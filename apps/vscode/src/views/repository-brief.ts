/**
 * Repository Brief: business rules, contracts, flows, change impact, risks and questions for the
 * product owner, each statement with the file and line it rests on.
 *
 * The engine builds the evidence (code rules, endpoints, flows, tests, history, README and docs)
 * and, when the model is on, has the model write each view and checks every statement against what
 * it cites. This panel only shows the result and asks for it; it never writes to the repository.
 */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import type { WorkspaceStore } from '../state.ts';
import { containedWorkingPath } from './change-explorer-source.ts';
import { enumField, integerField, registerMessageRouter, stringField } from './messages.ts';
import {
  BRIEF_PHASES, BRIEF_TABS, REPOSITORY_BRIEF_SCRIPT, REPOSITORY_BRIEF_STYLES, repositoryBriefBody,
  type BriefPageState, type RepositoryBrief
} from './repository-brief-page.ts';
import { contentSecurityPolicy, nonce, page } from './webview.ts';

export class RepositoryBriefPanel {
  private static current: RepositoryBriefPanel | null = null;
  private readonly panel: vscode.WebviewPanel;
  private readonly store: WorkspaceStore;
  private readonly client: SingularityFlowClient;
  private brief: RepositoryBrief | null = null;
  private state: BriefPageState = { tab: 'overview', phase: 'all', loading: 'read', error: null };
  private request = 0;
  private disposed = false;

  static show(context: vscode.ExtensionContext, store: WorkspaceStore, client: SingularityFlowClient): RepositoryBriefPanel {
    if (RepositoryBriefPanel.current) {
      RepositoryBriefPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return RepositoryBriefPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.repositoryBrief', 'Repository Brief', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
    );
    RepositoryBriefPanel.current = new RepositoryBriefPanel(panel, store, client);
    return RepositoryBriefPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, store: WorkspaceStore, client: SingularityFlowClient) {
    this.panel = panel;
    this.store = store;
    this.client = client;
    const router = registerMessageRouter('singularityFlow.repositoryBrief', {
      tab: (message) => {
        const tab = enumField(message, 'tab', BRIEF_TABS);
        if (tab) { this.state = { ...this.state, tab }; this.render(); }
      },
      phase: (message) => {
        const phase = enumField(message, 'phase', BRIEF_PHASES);
        if (phase && phase !== this.state.phase) { this.state = { ...this.state, phase }; void this.load('read'); }
      },
      ref: (message) => {
        // Empty means "let the engine choose"; any other value must be a branch the brief listed.
        const ref = stringField(message, 'ref');
        if (ref && !(this.brief?.branches ?? []).includes(ref)) return;
        if (ref !== (this.state.ref ?? null)) { this.state = { ...this.state, ref }; void this.load('read'); }
      },
      generate: () => void this.load('write'),
      regenerate: () => void this.load('rewrite'),
      refresh: () => void this.load('read'),
      'open-file': (message) => {
        const file = stringField(message, 'path');
        const line = integerField(message, 'line');
        if (file) void this.openFile(file, line ?? 0);
      }
    });
    panel.webview.onDidReceiveMessage((raw) => router.route(raw));
    panel.onDidDispose(() => this.dispose());
    this.render();
    void this.load('read');
  }

  /**
   * Ask the engine for the brief. `read` shows a saved model brief or the evidence-built one;
   * `write` has the model write it unless one is saved for this exact evidence (no second payment);
   * `rewrite` asks the model again regardless.
   */
  private async load(mode: 'read' | 'write' | 'rewrite'): Promise<void> {
    const request = ++this.request;
    const generate = mode !== 'read';
    this.state = { ...this.state, loading: generate ? 'generate' : 'read', error: null };
    this.render();
    const args = ['wm', 'knowledge', 'brief', '--json'];
    if (this.state.phase !== 'all') args.push('--phase', this.state.phase);
    if (this.state.ref) args.push('--ref', this.state.ref);
    if (mode === 'read') args.push('--cached');
    if (mode === 'rewrite') args.push('--refresh');
    try {
      const brief = await this.client.run<RepositoryBrief>(args);
      if (request !== this.request || this.disposed) return;
      this.brief = brief;
      if (generate && brief.mode !== 'model') this.state = { ...this.state, error: brief.reason ?? 'The model did not write a brief.' };
    } catch (error) {
      if (request !== this.request || this.disposed) return;
      this.state = { ...this.state, error: `The brief could not be read: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      if (request === this.request && !this.disposed) {
        this.state = { ...this.state, loading: null };
        this.render();
      }
    }
  }

  /** Paths the brief names, so the page can open only files it actually showed. */
  private knownPaths(): Set<string> {
    const paths = new Set<string>();
    for (const list of Object.values(this.brief?.views ?? {})) for (const statement of list) for (const source of statement.sources) paths.add(source.path);
    for (const document of this.brief?.evidence.documents ?? []) paths.add(document);
    for (const entry of this.brief?.documented ?? []) paths.add(entry.path);
    return paths;
  }

  private async openFile(file: string, line: number): Promise<void> {
    const root = this.store.current.snapshot?.repository?.root ?? this.client.repository;
    if (!root || !this.knownPaths().has(file)) return;
    const { target, refusal } = await containedWorkingPath(root, file);
    if (!target) {
      this.state = { ...this.state, error: refusal };
      this.render();
      return;
    }
    const options = line > 0 ? { selection: new vscode.Range(line - 1, 0, line - 1, 0) } : undefined;
    // A brief read from another branch names files at that commit, which the working tree may not
    // have: VS Code's Git view shows them read-only at the commit the brief read.
    const commit = this.brief?.source && this.brief.source.chosen !== 'checked-out' ? this.brief.commit : null;
    const uri = commit
      ? vscode.Uri.file(target).with({ scheme: 'git', query: JSON.stringify({ path: target, ref: commit }) })
      : vscode.Uri.file(target);
    await vscode.commands.executeCommand('vscode.open', uri, options);
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    this.panel.webview.html = page(
      'Repository Brief',
      repositoryBriefBody(this.brief, this.state),
      contentSecurityPolicy(this.panel.webview, token), token, REPOSITORY_BRIEF_SCRIPT, { nav: 'help', styles: REPOSITORY_BRIEF_STYLES }
    );
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    RepositoryBriefPanel.current = null;
  }
}
