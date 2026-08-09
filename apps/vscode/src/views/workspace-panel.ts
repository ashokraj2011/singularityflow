/**
 * The workspace panel: the form, the pickers behind it, and the one command it finally runs.
 *
 * Every value the page reports is treated as a claim, not a fact. The page names a capability by
 * identifier and nothing more; whether it exists, what it ships from and where that is cloned from
 * are read from the organisation's own map, so a page that posts a capability nobody mapped changes
 * nothing.
 *
 * No repository is named here, by the page or by anyone. The clone list is what the chosen
 * capabilities ship from.
 */
import * as vscode from 'vscode';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import {
  capabilityChoices, derivedRepositories, effectiveLead, EMPTY_WORKSPACE_FORM, formCommand,
  formProblems, shippingCapabilities,
  workspaceFormHtml, WORKSPACE_FORM_SCRIPT,
  type CapabilityChoice, type RemoteCapability, type WorkspaceForm
} from './workspace-form.ts';
import { SingularityFlowClient, type CliLocation } from '../cli/client.ts';

export interface WorkspaceCreated {
  directory: string;
  lead: string;
  leadDirectory: string;
  /** The orphan branch the workspace records its governance on. */
  stateBranch: string | null;
}

/** What the organisation read returns, of the parts this form uses. */
interface Organisation {
  capabilities: RemoteCapability[] | null;
  repositories?: Record<string, { url?: string; defaultBranch?: string }>;
}

export class WorkspacePanel {
  private static current: WorkspacePanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly location: CliLocation;
  private readonly output: vscode.OutputChannel;
  private readonly onCreated: (created: WorkspaceCreated) => Promise<void>;
  private readonly onOpenCapabilities: () => Promise<void>;
  private readonly disposables: vscode.Disposable[] = [];
  private form: WorkspaceForm = { ...EMPTY_WORKSPACE_FORM };

