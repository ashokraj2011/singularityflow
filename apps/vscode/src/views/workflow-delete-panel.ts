/**
 * Workflow Studio's Delete… review page (lazy panels runtime). [docs/SPEC-WORKFLOW-RETIREMENT-v1.md]
 *
 * It previews `workflow delete <ID> --dry-run --json` and shows that exact plan. Propose deletion runs
 * `--confirm <planSha256>`, with `--propose` when the plan bound an approved destination. A person
 * clicking here is the confirmer the engine expects; the Copilot guard refuses the same command in an
 * agent turn. A changed configuration (WORKFLOW_DELETE_PLAN_STALE) previews again; the default
 * workflow asks for its replacement first. The page shows names and paths, never file contents.
 */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { formatCliArgsForDisplay } from '../cli/runner.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField } from './messages.ts';
import {
  deletePlanFrom, deleteResultFrom, liveWorkflows, refusalOf, restoreCommand, workflowDeleteConfirmArgs, workflowDeleteHtml, workflowDeletePreviewArgs,
  WORKFLOW_DELETE_SCRIPT, WORKFLOW_DELETE_STYLE, type DeletePlan, type DeleteResult
} from './workflow-delete-page.ts';

/** What became of a Delete…, for Workflow Studio's status line. */
export interface WorkflowRetireOutcome { outcome: 'cancelled' | 'proposed' | 'written' | 'unchanged' | 'failed'; text: string; branch?: string | null }

export interface WorkflowDeleteRequest {
  client: SingularityFlowClient;
  output: vscode.OutputChannel;
  selector: string;
  label: string;
  /** Workflow labels by selector (`story:<id>`, `initiative:<id>`), for the names the plan lists. */
  labels: Record<string, string>;
  /** Review and activate a proposal, as Workflow Studio does. */
  review(branch: string): Promise<unknown>;
}

/**
 * Ask which live workflow new Stories default to, when the one being retired is the default.
 * `live` is the engine's list (`details.live`); null when the person chose none.
 */
export async function chooseNewDefault(label: string, live: readonly string[], labels: Record<string, string>): Promise<string | null> {
  if (!live.length) return null;
  const picked = await vscode.window.showQuickPick(live.map((id) => ({ label: labels[`story:${id}`] ?? id, description: id, id })), {
    title: 'Choose the new default workflow',
    placeHolder: `${label} is the default workflow for new Stories. Choose the one new Stories default to instead.`,
    ignoreFocusOut: true
  });
  return picked?.id ?? null;
}

