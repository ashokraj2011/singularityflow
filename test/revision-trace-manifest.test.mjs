import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  collectRevisionTestBodies, expandRevisionCriterionIds, REV_ALL_CRITERIA,
  REV_OPTIONAL_CRITERIA, REV_PILOT_CORE_CRITERIA, validateRevisionTraceManifest
} from '../src/revision/trace-manifest.mjs';
import {
  inspectRevisionPilotActivation, readRevisionPilotOptIn, resolveRevisionRuntimeCapabilities,
  revisionRuntimeCapabilities,
  REV_PILOT_OPT_IN_PATH
} from '../src/revision/runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const disabledRuntime = { activationProfile: 'disabled', codeRevisionExecutionAvailable: false };
const pilotRuntime = {
  activationProfile: 'REV_POC_SINGLE_REPO', codeRevisionExecutionAvailable: true,
  publicRoutePreviewAvailable: true, publicPacketPlanningAvailable: true,
  manualCaptureAvailable: true, candidateHeadCasAvailable: true,
  codeResultAvailable: true, publicationBridgeAvailable: true,
  releaseWitnessExecutionAvailable: true
};
const witnessContext = {
  sourceCommit: 'a'.repeat(40), platformProfile: 'linux-x64-node20'
};
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const loadManifest = async () => JSON.parse(await readFile(path.join(root, 'revision-trace-manifest.json'), 'utf8'));

test('REV:TRACE disabled manifest is complete, explicit, and agrees with the installed runtime', async () => {
  const manifest = await loadManifest();
  const report = await validateRevisionTraceManifest(manifest, { repositoryRoot: root });
  assert.equal(report.activationProfile, 'disabled');
  assert.equal(report.enabledCriterionCount, 0);
  assert.equal(report.deferredCriterionCount, 208);
  assert.equal(REV_ALL_CRITERIA.length, 208);
  assert.equal(REV_PILOT_CORE_CRITERIA.length, 134);
  assert.equal(REV_PILOT_CORE_CRITERIA.filter((id) => id.startsWith('REV:AC-')).length, 126);
  assert.deepEqual(expandRevisionCriterionIds('REV:UPLOAD-AC-001..010'),
    REV_ALL_CRITERIA.slice(-10));
  assert.throws(() => expandRevisionCriterionIds('REV:AC-190..191'), /outside the REV catalog/);
});

test('REV:TRACE rejects false profile, advertised deferred capability, and duplicate deferment', async () => {
  const manifest = await loadManifest();
  await assert.rejects(validateRevisionTraceManifest({ ...manifest, activationProfile: 'REV_POC_SINGLE_REPO' }, {
    repositoryRoot: root, runtimeCapabilities: disabledRuntime
  }), /disagrees with installed runtime/);
  await assert.rejects(validateRevisionTraceManifest({
    ...manifest, advertisedCapabilities: ['copilot-upload']
  }, { repositoryRoot: root, runtimeCapabilities: disabledRuntime }), /disabled REV cannot advertise/);
  await assert.rejects(validateRevisionTraceManifest({
    ...manifest, deferredCriteria: [...manifest.deferredCriteria, manifest.deferredCriteria[0]]
  }, { repositoryRoot: root, runtimeCapabilities: disabledRuntime }), /duplicate deferment/);
});

async function pilotFixture(t) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-rev-trace-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', repositoryRoot], { stdio: 'ignore' });
  await mkdir(path.join(repositoryRoot, 'test'));
  const testFile = 'test/revision-witness.test.mjs';
  const source = REV_PILOT_CORE_CRITERIA.map((id) =>
    `test('${id} exact witness', () => { return '${id}'; });`).join('\n');
  await writeFile(path.join(repositoryRoot, testFile), source);
  const bodies = await collectRevisionTestBodies(source, testFile);
  const byId = new Map(bodies.map((body) => [body.namePath[0].split(' ')[0], body]));
  const enabledCriteria = Object.fromEntries(REV_PILOT_CORE_CRITERIA.map((id) => [id, {
    test: testFile,
    namePath: byId.get(id).namePath,
    bodySha256: byId.get(id).bodySha256,
    sourceSha256: digest(source)
  }]));
  const core = new Set(REV_PILOT_CORE_CRITERIA);
  const owner = new Map(Object.entries(REV_OPTIONAL_CRITERIA)
    .flatMap(([capability, criteria]) => criteria.map((id) => [id, capability])));
  const deferredCriteria = REV_ALL_CRITERIA.filter((id) => !core.has(id)).map((id) => ({
    ids: id, unavailableCapability: owner.get(id), reason: 'Not advertised by the pilot.'
  }));
  const manifest = {
    schemaVersion: 1, kind: 'revision-trace-manifest', specificationVersion: '0.6.0',
    activationProfile: 'REV_POC_SINGLE_REPO',
    decisionOwner: null, validatedBy: null,
    advertisedCapabilities: ['revision-loop', 'revision-code-results'],
    enabledCriteria, deferredCriteria
  };
  return { repositoryRoot, manifest, testFile };
}

