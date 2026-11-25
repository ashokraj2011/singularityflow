/**
 * All skills [owner, 2026-11-25]: the panel that shows `skill catalog --json` (all-skills-page.ts). The engine reads and
 * analyzes; this view shows its answer. Its two actions reuse Workflow Studio's own routes: a marketplace skill's
 * Preview opens Studio's Library on the import preview of that skill, and Open in Skill master opens Studio's Skill
 * master on the library skill. A page message names a row by its key, found here in the engine's own answer.
 */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField } from './messages.ts';
import { ALL_SKILLS_SCRIPT, ALL_SKILLS_STYLE, allSkillsPageHtml, skillCatalogFrom, type SkillCatalog } from './all-skills-page.ts';

const errorText = (error: unknown): string => (error as Error)?.message ?? String(error);

export class AllSkillsPanel implements vscode.Disposable {
  private static current: AllSkillsPanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  private catalog: SkillCatalog | null = null;
  private busy = false;
  private error: string | null = null;
  private notice: string | null = null;
  private disposed = false;

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly client: SingularityFlowClient) {
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      void this.router.route(raw);
    }, null, this.subscriptions);
    panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
  }

  /** Open (or reveal) All skills and read it fresh. */
  static show(client: SingularityFlowClient): AllSkillsPanel {
    const existing = AllSkillsPanel.current;
    if (existing && existing.client === client) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      void existing.load();
      return existing;
    }
    existing?.panel.dispose();
    const panel = vscode.window.createWebviewPanel('singularityFlow.allSkills', 'All skills', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    AllSkillsPanel.current = new AllSkillsPanel(panel, client);
    void AllSkillsPanel.current.load();
    return AllSkillsPanel.current;
  }

  private router = registerMessageRouter('singularityFlow.allSkills', {
    'allSkills.refresh': () => this.load(),
    'allSkills.preview': (message) => this.preview(stringField(message, 'key')),
    'allSkills.open': (message) => this.open(stringField(message, 'key')),
    'allSkills.skillMaster': () => vscode.commands.executeCommand('singularityFlow.openWorkflowStudio', { view: 'skills' }),
    // The Marketplace: the same marketplaces as an app store, with Install, Update and Remove.
    'allSkills.marketplace': () => vscode.commands.executeCommand('singularityFlow.marketplace')
  });

  private row(key: string | null | undefined) {
    return key ? this.catalog?.rows.find((row) => row.key === key) ?? null : null;
  }

  private async load(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.render();
    try {
      const catalog = skillCatalogFrom(await this.client.run(['skill', 'catalog', '--json']));
      if (!catalog) throw new Error("The skills could not be read from the engine's answer.");
      this.catalog = catalog;
      this.error = null;
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  /** A marketplace skill's exact text, in Studio's import preview: added to the skill master from there, once reviewed. */
  private async preview(key: string | null | undefined): Promise<void> {
    const row = this.row(key);
    if (!row?.actions.reference) return;
    await vscode.commands.executeCommand('singularityFlow.openWorkflowStudio',
      { view: 'library', preview: { reference: row.actions.reference, replace: row.inLibrary } });
  }

  private async open(key: string | null | undefined): Promise<void> {
    const row = this.row(key);
    if (!row?.inLibrary) return;
    await vscode.commands.executeCommand('singularityFlow.openWorkflowStudio', { view: 'skills', skill: row.id });
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    this.panel.webview.html = page('All skills', allSkillsPageHtml({ catalog: this.catalog, busy: this.busy, error: this.error, notice: this.notice }),
      contentSecurityPolicy(this.panel.webview, token), token, ALL_SKILLS_SCRIPT, { styles: ALL_SKILLS_STYLE });
  }

  dispose(): void {
    this.disposed = true;
    if (AllSkillsPanel.current === this) AllSkillsPanel.current = null;
    while (this.subscriptions.length) this.subscriptions.pop()?.dispose();
  }
}
