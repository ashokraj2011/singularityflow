/**
 * The panel behind the bootstrap form.
 *
 * Registered and usable before any repository exists, which is the whole point: it is the command
 * that produces the thing every other command needs.
 */
import * as vscode from 'vscode';
import { contentSecurityPolicy, nonce, page } from './webview.ts';
import {
  bootstrapCommand, bootstrapHtml, bootstrapProblems, BOOTSTRAP_SCRIPT,
  EMPTY_BOOTSTRAP, type BootstrapForm
} from './bootstrap-form.ts';

export interface Bootstrapped { root: string; repositoryId: string; capability: string }

export class BootstrapPanel {
  private static current: BootstrapPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly onRun: (argv: string[]) => Promise<{ result: Bootstrapped | null; error: string | null }>;
  private readonly onDone: (result: Bootstrapped) => Promise<void>;
  private readonly disposables: vscode.Disposable[] = [];
  private form: BootstrapForm = { ...EMPTY_BOOTSTRAP };

  private constructor(
    panel: vscode.WebviewPanel,
    onRun: (argv: string[]) => Promise<{ result: Bootstrapped | null; error: string | null }>,
    onDone: (result: Bootstrapped) => Promise<void>
  ) {
    this.panel = panel;
    this.onRun = onRun;
    this.onDone = onDone;
    this.panel.webview.onDidReceiveMessage((raw: unknown) => { void this.receive(raw); }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
  }

  static show(
    context: vscode.ExtensionContext,
    onRun: (argv: string[]) => Promise<{ result: Bootstrapped | null; error: string | null }>,
    onDone: (result: Bootstrapped) => Promise<void>
  ): BootstrapPanel {
    if (BootstrapPanel.current) {
      BootstrapPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return BootstrapPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.bootstrap', 'Govern a repository', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    BootstrapPanel.current = new BootstrapPanel(panel, onRun, onDone);
    return BootstrapPanel.current;
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page(
      'Govern a repository',
      bootstrapHtml(this.form),
      contentSecurityPolicy(this.panel.webview, token),
      token,
      BOOTSTRAP_SCRIPT
    );
  }

  private update(changes: Partial<BootstrapForm>): void {
    this.form = { ...this.form, ...changes };
    this.render();
  }

  private async receive(raw: unknown): Promise<void> {
    const message = raw as { type?: unknown; field?: unknown; value?: unknown };

    // Recorded without re-rendering: replacing the document on every keystroke would take the caret
    // with it, and the page answers its own derived identifier.
    if (message?.type === 'field' && typeof message.value === 'string') {
      const field = message.field;
      if (field === 'url' || field === 'capabilityId' || field === 'capabilityName'
        || field === 'kind' || field === 'jiraProject' || field === 'teams'
        || field === 'stateBranch') {
        this.form[field] = message.value;
      }
      return;
    }

    if (message?.type === 'choose') {
      const picked = await vscode.window.showOpenDialog({
        title: 'Where should the repository be cloned?',
        openLabel: 'Clone here',
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false
      });
      if (picked?.[0]) this.update({ base: picked[0].fsPath });
      return;
    }

    if (message?.type === 'bootstrap') {
      // Re-checked here rather than trusted from the page: the disabled button is a courtesy.
      if (bootstrapProblems(this.form).length || this.form.busy) return;
      this.update({ busy: true, error: null });
      const { result, error } = await this.onRun(bootstrapCommand(this.form));
      if (error || !result) return void this.update({ busy: false, error: error ?? 'Nothing was reported.' });
      this.panel.dispose();
      await this.onDone(result);
    }
  }

  dispose(): void {
    BootstrapPanel.current = null;
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
