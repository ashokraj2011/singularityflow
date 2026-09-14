import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';
import {
  acquireSubjectLock,
  activeSubjectLocks,
  assertRepositoryResetAvailable,
  currentSubjectLockOwner,
  releaseSubjectLock,
  repositoryResetBarrierPath,
  subjectLockPath,
  withRepositoryMutationLease,
  withRepositoryResetBarrier,
  withSubjectLock
} from '../src/subject-lock.mjs';
import { SnapshotCoordinator } from '../src/snapshot-coordinator.mjs';
import { StoryStateStore } from '../src/state-stores.mjs';
import { inspectStatePlanes, reconcileStateProjections } from '../src/state-planes.mjs';
import { evaluateSequence, applySequenceDecision, assertPhaseSequence, withConfirmationPort } from '../src/sequence.mjs';
import { loadDefinition } from '../src/config.mjs';
import { bindLifecycleEvent, lifecycleEvent, recordPublicationProjection } from '../src/lifecycle-event.mjs';
import { canonicalJson, createLedgerIntent, ledgerIdempotencyKey } from '../src/ledger.mjs';
import { saveWorkflow, workDir } from '../src/state.mjs';
import {
  findLegacyPendingPublications, localPendingPublicationPath, readPendingPublication
} from '../src/publication-pending.mjs';
import { GitPublicationUnitOfWork } from '../src/publication-unit-of-work.mjs';
import { assignPhase } from '../src/collaboration.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    // Repository snapshots intentionally carry the complete multi-surface read model. Keep this
    // harness above Node's 1 MiB default, matching the bounded extension client instead of killing
    // a valid snapshot with ENOBUFS as the catalog grows.
    maxBuffer: 40 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Kernel Tester',
      SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'developer' })
    }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-kernel-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Kernel Tester'], root);
  run('git', ['config', 'user.email', 'kernel@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Kernel test\n');
  run(process.execPath, [bin, 'init'], root);
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(workflowPath, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(workflowPath, YAML.stringify(definition));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  const remote = `${root}.git`;
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  run(process.execPath, [bin, 'start', 'KERNEL-1', '--from-branch', 'main', '--ref', 'KERNEL-1', '--title', 'Kernel'], root);
  return root;
}

test('subject locks are process-owned and reject a concurrent local mutation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-lock-'));
  run('git', ['init', '-b', 'main'], root);
  const subject = { kind: 'story', id: 'LOCK-1' };
  const owner = await acquireSubjectLock(root, subject);
  await assert.rejects(() => acquireSubjectLock(root, subject), /locked by PID/i);
  assert.equal(await releaseSubjectLock(root, subject, owner), true);
  const next = await acquireSubjectLock(root, subject);
  assert.equal(await releaseSubjectLock(root, subject, next), true);
});

test('stale subject locks are recovered after a crashed owner', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-stale-lock-'));
  run('git', ['init', '-b', 'main'], root);
  const subject = { kind: 'initiative', id: 'CRASHED-1' };
  const directory = subjectLockPath(root, subject);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'owner.json'), `${JSON.stringify({
    schemaVersion: 1,
    subject,
    pid: 99999999,
    host: os.hostname(),
    processToken: 'dead',
    lockToken: 'dead',
    acquiredAt: '2000-01-01T00:00:00.000Z'
  })}\n`);
  const owner = await acquireSubjectLock(root, subject, { ttlMs: 1 });
  assert.equal(await releaseSubjectLock(root, subject, owner), true);
});

test('a delayed acquirer cannot publish into a successor lock generation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-lock-generation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  const subject = { kind: 'story', id: 'GENERATION-1' };
  let entered;
  const paused = new Promise((resolve) => { entered = resolve; });
  let resume;
  const resumed = new Promise((resolve) => { resume = resolve; });
  let pauseOnce = true;
  const delayed = acquireSubjectLock(root, subject, {
    ownerLink: async () => {
      const error = new Error('hard links unavailable during delayed publication');
      error.code = 'ENOTSUP';
      throw error;
    },
    hooks: {
      afterDirectoryCreated: async ({ directory }) => {
        if (!pauseOnce) return;
        pauseOnce = false;
        const old = new Date(Date.now() - 10 * 60 * 1000);
        await utimes(directory, old, old);
        entered();
        await resumed;
      }
    }
  });
  await paused;

  const successor = await acquireSubjectLock(root, subject);
  const successorOwner = JSON.parse(await readFile(
    path.join(subjectLockPath(root, subject), 'owner.json'), 'utf8'
  ));
  resume();
  await assert.rejects(delayed, (error) => error?.code === 'SUBJECT_LOCK_BUSY');
  const stillOwned = JSON.parse(await readFile(
    path.join(subjectLockPath(root, subject), 'owner.json'), 'utf8'
  ));
  assert.equal(stillOwned.lockToken, successorOwner.lockToken,
    'the resumed acquirer did not overwrite the successor owner');
  assert.equal(await releaseSubjectLock(root, subject, successor), true);
});

test('release retires only the directory generation it observed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-lock-release-generation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  const subject = { kind: 'story', id: 'GENERATION-2' };
  const directory = subjectLockPath(root, subject);
  const first = await acquireSubjectLock(root, subject);
  let entered;
  const paused = new Promise((resolve) => { entered = resolve; });
  let resume;
  const resumed = new Promise((resolve) => { resume = resolve; });
  const releasing = releaseSubjectLock(root, subject, first, {
    hooks: {
      beforeRetire: async () => {
        entered();
        await resumed;
      }
    }
  });
  await paused;

  const displaced = `${directory}.displaced`;
  await rename(directory, displaced);
  const successor = await acquireSubjectLock(root, subject);
  resume();
  assert.equal(await releasing, false,
    'a release whose observed generation moved must not remove its successor');
  assert.equal(await releaseSubjectLock(root, subject, successor), true);
  await rm(displaced, { recursive: true, force: true });
});

