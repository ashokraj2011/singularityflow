#!/usr/bin/env node
/**
 * Update SFlow from the SharePoint folder link people are given (saved once), or from a folder on this
 * computer that holds the downloaded .tgz and .vsix. Runs as `singularity-flow update`, from VS Code's
 * Update SFlow… menu, or from update-sflow.sh / update-sflow.ps1. The CLI is updated where it is
 * installed now (runtime/updater/cli-install.mjs), so a machine never ends with two SFlow CLIs.
 */
import { chmod, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { inspectPair } from './updater/artifacts.mjs';
import { downloadPair } from './updater/sharepoint.mjs';
import { installPackages } from './updater/installer.mjs';
import { isMainModule } from './updater/entry.mjs';
import { copyLocalPair } from './updater/local-folder.mjs';
import { describeCliInstall, detectCliInstall, installNpmGlobal, updateSteps, vscodeCli } from './updater/cli-install.mjs';
import { activeSource, describeSource, loadConfig, privateDirectory, savedSettings, saveConfig, sourceArgument, sourceError,
  timeoutSeconds, updaterHome } from './updater/source.mjs';
export { runtimePathFromOutput } from './updater/installer.mjs';
export { inspectPair } from './updater/artifacts.mjs';
export { loadConfig, saveConfig, privateDirectory, timeoutSeconds } from './updater/source.mjs';

const fail = message => { throw new Error(message); };
const VALUE_OPTIONS = { '--source': 'source', '--folder': 'source', '--local-folder': 'localFolder', '--timeout-seconds': 'timeout',
  '--current-cli': 'currentCli', '--code': 'code', '--code-extensions-dir': 'codeExtensionsDir', '--result': 'result' };

export function parseOptions(argv, { platform = process.platform, cwd = process.cwd() } = {}) {
  const options = {};
  const setSource = value => {
    if (options.source !== undefined || options.localFolder !== undefined) fail('Give the folder link/timeout only once.');
    const chosen = sourceArgument(value, { platform, cwd });
    if (chosen.mode === 'folder') options.source = chosen.source; else options.localFolder = chosen.localFolder;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], field = VALUE_OPTIONS[arg];
    if (field) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail(arg + ' requires a value.');
      const value = argv[++i];
      if (field === 'source') setSource(value);
      else if (field === 'localFolder') setSource(path.isAbsolute(value) || path.win32.isAbsolute(value) ? value : path.resolve(cwd, value));
      else {
        if (options[field] !== undefined) fail('Give the folder link/timeout only once.');
        options[field] = value;
      }
    } else if (arg === '--check-only') options.checkOnly = true;
    else if (arg === '--reinstall') options.reinstall = true;
    else if (arg === '--reinstall-copilot') options.reinstallCopilot = true;
    else if (arg === '--hold') options.hold = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (!arg.startsWith('-') && options.source === undefined && options.localFolder === undefined) setSource(arg);
    else fail('Unknown argument: ' + arg + '. Use --help.');
  }
  if (options.timeout !== undefined) options.timeout = timeoutSeconds(options.timeout);
  for (const field of ['currentCli', 'code', 'codeExtensionsDir', 'result']) {
    if (options[field] !== undefined && !(path.isAbsolute(options[field]) || path.win32.isAbsolute(options[field]))) fail('--' + field.replace(/[A-Z]/gu, c => '-' + c.toLowerCase()) + ' must be an absolute path.');
  }
  return options;
}

