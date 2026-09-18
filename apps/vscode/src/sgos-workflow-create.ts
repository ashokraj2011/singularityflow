/** A single, review-first VS Code surface for a storyless SGOS Workflow Candidate. */
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';

import type { SingularityFlowClient } from './cli/client.ts';
import {
  SGOS_LOWER_KEBAB, sgosCommand, sgosRatificationPreviewArguments,
  sgosTerminalCommand, sgosWorkflowCreateArguments, sgosWorkflowCreateReview,
  sgosWorkflowOutputPaths, sgosWorkflowSelectionIssue, sgosWorkspaceBindingIssue,
  validSgosInputPath, type SgosWorkflowCreateSelection, type SgosWorkflowGuide
} from './sgos-workflow-create-model.ts';
import { commandGuidance } from './copilot-command.ts';
import {
  SGOS_WORKFLOW_CREATE_SCRIPT, sgosWorkflowCreateHtml,
  type SgosWorkflowPageState
} from './views/sgos-workflow-create-page.ts';
import { contentSecurityPolicy, nonce, page } from './views/webview.ts';
import { registerMessageRouter } from './views/messages.ts';

type InputField = 'intentPath' | 'policyPath' | 'registryPath';
type FormField = Exclude<keyof SgosWorkflowCreateSelection, InputField>;
type MutableSelection = { -readonly [K in keyof SgosWorkflowCreateSelection]?: SgosWorkflowCreateSelection[K] };
const INPUT_FIELDS = new Set<InputField>(['intentPath', 'policyPath', 'registryPath']);
const FORM_FIELDS = new Set<FormField>([
  'id', 'title', 'operation', 'verificationOperation', 'storageProfileSha256',
  'maximumAttempts', 'outputRef', 'declarationOut', 'workflowOut'
]);

function resultOf<T>(value: unknown): T {
  return ((value as { data?: { result?: T } })?.data?.result ?? value) as T;
}

function inside(repository: string, file: string): string | null {
  const relative = path.relative(repository, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) return null;
  const candidate = relative.split(path.sep).join('/');
  return validSgosInputPath(candidate) ? candidate : null;
}

async function browseJson(repository: string, title: string): Promise<string | null> {
  const picked = await vscode.window.showOpenDialog({
    title, defaultUri: vscode.Uri.file(repository), canSelectFiles: true,
    canSelectFolders: false, canSelectMany: false, filters: { JSON: ['json'] },
    openLabel: 'Use this reviewed file'
  });
  if (!picked?.[0]) return null;
  // Reject symlink traversal into another repository before treating the selected file as input.
  const repositoryReal = await realpath(repository);
  const pickedReal = await realpath(picked[0].fsPath);
  const relative = inside(repositoryReal, pickedReal);
  if (!relative) {
    throw new Error('The selected JSON file must be inside the active repository.');
  }
  return relative;
}

async function alreadyExists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function repositoryIssue(client: SingularityFlowClient, repository: string): Promise<string | null> {
  try {
    const current = await client.run<{
      active?: boolean; repositoryPath?: string; repositoryState?: string; selectionStatus?: string;
    }>(['workspace', 'current', '--json']);
    if (path.resolve(client.repository) !== path.resolve(repository)) {
      return 'The extension changed repositories while this form was open.';
    }
    return sgosWorkspaceBindingIssue(current, repository);
  } catch (error) {
    return `The active workspace could not be verified: ${(error as Error).message}`;
  }
}

class SgosWorkflowCreatePanel {
  private static current: SgosWorkflowCreatePanel | null = null;
  private readonly panel: vscode.WebviewPanel;
  private readonly client: SingularityFlowClient;
  private readonly repository: string;
  private readonly disposables: vscode.Disposable[] = [];
  private state: SgosWorkflowPageState;
  private disposed = false;

