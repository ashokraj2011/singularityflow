/**
 * A test run stands until something it ran on moves [TCE:REQ-080], and a Story's test scope changes
 * while it is open [TCE:REQ-090], through whole Stories on the real CLI and a real `npm test`.
 *
 * Owner, 2026-11-06: "dont rerun if the code has not changed". The incident: on one source digest a
 * Story ran its tests at publish, again at submit, and again when its verification step was
 * submitted. Each test here appends a line to a log outside the repository, so a run is counted as
 * something that happened, never as what a record claims. Reuse is refused when the source, the test
 * configuration, the environment or the command moves, and when the last run on this code failed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { storyTestScope, TEST_SCOPES } from '../src/code-delivery-policy.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { unchangedTestRun } from '../src/verification/attempts.mjs';
import { flakyTestRuns } from '../src/verification/flaky-runs.mjs';
import { lastTestingStep, newAndChangedTestCommands, storyExistingImporters } from '../src/verification/test-scope-selection.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const W = 'RERUN-1';
const [AC1, AC2] = [`${W}:AC-001`, `${W}:AC-002`];

/** A repository at the code step of a real Story whose later step runs the repository's tests. */
async function storyAtCode(t, { existingImports = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-unchanged-runs-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const log = path.join(base, 'runs.log');
  const existingLog = path.join(base, 'existing.log');
  const env = { ...isolatedTestEnvironment(path.join(base, 'machine')), NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Rerun Tester',
    SINGULARITY_FLOW_AGENT_OUTPUT: 'full', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Rerun Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'rerun.tester@example.invalid' };
  delete env.NODE_TEST_CONTEXT;
  const run = (command, args, { cwd = root, extra = {} } = {}) => spawnSync(command, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: childTimeout(180_000) });
  const must = (command, args, options) => {
    const result = run(command, args, options);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
  const write = async (relative, text) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  };
  const lines = async (file) => (existsSync(file) ? (await readFile(file, 'utf8')).split('\n').filter(Boolean).length : 0);
  const source = (value) => `// @clause:${AC1} returns the approved value\n// @clause:${AC2} keeps the module export named value\nexport const value = ${value};\n`;
  const check = (value, { tagged = true } = {}) => ["import test from 'node:test';", "import assert from 'node:assert/strict';", "import { appendFileSync } from 'node:fs';",
    "import { value } from '../src/value.mjs';", ...(tagged ? [`// @ac:${AC1}`, `// @ac:${AC2}`] : []),
    `test('value', () => { appendFileSync(${JSON.stringify(log)}, 'run\\n'); assert.equal(value, ${value}); });`, ''].join('\n');
  must('git', ['init', '-q', '-b', 'main', root], { cwd: base });
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await write('src/value.mjs', 'export const value = 1;\n');
  await write('test/value.test.mjs', check(1, { tagged: false }));
  await write('test/existing.test.mjs', `import test from 'node:test';\nimport { appendFileSync } from 'node:fs';\n${existingImports ? "import { value } from '../src/value.mjs';\n" : ''}`
    + `test('existing', () => { appendFileSync(${JSON.stringify(existingLog)}, 'run\\n'); ${existingImports ? 'if (!value) throw new Error(\'no value\');' : ''} });\n`);
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // Its testing step then runs the repository's tests, as packaged feature and bugfix verification do.
  delete config.workTypes['classic-delivery'].phaseOverrides.testing.testEvidenceFrom;
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], { cwd: base });
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  const plan = JSON.parse(sflow('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  sflow('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', plan.planId, '--json');
  sflow('start', W, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Change the value', '--description', 'Return the approved value 2.');
  const item = path.join(root, 'singularity/work-items', W);
  const workflow = async () => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  sflow('prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [`# ${W} — Classic delivery intake`, '', '## Request and outcome', '',
    'Return the approved new value 2 to every caller; retain the exported API.', '', '## Scope and constraints', '', 'Change only the value module and its executable unit test.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${AC1}] | The exported value equals 2. |`, `| [${AC2}] | The module still exports a binding named value. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests |', '|---|---|---|', `| \`${AC1}\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, `| \`${AC2}\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, '',
    '## Initial evidence', '', 'The baseline module and executable test at the pinned main revision.', ''].join('\n'));
  sflow('wm', 'compose', '--phase', 'intake');
  sflow('clarification', 'record', 'intake', '--question', 'Is the new value 2 the approved outcome?', '--answer', 'Yes; keep the exported interface and add the matching unit test.');
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  sflow('submit', 'intake');
  sflow('approve', 'intake', '--yes');
  sflow('prepare', 'implementation');
  await write('src/value.mjs', source(2));
  await write('test/value.test.mjs', check(2));
  const summary = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(summary, (await readFile(summary, 'utf8')).replace(/TODO:[^\n]*/gu, 'The clause-tagged value module and acceptance-tagged unit test now prove the approved value 2.'));
  const publish = (options) => must(process.execPath, [cli, '--no-model', 'phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place'], options);
  const attempts = async (phase = 'implementation') => {
    const { readdir } = await import('node:fs/promises');
    const folder = path.join(item, 'context/code-delivery/tests/attempts', phase);
    if (!existsSync(folder)) return [];
    return Promise.all((await readdir(folder)).filter((name) => name.endsWith('.json')).map(async (name) => JSON.parse(await readFile(path.join(folder, name), 'utf8'))));
  };
  const finishTesting = async () => {
    sflow('prepare', 'testing');
    const file = path.join(item, (await workflow()).phases.testing.requiredArtifact.path);
    await writeFile(file, (await readFile(file, 'utf8')).replace(/TODO:[^\n]*/gu, `Verified ${AC1} and ${AC2} against the approved code generation and its recorded run.`).replace(/\bTODO\b/gu, 'matched'));
    sflow('phase', 'publish', 'testing', '--authored', 'human', '--channel', 'manual-in-place');
    return sflow('submit', 'testing');
  };
  const finishConformance = async () => {
    sflow('prepare', 'conformance');
    const report = path.join(item, (await workflow()).phases.conformance.requiredArtifact.path);
    const sample = `| \`${AC1}\` | TODO | TODO | TODO | TODO: matched/partial/missing/deviated/unplanned | TODO |`;
    await writeFile(report, (await readFile(report, 'utf8')).replace(sample, [`| \`${AC1}\` | Exported value equals 2 | \`src/value.mjs\` @clause:${AC1} | \`test/value.test.mjs\` @ac:${AC1} | matched | none |`,
      `| \`${AC2}\` | Export keeps its name | \`src/value.mjs\` @clause:${AC2} | \`test/value.test.mjs\` @ac:${AC2} | matched | none |`].join('\n'))
      .replace(/TODO:[^\n]*/gu, `Compared ${AC1} and ${AC2} against the approved Code generation and its committed receipt.`).replace(/\bTODO\b/gu, 'none'));
    sflow('prepare', 'conformance');
    sflow('phase', 'publish', 'conformance', '--authored', 'human', '--channel', 'manual-in-place');
    sflow('submit', 'conformance');
    sflow('approve', 'conformance', '--yes');
  };
  return { root, item, log, existingLog, sflow, must, run, write, publish, attempts, workflow, source, check, finishTesting, finishConformance,
    runs: () => lines(log), existingRuns: () => lines(existingLog), cli };
}

test('tests run once on unchanged code, however many later steps need them, and the Story still closes', slowLane({ timeout: 600_000 }), async (t) => {
  const f = await storyAtCode(t);
  const start = await f.runs();
  f.publish();
  assert.equal(await f.runs(), start + 1, 'publication runs them');
  // The review packet no longer says submission runs them again [CQF:REQ-016].
  const preflight = JSON.parse(f.sflow('phase', 'show', 'implementation', '--json').stdout).testEvidence.acceptance.statement;
  assert.match(preflight, /^In the preflight run, 2 of 2 acceptance criteria verified .*; a passing run stands for submission while nothing it ran on changes\.$/u);
  assert.doesNotMatch(preflight, /runs the tests again/u);
  const submitted = f.sflow('submit', 'implementation');
  assert.equal(await f.runs(), start + 1, 'submission reuses the run');
  assert.match(submitted.stderr, /Not run again: \.-node-tests passed on this exact code \(TA-[a-f0-9]{20}, recorded by implementation\)/u);
  const delivered = (await f.workflow()).phases.implementation;
  assert.equal(delivered.checks.find((check) => check.id === '.-node-tests').evidenceUse, 'reused');
  assert.equal(delivered.deliveryEvidence.testExecutions[0].attemptId, delivered.deliveryEvidence.preflightAttempts[0].attemptId, 'the receipt binds the run that happened');
  assert.equal((await f.attempts()).length, 1, 'no second record of one run');
  f.sflow('approve', 'implementation', '--yes');

  const reviewed = await f.finishTesting();
  assert.equal(await f.runs(), start + 1, "the later step's repository tests are the same command on the same code");
  assert.match(reviewed.stderr, /Not run again: node-tests passed on this exact code/u);
  const testing = (await f.workflow()).phases.testing;
  const reused = testing.checks.find((check) => check.source === 'repository-tests');
  assert.equal(reused.reusedFrom.phase, 'implementation');
  assert.equal(reused.status, 'passed');
  const review = JSON.parse(f.sflow('phase', 'show', 'testing', '--json').stdout);
  assert.match(review.reusedTestRuns[0].words, /^reused: TA-[a-f0-9]{20} recorded by implementation at [a-f0-9]{12}; the code has not changed since/u, 'it never reads as a run by this step');
  f.sflow('approve', 'testing', '--yes');
  await f.finishConformance();
  assert.equal(await f.runs(), start + 1);
  assert.equal((await f.workflow()).status, 'closed', 'every final gate replays the one run');
});

test('a README edit after the code step reruns nothing, and the run still binds to the end [CQF:REQ-011]', slowLane({ timeout: 600_000 }), async (t) => {
  const f = await storyAtCode(t);
  const start = await f.runs();
  f.publish();
  f.sflow('submit', 'implementation');
  f.sflow('approve', 'implementation', '--yes');
  assert.equal(await f.runs(), start + 1);
  // Documentation, as delivery evidence already defines it, edited and committed after the code was approved.
  await f.write('README.md', '# Value\n\nReturns the approved value.\n');
  f.must('git', ['add', 'README.md']); f.must('git', ['commit', '-q', '-m', 'Say what the module returns']);
  const reviewed = await f.finishTesting();
  assert.equal(await f.runs(), start + 1, 'the tests did not run again');
  assert.match(reviewed.stderr, /Not run again: node-tests passed on this exact code \(TA-[a-f0-9]{20}, recorded by implementation\)/u);
  const testing = (await f.workflow()).phases.testing;
  const reused = testing.checks.find((check) => check.source === 'repository-tests');
  const packet = (await f.workflow()).lineage.submissions.filter((entry) => entry.phase === 'testing').at(-1).projection;
  assert.notEqual(reused.sourceTreeSha256, packet.sourceTreeSha256, 'the tree moved with the README');
  assert.equal(reused.codeTreeSha256, packet.codeTreeSha256, 'the code did not');
  assert.match(packet.documentationSha256, /^sha256:[a-f0-9]{64}$/u, 'the documentation is hashed separately');
  f.sflow('approve', 'testing', '--yes');
  await f.finishConformance();
  assert.equal(await f.runs(), start + 1);
  assert.equal((await f.workflow()).status, 'closed');
});

test('a different environment runs the tests again, and the real run is recorded as one', slowLane({ timeout: 600_000 }), async (t) => {
  const f = await storyAtCode(t);
  const start = await f.runs();
  // NODE_OPTIONS is no selection, but it is not the same run.
  f.publish();
  const again = f.must(process.execPath, [cli, '--no-model', 'submit', 'implementation'], { extra: { NODE_OPTIONS: '--max-old-space-size=4096' } });
  assert.equal(await f.runs(), start + 2, 'a different environment runs them');
  assert.match(again.stderr, /Running \.-node-tests again: the environment changed since TA-/u);
  const delivered = (await f.workflow()).phases.implementation;
  assert.equal(delivered.checks.find((check) => check.id === '.-node-tests').evidenceUse, undefined);
  assert.notEqual(delivered.deliveryEvidence.testExecutions[0].attemptId, delivered.deliveryEvidence.preflightAttempts[0].attemptId);
});

test('a generation back on code that already passed reuses that run under its own record; changed code or a changed test input runs again', slowLane({ timeout: 600_000 }), async (t) => {
  const f = await storyAtCode(t);
  const start = await f.runs();
  const nextGeneration = () => {
    const preview = JSON.parse(f.sflow('phase', 'rollover', 'implementation', '--json').stdout);
    f.sflow('phase', 'rollover', 'implementation', '--confirm', preview.confirmation);
  };
  const returned = (why) => f.sflow('reject', 'implementation', '--to', 'implementation', '--reason', why);
  f.publish();
  f.sflow('submit', 'implementation');
  assert.equal(await f.runs(), start + 1);
  // Changed code runs them.
  returned('Keep a note on why the value changed.');
  await f.write('src/value.mjs', `${f.source(2)}// the approved value\n`);
  nextGeneration();
  f.publish();
  assert.equal(await f.runs(), start + 2, 'changed code runs them');
  f.sflow('submit', 'implementation');
  assert.equal(await f.runs(), start + 2);
  // Taking that back returns to code that already passed: its run stands, recorded for this generation.
  returned('Drop the note after all; the code goes back to what was reviewed first.');
  await f.write('src/value.mjs', f.source(2));
  nextGeneration();
  f.publish();
  assert.equal(await f.runs(), start + 2, 'the first run stands for the same code');
  const carried = (await f.attempts()).find((attempt) => attempt.reusedFrom);
  assert.equal(carried.generation, 3, 'bound by the generation that reused it');
  assert.equal(carried.reusedFrom.generation, 1);
  f.sflow('submit', 'implementation');
  assert.equal(await f.runs(), start + 2);
  // A file the tests read: the digest moves, so they run.
  returned('The fixture the test reads needs its new value.');
  await f.write('test/fixture.json', '{"value":2}\n');
  nextGeneration();
  f.publish();
  assert.equal(await f.runs(), start + 3, 'a changed test input runs them');
  f.sflow('submit', 'implementation');
  // And so does a changed test file.
  returned('The test needs a note about the fixture.');
  await f.write('test/value.test.mjs', `${f.check(2)}// reads the fixture\n`);
  nextGeneration();
  f.publish();
  assert.equal(await f.runs(), start + 4, 'a changed test runs them');
  f.sflow('submit', 'implementation');
  f.sflow('approve', 'implementation', '--yes');
  await f.finishTesting();
  assert.equal(await f.runs(), start + 4, 'and the later step reuses the last of them');
});

test('a recorded tests run on the same code counts for publish', slowLane({ timeout: 600_000 }), async (t) => {
  const f = await storyAtCode(t);
  const start = await f.runs();
  f.sflow('tests', 'run', '--work-id', W, '--phase', 'implementation', '--json');
  assert.equal(await f.runs(), start + 1);
  const published = f.publish();
  assert.equal(await f.runs(), start + 1, 'owner, 2026-11-06: it counts, so publish does not run them again');
  assert.match(published.stderr, /Not run again: \.-node-tests passed on this exact code/u);
  const evidence = (await f.workflow()).phases.implementation.deliveryEvidence;
  const bound = (await f.attempts()).find((attempt) => attempt.attemptId === evidence.preflightAttempts[0].attemptId);
  assert.equal(bound.reusedFrom.purpose, 'local', 'it says what it reused');
  assert.equal(bound.purpose, 'preflight');
  assert.ok(bound.pin?.sha256, 'the gate pins it like a run of its own');
  // A person who asks for a run gets one, even on the same code.
  const asked = JSON.parse(f.sflow('tests', 'run', '--work-id', W, '--phase', 'implementation', '--json').stdout);
  assert.equal(await f.runs(), start + 2);
  // The summary still reads the run publication bound, and names the newer one [CQF:REQ-015].
  const summary = JSON.parse(f.sflow('tests', 'summary', '--work-id', W, '--phase', 'implementation', '--json').stdout);
  assert.equal(summary.run.id, evidence.preflightAttempts[0].attemptId);
  assert.equal(summary.run.bound, true);
  assert.equal(summary.run.newer.id, asked.run.id);
  assert.match(f.sflow('tests', 'summary', '--work-id', W, '--phase', 'implementation').stdout, /A newer run, RUN-[^,]+, is not bound to it: singularity-flow tests summary --work-id RERUN-1 --phase implementation --latest/u);
  assert.equal(JSON.parse(f.sflow('tests', 'summary', '--work-id', W, '--phase', 'implementation', '--latest', '--json').stdout).run.id, asked.run.id);
  f.sflow('submit', 'implementation');
  assert.equal(await f.runs(), start + 2);
  f.sflow('approve', 'implementation', '--yes');
});

test('a fail then a pass on the same code and environment marks the command flaky, and refuses nothing [CQF:REQ-013]', slowLane({ timeout: 600_000 }), async (t) => {
  const f = await storyAtCode(t);
  const flag = path.join(path.dirname(f.root), 'busy.flag');
  await writeFile(flag, 'busy\n');
  await f.write('test/value.test.mjs', f.check(2).replace('{ appendFileSync }', '{ appendFileSync, existsSync }')
    .replace("test('value', () => {", `test('value', () => { if (existsSync(${JSON.stringify(flag)})) throw new Error('the shared fixture was busy');`));
  const local = f.run(process.execPath, [f.cli, '--no-model', 'tests', 'run', '--work-id', W, '--phase', 'implementation', '--json']);
  assert.equal(local.status, 1, 'the first run fails');
  await rm(flag);
  const published = f.publish();
  assert.match(published.stderr, /Running \.-node-tests again: its last run on this code failed/u);
  const review = JSON.parse(f.sflow('phase', 'show', 'implementation', '--json').stdout);
  const [flaky] = review.flakyTestRuns;
  assert.equal(flaky.failed.length, 1);
  assert.deepEqual(flaky.passed, [(await f.workflow()).phases.implementation.deliveryEvidence.preflightAttempts[0].attemptId]);
  assert.match(flaky.words, /^\.-node-tests is flaky: on the same code and environment TA-[a-f0-9]{20} failed and TA-[a-f0-9]{20} passed$/u);
  const summary = JSON.parse(f.sflow('tests', 'summary', '--work-id', W, '--phase', 'implementation', '--json').stdout);
  assert.equal(summary.commands[0].flaky.words, flaky.words);
  assert.match(f.sflow('tests', 'summary', '--work-id', W, '--phase', 'implementation').stdout, /\.-node-tests is flaky: .*; it refuses nothing\./u);
  f.sflow('submit', 'implementation');
  f.sflow('approve', 'implementation', '--yes');
  assert.equal((await f.workflow()).phases.implementation.status, 'approved', 'it refuses nothing');
});

test('anyone may move a Story to only its new tests in the code step; its existing tests never run and the review says so', slowLane({ timeout: 600_000 }), async (t) => {
  const f = await storyAtCode(t);
  const before = await f.existingRuns();
  const shown = JSON.parse(f.sflow('story', 'test-policy', 'scope', W, '--json').stdout).data;
  assert.equal(shown.scope, 'changed-and-affected');
  // Fewer tests need a reason a reviewer can read.
  const noReason = f.run(process.execPath, [cli, '--no-model', 'story', 'test-policy', 'scope', W, '--to', 'new-and-changed', '--json']);
  assert.notEqual(noReason.status, 0);
  assert.equal(JSON.parse(noReason.stdout).error.code, 'TEST_SCOPE_REASON_REQUIRED');
  const changed = JSON.parse(f.sflow('story', 'test-policy', 'scope', W, '--to', 'new-and-changed', '--reason', 'Only the tests this Story adds matter here.', '--json').stdout).data;
  assert.equal(changed.record.id, 'TSC-001');
  assert.equal(changed.record.narrowing, true);
  f.publish();
  assert.equal(await f.existingRuns(), before, 'the existing test did not run');
  const delivered = (await f.workflow()).phases.implementation.deliveryEvidence;
  const [attempt] = await f.attempts();
  assert.deepEqual(attempt.testScope, { mode: 'new-and-changed', files: ['test/value.test.mjs'] });
  assert.equal(attempt.tests.discovered, 1);
  assert.deepEqual(attempt.narrowing.reasons, [], 'declared in the open, so it is no hidden narrowing');
  assert.deepEqual(delivered.preflightAttempts.map((entry) => entry.commandId), ['.-node-tests']);
  f.sflow('submit', 'implementation');
  assert.equal((await f.workflow()).phases.implementation.deliveryEvidence.status, 'ready');
  f.sflow('approve', 'implementation', '--yes');
  await f.finishTesting();
  const testing = (await f.workflow()).phases.testing;
  const note = testing.checks.find((check) => check.source === 'repository-tests' || check.id === 'repository-tests');
  assert.match(note.stderr, /Not run: this Story runs only its new and changed tests \(TSC-001, .*Only the tests this Story adds matter here\.\), so its existing tests were not run; none of them imports a module it changed\./u);
  assert.match(JSON.parse(f.sflow('phase', 'show', 'testing', '--json').stdout).testScope.words, /Its existing tests were not run\./u);
  assert.equal(await f.existingRuns(), before, 'nor at the later step');
  f.sflow('approve', 'testing', '--yes');
  await f.finishConformance();
  assert.equal((await f.workflow()).status, 'closed', 'its receipts replay through the final gates');
  const closed = f.run(process.execPath, [cli, '--no-model', 'story', 'test-policy', 'scope', W, '--to', 'all-configured', '--json']);
  assert.equal(JSON.parse(closed.stdout).error.code, 'TEST_SCOPE_STORY_CLOSED');
});

test('on only its new tests, the last step that runs tests runs once the existing tests that import a changed module, and says so [CQF:REQ-017]', slowLane({ timeout: 600_000 }), async (t) => {
  const f = await storyAtCode(t, { existingImports: true });
  const before = await f.existingRuns();
  f.sflow('story', 'test-policy', 'scope', W, '--to', 'new-and-changed', '--reason', 'Only the tests this Story adds matter here.');
  f.publish();
  f.sflow('submit', 'implementation');
  assert.equal(await f.existingRuns(), before, 'the code step is not the last step that runs tests');
  f.sflow('approve', 'implementation', '--yes');
  const reviewed = await f.finishTesting();
  assert.equal(await f.existingRuns(), before + 1, 'it ran once, at publication, and submission reused it');
  assert.match(reviewed.stderr, /Not run again: node-tests passed on this exact code \(TA-[a-f0-9]{20}, recorded by testing\)/u);
  const testing = (await f.workflow()).phases.testing;
  const [run] = testing.stepTestRuns.testExecutions;
  assert.deepEqual(run.importers, ['test/existing.test.mjs']);
  assert.equal(run.status, 'passed');
  const [attempt] = await f.attempts('testing');
  assert.deepEqual(attempt.testScope, { mode: 'new-and-changed', files: ['test/existing.test.mjs'], importers: ['test/existing.test.mjs'] });
  assert.equal(attempt.tests.discovered, 1, 'only the importing test, not the Story\'s own again');
  const review = JSON.parse(f.sflow('phase', 'show', 'testing', '--json').stdout);
  assert.match(review.testScope.words, /As its last step that runs tests, testing also ran once the existing tests that import a module it changed: test\/existing\.test\.mjs\. Its other existing tests were not run\./u);
  const summary = JSON.parse(f.sflow('tests', 'summary', '--work-id', W, '--phase', 'testing', '--json').stdout);
  assert.match(summary.commands[0].note, /The existing tests that import a module it changed ran once \(test\/existing\.test\.mjs\); its other existing tests did not\./u);
  f.sflow('approve', 'testing', '--yes');
  await f.finishConformance();
  assert.equal(await f.existingRuns(), before + 1);
  assert.equal((await f.workflow()).status, 'closed');
});

test('moving back to more tests needs no reason, keeps what was recorded and runs only what has not run on this code', slowLane({ timeout: 600_000 }), async (t) => {
  const f = await storyAtCode(t);
  const before = await f.existingRuns();
  f.sflow('story', 'test-policy', 'scope', W, '--to', 'new-and-changed', '--reason', 'Only the tests this Story adds matter here.');
  f.publish();
  const [scoped] = await f.attempts();
  const start = await f.runs();
  const widened = JSON.parse(f.sflow('story', 'test-policy', 'scope', W, '--to', 'changed-and-affected', '--json').stdout).data;
  assert.equal(widened.record.narrowing, false);
  assert.equal(widened.record.reason, '');
  // The whole module has never run on this code, so submit runs it once; the scoped record is untouched.
  f.sflow('submit', 'implementation');
  assert.equal(await f.runs(), start + 1);
  assert.equal(await f.existingRuns(), before + 1, 'now they run');
  const records = await f.attempts();
  assert.deepEqual(records.find((attempt) => attempt.attemptId === scoped.attemptId).testScope.files, ['test/value.test.mjs']);
  // Narrowing again on the same code: the whole run already ran the new tests, so nothing runs.
  f.sflow('story', 'test-policy', 'scope', W, '--to', 'new-and-changed', '--reason', 'Back to the tests this Story adds.');
  assert.equal(storyTestScope(await f.workflow()), 'new-and-changed');
  assert.deepEqual((await f.workflow()).testScopeChanges.map((entry) => entry.id), ['TSC-001', 'TSC-002', 'TSC-003']);
  // The change was made while the step waited for review, and its review still stands.
  f.sflow('approve', 'implementation', '--yes');
  assert.equal((await f.workflow()).phases.implementation.status, 'approved');
});

test('all-configured reaches the gates, from intake or changed later, and only-new can be chosen at intake', slowLane({ timeout: 600_000 }), async (t) => {
  const commandsAtPublish = async (mode, { change = null, importer = false } = {}) => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-scope-reach-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const root = path.join(base, 'repo');
    const env = { ...isolatedTestEnvironment(path.join(base, 'machine')), NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Scope Tester',
      SINGULARITY_FLOW_AGENT_OUTPUT: 'full', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Scope Tester',
      GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'scope.tester@example.invalid' };
    delete env.NODE_TEST_CONTEXT;
    const must = (command, args, cwd = root) => {
      const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: childTimeout(180_000) });
      assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };
    const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
    const write = async (relative, text) => { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), text); };
    const check = (value, tag = '') => `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\n${tag}test('value', () => assert.equal(value, ${value}));\n`;
    must('git', ['init', '-q', '-b', 'main', root], base);
    await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
    await write('src/value.mjs', 'export const value = 1;\n'); await write('test/root.test.mjs', check(1));
    await write('packages/a/package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
    await write('packages/a/src/value.mjs', 'export const value = 1;\n'); await write('packages/a/test/a.test.mjs', check(1));
    if (importer) await write('packages/a/test/old.test.mjs', "import test from 'node:test';\nimport { value } from '../src/value.mjs';\ntest('reads the value', () => { if (value == null) throw new Error('none'); });\n");
    sflow('init');
    const configPath = path.join(root, 'singularity/workflow.yml');
    const config = YAML.parse(await readFile(configPath, 'utf8'));
    config.worldModel.grounding = 'off'; config.approvalSecurity = { profile: 'poc' };
    for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
    await writeFile(configPath, YAML.stringify(config));
    must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Fixture']);
    must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
    must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
    sflow('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change', '--description', 'Return 2.', '--test-execution-mode', mode);
    sflow('prepare', 'intake');
    const item = path.join(root, 'singularity/work-items/QF-1');
    await writeFile(path.join(item, 'artifacts/intake/intake.md'), ['# QF-1 — Quick fix scope and plan', '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
      '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', '| [QF-1:AC-001] | The exported value equals 2. |', '', '## Planned implementation evidence', '',
      '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|', '| `QF-1:AC-001` | `packages/a/src/value.mjs` | `packages/a/test/a.test.mjs` | modified | The test reads 2. |', '',
      '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n'));
    sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
    sflow('submit', 'intake'); sflow('approve', 'intake', '--yes'); sflow('resume', 'QF-1'); sflow('phase', 'begin', 'implement', '--json');
    await write('packages/a/src/value.mjs', '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 2;\n');
    await write('packages/a/test/a.test.mjs', check(2, '// @ac:QF-1:AC-001\n'));
    sflow('prepare', 'implement');
    if (change) sflow('story', 'test-policy', 'scope', 'QF-1', '--to', change, ...(change === 'new-and-changed' ? ['--reason', 'Only the tests this Story adds.'] : []));
    sflow('phase', 'publish', 'implement');
    const workflow = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
    const policy = JSON.parse(await readFile(path.join(item, 'context/test-policy.json'), 'utf8'));
    if (importer) return { attempts: workflow.phases.implement.deliveryEvidence.preflightAttempts, review: JSON.parse(sflow('phase', 'show', 'implement', '--json')) };
    return { commands: workflow.phases.implement.deliveryEvidence.preflightAttempts.map((entry) => entry.commandId).sort(), scope: storyTestScope(workflow), sealed: policy.executionScope };
  };
  assert.deepEqual(await commandsAtPublish('changed-and-affected'), { commands: ['packages/a-node-tests'], scope: 'changed-and-affected', sealed: 'affected' });
  // The incident: this choice was sealed and never reached a gate, so it ran the same as the default.
  assert.deepEqual(await commandsAtPublish('all-configured'), { commands: ['node-tests', 'packages/a-node-tests'], scope: 'all-configured', sealed: 'full' });
  assert.deepEqual(await commandsAtPublish('changed-and-affected', { change: 'all-configured' }), { commands: ['node-tests', 'packages/a-node-tests'], scope: 'all-configured', sealed: 'affected' });
  assert.deepEqual(await commandsAtPublish('new-and-changed'), { commands: ['packages/a-node-tests'], scope: 'new-and-changed', sealed: 'new' });
  // A quick fix's verify runs no tests, so its code step is the last that does: the existing test importing the changed module runs there [CQF:REQ-017].
  const last = await commandsAtPublish('new-and-changed', { importer: true });
  assert.deepEqual(last.attempts.map((entry) => [entry.commandId, entry.importers, entry.status]), [['packages/a-node-tests', ['packages/a/test/old.test.mjs'], 'passed']]);
  assert.match(last.review.testScope.words, /As its last step that runs tests, implement also ran once the existing tests that import a module it changed: packages\/a\/test\/old\.test\.mjs\./u);
});

