import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeTemporaryTree } from '../src/util.mjs';
import { SKP_PILOT_PLAN, SKP_QUALIFICATION_LIMITS, SKP_QUALIFICATION_PROFILE, SKP_QUALIFICATION_TARGETS,
  captureQualificationSource, parseQualificationOptions, qualificationAssessment,
  readBoundedQualificationFile, detachUnclosedQualificationChild,
  runQualificationTarget, runSkpQualification, summarizeQualificationEvents } from '../scripts/skp-qualification.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNNER = fileURLToPath(new URL('../scripts/skp-qualification.mjs', import.meta.url));
const SHA = /^sha256:[a-f0-9]{64}$/u;
const COUNTS = { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
const diagnostics = (counts) => Object.entries(counts).map(([key, value]) => ({ type: 'test:diagnostic', data: { message: `${key} ${value}` } }));
const childEnvironment = () => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS; return env; };
const event = (type = 'test:pass', extra = {}) => ({ type, data: { name: 'private prompt TOKEN_SECRET_123',
  file: '/private/person/temporary/secret.test.mjs', line: 20, column: 3, ...extra } });
const cli = (...args) => spawnSync(process.execPath, [RUNNER, ...args], { cwd: ROOT,
  env: childEnvironment(), encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, shell: false, windowsHide: true });

test('qualification options admit only fixed plan/execute/release modes, never arbitrary paths, code or attestations', () => {
  assert.deepEqual(parseQualificationOptions([]), { execute: false, requireRelease: false });
  assert.deepEqual(parseQualificationOptions(['--execute']), { execute: true, requireRelease: false });
  assert.deepEqual(parseQualificationOptions(['--plan', '--require-release']), { execute: false, requireRelease: true });
  for (const value of [['--execute', '--plan'], ['--execute', '--execute'], ['--test-file=../../private.mjs'],
    ['--eval=process.exit(0)'], ['--evidence=trusted.json'], ['--sandbox-approved'], ['--platform=win32'], ['--timeout-ms=0'], null]) {
    assert.throws(() => parseQualificationOptions(value), { code: 'SKP_QUALIFICATION_OPTION_INVALID' });
  }
});

test('fixed target classes distinguish policy fixtures, independent Git clients, actual CLI and PTY from native installed acceptance', async () => {
  assert.equal(SKP_QUALIFICATION_TARGETS.length, 7);
  assert.ok(Object.isFrozen(SKP_QUALIFICATION_TARGETS));
  const policy = SKP_QUALIFICATION_TARGETS.find((target) => target.id === 'inert-contract-fixtures');
  assert.equal(policy.evidenceClass, 'unit-fixtures'); assert.ok(policy.files.includes('test/skp-host-admission.test.mjs'));
  assert.ok(policy.files.includes('test/wca-shared-phase-changes.test.mjs'));
  assert.ok(policy.files.includes('test/wca-simulation.test.mjs'));
  assert.ok(policy.files.includes('test/skp-platform-owners.test.mjs'));
  assert.match(policy.meaning, /structural shared-impact\/lifecycle projections/u);
  assert.match(policy.meaning, /synthetic host and Windows\/Linux owner policy/u);
  const retained = SKP_QUALIFICATION_TARGETS.find((target) => target.id === 'retained-local-owner-fixtures');
  assert.ok(retained.files.includes('test/vscode-workflow-drafts-portable-recovery.test.mjs'));
  assert.equal(retained.evidenceClass, 'actual-local-git-and-filesystem-fixtures');
  assert.match(retained.meaning, /on the observed OS/u);
  const clients = SKP_QUALIFICATION_TARGETS.find((target) => target.id === 'independent-local-git-clients');
  assert.equal(clients.evidenceClass, 'actual-two-client-local-git-fixtures'); assert.match(clients.meaning, /not two physical machines/);
  const pty = SKP_QUALIFICATION_TARGETS.find((target) => target.id === 'direct-terminal-local-review');
  assert.deepEqual(pty.platforms, ['darwin']); assert.match(pty.meaning, /No authenticated native host/);
  const inventory = SKP_QUALIFICATION_TARGETS.find((target) => target.id === 'explicit-local-story-history');
  assert.deepEqual(inventory.files, ['test/skp-story-usage.test.mjs', 'test/local-read-deadline.test.mjs', 'test/fos-preparation-cleanup.test.mjs']);
  assert.equal(inventory.evidenceClass, 'actual-local-git-and-filesystem-fixtures');
  const replacement = SKP_QUALIFICATION_TARGETS.find((target) => target.id === 'shared-replacement-terminal-review');
  assert.deepEqual(replacement.platforms, ['darwin']); assert.equal(replacement.requiresExpect, true);
  assert.match(replacement.pattern, /real terminal skill replacement/u);
  assert.match(replacement.meaning, /No authenticated mediated host/u);
  for (const target of SKP_QUALIFICATION_TARGETS) {
    assert.ok(Object.isFrozen(target)); assert.ok(Object.isFrozen(target.files));
    assert.ok(target.files.every((file) => /^test\/[a-z0-9-]+\.test\.mjs$/u.test(file)));
  }
  await assert.rejects(runQualificationTarget({ ...policy, files: ['/private/attacker.mjs'] }), { code: 'SKP_QUALIFICATION_TARGET_INVALID' });
});

