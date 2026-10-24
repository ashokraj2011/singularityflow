/**
 * A step with no runner Singularity Flow can infer, through a whole quick-fix Story.
 *
 * Publication refuses with CODE_DELIVERY_TEST_COMMAND_REQUIRED and names the routes. The developer
 * requests the exact command that runs the tests (`decision test-command`); a person who approves the
 * step accepts it from the decision list; publication and submission then run it like a configured
 * command, and its tests must pass. The repository configuration never changes.
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

test('a step approver accepts a Story-only test command, and publication and submission run it', { timeout: 300_000 }, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-test-command-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const failFlag = path.join(base, 'fail.flag');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Runner Tester',
    SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Runner Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'runner.tester@example.invalid' };
  delete env.NODE_TEST_CONTEXT;
  const run = (command, args, cwd = root) => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: childTimeout(180_000) });
  const must = (command, args, cwd = root) => {
    const result = run(command, args, cwd);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
  const json = (...args) => JSON.parse(sflow(...args, '--json'));
  // A second person, who reviews the Story, decides what the developer asked.
  const asReviewer = (...args) => {
    const result = spawnSync(process.execPath, [cli, '--no-model', ...args, '--json'], { cwd: root, encoding: 'utf8', timeout: childTimeout(180_000),
      env: { ...env, SINGULARITY_FLOW_TEST_IDENTITY: 'Runner Reviewer', GIT_CONFIG_VALUE_0: 'Runner Reviewer', GIT_CONFIG_VALUE_1: 'runner.reviewer@example.invalid' } });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const refused = (...args) => {
    const result = run(process.execPath, [cli, '--no-model', ...args, '--json']);
    assert.notEqual(result.status, 0, `${args.join(' ')} should be refused\n${result.stdout}`);
    return JSON.parse(result.stdout);
  };

  must('git', ['init', '-q', '-b', 'main', root], base);
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'checks'));
  // No test script and a test file in no language SFlow runs: nothing is inferred.
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  await writeFile(path.join(root, '.gitignore'), '.sflow/results/\n');
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'checks/value_test.py'), '# The repository runner checks src/value.mjs.\n');
  // The team's own runner: reads the value and writes SFlow's structured result.
  await writeFile(path.join(root, 'run-checks.mjs'), [
    "import { existsSync, mkdirSync, writeFileSync } from 'node:fs';",
    "const { value } = await import('./src/value.mjs');",
    `const passed = value === 2 && !existsSync(${JSON.stringify(failFlag)});`,
    "mkdirSync('.sflow/results', { recursive: true });",
    "writeFileSync('.sflow/results/checks.json', JSON.stringify({ run: Date.now(), tests: { discovered: 1, passed: passed ? 1 : 0, failed: passed ? 0 : 1, skipped: 0 } }));",
    'process.exit(passed ? 0 : 1);', ''].join('\n'));
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  const configured = await readFile(configPath, 'utf8');
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Story-only runner fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.');
  sflow('prepare', 'intake');
  await writeFile(path.join(root, 'singularity/work-items/QF-1/artifacts/intake/intake.md'), [
    '# QF-1 — Quick fix scope and plan', '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', '| [QF-1:AC-001] | The exported value equals 2. |', '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    '| `QF-1:AC-001` | `src/value.mjs` | `checks/value_test.py` | modified | The check reads 2. |', '',
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n'));
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  sflow('submit', 'intake');
  sflow('approve', 'intake', '--yes');

  sflow('resume', 'QF-1');
  sflow('phase', 'begin', 'implement', '--json');
  // Before any code is written, the planned paths already show that no runner will be found.
  const early = json('recover', 'QF-1', '--phase', 'implement');
  const earlyExecution = early.testExecution ?? early.data?.testExecution;
  assert.deepEqual(earlyExecution?.planned, { runner: 'missing', commands: [] }, JSON.stringify(earlyExecution));
  assert.equal(earlyExecution.reason, 'CODE_DELIVERY_TEST_COMMAND_REQUIRED');
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 2;\n');
  await writeFile(path.join(root, 'checks/value_test.py'), '# @ac:QF-1:AC-001\n# The repository runner checks src/value.mjs reads 2.\n');
  sflow('prepare', 'implement');

  // No runner: the refusal names the Story-only route and test setup.
  const blocked = refused('phase', 'publish', 'implement');
  assert.equal(blocked.error.code, 'CODE_DELIVERY_TEST_COMMAND_REQUIRED');
  const routes = blocked.remediationPlan.steps.map((step) => step.command ?? '').join('\n');
  assert.match(routes, /singularity-flow decision test-command QF-1 --phase implement /u);
  assert.match(routes, /singularity-flow capability test-setup /u);
  const recovery = json('recover', 'QF-1', '--phase', 'implement');
  const recoveryActions = recovery.actions ?? recovery.data?.actions ?? [];
  assert.ok(recoveryActions.some((entry) => entry.id === 'request-story-test-command:implement'
    && /decision test-command QF-1 --phase implement/u.test(entry.detail)), JSON.stringify(recoveryActions.map((entry) => entry.id)));

  const requested = json('decision', 'test-command', '--phase', 'implement', '--id', 'repository-checks',
    '--argv', JSON.stringify([process.execPath, 'run-checks.mjs']), '--working-directory', '.', '--affected-root', '.',
    '--adapter', 'sflow-test-result-v1', '--report', '.sflow/results/checks.json', '--reason', 'The team runs run-checks.mjs for this module.');
  assert.equal(requested.data.record.id, 'TCD-001');
  assert.equal(requested.next[0].command, 'singularity-flow decision test-command QF-1 --accept TCD-001');
  assert.equal(refused('phase', 'publish', 'implement').error.code, 'CODE_DELIVERY_TEST_COMMAND_REQUIRED', 'a request alone runs nothing');

  // The step's approvers see it in their decision list and accept it there.
  const list = asReviewer('decisions', 'QF-1', '--phase', 'implement');
  const item = list.data.items.find((entry) => entry.kind === 'test-command');
  assert.ok(item, JSON.stringify(list.data.items.map((entry) => entry.kind)));
  assert.equal(item.options[0].id, 'accept-test-command');
  asReviewer('decisions', 'record', 'QF-1', '--phase', 'implement', '--choose', `${item.id}=accept-test-command`, '--confirm', list.data.packetSha256);

  // A revised request is accepted from the reviewer's terminal and replaces the first.
  json('decision', 'test-command', '--phase', 'implement', '--id', 'repository-checks',
    '--argv', JSON.stringify([process.execPath, 'run-checks.mjs', '--verbose']), '--working-directory', '.', '--affected-root', '.',
    '--adapter', 'sflow-test-result-v1', '--report', '.sflow/results/checks.json', '--reason', 'The runner now prints each check it makes.');
  asReviewer('decision', 'test-command', 'QF-1', '--accept', 'TCD-002');

  const checked = json('phase', 'prepublish', 'implement');
  assert.deepEqual(checked.testExecution.commands.map((entry) => [entry.id, entry.provenance ?? entry.argvSource]),
    [['repository-checks', 'story-decision']]);
  // Its tests must pass like any other command.
  await writeFile(failFlag, 'fail\n');
  assert.equal(refused('phase', 'publish', 'implement').error.code, 'CODE_TEST_FAILED');
  await rm(failFlag);
  sflow('phase', 'publish', 'implement');
  sflow('submit', 'implement');
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));
  assert.deepEqual(workflow.phases.implement.storyTestCommands.map((entry) => [entry.storyDecision.id, entry.argv.at(-1)]), [['TCD-002', '--verbose']]);
  assert.ok(workflow.phases.implement.deliveryEvidence.testExecutions.some((entry) => entry.commandId === 'repository-checks' && entry.status === 'passed'),
    JSON.stringify(workflow.phases.implement.deliveryEvidence.testExecutions));
  assert.equal(await readFile(configPath, 'utf8'), configured, 'the repository configuration never changed');
  // Once the step has moved on, its test commands are no longer decided.
  assert.equal(refused('decision', 'test-command', '--revoke', 'TCD-002', '--reason', 'The repository now configures this runner.').error.code,
    'TEST_COMMAND_DECISION_CLOSED');
});
