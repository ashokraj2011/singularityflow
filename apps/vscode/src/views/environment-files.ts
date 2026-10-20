/**
 * "Singularity Flow: Environment Files" (lazy panels runtime). [ENVF, docs/SPEC-ENVIRONMENT-FILES-v1.md]
 *
 * The page reads `env files --json` (with `--workspace` for every member repository) and shows each
 * environment's files. Its actions run the engine's commands and nothing else: Create from template
 * (`env files create --from-template`), Use existing file… (a file picker, then `env files link
 * --to`), Adopt, Stop using linked file, Add personal file… and Remove, Set folder for <ENV>… and
 * Clear (`env files root`). Open and Reveal ask `env files path --json` where the real file is now
 * and open that file in an ordinary editor tab, or in the system's file manager. The list is read
 * again after every action.
 *
 * VS Code never reads, shows, copies or writes what an environment file holds: the engine reports
 * paths only, the page shows paths only, and the only file an action creates is the engine's own
 * copy of a template. Every action that changes a file needs a trusted workspace.
 *
 * The run pre-flight (run-and-test.ts) offers the same Create from template and Use existing file…
 * through the helpers below, so the page and a refused run act alike.
 */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import type { CapabilityNode } from '../cli/snapshot.ts';
import { showCompactWarningMessage } from '../compact-message.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { enumField, registerMessageRouter, stringField } from './messages.ts';
import {
  actionArgv, actionNotice, buildEnvironmentFilesView, CHANGING_ACTIONS, envFilesAddArgv, envFilesArgv, envFilesCreateArgv, envFilesLinkArgv,
  envFilesPathArgv, envFilesRootArgv, envFilesSuggestArgv, environmentFilesFrom, environmentFilesUnsupported, FILE_ACTIONS, fileActions, fileByKey,
  locationFrom, personalPathProblem, refusalWords, relativeFilePath, suggestionFrom,
  type EnvironmentFile, type EnvironmentFileSuggestion, type EnvironmentFilesReading, type FileAction, type RepositoryTarget
} from './environment-files-model.ts';
import { environmentFilesHtml, ENVIRONMENT_FILES_SCRIPT, ENVIRONMENT_FILES_STYLE } from './environment-files-page.ts';

export interface EnvironmentFilesHost {
  client: SingularityFlowClient;
  output?: { appendLine(line: string): void };
  activeRepositoryId?(): string | null;
  capabilities?(): CapabilityNode[];
}

export interface EnvironmentFilesTarget { environment?: string | null; capability?: string | null; scope?: 'repository' | 'workspace' | null }

const UNTRUSTED = 'This workspace is not trusted, so Singularity Flow creates, links and moves no environment file here. Trust it (Manage Workspace Trust), then try again.';
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const WORKSPACE_ACTIONS = ['root-set', 'root-clear', 'add', 'suggest', 'copy-draft', 'copy-command'] as const;

/** Whoever shows environment files elsewhere (the Run & test section) reads them again after a change. */
const listeners = new Set<(repository: string) => void>();
export function onEnvironmentFilesChanged(listener: (repository: string) => void): vscode.Disposable {
  listeners.add(listener);
  return { dispose: () => { listeners.delete(listener); } };
}
function announce(host: EnvironmentFilesHost): void {
  for (const listener of [...listeners]) {
    try { listener(host.client.repository); } catch { /* one reader's failure never stops the others */ }
  }
}

/** Nothing that changes a file runs in an untrusted workspace; saying so is the answer. */
export function trustedToChange(): boolean {
  if (vscode.workspace.isTrusted === true) return true;
  void showCompactWarningMessage(UNTRUSTED);
  return false;
}

async function run(host: EnvironmentFilesHost, argv: string[]): Promise<unknown> {
  host.output?.appendLine(`\n$ singularity-flow ${argv.join(' ')}`);
  return host.client.run(argv);
}

/** A command that changes files on this computer: trust first, then the engine, then everyone reads again. */
async function change(host: EnvironmentFilesHost, argv: string[]): Promise<unknown> {
  if (!trustedToChange()) throw new Error(UNTRUSTED);
  try { return await run(host, argv); } finally { announce(host); }
}

