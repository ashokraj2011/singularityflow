import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDefinition, loadDefinition, resolveWorkType, validateDefinition } from '../src/config.mjs';
import { canonicalJson } from '../src/records.mjs';

// One suite, two levels and two targets [RTC:REQ-001, RTC:REQ-011].
const command = (id, level, extra = {}) => ({
  id, kind: 'test', ...(level ? { level } : {}), argv: ['npx', 'playwright', 'test'], workingDirectory: 'apps/shop', affectedRoots: ['apps/shop'],
  modelPolicy: 'never', result: { adapter: 'playwright-json', path: `.sflow/results/${id}.json`, minimumDiscovered: 1 }, ...extra
});
const unit = { ...command('shop-unit', 'unit'), argv: ['npx', 'vitest', 'run'], result: { adapter: 'vitest-json', path: '.sflow/results/shop-unit.json', minimumDiscovered: 1 } };
const local = command('e2e-local', 'e2e', { env: { PLAYWRIGHT_BASE_URL: 'http://localhost:3000' } });
const relay = command('e2e-relay', 'e2e', { environment: 'relay' });

async function shipped(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rtc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git'), { recursive: true });
  await initializeDefinition(root);
  return loadDefinition(root);
}
const phase = (resolved, id) => resolved.phases.find((entry) => entry.id === id);
const ids = (step) => (step.qualityCommands ?? []).map((entry) => entry.id);

test('a configuration without tests: resolves byte for byte as before repository tests existed [RTC:REQ-002]', async (t) => {
  const definition = await shipped(t);
  const digest = (id) => createHash('sha256').update(canonicalJson(resolveWorkType(definition, id))).digest('hex');
  // Computed on main 2e3e74c8c, before `tests:` existed. Only a deliberate change to these shipped
  // workflows or to resolution itself moves them; repository tests must not.
  assert.equal(digest('feature'), 'e294f39567509a24a669e9d9ce2b21ca547bdb84cc219a640056cb2982d32582');
  assert.equal(digest('bugfix'), '43db7e0151bd9d861a9c198340b0dbf566dda8fe623a5458441a77891c9cf162');
});

test('steps that run tests get the repository tests they choose; a step with its own test command keeps it [RTC:REQ-002, RTC:REQ-011]', async (t) => {
  const definition = await shipped(t);
  const all = validateDefinition({ ...structuredClone(definition), tests: [unit, local, relay] });
  const feature = resolveWorkType(all, 'feature');
  // The code step and the step with repositoryTests: run get every one; a step that runs no tests gets none.
  assert.deepEqual(ids(phase(feature, 'implementation')), ['shop-unit', 'e2e-local', 'e2e-relay']);
  assert.deepEqual(ids(phase(feature, 'verification')), ['shop-unit', 'e2e-local', 'e2e-relay']);
  assert.deepEqual(ids(phase(feature, 'design')), []);
  // Each keeps its target: a literal URL, or a bound environment named only by ID.
  assert.deepEqual(phase(feature, 'implementation').qualityCommands[1].env, { PLAYWRIGHT_BASE_URL: 'http://localhost:3000' });
  assert.equal(phase(feature, 'implementation').qualityCommands[2].environment, 'relay');

  const chosen = structuredClone(all);
  chosen.phases.implementation.testLevels = ['unit'];
  chosen.workTypes.feature.phaseOverrides.verification = { ...chosen.workTypes.feature.phaseOverrides.verification, testIds: ['e2e-local'] };
  const narrowed = resolveWorkType(validateDefinition(chosen), 'feature');
  // testLevels: [unit] is the code step's own choice; it also runs, before its approval, the one verification
  // chose, so verification finds nothing new there [PHR:REQ-007], item 8.
  assert.deepEqual(ids(phase(narrowed, 'implementation')), ['shop-unit', 'e2e-local'], 'testLevels: [unit], and what the later step runs');
  assert.deepEqual(phase(narrowed, 'implementation').laterStepTests, { runs: [{ id: 'e2e-local', steps: ['verification'] }], cannotRunHere: [] });
  assert.deepEqual(ids(phase(narrowed, 'verification')), ['e2e-local'], 'testIds in the workflow override runs only the local one');
  assert.equal(Object.hasOwn(phase(narrowed, 'implementation'), 'testLevels'), false, 'the choice is configuration, not Story contract');
  const both = structuredClone(all);
  both.phases.implementation.testLevels = ['unit'];
  both.phases.implementation.testIds = ['e2e-relay'];
  const bothResolved = phase(resolveWorkType(validateDefinition(both), 'feature'), 'implementation');
  assert.deepEqual(ids(bothResolved).slice(0, 2), ['shop-unit', 'e2e-relay'], 'with both, a command runs when its level or its ID is listed');

  const own = structuredClone(all);
  own.phases.implementation.qualityCommands = [{ ...unit, id: 'step-own' }];
  // A step's own test command replaces the repository's for that step only; the ones the next step runs still run there
  // first, but not one that is its own command under another name [PHR:REQ-007], item 8.
  assert.deepEqual(ids(phase(resolveWorkType(validateDefinition(own), 'feature'), 'implementation')), ['step-own', 'e2e-local'],
    "a step's own test command replaces the repository's for that step only");
  assert.deepEqual(ids(phase(resolveWorkType(validateDefinition(own), 'feature'), 'verification')), ['shop-unit', 'e2e-local', 'e2e-relay']);
  const lint = structuredClone(all);
  lint.phases.implementation.qualityCommands = [{ id: 'lint', kind: 'lint', argv: ['npx', 'eslint', '.'], modelPolicy: 'never' }];
  assert.deepEqual(ids(phase(resolveWorkType(validateDefinition(lint), 'feature'), 'implementation')), ['lint', 'shop-unit', 'e2e-local', 'e2e-relay'],
    'other kinds of check are unchanged and the repository tests follow them');
});

