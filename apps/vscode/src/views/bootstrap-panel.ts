/**
 * The panel behind "map a capability".
 *
 * Registered and usable before any repository is open, which is the point: describing what an
 * organisation builds is not work done inside a checkout, and requiring one was the circular
 * dependency this whole screen exists to break.
 */
import * as vscode from 'vscode';
import { contentSecurityPolicy, nonce, page } from './webview.ts';
import {
  EMPTY_MAP_FORM, mapCapabilityHtml, mapCommand, mapProblems,
  MAP_CAPABILITY_SCRIPT, type MapCapabilityForm, type ParentChoice
} from './map-capability-form.ts';

/** The map as `capability organisation --json` reports it. */
export interface Organisation {
  governed: boolean;
  capabilities: Array<{ id: string; name: string; kind?: string; repository?: string | null; children: unknown[] }>;
}

export interface Mapped { capabilityId: string; repositoryId: string | null; lead: string }

type Run = (argv: string[]) => Promise<{ result: unknown; error: string | null }>;

/** Flatten the map into the parents a new capability may sit under. */
function parentChoices(nodes: Organisation['capabilities'], depth = 0): ParentChoice[] {
  return nodes.flatMap((node) => [
    { id: node.id, name: node.name, depth, ships: Boolean(node.repository) },
    ...parentChoices((node.children ?? []) as Organisation['capabilities'], depth + 1)
  ]);
}

export class BootstrapPanel {
  private static current: BootstrapPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly run: Run;
  private readonly onMapped: (result: Mapped) => Promise<void>;
  private readonly disposables: vscode.Disposable[] = [];
  private form: MapCapabilityForm = { ...EMPTY_MAP_FORM };
  private mapLoadRevision = 0;

  private constructor(
    panel: vscode.WebviewPanel, leads: string[], run: Run,
    onMapped: (result: Mapped) => Promise<void>
  ) {
    this.panel = panel;
    this.run = run;
    this.onMapped = onMapped;
    const uniqueLeads = [...new Set(leads.filter((lead) => lead.trim()))];
    this.form = {
      ...EMPTY_MAP_FORM,
      leads: uniqueLeads,
      // One available map is not a meaningful choice. More than one is, so do not silently pick
      // the first entry in an organisation whose capability map is split across repositories.
      lead: uniqueLeads.length === 1 ? (uniqueLeads[0] ?? '') : ''
    };
    this.panel.webview.onDidReceiveMessage((raw: unknown) => { void this.receive(raw); }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
    if (this.form.lead) void this.loadSelectedMap();
  }

  static show(
    context: vscode.ExtensionContext, leads: string[], run: Run,
    onMapped: (result: Mapped) => Promise<void>
  ): BootstrapPanel {
    if (BootstrapPanel.current) {
      BootstrapPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return BootstrapPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.mapCapability', 'Map a capability', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    BootstrapPanel.current = new BootstrapPanel(panel, leads, run, onMapped);
    return BootstrapPanel.current;
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page(
      'Map a capability',
      mapCapabilityHtml(this.form),
      contentSecurityPolicy(this.panel.webview, token),
      token,
      MAP_CAPABILITY_SCRIPT
    );
  }

  private update(changes: Partial<MapCapabilityForm>): void {
    this.form = { ...this.form, ...changes };
    this.render();
  }

  /**
   * Load the map as a consequence of selecting its repository. There is deliberately no separate
   * "read" action in the UI: repository selection is the decision; reading is just what the form
   * has to do to offer valid parent capabilities.
   */
  private async loadSelectedMap(): Promise<void> {
    if (!this.form.lead.trim() || (this.form.busy && this.form.loaded)) return;
    const selectedLead = this.form.lead.trim();
    const revision = ++this.mapLoadRevision;
    this.update({ busy: true, loaded: false, parents: [], parent: '', error: null });
    const { result, error } = await this.run(['capability', 'organisation', selectedLead, '--json']);
    // A quick second selection must not put the first repository's parents under the second one.
    if (revision !== this.mapLoadRevision || selectedLead !== this.form.lead.trim()) return;
    if (error) return void this.update({ busy: false, error });
    const organisation = result as Organisation;
    const parents = parentChoices(organisation.capabilities ?? []);
    this.update({
      busy: false,
      loaded: true,
      parents,
      error: organisation.governed ? null : `${selectedLead} holds no capability map yet.`
    });
  }

  private async selectLead(value: string): Promise<void> {
    const lead = value.trim();
    if (lead !== this.form.lead.trim()) {
      this.form = { ...this.form, lead, loaded: false, parents: [], parent: '', error: null };
    }
    if (!lead) return void this.render();
    await this.loadSelectedMap();
  }

  private async receive(raw: unknown): Promise<void> {
    const message = raw as { type?: unknown; field?: unknown; value?: unknown; checked?: unknown };

    // Recorded without re-rendering: replacing the document on every keystroke would take the caret.
    if (message?.type === 'field' && typeof message.value === 'string') {
      const field = message.field;
      if (field === 'lead' || field === 'capabilityId' || field === 'name' || field === 'kind'
        || field === 'parent' || field === 'repositoryUrl' || field === 'jiraProject'
        || field === 'teams') {
        const previousRepository = this.form.repositoryUrl;
        // Changing which map is being edited invalidates the parents read from the last one.
        if (field === 'lead' && message.value !== this.form.lead) {
          this.form = { ...this.form, loaded: false, parents: [], parent: '' };
        }
        this.form[field] = message.value;
        // When no map is registered, the first repository entered is the only possible home for
        // it. Defaulting here makes the checkbox truthful without inventing another prompt.
        if (field === 'repositoryUrl' && !this.form.leads.length
          && (!this.form.lead || this.form.lead === previousRepository)) {
          this.form.lead = message.value;
        }
        if (field === 'kind' && message.value === 'collection') this.form.repositoryUrl = '';
      }
      return;
    }

    if (message?.type === 'redraw') return this.render();

    if (message?.type === 'selectLead' && typeof message.value === 'string') {
      await this.selectLead(message.value);
      return;
    }

    if (message?.type === 'repositoryCommitted' && typeof message.value === 'string') {
      if (!this.form.leads.length && message.value.trim()) await this.selectLead(message.value);
      else this.render();
      return;
    }

    if (message?.type === 'useShippingRepository' && typeof message.checked === 'boolean') {
      if (message.checked) {
        if (this.form.repositoryUrl.trim()) await this.selectLead(this.form.repositoryUrl);
      } else {
        const fallback = this.form.leads.length === 1 ? (this.form.leads[0] ?? '') : '';
        await this.selectLead(fallback);
      }
      return;
    }

    // Kept as a compatibility alias for a webview that was already open when the extension was
    // updated. New renders never expose a separate Read button.
    if (message?.type === 'read') return void await this.loadSelectedMap();

    if (message?.type === 'map') {
      if (mapProblems(this.form).length || this.form.busy) return;
      this.update({ busy: true, error: null });
      const { result, error } = await this.run(mapCommand(this.form));
      if (error) return void this.update({ busy: false, error });
      // dispose() rather than panel.dispose(): closing the panel has to clear the singleton in
      // the same tick, or opening the screen again reveals the panel that was just closed.
      this.dispose();
      await this.onMapped(result as Mapped);
    }
  }

  dispose(): void {
    BootstrapPanel.current = null;
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
