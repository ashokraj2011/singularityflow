/**
 * Quick-fix's implement step: the agent writes the code, the engine builds the summary.
 *
 * Its producer is deterministic because the summary is assembled from what changed. From
 * 2026-10-08 the session cleared the agent, entry refused composition and the mutation contract
 * refused source edits for every deterministic step, so /sf-code (which every route offered)
 * could only regenerate an empty summary and stop: "codeAuthoringReady is false".
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

test('a quick-fix implement step is coded by its agent and published with an engine-built summary', { timeout: 300_000 }, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-deterministic-code-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Quick Fix Tester',
    SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Quick Fix Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'quick.fix@example.invalid' };
  const run = (command, args, cwd = root) => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
  const must = (command, args, cwd = root) => {
    const result = run(command, args, cwd);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
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
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Quick fix fixture']);
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

  // /sf-next said to select the agent first; /sf-code then opens the generation and enters.
  sflow('resume', 'QF-1');
  sflow('phase', 'begin', 'implement', '--json');
  const entry = JSON.parse(sflow('phase', 'enter', '--compose', '--for-agent', '--json'));
  assert.equal(entry.status, 'authoring-entry');
  assert.equal(entry.codeAuthoringReady, true, 'the agent may write this step\'s code');
  assert.ok(entry.context?.text?.length > 0, 'with the composed context');
  assert.match(entry.mutationContract.summary, /summary is built by `singularity-flow prepare` from what changed/u);

  // The agent's planned change; the engine builds the summary and publication runs the tests.
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 2;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\n// @ac:QF-1:AC-001\ntest('value', () => assert.equal(value, 2));\n");
  sflow('prepare', 'implement');
  const published = JSON.parse(sflow('phase', 'prepublish', 'implement', '--for-agent', '--json', '--publish-if-ready'));
  assert.equal(published.status, 'ready', JSON.stringify(published.findings));
  assert.equal(published.publishIfReady.published, true);
  assert.equal(published.publishIfReady.next.commandGuidance.copilotCommand, '/sf-submit');
});