test('release restores a successor replaced after its final retirement revalidation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-lock-release-syscall-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  const subject = { kind: 'story', id: 'GENERATION-3' };
  const directory = subjectLockPath(root, subject);
  const first = await acquireSubjectLock(root, subject);
  let successor;
  let preservedSuccessor;
  const displaced = `${directory}.displaced`;

  const released = await releaseSubjectLock(root, subject, first, {
    hooks: {
      afterRetireRevalidation: async ({ destination }) => {
        preservedSuccessor = destination;
        await rename(directory, displaced);
        successor = await acquireSubjectLock(root, subject);
      }
    }
  });

  assert.equal(released, false,
    'a release must report that the directory generation changed in the rename window');
  const owner = JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8'));
  assert.equal(owner.lockToken, successor.lockToken,
    'the successor owner is restored at the public lock pathname');
  const preservedOwner = JSON.parse(await readFile(
    path.join(preservedSuccessor, 'owner.json'), 'utf8'
  ));
  assert.equal(preservedOwner.lockToken, successor.lockToken,
    'claim cleanup must retain the exact moved successor as recovery evidence');
  await assert.rejects(() => acquireSubjectLock(root, subject), /locked by PID/i,
    'the restored successor remains an active exclusive lease');
  assert.equal(await releaseSubjectLock(root, subject, successor), true,
    'the restored successor remains normally releasable');
  await rm(displaced, { recursive: true, force: true });
});

test('heartbeat construction failure releases subject and reset-barrier locks', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-lock-heartbeat-start-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  const heartbeatFactory = () => { throw new Error('worker startup unavailable'); };
  const subject = { kind: 'story', id: 'HEARTBEAT-1' };
  let ran = false;
  await assert.rejects(() => withSubjectLock(root, subject, async () => {
    ran = true;
  }, { heartbeatFactory }), /worker startup unavailable/);
  assert.equal(ran, false);
  assert.equal(existsSync(subjectLockPath(root, subject)), false);

  await assert.rejects(() => withRepositoryResetBarrier(root, async () => {
    ran = true;
  }, { heartbeatFactory }), /worker startup unavailable/);
  assert.equal(ran, false);
  assert.equal(existsSync(repositoryResetBarrierPath(root)), false);
});

test('an asynchronous heartbeat startup failure runs no callback and releases its lock', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-lock-heartbeat-async-start-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  class StartupFailureWorker extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit('error', new Error('asynchronous worker startup failure')));
    }

    unref() {}

    async terminate() { return 1; }
  }
  const heartbeatFactory = () => new StartupFailureWorker();
  const subject = { kind: 'story', id: 'HEARTBEAT-ASYNC-START' };
  let ran = false;
  await assert.rejects(() => withSubjectLock(root, subject, async () => {
    ran = true;
  }, { heartbeatFactory }), (error) => error?.code === 'SUBJECT_LOCK_HEARTBEAT_FAILED');
  assert.equal(ran, false);
  assert.equal(existsSync(subjectLockPath(root, subject)), false);

  await assert.rejects(() => withRepositoryResetBarrier(root, async () => {
    ran = true;
  }, { heartbeatFactory }), (error) => error?.code === 'SUBJECT_LOCK_HEARTBEAT_FAILED');
  assert.equal(ran, false);
  assert.equal(existsSync(repositoryResetBarrierPath(root)), false);
});

test('heartbeat readiness keeps a short-lived CLI alive until its mutation callback starts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-lock-cli-readiness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  const result = run(process.execPath, [bin, 'init'], root);
  assert.match(result.stdout, /Created singularity\/workflow\.yml/);
  assert.equal(existsSync(path.join(root, 'singularity', 'workflow.yml')), true);
});

test('a default heartbeat keeps an unsettled mutation process alive until its lease ends', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-lock-heartbeat-reference-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  const moduleUrl = new URL('../src/subject-lock.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withSubjectLock } from ${JSON.stringify(moduleUrl)};
    await withSubjectLock(${JSON.stringify(root)}, { kind: 'story', id: 'REFERENCED' }, async () => {
      process.stdout.write('lease-entered\\n');
      await new Promise(() => {});
    });
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode == null) child.kill('SIGKILL'); });
  let output = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('child never entered its lock callback')), 5_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('lease-entered')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`child exited before its lease ended (${code})`)));
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(child.exitCode, null,
    'the shared worker remains referenced for the complete physical lease');
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
});

test('a runtime heartbeat failure keeps the live lease fail-closed and fails its outcome', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-lock-heartbeat-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  let worker;
  class ControlledWorker extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit('message', { type: 'ready' }));
    }

    unref() {}

    async terminate() { return 0; }
  }
  const subject = { kind: 'story', id: 'HEARTBEAT-RUNTIME' };
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let finish;
  const held = new Promise((resolve) => { finish = resolve; });
  const operation = withSubjectLock(root, subject, async () => {
    entered();
    await held;
  }, {
    ttlMs: 1_000,
    heartbeatFactory: () => {
      worker = new ControlledWorker();
      return worker;
    }
  });
  await started;
  worker.emit('error', new Error('heartbeat thread terminated'));
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await assert.rejects(() => acquireSubjectLock(root, subject, { ttlMs: 1 }),
    (error) => error?.code === 'SUBJECT_LOCK_BUSY');
  finish();
  await assert.rejects(operation, (error) => error?.code === 'SUBJECT_LOCK_HEARTBEAT_FAILED');
  assert.equal(existsSync(subjectLockPath(root, subject)), false);
});

