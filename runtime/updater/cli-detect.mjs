/**
 * Which installation of the SFlow CLI an update replaces, so a machine never ends with two CLIs.
 *
 * Three routes: SFlow's managed engine (setup, install-managed, or the updater's own first install),
 * an npm global install (`npm install -g singularity-flow-<v>.tgz`, common on office laptops), or no
 * CLI yet, which the managed installer creates. Detection only reads the filesystem, so VS Code names
 * the route in its confirmation before anything runs. Built-ins only: the standalone updater ZIP and
 * the VSIX ship it, and VS Code bundles it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Spelled through runtime/ so VS Code's bundles share their one resolver entry (apps/vscode/esbuild.mjs).
import { engineHome, resolveManagedEngine } from '../../runtime/resolve.cjs';

const PACKAGE = 'singularity-flow';
export const EXTENSION = 'singularityflow.singularity-flow-vscode';
export const layoutFor = platform => (platform === 'win32' ? path.win32 : path.posix);

/** The real filesystem, read synchronously; tests pass a fake one to check Windows layouts anywhere. */
export const realFilesystem = Object.freeze({
  kind(file) {
    try {
      const info = fs.lstatSync(file);
      return info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null;
    } catch { return null; }
  },
  readlink: file => fs.readlinkSync(file),
  realpath: file => fs.realpathSync.native(file),
  read: file => fs.readFileSync(file, 'utf8')
});

export function exists(fsView, file) {
  const kind = fsView.kind(file);
  if (kind !== 'link') return Boolean(kind);
  try { fsView.realpath(file); return true; } catch { return false; }
}

export function pathEntries(environment, platform) {
  const key = platform === 'win32' ? Object.keys(environment).find(name => name.toUpperCase() === 'PATH') : 'PATH';
  return String((key && environment[key]) || '').split(layoutFor(platform).delimiter).filter(Boolean);
}

