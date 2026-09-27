import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readFile, stat, rm, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { initializeDefinition } from '../src/config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const { SharedWorkflowDraftController, WORKFLOW_DRAFT_INPUT_MAX_BYTES, workflowDraftCopilotContextIssue } = await import(path.join(root, 'apps/vscode/src/views/workflow-drafts-model.ts'));
const { withWorkflowDraftInputFile } = await import(path.join(root, 'apps/vscode/src/views/workflow-drafts-input.ts'));
const { createWorkflowDraftRecoveryStore } = await import(path.join(root, 'apps/vscode/src/views/workflow-drafts-recovery.ts'));
const { sharedWorkflowDraftsHtml, SHARED_WORKFLOW_DRAFTS_SCRIPT } = await import(path.join(root, 'apps/vscode/src/views/workflow-drafts-page.ts'));
const { addWorkflowDraftStage, editWorkflowDraftGuide, workflowDraftGuide, reorderWorkflowDraftStage, selectWorkflowDraftCatalog, prepareWorkflowDraftChange, WORKFLOW_DRAFT_STAGES } = await import(path.join(root, 'apps/vscode/src/views/workflow-drafts-guide.ts'));

const repository = path.resolve('/opened/explicit repository');
const draftId = 'WFD-ABC123';
const firstHead = 'a'.repeat(40);
const secondHead = 'b'.repeat(40);
const latestHead = 'c'.repeat(40);
const revision = (number = 1, id = draftId) => ({ draftId: id, displayName: 'Draft', revision: number,
  lifecycleEpoch: 1, revisionSha256: `sha256:${String(number).repeat(64)}` });
const result = (action, data, status = 'read') => ({ resultType: 'workflow-author', status,
  operation: { id: `workflow.author.${action}`, modelPolicy: 'never' },
  capability: { repository: '/approved/shared.git' }, data });
function packagePreview(selected = revision(), overrides = {}) {
  const approvedSource = { repository: '/approved/shared.git', baseRevision: firstHead, observedCommit: firstHead };
  return { kind: 'workflow-authoring-package-preview',
    source: { repository: '/approved/shared.git', draftId: selected.draftId, revision: selected.revision,
      lifecycleEpoch: selected.lifecycleEpoch, revisionSha256: selected.revisionSha256, lifecycle: 'live', head: firstHead },
    approvedSource, planSha256: `sha256:${'d'.repeat(64)}`, findings: [{ code: 'WCA_ARTIFACT_UNRESOLVED', fieldPath: 'definitions.phases', message: 'Actual output choices remain unresolved.' }],
    readiness: { authoring: 'invalid', host: 'discovery-unverified', execution: 'not-run', confirmation: 'absent' },
    catalogChoices: { kind: 'workflow-authoring-catalog-choices', permissionEffect: 'none', membership: 'not-verified', hostMapping: 'not-verified', approvedSource,
      groups: [['execution-task', 'analyze'], ['approval-authority', 'real-reviewers'], ['quality-command', 'actual-check'], ['phase', 'intake']].map(([kind, id]) =>
        ({ kind, choices: [{ ref: { source: 'catalog', kind, id }, label: id }], total: 1, nextCursor: null, unavailable: 0 })) }, ...overrides };
}
function packageShow(selected = revision()) {
  return { kind: 'workflow-authoring-show-view', subject: { kind: 'draft', ...selected },
    assessment: { status: 'invalid', coverage: { schema: 'invalid', references: 'selected-closure', policy: 'pre-change-approved-source',
      graph: 'ordered-input-and-registered-rework-validation', hostEnforcement: 'unavailable', behavior: 'not-evaluated' } },
    missingDecisions: [], graph: { nodes: [], edges: [], coverage: 'ordered-input-and-registered-rework-validation' },
    preview: packagePreview(selected), capabilities: { automaticSaving: 'vscode-opt-in' } };
}

function fixture(overrides = {}, clock, recoveryStore) {
  const calls = []; const copied = []; const inputs = []; const notices = []; const rejected = []; const inputFiles = []; const compared = []; const discardReasons = []; const lockReviews = [];
  let loadedRevision = revision();
  let listHead = firstHead;
  let confirmation = false;
  const runner = async (args, callRoot) => {
    calls.push({ args, root: callRoot });
    assert.equal(callRoot, repository);
    const action = args[2];
    if (overrides[action]) return { result: await overrides[action](args), error: null };
    if (action === 'list') return { result: result(action, { head: listHead, drafts: [loadedRevision], nextCursor: null }), error: null };
    if (action === 'read') return { result: result(action, { head: firstHead, record: loadedRevision,
      payload: { id: 'partial' }, assets: [{ path: 'SKILL.md', contentBase64: Buffer.from('literal').toString('base64'), bytes: 7 }], tombstone: null }), error: null };
    if (action === 'op-status') return { result: result(action, { status: 'not-found', head: listHead,
      operationId: args[3] }), error: null };
    if (action === 'save') {
      loadedRevision = revision(2); listHead = secondHead;
      return { result: result(action, { record: loadedRevision, head: secondHead, operationHead: secondHead,
        operationId: args[args.indexOf('--operation-id') + 1], currentLifecycle: 'live' }, 'shared-acknowledged'), error: null };
    }
    if (action === 'show') return { result: result(action, { view: packageShow(loadedRevision) }), error: null };
    if (action === 'preview') return { result: result(action, { preview: packagePreview(loadedRevision) }), error: null };
    throw new Error(`Unexpected action ${action}`);
  };
  const controller = new SharedWorkflowDraftController(repository, runner, async (text, invoke) => {
    inputs.push(text);
    const file = inputs.length === 1 ? '/private/temporary/input.json' : `/private/temporary/input-${inputs.length}.json`;
    inputFiles.push(file); return invoke(file);
  }, {
    changed: () => notices.push(controller.view.busy),
    editorRejected: (binding, message) => rejected.push({ binding, message }),
    confirmDiscard: async (reason) => { discardReasons.push(reason); return confirmation; },
    compareRecovery: async (value) => compared.push(value),
    confirmLockRepair: async (value) => { lockReviews.push(value); return overrides.confirmLockRepair ? overrides.confirmLockRepair(value, controller) : confirmation; },
    copyReview: async (callRoot, argv, surface) => copied.push({ root: callRoot, argv, surface })
  }, clock, recoveryStore);
  const edit = (inputText = '{"payload":{"id":"unsaved"},"assets":[]}', name = 'Edited') => ({
    binding: controller.view.editor.binding, name, inputText
  });
  const open = async () => { await controller.initialize(); await controller.receive({ type: 'open', draftId }); };
  return { controller, calls, copied, inputs, notices, rejected, inputFiles, compared, discardReasons, lockReviews, open, edit,
    setListHead: (value) => { listHead = value; }, confirm: (value) => { confirmation = value; } };
}

test('private lock actions require host-held inspection and native confirmation, never resume a save', async () => {
  const store = memoryRecoveryStore(); const inspections = []; const repairs = [];
  store.inspectLocks = async (scope) => {
    inspections.push(scope);
    return { scope, locks: [{ schemaVersion: 1, kind: 'scope', scope, scopeSha256: `sha256:${'9'.repeat(64)}`,
      directorySha256: `sha256:${'8'.repeat(64)}`, status: 'dead', reason: '<private owner exited>',
      owner: { pid: 42, processNonce: 'private-process', lockNonce: 'private-lock', createdAt: '2026-01-01T00:00:00.000Z' },
      repairSupported: true, reviewId: 'host-ticket' }] };
  };
  store.repairLock = async (scope, ticket, confirm) => {
    repairs.push({ scope, ticket });
    const allowed = await confirm((await store.inspectLocks(scope)).locks[0]);
    return { status: allowed ? 'repaired' : 'cancelled', kind: 'scope', checkpointChanged: false, keyChanged: false };
  };
  const f = fixture({}, undefined, store); await f.open(); const binding = f.controller.view.editor.binding;
  const before = f.controller.view.editor.inputText;
  await f.controller.receive({ type: 'recovery-repair-lock', binding, lockKind: 'scope' });
  assert.match(f.controller.view.error, /Inspect a proven-dead/); assert.equal(repairs.length, 0);
  await f.controller.receive({ type: 'recovery-inspect-locks', binding });
  const html = sharedWorkflowDraftsHtml(f.controller.view);
  assert.match(html, /Review dead lock repair/); assert.match(html, /&lt;private owner exited&gt;/); assert.doesNotMatch(html, /host-ticket/);
  await f.controller.receive({ type: 'recovery-repair-lock', binding, lockKind: 'scope', confirmed: true });
  assert.match(f.controller.view.error, /unsupported fields/); assert.equal(repairs.length, 0);
  await f.controller.receive({ type: 'recovery-repair-lock', binding, lockKind: 'scope' });
  assert.equal(f.lockReviews.length, 1); assert.match(f.controller.view.notice, /cancelled/);
  await f.controller.receive({ type: 'recovery-inspect-locks', binding }); f.confirm(true);
  await f.controller.receive({ type: 'recovery-repair-lock', binding, lockKind: 'scope' });
  assert.match(f.controller.view.notice, /No save|no save/); assert.equal(f.controller.view.editor.inputText, before);
  assert.equal(f.controller.view.autosave, false); assert.equal(f.calls.filter((call) => call.args[2] === 'save').length, 0);
  assert.equal(repairs.at(-1).ticket, 'host-ticket'); assert.equal(inspections[0].draftId, draftId);
});

test('private lock repair rechecks the editor after native review and rejects another scope', async () => {
  const store = memoryRecoveryStore(); let removed = false;
  store.inspectLocks = async (scope) => ({ scope, locks: [{ schemaVersion: 1, kind: 'scope', scope,
    scopeSha256: null, directorySha256: `sha256:${'8'.repeat(64)}`, status: 'dead', reason: 'dead in same domain',
    owner: null, repairSupported: true, reviewId: 'ticket' }] });
  store.repairLock = async (scope, ticket, confirm) => {
    if (await confirm((await store.inspectLocks(scope)).locks[0])) removed = true;
    return { status: 'repaired', kind: 'scope', checkpointChanged: false, keyChanged: false };
  };
  const f = fixture({ confirmLockRepair: async (_value, controller) => {
    controller.view.editor.inputText = '{"payload":{"newer":"retain"}}'; return true;
  } }, undefined, store); await f.open(); const binding = f.controller.view.editor.binding;
  await f.controller.receive({ type: 'recovery-inspect-locks', binding });
  await f.controller.receive({ type: 'recovery-repair-lock', binding, lockKind: 'scope' });
  assert.equal(removed, false); assert.match(f.controller.view.error, /New captured edits/);
  assert.match(f.controller.view.editor.inputText, /newer/);
});

test('guided edit and linked copy prepare exact raw parent without removing prior decisions or creating shared components', () => {
  const envelope = JSON.stringify({ payload: { schema: 'sflow-workflow-request@2', id: 'new-copy', label: 'Package review', rationale: 'preserve me' }, assets: [] });
  const choice = { id: 'original', rawDefinitionSha256: `sha256:${'d'.repeat(64)}`, phaseOrder: ['intake', 'conformance'] };
  for (const intent of ['edit', 'fork']) {
    const prepared = JSON.parse(prepareWorkflowDraftChange(envelope, intent, choice, firstHead));
    const target = intent === 'edit' ? 'original' : 'new-copy';
    assert.equal(prepared.payload.rationale, 'preserve me'); assert.deepEqual(prepared.assets, []);
    assert.equal(prepared.payload.intent, intent); assert.equal(prepared.payload.baseRevision, firstHead);
    assert.deepEqual(prepared.payload.definitions.workflows, [{ id: target, phases: choice.phaseOrder }]);
    assert.equal(prepared.payload.changes[0].expectedDefinitionSha256, choice.rawDefinitionSha256);
    assert.throws(() => addWorkflowDraftStage(JSON.stringify(prepared), 'extra'), /reuses approved stages/);
    const updated = JSON.parse(editWorkflowDraftGuide(JSON.stringify(prepared), 'workflow-label', 'New label'));
    assert.equal(updated.payload.definitions.workflows[0].label, 'New label');
    assert.deepEqual(updated.payload.changes, prepared.payload.changes);
  }
  for (const extra of [{ definitions: { phases: [{ id: 'private-note' }] } }, { changes: [] }, { bindings: {} }]) {
    const input = JSON.stringify({ payload: { ...JSON.parse(envelope).payload, ...extra }, assets: [] });
    assert.throws(() => prepareWorkflowDraftChange(input, 'edit', choice, firstHead), /retained, not deleted/);
  }
  assert.throws(() => prepareWorkflowDraftChange(envelope, 'edit', { ...choice, rawDefinitionSha256: 'guessed' }, firstHead), /exact captured/);
});

test('shared draft editor reaches only the existing CLI at the frozen explicit root', async () => {
  const f = fixture(); await f.open();
  assert.deepEqual(f.calls.map((call) => call.args), [
    ['workflow', 'author', 'list', '--limit', '64', '--json'],
    ['workflow', 'author', 'read', draftId, '--json']
  ]);
  const input = '{"payload":{"unknownBinding":"keep","phaseOrder":[]},"assets":[{"path":"../not-read","content":"literal only"}]}';
  await f.controller.receive({ type: 'save', ...f.edit(input) });
  const args = f.calls.find((call) => call.args[2] === 'save').args;
  assert.equal(args[args.indexOf('--input') + 1], '/private/temporary/input.json');
  assert.equal(args[args.indexOf('--expected-head') + 1], firstHead);
  assert.equal(args[args.indexOf('--expected-authority') + 1], '/approved/shared.git');
  assert.equal(args[args.indexOf('--epoch') + 1], '1');
  assert.equal(args[args.indexOf('--name') + 1], 'Edited');
  assert.deepEqual(f.inputs, [input]);
  assert.equal(f.controller.view.dirty, false);
  assert.equal(f.controller.view.editor.record.revision, 2);
  assert.equal(f.controller.view.editor.inputText, input);
  assert.match(f.controller.view.notice, /storage only/);
});

test('list refresh never rebases an unsaved draft and conflict retains exact editor text', async () => {
  const f = fixture({ save: async () => { throw new Error('WCA_DRAFT_CONFLICT: Another client won compare-and-swap.'); } });
  await f.open(); const fields = f.edit();
  await f.controller.receive({ type: 'change', ...fields });
  f.setListHead(latestHead); await f.controller.receive({ type: 'refresh', ...fields });
  assert.equal(f.controller.view.listHead, latestHead);
  assert.equal(f.controller.view.editor.head, firstHead);
  await f.controller.receive({ type: 'save', ...fields });
  assert.match(f.controller.view.error, /WCA_DRAFT_CONFLICT/);
  assert.equal(f.controller.view.editor.inputText, fields.inputText);
  assert.equal(f.controller.view.editor.name, fields.name);
  assert.equal(f.controller.view.dirty, true);
  assert.equal(f.controller.view.busy, false);
  const operationId = f.controller.view.operationId;
  await f.controller.receive({ type: 'save', ...fields });
  assert.equal(f.controller.view.operationId, operationId, 'retry the exact request/operation, do not silently create another write');
  const saves = f.calls.filter((call) => call.args[2] === 'save');
  const semanticArgs = (args) => args.map((argument, index) => args[index - 1] === '--input' ? '[fresh private input]' : argument);
  assert.deepEqual(semanticArgs(saves[0].args), semanticArgs(saves[1].args));
});

