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
import { navigateTo } from './navigate.ts';
import { booleanField, registerMessageRouter, stringField } from './messages.ts';
import {
  capabilityChoices, derivedRepositories, effectiveLead, EMPTY_WORKSPACE_FORM, formCommand,
  formProblems, shippingCapabilities, WORKSPACE_PROFILE_ROLES,
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
  repositories?: Record<string, { url?: string; defaultBranch?: string; clone?: { mode?: string; sparseCone?: string[]; fallback?: string } }>;
  stale?: boolean;
  cacheAgeMs?: number | null;
  remoteError?: string | null;
}

export class WorkspacePanel {
  private static current: WorkspacePanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly location: CliLocation;
  private readonly output: vscode.OutputChannel;
  private readonly context: vscode.ExtensionContext;
  private readonly onCreated: (created: WorkspaceCreated) => Promise<void>;
  private readonly onOpenCapabilities: () => Promise<void>;
  private readonly disposables: vscode.Disposable[] = [];
  private form: WorkspaceForm = { ...EMPTY_WORKSPACE_FORM };

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    location: CliLocation,
    output: vscode.OutputChannel,
    onCreated: (created: WorkspaceCreated) => Promise<void>,
    onOpenCapabilities: () => Promise<void>
  ) {
    this.panel = panel;
    this.location = location;
    this.output = output;
    this.context = context;
    this.onCreated = onCreated;
    this.onOpenCapabilities = onOpenCapabilities;
    const settings = vscode.workspace.getConfiguration('singularityFlow');
    this.form = {
      ...EMPTY_WORKSPACE_FORM,
      profileName: settings.get<string>('userName') ?? '',
      profileRole: settings.get<string>('role') ?? ''
    };
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
 this.router.route(raw); }, null, this.disposables);
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
    WorkspacePanel.current = new WorkspacePanel(
      panel, context, location, output, onCreated, onOpenCapabilities);
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
  private async loadOrganisations(refresh = false): Promise<void> {
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
      capabilitiesNotice: null,
      reading: Boolean(selected),
      error: null
    });
    if (selected) await this.readOrganisation(selected, refresh);
  }

  /** Return from capability setup without losing the workspace directory or identity already typed. */
  async refreshCapabilityMap(): Promise<void> {
    this.panel.reveal(vscode.ViewColumn.Active);
    await this.loadOrganisations(true);
  }

  /**
   * Read one organisation's capability map.
   *
   * Nothing is cloned to answer this: the map and the repository URLs it refers to are read from the
   * remote. An organisation with no map is reported as the ordinary state of a new organisation
   * rather than as a failure, because the answer is to go and map one, not to try again.
   */
  private async readOrganisation(url: string, refresh = false): Promise<void> {
    let capabilities: CapabilityChoice[] | null = null;
    let capabilitiesReason: string | null = null;
    let capabilitiesNotice: string | null = null;
    try {
      const organisation = await this.client().run<Organisation>(
        ['capability', 'organisation', url, ...(refresh ? ['--refresh'] : []), '--json']);
      capabilities = organisation.capabilities
        ? capabilityChoices(organisation.capabilities, organisation.repositories ?? {})
        : null;
      if (organisation.stale) {
        const minutes = organisation.cacheAgeMs == null ? 'unknown age'
          : `${Math.max(0, Math.floor(organisation.cacheAgeMs / 60_000))} minute(s) old`;
        capabilitiesNotice = `Showing a validated cached capability map (${minutes}); the remote is unreachable${organisation.remoteError ? `: ${organisation.remoteError}` : '.'}`;
      }
      if (!capabilities?.length) {
        capabilitiesReason = 'This organisation does not describe what it builds yet.';
      }
    } catch (error) {
      capabilitiesReason = (error as Error).message;
    }
    this.update({
      capabilities, capabilitiesReason, capabilitiesNotice,
      selected: [], leadCapability: null, reading: false
    });
  }

  /**
   * The six messages this panel speaks, enumerated. `[UXH:REQ-134]` `[UXH:AC-014]`
   *
   * Every resolution against a known set is unchanged, and there are four of them — a capability id,
   * a profile role, an organisation URL and a lead capability are each checked against what this
   * panel loaded rather than trusted from the page. That is the security posture; the closed type
   * set is what it was missing.
   *
   * `draft` and `field` stay distinct. A keystroke is recorded and nothing else, because redrawing
   * the document under whoever is typing takes the caret with it; the same value arrives again as a
   * `field` once committed.
   */
  private router = registerMessageRouter('singularityFlow.workspaceForm', {
    choose: (message) => {
      if (stringField(message, 'what') === 'base') void this.chooseBase();
    },
    open: (message) => {
      if (stringField(message, 'what') === 'capabilities') void this.onOpenCapabilities();
    },
    capability: (message) => {
      const id = stringField(message, 'id');
      // Resolved against the map rather than trusted: the page can name anything it likes.
      if (!id || !(this.form.capabilities ?? []).some((entry) => entry.id === id)) return;
      const selected = new Set(this.form.selected);
      if (booleanField(message, 'selected')) selected.add(id);
      else selected.delete(id);
      this.update({ selected: [...selected], error: null });
    },
    draft: (message) => {
      const value = stringField(message, 'value');
      if (value === null) return;
      const field = stringField(message, 'field');
      if (field === 'id') this.form.id = value;
      else if (field === 'name') this.form.name = value;
      else if (field === 'profile-name') this.form.profileName = value;
    },
    field: (message) => { void this.commitField(stringField(message, 'field'), stringField(message, 'value')); },
    create: () => { void this.create(); }
  });

  private async chooseBase(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      title: 'Where should the workspace directory be created?',
      openLabel: 'Create here',
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false
    });
    if (picked?.[0]) this.update({ base: picked[0].fsPath });
  }

  private async commitField(field: string | null, value: string | null): Promise<void> {
    if (value === null) return;
    // Committed, so the summary below is redrawn against it.
    if (field === 'id') return this.update({ id: value });
    if (field === 'name') return this.update({ name: value });
    if (field === 'profile-name') return this.update({ profileName: value });
    if (field === 'profile-role') {
      const role = WORKSPACE_PROFILE_ROLES.includes(value as typeof WORKSPACE_PROFILE_ROLES[number]) ? value : '';
      return this.update({ profileRole: role });
    }
    if (field === 'organisation') {
      // Changing the organisation invalidates everything read from the last one. Keeping a
      // selection from a different map would be worse than asking again.
      const url = this.form.organisations.includes(value) ? value : null;
      this.update({
        organisation: url, capabilities: null, capabilitiesReason: null,
        capabilitiesNotice: null,
        selected: [], leadCapability: null, reading: Boolean(url), error: null
      });
      if (url) await this.readOrganisation(url);
      return;
    }
    if (field === 'lead-capability') {
      // Only a capability that ships can lead: leading means carrying the state branch.
      const lead = shippingCapabilities(this.form).find((entry) => entry.id === value);
      if (lead) this.update({ leadCapability: lead.id, error: null });
    }
  }

  private async create(): Promise<void> {
    // Re-checked here rather than trusted from the page: the disabled button is a courtesy, not a
    // guarantee, and a page can post whatever it likes.
    if (formProblems(this.form).length || this.form.busy) return;
    this.update({ busy: true, error: null });

    const args = formCommand(this.form);
    this.output.appendLine(`\n$ singularity-flow ${args.join(' ')}`);
    try {
      // The workspace form is also the first-run profile screen. Keep the profile in the one
      // machine-local store already used by onboarding and Configuration Center; it is never copied
      // into governed repository state or treated as approval identity.
      const settings = vscode.workspace.getConfiguration('singularityFlow');
      await Promise.all([
        settings.update('userName', this.form.profileName.trim(), vscode.ConfigurationTarget.Global),
        settings.update('role', this.form.profileRole, vscode.ConfigurationTarget.Global),
        this.context.globalState.update('onboardingComplete', true)
      ]);
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
