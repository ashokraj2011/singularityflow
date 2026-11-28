import * as vscode from 'vscode';
import type { StoryArtifact, StoryWorkflow } from '../cli/snapshot.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField } from './messages.ts';
import { storyIntakeBody, type IntakeDocumentPreview } from './story-intake-page.ts';

export type StoryIntakeAction = 'refresh' | 'evidence' | 'tests' | 'test-scope';
/** A specification slice to open in the Spec Studio: `SPEC-ID@N` and its clause IDs. */
export interface StoryIntakeSlice { revision: string; clauses: string[] }
/** A sliced clause dropped from this Story, or brought back, with the person's reason. */
export interface StoryIntakeClauseChange { clause: string; back: boolean; reason: string }
export function showStoryIntakeDetails(workflow: StoryWorkflow, preview: IntakeDocumentPreview,
  documents: StoryArtifact[], onAction: (action: StoryIntakeAction) => void, onSlice: (slice: StoryIntakeSlice) => void = () => {},
  dropped: Set<string> | null = null, onClause: (change: StoryIntakeClauseChange) => void = () => {}): vscode.WebviewPanel {
  const body = storyIntakeBody(workflow, preview, documents, dropped);
  const panel = vscode.window.createWebviewPanel('singularityFlow.storyIntake', `Intake · ${workflow.workItem.id}`,
    vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
  const token = nonce();
  const styles = `<style nonce="${token}">.intake-value{white-space:pre-wrap;overflow-wrap:anywhere}pre.intake-value{max-height:40rem;overflow:auto}th{text-align:left;vertical-align:top}</style>`;
  panel.webview.html = page('Story intake details', styles + body, contentSecurityPolicy(panel.webview, token), token,
    `document.addEventListener('click', event => { const button = event.target.closest('[data-action]'); if (button) window.__sfVscode.postMessage({type: button.dataset.action, revision: button.dataset.revision, clauses: button.dataset.clauses, clause: button.dataset.clause, back: button.dataset.back, reason: button.dataset.clause ? (document.querySelector('[data-slice-reason="' + button.dataset.clause + '"]')?.value ?? '') : undefined}); });`);
  const router = registerMessageRouter('singularityFlow.storyIntake', {
    navigate: raw => { const target = navigationTarget(raw); if (target) void navigateTo(target); },
    refresh: () => onAction('refresh'), evidence: () => onAction('evidence'), tests: () => onAction('tests'), 'test-scope': () => onAction('test-scope'),
    'slice-change': message => {
      const clause = stringField(message, 'clause');
      if (clause && /^[A-Z][A-Z0-9-]*:[A-Z][A-Z0-9-]*$/u.test(clause)) onClause({ clause, back: stringField(message, 'back') === 'yes', reason: (stringField(message, 'reason') ?? '').trim() });
    },
    'spec-studio': message => {
      const revision = stringField(message, 'revision');
      if (revision) onSlice({ revision, clauses: (stringField(message, 'clauses') ?? '').split(' ').filter(Boolean) });
    }
  });
  const messages = panel.webview.onDidReceiveMessage(raw => router.route(raw));
  panel.onDidDispose(() => messages.dispose());
  return panel;
}
