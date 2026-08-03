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
import { WorkspacePanel } from './views/workspace-panel.ts';
import { LifecycleTreeProvider } from './views/lifecycle.ts';
import { JourneyPanel, type JourneyMessage } from './views/journey.ts';
import { ReconciliationPanel } from './views/reconciliation.ts';
import { ApprovalsPanel, type ApprovalsMessage } from './views/approvals.ts';
import { StoriesPanel, type StoriesMessage } from './views/stories.ts';
import { ImpactPanel } from './views/impact.ts';
import { CapabilitiesPanel, type CapabilitiesMessage } from './views/capabilities.ts';
import { IntakePanel } from './views/intake-panel.ts';
import { DashboardPanel } from './views/dashboard.ts';
import { DesignerPanel, type DesignerMessage } from './views/designer.ts';
import { WorkspacesPanel, type WorkspacesMessage } from './views/workspaces-panel.ts';
import { BootstrapPanel, type Mapped } from './views/bootstrap-panel.ts';
import type { WorkspaceEntry } from './views/workspaces-model.ts';
import { capabilityArgv } from './views/capability-model.ts';
import { buildConfigurationTree, unavailableTree, type TreeNode } from './views/tree-model.ts';
import { NodeTreeProvider } from './views/navigation.ts';
import {
  buildCapabilityTree, buildWorkspaceScopeTree, capabilityIdOf, workspacePathOf,
  type CapabilityReadiness
} from './views/navigation-trees.ts';
import type { DesktopSnapshot } from './cli/snapshot.ts';

