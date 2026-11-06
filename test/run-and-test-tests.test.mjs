import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildTestSummary, SUMMARY_CASE_LIMIT } from '../src/test-summary.mjs';
import { KEPT_TEST_RUNS, listTestRuns, newTestRunId, saveTestRun, TEST_RUN_FORMAT } from '../src/test-runs.mjs';
import { latestStepAttempts, recordTestAttempt } from '../src/verification/attempts.mjs';

import { cli, repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

test('a capability-scope run is a private local preview and its summary lists cases with their requirement tags', slowLane({ timeout: 300_000 }), async (t) => {
  const repo = await repository(t, { extraCommands: [
    { id: 'bulk-junit', kind: 'test', argv: ['node', 'tools/junit.mjs', String(SUMMARY_CASE_LIMIT + 1)], workingDirectory: '.',
      affectedRoots: ['bulk'], modelPolicy: 'never', result: { adapter: 'junit-xml', path: '.sflow/results/bulk.xml' } }
  ] });
  // tests plan: what would run, with nothing executed.
  const plan = repo.sflowJson('tests', 'plan').value;
  assert.equal(plan.resultType, 'sflow-test-plan');
  assert.deepEqual(plan.scope, { kind: 'capability', capability: 'repository-root', workId: null, phase: null });
  const junitPlan = plan.commands.find((command) => command.id === 'module-junit');
  assert.deepEqual(Object.keys(junitPlan), ['id', 'kind', 'argv', 'workingDirectory', 'adapter', 'environments', 'commandSha256',
    'runner', 'level', 'title', 'source', 'why', 'results', 'resultsWords', 'covers', 'coversWords']);
  assert.deepEqual([junitPlan.argv, junitPlan.workingDirectory, junitPlan.environments], [['node', 'tools/junit.mjs', '2'], '.', []]);
  assert.deepEqual(plan.commands.map((command) => command.id).sort(), ['bulk-junit', 'karma-totals', 'module-junit', 'node-tests']);
  await assert.rejects(readdir(path.join(repo.root, '.git', 'singularity-flow', 'test-runs')), { code: 'ENOENT' }, 'a plan runs nothing');
  const nodePlan = plan.commands.find((command) => command.id === 'node-tests');
  const changed = repo.sflowJson('tests', 'run', '--command', 'node-tests', '--expect-command', junitPlan.commandSha256);
  assert.equal(changed.value.error.code, 'TESTS_COMMAND_CHANGED');
  assert.match(changed.value.error.message, /changed since they were confirmed: node-tests\. Nothing ran/u);
  // The node:test command the code step infers, through the code step's reporter.
  const nodeRun = repo.sflowJson('tests', 'run', '--command', 'node-tests', '--expect-command', nodePlan.commandSha256);
  assert.equal(nodeRun.status, 0, nodeRun.stderr);
  assert.equal(nodeRun.value.resultType, 'sflow-test-run');
  assert.deepEqual(nodeRun.value.scope, { kind: 'capability', capability: 'repository-root', workId: null, phase: null });
  assert.equal(nodeRun.value.run.evidenceClass, 'local-preview');
  assert.equal(nodeRun.value.run.label, 'Local preview, not evidence');
  assert.match(nodeRun.value.run.id, /^RUN-\d{8}T\d{6}Z-[a-f0-9]{8}$/u);
  assert.equal(nodeRun.value.run.countsForStep, false);
  assert.equal(nodeRun.value.next, 'singularity-flow tests summary --capability repository-root');
  assert.deepEqual(nodeRun.value.commands.map((command) => [command.id, command.adapter, command.status, command.perCase]), [
    ['node-tests', 'node-tap', 'passed', true]
  ]);
  const nodeSummary = repo.sflowJson('tests', 'summary').value;
  assert.equal(nodeSummary.resultType, 'sflow-test-summary');
  assert.equal(nodeSummary.schemaVersion, 1);
  assert.deepEqual(Object.keys(nodeSummary), ['resultType', 'schemaVersion', 'scope', 'run', 'totals', 'commands', 'cases', 'truncated', 'untagged', 'history']);
  assert.deepEqual(nodeSummary.cases.map((entry) => [entry.name, entry.file, entry.line, entry.outcome, entry.clauses]), [
    ['value is one', 'test/value.test.mjs', 6, 'passed', ['QF-1:AC-001']],
    ['untagged arithmetic', 'test/value.test.mjs', 8, 'passed', []]
  ]);
  assert.equal(nodeSummary.untagged, 1);
  assert.equal(nodeSummary.totals.discovered, 2);

  // JUnit XML that names each case's file and line, and a totals-only report.
  // From a host that sets its own variables, as VS Code does: karma-totals exits 3 if it sees them.
  const hosted = spawnSync(process.execPath, [cli, '--no-model', 'tests', 'run', '--command', 'module-junit', '--command', 'karma-totals', '--json'], {
    cwd: repo.root, encoding: 'utf8', timeout: childTimeout(240_000),
    env: { ...repo.env, ELECTRON_RUN_AS_NODE: '1', SINGULARITY_FLOW_SURFACE_CONTEXT: JSON.stringify({ schemaVersion: 1, repositoryPath: repo.root }) }
  });
  const mixed = { status: hosted.status, value: JSON.parse(hosted.stdout) };
  assert.equal(mixed.status, 1, 'a failing test case makes the run exit non-zero');
  assert.equal(mixed.value.commands.find((command) => command.id === 'karma-totals').status, 'passed');
  const summary = repo.sflowJson('tests', 'summary').value;
  assert.equal(summary.run.id, mixed.value.run.id);
  const junit = summary.commands.find((command) => command.id === 'module-junit');
  assert.deepEqual([junit.adapter, junit.status, junit.exitCode, junit.perCase, junit.note], ['junit-xml', 'failed', 1, true, null]);
  assert.deepEqual(junit.tests, { discovered: 2, passed: 1, failed: 1, skipped: 0 });
  const karma = summary.commands.find((command) => command.id === 'karma-totals');
  assert.equal(karma.perCase, false);
  assert.match(karma.note, /karma-text reports give totals only\. A junit-xml, node-tap, jest-json or vitest-json report lists each test case/u);
  assert.deepEqual(summary.cases, [
    { command: 'module-junit', suite: 'tests.test_pay', name: 'test_refund', file: 'tests/test_pay.py', line: 4, outcome: 'passed', durationMs: 10, clauses: ['PAY-1:AC-002'] },
    { command: 'module-junit', suite: 'tests.test_pay', name: 'test_round', file: 'tests/test_pay.py', line: 8, outcome: 'failed', durationMs: 20, clauses: [], message: 'off by one\nexpected 2' }
  ]);
  assert.deepEqual(summary.totals, { discovered: 5, passed: 4, failed: 1, skipped: 0, flaky: 0, durationMs: summary.totals.durationMs });
  assert.equal(summary.untagged, 1);
  const text = repo.run(process.execPath, [cli, '--no-model', 'tests', 'summary']).stdout;
  assert.match(text, /Local preview, not evidence/u);
  assert.match(text, /✖ module-junit › tests\.test_pay › test_round \(tests\/test_pay\.py:8\)/u);

  // More than 5,000 cases: the list stops and says so.
  repo.sflowJson('tests', 'run', '--command', 'bulk-junit');
  const bulk = repo.sflowJson('tests', 'summary').value;
  assert.equal(bulk.cases.length, SUMMARY_CASE_LIMIT);
  assert.equal(bulk.truncated, true);
  assert.equal(bulk.totals.discovered, SUMMARY_CASE_LIMIT + 1);
  assert.equal(bulk.untagged, SUMMARY_CASE_LIMIT + 1);

  // History is every kept run, newest first; an earlier run stays readable by ID.
  assert.deepEqual(bulk.history.map((entry) => entry.runId), [bulk.run.id, mixed.value.run.id, nodeRun.value.run.id]);
  assert.deepEqual(bulk.history[1].totals.failed, 1);
  assert.equal(repo.sflowJson('tests', 'summary', '--run', nodeRun.value.run.id).value.run.id, nodeRun.value.run.id);
  const stored = path.join(repo.root, '.git', 'singularity-flow', 'test-runs', 'repository-root');
  assert.equal((await readdir(stored)).length, 3);
  assert.equal((await lstat(stored)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(stored, `${nodeRun.value.run.id}.json`))).mode & 0o777, 0o600);
  // A preview never touches the Story tree or the index.
  assert.equal(repo.run('git', ['status', '--porcelain']).stdout.trim(), '');

  const unknown = repo.sflowJson('tests', 'run', '--command', 'nope');
  assert.equal(unknown.status, 1);
  assert.equal(unknown.value.error.code, 'TESTS_COMMAND_UNKNOWN');
  assert.match(unknown.value.error.message, /Available: .*module-junit/u);
});

