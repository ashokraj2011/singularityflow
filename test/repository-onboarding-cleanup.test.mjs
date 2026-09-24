import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { CONFIGURATION_BRANCH, ensureConfigurationBranch } from '../src/configuration-branch.mjs';
import {
  drainRepositoryOnboardingCleanup, enqueueRepositoryOnboardingCleanup,
  repositoryOnboardingCleanupContention
} from '../src/repository-onboarding-cleanup.mjs';
import {
  applyRepositoryOnboarding, inspectRepositoryOnboarding
} from '../src/repository-onboarding.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';
import { run } from '../src/util.mjs';

// A successful cleanup-path apply also registers a lead. Never let fixture repositories enter
// the operator's machine-local registry when this suite runs on a developer laptop.
const originalLeadRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
let suiteLeadRegistryRoot;
before(async () => {
  suiteLeadRegistryRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-cleanup-test-leads-'));
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(suiteLeadRegistryRoot, 'leads.json');
});
after(async () => {
  if (originalLeadRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = originalLeadRegistry;
  if (suiteLeadRegistryRoot) await rm(suiteLeadRegistryRoot, { recursive: true, force: true });
});

test('cleanup fixtures use a suite-local lead registry', () => {
  assert.equal(process.env.SINGULARITY_FLOW_LEAD_REGISTRY,
    path.join(suiteLeadRegistryRoot, 'leads.json'));
  assert.notEqual(process.env.SINGULARITY_FLOW_LEAD_REGISTRY,
    path.join(os.homedir(), '.singularity-flow', 'leads.json'));
});

const capability = {
  capabilityId: 'application', capabilityName: 'Application', kind: 'delivery',
  repositoryId: 'application', jiraProject: null, teams: []
};

function cleanupQueueFixture(fixture) {
  const queue = path.join(fixture.base, 'deferred-cleanup');
  return { queue };
}

function cleanupRecordName(target) {
  return `${createHash('sha256').update(target).digest('hex')}.json`;
}

async function writeCleanupRecord(queue, target, values = {}) {
  await mkdir(queue, { recursive: true });
  const record = path.join(queue, cleanupRecordName(target));
  await writeFile(record, `${JSON.stringify({
    schemaVersion: values.schemaVersion ?? 1,
    path: path.resolve(target),
    createdAt: values.createdAt ?? new Date().toISOString(),
    attempts: values.attempts ?? 0,
    nextAttemptAt: values.nextAttemptAt ?? null
  }, null, 2)}\n`);
  return record;
}

function snapshotCleanupFailure(originalRm, {
  prefix, targetIndex = 1, code = 'EBUSY', once = false
}) {
  const targets = [];
  let failures = 0;
  return {
    get target() { return targets[targetIndex] ?? null; },
    get failures() { return failures; },
    rm: async (target, options) => {
      if (path.basename(String(target)).startsWith(prefix)) {
        let index = targets.indexOf(String(target));
        if (index < 0) {
          targets.push(String(target));
          index = targets.length - 1;
        }
        if (index === targetIndex && (!once || failures === 0)) {
          failures += 1;
          const error = new Error(`${code === 'EMFILE' ? 'too many open files' : 'resource busy or locked'}, rmdir '${target}'`);
          error.code = code;
          if (code === 'EBUSY') {
            error.errno = -4082;
            error.syscall = 'rmdir';
            error.path = String(target);
          }
          throw error;
        }
      }
      return originalRm(target, options);
    }
  };
}

test('plan identity excludes only the dedicated local-cleanup diagnostic field', async () => {
  const source = await readFile(new URL('../src/repository-onboarding.mjs', import.meta.url), 'utf8');
  assert.match(source, /delete identity\.localCleanupWarnings\b/u,
    'cleanup diagnostics must not stale an otherwise identical ref-bound plan');
  assert.doesNotMatch(source, /delete identity\.warnings\b/u,
    'a generic warning field could later contain authority or policy evidence and must stay hashed');
});

test('POSIX EPERM is not treated as Windows path contention', {
  skip: process.platform === 'win32' ? 'This assertion covers POSIX cleanup semantics.' : false
}, () => {
  const error = new Error('operation not permitted');
  error.code = 'EPERM';
  assert.equal(repositoryOnboardingCleanupContention(error), false,
    'a real POSIX permission failure must remain fatal instead of being queued as a Windows lock');
});

test('enqueue atomically replaces a symlink record without changing its target', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-cleanup-record-safety-'));
  const queue = path.join(base, 'queue');
  const victim = path.join(base, 'user-owned.txt');
  const owned = await mkdtemp(path.join(os.tmpdir(), 'sflow-configuration-classifier-'));
  await mkdir(queue);
  await writeFile(victim, 'user-owned content\n');
  await chmod(victim, 0o640);
  const before = await stat(victim);
  const record = path.join(queue, cleanupRecordName(owned));
  try {
    await symlink(victim, record);
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('This host does not permit creation of a test file symlink.');
      await rm(base, { recursive: true, force: true });
      await rm(owned, { recursive: true, force: true });
      return;
    }
    throw error;
  }

  try {
    assert.equal(await enqueueRepositoryOnboardingCleanup(owned, { root: queue }), true);
    const published = await lstat(record);
    assert.equal(published.isFile(), true);
    assert.equal(published.isSymbolicLink(), false,
      'the atomic publication must replace the queue entry rather than follow its old symlink');
    assert.equal(await readFile(victim, 'utf8'), 'user-owned content\n');
    const after = await stat(victim);
    if (process.platform !== 'win32') {
      assert.equal(after.mode & 0o777, before.mode & 0o777,
        'publishing the private record must not chmod the former symlink target');
    }
    assert.equal(JSON.parse(await readFile(record, 'utf8')).path, path.resolve(owned));
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(owned, { recursive: true, force: true });
  }
});

