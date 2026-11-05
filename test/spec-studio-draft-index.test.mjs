import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { draftsRoot, readDraft, saveDraft, snapshotDigest } from '../src/spec-library/draft-store.mjs';
import { newDraft } from '../src/spec-library/draft-model.mjs';
import { environment } from './helpers/run-and-test-fixture.mjs';

const specId = 'SPEC-INDEX-001';
async function fixture(t, count = 12) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-studio-index-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: environment(path.join(root, 'context')) });
  for (let sequence = 1; sequence <= count; sequence++) await saveDraft(root, specId, {
    operation: sequence === 1 ? 'new' : 'edit', operationId: 'save-' + sequence, payload: { sequence }, create: sequence === 1,
    change: current => ({ ...(current ?? newDraft({ title: 'An evolving idea' })), spec: 'Version ' + sequence + '\n' + 'Some writing. '.repeat(3000) })
  });
  return { root, directory: path.join(draftsRoot(root), specId) };
}

test('quick reads use the verified current snapshot; old operation retries still verify their original bytes', async t => {
  const { root } = await fixture(t);
  const quick = await readDraft(root, specId, { headOnly: true });
  assert.equal(quick.sequence, 12);
  assert.equal(quick.snapshots.length, 1, 'the quick view does not materialize every saved document');
  assert.equal(quick.historyChecked, false);
  assert.equal((await readDraft(root, specId)).snapshots.length, 12, 'explicit history retains every version');
  const replay = await saveDraft(root, specId, { operationId: 'save-1', operation: 'new', create: true,
    payload: { sequence: 1 }, change: () => { throw Error('A replay must never rerun its mutation'); } });
  assert.equal(replay.replayed, true); assert.equal(replay.snapshot.sequence, 1); assert.equal(replay.head.sequence, 12);
  await assert.rejects(saveDraft(root, specId, { operationId: 'save-1', operation: 'new', payload: { different: true }, change: () => null }), { code: 'SPEC_DRAFT_OPERATION_REUSED' });
});

test('a lost or torn index rebuilds from immutable history without changing its bytes', async t => {
  const { root, directory } = await fixture(t, 3);
  const first = await readFile(path.join(directory, '000001.json'));
  await writeFile(path.join(directory, 'index.json'), '{torn');
  assert.equal((await readDraft(root, specId, { headOnly: true })).sequence, 3);
  await saveDraft(root, specId, { operationId: 'save-4', operation: 'edit', change: current => ({ ...current, spec: 'Fourth version' }) });
  assert.equal((await readDraft(root, specId, { headOnly: true })).snapshots.length, 1);
  assert.deepEqual(await readFile(path.join(directory, '000001.json')), first);
  await rm(path.join(directory, 'index.json'));
  assert.equal((await readDraft(root, specId, { headOnly: true })).sequence, 4);
});

test('a snapshot durable before its index acknowledgement is discovered and replayed exactly once', async t => {
  const { root, directory } = await fixture(t, 2);
  const previous = (await readDraft(root, specId)).head;
  const third = { ...previous, sequence: 3, operationId: 'arrived-before-index', previousSnapshotSha256: previous.snapshotSha256,
    draft: { ...previous.draft, spec: 'The snapshot already landed.' } };
  third.snapshotSha256 = snapshotDigest(third);
  await writeFile(path.join(directory, '000003.json'), JSON.stringify(third) + '\n');
  assert.equal((await readDraft(root, specId, { headOnly: true })).head.draft.spec, third.draft.spec);
  const replay = await saveDraft(root, specId, { operation: third.operation, operationId: third.operationId, payload: { sequence: 2 }, change: () => null });
  assert.equal(replay.replayed, true); assert.equal(replay.snapshot.sequence, 3);
  assert.equal((await readDraft(root, specId)).snapshots.length, 3);
});

test('the index cannot substitute for missing or altered original operation evidence', async t => {
  const { root, directory } = await fixture(t, 2);
  await writeFile(path.join(directory, '000001.json'), '{changed');
  await assert.rejects(saveDraft(root, specId, { operation: 'new', operationId: 'save-1', payload: { sequence: 1 }, change: () => null }), { code: 'SPEC_DRAFT_OPERATION_UNAVAILABLE' });
  assert.equal((await readDraft(root, specId)).damaged.length, 1);
  assert.equal((await readDraft(root, specId, { headOnly: true })).sequence, 2);
});

test('an unwritable optional index cannot turn an already durable save into a failed save', async t => {
  const { root, directory } = await fixture(t, 2);
  await rm(path.join(directory, 'index.json')); await mkdir(path.join(directory, 'index.json'));
  const saved = await saveDraft(root, specId, { operationId: 'save-3', operation: 'edit', change: current => ({ ...current, spec: 'Saved without its optional cache.' }) });
  assert.equal(saved.snapshot.sequence, 3);
  assert.equal((await readDraft(root, specId, { headOnly: true })).head.draft.spec, saved.snapshot.draft.spec);
});