test('a choice naming a test or level the repository does not have, and a malformed list, are refused [RTC:REQ-001, RTC:REQ-002]', async (t) => {
  const definition = await shipped(t);
  const refused = (change, pattern) => {
    const candidate = { ...structuredClone(definition), tests: [unit, local] };
    change(candidate);
    assert.throws(() => validateDefinition(candidate), pattern);
  };
  refused((d) => { d.phases.implementation.testIds = ['nope']; }, /Phase 'implementation' testIds names 'nope', which tests does not hold/u);
  refused((d) => { d.phases.implementation.testLevels = ['integration']; }, /testLevels names 'integration', but no repository test in tests has that level/u);
  refused((d) => { d.phases.implementation.testLevels = ['smoke']; }, /a level is unit, component, integration, e2e, other/u);
  refused((d) => { d.workTypes.feature.phaseOverrides.implementation = { ...d.workTypes.feature.phaseOverrides.implementation, testIds: ['nope'] }; },
    /Work type 'feature' phase 'implementation' override testIds names 'nope'/u);
  refused((d) => { d.tests.push({ ...unit }); }, /tests has two commands called 'shop-unit'/u);
  refused((d) => { d.tests.push({ ...unit, id: 'lint', kind: 'lint' }); }, /tests\[2\] must declare kind: test/u);
  refused((d) => { d.tests.push({ ...unit, id: 'x', level: 'smoke' }); }, /tests\[2\]\.level must be unit, component, integration, e2e, other/u);
  refused((d) => { d.tests = { unit }; }, /tests must be a list of test commands/u);
  // Without tests:, a level is one no repository test has.
  assert.throws(() => validateDefinition({ ...structuredClone(definition), phases: { ...structuredClone(definition.phases),
    implementation: { ...structuredClone(definition.phases.implementation), testLevels: ['unit'] } } }), /no repository test in tests has that level/u);
  // A command without a level is `other`, and a step may choose it so.
  const other = validateDefinition({ ...structuredClone(definition), tests: [{ ...unit, level: undefined }] });
  other.phases.implementation.testLevels = ['other'];
  assert.deepEqual(ids(phase(resolveWorkType(validateDefinition(other), 'feature'), 'implementation')), ['shop-unit']);
});

test('a literal env value holding a credential is refused with the line to declare it in environments.yml, in tests and in a step [RTC:REQ-011]', async (t) => {
  const definition = await shipped(t);
  const withCredential = { ...local, id: 'e2e-secret', env: { PLAYWRIGHT_BASE_URL: 'https://user:pw@relay.example.test' } };
  assert.throws(() => validateDefinition({ ...structuredClone(definition), tests: [withCredential] }),
    (error) => error.code === 'QUALITY_COMMAND_ENV_SECRET'
      && /tests\[0\]\.env\.PLAYWRIGHT_BASE_URL holds a credential \(a user name or password in the URL\)\. Declare PLAYWRIGHT_BASE_URL in singularity\/environments\.yml/u.test(error.message));
  const step = structuredClone(definition);
  step.phases.implementation.qualityCommands = [{ ...local, env: { PW_TEST_CONNECT_WS_ENDPOINT: 'wss://relay.example.test/ws?token=abc' } }];
  assert.throws(() => validateDefinition(step), /holds a credential \(the query parameter 'token'\)/u);
  // A plain URL is a literal anyone may share.
  validateDefinition({ ...structuredClone(definition), tests: [{ ...local, env: { PLAYWRIGHT_BASE_URL: 'https://relay.example.test/app?page=1' } }] });
});

