import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDefinition, loadDefinition, mergePhaseOverride, resolveWorkType, validateDefinition } from '../src/config.mjs';
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

// This once pinned whole-resolution digests of two workflows, so any deliberate change to resolution moved them
// (review level 2 did, a72215495) and said nothing about repository tests. It checks the property itself, byte
// for byte, in every shipped workflow.
test('a configuration without tests: gets nothing from repository tests, and adding them changes nothing but their commands [RTC:REQ-002]', async (t) => {
  const definition = await shipped(t);
  assert.equal(Object.hasOwn(definition, 'tests'), false, 'the shipped configuration has no tests:');
  // Repository tests reach a resolution in two places only: commands in a step's list, and the later steps'
  // tests a code step also runs (laterStepTests). A step's choice of them (testLevels, testIds) never stays.
  const repository = new Set([unit, local, relay].map((entry) => entry.id));
  const withTests = validateDefinition({ ...structuredClone(definition), tests: [unit, local, relay] });
  const emptyTests = validateDefinition({ ...structuredClone(definition), tests: [] });
  const withoutRepositoryTests = (resolved) => ({
    ...resolved,
    phases: resolved.phases.map(({ laterStepTests, qualityCommands, ...step }) => {
      const kept = (qualityCommands ?? []).filter((entry) => !repository.has(entry.id));
      return kept.length ? { ...step, qualityCommands: kept } : step;
    })
  });
  const gained = [];
  for (const [workTypeId, workType] of Object.entries(definition.workTypes)) {
    const plain = resolveWorkType(definition, workTypeId);
    for (const step of plain.phases) {
      // Each step runs exactly the commands its own configuration declares, and carries no repository-test field.
      const declared = mergePhaseOverride(structuredClone(definition.phases[step.id]), structuredClone(workType.phaseOverrides?.[step.id] ?? {}));
      assert.deepEqual(step.qualityCommands, declared.qualityCommands, `${workTypeId} ${step.id}: only the commands it declares`);
      for (const field of ['laterStepTests', 'testLevels', 'testIds']) {
        assert.equal(Object.hasOwn(step, field), false, `${workTypeId} ${step.id}: no ${field}`);
      }
    }
    assert.equal(canonicalJson(resolveWorkType(emptyTests, workTypeId)), canonicalJson(plain), `${workTypeId}: an empty tests: is no tests:`);
    // Taking the repository tests out again leaves the resolution without them, byte for byte: they move nothing else,
    // so existing Stories and digests do not move for a configuration that has none.
    const added = resolveWorkType(withTests, workTypeId);
    assert.equal(canonicalJson(withoutRepositoryTests(added)), canonicalJson(withoutRepositoryTests(plain)), `${workTypeId}: tests: adds only its commands`);
    if (added.phases.some((step) => (step.qualityCommands ?? []).some((entry) => repository.has(entry.id)))) gained.push(workTypeId);
  }
  assert.ok(gained.includes('feature') && gained.includes('bugfix'), `the comparison is not empty: ${gained.join(', ')}`);
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

test('[PHR:REQ-007] item 8: a test whose env or argv names a deployed host is not run at the code step; the later step that chose it runs it', async (t) => {
  const { literalDeployedHosts } = await import('../src/external-command-policy.mjs');
  // This machine is never a deployed environment; a placeholder is no literal host; only host[:port] is kept.
  for (const url of ['http://localhost:3000', 'http://127.0.0.1:5173', 'http://[::1]:5173/app', 'http://shop.localhost', 'https://shop.test/x',
    'http://$HOST:3000', 'https://${BASE_HOST}/app', 'ftp://files.example.com']) {
    assert.deepEqual(literalDeployedHosts({ env: { BASE_URL: url } }), [], url);
  }
  assert.deepEqual(literalDeployedHosts({ argv: ['npx', 'playwright', 'test', '--base-url=https://bot:pw@QA.Example.com:8443/app?token=abc#top'] }),
    ['qa.example.com:8443']);
  assert.deepEqual(literalDeployedHosts({ command: 'BASE_URL=https://staging.example.com npx playwright test' }), ['staging.example.com']);
  assert.deepEqual(literalDeployedHosts({ env: { RELAY: 'wss://relay.example.com/socket' } }), ['relay.example.com']);

  const definition = await shipped(t);
  const staging = command('e2e-staging', 'e2e', { env: { PLAYWRIGHT_BASE_URL: 'https://staging.example.com' } });
  const qa = command('e2e-qa', 'e2e', { argv: ['npx', 'playwright', 'test', '--base-url=https://qa.example.com:8443/app?token=abc'] });
  const tests = [unit, local, relay, staging, qa];
  const narrowed = structuredClone({ ...definition, tests });
  narrowed.phases.implementation.testLevels = ['unit'];
  const code = phase(resolveWorkType(validateDefinition(narrowed), 'feature'), 'implementation');
  // The local one runs here; the relay one needs its environment, and the deployed ones a build with this code.
  assert.deepEqual(ids(code), ['shop-unit', 'e2e-local']);
  assert.deepEqual(code.laterStepTests, { runs: [{ id: 'e2e-local', steps: ['verification'] }], cannotRunHere: [
    { id: 'e2e-relay', steps: ['verification'], needs: 'environment relay' },
    { id: 'e2e-staging', steps: ['verification'], needs: 'staging.example.com (a deployed environment)' },
    { id: 'e2e-qa', steps: ['verification'], needs: 'qa.example.com:8443 (a deployed environment)' }] });

  // A code step that chose them itself leaves them to the later step that chose them too, never run here and never
  // looped back; its own environment-bound one stays its own, as before.
  const everything = resolveWorkType(validateDefinition({ ...structuredClone(definition), tests }), 'feature');
  const all = phase(everything, 'implementation');
  assert.deepEqual(ids(all), ['shop-unit', 'e2e-local', 'e2e-relay']);
  assert.deepEqual(all.laterStepTests, { runs: [], cannotRunHere: [
    { id: 'e2e-staging', steps: ['verification'], needs: 'staging.example.com (a deployed environment)' },
    { id: 'e2e-qa', steps: ['verification'], needs: 'qa.example.com:8443 (a deployed environment)' }] });
  assert.deepEqual(ids(phase(everything, 'verification')), ['shop-unit', 'e2e-local', 'e2e-relay', 'e2e-staging', 'e2e-qa'],
    'the later step keeps all it chose');
  // One only the code step runs stays its own: nothing else would run it.
  const alone = structuredClone({ ...definition, tests });
  alone.phases.implementation.testIds = ['shop-unit', 'e2e-staging'];
  alone.workTypes.feature.phaseOverrides.verification = { ...alone.workTypes.feature.phaseOverrides.verification, testIds: ['e2e-local'] };
  const kept = phase(resolveWorkType(validateDefinition(alone), 'feature'), 'implementation');
  assert.deepEqual(ids(kept), ['shop-unit', 'e2e-staging', 'e2e-local']);
  assert.deepEqual(kept.laterStepTests.cannotRunHere, []);
  // Same argv with another env is another run: a deployed twin of a local test the code step runs is still named.
  const twin = structuredClone({ ...definition, tests: [unit, local, staging] });
  twin.phases.implementation.testIds = ['shop-unit', 'e2e-local'];
  assert.deepEqual(phase(resolveWorkType(validateDefinition(twin), 'feature'), 'implementation').laterStepTests,
    { runs: [], cannotRunHere: [{ id: 'e2e-staging', steps: ['verification'], needs: 'staging.example.com (a deployed environment)' }] });

  // The words: the host only, and an ID that is its argv never shows a user name, password or query.
  const { laterStepTestLines, laterStepTestNotes } = await import('../src/later-step-tests.mjs');
  const workflow = { phaseOrder: ['implementation', 'verification'], resolution: { phases: [{ id: 'implementation', laterStepTests: { runs: [],
    cannotRunHere: [{ id: 'npx playwright test --base-url=https://bot:pw@qa.example.com/app?token=abc', steps: ['verification'], needs: 'qa.example.com (a deployed environment)' }] } }] } };
  assert.deepEqual(laterStepTestLines(workflow, 'implementation'), [
    'Cannot run here: npx playwright test --base-url=https://qa.example.com/app needs qa.example.com (a deployed environment); verification runs it.']);
  assert.doesNotMatch(JSON.stringify(laterStepTestNotes(workflow)), /bot|pw@|token/u);
});
