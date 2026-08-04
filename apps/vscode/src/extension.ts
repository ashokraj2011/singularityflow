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
import { InboxPanel, type InboxMessage } from './views/inbox.ts';
import { buildInboxTree } from './views/inbox-model.ts';
import { StoriesPanel, type StoriesMessage } from './views/stories.ts';
import { ImpactPanel } from './views/impact.ts';
import { CapabilitiesPanel, type CapabilitiesMessage } from './views/capabilities.ts';
import { IntakePanel } from './views/intake-panel.ts';
import { DashboardPanel } from './views/dashboard.ts';
import { DesignerPanel, type DesignerMessage } from './views/designer.ts';
import { InstructionDesignerPanel } from './views/instruction-designer.ts';
import { HelpPanel } from './views/help.ts';
import type { HelpDocument } from './views/help-page.ts';
import { WorkspacesPanel, type WorkspacesMessage } from './views/workspaces-panel.ts';
import { BootstrapPanel, type Mapped } from './views/bootstrap-panel.ts';
import type { WorkspaceEntry, WorkspaceStatus } from './views/workspaces-model.ts';
import { capabilityChoices, type RemoteCapability } from './views/workspace-form.ts';
import { capabilityArgv } from './views/capability-model.ts';
import { buildConfigurationTree, unavailableTree, type TreeNode } from './views/tree-model.ts';
import { NodeTreeProvider } from './views/navigation.ts';
import {
  buildWorkspaceTree, capabilityIdOf, workspacePathOf, type CapabilityReadiness
} from './views/navigation-trees.ts';
import { SecureCredentials } from './credentials.ts';

