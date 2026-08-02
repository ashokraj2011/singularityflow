/**
 * The Workspaces panel: the list, and the three things you can do to a local workspace.
 *
 * Rename, copy, forget. All three are safe in a way governed operations are not, because a
 * workspace holds no record of its own — it is a directory of checkouts and a note of which
 * capabilities are worked on there. The one rule the panel enforces on top of the engine is that no
 * two of them occupy the same directory, and it enforces it by refusing before the command runs.
 */
import * as vscode from 'vscode';
import { contentSecurityPolicy, nonce, page } from './webview.ts';
import { EMPTY_DRAFT, workspacesHtml, WORKSPACES_SCRIPT, type DuplicateDraft } from './workspaces-page.ts';
import {
  duplicateCommand, duplicateProblems, renameCommand, workspaceRows,
  type WorkspaceEntry, type WorkspaceRow
} from './workspaces-model.ts';

export type WorkspacesMessage =
  | { type: 'switch'; row: WorkspaceRow }
  | { type: 'create' }
  | { type: 'forget'; row: WorkspaceRow }
  | { type: 'run'; command: string[]; title: string };

export class WorkspacesPanel {
  private static current: WorkspacesPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly onMessage: (message: WorkspacesMessage) => Promise<string | null>;
  private readonly reload: () => Promise<WorkspaceEntry[]>;
  private readonly disposables: vscode.Disposable[] = [];
  private rows: WorkspaceRow[] = [];
  private selected: string | null = null;
  private draft: DuplicateDraft = { ...EMPTY_DRAFT };
  private error: string | null = null;

  private constructor(
    panel: vscode.WebviewPanel,
    entries: WorkspaceEntry[],
    reload: () => Promise<WorkspaceEntry[]>,
    onMessage: (message: WorkspacesMessage) => Promise<string | null>
  ) {
    this.panel = panel;
    this.reload = reload;
    this.onMessage = onMessage;
    this.rows = workspaceRows(entries);
    this.panel.webview.onDidReceiveMessage((raw: unknown) => { void this.receive(raw); }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
  }

  static show(
    context: vscode.ExtensionContext,
    entries: WorkspaceEntry[],
    reload: () => Promise<WorkspaceEntry[]>,
    onMessage: (message: WorkspacesMessage) => Promise<string | null>
  ): WorkspacesPanel {
    if (WorkspacesPanel.current) {
      WorkspacesPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return WorkspacesPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.workspaces', 'Workspaces', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    WorkspacesPanel.current = new WorkspacesPanel(panel, entries, reload, onMessage);
    return WorkspacesPanel.current;
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page(
      'Workspaces',
      workspacesHtml(this.rows, this.selected, this.draft, this.error),
      contentSecurityPolicy(this.panel.webview, token),
      token,
      WORKSPACES_SCRIPT
    );
  }

  private async refresh(): Promise<void> {
    this.rows = workspaceRows(await this.reload());
    this.render();
  }

  /** The row a page message names — resolved from the list rather than taken from the page. */
  private rowFor(value: unknown): WorkspaceRow | null {
    return this.rows.find((row) => row.path === value) ?? null;
  }

  private async receive(raw: unknown): Promise<void> {
    const message = raw as {
      type?: unknown; path?: unknown; id?: unknown; base?: unknown; name?: unknown;
      field?: unknown; value?: unknown;
    };

    if (message?.type === 'select') {
      this.selected = typeof message.path === 'string' ? message.path : null;
      this.draft = { ...EMPTY_DRAFT };
      this.error = null;
      return this.render();
    }

    // Typed without re-rendering: the page answers its own preview, and this is only so that acting
    // on the draft never has to trust what arrives with the click.
    if (message?.type === 'draft' && typeof message.value === 'string') {
      if (message.field === 'copy-id') this.draft.id = message.value;
      else if (message.field === 'copy-base') this.draft.base = message.value;
      return;
    }

    if (message?.type === 'create') { await this.onMessage({ type: 'create' }); return; }

    const row = this.rowFor(message?.path);
    if (!row) return;

    if (message.type === 'switch') { await this.onMessage({ type: 'switch', row }); return; }

    if (message.type === 'forget') {
      const failure = await this.onMessage({ type: 'forget', row });
      this.error = failure;
      if (!failure && this.selected === row.path) this.selected = null;
      return this.refresh();
    }

    if (message.type === 'rename') {
      const name = String(message.name ?? '').trim();
      if (!name || name === row.name) return;
      const failure = await this.onMessage({
        type: 'run', command: renameCommand(row, name), title: `Renaming ${row.name}`
      });
      this.error = failure;
      return this.refresh();
    }

    if (message.type === 'duplicate') {
      // Re-checked here rather than trusted from the page: the disabled button is a courtesy, and
      // the directory rule is the one thing this screen exists to keep.
      const id = String(message.id ?? this.draft.id);
      const base = String(message.base ?? this.draft.base);
      const problems = duplicateProblems(row, id, base, this.rows);
      if (problems.length) {
        this.error = problems.join(' ');
        return this.render();
      }
      this.draft = { ...this.draft, busy: true };
      this.error = null;
      this.render();

      const failure = await this.onMessage({
        type: 'run', command: duplicateCommand(row, id, base, ''), title: `Copying ${row.name}`
      });
      this.draft = failure ? { ...this.draft, busy: false } : { ...EMPTY_DRAFT };
      this.error = failure;
      return this.refresh();
    }
  }

  dispose(): void {
    WorkspacesPanel.current = null;
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