test('explicit Reload warns before discarding text and stale document messages cannot edit reloaded state', async () => {
  const f = fixture(); await f.open(); const fields = f.edit();
  await f.controller.receive({ type: 'change', ...fields });
  await f.controller.receive({ type: 'reload', ...fields });
  assert.equal(f.controller.view.editor.inputText, fields.inputText, 'Cancel preserves editor');
  assert.equal(f.calls.filter((call) => call.args[2] === 'read').length, 1);
  f.confirm(true); await f.controller.receive({ type: 'reload', ...fields });
  assert.equal(f.controller.view.dirty, false);
  assert.notEqual(f.controller.view.editor.binding, fields.binding);
  const baseline = f.controller.view.editor.inputText;
  await f.controller.receive({ type: 'save', ...fields });
  await f.controller.receive({ type: 'change', ...fields });
  assert.equal(f.controller.view.editor.inputText, baseline);
  assert.equal(f.calls.filter((call) => call.args[2] === 'save').length, 0);
});

test('empty Create first fresh-lists and a lost acknowledgement retries the exact same identity', async () => {
  let attempts = 0;
  const f = fixture({ create: async (args) => {
    if (++attempts === 1) throw new Error('Shared write acknowledgement unavailable.');
    return result('create', { record: revision(1, args[3]), operationId: args[args.indexOf('--operation-id') + 1] }, 'shared-acknowledged');
  }, read: async (args) => result('read', { head: secondHead, record: revision(1, args[3]), payload: {}, assets: [], tombstone: null }) });
  await f.controller.initialize(); f.setListHead(secondHead);
  await f.controller.receive({ type: 'create' });
  assert.deepEqual(f.calls.slice(-2).map((call) => call.args[2]), ['list', 'create']);
  const first = f.calls.at(-1).args;
  assert.equal(first[first.indexOf('--expected-head') + 1], secondHead);
  assert.equal(first[first.indexOf('--expected-authority') + 1], '/approved/shared.git');
  assert.ok(!first.includes('--input'));
  assert.ok(!first.includes('--name'));
  assert.match(first[3], /^WFD-[A-F0-9]{12}$/);
  await f.controller.receive({ type: 'create' });
  assert.deepEqual(f.calls.filter((call) => call.args[2] === 'create')[1].args, first);
  assert.equal(f.controller.view.busy, false);
  assert.equal(f.controller.view.editor.record.draftId, first[3]);
});

test('idempotent historical save acknowledgement does not widen the next compare-and-swap head', async () => {
  const f = fixture({ save: async (args) => result('save', {
    record: revision(2), head: latestHead, operationHead: secondHead,
    operationId: args[args.indexOf('--operation-id') + 1], currentLifecycle: 'live', replayed: true
  }, 'shared-acknowledged') });
  await f.open(); await f.controller.receive({ type: 'save', ...f.edit() });
  assert.equal(f.controller.view.editor.head, secondHead);
  assert.notEqual(f.controller.view.editor.head, latestHead);
});

test('Create retry resolves an existing acknowledgement before allocating or writing another draft', async () => {
  let original;
  const f = fixture({
    create: async (args) => { original = args; throw new Error('Lost shared acknowledgement'); },
    'op-status': async (args) => result('op-status', { status: 'shared-acknowledged', head: latestHead,
      record: revision(1, original[3]), operationId: args[3], currentLifecycle: 'live' }),
    read: async (args) => result('read', { head: latestHead, record: revision(1, args[3]), payload: {}, assets: [], tombstone: null })
  });
  await f.controller.initialize(); await f.controller.receive({ type: 'create' });
  await f.controller.receive({ type: 'create' });
  assert.equal(f.calls.filter((call) => call.args[2] === 'create').length, 1);
  assert.equal(f.controller.view.editor.record.draftId, original[3]);
  assert.match(f.controller.view.notice, /no duplicate was created/);
});

test('losing Create compare-and-swap can retry the same identity only after a fresh not-found observation', async () => {
  let attempts = 0;
  const f = fixture({ create: async (args) => {
    if (++attempts === 1) throw new Error('WCA_DRAFT_CONFLICT');
    return result('create', { record: revision(1, args[3]), operationId: args[args.indexOf('--operation-id') + 1] }, 'shared-acknowledged');
  }, read: async (args) => result('read', { head: latestHead, record: revision(1, args[3]), payload: {}, assets: [], tombstone: null }) });
  await f.controller.initialize(); await f.controller.receive({ type: 'create' });
  f.setListHead(latestHead); await f.controller.receive({ type: 'create' });
  const creates = f.calls.filter((call) => call.args[2] === 'create').map((call) => call.args);
  assert.equal(creates.length, 2); assert.equal(creates[0][3], creates[1][3]);
  assert.equal(creates[0][creates[0].indexOf('--operation-id') + 1], creates[1][creates[1].indexOf('--operation-id') + 1]);
  assert.equal(creates[1][creates[1].indexOf('--expected-head') + 1], latestHead);
  const index = f.calls.findLastIndex((call) => call.args[2] === 'create');
  assert.equal(f.calls[index - 1].args[2], 'op-status');
});

test('read-only Show pins saved revision, preserves unsaved text and cannot approve or execute', async () => {
  const f = fixture(); await f.open(); const fields = f.edit();
  await f.controller.receive({ type: 'show', ...fields });
  assert.deepEqual(f.calls.at(-1).args, ['workflow', 'author', 'show', draftId, '--revision', '1', '--json']);
  assert.equal(f.controller.view.editor.inputText, fields.inputText);
  assert.equal(f.controller.view.dirty, true);
  assert.match(f.controller.view.notice, /not unsaved editor text/);
  assert.match(f.controller.view.notice, /Compiler coverage.*static validation is not approval, host acceptance/);
  const html = sharedWorkflowDraftsHtml(f.controller.view);
  assert.match(html, /Authoring assessment: invalid/); assert.match(html, /Request schema<\/dt><dd>invalid/);
  assert.match(html, /Native host enforcement<\/dt><dd>unavailable/);
  assert.doesNotMatch(html, /storage-only projection|Complete-package validation, graph coverage/);
  await f.controller.receive({ type: 'approve', ...fields });
  assert.match(f.controller.view.error, /not supported/);
  assert.equal(f.calls.filter((call) => !['list', 'read', 'show'].includes(call.args[2])).length, 0);
});

test('Show refuses a mismatched saved tuple and never republishes an assessment after newer captured edits', async () => {
  for (const change of [(v) => { v.subject.revision = 2; }, (v) => { v.subject.lifecycleEpoch = 2; },
    (v) => { v.subject.revisionSha256 = revision(2).revisionSha256; }]) {
    const f = fixture({ show: async () => { const view = packageShow(); change(view); return result('show', { view }); } });
    await f.open(); await f.controller.receive({ type: 'show', binding: f.controller.view.editor.binding });
    assert.equal(f.controller.view.show, null); assert.match(f.controller.view.error, /retained saved revision/); f.controller.dispose();
  }
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ show: async () => { await gate; return result('show', { view: packageShow() }); } }); await f.open();
  const showing = f.controller.receive({ type: 'show', binding: f.controller.view.editor.binding }); await settle();
  const changed = f.edit(); await f.controller.receive({ type: 'change', ...changed }); release(); await showing;
  assert.equal(f.controller.view.show, null); assert.equal(f.controller.view.editor.inputText, changed.inputText);
  assert.match(f.controller.view.error, /New captured edits arrived during navigation/); f.controller.dispose();
});

test('Shell and Copilot deletion routes are copy-only and use retained subject, never a message command', async () => {
  const f = fixture(); await f.open();
  await f.controller.receive({ type: 'terminal-review', ...f.edit() });
  await f.controller.receive({ type: 'copilot-review', ...f.edit() });
  assert.deepEqual(f.copied, [
    { root: repository, argv: ['workflow', 'author', 'delete', draftId], surface: 'shell' },
    { root: repository, argv: ['workflow', 'author', 'delete', draftId], surface: 'copilot' }
  ]);
  assert.equal(f.calls.some((call) => call.args[2] === 'delete'), false);
  await f.controller.receive({ type: 'save', ...f.edit(), root: '/other', expectedHead: latestHead });
  assert.match(f.controller.view.error, /unsupported fields/);
  assert.equal(f.calls.some((call) => call.args[2] === 'save'), false);
});

test('Copilot route copy requires one exact opened folder while Shell remains explicitly rooted', () => {
  const refusal = 'Copilot folder context is ambiguous; use the rooted Shell review command or open this exact repository alone.';
  assert.equal(workflowDraftCopilotContextIssue('/opened/repo', ['/opened/repo'], 'darwin'), null);
  assert.equal(workflowDraftCopilotContextIssue('/opened/repo/', ['/opened/repo'], 'linux'), null);
  for (const folders of [[], ['/opened/repo', '/other'], ['/other'], ['relative']]) {
    assert.equal(workflowDraftCopilotContextIssue('/opened/repo', folders, 'linux'), refusal);
  }
  assert.equal(workflowDraftCopilotContextIssue('C:\\work\\repo', ['c:\\work\\repo'], 'win32'), null);
  assert.equal(workflowDraftCopilotContextIssue('C:\\work\\repo', ['D:\\work\\repo'], 'win32'), refusal);
  assert.equal(workflowDraftCopilotContextIssue('C:\\work\\repo', ['C:\\work\\repo-other'], 'win32'), refusal);
});

test('busy lease settles on failures and overlapping messages cannot start a second write', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const f = fixture({ save: async () => { await pending; throw new Error('Transport timeout'); } });
  await f.open(); const fields = f.edit();
  const saving = f.controller.receive({ type: 'save', ...fields });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.controller.view.busy, true);
  await f.controller.receive({ type: 'save', ...fields });
  await f.controller.receive({ type: 'reload', ...fields });
  release(); await saving;
  assert.equal(f.calls.filter((call) => call.args[2] === 'save').length, 1);
  assert.equal(f.controller.view.busy, false);
  assert.equal(f.controller.view.dirty, true);
  assert.match(f.controller.view.error, /Transport timeout/);
});

test('Save timeout never advertises a deleted temp replay and status inspection precedes explicit same-operation retry', async () => {
  let attempts = 0;
  const f = fixture({ save: async (args) => {
    if (++attempts === 1) throw new Error('The Singularity Flow CLI did not finish within 90 seconds. The interrupted operation may have retained recoverable transaction state.\n\nRun this exact command from a terminal:\ncd /repo && singularity-flow workflow author save WFD-ABC123 --input /already-deleted/input.json');
    return result('save', { record: revision(2), head: secondHead, operationHead: secondHead,
      operationId: args[args.indexOf('--operation-id') + 1], currentLifecycle: 'live' }, 'shared-acknowledged');
  } });
  await f.open(); const fields = f.edit(); await f.controller.receive({ type: 'save', ...fields });
  const operationId = f.controller.view.operationId;
  assert.match(f.controller.view.error, new RegExp(`op-status ${operationId} first`));
  assert.match(f.controller.view.error, /explicit Save with the retained editor text/);
  assert.doesNotMatch(f.controller.view.error, /Run this exact command|already-deleted|cd \/repo/);
  assert.equal(f.controller.view.editor.inputText, fields.inputText);
  assert.equal(f.controller.view.dirty, true);
  await f.controller.receive({ type: 'operation-status', ...fields });
  assert.deepEqual(f.calls.at(-1).args, ['workflow', 'author', 'op-status', operationId, '--json']);
  assert.match(f.controller.view.notice, /not found.*explicit Save/s);
  await f.controller.receive({ type: 'save', ...fields });
  const saves = f.calls.filter((call) => call.args[2] === 'save').map((call) => call.args);
  assert.equal(saves.length, 2);
  assert.equal(saves[0][saves[0].indexOf('--operation-id') + 1], saves[1][saves[1].indexOf('--operation-id') + 1]);
  assert.notEqual(saves[0][saves[0].indexOf('--input') + 1], saves[1][saves[1].indexOf('--input') + 1]);
  assert.deepEqual(f.inputs, [fields.inputText, fields.inputText]);
  assert.equal(f.controller.view.error, null);
});

test('Save failure retains a bounded reported refusal code without echoing the deleted input invocation', async () => {
  const f = fixture({ save: async () => { throw new Error('Command failed: node CLI workflow author save WFD-ABC123 --input /deleted/input.json\n{"resultType":"command-result","code":"WCA_DRAFT_CONFLICT","message":"Another client won compare-and-swap"}'); } });
  await f.open(); await f.controller.receive({ type: 'save', ...f.edit() });
  assert.match(f.controller.view.error, /reported WCA_DRAFT_CONFLICT/);
  assert.doesNotMatch(f.controller.view.error, /\/deleted|Command failed|node CLI|resultType/);
  assert.match(f.controller.view.error, /op-status .* first/);
});

test('over-limit host fallback rejects transient input without re-rendering the previous bounded editor', async () => {
  const f = fixture(); await f.open();
  const prior = f.controller.view.editor.inputText;
  const renders = f.notices.length; const calls = f.calls.length;
  const oversized = 'x'.repeat(WORKFLOW_DRAFT_INPUT_MAX_BYTES + 1);
  await f.controller.receive({ type: 'save', ...f.edit(oversized) });
  assert.equal(f.controller.view.editor.inputText, prior, 'oversized text is not retained in host state');
  assert.equal(f.notices.length, renders, 'do not replace the current DOM with stale bounded text');
  assert.equal(f.calls.length, calls); assert.equal(f.inputs.length, 0);
  assert.deepEqual(f.rejected, [{ binding: f.controller.view.editor.binding,
    message: 'Editor input exceeds its bounded single-name/JSON transport limit.' }]);
});

test('actual page script keeps oversized pasted DOM text without posting it and resumes only after reduction', () => {
  const posted = []; const handlers = {}; const hostHandlers = {};
  const fields = {
    'draft-binding': { value: 'retained-binding' }, 'draft-name': { id: 'draft-name', value: 'Name' },
    'draft-input': { id: 'draft-input', value: 'x'.repeat(WORKFLOW_DRAFT_INPUT_MAX_BYTES + 1) },
    'draft-dirty': { textContent: '' }, 'draft-input-error': { textContent: '', hidden: true }
  };
  class Element { closest() { return this; } }
  class HTMLButtonElement extends Element { constructor(action) { super(); this.dataset = { draftAction: action }; this.disabled = false; } }
  runInNewContext(SHARED_WORKFLOW_DRAFTS_SCRIPT, {
    window: { __sfVscode: { postMessage: (message) => posted.push(message) }, addEventListener: (type, listener) => { hostHandlers[type] = listener; } },
    document: { getElementById: (id) => fields[id], addEventListener: (type, listener) => { handlers[type] = listener; } },
    Element, HTMLButtonElement, TextEncoder
  });
  handlers.input({ target: fields['draft-input'] });
  handlers.click({ target: new HTMLButtonElement('save') });
  handlers.click({ target: new HTMLButtonElement('refresh') });
  assert.equal(posted.length, 0, 'the oversized literal never crosses the host boundary');
  assert.equal(fields['draft-input'].value.length, WORKFLOW_DRAFT_INPUT_MAX_BYTES + 1);
  assert.match(fields['draft-input-error'].textContent, /5 MiB.*only in this visible editor.*not sent or saved/);
  assert.equal(fields['draft-input-error'].hidden, false);
  hostHandlers.message({ data: { type: 'draft-status', binding: 'retained-binding', durability: 'Shared revision 2 · all captured changes saved',
    busy: false, autosave: 'On', revision: '2', operation: 'one', error: '', hasShow: false } });
  assert.match(fields['draft-dirty'].textContent, /Visible text is not captured or saved.*prior bounded checkpoint/);
  assert.equal(fields['draft-input'].value.length, WORKFLOW_DRAFT_INPUT_MAX_BYTES + 1);
  assert.equal(posted.length, 0);
  hostHandlers.message({ data: { type: 'editor-rejected', binding: 'retained-binding', message: 'Rejected by bounded host preflight.' } });
  assert.equal(fields['draft-input'].value.length, WORKFLOW_DRAFT_INPUT_MAX_BYTES + 1);
  assert.match(fields['draft-input-error'].textContent, /visible text has not been replaced/);
  fields['draft-input'].value = '{"payload":{}}'; handlers.input({ target: fields['draft-input'] });
  assert.equal(posted.length, 1); assert.equal(posted[0].inputText, fields['draft-input'].value);
  assert.equal(fields['draft-input-error'].hidden, true);
  handlers.click({ target: new HTMLButtonElement('save') });
  assert.equal(posted.at(-1).type, 'save'); assert.equal(posted.at(-1).inputText, fields['draft-input'].value);
});

