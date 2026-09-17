import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { previewFeedbackAttachments, registerFeedbackAttachments } from '../src/revision/feedback-attachments.mjs';
import { createFeedbackAttachmentStore } from '../src/revision/feedback-attachment-store.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rev-revoke-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const file = path.join(root, 'review.md');
  await writeFile(file, '# Feedback\nUse these exact bytes.\n');
  const context = {
    repositoryRoot: root, workId: 'STORY-1', phaseId: 'implementation', phaseGeneration: 2,
    feedbackText: 'Please inspect this document.', active: true,
    headCommit: 'a'.repeat(40), sourceTreeSha256: `sha256:${'b'.repeat(64)}`,
    configSha256: `sha256:${'c'.repeat(64)}`, workflowSha256: `sha256:${'d'.repeat(64)}`
  };
  let active = true;
  const store = createFeedbackAttachmentStore(root, {
    workId: context.workId, phaseId: context.phaseId, phaseGeneration: context.phaseGeneration,
    assertCurrentContext: async (expected) => active && expected.headCommit === context.headCommit
      && expected.sourceTreeSha256 === context.sourceTreeSha256
      && expected.configSha256 === context.configSha256
      && expected.workflowSha256 === context.workflowSha256
  });
  const sources = [{ source: 'local-file', path: file }];
  const authorizeRead = async () => true;
  const { plan } = await previewFeedbackAttachments({
    context, sources, selection: [0], authorizeRead
  });
  await store.savePlan(plan);
  const receipt = await registerFeedbackAttachments({
    plan, context, sources, selection: [0], confirm: plan.planSha256,
    idempotencyKey: 'register-1', authorizeRead,
    assertCurrentContext: async () => active, store
  });
  return { root, file, store, receipt, plan, context, sources, authorizeRead,
    setActive: (value) => { active = value; } };
}

test('status reads only revocation metadata while evidence consumption verifies selected bytes', async (t) => {
  const { root, store, receipt } = await fixture(t);
  const original = path.join(root, '.git', 'singularity-flow', 'revision-feedback-attachments',
    'STORY-1', 'implementation', '0002', 'objects',
    `${receipt.attachments[0].originalSha256.slice(7)}.bin`);
  await unlink(original);
  assert.deepEqual(await store.listStatus(), [{
    attachmentSetSha256: receipt.attachmentSetSha256,
    status: 'active', objectIntegrity: 'not-checked', registeredAt: receipt.registeredAt
  }]);
  await assert.rejects(store.read(receipt.attachmentSetSha256), { code: 'REV_ATTACHMENT_STORE_CORRUPT' });
  await assert.rejects(store.list(), { code: 'REV_ATTACHMENT_STORE_CORRUPT' });
});

test('a revoked set cannot be reported as registered by idempotent replay, including inside append', async (t) => {
  const { file, store, receipt, plan, context, sources, authorizeRead } = await fixture(t);
  const existing = await store.findByIdempotencyKey('register-1');
  const original = await readFile(file);
  const rendition = await store.readObject(receipt.attachments[0].renditionSha256);
  const objects = [
    { role: 'original', sha256: receipt.attachments[0].originalSha256, bytes: original },
    { role: 'selected-rendition', sha256: receipt.attachments[0].renditionSha256, bytes: rendition }
  ];
  const removal = await store.planRevocation({
    attachmentSetSha256: receipt.attachmentSetSha256, expectedContext: receipt
  });
  await store.revoke({
    planSha256: removal.planSha256, confirm: removal.planSha256,
    idempotencyKey: 'remove-1', expectedContext: receipt
  });
  await assert.rejects(store.findByIdempotencyKey('register-1'), {
    code: 'REV_ATTACHMENT_SET_REVOKED'
  });
  await assert.rejects(registerFeedbackAttachments({
    plan, context, sources, selection: [0], confirm: plan.planSha256,
    idempotencyKey: 'register-1', authorizeRead,
    assertCurrentContext: async () => true, store
  }), { code: 'REV_ATTACHMENT_SET_REVOKED' });
  await assert.rejects(store.append({
    idempotencyKey: 'register-1', requestSha256: existing.requestSha256,
    receipt, objects, expectedContext: receipt
  }), { code: 'REV_ATTACHMENT_SET_REVOKED' });
});

