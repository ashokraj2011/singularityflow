/** Scrollable, plain-text human confirmation. Presentation never supplies consent. */
import { escape } from './webview.ts';
import { booleanField, stringField, type InboundMessage } from './messages.ts';

export interface ReviewConfirmationRequest {
  title: string;
  summary: string;
  detail: string;
  confirmLabel: string;
  /** When present, the human must type these exact bytes; never prefilled or shortened. */
  expected?: string;
}

export function reviewConfirmationAccepted(request: ReviewConfirmationRequest, message: InboundMessage): boolean {
  return request.expected !== undefined
    ? Boolean(request.expected) && stringField(message, 'confirmation') === request.expected
    : booleanField(message, 'acknowledged');
}

export function reviewConfirmationBody(request: ReviewConfirmationRequest): string {
  return `<div class="confirmation-layout">
    <header class="confirmation-heading"><h1>${escape(request.title)}</h1>
      <p class="meta">${escape(request.summary)}</p></header>
    <main class="confirmation-content" tabindex="0" aria-label="Exact change to review">
      <pre>${escape(request.detail)}</pre>
      <p class="muted">No changes are made until you confirm. Cancel or close this page to leave things unchanged.</p>
    </main>
    <form class="confirmation-controls" data-expected="${escape(request.expected ?? '')}"
      data-typed="${request.expected !== undefined}">
      ${request.expected !== undefined
        ? `<label for="review-confirmation">Type this exact value: <code>${escape(request.expected)}</code></label>
          <input id="review-confirmation" data-confirmation autocomplete="off" spellcheck="false" required>
          <small class="muted">The confirmation is intentionally empty. Do not enter a command.</small>`
        : `<label class="confirmation-ack"><input type="checkbox" data-acknowledged>
          I reviewed this exact change and want to proceed.</label>`}
      <div class="confirmation-actions"><button type="submit" disabled>${escape(request.confirmLabel)}</button>
        <button type="button" class="secondary" data-cancel>Cancel</button></div>
    </form>
  </div>`;
}

export const REVIEW_CONFIRMATION_STYLE = `
html { height:100%; }
body { height:100vh; height:100dvh; padding:0 .75rem; display:flex; flex-direction:column; overflow:hidden; }
.confirmation-layout { flex:1; min-height:0; display:grid; grid-template-rows:auto minmax(0,1fr) auto; }
.confirmation-heading { max-height:24vh; overflow:auto; padding:.75rem 0; }
.confirmation-heading h1 { margin:0 0 .35rem; overflow-wrap:anywhere; }
.confirmation-heading p { overflow-wrap:anywhere; }
.confirmation-content { min-height:0; overflow:auto; border-block:var(--sf-border); padding:.75rem .25rem; }
.confirmation-content pre { white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; font:inherit; margin:0 0 1rem; }
.confirmation-controls { min-width:0; max-height:48vh; overflow:auto; padding:.75rem 0 0; display:grid; gap:.4rem; }
.confirmation-controls label, .confirmation-controls code { overflow-wrap:anywhere; white-space:pre-wrap; }
.confirmation-controls input:not([type=checkbox]) { min-width:0; width:100%; padding:.45rem; font:inherit; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:var(--sf-border); }
.confirmation-ack { display:flex; align-items:flex-start; gap:.5rem; }
.confirmation-actions { position:sticky; bottom:0; display:flex; flex-wrap:wrap; gap:.5rem; padding:.5rem 0; background:var(--vscode-editor-background); }
body > .page-nav { flex:none; flex-wrap:nowrap; overflow-x:auto; margin-top:.4rem; padding-block:.4rem; }
body > .page-nav button { flex:none; white-space:nowrap; }
@media (max-height:400px) { .confirmation-heading { max-height:20vh; padding:.25rem 0; } .confirmation-heading h1 { font-size:1.1rem; } .confirmation-controls { max-height:40vh; padding-top:.25rem; } }
`;

export const REVIEW_CONFIRMATION_SCRIPT = `
(() => {
  const form = document.querySelector('.confirmation-controls');
  const submit = form.querySelector('button[type=submit]');
  const valid = () => form.dataset.typed === 'true'
    ? Boolean(form.dataset.expected) && form.querySelector('[data-confirmation]').value === form.dataset.expected
    : form.querySelector('[data-acknowledged]').checked;
  const sync = () => { submit.disabled = !valid(); };
  form.addEventListener('input', sync);
  form.addEventListener('change', sync);
  form.querySelector('[data-cancel]').addEventListener('click', () => window.__sfVscode.postMessage({ type:'confirmation.cancel' }));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.__sfVscode.postMessage({ type:'confirmation.cancel' });
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!valid()) return;
    submit.disabled = true;
    window.__sfVscode.postMessage({ type:'confirmation.accept',
      confirmation:form.querySelector('[data-confirmation]')?.value ?? '',
      acknowledged:Boolean(form.querySelector('[data-acknowledged]')?.checked) });
  });
  sync();
})();
`;