test('binary assets remain read-only, literal duplicates are not silently canonicalized, and invalid inputs never reach CLI', async () => {
  const f = fixture({ read: async () => result('read', { head: firstHead, record: revision(), payload: {},
    assets: [{ path: 'binary.dat', bytes: 1, contentBase64: '/w==' }], tombstone: null }) });
  await f.open(); assert.match(f.controller.view.editor.readOnlyReason, /binary assets/);
  await f.controller.receive({ type: 'save', ...f.edit() });
  assert.equal(f.calls.some((call) => call.args[2] === 'save'), false);
  const plain = fixture(); await plain.open();
  const duplicate = '{"payload":{"id":"one","id":"two"},"assets":[]}';
  await plain.controller.receive({ type: 'save', ...plain.edit(duplicate) });
  assert.equal(plain.inputs[0], duplicate, 'CLI owns duplicate-key refusal; never parse and rewrite user bytes');
  await plain.controller.receive({ type: 'save', ...plain.edit('{broken') });
  assert.match(plain.controller.view.error, /not valid JSON/);
  const count = plain.calls.length;
  await plain.controller.receive({ type: 'save', ...plain.edit(' '.repeat(WORKFLOW_DRAFT_INPUT_MAX_BYTES + 1)) });
  assert.equal(plain.calls.length, count);
  assert.match(plain.controller.view.error, /transport limit/);
  await plain.controller.receive({ type: 'save', ...plain.edit('{"payload":{"text":"\ud800"}}') });
  assert.match(plain.controller.view.error, /well-formed literal Unicode/);
  assert.throws(() => new SharedWorkflowDraftController('', async () => ({}), async () => {}, {}), /explicit repository/);
});

test('literal UTF-8 BOM asset bytes survive the editor round trip exactly', async () => {
  const content = '\ufeffliteral asset with BOM';
  const bytes = Buffer.from(content, 'utf8');
  const f = fixture({ read: async () => result('read', { head: firstHead, record: revision(), payload: {},
    assets: [{ path: 'with-bom.md', bytes: bytes.length, contentBase64: bytes.toString('base64') }], tombstone: null }) });
  await f.open();
  assert.equal(JSON.parse(f.controller.view.editor.inputText).assets[0].content, content);
  await f.controller.receive({ type: 'save', ...f.edit(f.controller.view.editor.inputText, 'Rename only') });
  assert.deepEqual(Buffer.from(JSON.parse(f.inputs[0]).assets[0].content, 'utf8'), bytes);
});

test('a refreshed replacement authority cannot silently rebind a retained draft write', async () => {
  let observedAuthority = '/approved/first.git';
  const f = fixture({
    list: async () => ({ ...result('list', { head: firstHead, drafts: [revision()], nextCursor: null }), capability: { repository: observedAuthority } }),
    read: async () => ({ ...result('read', { head: firstHead, record: revision(), payload: {}, assets: [], tombstone: null }), capability: { repository: observedAuthority } })
  });
  await f.open(); assert.equal(f.controller.view.editor.authority, observedAuthority);
  observedAuthority = '/approved/replacement.git';
  await f.controller.receive({ type: 'refresh', ...f.edit() });
  assert.equal(f.controller.view.authority, observedAuthority);
  assert.equal(f.controller.view.editor.authority, '/approved/first.git');
  await f.controller.receive({ type: 'save', ...f.edit() });
  const save = f.calls.find((call) => call.args[2] === 'save').args;
  assert.equal(save[save.indexOf('--expected-authority') + 1], '/approved/first.git');
});

test('read and Reload refuse destination changes without replacing the retained editor buffer', async () => {
  let changing = false;
  const f = fixture({ read: async () => ({ ...result('read', {
    head: firstHead, record: revision(), payload: {}, assets: [], tombstone: null
  }), capability: { repository: changing ? '/replacement/shared.git' : '/approved/shared.git' } }) });
  await f.open(); const fields = f.edit();
  await f.controller.receive({ type: 'change', ...fields });
  changing = true; f.confirm(true);
  await f.controller.receive({ type: 'reload', ...fields });
  assert.match(f.controller.view.error, /authority changed during this read/);
  assert.equal(f.controller.view.editor.inputText, fields.inputText);
  assert.equal(f.controller.view.editor.name, fields.name);
  assert.equal(f.controller.view.editor.authority, '/approved/shared.git');
  assert.equal(f.controller.view.dirty, true);
});

test('repeated refused Open cannot pair the old authority list with a new read destination', async () => {
  let observedAuthority = '/approved/first.git';
  const f = fixture({
    list: async () => ({ ...result('list', { head: firstHead, drafts: [revision()], nextCursor: null }), capability: { repository: observedAuthority } }),
    read: async () => ({ ...result('read', { head: secondHead, record: revision(), payload: {}, assets: [], tombstone: null }), capability: { repository: observedAuthority } })
  });
  await f.controller.initialize();
  const originalList = structuredClone({ drafts: f.controller.view.drafts, head: f.controller.view.listHead,
    authority: f.controller.view.authority });
  observedAuthority = '/replacement/second.git';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await f.controller.receive({ type: 'open', draftId });
    assert.match(f.controller.view.error, /authority changed during this read/);
    assert.equal(f.controller.view.editor, null);
    assert.deepEqual({ drafts: f.controller.view.drafts, head: f.controller.view.listHead,
      authority: f.controller.view.authority }, originalList);
  }
  await f.controller.receive({ type: 'refresh' });
  assert.equal(f.controller.view.authority, observedAuthority);
  await f.controller.receive({ type: 'open', draftId });
  assert.equal(f.controller.view.error, null);
  assert.equal(f.controller.view.editor.authority, observedAuthority);
});

test('malformed or rejected replacement list retains the entire previously validated list observation', async () => {
  let replacement = null;
  const f = fixture({ list: async () => {
    if (replacement instanceof Error) throw replacement;
    return replacement ?? result('list', { head: firstHead, drafts: [revision()], nextCursor: null });
  } });
  await f.controller.initialize();
  const originalList = structuredClone({ drafts: f.controller.view.drafts, head: f.controller.view.listHead,
    authority: f.controller.view.authority });
  for (const invalid of [
    { ...result('list', { head: secondHead, drafts: [revision(2)], nextCursor: null }), capability: { repository: '' } },
    { ...result('list', { head: 'not-an-exact-head', drafts: [revision(2)], nextCursor: null }), capability: { repository: '/replacement/shared.git' } },
    { ...result('list', { head: secondHead, drafts: [revision(2), { draftId: 'bad' }], nextCursor: null }), capability: { repository: '/replacement/shared.git' } },
    { ...result('list', { head: secondHead, drafts: [revision(2)], nextCursor: 1 }), capability: { repository: '/replacement/shared.git' } },
    { ...result('list', { head: secondHead, drafts: [revision(2)], nextCursor: null }, 'refused'), capability: { repository: '/replacement/shared.git' } },
    new Error('Approved authority refresh refused')
  ]) {
    replacement = invalid; await f.controller.receive({ type: 'refresh' });
    assert.ok(f.controller.view.error);
    assert.deepEqual({ drafts: f.controller.view.drafts, head: f.controller.view.listHead,
      authority: f.controller.view.authority }, originalList);
    assert.equal(f.controller.view.busy, false);
  }
});

test('temporary literal input file is private, byte-exact, bounded and removed on success or refusal', async () => {
  const input = '{"payload":{"unknown":"literal"},"assets":[]}';
  let captured;
  const value = await withWorkflowDraftInputFile(input, async (file) => {
    captured = file; assert.equal(await readFile(file, 'utf8'), input);
    assert.equal(path.basename(file), 'input.json');
    assert.ok(!file.startsWith(repository));
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
    }
    return 'shared-acknowledged';
  });
  assert.equal(value, 'shared-acknowledged'); await assert.rejects(access(captured), /ENOENT/);
  await assert.rejects(withWorkflowDraftInputFile(input, async (file) => { captured = file; throw new Error('CLI refusal'); }), /CLI refusal/);
  await assert.rejects(access(captured), /ENOENT/);
  await assert.rejects(withWorkflowDraftInputFile('x'.repeat(WORKFLOW_DRAFT_INPUT_MAX_BYTES + 1), async () => {}), /bounded interactive/);
  await assert.rejects(withWorkflowDraftInputFile('{"payload":{"text":"\ud800"}}', async () => {}), /bounded interactive/);
  let warnings = 0; let retained;
  assert.equal(await withWorkflowDraftInputFile(input, async (file) => { retained = path.dirname(file); return 'durable receipt'; }, {
    remove: async () => { throw new Error('EBUSY'); }, cleanupWarning: () => { warnings += 1; }
  }), 'durable receipt');
  assert.equal(warnings, 1); await rm(retained, { recursive: true, force: true });
  assert.equal(await withWorkflowDraftInputFile(input, async (file) => { retained = path.dirname(file); return 'retained acknowledgement'; }, {
    remove: async () => { throw new Error('EBUSY'); }, cleanupWarning: () => { throw new Error('UI reporting failed'); }
  }), 'retained acknowledgement');
  await rm(retained, { recursive: true, force: true });
});

