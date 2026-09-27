import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SharedWorkflowDraftController } from '../apps/vscode/src/views/workflow-drafts-model.ts';
import { createWorkflowDraftRecoveryStore } from '../apps/vscode/src/views/workflow-drafts-recovery.ts';

const draftId = 'WFD-ABC123';
const authority = 'https://approved.fixture-only.example/config.git';
const heads = ['a', 'b', 'c', 'd'].map((character) => character.repeat(40));
const sha = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
const turn = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-encrypted-restart-integration-')));
  const repository = path.join(base, 'explicit-repository');
  const directory = path.join(base, 'workflow-draft-recovery');
  const values = new Map();
  const secrets = { async get(key) { return values.get(key); }, async store(key, value) { values.set(key, value); } };
  const scope = { repository, authority, draftId };
  const inspect = createWorkflowDraftRecoveryStore(directory, secrets);
  const controllers = []; let privateWrites = 0;
  let shared = { revision: 1, displayName: 'Shared draft', payload: { initial: true }, assets: [], head: heads[0] };
  const operations = new Map(); const saves = [];
  let saveGate = null; let loseNextAck = false; let loseBeforeCommit = false;
  const record = () => ({ draftId, displayName: shared.displayName, revision: shared.revision, lifecycleEpoch: 1,
    revisionSha256: sha({ draftId, name: shared.displayName, revision: shared.revision, payload: shared.payload, assets: shared.assets }) });
  const result = (action, data, status = 'read') => ({ resultType: 'workflow-author', status,
    operation: { id: `workflow.author.${action}`, modelPolicy: 'never' }, capability: { repository: authority }, data });
  const apply = (text, name) => {
    const input = JSON.parse(text); shared = { revision: shared.revision + 1, displayName: name,
      payload: input.payload ?? {}, assets: (input.assets ?? []).map((asset) => ({ path: asset.path,
        contentBase64: Buffer.from(asset.content).toString('base64'), bytes: Buffer.byteLength(asset.content) })), head: heads[shared.revision] };
  };
  const ownStore = () => {
    const raw = createWorkflowDraftRecoveryStore(directory, secrets);
    return { read: (selected) => raw.read(selected), remove: (selected, id) => raw.remove(selected, id),
      async write(checkpoint, expected) { privateWrites += 1; try { await raw.write(checkpoint, expected); } finally { privateWrites -= 1; } } };
  };
  const open = async () => {
    const calls = []; const inputFiles = new Map(); const comparisons = []; let counter = 0;
    const runner = async (args, root) => {
      assert.equal(root, repository); calls.push([...args]);
      const action = args[2]; const option = (name) => args[args.indexOf(name) + 1];
      if (action === 'list') return { result: result(action, { head: shared.head, drafts: [record()], nextCursor: null }), error: null };
      if (action === 'read') return { result: result(action, { head: shared.head, record: record(),
        payload: shared.payload, assets: shared.assets, tombstone: null }), error: null };
      if (action === 'op-status') {
        const operationId = args[3]; const acknowledged = operations.get(operationId);
        return { result: result(action, { status: acknowledged ? 'shared-acknowledged' : 'not-found',
          operationId, head: shared.head, ...(acknowledged ?? {}) }), error: null };
      }
      assert.equal(action, 'save', 'the integration runner permits no approval/execution/deletion routes');
      const text = inputFiles.get(option('--input')); assert.equal(typeof text, 'string');
      const operationId = option('--operation-id');
      const privateCheckpoint = await inspect.read(scope);
      assert.equal(privateCheckpoint.pendingSave.operationId, operationId, 'possibly-issued operation must already be AES-sealed before shared contact');
      assert.equal(privateCheckpoint.pendingSave.snapshot.text, text);
      assert.equal(privateCheckpoint.pendingSave.snapshot.head, option('--expected-head'));
      saves.push({ operationId, text, head: option('--expected-head'), name: option('--name') });
      if (saveGate) { const gate = saveGate; saveGate = null; gate.entered.resolve(); await gate.release.promise; }
      if (loseBeforeCommit) { loseBeforeCommit = false; throw new Error('fixture timeout before acknowledgement'); }
      const previous = operations.get(operationId);
      if (!previous) {
        assert.equal(option('--expected-head'), shared.head, 'a stale shared head must never be overwritten');
        apply(text, option('--name'));
        operations.set(operationId, { operationHead: shared.head, record: record(), currentLifecycle: 'live' });
      }
      if (loseNextAck) { loseNextAck = false; throw new Error('fixture timeout after shared commit'); }
      return { result: result(action, { ...operations.get(operationId), operationId, head: shared.head }, 'shared-acknowledged'), error: null };
    };
    const controller = new SharedWorkflowDraftController(repository, runner, async (text, invoke) => {
      const file = `/fixture-only/private-request-${++counter}.json`; inputFiles.set(file, text);
      try { return await invoke(file); } finally { inputFiles.delete(file); }
    }, { changed() {}, statusChanged() {}, confirmDiscard: async () => true, copyReview: async () => { throw new Error('No submission route belongs to this test'); },
      compareRecovery: async (view) => { comparisons.push(view); } }, undefined, ownStore());
    const owned = { controller, closed: false }; controllers.push(owned);
    await controller.initialize(); await controller.receive({ type: 'open', draftId });
    assert.equal(controller.view.error, null);
    return { controller, calls, comparisons, dispose: () => { if (!owned.closed) { owned.closed = true; controller.dispose(); } },
      fields: (text, name = 'Edited draft') => ({ binding: controller.view.editor.binding, inputText: text, name }),
      action: (type) => controller.receive({ type, binding: controller.view.editor.binding }) };
  };
  const settle = async () => {
    const deadline = Date.now() + 4000;
    do { await turn(); if (!privateWrites && controllers.every(({ controller }) => controller.view.recovery.status !== 'writing')) return; }
    while (Date.now() < deadline);
    assert.fail('The bounded private checkpoint did not settle');
  };
  t.after(async () => { for (const owned of controllers) if (!owned.closed) { owned.closed = true; owned.controller.dispose(); }
    await settle(); await rm(base, { recursive: true, force: true }); });
  const assertEncrypted = async (...texts) => {
    for (const filename of await readdir(directory)) {
      const bytes = await readFile(path.join(directory, filename));
      for (const text of texts) assert.equal(bytes.includes(Buffer.from(text)), false, 'literal recovery text must never exist in a filesystem record');
    }
  };
  return { open, settle, scope, inspect, directory, saves, assertEncrypted, record,
    shared: () => structuredClone(shared), gate: () => { saveGate = { entered: deferred(), release: deferred() }; return saveGate; },
    loseAck: () => { loseNextAck = true; }, loseBeforeCommit: () => { loseBeforeCommit = true; }, peer: (text, name) => apply(text, name) };
}