test('one default heartbeat failure does not poison another lease in the shared worker', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-lock-heartbeat-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  const brokenSubject = { kind: 'story', id: 'HEARTBEAT-BROKEN' };
  const healthySubject = { kind: 'story', id: 'HEARTBEAT-HEALTHY' };
  let brokenEntered;
  let healthyEntered;
  const brokenStarted = new Promise((resolve) => { brokenEntered = resolve; });
  const healthyStarted = new Promise((resolve) => { healthyEntered = resolve; });
  let finish;
  const held = new Promise((resolve) => { finish = resolve; });
  const broken = withSubjectLock(root, brokenSubject, async (owner) => {
    brokenEntered(owner);
    await held;
  }, { ttlMs: 1_000 });
  const healthy = withSubjectLock(root, healthySubject, async () => {
    healthyEntered();
    await held;
  }, { ttlMs: 1_000 });
  const [brokenOwner] = await Promise.all([brokenStarted, healthyStarted]);
  await rm(path.join(
    subjectLockPath(root, brokenSubject), `heartbeat-${brokenOwner.lockToken}`
  ));
  await new Promise((resolve) => setTimeout(resolve, 450));
  finish();
  await assert.rejects(broken, (error) => error?.code === 'SUBJECT_LOCK_HEARTBEAT_FAILED');
  await healthy;
  assert.equal(existsSync(subjectLockPath(root, brokenSubject)), false);
  assert.equal(existsSync(subjectLockPath(root, healthySubject)), false);
});

test('detached async contexts cannot reuse a released subject lease or cross reset barrier', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-lock-detached-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  const subject = { kind: 'story', id: 'DETACHED-CONTEXT' };
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  let detached;
  let callbackRan = false;
  await withSubjectLock(root, subject, async () => {
    detached = (async () => {
      await gate;
      assert.equal(currentSubjectLockOwner(root, subject), null,
        'the async resource inherited only an invalidated frame');
      return withSubjectLock(root, subject, async () => { callbackRan = true; });
    })();
  });

  await withRepositoryResetBarrier(root, async () => {
    resume();
    await assert.rejects(detached, (error) => error?.code === 'FACTORY_RESET_IN_PROGRESS');
    assert.equal(callbackRan, false);
  });
});

test('an already-started reentrant callback keeps the outer physical lease held', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-lock-reentrant-drain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  const subject = { kind: 'story', id: 'REENTRANT-DRAIN' };
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let finish;
  const held = new Promise((resolve) => { finish = resolve; });
  let nested;
  let outerSettled = false;
  const outer = withSubjectLock(root, subject, async () => {
    nested = withSubjectLock(root, subject, async () => {
      entered();
      await held;
    });
    await started;
  });
  outer.finally(() => { outerSettled = true; }).catch(() => {});
  await started;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outerSettled, false, 'the outer call waits for the active child frame');
  assert.equal((await activeSubjectLocks(root)).length, 1);
  finish();
  await Promise.all([outer, nested]);
  assert.equal(existsSync(subjectLockPath(root, subject)), false);
});

test('owner publication falls back to exclusive create when hard links are unsupported', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-lock-owner-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  const subject = { kind: 'story', id: 'OWNER-FALLBACK' };
  let attempts = 0;
  const ownerLink = async () => {
    attempts += 1;
    const error = new Error('hard links unavailable');
    error.code = 'ENOTSUP';
    throw error;
  };
  const owner = await acquireSubjectLock(root, subject, { ownerLink });
  const published = JSON.parse(await readFile(
    path.join(subjectLockPath(root, subject), 'owner.json'), 'utf8'
  ));
  assert.equal(attempts, 1);
  assert.equal(published.lockToken, owner.lockToken);
  await assert.rejects(() => acquireSubjectLock(root, subject),
    (error) => error?.code === 'SUBJECT_LOCK_BUSY');
  assert.equal(await releaseSubjectLock(root, subject, owner), true);
});

test('repository mutation leases are unique, visible to reset, and barrier checked', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-repository-mutation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  let enteredCount = 0;
  let bothEntered;
  const entered = new Promise((resolve) => { bothEntered = resolve; });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const operation = () => withRepositoryMutationLease(root, 'same-command', async () => {
    enteredCount += 1;
    if (enteredCount === 2) bothEntered();
    await held;
  });
  const first = operation();
  const second = operation();
  let timeout;
  try {
    await Promise.race([
      entered,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('mutation leases serialized')), 2_000);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
  const locks = await activeSubjectLocks(root);
  assert.equal(locks.filter((entry) => entry.owner?.subject?.kind === 'repository-mutation').length, 2);
  release();
  await Promise.all([first, second]);

  await assertRepositoryResetAvailable(root);
  await withRepositoryResetBarrier(root, async () => {
    await assert.rejects(() => assertRepositoryResetAvailable(root),
      (error) => error?.code === 'FACTORY_RESET_IN_PROGRESS');
    let callbackRan = false;
    await assert.rejects(() => withRepositoryMutationLease(root, 'blocked-command', async () => {
      callbackRan = true;
    }), (error) => error?.code === 'FACTORY_RESET_IN_PROGRESS');
    assert.equal(callbackRan, false);
  });
});

test('active lock scan includes an old worktree-private lock root', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-private-lock-root-'));
  const linked = `${root}-linked`;
  t.after(() => Promise.all([
    rm(linked, { recursive: true, force: true }),
    rm(root, { recursive: true, force: true })
  ]));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Kernel Tester'], root);
  run('git', ['config', 'user.email', 'kernel@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# private lock root\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initial'], root);
  run('git', ['worktree', 'add', '-b', 'linked-lock-test', linked], root);
  const privateGitDirectory = run('git', ['rev-parse', '--absolute-git-dir'], linked).stdout.trim();
  const directory = path.join(
    privateGitDirectory, 'singularity-flow', 'locks', 'story--LEGACY-PRIVATE.lock'
  );
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'owner.json'), `${JSON.stringify({
    schemaVersion: 1,
    subject: { kind: 'story', id: 'LEGACY-PRIVATE' },
    pid: process.pid,
    host: os.hostname(),
    processToken: 'legacy-process',
    lockToken: 'legacy-lock',
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  })}\n`);

  const locks = await activeSubjectLocks(linked);
  assert.equal(locks.some((entry) => entry.directory === directory
    && entry.owner?.subject?.id === 'LEGACY-PRIVATE'), true);
});

