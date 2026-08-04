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

  private constructor(
    panel: vscode.WebviewPanel, leads: string[], run: Run,
    onMapped: (result: Mapped) => Promise<void>
  ) {
    this.panel = panel;
    this.run = run;
    this.onMapped = onMapped;
    this.form = { ...EMPTY_MAP_FORM, leads, lead: leads[0] ?? '' };
    this.panel.webview.onDidReceiveMessage((raw: unknown) => { void this.receive(raw); }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
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

  private async receive(raw: unknown): Promise<void> {
    const message = raw as { type?: unknown; field?: unknown; value?: unknown };

    // Recorded without re-rendering: replacing the document on every keystroke would take the caret.
    if (message?.type === 'field' && typeof message.value === 'string') {
      const field = message.field;
      // An empty pick from the lead dropdown means "another", which the free-text field answers.
      if (field === 'leadOther') { if (message.value.trim()) this.form.lead = message.value; return; }
      if (field === 'lead' || field === 'capabilityId' || field === 'name' || field === 'kind'
        || field === 'parent' || field === 'repositoryUrl' || field === 'jiraProject'
        || field === 'teams') {
        // Changing which map is being edited invalidates the parents read from the last one.
        if (field === 'lead' && message.value !== this.form.lead) {
          this.form = { ...this.form, loaded: false, parents: [], parent: '' };
        }
        this.form[field] = message.value;
        if (field === 'kind' && message.value === 'collection') this.form.repositoryUrl = '';
      }
      return;
    }

    if (message?.type === 'redraw') return this.render();

    if (message?.type === 'read') {
      if (!this.form.lead.trim() || this.form.busy) return;
      this.update({ busy: true, error: null });
      const { result, error } = await this.run(['capability', 'organisation', this.form.lead.trim(), '--json']);
      if (error) return void this.update({ busy: false, error });
      const organisation = result as Organisation;
      const parents = parentChoices(organisation.capabilities ?? []);
      this.update({
        busy: false,
        loaded: true,
        parents,
        error: organisation.governed ? null : `${this.form.lead} holds no capability map yet.`
      });
      return;
    }

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