  private constructor(panel: vscode.WebviewPanel, client: SingularityFlowClient, repository: string) {
    this.panel = panel;
    this.client = client;
    this.repository = repository;
    this.state = {
      repository, intentPath: '', policyPath: '', registryPath: '',
      selection: { maximumAttempts: 1, outputRef: 'artifact:result' }
    };
    const router = registerMessageRouter('singularityFlow.sgosWorkflowCreate', {
      change: (message) => this.receive(message),
      browse: (message) => this.receive(message),
      guide: (message) => this.receive(message),
      create: (message) => this.receive(message)
    });
    this.disposables.push(panel.webview.onDidReceiveMessage((message: unknown) => {
      void Promise.resolve(router.route(message)).catch((error) => {
        this.state = { ...this.state, busy: false, guideLoading: false, error: (error as Error).message };
        this.render();
      });
    }));
    this.disposables.push(panel.onDidDispose(() => this.dispose()));
    this.render();
  }

  static async show(client: SingularityFlowClient): Promise<void> {
    const repository = path.resolve(client.repository);
    const issue = await repositoryIssue(client, repository);
    if (issue) {
      await vscode.window.showErrorMessage(`${issue} Nothing was created. Refresh Workspaces and try again.`);
      return;
    }
    const current = this.current;
    if (current && !current.disposed) {
      if (current.repository === repository) {
        current.panel.reveal(vscode.ViewColumn.Active);
        return;
      }
      current.panel.dispose();
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.sgosWorkflowCreate', 'Create execution workflow', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.current = new SgosWorkflowCreatePanel(panel, client, repository);
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposables) disposable.dispose();
    if (SgosWorkflowCreatePanel.current === this) SgosWorkflowCreatePanel.current = null;
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    this.panel.webview.html = page(
      'Create execution workflow', sgosWorkflowCreateHtml(this.state),
      contentSecurityPolicy(this.panel.webview, token), token, SGOS_WORKFLOW_CREATE_SCRIPT,
      { nav: false }
    );
  }

  private update(fields: Record<string, unknown>): void {
    if (this.state.busy || this.state.guideLoading) return;
    const next: MutableSelection = { ...this.state.selection };
    let intentOrRegistryChanged = false;
    for (const [field, value] of Object.entries(fields)) {
      if (INPUT_FIELDS.has(field as InputField) && typeof value === 'string') {
        const key = field as InputField;
        if ((key === 'intentPath' || key === 'registryPath')
            && value.trim() !== this.state[key]) intentOrRegistryChanged = true;
        this.state = { ...this.state, [key]: value.trim() };
      } else if (FORM_FIELDS.has(field as FormField)) {
        if (field === 'maximumAttempts' && typeof value === 'number') {
          next.maximumAttempts = value;
        } else if (typeof value === 'string') {
          const key = field as Exclude<FormField, 'maximumAttempts'>;
          (next as Record<string, unknown>)[key] = value.trim();
        }
      }
    }
    if (typeof fields.id === 'string' && fields.id.trim() !== this.state.selection?.id) {
      const prior = this.state.selection?.id;
      const priorPaths = prior && SGOS_LOWER_KEBAB.test(prior) ? sgosWorkflowOutputPaths(prior) : null;
      if (SGOS_LOWER_KEBAB.test(fields.id.trim())) {
        const fresh = sgosWorkflowOutputPaths(fields.id.trim());
        if (!next.declarationOut || next.declarationOut === priorPaths?.declarationOut) {
          next.declarationOut = fresh.declarationOut;
        }
        if (!next.workflowOut || next.workflowOut === priorPaths?.workflowOut) {
          next.workflowOut = fresh.workflowOut;
        }
      }
    }
    if (typeof fields.operation === 'string' && fields.operation !== this.state.selection?.operation) {
      next.verificationOperation = '';
    }
    this.state = {
      ...this.state, selection: next, error: null,
      ...(intentOrRegistryChanged ? { guide: undefined,
        selection: { ...next, operation: '', verificationOperation: '' } } : {})
    };
    this.render();
  }

