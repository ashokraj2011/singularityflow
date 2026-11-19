/**
 * Where the updater takes packages from: the saved SharePoint link, a folder of downloaded files, and
 * the plain refusal a person reads for every link that is not an anonymous shared folder. The links
 * are served by a local HTTPS fixture; nothing here reaches SharePoint, npm or an installed SFlow.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runUpdate, loadConfig, saveConfig, inspectPair, parseOptions } from '../runtime/update.mjs';
import { activeSource, describeSource, localFolder, savedSettings, sourceArgument } from '../runtime/updater/source.mjs';
import { folderMetadata, landingProblem, listPackages, shareLink } from '../runtime/updater/sharepoint.mjs';
import { copyLocalPair, selectLocalPair } from '../runtime/updater/local-folder.mjs';
import { pair } from './helpers/package-updater-artifacts.mjs';
import { localCertificate } from './helpers/package-updater-tls.mjs';
import { inventedValue } from './helpers/invented-secrets.mjs';

const silent = () => {};
// Every run names its route, so detection can never find and update this machine's own CLI.
const managed = () => ({ route: 'managed', engineHome: '/nonexistent/engine', fresh: true, version: null, cli: null, others: [] });
async function area(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow updater sources '));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return directory;
}
async function rejectsWith(promise, code, words) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, error.message);
    assert.equal(error.sourceProblem, true);
    assert.match(error.message, words);
    assert.doesNotMatch(error.message, /\n\s+at /u, 'no stack in what a person reads');
    return true;
  });
}

test('a link or a folder is one argument; the saved source keeps the other kind remembered', async t => {
  assert.deepEqual(sourceArgument('https://contoso.sharepoint.com/:f:/s/team/Ab1?e=x'), { mode: 'folder', source: 'https://contoso.sharepoint.com/:f:/s/team/Ab1?e=x' });
  assert.deepEqual(sourceArgument('/Users/person/Downloads', { platform: 'darwin' }), { mode: 'local-folder', localFolder: '/Users/person/Downloads' });
  assert.deepEqual(sourceArgument('C:\\Users\\Person\\Downloads\\', { platform: 'win32' }), { mode: 'local-folder', localFolder: 'C:\\Users\\Person\\Downloads' });
  assert.deepEqual(sourceArgument('Downloads', { platform: 'darwin', cwd: '/Users/person' }), { mode: 'local-folder', localFolder: '/Users/person/Downloads' });
  assert.throws(() => localFolder('relative', 'darwin'), /full path/);
  assert.deepEqual(parseOptions(['--local-folder', '/data/sflow']), { localFolder: '/data/sflow' });
  assert.deepEqual(parseOptions(['/data/sflow', '--check-only']), { localFolder: '/data/sflow', checkOnly: true });
  assert.deepEqual(parseOptions(['--hold', '--reinstall-copilot']), { hold: true, reinstallCopilot: true });
  assert.throws(() => parseOptions(['--source', 'https://contoso.sharepoint.com/:f:/x', '--local-folder', '/data']), /only once/);

  const directory = await area(t);
  await saveConfig(directory, { schemaVersion: 1, mode: 'folder', source: 'https://contoso.sharepoint.com/:f:/s/team/Ab1', timeoutSeconds: 900 });
  const linkFirst = await loadConfig(directory);
  const local = savedSettings(linkFirst, { mode: 'local-folder', localFolder: '/data/sflow' }, 900);
  assert.deepEqual(local, { schemaVersion: 1, mode: 'local-folder', timeoutSeconds: 900, source: 'https://contoso.sharepoint.com/:f:/s/team/Ab1', localFolder: '/data/sflow' });
  await saveConfig(directory, local);
  assert.deepEqual(activeSource(await loadConfig(directory)), { mode: 'local-folder', localFolder: '/data/sflow' });
  assert.match(describeSource(activeSource(linkFirst)), /^the SharePoint link https:/u);
  // A file the current updater wrote before modes existed still loads as the link.
  await writeFile(path.join(directory, 'source.json'), JSON.stringify({ schemaVersion: 1, source: 'https://contoso.sharepoint.com/x', timeoutSeconds: 900 }));
  assert.deepEqual(activeSource(await loadConfig(directory)), { mode: 'folder', source: 'https://contoso.sharepoint.com/x' });
  await writeFile(path.join(directory, 'source.json'), JSON.stringify({ schemaVersion: 1, mode: 'local-folder', timeoutSeconds: 900 }));
  await assert.rejects(loadConfig(directory), /unsupported; source.json was preserved/);
});

test('a link to one file, a sign-in page and a site page each say what link is needed', () => {
  for (const kind of ['u', 'x', 'w', 'b']) {
    assert.throws(() => shareLink(`https://contoso.sharepoint.com/:${kind}:/s/team/Ab1`), error =>
      error.code === 'SOURCE_FILE_LINK' && /single file, not a folder/.test(error.message) && /Anyone with the link/.test(error.message));
  }
  assert.equal(shareLink('https://contoso.sharepoint.com/:f:/s/team/Ab1'), 'https://contoso.sharepoint.com/:f:/s/team/Ab1');
  assert.throws(() => shareLink('contoso.sharepoint.com/sites/team'), error => error.code === 'SOURCE_NOT_LINK');
  assert.equal(landingProblem('<html>Hi</html>', 'https://login.microsoftonline.com/common/oauth2').code, 'SOURCE_SIGN_IN');
  assert.equal(landingProblem('<html><title>Sign in to your account</title></html>', 'https://contoso.sharepoint.com/x').code, 'SOURCE_SIGN_IN');
  assert.equal(landingProblem('<html>Team home</html>', 'https://contoso.sharepoint.com/sites/team/_forms/default.aspx').code, 'SOURCE_SIGN_IN');
  const site = landingProblem('<html><title>Team site - Home</title></html>', 'https://contoso.sharepoint.com/sites/team');
  assert.equal(site.code, 'SOURCE_NOT_FOLDER');
  assert.match(site.message, /opens a SharePoint page, not a shared folder/);
  assert.throws(() => folderMetadata('<html><title>Team site</title></html>', 'https://contoso.sharepoint.com/sites/team'),
    error => error.code === 'SOURCE_NOT_FOLDER' && /public folder download details/.test(error.message));
});

test('folder listings: a refused, missing, sign-in or empty listing is a plain source problem', async () => {
  const page = '<script>window.c=' + JSON.stringify({ '.driveUrl': 'https://contoso.sharepoint.com/_api/v2.0/drives/d1',
    '.driveAccessToken': inventedValue('tempauth=', 'fixture-folder'), listUrl: '/sites/team/Shared Documents' }) + '</script>';
  const folder = 'https://contoso.sharepoint.com/:f:/s/team/Ab1?id=' + encodeURIComponent('/sites/team/Shared Documents/SFlow');
  // listPackages reads each response from a file, as the curl session leaves it.
  const listed = async responses => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow listing '));
    try {
      let index = 0;
      return await listPackages(folder, { get: async () => {
        const next = responses.shift();
        if (next instanceof Error) throw next;
        const file = path.join(directory, String(index++));
        await writeFile(file, next.text);
        return { file, effectiveUrl: folder };
      } }, { log: silent });
    } finally { await rm(directory, { recursive: true, force: true }); }
  };
  await rejectsWith(listed([new Error('Reading SharePoint failed: curl: (22) The requested URL returned error: 403')]), 'SOURCE_SIGN_IN', /refused this link \(403\)/);
  await rejectsWith(listed([new Error('Reading SharePoint failed: curl: (22) The requested URL returned error: 404')]), 'SOURCE_GONE', /no longer opens anything/);
  await rejectsWith(listed([{ text: page }, { text: '<html>Sign in to your account</html>' }]), 'SOURCE_SIGN_IN', /asks people to sign in/);
  await rejectsWith(listed([{ text: page }, { text: JSON.stringify({ value: [] }) }]), 'SOURCE_NO_PACKAGES', /No .tgz file was found/);
  await rejectsWith(listed([{ text: page }, { text: JSON.stringify({ error: { code: 'notFound' } }) }]), 'SOURCE_NOT_FOLDER', /not a shared folder/);
});

test('mismatched versions and builds name both versions and what to do', async t => {
  const directory = await area(t);
  const write = async (name, bytes) => { const file = path.join(directory, name); await writeFile(file, bytes); return file; };
  const cli = await write('a.tgz', pair().cli), vsix = await write('b.vsix', pair({ vsixVersion: '1.0.0' }).vsix);
  await assert.rejects(inspectPair(cli, vsix), error => error.code === 'PAIR_MISMATCH'
    && /\.tgz is SFlow 0\.9\.0 and the \.vsix is SFlow 1\.0\.0/.test(error.message) && /do not match/.test(error.message));
  const other = await write('c.vsix', pair({ differentBuild: true }).vsix);
  await assert.rejects(inspectPair(cli, other), error => error.code === 'PAIR_MISMATCH' && /different build/.test(error.message));
});

test('a folder with several pairs uses the newest matching pair; none matching is refused plainly', async t => {
  const directory = await area(t);
  const at = async (name, bytes, minutes) => {
    const file = path.join(directory, name);
    await writeFile(file, bytes);
    const time = new Date(Date.UTC(2026, 10, 18, 12, minutes));
    await utimes(file, time, time);
  };
  const older = pair({ version: '0.9.0' }), newer = pair({ version: '0.9.1' }), lone = pair({ version: '1.0.0' });
  await at('singularity-flow-0.9.0.tgz', older.cli, 1);
  await at('singularity-flow-vscode-0.9.0.vsix', older.vsix, 2);
  await at('singularity-flow-0.9.1.tgz', newer.cli, 3);
  await at('singularity-flow-vscode-0.9.1.vsix', newer.vsix, 4);
  await at('singularity-flow-vscode-1.0.0.vsix', lone.vsix, 9); // newest file, but its .tgz is missing
  await at('notes.txt', Buffer.from('not a package'), 10);
  const chosen = await selectLocalPair(directory);
  assert.equal(chosen.cli.name, 'singularity-flow-0.9.1.tgz');
  assert.equal(chosen.vsix.name, 'singularity-flow-vscode-0.9.1.vsix');

  const work = path.join(directory, 'work'); await mkdir(work);
  const copied = await copyLocalPair(directory, work, { log: silent });
  assert.equal((await readFile(copied.tarball)).equals(newer.cli), true);
  assert.equal((await readFile(copied.vsix)).equals(newer.vsix), true);

  const empty = path.join(directory, 'empty'); await mkdir(empty);
  await rejectsWith(selectLocalPair(empty), 'SOURCE_NO_PACKAGES', /No .tgz file was found in .*empty/);
  const mixed = path.join(directory, 'mixed'); await mkdir(mixed);
  for (const [name, bytes] of [['sflow-a.tgz', older.cli], ['sflow-b.tgz', newer.cli], ['sflow-c.vsix', lone.vsix], ['sflow-d.vsix', pair({ version: '2.0.0' }).vsix]]) {
    await writeFile(path.join(mixed, name), bytes);
  }
  await rejectsWith(selectLocalPair(mixed), 'PAIR_MISMATCH', /the \.tgz files are 0\.9\.\d, 0\.9\.\d; the \.vsix files are /);
  await rejectsWith(selectLocalPair(path.join(directory, 'missing')), 'SOURCE_FOLDER_MISSING', /not there any more/);
});

test('an update from a folder saves the folder, keeps the link, and reports each end in its result file', async t => {
  const directory = await area(t), state = path.join(directory, 'state'), folder = path.join(directory, 'downloads');
  await mkdir(folder);
  const fixture = pair({ version: '0.9.1' });
  await writeFile(path.join(folder, 'singularity-flow-0.9.1.tgz'), fixture.cli);
  await writeFile(path.join(folder, 'singularity-flow-vscode-0.9.1.vsix'), fixture.vsix);
  await saveConfig(state, { schemaVersion: 1, mode: 'folder', source: 'https://contoso.sharepoint.com/:f:/s/team/Ab1', timeoutSeconds: 900 });
  const result = path.join(directory, 'result.json'), installed = [];
  const dependencies = { environment: { ...process.env, SINGULARITY_FLOW_PACKAGE_UPDATER_HOME: state }, log: silent, detect: managed,
    downloader: () => assert.fail('a folder source never downloads'),
    installer: async (files, options) => { installed.push({ version: files.version, reinstallCopilot: options.reinstallCopilot, reinstall: options.reinstall }); } };
  const done = await runUpdate({ localFolder: folder, result }, dependencies);
  assert.equal(done.status, 'complete'); assert.equal(done.version, '0.9.1');
  assert.deepEqual(installed, [{ version: '0.9.1', reinstallCopilot: true, reinstall: false }]);
  assert.equal(JSON.parse(await readFile(result, 'utf8')).status, 'complete');
  const saved = await loadConfig(state);
  assert.deepEqual([saved.mode, saved.localFolder, saved.source], ['local-folder', folder, 'https://contoso.sharepoint.com/:f:/s/team/Ab1']);
  assert.deepEqual((await readdir(state)).sort(), ['source.json']);

  // A folder emptied by a sync: nothing downloaded, nothing kept, the result says it is a source problem.
  await rm(path.join(folder, 'singularity-flow-0.9.1.tgz'));
  await rejectsWith(runUpdate({ result }, dependencies), 'SOURCE_NO_PACKAGES', /No .tgz file was found/);
  const failed = JSON.parse(await readFile(result, 'utf8'));
  assert.deepEqual([failed.status, failed.code, failed.sourceProblem, failed.work], ['failed', 'SOURCE_NO_PACKAGES', true, null]);
  assert.deepEqual((await readdir(state)).sort(), ['source.json'], 'an empty stage is not kept');
});

test('local HTTPS fixture: site page, organisation-only link, expired link, empty folder and mismatched pair', async t => {
  const directory = await area(t), certificate = localCertificate(), ca = path.join(directory, 'server.pem');
  await writeFile(ca, certificate.cert);
  const fixture = pair(), newer = pair({ version: '1.0.0' });
  let origin;
  const server = https.createServer(certificate, (request, response) => {
    const url = new URL(request.url, origin);
    const folderPage = name => '<html><script>window.c=' + JSON.stringify({ '.driveUrl': origin + '/_api/v2.0/drives/d1',
      '.driveAccessToken': inventedValue('tempauth=', 'fixture-folder'), listUrl: '/sites/team/Shared Documents' }) + '</script></html>';
    if (url.pathname === '/sites/team') return response.end('<html><title>Team site - Home</title><body>Welcome</body></html>');
    if (url.pathname === '/:f:/s/team/restricted') { response.writeHead(302, { Location: '/_forms/default.aspx?ReturnUrl=%2fsites%2fteam' }); return response.end(); }
    if (url.pathname === '/_forms/default.aspx') return response.end('<html><title>Sign in to your account</title></html>');
    if (url.pathname === '/:f:/s/team/expired') { response.writeHead(403); return response.end('Forbidden'); }
    if (url.pathname === '/folder') return response.end(folderPage());
    if (url.pathname.startsWith('/_api/')) {
      response.setHeader('Content-Type', 'application/json');
      const file = (name, bytes, id) => ({ name, file: {}, size: bytes.length, lastModifiedDateTime: '2026-11-18T00:00:00Z', '@content.downloadUrlNoAuth': origin + '/binary/' + id });
      if (url.pathname.includes('Empty')) return response.end(JSON.stringify({ value: [{ name: 'readme.txt', file: {}, size: 3 }] }));
      return response.end(JSON.stringify({ value: [file('singularity-flow.tgz', fixture.cli, 'cli'), file('singularity-flow.vsix', newer.vsix, 'vsix')] }));
    }
    if (url.pathname.startsWith('/binary/')) {
      const bytes = url.pathname.endsWith('cli') ? fixture.cli : newer.vsix;
      response.setHeader('Content-Length', bytes.length);
      return response.end(bytes);
    }
    response.writeHead(404); response.end('Not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'https://127.0.0.1:' + server.address().port;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const state = path.join(directory, 'state');
  const dependencies = { environment: { ...process.env, CURL_CA_BUNDLE: ca, SINGULARITY_FLOW_PACKAGE_UPDATER_HOME: state }, log: silent,
    detect: managed, installer: () => assert.fail('check-only never installs') };
  const check = source => runUpdate({ source: shareLink(source), checkOnly: true, timeout: 300 }, dependencies);
  await rejectsWith(check(origin + '/sites/team'), 'SOURCE_NOT_FOLDER', /opens a SharePoint page, not a shared folder/);
  await rejectsWith(check(origin + '/:f:/s/team/restricted'), 'SOURCE_SIGN_IN', /asks people to sign in/);
  await rejectsWith(check(origin + '/:f:/s/team/expired'), 'SOURCE_SIGN_IN', /refused this link \(403\)/);
  await rejectsWith(check(origin + '/:f:/s/team/missing'), 'SOURCE_GONE', /no longer opens anything/);
  await rejectsWith(check(origin + '/folder?id=' + encodeURIComponent('/sites/team/Shared Documents/SFlowEmpty')), 'SOURCE_NO_PACKAGES', /No .tgz file was found/);
  await assert.rejects(check(origin + '/folder?id=' + encodeURIComponent('/sites/team/Shared Documents/SFlow')),
    error => error.code === 'PAIR_MISMATCH' && /0\.9\.0 and the \.vsix is SFlow 1\.0\.0/.test(error.message) && /retained/.test(error.message));
  assert.deepEqual((await readdir(state)).filter(name => name === 'source.json'), [], 'no refused link is saved');
});
