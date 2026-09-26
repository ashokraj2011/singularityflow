import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile, stat, rm, mkdir, mkdtemp } from 'node:fs/promises';
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
const { sharedWorkflowDraftsHtml, SHARED_WORKFLOW_DRAFTS_SCRIPT } = await import(path.join(root, 'apps/vscode/src/views/workflow-drafts-page.ts'));

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

function fixture(overrides = {}) {
  const calls = []; const copied = []; const inputs = []; const notices = []; const rejected = []; const inputFiles = [];
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
    if (action === 'show') return { result: result(action, { view: { kind: 'workflow-authoring-show-view',
      subject: { draftId, revision: loadedRevision.revision, revisionSha256: loadedRevision.revisionSha256 },
      assessment: { coverage: 'complete-package-validation-unavailable' }, missingDecisions: [], graph: { coverage: 'unavailable' } } }), error: null };
    throw new Error(`Unexpected action ${action}`);
  };
  const controller = new SharedWorkflowDraftController(repository, runner, async (text, invoke) => {
    inputs.push(text);
    const file = inputs.length === 1 ? '/private/temporary/input.json' : `/private/temporary/input-${inputs.length}.json`;
    inputFiles.push(file); return invoke(file);
  }, {
    changed: () => notices.push(controller.view.busy),
    editorRejected: (binding, message) => rejected.push({ binding, message }),
    confirmDiscard: async () => confirmation,
    copyReview: async (callRoot, argv, surface) => copied.push({ root: callRoot, argv, surface })
  });
  const edit = (inputText = '{"payload":{"id":"unsaved"},"assets":[]}', name = 'Edited') => ({
    binding: controller.view.editor.binding, name, inputText
  });
  const open = async () => { await controller.initialize(); await controller.receive({ type: 'open', draftId }); };
  return { controller, calls, copied, inputs, notices, rejected, inputFiles, open, edit,
    setListHead: (value) => { listHead = value; }, confirm: (value) => { confirmation = value; } };
}

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
  assert.match(f.controller.view.notice, /readiness are unavailable/);
  await f.controller.receive({ type: 'approve', ...fields });
  assert.match(f.controller.view.error, /not supported/);
  assert.equal(f.calls.filter((call) => !['list', 'read', 'show'].includes(call.args[2])).length, 0);
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
  assert.match(html, /No autosave, complete-package compiler/);
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
  assert.match(panel, /showWarningMessage\([\s\S]*Cancel keeps the unsaved text/);
  assert.doesNotMatch(panel, /executeCommand|createTerminal|sendText|issueActionAuthorization|useRepository|openGitDraftStore/);
});

test('actual CLI-backed editor and an independent shell share one identity and stale Save preserves the buffer', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-shared-drafts-'));
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
  const controller = new SharedWorkflowDraftController(application, async (argv, openedRoot) => {
    assert.equal(openedRoot, application); commands.push([...argv]);
    try { return { result: await cli(openedRoot, argv), error: null }; }
    catch (error) { return { result: null, error: error.message }; }
  }, withWorkflowDraftInputFile, { changed: () => {}, confirmDiscard: async () => true,
    copyReview: async () => { throw new Error('No deletion review was requested.'); } });
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
  assert.equal(controller.view.show.assessment.coverage, 'complete-package-validation-unavailable');
  assert.equal(controller.view.show.capabilities.automaticSaving, 'unavailable');
  assert.ok(commands.filter((argv) => ['create', 'save'].includes(argv[2])).every((argv) => argv.includes('--expected-authority')));
  assert.equal(await git(application, 'rev-parse', 'HEAD'), appHead);
  assert.deepEqual(await readFile(path.join(application, '.git/index')), appIndex);
  assert.equal(await git(remote, 'rev-parse', 'refs/heads/main'), appHead);
  assert.equal(await git(remote, 'rev-parse', 'refs/heads/sflow/config'), appHead);
});
