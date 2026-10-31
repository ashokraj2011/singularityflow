/**
 * The agent packages panel [APM A7, 2026-10-30]: the repository's `singularity-flow apm status
 * --json`, read once per refresh. Installing and updating change which agents run, so they are the
 * person's own step: the panel types the command into a terminal and the person presses Enter.
 * Attach (`apm attach`, Studio's `phase.agent`) and Share (`apm publish`) are buttons: each runs
 * its dry run, shows what it would do, and runs only once the person confirms. Attaching is proposed
 * for review where configuration is approved; sharing commits on a branch in the marketplace's
 * checkout and pushes nothing. Choosing steps the general way opens Workflow Studio.
 */
import * as vscode from 'vscode';
import path from 'node:path';
import type { SingularityFlowClient } from '../cli/client.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { showCompactInformationMessage } from '../compact-message.ts';
import { createTerminalIn } from '../terminal-start.ts';
import { registerMessageRouter, stringField } from './messages.ts';
import {
  apmAttachResult, apmPublishDetail, apmPublishResult, apmView, kebabName, packageSpec, shellArgument, type ApmView
} from './apm-packages-model.ts';

/** What the panel needs from the window around it to attach an agent to a step. */
export interface ApmPanelContext {
  /** The steps of the configuration this window shows. */
  steps(): Array<{ id: string; label: string }>;
  /** The configuration authority's kind: anything but 'working-tree' takes a review proposal. */
  authorityKind(): string | null;
  /** Re-read configuration after a change. */
  refresh(): Promise<unknown>;
}
import { APM_PACKAGES_SCRIPT, APM_PACKAGES_STYLE, apmPackagesHtml } from './apm-packages-page.ts';

export class ApmPackagesPanel {
  private static current: ApmPackagesPanel | null = null;
  private view: ApmView | null = null;
  private error: string | null = null;
  private revision = 0;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly panel: vscode.WebviewPanel;
  private readonly client: SingularityFlowClient;
  private readonly context: ApmPanelContext;

