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
  draftUrls, EMPTY_DRAFT, EMPTY_FORM, formCommand, formProblems, workspaceFormHtml,
  WORKSPACE_FORM_SCRIPT, type FormRepository, type WorkspaceForm
} from './workspace-form.ts';
import { SingularityFlowClient, type CliLocation } from '../cli/client.ts';

export interface WorkspaceCreated {
  directory: string;
  lead: string;
  leadDirectory: string;
}

export class WorkspacePanel {
  private static current: WorkspacePanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly location: CliLocation;
  private readonly output: vscode.OutputChannel;
  private readonly onCreated: (created: WorkspaceCreated) => Promise<void>;
  private readonly disposables: vscode.Disposable[] = [];
  private form: WorkspaceForm = { ...EMPTY_FORM, repositories: [], draft: { ...EMPTY_DRAFT } };

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
        const defaults = await client.run<FormRepository>(['workspace', 'inspect', url, '--json']);
        added.push({
          id: defaults.id,
          url: defaults.url,
          defaultBranch: defaults.defaultBranch,
          hasStateBranch: Boolean(defaults.hasStateBranch),
          stateBranch: defaults.stateBranch ?? 'state'
        });
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
    return { added, failures };
  }

  /**
   * Add what the draft describes.
   *
   * Only the URL is required; everything else about a repository is read from its remote. A typed
   * identifier renames the one repository it can unambiguously refer to — with several URLs there is
   * no such repository, so it is ignored and the form says so before the button is pressed.
   *
   * A URL that cannot be read is reported on the form rather than in a notification: it is a fact
   * about what was just typed, and it belongs beside the field it was typed into.
   */
  private async addDrafted(): Promise<void> {
    const urls = draftUrls(this.form.draft);
    if (!urls.length || this.form.adding) return;
    const wantsLead = this.form.draft.lead;
    const named = urls.length === 1 ? this.form.draft.id.trim() : '';
    this.update({ adding: true, error: null });

    const { added, failures } = await this.inspect(urls);
    const known = new Set(this.form.repositories.map((repository) => repository.url));
    const fresh = added
      .filter((entry) => !known.has(entry.url))
      .map((entry) => (named ? { ...entry, id: named } : entry));
    const repositories = [...this.form.repositories, ...fresh];

    // The first repository added leads until someone says otherwise; a single-repository workspace
    // should not need a choice made about it.
    const nominated = wantsLead ? fresh[0]?.id ?? null : null;
    this.update({
      repositories,
      lead: nominated ?? this.form.lead ?? repositories[0]?.id ?? null,
      draft: fresh.length ? { ...EMPTY_DRAFT } : this.form.draft,
      adding: false,
      error: failures.join(' ') || null
    });
  }

  private async receive(raw: unknown): Promise<void> {
    const message = raw as {
      type?: unknown; what?: unknown; id?: unknown; field?: unknown; value?: unknown;
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
    if (message.type === 'draft' && typeof message.field === 'string') {
      const { field, value } = message;
      if (field === 'lead' && typeof value === 'boolean') this.form.draft.lead = value;
      else if ((field === 'url' || field === 'id') && typeof value === 'string') this.form.draft[field] = value;
      return;
    }

    if (message.type === 'add') return this.addDrafted();

    if (message.type === 'remove' && typeof message.id === 'string') {
      const repositories = this.form.repositories.filter((repository) => repository.id !== message.id);
      this.update({ repositories, lead: this.form.lead === message.id ? repositories[0]?.id ?? null : this.form.lead });
      return;
    }

    if (message.type === 'lead' && typeof message.id === 'string') {
      if (this.form.repositories.some((repository) => repository.id === message.id)) this.update({ lead: message.id });
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
      this.update({ repositories, lead: this.form.lead === message.id ? renamed : this.form.lead });
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
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Cloning ${this.form.repositories.length} ${this.form.repositories.length === 1 ? 'repository' : 'repositories'}…`
        },
        () => client.run<{ workspace?: { path?: string; leadRepository?: string } }>(args));

      const directory = result.workspace?.path;
      if (!directory) throw new Error('The workspace was created but its directory was not reported.');
      const lead = result.workspace?.leadRepository ?? this.form.lead ?? '';
      this.panel.dispose();
      await this.onCreated({ directory, lead, leadDirectory: `${directory}/repos/${lead}` });
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
