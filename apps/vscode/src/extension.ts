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
import { ConfigurationValidator } from './validation.ts';
import { approveWithReceipt, resolvePlaceholders, runGovernedAction } from './actions.ts';
import { enableStateLedger } from './workspace.ts';
import { WorkspacePanel } from './views/workspace-panel.ts';
import { LifecycleTreeProvider } from './views/lifecycle.ts';
import { JourneyPanel, type JourneyMessage } from './views/journey.ts';
import { ReconciliationPanel } from './views/reconciliation.ts';
import { ApprovalsPanel, type ApprovalsMessage } from './views/approvals.ts';
import { StoriesPanel, type StoriesMessage } from './views/stories.ts';
import { ImpactPanel } from './views/impact.ts';
import { CapabilitiesPanel, type CapabilitiesMessage } from './views/capabilities.ts';
import { EpicPanel } from './views/epic-panel.ts';
import { DashboardPanel } from './views/dashboard.ts';
import { DesignerPanel, type DesignerMessage } from './views/designer.ts';
import { WorkspacesPanel, type WorkspacesMessage } from './views/workspaces-panel.ts';
import type { WorkspaceEntry } from './views/workspaces-model.ts';
import { epicCommand } from './views/epic-form.ts';
import { capabilityArgv } from './views/capability-model.ts';
import { unavailableTree, type TreeNode } from './views/tree-model.ts';
import { NodeTreeProvider } from './views/navigation.ts';
import {
  buildCapabilityTree, buildWorkspaceTree, capabilityIdOf, workspacePathOf
} from './views/navigation-trees.ts';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Singularity Flow');
  context.subscriptions.push(output);

  /**
   * Register the view with a fixed explanation and stop.
   *
   * Every path out of activation goes through here rather than returning bare. A contributed view
   * with no provider makes VS Code report that no data provider is registered, which describes the
   * extension's internals and nothing about the repository the reader has open.
   */
  /**
   * The commands that need a repository behind them.
   *
   * Every one of these is contributed in package.json, so the command palette offers all of them
   * whatever state the window is in. They used to be registered after activation had decided it
   * had a repository — which meant that in a window without one, the palette advertised eleven
   * commands that did not exist, and running one reported "command not found". That describes the
   * extension's internals and nothing about the folder the reader has open.
   *
   * So they are registered here, unconditionally, and dispatch through `handlers`. Until a
   * repository is available the handler is missing and the command says why, in the same words the
   * view is showing.
   */
  const REPOSITORY_COMMANDS = [
    'singularityFlow.openCapabilities', 'singularityFlow.openImpact', 'singularityFlow.openStories',
    'singularityFlow.openApprovals', 'singularityFlow.startEpic', 'singularityFlow.addSource',
    'singularityFlow.refresh', 'singularityFlow.openArtifact', 'singularityFlow.runAction',
    'singularityFlow.approve', 'singularityFlow.openJourney', 'singularityFlow.openReconciliation',
    'singularityFlow.showImpact', 'singularityFlow.addCapability', 'singularityFlow.editCapability',
    'singularityFlow.openDashboard', 'singularityFlow.openDesigner'
  ];
  /**
   * The two navigation trees, registered before anything can go wrong.
   *
   * Workspaces are machine-wide and are populated whatever the open folder is. Capabilities need
   * the lead repository, so until there is one the tree says that rather than being absent — a
   * contributed view with no provider reports on the extension rather than on the folder.
   */
  const capabilityTree = new NodeTreeProvider();
  const workspaceTree = new NodeTreeProvider();
  context.subscriptions.push(capabilityTree, workspaceTree);
  context.subscriptions.push(
    vscode.window.createTreeView('singularityFlow.capabilities', { treeDataProvider: capabilityTree }),
    vscode.window.createTreeView('singularityFlow.workspaces', { treeDataProvider: workspaceTree })
  );

  const handlers = new Map<string, (...args: never[]) => unknown>();
  let unavailableReason = 'Open the repository that contains singularity/workflow.yml.';
  for (const id of REPOSITORY_COMMANDS) {
    context.subscriptions.push(vscode.commands.registerCommand(id, (...args: never[]) => {
      const handler = handlers.get(id);
      if (handler) return handler(...args);
      void vscode.window.showWarningMessage(
        `Singularity Flow: ${unavailableReason}`,
        'Find a workspace', 'Create a workspace'
      ).then((chosen) => {
        if (chosen === 'Find a workspace') return vscode.commands.executeCommand('singularityFlow.openWorkspaces');
        if (chosen === 'Create a workspace') return vscode.commands.executeCommand('singularityFlow.createWorkspace');
        return undefined;
      });
      return undefined;
    }));
  }

  const unavailable = (
    label: string, detail: string, contextValue?: string, leadRepository?: string | null
  ): void => {
    output.appendLine(`${label} — ${detail}`);
    // The same sentence the view is showing, so a command and the tree never disagree about why
    // there is nothing to act on.
    unavailableReason = detail;
    capabilityTree.replace(buildCapabilityTree(null, detail));
    const provider = new LifecycleTreeProvider(null,
      unavailableTree(label, detail, contextValue, leadRepository));
    context.subscriptions.push(provider);
    context.subscriptions.push(vscode.window.createTreeView('singularityFlow.lifecycle', {
      treeDataProvider: provider
    }));
  };

  /**
   * Create a workspace, then offer its append-only state branch and open the lead repository.
   *
   * Registered before any early return: this is the command for when there is no repository to
   * serve yet, which is precisely when activation stops early.
   */
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.createWorkspace', () => {
    let location;
    try {
      location = resolveCli({ extensionPath: context.extensionPath });
    } catch (error) {
      return void vscode.window.showErrorMessage((error as Error).message);
    }

    WorkspacePanel.show(context, location, output, async (created) => {
      // Asked on the form, not after it. A prompt that appears once the panel has closed asks about
      // a decision the person has already finished making, and cannot be corrected without starting
      // the whole workspace again.
      if (created.stateBranch) await enableStateLedger(location, created.leadDirectory, created.stateBranch, output);

      const open = await vscode.window.showInformationMessage(
        `Workspace created with ${created.lead} as lead.`,
        'Open lead repository', 'Open workspace folder');
      const target = open === 'Open lead repository' ? created.leadDirectory
        : open === 'Open workspace folder' ? created.directory
          : null;
      if (target) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: false });
    });
  }));

  /**
   * The workspaces on this machine, and the three things you can do to one.
   *
   * Registered before any early return, like creating one: a person with no repository open is
   * exactly the person who needs to find the workspace they already have.
   */
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.openWorkspaces', async () => {
    let location;
    try {
      location = resolveCli({ extensionPath: context.extensionPath });
    } catch (error) {
      return void vscode.window.showErrorMessage((error as Error).message);
    }
    // The registry is machine-wide, so this runs from wherever the CLI happens to be rooted rather
    // than from a repository the person may not have open.
    const registry = new SingularityFlowClient({
      location, repository: process.cwd(), onOutput: (text) => output.append(text)
    });
    const list = (): Promise<WorkspaceEntry[]> =>
      registry.run<WorkspaceEntry[]>(['workspace', 'list', '--json']).catch(() => []);

    const onMessage = async (message: WorkspacesMessage): Promise<string | null> => {
      if (message.type === 'create') {
        await vscode.commands.executeCommand('singularityFlow.createWorkspace');
        return null;
      }
      if (message.type === 'open') {
        await vscode.commands.executeCommand('vscode.openFolder',
          vscode.Uri.file(message.row.leadRepositoryPath || message.row.directory),
          { forceNewWindow: false });
        return null;
      }
      if (message.type === 'forget') {
        const confirmed = await vscode.window.showWarningMessage(
          `Forget ${message.row.name}?`,
          { modal: true, detail: `Removes it from the workspace list. ${message.row.directory} is left exactly as it is.` },
          'Forget');
        if (confirmed !== 'Forget') return null;
        message = { type: 'run', command: ['workspace', 'forget', message.row.directory, '--json'], title: 'Forgetting workspace' };
      }
      output.appendLine(`\n$ singularity-flow ${message.command.join(' ')}`);
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: message.title },
          () => registry.runText(message.command));
        return null;
      } catch (error) {
        output.appendLine(`  failed: ${(error as Error).message}`);
        return (error as Error).message;
      }
    };

    WorkspacesPanel.show(context, await list(), list, async (message) => {
      const failure = await onMessage(message);
      // Anything that changes the registry changes the tree beside it.
      if (message.type !== 'open') void refreshWorkspaceTree();
      return failure;
    });
  }));

  /**
   * The workspace tree, and the two things it offers.
   *
   * Machine-wide: the registry does not depend on which folder happens to be open, which is exactly
   * why this is useful in a window that has no repository in it yet.
   */
  const refreshWorkspaceTree = async (): Promise<void> => {
    try {
      const location = resolveCli({ extensionPath: context.extensionPath });
      const entries = await new SingularityFlowClient({
        location, repository: process.cwd(), onOutput: () => {}
      }).run<WorkspaceEntry[]>(['workspace', 'list', '--json']);
      workspaceTree.replace(buildWorkspaceTree(entries));
    } catch (error) {
      output.appendLine(`Could not read the workspace registry: ${(error as Error).message}`);
      workspaceTree.replace(buildWorkspaceTree([]));
    }
  };
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.openWorkspace',
    async (node?: TreeNode) => {
      // The lead repository, not the workspace directory: that is where the capability map, the
      // governed state branch and every command's configuration live.
      const target = node?.openPath ?? workspacePathOf(node);
      if (!target) return;
      await vscode.commands.executeCommand('vscode.openFolder',
        vscode.Uri.file(target), { forceNewWindow: false });
    }));
  void refreshWorkspaceTree();

  /** Diagnostics, as the CLI reports them. */
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.doctor', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return void vscode.window.showWarningMessage('Open a repository first.');
    try {
      const report = await new SingularityFlowClient({
        location: resolveCli({ extensionPath: context.extensionPath }),
        repository: folder.uri.fsPath,
        onOutput: (text) => output.append(text)
      }).runText(['doctor']);
      const document = await vscode.workspace.openTextDocument({ content: report, language: 'plaintext' });
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      void vscode.window.showErrorMessage((error as Error).message);
    }
  }));

  // Offered from the uninitialized state, so a folder that is not yet a Flow repository can become
  // one without leaving the editor. Registered before any early return, since that is exactly when
  // it is the only useful thing to do.
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.init', async () => {
    const target = vscode.workspace.workspaceFolders?.[0];
    if (!target) return;
    const confirmed = await vscode.window.showWarningMessage(
      'Initialize Singularity Flow in this repository?',
      { modal: true, detail: `This writes singularity/ into ${target.uri.fsPath} and commits it.` },
      'Initialize');
    if (confirmed !== 'Initialize') return;
    try {
      const location = resolveCli({ extensionPath: context.extensionPath });
      await new SingularityFlowClient({ location, repository: target.uri.fsPath, onOutput: (text) => output.append(text) })
        .runText(['init']);
      // The extension host has to reload: activation already decided this was not a Flow repository.
      const reload = await vscode.window.showInformationMessage(
        'Singularity Flow initialized. Reload the window to open it?', 'Reload');
      if (reload === 'Reload') await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
      void vscode.window.showErrorMessage((error as Error).message);
    }
  }));

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return unavailable('No folder is open',
      'Open the repository that contains singularity/workflow.yml.');
  }

  let repository: string;
  try {
    repository = await validateRepositoryDirectory(folder.uri.fsPath);
  } catch (error) {
    // A workspace directory holds repos/, documents/ and workspace.json — it is not itself a
    // repository, but opening it is the obvious thing to do from a file manager, and it knows
    // exactly where the repository someone wanted is.
    const lead = await workspaceLeadDirectory(folder.uri.fsPath);
    if (lead) {
      return unavailable('This is a workspace directory, not a repository',
        `Its lead repository is ${lead}, which is where the capability map and the governed state live.`,
        'sflow.workspace-directory', lead);
    }
    // Not a Singularity Flow repository is an ordinary state for a folder to be in. It is said in
    // the view, where the person is looking, and the view offers to initialize one.
    return unavailable('Not a Singularity Flow repository',
      (error as Error).message, 'sflow.uninitialized');
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
    return unavailable('No Singularity Flow CLI was found', (error as Error).message);
  }
  output.appendLine(`Using CLI (${client.location.source}): ${client.location.cli}`);

  const store = new WorkspaceStore(client);
  context.subscriptions.push(store);
  // The capability tree is the map as the lead repository states it, so it follows the snapshot
  // rather than being refreshed by whoever happened to change it.
  context.subscriptions.push(store.onDidChange((state) =>
    capabilityTree.replace(buildCapabilityTree(state.snapshot, state.error?.message ?? null))));
  capabilityTree.replace(buildCapabilityTree(store.current.snapshot));

  // Governed configuration is edited in ordinary tabs; saving one asks the engine whether the result
  // is still valid, so a broken workflow.yml is reported where it was typed rather than by a command
  // failing later for a reason that looks unrelated.
  context.subscriptions.push(new ConfigurationValidator(client, repository));

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
    // Checked before anything is asked. The engine refuses to start an Epic when no approval
    // authority has a member, and discovering that after five questions — with a message naming a
    // YAML key — is a poor greeting for someone who has just initialized a repository.
    const authorities = store.current.snapshot?.portfolio?.approvalAuthorities ?? {};
    const named = Object.entries(authorities).filter(([, authority]) => (authority?.members ?? []).length);
    if (Object.keys(authorities).length && !named.length) {
      const open = await vscode.window.showWarningMessage(
        'No approval authority has a member yet, so an Epic cannot be started.',
        { modal: true, detail: 'Add at least one person under approvalAuthorities in singularity/portfolio.yml. Every governed approval is checked against that list.' },
        'Open portfolio.yml');
      if (open === 'Open portfolio.yml') {
        const target = vscode.Uri.file(path.join(repository, store.current.snapshot?.portfolioPath ?? 'singularity/portfolio.yml'));
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
      }
      return;
    }

    // Five prompts in a row, each covering the answer before it, with the one that decides the
    // Epic's whole lifecycle asked last. It is a form: everything visible at once, everything
    // correctable, and the profiles shown with the phases that actually distinguish them.
    const profiles = await client.run<Array<{
      id: string; label?: string; description?: string; phases?: string[];
    }>>(['initiative', 'profiles', '--json']).catch(() => []);
    const personas = store.current.snapshot?.definition?.personas ?? {};

    EpicPanel.show(context, {
      profiles: profiles.map((entry) => ({
        id: entry.id,
        label: entry.label ?? entry.id,
        description: entry.description ?? '',
        phases: entry.phases ?? []
      })),
      lenses: Object.entries(personas).map(([id, persona]) => ({
        label: (persona as { label?: string })?.label ?? id, id
      }))
    }, async (form) => {
      // The refusal comes back to the form rather than to a notification the panel outlives, so it
      // can be corrected against the fields that caused it.
      const ran = await runGovernedAction(client, {
        command: epicCommand(form), title: `Starting ${form.title.trim()}`
      }, output);
      if (!ran) return 'The Epic was not started. The output channel has the engine\'s reason.';
      await store.refresh();
      return null;
    });
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

  /**
   * Acting on an approval card.
   *
   * The page names a card; which approval that is was resolved from the snapshot before this runs,
   * so the subject and the confirmation string come from governed state rather than the page.
   */
  const onApprovalsMessage = async (message: ApprovalsMessage): Promise<void> => {
    const { approval } = message;
    const initiative = store.current.snapshot?.initiative;
    if (message.type === 'open') {
      const output = initiative?.state.phases[approval.phase]?.outputs?.[approval.subject];
      if (output) {
        await openArtifact(repository, {
          kind: 'artifact', id: approval.id, label: approval.label, path: output.path
        });
      }
      return;
    }
    if (message.type === 'approve') {
      return runNode({
        kind: 'action', id: approval.id, label: approval.label,
        approve: {
          initiativeId: initiative?.state.initiative.id ?? '',
          subject: approval.subject,
          expected: approval.expected,
          summary: `Approve ${approval.label}`
        }
      });
    }
    // Rejecting needs a reason: an invalidation nobody can explain is worse than none at all.
    const reason = await vscode.window.showInputBox({
      title: `Reject ${approval.label}`,
      prompt: 'Why is this being sent back? Recorded with the decision.',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? null : 'A reason is required.')
    });
    if (!reason?.trim()) return;
    await runNode({
      kind: 'action', id: approval.id, label: approval.label,
      command: ['initiative', 'reject', approval.subject, '--reason', reason.trim()]
    });
  };

  const onStoriesMessage = async (message: StoriesMessage): Promise<void> => {
    const initiativeId = store.current.snapshot?.initiative?.state.initiative.id ?? '';
    if (message.type === 'materialize') {
      // The confirmation is the Epic's own identifier, exactly as the terminal demands it.
      return runNode({
        kind: 'action', id: 'materialize', label: 'Push Stories to their repositories',
        command: ['initiative', 'materialize'],
        confirmation: { expected: initiativeId, summary: `Push ${initiativeId} Stories to their repositories` }
      });
    }
    if (message.type === 'spec') {
      // The specification lives beside the Story plan, under the planning phase.
      return openArtifact(repository, {
        kind: 'artifact', id: `spec:${message.story.planId}`, label: message.story.workId,
        path: `singularity/initiatives/${initiativeId}/artifacts/epic-planning/stories/${message.story.planId}/story-spec.md`
      });
    }
    const title = await vscode.window.showInputBox({
      title: `Split ${message.story.workId}`,
      prompt: 'Title of the new Story carved out of this one',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? null : 'A title is required.')
    });
    if (!title?.trim()) return;
    await runNode({
      kind: 'action', id: `split:${message.story.planId}`, label: 'Split Story',
      command: ['epic', 'stories', 'split', message.story.planId, '--title', title.trim()]
    });
  };

  /**
   * Editing the capability map.
   *
   * The engine validates the whole tree before it writes, so a refusal is the answer rather than a
   * failure: it goes back onto the panel that caused it, in the engine's own words, instead of into a
   * notification the reader has to hold in their head while fixing the form.
   */
  const onCapabilitiesMessage = async (message: CapabilitiesMessage): Promise<void> => {
    const panel = CapabilitiesPanel.show(context, store, (next) => { void onCapabilitiesMessage(next); });
    if (message.type === 'remove') {
      const confirmed = await vscode.window.showWarningMessage(
        `Remove ${message.id} from the capability map?`,
        { modal: true, detail: 'The map is the lead repository\'s record of what this organisation builds. Anything this capability delivers loses its owner.' },
        'Remove'
      );
      if (confirmed !== 'Remove') return;
    }
    const argv = message.type === 'remove'
      ? capabilityArgv('remove', message.id)
      : capabilityArgv(message.type === 'create' ? 'add' : 'set', message.id, message.edits);

    output.appendLine(`\n$ singularity-flow ${argv.join(' ')}`);
    try {
      await client.runText(argv);
    } catch (error) {
      output.appendLine(`  refused: ${(error as Error).message}`);
      return panel.report((error as Error).message);
    }
    await store.refresh();
    panel.settled(message.type === 'remove' ? '' : message.id);
  };

  // The commands themselves were registered at activation; this is what they do once there is a
  // repository to do it against.
  const registered: Record<string, (...args: never[]) => unknown> = {
    'singularityFlow.openCapabilities':
      () => CapabilitiesPanel.show(context, store, (message) => { void onCapabilitiesMessage(message); }),
    'singularityFlow.openImpact': () => ImpactPanel.show(context, store, client),
    'singularityFlow.openStories':
      () => StoriesPanel.show(context, store, (message) => { void onStoriesMessage(message); }),
    'singularityFlow.openApprovals':
      () => ApprovalsPanel.show(context, store, (message) => { void onApprovalsMessage(message); }),
    'singularityFlow.startEpic': startEpic,
    'singularityFlow.addSource': addSource,
    'singularityFlow.refresh': () => store.refresh(),
    'singularityFlow.openArtifact': ((node?: TreeNode) => openArtifact(repository, node)) as never,
    'singularityFlow.runAction': runNode as never,
    'singularityFlow.approve': runNode as never,
    'singularityFlow.openJourney': () => JourneyPanel.show(context, store, onJourneyMessage),
    'singularityFlow.openReconciliation': () => ReconciliationPanel.show(context, store, client),
    'singularityFlow.showImpact': () => showImpact(client, output),
    'singularityFlow.openDashboard': () => DashboardPanel.show(context, store),
    'singularityFlow.openDesigner': () => DesignerPanel.show(context, store, async (message) => {
      if (message.type === 'open') {
        await openArtifact(repository, { kind: 'artifact', id: message.path, label: message.path, path: message.path });
        return null;
      }
      // Written through the engine, which validates before it writes — a template is governed
      // configuration like any other, and the editor does not get its own way past that.
      output.appendLine(`\n$ singularity-flow desktop save ${message.path}`);
      try {
        await client.runText(['desktop', 'save', message.path], { input: message.content });
        await store.refresh();
        return null;
      } catch (error) {
        output.appendLine(`  refused: ${(error as Error).message}`);
        return (error as Error).message;
      }
    }),
    // Both open the same screen, positioned: adding lands on the form for a new capability under
    // whatever was clicked, editing lands on the capability itself.
    'singularityFlow.addCapability': ((node?: TreeNode) => {
      const panel = CapabilitiesPanel.show(context, store, (message) => { void onCapabilitiesMessage(message); });
      panel.beginAdd(capabilityIdOf(node));
    }) as never,
    'singularityFlow.editCapability': ((node?: TreeNode) => {
      const panel = CapabilitiesPanel.show(context, store, (message) => { void onCapabilitiesMessage(message); });
      const capability = capabilityIdOf(node);
      if (capability) panel.focus(capability);
    }) as never
  };
  for (const [id, handler] of Object.entries(registered)) handlers.set(id, handler);
  // A contributed command with no handler here would be one the palette offers and nothing answers.
  const orphaned = REPOSITORY_COMMANDS.filter((id) => !handlers.has(id));
  if (orphaned.length) output.appendLine(`Commands with no handler: ${orphaned.join(', ')}`);

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

/**
 * The lead repository of a workspace directory, or null when this is not one.
 *
 * Read through the editor's own file system rather than the CLI: this runs on a path the CLI has
 * already refused to treat as a repository, so there is nothing to run a command in.
 */
async function workspaceLeadDirectory(folder: string): Promise<string | null> {
  try {
    const manifest = vscode.Uri.file(path.join(folder, 'workspace.json'));
    const text = Buffer.from(await vscode.workspace.fs.readFile(manifest)).toString('utf8');
    const workspace = JSON.parse(text) as {
      leadRepository?: string;
      repositories?: Record<string, { path?: string }>;
    };
    const lead = workspace.leadRepository;
    if (!lead) return null;
    const relative = workspace.repositories?.[lead]?.path ?? `repos/${lead}`;
    return path.join(folder, relative);
  } catch {
    return null;
  }
}

export function deactivate(): void { /* Every disposable is registered on the context. */ }
