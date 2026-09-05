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
  EMPTY_CONFIGURATION_REFRESH, EMPTY_DRAFT, EMPTY_EDIT_DRAFT, workspacesHtml, WORKSPACES_SCRIPT,
  type DuplicateDraft, type WorkspaceConfigurationRefreshView, type WorkspaceEditDraft
} from './workspaces-page.ts';
import {
  duplicateCommand, duplicateProblems, renameCommand, updateCommand, workspaceRows,
  WORKSPACE_ACTION_CANCELLED,
  type WorkspaceConfigurationRefreshResult, type WorkspaceConfigurationResolution,
  type WorkspaceCapabilityAttachScope, type WorkspaceEntry, type WorkspaceRow, type WorkspaceStatus
} from './workspaces-model.ts';

export type WorkspacesMessage =
  | { type: 'switch'; row: WorkspaceRow }
  | { type: 'create'; organisation: string | null; capabilityId: string | null }
  | { type: 'adopt' }
  | { type: 'forget'; row: WorkspaceRow }
  | { type: 'archive'; row: WorkspaceRow }
  | { type: 'restore'; row: WorkspaceRow }
  | { type: 'repair'; row: WorkspaceRow }
  | {
      type: 'attach-capability'; row: WorkspaceRow; capabilityId: string;
      /** Trusted repository-inspection authority, owned by the panel rather than the webview. */
      expectedAuthority: WorkspaceCapabilityAttachScope['authority'] | null;
      /** A panel-owned lease that expires when the visible workspace editor changes. */
      isCurrent: () => boolean;
    }
  | {
      type: 'detach-capability'; row: WorkspaceRow; capabilityId: string; dropLocal: boolean;
      /** A panel-owned lease that expires when the visible workspace editor changes. */
      isCurrent: () => boolean;
    }
  | { type: 'run'; command: string[]; title: string };

export class WorkspacesPanel {
  private static current: WorkspacesPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly onMessage: (message: WorkspacesMessage) => Promise<string | null>;
  private readonly reload: () => Promise<WorkspaceEntry[]>;
  private readonly loadDetails: (path: string) => Promise<WorkspaceStatus>;
  private readonly refreshConfiguration: (
    path: string | null,
    request: {
      dryRun: boolean;
      planId?: string | null;
      resolutions: Record<string, WorkspaceConfigurationResolution>;
    }
  ) => Promise<WorkspaceConfigurationRefreshResult>;
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
  private manageRevision = 0;
  private repairPath: string | null = null;
  private requestedCapabilityIds: string[] = [];
  private attachScope: WorkspaceCapabilityAttachScope | null = null;
  private configuration: WorkspaceConfigurationRefreshView = {
    ...EMPTY_CONFIGURATION_REFRESH, resolutions: {}
  };

