import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recordSha256 } from '../src/records.mjs';
import { reconstructRequiredStepActions } from '../src/step-action-recovery.mjs';
import { deliverStepActions, readStepActionDelivery } from '../src/step-action-delivery.mjs';
import { requiredStepActionDeliveries } from '../src/step-action-receipts.mjs';
import { sharedPublicationStorageDirectory } from '../src/publication-storage.mjs';

async function fixture(t, { published = true, wrongHash = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-delivery-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Recovery Tester'); git('config', 'user.email', 'recovery@example.test');
  const workflow = { workItem: { id: 'CRASH-1', branch: 'main' },
    resolution: { phases: [{ id: 'intake', afterStep: [{ id: 'audit', required: true, on: ['approved'], send: 'event',
      target: 'hook', targetSpec: { kind: 'webhook', url: 'https://hooks.example.test/audit' } }] }] },
    phases: { intake: { status: 'approved', generation: 1, artifacts: [] } } };
  const event = { type: 'phase-approved', phaseId: 'intake', generation: 1,
    createdAt: '2026-10-04T00:00:00.000Z', payload: { stepActionRemote: null } };
  workflow.publicationProjections = [{ event }];
  const directory = path.join(root, 'singularity/work-items/CRASH-1');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'workflow.json'), JSON.stringify(workflow));
  git('add', '.'); git('commit', '-qm', `approval\n\nSingularity-Flow-Event-SHA256: sha256:${wrongHash ? '0'.repeat(64) : recordSha256(event)}\nSingularity-Flow-Publication-Mode: ${published ? 'off' : 'required'}`);
  return { root, git, workflow, key: requiredStepActionDeliveries(workflow)[0].key };
}

test('committed approval recovers a missing queue once; automatic delivery never replays an unknown outcome', async t => {
  const { root, workflow, key } = await fixture(t);
  const result = await reconstructRequiredStepActions(root, {}, workflow);
  assert.deepEqual(result.restored.map(entry => [entry.key, entry.status]), [[key, 'failed']]);
  let sent = 0;
  const post = async () => { sent++; return { outcome: 'delivered', status: 200 }; };
  await deliverStepActions(root, { post });
  assert.equal(sent, 0);
  assert.equal((await reconstructRequiredStepActions(root, {}, workflow)).restored.length, 0);
  await deliverStepActions(root, { keys: [key], post });
  assert.equal(sent, 1);
  assert.equal((await readStepActionDelivery(root, key)).status, 'delivered');
  assert.equal((await reconstructRequiredStepActions(root, {}, workflow)).restored.length, 0);
});

test('unpublished approvals create no stranded waiting record and can recover after publication', async t => {
  const { root, git, workflow, key } = await fixture(t, { published: false });
  const result = await reconstructRequiredStepActions(root, {}, workflow);
  assert.equal(result.restored.length, 0);
  assert.match(result.unavailable[0].reason, /publication could not be verified/);
  assert.equal(await readStepActionDelivery(root, key), null);
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.equal((await reconstructRequiredStepActions(root, {}, workflow)).restored.length, 1);
  assert.equal((await readStepActionDelivery(root, key)).status, 'failed');
});

test('reconstruction refuses a mismatched event hash or changed pinned target', async t => {
  const badHash = await fixture(t, { wrongHash: true });
  const first = await reconstructRequiredStepActions(badHash.root, {}, badHash.workflow);
  assert.equal(first.restored.length, 0);
  assert.equal(first.unavailable.length, 1);
  const changed = await fixture(t);
  changed.workflow.resolution.phases[0].afterStep[0].targetSpec.url = 'https://other.example.test/audit';
  const second = await reconstructRequiredStepActions(changed.root, {}, changed.workflow);
  assert.equal(second.restored.length, 0);
  assert.equal(second.unavailable.length, 1);
});

test('reconstruction preserves damaged outbox bytes instead of discarding delivery history', async t => {
  const { root, workflow, key } = await fixture(t);
  await reconstructRequiredStepActions(root, {}, workflow);
  const file = path.join(sharedPublicationStorageDirectory(root, 'action-outbox'), `${key}.json`);
  await writeFile(file, '{broken');
  assert.equal((await reconstructRequiredStepActions(root, {}, workflow)).restored.length, 0);
  assert.equal(await readFile(file, 'utf8'), '{broken');
});