test('revocation is append-only, confirmed, idempotent, and excludes registered bytes from routing', async (t) => {
  const { root, file, store, receipt } = await fixture(t);
  assert.deepEqual(await store.listStatus(), [{
    attachmentSetSha256: receipt.attachmentSetSha256,
    status: 'active', objectIntegrity: 'not-checked', registeredAt: receipt.registeredAt
  }]);
  const plan = await store.planRevocation({
    attachmentSetSha256: receipt.attachmentSetSha256, expectedContext: receipt
  });
  assert.equal(JSON.stringify(plan).includes(root), false);
  assert.equal(JSON.stringify(plan).includes(await readFile(file, 'utf8')), false);
  assert.deepEqual(await store.readRevocationPlan(plan.planSha256), plan);
  await assert.rejects(store.revoke({
    planSha256: plan.planSha256, confirm: `sha256:${'0'.repeat(64)}`,
    idempotencyKey: 'remove-1', expectedContext: receipt
  }), { code: 'REV_ATTACHMENT_CONFIRMATION' });
  assert.deepEqual(await store.read(receipt.attachmentSetSha256), receipt);
  const request = {
    planSha256: plan.planSha256, confirm: plan.planSha256,
    idempotencyKey: 'remove-1', expectedContext: receipt
  };
  const event = await store.revoke(request);
  assert.deepEqual(await store.revoke(request), event);
  assert.equal((await store.list()).length, 1, 'historical receipt remains');
  await assert.rejects(store.read(receipt.attachmentSetSha256), { code: 'REV_ATTACHMENT_SET_REVOKED' });
  await assert.rejects(store.readObject(receipt.attachments[0].originalSha256), {
    code: 'REV_ATTACHMENT_STORE_UNAUTHORIZED'
  });
  assert.deepEqual(await store.listStatus(), [{
    attachmentSetSha256: receipt.attachmentSetSha256,
    status: 'revoked', objectIntegrity: 'not-checked', registeredAt: receipt.registeredAt,
    revokedAt: event.revokedAt, revocationSha256: event.revocationSha256
  }]);
  assert.equal(JSON.stringify(event).includes(root), false);
  assert.equal(JSON.stringify(event).includes(await readFile(file, 'utf8')), false);
  await assert.rejects(store.revoke({ ...request, idempotencyKey: 'remove-2' }), {
    code: 'REV_ATTACHMENT_SET_REVOKED'
  });
  await assert.rejects(store.planRevocation({
    attachmentSetSha256: receipt.attachmentSetSha256, expectedContext: receipt
  }), { code: 'REV_ATTACHMENT_SET_REVOKED' });
});

test('revocation refuses wrong Story context, stale active phase, and expired confirmation', async (t) => {
  const { store, receipt, setActive } = await fixture(t);
  await assert.rejects(store.planRevocation({
    attachmentSetSha256: receipt.attachmentSetSha256,
    expectedContext: { ...receipt, phaseGeneration: receipt.phaseGeneration + 1 }
  }), { code: 'REV_ATTACHMENT_PLAN_STALE' });
  const now = Date.now();
  const plan = await store.planRevocation({
    attachmentSetSha256: receipt.attachmentSetSha256, expectedContext: receipt, now
  });
  await assert.rejects(store.revoke({
    planSha256: plan.planSha256, confirm: plan.planSha256,
    idempotencyKey: 'remove-1', expectedContext: { ...receipt, configSha256: `sha256:${'e'.repeat(64)}` }
  }), { code: 'REV_ATTACHMENT_PLAN_STALE' });
  await assert.rejects(store.revoke({
    planSha256: plan.planSha256, confirm: plan.planSha256,
    idempotencyKey: 'remove-1', expectedContext: receipt,
    now: Date.parse(plan.expiresAt) + 1
  }), { code: 'REV_ATTACHMENT_PLAN_EXPIRED' });
  setActive(false);
  await assert.rejects(store.revoke({
    planSha256: plan.planSha256, confirm: plan.planSha256,
    idempotencyKey: 'remove-1', expectedContext: receipt
  }), { code: 'REV_ATTACHMENT_PLAN_STALE' });
  assert.deepEqual(await store.read(receipt.attachmentSetSha256), receipt);
});

test('corrupted revocation never restores a registered set to usable status', async (t) => {
  const { root, store, receipt } = await fixture(t);
  const plan = await store.planRevocation({
    attachmentSetSha256: receipt.attachmentSetSha256, expectedContext: receipt
  });
  await store.revoke({
    planSha256: plan.planSha256, confirm: plan.planSha256,
    idempotencyKey: 'remove-1', expectedContext: receipt
  });
  const file = path.join(root, '.git', 'singularity-flow', 'revision-feedback-attachments',
    'STORY-1', 'implementation', '0002', 'revocations',
    `${receipt.attachmentSetSha256.slice(7)}.json`);
  const record = JSON.parse(await readFile(file, 'utf8'));
  record.revokedAt = '2000-01-01T00:00:00.000Z';
  await writeFile(file, JSON.stringify(record), { mode: 0o600 });
  await assert.rejects(store.read(receipt.attachmentSetSha256), {
    code: 'REV_ATTACHMENT_STORE_CORRUPT'
  });
});

test('ordinary removal preview prunes expired private plans and retains live confirmation', async (t) => {
  const { root, store, receipt } = await fixture(t);
  const request = {
    attachmentSetSha256: receipt.attachmentSetSha256, expectedContext: receipt
  };
  const expired = await store.planRevocation({ ...request, now: Date.now() - 60 * 60 * 1000 });
  const current = await store.planRevocation({ ...request, now: Date.now() });
  const plans = path.join(root, '.git', 'singularity-flow', 'revision-feedback-attachments',
    'STORY-1', 'implementation', '0002', 'revocation-plans');
  await assert.rejects(access(path.join(plans, `${expired.planSha256.slice(7)}.json`)), { code: 'ENOENT' });
  assert.deepEqual(await store.readRevocationPlan(current.planSha256), current,
    'an unexpired removal confirmation remains available after ordinary cleanup');
});