test('the scope helper reads the latest change, then what intake chose', () => {
  assert.deepEqual(TEST_SCOPES, ['all-configured', 'changed-and-affected', 'new-and-changed']);
  assert.equal(storyTestScope({}), 'changed-and-affected');
  assert.equal(storyTestScope({ resolution: { testExecutionMode: 'all-configured' } }), 'all-configured');
  assert.equal(storyTestScope({ resolution: { testExecutionMode: 'all-configured' }, testScopeChanges: [{ to: 'new-and-changed' }] }), 'new-and-changed');
});

test('a run stands only while everything it ran on is the same', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-unchanged-rule-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Rule Tester', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'rule@example.invalid' } }).stdout.trim();
  git('init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'a.txt'), 'a\n');
  git('add', '.'); git('commit', '-q', '-m', 'One');
  const commit = git('rev-parse', 'HEAD');
  const report = Buffer.from('report');
  const reportSha = createHash('sha256').update(report).digest('hex');
  const stage = path.join(root, '.git/singularity-flow/test-attempts/W-1');
  await mkdir(path.join(stage, 'code'), { recursive: true });
  await mkdir(path.join(stage, 'raw'), { recursive: true });
  await writeFile(path.join(stage, 'raw', reportSha), report);
  const command = { id: 'unit', argv: ['npm', 'test'], workingDirectory: '.', result: { adapter: 'node-tap' } };
  const argvSha256 = createHash('sha256').update(Buffer.from(JSON.stringify(command.argv))).digest('hex');
  let serial = 0;
  const attempt = async (overrides = {}) => {
    serial += 1;
    const attemptId = `TA-${String(serial).padStart(20, '0')}`;
    const record = { schemaVersion: currentSchemaVersion('test-execution'), kind: 'test-execution', attemptId, nonce: String(serial), parentAttemptId: null, purpose: 'preflight', workId: 'W-1', phase: 'code', generation: 1,
      commandId: 'unit', argvSha256, workingDirectory: '.', adapter: 'node-tap', environmentSha256: 'sha256:env', status: 'passed', exitCode: 0, reportError: null,
      tests: { discovered: 1, passed: 1, failed: 0, skipped: 0 }, candidate: { commit, treeSha256: 'sha256:tree', testInputSha256: 'sha256:inputs' },
      rawReports: [{ path: `work/raw/${reportSha}.bin`, sha256: reportSha, bytes: report.length }], process: { completedAt: `2026-11-06T00:00:${String(serial).padStart(2, '0')}.000Z` }, ...overrides };
    await writeFile(path.join(stage, 'code', `${attemptId}.json`), JSON.stringify(record));
    return record;
  };
  const workflow = { workItem: { id: 'W-1' }, phaseOrder: ['code', 'verify'], testCommandPins: [] };
  const standing = (now = {}) => unchangedTestRun(root, 'work', workflow, 'verify', command,
    { commit, treeSha256: 'sha256:tree', testInputSha256: 'sha256:inputs', environmentSha256: 'sha256:env', ...now });
  assert.deepEqual(await standing(), { moved: null }, 'nothing recorded');
  const first = await attempt();
  assert.equal((await standing()).attempt.attemptId, first.attemptId);
  assert.equal((await standing({ treeSha256: 'sha256:other' })).attempt, undefined, 'the source moved');
  assert.equal((await standing({ testInputSha256: 'sha256:other' })).attempt, undefined, 'the test inputs moved');
  assert.equal((await unchangedTestRun(root, 'work', workflow, 'verify', { ...command, argv: ['npm', 'run', 'other'] },
    { commit, treeSha256: 'sha256:tree', testInputSha256: 'sha256:inputs', environmentSha256: 'sha256:env' })).attempt, undefined, 'another command');
  assert.match((await standing({ environmentSha256: 'sha256:other' })).moved, /the environment changed since/u);
  assert.equal((await standing({ pinSha256: 'sha256:pin' })).attempt.attemptId, first.attemptId, 'a run recorded without a pin is compared by what it ran');
  const pinned = await attempt({ pin: { sha256: 'sha256:pin' } });
  assert.match((await standing({ pinSha256: 'sha256:other' })).moved, /pin changed/u);
  assert.equal((await standing({ pinSha256: 'sha256:pin' })).attempt.attemptId, pinned.attemptId);
  const local = await attempt({ purpose: 'local' });
  assert.equal((await standing({ pinSha256: 'sha256:pin' })).attempt.attemptId, local.attemptId, 'a recorded tests run counts');
  await attempt({ evidenceClass: 'local-integration' });
  assert.match((await standing()).moved, /cannot be compared/u);
  await attempt();
  assert.ok((await standing()).attempt, 'a later ordinary run stands');
  await attempt({ status: 'failed', exitCode: 1 });
  assert.match((await standing()).moved, /last run on this code failed/u, 'a failure never hides behind the pass before it');
  await attempt();
  assert.ok((await standing()).attempt, 'and a pass after it stands');
  await attempt({ candidate: { commit: '0'.repeat(40), treeSha256: 'sha256:tree', testInputSha256: 'sha256:inputs' } });
  assert.match((await standing()).moved, /outside this branch's history/u);
  await attempt({ rawReports: [{ path: 'work/raw/gone.bin', sha256: 'f'.repeat(64), bytes: 1 }] });
  assert.match((await standing()).moved, /report of .* is not available/u);
  // A documentation edit moves the tree but not the code a run ran on [CQF:REQ-011].
  const coded = await attempt({ candidate: { commit, treeSha256: 'sha256:tree', codeTreeSha256: 'sha256:code', testInputSha256: 'sha256:inputs' } });
  assert.equal((await standing({ treeSha256: 'sha256:readme-edited', codeTreeSha256: 'sha256:code' })).attempt.attemptId, coded.attemptId);
  assert.equal((await standing({ treeSha256: 'sha256:readme-edited', codeTreeSha256: 'sha256:other' })).attempt, undefined, 'changed code still runs');
  assert.equal((await standing({ treeSha256: 'sha256:readme-edited' })).attempt, undefined, 'without the code digest only the tree is compared');
});

test('runs disagree only on the same program, code, test inputs and environment; a copy or an environment\'s run never counts [CQF:REQ-013]', () => {
  const run = (attemptId, status, fields = {}) => ({ attemptId, commandId: 'unit', status, argvSha256: 'argv', workingDirectory: '.', adapter: 'node-tap',
    environmentSha256: 'sha256:env', candidate: { treeSha256: 'sha256:tree', testInputSha256: 'sha256:inputs' }, ...fields });
  assert.deepEqual(flakyTestRuns([run('TA-1', 'passed'), run('TA-2', 'passed')]), [], 'agreeing runs');
  const [flaky] = flakyTestRuns([run('TA-1', 'failed'), run('TA-2', 'passed', { commandId: 'node-tests' })]);
  assert.deepEqual([flaky.commandId, flaky.failed, flaky.passed], ['node-tests', ['TA-1'], ['TA-2']], 'the same command under another ID in a later step');
  assert.equal(flaky.words, 'node-tests is flaky: on the same code and environment TA-1 failed and TA-2 passed');
  for (const [why, other] of [['other code', { candidate: { treeSha256: 'sha256:other', testInputSha256: 'sha256:inputs' } }],
    ['other test inputs', { candidate: { treeSha256: 'sha256:tree', testInputSha256: 'sha256:other' } }], ['another environment', { environmentSha256: 'sha256:other' }],
    ['another program', { argvSha256: 'other' }], ['a copy of a run', { reusedFrom: { attemptId: 'TA-1' } }], ['an environment\'s values', { evidenceClass: 'local-integration' }]]) {
    assert.deepEqual(flakyTestRuns([run('TA-1', 'failed'), run('TA-2', 'passed', other)]), [], why);
  }
  assert.deepEqual(flakyTestRuns([run('TA-1', 'blocked'), run('TA-2', 'passed')]), [], 'a run that could not run is no disagreement');
});

test('the last step that runs tests is found, and only the existing tests importing a changed module join its run [CQF:REQ-017]', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-importers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Importer Tester', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'importers@example.invalid' } });
  const files = {
    'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }), 'src/value.mjs': 'export const value = 2;\n', 'src/other.mjs': 'export const other = 1;\n',
    'test/value.test.mjs': "import { value } from '../src/value.mjs';\n", 'test/reads.test.mjs': "import { value } from '../src/value.mjs';\n",
    'test/requires.test.cjs': "const { value } = require('../src/value.mjs');\n", 'test/other.test.mjs': "import { other } from '../src/other.mjs';\n",
    'test/mentions.test.mjs': "// import { value } from '../src/value.mjs';\nconst text = \"from '../src/value.mjs'\";\n"
  };
  for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
  git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'One');
  const code = { id: 'implement', generationPolicy: { task: 'code' }, status: 'in_progress', deliveryEvidence: { sourcePaths: ['src/value.mjs'], testPaths: ['test/value.test.mjs'] } };
  const workflow = (verify) => ({ phaseOrder: ['intake', 'implement', 'verify'], phases: { intake: { id: 'intake' }, implement: code, verify: { id: 'verify', status: 'pending' } },
    resolution: { phases: [{ id: 'verify', ...verify }] } });
  assert.equal(lastTestingStep(workflow({}), code), true, "quick-fix's verify runs no tests, so the code step is the last");
  assert.equal(lastTestingStep(workflow({ repositoryTests: 'run' }), code), false);
  assert.equal(lastTestingStep(workflow({ repositoryTests: 'run', testEvidenceFrom: 'implement' }), code), true, 'a step that reads the code step\'s tests runs none');
  assert.deepEqual(await storyExistingImporters(root, workflow({}), code), ['test/reads.test.mjs', 'test/requires.test.cjs'],
    'direct importers only: not the Story\'s own test, nor one of another module, nor a comment or a string');
  const [command] = await newAndChangedTestCommands(root, [inferred({ id: 'npm', argv: ['npm', 'test'], result: { adapter: 'node-tap', path: 'r.tap' } })],
    ['test/value.test.mjs'], { importers: ['test/reads.test.mjs'] });
  assert.deepEqual(command.argv, ['npm', 'test', '--', 'test/reads.test.mjs', 'test/value.test.mjs']);
  assert.deepEqual(command.testScope.importers, ['test/reads.test.mjs']);
});