test('content-free event report retains passing identity and counts without prompt, username, raw stdout or exception text', async () => {
  const result = await summarizeQualificationEvents([event(),
    { type: 'test:stdout', data: { message: 'TOKEN_SECRET_123 private approved agent prompt' } },
    { type: 'test:stderr', data: { message: '/private/person/temporary/access-token' } }, ...diagnostics(COUNTS)]);
  assert.deepEqual(result.counts, COUNTS); assert.equal(result.outcomes.length, 1);
  assert.match(result.outcomes[0].identitySha256, SHA); assert.equal(result.outcomes[0].state, 'pass');
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /TOKEN_SECRET|private prompt|approved agent|access-token|\/private\/person|secret\.test\.mjs/u);
});

test('authored skips, TODOs, cancelled and failed tests are recorded rather than treated as success', async () => {
  const counts = { tests: 4, pass: 0, fail: 1, cancelled: 1, skipped: 1, todo: 1 };
  const result = await summarizeQualificationEvents([event('test:pass', { skip: 'private secret skip reason' }),
    event('test:pass', { todo: 'future native host' }), event('test:fail', { details: { error: { message: 'secret error', failureType: 'cancelledByParent' } } }),
    event('test:fail', { details: { error: { message: 'secret error' } } }), ...diagnostics(counts)]);
  assert.deepEqual(result.counts, counts); assert.deepEqual(result.outcomes.map((row) => row.state), ['skipped', 'todo', 'fail', 'fail']);
  assert.doesNotMatch(JSON.stringify(result), /private secret|future native|secret error|cancelledByParent/u);
});

test('partial, empty, contradictory or overflowing test events fail closed instead of fabricating a passing suite', async () => {
  for (const values of [[], [event()], diagnostics({ ...COUNTS, tests: 0, pass: 0 }),
    [event('test:fail'), ...diagnostics(COUNTS)], [event('test:pass', { skip: true }), ...diagnostics(COUNTS)],
    [event(), ...diagnostics({ ...COUNTS, tests: 2 })]]) {
    await assert.rejects(summarizeQualificationEvents(values), { code: 'SKP_QUALIFICATION_RESULT_INCOMPLETE' });
  }
  await assert.rejects(summarizeQualificationEvents(Array.from({ length: SKP_QUALIFICATION_LIMITS.testEvents + 1 }, () => ({ type: 'test:stdout' }))),
    { code: 'SKP_QUALIFICATION_EVENT_LIMIT' });
  await assert.rejects(summarizeQualificationEvents(Array.from({ length: SKP_QUALIFICATION_LIMITS.outcomeRows + 1 }, () => event())),
    { code: 'SKP_QUALIFICATION_OUTCOME_LIMIT' });
});

