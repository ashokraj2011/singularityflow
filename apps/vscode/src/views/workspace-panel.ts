/**
 * The workspace panel: the form, the pickers behind it, and the one command it finally runs.
 *
 * Every value the page reports is treated as a claim, not a fact. The page supplies a URL and
 * nothing else about a repository: the identifier, the default branch and whether the state branch
 * exists are read from the remote by `workspace inspect`, and the page can only rename a row or
 * remove one afterwards.
 */
import * as vscode from 'vscode';
import { contentSecurityPolicy, nonce, page } from './webview.ts';
import {
  derivedRepositories, draftUrls, EMPTY_DRAFT, EMPTY_FORM, flattenChoices, formCommand,
  formProblems, hasCapabilityMap,
  workspaceFormHtml, WORKSPACE_FORM_SCRIPT,
  type CapabilityChoice, type FormRepository, type RemoteCapability, type RemoteDelivery,
  type WorkspaceForm
} from './workspace-form.ts';
import { SingularityFlowClient, type CliLocation } from '../cli/client.ts';

export interface WorkspaceCreated {
  directory: string;
  lead: string;
  leadDirectory: string;
  /** The branch the form asked for, or null when it asked for none. */
  stateBranch: string | null;
}

export class WorkspacePanel {
  private static current: WorkspacePanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly location: CliLocation;
  private readonly output: vscode.OutputChannel;
  private readonly onCreated: (created: WorkspaceCreated) => Promise<void>;
  private readonly disposables: vscode.Disposable[] = [];
  private form: WorkspaceForm = {
    ...EMPTY_FORM, repositories: [], selected: [], draft: { ...EMPTY_DRAFT }
  };

