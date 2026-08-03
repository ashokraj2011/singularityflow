import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';
import { acquireSubjectLock, releaseSubjectLock, subjectLockPath } from '../src/subject-lock.mjs';
import { SnapshotCoordinator } from '../src/snapshot-coordinator.mjs';
import { StoryStateStore } from '../src/state-stores.mjs';
import { inspectStatePlanes, reconcileStateProjections } from '../src/state-planes.mjs';
import { evaluateSequence, applySequenceDecision } from '../src/sequence.mjs';
import { loadDefinition } from '../src/config.mjs';
import { bindLifecycleEvent, lifecycleEvent } from '../src/lifecycle-event.mjs';
import { createLedgerIntent, ledgerIdempotencyKey } from '../src/ledger.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
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
  run(process.execPath, [bin, 'start', 'KERNEL-1', '--ref', 'KERNEL-1', '--title', 'Kernel'], root);
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

  const status = path.join(root, 'singularity/work-items/KERNEL-1/STATUS.md');
  await writeFile(status, '# stale projection\n');
  planes = await inspectStatePlanes(root, { definition, reference: 'KERNEL-1' });
  assert.equal(planes.projections.status.current, false);
  const repaired = await reconcileStateProjections(root, {
    definition,
    reference: 'KERNEL-1',
    repair: true
  });
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.planes.projections.status.current, true);
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
  await assert.rejects(() => coordinator.capture(async () => {
    await writeFile(path.join(root, 'mixed-revision.txt'), 'changed\n');
    return {};
  }), /changed while the snapshot was being assembled/i);
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

test('surface orchestration cannot import raw state loaders', async () => {
  for (const relative of ['src/cli.mjs', 'src/editor.mjs', 'src/doctor.mjs']) {
    const content = await readFile(path.join(packageRoot, relative), 'utf8');
    assert.doesNotMatch(content, /\bloadWorkflow\b|\bloadInitiative\b/, `${relative} must use state stores`);
  }
});