test('draft page escapes all untrusted text, states unavailable coverage and exposes no executing delete', async () => {
  const f = fixture(); await f.open();
  f.controller.view.repository = '</textarea><script>unsafe()</script>';
  f.controller.view.authority = '<img src=x onerror=unsafe()>';
  f.controller.view.editor.name = '<b>unsafe name</b>';
  f.controller.view.editor.inputText = '{"payload":{"text":"</textarea><script>unsafe()</script>"}}';
  f.controller.view.error = '<img src=x>';
  f.controller.view.show = { missingDecisions: [{ label: '<a>unsafe</a>', fieldPath: '<code>' }], assessment: { coverage: 'unavailable' } };
  const html = sharedWorkflowDraftsHtml(f.controller.view);
  assert.doesNotMatch(html, /<script>|<img src=|<b>unsafe|<a>unsafe/);
  assert.match(html, /&lt;\/textarea&gt;&lt;script&gt;/);
  assert.match(html, /Shared autosave requires explicit editing-scope opt-in/);
  assert.match(html, /execution readiness are unavailable/);
  assert.match(html, /data-draft-action="save"/);
  assert.match(html, /data-draft-action="show"/);
  assert.doesNotMatch(html, /data-draft-action="delete"|data-draft-action="approve"|data-draft-action="run"/);
  assert.match(html, /Copy Shell review command/); assert.match(html, /Copy Copilot handoff/);
  assert.match(SHARED_WORKFLOW_DRAFTS_SCRIPT, /const fields = editorFields\(\)/);
  assert.match(SHARED_WORKFLOW_DRAFTS_SCRIPT, /if \(!fields\) return/);
  assert.doesNotMatch(SHARED_WORKFLOW_DRAFTS_SCRIPT, /localStorage|sessionStorage|setState|setInterval|fetch\(|innerHTML/);
  assert.doesNotThrow(() => new Function(SHARED_WORKFLOW_DRAFTS_SCRIPT));
  const panel = await readFile(path.join(root, 'apps/vscode/src/views/workflow-drafts.ts'), 'utf8');
  assert.match(panel, /contentSecurityPolicy\(this\.panel\.webview, token\)/);
  assert.match(panel, /showSharedWorkflowDrafts/);
  assert.match(panel, /surface === 'copilot'[\s\S]*workflowDraftCopilotContextIssue\(repository/);
  assert.match(panel, /vscode\.workspace\.workspaceFolders/);
  assert.match(panel, /terminalCommand\(repository, guidance\.argv\)/);
  assert.match(panel, /showWarningMessage\([\s\S]*Cancel keeps the text and checkpoint/);
  assert.doesNotMatch(panel, /createTerminal|sendText|issueActionAuthorization|useRepository|openGitDraftStore/);
  assert.equal([...panel.matchAll(/\bexecuteCommand\(/gu)].length, 1);
  assert.match(panel, /vscode\.commands\.executeCommand\('vscode\.diff',/);
});

const settle = async () => { for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve)); };
function fakeClock() {
  let now = 0; let sequence = 0; const timers = new Map();
  return { now: () => now, set: (callback, milliseconds) => { const id = ++sequence; timers.set(id, { at: now + milliseconds, callback }); return id; },
    clear: (id) => timers.delete(id), count: () => timers.size,
    advance: async (milliseconds) => {
      const until = now + milliseconds;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await settle();
      }
      now = until; await settle();
    } };
}

function memoryRecoveryStore(hooks = {}) {
  const records = new Map(); const writes = []; const removals = []; const reads = [];
  const key = (scope) => JSON.stringify([scope.repository, scope.authority, scope.draftId]);
  return { records, writes, removals, reads, get: () => structuredClone([...records.values()][0] ?? null),
    read: async (scope) => { reads.push(structuredClone(scope)); await hooks.read?.(scope); return structuredClone(records.get(key(scope)) ?? null); },
    write: async (checkpoint, expected = null) => {
      writes.push({ checkpoint: structuredClone(checkpoint), expected }); await hooks.write?.(checkpoint, expected);
      const retained = records.get(key(checkpoint.scope));
      if ((retained?.checkpointId ?? null) !== expected) throw new Error('PRIVATE_RECOVERY_CONFLICT: another window retained a checkpoint.');
      records.set(key(checkpoint.scope), structuredClone(checkpoint));
    },
    remove: async (scope, expected) => {
      removals.push({ scope: structuredClone(scope), expected }); await hooks.remove?.(scope, expected);
      if (records.get(key(scope))?.checkpointId !== expected) return false;
      records.delete(key(scope)); return true;
    },
    replace: (checkpoint) => { records.set(key(checkpoint.scope), structuredClone(checkpoint)); }
  };
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

test('private recovery preserves literal invalid JSON across crash/reopen only after explicit exact-base Restore', async () => {
  const store = memoryRecoveryStore(); const clock = fakeClock(); const first = fixture({}, clock, store); await first.open();
  const baseline = first.controller.view.editor.savedText;
  const fields = first.edit('{"payload":{\r\n  "incomplete":', 'Literal private edit');
  await first.controller.receive({ type: 'change', ...fields }); await settle();
  assert.equal(first.controller.view.recovery.status, 'saved');
  assert.equal(store.get().buffer.text, fields.inputText);
  assert.equal(store.get().base.savedText, baseline);
  assert.equal(first.calls.some((call) => call.args[2] === 'save'), false);
  first.controller.dispose(); await settle();
  const reopened = fixture({}, clock, store); await reopened.open();
  assert.equal(reopened.controller.view.editor.inputText, baseline);
  assert.equal(reopened.controller.view.recovery.candidateAvailable, true);
  assert.equal(reopened.controller.view.recovery.restoreAllowed, true);
  assert.equal(reopened.controller.view.autosave, false);
  await reopened.controller.receive({ type: 'autosave-on', binding: reopened.controller.view.editor.binding });
  assert.equal(reopened.controller.view.autosave, false);
  await reopened.controller.receive({ type: 'recovery-compare', binding: reopened.controller.view.editor.binding });
  assert.equal(reopened.compared[0].checkpointText, fields.inputText); assert.equal(reopened.compared[0].sharedText, baseline);
  await reopened.controller.receive({ type: 'recovery-restore', binding: reopened.controller.view.editor.binding });
  assert.equal(reopened.controller.view.editor.inputText, fields.inputText);
  assert.equal(reopened.controller.view.editor.savedText, baseline);
  assert.equal(reopened.controller.view.dirty, true); assert.equal(reopened.controller.view.autosave, false);
  await clock.advance(20_000);
  await reopened.controller.receive({ type: 'save', binding: reopened.controller.view.editor.binding });
  assert.match(reopened.controller.view.error, /not valid JSON/);
  assert.equal(reopened.calls.some((call) => call.args[2] === 'save'), false);
  assert.equal(store.get().buffer.text, fields.inputText);
});

test('private checkpoints coalesce to one in-flight plus latest buffer and finish after dispose without shared mutation', async () => {
  const gate = deferred(); const store = memoryRecoveryStore({ write: async () => gate.promise });
  const f = fixture({}, fakeClock(), store); await f.open();
  await f.controller.receive({ type: 'change', ...f.edit('{"payload":{"n":1}}') });
  for (let index = 2; index <= 40; index += 1) await f.controller.receive({ type: 'change', ...f.edit(`{"payload":{"n":${index}}}`) });
  assert.equal(store.writes.length, 1); assert.equal(f.controller.view.recovery.status, 'writing');
  f.controller.dispose(); gate.resolve(); await settle();
  assert.equal(store.writes.length, 2, 'intermediate buffers do not form an unbounded queue');
  assert.equal(store.get().buffer.text, '{"payload":{"n":40}}');
  assert.equal(f.calls.filter((call) => call.args[2] === 'save').length, 0);
});

test('private pending operation is acknowledged before shared Save starts, and local failure blocks the runner', async () => {
  const gate = deferred(); let block = true;
  const store = memoryRecoveryStore({ write: async (checkpoint) => { if (block && checkpoint.pendingSave) await gate.promise; } });
  const f = fixture({}, undefined, store); await f.open();
  const fields = f.edit(); const saving = f.controller.receive({ type: 'save', ...fields }); await settle();
  assert.equal(f.calls.some((call) => call.args[2] === 'save'), false);
  assert.equal(store.writes.at(-1).checkpoint.pendingSave.uncertain, true);
  const operationId = store.writes.at(-1).checkpoint.pendingSave.operationId;
  gate.resolve(); block = false; await saving;
  assert.equal(f.calls.find((call) => call.args[2] === 'save').args.at(-1), '--json');
  assert.equal(f.controller.view.operationId, operationId);
  assert.equal(store.get(), null, 'matching clean shared acknowledgement CAS-clears only its private checkpoint');
  assert.ok(store.removals[0].expected);
  let broken = true; const failedStore = memoryRecoveryStore({ write: async () => { if (broken) throw new Error('PRIVATE_RECOVERY_UNAVAILABLE'); } });
  const failed = fixture({}, undefined, failedStore); await failed.open();
  await failed.controller.receive({ type: 'save', ...failed.edit() });
  assert.equal(failed.calls.some((call) => call.args[2] === 'save'), false);
  assert.equal(failed.controller.view.recovery.status, 'failed'); assert.equal(failed.controller.view.dirty, true);
  broken = false; await failed.controller.receive({ type: 'save', binding: failed.controller.view.editor.binding });
  assert.equal(failed.calls.filter((call) => call.args[2] === 'save').length, 1, 'explicit retry checkpoints before contacting Git');
});

test('offered private candidate is not overwritten by new edits and explicit candidate Discard retains current text', async () => {
  const store = memoryRecoveryStore(); const first = fixture({}, undefined, store); await first.open();
  await first.controller.receive({ type: 'change', ...first.edit('{"payload":{"oldPrivate":true}}') }); await settle();
  const original = store.get(); const reopened = fixture({}, undefined, store); await reopened.open();
  const fields = reopened.edit('{"payload":{"newMemory":true}}', 'Current editor');
  await reopened.controller.receive({ type: 'change', ...fields }); await settle();
  assert.equal(store.get().checkpointId, original.checkpointId);
  await reopened.controller.receive({ type: 'save', ...fields });
  assert.equal(reopened.calls.some((call) => call.args[2] === 'save'), false);
  reopened.confirm(true); await reopened.controller.receive({ type: 'recovery-discard', ...fields }); await settle();
  assert.equal(reopened.discardReasons.at(-1), 'private-checkpoint');
  assert.equal(reopened.controller.view.editor.inputText, fields.inputText); assert.equal(reopened.controller.view.dirty, true);
  assert.notEqual(store.get().checkpointId, original.checkpointId); assert.equal(store.get().buffer.text, fields.inputText);
});

test('newer shared revision permits Compare but refuses stale Restore, and another authority never inherits recovery', async () => {
  const store = memoryRecoveryStore(); const first = fixture({}, undefined, store); await first.open();
  await first.controller.receive({ type: 'change', ...first.edit() }); await settle(); const original = store.get();
  const stale = fixture({ read: async () => result('read', { head: secondHead, record: revision(2), payload: { id: 'peer-new' }, assets: [], tombstone: null }) }, undefined, store);
  await stale.open(); const binding = stale.controller.view.editor.binding;
  assert.equal(stale.controller.view.recovery.restoreAllowed, false);
  await stale.controller.receive({ type: 'recovery-restore', binding });
  assert.match(stale.controller.view.error, /Stale recovery cannot overwrite or rebase/);
  assert.equal(stale.controller.view.editor.head, secondHead); assert.equal(store.get().checkpointId, original.checkpointId);
  await stale.controller.receive({ type: 'recovery-compare', binding });
  assert.equal(stale.compared[0].baseRevision, 1); assert.equal(stale.compared[0].currentRevision, 2);
  assert.equal(stale.controller.view.dirty, false);
  const other = fixture({
    list: async () => ({ ...result('list', { head: firstHead, drafts: [revision()], nextCursor: null }), capability: { repository: '/approved/another.git' } }),
    read: async () => ({ ...result('read', { head: firstHead, record: revision(), payload: { id: 'partial' }, assets: [], tombstone: null }), capability: { repository: '/approved/another.git' } })
  }, undefined, store); await other.open();
  assert.equal(other.controller.view.recovery.candidate, null);
  assert.equal(store.get().checkpointId, original.checkpointId, 'old-authority recovery remains retained, never reassigned');
  const deleted = fixture({ read: async () => result('read', { head: secondHead, record: { ...revision(2), lifecycleEpoch: 2 }, payload: {}, assets: [], tombstone: { deleted: true } }) }, undefined, store);
  await deleted.open(); await deleted.controller.receive({ type: 'recovery-restore', binding: deleted.controller.view.editor.binding });
  assert.equal(deleted.controller.view.recovery.restoreAllowed, false); assert.equal(deleted.controller.view.editor.readOnlyReason !== null, true);
  assert.equal(deleted.calls.some((call) => call.args[2] === 'save'), false);
});

test('corrupt private read is not absence and explicit Refresh recovers without overwriting captured text', async () => {
  let corrupt = true; const store = memoryRecoveryStore({ read: async () => { if (corrupt) throw new Error('PRIVATE_RECOVERY_CORRUPT'); } });
  const f = fixture({}, undefined, store); await f.open();
  assert.equal(f.controller.view.recovery.status, 'failed');
  const fields = f.edit(); await f.controller.receive({ type: 'change', ...fields }); await settle();
  assert.equal(store.writes.length, 0);
  await f.controller.receive({ type: 'save', ...fields }); await f.controller.receive({ type: 'autosave-on', ...fields });
  assert.equal(f.calls.some((call) => call.args[2] === 'save'), false); assert.equal(f.controller.view.autosave, false);
  corrupt = false; await f.controller.receive({ type: 'recovery-refresh', ...fields });
  assert.equal(f.controller.view.editor.inputText, fields.inputText); assert.equal(f.controller.view.recovery.status, 'none');
  assert.equal(store.writes.length, 0, 'refresh is inspection only');
  await f.controller.receive({ type: 'save', ...fields }); assert.equal(f.controller.view.error, null);
});

test('foreign private checkpoint CAS is never erased and explicit Refresh offers its exact winning candidate', async () => {
  const store = memoryRecoveryStore(); const f = fixture({}, undefined, store); await f.open();
  await f.controller.receive({ type: 'change', ...f.edit() }); await settle();
  const original = store.get(); const foreign = { ...original, checkpointId: randomUUID(), buffer: { name: 'Peer window', text: '{"payload":{"peer":true}}' } };
  store.replace(foreign);
  f.confirm(true); await f.controller.receive({ type: 'reload', binding: f.controller.view.editor.binding });
  assert.equal(store.get().checkpointId, foreign.checkpointId); assert.equal(f.controller.view.recovery.status, 'failed');
  assert.match(f.controller.view.error, /newer private checkpoint/);
  const text = f.controller.view.editor.inputText;
  await f.controller.receive({ type: 'recovery-refresh', binding: f.controller.view.editor.binding });
  assert.equal(f.controller.view.recovery.candidate.checkpointId, foreign.checkpointId);
  assert.equal(f.controller.view.editor.inputText, text);
  await f.controller.receive({ type: 'recovery-discard', binding: f.controller.view.editor.binding }); await settle();
  assert.equal(f.controller.view.editor.inputText, text); assert.equal(store.get().buffer.text, text);
  assert.ok(store.removals.some((entry) => entry.expected === foreign.checkpointId));
});

test('recovered unknown Save forces op-status and explicit unchanged retry retains its exact operation and head', async () => {
  const store = memoryRecoveryStore(); const first = fixture({ save: async () => { throw new Error('timeout: acknowledgement lost'); } }, undefined, store);
  await first.open(); const fields = first.edit();
  await first.controller.receive({ type: 'save', ...fields }); await settle(); const pending = store.get().pendingSave;
  assert.equal(pending.uncertain, true); assert.equal(pending.snapshot.text, fields.inputText);
  const reopened = fixture({}, undefined, store); await reopened.open(); const binding = reopened.controller.view.editor.binding;
  await reopened.controller.receive({ type: 'back-drafts', binding }); assert.ok(reopened.controller.view.editor);
  await reopened.controller.receive({ type: 'recovery-discard', binding }); assert.match(reopened.controller.view.error, /unresolved Save/);
  await reopened.controller.receive({ type: 'recovery-restore', binding });
  assert.equal(reopened.controller.view.durability, 'uncertain');
  await reopened.controller.receive({ type: 'save', binding }); await reopened.controller.receive({ type: 'autosave-on', binding });
  assert.equal(reopened.calls.some((call) => call.args[2] === 'save'), false); assert.equal(reopened.controller.view.autosave, false);
  await reopened.controller.receive({ type: 'operation-status', binding });
  assert.equal(reopened.calls.some((call) => call.args[2] === 'save'), false, 'not-found is not authority to auto-write');
  assert.equal(reopened.controller.view.editor.head, firstHead);
  await reopened.controller.receive({ type: 'save', binding });
  const args = reopened.calls.find((call) => call.args[2] === 'save').args;
  assert.equal(args[args.indexOf('--operation-id') + 1], pending.operationId);
  assert.equal(args[args.indexOf('--expected-head') + 1], pending.snapshot.head);
  assert.equal(reopened.inputs[0], pending.snapshot.text); assert.equal(store.get(), null);
});

test('crash after remote ACK resolves offered pending checkpoint to its operation head, not a newer peer revision', async () => {
  for (const peerAdvanced of [false, true]) {
    const store = memoryRecoveryStore(); const first = fixture({ save: async () => { throw new Error('lost ACK after commit'); } }, undefined, store);
    await first.open(); const text = '{"payload":{"saved":true},"assets":[]}';
    await first.controller.receive({ type: 'save', ...first.edit(text, 'Saved name') }); await settle();
    const operationId = store.get().pendingSave.operationId;
    const observedRecord = { ...revision(peerAdvanced ? 3 : 2), displayName: peerAdvanced ? 'Peer name' : 'Saved name' };
    const f = fixture({ read: async () => result('read', { head: peerAdvanced ? latestHead : secondHead, record: observedRecord,
      payload: peerAdvanced ? { peer: true } : { saved: true }, assets: [], tombstone: null }),
    'op-status': async () => result('op-status', { status: 'shared-acknowledged', operationId, head: peerAdvanced ? latestHead : secondHead,
      operationHead: secondHead, record: { ...revision(2), displayName: 'Saved name' }, currentLifecycle: 'live' }) }, undefined, store);
    await f.open(); const binding = f.controller.view.editor.binding;
    assert.equal(f.controller.view.recovery.restoreAllowed, false);
    await f.controller.receive({ type: 'operation-status', binding });
    assert.equal(f.controller.view.error, null); assert.equal(f.controller.view.recovery.candidate.pendingSave, undefined);
    assert.equal(store.get().base.head, secondHead); assert.equal(store.get().base.savedText, text);
    assert.equal(f.controller.view.editor.head, peerAdvanced ? latestHead : secondHead);
    assert.equal(f.controller.view.recovery.restoreAllowed, !peerAdvanced);
    await f.controller.receive({ type: 'recovery-restore', binding });
    if (peerAdvanced) assert.match(f.controller.view.error, /Stale recovery/);
    else { assert.equal(f.controller.view.error, null); assert.equal(f.controller.view.editor.savedText, text); }
    assert.equal(f.calls.some((call) => call.args[2] === 'save'), false);
  }
});

test('newer edits during shared Save preserve exact pending request and checkpoint the new buffer after ACK', async () => {
  const entered = deferred(); const release = deferred(); const store = memoryRecoveryStore();
  const f = fixture({ save: async (args) => { entered.resolve(); await release.promise; return result('save', { record: revision(2), head: secondHead,
    operationHead: secondHead, operationId: args[args.indexOf('--operation-id') + 1], currentLifecycle: 'live' }, 'shared-acknowledged'); } }, undefined, store);
  await f.open(); const original = f.edit(); const saving = f.controller.receive({ type: 'save', ...original }); await entered.promise;
  const newer = f.edit('{"payload":{"newer":true}}', 'Newer edit'); await f.controller.receive({ type: 'change', ...newer }); await settle();
  assert.equal(store.get().buffer.text, newer.inputText); assert.equal(store.get().pendingSave.snapshot.text, original.inputText);
  release.resolve(); await saving;
  assert.equal(f.controller.view.editor.inputText, newer.inputText); assert.equal(f.controller.view.dirty, true);
  assert.equal(store.get().base.head, secondHead); assert.equal(store.get().base.savedText, original.inputText);
  assert.equal(store.get().buffer.text, newer.inputText); assert.equal(store.get().pendingSave, undefined);
  assert.equal(store.removals.length, 0, 'new captured text is not cleared by older shared acknowledgement');
});

test('CAS clear acknowledgement cannot erase new text captured while the exact checkpoint is being removed', async () => {
  const entered = deferred(); const release = deferred(); const store = memoryRecoveryStore({ remove: async () => { entered.resolve(); await release.promise; } });
  const f = fixture({}, undefined, store); await f.open(); const original = f.edit();
  const saving = f.controller.receive({ type: 'save', ...original }); await entered.promise;
  const newer = f.edit('{"payload":{"duringClear":true}}'); await f.controller.receive({ type: 'change', ...newer });
  release.resolve(); await saving; await settle();
  assert.equal(f.controller.view.editor.inputText, newer.inputText); assert.equal(f.controller.view.dirty, true);
  assert.equal(store.get().buffer.text, newer.inputText); assert.equal(store.get().base.head, secondHead);
  assert.equal(store.writes.at(-1).expected, null, 'the newer checkpoint is created only after exact prior CAS clear');
});

test('dirty Restore requires cancel-default confirmation and a concurrent edit during fresh read keeps both buffers', async () => {
  const store = memoryRecoveryStore(); const first = fixture({}, undefined, store); await first.open();
  const privateFields = first.edit('{"payload":{"private":true}}', 'Private name');
  await first.controller.receive({ type: 'change', ...privateFields }); await settle();
  const f = fixture({}, undefined, store); await f.open();
  const fields = f.edit('{"payload":{"current":true}}', 'Current name'); await f.controller.receive({ type: 'change', ...fields });
  await f.controller.receive({ type: 'recovery-restore', ...fields });
  assert.equal(f.controller.view.editor.inputText, fields.inputText); assert.ok(f.controller.view.recovery.candidate);
  f.confirm(true); await f.controller.receive({ type: 'recovery-restore', ...fields });
  assert.equal(f.controller.view.editor.inputText, privateFields.inputText); assert.equal(f.controller.view.editor.name, privateFields.name);
  assert.equal(f.controller.view.autosave, false); assert.equal(f.calls.some((call) => call.args[2] === 'save'), false);
  let reads = 0; const gate = deferred(); const entered = deferred();
  const raced = fixture({ read: async () => { if (++reads > 1) { entered.resolve(); await gate.promise; }
    return result('read', { head: firstHead, record: revision(), payload: { id: 'partial' }, assets: [{ path: 'SKILL.md', bytes: 7, contentBase64: Buffer.from('literal').toString('base64') }], tombstone: null });
  } }, undefined, store); await raced.open();
  const restoring = raced.controller.receive({ type: 'recovery-restore', binding: raced.controller.view.editor.binding }); await entered.promise;
  const latest = raced.edit('{"payload":{"typedDuringRestore":true}}'); await raced.controller.receive({ type: 'change', ...latest });
  gate.resolve(); await restoring;
  assert.equal(raced.controller.view.editor.inputText, latest.inputText); assert.equal(raced.controller.view.dirty, true);
  assert.match(raced.controller.view.error, /New captured edits arrived/);
  assert.equal(store.get().buffer.text, privateFields.inputText); assert.ok(raced.controller.view.recovery.candidate);
});

test('pending ACK checkpoint update publishes its new CAS identity even when current text changes during private write', async () => {
  const gate = deferred(); const entered = deferred(); let block = false;
  const store = memoryRecoveryStore({ write: async (checkpoint) => { if (block && checkpoint.base.record.revision === 2) { entered.resolve(); await gate.promise; } } });
  const first = fixture({ save: async () => { throw new Error('lost ACK'); } }, undefined, store); await first.open();
  const text = '{"payload":{"saved":true},"assets":[]}'; await first.controller.receive({ type: 'save', ...first.edit(text, 'Saved name') }); await settle();
  const operationId = store.get().pendingSave.operationId;
  const f = fixture({ read: async () => result('read', { head: secondHead, record: { ...revision(2), displayName: 'Saved name' }, payload: { saved: true }, assets: [], tombstone: null }),
    'op-status': async () => result('op-status', { status: 'shared-acknowledged', operationId, head: secondHead, operationHead: secondHead,
      record: { ...revision(2), displayName: 'Saved name' }, currentLifecycle: 'live' }) }, undefined, store);
  await f.open(); block = true;
  const status = f.controller.receive({ type: 'operation-status', binding: f.controller.view.editor.binding }); await entered.promise;
  const fields = f.edit('{"payload":{"newMemory":true}}'); await f.controller.receive({ type: 'change', ...fields });
  gate.resolve(); await status;
  assert.equal(f.controller.view.editor.inputText, fields.inputText); assert.equal(f.controller.view.dirty, true);
  assert.equal(f.controller.view.recovery.candidate.checkpointId, store.get().checkpointId);
  assert.equal(f.controller.view.recovery.candidate.pendingSave, undefined);
  assert.equal(f.controller.view.operationId, null);
  assert.equal(f.calls.some((call) => call.args[2] === 'save'), false);
});

test('closing during possibly-issued shared Save leaves encrypted-bound pending identity for status, with no follow-up shared call', async () => {
  const entered = deferred(); const release = deferred(); const store = memoryRecoveryStore();
  const f = fixture({ save: async (args) => { entered.resolve(); await release.promise; return result('save', { record: revision(2), operationHead: secondHead,
    head: secondHead, operationId: args[args.indexOf('--operation-id') + 1], currentLifecycle: 'live' }, 'shared-acknowledged'); } }, undefined, store);
  await f.open(); const saving = f.controller.receive({ type: 'save', ...f.edit() }); await entered.promise;
  const pending = store.get().pendingSave;
  f.controller.dispose(); release.resolve(); await saving; await settle();
  assert.deepEqual(store.get().pendingSave, pending);
  assert.equal(f.calls.filter((call) => call.args[2] === 'save').length, 1);
  assert.equal(f.calls.filter((call) => call.args[2] === 'list').length, 1);
  const reopened = fixture({}, undefined, store); await reopened.open();
  assert.equal(reopened.controller.view.recovery.candidate.pendingSave.operationId, pending.operationId);
  assert.equal(reopened.controller.view.operationId, pending.operationId);
  assert.equal(reopened.controller.view.editor.head, firstHead);
});

test('foreign private replacement during checkpoint write refuses shared Save until exact-scope refresh and review', async () => {
  const store = memoryRecoveryStore(); const f = fixture({}, undefined, store); await f.open();
  await f.controller.receive({ type: 'change', ...f.edit() }); await settle();
  const observed = store.get(); const foreign = { ...observed, checkpointId: randomUUID(), buffer: { name: 'Foreign', text: '{"payload":{"foreign":true}}' } }; store.replace(foreign);
  await f.controller.receive({ type: 'save', ...f.edit('{"payload":{"newer":true}}') });
  assert.equal(f.calls.some((call) => call.args[2] === 'save'), false); assert.equal(store.get().checkpointId, foreign.checkpointId);
  assert.equal(f.controller.view.recovery.status, 'failed');
  await f.controller.receive({ type: 'recovery-refresh', binding: f.controller.view.editor.binding });
  assert.equal(f.controller.view.recovery.candidate.checkpointId, foreign.checkpointId);
  assert.equal(f.controller.view.editor.inputText, '{"payload":{"newer":true}}');
  await f.controller.receive({ type: 'autosave-on', binding: f.controller.view.editor.binding });
  assert.equal(f.controller.view.autosave, false); assert.equal(store.get().checkpointId, foreign.checkpointId);
});

test('private Refresh retains current unknown operation before inspecting a different winning candidate operation', async () => {
  const store = memoryRecoveryStore(); const f = fixture({ save: async () => { throw new Error('unknown acknowledgement'); } }, undefined, store);
  await f.open(); await f.controller.receive({ type: 'save', ...f.edit() }); await settle();
  const original = store.get(); const operationId = original.pendingSave.operationId;
  const foreignId = randomUUID(); const foreign = { ...original, checkpointId: randomUUID(),
    buffer: { name: 'Peer', text: '{"payload":{"peer":true}}' },
    pendingSave: { ...original.pendingSave, operationId: foreignId, snapshot: { ...original.pendingSave.snapshot, name: 'Peer', text: '{"payload":{"peer":true}}' } } };
  store.replace(foreign);
  const binding = f.controller.view.editor.binding;
  await f.controller.receive({ type: 'recovery-refresh', binding });
  assert.equal(f.controller.view.operationId, operationId, 'the current unknown operation is not lost behind a foreign candidate');
  await f.controller.receive({ type: 'operation-status', binding });
  assert.equal(f.controller.view.operationId, foreignId, 'only a resolved not-found current request yields the candidate status route');
  await f.controller.receive({ type: 'operation-status', binding });
  f.confirm(true); await f.controller.receive({ type: 'recovery-discard', binding }); await settle();
  assert.equal(f.controller.view.error, null); assert.equal(f.controller.view.recovery.candidate, null);
  assert.equal(f.controller.view.operationId, operationId); assert.equal(f.controller.view.editor.inputText, original.buffer.text);
  assert.equal(f.calls.filter((call) => call.args[2] === 'save').length, 1, 'no recovery decision retries either write');
});

test('Restore cannot replace this editor unknown Save with a foreign offered checkpoint until its own status is resolved', async () => {
  for (const foreignPending of [false, true]) {
    const store = memoryRecoveryStore(); const f = fixture({ save: async () => { throw new Error('unknown shared acknowledgement'); } }, undefined, store);
    await f.open(); const fields = f.edit(); await f.controller.receive({ type: 'save', ...fields }); await settle();
    const original = store.get(); const ownOperationId = original.pendingSave.operationId;
    const foreign = { ...original, checkpointId: randomUUID(), buffer: { name: 'Other window', text: '{"payload":{"otherWindow":true}}' } };
    if (foreignPending) foreign.pendingSave = { ...original.pendingSave, operationId: randomUUID(), snapshot: { ...original.pendingSave.snapshot, ...foreign.buffer, name: foreign.buffer.name, text: foreign.buffer.text } };
    else delete foreign.pendingSave;
    store.replace(foreign); f.confirm(true);
    await f.controller.receive({ type: 'recovery-refresh', binding: fields.binding });
    assert.equal(f.controller.view.recovery.restoreAllowed, false);
    await f.controller.receive({ type: 'recovery-compare', binding: fields.binding });
    assert.equal(f.controller.view.recovery.restoreAllowed, false, 'Compare cannot enable Restore around an unresolved current operation');
    await f.controller.receive({ type: 'recovery-restore', binding: fields.binding });
    assert.match(f.controller.view.error, /current Save operation.*unresolved acknowledgement.*Operation Status/);
    assert.equal(f.controller.view.operationId, ownOperationId);
    assert.equal(f.controller.view.editor.inputText, fields.inputText); assert.equal(f.controller.view.editor.name, fields.name);
    assert.equal(f.controller.view.recovery.candidate.checkpointId, foreign.checkpointId);
    assert.deepEqual(store.get(), foreign); assert.equal(f.discardReasons.length, 0, 'even confirmed dirty replacement cannot bypass the unknown operation fence');
    assert.equal(f.calls.filter((call) => call.args[2] === 'save').length, 1);
    await f.controller.receive({ type: 'operation-status', binding: fields.binding });
    assert.equal(f.controller.view.recovery.restoreAllowed, true, 'only current-operation resolution recomputes the exact-base Restore flag');
    assert.equal(f.controller.view.editor.head, firstHead); assert.deepEqual(store.get(), foreign);
    await f.controller.receive({ type: 'recovery-restore', binding: fields.binding });
    assert.equal(f.controller.view.error, null); assert.equal(f.controller.view.editor.inputText, foreign.buffer.text);
    assert.equal(f.controller.view.operationId, foreignPending ? foreign.pendingSave.operationId : null);
    assert.equal(f.calls.filter((call) => call.args[2] === 'save').length, 1);
  }
});

test('discarding a foreign private candidate checkpoints an own unresolved Save even when visible buffer was reverted clean', async () => {
  const store = memoryRecoveryStore(); const f = fixture({ save: async () => { throw new Error('unknown acknowledgement'); } }, undefined, store);
  await f.open(); const baseline = f.controller.view.editor.savedText; const baselineName = f.controller.view.editor.savedName;
  await f.controller.receive({ type: 'save', ...f.edit() }); await settle();
  const original = store.get();
  const foreign = { ...original, checkpointId: randomUUID(), buffer: { name: 'Foreign', text: '{"payload":{"foreign":true}}' } };
  delete foreign.pendingSave; store.replace(foreign);
  const binding = f.controller.view.editor.binding;
  await f.controller.receive({ type: 'recovery-refresh', binding });
  await f.controller.receive({ type: 'change', binding, name: baselineName, inputText: baseline });
  assert.equal(f.controller.view.dirty, false);
  f.confirm(true); await f.controller.receive({ type: 'recovery-discard', binding });
  assert.equal(f.controller.view.error, null); assert.equal(f.controller.view.recovery.status, 'saved');
  const retained = store.get(); assert.notEqual(retained.checkpointId, foreign.checkpointId);
  assert.deepEqual(retained.pendingSave, original.pendingSave); assert.equal(retained.buffer.text, baseline);
  assert.equal(f.controller.view.operationId, original.pendingSave.operationId);
  await f.controller.receive({ type: 'back-drafts', binding });
  assert.ok(f.controller.view.editor); assert.match(f.controller.view.error, /unresolved acknowledgement/);
  assert.equal(f.calls.filter((call) => call.args[2] === 'save').length, 1);
});

test('unknown current Save ACK can reconcile without replacing a separately offered foreign checkpoint', async () => {
  let acknowledged = false; let operationId;
  const store = memoryRecoveryStore(); const f = fixture({ save: async () => { throw new Error('unknown ACK'); },
    'op-status': async () => acknowledged
      ? result('op-status', { status: 'shared-acknowledged', operationId, head: secondHead, operationHead: secondHead, record: revision(2), currentLifecycle: 'live' })
      : result('op-status', { status: 'not-found', operationId, head: firstHead }) }, undefined, store);
  await f.open(); await f.controller.receive({ type: 'save', ...f.edit() }); await settle();
  const original = store.get(); operationId = original.pendingSave.operationId;
  const foreign = { ...original, checkpointId: randomUUID(), buffer: { name: 'Separate peer', text: '{"payload":{"peer":true}}' } };
  delete foreign.pendingSave; store.replace(foreign);
  const binding = f.controller.view.editor.binding; await f.controller.receive({ type: 'recovery-refresh', binding });
  acknowledged = true; await f.controller.receive({ type: 'operation-status', binding });
  assert.equal(f.controller.view.error, null); assert.equal(f.controller.view.editor.head, secondHead);
  assert.equal(store.get().checkpointId, foreign.checkpointId); assert.equal(f.controller.view.recovery.candidate.checkpointId, foreign.checkpointId);
  assert.equal(f.controller.view.recovery.restoreAllowed, false);
  assert.equal(f.calls.filter((call) => call.args[2] === 'save').length, 1);
});

test('six-stage guide edits preserve unknown fields/assets and create real incomplete namespaced components without grants', () => {
  assert.deepEqual(WORKFLOW_DRAFT_STAGES, ['Goal', 'Stages', 'Team & skills', 'Access & review', 'Review package', 'Submit & next steps']);
  const original = { payload: { unknown: { retained: true }, definitions: { futureCollection: [{ data: 'keep' }] } },
    assets: [{ path: 'references/manual.md', content: 'hand-written literal' }] };
  let text = editWorkflowDraftGuide(JSON.stringify(original), 'id', 'reviewed-change');
  text = editWorkflowDraftGuide(text, 'description', 'Actual human goal');
  text = addWorkflowDraftStage(text, 'reviewed-change');
  text = editWorkflowDraftGuide(text, 'agent-prompt', 'Do the actual task; never approve it.', 0);
  text = editWorkflowDraftGuide(text, 'skill-instructions', 'Retain the real procedural instructions.', 0);
  text = editWorkflowDraftGuide(text, 'template-content', '# Actual required output', 0);
  text = addWorkflowDraftStage(text, 'reviewed-change');
  text = reorderWorkflowDraftStage(text, 1, -1);
  const saved = JSON.parse(text); const guide = workflowDraftGuide(text);
  assert.deepEqual(saved.assets, original.assets); assert.deepEqual(saved.payload.unknown, original.payload.unknown);
  assert.deepEqual(saved.payload.definitions.futureCollection, original.payload.definitions.futureCollection);
  assert.equal(saved.payload.schema, 'sflow-workflow-request@2');
  assert.deepEqual(guide.workflows[0].phases, ['reviewed-change-stage-2', 'reviewed-change-stage-1']);
  assert.equal(guide.agents[0].prompt, 'Do the actual task; never approve it.');
  assert.equal(guide.skills[0].instructions, 'Retain the real procedural instructions.');
  assert.equal(guide.templates[0].content, '# Actual required output');
  assert.equal(guide.agents[1].prompt, ''); assert.deepEqual(guide.agents[1].toolBindings, []);
  assert.equal(guide.phases[0].taskBinding, undefined); assert.equal(guide.phases[0].approvalBinding, undefined);
  assert.equal(saved.payload.baseRevision, undefined, 'no fabricated approved revision');
  assert.equal(saved.payload.definitions.workflows[0].plannedClaims, undefined, 'no implicit code opt-out');
});

test('guided edits refuse duplicate, future-version and ambiguous collection shapes without rewriting advanced text', async () => {
  for (const text of ['{"payload":{"id":"one","id":"two"}}', '{"payload":{"id":"one","\\u0069d":"two"}}',
    '{"payload":{"schema":"future-required@9"}}', '{"payload":{"definitions":{"phases":{}}}}']) {
    assert.throws(() => editWorkflowDraftGuide(text, 'label', 'Changed'), /Duplicate|not supported|requires/);
  }
  const f = fixture(); await f.open(); const text = '{"payload":{"id":"one","id":"two"}}';
  await f.controller.receive({ type: 'guide-answer', ...f.edit(text), field: 'label', value: 'No rewrite', index: 0 });
  assert.equal(f.controller.view.editor.inputText, text); assert.match(f.controller.view.error, /Duplicate JSON keys/);
  assert.equal(f.calls.some((call) => call.args[2] === 'save'), false);
  await f.controller.receive({ type: 'guide-answer', ...f.edit(), field: 'actor', value: 'approved human', index: 0 });
  assert.match(f.controller.view.error, /bounded typed guide field/);
});

test('shared autosave is exact-draft opt-in, coalesces idle changes and turns off on explicit reload', async () => {
  const clock = fakeClock(); const f = fixture({}, clock); await f.open();
  await f.controller.receive({ type: 'change', ...f.edit() }); await clock.advance(5000);
  assert.equal(f.calls.some((call) => call.args[2] === 'save'), false); assert.equal(f.controller.view.durability, 'memory');
  await f.controller.receive({ type: 'autosave-on', ...f.edit() });
  await clock.advance(749); assert.equal(f.calls.filter((call) => call.args[2] === 'save').length, 0);
  await clock.advance(1); assert.equal(f.calls.filter((call) => call.args[2] === 'save').length, 1);
  assert.equal(f.controller.view.durability, 'shared'); assert.equal(f.controller.view.dirty, false);
  await f.controller.receive({ type: 'reload', binding: f.controller.view.editor.binding });
  assert.equal(f.controller.view.autosave, false); assert.equal(clock.count(), 0);
  f.controller.dispose();
});

test('continuous captured editing cannot postpone a shared attempt past the bounded two-second window', async () => {
  const clock = fakeClock(); const f = fixture({}, clock); await f.open();
  await f.controller.receive({ type: 'autosave-on', binding: f.controller.view.editor.binding });
  for (let index = 0; index < 20; index += 1) {
    await f.controller.receive({ type: 'change', ...f.edit(JSON.stringify({ payload: { incomplete: index } })) });
    await clock.advance(100);
  }
  assert.equal(f.calls.filter((call) => call.args[2] === 'save').length, 1);
  assert.deepEqual(JSON.parse(f.inputs[0]), { payload: { incomplete: 19 } });
  assert.equal(f.controller.view.dirty, false); f.controller.dispose();
});

test('edits during an in-flight autosave stay captured; immutable snapshot ACK cannot certify or discard newer text', async () => {
  const clock = fakeClock(); let release; const gate = new Promise((resolve) => { release = resolve; }); let attempts = 0;
  const f = fixture({ save: async (args) => {
    if (++attempts === 1) await gate;
    return result('save', { record: revision(attempts + 1), head: attempts === 1 ? secondHead : latestHead,
      operationHead: attempts === 1 ? secondHead : latestHead,
      operationId: args[args.indexOf('--operation-id') + 1], currentLifecycle: 'live' }, 'shared-acknowledged');
  } }, clock);
  await f.open(); const binding = f.controller.view.editor.binding;
  await f.controller.receive({ type: 'autosave-on', binding });
  const first = f.edit('{"payload":{"draft":"first"}}', 'First');
  await f.controller.receive({ type: 'change', ...first }); await clock.advance(750);
  assert.equal(f.controller.view.busy, true); assert.equal(f.controller.view.durability, 'saving');
  const second = f.edit('{"payload":{"draft":"second"}}', 'Second');
  await f.controller.receive({ type: 'change', ...second });
  release(); await settle();
  assert.equal(f.controller.view.editor.savedText, first.inputText);
  assert.equal(f.controller.view.editor.inputText, second.inputText); assert.equal(f.controller.view.dirty, true);
  assert.equal(f.controller.view.editor.binding, binding, 'managed capture lease remains stable while saving');
  assert.equal(f.controller.view.editor.head, secondHead); assert.equal(f.controller.view.durability, 'memory');
  await clock.advance(750);
  assert.equal(f.controller.view.dirty, false); assert.deepEqual(f.inputs, [first.inputText, second.inputText]);
  const saves = f.calls.filter((call) => call.args[2] === 'save').map((call) => call.args);
  assert.equal(saves[0][saves[0].indexOf('--name') + 1], 'First');
  assert.equal(saves[1][saves[1].indexOf('--expected-head') + 1], secondHead);
  assert.notEqual(saves[0][saves[0].indexOf('--operation-id') + 1], saves[1][saves[1].indexOf('--operation-id') + 1]);
  f.controller.dispose();
});

test('lost autosave acknowledgement fences changed requests until operation-status resolves the exact prior snapshot', async () => {
  const clock = fakeClock(); let attempts = 0; let operation;
  const f = fixture({ save: async (args) => {
    operation ??= args[args.indexOf('--operation-id') + 1];
    if (++attempts === 1) throw new Error('WCA_DRAFT_WRITE_UNACKNOWLEDGED: Network outcome unknown');
    return result('save', { record: revision(3), head: latestHead, operationHead: latestHead,
      operationId: args[args.indexOf('--operation-id') + 1], currentLifecycle: 'live' }, 'shared-acknowledged');
  }, 'op-status': async (args) => result('op-status', { status: 'shared-acknowledged', head: latestHead,
    operationHead: secondHead, record: revision(2), operationId: args[3], currentLifecycle: 'live' }) }, clock);
  await f.open(); await f.controller.receive({ type: 'autosave-on', binding: f.controller.view.editor.binding });
  const first = f.edit('{"payload":{"pending":1}}'); await f.controller.receive({ type: 'change', ...first }); await clock.advance(750);
  assert.equal(f.controller.view.durability, 'uncertain');
  const changed = f.edit('{"payload":{"pending":2}}'); await f.controller.receive({ type: 'change', ...changed });
  await f.controller.receive({ type: 'save', ...changed });
  assert.equal(attempts, 1); assert.equal(f.controller.view.operationId, operation);
  await f.controller.receive({ type: 'operation-status', ...changed });
  assert.equal(f.controller.view.editor.head, secondHead, 'never adopt the newer global head from historical ACK');
  assert.equal(f.controller.view.editor.savedText, first.inputText); assert.equal(f.controller.view.editor.inputText, changed.inputText);
  await clock.advance(5000); assert.equal(attempts, 1, 'status is read-only; no automatic write resumes');
  await f.controller.receive({ type: 'save', ...changed });
  assert.equal(attempts, 2); assert.equal(f.controller.view.dirty, false);
  assert.notEqual(f.controller.view.operationId, operation); f.controller.dispose();
});

test('autosave conflict or deletion pauses retries and navigation; explicit Reload is the only discard/reconciliation path', async () => {
  for (const code of ['WCA_DRAFT_CONFLICT', 'WCA_DRAFT_AUTHORITY_CHANGED', 'WCA_DRAFT_DELETED']) {
    const clock = fakeClock(); const f = fixture({ save: async () => { throw new Error(`${code}: Peer changed retained authority/lifecycle`); } }, clock);
    await f.open(); await f.controller.receive({ type: 'autosave-on', binding: f.controller.view.editor.binding });
    const fields = f.edit(); await f.controller.receive({ type: 'change', ...fields }); await clock.advance(750);
    assert.equal(f.controller.view.durability, code === 'WCA_DRAFT_DELETED' ? 'deleted' : 'conflict');
    await clock.advance(20_000); await f.controller.receive({ type: 'stage', ...fields, stage: 3 });
    assert.equal(f.controller.view.stage, 1); assert.equal(f.controller.view.editor.inputText, fields.inputText);
    assert.equal(f.calls.filter((call) => call.args[2] === 'save').length, 1);
    assert.equal(f.calls.some((call) => call.args[2] === 'create'), false);
    f.confirm(true); await f.controller.receive({ type: 'reload', ...fields });
    assert.equal(f.controller.view.dirty, false); assert.equal(f.controller.view.autosave, false);
    f.controller.dispose();
  }
});

test('navigation flushes opted-in captured edits before Show, stage switch and Back to drafts without submission', async () => {
  const clock = fakeClock(); const f = fixture({}, clock); await f.open();
  await f.controller.receive({ type: 'autosave-on', binding: f.controller.view.editor.binding });
  await f.controller.receive({ type: 'stage', ...f.edit(), stage: 2 });
  assert.equal(f.controller.view.stage, 2); assert.equal(f.controller.view.dirty, false);
  await f.controller.receive({ type: 'show', ...f.edit('{"payload":{"third":"partial"}}') });
  const show = f.calls.findLast((call) => call.args[2] === 'show').args;
  assert.equal(show[show.indexOf('--revision') + 1], '2');
  assert.equal(f.controller.view.dirty, false);
  await f.controller.receive({ type: 'back-drafts', ...f.edit('{"payload":{"fourth":"partial"}}') });
  assert.equal(f.controller.view.editor, null); assert.equal(f.controller.view.autosave, false); assert.equal(clock.count(), 0);
  assert.equal(f.calls.filter((call) => call.args[2] === 'save').length, 3);
  assert.ok(f.calls.every((call) => ['list', 'read', 'save', 'show'].includes(call.args[2])));
  f.controller.dispose();
});

test('semantic guided answers autosave through the same CLI and stage navigation itself creates no revision', async () => {
  const clock = fakeClock(); const f = fixture({}, clock); await f.open();
  await f.controller.receive({ type: 'autosave-on', binding: f.controller.view.editor.binding });
  await f.controller.receive({ type: 'guide-answer', binding: f.controller.view.editor.binding, field: 'id', value: 'real-goal', index: 0 });
  await f.controller.receive({ type: 'add-stage', binding: f.controller.view.editor.binding });
  assert.equal(f.calls.filter((call) => call.args[2] === 'save').length, 2);
  assert.equal(workflowDraftGuide(f.controller.view.editor.inputText).agents[0].prompt, '');
  for (let stage = 1; stage <= 6; stage += 1) await f.controller.receive({ type: 'stage', binding: f.controller.view.editor.binding, stage });
  assert.equal(f.calls.filter((call) => call.args[2] === 'save').length, 2);
  const html = sharedWorkflowDraftsHtml(f.controller.view);
  assert.match(html, /Step 6 of 6/); assert.match(html, /Trusted submission confirmation is unavailable/);
  assert.doesNotMatch(html, /data-draft-action="submit"/); f.controller.dispose();
});

test('captured edits during an asynchronous Open or discard prompt cannot be replaced by navigation', async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; }); let reads = 0;
  const f = fixture({ read: async () => {
    if (++reads > 1) await gate;
    return result('read', { head: secondHead, record: revision(2), payload: { reopened: true }, assets: [], tombstone: null });
  } });
  await f.open();
  const reopening = f.controller.receive({ type: 'open', draftId }); await settle();
  const newest = f.edit('{"payload":{"arrived":"during read"}}');
  await f.controller.receive({ type: 'change', ...newest }); release(); await reopening;
  assert.equal(f.controller.view.editor.inputText, newest.inputText);
  assert.match(f.controller.view.error, /New captured edits arrived during navigation/);
  assert.equal(f.controller.view.dirty, true);
  let answer; const prompt = new Promise((resolve) => { answer = resolve; });
  const current = f.controller.view.editor;
  const controller = new SharedWorkflowDraftController(repository, async () => { throw new Error('No read may start after a raced discard prompt.'); },
    async () => {}, { changed: () => {}, confirmDiscard: () => prompt, copyReview: async () => {} });
  controller.view.editor = structuredClone(current); controller.view.dirty = true;
  const reload = controller.receive({ type: 'reload', binding: controller.view.editor.binding }); await settle();
  await controller.receive({ type: 'change', binding: controller.view.editor.binding, name: 'New during prompt', inputText: newest.inputText });
  answer(true); await reload;
  assert.equal(controller.view.editor.name, 'New during prompt');
  assert.match(controller.view.error, /New captured edits arrived during navigation/);
  controller.dispose(); f.controller.dispose();
});

