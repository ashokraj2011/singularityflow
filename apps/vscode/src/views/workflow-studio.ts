/**
 * Workflow Studio: create and change workflows, their steps, the agent that drafts each step and
 * the people who sign it off, then check and publish everything as one governed change.
 *
 * The page keeps the draft; this host only reads the model (`workflow studio --json`), asks the
 * engine to check a change set (`--dry-run`), and publishes it after a person confirms. The engine
 * remains the authority: it validates the whole candidate configuration and writes through a review
 * proposal (or a local authority's working tree). The extension never writes configuration itself.
 */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { formatCliArgsForDisplay } from '../cli/runner.ts';
import { navigationTarget, nonce } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { integerField, registerMessageRouter, stringField } from './messages.ts';
import {
  STUDIO_MODEL_ARGS, STUDIO_PREVIEW_ARGS, studioPublishArgs, workflowStudioHtml, type StudioAuthority
} from './workflow-studio-page.ts';


interface StudioModel { authority?: StudioAuthority; base?: unknown; [key: string]: unknown }
interface StudioPlan { valid: boolean; changed: boolean; summary: string[]; problems: Array<{ message: string }>; warnings: Array<{ message: string }>; files: Array<{ path: string }> }
interface StudioApplyResult extends StudioPlan { reviewRequired?: boolean; branch?: string | null; authorityMode?: string; written?: string[] }

const MAX_CHANGE_SET_BYTES = 1024 * 1024;


export interface WorkflowStudioActions {
  /** Re-read repository state after a publish, so the rest of the extension sees it. */
  refresh(): Promise<void>;
  /** Review and activate a configuration proposal the way the Workflow Designer does. */
  reviewProposal(branch: string): Promise<void>;
}

export class WorkflowStudioPanel implements vscode.Disposable {
  private static current: WorkflowStudioPanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  private model: StudioModel | null = null;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly client: SingularityFlowClient,
    private readonly output: vscode.OutputChannel,
    private readonly actions: WorkflowStudioActions
  ) {
    panel.webview.onDidReceiveMessage(async (raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      await this.router.route(raw);
    }, null, this.subscriptions);
    panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
    panel.webview.html = workflowStudioHtml(panel.webview, nonce());
  }

  static show(client: SingularityFlowClient, output: vscode.OutputChannel, actions: WorkflowStudioActions): WorkflowStudioPanel {
    if (WorkflowStudioPanel.current) {
      WorkflowStudioPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return WorkflowStudioPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.workflowStudio', 'Workflow Studio', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    WorkflowStudioPanel.current = new WorkflowStudioPanel(panel, client, output, actions);
    return WorkflowStudioPanel.current;
  }

  /**
   * The four messages the page sends. The change set arrives as JSON text and is bounded here; the
   * engine parses and validates its content, so the host never trusts its shape.
   */
  private router = registerMessageRouter('singularityFlow.workflowStudio', {
    'studio.ready': () => this.load(false),
    'studio.reload': () => this.load(true),
    'studio.preview': (message) => this.preview(stringField(message, 'changeSet')),
    'studio.publish': (message) => this.publish(stringField(message, 'changeSet'), integerField(message, 'count') ?? 0)
  });

  private post(message: Record<string, unknown>): void {
    void this.panel.webview.postMessage(message);
  }

  private async load(reset: boolean): Promise<void> {
    try {
      this.model = await this.client.run<StudioModel>([...STUDIO_MODEL_ARGS]);
      this.post({ type: 'studio.model', model: this.model, reset });
    } catch (error) {
      this.post({ type: 'studio.failed', message: (error as Error).message });
    }
  }

  private changeSet(text: string | null): string | null {
    if (!text || Buffer.byteLength(text, 'utf8') > MAX_CHANGE_SET_BYTES) {
      this.post({ type: 'studio.failed', message: 'That change set is empty or too large to check.' });
      return null;
    }
    return text;
  }

  private async preview(text: string | null): Promise<void> {
    const changeSet = this.changeSet(text);
    if (!changeSet) return;
    try {
      const plan = await this.client.runWithInput<StudioPlan>([...STUDIO_PREVIEW_ARGS], changeSet);
      this.post({ type: 'studio.plan', plan, changeSet });
    } catch (error) {
      this.post({ type: 'studio.failed', message: (error as Error).message });
    }
  }

  private async publish(text: string | null, count: number): Promise<void> {
    const changeSet = this.changeSet(text);
    if (!changeSet) return;
    let args: string[];
    try { args = studioPublishArgs(this.model?.authority); }
    catch (error) { this.post({ type: 'studio.failed', message: (error as Error).message }); return; }
    const proposal = args.includes('--propose');
    const confirmed = await vscode.window.showWarningMessage(
      `Publish ${count} ${count === 1 ? 'change' : 'changes'} from Workflow Studio?`,
      {
        modal: true,
        detail: proposal
          ? 'They become one review proposal on the approved configuration. Approved configuration and running Stories do not change until it is merged.'
          : 'The files are written to this repository. Review the diff and commit it through your usual review. Running Stories keep the workflow they started with.'
      },
      proposal ? 'Publish for review' : 'Write files'
    );
    if (!confirmed) { this.post({ type: 'studio.cancelled' }); return; }
    this.output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(args)}`);
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Publishing Workflow Studio changes', cancellable: false },
        () => this.client.runWithInput<StudioApplyResult>(args, changeSet)
      );
      for (const line of result.summary ?? []) this.output.appendLine(`  ${line}`);
      const summary = result.reviewRequired && result.branch
        ? `Published for review as ${result.branch}.`
        : `Wrote ${(result.written ?? []).length} file(s) to this repository.`;
      this.post({ type: 'studio.published', summary });
      await this.load(true);
      await this.actions.refresh();
      if (result.reviewRequired && result.branch) {
        const choice = await vscode.window.showInformationMessage(
          `Workflow Studio changes are ready for review: ${result.branch}.`, 'Review and activate', 'Later');
        if (choice === 'Review and activate') await this.actions.reviewProposal(result.branch);
      } else {
        const choice = await vscode.window.showInformationMessage(
          'Workflow Studio wrote the configuration files. Review the diff and commit it.', 'Open Source Control');
        if (choice === 'Open Source Control') await vscode.commands.executeCommand('workbench.view.scm');
      }
    } catch (error) {
      this.output.appendLine(`  refused: ${(error as Error).message}`);
      this.post({ type: 'studio.failed', message: (error as Error).message });
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    if (WorkflowStudioPanel.current === this) WorkflowStudioPanel.current = null;
  }
}
