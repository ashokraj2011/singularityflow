/** VS Code host for the offline, searchable Singularity Flow Help Center. */
import * as vscode from 'vscode';
import path from 'node:path';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField } from './messages.ts';
import { HELP_CENTER_SCRIPT, helpCenterHtml, type HelpDocument } from './help-page.ts';

export class HelpPanel {
  private static current: HelpPanel | null = null;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private document: HelpDocument,
    private requested: string | null,
    private manualRoot: string
  ) {
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      this.router.route(raw);
    });
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

  /**
   * The one message this panel speaks. `[UXH:REQ-134]` `[UXH:AC-014]`
   *
   * A single-type handler is still an open set: `if (type !== 'open-link') return` drops everything
   * else in silence, so nothing can enumerate what this panel accepts and an unrecognised type is
   * indistinguishable from a handled one. One entry in a closed map says the same thing and can be
   * read from outside.
   *
   * **The containment check below is unchanged and is the point of this handler.** A help page names
   * a link; this decides what that name may reach. `https://` goes to the browser, and anything else
   * is resolved under the manual root and refused if it escapes — which is why the boundary compares
   * against a path with a trailing separator rather than a prefix, so `…/manual-evil` cannot pass as
   * being inside `…/manual`.
   */
  private router = registerMessageRouter('singularityFlow.help', {
    'open-link': (message) => { void this.openLink(stringField(message, 'target')); }
  });

  private async openLink(target: string | null): Promise<void> {
    if (!target) return;
    if (/^https:\/\//i.test(target)) {
      await vscode.env.openExternal(vscode.Uri.parse(target));
      return;
    }
    const relative = target.split('#')[0]?.trim();
    if (!relative) return;
    const resolved = path.resolve(this.manualRoot, relative);
    const boundary = `${path.resolve(this.manualRoot)}${path.sep}`;
    if (resolved !== path.resolve(this.manualRoot) && !resolved.startsWith(boundary)) return;
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(resolved));
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page('Singularity Flow Help', helpCenterHtml(this.document, this.requested),
      contentSecurityPolicy(this.panel.webview, token), token, HELP_CENTER_SCRIPT, { nav: 'help' });
  }
}
