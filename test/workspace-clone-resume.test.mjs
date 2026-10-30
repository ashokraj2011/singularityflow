import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import {
  CLONE_COMPLETION_FILE, cloneClaimPolicy, retryWorkspaceCloneClaim
} from '../src/workspace-clone-claim.mjs';
import {
  createWorkspace, previewWorkspace, readWorkspace, repairWorkspace, rememberWorkspace, orphanCloneStagingRoots
} from '../src/workspace.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';
import { run } from '../src/util.mjs';

const fast = { ...process.env, SINGULARITY_FLOW_CLONE_CLAIM_TIMEOUT_MS: '15000',
  SINGULARITY_FLOW_CLONE_CLAIM_RETRY_DELAY_MS: '1', SINGULARITY_FLOW_CLONE_CLAIM_MAX_ATTEMPTS: '3' };
const locked = () => Object.assign(new Error('EBUSY: simulated folder move lock'), { code: 'EBUSY' });

async function fixture(t, { create = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sflow-clone-resume-')));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  run('git', ['init', '--initial-branch=main'], { cwd: source });
  run('git', ['config', 'user.name', 'Fixture Author'], { cwd: source });
  run('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: source });
  await fs.writeFile(path.join(source, 'README.md'), 'retained source\n');
  run('git', ['add', '.'], { cwd: source });
  run('git', ['commit', '-m', 'fixture'], { cwd: source });
  const remote = path.join(root, 'remote.git');
  run('git', ['clone', '--bare', source, remote], { cwd: root });
  const input = { baseDirectory: path.join(root, 'workspaces'), anchor: { provider: 'workspace',
    key: 'clone-resume', title: 'Clone resume' }, leadRepository: 'app',
    repositories: { app: { url: remote, defaultBranch: 'main', required: true, path: 'repos/app' } } };
  const workspace = previewWorkspace(input).root;
  const target = path.join(workspace, 'repos', 'app');
  if (!create) await createWorkspace(input, { confirmation: 'clone-resume', clone: false, env: fast });
  const staging = async () => (await fs.readdir(path.dirname(target)))
    .filter(name => name.startsWith('.sflow-clone-')).map(name => path.join(path.dirname(target), name));
  const journal = async () => JSON.parse(await fs.readFile(path.join(workspace, 'logs', 'workspace-materialization.json'), 'utf8'));
  return { root, input, workspace, target, remote, staging, journal };
}

async function interceptClaim(target, intercept, action) {
  const original = fs.rename;
  fs.rename = (from, to) => to === target && path.basename(from) === 'repository'
    ? intercept(original, from, to) : original(from, to);
  syncBuiltinESMExports();
  try { return await action(); }
  finally { fs.rename = original; syncBuiltinESMExports(); }
}

async function retain(f) {
  await interceptClaim(f.target, async () => { throw locked(); }, async () => {
    await assert.rejects(() => repairWorkspace(f.workspace, { env: fast, statusLevel: 'readiness' }), error => {
      assert.equal(error.code, 'WORKSPACE_CLONE_CLAIM_PENDING');
      assert.equal(error.details.causeCode, 'EBUSY');
      assert.equal(error.details.retry.attempts, 3);
      assert.equal(error.details.resumable, true);
      return true;
    });
  });
  const roots = await f.staging();
  assert.equal(roots.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(roots[0], CLONE_COMPLETION_FILE), 'utf8')).schemaVersion, 1);
  return roots[0];
}