export class WorkflowDeletePanel {
  private plan: DeletePlan | null = null;
  private newDefault: string | null = null;
  private needsDefault = false;
  /** The live workflows the engine named when it asked for a new default. */
  private live: string[] = [];
  private busy = false;
  private notice: string | null = null;
  private error: string | null = null;
  private done: DeleteResult | null = null;
  private disposed = false;
  private settle: (outcome: WorkflowRetireOutcome) => void = () => {};

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly request: WorkflowDeleteRequest) {}

  /** Open the review page; resolves once the deletion is proposed (or written), or the page closes. */
  static show(request: WorkflowDeleteRequest): Promise<WorkflowRetireOutcome> {
    const panel = vscode.window.createWebviewPanel('singularityFlow.workflowDelete', `Delete ${request.label}`, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    const review = new WorkflowDeletePanel(panel, request);
    return new Promise((resolve) => {
      let settled = false;
      review.settle = (outcome) => { if (!settled) { settled = true; resolve(outcome); } };
      const router = registerMessageRouter('singularityFlow.workflowDelete', {
        'delete.cancel': () => { panel.dispose(); },
        'delete.preview': () => review.preview(),
        'delete.default': () => review.chooseDefault(),
        'delete.confirm': (message) => review.confirm(stringField(message, 'planSha256')),
        'delete.review': () => review.reviewProposal(),
        'delete.copy': () => review.copyRestore()
      });
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        const navigation = navigationTarget(raw);
        if (navigation) return void navigateTo(navigation);
        if (review.busy) return;
        return router.route(raw);
      });
      panel.onDidDispose(() => {
        review.disposed = true;
        review.settle({ outcome: 'cancelled', text: `Nothing was deleted; ${request.label} is unchanged.` });
      });
      void review.preview();
    });
  }

  private log(args: string[]): void { this.request.output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(args)}`); }

  /** The exact plan as the configuration stands now. */
  private async preview(): Promise<void> {
    this.busy = true; this.error = null; this.render();
    const args = workflowDeletePreviewArgs(this.request.selector, this.newDefault);
    this.log(args);
    try {
      const plan = deletePlanFrom(await this.request.client.run<unknown>(args));
      if (!plan || plan.selector !== this.request.selector) throw new Error('The engine did not return a delete plan for this workflow.');
      this.plan = plan; this.needsDefault = false;
    } catch (error) {
      this.plan = null;
      const refusal = refusalOf(error);
      this.request.output.appendLine(`  refused: ${refusal?.message ?? (error as Error).message}`);
      if (refusal?.code === 'WORKFLOW_DEFAULT_REPLACEMENT_REQUIRED' && liveWorkflows(refusal).length) {
        this.needsDefault = true; this.live = liveWorkflows(refusal);
        this.busy = false;
        return this.chooseDefault();
      }
      this.error = refusal?.message ?? (error as Error).message;
    }
    this.busy = false; this.render();
  }

  /** The replacement default, from the live workflows the engine's last refusal named. */
  private async chooseDefault(): Promise<void> {
    if (this.busy) return;
    const chosen = await chooseNewDefault(this.request.label, this.live, this.request.labels);
    if (this.disposed) return;
    if (!chosen) {
      this.error = `${this.request.label} is the default workflow for new Stories. Choose the workflow that becomes the default to preview the delete.`;
      return this.render();
    }
    this.newDefault = chosen;
    return this.preview();
  }

  /** Propose the deletion of exactly the plan on screen. */
  private async confirm(planSha256: string | null): Promise<void> {
    const plan = this.plan;
    if (!plan || planSha256 !== plan.planSha256 || plan.stories.unpinned.length || this.done) return this.render();
    const args = workflowDeleteConfirmArgs(plan.selector, plan.planSha256, this.newDefault, plan.proposes);
    this.busy = true; this.notice = null; this.error = null; this.render();
    this.log(args);
    try {
      const result = deleteResultFrom(await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: `Deleting ${this.request.label}`, cancellable: false
      }, () => this.request.client.run<unknown>(args)));
      if (result.backupPath) this.request.output.appendLine(`  backup: ${result.backupPath} (restore: ${restoreCommand(result.backupPath)})`);
      this.done = result; this.busy = false; this.render();
      this.settle(result.reviewRequired && result.branch
        ? { outcome: 'proposed', branch: result.branch, text: `Deletion of ${this.request.label} proposed as ${result.branch}; it waits for review under Changes.` }
        : { outcome: 'written', text: `Deleted ${this.request.label} in this repository's configuration files; review the diff and commit it.` });
    } catch (error) {
      const refusal = refusalOf(error);
      this.busy = false;
      this.request.output.appendLine(`  refused: ${refusal?.message ?? (error as Error).message}`);
      if (refusal?.code === 'WORKFLOW_DELETE_PLAN_STALE') {
        this.notice = 'The configuration changed since this preview, so it was previewed again. Review the new plan, then propose it.';
        return this.preview();
      }
      if (refusal?.code === 'WORKFLOW_DEFAULT_REPLACEMENT_REQUIRED') { this.live = liveWorkflows(refusal); return this.chooseDefault(); }
      this.error = refusal?.message ?? (error as Error).message;
      // A Story that started since the preview blocks it: show the Stories as they are now.
      if (refusal?.code === 'WORKFLOW_DELETE_STORIES_UNPINNED') { const reason = this.error; await this.preview(); this.error = reason; }
      this.render();
    }
  }

  private async reviewProposal(): Promise<void> {
    const branch = this.done?.reviewRequired ? this.done.branch : null;
    if (!branch) return;
    this.panel.dispose();
    await this.request.review(branch);
  }

  private async copyRestore(): Promise<void> {
    if (!this.done?.backupPath) return;
    await vscode.env.clipboard.writeText(restoreCommand(this.done.backupPath));
    this.notice = 'Copied the restore command.'; this.render();
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    this.panel.webview.html = page(`Delete ${this.request.label}`, workflowDeleteHtml({
      label: this.request.label, selector: this.request.selector, plan: this.plan, busy: this.busy, notice: this.notice, error: this.error,
      needsDefault: this.needsDefault, done: this.done, labels: this.request.labels
    }), contentSecurityPolicy(this.panel.webview, token), token, WORKFLOW_DELETE_SCRIPT, { styles: WORKFLOW_DELETE_STYLE });
  }
}
