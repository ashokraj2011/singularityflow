/** Escaped, nonce-shell content. Draft JSON is never executable webview markup. */
import { WORKFLOW_DRAFT_INPUT_MAX_BYTES, type SharedWorkflowDraftView } from './workflow-drafts-model.ts';
import { escape } from './webview.ts';

export function sharedWorkflowDraftsHtml(view: SharedWorkflowDraftView): string {
  const editor = view.editor;
  const disabled = view.busy ? ' disabled' : '';
  const show = view.show;
  const missing = show && Array.isArray(show.missingDecisions) ? show.missingDecisions : [];
  return `<main aria-labelledby="drafts-title"><header><p class="eyebrow">Workflow authoring · Shared Git drafts</p>
    <h1 id="drafts-title">Shared Workflow Drafts</h1><p>List, read and explicitly save inert partial workflow packages through the same CLI DraftStore used by a shell.</p>
    <p class="muted">Opened repository: <code>${escape(view.repository)}</code><br>Draft authority: <code>${escape(view.authority ?? 'Not observed yet')}</code></p>
    <p>No autosave, complete-package compiler, submission, approval, host installation or execution is provided by this editor.</p></header>
    ${view.error ? `<section class="warning" role="alert"><strong>Draft operation needs attention</strong><p>${escape(view.error)}</p><p>The editor buffer is retained. A write may need operation-status reconciliation; a conflict requires explicit Reload, never automatic overwrite.</p></section>` : ''}
    ${view.notice ? `<p role="status" aria-live="polite">${escape(view.notice)}</p>` : ''}
    ${view.operationId ? `<p class="muted">Last write operation ID: <code>${escape(view.operationId)}</code>. Check status first; then explicitly Save retained text with the same ID if unchanged.</p><button type="button" class="secondary" data-draft-action="operation-status"${disabled}>Check last write status (read-only)</button>` : ''}
    ${view.busy ? '<p role="status" aria-live="polite">Waiting for the shared-draft CLI…</p>' : ''}
    <section><h2>Shared drafts</h2><div class="form-actions"><button type="button" class="secondary" data-draft-action="refresh"${disabled}>Refresh shared list</button>
      <button type="button" data-draft-action="create"${disabled}>Create empty shared draft</button></div>
      ${view.drafts.length ? `<table><thead><tr><th>Draft</th><th>Saved revision</th><th>Open</th></tr></thead><tbody>${view.drafts.map((draft) => `<tr><td>${escape(draft.displayName)}<br><code>${escape(draft.draftId)}</code></td><td>${escape(draft.revision)}</td><td><button type="button" class="secondary" data-draft-action="open" data-draft-id="${escape(draft.draftId)}"${disabled}>Open draft</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No live shared drafts were observed. Refresh or create an empty draft.</p>'}</section>
    ${editor ? `<section><h2>Draft editor · <code>${escape(editor.record.draftId)}</code></h2>
      <p>Retained saved revision ${escape(editor.record.revision)} · lifecycle epoch ${escape(editor.record.lifecycleEpoch)}<br>
      <code>${escape(editor.record.revisionSha256)}</code><br>Compare-and-swap head: <code>${escape(editor.head)}</code><br>Retained draft authority: <code>${escape(editor.authority)}</code></p>
      <p id="draft-dirty" role="status" aria-live="polite">${view.dirty ? 'Unsaved editor changes · explicit Save required.' : 'Editor matches the retained saved revision.'}</p>
      <p class="muted">Unsaved text exists only in this open panel. Save before closing; no local shadow draft or autosave is created.</p>
      <p id="draft-input-error" class="warning" role="alert" hidden></p>
      ${editor.readOnlyReason ? `<p class="warning">${escape(editor.readOnlyReason)}</p>` : ''}
      <input type="hidden" id="draft-binding" value="${escape(editor.binding)}">
      <label for="draft-name">Display name<input id="draft-name" value="${escape(editor.name)}" autocomplete="off"${view.busy || editor.readOnlyReason ? ' disabled' : ''}></label>
      <label for="draft-input">Partial package JSON and literal assets<textarea id="draft-input" rows="22" spellcheck="false"${view.busy || editor.readOnlyReason ? ' readonly' : ''}>${escape(editor.inputText)}</textarea></label>
      <p class="muted">Closed JSON envelope: <code>{"payload": {…}, "assets": [{"path": "logical/path", "content": "literal text"}]}</code>. Paths are labels, not local file reads. Missing decisions are allowed; secret/environment-local storage admission still applies.</p>
      <div class="form-actions"><button type="button" data-draft-action="save"${view.busy || editor.readOnlyReason ? ' disabled' : ''}>Save shared revision</button>
      <button type="button" class="secondary" data-draft-action="reload"${disabled}>Reload latest (discard unsaved changes…)</button>
      <button type="button" class="secondary" data-draft-action="show"${disabled}>Show saved revision (read-only)</button></div>
      <details><summary>Delete via terminal review</summary><p>Native webview deletion confirmation is unavailable. This prepares a terminal command only; the terminal separately presents the exact current draft, repository and revision with Cancel as the default. Submitted snapshots and active workflows are not deletion targets.</p>
      <p class="muted">Shell copy is rooted to this exact repository. Copilot copy requires this repository to be the only opened folder; its headless route cannot capture deletion consent.</p>
      <button type="button" class="secondary" data-draft-action="terminal-review"${disabled}>Copy Shell review command</button>
      <button type="button" class="secondary" data-draft-action="copilot-review"${disabled}>Copy Copilot handoff</button></details></section>` : '<section><p>Open a shared draft to edit its partial package.</p></section>'}
    ${show ? `<section aria-labelledby="draft-show-title"><h2 id="draft-show-title">Read-only Show · saved revision</h2>
      <p>Assessment: partial. Complete-package validation, graph coverage and execution readiness are unavailable. No approval or host acceptance is implied.</p>
      <h3>Missing decisions reported by the storage-only projection</h3>${missing.length ? `<ul>${missing.slice(0, 64).map((decision) => {
        const item = decision && typeof decision === 'object' ? decision as Record<string, unknown> : {};
        return `<li>${escape(item.label)} · <code>${escape(item.fieldPath)}</code></li>`;
      }).join('')}</ul>` : '<p>No missing fields were reported by this partial projection. This is not a ready-to-run verdict.</p>'}
      <details><summary>Exact saved-revision Show JSON</summary><pre><code>${escape(JSON.stringify(show, null, 2))}</code></pre></details></section>` : ''}
    </main>`;
}

export const SHARED_WORKFLOW_DRAFTS_SCRIPT = `
  const draftsVscode = window.__sfVscode;
  const showEditorError = (message) => {
    const error = document.getElementById('draft-input-error');
    if (error) { error.textContent = message; error.hidden = !message; }
  };
  const editorFields = () => {
    const binding = document.getElementById('draft-binding');
    const name = document.getElementById('draft-name');
    const input = document.getElementById('draft-input');
    if (!binding || !name || !input) return {};
    if (new TextEncoder().encode(input.value).byteLength > ${WORKFLOW_DRAFT_INPUT_MAX_BYTES}) {
      showEditorError('Draft JSON exceeds the 5 MiB transport limit. This pasted text remains only in this visible editor and is not sent or saved. Reduce it before any panel action.');
      return null;
    }
    if (new TextEncoder().encode(name.value).byteLength > 512 || /[\\0\\r\\n]/u.test(name.value)) {
      showEditorError('Display name exceeds its bounded single-line limit. The visible text is retained and not sent. Reduce it before any panel action.');
      return null;
    }
    showEditorError('');
    return { binding: binding.value, name: name.value, inputText: input.value };
  };
  document.addEventListener('input', (event) => {
    if (event.target?.id !== 'draft-name' && event.target?.id !== 'draft-input') return;
    const status = document.getElementById('draft-dirty');
    if (status) status.textContent = 'Unsaved editor changes · explicit Save required.';
    const fields = editorFields();
    if (fields) draftsVscode.postMessage({ type: 'change', ...fields });
  });
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-draft-action]') : null;
    if (!(target instanceof HTMLButtonElement) || target.disabled) return;
    const fields = editorFields();
    if (!fields) return;
    draftsVscode.postMessage({ type: target.dataset.draftAction, ...fields,
      ...(target.dataset.draftId ? { draftId: target.dataset.draftId } : {}) });
  });
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.type !== 'editor-rejected' || typeof message.message !== 'string'
        || message.message.length > 4000 || message.binding !== document.getElementById('draft-binding')?.value) return;
    showEditorError(message.message + ' The visible text has not been replaced or sent to the CLI. Reduce it before any panel action.');
  });
`;
