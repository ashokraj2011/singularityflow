/**
 * Activation, commands, and the wiring between them.
 *
 * The extension refuses to half-work: if the workspace is not a Singularity Flow repository, or no
 * CLI can be found, it says so once and stops rather than presenting an empty tree that looks like a
 * repository with nothing in it.
 */
import * as vscode from 'vscode';
import path from 'node:path';
import { resolveCli, SingularityFlowClient } from './cli/client.ts';
import { validateRepositoryDirectory } from './cli/runner.ts';
import { WorkspaceStore } from './state.ts';
import { approveWithReceipt, resolvePlaceholders, runGovernedAction } from './actions.ts';
import { LifecycleTreeProvider } from './views/lifecycle.ts';
import { JourneyPanel, type JourneyMessage } from './views/journey.ts';
import { ReconciliationPanel } from './views/reconciliation.ts';
import type { TreeNode } from './views/tree-model.ts';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;

  const output = vscode.window.createOutputChannel('Singularity Flow');
  context.subscriptions.push(output);

  let repository: string;
  try {
    repository = await validateRepositoryDirectory(folder.uri.fsPath);
  } catch (error) {
    // Not a Singularity Flow repository is an ordinary state for a folder to be in, not a failure to
    // report loudly; the reason goes to the channel for anyone who expected otherwise.
    output.appendLine(`Not activating: ${(error as Error).message}`);
    return;
  }

  const settings = vscode.workspace.getConfiguration('singularityFlow');
  let client: SingularityFlowClient;
  try {
    client = new SingularityFlowClient({
      location: resolveCli({
        configuredCli: settings.get<string>('cliPath'),
        configuredNode: settings.get<string>('nodePath'),
        extensionPath: context.extensionPath
      }),
      repository,
      onOutput: (text) => output.append(text)
    });
  } catch (error) {
    void vscode.window.showErrorMessage((error as Error).message);
    return;
  }
  output.appendLine(`Using CLI (${client.location.source}): ${client.location.cli}`);

  const store = new WorkspaceStore(client);
  context.subscriptions.push(store);

  const tree = new LifecycleTreeProvider(store);
  context.subscriptions.push(tree);
  context.subscriptions.push(vscode.window.createTreeView('singularityFlow.lifecycle', {
    treeDataProvider: tree,
    showCollapseAll: true
  }));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'singularityFlow.refresh';
  context.subscriptions.push(status);
  context.subscriptions.push(store.onDidChange((state) => {
    if (state.loading) { status.text = '$(loading~spin) Singularity Flow'; status.show(); return; }
    if (state.error) { status.text = '$(error) Singularity Flow'; status.tooltip = state.error.message; status.show(); return; }
    const initiative = state.snapshot?.initiative;
    if (!initiative) { status.text = '$(rocket) No Epic'; status.tooltip = 'No Epic is checked out on this branch.'; status.show(); return; }
    const phase = initiative.state.currentPhase ?? 'complete';
    status.text = `$(rocket) ${initiative.state.initiative.id} · ${phase}`;
    status.tooltip = initiative.nextActions?.[0]?.reason ?? 'Singularity Flow';
    status.show();
  }));

  /**
   * Run whatever a node offers, then refresh so every view reflects what just happened.
   *
   * Approvals take the receipt path; everything else is a plain command. They are different enough
   * to be worth distinguishing here rather than papering over with one code path.
   */
  const runNode = async (node?: TreeNode): Promise<void> => {
    if (node?.approve) {
      if (await approveWithReceipt(client, node.approve, output)) await store.refresh();
      return;
    }
    if (!node?.command) return;
    // A suggested command may carry `<PATH>`-style placeholders meant for a person to fill in.
    // Running them literally passes the placeholder to the CLI, which then fails on a file of that
    // name — a failure that says nothing about what was actually wanted.
    const argv = await resolvePlaceholders(node.command, repository);
    if (!argv) return;
    const ran = await runGovernedAction(client, {
      command: argv,
      title: node.confirmation?.summary ?? `singularity-flow ${argv.join(' ')}`,
      ...(node.confirmation ? { confirmation: node.confirmation } : {})
    }, output);
    if (ran) await store.refresh();
  };

  /** Resolve a webview's artifact id against the snapshot; ids from a page are never paths. */
  const nodeForOutput = (outputId: string): TreeNode | null => {
    const initiative = store.current.snapshot?.initiative;
    const phaseId = initiative?.state.currentPhase;
    if (!initiative || !phaseId) return null;
    const output = initiative.state.phases[phaseId]?.outputs?.[outputId];
    if (!output) return null;
    return {
      kind: 'artifact',
      id: `artifact:${phaseId}/${output.id}`,
      label: output.label ?? output.id,
      path: output.path,
      readOnly: output.status === 'approved',
      ...(output.sha256 && output.status !== 'approved' ? {
        approve: {
          initiativeId: initiative.state.initiative.id,
          subject: output.id,
          expected: `${phaseId}:${output.id}`,
          summary: `Approve ${output.label ?? output.id}`
        }
      } : {})
    };
  };

  const onJourneyMessage = async (message: JourneyMessage): Promise<void> => {
    if (message.type === 'pin') return addSource();
    if (message.type === 'run') {
      const next = store.current.snapshot?.initiative?.nextActions?.[0];
      if (!next) return;
      return runNode({
        kind: 'action', id: 'next', label: next.reason,
        command: next.command.replace(/^singularity-flow\s+/, '').split(/\s+/)
      });
    }
    const node = nodeForOutput(message.outputId);
    if (!node) return;
    if (message.type === 'open') return openArtifact(repository, node);
    await runNode(node);
  };

  /**
   * Start an Epic.
   *
   * Every answer is asked for; none is guessed. The profile and the working lens come from the
   * repository's own configuration rather than a list this file keeps, so a portfolio that adds a
   * profile offers it here without the extension being changed.
   */
  const startEpic = async (): Promise<void> => {
    const ask = async (title: string, prompt: string): Promise<string | null> => {
      const value = await vscode.window.showInputBox({ title, prompt, ignoreFocusOut: true,
        validateInput: (input) => (input.trim() ? null : 'This is required.') });
      return value?.trim() || null;
    };
    const title = await ask('Start an Epic', 'Title');
    if (!title) return;
    const description = await ask('Start an Epic', 'What is being asked for?');
    if (!description) return;
    const goal = await ask('Start an Epic', 'What outcome would make this a success?');
    if (!goal) return;

    const profiles = await client.run<Array<{ id: string; label?: string; description?: string }>>(
      ['initiative', 'profiles', '--json']).catch(() => []);
    const profile = profiles.length
      ? await vscode.window.showQuickPick(
        profiles.map((entry) => ({ label: entry.label ?? entry.id, description: entry.description ?? '', id: entry.id })),
        { title: 'Delivery profile', placeHolder: 'Which phases this Epic will run', ignoreFocusOut: true })
      : { id: 'epic-planning' };
    if (!profile) return;

    const personas = store.current.snapshot?.definition?.personas ?? {};
    const lens = await vscode.window.showQuickPick(
      Object.entries(personas).map(([id, persona]) => ({
        label: (persona as { label?: string })?.label ?? id, id
      })),
      { title: 'Working lens', placeHolder: 'The lens this Epic starts under', ignoreFocusOut: true });
    if (!lens) return;

    const ran = await runGovernedAction(client, {
      command: ['epic', 'start', '--local', '--title', title, '--description', description,
        '--goal', goal, '--profile', profile.id, '--persona', lens.id],
      title: `Starting ${title}`
    }, output);
    if (ran) await store.refresh();
  };

  /**
   * Pin a source.
   *
   * A file picker is the one thing an editor does better than a terminal here, and pinning is the
   * step that decides what every later requirement is allowed to cite.
   */
  const addSource = async (): Promise<void> => {
    const picked = await vscode.window.showOpenDialog({
      title: 'Pin a source for this Epic',
      openLabel: 'Pin this source',
      canSelectMany: false
    });
    if (!picked?.length || !picked[0]) return;
    const ran = await runGovernedAction(client, {
      command: ['epic', 'sources', 'add', '--provider', 'local', '--file', picked[0].fsPath],
      title: 'Pinning source'
    }, output);
    if (ran) await store.refresh();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('singularityFlow.startEpic', startEpic),
    vscode.commands.registerCommand('singularityFlow.addSource', addSource),
    vscode.commands.registerCommand('singularityFlow.refresh', () => store.refresh()),
    vscode.commands.registerCommand('singularityFlow.openArtifact', (node?: TreeNode) => openArtifact(repository, node)),
    vscode.commands.registerCommand('singularityFlow.runAction', runNode),
    vscode.commands.registerCommand('singularityFlow.approve', runNode),
    vscode.commands.registerCommand('singularityFlow.openJourney', () => JourneyPanel.show(context, store, onJourneyMessage)),
    vscode.commands.registerCommand('singularityFlow.openReconciliation', () => ReconciliationPanel.show(context, store, client)),
    vscode.commands.registerCommand('singularityFlow.showImpact', () => showImpact(client, output))
  );

  await store.refresh();
}