test('actual encrypted checkpoint survives controller restart; invalid JSON restores only explicitly and successful Save clears its exact checkpoint', async (t) => {
  const f = await fixture(t); const first = await f.open(); const original = first.controller.view.editor.inputText;
  const literal = '{ invalid JSON\r\n\tfixture-only-recovery-sentinel: "🚀 | $()"';
  await first.controller.receive({ type: 'change', ...first.fields(literal, 'Literal recovery') }); await f.settle();
  const cp = await f.inspect.read(f.scope); assert.equal(cp.buffer.text, literal); assert.equal(cp.pendingSave, undefined);
  await f.assertEncrypted(literal, 'Literal recovery', f.scope.authority);
  first.dispose(); await f.settle();
  const restarted = await f.open(); assert.equal(restarted.controller.view.editor.inputText, original);
  assert.equal(restarted.controller.view.recovery.candidateAvailable, true); assert.equal(restarted.controller.view.recovery.restoreAllowed, true);
  assert.equal(f.saves.length, 0); assert.equal(restarted.controller.view.autosave, false);
  await restarted.action('recovery-compare'); assert.equal(restarted.comparisons[0].checkpointText, literal);
  await restarted.action('recovery-restore'); assert.equal(restarted.controller.view.editor.inputText, literal);
  assert.equal(restarted.controller.view.editor.name, 'Literal recovery'); assert.equal(restarted.controller.view.dirty, true);
  assert.equal(f.saves.length, 0); await restarted.action('save'); assert.match(restarted.controller.view.error, /not valid JSON/);
  assert.equal(f.saves.length, 0); assert.equal((await f.inspect.read(f.scope)).buffer.text, literal);
  const valid = ' { "assets": [], "payload": {"literal":"fixture-only-saved-value"} }\r\n';
  await restarted.controller.receive({ type: 'change', ...restarted.fields(valid, 'Explicit save') }); await f.settle();
  await restarted.action('save'); assert.equal(restarted.controller.view.error, null);
  assert.equal(f.saves.length, 1); assert.equal(f.saves[0].text, valid);
  assert.equal(await f.inspect.read(f.scope), null); assert.equal(restarted.controller.view.dirty, false);
  assert.equal(f.shared().revision, 2);
});