  private async guide(): Promise<void> {
    if (this.state.busy || this.state.guideLoading) return;
    if (!validSgosInputPath(this.state.intentPath) || !validSgosInputPath(this.state.registryPath)) {
      throw new Error('Choose repository-relative Intent and registry JSON files first.');
    }
    const issue = await repositoryIssue(this.client, this.repository);
    if (issue) throw new Error(issue);
    const intent = this.state.intentPath;
    const registry = this.state.registryPath;
    this.state = { ...this.state, guideLoading: true, guide: undefined, error: null };
    this.render();
    try {
      const guide = resultOf<SgosWorkflowGuide>(await this.client.run([
        'intent', 'workflow-guide', intent, '--registry', registry, '--json'
      ]));
      if (intent !== this.state.intentPath || registry !== this.state.registryPath) return;
      this.state = { ...this.state, guideLoading: false, guide,
        selection: { ...this.state.selection, operation: '', verificationOperation: '',
          maximumAttempts: this.state.selection?.maximumAttempts ?? guide.defaults?.maximumAttempts ?? 1,
          outputRef: this.state.selection?.outputRef ?? guide.defaults?.outputRef ?? 'artifact:result' }
      };
    } finally {
      this.state = { ...this.state, guideLoading: false };
      this.render();
    }
  }

  private selection(): SgosWorkflowCreateSelection {
    const choice = this.state.selection ?? {};
    const id = choice.id ?? '';
    const paths = SGOS_LOWER_KEBAB.test(id) ? sgosWorkflowOutputPaths(id) : {
      declarationOut: '', workflowOut: ''
    };
    return {
      intentPath: this.state.intentPath, policyPath: this.state.policyPath,
      registryPath: this.state.registryPath, id, title: choice.title ?? '',
      operation: choice.operation ?? '', verificationOperation: choice.verificationOperation ?? '',
      storageProfileSha256: choice.storageProfileSha256 ?? '',
      maximumAttempts: choice.maximumAttempts ?? 1, outputRef: choice.outputRef ?? '',
      declarationOut: choice.declarationOut ?? paths.declarationOut,
      workflowOut: choice.workflowOut ?? paths.workflowOut
    };
  }

