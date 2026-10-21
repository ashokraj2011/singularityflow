/** One-command, resumable per-user CLI + VS Code extension + Copilot integration installation.
 * External managers cannot commit atomically together. A durable receipt records partial setup;
 * the same command finishes its exact retained candidate before accepting a newer one. No old
 * runtime, artifact, workspace, personal skill or recovery journal is deleted to make setup pass.
 */
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installManagedRelease, installerProcess, recoverManagedActivation } from './install.mjs';
import { installUserPath } from './user-path.mjs';
import resolver from './resolve.cjs';
import { commandExists, run } from '../src/util.mjs';
import { inspectVsix } from '../scripts/install-staged-artifacts.mjs';
import { verifyPluginInstallation } from '../src/plugin.mjs';

const EXTENSION = 'singularityflow.singularity-flow-vscode';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[a-f0-9]{64}$/u;
const GUID = /^[a-f0-9-]{36}$/u;

async function atomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

async function ordinary(file, maximum = 512 * 1024 * 1024) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum) throw new Error(`Setup input is not a bounded ordinary file: ${file}`);
  return readFile(file);
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()
    || (process.platform !== 'win32' && ((info.mode & 0o022) || info.uid !== process.getuid()))) {
    throw new Error(`Setup directory must be private to this user: ${directory}`);
  }
}

async function enrollTrust(homeDirectory, bytes) {
  if (!bytes) return;
  const directory = path.join(homeDirectory, '.singularity-flow', 'trust');
  await privateDirectory(path.dirname(directory)); await privateDirectory(directory);
  const file = path.join(directory, 'artifact-builder-public.pem');
  const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64 * 1024)) throw new Error('Stored distribution trust key needs review; preserved.');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

async function pending(root) {
  const file = path.join(root, 'product-install.json');
  let bytes;
  try { bytes = await ordinary(file, 64 * 1024); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const value = JSON.parse(bytes);
  if (value.schemaVersion !== 1 || value.kind !== 'sflow-managed-product-install'
    || !GUID.test(value.operationId || '') || !SHA.test(value.sha256 || '') || !SHA.test(value.vsixSha256 || '')
    || !['applying', 'needs-retry', 'complete'].includes(value.status)
    || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(value.version || '')
    || !value.stages || typeof value.stages !== 'object' || Array.isArray(value.stages)
    || Object.entries(value.stages).some(([name, status]) => !['cli', 'vscode', 'copilot', 'path'].includes(name) || status !== 'verified')) {
    throw new Error('Full-product setup receipt is invalid; it was preserved.');
  }
  return value;
}

async function acquire(root) {
  const lock = path.join(root, '.product-lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); return lock; }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt) throw error;
      const info = await lstat(lock);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Full-product setup lease needs review; preserved.');
      const owner = JSON.parse(await ordinary(path.join(lock, 'owner.json'), 1024));
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Full-product setup owner is invalid; preserved.');
      try { process.kill(owner.pid, 0); throw new Error('Another full-product installer is still running.'); }
      catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
      await rm(path.join(lock, 'owner.json')); await rmdir(lock);
    }
  }
}

