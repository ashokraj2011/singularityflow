/** VS Code presentation over the existing CLI's repository-scoped shared DraftStore. */
import * as vscode from 'vscode';
import path from 'node:path';
import { terminalCommand } from '../cli/runner.ts';
import { commandGuidance } from '../copilot-command.ts';
import { registerMessageRouter } from './messages.ts';
import { contentSecurityPolicy, nonce, page } from './webview.ts';
import { SharedWorkflowDraftController, workflowDraftCopilotContextIssue, type WorkflowDraftRunner } from './workflow-drafts-model.ts';
import { withWorkflowDraftInputFile } from './workflow-drafts-input.ts';
import { sharedWorkflowDraftsHtml, SHARED_WORKFLOW_DRAFTS_SCRIPT, workflowDraftDurabilityLabel } from './workflow-drafts-page.ts';

export type { WorkflowDraftRunner } from './workflow-drafts-model.ts';

class SharedWorkflowDraftsPanel {
  private static current: SharedWorkflowDraftsPanel | null = null;
  private readonly controller: SharedWorkflowDraftController;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private constructor(private readonly panel: vscode.WebviewPanel, runner: WorkflowDraftRunner, root: string) {
    this.controller = new SharedWorkflowDraftController(root, runner,
      (text, invoke) => withWorkflowDraftInputFile(text, invoke, {
        cleanupWarning: () => { void vscode.window.showWarningMessage('The private draft request could not be removed from the OS temporary directory. The shared-write acknowledgement is unchanged.'); }
      }), {
        changed: () => this.render(),
        statusChanged: () => {
          const view = this.controller.view; const editor = view.editor;
          if (!this.disposed && editor) void this.panel.webview.postMessage({ type: 'draft-status',
            binding: editor.binding, durability: workflowDraftDurabilityLabel(view),
            autosave: `Shared autosave ${view.autosave ? 'on for this exact draft' : 'off'}.`,
            revision: `Retained saved revision ${editor.record.revision} · lifecycle epoch ${editor.record.lifecycleEpoch}\n${editor.record.revisionSha256}\nCompare-and-swap head: ${editor.head}\nRetained draft authority: ${editor.authority}`,
            operation: view.operationId ? `Last write operation ID: ${view.operationId}. Check status before retrying uncertain writes.` : '',
            busy: view.busy, hasShow: Boolean(view.show), hasPreview: Boolean(view.preview), error: view.error ?? '' }).then(undefined, () => {});
        },
        exit: () => this.panel.dispose(),
        editorRejected: (binding, message) => {
          if (!this.disposed) void this.panel.webview.postMessage({ type: 'editor-rejected', binding, message }).then(undefined, () => {});
        },
        confirmDiscard: async () => await vscode.window.showWarningMessage(
          'Discard unsaved workflow draft text?', { modal: true,
            detail: 'Reload, opening another draft, or creating a draft will replace this editor buffer. Nothing is merged automatically. Cancel keeps the unsaved text.' },
          'Discard unsaved text') === 'Discard unsaved text',
        copyReview: async (repository, argv, surface) => {
          if (surface === 'copilot') {
            const issue = workflowDraftCopilotContextIssue(repository,
              (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath));
            if (issue) throw new Error(issue);
          }
          const guidance = commandGuidance({ executable: 'singularity-flow', argv });
          if (!guidance?.copyable) throw new Error('No safe paired Shell/Copilot handoff is available for this draft.');
          await vscode.env.clipboard.writeText(surface === 'shell'
            ? terminalCommand(repository, guidance.argv) : guidance.copilotCommand);
        }
      });
    const handle = (raw: unknown) => this.controller.receive(raw);
    const router = registerMessageRouter('singularityFlow.sharedWorkflowDrafts', {
      change: handle, refresh: handle, open: handle, create: handle, save: handle,
      reload: handle, show: handle, 'operation-status': handle, 'terminal-review': handle, 'copilot-review': handle,
      'autosave-on': handle, 'autosave-off': handle, stage: handle, 'back-drafts': handle, exit: handle,
      'guide-answer': handle, 'add-stage': handle, 'move-stage': handle, preview: handle, 'catalog-answer': handle,
      'submit-review': handle, 'copilot-submit-review': handle
    });
    panel.webview.onDidReceiveMessage((raw: unknown) => { void Promise.resolve(router.route(raw)).catch((error) => {
      this.controller.view.error = error instanceof Error ? error.message : String(error); this.render();
    }); }, null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render(); void this.controller.initialize();
  }
  private dispose(): void {
    if (this.disposed) return;
    if (this.controller.view.dirty || ['saving', 'uncertain'].includes(this.controller.view.durability)) void vscode.window.showWarningMessage('The closed draft panel contained pending memory-only text or an unacknowledged checkpoint. Its last acknowledged shared revision is retained; native tab close does not guarantee a flush or local recovery. Check any retained operation ID from the shared store; use the panel Exit action to flush captured edits before closing.');
    this.disposed = true; this.controller.dispose();
    for (const disposable of this.disposables) disposable.dispose();
    if (SharedWorkflowDraftsPanel.current === this) SharedWorkflowDraftsPanel.current = null;
  }
  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    this.panel.webview.html = page('Shared Workflow Drafts', sharedWorkflowDraftsHtml(this.controller.view),
      contentSecurityPolicy(this.panel.webview, token), token, SHARED_WORKFLOW_DRAFTS_SCRIPT, { nav: false });
  }
  static async show(context: vscode.ExtensionContext, runner: WorkflowDraftRunner, root: string): Promise<void> {
    const current = this.current;
    if (current && !current.disposed) {
      if (current.controller.view.repository === root) { current.panel.reveal(vscode.ViewColumn.Active); return; }
      await vscode.window.showWarningMessage('Shared Workflow Drafts is still bound to another opened repository. Close that panel before switching; any unsaved text remains there.');
      current.panel.reveal(vscode.ViewColumn.Active); return;
    }
    const panel = vscode.window.createWebviewPanel('singularityFlow.sharedWorkflowDrafts', 'Shared Workflow Drafts', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
    try { this.current = new SharedWorkflowDraftsPanel(panel, runner, root); }
    catch (error) { panel.dispose(); throw error; }
  }
}

/** Integration passes an explicit opened repository and the dynamic CLI runner; no home fallback. */
export async function showSharedWorkflowDrafts(
  context: vscode.ExtensionContext, runner: WorkflowDraftRunner, root?: string
): Promise<void> {
  if (!root || !path.isAbsolute(root) || /[\0\r\n]/u.test(root)) {
    await vscode.window.showErrorMessage('Open an explicit repository to use Shared Workflow Drafts. No machine-wide or home repository is selected.'); return;
  }
  await SharedWorkflowDraftsPanel.show(context, runner, path.resolve(root));
}
