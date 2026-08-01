/**
 * Turning on the workflow ledger for a newly created workspace.
 *
 * The form itself lives in views/workspace-panel.ts; this is the step that follows it.
 */
import * as vscode from 'vscode';
import path from 'node:path';
import { SingularityFlowClient, type CliLocation } from './cli/client.ts';

/**
 * Turn on the workflow ledger and create its orphan branch.
 *
 * The ledger is an append-only record of what happened to each work item — the branch has no shared
 * ancestry with any code branch and is never merged into one, so governance history cannot be
 * rewritten by a rebase of the work it describes. It is off by default in the starter workflow, and
 * the branch does not exist until it is initialized, which is why this is offered at creation: it is
 * the one moment when turning it on costs nothing.
 */
export async function enableStateLedger(
  location: CliLocation,
  leadDirectory: string,
  branch: string,
  output: vscode.OutputChannel
): Promise<boolean> {
  const workflow = vscode.Uri.file(path.join(leadDirectory, 'singularity', 'workflow.yml'));
  let text: string;
  try {
    text = Buffer.from(await vscode.workspace.fs.readFile(workflow)).toString('utf8');
  } catch {
    output.appendLine(`No singularity/workflow.yml in ${leadDirectory}; the ledger was not enabled.`);
    return false;
  }

  // Rewritten rather than parsed and re-emitted: this file is mostly commentary explaining each
  // setting, and a YAML round trip would throw all of it away.
  const configured = /^ledger:$/m.test(text)
    ? text.replace(/^ledger:\n(?:[ \t]+.*\n)*/m,
      `ledger:\n  enabled: true\n  branch: ${branch}\n  remote: origin\n  behind: warn\n`
      + '  enforcement: shadow\n  signing: off\n  trustTier: T0\n  maxRetries: 4\n'
      + '  pinTransport: refs\n  retentionDays: 2555\n')
    : `${text}\nledger:\n  enabled: true\n  branch: ${branch}\n  remote: origin\n`;
  await vscode.workspace.fs.writeFile(workflow, Buffer.from(configured, 'utf8'));

  const client = new SingularityFlowClient({ location, repository: leadDirectory, onOutput: (text2) => output.append(text2) });
  try {
    await client.runText(['ledger', 'init']);
    return true;
  } catch (error) {
    output.appendLine(`Ledger initialization failed: ${(error as Error).message}`);
    void vscode.window.showWarningMessage(
      `The workspace was created, but the ${branch} branch could not be initialized: ${(error as Error).message}`);
    return false;
  }
}