test('claim retries have configurable, validated bounds and a five-minute default', async t => {
  assert.equal(cloneClaimPolicy({}).timeoutMs, 300_000);
  for (const key of ['SINGULARITY_FLOW_CLONE_CLAIM_TIMEOUT_MS', 'SINGULARITY_FLOW_CLONE_CLAIM_RETRY_DELAY_MS', 'SINGULARITY_FLOW_CLONE_CLAIM_MAX_ATTEMPTS']) {
    for (const value of ['', '0', '-1', 'NaN', '1.5', '99999999']) assert.throws(
      () => cloneClaimPolicy({ [key]: value }), { code: 'WORKSPACE_CLONE_CLAIM_SETTINGS_INVALID' });
  }
  let count = 0;
  await assert.rejects(() => retryWorkspaceCloneClaim(async () => { count++; throw locked(); }, async () => {},
    { timeoutMs: 1000, initialDelayMs: 1, maxAttempts: 2 }), error => error.claimRetry.attempts === 2);
  assert.equal(count, 2);
  let observed = 0;
  await assert.rejects(() => retryWorkspaceCloneClaim(async () => {}, async () => { observed++; throw locked(); },
    { timeoutMs: 1000, initialDelayMs: 1, maxAttempts: 2 }));
  assert.equal(observed, 2, 'failed ownership observations consume the same retry budget');
  let deadlineCalls = 0;
  // A fractional remaining timeout may wake early on Windows. Advance a controlled monotonic
  // clock past the deadline after the first wait instead of asserting scheduler resolution.
  let clockReads = 0;
  const clock = t.mock.method(performance, 'now', () => clockReads++ < 2 ? 0 : 2);
  try {
    await assert.rejects(() => retryWorkspaceCloneClaim(async () => { deadlineCalls++; throw locked(); }, async () => {},
      { timeoutMs: 1, initialDelayMs: 100, maxAttempts: 100 }));
  } finally { clock.mock.restore(); }
  assert.equal(deadlineCalls, 1, 'do not begin another move after the wall-clock budget expires');
  let otherCalls = 0;
  await assert.rejects(() => retryWorkspaceCloneClaim(async () => {
    otherCalls++; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  }, async () => {}, { timeoutMs: 100, initialDelayMs: 1, maxAttempts: 100 }), { code: 'ENOSPC' });
  assert.equal(otherCalls, 1, 'disk and integrity failures are not lock retries');
});

