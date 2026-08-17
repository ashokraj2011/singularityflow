/**
 * The Workspaces panel: the list, and the three things you can do to a local workspace.
 *
 * Rename, copy, forget. All three are safe in a way governed operations are not, because a
 * workspace holds no record of its own — it is a directory of checkouts and a note of which
 * capabilities are worked on there. The one rule the panel enforces on top of the engine is that no
 * two of them occupy the same directory, and it enforces it by refusing before the command runs.
 */
import * as vscode from 'vscode';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { booleanField, registerMessageRouter, stringField, type InboundMessage } from './messages.ts';
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
    this.selected = this.initialSelection(selected);
    // Return the promise so sequential UI events (typing, then immediately saving) are observed in
    // order by hosts and test doubles that support async listeners. VS Code itself ignores the
    // return value, but the edit-save message also carries the current field value as a safeguard.
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      return this.router.route(raw);
    }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
    if (this.selected) void this.select(this.selected);
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
      // The panel is retained when hidden. Revealing its original rows made an old active marker
      // look authoritative even after the Navigator and CLI had switched workspaces. Re-read the
      // machine-wide registry every time the page is opened, preferring the explicitly clicked row
      // and otherwise the workspace that is active now.
      void WorkspacesPanel.current.refresh(selected, true);
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

  /** Keep an already-open panel in step with a workspace switch performed by another surface. */
  static async activeWorkspaceChanged(path: string | null = null): Promise<void> {
    if (WorkspacesPanel.current) await WorkspacesPanel.current.refresh(path, true);
  }

  private initialSelection(selected: string | null): string | null {
    if (selected && this.rows.some((row) => row.path === selected)) return selected;
    return this.rows.find((row) => row.active)?.path ?? null;
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

  private async refresh(preferred: string | null = null, preferActive = false): Promise<void> {
    this.rows = workspaceRows(await this.reload());
    const requested = preferred && this.rows.some((row) => row.path === preferred) ? preferred : null;
    const active = this.rows.find((row) => row.active)?.path ?? null;
    const retained = this.selected && this.rows.some((row) => row.path === this.selected)
      ? this.selected : null;
    const next = requested ?? (preferActive ? active : retained ?? active);
    if (next) {
      await this.select(next);
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

  /**
   * The fifteen messages this panel speaks, enumerated. `[UXH:REQ-134]` `[UXH:AC-014]`
   *
   * The chain this replaces had a *shared tail*: eight types fell past the early returns to
   * `const row = this.rowFor(message.path); if (!row) return;` and then branched again. That is the
   * pattern the enumerated map is worst at expressing naively and best at making explicit — so the
   * row resolution becomes `withRow`, which every one of those eight goes through. It resolves a
   * path against the rows this panel loaded, never trusting the page, exactly as before.
   *
   * Handlers return their promise. This panel's outer listener awaits, and discarding it would turn
   * a completed refresh into a race — the failure `evidence-manager` had for one commit.
   */
  private router = registerMessageRouter('singularityFlow.workspaces', {
    select: (message) => {
      const path = stringField(message, 'path');
      return path ? this.select(path) : undefined;
    },
    // Typed without re-rendering: the page answers its own preview, and this is only so that acting
    // on the draft never has to trust what arrives with the click.
    draft: (message) => {
      const value = stringField(message, 'value');
      if (value === null) return;
      const field = stringField(message, 'field');
      if (field === 'copy-id') this.draft.id = value;
      else if (field === 'copy-base') this.draft.base = value;
    },
    'edit-draft': (message) => {
      const value = stringField(message, 'value');
      if (value !== null && stringField(message, 'field') === 'edit-name' && this.edit.open) this.edit.name = value;
    },
    'edit-cancel': () => {
      this.edit = { ...EMPTY_EDIT_DRAFT };
      this.error = null;
      this.render();
    },
    'edit-capability': (message) => {
      const id = stringField(message, 'id');
      if (!id || !this.edit.open) return;
      const known = (this.details?.availableCapabilities ?? []).some((choice) => choice.id === id)
        || this.edit.capabilities.includes(id);
      if (!known) return;
      const capabilities = new Set(this.edit.capabilities);
      if (booleanField(message, 'selected')) capabilities.add(id);
      else capabilities.delete(id);
      this.edit.capabilities = [...capabilities];
      this.error = null;
      this.render();
    },
    create: () => this.onMessage({ type: 'create' }).then(() => undefined),
    edit: (message) => this.withRow(message, (row) => {
      this.edit = {
        open: true,
        name: this.details?.workspace.name ?? row.name,
        capabilities: [...(this.details?.workspace.capabilities ?? [])],
        busy: false
      };
      this.error = null;
      this.render();
    }),
    'edit-save': (message) => this.withRow(message, (row) => this.saveEdit(row, stringField(message, 'name'))),
    switch: (message) => this.withRow(message, (row) => this.onMessage({ type: 'switch', row }).then(() => undefined)),
    forget: (message) => this.withRow(message, (row) => this.actOnRow(row, 'forget', true)),
    archive: (message) => this.withRow(message, (row) => this.actOnRow(row, 'archive', true)),
    restore: (message) => this.withRow(message, (row) => this.actOnRow(row, 'restore', false)),
    rename: (message) => this.withRow(message, (row) => this.rename(row, stringField(message, 'name'))),
    duplicate: (message) => this.withRow(message, (row) => this.duplicate(row, message))
  });

  /**
   * Resolve the row a message is about, or do nothing.
   *
   * The shared tail of the old chain, named. A path is looked up against the rows this panel
   * loaded — the page names one, and which workspace that is comes from the registry read.
   */
  private async withRow(message: InboundMessage, action: (row: WorkspaceRow) => unknown): Promise<void> {
    const row = this.rowFor(stringField(message, 'path') ?? undefined);
    if (row) await action(row);
  }

  private async saveEdit(row: WorkspaceRow, supplied: string | null): Promise<void> {
    const name = (supplied ?? this.edit.name).trim();
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
      this.render();
      return;
    }
    this.edit = { ...EMPTY_EDIT_DRAFT };
    await this.refresh();
  }

  /** The three that differ only in verb and whether a success clears the selection. */
  private async actOnRow(row: WorkspaceRow, type: 'forget' | 'archive' | 'restore', clearsSelection: boolean): Promise<void> {
    const failure = await this.onMessage({ type, row });
    this.error = failure;
    if (clearsSelection && !failure && this.selected === row.path) this.selected = null;
    await this.refresh();
  }

  private async rename(row: WorkspaceRow, supplied: string | null): Promise<void> {
    const name = (supplied ?? '').trim();
    if (!name || name === row.name) return;
    const failure = await this.onMessage({
      type: 'run', command: renameCommand(row, name), title: `Renaming ${row.name}`
    });
    this.error = failure;
    await this.refresh();
  }

  private async duplicate(row: WorkspaceRow, message: InboundMessage): Promise<void> {
    // Re-checked here rather than trusted from the page: the disabled button is a courtesy, and
    // the directory rule is the one thing this screen exists to keep.
    const id = stringField(message, 'id') ?? this.draft.id;
    const base = stringField(message, 'base') ?? this.draft.base;
    const problems = duplicateProblems(row, id, base, this.rows);
    if (problems.length) {
      this.error = problems.join(' ');
      this.render();
      return;
    }
    this.draft = { ...this.draft, busy: true };
    this.error = null;
    this.render();
    const failure = await this.onMessage({
      type: 'run', command: duplicateCommand(row, id, base, ''), title: `Copying ${row.name}`
    });
    this.draft = failure ? { ...this.draft, busy: false } : { ...EMPTY_DRAFT };
    this.error = failure;
    await this.refresh();
  }

  dispose(): void {
    WorkspacesPanel.current = null;
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
