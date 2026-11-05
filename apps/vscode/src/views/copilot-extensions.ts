/** The Copilot extensions page: this window's extensions, its folders and the last chat's own numbers. */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  COPILOT_EXTENSIONS_SCRIPT, COPILOT_EXTENSIONS_STYLE, copilotExtensionsHtml, copilotExtensionsView, declaredFilePatterns, extensionFacts,
  languageFilePatterns, readLastCopilotChat, type CopilotExtensionsView, type ExtensionFacts, type WorkspaceFinding
} from './copilot-extensions-model.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField } from './messages.ts';

const NOT_SOURCE = '**/{node_modules,.git,.sflow,.singularity-flow,dist,build,out,target}/**';
const SEARCH_MS = 6_000;

/** Which declared patterns this window's folders hold. A search that runs out of time says so. */
async function workspaceFindings(facts: readonly ExtensionFacts[]): Promise<Map<string, WorkspaceFinding>> {
  const languages = languageFilePatterns(vscode.extensions.all.map(extension => extension.packageJSON as Record<string, unknown>));
  const declared = new Map(facts.map(fact => [fact.id, declaredFilePatterns(fact.activationEvents, languages)]));
  const hasFolder = Boolean(vscode.workspace.workspaceFolders?.length);
  const found = new Map<string, boolean | null>();
  const pending = hasFolder ? [...new Set([...declared.values()].flat())] : [];
  const cancel = new vscode.CancellationTokenSource();
  const timer = setTimeout(() => cancel.cancel(), SEARCH_MS);
  try {
    await Promise.all(Array.from({ length: 8 }, async () => {
      for (let pattern = pending.shift(); pattern !== undefined; pattern = pending.shift()) {
        if (cancel.token.isCancellationRequested) { found.set(pattern, null); continue; }
        try { found.set(pattern, (await vscode.workspace.findFiles(pattern, NOT_SOURCE, 1, cancel.token)).length > 0); }
        catch { found.set(pattern, null); }
      }
    }));
  } finally { clearTimeout(timer); cancel.dispose(); }
  return new Map(facts.map((fact) => {
    const looked = declared.get(fact.id) ?? [];
    return [fact.id, { looked, found: looked.filter(pattern => found.get(pattern) === true),
      complete: hasFolder && looked.every(pattern => typeof found.get(pattern) === 'boolean') }];
  }));
}

async function readView(): Promise<CopilotExtensionsView> {
  const appRoot = path.resolve(vscode.env.appRoot);
  const facts = await extensionFacts(vscode.extensions.all.map(extension => ({
    id: extension.id, packageJSON: extension.packageJSON as Record<string, unknown>,
    builtin: path.resolve(extension.extensionPath).startsWith(appRoot + path.sep),
    text: (file: string) => readFile(path.join(extension.extensionPath, file), 'utf8').catch(() => null)
  })));
  const folders = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
  const [chat, findings] = await Promise.all([
    readLastCopilotChat(process.env.COPILOT_HOME?.trim() || path.join(os.homedir(), '.copilot'), folders), workspaceFindings(facts)]);
  return copilotExtensionsView(facts, chat, findings);
}

export class CopilotExtensionsPanel {
  private static current: CopilotExtensionsPanel | null = null;
  private view: CopilotExtensionsView | null = null;
  private error: string | null = null;
  private revision = 0;
  private readonly disposables: vscode.Disposable[] = [];
  private constructor(private readonly panel: vscode.WebviewPanel) {
    const router = registerMessageRouter('singularityFlow.copilotExtensions', {
      refresh: () => this.refresh(),
      // Only an extension this page listed, and only VS Code's own page for it.
      open: (message) => {
        const id = stringField(message, 'id');
        return this.view?.rows.some(row => row.canOpen && row.id === id) ? vscode.commands.executeCommand('extension.open', id) : undefined;
      },
      skills: () => vscode.commands.executeCommand('workbench.action.chat.configure.skills').then(undefined, () =>
        vscode.window.showInformationMessage('This version of VS Code has no skill chooser. Open the extension instead.'))
    });
    panel.webview.onDidReceiveMessage((raw) => {
      const target = navigationTarget(raw);
      return target ? navigateTo(target) : router.route(raw);
    }, null, this.disposables);
    vscode.extensions.onDidChange(() => void this.refresh(), null, this.disposables);
    panel.onDidDispose(() => {
      this.revision++;
      if (CopilotExtensionsPanel.current === this) CopilotExtensionsPanel.current = null;
      this.disposables.forEach(disposable => disposable.dispose());
    }, null, this.disposables);
    this.render();
    void this.refresh();
  }
  static show(): void {
    if (CopilotExtensionsPanel.current) { CopilotExtensionsPanel.current.panel.reveal(); void CopilotExtensionsPanel.current.refresh(); return; }
    const panel = vscode.window.createWebviewPanel('singularityFlow.copilotExtensions', 'Copilot extensions', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    CopilotExtensionsPanel.current = new CopilotExtensionsPanel(panel);
  }
  private async refresh(): Promise<void> {
    const revision = ++this.revision;
    try {
      const view = await readView();
      if (revision !== this.revision) return;
      this.view = view; this.error = null;
    } catch (error) {
      if (revision !== this.revision) return;
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.render();
  }
  private render(): void {
    const token = nonce();
    this.panel.webview.html = page('Copilot extensions', `<style nonce="${token}">${COPILOT_EXTENSIONS_STYLE}</style>${copilotExtensionsHtml(this.view, this.error)}`,
      contentSecurityPolicy(this.panel.webview, token), token, COPILOT_EXTENSIONS_SCRIPT);
  }
}