const inferred = (command) => ({ kind: 'test', modelPolicy: 'never', provenance: 'inferred', workingDirectory: '.', affectedRoots: ['.'], ...command });

test('only-new tells each runner its files the way that runner takes them', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-test-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', 'chained': 'node --test && eslint .', 'dir': 'node --test test/unit' } }));
  const selected = async (command, files) => (await newAndChangedTestCommands(root, [inferred(command)], files))[0];
  const junit = (path_) => ({ adapter: 'junit-xml', path: path_, minimumDiscovered: 1 });
  const cases = [
    [{ id: 'npm', argv: ['npm', 'test'], result: { adapter: 'node-tap', path: 'r.tap' } }, ['t/a.test.mjs'], ['npm', 'test', '--', 't/a.test.mjs']],
    [{ id: 'pnpm', argv: ['pnpm', 'test'], result: { adapter: 'node-tap', path: 'r.tap' } }, ['t/a.test.mjs'], ['pnpm', 'test', 't/a.test.mjs']],
    [{ id: 'node', argv: ['node', '--test'], result: { adapter: 'node-tap', path: 'r.tap' } }, ['t/a.test.mjs'], ['node', '--test', 't/a.test.mjs']],
    [{ id: 'jest', argv: ['npm', 'test', '--', '--json', '--outputFile', 'r.json'], result: { adapter: 'jest-json', path: 'r.json' } }, ['a.test.js'],
      ['npm', 'test', '--', '--json', '--outputFile', 'r.json', '--runTestsByPath', 'a.test.js']],
    [{ id: 'vitest', argv: ['pnpm', 'test', '--reporter=json', '--outputFile=r.json'], result: { adapter: 'vitest-json', path: 'r.json' } }, ['a.test.ts'],
      ['pnpm', 'test', '--reporter=json', '--outputFile=r.json', 'a.test.ts']],
    [{ id: 'pw', argv: ['npx', 'playwright', 'test', '--reporter=json'], result: { adapter: 'playwright-json', path: 'r.json' } }, ['e2e/a.spec.ts'],
      ['npx', 'playwright', 'test', '--reporter=json', 'e2e/a.spec.ts']],
    [{ id: 'pytest', argv: ['python3', '-B', '-m', 'pytest', '--junitxml=r.xml'], result: junit('r.xml') }, ['tests/test_a.py'], ['python3', '-B', '-m', 'pytest', '--junitxml=r.xml', 'tests/test_a.py']],
    [{ id: 'mvn', argv: ['mvn', 'test'], result: junit('target/surefire-reports') }, ['src/test/java/a/FooTest.java', 'src/test/java/a/BarTest.java'],
      ['mvn', 'test', '-Dtest=BarTest,FooTest', '-Dsurefire.failIfNoSpecifiedTests=false']],
    [{ id: 'gradle', argv: ['./gradlew', 'test'], result: junit('build/test-results/test') }, ['src/test/kotlin/FooTest.kt'], ['./gradlew', 'test', '--tests', '*FooTest']],
    [{ id: 'go', argv: ['go', 'test', '-json', './...'], result: { adapter: 'go-test-json', path: 'r.jsonl' } }, ['pkg/a/a_test.go', 'pkg/a/b_test.go', 'c_test.go'], ['go', 'test', '-json', '.', './pkg/a']],
    [{ id: 'dotnet', argv: ['dotnet', 'test', '--logger', 'trx'], result: { adapter: 'dotnet-trx', path: 'TestResults' } }, ['Tests/FooTests.cs'], ['dotnet', 'test', '--logger', 'trx', '--filter', 'FullyQualifiedName~FooTests']]
  ];
  for (const [command, files, argv] of cases) {
    const result = await selected(command, [...files].sort());
    assert.deepEqual(result.argv, argv, command.id);
    assert.deepEqual(result.testScope.files, [...files].sort(), command.id);
    assert.deepEqual(result.testScope.baseCommand.argv, command.argv, `${command.id} keeps the whole command, so a whole run still stands for it`);
  }
});

