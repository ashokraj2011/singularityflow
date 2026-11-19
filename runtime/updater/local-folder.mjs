/**
 * Packages a person already downloaded: a folder on this computer (Downloads, a synced OneDrive or
 * SharePoint folder) holding the SFlow .tgz and .vsix. With several pairs there, the newest pair
 * that is one build is used. Built-ins only: the standalone updater ZIP ships it.
 */
import { constants } from 'node:fs';
import { copyFile, lstat, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { inspectNpmTarballBuildSources, inspectVsixBuildSources } from '../../scripts/install-staged-artifacts.mjs';
import { MAX_PACKAGE, sourceError } from './sharepoint.mjs';

const PRODUCT = /^(?:singularity[-_.]?flow|sflow)[-_.]/iu;
const MAX_CANDIDATES = 12;

async function candidates(folder, suffix) {
  let entries;
  try { entries = await readdir(folder, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw sourceError('The folder ' + folder + ' is not there any more. Choose the folder that holds the SFlow .tgz and .vsix, or use the SharePoint link you were given.', 'SOURCE_FOLDER_MISSING');
    }
    throw error;
  }
  let files = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(suffix)
    && !/[\u0000-\u001f\u007f]/u.test(entry.name));
  const named = files.filter(entry => PRODUCT.test(entry.name));
  if (named.length) files = named;
  const rows = [];
  for (const entry of files) {
    const file = path.join(folder, entry.name), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_PACKAGE) continue;
    rows.push({ name: entry.name, path: file, size: info.size, mtimeMs: info.mtimeMs });
  }
  if (!rows.length) {
    throw sourceError('No ' + suffix + ' file was found in ' + folder + '. The folder needs the SFlow .tgz and .vsix, side by side. '
      + 'Put them there, or use the SharePoint link you were given to install SFlow.', 'SOURCE_NO_PACKAGES');
  }
  return rows.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name)).slice(0, MAX_CANDIDATES);
}

/** The newest .tgz and .vsix in `folder` that are one SFlow build: { cli, vsix } rows with name, path, size and version. */
export async function selectLocalPair(folder, { inspectCli = inspectNpmTarballBuildSources,
  inspectExtension = inspectVsixBuildSources } = {}) {
  const [tarballs, extensions] = await Promise.all([candidates(folder, '.tgz'), candidates(folder, '.vsix')]);
  // One of each: the pair check that follows reports any mismatch in the same words as a download.
  if (tarballs.length === 1 && extensions.length === 1) return { cli: tarballs[0], vsix: extensions[0] };
  const seen = new Map(), problems = [];
  const read = async (row, inspect) => {
    if (!seen.has(row.path)) seen.set(row.path, await inspect(row.path).catch(error => { problems.push(row.name + ': ' + error.message); return null; }));
    return seen.get(row.path);
  };
  const pairs = [];
  for (const cli of tarballs) {
    const left = await read(cli, inspectCli);
    if (!left) continue;
    for (const vsix of extensions) {
      const right = await read(vsix, inspectExtension);
      if (right && left.version === right.version && left.versionSource === right.versionSource
        && left.buildInfoSource === right.buildInfoSource) {
        pairs.push({ cli: { ...cli, version: left.version }, vsix: { ...vsix, version: right.version },
          time: Math.max(cli.mtimeMs, vsix.mtimeMs) });
      }
    }
  }
  if (!pairs.length) {
    const versions = kind => [...new Set([...seen].filter(([file, value]) => value && file.toLowerCase().endsWith(kind))
      .map(([, value]) => value.version))].join(', ') || 'none readable';
    throw sourceError('No .tgz and .vsix in ' + folder + ' are the same SFlow build (the .tgz files are '
      + versions('.tgz') + '; the .vsix files are ' + versions('.vsix') + '). Put one matching pair, built together, in the folder.'
      + (problems.length ? ' Unreadable: ' + problems.join('; ') : ''), 'PAIR_MISMATCH');
  }
  pairs.sort((a, b) => b.time - a.time);
  if (pairs.length > 1 && pairs[0].time === pairs[1].time
    && (pairs[0].cli.path !== pairs[1].cli.path || pairs[0].vsix.path !== pairs[1].vsix.path)) {
    throw sourceError('Two matching SFlow pairs in ' + folder + ' are equally recent. Keep one current .tgz and .vsix there.', 'SOURCE_AMBIGUOUS');
  }
  return { cli: pairs[0].cli, vsix: pairs[0].vsix };
}

/** Copy the chosen pair into the private stage, so a sync that changes the folder cannot change what installs. */
export async function copyLocalPair(folder, work, { log = console.log, select = selectLocalPair } = {}) {
  log('Looking in ' + folder + ' for the newest matching .tgz and .vsix…');
  const selected = await select(folder);
  log('Found ' + selected.cli.name + ' and ' + selected.vsix.name + '.');
  const tarball = path.join(work, 'singularity-flow.tgz'), vsix = path.join(work, 'singularity-flow.vsix');
  for (const [row, target] of [[selected.cli, tarball], [selected.vsix, vsix]]) {
    log('Copying ' + row.name + '…');
    await copyFile(row.path, target, constants.COPYFILE_EXCL);
    const [copied, now] = await Promise.all([stat(target), stat(row.path)]);
    if (copied.size !== row.size || now.size !== row.size || now.mtimeMs !== row.mtimeMs) {
      throw sourceError(row.name + ' changed while it was being copied; a sync may still be running. Wait for it to finish, then try again.', 'SOURCE_CHANGING');
    }
  }
  return { tarball, vsix, selected };
}