test('the preview store keeps the last 20 runs', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-test-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  const ids = [];
  for (let index = 0; index < KEPT_TEST_RUNS + 2; index += 1) {
    const at = new Date(Date.UTC(2026, 9, 19, 10, 0, index));
    const runId = newTestRunId(at);
    ids.push(runId);
    await saveTestRun(root, { format: TEST_RUN_FORMAT, runId, capability: 'web', startedAt: at.toISOString(), commands: [] });
  }
  const kept = await listTestRuns(root, 'web');
  assert.equal(kept.length, KEPT_TEST_RUNS);
  assert.deepEqual(kept.map((entry) => entry.runId), ids.slice(2).reverse());
});

test('a Story-scope run stages local attempts that gates, decisions and test-run risks do not read', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-attempts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  const item = 'singularity/work-items/PAY-1';
  await mkdir(path.join(root, item), { recursive: true });
  const command = { id: 'unit', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never',
    result: { adapter: 'junit-xml', path: '.sflow/results/unit.xml', minimumDiscovered: 1, minimumPassed: 1 } };
  const check = (status) => ({ id: 'unit', status, exitCode: status === 'passed' ? 0 : 1, startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(), sourceCommit: 'a'.repeat(40), sourceTreeSha256: 'b'.repeat(64), resultIsolated: false, stderr: '' });
  const gate = await recordTestAttempt(root, item, { command, check: check('blocked'), purpose: 'preflight', workId: 'PAY-1', phaseId: 'implement', generation: 1 });
  const local = await recordTestAttempt(root, item, { command, check: check('failed'), purpose: 'local', workId: 'PAY-1', phaseId: 'implement',
    generation: 1, localRunId: 'RUN-20261019T100000Z-0000abcd', uncommittedChanges: true });
  assert.equal(local.attempt.purpose, 'local');
  assert.equal(local.attempt.localRunId, 'RUN-20261019T100000Z-0000abcd');
  assert.equal(local.attempt.uncommittedChanges, true);
  assert.equal(local.attempt.parentAttemptId, gate.attempt.attemptId, 'lineage still names every earlier run');
  assert.equal(Object.hasOwn(gate.attempt, 'localRunId'), false, 'a gate attempt is unchanged');
  assert.equal(Object.hasOwn(gate.attempt, 'uncommittedChanges'), false);
  const latest = await latestStepAttempts(root, item, 'PAY-1', 'implement');
  assert.equal(latest.get('unit').attemptId, gate.attempt.attemptId);
  assert.equal((await latestStepAttempts(root, item, 'PAY-1', 'implement', { includeLocal: true })).get('unit').attemptId, local.attempt.attemptId);
});

