import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

const bin = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

async function fixture(t, { enabled = true, baselinePolicy = 'choice' } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-trp-cli-intake-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'checkout');
  await mkdir(root);
  const environment = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1',
    SINGULARITY_FLOW_TEST_IDENTITY: 'TRP Intake Tester',
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'),
    SINGULARITY_FLOW_STORY_CONFIGURATION_CACHE: path.join(root, '.git', 'fixture-config-cache') };
  function invoke(command, argv, { allowFailure = false, cwd = root } = {}) {
    const result = spawnSync(command, argv, { cwd, encoding: 'utf8', env: environment, timeout: 30_000 });
    assert.ifError(result.error);
    if (!allowFailure) assert.equal(result.status, 0, `${command} ${argv.join(' ')}\n${result.stderr}\n${result.stdout}`);
    return result;
  }
  const git = (...argv) => invoke('git', argv).stdout.trim();
  const flow = (argv, options) => invoke(process.execPath, [bin, ...argv], options);
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'TRP Intake Tester');
  git('config', 'user.email', 'trp.intake@example.invalid');
  flow(['init']);
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.sflow/results/\n');
  await writeFile(path.join(root, 'README.md'), '# CLI intake fixture\n');
  await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'trp-intake-fixture', version: '1.0.0', private: true,
    scripts: { test: 'node --test --test-reporter=tap test/*.test.mjs' } }));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'trp-intake-fixture', version: '1.0.0',
    lockfileVersion: 3, requires: true, packages: { '': { name: 'trp-intake-fixture', version: '1.0.0' } } }));
  await writeFile(path.join(root, 'test/baseline.test.mjs'), [
    "import test from 'node:test'; import assert from 'node:assert/strict';",
    "import {mkdirSync,appendFileSync} from 'node:fs';",
    "test('existing baseline failure',()=>{ mkdirSync('.sflow/results',{recursive:true}); appendFileSync('.sflow/results/intake-test-runs','ran\\n'); assert.fail('pre-existing fixture failure'); });", ''
  ].join('\n'));
  const definitionFile = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionFile, 'utf8'));
  definition.git.publish = 'off';
  definition.repositoryReadiness = { ...definition.repositoryReadiness, requiredBeforeStory: true, baselinePolicy };
  definition.testRecovery = { enabled };
  await writeFile(definitionFile, YAML.stringify(definition));
  git('add', '.'); git('commit', '-qm', 'Exact-base intake fixture');
  const remote = path.join(base, 'remote.git');
  invoke('git', ['init', '--bare', '-q', '-b', 'main', remote], { cwd: base });
  git('remote', 'add', 'origin', remote); git('push', '-q', 'origin', 'main');
  const baseCommit = git('rev-parse', 'HEAD');
  const marker = path.join(root, '.sflow/results/intake-test-runs');
  const preview = (mode = null) => JSON.parse(flow(['workspace', 'branches', '--json', '--intake',
    '--preflight-story', 'TRP-CLI-PREVIEW', '--from-branch', 'main', '--selected-base-only', '--work-type', 'feature',
    ...(mode ? ['--test-baseline-disposition', 'fix', '--test-execution-mode', mode, '--test-baseline-scope', 'reuse'] : [])
  ]).stdout).preflight;
  const assertUnchanged = () => {
    assert.equal(git('rev-parse', 'HEAD'), baseCommit);
    assert.equal(git('branch', '--show-current'), 'main');
    assert.equal(git('status', '--porcelain'), '');
    assert.equal(git('ls-remote', 'origin', 'refs/heads/TRP-CLI-PREVIEW'), '');
  };
  return { root, git, flow, baseCommit, marker, preview, assertUnchanged };
}

