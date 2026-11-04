/**
 * The outcome review panel: the active Story's `singularity-flow outcome --json`, read once per
 * refresh. It changes nothing itself. Its buttons run commands that already exist (start the
 * application, run the tests, open the Evidence Matrix or the decisions), open a reference or a
 * screenshot, or copy a sign-off or scope command for the person to complete and run; every target
 * is looked up in what this panel loaded, never taken from the page.
 */
import * as vscode from 'vscode';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SingularityFlowClient } from '../cli/client.ts';
import type { WorkspaceStore } from '../state.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { showCompactInformationMessage, showCompactWarningMessage } from '../compact-message.ts';
import { taskStartFolder } from '../terminal-start.ts';
import { integerField, registerMessageRouter, stringField } from './messages.ts';
import { documentReference, outcomeView, sameOutcomeTarget, signOffArgs, signOffQuestions, type OutcomeCheck, type OutcomeTarget, type OutcomeView } from './outcome-review-model.ts';
import { OUTCOME_REVIEW_SCRIPT, OUTCOME_REVIEW_STYLE, outcomeReviewHtml } from './outcome-review-page.ts';

export class OutcomeReviewPanel {
  private static current: OutcomeReviewPanel | null = null;
  private view: OutcomeView | null = null;
  private error: string | null = null;
  private revision = 0;
  private playwright: string | null = null;
  private disposed = false;
  private readRepository: string | null = null;
  private expected: OutcomeTarget | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  static show(_context: vscode.ExtensionContext, store: WorkspaceStore, client: SingularityFlowClient, expected: OutcomeTarget | null = null): OutcomeReviewPanel {
    if (OutcomeReviewPanel.current) {
      OutcomeReviewPanel.current.expected = expected;
      OutcomeReviewPanel.current.panel.reveal(vscode.ViewColumn.Active);
      void OutcomeReviewPanel.current.reload();
      return OutcomeReviewPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('singularityFlow.outcomeReview', 'Check the Outcome', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    return OutcomeReviewPanel.current = new OutcomeReviewPanel(panel, store, client, expected);
  }

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly store: WorkspaceStore,
    private readonly client: SingularityFlowClient, expected: OutcomeTarget | null = null) {
    this.expected = expected;
    const router = registerMessageRouter('singularityFlow.outcomeReview', {
      action: (message) => this.act(stringField(message, 'action') ?? '', integerField(message, 'criterion'),
        integerField(message, 'check'), integerField(message, 'item'))
    });
    // The page's footer navigates like every other view's.
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return navigateTo(navigation);
      return router.route(raw);
    }, null, this.disposables);
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
      const repository = this.client.repository;
      const workId = this.store.current.snapshot.workflow.workItem.id;
      const result = await this.client.run<unknown>(['outcome', workId, '--json']);
      if (revision !== this.revision || this.client.repository !== repository) return;
      this.view = outcomeView(result);
      if (this.view?.workId !== workId || this.expected && !sameOutcomeTarget(this.view?.target, this.expected)) {
        this.view = null;
        this.error = 'The Story or delivered generation changed. Refresh to review the current result.';
        return this.render();
      }
      this.readRepository = repository;
      this.error = this.view ? null : 'The outcome review returned a shape this panel does not read.';
      this.playwright = await this.localPlaywright();
    } catch (failure) {
      if (revision !== this.revision) return;
      this.view = null;
      this.error = `The outcome could not be read: ${failure instanceof Error ? failure.message : String(failure)}`;
    }
    this.render();
  }

  private currentTarget(): OutcomeTarget | null {
    const state = this.store.current;
    const workflow = state.stale || state.error ? null : state.snapshot?.workflow;
    const phase = workflow?.currentPhase ? workflow.phases[workflow.currentPhase] : null;
    if (!workflow || workflow.currentPhase && !phase) return null;
    return { workId: workflow.workItem.id, phase: workflow.currentPhase ?? null, generation: phase?.generation ?? null };
  }

  private currentDelivery(expected = this.view?.target): boolean {
    if (this.readRepository === this.client.repository && sameOutcomeTarget(expected, this.view?.target)
        && sameOutcomeTarget(this.view?.target, this.currentTarget())) return true;
    this.error = 'The active Story or generation changed. Refresh before running, recording evidence or requesting a repair.';
    this.render(); return false;
  }

  private check(criterion: number | null, check: number | null): OutcomeCheck | null {
    if (criterion === null || check === null) return null;
    return this.view?.criteria[criterion]?.checks[check] ?? null;
  }

  /** Palette and outcome button share the same bound Story and owner-issued session. */
  async reviewApplication(): Promise<void> {
    await this.reload();
    if (!this.view?.applicationReview) {
      void showCompactInformationMessage('This Story did not adopt application review. Its pinned workflow is unchanged.');
      return;
    }
    await this.act('app-review', null, null, null);
  }

  private async act(action: string, criterion: number | null, check: number | null, item: number | null): Promise<void> {
    if (action === 'refresh') { this.expected = null; return this.reload(); }
    if (!this.currentDelivery()) return;
    if (action === 'app-review' && this.view?.applicationReview) {
      if (vscode.workspace.isTrusted === false) throw new Error('Trust the workspace before opening application review.');
      const workId = this.view.workId;
      const target = this.view.target;
      let sessionId = this.view.applicationReview.sessionId;
      if (!sessionId) {
        const result = await this.client.run<{ session?: { id?: string } }>(['app-review', 'start', '--work-id', workId, '--json']);
        sessionId = result.session?.id ?? null;
      }
      if (!sessionId) throw new Error('The engine did not issue a review session. No application was started.');
      if (!this.currentDelivery(target)) return;
      await this.client.run(['app-review', 'inspect', sessionId, '--work-id', workId, '--json']);
      await this.reload(); return;
    }
    if (action === 'start') { await vscode.commands.executeCommand('singularityFlow.startApplication'); return; }
    if (action === 'run-test') { await vscode.commands.executeCommand('singularityFlow.workspaceRunTest'); return; }
    if (action === 'test-summary') { await vscode.commands.executeCommand('singularityFlow.testSummary'); return; }
    if (action === 'continue') { await vscode.commands.executeCommand('singularityFlow.openJourney'); return; }
    if (action === 'request-repair') {
      if (this.view?.applicationReview) return this.act('app-review', null, null, null);
      const view = this.view;
      if (!view?.repairCopilot) return;
      const feedback = await vscode.window.showInputBox({ title: 'Request a Story repair', prompt: 'What did you try, what happened, and what did you expect?',
        ignoreFocusOut: true, validateInput: value => value.trim() ? undefined : 'Describe the observed problem.' });
      if (!feedback?.trim() || !this.currentDelivery(view.target)) return;
      await vscode.commands.executeCommand('workbench.action.chat.open', { isPartialQuery: true,
        query: `${view.repairCopilot}\nWork ID: ${view.workId}; phase: ${view.target?.phase}; generation: ${view.target?.generation}.\nHuman repair request: ${JSON.stringify(feedback.trim())}\nThe returned repair admission is: ${view.repairCommand}\nRun that exact admission once before source edits, then refresh phase entry and fix the reported in-scope behavior. Preserve this Story and its existing code; if admission requires an owner, retain that route. Do not recreate the Story, waive tests, accept the application or approve a phase.` });
      return;
    }
    if (action === 'tests') { await vscode.commands.executeCommand('singularityFlow.runTests'); return; }
    if (action === 'matrix') { await vscode.commands.executeCommand('singularityFlow.openEvidenceMatrix'); return; }
    if (action === 'decisions') { await vscode.commands.executeCommand('singularityFlow.decisions'); return; }
    if (action === 'copy-scope') {
      const scope = item === null ? null : this.view?.open.scopeItems[item];
      if (!scope) return;
      await vscode.env.clipboard.writeText(scope.command);
      void showCompactInformationMessage('Copied. Choose the disposition, name the clauses for included or existing, give your reason, then run it.');
      return;
    }
    const selected = this.check(criterion, check);
    if (!selected) return;
    if (action === 'copy-sign-off' && selected.signOff) {
      await vscode.env.clipboard.writeText(selected.signOff);
      void showCompactInformationMessage('Copied. Look at the screenshot first, replace the reason, then run it; use --deny for any item that is not true.');
      return;
    }
    if (action === 'reference' && selected.reference) return this.openReference(selected.reference);
    if (action === 'attach' && selected.suggestedFile) return this.attach(selected.suggestedFile);
    if (action === 'capture' && selected.suggestedFile) return this.capture(selected.suggestedFile);
    if (action === 'sign-off' && selected.signOff && criterion !== null) return this.signOff(criterion, selected);
    if (action === 'screenshot') return this.openRepositoryFile(selected.files?.[0] ?? selected.suggestedFile ?? null, true);
  }

  /** Repository-relative and inside this checkout, as the engine wrote it, or null. */
  private repositoryPath(relative: string | null): string | null {
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/u).some((part) => !part || part === '.' || part === '..')) return null;
    return path.join(this.client.repository, relative);
  }

  /** Copy a screenshot the person picks to the path the review suggested; nothing is recorded yet. */
  private async attach(relative: string): Promise<void> {
    const binding = this.view?.target;
    const target = this.repositoryPath(relative);
    if (!target) return;
    const [picked] = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Attach screenshot',
      filters: { Images: ['png', 'jpg', 'jpeg', 'webp', 'gif'] } }) ?? [];
    if (!picked || !this.currentDelivery(binding)) return;
    if (await stat(target).then(() => true, () => false)) {
      const replace = await showCompactWarningMessage(`${relative} already exists. Replace it with the picked screenshot?`, { modal: true }, 'Replace');
      if (replace !== 'Replace') return;
    }
    await mkdir(path.dirname(target), { recursive: true });
    if (!this.currentDelivery(binding)) return;
    await copyFile(picked.fsPath, target);
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
    void showCompactInformationMessage(`Saved as ${relative}. Look at it, then sign off; the sign-off commits it with its record.`);
    await this.reload();
  }

  /** This checkout's own Playwright command, or null: capturing never installs anything. */
  private async localPlaywright(): Promise<string | null> {
    const command = path.join(this.client.repository, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
    return await stat(command).then((info) => (info.isFile() ? command : null), () => null);
  }

  /** The running application's address, when one runs. */
  private runningUrl(): string | null {
    return this.view?.application.entries?.find((entry) => entry.started)?.url ?? null;
  }

  /**
   * Capture the running screen to the suggested path with the repository's Playwright, as a task the
   * person can watch; like a test run it needs a trusted workspace. Nothing is recorded by capturing.
   */
  private async capture(relative: string): Promise<void> {
    const binding = this.view?.target;
    const target = this.repositoryPath(relative);
    const url = this.runningUrl();
    if (!target || !url || !this.playwright) return;
    if (vscode.workspace.isTrusted === false) {
      void showCompactWarningMessage('Capturing runs this repository\'s Playwright. Trust the workspace first, or attach a screenshot instead.');
      return;
    }
    if (await stat(target).then(() => true, () => false)) {
      const replace = await showCompactWarningMessage(`${relative} already exists. Replace it with a new capture?`, { modal: true }, 'Replace');
      if (replace !== 'Replace') return;
    }
    await mkdir(path.dirname(target), { recursive: true });
    if (!this.currentDelivery(binding)) return;
    const execution = new vscode.ProcessExecution(this.playwright, ['screenshot', '--viewport-size=1280,800', url, target],
      { cwd: taskStartFolder(this.client.repository) });
    const task = new vscode.Task({ type: 'singularityFlow', action: 'outcome-capture', capability: this.view?.application.capability ?? 'default' },
      vscode.TaskScope.Workspace, `Capture ${relative}`, 'Singularity Flow', execution, []);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true, focus: false, showReuseMessage: false };
    const run = await vscode.tasks.executeTask(task);
    const ended = vscode.tasks.onDidEndTaskProcess(async (event) => {
      if (event.execution !== run) return;
      ended.dispose();
      if (event.exitCode === 0) {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
        void showCompactInformationMessage(`Captured ${url} as ${relative}. Look at it, then sign off.`);
      } else {
        void showCompactWarningMessage('Playwright could not capture the screen; see its task output (its browsers may need installing). You can attach a screenshot instead.');
      }
      await this.reload();
    });
    this.disposables.push(ended);
  }

  /**
   * The person's sign-off: they look at the screenshot, answer the three checklist items and say
   * what they looked at, then confirm. The CLI records it under their authority and refuses anyone
   * else; nothing is preselected and nothing is recorded until they confirm.
   */
  private async signOff(criterionIndex: number, check: OutcomeCheck): Promise<void> {
    const binding = this.view?.target;
    const criterion = this.view?.criteria[criterionIndex];
    const relative = check.files?.[0] ?? check.suggestedFile ?? null;
    const file = this.repositoryPath(relative);
    if (!criterion || !this.view || !file || !relative) return;
    if (!(await stat(file).then((info) => info.isFile(), () => false))) {
      void showCompactInformationMessage(`No screenshot at ${relative} yet. Attach one first, then sign off.`);
      return;
    }
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
    const answers: Array<[string, boolean]> = [];
    for (const [item, question] of signOffQuestions(criterion)) {
      const choice = await vscode.window.showQuickPick([{ label: 'Yes', yes: true }, { label: 'No', yes: false }],
        { title: `Sign off ${criterion.id} · ${check.slot}`, placeHolder: question, ignoreFocusOut: true });
      if (!choice) return;
      answers.push([item, choice.yes]);
    }
    const reason = await vscode.window.showInputBox({ title: `Sign off ${criterion.id} · ${check.slot}`, ignoreFocusOut: true,
      prompt: 'What did you look at? (10 to 1000 characters)',
      validateInput: (value) => value.trim().length >= 10 && value.trim().length <= 1000 ? null : 'Say what you inspected in 10 to 1000 characters.' });
    if (!reason) return;
    const met = answers.every(([, yes]) => yes);
    const confirmed = await showCompactWarningMessage(
      `Record this sign-off of ${criterion.id} (${check.slot}) as ${met ? 'satisfied' : 'not satisfied'}? It is committed with ${relative}, under your name.`,
      { modal: true }, 'Record sign-off');
    if (confirmed !== 'Record sign-off' || !this.currentDelivery(binding)) return;
    try {
      await this.client.run(signOffArgs(this.view.workId, criterion.id, check.slot, relative, answers, reason));
      void showCompactInformationMessage(`Recorded the sign-off of ${criterion.id} (${check.slot}).`);
    } catch (failure) {
      void vscode.window.showErrorMessage(`The sign-off was not recorded: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
    await this.reload();
  }

  private async openReference(reference: string): Promise<void> {
    if (!documentReference(reference)) return this.openRepositoryFile(reference, false);
    try {
      const viewed = await this.client.run<{ absolutePath?: unknown }>(['documents', 'view', reference, '--json']);
      if (typeof viewed?.absolutePath !== 'string' || !path.isAbsolute(viewed.absolutePath)) throw new Error(`${reference} has no local file to open.`);
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(viewed.absolutePath));
    } catch (failure) {
      void showCompactWarningMessage(`${reference} could not be opened: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
  }

  private async openRepositoryFile(relative: string | null, screenshot: boolean): Promise<void> {
    const target = this.repositoryPath(relative);
    if (!target) return;
    const file = vscode.Uri.file(target);
    try {
      await vscode.workspace.fs.stat(file);
      await vscode.commands.executeCommand('vscode.open', file);
    } catch {
      void showCompactInformationMessage(screenshot
        ? `No screenshot yet. Save one of the running screen as ${relative}, then open it here.`
        : `${relative} is not in this checkout.`);
    }
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    this.panel.webview.html = page('Check the Outcome', outcomeReviewHtml(this.view, this.error, { capture: Boolean(this.playwright && this.runningUrl()) }),
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
