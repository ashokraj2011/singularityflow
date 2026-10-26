/**
 * The outcome review panel: the active Story's `singularity-flow outcome --json`, read once per
 * refresh. It changes nothing itself. Its buttons run commands that already exist (start the
 * application, run the tests, open the Evidence Matrix or the decisions), open a reference or a
 * screenshot, or copy a sign-off or scope command for the person to complete and run; every target
 * is looked up in what this panel loaded, never taken from the page.
 */
import * as vscode from 'vscode';
import path from 'node:path';
import type { SingularityFlowClient } from '../cli/client.ts';
import type { WorkspaceStore } from '../state.ts';
import { contentSecurityPolicy, nonce, page } from './webview.ts';
import { integerField, registerMessageRouter, stringField } from './messages.ts';
import { documentReference, outcomeView, type OutcomeCheck, type OutcomeView } from './outcome-review-model.ts';
import { OUTCOME_REVIEW_SCRIPT, OUTCOME_REVIEW_STYLE, outcomeReviewHtml } from './outcome-review-page.ts';

export class OutcomeReviewPanel {
  private static current: OutcomeReviewPanel | null = null;
  private view: OutcomeView | null = null;
  private error: string | null = null;
  private revision = 0;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  static show(_context: vscode.ExtensionContext, store: WorkspaceStore, client: SingularityFlowClient): OutcomeReviewPanel {
    if (OutcomeReviewPanel.current) {
      OutcomeReviewPanel.current.panel.reveal(vscode.ViewColumn.Active);
      void OutcomeReviewPanel.current.reload();
      return OutcomeReviewPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('singularityFlow.outcomeReview', 'Check the Outcome', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    return OutcomeReviewPanel.current = new OutcomeReviewPanel(panel, store, client);
  }

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly store: WorkspaceStore,
    private readonly client: SingularityFlowClient) {
    const router = registerMessageRouter('singularityFlow.outcomeReview', {
      action: (message) => this.act(stringField(message, 'action') ?? '', integerField(message, 'criterion'),
        integerField(message, 'check'), integerField(message, 'item'))
    });
    this.panel.webview.onDidReceiveMessage((raw: unknown) => router.route(raw), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
    void this.reload();
  }

  private async reload(): Promise<void> {
    const revision = ++this.revision;
    if (!this.store.current.snapshot?.workflow) {
      this.view = null;
      this.error = 'Open a Story to check its outcome.';
      return this.render();
    }
    try {
      const result = await this.client.run<unknown>(['outcome', '--json']);
      if (revision !== this.revision) return;
      this.view = outcomeView(result);
      this.error = this.view ? null : 'The outcome review returned a shape this panel does not read.';
    } catch (failure) {
      if (revision !== this.revision) return;
      this.view = null;
      this.error = `The outcome could not be read: ${failure instanceof Error ? failure.message : String(failure)}`;
    }
    this.render();
  }

  private check(criterion: number | null, check: number | null): OutcomeCheck | null {
    if (criterion === null || check === null) return null;
    return this.view?.criteria[criterion]?.checks[check] ?? null;
  }

  private async act(action: string, criterion: number | null, check: number | null, item: number | null): Promise<void> {
    if (action === 'refresh') return this.reload();
    if (action === 'start') { await vscode.commands.executeCommand('singularityFlow.startApplication'); return; }
    if (action === 'tests') { await vscode.commands.executeCommand('singularityFlow.runTests'); return; }
    if (action === 'matrix') { await vscode.commands.executeCommand('singularityFlow.openEvidenceMatrix'); return; }
    if (action === 'decisions') { await vscode.commands.executeCommand('singularityFlow.decisions'); return; }
    if (action === 'copy-scope') {
      const scope = item === null ? null : this.view?.open.scopeItems[item];
      if (!scope) return;
      await vscode.env.clipboard.writeText(scope.command);
      void vscode.window.showInformationMessage('Copied. Choose the disposition, name the clauses for included or existing, give your reason, then run it.');
      return;
    }
    const selected = this.check(criterion, check);
    if (!selected) return;
    if (action === 'copy-sign-off' && selected.signOff) {
      await vscode.env.clipboard.writeText(selected.signOff);
      void vscode.window.showInformationMessage('Copied. Look at the screenshot first, replace the reason, then run it; use --deny for any item that is not true.');
      return;
    }
    if (action === 'reference' && selected.reference) return this.openReference(selected.reference);
    if (action === 'screenshot') return this.openRepositoryFile(selected.files?.[0] ?? selected.suggestedFile ?? null, true);
  }

  private async openReference(reference: string): Promise<void> {
    if (!documentReference(reference)) return this.openRepositoryFile(reference, false);
    try {
      const viewed = await this.client.run<{ absolutePath?: unknown }>(['documents', 'view', reference, '--json']);
      if (typeof viewed?.absolutePath !== 'string' || !path.isAbsolute(viewed.absolutePath)) throw new Error(`${reference} has no local file to open.`);
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(viewed.absolutePath));
    } catch (failure) {
      void vscode.window.showWarningMessage(`${reference} could not be opened: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
  }

  private async openRepositoryFile(relative: string | null, screenshot: boolean): Promise<void> {
    // Only a path inside this repository, as the engine wrote it.
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/u).some((part) => part === '..')) return;
    const file = vscode.Uri.file(path.join(this.client.repository, relative));
    try {
      await vscode.workspace.fs.stat(file);
      await vscode.commands.executeCommand('vscode.open', file);
    } catch {
      void vscode.window.showInformationMessage(screenshot
        ? `No screenshot yet. Save one of the running screen as ${relative}, then open it here.`
        : `${relative} is not in this checkout.`);
    }
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    this.panel.webview.html = page('Check the Outcome', outcomeReviewHtml(this.view, this.error),
      contentSecurityPolicy(this.panel.webview, token), token, OUTCOME_REVIEW_SCRIPT, { styles: OUTCOME_REVIEW_STYLE });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (OutcomeReviewPanel.current === this) OutcomeReviewPanel.current = null;
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
