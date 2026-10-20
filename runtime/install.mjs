/** Private engine activation. The caller supplies an explicitly trusted, digest-bound npm archive.
 * Distribution callers must verify the existing signed artifact receipt before calling this.
 * No global npm installation, repository discovery, shell profile edit or runtime download here.
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import resolver from './resolve.cjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const bins = ['singularity-flow', 'sflow', 'sflow-about', 'sflow-inbox', 'sflow-next', 'sflow-agent',
  'sf-reset-all', 'sf-local-reset', 'sf-reinstall', 'sf-install', 'sf-uninstall'];

export async function installerProcess(executable, args, options = {}) {
  const { timeoutMs = 300_000, capture = false, ...rest } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', ...rest });
    let stdout = '', stderr = '', timeout = false, interrupted = null;
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        spawnSync(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'],
          { shell: false, windowsHide: true, timeout: 10_000 });
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already settled */ } }
    };
    const timer = setTimeout(() => { timeout = true; stop(); }, timeoutMs);
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => { interrupted = signal; stop(); }]);
    for (const [signal, handler] of signals) process.once(signal, handler);
    const settled = () => { clearTimeout(timer); for (const [signal, handler] of signals) process.removeListener(signal, handler); };
    child.stdout?.on('data', bytes => { stdout += bytes; if (stdout.length > 1024 * 1024) stop(); });
    child.stderr?.on('data', bytes => { stderr += bytes; if (stderr.length > 1024 * 1024) stop(); });
    child.once('error', error => { settled(); reject(error); });
    child.once('close', (code, signal) => {
      settled();
      if (code !== 0 || signal || timeout || interrupted) reject(new Error(`${path.basename(executable)} failed (${timeout ? `deadline ${timeoutMs}ms` : interrupted || signal || `exit ${code}`}): ${stderr.trim()}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function atomic(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()
      || (process.platform !== 'win32' && ((info.mode & 0o022) || (process.getuid && info.uid !== process.getuid())))) throw new Error(`Unsafe SFlow installation directory: ${directory}`);
}

async function packageTreeDigest(root) {
  const hash = createHash('sha256');
  let files = 0, bytes = 0;
  const visit = async directory => {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name);
      const info = await lstat(file);
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (info.isSymbolicLink()) throw new Error(`Managed package contains a redirected path: ${relative}`);
      if (info.isDirectory()) await visit(file);
      else if (info.isFile()) {
        if (++files > 60_000 || (bytes += info.size) > 1024 * 1024 * 1024) throw new Error('Managed package exceeds its bounded inventory.');
        const contents = await readFile(file);
        hash.update(`${relative}\0${contents.length}\0`); hash.update(contents);
      } else throw new Error(`Managed package contains a special file: ${relative}`);
    }
  };
  await visit(root);
  return hash.digest('hex');
}

export function managedLauncher(name, { windows = false } = {}) {
  if (!bins.includes(name)) throw new Error('Unsupported SFlow launcher.');
  const entry = name === 'sflow' ? 'singularity-flow' : name;
  if (windows) return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%SystemRoot%\\System32\\findstr.exe" /r /x /c:"1|node-v26[.][0-9][0-9]*[.][0-9][0-9]*-win32-${process.arch}|[0-9a-f][0-9a-f]*" "%~dp0..\\active" >nul\r\nif errorlevel 1 (echo SFlow engine selection is invalid. Repair the managed installation. 1>&2& exit /b 1)\r\nset "runtime="\r\nset "release="\r\nfor /f "usebackq tokens=1-3 delims=|" %%A in ("%~dp0..\\active") do if "%%A"=="1" (set "runtime=%%B"& set "release=%%C")\r\nif not defined runtime exit /b 1\r\nif not defined release exit /b 1\r\nif not "%release:~64%"=="" exit /b 1\r\nif "%release:~63,1%"=="" exit /b 1\r\n"%~dp0..\\runtimes\\%runtime%\\node.exe" "%~dp0..\\releases\\%release%\\node_modules\\singularity-flow\\bin\\${entry}.mjs" %*\r\nexit /b %errorlevel%\r\n`;
  return `#!/usr/bin/env bash\nset -euo pipefail\nengine_root="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")/.." && pwd -P)"\nIFS='|' read -r schema runtime release extra < "$engine_root/active"\n[[ "$schema" == 1 && -z "\${extra:-}" && "$runtime" != *[!a-zA-Z0-9.-]* && "$runtime" == node-v26.* && "$release" =~ ^[a-f0-9]{64}$ ]] || { printf '%s\\n' 'SFlow engine selection is invalid. Repair the managed installation.' >&2; exit 1; }\nexec "$engine_root/runtimes/$runtime/bin/node" "$engine_root/releases/$release/node_modules/singularity-flow/bin/${entry}.mjs" "$@"\n`;
}

async function assertNoLegacyRecovery(root) {
  // A managed install must not erase/bypass an unfinished legacy activation or uninstall.
  const installations = path.join(path.dirname(root), 'installations');
  for (const name of ['activation-current.json', 'distribution-install-pending.json', 'uninstall-pending.json']) {
    const file = path.join(installations, name);
    const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error(`Preserved installation recovery needs review: ${file}`);
    const record = JSON.parse(await readFile(file, 'utf8'));
    if (!['complete', 'rolled-back'].includes(record.status)) throw new Error(`Finish the existing installation recovery before managed activation: ${file}`);
  }
}

/** Install at a final content-addressed path before smoke/prewarm, then change one small pointer. */
export async function installManagedRelease({ tarball, sha256, nodeExecutable = process.execPath,
  root = resolver.engineHome(), execute = installerProcess, log = console.log } = {}) {
  if (!/^[a-f0-9]{64}$/.test(sha256 || '')) throw new Error('A trusted archive SHA-256 is required.');
  root = path.resolve(root);
  // Windows command shims cannot safely represent shell expansion characters in their own path.
  if (process.platform === 'win32' && /[%!^&|<>\r\n]/.test(root)) throw new Error('SFlow engine home contains unsupported Windows command-path characters. Choose a path without % ! ^ & | < >.');
  const archiveInfo = await lstat(tarball);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size > 512 * 1024 * 1024) throw new Error('Managed archive must be a bounded ordinary file.');
  const bytes = await readFile(tarball);
  if (digest(bytes) !== sha256) throw new Error('Managed archive digest changed; nothing was activated.');
  const runtimeRoot = path.resolve(path.dirname(nodeExecutable), process.platform === 'win32' ? '.' : '..');
  const runtime = path.basename(runtimeRoot);
  if (!/^node-v26\.\d+\.\d+-(darwin|linux|win32)-(arm64|x64)$/.test(runtime)
      || path.dirname(runtimeRoot) !== path.join(root, 'runtimes')) throw new Error('Managed activation requires the private, pinned Node runtime.');
  for (const directory of [root, path.join(root, 'runtimes'), runtimeRoot, path.dirname(nodeExecutable)]) await privateDirectory(directory);
  const nodeInfo = await lstat(nodeExecutable);
  if (!nodeInfo.isFile() || nodeInfo.isSymbolicLink()) throw new Error('Private Node must be an ordinary executable.');
  const version = (await execute(nodeExecutable, ['--version'], { capture: true, timeoutMs: 10_000 })).stdout.trim();
  if (runtime !== `node-${version}-${process.platform}-${process.arch}`) throw new Error('Private Node version/host mismatch.');
  const npm = path.join(runtimeRoot, ...(process.platform === 'win32' ? ['node_modules', 'npm'] : ['lib', 'node_modules', 'npm']), 'bin', 'npm-cli.js');
  await privateDirectory(root);
  await assertNoLegacyRecovery(root);
  for (const directory of ['releases', 'bin', 'cache']) await privateDirectory(path.join(root, directory));
  const lock = path.join(root, '.activation-lock');
  await mkdir(lock, { mode: 0o700 }).catch(() => { throw new Error('Another managed activation or interrupted activation needs recovery. The current engine was preserved.'); });
  const release = path.join(root, 'releases', sha256);
  const activeFile = path.join(root, 'active');
  const receiptFile = path.join(root, 'last-install.json');
  try {
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: 'wx' });
    const previous = await readFile(activeFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (previous) resolver.resolveManagedEngine({ environment: { SINGULARITY_FLOW_ENGINE_HOME: root } });
    let exists = await lstat(release).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (exists?.isDirectory() && !exists.isSymbolicLink()) {
      const archiveMarker = await lstat(path.join(release, '.archive-sha256')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const treeMarker = await lstat(path.join(release, '.package-tree-sha256')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!archiveMarker || !treeMarker) {
        const owner = JSON.parse(await readFile(path.join(release, '.install-owner.json'), 'utf8'));
        const priorReceipt = JSON.parse(await readFile(receiptFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; }));
        const selected = [previous, priorReceipt.previous, priorReceipt.candidate].filter(Boolean);
        if (owner.sha256 !== sha256 || owner.status !== 'staging'
            || selected.some(value => value.includes(`|${sha256}\n`))
            || digest(await readFile(path.join(release, 'singularity-flow.tgz'))) !== sha256) throw new Error('Incomplete release needs manual review; accepted/recovery bytes were preserved.');
        const quarantine = `${release}.failed-${randomUUID()}`;
        await rename(release, quarantine);
        log(`Preserved an interrupted, never-activated candidate at ${quarantine}; restaging its verified archive.`);
        exists = null;
      }
    }
    if (exists) {
      if (!exists.isDirectory() || exists.isSymbolicLink()
          || (await readFile(path.join(release, '.archive-sha256'), 'utf8')).trim() !== sha256) throw new Error('Existing release is incomplete; it was preserved for recovery.');
    } else {
      await privateDirectory(release);
      const retained = path.join(release, 'singularity-flow.tgz');
      await writeFile(retained, bytes, { mode: 0o600, flag: 'wx' });
      await writeFile(path.join(release, '.install-owner.json'), JSON.stringify({ status: 'staging', sha256 }), { mode: 0o600, flag: 'wx' });
      // Only this build/install child environment selects private Node. Application environments do not.
      const env = { ...process.env, PATH: `${path.dirname(nodeExecutable)}${path.delimiter}${process.env.PATH || ''}`,
        NPM_CONFIG_CACHE: path.join(release, '.npm-cache'), NODE_COMPILE_CACHE: undefined,
        NODE_COMPILE_CACHE_READONLY: undefined, NODE_OPTIONS: undefined };
      await execute(nodeExecutable, [npm, 'install', '--prefix', release, '--offline', '--ignore-scripts',
        '--global=false', '--workspaces=false', '--no-bin-links', '--omit=dev', '--no-audit', '--no-fund', retained], { cwd: root, env });
      await writeFile(path.join(release, '.archive-sha256'), `${sha256}\n`, { mode: 0o600, flag: 'wx' });
    }
    const packageRoot = path.join(release, 'node_modules', 'singularity-flow');
    const tree = await packageTreeDigest(packageRoot);
    const treeFile = path.join(release, '.package-tree-sha256');
    if (exists) {
      if ((await readFile(treeFile, 'utf8')).trim() !== tree) throw new Error('Retained managed package changed; it was preserved, not executed.');
    } else await writeFile(treeFile, `${tree}\n`, { mode: 0o600, flag: 'wx' });
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.name !== 'singularity-flow' || manifest.bin?.['singularity-flow'] !== 'bin/singularity-flow.mjs') throw new Error('Managed archive is not an SFlow engine.');
    const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
    const env = { ...process.env, SINGULARITY_FLOW_PRODUCT_ALIGNMENT: 'off' };
    const observed = (await execute(nodeExecutable, [cli, '--version'], { capture: true, env, cwd: root, timeoutMs: 30_000 })).stdout.trim();
    if (observed !== manifest.version) throw new Error('Managed engine smoke check failed.');
    const build = (await execute(nodeExecutable, [cli, '--build'], { capture: true, env, cwd: root, timeoutMs: 30_000 })).stdout.trim();
    if (!build.startsWith(`${manifest.version} (`) || /development checkout/.test(build)) throw new Error('Managed engine requires a stamped build.');
    try {
      await execute(nodeExecutable, [cli, '--warm-runtime'], { capture: true, env: { ...env,
        NODE_COMPILE_CACHE: path.join(root, 'cache', runtime, sha256), NODE_COMPILE_CACHE_READONLY: '0' }, cwd: root, timeoutMs: 30_000 });
    } catch (error) { log(`Optional cache preparation unavailable: ${error.message}`); }
    // Launchers are stable across releases and carry no release-specific executable selection.
    for (const name of bins) {
      const file = path.join(root, 'bin', `${name}${process.platform === 'win32' ? '.cmd' : ''}`);
      const content = managedLauncher(name, { windows: process.platform === 'win32' });
      if (await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; }) !== content) await atomic(file, content);
      if (process.platform !== 'win32') await chmod(file, 0o700);
    }
    const candidate = `1|${runtime}|${sha256}\n`;
    if (candidate !== previous) {
      await atomic(receiptFile, `${JSON.stringify({ schemaVersion: 1, status: 'prepared', previous,
        candidate, build, version: manifest.version, createdAt: new Date().toISOString() }, null, 2)}\n`);
      // The engine/runtime selection is committed in one atomic filesystem operation.
      await atomic(activeFile, candidate);
      try {
        await atomic(path.join(release, '.install-owner.json'), JSON.stringify({ status: 'activated', sha256 }));
        await atomic(receiptFile, `${JSON.stringify({ schemaVersion: 1, status: 'complete', previous,
          candidate, build, version: manifest.version, createdAt: new Date().toISOString() }, null, 2)}\n`);
      } catch (error) { log(`Engine activation committed; completion receipt remains prepared: ${error.message}`); }
    }
    return { installed: true, root, build, version: manifest.version, runtime, executable: nodeExecutable,
      cli, bin: path.join(root, 'bin'), previousRetained: Boolean(previous) };
  } finally { await rm(path.join(lock, 'owner.json'), { force: true }); await rmdir(lock); }
}

