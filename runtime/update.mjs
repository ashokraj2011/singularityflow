#!/usr/bin/env node
/** Give the public SharePoint folder link once; later invocations reuse it. */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPair } from './updater/artifacts.mjs';
import { downloadPair, folderUrl } from './updater/sharepoint.mjs';
import { installPackages } from './updater/installer.mjs';
export { runtimePathFromOutput } from './updater/installer.mjs';
export { inspectPair } from './updater/artifacts.mjs';

const fail = message => { throw new Error(message); };
export function timeoutSeconds(value = 900) {
  if (!/^\d+$/u.test(String(value)) || !Number.isSafeInteger(Number(value))
    || Number(value) < 300 || Number(value) > 3600) fail('Download timeout must be 300–3600 seconds (5–60 minutes).');
  return Number(value);
}
export function parseOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--source', '--folder', '--timeout-seconds'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail(arg + ' requires a value.');
      const field = arg === '--timeout-seconds' ? 'timeout' : 'source';
      if (options[field] !== undefined) fail('Give the folder link/timeout only once.');
      options[field] = argv[++i];
    } else if (arg === '--check-only') options.checkOnly = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (!arg.startsWith('-') && options.source === undefined) options.source = arg;
    else fail('Unknown argument: ' + arg + '. Use --help.');
  }
  if (options.source !== undefined) options.source = folderUrl(options.source);
  if (options.timeout !== undefined) options.timeout = timeoutSeconds(options.timeout);
  return options;
}
export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()
    || (process.platform !== 'win32' && ((info.mode & 0o022) !== 0 || info.uid !== process.getuid()))) fail('Updater directory must be private to this user: ' + directory);
}
async function ordinary(file, maximum = 65536) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum) fail('Updater file is not a bounded ordinary file: ' + file);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size) fail('Updater file changed while opening.');
    const bytes = await handle.readFile();
    if (bytes.length !== opened.size) fail('Updater file changed while reading.');
    return bytes;
  } finally { await handle.close(); }
}
export async function loadConfig(directory) {
  let bytes;
  try { bytes = await ordinary(path.join(directory, 'source.json')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  let value;
  try { value = JSON.parse(bytes); } catch { fail('Saved updater settings are invalid; source.json was preserved.'); }
  if (value?.schemaVersion !== 1 || typeof value.source !== 'string') fail('Saved updater settings are unsupported; source.json was preserved.');
  folderUrl(value.source); timeoutSeconds(value.timeoutSeconds);
  return value;
}
export async function saveConfig(directory, config) {
  await privateDirectory(directory);
  const target = path.join(directory, 'source.json'), temporary = target + '.' + randomUUID() + '.tmp';
  const current = await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (current && (!current.isFile() || current.isSymbolicLink())) fail('Saved updater settings are redirected; preserved.');
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}
export async function runUpdate(options, { environment = process.env, homeDirectory = os.homedir(),
  downloader = downloadPair, installer = installPackages, log = console.log } = {}) {
  const directory = path.resolve(environment.SINGULARITY_FLOW_PACKAGE_UPDATER_HOME || environment.SFLOW_UPDATER_HOME
    || path.join(homeDirectory, '.singularity-flow', 'package-updater'));
  await privateDirectory(directory);
  const saved = await loadConfig(directory);
  const source = folderUrl(options.source || saved.source || fail('First run: give the SharePoint folder link after the script name.'));
  const timeout = timeoutSeconds(options.timeout ?? saved.timeoutSeconds ?? 900);
  const work = await mkdtemp(path.join(directory, 'stage-')); await chmod(work, 0o700);
  let completed = false;
  try {
    const downloaded = await downloader(source, work, { timeout, environment, log });
    log('Checking the CLI and VS Code build match…');
    const inspected = await inspectPair(downloaded.tarball, downloaded.vsix);
    const pair = { ...downloaded, cliSha256: inspected.cliSha256, vsixSha256: inspected.vsixSha256 };
    await saveConfig(directory, { schemaVersion: 1, mode: 'folder', source, timeoutSeconds: timeout });
    log('SFlow ' + inspected.version + ' packages match. Folder link saved.');
    if (options.checkOnly) {
      completed = true;
      return { status: 'checked', installed: false, version: inspected.version };
    }
    log('Updating SFlow CLI, VS Code and Copilot…');
    await installer(pair, { environment });
    completed = true;
    log('Update complete. Restart VS Code/Copilot and open a new terminal to load the update.');
    return { status: 'complete', installed: true, version: inspected.version };
  } catch (error) {
    throw new Error(error.message + '\nDownloaded work was retained: ' + work
      + '\nYour existing workspace and recovery files were preserved. Resolve the reported cause and run the updater again.', { cause: error });
  } finally { if (completed) await rm(work, { recursive: true, force: true }); }
}
const HELP = `SFlow updater
First run:
  Mac:     bash update-sflow.sh 'SHAREPOINT_FOLDER_LINK'
  Windows: .\\update-sflow.ps1 'SHAREPOINT_FOLDER_LINK'

Later updates:
  Mac:     bash update-sflow.sh
  Windows: .\\update-sflow.ps1

The public folder needs the current .tgz and .vsix. The link is remembered.
Optional: --check-only (download/check without installation)
          --timeout-seconds 1800 (default 900; minimum 300)
`;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else await runUpdate(options);
  } catch (error) { console.error('SFlow update failed: ' + error.message); process.exitCode = 1; }
}
