'use strict';
// Shared by VS Code, hooks and engine diagnostics. No Git, downloads, PATH search or repository reads.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ACTIVE = /^1\|(node-v26\.\d+\.\d+-(?:darwin|linux|win32)-(?:arm64|x64))\|([a-f0-9]{64})\n?$/;

function engineHome({ environment = process.env, homeDirectory = os.homedir() } = {}) {
  const configured = environment.SINGULARITY_FLOW_ENGINE_HOME;
  if (configured && !path.isAbsolute(configured)) throw new Error('SFlow engine home must be absolute.');
  return path.resolve(configured || path.join(homeDirectory, '.singularity-flow', 'engine'));
}

function ordinary(file, directory = false) {
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())) {
    throw new Error(`Managed SFlow path is not an ordinary ${directory ? 'directory' : 'file'}: ${file}`);
  }
  if (process.platform !== 'win32' && ((info.mode & 0o022) !== 0 || (process.getuid && info.uid !== process.getuid()))) {
    throw new Error(`Managed SFlow path is not private to this user: ${file}`);
  }
  return info;
}

function resolveManagedEngine(options = {}) {
  const root = engineHome(options);
  let text;
  try {
    const file = path.join(root, 'active');
    const info = ordinary(file);
    if (info.size > 256) throw new Error('Managed SFlow selection is oversized.');
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const parsed = ACTIVE.exec(text);
  if (!parsed) throw new Error('Managed SFlow selection is invalid; repair the installation.');
  const [, runtime, release] = parsed;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (!runtime.endsWith(`-${platform}-${arch}`)) throw new Error('Managed SFlow runtime does not match this host. Install on this host, including WSL/SSH/container hosts.');
  const runtimeRoot = path.join(root, 'runtimes', runtime);
  const releaseRoot = path.join(root, 'releases', release);
  for (const directory of [root, path.join(root, 'runtimes'), runtimeRoot,
    path.join(root, 'releases'), releaseRoot, path.join(releaseRoot, 'node_modules'),
    path.join(releaseRoot, 'node_modules', 'singularity-flow')]) ordinary(directory, true);
  const executable = path.join(runtimeRoot, ...(platform === 'win32' ? ['node.exe'] : ['bin', 'node']));
  const cli = path.join(releaseRoot, 'node_modules', 'singularity-flow', 'bin', 'singularity-flow.mjs');
  ordinary(executable); ordinary(path.dirname(cli), true); ordinary(cli);
  return { executable: fs.realpathSync.native(executable), cli: fs.realpathSync.native(cli),
    root, runtimeRoot, releaseRoot, runtime, release, source: 'managed' };
}

function assertLegacyInstallerAllowed(packageRoot) {
  // A managed engine must never accidentally update/uninstall the user's unrelated global npm.
  const release = path.dirname(path.dirname(packageRoot));
  if (path.basename(packageRoot) === 'singularity-flow' && path.basename(path.dirname(packageRoot)) === 'node_modules'
      && /^[a-f0-9]{64}$/.test(path.basename(release)) && path.basename(path.dirname(release)) === 'releases') {
    throw new Error('This is an SFlow-managed engine. Use install-managed.sh / install-managed.ps1 (source), or the promoted installer with --managed-runtime (distribution). Use the managed source installer --rollback or --recover for recovery. Legacy global npm replacement/removal was not attempted.');
  }
}

module.exports = { engineHome, resolveManagedEngine, assertLegacyInstallerAllowed };
