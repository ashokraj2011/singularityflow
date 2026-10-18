/** Thin UI ports: the kernel owns context, takeover, inventory and cleanup decisions. */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from './cli/client.ts';

export function registerExecutionContextCommands(context: vscode.ExtensionContext, client: SingularityFlowClient): void {
  const show = async (value: unknown): Promise<void> => {
    const document = await vscode.workspace.openTextDocument({ language: 'json', content: `${JSON.stringify(value, null, 2)}\n` });
    await vscode.window.showTextDocument(document, { preview: true });
  };
  const register = (id: string, execute: () => Promise<void>): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
      try { await execute(); }
      catch (error) { await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
    }));
  };
  register('singularityFlow.executionContext', async () => show(await client.run(['workspace', 'context', '--json'])));
  register('singularityFlow.checkoutInventory', async () => show(await client.run(['workspace', 'checkouts', '--json'])));
  register('singularityFlow.cleanupCheckouts', async () => {
    const plan = await client.run<{ candidates: unknown[]; confirmation: string }>(['workspace', 'cleanup', '--purge', '--json']);
    await show(plan);
    if (!plan.candidates.length) { await vscode.window.showInformationMessage('No verified unused clones are eligible for cleanup.'); return; }
    const answer = await vscode.window.showWarningMessage(
      `Remove ${plan.candidates.length} verified unused clone(s)?`, { modal: true,
        detail: 'The kernel rechecks publication, local edits, private recovery state, and dependent worktrees. Selected, canonical and adopted checkouts are retained.' }, 'Remove unused clones');
    if (answer !== 'Remove unused clones') return;
    await show(await client.run(['workspace', 'cleanup', '--purge', '--apply', '--confirm', plan.confirmation, '--json']));
  });
  register('singularityFlow.takeoverStory', async () => {
    const id = await vscode.window.showInputBox({ title: 'Take over a published Story', prompt: 'Exact Story ID. Synchronizes published work; does not approve or advance the Story.' });
    if (!id?.trim()) return;
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: `Synchronizing ${id.trim()}…` }, () => client.run<{ ready: boolean; repositoryPath: string }>(['session', 'takeover', id.trim(), '--json']));
    if (result.ready) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(result.repositoryPath), { forceReuseWindow: true });
    else await show(result);
  });
}
