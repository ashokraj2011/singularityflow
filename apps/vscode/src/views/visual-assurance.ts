/** VS Code host for local-first visual assurance and explicit MCP operations. */
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import type { WorkspaceStore } from '../state.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { buildVisualAssuranceView } from './visual-assurance-model.ts';
import { visualAssuranceHtml, VISUAL_ASSURANCE_SCRIPT } from './visual-assurance-page.ts';

interface VisualMessage {
  type?: string; path?: string; server?: string; expected?: string; actual?: string; profile?: string;
  tool?: string; kind?: string; output?: string; outputUrl?: string; fileKey?: string;
  fileVersion?: string; profileId?: string; screenId?: string; stateId?: string; nodes?: string[];
  candidateRecordId?: string;
}

function addOption(args: string[], flag: string, value: unknown): void {
  if (typeof value === 'string' && value.trim()) args.push(flag, value.trim());
}

export class VisualAssurancePanel implements vscode.Disposable {
  private static current: VisualAssurancePanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  private notice: string | null = null;
  private operationError: string | null = null;
  private busy = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly store: WorkspaceStore,
    private readonly client: SingularityFlowClient
  ) {
    this.subscriptions.push(store.onDidChange(() => this.render()) as vscode.Disposable);
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
 void this.receive(raw); }, null, this.subscriptions);
    panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
    this.render();
  }

  static show(context: vscode.ExtensionContext, store: WorkspaceStore, client: SingularityFlowClient): VisualAssurancePanel {
    if (VisualAssurancePanel.current) {
      VisualAssurancePanel.current.panel.reveal(vscode.ViewColumn.Active);
      VisualAssurancePanel.current.render();
      return VisualAssurancePanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.visualAssurance', 'Visual Assurance', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.file(client.repository), vscode.Uri.joinPath(context.extensionUri, 'media')] }
    );
    VisualAssurancePanel.current = new VisualAssurancePanel(panel, store, client);
    return VisualAssurancePanel.current;
  }

  private async receive(raw: unknown): Promise<void> {
    const message = (raw && typeof raw === 'object' ? raw : {}) as VisualMessage;
    if (this.busy) return;
    if (message.type === 'refresh') { await this.store.refresh(); return; }
    if (message.type === 'open' && message.path) return this.open(message.path);
    if (message.type === 'network-doctor') {
      const confirmed = await vscode.window.showWarningMessage(
        'Run network diagnostics against configured MCP hosts? This may contact external design and browser services.',
        { modal: true }, 'Run network doctor'
      );
      if (confirmed !== 'Run network doctor') return;
      return this.operate('MCP network diagnostics completed.', ['mcp', 'doctor', '--network', '--json']);
    }
    if (message.type === 'warm' && message.server) {
      const confirmed = await vscode.window.showWarningMessage(
        `Contact and warm MCP server '${message.server}'?`, { modal: true }, 'Warm server'
      );
      if (confirmed !== 'Warm server') return;
      return this.operate(`MCP server '${message.server}' warmed.`, ['mcp', 'warm', message.server, '--network', '--json']);
    }
    if (message.type === 'attest' && message.server) {
      const confirmation = await vscode.window.showInputBox({
        title: `Attest MCP host readiness · ${message.server}`,
        prompt: `Type ${message.server} to confirm that you trusted, started, and authenticated this MCP host on this machine.`,
        placeHolder: message.server,
        ignoreFocusOut: true
      });
      if (confirmation !== message.server) {
        if (confirmation !== undefined) void vscode.window.showWarningMessage(`Readiness was not attested. Enter the exact server ID: ${message.server}`);
        return;
      }
      return this.operateText(`MCP host readiness attested for '${message.server}'.`, ['mcp', 'attest', message.server, '--confirm', message.server]);
    }
    if (message.type === 'inventory') return this.operate(
      'Deterministic design inventory generated.', ['wm', 'design-inventory', '--from-records', '--json']
    );
    if (message.type === 'promote-candidate' && message.candidateRecordId) {
      const confirmation = await vscode.window.showInputBox({
        title: 'Promote design-source candidate',
        prompt: 'This reopens the design capture phase and invalidates downstream approvals. Type the exact candidate record ID to continue.',
        placeHolder: message.candidateRecordId, ignoreFocusOut: true
      });
      if (confirmation !== message.candidateRecordId) return;
      return this.operateText('Design candidate promoted; capture and downstream phases reopened.', [
        'mcp', 'design-sources', 'promote', message.candidateRecordId, '--confirm', message.candidateRecordId
      ]);
    }
    if (message.type === 'compare' && message.expected && message.actual) {
      const args = ['visual', 'compare', '--expected', message.expected, '--actual', message.actual];
      addOption(args, '--profile', message.profile); args.push('--json');
      return this.operate('Visual comparison recorded.', args);
    }
    if (message.type === 'record' && message.server && message.tool && message.kind) {
      const args = ['mcp', 'record', message.server, '--tool', message.tool, '--kind', message.kind];
      addOption(args, '--output', message.output); addOption(args, '--output-url', message.outputUrl);
      addOption(args, '--file-key', message.fileKey); addOption(args, '--file-version', message.fileVersion);
      addOption(args, '--profile-id', message.profileId); addOption(args, '--screen-id', message.screenId);
      addOption(args, '--state-id', message.stateId);
      for (const node of message.nodes ?? []) addOption(args, '--node', node);
      if (message.outputUrl) {
        const confirmed = await vscode.window.showWarningMessage(
          `Download and hash MCP evidence from ${message.outputUrl}?`, { modal: true }, 'Record remote evidence'
        );
        if (confirmed !== 'Record remote evidence') return;
      }
      return this.operateText('Governed MCP evidence recorded.', args);
    }
  }

  private async operate(success: string, args: string[]): Promise<void> {
    this.busy = true; this.operationError = null; this.notice = null; this.render();
    try { await this.client.run(args); this.notice = success; }
    catch (error) { this.operationError = (error as Error).message; }
    finally { this.busy = false; await this.store.refresh(); this.render(); }
  }

  private async operateText(success: string, args: string[]): Promise<void> {
    this.busy = true; this.operationError = null; this.notice = null; this.render();
    try { await this.client.runText(args); this.notice = success; }
    catch (error) { this.operationError = (error as Error).message; }
    finally { this.busy = false; await this.store.refresh(); this.render(); }
  }

  private async open(relative: string): Promise<void> {
    const view = buildVisualAssuranceView(this.store.current.snapshot);
    const repository = path.resolve(this.client.repository);
    const itemRoot = path.resolve(repository, view.itemDirectory ?? '');
    const possibilities = [path.resolve(itemRoot, relative), path.resolve(repository, relative)];
    const target = possibilities.find((candidate) => {
      const inside = path.relative(repository, candidate);
      return inside && !inside.startsWith('..') && !path.isAbsolute(inside) && existsSync(candidate);
    });
    if (!target) { this.operationError = `The governed artifact could not be found inside this repository: ${relative}`; return this.render(); }
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
  }

  /** Resolve only a committed Story artifact to a webview URI; never expose arbitrary repository files. */
  private mediaUri(relative: string | undefined): string | null {
    if (!relative) return null;
    const view = buildVisualAssuranceView(this.store.current.snapshot);
    if (!view.itemDirectory) return null;
    const repository = path.resolve(this.client.repository);
    const itemRoot = path.resolve(repository, view.itemDirectory);
    const possibilities = [path.resolve(itemRoot, relative), path.resolve(repository, relative)];
    for (const possibility of possibilities) {
      if (!existsSync(possibility)) continue;
      try {
        const canonicalRoot = realpathSync(itemRoot);
        const canonical = realpathSync(possibility);
        const inside = path.relative(canonicalRoot, canonical);
        if ((!inside || (!inside.startsWith('..') && !path.isAbsolute(inside))) && /\.png$/i.test(canonical)) {
          return this.panel.webview.asWebviewUri(vscode.Uri.file(canonical)).toString();
        }
      } catch { /* A missing or escaping artifact is shown as unavailable, never loaded. */ }
    }
    return null;
  }

  private render(): void {
    const token = nonce();
    const body = `${this.busy ? '<div class="notice warning">An explicit governed operation is running. The dashboard will refresh when it finishes.</div>' : ''}${visualAssuranceHtml(buildVisualAssuranceView(this.store.current.snapshot), this.notice, this.operationError, (relative) => this.mediaUri(relative))}`;
    this.panel.webview.html = page('Visual Assurance', body, contentSecurityPolicy(this.panel.webview, token), token, VISUAL_ASSURANCE_SCRIPT);
  }

  dispose(): void {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    VisualAssurancePanel.current = null;
  }
}