test('immediate newer edits fence every clean navigation action before its first async discard return', async () => {
  for (const type of ['open', 'create', 'reload', 'back-drafts', 'exit']) {
    const f = fixture(); await f.open();
    const baselineCalls = f.calls.length; const editor = f.controller.view.editor;
    const action = f.controller.receive({ type, binding: editor.binding, ...(type === 'open' ? { draftId } : {}) });
    const newest = f.edit('{"payload":{"newUnsaved":"never-discarded"},"assets":[]}', 'Just typed');
    await f.controller.receive({ type: 'change', ...newest }); await action;
    assert.equal(f.controller.view.editor, editor, `${type} must retain the original editor`);
    assert.equal(f.controller.view.editor.inputText, newest.inputText); assert.equal(f.controller.view.editor.name, newest.name);
    assert.equal(f.controller.view.dirty, true); assert.match(f.controller.view.error, /New captured edits arrived during navigation/);
    assert.equal(f.calls.length, baselineCalls, `${type} must stop before a new read or shared mutation`);
    f.controller.dispose();
  }
});

test('closing the controller cancels scheduled autosave and offers no false private recovery or background sync', async () => {
  const clock = fakeClock(); const f = fixture({}, clock); await f.open();
  await f.controller.receive({ type: 'autosave-on', binding: f.controller.view.editor.binding });
  await f.controller.receive({ type: 'change', ...f.edit() }); assert.equal(clock.count(), 1);
  const html = sharedWorkflowDraftsHtml(f.controller.view);
  assert.match(html, /Native close does not flush to Git/);
  assert.match(html, /Private recovery unavailable/);
  assert.equal(f.controller.view.recovery.status, 'unavailable');
  assert.equal(f.controller.view.durability, 'memory');
  f.controller.dispose(); await clock.advance(20_000);
  assert.equal(clock.count(), 0); assert.equal(f.calls.filter((call) => call.args[2] === 'save').length, 0);
});