test('the summary read model reports perCase false for counts-only adapters and caps the case list', () => {
  const occurrences = Array.from({ length: SUMMARY_CASE_LIMIT + 3 }, (_, index) => ({ className: 'Bulk', name: `case ${index}`, outcome: 'passed', durationMs: 1 }));
  const summary = buildTestSummary({
    scope: { kind: 'capability', capability: 'web', workId: null, phase: null },
    run: { id: 'RUN-20261019T100000Z-0000abcd', evidenceClass: 'local-preview', label: 'Local preview, not evidence' },
    entries: [
      { receipt: { commandId: 'bulk', adapter: 'junit-xml', status: 'passed', exitCode: 0, tests: { discovered: occurrences.length, passed: occurrences.length, failed: 0, skipped: 0 }, occurrences } },
      { receipt: { commandId: 'go', adapter: 'go-test-json', status: 'passed', exitCode: 0, tests: { discovered: 4, passed: 4, failed: 0, skipped: 0 }, occurrences: [] } },
      { receipt: { commandId: 'tap', adapter: 'node-tap', status: 'passed', exitCode: 0, tests: { discovered: 2, passed: 2, failed: 0, skipped: 0 }, occurrences: [] } }
    ]
  });
  assert.equal(summary.cases.length, SUMMARY_CASE_LIMIT);
  assert.equal(summary.truncated, true);
  assert.equal(summary.untagged, SUMMARY_CASE_LIMIT + 3);
  assert.equal(summary.commands[1].perCase, false);
  assert.match(summary.commands[1].note, /go-test-json reports give totals only/u);
  assert.equal(summary.commands[2].perCase, false);
  assert.match(summary.commands[2].note, /This TAP report has totals only/u);
  assert.equal(summary.totals.discovered, SUMMARY_CASE_LIMIT + 9);
});

