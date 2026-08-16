/**
 * The host for schema-driven forms. `[UXH:REQ-070]`–`[UXH:REQ-076]`
 *
 * The model says what the fields are, the page says how they are asked for, and this says what
 * happens when someone presses the button. Three modules because only the third needs an extension
 * host, and the first two carry the rules worth testing.
 *
 * ## Local success is not operation success `[UXH:REQ-071]`
 *
 * This panel can say "you have not filled in `workId`". It cannot say "done". A form that reports
 * success from its own validation has told the reader the operation ran, and the only honest
 * evidence of that is the operation's own envelope — which arrives as a result card, from the same
 * executor a CLI invocation goes through. So submit hands off and closes, and the answer appears
 * where every other answer appears.
 *
 * ## Drafts are written through the model, never around it
 *
 * `saveDraft` takes the whole value bag and `draftRecord` decides what may be kept. Filtering on
 * write as well as on read is deliberate: once a confirmation reaches workspace state the rule has
 * already been broken, and a later reader declining to restore it does not unwrite it.
 */
import * as vscode from 'vscode';

import { createMessageRouter, stringField } from './messages.ts';
import { FORM_STYLE, formHtml, type FormView } from './form-page.ts';
import { navigateTo } from './navigate.ts';
import { contentSecurityPolicy, escape, navigationTarget, nonce, page } from './webview.ts';

/**
 * The pure half of the form layer, loaded from the CLI package.
 *
 * Declared in `gateway-core.d.ts` alongside the rest of the gateway surface the extension consumes.
 */
import {
  checkForm, coerceForm, draftRecord, formModel, readDraft, terminalEquivalent
} from '../../../../src/gateway/form-model.mjs';

export type FormRequest = {
  /** A registered operation argument schema. The form cannot exist without one. */
  readonly schemaId: string;
  readonly title: string;
  /** The command the collapsed terminal equivalent is built from. Display-only `[UXH:REQ-073]`. */
  readonly command: string;
  readonly defaults?: Record<string, string | number | boolean>;
};

export type FormSubmission = {
  readonly schemaId: string;
  readonly values: Record<string, string | number | boolean>;
};

const DRAFT_KEY = 'singularityFlow.formDraft';

let panel: vscode.WebviewPanel | null = null;
let request: FormRequest | null = null;
let store: vscode.Memento | null = null;
let submit: ((submission: FormSubmission) => void | Promise<void>) | null = null;

/** Injected, for the same reason the result panel injects its dispatcher: the host decides what an action means. */
export function onFormSubmit(handler: (submission: FormSubmission) => void | Promise<void>): void {
  submit = handler;
}

/** Workspace state, so a draft belongs to a workspace and a user rather than to a machine `[UXH:REQ-074]`. */
export function useDraftStore(memento: vscode.Memento): void {
  store = memento;
}

const draftKeyFor = (schemaId: string) => `${DRAFT_KEY}.${schemaId}`;

function loadDraft(schemaId: string): Record<string, string | number | boolean> {
  if (!store) return {};
  return readDraft(schemaId, store.get(draftKeyFor(schemaId)));
}

function saveDraft(schemaId: string, values: Record<string, unknown>): void {
  if (!store) return;
  void store.update(draftKeyFor(schemaId), draftRecord(schemaId, values));
}

/**
 * The script that collects the form and posts it.
 *
 * It reads the DOM rather than tracking state, so what is submitted is what is on screen. A
 * `data-no-draft` field is excluded from the *draft* message and included in the *submit* message,
 * which is the whole distinction `[UXH:AC-004]` is about — a confirmation must be typed and must be
 * sent, and must never come back on its own.
 */
const FORM_SCRIPT = `
(function () {
  const form = document.querySelector('.sf-form');
  if (!form) return;
  function collect(includeCeremony) {
    const values = {};
    for (const input of form.querySelectorAll('input, textarea, select')) {
      if (!includeCeremony && input.hasAttribute('data-no-draft')) continue;
      if (input.type === 'checkbox') { if (input.checked) values[input.name] = true; continue; }
      if (input.value !== '') values[input.name] = input.value;
    }
    return values;
  }
  form.addEventListener('input', function () {
    window.__sfVscode.postMessage({ type: 'sflow.form.draft', values: JSON.stringify(collect(false)) });
  });
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    window.__sfVscode.postMessage({ type: 'sflow.form.submit', values: JSON.stringify(collect(true)) });
  });
})();
`;