test('legacy pending publication markers migrate into the machine-local recovery plane', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-pending-migration-'));
  run('git', ['init', '-b', 'main'], root);
  const legacy = path.join(root, 'custom-state', 'LEGACY-1', 'publication-pending.json');
  await mkdir(path.dirname(legacy), { recursive: true });
  await writeFile(legacy, `${JSON.stringify({ workId: 'LEGACY-1', commit: 'a'.repeat(40) })}\n`);

  const pending = await readPendingPublication(root, {
    kind: 'story', id: 'LEGACY-1', legacyPath: legacy
  });
  assert.equal(pending.migrated, true);
  assert.equal(pending.migratedFrom, legacy);
  assert.equal(pending.record.workId, 'LEGACY-1');
  assert.equal(JSON.parse(await readFile(localPendingPublicationPath(root, 'story', 'LEGACY-1'), 'utf8')).workId, 'LEGACY-1');
  await assert.rejects(() => readFile(legacy, 'utf8'), { code: 'ENOENT' });
});

test('legacy publication marker scan exposes orphaned recovery state to doctor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-pending-orphan-'));
  run('git', ['init', '-b', 'main'], root);
  const orphan = path.join(root, 'singularity', 'work-items', 'ORPHAN-1', 'publication-pending.json');
  await mkdir(path.dirname(orphan), { recursive: true });
  await writeFile(orphan, '{}\n');
  assert.deepEqual(await findLegacyPendingPublications(root), [orphan]);
});

test('lifecycle and ledger use one event identity and idempotency key', () => {
  const event = lifecycleEvent({
    type: 'phase-approved',
    subject: { kind: 'story', id: 'EVENT-1', branch: 'EVENT-1' },
    phaseId: 'design',
    generation: 2
  });
  const commit = 'a'.repeat(40);
  const bound = bindLifecycleEvent(event, commit);
  const intent = createLedgerIntent({
    eventId: bound.eventId,
    eventType: bound.type,
    capabilityId: 'event-test',
    subject: {
      workId: bound.subject.id,
      phase: bound.phaseId,
      generation: bound.generation
    },
    actor: null
  });
  const ledgerKey = ledgerIdempotencyKey(intent, commit);
  assert.equal(intent.eventId, bound.eventId);
  assert.equal(ledgerKey.value, bound.idempotencyKey);
  assert.equal(ledgerKey.hash, bound.idempotencyHash);
});

test('revisioned stores and state planes distinguish authority from projections', async () => {
  const root = await repository();
  const definition = await loadDefinition(root);
  const loaded = await new StoryStateStore(root, definition).load('KERNEL-1');
  assert.match(loaded.revision.head, /^[0-9a-f]{40}$/);
  assert.match(loaded.revision.subjectRevision, /^[0-9a-f]{64}$/);
  assert.equal(loaded.aggregate.workItem.id, 'KERNEL-1');

  let planes = await inspectStatePlanes(root, { definition, reference: 'KERNEL-1' });
  assert.equal(planes.lifecycle.authority, 'lifecycle-branch');
  assert.equal(planes.localContext.authority, 'selection-only');
  assert.equal(planes.ledger.authority, 'proof-and-mirror');
  assert.equal(planes.projections.status.current, true);
  assert.equal(planes.projections.stale, 0, 'a new publication must persist the same ledger intent its aggregate captured');
  assert.equal(planes.healthy, true);

  const status = path.join(root, 'singularity/work-items/KERNEL-1/STATUS.md');
  await writeFile(status, '# stale projection\n');
  planes = await inspectStatePlanes(root, { definition, reference: 'KERNEL-1' });
  assert.equal(planes.projections.status.current, false);
  const projectionIssue = planes.issues.find((issue) => issue.code === 'STALE_PROJECTIONS');
  assert.equal(projectionIssue.count, 1);
  assert.deepEqual(projectionIssue.kinds, [{ kind: 'StatusMarkdown', count: 1 }]);
  assert.equal(projectionIssue.action, 'singularity-flow state reconcile KERNEL-1 --repair-projections');
  const repaired = await reconcileStateProjections(root, {
    definition,
    reference: 'KERNEL-1',
    repair: true
  });
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.planes.projections.status.current, true);
  assert.deepEqual(repaired.planes.issues, []);
});

test('assignment changes are persisted only by publication and roll back on failure', async () => {
  const root = await repository();
  const definition = await loadDefinition(root);
  const store = new StoryStateStore(root, definition);
  const workflow = await store.loadAggregate('KERNEL-1');
  const phaseId = workflow.currentPhase;
  const stateFile = path.join(workDir(root, definition, workflow.workItem.id), 'workflow.json');
  const beforeText = await readFile(stateFile, 'utf8');
  const beforeState = JSON.parse(beforeText);

  await assert.rejects(() => store.transact(
    workflow,
    { type: 'configuration-changed', phaseId, payload: { assignee: 'mobile-team' } },
    '[KERNEL-1][phase:intake][assign] mobile-team',
    (aggregate) => {
      const assignment = assignPhase(aggregate, phaseId, 'mobile-team', {
        actor: { name: 'Kernel Tester', email: 'kernel@example.com' },
        agent: 'developer'
      });
      assert.equal(assignment.assignee, 'mobile-team');
      // Force validation to fail after the publication unit writes the aggregate.
      aggregate.currentPhase = 'missing-phase';
      return assignment;
    }
  ), /Unknown current phase/);
  const restored = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.deepEqual(restored.collaboration, beforeState.collaboration, 'the transaction must restore collaboration state');
  assert.equal(restored.currentPhase, beforeState.currentPhase, 'the transaction must restore the active phase');
  assert.deepEqual(restored.history, beforeState.history, 'the transaction must restore lifecycle history');
  const reloaded = await store.loadAggregate('KERNEL-1');
  assert.equal(reloaded.collaboration.assignments[phaseId], undefined);
  assert.equal(
    (reloaded.publicationProjections ?? []).some((entry) => entry.event?.payload?.assignee === 'mobile-team'),
    false,
    'a failed assignment publication must not leave an authoritative event projection'
  );
});