test('REV:TRACE pilot validates every exact current body and refuses missing or stale witnesses', async (t) => {
  const { repositoryRoot, manifest, testFile } = await pilotFixture(t);
  const report = await validateRevisionTraceManifest(manifest, {
    repositoryRoot, runtimeCapabilities: pilotRuntime, witnessContext
  });
  assert.equal(report.enabledCriterionCount, 134);
  assert.equal(report.deferredCriterionCount, 74);

  const missing = structuredClone(manifest);
  delete missing.enabledCriteria['REV:AC-001'];
  await assert.rejects(validateRevisionTraceManifest(missing, {
    repositoryRoot, runtimeCapabilities: pilotRuntime, witnessContext
  }), /lacks REV:AC-001 witness/);

  const stale = structuredClone(manifest);
  stale.enabledCriteria['REV:AC-001'].bodySha256 = digest('changed');
  await assert.rejects(validateRevisionTraceManifest(stale, {
    repositoryRoot, runtimeCapabilities: pilotRuntime, witnessContext
  }), /witness body changed/);

  const source = await readFile(path.join(repositoryRoot, testFile), 'utf8');
  await writeFile(path.join(repositoryRoot, testFile), `${source}\n// changed after attestation\n`);
  await assert.rejects(validateRevisionTraceManifest(manifest, {
    repositoryRoot, runtimeCapabilities: pilotRuntime, witnessContext
  }), /witness source changed/);
});

test('REV:TRACE parser ignores names in comments and rejects a skipped witness', async (t) => {
  const { repositoryRoot, manifest, testFile } = await pilotFixture(t);
  const source = await readFile(path.join(repositoryRoot, testFile), 'utf8');
  const changed = `// test('REV:AC-001 decoy', () => {})\n${source.replace(
    "test('REV:AC-001 exact witness', () => { return 'REV:AC-001'; });",
    "test('REV:AC-001 exact witness', { skip: true }, () => { return 'REV:AC-001'; });"
  )}`;
  await writeFile(path.join(repositoryRoot, testFile), changed);
  const altered = structuredClone(manifest);
  const updatedBodies = await collectRevisionTestBodies(changed, testFile);
  assert.equal(updatedBodies.filter((body) => body.namePath[0] === 'REV:AC-001 decoy').length, 0);
  for (const row of Object.values(altered.enabledCriteria)) row.sourceSha256 = digest(changed);
  await assert.rejects(validateRevisionTraceManifest(altered, {
    repositoryRoot, runtimeCapabilities: pilotRuntime, witnessContext
  }), /witness is skipped, todo, or focused/);
});

test('REV:TRACE pilot witness context is exact and cannot be omitted', async (t) => {
  const { repositoryRoot, manifest } = await pilotFixture(t);
  await assert.rejects(validateRevisionTraceManifest(manifest, {
    repositoryRoot, runtimeCapabilities: pilotRuntime
  }), /exact source commit and supported platform profile/);
  await assert.rejects(validateRevisionTraceManifest(manifest, {
    repositoryRoot, runtimeCapabilities: pilotRuntime,
    witnessContext: { ...witnessContext, sourceCommit: 'not-a-commit' }
  }), /exact source commit and supported platform profile/);
  const report = await validateRevisionTraceManifest(manifest, {
    repositoryRoot, runtimeCapabilities: pilotRuntime, witnessContext
  });
  assert.equal(report.sourceCommit, witnessContext.sourceCommit);
  assert.equal(report.platformProfile, witnessContext.platformProfile);
});

test('REV:TRACE rejects focused tests and inherited skipped suites', async () => {
  const source = `describe.skip('suite', () => { test('REV:AC-001 inherited', () => { throw Error('run'); }); });\n`
    + `test.only('REV:AC-002 focused', () => { throw Error('run'); });\n`
    + `test.describe.skip('playwright suite', () => { test('REV:AC-003 inherited', () => {}); });\n`
    + `test('REV:AC-004 option', { 'skip': true }, () => {});`;
  const bodies = await collectRevisionTestBodies(source);
  assert.equal(bodies.length, 4);
  assert.ok(bodies.every((body) => body.disabled));
  assert.deepEqual(bodies[0].namePath, ['suite', 'REV:AC-001 inherited']);
  assert.deepEqual(bodies[2].namePath, ['playwright suite', 'REV:AC-003 inherited']);
});

