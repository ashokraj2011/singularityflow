import { showCompactWarningMessage } from "../compact-message.ts";
/** VS Code presentation over the existing CLI's repository-scoped shared DraftStore. */
import * as vscode from 'vscode';
import path from 'node:path';
import { terminalCommand } from '../cli/runner.ts';
import { commandGuidance } from '../copilot-command.ts';
import { registerMessageRouter } from './messages.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { SharedWorkflowDraftController, workflowDraftCopilotContextIssue, type WorkflowDraftRunner } from './workflow-drafts-model.ts';
import { withWorkflowDraftInputFile } from './workflow-drafts-input.ts';
import { sharedWorkflowDraftsHtml, SHARED_WORKFLOW_DRAFTS_SCRIPT, workflowDraftDurabilityLabel, workflowDraftRecoveryLabel } from './workflow-drafts-page.ts';
import { createWorkflowDraftRecoveryStore } from './workflow-drafts-recovery.ts';
import { WorkflowDraftComparisonBuffers, WORKFLOW_DRAFT_COMPARISON_SCHEME, type WorkflowDraftComparison } from './workflow-drafts-comparison.ts';

export type { WorkflowDraftRunner } from './workflow-drafts-model.ts';

const comparisonHosts = new WeakMap<vscode.ExtensionContext, (value: WorkflowDraftComparison) => Promise<void>>();
function privateComparisonHost(context: vscode.ExtensionContext): (value: WorkflowDraftComparison) => Promise<void> {
  const retained = comparisonHosts.get(context); if (retained) return retained;
  const buffers = new WorkflowDraftComparisonBuffers();
  const provider = vscode.workspace.registerTextDocumentContentProvider(WORKFLOW_DRAFT_COMPARISON_SCHEME, {
    provideTextDocumentContent: (uri) => {
      const text = buffers.content(uri.toString());
      if (text === undefined) throw new Error('This private comparison is no longer retained. Compare again from the draft editor.');
      return text;
    }
  });
  const closed = vscode.workspace.onDidCloseTextDocument((document) => buffers.release(document.uri.toString()));
  context.subscriptions.push(provider, closed, { dispose: () => { buffers.clear(); comparisonHosts.delete(context); } });
  const compare = async (value: WorkflowDraftComparison): Promise<void> => {
    const opened = buffers.add(value);
    try {
      // Content-provider documents are read-only and memory-backed, not plaintext temporary files.
      // VS Code can normalize EOLs for display: this visual diff never authorizes a bytewise merge.
      await vscode.commands.executeCommand('vscode.diff', vscode.Uri.parse(opened.left), vscode.Uri.parse(opened.right), opened.title);
    } catch {
      buffers.release(opened.left); buffers.release(opened.right);
      throw new Error('The read-only private comparison could not be opened. Its encrypted checkpoint has not been removed.');
    }
  };
  comparisonHosts.set(context, compare); return compare;
}