test('reconciler repairs every declared Story projection without changing canonical state', async () => {
  const root = await repository();
  const definition = await loadDefinition(root);
  const store = new StoryStateStore(root, definition);
  const workflow = await store.loadAggregate('KERNEL-1');
  const phase = workflow.phases[workflow.currentPhase];
  const directory = workDir(root, definition, workflow.workItem.id);
  const artifact = path.join(directory, phase.requiredArtifact.path);
  await mkdir(path.dirname(artifact), { recursive: true });
  await writeFile(artifact, '# Governed artifact\n\nAuthored content remains intact.\n');
  phase.approvals = [{
    decision: 'approved',
    phase: phase.id,
    generation: 1,
    at: '2026-08-03T00:00:00.000Z',
    actor: { name: 'Kernel Tester', email: 'kernel@example.com' },
    agent: 'developer',
    authorityGroup: 'default-reviewers',
    identityAssurance: 'configured-local',
    selfApproval: false
  }];
  const packetBase = {
    schemaVersion: 1,
    workId: workflow.workItem.id,
    phase: phase.id,
    generation: 1,
    status: 'awaiting_review'
  };
  const packetSha256 = createHash('sha256').update(JSON.stringify(packetBase)).digest('hex');
  workflow.lineage ??= { schemaVersion: 1, canonicalBranch: workflow.workItem.branch, childBranches: [] };
  workflow.lineage.submissions = [{
    packetSha256,
    phase: phase.id,
    generation: 1,
    path: `singularity/work-items/KERNEL-1/submissions/${phase.id}/${packetSha256}.json`,
    projection: packetBase
  }];
  const event = lifecycleEvent({
    type: 'approval-requested',
    subject: { kind: 'story', id: workflow.workItem.id, branch: workflow.workItem.branch },
    phaseId: phase.id,
    generation: 1,
    actor: { name: 'Kernel Tester', email: 'kernel@example.com' }
  });
  const intent = createLedgerIntent({
    eventId: event.eventId,
    eventType: event.type,
    capabilityId: 'kernel',
    subject: { workId: workflow.workItem.id, phase: phase.id, generation: 1 },
    actor: event.actor
  });
  recordPublicationProjection(workflow, event, intent);
  assert.deepEqual(
    workflow.publicationProjections.at(-1).ledgerIntent.payload.lifecycleEvent,
    event,
    'the replay recipe must capture the exact durable ledger-intent body'
  );
  await saveWorkflow(root, definition, workflow);
  const canonical = await readFile(path.join(directory, 'workflow.json'), 'utf8');

  const repaired = await reconcileStateProjections(root, {
    definition,
    reference: workflow.workItem.id,
    repair: true
  });
  assert.deepEqual(
    new Set(repaired.repairedPaths.map((entry) => entry.includes('/approvals/') ? 'ApprovalSummary'
      : entry.includes('/submissions/') ? 'ReviewPacket'
        : entry.includes('/ledger-intents/') ? 'LedgerIntent'
          : 'ArtifactMetadata')),
    new Set(['ArtifactMetadata', 'ApprovalSummary', 'ReviewPacket', 'LedgerIntent'])
  );
  assert.equal(await readFile(path.join(directory, 'workflow.json'), 'utf8'), canonical);
  assert.match(await readFile(artifact, 'utf8'), /singularity-flow:metadata/);
  assert.match(await readFile(artifact, 'utf8'), /Authored content remains intact/);
  assert.equal(repaired.planes.projections.stale, 0);
  assert.ok(repaired.planes.projections.items.some((item) => item.kind === 'ArtifactMetadata'));
  assert.ok(repaired.planes.projections.items.some((item) => item.kind === 'ApprovalSummary'));
  assert.ok(repaired.planes.projections.items.some((item) => item.kind === 'ReviewPacket'));
  assert.ok(repaired.planes.projections.items.some((item) => item.kind === 'LedgerIntent'));
});

test('legacy ledger-intent recipes derive the committed lifecycle envelope without rewriting state', async () => {
  const root = await repository();
  const definition = await loadDefinition(root);
  const workflow = await new StoryStateStore(root, definition).loadAggregate('KERNEL-1');
  const event = lifecycleEvent({
    type: 'artifact-generated',
    subject: { kind: 'story', id: workflow.workItem.id, branch: workflow.workItem.branch },
    phaseId: workflow.currentPhase,
    generation: workflow.phases[workflow.currentPhase].generation,
    actor: { name: 'Kernel Tester', email: 'kernel@example.com' }
  });
  const intent = createLedgerIntent({
    eventId: event.eventId,
    eventType: event.type,
    capabilityId: 'kernel',
    subject: { workId: workflow.workItem.id, phase: event.phaseId, generation: event.generation },
    actor: event.actor
  });
  // Reproduce the historical ordering: state captured the intent before the unit of work embedded
  // the lifecycle event, while the committed durable intent correctly included it.
  workflow.publicationProjections.push({ schemaVersion: 1, event, ledgerIntent: structuredClone(intent) });
  await saveWorkflow(root, definition, workflow);
  const durableIntent = {
    ...intent,
    payload: { ...(intent.payload ?? {}), lifecycleEvent: event }
  };
  const intentPath = path.join(
    workDir(root, definition, workflow.workItem.id),
    'context/ledger-intents',
    `${intent.eventId}.json`
  );
  await mkdir(path.dirname(intentPath), { recursive: true });
  await writeFile(intentPath, canonicalJson(durableIntent));

  const workflowBytes = await readFile(path.join(workDir(root, definition, workflow.workItem.id), 'workflow.json'), 'utf8');
  const planes = await inspectStatePlanes(root, { definition, reference: workflow.workItem.id });
  const projected = planes.projections.items.find((item) => item.id === `ledger-intent:${intent.eventId}`);
  assert.equal(projected.current, true);
  assert.equal(
    await readFile(path.join(workDir(root, definition, workflow.workItem.id), 'workflow.json'), 'utf8'),
    workflowBytes,
    'inspection must not migrate or rewrite authoritative lifecycle state'
  );
});

