/** Anonymous SharePoint folder access using metadata supplied by its public landing page. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat } from 'node:fs/promises';
import { processCommand } from './process.mjs';
import { FOLDER_LINK_NEEDED, folderUrl, landingProblem, shareLink, sourceError } from './links.mjs';

export const MAX_PACKAGE = 512 * 1024 * 1024;
const MAX_PAGE = 16 * 1024 * 1024;
const fail = message => { throw new Error(message); };

export { folderUrl, landingProblem, shareLink, sourceError };
function decodeEntities(value) {
  return value.replace(/&quot;/gu, '"').replace(/&#34;/gu, '"').replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&');
}
function pageString(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp('"' + escaped + '"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")', 'u');
  const found = pattern.exec(text);
  if (!found) return null;
  try { return JSON.parse(found[1]); } catch { return null; }
}

export function folderMetadata(page, effectiveUrl) {
  const location = new URL(folderUrl(effectiveUrl)), candidates = [page, decodeEntities(page)];
  for (const match of page.matchAll(/JSON\.parse\(\s*("(?:\\.|[^"\\])*")\s*\)/gu)) {
    try { const value = JSON.parse(match[1]); if (typeof value === 'string') candidates.push(value); } catch { /* other script */ }
  }
  for (const text of candidates) {
    const drive = pageString(text, '.driveUrl'), token = pageString(text, '.driveAccessToken'), library = pageString(text, 'listUrl');
    if (!drive || !token || !library) continue;
    const driveUrl = new URL(folderUrl(drive));
    if (driveUrl.origin !== location.origin
      && !(driveUrl.hostname === 'api.onedrive.com' && /(?:^|\.)onedrive\.live\.com$/iu.test(location.hostname))) {
      fail('SharePoint supplied a drive endpoint outside the folder site; no access token was forwarded.');
    }
    let item = location.searchParams.get('id') || '';
    if (!item.startsWith('/') && /^%2f/iu.test(item)) {
      try { item = decodeURIComponent(item); } catch { fail('SharePoint supplied an invalid folder path.'); }
    }
    const libraryUrl = new URL(library, location);
    if (libraryUrl.origin !== location.origin) fail('SharePoint supplied an unexpected library site.');
    let base;
    try { base = decodeURIComponent(libraryUrl.pathname).replace(/\/$/u, ''); }
    catch { fail('SharePoint supplied an invalid library path.'); }
    if (!item.startsWith(base + '/') && item !== base) continue;
    return { drive: driveUrl.href.replace(/\/$/u, ''), token: token.replace(/^[?&]/u, ''), folder: item.slice(base.length).replace(/^\//u, '') };
  }
  const problem = landingProblem(page, effectiveUrl);
  if (problem.code === 'SOURCE_SIGN_IN') throw problem;
  throw sourceError('SharePoint did not expose public folder download details: this link opens a SharePoint page, not a shared folder. '
    + 'Check that the link opens the folder without signing in and allows downloading. ' + FOLDER_LINK_NEEDED, 'SOURCE_NOT_FOLDER');
}

function apiUrl(metadata, target) {
  const drive = new URL(metadata.drive), url = new URL(target, drive);
  if (url.origin !== drive.origin || !url.pathname.startsWith(drive.pathname.replace(/\/$/u, '') + '/')) {
    fail('SharePoint pagination left the selected drive; no folder access token was forwarded.');
  }
  const access = new URLSearchParams(metadata.token);
  for (const [name, value] of access) if (!url.searchParams.has(name)) url.searchParams.append(name, value);
  return folderUrl(url.href);
}

export function childrenUrl(metadata) {
  const relative = metadata.folder.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const target = metadata.drive + (relative ? '/root:/' + relative + ':/children' : '/root/children');
  return apiUrl(metadata, target);
}

export function selectPackages(items) {
  const result = {};
  for (const [kind, suffix] of [['cli', '.tgz'], ['vsix', '.vsix']]) {
    let candidates = items.filter(item => item && !item.folder && typeof item.name === 'string'
      && item.name.toLowerCase().endsWith(suffix));
    const productNames = candidates.filter(item => /^(?:singularity[-_.]?flow|sflow)[-_.]/iu.test(item.name));
    if (productNames.length) candidates = productNames;
    if (!candidates.length) {
      throw sourceError('No ' + suffix + ' file was found in the selected folder. The folder needs the SFlow .tgz and .vsix, '
        + 'side by side. Put them there, or use the folder link you were given to install SFlow.', 'SOURCE_NO_PACKAGES');
    }
    for (const item of candidates) {
      if (/[\u0000-\u001f\u007f/\\]/u.test(item.name) || item.size !== undefined
        && (!Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_PACKAGE)) fail('SharePoint returned an invalid package entry.');
    }
    if (candidates.length > 1) {
      const dated = candidates.map(item => ({ item, time: Date.parse(item.lastModifiedDateTime || item.timeLastModified || '') }));
      if (dated.some(row => !Number.isFinite(row.time))) throw sourceError('More than one ' + suffix + ' is present without reliable dates. Keep the current package pair in this folder.', 'SOURCE_AMBIGUOUS');
      dated.sort((a, b) => b.time - a.time);
      if (dated[0].time === dated[1].time) throw sourceError('More than one equally recent ' + suffix + ' was found. Keep one current package pair in this folder.', 'SOURCE_AMBIGUOUS');
      candidates = [dated[0].item];
    }
    const item = candidates[0];
    const download = item['@content.downloadUrlNoAuth'] || item['@content.downloadUrl'] || item['@microsoft.graph.downloadUrl'];
    if (!download) fail('SharePoint did not supply a public download URL for ' + item.name + '.');
    result[kind] = { name: item.name, url: folderUrl(download), size: item.size, etag: item.eTag || null };
  }
  return result;
}

export function curlSession(work, { timeout = 900, environment = process.env, execute = processCommand, log = console.log } = {}) {
  const cookieJar = path.join(work, 'public-session.cookies');
  const curl = process.platform === 'win32' ? path.join(environment.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe')
    : process.platform === 'darwin' ? '/usr/bin/curl' : 'curl';
  let active = false;
  const responseFiles = new Set();
  async function get(url, { destination, maximum = MAX_PAGE, label } = {}) {
    if (active) fail('SharePoint requests in this session must run sequentially.');
    active = true;
    const target = destination || path.join(work, 'response-' + randomUUID());
    if (!destination) responseFiles.add(target);
    const partial = target + '.part', started = Date.now();
    if (label) log('Downloading ' + label + '…');
    try {
      const caOptions = environment.CURL_CA_BUNDLE ? ['--cacert', environment.CURL_CA_BUNDLE] : [];
      const result = await execute(curl, ['--fail', '--location', '--globoff', '--proto', '=https', '--proto-redir', '=https',
        ...caOptions,
        '--connect-timeout', '30', '--max-time', String(timeout), '--retry', '2', '--retry-delay', '3',
        '--retry-max-time', String(timeout), '--silent', '--show-error', '--max-filesize', String(maximum),
        '--header', 'Cache-Control: no-cache', '--header', 'Pragma: no-cache',
        '--cookie', cookieJar, '--cookie-jar', cookieJar, '--output', partial,
        '--write-out', '%{url_effective}\\n%{content_type}', '--url', folderUrl(url)], {
        env: environment, capture: true, timeoutMs: (timeout + 15) * 1000,
        onProgress: async () => {
          const info = await stat(partial).catch(() => null);
          if (info?.size > maximum) fail('SharePoint response exceeded its size limit.');
          if (label) log(label + ': ' + ((info?.size ?? 0) / 1048576).toFixed(1) + ' MiB · ' + Math.round((Date.now() - started) / 1000) + 's');
        }
      });
      const info = await stat(partial);
      if (!info.size || info.size > maximum) fail('SharePoint returned an empty or oversized response.');
      await rename(partial, target);
      const lines = result.stdout.trim().split(/\r?\n/u);
      return { file: target, effectiveUrl: folderUrl(lines[0]), contentType: lines[1] || '' };
    } catch (error) {
      await rm(partial, { force: true });
      const message = String(error.message).replace(/https:\/\/[^\s]+/gu, '[download URL]');
      throw new Error((label ? 'Downloading ' + label : 'Reading SharePoint') + ' failed: ' + message, { cause: error });
    } finally { active = false; }
  }
  return { get, close: async () => {
    await rm(cookieJar, { force: true });
    await Promise.all([...responseFiles].map(file => rm(file, { force: true })));
  } };
}

/** A refused landing request, in plain words: a 401/403 is a link people must sign in for, 404 a link that is gone. */
function landingRefusal(error) {
  const status = /returned error:\s*(\d{3})/u.exec(String(error?.message))?.[1];
  if (status === '401' || status === '403') {
    return sourceError('SharePoint refused this link (' + status + '): it has expired, or only people in your organisation can open it. '
      + FOLDER_LINK_NEEDED, 'SOURCE_SIGN_IN');
  }
  if (status === '404' || status === '410') {
    return sourceError('This link no longer opens anything on SharePoint (' + status + '). Ask for the current link, then change the source. '
      + FOLDER_LINK_NEEDED, 'SOURCE_GONE');
  }
  return error;
}

export async function listPackages(source, session, { log = console.log } = {}) {
  log('Reading the SharePoint folder…');
  let landing;
  try { landing = await session.get(shareLink(source)); }
  catch (error) { throw landingRefusal(error); }
  const metadata = folderMetadata(await readFile(landing.file, 'utf8'), landing.effectiveUrl);
  let next = childrenUrl(metadata);
  const seen = new Set(), items = [];
  while (next) {
    if (seen.has(next) || seen.size >= 50 || items.length > 10000) fail('SharePoint folder listing exceeded its supported page limit.');
    seen.add(next);
    const response = await session.get(next);
    let page;
    let text = '';
    try { text = await readFile(response.file, 'utf8'); page = JSON.parse(text); }
    catch { throw landingProblem(text, response.effectiveUrl); }
    if (!Array.isArray(page.value)) throw sourceError('SharePoint did not return a list of files for this link, so it is not a shared folder. ' + FOLDER_LINK_NEEDED, 'SOURCE_NOT_FOLDER');
    items.push(...page.value);
    next = page['@odata.nextLink'] ? apiUrl(metadata, page['@odata.nextLink']) : null;
  }
  const selected = selectPackages(items);
  log('Found ' + selected.cli.name + ' and ' + selected.vsix.name + '.');
  return selected;
}

export async function downloadPair(source, work, options = {}) {
  const session = curlSession(work, options);
  try {
    const selected = await listPackages(source, session, options);
    for (const [kind, destination] of [['cli', 'singularity-flow.tgz'], ['vsix', 'singularity-flow.vsix']]) {
      const item = selected[kind];
      const response = await session.get(item.url, { destination: path.join(work, destination), maximum: MAX_PACKAGE, label: item.name });
      const size = (await stat(response.file)).size;
      if (item.size !== undefined && size !== item.size) fail('Download size differs from the folder listing for ' + item.name + '; the file may be changing. Retry after the upload finishes.');
    }
    return { tarball: path.join(work, 'singularity-flow.tgz'), vsix: path.join(work, 'singularity-flow.vsix'), selected };
  } finally { await session.close(); }
}