test('uncertain Save still pauses when the visible buffer was reverted before the failed acknowledgement', async () => {
  const clock = fakeClock(); let release; const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ save: async () => { await gate; throw new Error('WCA_FUTURE_TRANSPORT_FAILURE: outcome unknown'); } }, clock);
  await f.open(); const original = { binding: f.controller.view.editor.binding, name: f.controller.view.editor.name,
    inputText: f.controller.view.editor.inputText };
  await f.controller.receive({ type: 'autosave-on', binding: original.binding });
  await f.controller.receive({ type: 'change', ...f.edit() }); await clock.advance(750);
  await f.controller.receive({ type: 'change', ...original }); assert.equal(f.controller.view.dirty, false);
  release(); await settle();
  assert.equal(f.controller.view.busy, false); assert.equal(f.controller.view.durability, 'uncertain');
  assert.match(f.controller.view.error, /op-status/); await clock.advance(20_000);
  assert.equal(f.calls.filter((call) => call.args[2] === 'save').length, 1);
  f.controller.dispose();
});

test('an uncertain exact pending checkpoint fences replacement/exit even after reverting the visible buffer to an older baseline', async () => {
  for (const type of ['open', 'create', 'reload', 'back-drafts', 'exit']) {
    const f = fixture({ save: async () => { throw new Error('WCA_DRAFT_WRITE_UNACKNOWLEDGED: outcome unknown'); } }); await f.open();
    const editor = f.controller.view.editor;
    const original = { binding: editor.binding, name: editor.name, inputText: editor.inputText };
    const pending = f.edit('{"payload":{"uncertainOriginal":"retain exact bytes"}}');
    await f.controller.receive({ type: 'save', ...pending }); const operation = f.controller.view.operationId;
    await f.controller.receive({ type: 'change', ...original }); assert.equal(f.controller.view.dirty, false);
    const calls = f.calls.length;
    await f.controller.receive({ type, binding: editor.binding, ...(type === 'open' ? { draftId } : {}) });
    assert.equal(f.controller.view.editor, editor); assert.equal(f.controller.view.operationId, operation);
    assert.match(f.controller.view.error, /unresolved acknowledgement.*operation status before replacing or closing/);
    assert.equal(f.calls.length, calls, `${type} cannot discard or replace an unresolved checkpoint`);
    await f.controller.receive({ type: 'save', ...pending });
    assert.equal(f.controller.view.operationId, operation, 'the original exact checkpoint remains recoverable with its stable operation ID');
    assert.deepEqual(f.inputs, [pending.inputText, pending.inputText]); f.controller.dispose();
  }
});