test('snapshot coordinator rejects a mixed repository revision', async () => {
  const root = await repository();
  const coordinator = new SnapshotCoordinator(root);
  const stable = await coordinator.capture(async () => ({ lifecycle: { id: 'KERNEL-1' } }), {
    included: ['lifecycle']
  });
  assert.equal(stable.schemaVersion, 2);
  assert.deepEqual(stable.included, ['lifecycle']);
  assert.deepEqual(stable.lifecycle, { id: 'KERNEL-1' });
  assert.match(stable.revision.subjectRevision, /^[0-9a-f]{64}$/);
  assert.match(stable.revision.slices.lifecycle, /^[0-9a-f]{64}$/);
  const unchanged = await coordinator.capture(async () => ({
    lifecycle: { id: 'KERNEL-1' }, configuration: { version: 2 }
  }), {
    included: ['lifecycle'],
    ifRevision: stable.revision.subjectRevision,
    timings: true
  });
  assert.equal(unchanged.notModified, true);
  assert.equal(unchanged.lifecycle, undefined, 'an unchanged conditional snapshot omits its payload');
  assert.deepEqual(unchanged.included, ['lifecycle']);
  assert.equal(unchanged.timings.unit, 'milliseconds');
  assert.ok(unchanged.timings.total >= 0);
  await assert.rejects(() => coordinator.capture(async () => {
    await writeFile(path.join(root, 'mixed-revision.txt'), 'changed\n');
    return {};
  }), /changed while the snapshot was being assembled/i);
});

test('snapshot worktree fingerprints include dirty file bytes, not only status shape', async () => {
  const root = await repository();
  const coordinator = new SnapshotCoordinator(root);
  const dirty = path.join(root, 'README.md');
  await writeFile(dirty, '# first dirty value\n');
  const first = await coordinator.capture(async () => ({ lifecycle: { id: 'KERNEL-1' } }), {
    included: ['lifecycle']
  });
  await writeFile(dirty, '# second dirty value\n');
  const second = await coordinator.capture(async () => ({ lifecycle: { id: 'KERNEL-1' } }), {
    included: ['lifecycle']
  });
  assert.notEqual(first.revision.worktreeHash, second.revision.worktreeHash,
    'two modifications with the same porcelain status must have different revisions');
  assert.equal(first.revision.subjectRevision, second.revision.subjectRevision,
    'an unrelated worktree change does not invalidate a selected read-model slice');
});

test('sequence evaluation and reduction are pure', () => {
  const workflow = {
    status: 'in_progress', currentPhase: 'intake', phaseOrder: ['intake', 'design'],
    workItem: { id: 'PURE-1' }, resolution: { sequenceGates: { default: 'soft' } },
    phases: {
      intake: { id: 'intake', status: 'in_progress', approvals: [] },
      design: { id: 'design', status: 'not_started', approvals: [] }
    }
  };
  const before = structuredClone(workflow);
  const decision = evaluateSequence(workflow, { requestedPhase: 'design' });
  assert.deepEqual(workflow, before);
  assert.equal(decision.effect, 'switch');
  const next = applySequenceDecision(workflow, decision, '2026-08-03T00:00:00.000Z');
  assert.deepEqual(workflow, before);
  assert.equal(next.currentPhase, 'design');
  assert.equal(next.phases.design.status, 'in_progress');
});

test('editor confirmation port applies the same audited soft-gate reducer as the terminal', async () => {
  const workflow = {
    status: 'in_progress', currentPhase: 'intake', phaseOrder: ['intake', 'design'],
    workItem: { id: 'PORT-1' }, resolution: { sequenceGates: { default: 'soft', currentPhase: 'soft' } },
    phases: {
      intake: { id: 'intake', status: 'in_progress', approvals: [] },
      design: { id: 'design', status: 'not_started', approvals: [] }
    }, history: []
  };
  let request = null;
  const phase = await withConfirmationPort(async (message, gate) => {
    request = { message, gate };
    return true;
  }, () => assertPhaseSequence(null, workflow, 'prepare', { requestedPhase: 'design' }));
  assert.equal(request.gate, 'currentPhase');
  assert.match(request.message, /Soft sequence warning \[currentPhase\]/);
  assert.equal(phase.id, 'design');
  assert.equal(workflow.sequenceOverrides[0].gate, 'currentPhase');
});

test('a governed commit contains only the paths the publication staged', async () => {
  // `allowedPaths` named a containment the bare `git commit -m` never delivered: it staged those
  // paths and then committed the entire index. A developer with anything already staged had it
  // swept into the governed commit, which is pushed, pinned by the ledger and attested to by the
  // gate — so the governance record described a commit no reviewer ever saw.
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-commit-scope-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Kernel Tester'], root);
  run('git', ['config', 'user.email', 'kernel@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# scope\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initial'], root);

  // What the person at the keyboard was in the middle of, staged and unrelated to governance.
  const unrelated = path.join(root, 'refund.ts');
  await writeFile(unrelated, 'export const refund = () => { /* half finished */ };\n');
  run('git', ['add', 'refund.ts'], root);

  const subject = { kind: 'story', id: 'SCOPE-1', branch: 'main' };
  const event = lifecycleEvent({ type: 'phase-approved', subject, phaseId: 'design', generation: 1 });
  const governed = 'state.json';
  await new GitPublicationUnitOfWork(root).execute({
    subject,
    event,
    commit: { message: '[SCOPE-1][phase:design][approve]' },
    publication: { mode: 'off', branch: 'main' },
    allowedPaths: [governed],
    state: { write: () => writeFile(path.join(root, governed), '{"approved":true}\n') }
  });

  const committed = run('git', ['show', '--name-only', '--format=', 'HEAD'], root).stdout
    .split('\n').map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(committed, [governed], 'the governed commit holds only what it staged');
  // And the developer's work is untouched, still staged, exactly where they left it.
  assert.match(run('git', ['diff', '--name-only', '--cached'], root).stdout, /refund\.ts/);
});

