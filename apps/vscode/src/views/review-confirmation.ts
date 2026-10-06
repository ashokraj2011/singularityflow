/** Human-only confirmation in an editor-sized page, not an unbounded native message box. */
import * as vscode from 'vscode';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { registerMessageRouter } from './messages.ts';
import { navigateTo } from './navigate.ts';
import {
  reviewConfirmationAccepted, reviewConfirmationBody, REVIEW_CONFIRMATION_SCRIPT, REVIEW_CONFIRMATION_STYLE,
  type ReviewConfirmationRequest
} from './review-confirmation-page.ts';

let activePanel: vscode.WebviewPanel | null = null;

/** Closing, navigating, or opening another confirmation cancels this decision. */
export function collectReviewConfirmation(request: ReviewConfirmationRequest): Promise<boolean> {
  activePanel?.dispose();
  const reviewed = Object.freeze({ ...request });
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.reviewConfirmation', request.title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: false }
    );
    activePanel = panel;
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      resolve(accepted);
      panel.dispose();
    };
    const router = registerMessageRouter('singularityFlow.reviewConfirmation', {
      'confirmation.cancel': () => finish(false),
      'confirmation.accept': (message) => {
        if (reviewConfirmationAccepted(reviewed, message)) finish(true);
      }
    });
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      if (settled) return;
      const navigation = navigationTarget(raw);
      if (navigation) { finish(false); return void navigateTo(navigation); }
      router.route(raw);
    });
    panel.onDidDispose(() => {
      if (activePanel === panel) activePanel = null;
      if (!settled) { settled = true; resolve(false); }
    });
    const token = nonce();
    panel.webview.html = page(reviewed.title,
      `<style nonce="${token}">${REVIEW_CONFIRMATION_STYLE}</style>${reviewConfirmationBody(reviewed)}`,
      contentSecurityPolicy(panel.webview, token), token, REVIEW_CONFIRMATION_SCRIPT
    );
  });
}