class SharedWorkflowDraftsPanel {
  private static current: SharedWorkflowDraftsPanel | null = null;
  private readonly controller: SharedWorkflowDraftController;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private constructor(private readonly panel: vscode.WebviewPanel, runner: WorkflowDraftRunner, root: string, context: vscode.ExtensionContext) {
    const recovery = createWorkflowDraftRecoveryStore(path.join(context.globalStorageUri.fsPath, 'workflow-draft-recovery'), context.secrets);
    this.controller = new SharedWorkflowDraftController(root, runner,
      (text, invoke) => withWorkflowDraftInputFile(text, invoke, {
        cleanupWarning: () => { void showCompactWarningMessage('The private draft request could not be removed from the OS temporary directory. The shared-write acknowledgement is unchanged.'); }
      }), {
        changed: () => this.render(),
        statusChanged: () => {
          const view = this.controller.view; const editor = view.editor;
          if (!this.disposed && editor) void this.panel.webview.postMessage({ type: 'draft-status',
            binding: editor.binding, durability: workflowDraftDurabilityLabel(view),
            recovery: workflowDraftRecoveryLabel(view), hasRecoveryCandidate: view.recovery.candidateAvailable,
            restoreAllowed: view.recovery.restoreAllowed, readOnly: Boolean(editor.readOnlyReason), dirty: view.dirty,
            recoveryBlocked: view.recovery.candidateAvailable || ['failed', 'checking'].includes(view.recovery.status),
            autosave: `Shared autosave ${view.autosave ? 'on for this exact draft' : 'off'}.`,
            revision: `Retained saved revision ${editor.record.revision} · lifecycle epoch ${editor.record.lifecycleEpoch}\n${editor.record.revisionSha256}\nCompare-and-swap head: ${editor.head}\nRetained draft authority: ${editor.authority}`,
            operation: view.operationId ? `Last write operation ID: ${view.operationId}. Check status before retrying uncertain writes.` : '',
            busy: view.busy, hasShow: Boolean(view.show), hasPreview: Boolean(view.preview), error: view.error ?? '' }).then(undefined, () => {});
        },
        exit: () => this.panel.dispose(),
        compareRecovery: privateComparisonHost(context),
        editorRejected: (binding, message) => {
          if (!this.disposed) void this.panel.webview.postMessage({ type: 'editor-rejected', binding, message }).then(undefined, () => {});
        },
        confirmDiscard: async (reason) => {
          const recoveryOnly = reason === 'private-checkpoint';
          const label = recoveryOnly ? 'Discard private checkpoint' : 'Discard unsaved text';
          return await showCompactWarningMessage(
            recoveryOnly ? 'Discard this private workflow draft checkpoint?' : 'Discard unsaved workflow draft text?', { modal: true,
              detail: recoveryOnly
                ? 'This removes only the reviewed private recovery copy on this machine. The current editor text and shared Git draft remain unchanged. Cancel keeps the checkpoint.'
                : 'This replaces pending editor text and removes only its reviewed private checkpoint on this machine. It does not delete a shared draft or merge anything. Cancel keeps the text and checkpoint.' },
            label) === label;
        },
        confirmLockRepair: async (inspection) => {
          const label = 'Remove this dead private lock';
          return await showCompactWarningMessage('Repair this interrupted private checkpoint lock?', {
            modal: true, detail: `Draft: ${inspection.scope.draftId}\nRepository: ${inspection.scope.repository}\nAuthority: ${inspection.scope.authority}\nLock: ${inspection.kind}${inspection.kind === 'key-init' ? ' (directory-wide key initialization)' : ''}\nDirectory: ${inspection.directorySha256}\nOwner PID: ${inspection.owner?.pid ?? 'unknown'}\nLock nonce: ${inspection.owner?.lockNonce ?? 'unknown'}\n${inspection.reason}\nOnly the exact proven-dead same-domain lock is removed after fresh ownership checks. Text, ciphertext, encryption key and shared Git draft are not changed. No save or retry runs. Cancel keeps everything.`
          }, label) === label;
        },
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
      }, undefined, recovery);
    const handle = (raw: unknown) => this.controller.receive(raw);
    const router = registerMessageRouter('singularityFlow.sharedWorkflowDrafts', {
      change: handle, refresh: handle, open: handle, create: handle, save: handle,
      reload: handle, show: handle, 'operation-status': handle, 'terminal-review': handle, 'copilot-review': handle,
      'autosave-on': handle, 'autosave-off': handle, stage: handle, 'back-drafts': handle, exit: handle,
      'guide-answer': handle, 'add-stage': handle, 'move-stage': handle, preview: handle, 'catalog-answer': handle,
      'submit-review': handle, 'copilot-submit-review': handle,
      'usage-query': handle, 'usage-next': handle,
      'recovery-restore': handle, 'recovery-compare': handle, 'recovery-discard': handle, 'recovery-refresh': handle,
      'recovery-inspect-locks': handle, 'recovery-repair-lock': handle
    });
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      void Promise.resolve(router.route(raw)).catch((error) => {
      this.controller.view.error = error instanceof Error ? error.message : String(error); this.render();
      });
    }, null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render(); void this.controller.initialize();
  }
  private dispose(): void {
    if (this.disposed) return;
    if (this.controller.view.dirty || ['saving', 'uncertain'].includes(this.controller.view.durability)) {
      const view = this.controller.view;
      const privateStatus = view.recovery.status === 'saved'
        ? 'Its acknowledged encrypted private checkpoint is retained on this machine. Reopen this repository and draft to Restore, Compare or Discard.'
        : 'The latest private checkpoint is not acknowledged; the newest edits may not survive closing. Any earlier acknowledged checkpoint is retained.';
      void showCompactWarningMessage(`The closed draft panel had pending changes. ${privateStatus} Native close does not flush to Git. Reconcile any unknown shared operation before another write.`);
    }
    this.disposed = true; this.controller.dispose();
    for (const disposable of this.disposables) disposable.dispose();
    if (SharedWorkflowDraftsPanel.current === this) SharedWorkflowDraftsPanel.current = null;
  }
  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    this.panel.webview.html = page('Shared Workflow Drafts', sharedWorkflowDraftsHtml(this.controller.view),
      contentSecurityPolicy(this.panel.webview, token), token, SHARED_WORKFLOW_DRAFTS_SCRIPT);
  }
  static async show(context: vscode.ExtensionContext, runner: WorkflowDraftRunner, root: string): Promise<void> {
    const current = this.current;
    if (current && !current.disposed) {
      if (current.controller.view.repository === root) { current.panel.reveal(vscode.ViewColumn.Active); return; }
      await showCompactWarningMessage('Shared Workflow Drafts is still bound to another opened repository. Close that panel before switching; any unsaved text remains there.');
      current.panel.reveal(vscode.ViewColumn.Active); return;
    }
    const panel = vscode.window.createWebviewPanel('singularityFlow.sharedWorkflowDrafts', 'Shared Workflow Drafts', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
    try { this.current = new SharedWorkflowDraftsPanel(panel, runner, root, context); }
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
