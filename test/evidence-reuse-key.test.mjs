/**
 * The fuller reuse key [TCE:REQ-081, amended 2026-11-17 for CVL-REQ-013/014]. A recorded run stands for a gate only
 * while its installed dependencies and the Story's test policy are the same too. A run recorded before they were kept
 * stands only when they can be shown unchanged since; otherwise it is stale and the run that replaces it says so. A
 * step whose workflow says `testRuns: fresh` reuses nothing, through the same reader as the test-recovery pilot.
 * Whole Stories through the real CLI are in unchanged-test-runs.test.mjs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { FRESH_TEST_RUNS_WORDS, stepRunsTestsFresh } from '../src/code-delivery-policy.mjs';
import { runEnvironmentSha256 } from '../src/code-delivery-tests.mjs';
import { resolveWorkType, validateDefinition } from '../src/config.mjs';
import { evidenceConsistencyLines, projectEvidenceConsistency } from '../src/evidence-consistency.mjs';
import { storyTestPolicySha256, verifyReusableAttempt } from '../src/evidence-reuse.mjs';
import { projectExecutionPacket } from '../src/phase-execution-evidence.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { localTestRunKernel } from '../src/state-stores.mjs';
import { gateTestEnvironment, testRunEnvironmentRecord } from '../src/test-run-environment.mjs';
import { runnerDependencies } from '../src/test-toolchain.mjs';
import { recordTestAttempt, unchangedTestRun } from '../src/verification/attempts.mjs';
import { flakyTestRuns } from '../src/verification/flaky-runs.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = { id: 'unit', argv: ['npm', 'test'], workingDirectory: 'packages/a', result: { adapter: 'node-tap' } };

test('a run\'s dependencies are the lockfiles its runner resolves, from its folder up to the root, and the runtime versions', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-reuse-deps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'packages/a'), { recursive: true });
  await writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await writeFile(path.join(root, 'packages/a/yarn.lock'), '# yarn\n');
  await writeFile(path.join(root, 'packages/go.sum'), 'example.com/x v1.0.0 h1:abc=\n');
  await writeFile(path.join(root, 'Cargo.lock'), 'version = 3\n');
  const versions = { npm: '10.0.0', node: '22.1.0' };
  const first = await runnerDependencies(node, { checkout: root, toolchain: versions });
  assert.deepEqual(first.lockfiles.map((entry) => entry.path), ['packages/a/yarn.lock', 'package-lock.json'], 'only the Node lockfiles on the way up');
  assert.deepEqual(first.runtime, { node: '22.1.0', npm: '10.0.0' });
  assert.match(first.sha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal((await runnerDependencies(node, { checkout: root, toolchain: { node: '22.1.0', npm: '10.0.0' } })).sha256, first.sha256, 'the same bytes and versions');
  assert.notEqual((await runnerDependencies(node, { checkout: root, toolchain: { ...versions, node: '22.2.0' } })).sha256, first.sha256, 'another runtime');
  await writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
  assert.notEqual((await runnerDependencies(node, { checkout: root, toolchain: versions })).sha256, first.sha256, 'an edited lockfile');
  assert.deepEqual((await runnerDependencies({ argv: ['go', 'test', './...'], workingDirectory: 'packages' }, { checkout: root })).lockfiles.map((entry) => entry.path), ['packages/go.sum']);
  assert.deepEqual((await runnerDependencies({ argv: ['cargo', 'test'], workingDirectory: '.' }, { checkout: root })).lockfiles.map((entry) => entry.path), ['Cargo.lock']);
  assert.deepEqual((await runnerDependencies({ argv: ['make', 'test'], workingDirectory: '.' }, { checkout: root })).lockfiles, [], 'a runner with no known lockfile');
  assert.deepEqual((await runnerDependencies({ argv: ['npm', 'test'], workingDirectory: '../elsewhere' }, { checkout: root })).lockfiles.map((entry) => entry.path),
    ['package-lock.json'], 'never a folder outside the checkout');
  if (process.platform !== 'win32') {
    await rm(path.join(root, 'packages/a/yarn.lock'));
    await symlink(path.join(root, 'package-lock.json'), path.join(root, 'packages/a/yarn.lock'));
    const linked = (await runnerDependencies(node, { checkout: root })).lockfiles.find((entry) => entry.path === 'packages/a/yarn.lock');
    assert.deepEqual(linked, { path: 'packages/a/yarn.lock', sha256: null }, 'a link is named, never followed');
  }
});

test('the attempt keeps dependencies and policy beside its environment, outside the environment\'s digest', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-reuse-record-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await mkdir(path.join(root, 'packages/a'), { recursive: true });
  await writeFile(path.join(root, 'package-lock.json'), '{}\n');
  const record = await testRunEnvironmentRecord(node, { cwd: path.join(root, 'packages/a'), environment: { CI: '1', PATH: '' }, checkout: root, testPolicySha256: 'sha256:policy' });
  assert.deepEqual(record.dependencies.lockfiles.map((entry) => entry.path), ['package-lock.json']);
  assert.equal(record.testPolicySha256, 'sha256:policy');
  assert.equal(Object.hasOwn(await testRunEnvironmentRecord(node, { cwd: root, environment: { PATH: '' } }), 'dependencies'), false, 'only a gate that names its checkout records them');
  const gate = gateTestEnvironment({ PATH: '' });
  gate.observe(node, { cwd: path.join(root, 'packages/a'), environment: gate.environment, checkout: root, testPolicySha256: 'sha256:policy' });
  const fresh = { reason: 'step-requires', words: FRESH_TEST_RUNS_WORDS };
  const check = { id: 'unit', kind: 'test', status: 'passed', exitCode: 0, sourceCommit: null, sourceTreeSha256: 'sha256:tree', resultIsolated: false, freshRun: fresh };
  await gate.attach(check);
  assert.equal(Object.hasOwn(check.runEnvironment, 'dependencies'), false, 'the environment, and so its digest, is as before');
  assert.equal(Object.hasOwn(check.runEnvironment, 'testPolicySha256'), false);
  assert.deepEqual(check.reuseKey, { dependencies: record.dependencies, testPolicySha256: 'sha256:policy' });
  assert.doesNotMatch(JSON.stringify(check), /dependencies|testPolicySha256/u, 'never in the check\'s JSON');
  const { attempt } = await recordTestAttempt(root, 'work', { command: node, check, purpose: 'preflight', workId: 'W-1', phaseId: 'code', generation: 1 });
  assert.deepEqual(attempt.dependencies, record.dependencies);
  assert.equal(attempt.testPolicySha256, 'sha256:policy');
  assert.deepEqual(attempt.freshRun, fresh);
  assert.equal(Object.hasOwn(attempt.environment, 'dependencies'), false);
  assert.equal(attempt.environmentSha256, runEnvironmentSha256(check.runEnvironment));
});

/** A repository with one committed lockfile, a store of recorded attempts, and the reuse check against it. */
async function attemptStore(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-reuse-key-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'Key Tester', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'key@example.invalid' } }).stdout.trim();
  git('init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  git('add', '.'); git('commit', '-q', '-m', 'One');
  const commit = git('rev-parse', 'HEAD');
  const report = Buffer.from('report');
  const reportSha = createHash('sha256').update(report).digest('hex');
  const stage = path.join(root, '.git/singularity-flow/test-attempts/W-1');
  await mkdir(path.join(stage, 'code'), { recursive: true });
  await mkdir(path.join(stage, 'raw'), { recursive: true });
  await writeFile(path.join(stage, 'raw', reportSha), report);
  const command = { id: 'unit', argv: ['npm', 'test'], workingDirectory: '.', result: { adapter: 'node-tap' } };
  const argvSha256 = createHash('sha256').update(Buffer.from(JSON.stringify(command.argv))).digest('hex');
  let serial = 0;
  const attempt = async (overrides = {}) => {
    serial += 1;
    const attemptId = `TA-${String(serial).padStart(20, '0')}`;
    const record = { schemaVersion: currentSchemaVersion('test-execution'), kind: 'test-execution', attemptId, nonce: String(serial), parentAttemptId: null, purpose: 'preflight',
      workId: 'W-1', phase: 'code', generation: 1, commandId: 'unit', argvSha256, workingDirectory: '.', adapter: 'node-tap', environmentSha256: 'sha256:env',
      status: 'passed', exitCode: 0, reportError: null, tests: { discovered: 1, passed: 1, failed: 0, skipped: 0 },
      candidate: { commit, treeSha256: 'sha256:tree', testInputSha256: 'sha256:inputs' },
      rawReports: [{ path: `work/raw/${reportSha}.bin`, sha256: reportSha, bytes: report.length }],
      process: { completedAt: `2026-11-17T00:00:${String(serial).padStart(2, '0')}.000Z` }, ...overrides };
    await writeFile(path.join(stage, 'code', `${attemptId}.json`), JSON.stringify(record));
    return record;
  };
  const dependencies = () => runnerDependencies(command, { checkout: root, toolchain: { node: '22.1.0' } });
  const standing = (workflow, now = {}) => unchangedTestRun(root, 'work', workflow, 'verify', command,
    { commit, treeSha256: 'sha256:tree', testInputSha256: 'sha256:inputs', environmentSha256: 'sha256:env', ...now });
  return { root, attempt, dependencies, standing };
}