test('Node 20 pattern exclusions are selection only, but an authored matching skip with the same reason remains missing evidence', async () => {
  const argv = ['--test-name-pattern=^selected case$'];
  const selected = event('test:pass', { name: 'selected case' });
  const excluded = event('test:pass', { name: 'unselected case', skip: 'test name does not match pattern' });
  const result = await summarizeQualificationEvents([selected, excluded, ...diagnostics({ ...COUNTS, tests: 2, skipped: 1 })], argv);
  assert.deepEqual(result.counts, COUNTS); assert.equal(result.outcomes.length, 1);
  const authored = await summarizeQualificationEvents([event('test:pass', { name: 'selected case', skip: 'test name does not match pattern' }),
    ...diagnostics({ ...COUNTS, pass: 0, skipped: 1 })], argv);
  assert.equal(authored.counts.skipped, 1); assert.equal(authored.outcomes[0].state, 'skipped');
});

test('all passing local fixture data still leaves other platforms, installed host, sandbox and human pilot unqualified', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const report = qualificationAssessment({ executed: true, platform,
      results: SKP_QUALIFICATION_TARGETS.map((target) => ({ id: target.id, status: 'passed' })) });
    assert.equal(report.status, 'not-qualified'); assert.equal(report.releaseQualified, false);
    assert.equal(report.nativeHostQualified, false); assert.equal(report.humanPilotQualified, false); assert.equal(report.localFixtures, 'passed');
    assert.equal(report.platforms.find((cell) => cell.platform === platform).status, 'observed-local-fixtures');
    assert.ok(report.platforms.filter((cell) => cell.platform !== platform).every((cell) => cell.status === 'missing'));
    assert.ok(report.platforms.every((cell) => cell.nativeHost === 'missing' && cell.installedArtifacts === 'missing' && cell.humanPilot === 'missing'));
    assert.ok(report.requiredExternalEvidence.every((evidence) => evidence.status === 'missing'));
  }
});

test('failure, source drift, no execution and unavailable actual PTY are distinct honest local outcomes', () => {
  assert.equal(qualificationAssessment({ executed: false, platform: 'darwin', results: [] }).localFixtures, 'not-run');
  assert.equal(qualificationAssessment({ executed: true, platform: 'darwin', results: [] }).localFixtures, 'not-run');
  assert.equal(qualificationAssessment({ executed: true, platform: 'linux', results: [{ status: 'failed' }] }).localFixtures, 'failed');
  const drift = qualificationAssessment({ executed: true, platform: 'darwin', results: [{ status: 'passed' }], sourceStable: false });
  assert.equal(drift.localFixtures, 'source-changed'); assert.ok(drift.blockers.includes('SKP_QUALIFICATION_SOURCE_CHANGED'));
  const unavailable = qualificationAssessment({ executed: true, platform: 'win32', results: [{ status: 'passed' }, { status: 'unavailable' }] });
  assert.equal(unavailable.localFixtures, 'passed-with-explicit-gaps'); assert.equal(unavailable.releaseQualified, false);
});

test('pilot harness is a blocked prerequisite and measurement plan, never a fabricated successful team or launch permission', () => {
  assert.ok(Object.isFrozen(SKP_PILOT_PLAN)); assert.equal(SKP_PILOT_PLAN.status, 'blocked');
  assert.equal(SKP_PILOT_PLAN.attemptStarted, false); assert.equal(SKP_PILOT_PLAN.launchAuthorized, false);
  assert.deepEqual(SKP_PILOT_PLAN.observations, []);
  for (const field of ['participantEligibility', 'attemptsAndSuccessDenominator', 'activeInteractionMs', 'elapsedMs',
    'humanReviewWaitMs', 'providerWaitMs', 'blockedAttempts', 'abandonedAttempts', 'observedMerge', 'observedChangePassport']) {
    assert.ok(SKP_PILOT_PLAN.measurementFields.includes(field));
  }
});

