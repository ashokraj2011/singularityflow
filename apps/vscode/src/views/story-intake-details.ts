import * as vscode from 'vscode';
import type { StoryArtifact, StoryWorkflow } from '../cli/snapshot.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter } from './messages.ts';
import { storyIntakeBody, type IntakeDocumentPreview } from './story-intake-page.ts';

export type StoryIntakeAction = 'refresh' | 'evidence' | 'tests';
export function showStoryIntakeDetails(workflow: StoryWorkflow, preview: IntakeDocumentPreview,
  documents: StoryArtifact[], onAction: (action: StoryIntakeAction) => void): vscode.WebviewPanel {
  const body = storyIntakeBody(workflow, preview, documents);
  const panel = vscode.window.createWebviewPanel('singularityFlow.storyIntake', `Intake · ${workflow.workItem.id}`,
    vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
  const token = nonce();
  const styles = `<style nonce="${token}">.intake-value{white-space:pre-wrap;overflow-wrap:anywhere}pre.intake-value{max-height:40rem;overflow:auto}th{text-align:left;vertical-align:top}</style>`;
  panel.webview.html = page('Story intake details', styles + body, contentSecurityPolicy(panel.webview, token), token,
    `document.addEventListener('click', event => { const button = event.target.closest('[data-action]'); if (button) window.__sfVscode.postMessage({type: button.dataset.action}); });`);
  const router = registerMessageRouter('singularityFlow.storyIntake', {
    navigate: raw => { const target = navigationTarget(raw); if (target) void navigateTo(target); },
    refresh: () => onAction('refresh'), evidence: () => onAction('evidence'), tests: () => onAction('tests')
  });
  const messages = panel.webview.onDidReceiveMessage(raw => router.route(raw));
  panel.onDidDispose(() => messages.dispose());
  return panel;
}
