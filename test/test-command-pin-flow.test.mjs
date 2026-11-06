/**
 * A guessed test command pinned for the Story, through a whole quick-fix Story [TCE:REQ-010].
 *
 * Inference was recomputed at every publication, so an agent could narrow the package script
 * behind `npm test` and the gate ran the narrower suite. Now the first gate run pins the command
 * and what it resolves through; the narrowed script is refused before it runs, naming what changed.
 * Anyone may request the new pin; a person who approves the step accepts it, the next publication
 * records it in place of the old one, and the Story closes with every attempt's pin replayed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

test('a guessed test command is pinned at first use, and a narrowed script waits for a person who approves the step', slowLane({ timeout: 600_000 }), async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-test-command-pin-'));
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
  // A second person, who approves the Story's verification, decides what the developer asked.
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
  const planCommands = (envelope) => (envelope.remediationPlan?.steps ?? []).map((entry) => entry.command).filter(Boolean);
  const workflowPath = path.join(root, 'singularity/work-items/QF-1/workflow.json');
  const stored = async () => JSON.parse(await readFile(workflowPath, 'utf8'));
  const writeScript = (test) => writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test } }));

  must('git', ['init', '-q', '-b', 'main', root], base);
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test')); await mkdir(path.join(root, 'node_modules/.bin'), { recursive: true });
  await writeScript('node --test');
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.sflow/results/\n');
  await writeFile(path.join(root, 'node_modules/.bin/jest'), FAKE_JEST);
  await writeFile(path.join(root, 'node_modules/.bin/jest.cmd'), '@echo off\r\nnode "%~dp0jest" %*\r\n');
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
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Pinned test command fixture']);
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
    '## Supporting files', '', '- `package.json` — the module\'s test script may move to Jest.', '',
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

  // The first gate run pins the guessed command and the script behind it [TCE:REQ-011].
  sflow('phase', 'publish', 'implement');
  const [first] = (await stored()).testCommandPins;
  assert.equal(first.id, 'TCP-001');
  assert.equal(first.commandId, '.-node-tests');
  assert.deepEqual(first.source, { kind: 'inferred' });
  assert.deepEqual(first.argv, ['npm', 'test']);
  assert.equal(first.adapter, 'node-tap');
  assert.ok(first.definition.some((entry) => entry.path === 'package.json' && entry.selector === 'scripts.test'), JSON.stringify(first.definition));
  assert.equal(first.baseline.discovered, 1, 'its first passing run is the baseline later runs are compared with');
  const attemptsDirectory = path.join(root, 'singularity/work-items/QF-1/context/code-delivery/tests/attempts/implement');
  const attempts = await Promise.all((await readdir(attemptsDirectory)).map(async (name) => JSON.parse(await readFile(path.join(attemptsDirectory, name), 'utf8'))));
  assert.ok(attempts.length && attempts.every((attempt) => attempt.pin?.sha256 === first.sha256), 'each attempt carries the pin it ran under');

  // The agent changes the code again and narrows the script behind `npm test`: refused before
  // anything runs [TCE:REQ-012].
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 1 + 1;\n');
  await writeScript('jest src/one');
  const preview = json('phase', 'rollover', 'implement');
  sflow('phase', 'rollover', 'implement', '--confirm', preview.confirmation);
  const changed = refusal('phase', 'publish', 'implement');
  assert.equal(changed.error.code, 'TEST_COMMAND_PIN_CHANGED', JSON.stringify(changed.error));
  assert.match(changed.error.message, /Test command '\.-node-tests' changed since it was pinned for this Story \(TCP-001\)/u);
  const words = changed.error.details.testCommandPin.changes;
  assert.ok(words.includes('package.json scripts.test changed'), JSON.stringify(words));
  assert.ok(words.includes('adapter node-tap → jest-json'), JSON.stringify(words));
  // What a person decides: the script before and after, and the test it no longer runs.
  assert.match(changed.error.message, /package\.json scripts\.test: before "node --test", after "jest src\/one"/u);
  assert.deepEqual(changed.error.details.testCommandPin.pathNarrowing?.[0]?.dropped, ['test/value.test.mjs'], JSON.stringify(changed.error.details.testCommandPin));
  const repinCommand = 'singularity-flow decision test-command QF-1 --phase implement --repin .-node-tests --reason "<why the test command changed>"';
  assert.equal(changed.error.details.testCommandPin.command, repinCommand);
  assert.ok(planCommands(changed).includes(repinCommand), JSON.stringify(planCommands(changed)));
  assert.equal(await readFile(path.join(root, '.sflow/results/node-tests.json'), 'utf8').catch(() => null), null, 'the narrowed command never ran');

  // Anyone working on the Story may request the new pin; until a person accepts it, nothing changes.
  const requested = json('decision', 'test-command', '--phase', 'implement', '--repin', '.-node-tests',
    '--reason', 'The module moved to Jest, which runs its own suite.');
  assert.equal(requested.data.record.id, 'TCD-001');
  assert.equal(requested.data.record.repin.pinned, first.sha256);
  assert.ok(requested.data.record.repin.changes.includes('package.json scripts.test changed'));
  assert.equal(refusal('phase', 'publish', 'implement').error.code, 'TEST_COMMAND_PIN_CHANGED');
  const listed = asReviewer('decisions', 'QF-1', '--phase', 'implement').data.items.find((item) => item.kind === 'test-command');
  assert.match(listed.title, /^Re-pin \.-node-tests/u);
  assert.match(listed.why, /before "node --test", after "jest src\/one"/u);
  assert.match(listed.why, /leaves out 1 of the 1 test files it ran at the base commit: test\/value\.test\.mjs/u);

  // A person who approves the step accepts it: the next publication records the new pin.
  asReviewer('decision', 'test-command', 'QF-1', '--accept', 'TCD-001');
  sflow('phase', 'publish', 'implement');
  const pins = (await stored()).testCommandPins;
  assert.equal(pins.length, 2);
  assert.equal(pins[1].replaces, 'TCP-001');
  assert.equal(pins[1].acceptedBy, 'TCD-001');
  assert.equal(pins[1].adapter, 'jest-json');
  assert.equal(pins[1].sha256, requested.data.record.repin.sha256);
  assert.equal((await stored()).phases.implement.storyTestCommands, undefined, 'a re-pin adds no command of its own');

  sflow('submit', 'implement');
  assert.equal((await stored()).phases.implement.status, 'approved');
  // The Story closes: its final gate replays each attempt with the pin it ran under [TCE:REQ-014].
  sflow('prepare', 'verify');
  sflow('phase', 'publish', 'verify', '--authored', 'deterministic');
  sflow('submit', 'verify');
  if ((await stored()).phases.verify.status !== 'approved') sflow('approve', 'verify', '--yes');
  const closed = await stored();
  assert.equal(closed.status, 'closed', JSON.stringify(Object.fromEntries(closed.phaseOrder.map((id) => [id, closed.phases[id].status]))));
});
