/**
 * Creating a workspace from the editor.
 *
 * A workspace is the thing that exists before any Epic: a directory holding a clone of each
 * participating repository, one of them nominated lead, and a registry entry so every surface
 * agrees which repositories are in scope. The CLI has had `workspace create --local` since B3; it
 * had no way in from an editor, which meant the very first step of using this product required a
 * terminal.
 *
 * This runs before any repository is open, so it cannot use the workspace-scoped client the rest of
 * the extension shares — it takes a CLI location and a working directory of its own.
 */
import * as vscode from 'vscode';
import path from 'node:path';
import { SingularityFlowClient, type CliLocation } from './cli/client.ts';

export interface RepositoryEntry {
  id: string;
  url: string;
}

/** Collect repositories one at a time until the person is done. At least one is required. */
async function askRepositories(): Promise<RepositoryEntry[] | null> {
  const repositories: RepositoryEntry[] = [];
  for (;;) {
    const url = await vscode.window.showInputBox({
      title: `Repositories (${repositories.length} added)`,
      prompt: repositories.length
        ? 'Clone URL of another repository, or leave empty to finish'
        : 'Clone URL of the first repository',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value.trim()) return repositories.length ? null : 'At least one repository is required.';
        return /^(https?:\/\/|git@|file:\/\/|\/)/.test(value.trim()) ? null : 'Enter a clone URL or an absolute path.';
      }
    });
    if (url === undefined) return null;
    if (!url.trim()) return repositories;

    // Default the id from the URL, because typing it twice is a way to get it wrong.
    const suggested = path.basename(url.trim().replace(/\.git$/, ''));
    const id = await vscode.window.showInputBox({
      title: 'Repository identifier',
      prompt: 'Short name used in Story plans and the impact map',
      value: suggested,
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.trim())) return 'Letters, numbers, dots, underscores and hyphens.';
        return repositories.some((entry) => entry.id === value.trim()) ? 'Already used.' : null;
      }
    });
    if (id === undefined) return null;
    repositories.push({ id: id.trim(), url: url.trim() });
  }
}

/**
 * The whole flow: where, what it is called, which repositories, which one leads.
 *
 * Returns the created workspace directory, or null if the person stopped. Nothing is created until
 * every question has been answered, so backing out at any point leaves the disk untouched.
 */
export async function createWorkspace(
  location: CliLocation,
  output: vscode.OutputChannel
): Promise<{ directory: string; lead: string; leadDirectory: string } | null> {
  const picked = await vscode.window.showOpenDialog({
    title: 'Where should the workspace directory be created?',
    openLabel: 'Create here',
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false
  });
  if (!picked?.length || !picked[0]) return null;
  const base = picked[0].fsPath;

  const id = await vscode.window.showInputBox({
    title: 'Workspace identifier',
    prompt: 'Directory name and registry key, e.g. checkout-platform',
    ignoreFocusOut: true,
    validateInput: (value) => (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.trim())
      ? null : 'Letters, numbers, dots, underscores and hyphens.')
  });
  if (!id?.trim()) return null;

  const name = await vscode.window.showInputBox({
    title: 'Workspace name',
    prompt: 'Shown in listings; leave empty to use the identifier',
    ignoreFocusOut: true
  });
  if (name === undefined) return null;

  const repositories = await askRepositories();
  if (!repositories?.length) return null;

  const lead = await vscode.window.showQuickPick(
    repositories.map((entry) => ({ label: entry.id, description: entry.url, id: entry.id })),
    {
      title: 'Lead repository',
      placeHolder: 'Holds the governed state: portfolio, phases, approvals',
      ignoreFocusOut: true
    });
  if (!lead) return null;

  // --json so the created directory is read rather than guessed: the engine derives the directory
  // name from the identifier AND the name (`platform--platform-workspace`), so reconstructing it
  // here would be a second implementation of a rule that is not this extension's to know.
  const args = ['workspace', 'create', '--local', '--json', '--id', id.trim(), '--base', base,
    '--lead', lead.id, '--confirm', id.trim()];
  if (name.trim()) args.push('--name', name.trim());
  for (const entry of repositories) args.push('--repository', `${entry.id}=${entry.url}`);

  const client = new SingularityFlowClient({ location, repository: base, onOutput: (text) => output.append(text) });
  output.appendLine(`\n$ singularity-flow ${args.join(' ')}`);
  let created: { workspace?: { path?: string; leadRepository?: string } };
  try {
    created = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating ${id.trim()} and cloning ${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'}…` },
      () => client.run<{ workspace?: { path?: string; leadRepository?: string } }>(args));
  } catch (error) {
    void vscode.window.showErrorMessage((error as Error).message);
    return null;
  }

  const directory = created.workspace?.path;
  if (!directory) {
    void vscode.window.showErrorMessage('The workspace was created but its directory was not reported.');
    return null;
  }
  const leadId = created.workspace?.leadRepository ?? lead.id;
  return { directory, lead: leadId, leadDirectory: path.join(directory, 'repos', leadId) };
}

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