test('an injected queue root with a symlinked ancestor is refused', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-cleanup-ancestor-safety-'));
  const actualParent = path.join(base, 'actual-parent');
  const nested = path.join(actualParent, 'nested');
  const linkedParent = path.join(base, 'linked-parent');
  const queue = path.join(linkedParent, 'nested', 'queue');
  const owned = await mkdtemp(path.join(os.tmpdir(), 'sflow-state-classifier-'));
  await mkdir(nested, { recursive: true });
  try {
    await symlink(actualParent, linkedParent, 'dir');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('This host does not permit creation of a test directory symlink.');
      await rm(base, { recursive: true, force: true });
      await rm(owned, { recursive: true, force: true });
      return;
    }
    throw error;
  }

  try {
    await assert.rejects(enqueueRepositoryOnboardingCleanup(owned, { root: queue }), {
      code: 'REPOSITORY_ONBOARDING_CLEANUP_STORAGE_UNSAFE'
    });
    assert.ok((await lstat(owned)).isDirectory(),
      'refusing unsafe queue storage must not delete the pending snapshot');
    await assert.rejects(lstat(path.join(nested, 'queue')), { code: 'ENOENT' },
      'an injected symlink ancestor must be refused before creating storage through it');
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(owned, { recursive: true, force: true });
  }
});

test('a future-schema cleanup record is retained without touching its snapshot', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-cleanup-future-record-'));
  const queue = path.join(base, 'queue');
  const owned = await mkdtemp(path.join(os.tmpdir(), 'sflow-state-classifier-'));
  const record = await writeCleanupRecord(queue, owned, { schemaVersion: 999 });

  try {
    const result = await drainRepositoryOnboardingCleanup({ root: queue });
    assert.equal(result.removed, 0);
    assert.equal(result.retained, 1,
      'a newer writer remains visible for a future compatible binary');
    assert.ok((await lstat(record)).isFile(), 'the future-schema record must stay on disk');
    assert.ok((await lstat(owned)).isDirectory(),
      'an unreadable future record cannot authorize deletion of its named path');
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(owned, { recursive: true, force: true });
  }
});