/** Injected by esbuild: the commit and time this bundle was built from. */
declare const __SFLOW_BUILD__: string;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Singularity Flow');
  context.subscriptions.push(output);
  // First line in the channel, so "which build is actually loaded" is one look rather than a guess.
  // The version does not change between development reinstalls, so it cannot answer this.
  output.appendLine(`Singularity Flow — build ${typeof __SFLOW_BUILD__ === 'string' ? __SFLOW_BUILD__ : 'unstamped'}`);
  const secureCredentials = new SecureCredentials(context.secrets);
  let cliEnvironment = await secureCredentials.environment();

  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.configureProfile', async () => {
    const settings = vscode.workspace.getConfiguration('singularityFlow');
    const name = await vscode.window.showInputBox({
      title: 'Your Singularity Flow profile', prompt: 'Display name',
      value: settings.get<string>('userName') ?? '', ignoreFocusOut: true
    });
    if (name == null) return;
    const role = await vscode.window.showQuickPick([
      'product-owner', 'business-analyst', 'product-designer', 'architect', 'developer',
      'qa', 'security', 'delivery-manager', 'operations', 'other'
    ], { title: 'Choose your role', placeHolder: 'Role filters guidance; governed agents still come from the phase.' });
    if (!role) return;
    await Promise.all([
      settings.update('userName', name.trim(), vscode.ConfigurationTarget.Global),
      settings.update('role', role, vscode.ConfigurationTarget.Global),
      context.globalState.update('onboardingComplete', true)
    ]);
    void vscode.window.showInformationMessage(`Singularity Flow profile saved for ${name.trim() || role}.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.connectJira', async () => {
    const deployment = await vscode.window.showQuickPick([
      { label: 'Jira Cloud', value: 'cloud' as const },
      { label: 'Jira Data Center', value: 'data-center' as const }
    ], { title: 'Jira deployment' });
    if (!deployment) return;
    const baseUrl = await vscode.window.showInputBox({
      title: 'Jira URL', prompt: 'https://company.atlassian.net', ignoreFocusOut: true,
      validateInput: (value) => { try { return new URL(value).protocol === 'https:' ? null : 'Use HTTPS.'; } catch { return 'Enter a valid HTTPS URL.'; } }
    });
    if (!baseUrl) return;
    const username = await vscode.window.showInputBox({
      title: deployment.value === 'cloud' ? 'Jira email or username' : 'Jira username (optional for PAT)',
      ignoreFocusOut: true
    });
    if (username == null) return;
    const token = await vscode.window.showInputBox({
      title: deployment.value === 'cloud' ? 'Jira API token / PAT' : 'Jira personal access token',
      password: true, ignoreFocusOut: true, validateInput: (value) => value.trim() ? null : 'A token is required.'
    });
    if (!token) return;
    const candidate = {
      ...process.env, JIRA_BASE_URL: baseUrl, JIRA_DEPLOYMENT: deployment.value,
      JIRA_USERNAME: username, JIRA_PAT: token, JIRA_CONNECTION_NAME: 'vscode'
    };
    try {
      const location = resolveCli({ extensionPath: context.extensionPath });
      const repository = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      await new SingularityFlowClient({ location, repository, environment: candidate }).run(['jira', 'status', '--json']);
      await secureCredentials.saveJira({ deployment: deployment.value, baseUrl, username, connectionName: 'vscode' }, token);
      cliEnvironment = await secureCredentials.environment();
      void vscode.window.showInformationMessage('Jira connected securely. Reload this window to apply it to every view.', 'Reload')
        .then((choice) => choice === 'Reload' ? vscode.commands.executeCommand('workbench.action.reloadWindow') : undefined);
    } catch (error) {
      void vscode.window.showErrorMessage(`Jira was not saved: ${(error as Error).message}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.resetJira', async () => {
    const choice = await vscode.window.showWarningMessage(
      'Remove the saved Jira connection from the operating-system keychain?', { modal: true }, 'Reset Jira');
    if (choice !== 'Reset Jira') return;
    await secureCredentials.resetJira();
    cliEnvironment = await secureCredentials.environment();
    void vscode.window.showInformationMessage('Saved Jira credentials removed.');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.configureTeams', async () => {
    const webhook = await vscode.window.showInputBox({
      title: 'Microsoft Teams incoming webhook',
      prompt: 'Stored in the operating-system keychain; never written to Git.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => {
        try {
          const url = new URL(value);
          return url.protocol === 'https:' && !url.username && !url.password ? null : 'Use an HTTPS webhook URL without embedded credentials.';
        } catch { return 'Enter a valid HTTPS URL.'; }
      }
    });
    if (!webhook) return;
    await secureCredentials.saveTeamsWebhook(webhook);
    cliEnvironment = await secureCredentials.environment();
    void vscode.window.showInformationMessage('Teams notifications configured. Reload this window to apply the secret to every command.', 'Reload')
      .then((choice) => choice === 'Reload' ? vscode.commands.executeCommand('workbench.action.reloadWindow') : undefined);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.resetTeams', async () => {
    const choice = await vscode.window.showWarningMessage(
      'Remove the saved Teams webhook from the operating-system keychain?', { modal: true }, 'Reset Teams');
    if (choice !== 'Reset Teams') return;
    await secureCredentials.resetTeamsWebhook();
    cliEnvironment = await secureCredentials.environment();
    void vscode.window.showInformationMessage('Saved Teams webhook removed.');
  }));

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
    'singularityFlow.openApprovals', 'singularityFlow.openInbox', 'singularityFlow.startWork', 'singularityFlow.addSource',
    'singularityFlow.refresh', 'singularityFlow.openArtifact', 'singularityFlow.runAction',
    'singularityFlow.prepareStoryPhase', 'singularityFlow.publishStoryPhase',
    'singularityFlow.submitStoryPhase',
    'singularityFlow.approve', 'singularityFlow.openJourney', 'singularityFlow.openReconciliation',
    'singularityFlow.showImpact', 'singularityFlow.addCapability', 'singularityFlow.editCapability',
    'singularityFlow.openDashboard', 'singularityFlow.openDesigner',
    'singularityFlow.openInstructionDesigner', 'singularityFlow.openCopilot'
  ];
  /** Workspaces are machine-wide and remain available whatever folder is open. */
  const workspaceTree = new NodeTreeProvider();
  let workspaceEntries: WorkspaceEntry[] = [];
  const drawWorkspaces = (): void => workspaceTree.replace(buildWorkspaceTree(workspaceEntries));
  context.subscriptions.push(workspaceTree);
  context.subscriptions.push(
    vscode.window.createTreeView('singularityFlow.workspaces', { treeDataProvider: workspaceTree })
  );

  /**
   * Product help is available before a repository or workspace is selected.
   *
   * The CLI packages the canonical manual, so the editor asks the selected/bundled CLI for it
   * instead of carrying a second documentation copy that can drift. The small tree is navigation;
   * the panel is the complete, searchable manual and command reference.
   */
  const helpTree = new NodeTreeProvider([
    {
      kind: 'group', id: 'help:start', label: 'Learn Singularity Flow', icon: 'book', children: [
        { kind: 'action', id: 'help:quick-start', label: 'Quick start', description: 'first governed work', icon: 'rocket', runCommand: 'singularityFlow.openHelp' },
        { kind: 'action', id: 'help:workspaces-and-capabilities', label: 'Workspaces & capabilities', description: 'scope and ownership', icon: 'type-hierarchy', runCommand: 'singularityFlow.openHelp' },
        { kind: 'action', id: 'help:story-intake', label: 'Story intake', description: 'Jira or manual', icon: 'book', runCommand: 'singularityFlow.openHelp' },
        { kind: 'action', id: 'help:how-the-workflow-works', label: 'Lifecycle & approvals', description: 'state and phases', icon: 'git-branch', runCommand: 'singularityFlow.openHelp' },
        { kind: 'action', id: 'help:governed-agents-and-approval-authority', label: 'Agents, prompts & world model', description: 'prompt composition', icon: 'hubot', runCommand: 'singularityFlow.openHelp' }
      ]
    },
    {
      kind: 'group', id: 'help:reference', label: 'Reference', icon: 'references', children: [
        { kind: 'action', id: 'help:copilot-commands', label: 'Copilot /sf-* commands', description: 'skills', icon: 'sparkle', runCommand: 'singularityFlow.openHelp' },
        { kind: 'action', id: 'help:cli-command-reference', label: 'CLI command reference', description: 'all commands', icon: 'terminal', runCommand: 'singularityFlow.openHelp' },
        { kind: 'action', id: 'help:configuring-workflows', label: 'Configuration reference', description: 'workflow and artifacts', icon: 'settings-gear', runCommand: 'singularityFlow.openHelp' },
        { kind: 'action', id: 'help:troubleshooting', label: 'Troubleshooting', description: 'doctor and recovery', icon: 'tools', runCommand: 'singularityFlow.openHelp' }
      ]
    },
    { kind: 'action', id: 'help:all', label: 'Open searchable Help Center', description: 'complete offline manual', icon: 'search', runCommand: 'singularityFlow.openHelp' }
  ]);
  context.subscriptions.push(helpTree, vscode.window.createTreeView('singularityFlow.help', { treeDataProvider: helpTree }));
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.openHelp', async (node?: TreeNode) => {
    try {
      const location = resolveCli({ extensionPath: context.extensionPath });
      const manual = await new SingularityFlowClient({
        location, repository: process.cwd(), onOutput: (text) => output.append(text)
      }).run<HelpDocument>(['help', '--json']);
      const topic = node?.id.startsWith('help:') && !['help:start', 'help:reference', 'help:all'].includes(node.id)
        ? node.id.slice('help:'.length) : null;
      HelpPanel.show(context, manual, topic, path.resolve(path.dirname(location.cli), '..'));
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not open Singularity Flow Help: ${(error as Error).message}`);
    }
  }));

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
    drawWorkspaces();
    const repositoryUnavailable = contextValue === 'sflow.workspace.repositoryUnavailable';
    const recoveryCommand = repositoryUnavailable
      ? 'singularityFlow.repairWorkspace' : 'singularityFlow.openWorkspaces';
    const recoveryDescription = repositoryUnavailable
      ? 'repair selected workspace' : 'select a saved workspace';
    const provider = new LifecycleTreeProvider(null,
      unavailableTree(label, detail, contextValue, leadRepository));
    const inbox = new LifecycleTreeProvider(null, [{
      kind: 'action', id: 'inbox:unavailable',
      label: repositoryUnavailable ? label : 'Choose a workspace to load the inbox',
      description: recoveryDescription, tooltip: detail,
      icon: repositoryUnavailable ? 'warning' : 'root-folder', runCommand: recoveryCommand
    }]);
    const configuration = new LifecycleTreeProvider(null, [{
      kind: 'action', id: 'configuration:unavailable',
      label: repositoryUnavailable ? label : 'Choose a workspace to load configuration',
      description: recoveryDescription, tooltip: detail,
      icon: repositoryUnavailable ? 'warning' : 'root-folder', runCommand: recoveryCommand
    }]);
    context.subscriptions.push(provider, inbox, configuration);
    context.subscriptions.push(vscode.window.createTreeView('singularityFlow.lifecycle', {
      treeDataProvider: provider
    }), vscode.window.createTreeView('singularityFlow.inbox', {
      treeDataProvider: inbox
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
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.openWorkspaces', async (node?: TreeNode) => {
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
    const details = async (workspacePath: string): Promise<WorkspaceStatus> => {
      const status = await registry.run<WorkspaceStatus>(['workspace', 'open', workspacePath, '--json']);
      const lead = status.repositories.find((repository) =>
        repository.id === status.workspace.leadRepository || repository.role === 'lead');
      if (!lead?.url) return status;
      try {
        const organisation = await registry.run<{
          capabilities?: RemoteCapability[] | null;
          repositories?: Record<string, { url?: string; defaultBranch?: string }>;
        }>(['capability', 'organisation', lead.url, '--json']);
        return {
          ...status,
          availableCapabilities: capabilityChoices(
            organisation.capabilities ?? [], organisation.repositories ?? {}
          ).map(({ id, name, depth, ancestors, repository }) => ({
            id, name, depth, ancestors, repository
          }))
        };
      } catch (error) {
        // Workspace health is still useful when the remote map is temporarily unreachable. The
        // edit screen names the limitation without hiding everything else it already read.
        return {
          ...status,
          warnings: [
            ...(status.warnings ?? []),
            { code: 'capability-map-unavailable', message: `Capabilities could not be refreshed: ${(error as Error).message}` }
          ]
        };
      }
    };

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
    }, details, workspacePathOf(node) ?? node?.path ?? null);
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
      drawWorkspaces();
    } catch (error) {
      output.appendLine(`Could not read the workspace registry: ${(error as Error).message}`);
      workspaceEntries = [];
      drawWorkspaces();
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

  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.repairWorkspace', async () => {
    try {
      const client = new SingularityFlowClient({
        location: resolveCli({ extensionPath: context.extensionPath }),
        repository: process.cwd(), onOutput: (text) => output.append(text)
      });
      const current = await client.run<{
        active?: boolean; workspacePath?: string; workspaceName?: string;
      }>(['workspace', 'current', '--json']);
      if (!current.active || !current.workspacePath) {
        return void vscode.window.showWarningMessage('Select a workspace before repairing it.');
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Repairing ${current.workspaceName ?? 'workspace'}` },
        () => client.run(['workspace', 'repair', current.workspacePath as string, '--json'])
      );
      // Refresh the persisted context so the next activation sees the repaired repository as ready.
      await client.run(['workspace', 'use', current.workspacePath, '--json']);
      void vscode.window.showInformationMessage(
        `${current.workspaceName ?? 'Workspace'} repaired. Reloading Lifecycle, Inbox, and Configuration.`);
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not repair workspace: ${(error as Error).message}`);
    }
  }));

  // The workspace list is part of the activation read model, not a background decoration. Await it
  // so a selected-but-unmaterialized workspace cannot briefly render as "No workspaces yet" (and
  // so commands/context menus are derived from the same registry revision as Lifecycle).
  await refreshWorkspaceTree();

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
      environment: cliEnvironment,
      onOutput: (text) => output.append(text)
    });
  } catch (error) {
    void vscode.window.showErrorMessage((error as Error).message);
    return unavailable('No Singularity Flow CLI was found', (error as Error).message);
  }
  output.appendLine(`Using CLI (${client.location.source}): ${client.location.cli}`);
  // Packaged agents and skills belong to the exact engine this window is driving. Resolve them
  // beside that CLI, not beside the repository and not beside some other globally installed copy.
  const cliPackageRoot = path.resolve(path.dirname(client.location.cli), '..');

  const store = new WorkspaceStore(client);
  context.subscriptions.push(store);
  // Lifecycle commits are routinely created by Copilot CLI or a terminal while
  // the editor is open. Watch the governed tree and debounce one coherent
  // snapshot refresh so every view follows those external mutations together.
  let repositoryWatcher: vscode.FileSystemWatcher | null = null;
  let repositoryRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRepositoryRefresh = (): void => {
    if (repositoryRefreshTimer) clearTimeout(repositoryRefreshTimer);
    repositoryRefreshTimer = setTimeout(() => {
      repositoryRefreshTimer = null;
      void store.refresh();
    }, 200);
  };
  const watchGovernedRepository = (target: string): void => {
    repositoryWatcher?.dispose();
    repositoryWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(target), 'singularity/**/*')
    );
    context.subscriptions.push(
      repositoryWatcher.onDidCreate(scheduleRepositoryRefresh),
      repositoryWatcher.onDidChange(scheduleRepositoryRefresh),
      repositoryWatcher.onDidDelete(scheduleRepositoryRefresh)
    );
  };
  watchGovernedRepository(repository);
  context.subscriptions.push({
    dispose: () => {
      repositoryWatcher?.dispose();
      if (repositoryRefreshTimer) clearTimeout(repositoryRefreshTimer);
    }
  });
  // Capability readiness is remote-derived status (state branch and world-model availability), not
  // configuration. Read it after the local snapshot so Configuration renders immediately and then
  // gains the remote status without delaying activation when VPN access is unavailable.
  let readiness: CapabilityReadiness = {};
  let configurationTree: LifecycleTreeProvider | null = null;
  const refreshReadiness = async (): Promise<void> => {
    try {
      const leads = await client.run<{ url?: string }[]>(['capability', 'leads', '--json']);
      const url = leads.find((lead) => lead.url)?.url;
      if (!url) return;
      const organisation = await client.run<{ readiness?: CapabilityReadiness }>(
        ['capability', 'organisation', url, '--readiness', '--json']);
      if (!organisation.readiness) return;
      readiness = organisation.readiness;
      configurationTree?.refresh();
    } catch (error) {
      output.appendLine(`Capability readiness could not be read: ${(error as Error).message}`);
    }
  };
  // Governed configuration is edited in ordinary tabs; saving one asks the engine whether the result
  // is still valid, so a broken workflow.yml is reported where it was typed rather than by a command
  // failing later for a reason that looks unrelated.
  context.subscriptions.push(new ConfigurationValidator(client));

  const tree = new LifecycleTreeProvider(store);
  const inboxTree = new LifecycleTreeProvider(store, [], buildInboxTree);
  configurationTree = new LifecycleTreeProvider(
    store, [], (snapshot, error) => buildConfigurationTree(snapshot, error, readiness));
  context.subscriptions.push(tree, inboxTree, configurationTree);
  context.subscriptions.push(vscode.window.createTreeView('singularityFlow.lifecycle', {
    treeDataProvider: tree,
    showCollapseAll: true
  }), vscode.window.createTreeView('singularityFlow.inbox', {
    treeDataProvider: inboxTree,
    showCollapseAll: true
  }), vscode.window.createTreeView('singularityFlow.configuration', {
    treeDataProvider: configurationTree,
    showCollapseAll: true
  }));
  void refreshReadiness();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'singularityFlow.refresh';
  context.subscriptions.push(status);
  context.subscriptions.push(store.onDidChange((state) => {
    if (state.loading) { status.text = '$(loading~spin) Singularity Flow'; status.show(); return; }
    if (state.error) { status.text = '$(error) Singularity Flow'; status.tooltip = state.error.message; status.show(); return; }
    const initiative = state.snapshot?.initiative;
    const workflow = state.snapshot?.workflow;
    const where = workspaceLabel ? `${workspaceLabel} · ` : '';
    if (workflow) {
      const phase = workflow.currentPhase ?? 'complete';
      status.text = `$(git-pull-request) ${workflow.workItem.id} · ${phase}`;
      status.tooltip = `${where}${workflow.workItem.title ?? 'Governed Story workflow'}`;
      status.show();
      return;
    }
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
    watchGovernedRepository(target);
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

  /** Named Story commands work both from a phase row and directly from the command palette. */
  const runStoryPhase = async (
    action: 'prepare' | 'publish' | 'submit', node?: TreeNode
  ): Promise<void> => {
    if (node?.command) return runNode(node);
    const workflow = store.current.snapshot?.workflow;
    const phaseId = workflow?.currentPhase;
    if (!workflow || !phaseId) {
      void vscode.window.showWarningMessage('No governed Story phase is active in this workspace.');
      return;
    }
    const command = action === 'prepare'
      ? ['prepare', phaseId]
      : action === 'publish'
        ? ['phase', 'publish', phaseId]
        : ['submit', '--phase', phaseId];
    await runNode({
      kind: 'action', id: `story:${phaseId}:${action}`,
      label: `${action} ${phaseId}`, command
    });
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
          kind: 'initiative',
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
      const output = approval.source === 'initiative'
        ? initiative?.state.phases[approval.phase]?.outputs?.[approval.subject]
        : null;
      const artifactPath = output?.path ?? approval.artifactPath;
      if (artifactPath) {
        await openArtifact(repository, {
          kind: 'artifact', id: approval.id, label: approval.label, path: artifactPath
        });
      }
      return;
    }
    if (message.type === 'approve') {
      return runNode({
        kind: 'action', id: approval.id, label: approval.label,
        approve: approval.source === 'story'
          ? {
            kind: 'story', workId: approval.workId ?? '', phaseId: approval.phase,
            expected: approval.expected, summary: `Approve ${approval.label}`
          }
          : {
            kind: 'initiative', initiativeId: initiative?.state.initiative.id ?? '',
            subject: approval.subject, expected: approval.expected,
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
      command: approval.source === 'story'
        ? ['reject', approval.workId ?? '', '--fetch', '--phase', approval.phase, '--reason', reason.trim()]
        : ['initiative', 'reject', approval.subject, '--reason', reason.trim()]
    });
  };

  /** The inbox reuses the exact approval transaction and adds all-phase document navigation. */
  const onInboxMessage = async (message: InboxMessage): Promise<void> => {
    if (message.type === 'open-artifact') {
      return openArtifact(repository, {
        kind: 'artifact', id: message.artifact.id, label: message.artifact.label,
        path: message.artifact.path, readOnly: message.artifact.readOnly
      });
    }
    const mapped: ApprovalsMessage = message.type === 'open-approval'
      ? { type: 'open', approval: message.approval }
      : { type: message.type, approval: message.approval };
    return onApprovalsMessage(mapped);
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
    'singularityFlow.openInbox':
      () => InboxPanel.show(context, store, (message) => { void onInboxMessage(message); }),
    'singularityFlow.startWork': startWork,
    'singularityFlow.addSource': addSource,
    'singularityFlow.refresh': async () => { await store.refresh(); void refreshReadiness(); },
    'singularityFlow.openArtifact':
      ((node?: TreeNode) => openArtifact(repository, node, cliPackageRoot)) as never,
    'singularityFlow.runAction': runNode as never,
    'singularityFlow.prepareStoryPhase': ((node?: TreeNode) => runStoryPhase('prepare', node)) as never,
    'singularityFlow.publishStoryPhase': ((node?: TreeNode) => runStoryPhase('publish', node)) as never,
    'singularityFlow.submitStoryPhase': ((node?: TreeNode) => runStoryPhase('submit', node)) as never,
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
      output.appendLine(`\n$ singularity-flow configuration save ${message.path}`);
      try {
        await client.runText(['configuration', 'save', message.path], { input: message.content });
        await store.refresh();
        return null;
      } catch (error) {
        output.appendLine(`  refused: ${(error as Error).message}`);
        return (error as Error).message;
      }
    }),
    'singularityFlow.openInstructionDesigner': () => InstructionDesignerPanel.show(context, store, async (message) => {
      output.appendLine(`\n$ singularity-flow configuration save ${message.path}`);
      try {
        await client.runText(['configuration', 'save', message.path], { input: message.content });
        await store.refresh();
        return null;
      } catch (error) {
        output.appendLine(`  refused: ${(error as Error).message}`);
        return (error as Error).message;
      }
    }),
    'singularityFlow.openCopilot': async () => {
      try {
        const prompt = await client.runText(['wm', 'show-prompt']);
        await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt, isPartialQuery: false });
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not prepare governed Copilot context: ${(error as Error).message}`);
      }
    },
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
async function openArtifact(
  repository: string,
  node?: TreeNode,
  cliPackageRoot?: string
): Promise<void> {
  if (!node?.path) return;
  const base = node.packagePath ? cliPackageRoot : repository;
  if (!base) {
    void vscode.window.showErrorMessage(`Cannot locate the packaged resource: ${node.path}`);
    return;
  }
  const requested = node.packagePath ?? node.path;
  const absolute = path.resolve(base, requested);
  const relative = path.relative(base, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    const boundary = node.packagePath ? 'installed Singularity Flow engine' : 'repository';
    void vscode.window.showErrorMessage(`Refusing to open a path outside the ${boundary}: ${requested}`);
    return;
  }

  const uri = vscode.Uri.file(absolute);
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
    if (node.readOnly) {
      const message = node.packagePath
        ? '$(lock-small) This resource ships with Singularity Flow and is read-only. Copy it into the repository to customize it.'
        // An approved artifact is pinned by hash into approvals that already happened, so editing it
        // in place silently invalidates them. Said once, rather than enforced by fighting the editor.
        : '$(lock-small) This artifact is approved and hash-pinned. Editing it invalidates its approval.';
      void vscode.window.setStatusBarMessage(
        message, 6_000);
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
): Promise<Resolved | null> {
  let current: {
    active?: boolean; workspaceName?: string; workspacePath?: string; repositoryPath?: string;
    repositoryState?: string;
  };
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
    current = await client.run(['workspace', 'current', '--json']);
  } catch (error) {
    output.appendLine(`Could not read the active workspace: ${(error as Error).message}`);
    return null;
  }
  if (current.active === false) return null;
  const directory = current.workspacePath;
  if (!directory) {
    return {
      label: 'Active workspace selection is incomplete',
      reason: 'Select the workspace again so its working directory and lead repository can be resolved.'
    };
  }
  // The recorded lead if there is one, and the workspace's own lead as the fallback for a registry
  // entry written before the field existed.
  const lead = current.repositoryPath ?? await workspaceLeadDirectory(directory);
  if (!lead) {
    return {
      label: 'Workspace lead repository is not configured',
      reason: `${current.workspaceName ?? directory} is selected, but it has no resolvable lead repository. Edit the workspace details.`,
      contextValue: 'sflow.workspace.repositoryUnavailable'
    };
  }
  if (current.repositoryState && current.repositoryState !== 'ready') {
    return {
      label: `Workspace repository is ${current.repositoryState}`,
      reason: `${current.workspaceName ?? directory} is selected, but its lead repository at ${lead} is ${current.repositoryState}. Repair the selected workspace to materialize it from workspace.json.`,
      contextValue: 'sflow.workspace.repositoryUnavailable',
      lead
    };
  }
  try {
    return {
      repository: await validateRepositoryDirectory(lead),
      origin: `the lead repository of your active workspace, ${current.workspaceName ?? directory}`
    };
  } catch (error) {
    output.appendLine(`Active workspace lead is unavailable: ${(error as Error).message}`);
    return {
      label: 'Workspace lead repository is not ready',
      reason: `${current.workspaceName ?? directory} is selected, but ${lead} cannot load Singularity Flow: ${(error as Error).message}`,
      contextValue: 'sflow.workspace.repositoryUnavailable',
      lead
    };
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
