/** Machine-level diagnostics, available without selecting or reloading a workspace. */
import * as vscode from 'vscode';
import { aboutHtml, isAboutInfo, ABOUT_SCRIPT, ABOUT_STYLE, type AboutInfo, type AboutWindow } from './about-page.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter } from './messages.ts';

interface AboutHost { read(): Promise<AboutInfo>; window(): AboutWindow }

export class AboutPanel {
  private static current: AboutPanel | null = null;
  private info: AboutInfo | null = null;
  private error: string | null = null;
  private revision = 0;
  private readonly disposables: vscode.Disposable[] = [];
  private constructor(private readonly panel: vscode.WebviewPanel, private readonly host: AboutHost) {
    const router = registerMessageRouter('singularityFlow.about', {
      refresh: () => this.refresh(),
      copy: () => this.info ? vscode.env.clipboard.writeText(JSON.stringify({ ...this.info, window: this.host.window() }, null, 2)) : undefined,
      reload: () => vscode.commands.executeCommand('workbench.action.reloadWindow'),
      'after-install': () => navigateTo('singularityFlow.afterInstall')
    });
    panel.webview.onDidReceiveMessage(raw => {
      const target = navigationTarget(raw);
      return target ? navigateTo(target) : router.route(raw);
    }, null, this.disposables);
    panel.onDidDispose(() => {
      this.revision++;
      if (AboutPanel.current === this) AboutPanel.current = null;
      this.disposables.forEach(disposable => disposable.dispose());
    }, null, this.disposables);
    this.render();
    void this.refresh();
  }
  static show(context: vscode.ExtensionContext, host: AboutHost): void {
    if (AboutPanel.current) { AboutPanel.current.panel.reveal(); void AboutPanel.current.refresh(); return; }
    const panel = vscode.window.createWebviewPanel('singularityFlow.about', 'About Singularity Flow', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    AboutPanel.current = new AboutPanel(panel, host);
  }
  private async refresh(): Promise<void> {
    const revision = ++this.revision;
    try {
      const info = await this.host.read();
      if (revision !== this.revision) return;
      if (!isAboutInfo(info)) {
        throw new Error('The selected CLI does not provide structured About build information. Update the CLI and reopen About.');
      }
      this.info = info; this.error = null;
    } catch (error) {
      if (revision !== this.revision) return;
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.render();
  }
  private render(): void {
    const token = nonce();
    this.panel.webview.html = page('About Singularity Flow', `<style nonce="${token}">${ABOUT_STYLE}</style>${aboutHtml(this.info, this.host.window(), this.error)}`,
      contentSecurityPolicy(this.panel.webview, token), token, ABOUT_SCRIPT);
  }
}