test('a Story step run is staged as local attempts, read as a local run, and admitted only with the next publication', slowLane({ timeout: 300_000 }), async (t) => {
  const repo = await repository(t, { implementCommands: false });
  const { root, sflow, sflowJson, must } = repo;
  await startQuickFix(repo);
  sflow('phase', 'begin', 'implement', '--json');
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 2;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "import { value } from '../src/value.mjs';\n\n// @ac:QF-1:AC-001\ntest('value is two', () => assert.equal(value, 2));\n\n"
    + "test('the host never hands its own variables to tests', () => {\n  assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined);\n"
    + "  assert.equal(process.env.SINGULARITY_FLOW_SURFACE_CONTEXT, undefined);\n});\n");
  sflow('prepare', 'implement');
  const workflowPath = path.join(root, 'singularity/work-items/QF-1/workflow.json');
  const before = await readFile(workflowPath, 'utf8');
  const head = must('git', ['rev-parse', 'HEAD']).trim();

  // The plan names what would run, with nothing executed; its identity is what a run must match.
  const plan = sflowJson('tests', 'plan', '--work-id', 'QF-1').value;
  assert.equal(plan.resultType, 'sflow-test-plan');
  assert.deepEqual(plan.scope, { kind: 'story', capability: 'repository-root', workId: 'QF-1', phase: 'implement' });
  assert.equal(plan.localIntegrationEvidence, 'off');
  assert.deepEqual(plan.commands.map((command) => [command.id, command.kind, command.environments]), [['.-node-tests', 'test', []]]);
  assert.match(plan.commands[0].commandSha256, /^sha256:[a-f0-9]{64}$/u);
  const stale = sflowJson('tests', 'run', '--work-id', 'QF-1', '--expect-command', `sha256:${'0'.repeat(64)}`);
  assert.equal(stale.status, 1);
  assert.equal(stale.value.error.code, 'TESTS_COMMAND_CHANGED');
  await assert.rejects(readdir(path.join(root, '.git', 'singularity-flow', 'test-attempts', 'QF-1', 'implement')), { code: 'ENOENT' }, 'nothing ran');
  // Run from a host that sets its own variables, as VS Code does: the tests never see them.
  const hosted = spawnSync(process.execPath, [cli, '--no-model', 'tests', 'run', '--work-id', 'QF-1', '--expect-command', plan.commands[0].commandSha256, '--json'], {
    cwd: root, encoding: 'utf8', timeout: childTimeout(240_000),
    env: { ...repo.env, ELECTRON_RUN_AS_NODE: '1', SINGULARITY_FLOW_SURFACE_CONTEXT: JSON.stringify({ schemaVersion: 1, repositoryPath: root }) }
  });
  const run = { status: hosted.status, value: JSON.parse(hosted.stdout), stderr: hosted.stderr };
  assert.equal(run.status, 0, run.stderr + JSON.stringify(run.value));
  assert.deepEqual(run.value.scope, { kind: 'story', capability: 'repository-root', workId: 'QF-1', phase: 'implement' });
  assert.equal(run.value.run.evidenceClass, 'local-preview');
  assert.match(run.value.run.label, /Local run, not evidence/u);
  assert.equal(run.value.run.countsForStep, false);
  assert.equal(run.value.next, 'singularity-flow tests summary --work-id QF-1 --phase implement');
  const summary = sflowJson('tests', 'summary', '--work-id', 'QF-1').value;
  assert.equal(summary.run.id, run.value.run.id);
  assert.deepEqual(summary.cases.map((entry) => [entry.name, entry.outcome, entry.clauses]), [
    ['value is two', 'passed', ['QF-1:AC-001']], ['the host never hands its own variables to tests', 'passed', []]
  ]);
  // Staged privately: the Story and the branch are exactly as they were.
  assert.equal(await readFile(workflowPath, 'utf8'), before);
  assert.equal(must('git', ['rev-parse', 'HEAD']).trim(), head);
  const staged = await readdir(path.join(root, '.git', 'singularity-flow', 'test-attempts', 'QF-1', 'implement'));
  assert.equal(staged.length, 1);
  await assert.rejects(readdir(path.join(root, 'singularity/work-items/QF-1/context/code-delivery/tests/attempts/implement')), { code: 'ENOENT' });

  // The passing local run stands for publication [TCE:REQ-082], which admits every kept attempt, the local
  // one included. Run from a host that sets its own variables too: they change nothing the run saw.
  const published = spawnSync(process.execPath, [cli, '--no-model', 'phase', 'publish', 'implement'], {
    cwd: root, encoding: 'utf8', timeout: childTimeout(240_000),
    env: { ...repo.env, ELECTRON_RUN_AS_NODE: '1', SINGULARITY_FLOW_SURFACE_CONTEXT: JSON.stringify({ schemaVersion: 1, repositoryPath: root }) }
  });
  assert.equal(published.status, 0, published.stdout + published.stderr);
  const admitted = await readdir(path.join(root, 'singularity/work-items/QF-1/context/code-delivery/tests/attempts/implement'));
  const records = await Promise.all(admitted.map(async (name) => JSON.parse(await readFile(path.join(root,
    'singularity/work-items/QF-1/context/code-delivery/tests/attempts/implement', name), 'utf8'))));
  assert.deepEqual(records.map((record) => record.purpose).sort(), ['local', 'preflight']);
  const afterPublish = sflowJson('tests', 'summary', '--work-id', 'QF-1').value;
  assert.equal(afterPublish.run.evidenceClass, 'governed');
  const reused = `Reused from ${records.find((record) => record.purpose === 'local').attemptId}, on the same code`;
  assert.equal(afterPublish.run.label, reused);
  assert.equal(afterPublish.run.countsForStep, true);
  assert.deepEqual(afterPublish.history.map((entry) => [entry.evidenceClass, entry.label]), [
    ['governed', reused], ['local-preview', 'Local run, not evidence itself: a passing one stands for the next publication while nothing it ran on changes']
  ]);
  assert.match(afterPublish.commands[0].note, /^Not run again: this is TA-[a-f0-9]{20} recorded by implement, on the same code\.$/u);
  assert.equal(sflowJson('tests', 'summary', '--work-id', 'QF-1', '--run', 'RUN-20200101T000000Z-00000000').value.error.code, 'TESTS_RUN_NOT_FOUND');
});