test('a lock still being acquired is held, not stale', async () => {
  // Acquisition creates the directory and then writes the record, so a lock with no record yet is
  // the newest lock there is. Reading that as abandoned let a second process delete a live lock and
  // proceed: both processes then believed they held it and published concurrently.
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-lock-race-'));
  run('git', ['init', '-b', 'main'], root);
  const subject = { kind: 'story', id: 'RACE-1' };

  // Exactly the window: the directory exists, the owner record does not.
  await mkdir(subjectLockPath(root, subject), { recursive: true });
  await assert.rejects(() => acquireSubjectLock(root, subject), /is locked by another process that is still acquiring it/);

  // A record that will not parse is the same situation — a crash mid-write, not a free lock.
  await writeFile(path.join(subjectLockPath(root, subject), 'owner.json'), '{"schemaVersion":1,"su');
  await assert.rejects(() => acquireSubjectLock(root, subject), /is locked by/);
});

test('an abandoned acquisition is reclaimed once it is old enough', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-lock-abandoned-'));
  run('git', ['init', '-b', 'main'], root);
  const subject = { kind: 'story', id: 'ABANDONED-1' };
  const directory = subjectLockPath(root, subject);
  await mkdir(directory, { recursive: true });
  // Backdated past the acquisition grace period: a process that died before writing its record.
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await utimes(directory, old, old);

  const owner = await acquireSubjectLock(root, subject);
  assert.equal(owner.subject.id, 'ABANDONED-1');
  assert.equal(await releaseSubjectLock(root, subject, owner), true);
});

test('a publication that fails after the state write leaves no record of the event', async () => {
  // `state.write` persists the aggregate with a publicationProjections entry carrying the whole
  // ledger-intent recipe, and every step after it can throw. Nothing put it back — so the repair
  // the tool recommends committed the projection, and the next sync appended an approval nobody
  // gave into the append-only ledger.
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rollback-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Kernel Tester'], root);
  run('git', ['config', 'user.email', 'kernel@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# rollback\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initial'], root);

  const aggregate = { workItem: { id: 'ROLL-1' }, publicationProjections: [] };
  const target = path.join(root, 'state.json');
  await writeFile(target, `${JSON.stringify(aggregate, null, 2)}\n`);
  run('git', ['add', 'state.json'], root);
  run('git', ['commit', '-m', 'state'], root);
  const prior = structuredClone(aggregate);

  const subject = { kind: 'story', id: 'ROLL-1', branch: 'main' };
  const event = lifecycleEvent({ type: 'phase-approved', subject, phaseId: 'design', generation: 1 });
  await assert.rejects(() => new GitPublicationUnitOfWork(root).execute({
    subject,
    event,
    commit: { message: '[ROLL-1][phase:design][approve]' },
    publication: { mode: 'off', branch: 'main' },
    allowedPaths: ['state.json'],
    state: {
      write: (publicationEvent) => {
        recordPublicationProjection(aggregate, publicationEvent, { eventType: 'phase-approved' });
        return writeFile(target, `${JSON.stringify(aggregate, null, 2)}\n`);
      },
      validate: () => { throw new Error("Capability ledger branch 'state' is not initialized."); },
      rollback: () => writeFile(target, `${JSON.stringify(prior, null, 2)}\n`)
    }
  }), /not initialized/);

  const onDisk = JSON.parse(await readFile(target, 'utf8'));
  assert.deepEqual(onDisk.publicationProjections, [],
    'no recipe for an event that never happened survives on disk');
  assert.equal(run('git', ['status', '--porcelain'], root).stdout.trim(), '',
    'and nothing is left staged or modified for a later repair to commit');
});

test('a stray copy of a work-item directory cannot shadow the real one', async () => {
  // loadWorkflow reads the location the index chose; saveWorkflow always writes the id-derived path.
  // Two working-tree locations for one id were settled by readdir order, so a copy taken before an
  // experiment could be loaded, approved, and written back over the live file — destroying every
  // approval recorded since the copy was made.
  const root = await repository();
  const live = path.join(root, 'singularity/work-items/KERNEL-1/workflow.json');
  const liveState = JSON.parse(await readFile(live, 'utf8'));
  liveState.history.push({ at: new Date(0).toISOString(), event: 'only-in-the-live-file', actor: 'tester' });
  await writeFile(live, `${JSON.stringify(liveState, null, 2)}\n`);

  // The copy a person makes before trying something, still naming the same Story inside. Named so
  // it is scanned *before* the canonical directory: "first seen wins" is precisely the behaviour
  // being ruled out, and a copy that sorts later would pass by luck.
  const copy = path.join(root, 'singularity/work-items/AAA-backup-of-KERNEL-1');
  await mkdir(copy, { recursive: true });
  const stale = JSON.parse(await readFile(live, 'utf8'));
  stale.history = stale.history.filter((item) => item.event !== 'only-in-the-live-file');
  await writeFile(path.join(copy, 'workflow.json'), `${JSON.stringify(stale, null, 2)}\n`);

  const { buildRepositorySubjectIndex } = await import('../src/repository-subject-index.mjs');
  const index = await buildRepositorySubjectIndex(root, { definition: await loadDefinition(root) });
  const subject = index.list('story').find((entry) => entry.id === 'KERNEL-1');
  assert.equal(subject.location.path, 'singularity/work-items/KERNEL-1/workflow.json',
    'the directory named for the Story is its canonical home');
  assert.equal(subject.state.history.some((item) => item.event === 'only-in-the-live-file'), true,
    'and the state the index carries is the live one, not the copy');
});

