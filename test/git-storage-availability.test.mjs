import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cloudSyncedFolder, downloadGitFiles, gitStorageUnavailable, iCloudSyncedHomeFolders, localWorkspaceBase,
  locateGitDirectories, parseRegistryQuery, resetGitStorageAvailability, syncedFolderAdvice, syncedFolderOf,
  syncedFolderRefusal, syncedFolderWarning, syncedLocations, unreadableGitFiles, windowsSyncedLocations
} from '../src/git-storage-availability.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';

const posix = process.platform !== 'win32';
const forced = { ...process.env, SINGULARITY_FLOW_GIT_STORAGE_CHECK: 'always', SINGULARITY_FLOW_GIT_STORAGE_DOWNLOAD_TIMEOUT_MS: '400' };
const gitEnv = { ...process.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Storage Tester',
  GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'storage.tester@example.invalid' };

async function repository(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-git-storage-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', root], { env: gitEnv });
  await writeFile(path.join(root, 'README.md'), '# storage\n');
  execFileSync('git', ['add', '.'], { cwd: root, env: gitEnv });
  execFileSync('git', ['commit', '-q', '-m', 'one'], { cwd: root, env: gitEnv });
  return { base, root, gitDirectory: path.join(root, '.git') };
}

/** Replace the commit's tree object with a named pipe: Git then blocks opening it, as on an evicted file. */
async function blockTree(root) {
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim();
  const file = path.join(root, '.git', 'objects', tree.slice(0, 2), tree.slice(2));
  await rename(file, `${file}.saved`);
  execFileSync('mkfifo', [file]);
  return file;
}

test('the check applies only inside folders macOS can evict, unless forced on or off', () => {
  const home = '/Users/someone';
  const darwin = { platform: 'darwin', homeDirectory: home, env: {} };
  assert.equal(cloudSyncedFolder('/Users/someone/Documents/work/repo/.git', darwin), '/Users/someone/Documents');
  assert.equal(cloudSyncedFolder('/Users/someone/Library/CloudStorage/OneDrive-Org/repo/.git', darwin), '/Users/someone/Library/CloudStorage');
  assert.equal(cloudSyncedFolder('/Users/someone/DocumentsArchive/repo/.git', darwin), null);
  assert.equal(cloudSyncedFolder('/tmp/repo/.git', darwin), null);
  assert.equal(cloudSyncedFolder('/Users/someone/Documents/repo/.git', { ...darwin, env: { SINGULARITY_FLOW_GIT_STORAGE_CHECK: 'off' } }), null);
  assert.equal(cloudSyncedFolder('/home/someone/Documents/repo/.git', { platform: 'linux', homeDirectory: '/home/someone', env: {} }), null);
  assert.equal(cloudSyncedFolder('/tmp/repo/.git', { ...darwin, env: { SINGULARITY_FLOW_GIT_STORAGE_CHECK: 'always' } }), '');
});

test('placeholders and special files are found with lstat alone, in linked worktrees too', { skip: !posix }, async (t) => {
  const { root, gitDirectory } = await repository(t);
  // A sparse file has a size and no allocated blocks, which is what an evicted placeholder reports.
  const placeholder = path.join(gitDirectory, 'objects', 'pack', 'pack-0000000000000000000000000000000000000000.pack');
  await writeFile(placeholder, '');
  await truncate(placeholder, 65_536);
  if (lstatSync(placeholder).blocks !== 0) return t.skip('this filesystem does not keep sparse files sparse');
  const linked = path.join(path.dirname(root), 'linked');
  execFileSync('git', ['worktree', 'add', '-q', '--detach', linked, 'HEAD'], { cwd: root, env: gitEnv, stdio: 'ignore' });
  const pipe = await blockTree(root);
  const found = unreadableGitFiles(locateGitDirectories(root));
  assert.deepEqual(found.placeholders, [placeholder]);
  assert.deepEqual(found.special, [pipe]);
  const located = locateGitDirectories(path.join(linked, 'nested', 'deeper'));
  assert.equal(realpathSync(located.commonDirectory), realpathSync(gitDirectory));
  assert.equal(realpathSync(located.gitDirectory), realpathSync(path.join(gitDirectory, 'worktrees', 'linked')));
});