test('reuse is refused when a lockfile or the test policy changes, and allowed when neither does', async (t) => {
  const store = await attemptStore(t);
  const workflow = { workItem: { id: 'W-1' }, phaseOrder: ['code', 'verify'], testCommandPins: [] };
  const deps = await store.dependencies();
  const recorded = await store.attempt({ dependencies: deps, testPolicySha256: 'sha256:policy' });
  const same = await store.standing(workflow, { dependencies: deps, testPolicySha256: 'sha256:policy' });
  assert.equal(same.attempt.attemptId, recorded.attemptId, 'the same lockfile and policy: the run stands');
  await writeFile(path.join(store.root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"":{}}}\n');
  const moved = await store.standing(workflow, { dependencies: await store.dependencies(), testPolicySha256: 'sha256:policy' });
  assert.equal(moved.attempt, undefined);
  assert.equal(moved.moved, `its installed dependencies changed since ${recorded.attemptId}`);
  assert.match((await store.standing(workflow, { dependencies: null, testPolicySha256: 'sha256:policy' })).moved, /installed dependencies changed/u,
    'dependencies that cannot be read now are never assumed the same');
  const policy = await store.standing(workflow, { dependencies: deps, testPolicySha256: 'sha256:stricter' });
  assert.equal(policy.attempt, undefined);
  assert.equal(policy.moved, `the Story's test policy changed since ${recorded.attemptId}`);
  // A caller that compares neither, as before this change, is unaffected.
  assert.equal((await store.standing(workflow)).attempt.attemptId, recorded.attemptId);
});