function render(target: vscode.WebviewPanel, view: FormView, {
  problems = {}, values = {}
}: { problems?: Record<string, string>; values?: Record<string, unknown> } = {}): void {
  const token = nonce();
  const csp = contentSecurityPolicy(target.webview, token);
  const terminal = terminalEquivalent(request?.command ?? '', values);
  /**
   * The nonce, again, and for the reason the result panel documents at length: `style-src
   * 'nonce-…'` drops an un-nonced `<style>` with no error, the markup stays byte-identical, and the
   * page renders in the shared kit's defaults which look plausible enough to ship.
   */
  const body = `<style nonce="${token}">${FORM_STYLE}
.sf-submit { margin-top: 8px; align-self: flex-start; }
</style>
<main style="padding:16px;max-width:720px">
<h2 style="margin-top:0">${escape(request?.title ?? '')}</h2>
${formHtml(view, { problems, terminal })
    .replace('</form>', '<button class="sf-primary sf-submit" type="submit">Submit</button></form>')}
</main>`;
  target.webview.html = page(request?.title ?? 'Singularity Flow', body, csp, token, FORM_SCRIPT);
}

/** Open a form for a registered schema, or refuse plainly if this build has no such schema. */
export function showForm(next: FormRequest): boolean {
  const view = formModel(next.schemaId) as FormView | null;
  if (!view) return false;

  request = next;
  const defaults = { ...loadDraft(next.schemaId), ...(next.defaults ?? {}) };
  const filled = formModel(next.schemaId, { defaults }) as FormView;

  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'singularityFlow.form',
      next.title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.onDidDispose(() => { panel = null; request = null; });

    /**
     * Two messages, enumerated. `[UXH:REQ-134]` `[UXH:AC-014]`
     *
     * `values` crosses as a JSON string and is parsed here, so a malformed payload is a caught
     * throw at the boundary rather than a shape a handler assumes. What comes back is still
     * untrusted: only fields the schema declares survive `checkForm` and `draftRecord`.
     */
    const router = createMessageRouter('singularityFlow.form', {
      'sflow.form.draft': (message) => {
        const parsed = parseValues(message);
        if (parsed && request) saveDraft(request.schemaId, parsed);
      },
      'sflow.form.submit': (message) => {
        const parsed = parseValues(message);
        if (!parsed || !request || !panel) return;
        const check = checkForm(request.schemaId, parsed);
        if (!check.valid) {
          const problems: Record<string, string> = {};
          for (const problem of check.problems) {
            if (problem.field) problems[problem.field] = problem.detail ?? 'Required.';
          }
          render(panel, formModel(request.schemaId, { defaults: parsed }) as FormView,
            { problems, values: parsed });
          return;
        }
        /**
         * Handed off, and the panel closes rather than reporting anything `[UXH:REQ-071]`.
         *
         * The operation's envelope is the only honest evidence that it ran, and it arrives as a
         * result card. A "Submitted ✓" here would be this panel asserting an outcome it has not
         * seen.
         */
        /**
         * Submitted in the schema's types, not the DOM's `[UXH:AC-011]`.
         *
         * A control hands back `"12"` where the schema declares `integer`, so a form that sent what
         * it collected would be refused where the identical CLI invocation succeeds. `checkForm`
         * already coerces internally, which is why the check above passed — sending `parsed` here
         * would have made the panel the one place the conversion did not happen.
         */
        const submission = { schemaId: request.schemaId, values: coerceForm(request.schemaId, parsed) };
        saveDraft(request.schemaId, parsed);
        panel.dispose();
        void submit?.(submission);
      }
    }, (type, source) => console.warn(`[singularity-flow] ${source} received an unrecognised message: ${type}`));
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer, before this panel's own contract — one seam for every page, as in
      // `result-panel.ts` and `capability-proposal.ts`.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      router.route(raw);
    });
  } else {
    panel.title = next.title;
    panel.reveal(vscode.ViewColumn.Active, false);
  }

  render(panel, filled, { values: defaults });
  return true;
}

function parseValues(message: { readonly type: string }): Record<string, string | number | boolean> | null {
  const raw = stringField(message as Record<string, unknown> & { type: string }, 'values');
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, string | number | boolean>;
  } catch {
    return null;
  }
}

/** Test seam: the panel is module state, and a test that ran before must not leak into the next. */
export function resetFormPanel(): void {
  panel?.dispose();
  panel = null;
  request = null;
  store = null;
  submit = null;
}
