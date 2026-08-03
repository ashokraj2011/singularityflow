import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { bindLifecycleEvent, lifecycleEvent, recordPublicationProjection } from '../src/lifecycle-event.mjs';
import { createLedgerIntent, ledgerIdempotencyKey } from '../src/ledger.mjs';
import { saveWorkflow, workDir } from '../src/state.mjs';

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