test('only-new runs a command whole where narrowing it could lose tests, and says why', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-test-scope-whole-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', chained: 'node --test && eslint .', dir: 'node --test test/unit' } }));
  const whole = async (command, files = ['t/a.test.mjs']) => {
    const [result] = await newAndChangedTestCommands(root, [inferred(command)], files);
    assert.equal(result.testScope.files, undefined, command.id);
    assert.deepEqual(result.argv, command.argv, `${command.id} runs as it is`);
    return result.testScope.whole;
  };
  const tap = { adapter: 'node-tap', path: 'r.tap' };
  assert.match(await whole({ id: 'a', argv: ['npm', 'run', 'chained'], result: tap }), /cannot be told to run single files/u, 'the files would reach eslint');
  assert.match(await whole({ id: 'b', argv: ['npm', 'run', 'dir'], result: tap }), /cannot be told/u, 'it would still run test/unit');
  assert.match(await whole({ id: 'c', argv: ['npm', 'test'], result: tap }, []), /changed no test here/u);
  assert.match(await whole({ id: 'd', argv: ['mvn', 'verify'], result: { adapter: 'junit-xml', path: 'target/failsafe-reports' } }, ['src/test/java/FooIT.java']), /cannot be told/u);
  assert.match(await whole({ id: 'e', argv: ['swift', 'test'], result: { adapter: 'junit-xml', path: 'r' } }, ['Tests/FooTests.swift']), /cannot be told/u);
  const [named] = await newAndChangedTestCommands(root, [inferred({ id: 'f', provenance: 'configured', argv: ['npm', 'test'], result: tap })], ['t/a.test.mjs']);
  assert.match(named.testScope.whole, /runs as written/u, 'a reviewed check is not narrowed by a Story setting');
  const several = await newAndChangedTestCommands(root, [inferred({ id: 'g', argv: ['npm', 'test'], result: tap }),
    inferred({ id: 'h', argv: ['npx', 'playwright', 'test'], result: { adapter: 'playwright-json', path: 'r.json' } })], ['t/a.test.mjs']);
  for (const command of several) assert.match(command.testScope.whole, /several test runners/u);
});