test('read-only plan binds current checkout/test bytes and Git/Node/OS identity without claiming installed or pilot observations', () => {
  const result = cli('--plan'); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout); assert.equal(report.profile, SKP_QUALIFICATION_PROFILE);
  assert.equal(report.mode, 'read-only-plan'); assert.equal(report.runtime.platform, process.platform);
  assert.equal(report.runtime.nodeVersion, process.versions.node); assert.match(report.runtime.gitVersion, /^\d+\.\d+\.\d+$/u);
  assert.match(report.runtime.sourceRevision, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u); assert.equal(typeof report.runtime.sourceDirty, 'boolean');
  assert.match(report.source.sha256, SHA); assert.ok(report.source.files > 0); assert.ok(report.source.bytes > 0);
  assert.ok(report.source.selectedTests.every((entry) => SHA.test(entry.sha256))); assert.equal(report.source.dependencyInstall, 'not-verified');
  assert.deepEqual(report.results, []); assert.equal(report.qualification.localFixtures, 'not-run'); assert.equal(report.qualification.status, 'not-qualified');
  assert.deepEqual(report.pilot, SKP_PILOT_PLAN);
  assert.ok(Object.values(report.effects).every((value) => value === false));
  assert.equal(report.acceptedImportedAttestations, false); assert.equal(report.assurance, 'local-checkout-test-observation-only');
  assert.equal(result.stdout.includes(path.resolve(ROOT)), false); assert.doesNotMatch(result.stdout, /TOKEN_SECRET|authorizationId|bodyBase64/u);
});

test('require-release cannot turn a plan into qualification; invalid flags fail before any target process', async () => {
  const required = cli('--plan', '--require-release'); assert.equal(required.status, 2, required.stderr);
  assert.equal(JSON.parse(required.stdout).qualification.releaseQualified, false); assert.deepEqual(JSON.parse(required.stdout).results, []);
  const invalid = cli('--evidence=attested-native-host.json'); assert.equal(invalid.status, 1); assert.equal(invalid.stderr, '');
  assert.equal(JSON.parse(invalid.stdout).code, 'SKP_QUALIFICATION_OPTION_INVALID');
  await assert.rejects(runSkpQualification({ execute: false, requireRelease: false, approvedSandbox: true }), { code: 'SKP_QUALIFICATION_OPTION_INVALID' });
  await assert.rejects(runSkpQualification({ execute: 'yes', requireRelease: false }), { code: 'SKP_QUALIFICATION_OPTION_INVALID' });
});

test('actual Node reporter hides noisy secret diagnostics and reports failed/skipped/TODO tests with no passing qualification', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-qualification-events-')); t.after(() => removeTemporaryTree(directory));
  const file = path.join(directory, 'private.test.mjs');
  await writeFile(file, `import test from 'node:test'; import assert from 'node:assert/strict';
    test('TOKEN_SECRET_123 private failing prompt',()=>{console.log('RAW_BODY_SECRET');console.error('RAW_STDERR_SECRET');assert.fail('RAW_ERROR_SECRET');});
    test('SKIP_SECRET',{skip:'SECRET_SKIP_REASON'},()=>{});
    test('TODO_SECRET',{todo:'SECRET_TODO_REASON'},()=>{});`);
  const result = spawnSync(process.execPath, ['--test', `--test-reporter=${RUNNER}`, file],
    { cwd: ROOT, env: childEnvironment(), encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, shell: false, windowsHide: true });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout); assert.equal(report.counts.fail, 1); assert.equal(report.counts.skipped, 1); assert.equal(report.counts.todo, 1);
  assert.doesNotMatch(result.stdout, /TOKEN_SECRET|RAW_BODY|RAW_STDERR|RAW_ERROR|SKIP_SECRET|TODO_SECRET|SECRET_SKIP|SECRET_TODO|private\.test\.mjs/u);
  assert.ok(report.outcomes.every((outcome) => SHA.test(outcome.identitySha256)));
});