test('REV pilot activation requires a real repository-local opt-in and refuses forged readiness inputs', async (t) => {
  const { repositoryRoot, manifest } = await pilotFixture(t);
  const releaseRoot = repositoryRoot;
  await writeFile(path.join(releaseRoot, 'revision-trace-manifest.json'), JSON.stringify(manifest));
  assert.equal(await readRevisionPilotOptIn(repositoryRoot), null);
  assert.equal(await resolveRevisionRuntimeCapabilities({ repositoryRoot, releaseRoot }),
    revisionRuntimeCapabilities);
  const dormant = await inspectRevisionPilotActivation({ repositoryRoot, releaseRoot });
  assert.equal(dormant.eligible, false);
  assert.equal(dormant.missingPilotCoreCriterionCount, 134);
  assert.equal(dormant.blockers[0].code, 'REV_PILOT_ATTESTATION_UNAVAILABLE');
  assert.equal(dormant.blockers.at(-1).code, 'REV_PILOT_OPT_IN_REQUIRED');
  await mkdir(path.join(repositoryRoot, '.sflow'));
  assert.equal(REV_PILOT_OPT_IN_PATH, '.sflow/revision-pilot.json');
  const filename = path.join(repositoryRoot, REV_PILOT_OPT_IN_PATH);
  await assert.rejects(readRevisionPilotOptIn(path.join(repositoryRoot, 'test')), {
    code: 'REV_PILOT_OPT_IN_INVALID'
  });
  await writeFile(filename, JSON.stringify({
    kind: 'revision-pilot-opt-in', activationProfile: 'REV_POC_SINGLE_REPO'
  }));
  await assert.rejects(resolveRevisionRuntimeCapabilities({ repositoryRoot, releaseRoot }), {
    code: 'REV_PILOT_ATTESTATION_UNAVAILABLE'
  });
  const forged = { repositoryRoot, releaseRoot, installedCapabilities: pilotRuntime, witnessContext };
  await assert.rejects(resolveRevisionRuntimeCapabilities(forged), {
    code: 'REV_PILOT_ATTESTATION_UNAVAILABLE'
  });
  const blocked = await inspectRevisionPilotActivation(forged);
  assert.equal(blocked.requested, true);
  assert.equal(blocked.eligible, false);
  assert.equal(blocked.missingPilotCoreCriterionCount, 134);
  assert.equal(blocked.blockers[0].code, 'REV_PILOT_ATTESTATION_UNAVAILABLE');
  assert.ok(blocked.blockers.some((row) => row.bridge === 'releaseWitnessExecutionAvailable'));
  await writeFile(path.join(releaseRoot, 'revision-trace-manifest.json'), JSON.stringify({
    ...manifest, activationProfile: 'disabled', enabledCriteria: {}
  }));
  const incomplete = await inspectRevisionPilotActivation({ repositoryRoot, releaseRoot });
  assert.equal(incomplete.missingPilotCoreCriterionCount, 134);
  assert.equal(incomplete.missingPilotCoreCriterionSample.length, 10);
  assert.ok(incomplete.blockers.some((row) => row.code === 'REV_TRACE_PROFILE_MISMATCH'));
  await writeFile(filename, JSON.stringify({
    kind: 'revision-pilot-opt-in', activationProfile: 'REV_FULL_DEFAULT'
  }));
  await assert.rejects(readRevisionPilotOptIn(repositoryRoot), { code: 'REV_PILOT_OPT_IN_INVALID' });
  await writeFile(filename, 'x'.repeat(4097));
  await assert.rejects(readRevisionPilotOptIn(repositoryRoot), { code: 'REV_PILOT_OPT_IN_INVALID' });
  await unlink(filename);
  const target = path.join(repositoryRoot, 'revision-pilot-target.json');
  await writeFile(target, JSON.stringify({
    kind: 'revision-pilot-opt-in', activationProfile: 'REV_POC_SINGLE_REPO'
  }));
  await symlink(target, filename);
  await assert.rejects(readRevisionPilotOptIn(repositoryRoot), { code: 'REV_PILOT_OPT_IN_INVALID' });
});

test('REV:TRACE is a mandatory release preflight even when local tests are skipped', async () => {
  const [release, gate, traceCheck, packageJson] = await Promise.all([
    readFile(path.join(root, 'scripts', 'release.mjs'), 'utf8'),
    readFile(path.join(root, 'scripts', 'poc-release-gate.mjs'), 'utf8'),
    readFile(path.join(root, 'scripts', 'revision-trace-check.mjs'), 'utf8'),
    readFile(path.join(root, 'package.json'), 'utf8')
  ]);
  assert.match(release, /must\(process\.execPath, \['scripts\/revision-trace-check\.mjs'\]\)/);
  assert.match(gate, /args: \['scripts\/revision-trace-check\.mjs'\]/);
  assert.match(gate, /test\/revision-trace-manifest\.test\.mjs/);
  assert.match(traceCheck, /runPocReleaseStage/);
  assert.doesNotMatch(traceCheck, /spawnSync/);
  const packagedFiles = JSON.parse(packageJson).files;
  assert.ok(packagedFiles.includes('revision-trace-manifest.json'));
  assert.ok(packagedFiles.includes('scripts/revision-trace-check.mjs'));
});