  private constructor(
    panel: vscode.WebviewPanel,
    location: CliLocation,
    output: vscode.OutputChannel,
    onCreated: (created: WorkspaceCreated) => Promise<void>,
    onOpenCapabilities: () => Promise<void>
  ) {
    this.panel = panel;
    this.location = location;
    this.output = output;
    this.onCreated = onCreated;
    this.onOpenCapabilities = onOpenCapabilities;
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void vscode.commands.executeCommand(navigation);
 void this.receive(raw); }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
    void this.loadOrganisations();
  }

  static show(
    context: vscode.ExtensionContext,
    location: CliLocation,
    output: vscode.OutputChannel,
    onCreated: (created: WorkspaceCreated) => Promise<void>,
    onOpenCapabilities: () => Promise<void> = async () => {}
  ): WorkspacePanel {
    if (WorkspacePanel.current) {
      WorkspacePanel.current.panel.reveal(vscode.ViewColumn.Active);
      // A capability may have been mapped while this retained panel was hidden. Re-read rather than
      // revealing the stale "no capabilities" snapshot that originally opened the form.
      void WorkspacePanel.current.refreshCapabilityMap();
      return WorkspacePanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.workspace', 'New workspace', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    WorkspacePanel.current = new WorkspacePanel(panel, location, output, onCreated, onOpenCapabilities);
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

  private client(): SingularityFlowClient {
    return new SingularityFlowClient({
      location: this.location, repository: this.form.base ?? process.cwd(), onOutput: () => {}
    });
  }

  /**
   * The organisations already mapped, and — when there is only one — its map straight away.
   *
   * A single organisation is the ordinary case, and asking which of one to use is a question with no
   * information in it.
   */
  private async loadOrganisations(): Promise<void> {
    let leads: { url?: string }[] = [];
    try {
      leads = await this.client().run<{ url?: string }[]>(['capability', 'leads', '--json']);
    } catch (error) {
      this.update({ error: (error as Error).message });
      return;
    }
    const organisations = leads.map((lead) => lead.url ?? '').filter(Boolean);
    const only = organisations.length === 1 ? organisations[0] : null;
    const current = this.form.organisation && organisations.includes(this.form.organisation)
      ? this.form.organisation
      : null;
    const selected = current ?? only;
    this.update({
      organisations,
      organisation: selected,
      capabilities: null,
      capabilitiesReason: null,
      reading: Boolean(selected),
      error: null
    });
    if (selected) await this.readOrganisation(selected);
  }

  /** Return from capability setup without losing the workspace directory or identity already typed. */
  async refreshCapabilityMap(): Promise<void> {
    this.panel.reveal(vscode.ViewColumn.Active);
    await this.loadOrganisations();
  }

  /**
   * Read one organisation's capability map.
   *
   * Nothing is cloned to answer this: the map and the repository URLs it refers to are read from the
   * remote. An organisation with no map is reported as the ordinary state of a new organisation
   * rather than as a failure, because the answer is to go and map one, not to try again.
   */
  private async readOrganisation(url: string): Promise<void> {
    let capabilities: CapabilityChoice[] | null = null;
    let capabilitiesReason: string | null = null;
    try {
      const organisation = await this.client().run<Organisation>(
        ['capability', 'organisation', url, '--json']);
      capabilities = organisation.capabilities
        ? capabilityChoices(organisation.capabilities, organisation.repositories ?? {})
        : null;
      if (!capabilities?.length) {
        capabilitiesReason = 'This organisation does not describe what it builds yet.';
      }
    } catch (error) {
      capabilitiesReason = (error as Error).message;
    }
    this.update({
      capabilities, capabilitiesReason, selected: [], leadCapability: null, reading: false
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

    if (message.type === 'open' && message.what === 'capabilities') {
      await this.onOpenCapabilities();
      return;
    }

    if (message.type === 'capability' && typeof message.id === 'string') {
      // Resolved against the map rather than trusted: the page can name anything it likes.
      const known = (this.form.capabilities ?? []).some((entry) => entry.id === message.id);
      if (!known) return;
      const selected = new Set(this.form.selected);
      if (message.selected === true) selected.add(message.id);
      else selected.delete(message.id);
      this.update({ selected: [...selected], error: null });
      return;
    }

    // A keystroke is recorded and nothing else: replacing the document under whoever is typing would
    // take the caret with it. The same value arrives again as a field once it is committed.
    if (message.type === 'draft' && typeof message.value === 'string') {
      if (message.field === 'id') this.form.id = message.value;
      else if (message.field === 'name') this.form.name = message.value;
      return;
    }

    if (message.type === 'field' && typeof message.value === 'string') {
      // Committed, so the summary below is redrawn against it.
      if (message.field === 'id') { this.update({ id: message.value }); return; }
      if (message.field === 'name') { this.update({ name: message.value }); return; }

      if (message.field === 'organisation') {
        // Changing the organisation invalidates everything read from the last one. Keeping a
        // selection from a different map would be worse than asking again.
        const url = this.form.organisations.includes(message.value) ? message.value : null;
        this.update({
          organisation: url, capabilities: null, capabilitiesReason: null,
          selected: [], leadCapability: null, reading: Boolean(url), error: null
        });
        if (url) await this.readOrganisation(url);
        return;
      }

      if (message.field === 'lead-capability') {
        // Only a capability that ships can lead: leading means carrying the state branch.
        const lead = shippingCapabilities(this.form).find((entry) => entry.id === message.value);
        if (lead) this.update({ leadCapability: lead.id, error: null });
        return;
      }
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
      const lead = result.workspace?.leadRepository ?? effectiveLead(this.form)?.repository ?? '';
      // dispose() rather than panel.dispose(): closing the panel has to clear the singleton in
      // the same tick, or opening the screen again reveals the panel that was just closed.
      this.dispose();
      await this.onCreated({
        directory, lead, leadDirectory: `${directory}/repos/${lead}`, stateBranch: 'state'
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
