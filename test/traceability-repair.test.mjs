import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { traceabilityDraftFingerprint, traceabilityRepairProjection } from '../src/traceability-repair.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-tag-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'tests'));
  await writeFile(path.join(root, 'src/payment.js'), 'export const payment = true;\n');
  await writeFile(path.join(root, 'tests/payment.test.js'), 'test("pays", () => {});\n');
  const input = {
    plan: { path: 'context/claims/plan.json', sha256: 'a'.repeat(64), generation: 1 },
    sourcePaths: ['src/payment.js'], testPaths: ['tests/payment.test.js'],
    actions: [
      { kind: 'source-tag', clauseId: 'TAG-1:REQ-001', approved: true, expectedPaths: ['src/payment.js'] },
      { kind: 'acceptance-tag', clauseId: 'TAG-1:AC-001', approved: true, expectedPaths: ['tests/payment.test.js'] }
    ]
  };
  const options = { workId: 'TAG-1', phase: { id: 'build-code', generationIntent: { id: 'intent-1' } }, sameTurn: true };
  return { root, input, options, project: () => traceabilityRepairProjection(root, input, options) };
}

test('annotation repair is a hash-bound read-only producer instruction, not automatic evidence', async (t) => {
  const item = await fixture(t);
  const before = await readFile(path.join(item.root, 'src/payment.js'), 'utf8');
  const repair = await item.project();
  assert.equal(repair.status, 'producer-repair');
  assert.equal(repair.actions.length, 2);
  assert.deepEqual(repair.actions.map((action) => action.tag), ['@clause:TAG-1:REQ-001', '@ac:TAG-1:AC-001']);
  assert.deepEqual(repair.actions[0].explanationLimits, { minimum: 10, maximum: 300 });
  assert.equal(repair.actions[1].placement, 'directly-before-executable-test');
  assert.ok(repair.actions.every((action) => action.sameTurn && action.requiresSemanticVerification));
  assert.ok(repair.actions.every((action) => action.disposition === 'verify-existing-behavior'));
  assert.match(repair.guidance, /Tags alone prove neither correctness nor a test run/);
  assert.equal(await readFile(path.join(item.root, 'src/payment.js'), 'utf8'), before);
  assert.match(repair.fingerprint, /^sha256:[a-f0-9]{64}$/u);
});

test('tag-only source or test edits change only their scoped repair fingerprints', async (t) => {
  const item = await fixture(t);
  const first = await item.project();
  await writeFile(path.join(item.root, 'README.md'), '# unrelated work stays untouched\n');
  assert.deepEqual(await item.project(), first);
  await writeFile(path.join(item.root, 'src/payment.js'), '// @clause:TAG-1:REQ-001 marks the payment as paid\nexport const payment = true;\n');
  const second = await item.project();
  assert.notEqual(second.actions[0].fingerprint, first.actions[0].fingerprint);
  assert.equal(second.actions[1].fingerprint, first.actions[1].fingerprint);
  assert.notEqual(traceabilityDraftFingerprint('same-summary', second), traceabilityDraftFingerprint('same-summary', first));
  await writeFile(path.join(item.root, 'tests/payment.test.js'), '// @ac:TAG-1:AC-001\ntest("pays", () => {});\n');
  assert.notEqual((await item.project()).actions[1].fingerprint, second.actions[1].fingerprint);
  assert.equal(traceabilityDraftFingerprint('same-summary', null), 'same-summary');
});

test('repair fingerprints bind the Story, phase, open intent and approved plan', async (t) => {
  const item = await fixture(t);
  const first = await item.project();
  for (const options of [
    { ...item.options, workId: 'OTHER' },
    { ...item.options, phase: { ...item.options.phase, id: 'other-code' } },
    { ...item.options, phase: { ...item.options.phase, generationIntent: { id: 'intent-2' } } }
  ]) {
    assert.notEqual((await traceabilityRepairProjection(item.root, item.input, options)).fingerprint, first.fingerprint);
  }
  item.input.plan.sha256 = 'b'.repeat(64);
  assert.notEqual((await item.project()).fingerprint, first.fingerprint);
});

test('unapproved, unallocated or missing paths cannot receive routine tag repair', async (t) => {
  const item = await fixture(t);
  item.input.actions[0].approved = false;
  item.input.actions[1].expectedPaths = ['tests/not-allocated.test.js'];
  item.input.actions.push({ kind: 'source-tag', clauseId: 'TAG-1:REQ-002', approved: true, expectedPaths: [] });
  item.input.sourcePaths.push('src/missing.js');
  item.input.actions.push({ kind: 'source-tag', clauseId: 'TAG-1:REQ-003', approved: true, expectedPaths: ['src/missing.js'] });
  const repair = await item.project();
  assert.deepEqual(repair.actions.map((action) => action.disposition), [
    'clarify-mapping', 'repair-implementation-or-test', 'clarify-mapping', 'repair-implementation-or-test'
  ]);
  assert.ok(repair.actions.every((action) => !action.sameTurn));
  assert.equal(repair.actions[1].paths[0].status, 'not-in-candidate');
  assert.equal(repair.actions[3].paths[0].status, 'missing');
});

test('unowned or consumed-generation targets do not authorize same-turn annotations', async (t) => {
  const item = await fixture(t);
  item.options.sameTurn = false;
  const repair = await item.project();
  assert.equal(repair.status, 'owner-review');
  assert.equal(repair.sameTurn, false);
  assert.ok(repair.actions.every((action) => !action.sameTurn));
});

test('unsafe or oversized annotation targets remain untouched and unavailable', async (t) => {
  const item = await fixture(t);
  const target = path.join(item.root, 'src/payment.js');
  await rm(target);
  await symlink('../tests/payment.test.js', target);
  assert.equal((await item.project()).actions[0].sameTurn, false);
  await rm(target);
  await link(path.join(item.root, 'tests/payment.test.js'), target);
  assert.equal((await item.project()).actions[0].paths[0].status, 'unsafe');
  await rm(target);
  await writeFile(target, '');
  await truncate(target, 2 * 1024 * 1024 + 1);
  assert.equal((await item.project()).actions[0].paths[0].status, 'unavailable');
  await writeFile(target, Buffer.from([0xff]));
  assert.equal((await item.project()).actions[0].sameTurn, false);
});

test('oversized repair inventories fail closed rather than silently losing findings', async (t) => {
  const item = await fixture(t);
  item.input.actions = Array.from({ length: 257 }, (_, index) => ({
    kind: 'source-tag', clauseId: `TAG-1:REQ-${index}`, approved: true, expectedPaths: ['src/payment.js']
  }));
  const repair = await item.project();
  assert.equal(repair.status, 'manual-review');
  assert.equal(repair.sameTurn, false);
  assert.deepEqual(repair.actions, []);
});