  private constructor(
    panel: vscode.WebviewPanel,
    location: CliLocation,
    output: vscode.OutputChannel,
    onCreated: (created: WorkspaceCreated) => Promise<void>
  ) {
    this.panel = panel;
    this.location = location;
    this.output = output;
    this.onCreated = onCreated;
    this.panel.webview.onDidReceiveMessage((raw: unknown) => { void this.receive(raw); }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
  }

  static show(
    context: vscode.ExtensionContext,
    location: CliLocation,
    output: vscode.OutputChannel,
    onCreated: (created: WorkspaceCreated) => Promise<void>
  ): WorkspacePanel {
    if (WorkspacePanel.current) {
      WorkspacePanel.current.panel.reveal(vscode.ViewColumn.Active);
      return WorkspacePanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.workspace', 'New workspace', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    WorkspacePanel.current = new WorkspacePanel(panel, location, output, onCreated);
    return WorkspacePanel.current;
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page(
      'New workspace',
      workspaceFormHtml(this.form),
      contentSecurityPolicy(this.panel.webview, token),
      token,
      WORKSPACE_FORM_SCRIPT
    );
  }

  private update(changes: Partial<WorkspaceForm>): void {
    this.form = { ...this.form, ...changes };
    this.render();
  }

  /**
   * Read what a workspace would record for each URL, from the remote.
   *
   * `workspace inspect` uses ls-remote, so nothing is cloned to answer this — the clone happens once,
   * at creation. A URL that cannot be reached is named while somebody is still typing rather than
   * when the clone fails minutes later.
   */
  private async inspect(urls: string[]): Promise<{ added: FormRepository[]; failures: string[] }> {
    const added: FormRepository[] = [];
    const failures: string[] = [];
    for (const url of urls) {
      try {
        const client = new SingularityFlowClient({
          location: this.location, repository: this.form.base ?? process.cwd(), onOutput: () => {}
        });
        const stateBranch = this.form.stateBranch.trim();
        const defaults = await client.run<FormRepository>([
          'workspace', 'inspect', url, '--json',
          ...(stateBranch ? ['--state-branch', stateBranch] : [])
        ]);
        added.push({
          id: defaults.id,
          url: defaults.url,
          defaultBranch: defaults.defaultBranch,
          hasStateBranch: Boolean(defaults.hasStateBranch),
          stateBranch: defaults.stateBranch ?? stateBranch ?? 'state'
        });
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
    return { added, failures };
  }

  /**
   * Read the lead repository: what a workspace would record for it, and the map it holds.
   *
   * Both come from the same URL and neither clones it. The map is what the rest of the form is made
   * of, so this is the step everything else waits on — and a lead with no map is reported as the
   * normal state it is rather than as a failure to read one.
   */
  private async readLead(): Promise<void> {
    const url = this.form.leadDraft.trim();
    if (!url || this.form.adding) return;
    this.update({ adding: true, error: null });

    const { added, failures } = await this.inspect([url]);
    const lead = added[0];
    if (!lead) {
      this.update({ adding: false, error: failures.join(' ') || `Could not read '${url}'.` });
      return;
    }

    let capabilities: CapabilityChoice[] | null = null;
    let capabilitiesReason: string | null = null;
    try {
      const map = await this.client().run<{
        capabilities: RemoteCapability[] | null;
        deliveries: RemoteDelivery[];
        reason: string | null;
      }>(['workspace', 'capabilities', url, '--json']);
      capabilitiesReason = map.reason;
      capabilities = map.capabilities ? flattenChoices(map.capabilities, map.deliveries) : null;
    } catch (error) {
      // Failing to read the map does not invalidate the lead: the repositories can still be named
      // directly, which is exactly the fallback a repository without a map uses.
      capabilitiesReason = (error as Error).message;
    }

    this.update({
      lead, capabilities, capabilitiesReason, selected: [], adding: false, error: null
    });
  }

  private client(): SingularityFlowClient {
    return new SingularityFlowClient({
      location: this.location, repository: this.form.base ?? process.cwd(), onOutput: () => {}
    });
  }

  /**
   * Add what the draft describes.
   *
   * This is the fallback for a lead repository with no capability map. Only the URL is required;
   * everything else is read from its remote. A typed identifier renames the one repository it can
   * unambiguously refer to — with several URLs there is no such repository, so it is ignored and the
   * form says so before the button is pressed.
   *
   * A URL that cannot be read is reported on the form rather than in a notification: it is a fact
   * about what was just typed, and it belongs beside the field it was typed into.
   */
  private async addDrafted(): Promise<void> {
    const urls = draftUrls(this.form.draft);
    if (!urls.length || this.form.adding || hasCapabilityMap(this.form)) return;
    const named = urls.length === 1 ? this.form.draft.id.trim() : '';
    this.update({ adding: true, error: null });

    const { added, failures } = await this.inspect(urls);
    const known = new Set([
      ...this.form.repositories.map((repository) => repository.url),
      ...(this.form.lead ? [this.form.lead.url] : [])
    ]);
    const fresh = added
      .filter((entry) => !known.has(entry.url))
      .map((entry) => (named ? { ...entry, id: named } : entry));

    this.update({
      repositories: [...this.form.repositories, ...fresh],
      draft: fresh.length ? { ...EMPTY_DRAFT } : this.form.draft,
      adding: false,
      error: failures.join(' ') || null
    });
  }

  private async receive(raw: unknown): Promise<void> {
    const message = raw as {
      type?: unknown; what?: unknown; id?: unknown; field?: unknown; value?: unknown;
      selected?: unknown;
    };
    if (typeof message?.type !== 'string') return;

    if (message.type === 'choose' && message.what === 'base') {
      const picked = await vscode.window.showOpenDialog({
        title: 'Where should the workspace directory be created?',
        openLabel: 'Create here',
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false
      });
      if (picked?.[0]) this.update({ base: picked[0].fsPath });
      return;
    }

    // Typed values are recorded without re-rendering: replacing the document on every keystroke
    // would move the caret out from under whoever is typing. The form is redrawn when the data
    // changes — a repository added or removed — not when a character is.
    if (message.type === 'draft' && typeof message.value === 'string') {
      if (message.field === 'lead') this.form.leadDraft = message.value;
      else if (message.field === 'state-branch') this.form.stateBranch = message.value;
      else if (message.field === 'url' || message.field === 'id') this.form.draft[message.field] = message.value;
      return;
    }

    if (message.type === 'read-lead') return this.readLead();
    if (message.type === 'clear-lead') {
      // Changing the lead invalidates everything read from it. Keeping a capability selection from a
      // different organisation's map would be worse than asking again.
      this.update({
        lead: null, leadDraft: '', capabilities: null, capabilitiesReason: null,
        selected: [], repositories: [], error: null
      });
      return;
    }

    if (message.type === 'capability' && typeof message.id === 'string') {
      const known = (this.form.capabilities ?? []).some((entry) => entry.id === message.id);
      if (!known) return;
      const selected = new Set(this.form.selected);
      if (message.selected === true) selected.add(message.id);
      else selected.delete(message.id);
      this.update({ selected: [...selected], error: null });
      return;
    }

    if (message.type === 'add') return this.addDrafted();

    if (message.type === 'remove' && typeof message.id === 'string') {
      // Only the directly-named repositories can be removed; a derived one is removed by
      // deselecting the capability that brought it, and the lead cannot be removed at all.
      if (hasCapabilityMap(this.form) || message.id === this.form.lead?.id) return;
      this.update({ repositories: this.form.repositories.filter((entry) => entry.id !== message.id) });
      return;
    }

    if (message.type === 'field' && typeof message.value === 'string') {
      if (message.field === 'id') this.update({ id: message.value });
      else if (message.field === 'name') this.update({ name: message.value });
      return;
    }

    if (message.type === 'rename' && typeof message.id === 'string' && typeof message.value === 'string') {
      const renamed = message.value.trim();
      const repositories = this.form.repositories.map((repository) =>
        (repository.id === message.id ? { ...repository, id: renamed } : repository));
      this.update({ repositories });
      return;
    }

    if (message.type === 'create') await this.create();
  }

  private async create(): Promise<void> {
    // Re-checked here rather than trusted from the page: the disabled button is a courtesy, not a
    // guarantee, and a page can post whatever it likes.
    if (formProblems(this.form).length || this.form.busy) return;
    this.update({ busy: true, error: null });

    const args = formCommand(this.form);
    this.output.appendLine(`\n$ singularity-flow ${args.join(' ')}`);
    try {
      const client = new SingularityFlowClient({
        location: this.location,
        repository: this.form.base ?? '',
        onOutput: (text) => this.output.append(text)
      });
      const cloning = derivedRepositories(this.form).length;
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Cloning ${cloning} ${cloning === 1 ? 'repository' : 'repositories'}…`
        },
        () => client.run<{ workspace?: { path?: string; leadRepository?: string } }>(args));

      const directory = result.workspace?.path;
      if (!directory) throw new Error('The workspace was created but its directory was not reported.');
      const lead = result.workspace?.leadRepository ?? this.form.lead?.id ?? '';
      this.panel.dispose();
      await this.onCreated({
        directory, lead, leadDirectory: `${directory}/repos/${lead}`,
        stateBranch: this.form.stateBranch.trim() || null
      });
    } catch (error) {
      this.update({ busy: false, error: (error as Error).message });
    }
  }

  dispose(): void {
    WorkspacePanel.current = null;
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
