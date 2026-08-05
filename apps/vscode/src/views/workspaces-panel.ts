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
import {
  EMPTY_DRAFT, EMPTY_EDIT_DRAFT, workspacesHtml, WORKSPACES_SCRIPT,
  type DuplicateDraft, type WorkspaceEditDraft
} from './workspaces-page.ts';
import {
  duplicateCommand, duplicateProblems, renameCommand, updateCommand, workspaceRows,
  type WorkspaceEntry, type WorkspaceRow, type WorkspaceStatus
} from './workspaces-model.ts';

export type WorkspacesMessage =
  | { type: 'switch'; row: WorkspaceRow }
  | { type: 'create' }
  | { type: 'forget'; row: WorkspaceRow }
  | { type: 'archive'; row: WorkspaceRow }
  | { type: 'restore'; row: WorkspaceRow }
  | { type: 'run'; command: string[]; title: string };

export class WorkspacesPanel {
  private static current: WorkspacesPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly onMessage: (message: WorkspacesMessage) => Promise<string | null>;
  private readonly reload: () => Promise<WorkspaceEntry[]>;
  private readonly loadDetails: (path: string) => Promise<WorkspaceStatus>;
  private readonly disposables: vscode.Disposable[] = [];
  private rows: WorkspaceRow[] = [];
  private selected: string | null = null;
  private draft: DuplicateDraft = { ...EMPTY_DRAFT };
  private edit: WorkspaceEditDraft = { ...EMPTY_EDIT_DRAFT };
  private error: string | null = null;
  private detailError: string | null = null;
  private details: WorkspaceStatus | null = null;
  private detailsLoading = false;
  private detailRequest = 0;

