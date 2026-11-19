/**
 * Singularity Flow: Update SFlow… — download the .tgz and .vsix from the saved SharePoint link (or take
 * them from a folder), check they are one build, install the CLI where it is installed now, reinstall
 * the Copilot plugin, and install the VSIX into this VS Code.
 *
 * The update runs in a VS Code terminal, not in this extension host: the terminal's process belongs
 * to VS Code's terminal host, so it keeps running, and keeps showing each step, while the VSIX
 * replaces this extension or the window reloads. It runs a copy of the updater this VSIX ships
 * (cli/runtime), taken into a private run folder first, so neither a broken or old installed CLI nor
 * the files the update replaces can change it mid-run. The updater writes a small result file; this
 * window, or the window after a reload, reads it and shows the end screen.
 */
import * as vscode from 'vscode';
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { showCompactInformationMessage, showCompactWarningMessage } from '../compact-message.ts';
import { activeSource, loadConfig, privateDirectory, sourceArgument, updaterHome,
  type UpdaterSettings } from '../../../../runtime/updater/source.mjs';
import { describeCliInstall, detectCliInstall, updateSteps, type CliInstallPlan } from '../../../../runtime/updater/cli-detect.mjs';
import { UPDATER_FILES } from '../../../../runtime/updater/files.mjs';
import {
  confirmationDetail, confirmationSummary, endScreen, linkProblem, PENDING_UPDATE_KEY, UPDATE_TERMINAL_NAME, updaterArguments,
  updaterSourceRoot, vscodeExtensionsDirectory, vscodeLauncher,
  type PendingUpdate, type UpdateRunResult, type UpdateSourceChoice
} from '../sflow-update-model.ts';

export interface SflowUpdateHost {
  context: vscode.ExtensionContext;
  /** The CLI file this window runs now, when one resolves. */
  currentCli(): string | null;
  output: { appendLine(text: string): void };
}

const watched = new Set<string>();

function home(): string { return updaterHome(process.env, os.homedir()); }

async function savedSettings(): Promise<UpdaterSettings> {
  try { return await loadConfig(home()); }
  catch { return {}; }
}

/** The folder the person picks must hold a .tgz and a .vsix; the updater picks the newest matching pair. */
async function folderProblem(folder: string): Promise<string | null> {
  const names = await readdir(folder).catch(() => null);
  if (!names) return `${folder} cannot be read.`;
  const has = (suffix: string) => names.some((name) => name.toLowerCase().endsWith(suffix));
  if (!has('.tgz') || !has('.vsix')) return `${folder} does not hold an SFlow .tgz and .vsix side by side.`;
  return null;
}

type SourceItem = vscode.QuickPickItem & { choice: 'link' | 'downloaded' | 'saved'; saved?: UpdateSourceChoice };

/** "Paste the SharePoint link you were given to install SFlow", with downloaded files as the other way. */
export async function askSource(saved: UpdaterSettings): Promise<UpdateSourceChoice | undefined> {
  for (;;) {
    const picked = await new Promise<{ item: SourceItem; value: string } | undefined>((resolve) => {
      const pick = vscode.window.createQuickPick<SourceItem>();
      pick.title = 'Update SFlow: where are the packages?';
      pick.placeholder = 'Paste the SharePoint link you were given to install SFlow';
      pick.ignoreFocusOut = true;
      const downloaded: SourceItem = { choice: 'downloaded', label: '$(folder-opened) Use files I already downloaded…',
        detail: 'Choose the folder that holds the SFlow .tgz and .vsix.', alwaysShow: true };
      const remembered: SourceItem[] = [
        ...(saved.source ? [{ choice: 'saved' as const, label: '$(link) Use the saved SharePoint link', detail: saved.source,
          saved: { mode: 'folder' as const, source: saved.source }, alwaysShow: true }] : []),
        ...(saved.localFolder ? [{ choice: 'saved' as const, label: '$(folder) Use the saved folder', detail: saved.localFolder,
          saved: { mode: 'local-folder' as const, localFolder: saved.localFolder }, alwaysShow: true }] : [])
      ];
      const render = () => {
        const value = pick.value.trim();
        const problem = linkProblem(value);
        pick.items = value
          ? [{ choice: 'link', label: '$(link) Use this link', detail: problem ? `$(warning) ${problem}` : value, alwaysShow: true }, downloaded]
          : [...remembered, downloaded];
      };
      render();
      let settled = false;
      pick.onDidChangeValue(render);
      pick.onDidAccept(() => {
        const item = pick.activeItems[0] ?? pick.selectedItems[0];
        if (!item) return;
        if (item.choice === 'link' && linkProblem(pick.value)) return;
        settled = true;
        resolve({ item, value: pick.value.trim() });
        pick.hide();
      });
      pick.onDidHide(() => { if (!settled) resolve(undefined); pick.dispose(); });
      pick.show();
    });
    if (!picked) return undefined;
    if (picked.item.choice === 'saved') return picked.item.saved;
    if (picked.item.choice === 'link') {
      try { return sourceArgument(picked.value); }
      catch (error) {
        const next = await showCompactWarningMessage((error as Error).message, 'Paste another link');
        if (next !== 'Paste another link') return undefined;
        continue;
      }
    }
    const folders = await vscode.window.showOpenDialog({
      title: 'Folder with the SFlow .tgz and .vsix', canSelectFolders: true, canSelectFiles: false,
      canSelectMany: false, openLabel: 'Use this folder'
    });
    const folder = folders?.[0]?.fsPath;
    if (!folder) continue;
    const problem = await folderProblem(folder);
    if (!problem) return { mode: 'local-folder', localFolder: path.resolve(folder) };
    const next = await showCompactWarningMessage(`${problem} Put the SFlow .tgz and .vsix there, or paste the SharePoint link instead.`,
      'Choose again');
    if (next !== 'Choose again') return undefined;
  }
}

