import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { WorkflowDraftComparisonBuffers, WORKFLOW_DRAFT_COMPARISON_SCHEME } from '../apps/vscode/src/views/workflow-drafts-comparison.ts';
import { sharedWorkflowDraftsHtml, workflowDraftRecoveryLabel, SHARED_WORKFLOW_DRAFTS_SCRIPT } from '../apps/vscode/src/views/workflow-drafts-page.ts';

const comparison = () => ({ draftId: 'WFD-ABC123', checkpointId: '01234567-89ab-4cde-8fab-0123456789ab',
  checkpointName: 'Private', checkpointText: '{"payload":', sharedName: 'Shared', sharedText: '{"payload":{}}',
  baseRevision: 1, currentRevision: 2 });

test('private comparison retains incomplete literal text only behind opaque read-only virtual URIs', () => {
  const buffers = new WorkflowDraftComparisonBuffers();
  const value = comparison(); value.checkpointText = '\ufeff{\r\n"content":"</textarea><script>text only</script>"';
  const opened = buffers.add(value);
  assert.match(opened.left, new RegExp(`^${WORKFLOW_DRAFT_COMPARISON_SCHEME}:/[a-f0-9-]{36}/private\\.txt$`));
  assert.ok(!opened.left.includes(value.checkpointId));
  assert.ok(!opened.left.includes(value.draftId));
  assert.equal(buffers.content(opened.left), `Display name: Private\n\n${value.checkpointText}`);
  assert.equal(buffers.content(opened.right), `Display name: Shared\n\n${value.sharedText}`);
  assert.equal(buffers.content('file:///private.txt'), undefined);
  assert.equal(buffers.content(`${opened.left}?other`), undefined);
  assert.match(opened.title, /base 1.*shared revision 2/u);
  buffers.release(opened.left);
  assert.equal(buffers.content(opened.left), undefined);
  assert.notEqual(buffers.content(opened.right), undefined);
  buffers.clear(); assert.equal(buffers.content(opened.right), undefined);
});

test('comparison is bounded, never silently evicts open private documents and rejects forged metadata', () => {
  const buffers = new WorkflowDraftComparisonBuffers(); const opened = [];
  for (let index = 0; index < 4; index += 1) opened.push(buffers.add(comparison()));
  assert.throws(() => buffers.add(comparison()), /Close an earlier/u);
  assert.ok(buffers.content(opened[0].left));
  buffers.release(opened[0].left); buffers.release(opened[0].right);
  assert.ok(buffers.add(comparison()));
  for (const value of [
    { ...comparison(), draftId: '../../other' }, { ...comparison(), currentRevision: 0 },
    { ...comparison(), checkpointName: 'one\ntwo' }, { ...comparison(), checkpointId: 'other' },
    { ...comparison(), checkpointText: 'x'.repeat(5 * 1024 * 1024 + 1) }
  ]) assert.throws(() => new WorkflowDraftComparisonBuffers().add(value), /bounded/u);
});

test('recovery UI separates shared status, local acknowledgement and explicit choices without disclosing candidate text', () => {
  const record = { draftId: 'WFD-ABC123', displayName: 'Shared', revision: 1, lifecycleEpoch: 1, revisionSha256: `sha256:${'a'.repeat(64)}` };
  const candidate = { checkpointId: comparison().checkpointId, capturedAt: '2026-09-27T00:00:00.000Z',
    base: { record }, buffer: { name: 'private candidate', text: 'PRIVATE-CANDIDATE-NOT-RESTORED' } };
  const view = { repository: '/exact/repository', authority: '/exact/shared.git', drafts: [record], listHead: 'a'.repeat(40),
    editor: { binding: 'test-binding', record, head: 'a'.repeat(40), authority: '/exact/shared.git',
      name: 'Shared', inputText: '{"payload":{},"assets":[]}', readOnlyReason: null },
    busy: false, dirty: false, error: null, notice: null, show: null, preview: null, operationId: null,
    stage: 1, autosave: false, durability: 'shared', recovery: { status: 'saved', checkpoint: null, candidate,
      candidateAvailable: true, restoreAllowed: false } };
  const html = sharedWorkflowDraftsHtml(view);
  assert.match(html, /Shared revision 1/u);
  assert.match(html, /Private recovery available.*not automatically restored/u);
  assert.match(html, /data-draft-action="recovery-restore" disabled/u);
  assert.match(html, /data-draft-action="recovery-compare"/u);
  assert.match(html, /data-draft-action="recovery-discard"/u);
  assert.doesNotMatch(html, /PRIVATE-CANDIDATE-NOT-RESTORED/u);
  assert.doesNotMatch(html, /No private recovery checkpoint/u);
  view.recovery = { ...view.recovery, candidate: null, candidateAvailable: false, status: 'writing' };
  assert.match(workflowDraftRecoveryLabel(view), /not yet acknowledged locally/u);
  view.recovery.status = 'failed'; view.recovery.message = 'Key unavailable';
  assert.match(workflowDraftRecoveryLabel(view), /needs attention.*Key unavailable/u);
});