  private constructor(
    panel: vscode.WebviewPanel,
    entries: WorkspaceEntry[],
    reload: () => Promise<WorkspaceEntry[]>,
    onMessage: (message: WorkspacesMessage) => Promise<string | null>,
    loadDetails: (path: string) => Promise<WorkspaceStatus>,
    selected: string | null
  ) {
    this.panel = panel;
    this.reload = reload;
    this.onMessage = onMessage;
    this.loadDetails = loadDetails;
    this.rows = workspaceRows(entries);
    this.selected = selected;
    // Return the promise so sequential UI events (typing, then immediately saving) are observed in
    // order by hosts and test doubles that support async listeners. VS Code itself ignores the
    // return value, but the edit-save message also carries the current field value as a safeguard.
    this.panel.webview.onDidReceiveMessage((raw: unknown) => this.receive(raw), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
    if (selected) void this.select(selected);
  }

  static show(
    context: vscode.ExtensionContext,
    entries: WorkspaceEntry[],
    reload: () => Promise<WorkspaceEntry[]>,
    onMessage: (message: WorkspacesMessage) => Promise<string | null>,
    loadDetails: (path: string) => Promise<WorkspaceStatus>,
    selected: string | null = null
  ): WorkspacesPanel {
    if (WorkspacesPanel.current) {
      WorkspacesPanel.current.panel.reveal(vscode.ViewColumn.Active);
      if (selected) void WorkspacesPanel.current.select(selected);
      return WorkspacesPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.workspaces', 'Workspaces', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    WorkspacesPanel.current = new WorkspacesPanel(panel, entries, reload, onMessage, loadDetails, selected);
    return WorkspacesPanel.current;
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page(
      'Workspaces',
      workspacesHtml(
        this.rows, this.selected, this.draft, this.error,
        this.details, this.detailsLoading, this.detailError, this.edit
      ),
      contentSecurityPolicy(this.panel.webview, token),
      token,
      WORKSPACES_SCRIPT
    );
  }

  private async refresh(): Promise<void> {
    this.rows = workspaceRows(await this.reload());
    if (this.selected && this.rows.some((row) => row.path === this.selected)) {
      await this.select(this.selected);
    } else {
      this.selected = null;
      this.details = null;
      this.render();
    }
  }

  private async select(path: string): Promise<void> {
    if (!this.rows.some((row) => row.path === path)) return;
    const request = ++this.detailRequest;
    this.selected = path;
    this.draft = { ...EMPTY_DRAFT };
    this.edit = { ...EMPTY_EDIT_DRAFT };
    this.error = null;
    this.detailError = null;
    this.details = null;
    this.detailsLoading = true;
    this.render();
    try {
      const details = await this.loadDetails(path);
      if (request !== this.detailRequest) return;
      this.details = details;
    } catch (error) {
      if (request !== this.detailRequest) return;
      this.detailError = (error as Error).message;
    } finally {
      if (request !== this.detailRequest) return;
      this.detailsLoading = false;
      this.render();
    }
  }

  /** The row a page message names — resolved from the list rather than taken from the page. */
  private rowFor(value: unknown): WorkspaceRow | null {
    return this.rows.find((row) => row.path === value) ?? null;
  }

  private async receive(raw: unknown): Promise<void> {
    const message = raw as {
      type?: unknown; path?: unknown; id?: unknown; base?: unknown; name?: unknown;
      field?: unknown; value?: unknown; selected?: unknown;
    };

    if (message?.type === 'select') {
      if (typeof message.path === 'string') await this.select(message.path);
      return;
    }

    // Typed without re-rendering: the page answers its own preview, and this is only so that acting
    // on the draft never has to trust what arrives with the click.
    if (message?.type === 'draft' && typeof message.value === 'string') {
      if (message.field === 'copy-id') this.draft.id = message.value;
      else if (message.field === 'copy-base') this.draft.base = message.value;
      return;
    }

    if (message?.type === 'edit-draft' && message.field === 'edit-name'
      && typeof message.value === 'string' && this.edit.open) {
      this.edit.name = message.value;
      return;
    }

    if (message?.type === 'edit-cancel') {
      this.edit = { ...EMPTY_EDIT_DRAFT };
      this.error = null;
      return this.render();
    }

    if (message?.type === 'edit-capability' && typeof message.id === 'string' && this.edit.open) {
      const known = (this.details?.availableCapabilities ?? []).some((choice) => choice.id === message.id)
        || this.edit.capabilities.includes(message.id);
      if (!known) return;
      const capabilities = new Set(this.edit.capabilities);
      if (message.selected === true) capabilities.add(message.id);
      else capabilities.delete(message.id);
      this.edit.capabilities = [...capabilities];
      this.error = null;
      return this.render();
    }

    if (message?.type === 'create') { await this.onMessage({ type: 'create' }); return; }

    const row = this.rowFor(message?.path);
    if (!row) return;

    if (message.type === 'edit') {
      this.edit = {
        open: true,
        name: this.details?.workspace.name ?? row.name,
        capabilities: [...(this.details?.workspace.capabilities ?? [])],
        busy: false
      };
      this.error = null;
      return this.render();
    }

    if (message.type === 'edit-save') {
      const name = (typeof message.name === 'string' ? message.name : this.edit.name).trim();
      const capabilities = this.edit.capabilities.map((value) => value.trim()).filter(Boolean);
      if (!this.edit.open || !name || !capabilities.length || this.edit.busy) return;
      this.edit.busy = true;
      this.error = null;
      this.render();
      const failure = await this.onMessage({
        type: 'run', command: updateCommand(row, name, capabilities), title: `Updating ${row.name}`
      });
      this.error = failure;
      if (failure) {
        this.edit = { ...this.edit, busy: false };
        return this.render();
      }
      this.edit = { ...EMPTY_EDIT_DRAFT };
      return this.refresh();
    }

    if (message.type === 'switch') { await this.onMessage({ type: 'switch', row }); return; }

    if (message.type === 'forget') {
      const failure = await this.onMessage({ type: 'forget', row });
      this.error = failure;
      if (!failure && this.selected === row.path) this.selected = null;
      return this.refresh();
    }

    if (message.type === 'archive') {
      const failure = await this.onMessage({ type: 'archive', row });
      this.error = failure;
      if (!failure && this.selected === row.path) this.selected = null;
      return this.refresh();
    }

    if (message.type === 'restore') {
      const failure = await this.onMessage({ type: 'restore', row });
      this.error = failure;
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