/** The first `name` on PATH, with Windows' executable extensions. */
export function findOnPath(name, { environment = process.env, platform = process.platform, fsView = realFilesystem } = {}) {
  const layout = layoutFor(platform);
  const extensions = platform === 'win32'
    ? String(environment.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(value => value.toLowerCase())
    : [''];
  for (const directory of pathEntries(environment, platform)) {
    for (const extension of extensions) {
      const candidate = layout.join(directory, name + extension);
      const kind = fsView.kind(candidate);
      if ((kind === 'file' || kind === 'link') && exists(fsView, candidate)) return candidate;
    }
  }
  return null;
}

export function readVersion(packageRoot, layout, fsView) {
  try { return JSON.parse(fsView.read(layout.join(packageRoot, 'package.json'))).version ?? null; }
  catch { return null; }
}

/** The npm global install that holds `cli` (…/node_modules/singularity-flow/bin/singularity-flow.mjs), or null. */
export function npmGlobalPackageOf(cli, { platform = process.platform, fsView = realFilesystem } = {}) {
  const layout = layoutFor(platform);
  if (!cli || !layout.isAbsolute(cli)) return null;
  const packageRoot = layout.dirname(layout.dirname(layout.resolve(cli)));
  const nodeModules = layout.dirname(packageRoot);
  const named = value => (platform === 'win32' ? value.toLowerCase() : value);
  if (named(layout.basename(packageRoot)) !== PACKAGE || named(layout.basename(nodeModules)) !== 'node_modules') return null;
  let prefix, shim;
  if (platform === 'win32') {
    prefix = layout.dirname(nodeModules);
    shim = layout.join(prefix, PACKAGE + '.cmd');
  } else {
    if (layout.basename(layout.dirname(nodeModules)) !== 'lib') return null;
    prefix = layout.dirname(layout.dirname(nodeModules));
    shim = layout.join(prefix, 'bin', PACKAGE);
  }
  if (!fsView.kind(shim) || !fsView.kind(packageRoot)) return null;
  return { prefix, packageRoot, cli: layout.join(packageRoot, 'bin', PACKAGE + '.mjs'),
    linked: fsView.kind(packageRoot) === 'link', version: readVersion(packageRoot, layout, fsView) };
}

/** What `singularity-flow` on PATH is: an npm global install, SFlow's managed launcher, or something else. */
export function terminalCli({ environment = process.env, platform = process.platform, fsView = realFilesystem } = {}) {
  const layout = layoutFor(platform);
  const found = findOnPath(PACKAGE, { environment, platform, fsView });
  if (!found) return null;
  const directory = layout.dirname(found);
  if (fsView.kind(layout.join(layout.dirname(directory), 'active')) === 'file' && layout.basename(directory).toLowerCase() === 'bin'
    && fsView.kind(layout.join(layout.dirname(directory), 'releases')) === 'dir') return { kind: 'managed', path: found };
  if (platform === 'win32') {
    const npm = npmGlobalPackageOf(layout.join(directory, 'node_modules', PACKAGE, 'bin', PACKAGE + '.mjs'), { platform, fsView });
    return npm ? { kind: 'npm-global', path: found, ...npm } : { kind: 'other', path: found };
  }
  if (fsView.kind(found) === 'link') {
    // npm's bin link names the package through the global folder; resolve only that one hop, so an
    // `npm link` package (itself a link into a checkout) is still recognised as linked.
    const npm = npmGlobalPackageOf(layout.resolve(directory, fsView.readlink(found)), { platform, fsView });
    if (npm) return { kind: 'npm-global', path: found, ...npm };
  }
  return { kind: 'other', path: found };
}

/**
 * The install an update replaces. `currentCli` is the CLI VS Code runs, when VS Code asks.
 * Returns { route: 'managed' | 'npm-global' | 'unsupported', … } with `fresh` when nothing is installed yet.
 */
export function detectCliInstall({ currentCli = null, environment = process.env, homeDirectory = os.homedir(),
  platform = process.platform, fsView = realFilesystem, resolveManaged = resolveManagedEngine } = {}) {
  const layout = layoutFor(platform);
  let home = null, managed = null, managedProblem = null;
  try { home = engineHome({ environment, homeDirectory }); } catch (error) { managedProblem = error.message; }
  try { managed = resolveManaged({ environment, homeDirectory, platform }); } catch (error) { managedProblem = error.message; }
  const fromHost = currentCli ? npmGlobalPackageOf(currentCli, { platform, fsView }) : null;
  const onPath = terminalCli({ environment, platform, fsView });
  const npmOnPath = onPath?.kind === 'npm-global' ? onPath : null;
  if (managed || managedProblem) {
    const others = [fromHost, npmOnPath].filter(Boolean).map(item => item.packageRoot)
      .filter((value, index, all) => all.indexOf(value) === index);
    return { route: 'managed', engineHome: home, fresh: false, problem: managedProblem,
      version: managed ? readVersion(layout.dirname(layout.dirname(managed.cli)), layout, fsView) : null,
      cli: managed?.cli ?? null, others };
  }
  const npm = fromHost ?? npmOnPath;
  if (npm) {
    if (npm.linked) {
      return { route: 'unsupported', code: 'CLI_LINKED_CHECKOUT', reason: 'The SFlow CLI in ' + npm.prefix
        + ' is linked to a source checkout (npm link), so the updater does not replace it. Update that checkout with Git instead.' };
    }
    const others = [fromHost, npmOnPath].filter(item => item && item.packageRoot !== npm.packageRoot).map(item => item.packageRoot);
    return { route: 'npm-global', prefix: npm.prefix, packageRoot: npm.packageRoot, cli: npm.cli, version: npm.version, others };
  }
  if (onPath?.kind === 'other') {
    return { route: 'unsupported', code: 'CLI_UNKNOWN_INSTALL', reason: 'The singularity-flow command on PATH (' + onPath.path
      + ') was not installed with npm or with SFlow\'s installer, so the updater cannot replace it without leaving two SFlow CLIs. '
      + 'Remove it from PATH, or update it the way it was installed.' };
  }
  return { route: 'managed', engineHome: home, fresh: true, version: null, cli: null, others: [] };
}

/** One plain line about where the CLI is, for the confirmation and the terminal log. */
export function describeCliInstall(plan) {
  if (plan.route === 'npm-global') return 'The SFlow CLI' + (plan.version ? ' ' + plan.version : '') + ' is installed with npm in ' + plan.prefix + '.';
  if (plan.route === 'managed' && !plan.fresh) return 'The SFlow CLI' + (plan.version ? ' ' + plan.version : '') + ' is installed in SFlow\'s own folder, ' + plan.engineHome + '.';
  if (plan.route === 'managed') return 'No SFlow CLI is installed for terminals yet. It will go in SFlow\'s own folder, ' + plan.engineHome + '.';
  return plan.reason;
}

/** What the update does, in order, for this route and source kind. */
export function updateSteps(plan, sourceMode = 'folder') {
  const fetch = sourceMode === 'local-folder'
    ? 'Copy the newest matching .tgz and .vsix from the folder.'
    : 'Download the .tgz and .vsix from the SharePoint link.';
  const check = 'Check that the two files are one SFlow build.';
  const copilot = 'Uninstall the SFlow Copilot plugin and its skills, then install them again.';
  const vscode = 'Install the VS Code extension from the .vsix into this VS Code.';
  if (plan.route === 'npm-global') {
    return [fetch, check, 'Install the CLI from the .tgz with npm, into the same place (' + plan.prefix + ').', copilot, vscode];
  }
  return [fetch, check, 'Install the CLI from the .tgz into SFlow\'s own folder (' + plan.engineHome + ').', vscode, copilot];
}