  private constructor(
    panel: vscode.WebviewPanel,
    entries: WorkspaceEntry[],
    reload: () => Promise<WorkspaceEntry[]>,
    onMessage: (message: WorkspacesMessage) => Promise<string | null>,
    loadDetails: (path: string) => Promise<WorkspaceStatus>,
    refreshConfiguration: WorkspacesPanel['refreshConfiguration'],
    selected: string | null,
    attachScope: WorkspaceCapabilityAttachScope | null = null
  ) {
    this.panel = panel;
    this.reload = reload;
    this.onMessage = onMessage;
    this.loadDetails = loadDetails;
    this.refreshConfiguration = refreshConfiguration;
    this.attachScope = attachScope;
    this.rows = this.scopedRows(entries);
    this.requestedCapabilityIds = [...new Set(attachScope?.capabilityIds ?? [])];
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
    refreshConfiguration: WorkspacesPanel['refreshConfiguration'],
    selected: string | null = null,
    upgradeScope: 'selected' | 'all' | null = null,
    attachScope: WorkspaceCapabilityAttachScope | null = null
  ): WorkspacesPanel {
    if (WorkspacesPanel.current) {
      WorkspacesPanel.current.setAttachScope(attachScope);
      WorkspacesPanel.current.panel.reveal(vscode.ViewColumn.Active);
      const upgradeSelection = upgradeScope
        ? selected ?? WorkspacesPanel.current.rows.find((row) => !row.archived)?.path ?? null
        : selected;
      // The panel is retained when hidden. Revealing its original rows made an old active marker
      // look authoritative even after the Navigator and CLI had switched workspaces. Re-read the
      // machine-wide registry every time the page is opened, preferring the explicitly clicked row
      // and otherwise the workspace that is active now.
      void WorkspacesPanel.current.refresh(upgradeSelection, true).then(() => {
        if (upgradeScope) return WorkspacesPanel.current?.previewConfiguration(upgradeScope);
        return undefined;
      });
      return WorkspacesPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.workspaces', 'Workspaces', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    const upgradeSelection = upgradeScope
      ? selected ?? entries.find((entry) => !entry.archivedAt)?.path ?? null
      : selected;
    WorkspacesPanel.current = new WorkspacesPanel(
      panel, entries, reload, onMessage, loadDetails, refreshConfiguration, upgradeSelection,
      attachScope
    );
    if (upgradeScope) {
      void WorkspacesPanel.current.refresh(upgradeSelection, true)
        .then(() => WorkspacesPanel.current?.previewConfiguration(upgradeScope));
    }
    return WorkspacesPanel.current;
  }

  /** Keep an already-open panel in step with a workspace switch performed by another surface. */
  static async activeWorkspaceChanged(path: string | null = null): Promise<void> {
    if (WorkspacesPanel.current) await WorkspacesPanel.current.refresh(path, true);
  }

  private initialSelection(selected: string | null): string | null {
    if (selected && this.rows.some((row) => row.path === selected)) return selected;
    return this.rows.find((row) => row.active)?.path
      ?? (this.requestedCapabilityIds.length ? this.rows.find((row) => !row.archived)?.path ?? null : null);
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page(
      'Workspaces',
      workspacesHtml(
        this.rows, this.selected, this.draft, this.error,
        this.details, this.detailsLoading, this.detailError, this.edit, this.configuration,
        this.repairPath === this.selected, this.attachScope
      ),
      contentSecurityPolicy(this.panel.webview, token),
      token,
      WORKSPACES_SCRIPT
    );
  }

  private async refresh(preferred: string | null = null, preferActive = false): Promise<void> {
    this.rows = this.scopedRows(await this.reload());
    const requested = preferred && this.rows.some((row) => row.path === preferred) ? preferred : null;
    const active = this.rows.find((row) => row.active)?.path ?? null;
    const retained = this.selected && this.rows.some((row) => row.path === this.selected)
      ? this.selected : null;
    const next = requested ?? (preferActive ? active : retained ?? active)
      ?? (this.requestedCapabilityIds.length ? this.rows.find((row) => !row.archived)?.path ?? null : null);
    if (next) {
      await this.select(next);
    } else {
      this.selected = null;
      this.details = null;
      this.render();
    }
  }

  /** Never let a repository-inspection handoff select or offer a workspace from another authority. */
  private scopedRows(entries: WorkspaceEntry[]): WorkspaceRow[] {
    const rows = workspaceRows(entries);
    if (!this.attachScope) return rows;
    const allowed = new Set(this.attachScope.matchingPaths);
    return rows.filter((row) => allowed.has(row.path));
  }

  private setAttachScope(scope: WorkspaceCapabilityAttachScope | null): void {
    this.attachScope = scope;
    this.requestedCapabilityIds = [...new Set(scope?.capabilityIds ?? [])];
    // A retained panel may still be loading details for a workspace which is outside the new
    // authority boundary. Expire both that response and every open Manage action lease.
    this.detailRequest++;
    this.manageRevision++;
    this.edit = { ...EMPTY_EDIT_DRAFT };
    this.details = null;
    this.detailError = null;
    if (scope) {
      const allowed = new Set(scope.matchingPaths);
      this.rows = this.rows.filter((row) => allowed.has(row.path));
      if (!this.selected || !allowed.has(this.selected)) this.selected = null;
    }
    // Do not leave the previously rendered authority on screen while the registry refresh runs.
    this.render();
  }

  private async select(path: string, {
    preserveError = false,
    preserveEdit = false
  }: { preserveError?: boolean; preserveEdit?: boolean } = {}): Promise<void> {
    if (!this.rows.some((row) => row.path === path)) return;
    this.manageRevision++;
    const request = ++this.detailRequest;
    this.selected = path;
    this.draft = { ...EMPTY_DRAFT };
    if (!preserveEdit) this.edit = { ...EMPTY_EDIT_DRAFT };
    if (!preserveError) this.error = null;
    this.detailError = null;
    this.details = null;
    this.detailsLoading = true;
    this.configuration = { ...EMPTY_CONFIGURATION_REFRESH, resolutions: {} };
    this.render();
    try {
      const details = await this.loadDetails(path);
      if (request !== this.detailRequest) return;
      this.details = details;
      this.openRequestedCapabilityManager(details);
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

  /** Open Manage only after the selected workspace's approved map proves the requested ID. */
  private openRequestedCapabilityManager(details: WorkspaceStatus): void {
    if (!this.requestedCapabilityIds.length) return;
    const available = new Set((details.availableCapabilities ?? []).map((choice) => choice.id));
    const preferred = this.requestedCapabilityIds.find((id) => available.has(id)) ?? null;
    this.requestedCapabilityIds = [];
    if (!preferred) return;
    this.manageRevision++;
    this.edit = {
      open: true,
      name: details.workspace.name,
      capabilities: [...(details.workspace.capabilities ?? [])],
      preferredCapabilityId: preferred,
      busy: false
    };
  }

  /**
   * Every message this panel speaks, enumerated. `[UXH:REQ-134]` `[UXH:AC-014]`
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
    'open-help-topic': (message) => {
      const topic = stringField(message, 'topic');
      if (!topic || !['configuration', 'workspaces-and-sessions'].includes(topic)) return;
      return vscode.commands.executeCommand('singularityFlow.explainError', topic);
    },
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
      if (value !== null && stringField(message, 'field') === 'edit-name' && this.edit.open) {
        this.manageRevision++;
        this.edit.name = value;
      }
    },
    'edit-cancel': () => {
      this.manageRevision++;
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
      this.manageRevision++;
      const capabilities = new Set(this.edit.capabilities);
      if (booleanField(message, 'selected')) capabilities.add(id);
      else capabilities.delete(id);
      this.edit.capabilities = [...capabilities];
      this.error = null;
      this.render();
    },
    create: () => this.onMessage({
      type: 'create',
      organisation: this.attachScope?.authority.leadUrl ?? null,
      capabilityId: this.attachScope?.capabilityIds[0] ?? null
    }).then(() => undefined),
    adopt: () => this.onMessage({ type: 'adopt' }).then(() => undefined),
    edit: (message) => this.withRow(message, (row) => {
      if (row.path !== this.selected || this.details?.workspace.path !== row.path) return;
      this.manageRevision++;
      this.edit = {
        open: true,
        name: this.details?.workspace.name ?? row.name,
        capabilities: [...(this.details?.workspace.capabilities ?? [])],
        preferredCapabilityId: null,
        busy: false
      };
      this.error = null;
      this.render();
    }),
    'edit-save': (message) => this.withRow(message, (row) => this.saveEdit(row, stringField(message, 'name'))),
    'capability-attach': (message) => this.withSelectedDetailsRow(message, (row) => {
      const id = stringField(message, 'id');
      const known = id && (this.details?.availableCapabilities ?? []).some((choice) => choice.id === id);
      if (!known) return;
      return this.actOnCapability(row, id, 'attach', false);
    }, true),
    'capability-detach': (message) => this.withSelectedDetailsRow(message, (row) => {
      const id = stringField(message, 'id');
      const attached = id && (this.details?.workspace.capabilities ?? []).includes(id);
      if (!attached) return;
      return this.actOnCapability(row, id, 'detach', booleanField(message, 'dropLocal'));
    }, true),
    switch: (message) => this.withRow(message, (row) => this.onMessage({ type: 'switch', row }).then(() => undefined)),
    forget: (message) => this.withRow(message, (row) => this.actOnRow(row, 'forget', true)),
    archive: (message) => this.withRow(message, (row) => this.actOnRow(row, 'archive', true)),
    restore: (message) => this.withRow(message, (row) => this.actOnRow(row, 'restore', false)),
    repair: (message) => this.withSelectedDetailsRow(message, (row) => this.repair(row)),
    'configuration-preview': (message) => {
      const scope = stringField(message, 'scope');
      if (scope !== 'selected' && scope !== 'all') return;
      return this.previewConfiguration(scope);
    },
    'configuration-resolution': (message) => {
      const conflictPath = stringField(message, 'path');
      const resolution = stringField(message, 'resolution');
      if (!conflictPath || !['local', 'bundled', 'merge'].includes(resolution ?? '')) return;
      const known = this.configuration.result?.results.some((repository) =>
        repository.conflicts?.some((conflict) => conflict.path === conflictPath));
      if (!known) return;
      this.configuration.resolutions[conflictPath] = resolution as WorkspaceConfigurationResolution;
      this.configuration.error = null;
      return this.previewConfiguration(this.configuration.scope);
    },
    'configuration-bundled-assets': () => {
      for (const repository of this.configuration.result?.results ?? []) {
        for (const conflict of repository.conflicts ?? []) {
          if (conflict.path.startsWith('singularity/templates/')
            || conflict.path.startsWith('singularity/prompts/')
            || conflict.path.startsWith('.github/agents/')) {
            this.configuration.resolutions[conflict.path] = 'bundled';
          }
        }
      }
      this.configuration.error = null;
      return this.previewConfiguration(this.configuration.scope);
    },
    'configuration-packaged-agents': () => {
      const paths = new Set(this.configuration.result?.results.flatMap((repository) =>
        repository.repair?.kind === 'packaged-agents' ? repository.repair.paths : []) ?? []);
      // A blocked preview owns this list. The page never supplies a path, and selecting the repair
      // only asks the engine for another preview; publication still requires the resulting plan.
      for (const agentPath of paths) this.configuration.resolutions[agentPath] = 'bundled';
      if (!paths.size) return;
      this.configuration.error = null;
      return this.previewConfiguration(this.configuration.scope);
    },
    'configuration-apply': () => this.applyConfiguration(),
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

  /** Capability and repair actions are authorized by the detail snapshot currently on screen. */
  private async withSelectedDetailsRow(
    message: InboundMessage,
    action: (row: WorkspaceRow) => unknown,
    requireEdit = false
  ): Promise<void> {
    const row = this.rowFor(stringField(message, 'path') ?? undefined);
    if (!row || this.detailsLoading || row.path !== this.selected
      || this.details?.workspace.path !== row.path || (requireEdit && !this.edit.open)) return;
    await action(row);
  }

  private async saveEdit(row: WorkspaceRow, supplied: string | null): Promise<void> {
    const name = (supplied ?? this.edit.name).trim();
    if (!this.edit.open || !name || this.edit.busy) return;
    this.edit.busy = true;
    this.error = null;
    this.render();
    const failure = await this.onMessage({
      type: 'run', command: updateCommand(row, name), title: `Updating ${row.name}`
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

  private async actOnCapability(
    row: WorkspaceRow,
    capabilityId: string,
    action: 'attach' | 'detach',
    dropLocal: boolean
  ): Promise<void> {
    if (!this.edit.open || this.edit.busy || this.selected !== row.path) return;
    const revision = this.manageRevision;
    const isCurrent = (): boolean => this.manageRevision === revision
      && this.edit.open && this.selected === row.path
      && this.details?.workspace.path === row.path;
    this.edit = { ...this.edit, busy: true };
    this.error = null;
    this.render();
    let failure: string | null;
    try {
      failure = await this.onMessage(action === 'attach'
        ? {
            type: 'attach-capability', row, capabilityId,
            expectedAuthority: this.attachScope?.authority ?? null, isCurrent
          }
        : { type: 'detach-capability', row, capabilityId, dropLocal, isCurrent });
    } catch (error) {
      failure = (error as Error).message;
    }
    // Selection may travel A → B → A while the CLI is applying. The path alone cannot prove that
    // this is still the editor which authorized the operation; the panel-owned revision can.
    if (!isCurrent()) {
      // The command may have durably completed, but a newer Manage session owns the page now.
      // Its selection, draft, and errors must not be replaced by this older response. The shared
      // workspace tree is refreshed by the command host; the current page can be reloaded by its
      // owner when desired.
      return;
    }
    if (failure === WORKSPACE_ACTION_CANCELLED) {
      this.edit = { ...this.edit, busy: false };
      this.render();
      return;
    }
    this.error = failure;
    if (!failure) {
      this.edit = { ...EMPTY_EDIT_DRAFT };
      await this.select(row.path);
      return;
    }
    this.edit = { ...this.edit, busy: false };
    await this.select(row.path, { preserveError: true, preserveEdit: true });
  }

  private async previewConfiguration(scope: 'selected' | 'all'): Promise<void> {
    if (this.configuration.loading || this.configuration.applying
      || (scope === 'selected' && !this.selected)) return;
    if (scope !== this.configuration.scope) {
      this.configuration = { ...EMPTY_CONFIGURATION_REFRESH, scope, resolutions: {} };
    }
    this.configuration.loading = true;
    this.configuration.error = null;
    this.render();
    try {
      this.configuration.result = await this.refreshConfiguration(
        scope === 'selected' ? this.selected : null,
        { dryRun: true, resolutions: { ...this.configuration.resolutions } }
      );
    } catch (error) {
      this.configuration.result = null;
      this.configuration.error = (error as Error).message;
    } finally {
      this.configuration.loading = false;
      this.render();
    }
  }

  private async applyConfiguration(): Promise<void> {
    const planId = this.configuration.result?.planId;
    if (!planId || this.configuration.loading || this.configuration.applying || !this.selected) return;
    this.configuration.applying = true;
    this.configuration.error = null;
    this.render();
    try {
      const result = await this.refreshConfiguration(
        this.configuration.scope === 'selected' ? this.selected : null,
        {
          dryRun: false,
          planId,
          resolutions: { ...this.configuration.resolutions }
        }
      );
      this.configuration.result = result;
      this.configuration.applying = false;
      this.render();
      return;
    } catch (error) {
      this.configuration.error = (error as Error).message;
    } finally {
      this.configuration.applying = false;
      this.render();
    }
  }

  /** Repair is independently guarded because a double-click must not start two clone/fetch waves. */
  private async repair(row: WorkspaceRow): Promise<void> {
    if (this.repairPath) return;
    this.repairPath = row.path;
    this.error = null;
    this.render();
    let failure: string | null;
    try {
      failure = await this.onMessage({ type: 'repair', row });
    } catch (error) {
      failure = (error as Error).message;
    } finally {
      this.repairPath = null;
    }
    if (failure === WORKSPACE_ACTION_CANCELLED) {
      this.render();
      return;
    }
    if (this.selected !== row.path) {
      this.render();
      return;
    }
    this.error = failure;
    await this.select(row.path, { preserveError: Boolean(failure), preserveEdit: Boolean(failure) });
  }

  /** The three that differ only in verb and whether a success clears the selection. */
  private async actOnRow(row: WorkspaceRow, type: 'forget' | 'archive' | 'restore', clearsSelection: boolean): Promise<void> {
    const failure = await this.onMessage({ type, row });
    if (failure === WORKSPACE_ACTION_CANCELLED) return;
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
    this.manageRevision++;
    this.edit = { ...EMPTY_EDIT_DRAFT };
    this.detailRequest++;
    WorkspacesPanel.current = null;
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
