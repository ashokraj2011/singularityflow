/**
 * A suite whose every test skips itself here (no Docker daemon or database), through a whole
 * quick-fix Story. The run exits 0 yet no test executes: publication refuses it as an environment
 * cause and names the step approvers' route, an approver whose checkout never ran it binds the
 * command by the digest the refusal gave, and the run stays recorded as not passing. When that
 * decision is revoked, approval and the step that consumes Code's tests name its renewal instead
 * of only sending the work back; renewed, the Story closes with the criterion as an exception.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { childTimeout } from './helpers/child-timeout.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

test('every test skipped is an environment cause the step approvers can accept, from any checkout, and renew', { timeout: 300_000 }, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-skipped-tests-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const noDatabase = path.join(base, 'no-database.flag');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Skip Risk Tester',
    SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Skip Risk Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'skip.risk@example.invalid' };
  const run = (command, args, cwd = root) => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: childTimeout(180_000) });
  const must = (command, args, cwd = root) => {
    const result = run(command, args, cwd);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
  const refusal = (...args) => {
    const result = run(process.execPath, [cli, '--no-model', ...args, '--json']);
    assert.notEqual(result.status, 0, `${args.join(' ')} should be refused\n${result.stdout}`);
    return JSON.parse(result.stdout);
  };
  const refused = (...args) => refusal(...args).error;
  // The way out a refusal names is in its recovery plan, which every surface renders.
  const planCommands = (envelope) => (envelope.remediationPlan?.steps ?? []).map((entry) => entry.command).filter(Boolean);
  // The test skips itself while the flag exists, as an integration suite does without its database.
  const writeTest = (tag = '') => writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\n"
    + "import assert from 'node:assert/strict';\nimport { existsSync } from 'node:fs';\nimport { value } from '../src/value.mjs';\n"
    + `${tag}test('value', { skip: existsSync(${JSON.stringify(noDatabase)}) ? 'no database here' : false }, () => assert.equal(value, 2));\n`);

  must('git', ['init', '-q', '-b', 'main', root], base);
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\ntest('value', () => assert.equal(value, 1));\n");
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // Code is approved by its own reviewers, and verification consumes Code's tests.
  config.phases.implement.approval = { authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['implement'] };
  Object.assign(config.phases.verify, { testEvidenceFrom: 'implement', writeScope: 'artifact-only' });
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Skipped tests fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', 'QF-2', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.');
  sflow('prepare', 'intake');
  await writeFile(path.join(root, 'singularity/work-items/QF-2/artifacts/intake/intake.md'), [
    '# QF-2 — Quick fix scope and plan', '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', '| [QF-2:AC-001] | The exported value equals 2. |', '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    '| `QF-2:AC-001` | `src/value.mjs` | `test/value.test.mjs` | modified | The test reads 2. |', '',
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n'));
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  sflow('submit', 'intake');
  sflow('approve', 'intake', '--yes');

  sflow('resume', 'QF-2');
  sflow('phase', 'begin', 'implement', '--json');
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-2:AC-001 the exported value is the approved 2\nexport const value = 2;\n');
  await writeTest('// @ac:QF-2:AC-001\n');
  sflow('prepare', 'implement');

  // No database: the suite exits 0 with its one test skipped. That is never a pass.
  await writeFile(noDatabase, 'none\n');
  const blocked = refused('phase', 'publish', 'implement');
  assert.equal(blocked.code, 'CODE_TEST_FAILED');
  assert.match(blocked.message, /did not produce passing test evidence before publication \(exit 0\)/u);
  assert.match(blocked.message, /No test executed in this run, so the environment may be what stopped it/u);
  assert.equal(blocked.requiredTestExecution.failure.kind, 'all-tests-skipped');
  assert.match(blocked.requiredTestExecution.failure.guidance, /A skipped test is not a pass/u);
  assert.equal(blocked.details.testRunRisk.eligible, true);
  const commandId = blocked.details.testRunRisk.commandId;
  const digest = blocked.details.testRunRisk.command.match(/--argv-sha256 ([a-f0-9]{64})$/u)?.[1];
  assert.ok(digest, blocked.details.testRunRisk.command);

  // The approver's checkout has no record of that run (it is kept in the author's private Git storage).
  await rm(path.join(root, '.git', 'singularity-flow', 'test-attempts'), { recursive: true, force: true });
  const unbound = refused('decision', 'test-risk', '--phase', 'implement', '--command', commandId,
    '--cause', 'The integration database is not reachable here.', '--reason', 'CI runs the same tests with a database before merge.',
    '--expires', inDays(30));
  assert.equal(unbound.code, 'TEST_RUN_RISK_NOT_ELIGIBLE');
  assert.match(unbound.message, /--argv-sha256/u);
  assert.equal(refused('decision', 'test-risk', '--phase', 'implement', '--command', commandId, '--argv-sha256', 'not-a-digest',
    '--cause', 'The integration database is not reachable here.', '--reason', 'CI runs the same tests with a database before merge.',
    '--expires', inDays(30)).code, 'TEST_RUN_RISK_INVALID');
  const accepted = JSON.parse(sflow('decision', 'test-risk', '--phase', 'implement', '--command', commandId, '--argv-sha256', digest,
    '--cause', 'The integration database is not reachable here.', '--reason', 'CI runs the same tests with a database before merge.',
    '--expires', inDays(30), '--json'));
  assert.equal(accepted.data.record.id, 'TRR-001');
  assert.equal(accepted.data.record.boundBy, 'command-digest');
  assert.equal(accepted.data.record.argvSha256, digest);

  // Still no database: the run is let through, and recorded as what it was.
  sflow('phase', 'publish', 'implement');
  sflow('submit', 'implement');
  const workflowPath = path.join(root, 'singularity/work-items/QF-2/workflow.json');
  const submitted = JSON.parse(await readFile(workflowPath, 'utf8'));
  const evidence = submitted.phases.implement.deliveryEvidence;
  assert.equal(evidence.status, 'ready');
  assert.equal(evidence.testExecutions[0].testRunRisk.id, 'TRR-001');
  assert.equal(evidence.testExecutions[0].status, 'failed', 'a run in which every test skipped is not a pass');
  assert.equal(evidence.validation.status, 'failed');
  assert.equal(evidence.validation.checks[0].testRunRisk.id, 'TRR-001');
  assert.equal(submitted.phases.implement.status, 'awaiting_approval');
  const accept = (...extra) => sflow('decision', 'test-risk', '--phase', 'implement', '--command', commandId, '--argv-sha256', digest,
    '--cause', 'The integration database is not reachable here.', '--reason', 'CI runs the same tests with a database before merge.',
    '--expires', inDays(30), ...extra);
  const renewal = new RegExp(`singularity-flow decision test-risk QF-2 --phase implement --command ${commandId.replaceAll('.', '\\.')} .* --expires <YYYY-MM-DD> --argv-sha256 ${digest}`, 'u');

  // Revoked before approval: approval names the renewal instead of only a return for repair.
  sflow('decision', 'test-risk', '--revoke', 'TRR-001', '--reason', 'The database is expected to be reachable again soon.');
  const unapproved = refusal('approve', 'implement', '--yes');
  assert.equal(unapproved.error.code, 'PHASE_VALIDATION_FAILED');
  assert.match(unapproved.error.message, /TRR-001 was revoked, so the run of .* it let through \(no test executed\) is no longer carried/u);
  assert.match(unapproved.error.message, renewal);
  accept();
  sflow('approve', 'implement', '--yes');

  // Revoked after approval: the step that consumes Code's tests names the renewal, not a redo of Code.
  sflow('decision', 'test-risk', '--revoke', 'TRR-002', '--reason', 'The database is expected to be reachable again soon.');
  sflow('prepare', 'verify');
  const lapsed = refusal('phase', 'publish', 'verify', '--authored', 'deterministic');
  assert.equal(lapsed.error.code, 'PRIOR_CODE_TEST_EVIDENCE_REQUIRED', JSON.stringify(lapsed.error));
  assert.match(lapsed.error.message, /TRR-002 was revoked, so the run of .* it let through \(no test executed\) is no longer carried/u);
  assert.doesNotMatch(lapsed.error.message, /finish and approve the Code phase/u);
  assert.match(lapsed.error.message, renewal);
  assert.ok(planCommands(lapsed).some((command) => renewal.test(command)), JSON.stringify(lapsed.remediationPlan));

  // Renewed, the run is carried again and the Story completes with the criterion as an exception.
  accept();
  sflow('phase', 'publish', 'verify', '--authored', 'deterministic');
  sflow('submit', 'verify');
  const closing = JSON.parse(await readFile(workflowPath, 'utf8'));
  if (closing.phases.verify.status !== 'approved') sflow('approve', 'verify', '--yes');
  assert.equal(JSON.parse(await readFile(workflowPath, 'utf8')).status, 'closed');
  const matrix = JSON.parse(sflow('evidence', 'matrix', '--json')).data.matrix.evaluation;
  assert.equal(matrix.summary.results['satisfied-with-exception'], 1, JSON.stringify(matrix.summary.results));
  assert.equal(matrix.summary.results.satisfied, 0, 'a skipped test is never a pass');
});

function inDays(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
