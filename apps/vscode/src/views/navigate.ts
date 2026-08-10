/**
 * Following a footer link.
 *
 * A thin adapter on purpose: the judgement about whether a destination can be reached lives in
 * `navigationPlan`, which is free of `vscode` and therefore testable. This file only does what the
 * plan says. Keep it small enough to be verified by reading.
 */
import * as vscode from 'vscode';
import { navigationPlan } from './webview.ts';

export async function navigateTo(command: string): Promise<void> {
  // `true` filters to commands registered right now, rather than everything the manifest declares —
  // which is exactly the distinction that matters for the three destinations that register late.
  const plan = navigationPlan(command, await vscode.commands.getCommands(true));
  if (plan.kind === 'execute') {
    await vscode.commands.executeCommand(plan.command);
    return;
  }
  const choice = await vscode.window.showInformationMessage(plan.message, plan.action);
  if (choice === plan.action) await vscode.commands.executeCommand(plan.resolve);
}
