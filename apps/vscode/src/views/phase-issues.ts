import * as vscode from 'vscode';
import { contentSecurityPolicy, nonce, page } from './webview.ts';
import { registerMessageRouter } from './messages.ts';
import { phaseIssuesBody } from './phase-issues-page.ts';

export type PhaseIssueAction = 'refresh' | 'continue' | 'witness' | 'appeal' | 'tests' | 'review' | 'evidence' | 'repair' | 'resume' | 'risk' | 'checkpoint';
const ACTIONS: PhaseIssueAction[] = ['refresh', 'continue', 'witness', 'appeal', 'tests', 'review', 'evidence', 'repair', 'resume', 'risk', 'checkpoint'];

export function showPhaseIssues(result: unknown, onAction: (action: PhaseIssueAction) => void): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel('singularityFlow.phaseIssues', 'Resolve phase issues', vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [] });
  const token = nonce();
  panel.webview.html = page('Resolve phase issues', phaseIssuesBody(result), contentSecurityPolicy(panel.webview, token), token,
    `document.addEventListener('click', event => { const button = event.target.closest('[data-action]'); if (button) window.__sfVscode.postMessage({type: button.dataset.action}); });`, { nav: false });
  const router = registerMessageRouter('singularityFlow.phaseIssues', Object.fromEntries(ACTIONS.map(action => [action, () => onAction(action)])));
  const messages = panel.webview.onDidReceiveMessage(raw => router.route(raw));
  panel.onDidDispose(() => messages.dispose());
  return panel;
}