/** A small JSON record VS Code reads to show the end screen; written whole, never half. */
async function report(file, value) {
  if (!file) return;
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, pid: process.pid, ...value, updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export async function runUpdate(options, { environment = process.env, homeDirectory = os.homedir(),
  downloader = downloadPair, installer = installPackages, npmInstaller = installNpmGlobal, copier = copyLocalPair,
  detect = detectCliInstall, log = console.log, askSource = null } = {}) {
  const directory = updaterHome(environment, homeDirectory);
  await privateDirectory(directory);
  await report(options.result, { status: 'running' });
  const saved = await loadConfig(directory);
  let chosen = options.source ? { mode: 'folder', source: options.source }
    : options.localFolder ? { mode: 'local-folder', localFolder: options.localFolder } : activeSource(saved);
  if (!chosen && askSource) {
    const answer = await askSource();
    chosen = answer ? sourceArgument(answer) : null;
  }
  if (!chosen) throw sourceError('First run: give the SharePoint link you were given to install SFlow after the command, for example: singularity-flow update --source \'LINK\'.', 'SOURCE_MISSING');
  const timeout = timeoutSeconds(options.timeout ?? saved.timeoutSeconds ?? 900);
  const plan = detect({ currentCli: options.currentCli ?? null, environment, homeDirectory });
  if (plan.route === 'unsupported') throw Object.assign(new Error(plan.reason), { code: plan.code });
  log('Source: ' + describeSource(chosen) + '.');
  log(describeCliInstall(plan));
  for (const other of plan.others ?? []) log('Another SFlow CLI is installed in ' + other + '; it is left as it is.');
  if (!options.checkOnly) log('Steps:\n' + updateSteps(plan, chosen.mode).map((step, index) => '  ' + (index + 1) + '. ' + step).join('\n'));
  const work = await mkdtemp(path.join(directory, 'stage-')); await chmod(work, 0o700);
  await report(options.result, { status: 'running', work });
  let completed = false;
  try {
    const downloaded = chosen.mode === 'local-folder'
      ? await copier(chosen.localFolder, work, { log })
      : await downloader(chosen.source, work, { timeout, environment, log });
    log('Checking the CLI and VS Code build match…');
    const inspected = await inspectPair(downloaded.tarball, downloaded.vsix);
    const pair = { ...downloaded, cliSha256: inspected.cliSha256, vsixSha256: inspected.vsixSha256,
      version: inspected.version, buildInfoSource: inspected.buildInfoSource };
    await saveConfig(directory, savedSettings(saved, chosen, timeout));
    log('SFlow ' + inspected.version + ' packages match. ' + (chosen.mode === 'local-folder' ? 'Folder saved.' : 'Folder link saved.'));
    if (options.checkOnly) {
      completed = true;
      await report(options.result, { status: 'checked', version: inspected.version, route: plan.route });
      return { status: 'checked', installed: false, version: inspected.version, route: plan.route };
    }
    let installed;
    if (plan.route === 'npm-global') {
      const code = options.code ? vscodeCli(options.code, { extensionsDirectory: options.codeExtensionsDir ?? null }) : null;
      installed = await npmInstaller(pair, { plan, work, environment, homeDirectory, log, code });
    } else {
      log(options.reinstall ? 'Reinstalling SFlow CLI, VS Code and Copilot…' : 'Updating SFlow CLI, VS Code and Copilot…');
      const hostEnvironment = { ...environment,
        ...(options.code ? { SINGULARITY_FLOW_CODE_COMMAND: options.code } : {}),
        ...(options.codeExtensionsDir ? { VSCODE_EXTENSIONS: path.resolve(options.codeExtensionsDir) } : {}) };
      // The Copilot plugin is always uninstalled and installed again (owner, 2026-11-19); --reinstall also redoes VS Code.
      await installer(pair, { environment: hostEnvironment, reinstall: Boolean(options.reinstall),
        reinstallCopilot: options.reinstallCopilot !== false });
      installed = { route: 'managed', cli: null, version: inspected.version };
    }
    completed = true;
    log('SFlow ' + inspected.version + ' is installed. Reload VS Code, restart Copilot CLI sessions and open a new terminal to use it.');
    await report(options.result, { status: 'complete', version: inspected.version, route: installed.route, cli: installed.cli ?? null });
    return { status: 'complete', installed: true, version: inspected.version, route: installed.route, cli: installed.cli ?? null };
  } catch (error) {
    const empty = (await readdir(work).catch(() => [])).length === 0;
    if (empty) await rm(work, { recursive: true, force: true });
    const kept = empty ? '' : '\nDownloaded work was retained: ' + work;
    await report(options.result, { status: 'failed', error: error.message, code: error.code ?? null,
      sourceProblem: Boolean(error.sourceProblem), work: empty ? null : work, route: plan.route }).catch(() => {});
    throw Object.assign(new Error(error.message + kept
      + '\nYour existing workspace and recovery files were preserved. Resolve the reported cause and run the updater again.', { cause: error }),
    { code: error.code, sourceProblem: Boolean(error.sourceProblem), work: empty ? null : work });
  } finally { if (completed) await rm(work, { recursive: true, force: true }); }
}

export const HELP = `SFlow updater
Update from the SharePoint link you were given to install SFlow. The first time:
  singularity-flow update --source 'SHAREPOINT_FOLDER_LINK'
Later updates reuse the saved link:
  singularity-flow update
In VS Code: Singularity Flow: Update SFlow… (or Upgrade or Repair… → Update SFlow).

Already downloaded the .tgz and .vsix? Give their folder instead of the link:
  singularity-flow update --local-folder FOLDER

The folder needs the current SFlow .tgz and .vsix. The link or folder is remembered.
The CLI is updated where it is installed now: with npm when it was installed with npm,
otherwise in SFlow's own folder. The Copilot plugin and VS Code extension are reinstalled.
Optional: --check-only (download/check without installation)
          --reinstall (remove/reinstall the SFlow extension and Copilot integration)
          --timeout-seconds 1800 (default 900; minimum 300)
The scripts update-sflow.sh and update-sflow.ps1 take the same arguments.
`;

/** Run with these arguments; resolves to the result, or rejects with a plain message. */
export async function updateCommand(argv, { reinstall = false, interactive = process.stdin.isTTY, log = console.log } = {}) {
  const options = parseOptions(argv);
  if (options.help) { log(HELP); return { status: 'help' }; }
  return runUpdate({ ...options, reinstall: reinstall || options.reinstall }, {
    log,
    askSource: interactive ? async () => {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try { return (await prompt.question('Paste the SharePoint link you were given to install SFlow: ')).trim(); }
      finally { prompt.close(); }
    } : null
  });
}

export async function main({ reinstall = false } = {}) {
  const argv = process.argv.slice(2);
  try { await updateCommand(argv, { reinstall }); }
  catch (error) {
    console.error('SFlow update failed: ' + error.message);
    if (error.sourceProblem) console.error('To use another link: singularity-flow update --source \'LINK\' (or --local-folder FOLDER).');
    process.exitCode = 1;
  }
  // VS Code's terminal closes when its process ends; --hold keeps every step readable until the person closes it.
  if (argv.includes('--hold') && process.stdin.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { await prompt.question('\nPress Enter to close this terminal. '); } finally { prompt.close(); }
    // The result file already told VS Code how the update ended; a non-zero exit here would only add
    // VS Code's own "terminal process terminated with exit code 1" toast on top of SFlow's end screen.
    process.exitCode = 0;
  }
}
if (await isMainModule(import.meta.url)) await main();