test('a failed initial read is not rendered as an empty successful draft catalog', async () => {
  const f = fixture({ list: async () => { throw new Error('Git authorization unavailable'); } });
  await f.controller.initialize(); const html = sharedWorkflowDraftsHtml(f.controller.view);
  assert.match(html, /shared draft list has not loaded.*not an empty catalog/);
  assert.doesNotMatch(html, /No live shared drafts were observed/); f.controller.dispose();
});

test('deleted-draft fencing still permits explicit pause and Cancel-default return without recreating the ID', async () => {
  const clock = fakeClock(); const f = fixture({ save: async () => { throw new Error('WCA_DRAFT_DELETED: Shared tombstone'); } }, clock);
  await f.open(); await f.controller.receive({ type: 'autosave-on', binding: f.controller.view.editor.binding });
  const fields = f.edit(); await f.controller.receive({ type: 'change', ...fields }); await clock.advance(750);
  assert.equal(f.controller.view.durability, 'deleted');
  const html = sharedWorkflowDraftsHtml(f.controller.view);
  assert.match(html, /data-draft-action="autosave-off">Pause shared autosave/);
  assert.match(html, /data-draft-action="back-drafts">Back to drafts/);
  await f.controller.receive({ type: 'autosave-off', ...fields });
  await f.controller.receive({ type: 'back-drafts', ...fields });
  assert.equal(f.controller.view.editor.inputText, fields.inputText, 'Cancel preserves fenced text');
  f.confirm(true); await f.controller.receive({ type: 'back-drafts', ...fields });
  assert.equal(f.controller.view.editor, null);
  assert.equal(f.calls.filter((call) => call.args[2] === 'save').length, 1);
  assert.equal(f.calls.some((call) => call.args[2] === 'create'), false); f.controller.dispose();
});

test('explicit package Preview reaches its actual read-only owner, pins the saved revision and never claims host readiness', async () => {
  const f = fixture(); await f.open();
  await f.controller.receive({ type: 'preview', binding: f.controller.view.editor.binding });
  assert.deepEqual(f.calls.at(-1).args, ['workflow', 'author', 'preview', draftId, '--revision', '1', '--json']);
  assert.equal(f.controller.view.preview.source.revisionSha256, revision().revisionSha256);
  assert.equal(f.controller.view.editor.head, firstHead);
  assert.match(f.controller.view.notice, /unsupported host contracts.*no approval, submission or execution readiness/);
  const html = sharedWorkflowDraftsHtml(f.controller.view);
  assert.match(html, /Static validity is not Ready to run/); assert.match(html, /WCA_ARTIFACT_UNRESOLVED/);
  await f.controller.receive({ type: 'change', ...f.edit() });
  assert.equal(f.controller.view.preview, null, 'old assessment does not certify new candidate bytes');
  assert.equal(f.calls.some((call) => ['submit', 'approve', 'execute'].includes(call.args[2])), false); f.controller.dispose();
});

test('Preview refuses foreign authority, wrong revision/digest and changes captured during its async read', async () => {
  for (const change of [
    (p) => { p.source.repository = '/different/shared.git'; },
    (p) => { p.approvedSource.repository = '/different/shared.git'; },
    (p) => { p.source.revisionSha256 = revision(2).revisionSha256; },
    (p) => { p.source.revision = 2; }, (p) => { p.source.lifecycleEpoch = 2; }
  ]) {
    const f = fixture({ preview: async () => { const value = packagePreview(); change(value); return result('preview', { preview: value }); } });
    await f.open(); await f.controller.receive({ type: 'preview', binding: f.controller.view.editor.binding });
    assert.equal(f.controller.view.preview, null); assert.match(f.controller.view.error, /exact retained draft revision/); f.controller.dispose();
  }
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ preview: async () => { await gate; return result('preview', { preview: packagePreview() }); } }); await f.open();
  const previewing = f.controller.receive({ type: 'preview', binding: f.controller.view.editor.binding }); await settle();
  const changed = f.edit(); await f.controller.receive({ type: 'change', ...changed }); release(); await previewing;
  assert.equal(f.controller.view.preview, null); assert.equal(f.controller.view.editor.inputText, changed.inputText);
  assert.match(f.controller.view.error, /New captured edits arrived during navigation/); f.controller.dispose();
});

test('Preview flushes opted-in captured text first and observes only the acknowledged revision', async () => {
  const clock = fakeClock(); const f = fixture({}, clock); await f.open();
  await f.controller.receive({ type: 'autosave-on', binding: f.controller.view.editor.binding });
  await f.controller.receive({ type: 'preview', ...f.edit() });
  assert.equal(f.controller.view.dirty, false); assert.equal(f.controller.view.preview.source.revision, 2);
  const operations = f.calls.map((call) => call.args[2]);
  assert.deepEqual(operations.slice(-3), ['save', 'list', 'preview']);
  assert.equal(f.controller.view.editor.head, secondHead); f.controller.dispose();
});

test('catalog answers come only from the exact captured choice set and never select optional tools or invent reviewer authority', async () => {
  const text = addWorkflowDraftStage('{"payload":{"id":"typed-goal","unknown":"keep"},"assets":[]}', 'typed-goal');
  for (const choiceKind of ['execution-task', 'approval-authority', 'quality-command']) {
    const f = fixture({ read: async () => result('read', { head: firstHead, record: revision(), payload: JSON.parse(text).payload, assets: [], tombstone: null }) });
    await f.open(); await f.controller.receive({ type: 'preview', binding: f.controller.view.editor.binding });
    const choiceId = choiceKind === 'execution-task' ? 'analyze' : choiceKind === 'approval-authority' ? 'real-reviewers' : 'actual-check';
    await f.controller.receive({ type: 'catalog-answer', binding: f.controller.view.editor.binding, choiceKind, choiceId, index: 0 });
    assert.equal(f.controller.view.error, null);
    const payload = JSON.parse(f.controller.view.editor.inputText).payload;
    const selected = Object.values(payload.bindings)[0]; assert.deepEqual(selected, { source: 'catalog', kind: choiceKind, id: choiceId });
    assert.deepEqual(payload.definitions.agents[0].toolBindings, []);
    assert.equal(payload.unknown, 'keep'); assert.equal(f.controller.view.preview, null);
    assert.equal(f.calls.some((call) => call.args[2] === 'save'), false, 'opt-in remains separate; body is memory-only until Save');
    f.controller.dispose();
  }
  const invalid = fixture(); await invalid.open(); await invalid.controller.receive({ type: 'preview', binding: invalid.controller.view.editor.binding });
  const original = invalid.controller.view.editor.inputText;
  await invalid.controller.receive({ type: 'catalog-answer', binding: invalid.controller.view.editor.binding, choiceKind: 'approval-authority', choiceId: 'invented-admins', index: 0 });
  assert.match(invalid.controller.view.error, /not present in the exact captured catalog choice set/);
  assert.equal(invalid.controller.view.editor.inputText, original); invalid.controller.dispose();
});

test('catalog selection retains literal approved check identifiers instead of applying candidate pathname rules', async () => {
  const text = addWorkflowDraftStage('{"payload":{"id":"typed-goal"},"assets":[]}', 'typed-goal');
  for (const id of ['check:lint', `check:${'é'.repeat(253)}`]) {
    const f = fixture({ read: async () => result('read', { head: firstHead, record: revision(), payload: JSON.parse(text).payload, assets: [], tombstone: null }),
      preview: async () => { const preview = packagePreview(); const group = preview.catalogChoices.groups.find((entry) => entry.kind === 'quality-command');
        group.choices = [{ ref: { source: 'catalog', kind: 'quality-command', id }, label: id }]; return result('preview', { preview }); } });
    await f.open(); await f.controller.receive({ type: 'preview', binding: f.controller.view.editor.binding });
    await f.controller.receive({ type: 'catalog-answer', binding: f.controller.view.editor.binding, choiceKind: 'quality-command', choiceId: id, index: 0 });
    assert.equal(f.controller.view.error, null); assert.equal(Object.values(JSON.parse(f.controller.view.editor.inputText).payload.bindings)[0].id, id);
    f.controller.dispose();
  }
  for (const id of ['check\0lint', 'check\nlint', 'x'.repeat(513), 'é'.repeat(257), 'check:\ud800']) {
    assert.throws(() => selectWorkflowDraftCatalog(text, 'quality-command', id, 0), /bounded captured catalog reference/);
  }
  assert.throws(() => editWorkflowDraftGuide(text, 'id', 'check:lint'), /kebab-case/, 'candidate pathname identity stays separate and constrained');
});

test('actual page script sends bounded literal captured check IDs and refuses oversized catalog values', () => {
  const posted = []; const handlers = {};
  const fields = { 'draft-binding': { value: 'retained-binding' }, 'draft-name': { value: 'Name' }, 'draft-input': { value: '{"payload":{}}' },
    'draft-input-error': { textContent: '', hidden: true }, 'catalog-quality-command-0': { value: 'check:lint' } };
  class Element { closest() { return this; } }
  class HTMLButtonElement extends Element { constructor() { super(); this.dataset = { draftAction: 'catalog-answer', choiceKind: 'quality-command',
    choiceSelect: 'catalog-quality-command-0', guideIndex: '0' }; this.disabled = false; } }
  runInNewContext(SHARED_WORKFLOW_DRAFTS_SCRIPT, { window: { __sfVscode: { postMessage: (message) => posted.push(message) }, addEventListener: () => {} },
    document: { getElementById: (id) => fields[id], addEventListener: (type, listener) => { handlers[type] = listener; } }, Element, HTMLButtonElement, TextEncoder });
  for (const id of ['check:lint', `check:${'é'.repeat(253)}`]) {
    fields['catalog-quality-command-0'].value = id; handlers.click({ target: new HTMLButtonElement() });
    assert.equal(posted.at(-1).choiceId, id); assert.equal(posted.at(-1).choiceKind, 'quality-command');
  }
  for (const id of ['é'.repeat(257), 'check\0lint']) { fields['catalog-quality-command-0'].value = id; handlers.click({ target: new HTMLButtonElement() }); }
  assert.equal(posted.length, 2); assert.match(fields['draft-input-error'].textContent, /bounded captured catalog value/);
});

test('explicit captured-base selection binds real approved commit/target and refuses advanced conflicting scope', async () => {
  const f = fixture(); await f.open(); await f.controller.receive({ type: 'preview', binding: f.controller.view.editor.binding });
  await f.controller.receive({ type: 'catalog-answer', binding: f.controller.view.editor.binding, choiceKind: 'approved-base' });
  const payload = JSON.parse(f.controller.view.editor.inputText).payload;
  assert.equal(payload.baseRevision, firstHead); assert.deepEqual(payload.target, { hosts: [], governs: 'story', authority: 'selected-repository' });
  assert.equal(payload.schema, 'sflow-workflow-request@2'); assert.equal(payload.id, 'partial');
  assert.equal(f.controller.view.dirty, true); assert.equal(f.calls.some((call) => call.args[2] === 'save'), false);
  const scoped = fixture({ read: async () => result('read', { head: firstHead, record: revision(), payload: { target: { governs: 'initiative' } }, assets: [], tombstone: null }) });
  await scoped.open(); await scoped.controller.receive({ type: 'preview', binding: scoped.controller.view.editor.binding });
  await scoped.controller.receive({ type: 'catalog-answer', binding: scoped.controller.view.editor.binding, choiceKind: 'approved-base' });
  assert.match(scoped.controller.view.error, /another target.*No scope was silently changed/);
  assert.equal(JSON.parse(scoped.controller.view.editor.inputText).payload.target.governs, 'initiative');
  f.controller.dispose(); scoped.controller.dispose();
});

test('submission review is exact saved-revision Shell/Copilot copy-only, never a CLI write or webview consent token', async () => {
  const f = fixture(); await f.open();
  await f.controller.receive({ type: 'submit-review', binding: f.controller.view.editor.binding });
  await f.controller.receive({ type: 'copilot-submit-review', binding: f.controller.view.editor.binding });
  assert.deepEqual(f.copied, [{ root: repository, argv: ['workflow', 'author', 'submit', draftId, '--revision', '1'], surface: 'shell' },
    { root: repository, argv: ['workflow', 'author', 'submit', draftId, '--revision', '1'], surface: 'copilot' }]);
  assert.match(f.controller.view.notice, /copied only.*Nothing was submitted or executed/);
  await f.controller.receive({ type: 'submit-review', ...f.edit() });
  assert.equal(f.copied.length, 2); assert.match(f.controller.view.error, /No route was copied/);
  assert.equal(f.calls.some((call) => ['submit', 'approve'].includes(call.args[2])), false); f.controller.dispose();
});

test('guided output bounds and captured-asset content edits preserve exact representation and unrelated manual assets', () => {
  let text = '{"payload":{"id":"literal-package","definitions":{"phases":[{"id":"note"}],"agents":[{"id":"writer","promptAsset":"prompts/writer.md"}],"templates":[]}},"assets":[{"path":"prompts/writer.md","content":"Old exact manual text"},{"path":"notes/keep.txt","content":"Do not replace"}]}';
  text = editWorkflowDraftGuide(text, 'agent-prompt', 'Explicit new manual text');
  text = editWorkflowDraftGuide(text, 'phase-artifact-path', 'artifacts/note/note.md');
  text = editWorkflowDraftGuide(text, 'phase-artifact-kind', 'custom:note');
  text = editWorkflowDraftGuide(text, 'phase-artifact-minimum', '20');
  text = editWorkflowDraftGuide(text, 'phase-artifact-maximum', '16384');
  text = editWorkflowDraftGuide(text, 'phase-write-scope', 'artifact-only');
  const value = JSON.parse(text);
  assert.equal(value.payload.definitions.agents[0].promptAsset, 'prompts/writer.md');
  assert.equal(value.payload.definitions.agents[0].prompt, undefined);
  assert.deepEqual(value.assets, [{ path: 'prompts/writer.md', content: 'Explicit new manual text' }, { path: 'notes/keep.txt', content: 'Do not replace' }]);
  assert.deepEqual(value.payload.definitions.phases[0].artifact, { path: 'artifacts/note/note.md', kind: 'custom:note', minimumBytes: 20, maximumBytes: 16384 });
  assert.equal(value.payload.definitions.phases[0].writeScope, 'artifact-only');
  assert.throws(() => editWorkflowDraftGuide(text, 'phase-artifact-minimum', '-1'), /positive bounded integers/);
  assert.throws(() => editWorkflowDraftGuide(text, 'phase-write-scope', 'source-and-artifact'), /admitted owner/);
  value.payload.definitions.agents[0].prompt = 'Conflicting inline source';
  assert.throws(() => editWorkflowDraftGuide(JSON.stringify(value), 'agent-prompt', 'Must not normalize'), /one explicit content representation/);
});