test('checkout byte capture rejects symlinks and source bounds without returning partial build identity', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-qualification-source-')); t.after(() => removeTemporaryTree(directory));
  await writeFile(path.join(directory, 'real-package.json'), '{"version":"0.0.1"}');
  try { await symlink('real-package.json', path.join(directory, 'package.json')); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
    // Native Windows may disallow unprivileged symlink creation. A non-file still exercises refusal.
    await mkdir(path.join(directory, 'package.json'));
  } else throw error; }
  await assert.rejects(captureQualificationSource(directory), { code: 'SKP_QUALIFICATION_SOURCE_INVALID' });
  const oversized = path.join(directory, 'oversized'); await mkdir(oversized);
  await writeFile(path.join(oversized, 'package.json'), Buffer.alloc(SKP_QUALIFICATION_LIMITS.fileBytes + 1));
  await assert.rejects(captureQualificationSource(oversized), { code: 'SKP_QUALIFICATION_SOURCE_INVALID' });
  assert.ok(SKP_QUALIFICATION_LIMITS.targetTimeoutMs > 0); assert.ok(SKP_QUALIFICATION_LIMITS.outputBytes <= 1024 * 1024);
  assert.ok(SKP_QUALIFICATION_LIMITS.sourceEntries >= SKP_QUALIFICATION_LIMITS.sourceFiles);
});

test('concurrent file growth is refused after only the exact allocation and one bounded extra-byte probe', async () => {
  const source = Buffer.from('abc'); const requests = [];
  const handle = { async read(buffer, offset, length, position) {
    requests.push({ bytes: buffer.length, length, position });
    if (position >= source.length) return { bytesRead: 1 }; // virtual billion-byte append
    source.copy(buffer, offset, position, position + 1); return { bytesRead: 1 };
  } };
  await assert.rejects(readBoundedQualificationFile(handle, source.length), { code: 'SKP_QUALIFICATION_SOURCE_CHANGED' });
  assert.deepEqual(requests.map((request) => request.position), [0, 1, 2, 3]);
  assert.ok(requests.every((request) => request.bytes <= 3 && request.length <= 3));
  assert.deepEqual(requests.at(-1), { bytes: 1, length: 1, position: 3 });
  const count = requests.length;
  for (const size of [-1, Infinity, 0.5, SKP_QUALIFICATION_LIMITS.fileBytes + 1]) {
    await assert.rejects(readBoundedQualificationFile(handle, size), { code: 'SKP_QUALIFICATION_SOURCE_INVALID' });
  }
  assert.equal(requests.length, count, 'invalid sizes must be refused before I/O or allocation');
});

test('bounded file reads retain exact bytes, including empty files, and refuse truncation or malformed reads', async () => {
  const source = Buffer.from('abc');
  const handle = { async read(buffer, offset, length, position) {
    const bytesRead = Math.min(length, Math.max(0, source.length - position));
    source.copy(buffer, offset, position, position + bytesRead); return { bytesRead };
  } };
  assert.deepEqual(await readBoundedQualificationFile(handle, 3), source);
  assert.deepEqual(await readBoundedQualificationFile({ read: async () => ({ bytesRead: 0 }) }, 0), Buffer.alloc(0));
  await assert.rejects(readBoundedQualificationFile(handle, 4), { code: 'SKP_QUALIFICATION_SOURCE_CHANGED' });
  for (const bytesRead of [0, -1, 2, NaN, undefined]) {
    await assert.rejects(readBoundedQualificationFile({ read: async () => ({ bytesRead }) }, 1),
      { code: 'SKP_QUALIFICATION_SOURCE_CHANGED' });
  }
});

test('unclosed cleanup detaches local pipes and child handle without fabricating termination evidence', () => {
  const stdout = new PassThrough(); const stderr = new PassThrough(); let unrefs = 0;
  stdout.on('data', () => assert.fail('late output must not be consumed'));
  stderr.on('data', () => assert.fail('late error must not be consumed'));
  const result = detachUnclosedQualificationChild({ stdout, stderr, unref: () => { unrefs += 1; } });
  assert.deepEqual(result, { processClosed: false, outputHandlesDetached: true, childUnreferenced: true });
  assert.equal(stdout.destroyed, true); assert.equal(stderr.destroyed, true);
  assert.equal(stdout.listenerCount('data'), 0); assert.equal(stderr.listenerCount('data'), 0); assert.equal(unrefs, 1);
  const unavailable = detachUnclosedQualificationChild({ stdout: { destroy() { throw Error('private'); } },
    unref() { throw Error('private'); } });
  assert.deepEqual(unavailable, { processClosed: false, outputHandlesDetached: false, childUnreferenced: false });
});
