/**
 * One panel for every result the shell shows. `[UXH:REQ-031]` `[UXH:CON-007]`
 *
 * Replaces `showErrorMessage(error.message)` at every refusal site. The difference is not cosmetic:
 * a toast is dismissed and gone, carries no reason a reader can act on, says nothing about what
 * survived, and offers no next step — which is the dead end `[UXH:CON-007]` prohibits, repeated 37
 * times.
 *
 * **A singleton, reused.** One panel that re-renders, not one per refusal. A person who runs three
 * commands that each refuse should not have to close three tabs, and the newest answer should be
 * where the last one was.
 *
 * **Beside, never focused.** `preserveFocus` keeps the cursor where the reader left it. A refusal is
 * information, and stealing focus to deliver it is the toast's other bad habit.
 */
import * as vscode from 'vscode';

import { RESULT_CARD_SCRIPT, RESULT_CARD_STYLE, resultCardHtml } from './result-card-page.ts';
import { contentSecurityPolicy, escape, nonce, page } from './webview.ts';
import { fidelityNote, refusalFor, type Refusal } from './refusal.ts';
import type { ResultCardView } from './result-card-model.ts';

/**
 * Where a card's facts came from, and therefore whether its handles are live.
 *
 * A gateway result was resolved by the in-process kernel moments ago, so its handles can be
 * re-resolved. A CLI result came from a process that has exited, so its handles are dead and only
 * the terminal equivalent remains. The dispatcher must not have to guess which it is holding.
 */
export type ResultOrigin = 'gateway' | 'cli';

export type ActionRequest = {
  readonly actionId: string;
  readonly view: ResultCardView;
  readonly origin: ResultOrigin;
};

let panel: vscode.WebviewPanel | null = null;
let current: ResultCardView | null = null;
let currentOrigin: ResultOrigin = 'cli';

/**
 * Dispatch for a pressed action.
 *
 * Injected rather than imported so this module stays renderable in a test without an extension host,
 * and so the host decides what an action means. Today that is running the action's terminal
 * equivalent; when the gateway runs in-process it becomes `executor.executeById`, and the panel does
 * not change either way — the button already carries a stable id and nothing else.
 */
let dispatch: ((request: ActionRequest) => void | Promise<void>) | null = null;

export function onResultAction(handler: (request: ActionRequest) => void | Promise<void>): void {
  dispatch = handler;
}

function render(target: vscode.WebviewPanel, view: ResultCardView, note: string | null): void {
  const token = nonce();
  const csp = contentSecurityPolicy(target.webview, token);
  /**
   * The fidelity note sits under the card, not inside it.
   *
   * It is a statement about how much this build could read, which is a different kind of fact from
   * anything the result itself asserts. Putting it inside the card would make it look like one of
   * the result's own reasons.
   */
  const footnote = note ? `<p class="sf-fidelity">${escape(note)}</p>` : '';
  /**
   * The nonce is load-bearing, and its absence is silent. `[UXH:REQ-134]`
   *
   * The policy is `style-src 'nonce-…'`, so a `<style>` without it is dropped by the webview with
   * no error anywhere — the panel renders, the markup is correct, and every rule in this stylesheet
   * simply does not exist. What the reader sees instead is the shared kit's defaults, which look
   * plausible. It shipped that way and was caught by opening the editor and noticing that six
   * actions were all filled when the envelope said one.
   *
   * Worth stating because the failure has no symptom a test can see: the HTML this function returns
   * is byte-identical either way, and a fixture rendered outside a webview has no CSP to enforce.
   */
  const body = `<style nonce="${token}">${RESULT_CARD_STYLE}
.sf-fidelity { margin: 12px 2px 0; color: var(--vscode-descriptionForeground); font-size: .92em; }
</style>
<main style="padding:16px;max-width:720px">${resultCardHtml(view)}${footnote}</main>`;
  /**
   * The standard footer, not an opt-out.
   *
   * The first draft passed `nav: false`, and `vscode-navigation.test.mjs` was right to reject it:
   * opting out is correct only on the two pages that cannot run a script, and this one runs one.
   * A card's own actions answer "what about *this*"; the footer answers "get me back to the shell",
   * and a full page in a beside column needs both.
   */
  target.webview.html = page('Singularity Flow result', body, csp, token, RESULT_CARD_SCRIPT);
}

/** Show a result card, creating the panel on first use and reusing it after. */
export function showResultCard(view: ResultCardView,
  { note = null, origin = 'cli' }: { note?: string | null; origin?: ResultOrigin } = {}): void {
  current = view;
  currentOrigin = origin;
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'singularityFlow.result',
      'Singularity Flow result',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.onDidDispose(() => { panel = null; current = null; });
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      /**
       * The only message this panel accepts, checked rather than trusted.
       *
       * A webview is a separate document and its messages are input `[UXH:REQ-134]`. `actionId` is
       * looked up in the view that produced it, so a forged id names nothing and dispatches nothing.
       */
      const request = raw as { type?: unknown; actionId?: unknown };
      if (request?.type !== 'sflow.action' || typeof request.actionId !== 'string') return;
      if (!current || !current.actions.some((action) => action.id === request.actionId)
        && !current.checklist.some((row) => row.action?.id === request.actionId)) return;
      void dispatch?.({ actionId: request.actionId, view: current, origin: currentOrigin });
    });
  } else {
    panel.reveal(vscode.ViewColumn.Beside, true);
  }
  render(panel, view, note);
}

/**
 * The one call that replaces `showErrorMessage` at a refusal site.
 *
 * Returns nothing and never throws: a failure to render a refusal must not become a second failure
 * on top of the first, which is how a reader ends up with no information at all.
 */
export function showRefusal(error: unknown, { headline }: { headline?: string } = {}): void {
  let refusal: Refusal;
  try {
    refusal = refusalFor(error, { headline });
  } catch {
    // Last resort, and still not a dead end — the message, at least, reaches the reader.
    void vscode.window.showErrorMessage(String((error as { message?: string })?.message ?? error));
    return;
  }
  showResultCard(refusal.view, { note: fidelityNote(refusal.fidelity) });
}

/** Test seam: the panel is module state, and a test that ran before must not leak into the next. */
export function resetResultPanel(): void {
  panel?.dispose();
  panel = null;
  current = null;
  dispatch = null;
}