test('catalog source mismatch or stale preview cannot be used to overwrite an existing binding', async () => {
  const f = fixture({ preview: async () => {
    const value = packagePreview(); value.catalogChoices.approvedSource = { ...value.approvedSource, baseRevision: latestHead };
    return result('preview', { preview: value });
  } }); await f.open(); await f.controller.receive({ type: 'preview', binding: f.controller.view.editor.binding });
  const original = f.controller.view.editor.inputText;
  await f.controller.receive({ type: 'catalog-answer', binding: f.controller.view.editor.binding, choiceKind: 'approved-base' });
  assert.equal(f.controller.view.editor.inputText, original); assert.match(f.controller.view.error, /source-bound navigation-only/);
  f.controller.dispose();
});

test('fresh-list Create cannot silently change the destination disclosed by the clicked list', async () => {
  let destination = '/approved/shared.git'; let created = 0;
  const f = fixture({ list: async () => ({ ...result('list', { head: firstHead, drafts: [], nextCursor: null }), capability: { repository: destination } }),
    create: async () => { created += 1; throw new Error('No first redirected create is allowed.'); } });
  await f.controller.initialize(); destination = '/replacement/shared.git';
  await f.controller.receive({ type: 'create' });
  assert.equal(created, 0); assert.equal(f.controller.view.authority, destination);
  assert.match(f.controller.view.error, /changed while creating.*Review the refreshed authority.*no draft was written/);
  f.controller.dispose();
});

test('actual CLI-backed clients share identity, fence autosave races and Preview captured catalog choices before copy-only Submit', async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-shared-drafts-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const application = path.join(base, 'opened'); const peer = path.join(base, 'peer');
  const remote = path.join(base, 'shared.git');
  const git = async (cwd, ...args) => (await execute('git', args, { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  await git(base, 'init', '--bare', '-q', '-b', 'main', remote);
  await mkdir(application); await initializeDefinition(application);
  await git(application, 'init', '-q', '-b', 'main');
  await git(application, 'config', 'user.name', 'VSCode Draft Test');
  await git(application, 'config', 'user.email', 'vscode-drafts@example.test');
  await git(application, 'add', '.'); await git(application, 'commit', '-qm', 'approved fixture');
  await git(application, 'branch', 'sflow/config'); await git(application, 'remote', 'add', 'origin', remote);
  await git(application, 'push', '-q', 'origin', 'main', 'sflow/config');
  await git(base, 'clone', '-q', remote, peer);
  await git(peer, 'config', 'user.name', 'Independent Shell Draft Test');
  await git(peer, 'config', 'user.email', 'shell-drafts@example.test');
  const appHead = await git(application, 'rev-parse', 'HEAD');
  const appIndex = await readFile(path.join(application, '.git/index'));
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Shared Draft UI Test',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active-workspace.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_DISABLE_MODELS: '1' };
  const cli = async (cwd, args) => JSON.parse((await execute(process.execPath,
    [path.join(root, 'bin/singularity-flow.mjs'), ...args], { cwd, env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })).stdout);
  const commands = [];
  const clock = fakeClock();
  const privateKeys = new Map(); const secrets = { get: async (key) => privateKeys.get(key), store: async (key, value) => { privateKeys.set(key, value); } };
  const recoveryDirectory = path.join(base, 'private-extension-storage', 'workflow-draft-recovery');
  const recovery = createWorkflowDraftRecoveryStore(recoveryDirectory, secrets);
  const controller = new SharedWorkflowDraftController(application, async (argv, openedRoot) => {
    assert.equal(openedRoot, application); commands.push([...argv]);
    try { return { result: await cli(openedRoot, argv), error: null }; }
    catch (error) { return { result: null, error: error.message }; }
  }, withWorkflowDraftInputFile, { changed: () => {}, confirmDiscard: async () => true,
    copyReview: async () => { throw new Error('No deletion review was requested.'); } }, clock, recovery);
  t.after(() => controller.dispose());
  await controller.initialize(); await controller.receive({ type: 'create' });
  assert.equal(controller.view.error, null);
  const id = controller.view.editor.record.draftId;
  const text = JSON.stringify({ payload: { id: 'partial-package', definitions: { workflows: [{ id: 'candidate', phases: ['not-decided'] }] }, unknownBinding: null },
    assets: [{ path: '.github/skills/candidate/SKILL.md', content: 'Literal inert instructions, never installed.\n' }] });
  const fields = () => ({ binding: controller.view.editor.binding, name: 'Shared UI draft', inputText: text });
  await controller.receive({ type: 'save', ...fields() });
  assert.equal(controller.view.error, null);
  const saved = await cli(peer, ['workflow', 'author', 'read', id, '--json']);
  assert.equal(saved.data.record.revision, 2);
  assert.deepEqual(saved.data.payload, JSON.parse(text).payload);
  assert.equal(Buffer.from(saved.data.assets[0].contentBase64, 'base64').toString('utf8'), JSON.parse(text).assets[0].content);
  assert.equal(await recovery.read({ repository: application, authority: remote, draftId: id }), null,
    'clean shared ACK removes only its exact encrypted checkpoint');
  await assert.rejects(access(path.join(application, '.github/skills/candidate/SKILL.md')), /ENOENT/);
  await cli(peer, ['workflow', 'author', 'save', id, '--name', 'Shell peer renamed', '--epoch', '1',
    '--expected-head', saved.data.head, '--expected-authority', saved.capability.repository,
    '--operation-id', 'independent-shell-save', '--json']);
  const unsaved = { ...fields(), name: 'Unsaved after peer change' };
  await controller.receive({ type: 'save', ...unsaved });
  assert.match(controller.view.error, /WCA_DRAFT_CONFLICT/);
  assert.equal(controller.view.editor.name, unsaved.name);
  assert.equal(controller.view.editor.inputText, text);
  assert.equal(controller.view.dirty, true);
  await controller.receive({ type: 'reload', ...unsaved });
  assert.equal(controller.view.error, null);
  assert.equal(controller.view.editor.name, 'Shell peer renamed');
  assert.equal(controller.view.editor.record.revision, 3);
  await controller.receive({ type: 'show', binding: controller.view.editor.binding });
  assert.equal(controller.view.show.subject.draftId, id);
  assert.equal(controller.view.show.assessment.coverage.schema, 'invalid');
  assert.equal(controller.view.show.assessment.coverage.graph, 'ordered-input-and-registered-rework-validation');
  assert.equal(controller.view.show.capabilities.automaticSaving, 'vscode-opt-in');
  assert.equal(controller.view.show.preview.source.revisionSha256, controller.view.editor.record.revisionSha256);
  // Two independently rooted authoring clients open the same canonical head, accept different
  // complete semantic answers and autosave concurrently. Only one CAS may install revision 4.
  const peerCommands = [];
  const peerController = new SharedWorkflowDraftController(peer, async (argv, openedRoot) => {
    assert.equal(openedRoot, peer); peerCommands.push([...argv]);
    try { return { result: await cli(openedRoot, argv), error: null }; }
    catch (error) { return { result: null, error: error.message }; }
  }, withWorkflowDraftInputFile, { changed: () => {}, confirmDiscard: async () => false,
    copyReview: async () => { throw new Error('No review action requested.'); } }, clock,
  createWorkflowDraftRecoveryStore(recoveryDirectory, secrets));
  t.after(() => peerController.dispose());
  await peerController.initialize(); await peerController.receive({ type: 'open', draftId: id });
  assert.equal(peerController.view.editor.record.revision, 3);
  assert.equal(peerController.view.editor.head, controller.view.editor.head);
  for (const client of [controller, peerController]) await client.receive({ type: 'autosave-on', binding: client.view.editor.binding });
  await Promise.all([[controller, 'Actual UI autosave goal'], [peerController, 'Independent peer autosave goal']].map(([client, value]) =>
    client.receive({ type: 'guide-answer', binding: client.view.editor.binding, field: 'description', value, index: 0 })));
  const winner = [controller, peerController].find((client) => !client.view.error);
  const loser = [controller, peerController].find((client) => client.view.error);
  assert.ok(winner); assert.ok(loser); assert.equal(winner.view.editor.record.revision, 4);
  assert.equal(loser.view.editor.record.revision, 3); assert.equal(loser.view.durability, 'conflict');
  assert.match(loser.view.error, /WCA_DRAFT_CONFLICT/); assert.equal(loser.view.dirty, true);
  const winningShared = await cli(peer, ['workflow', 'author', 'read', id, '--json']);
  assert.equal(winningShared.data.record.revision, 4);
  assert.equal(winningShared.data.payload.description, JSON.parse(winner.view.editor.inputText).payload.description);
  assert.notEqual(winningShared.data.payload.description, JSON.parse(loser.view.editor.inputText).payload.description);
  const writeCounts = [commands.filter((argv) => argv[2] === 'save').length, peerCommands.filter((argv) => argv[2] === 'save').length];
  await clock.advance(20_000);
  assert.deepEqual([commands.filter((argv) => argv[2] === 'save').length, peerCommands.filter((argv) => argv[2] === 'save').length], writeCounts,
    'no silent retry, merge, rebase, duplicate revision or deleted-ID recreation');
  controller.dispose(); peerController.dispose();
  for (let attempt = 0; attempt < 100 && [controller, peerController].some((client) => client.view.recovery.status === 'writing'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok([controller, peerController].every((client) => client.view.recovery.status !== 'writing'));
  const reopenedCommands = []; const copied = [];
  const reopened = new SharedWorkflowDraftController(application, async (argv, openedRoot) => {
    assert.equal(openedRoot, application); reopenedCommands.push([...argv]); return { result: await cli(openedRoot, argv), error: null };
  }, withWorkflowDraftInputFile, { changed: () => {}, confirmDiscard: async () => true,
    copyReview: async (openedRoot, argv, surface) => copied.push({ root: openedRoot, argv: [...argv], surface }) }, clock,
  createWorkflowDraftRecoveryStore(recoveryDirectory, secrets));
  t.after(() => reopened.dispose());
  await reopened.initialize(); await reopened.receive({ type: 'open', draftId: id });
  assert.equal(reopened.view.editor.record.revision, 4);
  assert.equal(JSON.parse(reopened.view.editor.inputText).payload.description, winningShared.data.payload.description);
  assert.equal(reopened.view.autosave, false, 'resume does not transfer another editing scope or consent');
  const binding = reopened.view.editor.binding;
  if (reopened.view.recovery.candidate) {
    assert.equal(reopened.view.recovery.restoreAllowed, false, 'losing older-base checkpoint cannot overwrite the actual shared winner');
    assert.ok(reopened.view.recovery.candidate.pendingSave);
    await reopened.receive({ type: 'operation-status', binding });
    assert.equal(reopened.view.error, null);
    await reopened.receive({ type: 'recovery-discard', binding });
    assert.equal(reopened.view.error, null); assert.equal(reopened.view.recovery.candidate, null);
  }
  assert.equal(reopenedCommands.some((argv) => argv[2] === 'save'), false, 'encrypted recovery restart never autosaves or rebases');
  await reopened.receive({ type: 'preview', binding });
  assert.equal(reopened.view.error, null);
  const captured = reopened.view.preview;
  assert.equal(captured.source.repository, remote); assert.equal(captured.source.draftId, id);
  assert.equal(captured.source.revision, 4); assert.equal(captured.source.lifecycleEpoch, 1);
  assert.equal(captured.source.revisionSha256, winningShared.data.record.revisionSha256);
  assert.equal(captured.approvedSource.baseRevision, appHead);
  assert.equal(captured.coverage.schema, 'invalid'); assert.equal(captured.readiness.host, 'discovery-unverified');
  assert.equal(captured.effects.proposalCreated, false); assert.equal(captured.effects.executed, false);
  const catalog = await cli(peer, ['workflow', 'author', 'catalog', '--kind', 'phase', '--limit', '32', '--json']);
  assert.equal(catalog.operation.id, 'workflow.author.catalog'); assert.equal(catalog.operation.modelPolicy, 'never');
  assert.equal(catalog.data.catalogChoices.permissionEffect, 'none');
  assert.deepEqual(catalog.data.catalogChoices.approvedSource, captured.approvedSource);
  const group = captured.catalogChoices.groups.find((entry) => entry.kind === 'phase');
  assert.ok(group.choices.length > 0, 'choices are actual captured approved entries, not guessed defaults');
  assert.deepEqual(catalog.data.catalogChoices.groups[0].choices, group.choices);
  // Explicitly bind the captured approved source, checkpoint it, then request a fresh Preview.
  await reopened.receive({ type: 'catalog-answer', binding, choiceKind: 'approved-base' });
  assert.equal(reopened.view.error, null); assert.equal(reopened.view.preview, null);
  assert.equal(reopened.view.dirty, true); assert.equal(reopened.view.editor.record.revision, 4);
  await reopened.receive({ type: 'save', binding }); assert.equal(reopened.view.error, null);
  assert.equal(reopened.view.editor.record.revision, 5);
  await reopened.receive({ type: 'preview', binding }); assert.equal(reopened.view.error, null);
  const selected = reopened.view.preview.catalogChoices.groups.find((entry) => entry.kind === 'phase').choices[0].ref;
  await reopened.receive({ type: 'catalog-answer', binding, choiceKind: selected.kind, choiceId: selected.id, index: 0 });
  assert.equal(reopened.view.error, null); assert.equal(reopened.view.preview, null);
  assert.ok(JSON.parse(reopened.view.editor.inputText).payload.definitions.workflows[0].phases.includes(selected.id));
  await reopened.receive({ type: 'save', binding }); assert.equal(reopened.view.error, null);
  assert.equal(reopened.view.editor.record.revision, 6);
  await reopened.receive({ type: 'preview', binding }); assert.equal(reopened.view.error, null);
  assert.equal(reopened.view.preview.source.revision, 6);
  assert.equal(reopened.view.preview.source.revisionSha256, reopened.view.editor.record.revisionSha256);
  assert.equal(reopened.view.preview.readiness.authoring, 'invalid', 'unknown stage remains an honest decision gap');
  await reopened.receive({ type: 'submit-review', binding }); await reopened.receive({ type: 'copilot-submit-review', binding });
  assert.deepEqual(copied, ['shell', 'copilot'].map((surface) => ({ root: application,
    argv: ['workflow', 'author', 'submit', id, '--revision', '6'], surface })));
  assert.equal(reopenedCommands.some((argv) => ['submit', 'approve', 'execute', 'delete'].includes(argv[2])), false);
  const sharedCandidate = await cli(peer, ['workflow', 'author', 'read', id, '--json']);
  assert.equal(sharedCandidate.data.record.revision, 6);
  assert.equal(sharedCandidate.data.payload.baseRevision, appHead);
  assert.ok(sharedCandidate.data.payload.definitions.workflows[0].phases.includes(selected.id));
  assert.equal(sharedCandidate.data.payload.unknownBinding, null);
  assert.equal(Buffer.from(sharedCandidate.data.assets[0].contentBase64, 'base64').toString('utf8'), JSON.parse(text).assets[0].content);
  await assert.rejects(access(path.join(application, '.github/skills/candidate/SKILL.md')), /ENOENT/);
  assert.ok(commands.filter((argv) => ['create', 'save'].includes(argv[2])).every((argv) => argv.includes('--expected-authority')));
  assert.equal(await git(application, 'rev-parse', 'HEAD'), appHead);
  assert.deepEqual(await readFile(path.join(application, '.git/index')), appIndex);
  assert.equal(await git(remote, 'rev-parse', 'refs/heads/main'), appHead);
  assert.equal(await git(remote, 'rev-parse', 'refs/heads/sflow/config'), appHead);
});
