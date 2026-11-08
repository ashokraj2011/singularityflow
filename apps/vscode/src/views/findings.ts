/**
 * Findings in VS Code [CQF:REQ-070]: the Findings view, with Security and TLM tabs, and the command
 * "Upload security or TLM findings…", which opens a file picker and runs the same `findings import`
 * the CLI and `/sf-findings` run. Every read is the CLI's own `--json` answer; the uploaded file is
 * read by the CLI and never copied anywhere.
 */
import * as vscode from 'vscode';
import os from 'node:os';
import path from 'node:path';
import type { SingularityFlowClient } from '../cli/client.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { booleanField, registerMessageRouter, stringField } from './messages.ts';
import {
  findingsImportArgv, findingsListArgv, findingsListFrom, findingsTemplateArgv, importSummary,
  type FindingsImport, type FindingsList, type FindingsTab
} from './findings-model.ts';
import { findingsPageHtml, FINDINGS_SCRIPT, FINDINGS_STYLE } from './findings-page.ts';

export interface FindingsHooks {
  output?: { appendLine(line: string): void };
  refresh?: () => Promise<unknown>;
}

const errorText = (error: unknown): string => (error as Error)?.message ?? String(error);

/**
 * Pick a workbook or CSV file and import it. A CSV file is one list, so the person says which; a
 * workbook names its sheets. Returns the import's answer, or null when the person cancelled.
 */
export async function uploadFindings(client: SingularityFlowClient, hooks: FindingsHooks = {}): Promise<FindingsImport | null> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false, canSelectFiles: true, canSelectFolders: false, openLabel: 'Import findings',
    title: 'Upload security or TLM findings', filters: { 'Findings workbook or CSV': ['xlsx', 'csv'] }
  });
  const file = picked?.[0]?.fsPath;
  if (!file) return null;
  let feed: FindingsTab | null = null;
  if (/\.csv$/iu.test(file)) {
    const choice = await vscode.window.showQuickPick([
      { label: 'Security findings', feed: 'security' as const }, { label: 'TLM items', feed: 'tlm' as const }
    ], { title: 'Which list is this CSV file?', placeHolder: 'A CSV file holds one list' });
    if (!choice) return null;
    feed = choice.feed;
  }
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Importing findings…' },
    () => client.run<FindingsImport>(findingsImportArgv(file, feed)));
  for (const row of result.rejected ?? []) hooks.output?.appendLine(`Findings import ${result.importId}: rejected ${row.sheet} row ${row.row}: ${row.reason}.`);
  for (const sheet of result.ignoredSheets ?? []) hooks.output?.appendLine(`Findings import ${result.importId}: sheet "${sheet.sheet}" not read: ${sheet.reason}.`);
  await hooks.refresh?.().catch(() => undefined);
  return result;
}

export class FindingsPanel implements vscode.Disposable {
  private static current: FindingsPanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  private list: FindingsList | null = null;
  private tab: FindingsTab = 'security';
  private all = false;
  private busy = false;
  private error: string | null = null;
  private notice: string | null = null;
  private disposed = false;

  private readonly panel: vscode.WebviewPanel;
  private readonly client: SingularityFlowClient;
  private hooks: FindingsHooks;

  private constructor(panel: vscode.WebviewPanel, client: SingularityFlowClient, hooks: FindingsHooks) {
    this.panel = panel;
    this.client = client;
    this.hooks = hooks;
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      void this.router.route(raw);
    }, null, this.subscriptions);
    panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
  }

  /** Open (or reveal) the Findings view and read the register fresh. */
  static show(client: SingularityFlowClient, hooks: FindingsHooks = {}, notice: string | null = null): FindingsPanel {
    const existing = FindingsPanel.current;
    if (existing && existing.client === client) {
      existing.hooks = hooks;
      existing.notice = notice ?? existing.notice;
      existing.panel.reveal(vscode.ViewColumn.Active);
      void existing.load();
      return existing;
    }
    existing?.panel.dispose();
    const panel = vscode.window.createWebviewPanel('singularityFlow.findings', 'Findings', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    FindingsPanel.current = new FindingsPanel(panel, client, hooks);
    FindingsPanel.current.notice = notice;
    void FindingsPanel.current.load();
    return FindingsPanel.current;
  }

  /** Re-read an open view after an import elsewhere; nothing happens when none is open. */
  static async refreshOpen(notice: string | null = null): Promise<void> {
    const open = FindingsPanel.current;
    if (!open) return;
    if (notice) open.notice = notice;
    await open.load();
  }

  private router = registerMessageRouter('singularityFlow.findings', {
    'findings.refresh': () => this.load(),
    'findings.tab': (message) => {
      const tab = stringField(message, 'tab');
      if (tab !== 'security' && tab !== 'tlm') return;
      this.tab = tab;
      this.render();
    },
    'findings.all': (message) => { this.all = booleanField(message, 'value') === true; return this.load(); },
    'findings.upload': () => this.upload(),
    'findings.template': () => this.template()
  });

  /** `findings list`; a failed read keeps the last answer on screen. */
  private async load(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.render();
    try {
      const list = findingsListFrom(await this.client.run(findingsListArgv(this.all)));
      if (!list) throw new Error('The findings register could not be read from the engine\'s answer.');
      this.list = list;
      this.error = null;
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async upload(): Promise<void> {
    try {
      const result = await uploadFindings(this.client, { ...this.hooks, refresh: undefined });
      if (!result) return;
      this.notice = importSummary(result);
      const feeds = Object.keys(result.feeds);
      if (feeds.length === 1 && (feeds[0] === 'security' || feeds[0] === 'tlm')) this.tab = feeds[0];
      await this.hooks.refresh?.().catch(() => undefined);
    } catch (error) {
      this.error = errorText(error);
    }
    await this.load();
  }

  /** Save the empty workbook where the person chooses, offering the home folder (never the checkout); the CLI never overwrites a file. */
  private async template(): Promise<void> {
    const target = await vscode.window.showSaveDialog({ title: 'Save the findings workbook template', saveLabel: 'Save template',
      filters: { 'Excel workbook': ['xlsx'] }, defaultUri: vscode.Uri.file(path.join(os.homedir(), 'sflow-findings-template.xlsx')) });
    if (!target) return;
    try {
      const result = await this.client.run<{ path: string }>(findingsTemplateArgv(target.fsPath));
      this.notice = `Saved the template: ${result.path}`;
      this.error = null;
    } catch (error) {
      this.error = errorText(error);
    }
    this.render();
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    this.panel.webview.html = page('Findings', findingsPageHtml({
      list: this.list, tab: this.tab, all: this.all, busy: this.busy, error: this.error, notice: this.notice,
      today: new Date().toISOString().slice(0, 10)
    }), contentSecurityPolicy(this.panel.webview, token), token, FINDINGS_SCRIPT, { styles: FINDINGS_STYLE });
  }

  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    if (FindingsPanel.current === this) FindingsPanel.current = null;
  }
}