test('repair retains completed clone and resumes with no remote or second clone', async t => {
  const f = await fixture(t);
  const stage = await retain(f);
  assert.equal((await f.journal()).operations[0].claimRecovery.path, stage);
  await fs.rm(f.remote, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  const timer = commandTimer('repair');
  const result = await withCommandTiming(timer, () => repairWorkspace(f.workspace, { env: fast, statusLevel: 'readiness' }));
  assert.equal(timer.finish().counters['git.remote-clone'] ?? 0, 0);
  assert.equal(result.repaired[0].resumedClone, true);
  assert.equal(await fs.readFile(path.join(f.target, 'README.md'), 'utf8'), 'retained source\n');
  assert.deepEqual(await f.staging(), []);
  assert.equal((await f.journal()).operations[0].claimRecovery, null);
});

test('retrying original workspace creation resumes the same completed clone', async t => {
  const f = await fixture(t, { create: true });
  await interceptClaim(f.target, async () => { throw locked(); }, async () => {
    await assert.rejects(() => createWorkspace(f.input, { confirmation: 'clone-resume', clone: true, env: fast }),
      { code: 'WORKSPACE_CLONE_CLAIM_PENDING' });
  });
  await fs.rm(f.remote, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  const result = await createWorkspace(f.input, { confirmation: 'clone-resume', clone: true, env: fast });
  assert.equal(result.resumed, true);
  assert.equal(result.repair[0].resumedClone, true);
});

test('a newly occupied destination preserves both user files and completed clone', async t => {
  const f = await fixture(t);
  const stage = await retain(f);
  await fs.mkdir(f.target);
  await fs.writeFile(path.join(f.target, 'user.txt'), 'do not replace');
  await assert.rejects(() => repairWorkspace(f.workspace, { env: fast, statusLevel: 'readiness' }));
  assert.equal(await fs.readFile(path.join(f.target, 'user.txt'), 'utf8'), 'do not replace');
  assert.equal(await fs.readFile(path.join(stage, 'repository', 'README.md'), 'utf8'), 'retained source\n');
});

test('modified retained bytes are refused and not silently recloned or removed', async t => {
  const f = await fixture(t);
  const stage = await retain(f);
  await fs.writeFile(path.join(stage, 'repository', 'README.md'), 'local work to preserve');
  await assert.rejects(() => repairWorkspace(f.workspace, { env: fast, statusLevel: 'readiness' }), /no longer matches its recovery record/);
  assert.equal(await fs.readFile(path.join(stage, 'repository', 'README.md'), 'utf8'), 'local work to preserve');
  assert.equal((await f.staging()).length, 1);
});

test('retained Git configuration changes are refused before invoking repository helpers', async t => {
  const f = await fixture(t);
  const stage = await retain(f);
  const clone = path.join(stage, 'repository');
  run('git', ['config', 'core.fsmonitor', '!unexpected-helper'], { cwd: clone });
  await assert.rejects(() => repairWorkspace(f.workspace, { env: fast, statusLevel: 'readiness' }), /no longer matches its recovery record/);
  assert.ok((await fs.stat(path.join(stage, CLONE_COMPLETION_FILE))).isFile());
});

test('a target populated after its final observation is never overwritten by rename', async t => {
  const f = await fixture(t);
  let injected = false;
  await interceptClaim(f.target, async (rename, from, to) => {
    if (!injected) {
      injected = true;
      await fs.mkdir(to);
      await fs.writeFile(path.join(to, 'user.txt'), 'keep concurrent bytes');
    }
    return rename(from, to);
  }, async () => {
    await assert.rejects(() => repairWorkspace(f.workspace, { env: fast, statusLevel: 'readiness' }));
  });
  assert.equal(await fs.readFile(path.join(f.target, 'user.txt'), 'utf8'), 'keep concurrent bytes');
  assert.equal((await f.staging()).length, 1);
});

test('changed reviewed clone plan refuses reuse while retaining the original clone', async t => {
  const f = await fixture(t);
  const stage = await retain(f);
  const file = path.join(f.workspace, 'workspace.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.repositories.app.defaultBranch = 'changed';
  await fs.writeFile(file, JSON.stringify(manifest));
  await assert.rejects(() => repairWorkspace(f.workspace, { env: fast, statusLevel: 'readiness' }), /no longer matches its recovery record/);
  assert.ok((await fs.stat(path.join(stage, CLONE_COMPLETION_FILE))).isFile());
});

test('orphan cleanup does not classify completed recovery as disposable staging', async t => {
  const f = await fixture(t);
  const stage = await retain(f);
  const registry = path.join(f.root, 'registry.json');
  await rememberWorkspace(registry, await readWorkspace(f.workspace));
  const orphans = await orphanCloneStagingRoots(registry, { now: Date.now() + 8 * 60 * 60 * 1000 });
  assert.ok(!orphans.some(entry => entry.path === stage));
});

test('an interrupted journal write preserves sealed clone for a later repair', async t => {
  const f = await fixture(t);
  const original = fs.readFile;
  let injected = false;
  fs.readFile = async (file, ...args) => {
    if (file === path.join(f.workspace, 'workspace.json') && !injected) {
      const stages = await f.staging();
      if (stages.length && await fs.stat(path.join(stages[0], CLONE_COMPLETION_FILE)).catch(() => null)) {
        injected = true;
        throw new Error('injected finalization interruption');
      }
    }
    return original(file, ...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(() => repairWorkspace(f.workspace, { env: fast, statusLevel: 'readiness' }), /finalization interruption/); }
  finally { fs.readFile = original; syncBuiltinESMExports(); }
  assert.ok(injected);
  await fs.rm(f.remote, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  const result = await repairWorkspace(f.workspace, { env: fast, statusLevel: 'readiness' });
  assert.equal(result.repaired[0].resumedClone, true);
});

test('actual Windows directory lock is retried until the owning process exits', { skip: process.platform !== 'win32', timeout: 30_000 }, async t => {
  const f = await fixture(t);
  let child;
  let claims = 0;
  let release;
  t.after(() => { clearTimeout(release); child?.kill(); });
  const result = await interceptClaim(f.target, async (rename, from, to) => {
    claims++;
    if (!child) {
      child = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'],
        { cwd: from, stdio: ['ignore', 'pipe', 'pipe'] });
      await once(child.stdout, 'data');
      release = setTimeout(() => child.kill(), 600);
    }
    return rename(from, to);
  }, () => repairWorkspace(f.workspace, { env: { ...fast, SINGULARITY_FLOW_CLONE_CLAIM_MAX_ATTEMPTS: '100',
    SINGULARITY_FLOW_CLONE_CLAIM_TIMEOUT_MS: '15000', SINGULARITY_FLOW_CLONE_CLAIM_RETRY_DELAY_MS: '100' }, statusLevel: 'readiness' }));
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  assert.ok(claims > 1, 'the native Windows working-directory handle prevented the first move');
  assert.equal(result.repaired[0].status, 'cloned');
});