test('a state file that cannot be read is reported, not treated as absent', async () => {
  const root = await repository();
  await writeFile(path.join(root, 'singularity/work-items/KERNEL-1/workflow.json'),
    '<<<<<<< HEAD\n{"workItem":{"id":"KERNEL-1"}}\n=======\n');

  const { buildRepositorySubjectIndex } = await import('../src/repository-subject-index.mjs');
  const index = await buildRepositorySubjectIndex(root, { definition: await loadDefinition(root) });
  assert.equal(index.list('story').length, 0);
  assert.equal(index.unreadable.length, 1);
  assert.match(index.unreadable[0].path, /KERNEL-1\/workflow\.json$/);

  // And doctor calls it a failure rather than reporting no work item on this branch.
  const report = run(process.execPath, [bin, 'doctor', '--json'], root, { allowFailure: true });
  const workflowState = JSON.parse(report.stdout).checks.find((entry) => entry.id === 'workflow-state');
  assert.equal(workflowState.status, 'fail');
  assert.match(workflowState.message, /could not be read/);
});

test('a snapshot does not migrate the file it is reading', async () => {
  // fullRepositorySnapshot includes the doctor report, whose pending-publication read used to
  // migrate the pre-kernel marker — deleting a tracked file mid-capture. The coordinator then saw
  // the working tree change underneath it and failed, blaming a concurrent writer that never
  // existed, on the first snapshot after every upgrade.
  const root = await repository();
  const legacy = path.join(root, 'singularity/work-items/KERNEL-1/publication-pending.json');
  await writeFile(legacy, `${JSON.stringify({ schemaVersion: 2, commit: 'a'.repeat(40) }, null, 2)}\n`);
  run('git', ['add', '-A'], root);
  run('git', ['commit', '-m', 'legacy marker'], root);

  const snapshot = run(process.execPath, [bin, 'snapshot', '--json'], root, { allowFailure: true });
  assert.equal(snapshot.status, 0, `snapshot failed: ${snapshot.stderr}`);
  assert.doesNotMatch(snapshot.stderr, /changed while the snapshot was being assembled/);
  assert.equal(run('git', ['status', '--porcelain'], root).stdout.trim(), '',
    'reading the repository left it exactly as it was');

  // The marker is still reported, and a mutation still migrates it.
  const planes = JSON.parse(run(process.execPath, [bin, 'state', 'planes', 'KERNEL-1', '--json'], root).stdout);
  assert.equal(planes.publicationRecovery.pending, true,
    'state planes agrees with the commands that refuse while a publication is pending');
});

test('a failure inside the state write is unwound, not just one after it', async () => {
  // `wroteState` was set after `state.write` resolved, so it meant "the write finished" when the
  // question rollback answers is "may the write have reached disk". `state.write` is several writes
  // — the approval path rewrites artifact metadata, registers a snapshot and writes both decision
  // files before saving the aggregate — so a throw partway left every one of them on disk with the
  // undo skipped entirely.
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-unwind-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Kernel Tester'], root);
  run('git', ['config', 'user.email', 'kernel@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# unwind\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initial'], root);

  const aggregate = path.join(root, 'state.json');
  const decision = path.join(root, 'approved.json');
  await writeFile(aggregate, '{"approved":false}\n');
  run('git', ['add', 'state.json'], root);
  run('git', ['commit', '-m', 'state'], root);

  const subject = { kind: 'story', id: 'UNWIND-1', branch: 'main' };
  const event = lifecycleEvent({ type: 'phase-approved', subject, phaseId: 'design', generation: 1 });
  await assert.rejects(() => new GitPublicationUnitOfWork(root).execute({
    subject,
    event,
    commit: { message: '[UNWIND-1][phase:design][approve]' },
    publication: { mode: 'off', branch: 'main' },
    allowedPaths: ['state.json'],
    state: {
      // Two writes, and the second throws — exactly the shape of saveWorkflow plus the approval
      // materialisation that now runs inside it.
      write: async () => {
        await writeFile(decision, '{"decision":"approved"}\n');
        await writeFile(aggregate, '{"approved":true}\n');
        throw new Error('gpg: signing failed: Inappropriate ioctl for device');
      },
      rollback: async () => {
        await writeFile(aggregate, '{"approved":false}\n');
        await rm(decision, { force: true });
      }
    }
  }), /signing failed/);

  assert.equal(await readFile(aggregate, 'utf8'), '{"approved":false}\n',
    'the aggregate is back to what it was');
  assert.equal(existsSync(decision), false,
    'and the decision file the half-finished write left behind is gone');
});

test('cancel and reject mutate inside the transaction, not before it', async () => {
  // Both used to write workflow.json and publish afterwards, so the rollback snapshot was taken
  // after the mutation and restored it instead of undoing it. A refusal raised inside the unit of
  // work — an unreconciled ledger outbox is enough — then reported that the mutation had been
  // refused while leaving it durable on disk with no commit, no event and no ledger entry. For
  // cancel that was unrecoverable: cancel refuses an already-cancelled Story, every phase command
  // fails on a null currentPhase, and reopen only accepts a complete one.
  //
  // Asserted on the source because the refusal is impractical to stage through the CLI: a Story
  // pins its ledger configuration at start, so the preflight this depends on cannot be reached from
  // a fixture without rebuilding the repository around it. `transactStory` is the guarantee — it
  // clones the aggregate before running the transition and hands that clone in as the rollback.
  const cli = await readFile(path.join(packageRoot, 'src', 'cli.mjs'), 'utf8');
  const body = (name) => {
    const start = cli.indexOf(`async function ${name}(`);
    assert.ok(start > 0, `${name} exists`);
    return cli.slice(start, cli.indexOf('\nasync function ', start + 1));
  };
  for (const command of ['cancelCommand', 'rejectCommand']) {
    const source = body(command);
    assert.match(source, /transactStory\(/, `${command} publishes through a transaction`);
    assert.doesNotMatch(source, /await commitAndPublish\(/,
      `${command} does not mutate and then publish separately`);
  }
});