test('drain accounts for a deleted snapshot and a stale missing target', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-cleanup-accounting-'));
  const queue = path.join(base, 'queue');
  const owned = await mkdtemp(path.join(os.tmpdir(), 'sflow-state-classifier-'));
  const missing = await mkdtemp(path.join(os.tmpdir(), 'sflow-state-classifier-'));
  await rm(missing, { recursive: true, force: true });
  const ownedRecord = await writeCleanupRecord(queue, owned);
  const missingRecord = await writeCleanupRecord(queue, missing);

  try {
    const result = await drainRepositoryOnboardingCleanup({ root: queue, limit: 4 });
    assert.equal(result.processed, 2);
    assert.equal(result.removed, 1);
    assert.equal(result.retained, 0);
    await assert.rejects(lstat(owned), { code: 'ENOENT' });
    await assert.rejects(lstat(ownedRecord), { code: 'ENOENT' });
    await assert.rejects(lstat(missingRecord), { code: 'ENOENT' });
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(owned, { recursive: true, force: true });
  }
});

async function configuredRepositoryFixture({ initializeConfiguration = true } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-onboarding-cleanup-'));
  const source = path.join(base, 'source');
  const remote = path.join(base, 'application.git');
  await mkdir(source);
  run('git', ['init', '-q', '-b', 'main'], { cwd: source });
  run('git', ['config', 'user.name', 'Cleanup Tester'], { cwd: source });
  run('git', ['config', 'user.email', 'cleanup@example.invalid'], { cwd: source });
  await writeFile(path.join(source, 'README.md'), '# application\n');
  run('git', ['add', 'README.md'], { cwd: source });
  run('git', ['commit', '-qm', 'Initial application'], { cwd: source });
  run('git', ['clone', '-q', '--bare', '--no-hardlinks', source, remote], { cwd: base });
  run('git', ['config', 'receive.autogc', 'false'], { cwd: remote });
  if (initializeConfiguration) await ensureConfigurationBranch(remote, { capability });
  return { base, remote };
}

async function publishUnrecognizedState(fixture) {
  const publisher = path.join(fixture.base, 'state-publisher');
  run('git', ['clone', '-q', '--no-hardlinks', fixture.remote, publisher], { cwd: fixture.base });
  run('git', ['config', 'user.name', 'State Tester'], { cwd: publisher });
  run('git', ['config', 'user.email', 'state@example.invalid'], { cwd: publisher });
  run('git', ['checkout', '-qb', 'state'], { cwd: publisher });
  await writeFile(path.join(publisher, 'unrecognized-state.txt'), 'not an SFlow marker\n');
  run('git', ['add', 'unrecognized-state.txt'], { cwd: publisher });
  run('git', ['commit', '-qm', 'Publish unrelated state'], { cwd: publisher });
  run('git', ['push', '-q', 'origin', 'state'], { cwd: publisher });
}