test('a run recorded before dependencies and policy were kept stands only when they can be shown unchanged', async (t) => {
  const store = await attemptStore(t);
  const workflow = { workItem: { id: 'W-1' }, phaseOrder: ['code', 'verify'], testCommandPins: [], workflowSnapshot: { revision: 1 } };
  const legacy = await store.attempt();
  const committed = await store.dependencies();
  const shown = await store.standing(workflow, { dependencies: committed, testPolicySha256: 'sha256:policy' });
  assert.equal(shown.attempt.attemptId, legacy.attemptId, 'the lockfile is the one committed here and the workflow was never amended');
  assert.equal(shown.stale, undefined);
  assert.equal((await store.standing({ ...workflow, workflowSnapshot: undefined }, { dependencies: committed, testPolicySha256: 'sha256:policy' })).attempt.attemptId,
    legacy.attemptId, 'a Story that never had a snapshot was never amended either');
  // An edit not committed: the code digest the run matched does not cover it.
  await writeFile(path.join(store.root, 'package-lock.json'), '{"lockfileVersion":3,"edited":true}\n');
  const edited = await store.standing(workflow, { dependencies: await store.dependencies(), testPolicySha256: 'sha256:policy' });
  assert.equal(edited.attempt, undefined);
  assert.equal(edited.moved, `${legacy.attemptId}, the earlier run on this same code, did not record its dependencies, and they could not be shown unchanged since`);
  assert.deepEqual(edited.stale, { attemptId: legacy.attemptId, reason: 'earlier-run-unproven',
    words: `${legacy.attemptId}, the earlier run on this same code, did not record its dependencies, and they could not be shown unchanged since, so it is stale and the tests ran again` });
  await writeFile(path.join(store.root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  // A lockfile Git does not hold cannot be shown unchanged either.
  await writeFile(path.join(store.root, 'npm-shrinkwrap.json'), '{}\n');
  assert.match((await store.standing(workflow, { dependencies: await store.dependencies(), testPolicySha256: 'sha256:policy' })).moved,
    /did not record its dependencies, and they could not be shown unchanged since$/u);
  await rm(path.join(store.root, 'npm-shrinkwrap.json'));
  // A workflow amended since the Story began may have changed the policy the run was judged under.
  const amended = { ...workflow, workflowSnapshot: { revision: 2 } };
  assert.match((await store.standing(amended, { dependencies: committed, testPolicySha256: 'sha256:policy' })).stale.words,
    /did not record its test policy, and it could not be shown unchanged since, so it is stale and the tests ran again$/u);
  assert.match((await store.standing(amended, { dependencies: null, testPolicySha256: 'sha256:policy' })).moved,
    /did not record its dependencies or its test policy, and they could not be shown unchanged since$/u);
  // A newer run that records both is compared by them, whatever came before it.
  const kept = await store.attempt({ dependencies: committed, testPolicySha256: 'sha256:policy' });
  assert.equal((await store.standing(amended, { dependencies: committed, testPolicySha256: 'sha256:policy' })).attempt.attemptId, kept.attemptId);
});

test('the test policy digest follows the pinned rules, not a later scope change, and the fresh setting is read from the pinned step', () => {
  const base = { resolution: { codeDelivery: { tests: { minimumDiscovered: 1, minimumPassed: 1 } }, testExecutionMode: 'changed-and-affected',
    phases: [{ id: 'code' }, { id: 'verify' }] }, testPolicy: { sha256: 'sha256:sealed' } };
  const digest = storyTestPolicySha256(base);
  assert.match(digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(storyTestPolicySha256({ ...base, testScopeChanges: [{ to: 'new-and-changed' }] }), digest, 'anyone may narrow; a whole run already ran the new tests');
  const changed = (resolution, extra = {}) => storyTestPolicySha256({ ...base, ...extra, resolution: { ...base.resolution, ...resolution } });
  assert.notEqual(changed({ codeDelivery: { tests: { minimumDiscovered: 1, minimumPassed: 5 } } }), digest, 'minimum counts');
  assert.notEqual(changed({ codeDelivery: { ...base.resolution.codeDelivery, changedLineCoverage: { mode: 'enforce', minimum: 80 } } }), digest, 'coverage rule');
  assert.notEqual(changed({ testExecutionMode: 'all-configured' }), digest, 'the scope intake pinned');
  assert.notEqual(changed({}, { testPolicy: { sha256: 'sha256:other' } }), digest, 'the sealed Story test policy');
  assert.equal(FRESH_TEST_RUNS_WORDS, 'tests run fresh (this step requires it)');
  const fresh = { ...base, resolution: { ...base.resolution, phases: [{ id: 'code', testRuns: 'fresh' }, { id: 'verify' }] } };
  assert.equal(stepRunsTestsFresh(base, 'code'), false);
  assert.equal(stepRunsTestsFresh(fresh, 'code'), true);
  assert.equal(stepRunsTestsFresh(fresh, 'verify'), false, 'only the step that says so');
  // The gates' one reader, shared with the test-recovery pilot.
  const { mayReuseUnchangedRuns } = localTestRunKernel;
  assert.equal(mayReuseUnchangedRuns(base, { id: 'code' }), true, 'a Story pinned without the setting reuses as before');
  assert.equal(mayReuseUnchangedRuns(fresh, { id: 'code' }), false, 'a step requiring a fresh run never reuses');
  assert.equal(mayReuseUnchangedRuns(fresh, { id: 'verify' }), true);
  assert.equal(mayReuseUnchangedRuns({ ...base, resolution: { ...base.resolution, testRecovery: { enabled: true } } }, { id: 'code' }), false, 'the pilot, as before');
  // A step the live workflow marks fresh after the Story pinned it keeps its pinned behaviour: only resolution.phases is read.
  assert.equal(mayReuseUnchangedRuns({ ...base, phases: { code: { id: 'code', testRuns: 'fresh' } } }, { id: 'code', testRuns: 'fresh' }), true);
});

test('testRuns is a reviewed workflow setting: checked at load and pinned only when fresh', async () => {
  const config = YAML.parse(await readFile(path.join(packageRoot, 'templates/workflow.yml'), 'utf8'));
  validateDefinition(config);
  const phaseOf = (definition, id) => resolveWorkType(definition, 'feature').phases.find((phase) => phase.id === id);
  assert.equal(Object.hasOwn(phaseOf(config, 'implementation'), 'testRuns'), false, 'a workflow that asks for nothing resolves, and hashes, as before');
  const fresh = structuredClone(config);
  fresh.phases.implementation.testRuns = 'fresh';
  validateDefinition(fresh);
  assert.equal(phaseOf(fresh, 'implementation').testRuns, 'fresh');
  assert.equal(Object.hasOwn(phaseOf(fresh, 'verification'), 'testRuns'), false);
  const reuse = structuredClone(fresh);
  const overrides = reuse.workTypes.feature.phaseOverrides ??= {};
  overrides.implementation = { ...(overrides.implementation ?? {}), testRuns: 'reuse' };
  validateDefinition(reuse);
  assert.equal(Object.hasOwn(phaseOf(reuse, 'implementation'), 'testRuns'), false, 'a work type may turn it back to reuse');
  const wrong = structuredClone(config);
  wrong.phases.implementation.testRuns = 'always';
  assert.throws(() => validateDefinition(wrong), /Phase 'implementation' testRuns must be reuse or fresh\./u);
  const wrongOverride = structuredClone(config);
  const wrongOverrides = wrongOverride.workTypes.feature.phaseOverrides ??= {};
  wrongOverrides.implementation = { ...(wrongOverrides.implementation ?? {}), testRuns: true };
  assert.throws(() => validateDefinition(wrongOverride), /Work type 'feature' phase 'implementation' override testRuns must be reuse or fresh\./u);
  const schema = JSON.parse(await readFile(path.join(packageRoot, 'schemas/workflow-definition.schema.json'), 'utf8'));
  assert.deepEqual(schema.properties.phases.additionalProperties.properties.testRuns.enum, ['reuse', 'fresh']);
});

test('a person\'s evidence reuse is refused for a step whose tests run fresh, naming the run that works', async () => {
  const attemptId = `TA-${'a'.repeat(20)}`;
  const workflow = { workItem: { id: 'W-1' }, phaseOrder: ['code', 'verify'],
    phases: { code: { id: 'code', status: 'approved', generation: 1, deliveryEvidence: { status: 'ready', testExecutions: [{ attemptId, commandId: 'unit' }] } },
      verify: { id: 'verify', status: 'in_progress', generation: 1, qualityCommands: [{ id: 'unit', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.' }] } },
    resolution: { phases: [{ id: 'code' }, { id: 'verify', testRuns: 'fresh' }] } };
  await assert.rejects(verifyReusableAttempt(packageRoot, {}, workflow, { phaseId: 'verify', attemptId }), (error) => {
    assert.equal(error.code, 'EVIDENCE_REUSE_NOT_ELIGIBLE');
    assert.match(error.message, /cannot be reused for verify: its workflow says its tests run fresh, so no earlier run stands for it\. Fresh recorded run: submit verify; its submission runs its tests again\. Shell: /u);
    assert.equal(error.details.freshRunRequired, true);
    assert.ok(error.details.nextAction.command, 'a route that works');
    return true;
  });
});

test('the evidence account says why a run ran fresh, and a fresh run is never flaky against other dependencies', () => {
  const words = FRESH_TEST_RUNS_WORDS;
  const check = { id: 'unit', kind: 'test', status: 'passed', exitCode: 0, sourceTreeSha256: `sha256:${'1'.repeat(64)}`, sourceCommit: 'c'.repeat(40),
    freshRun: { reason: 'step-requires', words } };
  const packet = { workId: 'W-1', phase: 'code', generation: 1, packetSha256: 'sha256:packet', evidenceCommit: 'e'.repeat(40), sourceCommit: 'c'.repeat(40),
    sourceTreeSha256: check.sourceTreeSha256, checks: [check] };
  const phase = { id: 'code', status: 'awaiting_approval', generation: 1, checks: [check] };
  const projected = projectExecutionPacket(packet, phase, { status: 'available', sourceTreeSha256: check.sourceTreeSha256, testInputSha256: null, ancestor: () => true });
  assert.equal(projected.checks[0].freshRun, words);
  const workflow = { workItem: { id: 'W-1' }, phaseOrder: ['code'], phases: { code: phase } };
  const account = projectEvidenceConsistency({ workflow, phase, executionEvidence: { entries: [{ ...projected, executions: [] }] } });
  assert.ok(evidenceConsistencyLines(account).some((line) => line.includes(`unit: passed, no structured counts; source binding matched; ${words}`)), evidenceConsistencyLines(account).join('\n'));
  const run = (attemptId, status, dependencies) => ({ attemptId, commandId: 'unit', status, argvSha256: 'argv', workingDirectory: '.', adapter: 'node-tap',
    environmentSha256: 'sha256:env', candidate: { treeSha256: 'sha256:tree' }, dependencies: { sha256: dependencies } });
  assert.deepEqual(flakyTestRuns([run('TA-1', 'failed', 'sha256:a'), run('TA-2', 'passed', 'sha256:b')]), [], 'another lockfile is another run');
  assert.equal(flakyTestRuns([run('TA-1', 'failed', 'sha256:a'), run('TA-2', 'passed', 'sha256:a')]).length, 1);
});
