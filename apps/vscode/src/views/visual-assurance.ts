/** VS Code host for local-first visual assurance and explicit MCP operations. */
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import type { WorkspaceStore } from '../state.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField } from './messages.ts';
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
 void this.router.route(raw); }, null, this.subscriptions);
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

  /**
   * The nine messages this panel speaks, enumerated. `[UXH:REQ-134]` `[UXH:AC-014]`
   *
   * **Three of these are ceremonies and are reproduced exactly.** `attest` demands the server ID
   * typed back before recording that a person trusted and authenticated an MCP host; `promote-candidate`
   * demands the record ID because promoting reopens design capture and invalidates downstream
   * approvals; `record` with a remote URL asks before contacting the network. Those prompts, their
   * exact-match comparisons and their refusals are unchanged — a ceremony that a migration made one
   * click easier would be worse than the open type set this change is closing `[INT:CON-113]`.
   *
   * `this.busy` is checked once for all of them, as the chain did: an operation in flight means no
   * second one starts, and that guard has to sit in front of every branch rather than inside some.
   */
  private router = registerMessageRouter('singularityFlow.visualAssurance', {
    refresh: () => this.guard(() => this.store.refresh()),
    open: (message) => {
      const path = stringField(message, 'path');
      return path ? this.guard(() => this.open(path)) : undefined;
    },
    'network-doctor': () => this.guard(async () => {
      const confirmed = await vscode.window.showWarningMessage(
        'Run network diagnostics against configured MCP hosts? This may contact external design and browser services.',
        { modal: true }, 'Run network doctor'
      );
      if (confirmed !== 'Run network doctor') return;
      await this.operate('MCP network diagnostics completed.', ['mcp', 'doctor', '--network', '--json']);
    }),
    warm: (message) => {
      const server = stringField(message, 'server');
      if (!server) return;
      return this.guard(async () => {
        const confirmed = await vscode.window.showWarningMessage(
          `Contact and warm MCP server '${server}'?`, { modal: true }, 'Warm server'
        );
        if (confirmed !== 'Warm server') return;
        await this.operate(`MCP server '${server}' warmed.`, ['mcp', 'warm', server, '--network', '--json']);
      });
    },
    attest: (message) => {
      const server = stringField(message, 'server');
      if (!server) return;
      return this.guard(async () => {
        const confirmation = await vscode.window.showInputBox({
          title: `Attest MCP host readiness · ${server}`,
          prompt: `Type ${server} to confirm that you trusted, started, and authenticated this MCP host on this machine.`,
          placeHolder: server,
          ignoreFocusOut: true
        });
        if (confirmation !== server) {
          if (confirmation !== undefined) void vscode.window.showWarningMessage(`Readiness was not attested. Enter the exact server ID: ${server}`);
          return;
        }
        await this.operateText(`MCP host readiness attested for '${server}'.`, ['mcp', 'attest', server, '--confirm', server]);
      });
    },
    inventory: () => this.guard(() => this.operate(
      'Deterministic design inventory generated.', ['wm', 'design-inventory', '--from-records', '--json']
    )),
    'promote-candidate': (message) => {
      const candidateRecordId = stringField(message, 'candidateRecordId');
      if (!candidateRecordId) return;
      return this.guard(async () => {
        const confirmation = await vscode.window.showInputBox({
          title: 'Promote design-source candidate',
          prompt: 'This reopens the design capture phase and invalidates downstream approvals. Type the exact candidate record ID to continue.',
          placeHolder: candidateRecordId, ignoreFocusOut: true
        });
        if (confirmation !== candidateRecordId) return;
        await this.operateText('Design candidate promoted; capture and downstream phases reopened.', [
          'mcp', 'design-sources', 'promote', candidateRecordId, '--confirm', candidateRecordId
        ]);
      });
    },
    compare: (message) => {
      const expected = stringField(message, 'expected');
      const actual = stringField(message, 'actual');
      if (!expected || !actual) return;
      return this.guard(async () => {
        const args = ['visual', 'compare', '--expected', expected, '--actual', actual];
        addOption(args, '--profile', stringField(message, 'profile') ?? undefined); args.push('--json');
        await this.operate('Visual comparison recorded.', args);
      });
    },
    record: (message) => {
      const server = stringField(message, 'server');
      const tool = stringField(message, 'tool');
      const kind = stringField(message, 'kind');
      if (!server || !tool || !kind) return;
      return this.guard(async () => {
        const args = ['mcp', 'record', server, '--tool', tool, '--kind', kind];
        const option = (flag: string, name: string) => addOption(args, flag, stringField(message, name) ?? undefined);
        option('--output', 'output'); option('--output-url', 'outputUrl');
        option('--file-key', 'fileKey'); option('--file-version', 'fileVersion');
        option('--profile-id', 'profileId'); option('--screen-id', 'screenId');
        option('--state-id', 'stateId');
        const nodes = Array.isArray(message.nodes) ? message.nodes : [];
        for (const node of nodes) if (typeof node === 'string' && node) addOption(args, '--node', node);
        const outputUrl = stringField(message, 'outputUrl');
        if (outputUrl) {
          const confirmed = await vscode.window.showWarningMessage(
            `Download and hash MCP evidence from ${outputUrl}?`, { modal: true }, 'Record remote evidence'
          );
          if (confirmed !== 'Record remote evidence') return;
        }
        await this.operateText('Governed MCP evidence recorded.', args);
      });
    }
  });

  /** One busy check in front of every message, exactly where the chain's single `if` sat. */
  private async guard(action: () => Promise<unknown>): Promise<void> {
    if (this.busy) return;
    await action();
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
