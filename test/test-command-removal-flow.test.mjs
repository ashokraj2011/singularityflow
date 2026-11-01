/**
 * A pinned test suite deleted from its package, through a whole quick-fix step [TCE:REQ-012].
 *
 * The gate compared only the commands it inferred now, so deleting `test:node` from a package that
 * runs Jest and node:test dropped the node:test suite with Jest's pin unchanged and nothing refused
 * (review, 2026-11-01). Now the suite's removal is refused before anything runs; anyone may ask that
 * it no longer run, a person who approves the step accepts it, and the step publishes again.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

// A stand-in Jest on the npm script PATH: it reports one passing test in Jest's JSON form.
const FAKE_JEST = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const at = process.argv.indexOf('--outputFile');
const out = process.argv[at + 1];
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0,
  testResults: [{ assertionResults: [{ title: 'value', fullName: 'value', ancestorTitles: [], status: 'passed', duration: 1 }] }] }));
`;

test('a pinned suite deleted from its package is refused until a person who approves the step accepts that it no longer runs', slowLane({ timeout: 600_000 }), async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-test-command-removal-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Pin Tester',
    SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Pin Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'pin.tester@example.invalid' };
  delete env.NODE_TEST_CONTEXT;
  const run = (command, args, cwd = root, extra = {}) => spawnSync(command, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: childTimeout(180_000) });
  const must = (command, args, cwd = root) => {
    const result = run(command, args, cwd);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
  const json = (...args) => JSON.parse(sflow(...args, '--json'));
  const asReviewer = (...args) => {
    const result = run(process.execPath, [cli, '--no-model', ...args, '--json'], root,
      { SINGULARITY_FLOW_TEST_IDENTITY: 'Pin Reviewer', GIT_CONFIG_VALUE_0: 'Pin Reviewer', GIT_CONFIG_VALUE_1: 'pin.reviewer@example.invalid' });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const refusal = (...args) => {
    const result = run(process.execPath, [cli, '--no-model', ...args, '--json']);
    assert.notEqual(result.status, 0, `${args.join(' ')} should be refused\n${result.stdout}`);
    return JSON.parse(result.stdout);
  };
  const stored = async () => JSON.parse(await readFile(path.join(root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));
  const writeScripts = (scripts) => writeFile(path.join(root, 'package.json'),
    JSON.stringify({ type: 'module', private: true, scripts, devDependencies: { jest: '29.0.0' } }));

  must('git', ['init', '-q', '-b', 'main', root], base);
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test')); await mkdir(path.join(root, 'node_modules/.bin'), { recursive: true });
  await writeScripts({ test: 'jest', 'test:node': 'node --test' });
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.sflow/results/\n');
  await writeFile(path.join(root, 'node_modules/.bin/jest'), FAKE_JEST);
  await chmod(path.join(root, 'node_modules/.bin/jest'), 0o755);
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\ntest('value', () => assert.equal(value, 1));\n");
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Two test suites fixture']);
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
    '## Supporting files', '', '- `package.json` — the module\'s test scripts may change.', '',
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n'));
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  sflow('submit', 'intake');
  sflow('approve', 'intake', '--yes');

  sflow('resume', 'QF-1');
  sflow('phase', 'begin', 'implement', '--json');
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 2;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "import { value } from '../src/value.mjs';\n// @ac:QF-1:AC-001\ntest('value', () => assert.equal(value, 2));\n");
  sflow('prepare', 'implement');
  // The first gate run pins both suites the package declares.
  sflow('phase', 'publish', 'implement');
  const pinned = (await stored()).testCommandPins;
  assert.deepEqual(pinned.map((pin) => [pin.commandId, pin.definitionVersion]), [['.-node-tests', 2], ['node-test-tests', 2]]);

  // The agent changes the code again and deletes test:node: refused before anything runs.
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 1 + 1;\n');
  await writeScripts({ test: 'jest' });
  const preview = json('phase', 'rollover', 'implement');
  sflow('phase', 'rollover', 'implement', '--confirm', preview.confirmation);
  const removed = refusal('phase', 'publish', 'implement');
  assert.equal(removed.error.code, 'TEST_COMMAND_PIN_CHANGED', JSON.stringify(removed.error));
  assert.match(removed.error.message, /Test command 'node-test-tests' was pinned for this Story \(TCP-002\) and no longer runs/u);
  const requestCommand = 'singularity-flow decision test-command QF-1 --phase implement --repin node-test-tests --reason "<why the test command changed>"';
  assert.equal(removed.error.details.testCommandPin.command, requestCommand);

  // Anyone may ask that it no longer run; until a person accepts, the refusal stands.
  const requested = json('decision', 'test-command', '--phase', 'implement', '--repin', 'node-test-tests',
    '--reason', 'The node:test suite moved into the Jest run.');
  assert.equal(requested.data.record.repin.removed, true);
  assert.equal(requested.data.record.repin.pinned, pinned[1].sha256);
  assert.equal(refusal('phase', 'publish', 'implement').error.code, 'TEST_COMMAND_PIN_CHANGED');
  const listed = asReviewer('decisions', 'QF-1', '--phase', 'implement').data.items.find((item) => item.kind === 'test-command');
  assert.match(listed.title, /^Stop running node-test-tests, a test suite removed from/u);

  asReviewer('decision', 'test-command', 'QF-1', '--accept', requested.data.record.id);
  sflow('phase', 'publish', 'implement');
  const after = (await stored()).testCommandPins;
  assert.deepEqual(after.map((pin) => pin.id), ['TCP-001', 'TCP-002'], 'a removal adds no pin; the step publishes with the suites that remain');
});
