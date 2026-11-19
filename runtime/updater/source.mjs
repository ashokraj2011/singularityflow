/**
 * Where SFlow packages come from, saved once per person in a private source.json that the terminal
 * updater and VS Code's Update SFlow… share. Built-ins only: the standalone updater ZIP ships it.
 *
 * Two kinds of source: the SharePoint folder link people are given to install SFlow (mode 'folder',
 * field `source`), and a folder on this computer that holds the downloaded .tgz and .vsix (mode
 * 'local-folder', field `localFolder`). Both may be saved together; `mode` says which one is used.
 * An older updater reads only `source`, so it keeps using the link and never meets a local path.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { folderUrl, shareLink, sourceError } from './links.mjs';

export { sourceError };
const fail = message => { throw new Error(message); };

export function timeoutSeconds(value = 900) {
  if (!/^\d+$/u.test(String(value)) || !Number.isSafeInteger(Number(value))
    || Number(value) < 300 || Number(value) > 3600) fail('Download timeout must be 300–3600 seconds (5–60 minutes).');
  return Number(value);
}

/** The private folder that holds source.json, its stages and VS Code's update runs. */
export function updaterHome(environment = process.env, homeDirectory = os.homedir()) {
  return path.resolve(environment.SINGULARITY_FLOW_PACKAGE_UPDATER_HOME || environment.SFLOW_UPDATER_HOME
    || path.join(homeDirectory, '.singularity-flow', 'package-updater'));
}

/** An absolute folder path, on either OS's rules; refused before it reaches any process or file. */
export function localFolder(value, platform = process.platform) {
  const text = String(value ?? '').trim();
  const layout = platform === 'win32' ? path.win32 : path.posix;
  if (!text || /[\0\r\n]/u.test(text)) throw sourceError('Choose the folder that holds the SFlow .tgz and .vsix.', 'SOURCE_FOLDER_INVALID');
  if (!layout.isAbsolute(text)) throw sourceError('Give the full path of the folder that holds the SFlow .tgz and .vsix.', 'SOURCE_FOLDER_INVALID');
  return layout.resolve(text);
}

/** A typed argument is a link when it starts with http(s)://, otherwise a folder on this computer. */
export function sourceArgument(value, { platform = process.platform, cwd = process.cwd() } = {}) {
  const text = String(value ?? '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) return { mode: 'folder', source: shareLink(text) };
  const layout = platform === 'win32' ? path.win32 : path.posix;
  return { mode: 'local-folder', localFolder: localFolder(layout.isAbsolute(text) ? text : layout.resolve(cwd, text), platform) };
}

export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()
    || (process.platform !== 'win32' && ((info.mode & 0o022) !== 0 || info.uid !== process.getuid()))) fail('Updater directory must be private to this user: ' + directory);
}

export async function ordinary(file, maximum = 65536) {
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

/** The saved settings, or {} when nothing is saved yet. `mode` is always set on what returns. */
export async function loadConfig(directory) {
  let bytes;
  try { bytes = await ordinary(path.join(directory, 'source.json')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  let value;
  try { value = JSON.parse(bytes); } catch { fail('Saved updater settings are invalid; source.json was preserved.'); }
  const mode = value?.mode ?? 'folder';
  if (value?.schemaVersion !== 1 || !['folder', 'local-folder'].includes(mode)
    || (value.source !== undefined && typeof value.source !== 'string')
    || (value.localFolder !== undefined && typeof value.localFolder !== 'string')
    || (mode === 'folder' ? typeof value.source !== 'string' : typeof value.localFolder !== 'string')) {
    fail('Saved updater settings are unsupported; source.json was preserved.');
  }
  if (value.source !== undefined) folderUrl(value.source);
  if (value.localFolder !== undefined) localFolder(value.localFolder);
  timeoutSeconds(value.timeoutSeconds);
  return { ...value, mode };
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

/** The settings to save once a source has given a matching pair; the other kind stays remembered. */
export function savedSettings(saved, chosen, timeout) {
  const value = { schemaVersion: 1, mode: chosen.mode, timeoutSeconds: timeout };
  const link = chosen.mode === 'folder' ? chosen.source : saved.source;
  const folder = chosen.mode === 'local-folder' ? chosen.localFolder : saved.localFolder;
  if (link) value.source = link;
  if (folder) value.localFolder = folder;
  return value;
}

/** The source that is in use, as { mode, source | localFolder }, or null when none is saved. */
export function activeSource(config) {
  if (config?.mode === 'local-folder' && config.localFolder) return { mode: 'local-folder', localFolder: config.localFolder };
  if (config?.source) return { mode: 'folder', source: config.source };
  return null;
}

/** One plain line naming a source, for the terminal and VS Code. */
export function describeSource(source) {
  if (!source) return 'no source saved yet';
  return source.mode === 'local-folder' ? 'the folder ' + source.localFolder : 'the SharePoint link ' + source.source;
}
