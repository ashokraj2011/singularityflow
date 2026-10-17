import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cloudSyncedFolder, downloadGitFiles, gitStorageUnavailable, locateGitDirectories,
  resetGitStorageAvailability, unreadableGitFiles
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