export async function rollbackManagedRelease({ root = resolver.engineHome(), execute = installerProcess } = {}) {
  const lock = path.join(root, '.activation-lock');
  await mkdir(lock, { mode: 0o700 }).catch(() => { throw new Error('Managed activation is active or needs --recover; rollback did not change it.'); });
  try {
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: 'wx' });
  const receipt = JSON.parse(await readFile(path.join(root, 'last-install.json'), 'utf8'));
  if (!receipt.previous || !/^1\|node-v26\.\d+\.\d+-(darwin|linux|win32)-(arm64|x64)\|[a-f0-9]{64}\n$/.test(receipt.previous)) throw new Error('No retained managed engine is available for rollback.');
  if (await readFile(path.join(root, 'active'), 'utf8') !== receipt.candidate) throw new Error('The active engine changed; rollback was refused.');
  const [, runtime, release] = receipt.previous.trim().split('|');
  const executable = path.join(root, 'runtimes', runtime, ...(process.platform === 'win32' ? ['node.exe'] : ['bin', 'node']));
  const cli = path.join(root, 'releases', release, 'node_modules', 'singularity-flow', 'bin', 'singularity-flow.mjs');
  const packageRoot = path.dirname(path.dirname(cli));
  const tree = await packageTreeDigest(packageRoot);
  if ((await readFile(path.join(root, 'releases', release, '.package-tree-sha256'), 'utf8')).trim() !== tree) throw new Error('Rollback package changed; current engine was preserved.');
  await execute(executable, [cli, '--build'], { capture: true, cwd: root, timeoutMs: 30_000 });
  await atomic(path.join(root, 'active'), receipt.previous);
  return { rolledBack: true };
  } finally { await rm(path.join(lock, 'owner.json'), { force: true }); await rmdir(lock); }
}

/** Explicit recovery releases only a proven dead installer lease; no executable/recovery data deleted. */
export async function recoverManagedActivation({ root = resolver.engineHome() } = {}) {
  const lock = path.join(root, '.activation-lock');
  const info = await lstat(lock).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return { recovered: false, reason: 'no-pending-activation' };
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Managed recovery lease is not an ordinary directory.');
  const ownerFile = path.join(lock, 'owner.json');
  const ownerInfo = await lstat(ownerFile);
  if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.size > 1024) throw new Error('Managed recovery owner needs manual review; nothing was changed.');
  const owner = JSON.parse(await readFile(ownerFile, 'utf8'));
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Managed recovery owner is invalid.');
  try { process.kill(owner.pid, 0); throw new Error('Managed installer is still running; recovery did not change it.'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  // No app/repository state is examined. A committed pointer must still resolve exactly.
  const selected = resolver.resolveManagedEngine({ environment: { SINGULARITY_FLOW_ENGINE_HOME: root } });
  await rm(ownerFile); await rmdir(lock);
  return { recovered: true, selected: selected?.release ?? null, retained: 'All runtime/release and recovery bytes preserved. Retry the managed install or use --rollback.' };
}