const where = async (host: EnvironmentFilesHost, file: EnvironmentFile, target: RepositoryTarget): Promise<string> => {
  const location = locationFrom(await run(host, envFilesPathArgv(file, target)));
  if (!location) throw new Error(`The engine did not say where the real ${file.path} for ${file.environment} is.`);
  return location;
};

/** Open the real file, where `env files path` says it is now, in an ordinary editor tab. */
export async function openEnvironmentFile(host: EnvironmentFilesHost, file: EnvironmentFile, target: RepositoryTarget, known: string | null = null): Promise<string> {
  const location = known ?? await where(host, file, target);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(location));
  await vscode.window.showTextDocument(document, { preview: false });
  return location;
}

/** Create the store file (from its template, or empty), then open it to fill in. */
export async function createEnvironmentFile(host: EnvironmentFilesHost, file: EnvironmentFile, fromTemplate: boolean, target: RepositoryTarget): Promise<string> {
  const result = await change(host, envFilesCreateArgv(file, fromTemplate, target));
  return openEnvironmentFile(host, file, target, locationFrom(result));
}

/** Pick a file the person already has, then `env files link --to` it. False when nothing was picked. */
export async function useExistingEnvironmentFile(host: EnvironmentFilesHost, file: EnvironmentFile, target: RepositoryTarget): Promise<boolean> {
  if (!trustedToChange()) return false;
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true, canSelectFolders: false, canSelectMany: false, openLabel: 'Use this file',
    title: `Use an existing file for ${file.path} (${file.environment})`
  });
  const chosen = picked?.[0]?.fsPath;
  if (!chosen) return false;
  await change(host, envFilesLinkArgv(file, chosen, target));
  return true;
}

const messageOf = (error: unknown): string => refusalWords(error) || String(error);

export class EnvironmentFilesPanel implements vscode.Disposable {
  private static current: EnvironmentFilesPanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  private reading: EnvironmentFilesReading | null = null;
  private unsupported = false;
  private environment: string | null = null;
  private scope: 'repository' | 'workspace' = 'repository';
  private suggestion: EnvironmentFileSuggestion | null = null;
  private notice: string | null = null;
  private error: string | null = null;
  private busy = false;
  private disposed = false;

