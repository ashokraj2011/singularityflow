/**
 * The agent packages panel [APM A7, 2026-10-30]: the repository's `singularity-flow apm status
 * --json`, read once per refresh. It changes nothing itself. Installing and updating change which
 * agents run, so they are the person's own step: the panel types the command into a terminal and
 * the person presses Enter. Choosing steps opens Workflow Studio.
 */
import * as vscode from 'vscode';
import path from 'node:path';
import type { SingularityFlowClient } from '../cli/client.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { showCompactInformationMessage } from '../compact-message.ts';
import { createTerminalIn } from '../terminal-start.ts';
import { registerMessageRouter, stringField } from './messages.ts';
import { apmView, packageSpec, shellArgument, type ApmView } from './apm-packages-model.ts';
import { APM_PACKAGES_SCRIPT, APM_PACKAGES_STYLE, apmPackagesHtml } from './apm-packages-page.ts';

export class ApmPackagesPanel {
  private static current: ApmPackagesPanel | null = null;
  private view: ApmView | null = null;
  private error: string | null = null;
  private revision = 0;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  static show(client: SingularityFlowClient): ApmPackagesPanel {
    if (ApmPackagesPanel.current) {
      ApmPackagesPanel.current.panel.reveal(vscode.ViewColumn.Active);
      void ApmPackagesPanel.current.reload();
      return ApmPackagesPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('singularityFlow.apmPackages', 'Agent Packages', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    return ApmPackagesPanel.current = new ApmPackagesPanel(panel, client);
  }

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly client: SingularityFlowClient) {
    const router = registerMessageRouter('singularityFlow.apmPackages', {
      action: (message) => this.act(stringField(message, 'action') ?? '')
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

  private async act(action: string): Promise<void> {
    if (action === 'refresh') return this.reload();
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
