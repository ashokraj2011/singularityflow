/** Machine-local guided maintenance, available even with no governed repository open. */
import * as vscode from 'vscode';
import { AfterInstallJourney, type AfterInstallHost } from './after-install-model.ts';
import { afterInstallHtml, AFTER_INSTALL_SCRIPT, AFTER_INSTALL_STYLE } from './after-install-page.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField } from './messages.ts';

export class AfterInstallPanel {
  private static current: AfterInstallPanel | null = null;
  private readonly journey: AfterInstallJourney;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(private readonly panel: vscode.WebviewPanel, host: AfterInstallHost) {
    this.journey = new AfterInstallJourney(host, () => this.render());
    const router = registerMessageRouter('singularityFlow.afterInstall', {
      recheck: () => this.journey.load(),
      select: message => {
        const path = stringField(message, 'path');
        if (path) return this.journey.select(path);
      },
      align: () => this.journey.align(),
      migrate: () => this.journey.migrate(),
      cutover: () => this.journey.migrate(true),
      preview: () => this.journey.preview(),
      apply: () => this.journey.apply(),
      references: () => this.journey.refreshReferences(),
      reload: () => vscode.commands.executeCommand('workbench.action.reloadWindow'),
      workspaces: () => navigateTo('singularityFlow.openWorkspaces',
        this.journey.view.selected ? { workspacePath: this.journey.view.selected } : undefined),
      'repository-setup': () => navigateTo('singularityFlow.repairRepositorySetup')
    });
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return navigateTo(navigation);
      return router.route(raw);
    }, null, this.disposables);
    panel.onDidDispose(() => {
      this.journey.dispose();
      if (AfterInstallPanel.current === this) AfterInstallPanel.current = null;
      for (const disposable of this.disposables) disposable.dispose();
    }, null, this.disposables);
    this.render();
    void this.journey.load();
  }

  static show(context: vscode.ExtensionContext, host: AfterInstallHost): AfterInstallPanel {
    // Opening a fresh journey invalidates the old confirmation and its callbacks.
    AfterInstallPanel.current?.panel.dispose();
    const panel = vscode.window.createWebviewPanel('singularityFlow.afterInstall', 'After install',
      vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
    const current = new AfterInstallPanel(panel, host);
    AfterInstallPanel.current = current;
    return current;
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page('After install',
      `<style nonce="${token}">${AFTER_INSTALL_STYLE}</style>${afterInstallHtml(this.journey.view)}`,
      contentSecurityPolicy(this.panel.webview, token), token, AFTER_INSTALL_SCRIPT);
  }
}