test('an AES checkpoint captured after ACK retains literal base whitespace and exact revision digest while newer text survives restart', async (t) => {
  const f = await fixture(t); const first = await f.open(); const gate = f.gate();
  const sent = '{"assets":[],"payload":{"saved":true}}\r\n';
  const newer = '  {\r\n"payload":{"newer":"fixture-only-latest-buffer"},"assets":[] }\n';
  const saving = first.controller.receive({ type: 'save', ...first.fields(sent, 'Shared acknowledged name') });
  await gate.entered.promise;
  await first.controller.receive({ type: 'change', ...first.fields(newer, 'Newer local name') }); await f.settle();
  const before = await f.inspect.read(f.scope); assert.equal(before.pendingSave.snapshot.text, sent); assert.equal(before.buffer.text, newer);
  gate.release.resolve(); await saving; await f.settle();
  const checkpoint = await f.inspect.read(f.scope);
  assert.equal(checkpoint.base.savedText, sent); assert.equal(checkpoint.base.head, heads[1]);
  assert.equal(checkpoint.base.record.revisionSha256, f.record().revisionSha256);
  assert.equal(checkpoint.buffer.text, newer); assert.equal(checkpoint.pendingSave, undefined);
  await f.assertEncrypted(sent, newer, 'Newer local name');
  first.dispose(); await f.settle();
  const restarted = await f.open(); const sharedLiteral = restarted.controller.view.editor.savedText;
  assert.notEqual(sharedLiteral, sent); assert.deepEqual(JSON.parse(sharedLiteral), JSON.parse(sent));
  assert.equal(restarted.controller.view.recovery.restoreAllowed, true);
  await restarted.action('recovery-restore'); assert.equal(restarted.controller.view.error, null);
  assert.equal(restarted.controller.view.editor.inputText, newer); assert.equal(restarted.controller.view.editor.savedText, sent);
  assert.equal(restarted.controller.view.editor.record.revisionSha256, checkpoint.base.record.revisionSha256);
  assert.equal(f.saves.length, 1, 'restart and Restore never request a shared write');
  await restarted.action('save'); assert.equal(restarted.controller.view.error, null);
  assert.equal(f.saves.length, 2); assert.equal(f.saves[1].head, heads[1]); assert.equal(f.saves[1].text, newer);
  assert.equal(await f.inspect.read(f.scope), null);
});