  static show(client: SingularityFlowClient, context: ApmPanelContext): ApmPackagesPanel {
    if (ApmPackagesPanel.current) {
      ApmPackagesPanel.current.panel.reveal(vscode.ViewColumn.Active);
      void ApmPackagesPanel.current.reload();
      return ApmPackagesPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('singularityFlow.apmPackages', 'Agent Packages', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    return ApmPackagesPanel.current = new ApmPackagesPanel(panel, client, context);
  }

  // Plain fields, not parameter properties, so the panel loads under Node's type stripping in tests.
  private constructor(panel: vscode.WebviewPanel, client: SingularityFlowClient, context: ApmPanelContext) {
    this.panel = panel; this.client = client; this.context = context;
    const router = registerMessageRouter('singularityFlow.apmPackages', {
      action: (message) => this.act(stringField(message, 'action') ?? '', stringField(message, 'agent'))
    });
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return navigateTo(navigation);
      return router.route(raw);
    }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
    void this.reload();
  }

  private async reload(): Promise<void> {
    const revision = ++this.revision;
    try {
      const result = await this.client.run<unknown>(['apm', 'status', '--json']);
      if (revision !== this.revision) return;
      this.view = apmView(result);
      this.error = this.view ? null : 'apm status returned a shape this panel does not read.';
    } catch (failure) {
      if (revision !== this.revision) return;
      this.view = null;
      this.error = `The APM files could not be read: ${failure instanceof Error ? failure.message : String(failure)}`;
    }
    this.render();
  }

  private async act(action: string, agent: string | null = null): Promise<void> {
    if (action === 'refresh') return this.reload();
    if (action === 'attach' && agent) return this.attach(agent);
    if (action === 'share') return this.share();
    if (action === 'studio') { await vscode.commands.executeCommand('singularityFlow.openWorkflowStudio'); return; }
    if (action === 'open-manifest') return this.open('apm.yml');
    if (action === 'open-lock') return this.open('apm.lock.yaml');
    if (action === 'install') {
      const typed = await vscode.window.showInputBox({ title: 'Install an APM package', ignoreFocusOut: true,
        prompt: 'A package from your marketplace (name@marketplace), a repository (owner/repository) or a local path',
        validateInput: (value) => packageSpec(value) ? null : 'Name one package, without spaces or options.' });
      const spec = typed === undefined ? null : packageSpec(typed);
      if (!spec) return;
      return this.typeInTerminal(`singularity-flow apm install ${shellArgument(spec)}`,
        'The install is in the terminal. Press Enter to run it; it is committed on an apm/ branch for a pull request.');
    }
    if (action === 'update') {
      const choice = await vscode.window.showQuickPick([
        { label: 'Preview the update', description: 'apm update --dry-run: changes nothing', args: '--dry-run' },
        { label: 'Update every package', description: 'committed on an apm/ branch for a pull request', args: '' }
      ], { title: 'Update APM packages', ignoreFocusOut: true });
      if (!choice) return;
      return this.typeInTerminal(`singularity-flow apm update${choice.args ? ` ${choice.args}` : ''}`,
        'The update is in the terminal. Press Enter to run it.');
    }
  }

  /** An APM agent drafts a step: the dry run is shown, and the change runs once confirmed. */
  private async attach(agent: string): Promise<void> {
    if (!this.view?.apmAgents.includes(agent)) return;
    const kind = this.context.authorityKind();
    if (kind === 'verified-state-mirror') {
      void vscode.window.showErrorMessage('This configuration is readable only from the verified state recovery mirror. Restore or reinitialize sflow/config before changing it.');
      return;
    }
    const step = await vscode.window.showQuickPick(this.context.steps().map((entry) => ({ label: entry.label, description: entry.id, id: entry.id })),
      { title: `The step ${agent} drafts`, placeHolder: 'Choose a step', ignoreFocusOut: true });
    if (!step) return;
    const args = ['apm', 'attach', agent, '--step', step.id];
    const proposal = Boolean(kind && kind !== 'working-tree');
    try {
      const preview = apmAttachResult(await this.client.run<unknown>([...args, '--dry-run', '--json']));
      if (!preview.valid) {
        void vscode.window.showErrorMessage(`${agent} cannot draft ${step.label}: ${preview.problems.join(' ') || 'the change does not check.'}`);
        return;
      }
      const confirm = proposal ? 'Propose' : 'Attach';
      const choice = await showCompactInformationMessage(`${agent} drafts ${step.label}?`, {
        modal: true,
        detail: [...preview.summary, proposal
          ? 'It is proposed for review, and applies once the proposal is approved.'
          : "It changes this checkout's singularity/workflow.yml; review and commit it."].join('\n')
      }, confirm);
      if (choice !== confirm) return;
      const result = apmAttachResult(await this.client.run<unknown>([...args, ...(proposal ? ['--propose'] : []), '--json']));
      await this.context.refresh();
      void showCompactInformationMessage(proposal
        ? `Proposed: ${agent} drafts ${step.label}${result.branch ? ` (${result.branch})` : ''}. It applies once the proposal is approved.`
        : `${agent} now drafts ${step.label} in this checkout. Review and commit singularity/workflow.yml.`);
    } catch (failure) {
      void vscode.window.showErrorMessage(`${agent} was not attached: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
    await this.reload();
  }

  /** This repository's own agents, published as one package to the organisation's APM marketplace. */
  private async share(): Promise<void> {
    const own = this.view?.ownAgents ?? [];
    if (!own.length) return;
    const picked = await vscode.window.showQuickPick(own.map((id) => ({ label: id })),
      { title: 'Share agents to an APM marketplace', placeHolder: 'Choose the agents to publish as one package', canPickMany: true, ignoreFocusOut: true });
    if (!picked?.length) return;
    const folder = await vscode.window.showOpenDialog({ title: "The APM marketplace's checkout", openLabel: 'Publish to this marketplace',
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
    const marketplace = folder?.[0]?.fsPath;
    if (!marketplace) return;
    const agents = picked.map((entry) => entry.label);
    let name: string | null = null;
    if (agents.length > 1) {
      const typed = await vscode.window.showInputBox({ title: 'Package name', prompt: 'Several agents are published as one package. Name it.',
        ignoreFocusOut: true, validateInput: (value) => kebabName(value) ? null : 'Lower-case letters, digits and single hyphens, at most 64 characters.' });
      name = typed === undefined ? null : kebabName(typed);
      if (!name) return;
    }
    const args = ['apm', 'publish', ...agents, '--marketplace', marketplace, ...(name ? ['--package', name] : [])];
    try {
      const preview = apmPublishResult(await this.client.run<unknown>([...args, '--dry-run', '--json']));
      if (!preview) throw new Error('apm publish returned a shape this panel does not read.');
      if (preview.unchanged) {
        void showCompactInformationMessage(`${preview.package} ${preview.version} in ${preview.marketplace} already has exactly these files; nothing to publish.`);
        return;
      }
      const choice = await showCompactInformationMessage(`Publish ${preview.package} ${preview.version} to ${preview.marketplace}?`,
        { modal: true, detail: apmPublishDetail(preview) }, 'Publish');
      if (choice !== 'Publish') return;
      const result = apmPublishResult(await this.client.run<unknown>([...args, '--json']));
      void showCompactInformationMessage(result
        ? `Published ${result.package} ${result.version} to ${result.marketplace}: committed on ${result.branch ?? 'a branch'} in its checkout. Nothing was pushed; open a pull request there to share it.`
        : 'Published. Nothing was pushed; open a pull request in the marketplace\'s checkout to share it.');
    } catch (failure) {
      void vscode.window.showErrorMessage(`The agents were not shared: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
  }

  /** The person runs it: the command is typed, never entered, in a terminal at the repository. */
  private typeInTerminal(command: string, message: string): void {
    const terminal = createTerminalIn({ name: 'Singularity Flow APM' }, this.client.repository);
    terminal.show(false);
    terminal.sendText(command, false);
    void showCompactInformationMessage(message);
  }

  private async open(relative: string): Promise<void> {
    const file = vscode.Uri.file(path.join(this.client.repository, relative));
    try {
      await vscode.workspace.fs.stat(file);
      await vscode.commands.executeCommand('vscode.open', file);
    } catch {
      void showCompactInformationMessage(`${relative} is not in this checkout.`);
    }
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    this.panel.webview.html = page('Agent Packages', apmPackagesHtml(this.view, this.error),
      contentSecurityPolicy(this.panel.webview, token), token, APM_PACKAGES_SCRIPT, { styles: APM_PACKAGES_STYLE });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (ApmPackagesPanel.current === this) ApmPackagesPanel.current = null;
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