/** When singularityFlow.cliPath names another CLI, the update points VS Code at the updated one (said in the confirmation). */
function settingChange(plan: CliInstallPlan): { text: string; value: string } | null {
  const inspected = vscode.workspace.getConfiguration('singularityFlow').inspect?.<string>('cliPath');
  const configured = (inspected?.workspaceValue ?? inspected?.globalValue ?? '').trim();
  if (!configured) return null;
  if (plan.route === 'npm-global' && plan.cli && path.resolve(configured) !== path.resolve(plan.cli)) {
    return { text: `VS Code is set to use the CLI at ${configured} (singularityFlow.cliPath). After the update it uses the updated CLI in ${plan.prefix} instead.`,
      value: plan.cli };
  }
  if (plan.route === 'managed') {
    return { text: `VS Code is set to use the CLI at ${configured} (singularityFlow.cliPath). After the update it uses the CLI in SFlow's own folder instead, and that setting is cleared.`,
      value: '' };
  }
  return null;
}

function extensionVersion(context: vscode.ExtensionContext): string | null {
  const version = (context.extension?.packageJSON as { version?: unknown } | undefined)?.version;
  return typeof version === 'string' ? version : null;
}

/** The Node that runs the updater: this VS Code's own runtime as Node, which is always there. */
function updaterRuntime(): { executable: string; env: Record<string, string> } {
  const major = Number(process.versions.node.split('.')[0]);
  const configured = vscode.workspace.getConfiguration('singularityFlow').get<string>('nodePath')?.trim();
  if (major < 22 && configured) return { executable: configured, env: {} };
  return { executable: process.execPath, env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
}

function vscodeProduct(): { applicationName?: string; dataFolderName?: string } {
  try { return JSON.parse(readFileSync(path.join(vscode.env.appRoot ?? '', 'product.json'), 'utf8')); }
  catch { return {}; }
}

/** Copy the updater this extension ships into a private run folder; keep the three newest runs. */
async function prepareRun(host: SflowUpdateHost): Promise<{ runDirectory: string; script: string; resultFile: string }> {
  const runs = path.join(home(), 'vscode-runs');
  await privateDirectory(home());
  await privateDirectory(runs);
  const pending = host.context.globalState.get<PendingUpdate>(PENDING_UPDATE_KEY);
  const old = (await readdir(runs).catch(() => [] as string[])).filter((name) => /^run-[A-Za-z0-9]+$/u.test(name)).sort();
  for (const name of old.slice(0, Math.max(0, old.length - 2))) {
    const directory = path.join(runs, name);
    if (pending?.runDirectory !== directory) await rm(directory, { recursive: true, force: true });
  }
  const runDirectory = await mkdtemp(path.join(runs, 'run-'));
  const root = updaterSourceRoot(host.context.extensionPath, existsSync);
  for (const relative of UPDATER_FILES) {
    const target = path.join(runDirectory, 'updater', ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(path.join(root, ...relative.split('/')), target);
  }
  return { runDirectory, script: path.join(runDirectory, 'updater', 'runtime', 'update.mjs'), resultFile: path.join(runDirectory, 'result.json') };
}

async function readResult(file: string): Promise<UpdateRunResult | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as UpdateRunResult; } catch { return null; }
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function updateTerminal(name: string): vscode.Terminal | undefined {
  return (vscode.window.terminals ?? []).find((terminal) => terminal.name === name);
}

/** Show the end screen once, even when two windows watch the same run: the result file is claimed by rename. */
async function finish(host: SflowUpdateHost, pending: PendingUpdate, stopped: boolean): Promise<void> {
  const claimed = pending.resultFile + '.shown';
  const result = await readResult(pending.resultFile);
  try { await rename(pending.resultFile, claimed); }
  catch { if (result || !stopped) return; }
  watched.delete(pending.runDirectory);
  if (host.context.globalState.get<PendingUpdate>(PENDING_UPDATE_KEY)?.runDirectory === pending.runDirectory) {
    await host.context.globalState.update(PENDING_UPDATE_KEY, undefined);
  }
  host.output.appendLine(`Update SFlow ended: ${result?.status ?? 'stopped'}${result?.error ? ` — ${result.error}` : ''}`);
  if (result?.status === 'complete') {
    const change = host.context.globalState.get<string>(`${PENDING_UPDATE_KEY}.cliPath`);
    if (change !== undefined) {
      await host.context.globalState.update(`${PENDING_UPDATE_KEY}.cliPath`, undefined);
      const settings = vscode.workspace.getConfiguration('singularityFlow');
      const inspected = settings.inspect?.<string>('cliPath');
      const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await settings.update('cliPath', change || undefined, target);
    }
  }
  await showEnd(host, pending, endScreen(result, { stopped }));
}

async function showEnd(host: SflowUpdateHost, pending: PendingUpdate, screen: ReturnType<typeof endScreen>, modal = true): Promise<void> {
  const terminal = updateTerminal(pending.terminalName);
  const actions = screen.actions.filter((action) => action !== 'Show log' || terminal);
  const show = screen.kind === 'success' ? showCompactInformationMessage : showCompactWarningMessage;
  const choice = modal
    ? await show(screen.message, { modal: true, detail: screen.detail, compactDetail: screen.summary }, ...actions)
    : await show(`${screen.message}. ${screen.detail}`, ...actions);
  if (choice === 'Reload Window') return void vscode.commands.executeCommand('workbench.action.reloadWindow');
  if (choice === 'Try again') return updateSflow(host, { source: pending.source, confirmed: true });
  if (choice === 'Change source…') return updateSflow(host, { changeSource: true });
  if (choice === 'Show log') {
    terminal?.show(false);
    return showEnd(host, pending, screen, false);
  }
}

/** Watch one run until its result says it ended, or its terminal closes without one. */
function watch(host: SflowUpdateHost, pending: PendingUpdate): void {
  if (watched.has(pending.runDirectory)) return;
  watched.add(pending.runDirectory);
  let done = false;
  const stop = (stopped: boolean) => {
    if (done) return;
    done = true;
    clearInterval(timer);
    closed.dispose();
    void finish(host, pending, stopped);
  };
  const timer = setInterval(() => {
    void readResult(pending.resultFile).then((result) => {
      if (!result) return;
      if (result.status !== 'running') stop(false);
      else if (!alive(result.pid)) stop(true);
    });
  }, 1000);
  // The poll ends with the run; it must never be what keeps a host process alive.
  (timer as { unref?: () => void }).unref?.();
  const closed = vscode.window.onDidCloseTerminal?.((terminal) => {
    if (terminal.name !== pending.terminalName || done) return;
    setTimeout(() => void readResult(pending.resultFile).then((result) => {
      if (!result || result.status === 'running') stop(true); else stop(false);
    }), 750);
  }) ?? { dispose() {} };
  host.context.subscriptions.push({ dispose: () => { clearInterval(timer); closed.dispose(); } });
}

/** A window that reloaded (or whose extension was replaced) mid-run picks the run up again. */
export async function resumeSflowUpdate(host: SflowUpdateHost): Promise<void> {
  const pending = host.context.globalState.get<PendingUpdate>(PENDING_UPDATE_KEY);
  if (!pending?.resultFile) return;
  const result = await readResult(pending.resultFile);
  if (!result) {
    // Already shown by another window, or never started: nothing is left to report.
    await host.context.globalState.update(PENDING_UPDATE_KEY, undefined);
    return;
  }
  if (result.status === 'running' && alive(result.pid)) return watch(host, pending);
  await finish(host, pending, result.status === 'running');
}

/** The menu. `source` and `confirmed` come from Try again; `changeSource` from Change source…. */
export async function updateSflow(host: SflowUpdateHost, request: { source?: UpdateSourceChoice; confirmed?: boolean; changeSource?: boolean } = {}): Promise<void> {
  const running = host.context.globalState.get<PendingUpdate>(PENDING_UPDATE_KEY);
  if (running) {
    const result = await readResult(running.resultFile);
    if (result?.status === 'running' && alive(result.pid)) {
      const next = await showCompactInformationMessage('An SFlow update is already running in the "Update SFlow" terminal.', 'Show progress');
      if (next === 'Show progress') updateTerminal(running.terminalName)?.show(false);
      watch(host, running);
      return;
    }
  }
  const saved = await savedSettings();
  let source = request.changeSource ? await askSource(saved) : request.source ?? activeSource(saved) ?? await askSource(saved);
  let confirmed = Boolean(request.confirmed && request.source);
  for (;;) {
    if (!source) return;
    const plan = detectCliInstall({ currentCli: host.currentCli(), environment: process.env, homeDirectory: os.homedir() });
    if (plan.route === 'unsupported') {
      const next = await showCompactWarningMessage(`SFlow was not updated. ${plan.reason}`, { modal: true }, 'Open help');
      if (next === 'Open help') void vscode.commands.executeCommand('singularityFlow.openHelp');
      return;
    }
    const change = settingChange(plan);
    if (!confirmed) {
      const installedExtension = extensionVersion(host.context);
      const choice = await showCompactWarningMessage('Update SFlow?', {
        modal: true,
        detail: confirmationDetail({ source, installed: describeCliInstall(plan), extensionVersion: installedExtension,
          steps: updateSteps(plan, source.mode), others: plan.others ?? [], settingChange: change?.text ?? null }),
        compactDetail: confirmationSummary({ source, route: plan.route, version: plan.version, prefix: plan.prefix,
          extensionVersion: installedExtension })
      }, 'Update', 'Change source…');
      if (choice === 'Change source…') { source = await askSource(saved); continue; }
      if (choice !== 'Update') return;
    }
    await host.context.globalState.update(`${PENDING_UPDATE_KEY}.cliPath`, change ? change.value : undefined);
    return start(host, source);
  }
}

async function start(host: SflowUpdateHost, source: UpdateSourceChoice): Promise<void> {
  let run: Awaited<ReturnType<typeof prepareRun>>;
  try { run = await prepareRun(host); }
  catch (error) {
    const next = await showCompactWarningMessage(`SFlow was not updated: its updater could not be prepared. ${(error as Error).message}`, 'Try again');
    if (next === 'Try again') return updateSflow(host, { source, confirmed: true });
    return;
  }
  const appRoot = vscode.env.appRoot;
  const product = vscodeProduct();
  const launcher = vscodeLauncher(appRoot, process.platform, product.applicationName, existsSync);
  const extensionsDirectory = vscodeExtensionsDirectory({
    extensionPath: host.context.extensionPath, production: host.context.extensionMode === (vscode.ExtensionMode?.Production ?? 1),
    environment: process.env, homeDirectory: os.homedir(), dataFolderName: product.dataFolderName, platform: process.platform
  });
  const runtime = updaterRuntime();
  const args = updaterArguments({ script: run.script, source, resultFile: run.resultFile, currentCli: host.currentCli(),
    launcher, extensionsDirectory });
  const pending: PendingUpdate = { runDirectory: run.runDirectory, resultFile: run.resultFile, terminalName: UPDATE_TERMINAL_NAME,
    source, startedAt: new Date().toISOString() };
  await host.context.globalState.update(PENDING_UPDATE_KEY, pending);
  updateTerminal(UPDATE_TERMINAL_NAME)?.dispose();
  const terminal = vscode.window.createTerminal({
    name: UPDATE_TERMINAL_NAME, shellPath: runtime.executable, shellArgs: args, cwd: os.homedir(),
    env: runtime.env, iconPath: new vscode.ThemeIcon('cloud-download')
  });
  terminal.show(false);
  host.output.appendLine(`Update SFlow started in the "${UPDATE_TERMINAL_NAME}" terminal: ${run.runDirectory}`);
  watch(host, pending);
}