test('a retained cleanup backlog uses neutral stale-cleanup wording', async () => {
  const fixture = await configuredRepositoryFixture();
  const { queue } = cleanupQueueFixture(fixture);
  const owned = await mkdtemp(path.join(os.tmpdir(), 'sflow-configuration-classifier-'));
  await enqueueRepositoryOnboardingCleanup(owned, { root: queue });
  const originalRm = fs.promises.rm;
  fs.promises.rm = async (target, options) => {
    if (path.resolve(String(target)) === path.resolve(owned)) {
      const error = new Error(`resource busy or locked, rmdir '${target}'`);
      error.code = 'EBUSY';
      throw error;
    }
    return originalRm(target, options);
  };
  syncBuiltinESMExports();

  try {
    const plan = await inspectRepositoryOnboarding(fixture.remote, { cleanupQueueRoot: queue });
    assert.ok(plan.localCleanupWarnings.includes(
      'Previous repository-inspection cleanup is still pending; SFlow will retry that machine-local cleanup without changing repository authority.'
    ));
    assert.doesNotMatch(plan.localCleanupWarnings.join('\n'),
      /decision is valid|still has .* open|locking process/iu,
      'a stale queue record cannot prove a current lock or make claims about the current decision');
  } finally {
    fs.promises.rm = originalRm;
    syncBuiltinESMExports();
    await rm(owned, { recursive: true, force: true });
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('apply reinspection uses the same explicit cleanup queue as preview', async () => {
  const fixture = await configuredRepositoryFixture();
  const { queue } = cleanupQueueFixture(fixture);
  const preview = await inspectRepositoryOnboarding(fixture.remote, { cleanupQueueRoot: queue });
  const deferred = path.join(os.tmpdir(), 'sflow-state-classifier-PINNED');
  await writeCleanupRecord(queue, deferred, { nextAttemptAt: '2099-01-01T00:00:00.000Z' });

  try {
    await assert.rejects(applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: `sha256:${'d'.repeat(64)}`,
      cleanupQueueRoot: queue
    }), (error) => {
      assert.equal(error.code, 'REPOSITORY_ONBOARDING_CONFIRMATION_MISMATCH');
      assert.equal(error.details?.refreshedPlan?.planId, preview.planId);
      assert.ok(error.details?.refreshedPlan?.localCleanupWarnings?.some((warning) =>
        /Previous repository-inspection cleanup is still pending/u.test(warning)),
      'the apply-time reinspection must drain/report the same preview-scoped queue');
      return true;
    });
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('a locked survey is queued and stops before allocating an admitted snapshot', async () => {
  const fixture = await configuredRepositoryFixture();
  const { queue } = cleanupQueueFixture(fixture);
  const originalRm = fs.promises.rm;
  const injection = snapshotCleanupFailure(originalRm, {
    prefix: 'sflow-configuration-classifier-', targetIndex: 0
  });
  let clones = 0;
  fs.promises.rm = injection.rm;
  syncBuiltinESMExports();

  try {
    await assert.rejects(inspectRepositoryOnboarding(fixture.remote, {
      cleanupQueueRoot: queue,
      runRemoteCommand: async (args, options) => {
        if (args.includes('clone')) clones += 1;
        return runRemoteGitAsync(args, options);
      }
    }), (error) => {
      assert.equal(error.code, 'REPOSITORY_ONBOARDING_SNAPSHOT_UNAVAILABLE');
      assert.equal(error.details?.cleanup?.code, 'EBUSY');
      return true;
    });
    assert.equal(clones, 1, 'a locked blobless survey must stop before another clone');
    assert.ok(injection.target);
    assert.ok((await lstat(injection.target)).isDirectory());
    assert.ok((await lstat(path.join(queue, cleanupRecordName(injection.target)))).isFile(),
      'the exact locked survey must be queued for later cleanup');
  } finally {
    fs.promises.rm = originalRm;
    syncBuiltinESMExports();
    if (injection.target) await rm(injection.target, { recursive: true, force: true });
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('a full cleanup backlog never replaces a successful repository inspection', async () => {
  const fixture = await configuredRepositoryFixture();
  const { queue } = cleanupQueueFixture(fixture);
  const control = await inspectRepositoryOnboarding(fixture.remote, { cleanupQueueRoot: queue });
  for (let index = 0; index < 128; index += 1) {
    const suffix = index.toString(36).padStart(6, '0');
    const deferred = path.join(os.tmpdir(), `sflow-state-classifier-${suffix}`);
    await writeCleanupRecord(queue, deferred, { nextAttemptAt: '2099-01-01T00:00:00.000Z' });
  }
  const originalRm = fs.promises.rm;
  const injection = snapshotCleanupFailure(originalRm, {
    prefix: 'sflow-configuration-classifier-'
  });
  fs.promises.rm = injection.rm;
  syncBuiltinESMExports();

  try {
    const plan = await inspectRepositoryOnboarding(fixture.remote, { cleanupQueueRoot: queue });
    assert.equal(plan.status, 'ready');
    assert.equal(plan.planId, control.planId,
      'queue capacity is machine-local diagnostics and cannot replace the ref-bound decision');
    assert.ok(plan.localCleanupWarnings.some((warning) => /cleanup could not be queued/u.test(warning)));
    assert.ok((await lstat(injection.target)).isDirectory());
  } finally {
    fs.promises.rm = originalRm;
    syncBuiltinESMExports();
    if (injection.target) await rm(injection.target, { recursive: true, force: true });
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('configuration classification survives transient EBUSY through retry or deferred cleanup',
  async () => {
    const fixture = await configuredRepositoryFixture();
    const { queue } = cleanupQueueFixture(fixture);
    const control = await inspectRepositoryOnboarding(fixture.remote, { cleanupQueueRoot: queue });
    const originalRm = fs.promises.rm;
    const injection = snapshotCleanupFailure(originalRm, {
      prefix: 'sflow-configuration-classifier-', once: true
    });
    fs.promises.rm = injection.rm;
    syncBuiltinESMExports();

    try {
      const plan = await inspectRepositoryOnboarding(fixture.remote, { cleanupQueueRoot: queue });
      assert.equal(injection.failures, 1, 'the final classifier cleanup must reach the injected lock');
      assert.equal(plan.configuration.branch, CONFIGURATION_BRANCH);
      assert.equal(plan.configuration.status, 'current');
      assert.equal(plan.status, 'ready');
      assert.equal(plan.canApply, true);
      assert.equal(plan.planId, control.planId,
        'a cleanup retry cannot change the content-addressed onboarding decision');
      const deferred = await lstat(injection.target).then(() => true).catch((error) => {
        if (error?.code === 'ENOENT') return false;
        throw error;
      });
      if (deferred) {
        assert.equal(plan.localCleanupWarnings.length, 1,
          'a platform with one foreground attempt must report its queued cleanup');
        fs.promises.rm = originalRm;
        syncBuiltinESMExports();
        const repeated = await inspectRepositoryOnboarding(fixture.remote, {
          cleanupQueueRoot: queue
        });
        assert.equal(repeated.planId, control.planId);
        await assert.rejects(lstat(injection.target), { code: 'ENOENT' },
          'the next inspection must drain a transiently queued classifier checkout');
      } else {
        assert.deepEqual(plan.localCleanupWarnings, [],
          'an in-budget retry needs no deferred-cleanup diagnostic');
      }
    } finally {
      fs.promises.rm = originalRm;
      syncBuiltinESMExports();
      if (injection.target) await rm(injection.target, { recursive: true, force: true });
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

test('an exhausted Windows cleanup lock becomes a non-authoritative warning', async () => {
  const fixture = await configuredRepositoryFixture();
  const { queue } = cleanupQueueFixture(fixture);
  const control = await inspectRepositoryOnboarding(fixture.remote, { cleanupQueueRoot: queue });
  const originalRm = fs.promises.rm;
  const injection = snapshotCleanupFailure(originalRm, {
    prefix: 'sflow-configuration-classifier-'
  });
  fs.promises.rm = injection.rm;
  syncBuiltinESMExports();

  try {
    const plan = await inspectRepositoryOnboarding(fixture.remote, { cleanupQueueRoot: queue });
    assert.equal(plan.status, 'ready');
    assert.equal(plan.canApply, true);
    assert.equal(plan.planId, control.planId,
      'local cleanup diagnostics must not change the ref-bound authority decision');
    assert.equal(plan.localCleanupWarnings.length, 1);
    assert.match(plan.localCleanupWarnings[0], /disposable snapshot open/u);
    assert.ok((await lstat(injection.target)).isDirectory(),
      'the warning must disclose a real deferred cleanup rather than claim deletion');

    fs.promises.rm = originalRm;
    syncBuiltinESMExports();
    const repeated = await inspectRepositoryOnboarding(fixture.remote, { cleanupQueueRoot: queue });
    assert.equal(repeated.planId, control.planId);
    assert.deepEqual(repeated.localCleanupWarnings, []);
    await assert.rejects(lstat(injection.target), { code: 'ENOENT' },
      'the next inspection must drain the exact queued SFlow snapshot after the lock clears');
    assert.deepEqual(await readdir(queue), [],
      'a successfully drained queue must not retain a stale recovery record');
  } finally {
    fs.promises.rm = originalRm;
    syncBuiltinESMExports();
    if (injection.target) await rm(injection.target, { recursive: true, force: true });
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('state classification also survives an exhausted Windows cleanup lock', async () => {
  const fixture = await configuredRepositoryFixture();
  const { queue } = cleanupQueueFixture(fixture);
  await publishUnrecognizedState(fixture);
  const control = await inspectRepositoryOnboarding(fixture.remote, { cleanupQueueRoot: queue });
  const originalRm = fs.promises.rm;
  const injection = snapshotCleanupFailure(originalRm, {
    prefix: 'sflow-state-classifier-'
  });
  fs.promises.rm = injection.rm;
  syncBuiltinESMExports();

  try {
    const plan = await inspectRepositoryOnboarding(fixture.remote, { cleanupQueueRoot: queue });
    assert.equal(plan.state.kind, 'invalid');
    assert.equal(plan.planId, control.planId);
    assert.equal(plan.localCleanupWarnings.length, 1);
    assert.ok((await lstat(injection.target)).isDirectory());
  } finally {
    fs.promises.rm = originalRm;
    syncBuiltinESMExports();
    if (injection.target) await rm(injection.target, { recursive: true, force: true });
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('the deferred-cleanup queue discards an unowned path without deleting user data', async () => {
  const fixture = await configuredRepositoryFixture();
  const { queue } = cleanupQueueFixture(fixture);
  const unowned = path.join(fixture.base, 'user-owned-directory');
  const sentinel = path.join(unowned, 'keep.txt');
  await mkdir(queue, { recursive: true });
  await mkdir(unowned);
  await writeFile(sentinel, 'preserve me\n');
  const record = path.join(queue, cleanupRecordName(unowned));
  await writeFile(record, `${JSON.stringify({
    schemaVersion: 1,
    path: unowned,
    createdAt: new Date().toISOString()
  })}\n`);

  try {
    const plan = await inspectRepositoryOnboarding(fixture.remote, { cleanupQueueRoot: queue });
    assert.equal(plan.status, 'ready');
    assert.ok((await lstat(unowned)).isDirectory(),
      'a queue record cannot expand cleanup beyond SFlow-owned temporary snapshots');
    assert.ok((await lstat(sentinel)).isFile());
    await assert.rejects(lstat(record), { code: 'ENOENT' },
      'the invalid queue record must be discarded instead of retried forever');
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('resource exhaustion during cleanup remains fatal instead of becoming an EBUSY warning',
  async () => {
    const fixture = await configuredRepositoryFixture();
    const { queue } = cleanupQueueFixture(fixture);
    const originalRm = fs.promises.rm;
    const injection = snapshotCleanupFailure(originalRm, {
      prefix: 'sflow-configuration-classifier-', code: 'EMFILE'
    });
    fs.promises.rm = injection.rm;
    syncBuiltinESMExports();

    try {
      await assert.rejects(inspectRepositoryOnboarding(fixture.remote, {
        cleanupQueueRoot: queue
      }), (error) => {
        assert.equal(error.code, 'EMFILE');
        return true;
      });
      assert.deepEqual(await readdir(queue).catch((error) => {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }), [], 'resource exhaustion must not be queued as path contention');
    } finally {
      fs.promises.rm = originalRm;
      syncBuiltinESMExports();
      if (injection.target) await rm(injection.target, { recursive: true, force: true });
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

test('cleanup contention never replaces the original typed Git failure', async () => {
  const fixture = await configuredRepositoryFixture();
  const { queue } = cleanupQueueFixture(fixture);
  const originalRm = fs.promises.rm;
  let classifierScratch = null;
  fs.promises.rm = async (target, options) => {
    if (path.basename(String(target)).startsWith('sflow-configuration-classifier-')) {
      classifierScratch = String(target);
      const error = new Error(`resource busy or locked, rmdir '${target}'`);
      error.code = 'EBUSY';
      throw error;
    }
    return originalRm(target, options);
  };
  syncBuiltinESMExports();

  try {
    await assert.rejects(inspectRepositoryOnboarding(fixture.remote, {
      cleanupQueueRoot: queue,
      runRemoteCommand: async (args, options) => args.includes('clone')
        ? {
            status: 1,
            failure: {
              code: 'REMOTE_AUTH', classification: 'auth', retryable: false,
              advice: 'Use the approved credential helper.'
            }
          }
        : runRemoteGitAsync(args, options)
    }), (error) => {
      assert.equal(error.code, 'REMOTE_AUTH');
      assert.doesNotMatch(error.message, /resource busy|EBUSY/iu);
      assert.deepEqual(error.details?.cleanup, { completed: false, code: 'EBUSY' });
      return true;
    });
  } finally {
    fs.promises.rm = originalRm;
    syncBuiltinESMExports();
    if (classifierScratch) await rm(classifierScratch, { recursive: true, force: true });
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('post-publication candidate EBUSY preserves the review result and queues cleanup', async () => {
  const fixture = await configuredRepositoryFixture({ initializeConfiguration: false });
  const { queue } = cleanupQueueFixture(fixture);
  const preview = await inspectRepositoryOnboarding(fixture.remote, { cleanupQueueRoot: queue });
  assert.equal(preview.status, 'not-set-up');
  const originalRm = fs.promises.rm;
  let candidate = null;
  fs.promises.rm = async (target, options) => {
    if (path.basename(String(target)).startsWith('sflow-onboarding-candidate-')) {
      candidate = String(target);
      const error = new Error(`resource busy or locked, rmdir '${target}'`);
      error.code = 'EBUSY';
      throw error;
    }
    return originalRm(target, options);
  };
  syncBuiltinESMExports();

  try {
    const result = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: preview.planId, cleanupQueueRoot: queue
    });
    assert.equal(result.status, 'configuration-review-required');
    assert.equal(result.changed, true);
    assert.equal(result.proposal.published, true);
    assert.ok(result.localCleanupWarnings.some((warning) =>
      /Repository setup completed[\s\S]*queued cleanup/u.test(warning)));
    assert.ok(candidate, 'the apply must reach candidate cleanup after publication');
    assert.equal(run('git', [
      'rev-parse', `refs/heads/${result.proposal.branch}`
    ], { cwd: fixture.remote }).stdout.trim(), result.proposal.commit,
    'cleanup contention must not hide the exact proposal that was already published');
    assert.ok((await lstat(path.join(queue, cleanupRecordName(candidate)))).isFile(),
      'the exact locked candidate must be durably queued');
  } finally {
    fs.promises.rm = originalRm;
    syncBuiltinESMExports();
    if (candidate) await rm(candidate, { recursive: true, force: true });
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('proposal checkout EBUSY preserves an already-published recreate proposal', async () => {
  const fixture = await configuredRepositoryFixture();
  const { queue } = cleanupQueueFixture(fixture);
  const preview = await inspectRepositoryOnboarding(fixture.remote, {
    mode: 'recreate', cleanupQueueRoot: queue
  });
  assert.equal(preview.canApply, true);
  const originalRm = fs.promises.rm;
  const injection = snapshotCleanupFailure(originalRm, {
    prefix: 'sflow-onboarding-proposal-'
  });
  fs.promises.rm = injection.rm;
  syncBuiltinESMExports();

  try {
    const result = await applyRepositoryOnboarding(fixture.remote, {
      mode: 'recreate', confirmPlan: preview.planId, cleanupQueueRoot: queue
    });
    assert.equal(result.status, 'configuration-review-required');
    assert.equal(result.proposal.published, true);
    assert.ok(result.localCleanupWarnings.some((warning) =>
      /Repository setup completed[\s\S]*queued cleanup/u.test(warning)));
    assert.ok(injection.target, 'the apply must reach proposal-checkout cleanup after publication');
    assert.equal(run('git', [
      'rev-parse', `refs/heads/${result.proposal.branch}`
    ], { cwd: fixture.remote }).stdout.trim(), result.proposal.commit);
    assert.ok((await lstat(path.join(queue, cleanupRecordName(injection.target)))).isFile());
  } finally {
    fs.promises.rm = originalRm;
    syncBuiltinESMExports();
    if (injection.target) await rm(injection.target, { recursive: true, force: true });
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('candidate build failure remains primary when candidate cleanup is EBUSY', async () => {
  const fixture = await configuredRepositoryFixture({ initializeConfiguration: false });
  const { queue } = cleanupQueueFixture(fixture);
  const preview = await inspectRepositoryOnboarding(fixture.remote, { cleanupQueueRoot: queue });
  const originalRm = fs.promises.rm;
  const originalWriteFile = fs.promises.writeFile;
  let candidate = null;
  fs.promises.writeFile = async (target, data, options) => {
    if (String(target).includes(`${path.sep}sflow-onboarding-candidate-`)
        && String(target).endsWith(path.join(
          'singularity', '.product', 'configuration-recovery.json'
        ))) {
      const error = new Error('synthetic candidate receipt write failure');
      error.code = 'SYNTHETIC_CANDIDATE_BUILD_FAILURE';
      throw error;
    }
    return originalWriteFile(target, data, options);
  };
  fs.promises.rm = async (target, options) => {
    if (path.basename(String(target)).startsWith('sflow-onboarding-candidate-')) {
      candidate = String(target);
      const error = new Error(`resource busy or locked, rmdir '${target}'`);
      error.code = 'EBUSY';
      throw error;
    }
    return originalRm(target, options);
  };
  syncBuiltinESMExports();

  try {
    await assert.rejects(applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: preview.planId, cleanupQueueRoot: queue
    }), (error) => {
      assert.equal(error.code, 'SYNTHETIC_CANDIDATE_BUILD_FAILURE');
      assert.equal(error.message, 'synthetic candidate receipt write failure');
      assert.deepEqual(error.details?.cleanup, { completed: false, code: 'EBUSY' });
      assert.doesNotMatch(error.message, /resource busy|EBUSY/iu);
      return true;
    });
    assert.ok(candidate, 'candidate cleanup must be attempted after the build failure');
    assert.ok((await lstat(path.join(queue, cleanupRecordName(candidate)))).isFile(),
      'the cleanup failure must still be recoverable without replacing the primary error');
  } finally {
    fs.promises.writeFile = originalWriteFile;
    fs.promises.rm = originalRm;
    syncBuiltinESMExports();
    if (candidate) await rm(candidate, { recursive: true, force: true });
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('read-only primary error details cannot be masked by cleanup failure evidence', async () => {
  const fixture = await configuredRepositoryFixture({ initializeConfiguration: false });
  const { queue } = cleanupQueueFixture(fixture);
  const preview = await inspectRepositoryOnboarding(fixture.remote, { cleanupQueueRoot: queue });
  const originalRm = fs.promises.rm;
  const originalWriteFile = fs.promises.writeFile;
  const originalDetails = Object.freeze({ source: 'candidate-build' });
  let candidate = null;
  fs.promises.writeFile = async (target, data, options) => {
    if (String(target).includes(`${path.sep}sflow-onboarding-candidate-`)
        && String(target).endsWith(path.join(
          'singularity', '.product', 'configuration-recovery.json'
        ))) {
      const error = new Error('read-only primary failure');
      error.code = 'READ_ONLY_PRIMARY_FAILURE';
      Object.defineProperty(error, 'details', {
        value: originalDetails, writable: false, configurable: false, enumerable: true
      });
      throw error;
    }
    return originalWriteFile(target, data, options);
  };
  fs.promises.rm = async (target, options) => {
    if (path.basename(String(target)).startsWith('sflow-onboarding-candidate-')) {
      candidate = String(target);
      const error = new Error(`resource busy or locked, rmdir '${target}'`);
      error.code = 'EBUSY';
      throw error;
    }
    return originalRm(target, options);
  };
  syncBuiltinESMExports();

  try {
    await assert.rejects(applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: preview.planId, cleanupQueueRoot: queue
    }), (error) => {
      assert.equal(error.code, 'READ_ONLY_PRIMARY_FAILURE');
      assert.equal(error.message, 'read-only primary failure');
      assert.equal(error.details, originalDetails);
      return true;
    });
    assert.ok(candidate, 'candidate cleanup must still be attempted');
    assert.ok((await lstat(path.join(queue, cleanupRecordName(candidate)))).isFile(),
      'the locked candidate remains queued without replacing the primary failure');
  } finally {
    fs.promises.writeFile = originalWriteFile;
    fs.promises.rm = originalRm;
    syncBuiltinESMExports();
    if (candidate) await rm(candidate, { recursive: true, force: true });
    await rm(fixture.base, { recursive: true, force: true });
  }
});
