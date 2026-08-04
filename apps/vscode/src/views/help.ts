/** VS Code host for the offline, searchable Singularity Flow Help Center. */
import * as vscode from 'vscode';
import path from 'node:path';
import { contentSecurityPolicy, nonce, page } from './webview.ts';
import { HELP_CENTER_SCRIPT, helpCenterHtml, type HelpDocument } from './help-page.ts';

export class HelpPanel {
  private static current: HelpPanel | null = null;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private document: HelpDocument,
    private requested: string | null,
    private manualRoot: string
  ) {
    panel.webview.onDidReceiveMessage((raw: unknown) => { void this.receive(raw); });
    panel.onDidDispose(() => { HelpPanel.current = null; });
    this.render();
  }

  static show(
    context: vscode.ExtensionContext,
    document: HelpDocument,
    requested: string | null = null,
    manualRoot = context.extensionPath
  ): HelpPanel {
    if (HelpPanel.current) {
      HelpPanel.current.document = document;
      HelpPanel.current.requested = requested;
      HelpPanel.current.manualRoot = manualRoot;
      HelpPanel.current.render();
      HelpPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return HelpPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.helpCenter', 'Singularity Flow Help', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );
    HelpPanel.current = new HelpPanel(panel, document, requested, manualRoot);
    return HelpPanel.current;
  }

  private async receive(raw: unknown): Promise<void> {
    const message = (raw && typeof raw === 'object' ? raw : {}) as { type?: unknown; target?: unknown };
    if (message.type !== 'open-link' || typeof message.target !== 'string') return;
    if (/^https:\/\//i.test(message.target)) {
      await vscode.env.openExternal(vscode.Uri.parse(message.target));
      return;
    }
    const relative = message.target.split('#')[0]?.trim();
    if (!relative) return;
    const target = path.resolve(this.manualRoot, relative);
    const boundary = `${path.resolve(this.manualRoot)}${path.sep}`;
    if (target !== path.resolve(this.manualRoot) && !target.startsWith(boundary)) return;
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page('Singularity Flow Help', helpCenterHtml(this.document, this.requested),
      contentSecurityPolicy(this.panel.webview, token), token, HELP_CENTER_SCRIPT);
  }
}