/**
 * Open an artifact as a normal editor tab.
 *
 * The path comes from the snapshot rather than from anything a view constructed, and it is resolved
 * and then checked to be inside the repository — a `..` that escaped the workspace would be a
 * genuine path-traversal, and the check costs nothing.
 */
async function openArtifact(repository: string, node?: TreeNode): Promise<void> {
  if (!node?.path) return;
  const absolute = path.resolve(repository, node.path);
  const relative = path.relative(repository, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    void vscode.window.showErrorMessage(`Refusing to open a path outside the repository: ${node.path}`);
    return;
  }

  const uri = vscode.Uri.file(absolute);
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
    if (node.readOnly) {
      // An approved artifact is pinned by hash into approvals that already happened, so editing it
      // in place silently invalidates them. Said once, rather than enforced by fighting the editor.
      void vscode.window.setStatusBarMessage(
        '$(lock-small) This artifact is approved and hash-pinned. Editing it invalidates its approval.', 6_000);
    }
  } catch {
    void vscode.window.showWarningMessage(`This artifact has not been generated yet: ${node.path}`);
  }
}

async function showImpact(client: SingularityFlowClient, output: vscode.OutputChannel): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Computing impact…' },
    async () => {
      try {
        const impact = await client.runText(['epic', 'impact', '--markdown']);
        const document = await vscode.workspace.openTextDocument({ content: impact, language: 'markdown' });
        await vscode.window.showTextDocument(document, { preview: true });
      } catch (error) {
        output.appendLine(`epic impact failed: ${(error as Error).message}`);
        void vscode.window.showErrorMessage((error as Error).message);
      }
    }
  );
}

export function deactivate(): void { /* Every disposable is registered on the context. */ }