test('a download that completes lets Git run; one that cannot is refused within its deadline', { skip: !posix }, async (t) => {
  resetGitStorageAvailability();
  const { root, gitDirectory } = await repository(t);
  const readable = path.join(gitDirectory, 'objects', 'pack', 'pack-1111111111111111111111111111111111111111.pack');
  await writeFile(readable, '');
  await truncate(readable, 4096);
  assert.equal(gitStorageUnavailable(root, { env: forced }), null, 'bytes that can be read are available');
  await rm(readable);

  resetGitStorageAvailability();
  await blockTree(root);
  const started = performance.now();
  const storage = gitStorageUnavailable(root, { env: forced });
  const elapsed = performance.now() - started;
  assert.ok(storage, 'an unreadable object is reported');
  assert.ok(elapsed < 5_000, `the download attempt is bounded (${Math.round(elapsed)} ms)`);
  assert.equal(storage.code, 'GIT_STORAGE_UNAVAILABLE');
  assert.equal(storage.classification, 'local-storage-unavailable');
  assert.equal(storage.gitDirectory, gitDirectory);
  assert.equal(storage.special, 1);
  assert.equal(storage.downloadTimedOut, true);
  assert.match(storage.advice, /not regular files/);
  assert.ok(storage.advice.includes(gitDirectory));

  // Remembered: the next Git child in this repository is refused without another download.
  let downloads = 0;
  assert.equal(gitStorageUnavailable(root, { env: forced, download: () => { downloads += 1; return { completed: true }; } }), storage);
  assert.equal(downloads, 0);
});

test('placeholders that do not arrive name the folder and the way to download it', { skip: !posix }, async (t) => {
  resetGitStorageAvailability();
  const { root, gitDirectory } = await repository(t);
  const placeholder = path.join(gitDirectory, 'objects', 'pack', 'pack-2222222222222222222222222222222222222222.pack');
  await writeFile(placeholder, '');
  await truncate(placeholder, 8192);
  // By default only synced folders are examined, and this fixture is not in one.
  assert.equal(gitStorageUnavailable(root, {
    env: {}, platform: 'darwin', homeDirectory: '/Users/nobody',
    download: () => assert.fail('nothing is downloaded outside synced folders')
  }), null);
  const forcedStorage = gitStorageUnavailable(root, {
    env: forced, fresh: true, download: () => ({ completed: false, timedOut: true, elapsedMs: 15_000 })
  });
  assert.equal(forcedStorage.placeholders, 1);
  assert.match(forcedStorage.advice, /cloud placeholders that this computer has not downloaded/);
  assert.match(forcedStorage.advice, /Download Now/);
  assert.match(forcedStorage.advice, /move the workspace out of the synced folder/);
});

test('the bounded downloader is a child process that a blocked read cannot hold', { skip: !posix }, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-git-storage-pipe-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const pipe = path.join(base, 'blocked');
  execFileSync('mkfifo', [pipe]);
  const started = performance.now();
  const attempt = downloadGitFiles([pipe], { timeoutMs: 300 });
  assert.equal(attempt.completed, false);
  assert.equal(attempt.timedOut, true);
  assert.ok(performance.now() - started < 3_000);
});