  private constructor(private readonly panel: vscode.WebviewPanel, private host: EnvironmentFilesHost) {
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      return this.router.route(raw);
    }, null, this.subscriptions);
    panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
    // A file created or linked elsewhere (a refused run's fixes): read again, unless this page is acting.
    this.subscriptions.push(onEnvironmentFilesChanged((repository) => {
      if (!this.busy && repository === this.host.client.repository) void this.guard(() => this.load());
    }));
  }

  /** Open (or retarget) the one page, at an environment when one is named, and read the files fresh. */
  static show(host: EnvironmentFilesHost, target: EnvironmentFilesTarget = {}): EnvironmentFilesPanel {
    const existing = EnvironmentFilesPanel.current;
    const created = existing && existing.host.client === host.client ? existing : null;
    if (!created) existing?.panel.dispose();
    const panel = created ?? new EnvironmentFilesPanel(vscode.window.createWebviewPanel('singularityFlow.environmentFiles', 'Environment Files',
      vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true }), host);
    panel.host = host;
    if (target.environment && ENVIRONMENT.test(target.environment)) panel.environment = target.environment;
    if (target.scope === 'repository' || target.scope === 'workspace') panel.scope = target.scope;
    EnvironmentFilesPanel.current = panel;
    if (created) panel.panel.reveal(vscode.ViewColumn.Active);
    void panel.guard(() => panel.load());
    return panel;
  }

  private router = registerMessageRouter('singularityFlow.environmentFiles', {
    'envFiles.refresh': () => this.guard(() => this.load()),
    'envFiles.environment': (message) => this.selectEnvironment(stringField(message, 'environment')),
    'envFiles.scope': (message) => this.guard(() => this.setScope(enumField(message, 'scope', ['repository', 'workspace'] as const))),
    'envFiles.action': (message) => this.guard(() => this.act(enumField(message, 'action', FILE_ACTIONS), stringField(message, 'key'))),
    'envFiles.workspace': (message) => this.guard(() => this.workspace(enumField(message, 'action', WORKSPACE_ACTIONS)))
  });

  /** One operation at a time: a second click while one runs does nothing. */
  private async guard(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    await action();
  }

  private target(): RepositoryTarget {
    return { activeRepository: this.host.activeRepositoryId?.() ?? null, scope: this.scope };
  }

  /** Read the files as they stand now; a failed read keeps the last list on screen with the error. */
  private async load(): Promise<void> {
    this.busy = true; this.render();
    try {
      const reading = environmentFilesFrom(await this.host.client.run(envFilesArgv({ scope: this.scope })));
      if (!reading) throw new Error('The environment files could not be read from the engine\'s answer.');
      this.reading = reading;
      this.unsupported = false;
    } catch (error) {
      if (environmentFilesUnsupported(error)) { this.unsupported = true; this.reading = null; }
      else this.error = messageOf(error);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private selectEnvironment(environment: string | null): void {
    if (!environment || !ENVIRONMENT.test(environment) || this.busy) return;
    if (!this.reading?.environments.includes(environment) && environment !== this.environment) return;
    this.environment = environment;
    this.notice = null; this.error = null;
    this.render();
  }

  private async setScope(scope: 'repository' | 'workspace' | null): Promise<void> {
    if (!scope || scope === this.scope) return;
    this.scope = scope;
    this.notice = null; this.error = null; this.suggestion = null;
    await this.load();
  }

  /** One file's action, checked again against the file as last read and its status. */
  private async act(action: FileAction | null, key: string | null): Promise<void> {
    const file = fileByKey(this.reading?.files ?? [], key);
    if (!action || !file || !fileActions(file).includes(action)) return;
    this.notice = null; this.error = null;
    if (CHANGING_ACTIONS.has(action) && !trustedToChange()) { this.error = UNTRUSTED; return this.render(); }
    const target = this.target();
    let changed = CHANGING_ACTIONS.has(action);
    this.busy = true; this.render();
    try {
      switch (action) {
        case 'open': await openEnvironmentFile(this.host, file, target); break;
        case 'reveal': await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(await where(this.host, file, target))); break;
        case 'create': case 'create-empty': await createEnvironmentFile(this.host, file, action === 'create', target); break;
        case 'link':
          if (!await useExistingEnvironmentFile(this.host, file, target)) { changed = false; this.notice = 'No file was chosen; nothing changed.'; return; }
          break;
        case 'remove': {
          const remove = 'Remove';
          const answer = await showCompactWarningMessage(`Remove ${file.path} as a personal file for ${file.environment}?`, {
            modal: true, detail: 'Singularity Flow stops placing and protecting it for runs in this environment on this computer. Nothing reaches Git.'
          }, remove);
          if (answer !== remove) { changed = false; this.notice = 'Nothing was removed.'; return; }
          await change(this.host, actionArgv(action, file, target)!);
          break;
        }
        default: await change(this.host, actionArgv(action, file, target)!);
      }
      if (changed) this.notice = actionNotice(action, { environment: file.environment, path: file.path });
    } catch (error) {
      this.error = messageOf(error);
    } finally {
      this.busy = false;
      if (changed && !this.disposed) await this.load(); else this.render();
    }
  }

  /** The workspace folder for the selected environment, personal files, and the team's draft. */
  private async workspace(action: typeof WORKSPACE_ACTIONS[number] | null): Promise<void> {
    const environment = this.environment;
    if (!action) return;
    this.notice = null; this.error = null;
    if (action === 'copy-draft' || action === 'copy-command') {
      const value = action === 'copy-draft' ? this.suggestion?.valid ? this.suggestion.draft : null : this.suggestion?.command;
      if (!value) return;
      await vscode.env.clipboard.writeText(value);
      void vscode.window.setStatusBarMessage(action === 'copy-draft'
        ? '$(clippy) Copied the drafted singularity/environments.yml. It holds names and paths, never a secret value.' : '$(clippy) Copied the command.', 4_000);
      return;
    }
    if (action === 'suggest') return this.suggest();
    if (!environment) return;
    if (!trustedToChange()) { this.error = UNTRUSTED; return this.render(); }
    let argv: string[] | null = null;
    let notice = '';
    if (action === 'root-set') {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: `Use for ${environment}`,
        title: `Folder for ${environment} files, for every repository of the workspace`
      });
      const directory = picked?.[0]?.fsPath;
      if (!directory) { this.notice = 'No folder was chosen; nothing changed.'; return this.render(); }
      argv = envFilesRootArgv(environment, directory);
      notice = actionNotice('root', { environment, directory });
    } else if (action === 'root-clear') {
      argv = envFilesRootArgv(environment, null);
      notice = actionNotice('root-clear', { environment });
    } else {
      const typed = await vscode.window.showInputBox({
        title: `Add a personal file for ${environment}`, placeHolder: 'apps/web/.env.local', ignoreFocusOut: true,
        prompt: 'Its path in this repository, relative to its root. Only you use it; Singularity Flow keeps it out of Git like a declared file.',
        validateInput: (value) => personalPathProblem(value)
      });
      if (typed === undefined) return;
      const problem = personalPathProblem(typed);
      if (problem) { this.error = problem; return this.render(); }
      const filePath = relativeFilePath(typed)!;
      argv = envFilesAddArgv(environment, filePath);
      notice = actionNotice('add', { environment, path: filePath });
    }
    this.busy = true; this.render();
    try {
      await change(this.host, argv);
      this.notice = notice;
    } catch (error) {
      this.error = messageOf(error);
    } finally {
      this.busy = false;
    }
    if (!this.disposed) await this.load();
  }

  /** `env files suggest --json`: the engine's candidates and environments.yml draft, never values. */
  private async suggest(): Promise<void> {
    this.busy = true; this.render();
    try {
      const suggestion = suggestionFrom(await run(this.host, envFilesSuggestArgv()));
      if (!suggestion) throw new Error('The suggestions could not be read from the engine\'s answer.');
      this.suggestion = suggestion;
    } catch (error) {
      this.error = environmentFilesUnsupported(error) ? 'This Singularity Flow cannot suggest environment files yet.' : messageOf(error);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private appNames(): Record<string, string> {
    const names: Record<string, string> = {};
    const visit = (nodes: CapabilityNode[]) => { for (const node of nodes) { if (node.name) names[node.id] = node.name; visit(node.children ?? []); } };
    visit(this.host.capabilities?.() ?? []);
    return names;
  }

  private render(): void {
    if (this.disposed) return;
    const view = buildEnvironmentFilesView(this.reading, {
      environment: this.environment, scope: this.scope, trusted: vscode.workspace.isTrusted === true, busy: this.busy,
      notice: this.notice, error: this.error, unsupported: this.unsupported, suggestion: this.suggestion,
      activeRepository: this.host.activeRepositoryId?.() ?? null, appNames: this.appNames()
    });
    this.environment = view.environment;
    const title = view.environment ? `Environment Files · ${view.environment}` : 'Environment Files';
    const token = nonce();
    this.panel.title = title;
    this.panel.webview.html = page(title, environmentFilesHtml(view), contentSecurityPolicy(this.panel.webview, token), token,
      ENVIRONMENT_FILES_SCRIPT, { styles: ENVIRONMENT_FILES_STYLE });
  }

  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    if (EnvironmentFilesPanel.current === this) EnvironmentFilesPanel.current = null;
  }
}

/**
 * `singularityFlow.openEnvironmentFiles`: "Singularity Flow: Environment Files". Other surfaces pass
 * `{ environment, capability, scope }` (or an environment name as a string) to open it there.
 */
export function environmentFilesCommand(host: EnvironmentFilesHost, target?: unknown): void {
  const requested = (typeof target === 'string' ? { environment: target } : target && typeof target === 'object' ? target : {}) as
    { environment?: unknown; capability?: unknown; scope?: unknown };
  EnvironmentFilesPanel.show(host, {
    environment: typeof requested.environment === 'string' ? requested.environment : null,
    capability: typeof requested.capability === 'string' ? requested.capability : null,
    scope: requested.scope === 'workspace' ? 'workspace' : requested.scope === 'repository' ? 'repository' : null
  });
}
