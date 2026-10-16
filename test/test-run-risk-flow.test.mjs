/**
 * A test command the environment cannot run, through a whole quick-fix Story.
 *
 * Maven that cannot reach its repository, a missing JDK or Docker: the run fails before a single
 * test executes, and until now publication refused it with no way out but fixing the machine. A
 * person who approves the step may accept that risk (`decision test-risk`); the tests still run
 * every time, only a run in which no test executed is let through, and the acceptance carries the
 * step through approval and is shown as an exception in the evidence matrix.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

test('a step approver accepts that the environment cannot run its tests, and the Story carries on', { timeout: 300_000 }, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-test-run-risk-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const offline = path.join(base, 'repository-unreachable.flag');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Env Risk Tester',
    SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Env Risk Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'env.risk@example.invalid' };
  const run = (command, args, cwd = root) => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
  const must = (command, args, cwd = root) => {
    const result = run(command, args, cwd);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
  const refused = (...args) => {
    const result = run(process.execPath, [cli, '--no-model', ...args, '--json']);
    assert.notEqual(result.status, 0, `${args.join(' ')} should be refused\n${result.stdout}`);
    return JSON.parse(result.stdout).error;
  };
  const writeTest = (expected) => writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\n"
    + "import assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\n// @ac:QF-1:AC-001\n"
    + `test('value', () => assert.equal(value, ${expected}));\n`);

  must('git', ['init', '-q', '-b', 'main', root], base);
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  // npm runs `pretest` first; while the flag exists it fails like a build that cannot resolve its
  // dependencies, before any test runs.
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: {
    pretest: `node -e "if (require('node:fs').existsSync(process.argv[1])) { console.error('Could not resolve dependencies: the repository is unreachable'); process.exit(1); }" ${JSON.stringify(offline)}`,
    test: 'node --test'
  } }));
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\ntest('value', () => assert.equal(value, 1));\n");
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Environment risk fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.');
  sflow('prepare', 'intake');
  await writeFile(path.join(root, 'singularity/work-items/QF-1/artifacts/intake/intake.md'), [
    '# QF-1 — Quick fix scope and plan', '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', '| [QF-1:AC-001] | The exported value equals 2. |', '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    '| `QF-1:AC-001` | `src/value.mjs` | `test/value.test.mjs` | modified | The test reads 2. |', '',
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n'));
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  sflow('submit', 'intake');
  sflow('approve', 'intake', '--yes');

  sflow('resume', 'QF-1');
  sflow('phase', 'begin', 'implement', '--json');
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 2;\n');
  await writeTest(2);
  sflow('prepare', 'implement');

  // The repository is unreachable: no test executes, and the refusal names the approvers' route.
  await writeFile(offline, 'offline\n');
  const blocked = refused('phase', 'publish', 'implement');
  assert.equal(blocked.code, 'CODE_TEST_FAILED');
  assert.match(blocked.message, /No test executed in this run, so the environment may be what stopped it/u);
  assert.equal(blocked.details.testRunRisk.eligible, true);
  assert.match(blocked.details.testRunRisk.command, /^singularity-flow decision test-risk QF-1 --phase implement --command /u);
  const commandId = blocked.details.testRunRisk.commandId;

  // Nothing can be accepted without a cause, or for a step with no such run.
  assert.equal(refused('decision', 'test-risk', '--phase', 'implement', '--reason', 'CI runs these tests before merge.',
    '--expires', inDays(30)).code, 'TEST_RUN_RISK_INVALID');
  assert.equal(refused('decision', 'test-risk', '--phase', 'intake', '--cause', 'The repository is unreachable here.',
    '--reason', 'CI runs these tests before merge.', '--expires', inDays(30)).code, 'TEST_RUN_RISK_NOT_ELIGIBLE');

  const accepted = JSON.parse(sflow('decision', 'test-risk', '--phase', 'implement', '--command', commandId,
    '--cause', 'The Maven repository is unreachable from this laptop.',
    '--reason', 'CI runs the same tests against the repository before merge.', '--expires', inDays(30), '--json'));
  assert.equal(accepted.data.record.id, 'TRR-001');
  assert.equal(accepted.data.record.observation.testsExecuted, 0);

  // Tests that run and fail are never covered, decision or not.
  await rm(offline);
  await writeTest(3);
  const failing = refused('phase', 'publish', 'implement');
  assert.equal(failing.code, 'CODE_TEST_FAILED');
  assert.equal(failing.details?.testRunRisk, undefined, 'a run in which tests executed gets no risk route');

  // Offline again: the tests run, none executes, and the decision lets the step through.
  await writeTest(2);
  await writeFile(offline, 'offline\n');
  sflow('phase', 'publish', 'implement');
  sflow('submit', 'implement');
  const workflowPath = path.join(root, 'singularity/work-items/QF-1/workflow.json');
  const submitted = JSON.parse(await readFile(workflowPath, 'utf8'));
  const evidence = submitted.phases.implement.deliveryEvidence;
  assert.equal(evidence.status, 'ready');
  assert.equal(evidence.testExecutions[0].testRunRisk.id, 'TRR-001');
  assert.notEqual(evidence.testExecutions[0].status, 'passed', 'what was observed stays visible');
  // The review says what the run was: accepted, not passed.
  const review = JSON.parse(sflow('phase', 'show', 'implement', '--json'));
  assert.equal(review.testEvidence.acceptedRisks.length, 1);
  assert.equal(review.testEvidence.acceptedRisks[0].id, 'TRR-001');
  assert.match(review.testEvidence.acceptedRisks[0].words, /^No test ran for .*: The Maven repository is unreachable from this laptop\. Accepted as TRR-001 .*it is not a pass\.$/u);
  const shown = run(process.execPath, [cli, '--no-model', 'phase', 'show', 'implement']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stderr, /Accepted risk: No test ran for /u);

  // Quick-fix's implement step needs no approval of its own; submission settles it.
  const settled = JSON.parse(await readFile(workflowPath, 'utf8'));
  assert.equal(settled.phases.implement.status, 'approved');

  // The evidence matrix shows the criterion as satisfied with an exception, never as passed.
  const evaluation = () => JSON.parse(sflow('evidence', 'matrix', '--json')).data.matrix.evaluation;
  const excepted = evaluation();
  assert.equal(excepted.summary.results['satisfied-with-exception'], 1, JSON.stringify(excepted.summary.results));
  assert.equal(excepted.summary.results.satisfied, 0);
  assert.equal(excepted.decision.gate, 'allow-with-risk');

  // Revoking it takes the exception away again.
  sflow('decision', 'test-risk', '--revoke', 'TRR-001', '--reason', 'The repository is reachable again from the office network.');
  const revoked = evaluation();
  assert.equal(revoked.summary.results['satisfied-with-exception'], 0, JSON.stringify(revoked.summary.results));
  assert.notEqual(revoked.decision.gate, 'allow-with-risk');

  // A renewal on the same command carries the run the revoked decision let through.
  sflow('decision', 'test-risk', '--phase', 'implement', '--command', commandId,
    '--cause', 'The Maven repository is unreachable from this laptop.',
    '--reason', 'CI runs the same tests against the repository before merge.', '--expires', inDays(30));
  assert.equal(evaluation().summary.results['satisfied-with-exception'], 1);

  // The Story completes with the accepted risk: its final gate replays the receipt as of its end.
  sflow('prepare', 'verify');
  sflow('phase', 'publish', 'verify', '--authored', 'deterministic');
  sflow('submit', 'verify');
  const closing = JSON.parse(await readFile(workflowPath, 'utf8'));
  if (closing.phases.verify.status !== 'approved') sflow('approve', 'verify', '--yes');
  const closed = JSON.parse(await readFile(workflowPath, 'utf8'));
  assert.equal(closed.status, 'closed', JSON.stringify(Object.fromEntries(closed.phaseOrder.map((id) => [id, closed.phases[id].status]))));
  assert.equal(evaluation().summary.results['satisfied-with-exception'], 1, 'the exception stays visible after completion');
});

function inDays(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