test('the offer to adopt for a Story in progress includes the repository tests its step chose, and adopts nothing itself [RTC:REQ-003]', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rtc-adopt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { spawnSync } = await import('node:child_process');
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', root]).status, 0);
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  const YAML = (await import('yaml')).default;
  const write = (definition) => writeFile(path.join(root, 'singularity/workflow.yml'), YAML.stringify(definition));
  await write({ tests: [unit, local], phases: { implementation: { testLevels: ['e2e'] } }, workTypes: { feature: { phases: ['implementation'] } } });
  const { activatedTestCommandsFor } = await import('../src/activated-test-commands.mjs');
  const pinnedBefore = { workItem: { workType: 'feature' }, resolution: { phases: [{ id: 'implementation', qualityCommands: [] }] } };
  assert.deepEqual((await activatedTestCommandsFor(root, pinnedBefore, 'implementation')).map((entry) => entry.id), ['e2e-local']);
  const pinnedAfter = { ...pinnedBefore, resolution: { phases: [{ id: 'implementation', qualityCommands: [local] }] } };
  assert.deepEqual(await activatedTestCommandsFor(root, pinnedAfter, 'implementation'), [], 'what the Story already pins is not offered again');
  await write({ tests: [unit, local], phases: { implementation: { qualityCommands: [{ ...unit, id: 'step-own' }] } }, workTypes: { feature: { phases: ['implementation'] } } });
  assert.deepEqual((await activatedTestCommandsFor(root, pinnedBefore, 'implementation')).map((entry) => entry.id), ['step-own'],
    "a step's own test command is offered instead of the repository's");
});

test('[PHR:REQ-007] item 8: a code step also runs, before its approval, the repository tests the steps after it choose; one that needs an environment only that step has is named, not run', async (t) => {
  const definition = await shipped(t);
  const chosen = structuredClone({ ...definition, tests: [unit, local, relay] });
  chosen.phases.implementation.testLevels = ['unit'];
  const feature = resolveWorkType(validateDefinition(chosen), 'feature');
  const code = phase(feature, 'implementation');
  // Its own choice first, then what verification runs that it does not, with the same command, runner and result adapter.
  assert.deepEqual(ids(code), ['shop-unit', 'e2e-local']);
  assert.deepEqual(code.qualityCommands[1], local);
  assert.deepEqual(code.laterStepTests, { runs: [{ id: 'e2e-local', steps: ['verification'] }],
    cannotRunHere: [{ id: 'e2e-relay', steps: ['verification'], needs: 'environment relay' }] });
  assert.deepEqual(ids(phase(feature, 'verification')), ['shop-unit', 'e2e-local', 'e2e-relay'], 'the later step keeps all it chose');
  // Nothing moves where the code step already runs everything the later steps choose.
  assert.equal(Object.hasOwn(phase(resolveWorkType(validateDefinition({ ...structuredClone(definition), tests: [unit, local] }), 'feature'), 'implementation'), 'laterStepTests'), false);
  // Story start and the code step's runs say so.
  const { laterStepTestLines, laterStepTestNotes } = await import('../src/later-step-tests.mjs');
  const workflow = { phaseOrder: feature.phases.map((entry) => entry.id), resolution: { phases: feature.phases } };
  assert.deepEqual(laterStepTestLines(workflow, 'implementation'), [
    'Run here so verification finds nothing new: e2e-local (a repository test verification runs).',
    'Cannot run here: e2e-relay needs environment relay; verification runs it.']);
  assert.deepEqual(laterStepTestNotes(workflow).map((entry) => [entry.phase, entry.message]), [['implementation',
    'implementation also runs e2e-local before its approval, the tests verification runs, so those find nothing new. e2e-relay needs environment relay, so verification runs it, not implementation.']]);
});