function assertRepairPreview(preflight, baseCommit, baselineStatus) {
  const pending = baselineStatus === 'unknown';
  assert.equal(preflight.passed, true, JSON.stringify(preflight.readiness));
  assert.equal(preflight.readiness.ready, true);
  assert.ok(preflight.readiness.warnings.some(row => row.code === (pending
    ? 'STORY_TEST_CONFIGURATION_PENDING' : 'STORY_PRE_EXISTING_TEST_FAILURES_OBSERVED')));
  assert.ok(!preflight.readiness.blockers.some(row => row.code === 'STORY_REPOSITORY_READINESS_REQUIRED'));
  const policy = preflight.testRecovery;
  assert.equal(policy.enabled, true);
  assert.equal(policy.ready, true);
  assert.equal(policy.route, pending ? 'feature-coding' : 'readiness-repair');
  assert.equal(policy.repositories[0].testConfigurationPending, pending);
  assert.match(policy.planDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(policy.supportedBaselineDispositions, ['fix']);
  assert.deepEqual(policy.supportedExecutionModes, ['changed-and-affected', 'all-configured']);
  assert.deepEqual(policy.supportedBaselineScopes, ['reuse']);
  assert.equal(policy.acceptKnownFailuresEligible, false);
  assert.equal(policy.repositories[0].baseCommit, baseCommit);
  assert.equal(policy.repositories[0].baselineStatus, baselineStatus);
  assert.deepEqual(policy.repositories[0].commands, [], 'preview must not imply it executed test commands');
}

test('real CLI leaves missing baseline pending; independent modes have exact distinct digests and preview runs no test', async t => {
  const f = await fixture(t);
  const affected = f.preview('changed-and-affected');
  const all = f.preview('all-configured');
  assertRepairPreview(affected, f.baseCommit, 'unknown');
  assertRepairPreview(all, f.baseCommit, 'unknown');
  assert.equal(affected.testRecovery.choices.executionMode, 'changed-and-affected');
  assert.equal(all.testRecovery.choices.executionMode, 'all-configured');
  assert.notEqual(affected.testRecovery.planDigest, all.testRecovery.planDigest);
  assert.equal(f.preview('changed-and-affected').testRecovery.planDigest, affected.testRecovery.planDigest);
  assert.equal(affected.testReadiness.repositories[0].disposition, 'not-verified');
  await assert.rejects(access(f.marker), { code: 'ENOENT' });
  f.assertUnchanged();
});

test('real CLI preserves an actual failed baseline while advertising repair admission and never reruns it during preview', async t => {
  const f = await fixture(t);
  const baselinePlan = JSON.parse(f.flow(['precheck', '--run', '--scope', 'dependency-test', '--json']).stdout);
  const planId = baselinePlan.data?.plan?.planId ?? baselinePlan.plan?.planId ?? baselinePlan.planId;
  assert.match(planId, /^sha256:[a-f0-9]{64}$/u);
  const executed = f.flow(['precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', planId, '--json'], { allowFailure: true });
  assert.notEqual(executed.status, 0, 'the fixture must produce a genuine test failure');
  const count = await readFile(f.marker, 'utf8');
  assert.equal(count, 'ran\n');
  const affected = f.preview('changed-and-affected');
  const all = f.preview('all-configured');
  assertRepairPreview(affected, f.baseCommit, 'failing-tests');
  assertRepairPreview(all, f.baseCommit, 'failing-tests');
  assert.notEqual(affected.testRecovery.planDigest, all.testRecovery.planDigest);
  assert.equal(affected.testReadiness.repositories[0].disposition, 'pre-existing-test-failures-require-decision');
  assert.ok(affected.testRecovery.repositories[0].failures.some(row => row.id === 'existing baseline failure'));
  assert.ok(affected.testRecovery.repositories[0].tools.some(row => row.adapter === 'node-tap'));
  assert.equal(await readFile(f.marker, 'utf8'), count, 'read-only intake may inspect evidence but must not execute tests');
  f.assertUnchanged();
});

test('disabled TRP still permits unobserved test setup under the normal choice policy', async t => {
  const f = await fixture(t, { enabled: false });
  const result = f.preview();
  assert.equal(result.passed, true);
  assert.equal(result.readiness.ready, true);
  assert.ok(result.readiness.warnings.some(row => row.code === 'STORY_TEST_CONFIGURATION_PENDING'));
  assert.deepEqual(result.testRecovery, { schemaVersion: 1, enabled: false });
  await assert.rejects(access(f.marker), { code: 'ENOENT' });
  f.assertUnchanged();
});

test('an old required-baseline policy does not gate intake even without TRP', async t => {
  const f = await fixture(t, { enabled: false, baselinePolicy: 'required' });
  const result = f.preview();
  assert.equal(result.passed, true);
  assert.equal(result.readiness.ready, true);
  assert.ok(!result.readiness.blockers.some(row => row.code === 'STORY_REPOSITORY_READINESS_REQUIRED'));
  assert.ok(!result.readiness.warnings.some(row => row.code === 'TRP_READINESS_REPAIR_REQUIRED'));
  assert.deepEqual(result.testRecovery, { schemaVersion: 1, enabled: false });
  await assert.rejects(access(f.marker), { code: 'ENOENT' });
  f.assertUnchanged();
});