test('remote Git refuses before spawning when the repository cannot be read, and names that cause', { skip: !posix }, async (t) => {
  resetGitStorageAvailability();
  const { root } = await repository(t);
  await blockTree(root);
  let spawned = 0;
  const result = await runRemoteGitAsync(['fetch', 'origin'], {
    cwd: root, env: forced, operation: 'remote-configuration', platform: 'darwin',
    spawnCommand: (...args) => { spawned += 1; return spawn(...args); }
  });
  assert.equal(spawned, 0, 'no Git child is started');
  assert.equal(result.status, 1);
  assert.equal(result.failure.code, 'REMOTE_LOCAL_STORAGE_UNAVAILABLE');
  assert.equal(result.failure.classification, 'local-storage-unavailable');
  assert.equal(result.failure.retryable, true);
  assert.match(result.failure.advice, /Git cannot read this repository's own files/);

  // A clone reads nothing of the repository around its working directory, so it is not refused.
  const cloned = await runRemoteGitAsync(['clone', '-q', path.join(root, 'missing.git'), path.join(root, 'copy')], {
    cwd: root, env: forced, operation: 'remote-configuration', platform: 'darwin',
    spawnCommand: (...args) => { spawned += 1; return spawn(...args); }
  });
  assert.equal(spawned, 1);
  assert.notEqual(cloned.failure?.classification, 'local-storage-unavailable');
});

test('a Git deadline in a repository that became unreadable is reported as that, not as an unknown timeout', { skip: !posix }, async (t) => {
  resetGitStorageAvailability();
  const { root } = await repository(t);
  // Readable when first examined (and remembered), unreadable by the time Git reads the tree.
  assert.equal(gitStorageUnavailable(root, { env: forced }), null);
  await blockTree(root);
  const started = performance.now();
  const result = await runRemoteGitAsync(['ls-tree', 'HEAD'], {
    cwd: root, env: forced, operation: 'remote-configuration', timeoutMs: 1_000, terminationGraceMs: 200
  });
  assert.ok(performance.now() - started < 8_000);
  assert.equal(result.timedOut, true);
  assert.equal(result.failure.classification, 'local-storage-unavailable');
  assert.match(result.failure.advice, /not regular files/);
});

test('a Git child is ended when the process that started it is stopped', { skip: !posix }, async (t) => {
  const sockets = new Set();
  const server = net.createServer((socket) => { sockets.add(socket); socket.on('error', () => {}); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/silent.git`;
  const moduleUrl = new URL('../src/git-execution.mjs', import.meta.url).href;
  const script = `
    const { runRemoteGitAsync } = await import(${JSON.stringify(moduleUrl)});
    setTimeout(() => process.stdout.write('started\\n'), 500);
    await runRemoteGitAsync(['ls-remote', ${JSON.stringify(url)}], { operation: 'remote-probe', timeoutMs: 60_000 });`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, SINGULARITY_FLOW_GIT_STORAGE_CHECK: 'off' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve) => parent.stdout.once('data', resolve));
  const children = spawnSync('pgrep', ['-P', String(parent.pid)], { encoding: 'utf8' }).stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  assert.equal(children.length, 1, 'one Git child is running');
  const [gitPid] = children;
  const closed = new Promise((resolve) => parent.once('close', (code, signal) => resolve({ code, signal })));
  parent.kill('SIGTERM');
  const exit = await closed;
  assert.equal(exit.signal, 'SIGTERM', 'the termination signal still ends the process as before');
  let alive = true;
  for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
    try { process.kill(-gitPid, 0); await new Promise((resolve) => setTimeout(resolve, 50)); } catch { alive = false; }
  }
  if (alive) { try { process.kill(-gitPid, 'SIGKILL'); } catch { /* cleanup */ } }
  assert.equal(alive, false, 'the detached Git process group did not outlive its parent');
});


// Windows: what the OneDrive client and Known Folder Move leave behind on an office laptop.
const windowsHome = 'C:\\Users\\someone';
const business = 'C:\\Users\\someone\\OneDrive - Contoso';
const windows = (extra = {}) => ({
  platform: 'win32', homeDirectory: windowsHome,
  env: { OneDriveCommercial: business, OneDriveConsumer: 'C:\\Users\\someone\\OneDrive', USERPROFILE: windowsHome },
  ...extra
});

test('Windows: a path inside any OneDrive folder is synced, whatever its case or separators', () => {
  const facts = windows();
  for (const target of [
    `${business}\\work\\repo`, 'c:/users/SOMEONE/onedrive - contoso/work', `${business}\\`, business,
    '\\\\?\\C:\\Users\\someone\\OneDrive - Contoso\\repo'
  ]) assert.deepEqual(syncedFolderOf(target, facts), { folder: business, provider: 'OneDrive', knownFolder: null }, target);
  assert.equal(syncedFolderOf('C:\\Users\\someone\\OneDrive\\notes', facts).folder, 'C:\\Users\\someone\\OneDrive');
  // Only the folders themselves: a sibling that starts with the same letters is local, and so is home.
  assert.equal(syncedFolderOf('C:\\Users\\someone\\OneDrive - Contoso Archive\\repo', facts), null);
  assert.equal(syncedFolderOf('C:\\Users\\someone\\Singularity Workspaces\\payments', facts), null);
  assert.equal(syncedFolderOf('D:\\work\\repo', facts), null);
  // A copied environment keeps whatever case Windows reported the name in.
  assert.equal(syncedFolderOf(`${business}\\repo`, windows({ env: { ONEDRIVE: business } })).folder, business);
  assert.equal(syncedFolderOf(`${business}\\repo`, windows({ env: { OneDrive: 'relative\\path' } })), null);
  // Folders the registry knows about count too: a second business account sets no variable.
  const second = 'C:\\Users\\someone\\OneDrive - Fabrikam';
  assert.equal(syncedFolderOf(`${second}\\repo`, windows({ oneDriveFolders: [second] })).folder, second);
  // The same rules hold without OneDrive's variables on a machine that has none.
  assert.equal(syncedFolderOf(`${business}\\repo`, windows({ env: {} })), null);
});

test('Windows: Desktop and Documents moved into OneDrive are named as Known Folders', () => {
  const documents = `${business}\\Documents`;
  const facts = windows({ knownFolders: { Documents: documents, Desktop: `${business}\\Desktop`, Pictures: 'C:\\Users\\someone\\Pictures' } });
  assert.deepEqual(syncedFolderOf(`${documents}\\code\\payments`, facts), { folder: documents, provider: 'OneDrive', knownFolder: 'Documents' });
  assert.equal(syncedFolderOf(`${business}\\Desktop\\x`, facts).knownFolder, 'Desktop');
  // A Known Folder Known Folder Move did not redirect stays local.
  assert.equal(syncedFolderOf('C:\\Users\\someone\\Pictures\\repo', facts), null);
  assert.equal(syncedFolderOf(`${business}\\Projects\\repo`, facts).knownFolder, null);
});

test('macOS: iCloud Drive, CloudStorage providers, and Desktop and Documents only when iCloud syncs them', () => {
  const home = '/Users/someone';
  const synced = { platform: 'darwin', homeDirectory: home, env: {}, iCloudHomeFolders: ['Desktop', 'Documents'] };
  assert.deepEqual(syncedFolderOf('/Users/someone/Documents/code/repo', synced), { folder: '/Users/someone/Documents', provider: 'iCloud Drive', knownFolder: 'Documents' });
  assert.equal(syncedFolderOf('/Users/someone/documents/code', synced).folder, '/Users/someone/Documents', 'APFS ignores case by default');
  assert.equal(syncedFolderOf('/Users/someone/DocumentsArchive/repo', synced), null);
  assert.equal(syncedFolderOf('/Users/someone/Documents/repo', { ...synced, iCloudHomeFolders: [] }), null);
  assert.equal(syncedFolderOf('/Users/someone/Library/Mobile Documents/com~apple~CloudDocs/repo', synced).provider, 'iCloud Drive');
  assert.deepEqual(syncedFolderOf('/Users/someone/Library/CloudStorage/OneDrive-Contoso/repo', synced),
    { folder: '/Users/someone/Library/CloudStorage/OneDrive-Contoso', provider: 'OneDrive', knownFolder: null });
  assert.equal(syncedFolderOf('/Users/someone/Library/CloudStorage/GoogleDrive-someone@example.test/My Drive/r', synced).provider, 'Google Drive');
  assert.equal(syncedFolderOf('/Users/someone/Singularity Workspaces/payments', synced), null);
  assert.equal(syncedFolderOf('/home/someone/Documents/repo', { platform: 'linux', homeDirectory: '/home/someone', env: {} }), null);
});

test('macOS: Desktop and Documents sync when iCloud links them into iCloud Drive', { skip: !posix }, async (t) => {
  // The real path: macOS keeps temporary folders under /var, a link to /private/var.
  const home = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'sflow-icloud-home-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(iCloudSyncedHomeFolders(home), [], 'no iCloud Drive at all');
  const drive = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  await mkdir(path.join(home, 'Documents'), { recursive: true });
  await mkdir(path.join(drive, 'Desktop'), { recursive: true });
  await symlink(path.join(home, 'Documents'), path.join(drive, 'Documents'));
  assert.deepEqual(iCloudSyncedHomeFolders(home), ['Documents'], 'a real folder in iCloud Drive is what stays behind when the option is off');
  const denied = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
  assert.deepEqual(iCloudSyncedHomeFolders(home, { lstat: denied }), ['Desktop', 'Documents'], 'unexaminable counts as synced');
  // A link into a synced folder puts Git there too, and so does a folder that does not exist yet.
  const facts = { platform: process.platform, homeDirectory: home, env: {}, iCloudHomeFolders: ['Documents'] };
  await symlink(path.join(home, 'Documents'), path.join(home, 'code'));
  if (process.platform === 'darwin') {
    const [found] = syncedLocations([{ subject: 'workspace', path: path.join(home, 'code', 'later', 'demo') }], { facts });
    assert.equal(found?.knownFolder, 'Documents');
    assert.deepEqual(syncedLocations([{ subject: 'workspace', path: path.join(home, 'local', 'demo') }], { facts }), []);
  }
});

test('Windows registry answers are parsed, expanded, and never required', () => {
  const accounts = [
    '', 'HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Business1',
    '    UserFolder    REG_SZ    C:\\Users\\someone\\OneDrive - Contoso', '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Personal',
    '    UserFolder    REG_SZ    C:\\Users\\someone\\OneDrive', '', 'End of search: 2 match(es) found.', ''
  ].join('\r\n');
  const shellFolders = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
    '    Desktop    REG_EXPAND_SZ    %USERPROFILE%\\OneDrive - Contoso\\Desktop',
    '    Personal    REG_EXPAND_SZ    C:\\Users\\someone\\OneDrive - Contoso\\Documents',
    '    My Pictures    REG_EXPAND_SZ    %USERPROFILE%\\Pictures',
    '    Favorites    REG_EXPAND_SZ    %USERPROFILE%\\Favorites'
  ].join('\r\n');
  assert.deepEqual(parseRegistryQuery(accounts).map((row) => row.value), ['C:\\Users\\someone\\OneDrive - Contoso', 'C:\\Users\\someone\\OneDrive']);
  assert.equal(parseRegistryQuery(shellFolders).find((row) => row.name === 'My Pictures').type, 'REG_EXPAND_SZ');
  const calls = [];
  const runCommand = (command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: args.includes('/s') ? accounts : shellFolders };
  };
  const found = windowsSyncedLocations({ env: { USERPROFILE: windowsHome, SystemRoot: 'C:\\WINDOWS' }, runCommand });
  assert.deepEqual(found, {
    oneDriveFolders: ['C:\\Users\\someone\\OneDrive - Contoso', 'C:\\Users\\someone\\OneDrive'],
    knownFolders: { Desktop: `${business}\\Desktop`, Documents: `${business}\\Documents`, Pictures: 'C:\\Users\\someone\\Pictures' }
  });
  assert.equal(calls[0][0], 'C:\\WINDOWS\\System32\\reg.exe', 'reg.exe is named in full, not looked up on PATH');
  assert.deepEqual(windowsSyncedLocations({ runCommand: () => ({ status: 1, stdout: '' }) }), { oneDriveFolders: [], knownFolders: {} });
  assert.deepEqual(windowsSyncedLocations({ runCommand: () => { throw new Error('spawn failed'); } }), { oneDriveFolders: [], knownFolders: {} });
});

test('the refusal names the folder, why Git breaks there, where to go instead, and the override', () => {
  const facts = windows({ knownFolders: { Documents: `${business}\\Documents` } });
  const found = syncedLocations([{ subject: 'workspace', path: `${business}\\Documents\\ws\\payments` }], { facts });
  const error = syncedFolderRefusal(found, facts);
  assert.equal(error.code, 'WORKSPACE_SYNCED_FOLDER');
  assert.match(error.message, /is in Documents \(C:\\Users\\someone\\OneDrive - Contoso\\Documents\), which OneDrive syncs/);
  assert.match(error.message, /online-only\s+placeholders/);
  assert.match(error.message, /holds files open while it uploads/);
  assert.match(error.message, /conflict copy/);
  assert.match(error.message, /under C:\\Users\\someone\\Singularity Workspaces instead/);
  assert.match(error.message, /Known Folder Move redirects only Desktop, Documents and Pictures/);
  assert.match(error.message, /add --allow-synced-folder\.$/);
  assert.equal(error.details.suggestedBase, 'C:\\Users\\someone\\Singularity Workspaces');
  // The configured root is suggested unless it is synced itself.
  assert.equal(localWorkspaceBase({ ...facts, env: { ...facts.env, SINGULARITY_FLOW_WORKSPACE_ROOT: 'D:\\Workspaces' } }), 'D:\\Workspaces');
  assert.equal(localWorkspaceBase({ ...facts, env: { ...facts.env, SINGULARITY_FLOW_WORKSPACE_ROOT: `${business}\\ws` } }),
    'C:\\Users\\someone\\Singularity Workspaces');
  const mac = { platform: 'darwin', homeDirectory: '/Users/someone', env: {}, iCloudHomeFolders: ['Documents'] };
  const clone = syncedFolderAdvice([{ subject: 'repository', path: '/Users/someone/Documents/app', ...syncedFolderOf('/Users/someone/Documents/app', mac) }], mac);
  assert.match(clone.remedy, /^Clone the repository again under \/Users\/someone\/Singularity Workspaces/);
  assert.match(clone.remedy, /iCloud syncs only Desktop and Documents/);
  const warning = syncedFolderWarning(found[0], { workspacePath: `${business}\\Documents\\ws\\payments`, confirmation: 'payments' }, facts);
  assert.match(warning, /workspace archive-status "C:\\Users\\someone\\OneDrive - Contoso\\Documents\\ws\\payments" --fetch/);
  assert.match(warning, /workspace archive "[^"]+" --confirm payments for this one\.$/);
});

test('the Git-read check stays opt-in on Windows and names the OneDrive folder when forced on', () => {
  const facts = windows();
  assert.equal(cloudSyncedFolder(`${business}\\repo\\.git`, facts), null);
  assert.equal(cloudSyncedFolder(`${business}\\repo\\.git`, { ...facts, env: { ...facts.env, SINGULARITY_FLOW_GIT_STORAGE_CHECK: 'always' } }), business);
  assert.equal(cloudSyncedFolder('D:\\repo\\.git', { ...facts, env: { ...facts.env, SINGULARITY_FLOW_GIT_STORAGE_CHECK: 'always' } }), '');
});