test('lost shared ACK restart reconciles the AES pending operation to its own head and refuses newer-peer stale overwrite', async (t) => {
  for (const peerAdvanced of [false, true]) await t.test(peerAdvanced ? 'peer advanced' : 'acknowledged exact base', async (nested) => {
    const f = await fixture(nested); const first = await f.open(); f.loseAck();
    const sent = '{"assets":[],"payload":{"sent":"fixture-only-committed-request"}}';
    const newer = '{"payload":{"latest":"fixture-only-unshared-newer-text"},"assets":[]}';
    await first.controller.receive({ type: 'save', ...first.fields(sent, 'Committed name') }); await f.settle();
    assert.equal(first.controller.view.durability, 'uncertain');
    await first.controller.receive({ type: 'change', ...first.fields(newer, 'Latest private name') }); await f.settle();
    const pending = (await f.inspect.read(f.scope)).pendingSave;
    assert.equal(pending.snapshot.text, sent); assert.equal(pending.uncertain, true);
    first.dispose(); await f.settle();
    if (peerAdvanced) f.peer('{"payload":{"peer":"fixture-only-peer-value"},"assets":[]}', 'Peer name');
    const restarted = await f.open(); const originalEditor = structuredClone(restarted.controller.view.editor);
    assert.equal(restarted.controller.view.recovery.restoreAllowed, false);
    await restarted.action('save'); assert.equal(f.saves.length, 1);
    await restarted.action('operation-status'); assert.equal(restarted.controller.view.error, null);
    const resolved = await f.inspect.read(f.scope);
    assert.equal(resolved.base.head, heads[1]); assert.equal(resolved.base.savedText, sent); assert.equal(resolved.base.record.revision, 2);
    assert.equal(resolved.pendingSave, undefined); assert.equal(resolved.buffer.text, newer);
    assert.equal(restarted.controller.view.editor.head, originalEditor.head);
    assert.equal(restarted.controller.view.editor.inputText, originalEditor.inputText);
    assert.equal(restarted.controller.view.recovery.restoreAllowed, !peerAdvanced);
    assert.equal(f.saves.length, 1, 'op-status is a read plus private CAS update, never a shared retry');
    await restarted.action('recovery-restore');
    if (peerAdvanced) {
      assert.match(restarted.controller.view.error, /Stale recovery/);
      assert.equal(restarted.controller.view.editor.inputText, originalEditor.inputText);
      assert.equal((await f.inspect.read(f.scope)).checkpointId, resolved.checkpointId);
      await restarted.action('recovery-compare'); assert.equal(restarted.comparisons[0].currentRevision, 3);
      assert.equal(f.saves.length, 1); assert.equal(f.shared().displayName, 'Peer name');
      await f.assertEncrypted(sent, newer, 'Latest private name');
    } else {
      assert.equal(restarted.controller.view.error, null); assert.equal(restarted.controller.view.editor.inputText, newer);
      await restarted.action('save'); assert.equal(restarted.controller.view.error, null);
      assert.equal(f.saves.length, 2); assert.notEqual(f.saves[1].operationId, pending.operationId);
      assert.equal(f.saves[1].head, heads[1]); assert.equal(await f.inspect.read(f.scope), null);
    }
  });
});

test('not-found restored operation needs explicit retry and reuses the exact AES-sealed operation ID, request and head', async (t) => {
  const f = await fixture(t); const first = await f.open(); f.loseBeforeCommit();
  const sent = '{"payload":{"unchanged":"fixture-only-idempotent-retry"},"assets":[]}';
  await first.controller.receive({ type: 'save', ...first.fields(sent, 'Retry name') }); await f.settle();
  const pending = (await f.inspect.read(f.scope)).pendingSave; first.dispose(); await f.settle();
  const restarted = await f.open(); await restarted.action('recovery-restore');
  assert.equal(restarted.controller.view.durability, 'uncertain');
  await restarted.action('save'); assert.match(restarted.controller.view.error, /Operation Status/); assert.equal(f.saves.length, 1);
  await restarted.action('operation-status'); assert.equal(f.saves.length, 1); assert.equal(f.shared().revision, 1);
  await restarted.action('save'); assert.equal(restarted.controller.view.error, null);
  assert.equal(f.saves.length, 2); assert.equal(f.saves[1].operationId, pending.operationId);
  assert.equal(f.saves[1].head, pending.snapshot.head); assert.equal(f.saves[1].text, pending.snapshot.text);
  assert.equal(await f.inspect.read(f.scope), null); assert.equal(f.shared().revision, 2);
});