/** Injected by esbuild: the commit and time this bundle was built from. */
declare const __SFLOW_BUILD__: string;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Singularity Flow');
  context.subscriptions.push(output);
  // First line in the channel, so "which build is actually loaded" is one look rather than a guess.
  // The version does not change between development reinstalls, so it cannot answer this.
  output.appendLine(`Singularity Flow — build ${typeof __SFLOW_BUILD__ === 'string' ? __SFLOW_BUILD__ : 'unstamped'}`);

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
    'singularityFlow.openApprovals', 'singularityFlow.startWork', 'singularityFlow.addSource',
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
  const workspaceTree = new NodeTreeProvider();
  let workspaceEntries: WorkspaceEntry[] = [];
  let workspaceCapabilities: TreeNode[] = [];
  const drawWorkspaceScope = (): void =>
    workspaceTree.replace(buildWorkspaceScopeTree(workspaceEntries, workspaceCapabilities));
  context.subscriptions.push(workspaceTree);
  context.subscriptions.push(
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
        'Map a capability', 'Find a workspace'
      ).then((chosen) => {
        if (chosen === 'Map a capability') return vscode.commands.executeCommand('singularityFlow.mapCapability');
        if (chosen === 'Find a workspace') return vscode.commands.executeCommand('singularityFlow.openWorkspaces');
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
    workspaceCapabilities = [];
    drawWorkspaceScope();
    const provider = new LifecycleTreeProvider(null,
      unavailableTree(label, detail, contextValue, leadRepository));
    const configuration = new LifecycleTreeProvider(null, [{
      kind: 'action', id: 'configuration:unavailable', label: 'Choose a workspace to load configuration',
      description: 'select a saved workspace', tooltip: detail, icon: 'root-folder',
      runCommand: 'singularityFlow.openWorkspaces'
    }]);
    context.subscriptions.push(provider, configuration);
    context.subscriptions.push(vscode.window.createTreeView('singularityFlow.lifecycle', {
      treeDataProvider: provider
    }), vscode.window.createTreeView('singularityFlow.configuration', {
      treeDataProvider: configuration
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
      // The state branch is not created here. `workspace create` does it, in the repository the lead
      // capability ships from — one owner, so the editor and the CLI cannot disagree about where the
      // branch goes, and the editor's copy cannot silently skip a repository the CLI would govern.
      void vscode.window.showInformationMessage(`Workspace created. Now working in ${created.lead}.`);
      await selectWorkspace(created.directory, created.leadDirectory, created.lead);
    }, async () => {
      // The form's own way out of the empty case: with no organisation mapped there is nothing to
      // choose from, and mapping one is the step that was missed rather than a different task.
      await vscode.commands.executeCommand('singularityFlow.mapCapability');
    });
  }));

  /**
   * Govern a repository that has never heard of Singularity Flow.
   *
   * Registered before any early return, and it has to be: this is the command that produces the
   * thing every other command needs, so requiring one would be the whole chicken-and-egg problem
   * written into the extension.
   */
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.mapCapability', async () => {
    let location;
    try {
      location = resolveCli({ extensionPath: context.extensionPath });
    } catch (error) {
      return void vscode.window.showErrorMessage((error as Error).message);
    }
    // Run from wherever the CLI is rooted: describing what an organisation builds is not work done
    // inside a checkout, and requiring one was the circular dependency this breaks.
    const registry = new SingularityFlowClient({
      location, repository: process.cwd(), onOutput: (text) => output.append(text)
    });
    const run = async (argv: string[]): Promise<{ result: unknown; error: string | null }> => {
      output.appendLine(`\n$ singularity-flow ${argv.join(' ')}`);
      try {
        return { result: await registry.run<unknown>(argv), error: null };
      } catch (error) {
        output.appendLine(`  failed: ${(error as Error).message}`);
        return { result: null, error: (error as Error).message };
      }
    };

    const leads = await registry
      .run<Array<{ url: string }>>(['capability', 'leads', '--json'])
      .catch(() => []);

    BootstrapPanel.show(context, leads.map((lead) => lead.url), run, async (mapped: Mapped) => {
      void vscode.window.showInformationMessage(
        `${mapped.capabilityId} is mapped${mapped.repositoryId ? ` to ${mapped.repositoryId}` : ''}. `
        + 'Create a workspace on it to work in it.', 'Create a workspace')
        .then((chosen) => (chosen
          ? vscode.commands.executeCommand('singularityFlow.createWorkspace')
          : undefined));
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
      if (message.type === 'switch') {
        await selectWorkspace(
          message.row.directory,
          message.row.leadRepositoryPath || message.row.directory,
          message.row.name
        );
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
      if (message.type !== 'switch') void refreshWorkspaceTree();
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
      workspaceEntries = entries;
      drawWorkspaceScope();
    } catch (error) {
      output.appendLine(`Could not read the workspace registry: ${(error as Error).message}`);
      workspaceEntries = [];
      drawWorkspaceScope();
    }
  };
  /**
   * Make one workspace current, for this window and for the machine.
   *
   * Selecting a workspace does not open anything. It used to reload the window, or open the lead
   * repository as a folder — which threw away every open editor and every scroll position to change
   * which repository some commands run in, and made "have a look at that other workspace" an act
   * with a cost. Choosing is now cheap and reversible: pick another one whenever you like.
   *
   * What actually changes is the repository the client spawns commands in, and everything read from
   * it. Opening the lead repository as a folder is still available, as its own action, because
   * editing the code in it is a different intention from working in it.
   */
  const workspaceSelected: Array<(lead: string, name: string) => void | Promise<void>> = [];

  async function selectWorkspace(target: string, leadPath: string, name: string): Promise<void> {
    try {
      const chooser = new SingularityFlowClient({
        location: resolveCli({ extensionPath: context.extensionPath }),
        repository: process.cwd(),
        onOutput: (text) => output.append(text)
      });
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Working in ${name}` },
        // Recorded machine-wide by the CLI, so the terminal and the editor agree about where you are.
        () => chooser.run(['workspace', 'use', target, '--json'])
      );
      await refreshWorkspaceTree();
      // When activation began without a selected workspace, Lifecycle and Configuration were
      // registered with their honest empty-state providers and the repository services below were
      // never created. Reload this same window once so extension activation can bind those views to
      // the newly selected lead repository. This is not "Open workspace" and never creates another
      // VS Code window.
      if (!workspaceSelected.length) {
        void vscode.window.showInformationMessage(
          `${name} selected. Loading its Lifecycle and Configuration in this window.`);
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
        return;
      }
      for (const follow of workspaceSelected) await follow(leadPath, name);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not switch workspace: ${(error as Error).message}`);
    }
  }

  const nodeWorkspace = (node?: TreeNode): { path: string; lead: string; name: string } | null => {
    const workspacePath = workspacePathOf(node) ?? node?.path;
    if (typeof workspacePath !== 'string' || !workspacePath) return null;
    return {
      path: workspacePath,
      lead: node?.openPath ?? workspacePath,
      name: node?.label ?? workspacePath
    };
  };

  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.switchWorkspace',
    async (node?: TreeNode) => {
      const chosen = nodeWorkspace(node);
      if (chosen) await selectWorkspace(chosen.path, chosen.lead, chosen.name);
    }));
  /**
   * Open a workspace's lead repository as this window's folder.
   *
   * Separate from selecting it, and deliberately so: this one costs you the window. It is for going
   * to edit the code, not for choosing what the governed screens act on.
   */
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.openWorkspace',
    async (node?: TreeNode) => {
      const chosen = nodeWorkspace(node);
      if (!chosen) return;
      const open = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (open && path.resolve(open) === path.resolve(chosen.lead)) {
        return void vscode.window.showInformationMessage(`${chosen.name} is already open in this window.`);
      }
      // The built-in command takes a boolean as its second argument. Passing an object made that
      // object truthy on versions implementing the documented signature, which opened an unwanted
      // second window. `false` means replace this window everywhere.
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(chosen.lead), false);
    }));

  void refreshWorkspaceTree();

  /** Diagnostics, as the CLI reports them. */
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.doctor', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return void vscode.window.showWarningMessage('Open a repository first.');
    try {
      const client = new SingularityFlowClient({
        location: resolveCli({ extensionPath: context.extensionPath }),
        repository: folder.uri.fsPath,
        onOutput: (text) => output.append(text)
      });
      const [repositoryReport, capabilityReport] = await Promise.all([
        client.runText(['doctor']),
        client.runText(['capabilities', 'doctor']).catch((error) => `Capability diagnostics unavailable: ${(error as Error).message}`)
      ]);
      const report = `${repositoryReport.trim()}\n\nCAPABILITY AND STATE DIAGNOSTICS\n${capabilityReport.trim()}\n`;
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

  const resolved = await resolveGovernedRepository(context, output);
  if ('reason' in resolved) {
    return unavailable(resolved.label, resolved.reason, resolved.contextValue, resolved.lead);
  }
  // `repository` is rebound when a different workspace is chosen. Every closure below captures the
  // binding rather than the value, so they all follow — which is the point: choosing a workspace
  // used to require a window reload precisely because this was a constant.
  let { repository } = resolved;
  const { origin } = resolved;
  // Which repository this window is acting on, and why that one. Every screen below operates on it,
  // and when it was not the open folder that has to be visible rather than inferred.
  output.appendLine(`Governed repository: ${repository} (${origin})`);
  // Named in the status bar too: which workspace you are in is the one piece of context every
  // screen shares, and inferring it from a folder path in a title bar is not the same as being told.
  // Not a constant: choosing a different workspace changes it, and the status bar is where a person
  // checks which one they are in.
  let workspaceLabel = origin.startsWith('the lead repository of your active workspace, ')
    ? origin.slice('the lead repository of your active workspace, '.length)
    : null;

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
  //
  // Readiness — does the orphan state branch exist, is there a world model — is not in the map and
  // not in the snapshot. It is one `ls-remote` per repository against remotes that may be slow or
  // unreachable, so it is asked once beside the render rather than inside it: the tree appears at
  // snapshot speed saying "not checked", and fills in when the answer arrives. A tree that waits on
  // the network to show what a repository is called is a tree that is blank when the VPN is off.
  let readiness: CapabilityReadiness = {};
  const drawCapabilities = (state: { snapshot: DesktopSnapshot | null; error?: Error | null }): void => {
    workspaceCapabilities = buildCapabilityTree(state.snapshot, state.error?.message ?? null, readiness);
    drawWorkspaceScope();
  };

  const refreshReadiness = async (): Promise<void> => {
    try {
      const leads = await client.run<{ url?: string }[]>(['capability', 'leads', '--json']);
      const url = leads.find((lead) => lead.url)?.url;
      if (!url) return;
      const organisation = await client.run<{ readiness?: CapabilityReadiness }>(
        ['capability', 'organisation', url, '--readiness', '--json']);
      if (!organisation.readiness) return;
      readiness = organisation.readiness;
      drawCapabilities(store.current);
    } catch (error) {
      // Every repository being unreachable is a normal state on a laptop, and it is not a reason to
      // interrupt: the tree already says "not checked", which is exactly what is true.
      output.appendLine(`Capability readiness could not be read: ${(error as Error).message}`);
    }
  };

  context.subscriptions.push(store.onDidChange(drawCapabilities));
  drawCapabilities(store.current);
  void refreshReadiness();

  // Governed configuration is edited in ordinary tabs; saving one asks the engine whether the result
  // is still valid, so a broken workflow.yml is reported where it was typed rather than by a command
  // failing later for a reason that looks unrelated.
  context.subscriptions.push(new ConfigurationValidator(client));

  const tree = new LifecycleTreeProvider(store);
  const configurationTree = new LifecycleTreeProvider(store, [], buildConfigurationTree);
  context.subscriptions.push(tree, configurationTree);
  context.subscriptions.push(vscode.window.createTreeView('singularityFlow.lifecycle', {
    treeDataProvider: tree,
    showCollapseAll: true
  }), vscode.window.createTreeView('singularityFlow.configuration', {
    treeDataProvider: configurationTree,
    showCollapseAll: true
  }));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'singularityFlow.refresh';
  context.subscriptions.push(status);
  context.subscriptions.push(store.onDidChange((state) => {
    if (state.loading) { status.text = '$(loading~spin) Singularity Flow'; status.show(); return; }
    if (state.error) { status.text = '$(error) Singularity Flow'; status.tooltip = state.error.message; status.show(); return; }
    const initiative = state.snapshot?.initiative;
    const where = workspaceLabel ? `${workspaceLabel} · ` : '';
    if (!initiative) {
      status.text = `$(rocket) ${where}No work`;
      status.tooltip = workspaceLabel
        ? `Working in ${workspaceLabel}. Nothing governed is checked out on this branch.`
        : 'Nothing governed is checked out on this branch.';
      status.show();
      return;
    }
    const phase = initiative.state.currentPhase ?? 'complete';
    status.text = `$(rocket) ${initiative.state.initiative.id} · ${phase}`;
    status.tooltip = initiative.nextActions?.[0]?.reason ?? 'Singularity Flow';
    status.show();
  }));

  /**
   * Follow the chosen workspace, in place.
   *
   * Everything that knows which repository this window acts on is re-pointed here, in one list, so
   * that adding a screen which reads the repository means adding it to this list and not
   * discovering months later that it kept answering about the previous workspace.
   *
   * A workspace whose lead has never been cloned is a real state — the registry is machine-wide and
   * a colleague's workspace can name a directory this machine does not have — so it is reported
   * rather than switched to, and the previous workspace stays selected in the editor.
   */
  workspaceSelected.push(async (lead, name) => {
    const target = path.resolve(lead);
    if (path.resolve(repository) === target) return;
    try {
      await validateRepositoryDirectory(target);
    } catch (error) {
      void vscode.window.showWarningMessage(
        `${name} is recorded as your workspace, but this window is still acting on ${path.basename(repository)}: ${(error as Error).message}`);
      return;
    }
    repository = target;
    client.useRepository(target);
    workspaceLabel = name;
    readiness = {};
    await store.refresh();
    void refreshReadiness();
    output.appendLine(`Governed repository: ${repository} (the lead repository of your active workspace, ${name})`);
  });

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
   * Start work: an Initiative, an Epic or a Story, with or without a tracker.
   *
   * Every answer is asked for; none is guessed. The profile and the governed agent come from the
   * repository's own configuration rather than a list this file keeps, so a portfolio that adds a
   * profile offers it here without the extension being changed.
   */
  const startWork = async (): Promise<void> => {
    // Checked before anything is asked. The engine refuses to start governed work when no approval
    // authority has a member, and discovering that after a filled-in form — with a message naming a
    // YAML key — is a poor greeting for someone who has just initialized a repository.
    const authorities = store.current.snapshot?.portfolio?.approvalAuthorities ?? {};
    const named = Object.entries(authorities).filter(([, authority]) => (authority?.members ?? []).length);
    if (Object.keys(authorities).length && !named.length) {
      const open = await vscode.window.showWarningMessage(
        'No approval authority has a member yet, so governed work cannot be started.',
        { modal: true, detail: 'Add at least one person under approvalAuthorities in singularity/portfolio.yml. Every governed approval is checked against that list.' },
        'Open portfolio.yml');
      if (open === 'Open portfolio.yml') {
        const target = vscode.Uri.file(path.join(repository, store.current.snapshot?.portfolioPath ?? 'singularity/portfolio.yml'));
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
      }
      return;
    }

    // One screen for six paths. An Initiative, an Epic or a Story, each with or without a tracker,
    // used to be six commands you had to already know the names of — which meant the product's front
    // door was documentation rather than a screen.
    IntakePanel.show(context, client, output, async (started) => {
      await store.refresh();
      const open = await vscode.window.showInformationMessage(
        `Started ${started.shape} ${started.id}.`, 'Open the journey', 'Show status');
      if (open === 'Open the journey') await vscode.commands.executeCommand('singularityFlow.openJourney');
      else if (open === 'Show status') await vscode.commands.executeCommand('singularityFlow.openDashboard');
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
    'singularityFlow.startWork': startWork,
    'singularityFlow.addSource': addSource,
    // Refresh asks the remotes again too: the state branch somebody just created is the whole reason
    // they would press it.
    'singularityFlow.refresh': async () => { void refreshReadiness(); await store.refresh(); },
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
      // Authoring a lifecycle runs the same command the CLI runs, so the validation that refuses an
      // incoherent profile is one implementation rather than two that drift.
      if (message.type === 'run') {
        const ran = await runGovernedAction(client, { command: message.command, title: message.title }, output);
        if (!ran) return 'The lifecycle was not changed. The output channel has the engine\'s reason.';
        await store.refresh();
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
/** Where the governed repository came from, said in the words a reader would use. */
type Resolved =
  | { repository: string; origin: string }
  | { label: string; reason: string; contextValue?: string; lead?: string | null };

/**
 * Which repository this window governs.
 *
 * The map and the governed state live in a repository, but nobody works by opening that repository
 * as their editor folder — they work in a workspace, and the workspace already knows where its lead
 * is. Requiring the folder to be the repository made every screen in the product unreachable from
 * the place people actually start, and answered with "open the repository that contains
 * singularity/workflow.yml", which is a demand rather than an explanation.
 *
 * So three sources, most specific first: the open folder when it is one; the open folder's lead when
 * it is a workspace directory; and otherwise the active workspace's lead. The last is what makes the
 * product usable from a window with something else entirely open.
 */
async function resolveGovernedRepository(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<Resolved> {
  // The active workspace leads. Choosing one is an explicit act — it says which capabilities are
  // being worked on and where — and everything else in the product is scoped by it, so it cannot be
  // a fallback for whatever folder happens to be open. The open folder answers only when no
  // workspace has been chosen.
  const active = await activeWorkspaceLead(context, output);
  if (active) return active;

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    try {
      return { repository: await validateRepositoryDirectory(folder.uri.fsPath), origin: 'the open folder' };
    } catch (error) {
      // A workspace directory holds repos/, documents/ and workspace.json — it is not itself a
      // repository, but opening it is the obvious thing to do from a file manager, and it knows
      // exactly where the repository someone wanted is. Now it is used rather than described.
      const lead = await workspaceLeadDirectory(folder.uri.fsPath);
      if (lead) {
        try {
          return {
            repository: await validateRepositoryDirectory(lead),
            origin: 'the lead repository of the workspace directory you have open'
          };
        } catch { /* falls through to the explanation below */ }
      }
      return {
        label: 'Not a Singularity Flow repository',
        reason: (error as Error).message,
        contextValue: 'sflow.uninitialized'
      };
    }
  }

  return {
    label: 'No workspace is active',
    reason: 'Choose a workspace to work in, or create one. Everything else is scoped to it.'
  };
}

/**
 * The lead repository of the active workspace, when there is one.
 *
 * Best effort: no active workspace, a registry that cannot be read, or a lead that is not a governed
 * repository all return null and let the caller explain itself.
 */
async function activeWorkspaceLead(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<{ repository: string; origin: string } | null> {
  try {
    const client = new SingularityFlowClient({
      location: resolveCli({ extensionPath: context.extensionPath }),
      repository: process.cwd(),
      onOutput: () => {}
    });
    // The shape `workspace current --json` actually emits: flat, and it already names the lead
    // repository. This read `current.workspace.path` — a nested field the CLI has never produced —
    // so it resolved to undefined every time and the active workspace was silently never consulted.
    // Whichever folder happened to be open won, always, including when somebody had just chosen a
    // workspace. The test that covered this asserted the order of two lines in this file rather
    // than what the function returns, so it passed throughout.
    const current = await client.run<{
      active?: boolean; workspaceName?: string; workspacePath?: string; repositoryPath?: string;
    }>(['workspace', 'current', '--json']);
    if (current.active === false) return null;
    const directory = current.workspacePath;
    if (!directory) return null;
    // The recorded lead if there is one, and the workspace's own lead as the fallback for a registry
    // entry written before the field existed.
    const lead = current.repositoryPath ?? await workspaceLeadDirectory(directory);
    if (!lead) return null;
    return {
      repository: await validateRepositoryDirectory(lead),
      origin: `the lead repository of your active workspace, ${current.workspaceName ?? directory}`
    };
  } catch (error) {
    output.appendLine(`No active workspace to fall back to: ${(error as Error).message}`);
    return null;
  }
}

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