  private async create(): Promise<void> {
    if (this.state.busy || this.state.guideLoading) return;
    // Acquire the UI mutation lease before any asynchronous preflight or confirmation. A second
    // webview message cannot open another confirmation or race the exact same two draft paths.
    this.state = { ...this.state, busy: true, error: null };
    this.render();
    const selection = this.selection();
    const issue = sgosWorkflowSelectionIssue(selection, this.state.guide ?? null);
    if (issue) throw new Error(issue);
    const binding = await repositoryIssue(this.client, this.repository);
    if (binding) throw new Error(binding);
    const refreshed = resultOf<SgosWorkflowGuide>(await this.client.run([
      'intent', 'workflow-guide', selection.intentPath,
      '--registry', selection.registryPath, '--json'
    ]));
    const sameGuide = this.state.guide?.guideSha256 && refreshed.guideSha256
      ? this.state.guide.guideSha256 === refreshed.guideSha256
      : JSON.stringify(refreshed) === JSON.stringify(this.state.guide);
    if (!sameGuide) {
      this.state = { ...this.state, busy: false, guide: refreshed, error:
        'Intent or registry eligibility changed. Review the updated operation and verifier choices before creating.' };
      this.render();
      return;
    }
    for (const relative of [selection.declarationOut, selection.workflowOut]) {
      if (await alreadyExists(path.join(this.repository, ...relative.split('/')))) {
        throw new Error(`Draft output already exists: ${relative}. Choose a new workflow ID; nothing was overwritten.`);
      }
    }
    const accepted = await vscode.window.showWarningMessage(
      `Create the unratified SGOS Workflow '${selection.id}'?`,
      { modal: true, detail: sgosWorkflowCreateReview(selection) }, 'Create review files'
    );
    if (accepted !== 'Create review files') {
      this.state = { ...this.state, busy: false };
      this.render();
      return;
    }
    const finalBinding = await repositoryIssue(this.client, this.repository);
    if (finalBinding) throw new Error(finalBinding);
    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Creating unratified SGOS Workflow ${selection.id}`,
        cancellable: false
      }, () => this.client.run(sgosWorkflowCreateArguments(selection)));
    } catch (error) {
      this.state = { ...this.state, busy: false,
        error: `Creation failed: ${(error as Error).message}. Check whether either draft file now exists before retrying.` };
      this.render();
      return;
    }
    this.panel.dispose();
    try {
      await this.afterCreate(selection);
    } catch (error) {
      await vscode.window.showWarningMessage(
        `The unratified review files were created, but the follow-up view failed: ${(error as Error).message}`
      );
    }
  }

  private async afterCreate(selection: SgosWorkflowCreateSelection): Promise<void> {
    const declaration = vscode.Uri.file(path.join(this.repository, ...selection.declarationOut.split('/')));
    const workflow = vscode.Uri.file(path.join(this.repository, ...selection.workflowOut.split('/')));
    try {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(declaration), {
        preview: false, viewColumn: vscode.ViewColumn.One
      });
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(workflow), {
        preview: false, viewColumn: vscode.ViewColumn.Beside
      });
    } catch (error) {
      await vscode.window.showWarningMessage(
        `Review files were created, but VS Code could not open them: ${(error as Error).message}`
      );
    }
    const ratificationArgs = sgosRatificationPreviewArguments(selection);
    const guidance = commandGuidance(sgosCommand(ratificationArgs));
    const action = await vscode.window.showInformationMessage(
      `Created ${selection.declarationOut} and ${selection.workflowOut}. The Workflow is not ratified or executable.${guidance
        ? `\nShell: ${guidance.command}\nCopilot: ${guidance.copilotCommand}` : ''}`,
      ...(guidance?.copyable ? ['Copy Shell preview', 'Copy Copilot preview'] : []), 'Open Command Center'
    );
    if (action === 'Copy Shell preview' && guidance?.copyable) {
      const command = sgosTerminalCommand(
        ratificationArgs, this.repository, process.platform === 'win32' ? 'powershell' : 'posix',
        [this.client.location.executable, this.client.location.cli], true
      );
      await vscode.env.clipboard.writeText(command);
      await vscode.window.showInformationMessage('Copied the read-only ratification-packet command for review.');
    } else if (action === 'Copy Copilot preview' && guidance?.copyable) {
      await vscode.env.clipboard.writeText(guidance.copilotCommand);
      await vscode.window.showInformationMessage('Copied the Copilot ratification-packet preview command.');
    } else if (action === 'Open Command Center') {
      await vscode.commands.executeCommand('singularityFlow.openCommandCenter');
    }
  }

  private async receive(value: unknown): Promise<void> {
    if (this.disposed || !value || typeof value !== 'object') return;
    const message = value as { type?: unknown; field?: unknown; fields?: unknown };
    if (this.state.busy && message.type !== 'change') return;
    if (message.type === 'change' && message.fields && typeof message.fields === 'object') {
      this.update(message.fields as Record<string, unknown>);
    } else if (message.type === 'browse' && INPUT_FIELDS.has(message.field as InputField)) {
      const field = message.field as InputField;
      const label = field === 'intentPath' ? 'Confirmed Intent IR'
        : field === 'policyPath' ? 'Policy snapshot' : 'Operation registry snapshot';
      const selected = await browseJson(this.repository, `SGOS Workflow · ${label}`);
      if (selected) this.update({ [field]: selected });
    } else if (message.type === 'guide') {
      if (message.fields && typeof message.fields === 'object') this.update(message.fields as Record<string, unknown>);
      await this.guide();
    } else if (message.type === 'create') {
      if (message.fields && typeof message.fields === 'object') this.update(message.fields as Record<string, unknown>);
      await this.create();
    }
  }
}

/** Open or reveal the native, storyless SGOS Workflow creator. No mutation occurs on open. */
export async function showSgosWorkflowCreator(client: SingularityFlowClient): Promise<void> {
  return SgosWorkflowCreatePanel.show(client);
}
