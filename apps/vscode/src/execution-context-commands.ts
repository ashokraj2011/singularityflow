/** Thin UI ports: the kernel owns context, takeover, inventory and cleanup decisions. */
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { SingularityFlowClient } from './cli/client.ts';
import { showCompactInformationMessage, showCompactWarningMessage } from './compact-message.ts';

/** Registered with every window's repository commands, so a window without a repository explains why. */
export const EXECUTION_CONTEXT_COMMANDS = [
  'singularityFlow.executionContext', 'singularityFlow.checkoutInventory', 'singularityFlow.cleanupRetention',
  'singularityFlow.runRetention', 'singularityFlow.cleanupCheckouts', 'singularityFlow.takeoverStory'
] as const;

export function executionContextHandlers(context: vscode.ExtensionContext, client: SingularityFlowClient): Record<typeof EXECUTION_CONTEXT_COMMANDS[number], () => Promise<void>> {
  const surface = randomUUID();
  let maintenancePending = false;
  const heartbeat = async (): Promise<void> => {
    if (maintenancePending) return;
    maintenancePending = true;
    try { await client.run(['workspace', 'retention', '--heartbeat', '--surface', surface, '--pid', String(process.pid), '--json']); }
    catch { /* Unmapped/offline/invalid contexts never become cleanup authority. Explicit commands show diagnostics. */ }
    finally { maintenancePending = false; }
  };
  const initial = setTimeout(() => { void heartbeat(); }, 10000);
  const interval = setInterval(() => { void heartbeat(); }, 60000);
  initial.unref(); interval.unref();
  context.subscriptions.push({ dispose: () => { clearTimeout(initial); clearInterval(interval); } });
  const show = async (value: unknown): Promise<void> => {
    const document = await vscode.workspace.openTextDocument({ language: 'json', content: `${JSON.stringify(value, null, 2)}\n` });
    await vscode.window.showTextDocument(document, { preview: true });
  };
  const handle = (execute: () => Promise<void>) => async (): Promise<void> => {
    try { await execute(); }
    catch (error) { await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
  };
  return {
    'singularityFlow.executionContext': handle(async () => show(await client.run(['workspace', 'context', '--json']))),
    'singularityFlow.checkoutInventory': handle(async () => show(await client.run(['workspace', 'checkouts', '--json']))),
    'singularityFlow.cleanupRetention': handle(async () => {
      const current = await client.run<{ settings: { enabled: boolean; completedDays: number; cancelledDays: number; unusedCloneDays: number; intervalMinutes: number } }>(['workspace', 'retention', '--json']);
      const enabled = await vscode.window.showQuickPick(['Enabled', 'Disabled'], { title: 'Automatic workspace cleanup' });
      if (!enabled) return;
      const settings = current.settings;
      const value = enabled === 'Disabled' ? null : await vscode.window.showInputBox({ title: 'Cleanup retention',
        prompt: 'Completed days, cancelled days, unused clone days, check interval minutes. Zero days means immediate eligibility, not permission to discard work.',
        value: `${settings.completedDays},${settings.cancelledDays},${settings.unusedCloneDays},${settings.intervalMinutes}`,
        validateInput: text => {
          const parts = text.split(',').map(part => part.trim()), values = parts.map(Number);
          return values.length === 4 && parts.every(part => /^(?:0|[1-9][0-9]*)$/u.test(part)) && values.every(Number.isInteger) && values.slice(0, 3).every(days => days >= 0 && days <= 3650)
            && values[3]! >= 1 && values[3]! <= 10080 ? undefined : 'Enter three retention days (0–3650) and an interval (1–10080 minutes).';
        } });
      if (enabled === 'Enabled' && value === undefined) return;
      const days = value?.split(',').map(item => item.trim());
      await show(await client.run(['workspace', 'retention', '--enabled', String(enabled === 'Enabled'),
        ...(days ? ['--completed-days', days[0]!, '--cancelled-days', days[1]!, '--unused-clone-days', days[2]!, '--interval-minutes', days[3]!] : []), '--json']));
    }),
    'singularityFlow.runRetention': handle(async () => show(await client.run(['workspace', 'cleanup', '--automatic', '--refresh', '--json']))),
    'singularityFlow.cleanupCheckouts': handle(async () => {
      const plan = await client.run<{ candidates: unknown[]; confirmation: string }>(['workspace', 'cleanup', '--purge', '--json']);
      await show(plan);
      if (!plan.candidates.length) { await showCompactInformationMessage('No verified unused clones are eligible for cleanup.'); return; }
      const answer = await showCompactWarningMessage(
        `Remove ${plan.candidates.length} verified unused clone(s)?`, { modal: true,
          detail: 'The kernel rechecks publication, local edits, private recovery state, and dependent worktrees. Selected, canonical and adopted checkouts are retained.' }, 'Remove unused clones');
      if (answer !== 'Remove unused clones') return;
      await show(await client.run(['workspace', 'cleanup', '--purge', '--apply', '--confirm', plan.confirmation, '--json']));
    }),
    'singularityFlow.takeoverStory': handle(async () => {
      const id = await vscode.window.showInputBox({ title: 'Take over a published Story', prompt: 'Exact Story ID. Synchronizes published work; does not approve or advance the Story.' });
      if (!id?.trim()) return;
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: `Synchronizing ${id.trim()}…` }, () => client.run<{ ready: boolean; repositoryPath: string }>(['session', 'takeover', id.trim(), '--json']));
      if (result.ready) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(result.repositoryPath), { forceReuseWindow: true });
      else await show(result);
    })
  };
}