/** Locate an existing IDE without requiring its optional command-line launcher to be on PATH. */
export function resolveSetupCode({ environment = process.env, homeDirectory = os.homedir(),
  platform = process.platform, exists = commandExists, fileExists = existsSync } = {}) {
  const layout = platform === 'win32' ? path.win32 : path.posix;
  if (environment.SINGULARITY_FLOW_CODE_COMMAND) {
    if (!path.isAbsolute(environment.SINGULARITY_FLOW_CODE_COMMAND) || !fileExists(environment.SINGULARITY_FLOW_CODE_COMMAND)) throw new Error('SINGULARITY_FLOW_CODE_COMMAND must name an existing absolute VS Code launcher.');
    return environment.SINGULARITY_FLOW_CODE_COMMAND;
  }
  if (exists('code', { environment })) return 'code';
  const candidates = platform === 'darwin' ? [
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    layout.join(homeDirectory, 'Applications', 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code')
  ] : platform === 'win32' ? [
    environment.LOCALAPPDATA && layout.join(environment.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    environment.ProgramFiles && layout.join(environment.ProgramFiles, 'Microsoft VS Code', 'bin', 'code.cmd')
  ] : [];
  const selected = candidates.filter(Boolean).find(fileExists);
  if (!selected) throw new Error('VS Code is not installed or its launcher is unavailable. Install VS Code for this user, then rerun the same setup command. No administrator access is requested by SFlow.');
  return selected;
}

function invoke(execute, command, args, env, { mutate = false } = {}) {
  const result = execute(command, args, { env, allowFailure: true, stdio: 'pipe', timeoutMs: mutate ? 300_000 : 30_000 });
  if (result.status !== 0) throw new Error(`${path.basename(command)} ${args[0]} failed: ${String(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  return result.stdout.trim();
}

async function verifyUi({ execute, code, env, packageRoot, version }) {
  const versions = invoke(execute, code, ['--list-extensions', '--show-versions'], env).split(/\r?\n/u);
  if (!versions.some(line => line.toLowerCase() === `${EXTENSION}@${version}`)) throw new Error('Installed VS Code extension version did not match the candidate.');
  const directory = invoke(execute, code, ['--locate-extension', EXTENSION], env).split(/\r?\n/u).at(-1);
  if (!path.isAbsolute(directory)) throw new Error('VS Code did not return an absolute installed extension path.');
  const actual = await ordinary(path.join(directory, 'cli', 'src', 'build-info.mjs'), 64 * 1024);
  const expected = await ordinary(path.join(packageRoot, 'src', 'build-info.mjs'), 64 * 1024);
  if (!actual.equals(expected)) throw new Error('VS Code extension has the right version but a different build. Rerun setup; it was not reported complete.');
}

/** Full setup installs the SFlow extension/integration, not Microsoft's IDE or Copilot service. */
export async function installManagedProduct({ tarball, sha256, vsix, root = resolver.engineHome(),
  nodeExecutable = process.execPath, homeDirectory = os.homedir(), environment = process.env,
  trustedPublicKeyPem = null,
  execute = run, executeNode = installerProcess, installEngine = installManagedRelease,
  inspectExtension = inspectVsix, verifyExtension = verifyUi, verifyCopilot = verifyPluginInstallation,
  updatePath = installUserPath, resolveCode = resolveSetupCode, exists = commandExists, log = console.log } = {}) {
  root = path.resolve(root);
  if (/[\0\r\n]/u.test(root) || root.includes(path.delimiter)
    || (process.platform === 'win32' && /[%!^&|<>]/u.test(root))) throw new Error('Select a per-user engine directory without control, shell-expansion or PATH separator characters.');
  if (!SHA.test(sha256 || '')) throw new Error('A trusted archive SHA-256 is required.');
  const code = resolveCode({ environment, homeDirectory });
  if (!exists('copilot', { environment })) {
    // No vendor download or license acceptance is silently performed while installing SFlow.
    throw new Error('GitHub Copilot CLI is unavailable. Install it for this user, then rerun setup. SFlow installs its own Copilot plugin and skills, not a Copilot subscription.');
  }
  const requestedVsixBytes = await ordinary(vsix);
  if (digest(await ordinary(tarball)) !== sha256) throw new Error('Engine archive changed during setup admission.');
  await privateDirectory(root);
  const lock = await acquire(root);
  let state;
  const receiptFile = path.join(root, 'product-install.json');
  const env = { ...environment, HOME: homeDirectory, USERPROFILE: homeDirectory,
    SINGULARITY_FLOW_ENGINE_HOME: root, SINGULARITY_FLOW_PRODUCT_ALIGNMENT: 'off' };
  try {
    state = await pending(root);
    if (state && state.status !== 'complete') {
      log('Resuming the exact retained CLI, VS Code and Copilot setup before installing another build.');
      await complete(state);
      // A retry of the same package has just verified every surface. Do not install it twice or
      // replace the recovered operation receipt with a redundant second transaction.
      if (state.sha256 === sha256 && state.vsixSha256 === digest(requestedVsixBytes)) return completedResult();
    }
    const extension = await inspectExtension(vsix);
    if (!extension.version || extension.sha256 !== `sha256:${digest(requestedVsixBytes)}`) throw new Error('VSIX changed during setup admission.');
    if (digest(await ordinary(tarball)) !== sha256) throw new Error('Engine archive changed during setup admission.');
    const retainedDirectory = path.join(root, 'product-artifacts', sha256);
    await privateDirectory(path.dirname(retainedDirectory)); await privateDirectory(retainedDirectory);
    for (const [name, bytes] of [['singularity-flow.tgz', await ordinary(tarball)], ['singularity-flow.vsix', requestedVsixBytes]]) {
      const retained = path.join(retainedDirectory, name);
      const existing = await lstat(retained).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing) { if (!(await ordinary(retained)).equals(bytes)) throw new Error('Retained setup artifacts conflict; nothing was discarded.'); }
      else await writeFile(retained, bytes, { flag: 'wx', mode: 0o600 });
    }
    state = { schemaVersion: 1, kind: 'sflow-managed-product-install', operationId: randomUUID(),
      sha256, vsixSha256: digest(requestedVsixBytes), version: extension.version,
      status: 'applying', stages: {}, startedAt: new Date().toISOString() };
    await atomic(receiptFile, state);
    await complete(state);
    return completedResult();
  } catch (error) {
    if (state && state.status !== 'complete') {
      state.status = 'needs-retry'; state.error = String(error.message).slice(0, 4000);
      await atomic(receiptFile, state);
    }
    throw new Error(`Full SFlow setup did not complete: ${error.message}. Rerun the same setup command to resume. Prior runtimes, artifacts, workspaces and recovery were preserved.`, { cause: error });
  } finally { await rm(path.join(lock, 'owner.json'), { force: true }); await rmdir(lock); }

  function completedResult() {
    log('Singularity Flow user installation — COMPLETE AND VERIFIED');
    log('CLI, VS Code extension, Copilot plugin/skills and user PATH are aligned. Restart VS Code/Copilot and open a new terminal once to load updated integrations and environment; setup does not force-close applications.');
    return { ...state, root, restartRequired: true, adminRequired: false };
  }

  async function complete(record) {
    const retained = path.join(root, 'product-artifacts', record.sha256);
    await privateDirectory(path.dirname(retained)); await privateDirectory(retained);
    const archive = path.join(retained, 'singularity-flow.tgz'), extension = path.join(retained, 'singularity-flow.vsix');
    if (digest(await ordinary(archive)) !== record.sha256 || digest(await ordinary(extension)) !== record.vsixSha256) throw new Error('Pending setup artifact integrity failed; recovery was preserved.');
    await recoverManagedActivation({ root });
    const installed = await installEngine({ tarball: archive, sha256: record.sha256, root, homeDirectory,
      nodeExecutable, productOperationId: record.operationId, log });
    if (installed.version !== record.version) throw new Error('Engine and VSIX versions do not match.');
    const packageRoot = path.join(root, 'releases', record.sha256, 'node_modules', 'singularity-flow');
    record.stages.cli = 'verified'; await atomic(receiptFile, record);
    log('Installing and verifying the SFlow VS Code extension for this user…');
    invoke(execute, code, ['--install-extension', extension, '--force'], env, { mutate: true });
    await verifyExtension({ execute, code, env, packageRoot, version: record.version });
    record.stages.vscode = 'verified'; await atomic(receiptFile, record);
    log('Installing and verifying the SFlow Copilot plugin and skills for this user…');
    await executeNode(installed.executable, [installed.cli, 'plugin', 'install'], { cwd: root,
      env: { ...env, SINGULARITY_FLOW_PLUGIN_SOURCE: path.join(packageRoot, 'plugin'), SINGULARITY_FLOW_MARKETPLACE_SOURCE: '' }, timeoutMs: 300_000 });
    const plugin = await verifyCopilot({ execute, env, directSourceRoot: path.join(packageRoot, 'plugin', 'skills') });
    if (plugin?.pluginVersion && plugin.pluginVersion !== record.version) throw new Error('Copilot reports a different SFlow plugin version; setup remains incomplete.');
    record.stages.copilot = 'verified'; await atomic(receiptFile, record);
    record.path = await updatePath({ root, homeDirectory, environment });
    // Keep the exact extension with the engine for an explicit future rollback/recovery operation.
    const retainedVsix = path.join(root, 'releases', record.sha256, 'singularity-flow.vsix');
    const priorVsix = await lstat(retainedVsix).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (priorVsix && (!priorVsix.isFile() || priorVsix.isSymbolicLink())) throw new Error('Retained VSIX is redirected; preserved for review.');
    const temporary = `${retainedVsix}.${randomUUID()}.tmp`;
    try { await copyFile(extension, temporary); await rename(temporary, retainedVsix); }
    finally { await rm(temporary, { force: true }); }
    await enrollTrust(homeDirectory, trustedPublicKeyPem);
    record.stages.path = 'verified'; record.status = 'complete'; record.completedAt = new Date().toISOString();
    delete record.error;
    await atomic(receiptFile, record);
  }
}