test('status-only DOM relay preserves editor text and cannot re-enable stale Restore or read-only edit controls', () => {
  const handlers = {}; const posted = [];
  const fields = { 'draft-binding': { value: 'retained-binding' }, 'draft-name': { value: 'Shared' },
    'draft-input': { value: '{"payload":{}}' }, 'draft-input-error': { hidden: true }, 'draft-recovery-status': {},
    'draft-recovery-choice': { hidden: false } };
  class Element { closest() { return this; } }
  class HTMLButtonElement extends Element { constructor(action) { super(); this.dataset = { draftAction: action }; this.disabled = false; } }
  const buttons = ['recovery-restore', 'recovery-compare', 'recovery-discard', 'save', 'catalog-answer', 'autosave-on', 'refresh'].map((action) => new HTMLButtonElement(action));
  runInNewContext(SHARED_WORKFLOW_DRAFTS_SCRIPT, {
    window: { __sfVscode: { postMessage: (message) => posted.push(message) }, addEventListener: (type, listener) => { handlers[type] = listener; } },
    document: { getElementById: (id) => fields[id], querySelectorAll: () => buttons, addEventListener: () => {} },
    Element, HTMLButtonElement, TextEncoder
  });
  handlers.message({ data: { type: 'draft-status', binding: 'retained-binding', busy: false,
    readOnly: true, dirty: true, hasRecoveryCandidate: true, restoreAllowed: false, recovery: 'Private recovery available' } });
  assert.deepEqual(buttons.map((button) => button.disabled), [true, false, false, true, true, true, false]);
  assert.equal(fields['draft-input'].value, '{"payload":{}}');
  assert.equal(fields['draft-recovery-status'].textContent, 'Private recovery available');
  assert.equal(posted.length, 0, 'a status message cannot perform restore or a write');
  handlers.message({ data: { type: 'draft-status', binding: 'retained-binding', busy: false,
    readOnly: false, dirty: false, hasRecoveryCandidate: false, restoreAllowed: true } });
  assert.deepEqual(buttons.slice(0, 3).map((button) => button.disabled), [true, true, true]);
  assert.equal(fields['draft-recovery-choice'].hidden, true);
  fields['draft-input'].value = 'x'.repeat(5 * 1024 * 1024 + 1);
  handlers.message({ data: { type: 'draft-status', binding: 'retained-binding', busy: false,
    recovery: 'Private checkpoint saved on this machine' } });
  assert.match(fields['draft-recovery-status'].textContent, /Visible text is not privately checkpointed.*prior bounded capture/u);
  assert.equal(fields['draft-input'].value.length, 5 * 1024 * 1024 + 1);
});

test('production panel wires encrypted local storage and read-only virtual comparison rather than plaintext or shared persistence', async () => {
  const source = await readFile(new URL('../apps/vscode/src/views/workflow-drafts.ts', import.meta.url), 'utf8');
  assert.match(source, /createWorkflowDraftRecoveryStore\(path\.join\(context\.globalStorageUri\.fsPath, 'workflow-draft-recovery'\), context\.secrets\)/u);
  assert.match(source, /registerTextDocumentContentProvider\(WORKFLOW_DRAFT_COMPARISON_SCHEME/u);
  assert.match(source, /onDidCloseTextDocument.*buffers\.release/u);
  assert.match(source, /executeCommand\('vscode\.diff'/u);
  assert.match(source, /compareRecovery: privateComparisonHost\(context\)/u);
  assert.match(source, /'recovery-restore': handle.*'recovery-compare': handle.*'recovery-discard': handle/u);
  assert.doesNotMatch(source, /globalState\.update|workspaceState\.update|setKeysForSync|writeFile\(/u);
});
