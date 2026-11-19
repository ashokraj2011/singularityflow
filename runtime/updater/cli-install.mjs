/**
 * The npm global route of an update: npm install of the checked .tgz with the npm that owns the
 * global folder SFlow is in now, the Copilot plugin uninstalled and installed again, then the VSIX
 * installed into the VS Code that asked. Built-ins only: the standalone updater ZIP and the VSIX ship it.
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { processCommand } from './process.mjs';
import { EXTENSION, exists, findOnPath, layoutFor, pathEntries, readVersion, realFilesystem } from './cli-detect.mjs';
export { describeCliInstall, detectCliInstall, updateSteps } from './cli-detect.mjs';

const PACKAGE = 'singularity-flow';
const fail = message => { throw new Error(message); };

function samePath(left, right, platform, fsView) {
  const layout = layoutFor(platform), canonical = value => {
    let resolved = layout.resolve(value);
    try { resolved = fsView.realpath(resolved); } catch { /* compare as written */ }
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return canonical(left) === canonical(right);
}

/** Places npm may live for a global folder, most specific first: the folder's own npm, then PATH. */
export function npmCandidates(prefix, { environment = process.env, platform = process.platform, fsView = realFilesystem } = {}) {
  const layout = layoutFor(platform), result = [], seen = new Set();
  const add = (node, npmCli) => {
    if (!node || !npmCli || seen.has(npmCli) || !exists(fsView, npmCli) || !exists(fsView, node)) return;
    seen.add(npmCli); result.push({ node, npmCli });
  };
  if (platform === 'win32') {
    const directories = [prefix, ...pathEntries(environment, platform),
      environment.ProgramFiles && layout.join(environment.ProgramFiles, 'nodejs')].filter(Boolean);
    for (const directory of directories) {
      if (!fsView.kind(layout.join(directory, 'npm.cmd'))) continue;
      add(layout.join(directory, 'node.exe'), layout.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
    return result;
  }
  const pathNode = findOnPath('node', { environment, platform, fsView });
  for (const directory of [layout.join(prefix, 'bin'), ...pathEntries(environment, platform)]) {
    const npm = layout.join(directory, 'npm');
    if (!fsView.kind(npm)) continue;
    let npmCli;
    try { npmCli = fsView.realpath(npm); } catch { continue; }
    if (layout.basename(npmCli) !== 'npm-cli.js') continue;
    const sibling = layout.join(directory, 'node');
    add(exists(fsView, sibling) ? sibling : pathNode, npmCli);
  }
  return result;
}

/** The npm whose global folder is `prefix`, proven by asking it. Refuses before any change otherwise. */
export async function owningNpm(prefix, { environment = process.env, platform = process.platform, fsView = realFilesystem,
  execute = processCommand } = {}) {
  const tried = [];
  for (const candidate of npmCandidates(prefix, { environment, platform, fsView })) {
    try {
      const { stdout } = await execute(candidate.node, [candidate.npmCli, 'prefix', '--global'],
        { capture: true, env: { ...environment, NODE_OPTIONS: undefined }, timeoutMs: 60_000 });
      const reported = String(stdout).trim().split(/\r?\n/u).pop();
      if (reported && samePath(reported, prefix, platform, fsView)) return candidate;
      tried.push(candidate.npmCli + ' (its global folder is ' + reported + ')');
    } catch (error) { tried.push(candidate.npmCli + ' (' + String(error.message).split('\n')[0] + ')'); }
  }
  fail('Could not find the npm that installed SFlow in ' + prefix + ', so the CLI was not touched. '
    + (tried.length ? 'Tried: ' + tried.join('; ') + '. ' : 'No npm was found on PATH. ')
    + 'Open a terminal where `npm prefix -g` prints ' + prefix + ' and run singularity-flow update there.');
}

/** How to run one VS Code's command-line tool: its own launcher, or on Windows the runtime the .cmd starts. */
export function vscodeCli(launcher, { platform = process.platform, fsView = realFilesystem, extensionsDirectory = null } = {}) {
  const layout = layoutFor(platform);
  if (!launcher || !layout.isAbsolute(launcher)) fail('VS Code\'s command-line tool must be an absolute path.');
  const env = extensionsDirectory ? { VSCODE_EXTENSIONS: layout.resolve(extensionsDirectory) } : {};
  if (platform !== 'win32' || !/\.cmd$/iu.test(launcher)) return { command: launcher, args: [], env, launcher };
  // code.cmd is `"%~dp0..\Code.exe" "%~dp0..\<…>\cli.js" %*` with ELECTRON_RUN_AS_NODE=1. Run that pair
  // directly: Node refuses to start a .cmd without a shell, and a shell would reparse every argument.
  let text;
  try { text = fsView.read(launcher); } catch (error) { fail('Could not read VS Code\'s launcher ' + launcher + ': ' + error.message); }
  const found = /"%~dp0([^"%]+\.exe)"\s+"%~dp0([^"%]+cli\.js)"/iu.exec(text);
  if (!found) fail('VS Code\'s launcher ' + launcher + ' has an unexpected form; update VS Code and try again.');
  const directory = layout.dirname(launcher);
  return { command: layout.resolve(directory, found[1]), args: [layout.resolve(directory, found[2])],
    env: { ...env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: undefined }, launcher };
}

/** VS Code's launcher when no host named one: the setting, PATH, then the usual install folders. */
export function defaultVsCodeLauncher({ environment = process.env, homeDirectory = os.homedir(), platform = process.platform,
  fsView = realFilesystem } = {}) {
  const layout = layoutFor(platform);
  const configured = environment.SINGULARITY_FLOW_CODE_COMMAND;
  if (configured) return layout.isAbsolute(configured) && exists(fsView, configured) ? configured
    : fail('SINGULARITY_FLOW_CODE_COMMAND must name an existing absolute VS Code launcher.');
  const onPath = findOnPath('code', { environment, platform, fsView });
  if (onPath) return onPath;
  const candidates = platform === 'darwin' ? [
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    layout.join(homeDirectory, 'Applications', 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code')
  ] : platform === 'win32' ? [
    environment.LOCALAPPDATA && layout.join(environment.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    environment.ProgramFiles && layout.join(environment.ProgramFiles, 'Microsoft VS Code', 'bin', 'code.cmd')
  ] : ['/usr/bin/code', '/usr/share/code/bin/code'];
  return candidates.filter(Boolean).find(candidate => exists(fsView, candidate)) ?? null;
}

async function verifyExtension(code, pair, version, { execute, environment }) {
  const env = { ...environment, ...code.env };
  const listed = (await execute(code.command, [...code.args, '--list-extensions', '--show-versions'], { capture: true, env, timeoutMs: 60_000 })).stdout;
  if (!String(listed).split(/\r?\n/u).some(line => line.trim().toLowerCase() === EXTENSION + '@' + version)) {
    fail('VS Code did not list the SFlow extension ' + version + ' after installing it.');
  }
  const located = String((await execute(code.command, [...code.args, '--locate-extension', EXTENSION], { capture: true, env, timeoutMs: 60_000 })).stdout)
    .trim().split(/\r?\n/u).pop();
  const installed = await readFile(path.join(located, 'cli', 'src', 'build-info.mjs'), 'utf8').catch(() => null);
  if (installed !== pair.buildInfoSource) fail('VS Code has an SFlow extension ' + version + ' from a different build. Try again.');
}

/**
 * Update an npm global install in place: npm install of the .tgz with the npm that owns the folder,
 * then the Copilot plugin uninstalled and installed again, then the VSIX installed into VS Code.
 * Everything that could refuse is checked before the first change.
 */
export async function installNpmGlobal(pair, { plan, work, environment = process.env, homeDirectory = os.homedir(),
  platform = process.platform, fsView = realFilesystem, execute = processCommand, log = console.log, code = null } = {}) {
  const layout = layoutFor(platform);
  if (!findOnPath('copilot', { environment, platform, fsView })) {
    fail('GitHub Copilot CLI is not installed for this user, so the SFlow Copilot plugin cannot be reinstalled. Install Copilot CLI, then try again. Nothing was changed.');
  }
  const vscode = code ?? (() => {
    const launcher = defaultVsCodeLauncher({ environment, homeDirectory, platform, fsView });
    if (!launcher) fail('VS Code\'s command-line tool was not found. Install VS Code for this user, or update from VS Code\'s Update SFlow… menu. Nothing was changed.');
    return vscodeCli(launcher, { platform, fsView });
  })();
  const npm = await owningNpm(plan.prefix, { environment, platform, fsView, execute });
  const quiet = { ...environment, NODE_OPTIONS: undefined, NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_CACHE: layout.join(work, 'npm-cache'), NPM_CONFIG_FUND: 'false', NPM_CONFIG_AUDIT: 'false' };
  log('Installing the SFlow CLI ' + pair.version + ' with npm into ' + plan.prefix + '…');
  await execute(npm.node, [npm.npmCli, 'install', '--global', '--prefix', plan.prefix, '--offline', '--ignore-scripts',
    '--no-audit', '--no-fund', pair.tarball], { cwd: work, env: quiet, timeoutMs: 900_000 });
  const installedVersion = readVersion(plan.packageRoot, layout, fsView);
  const installedBuild = await readFile(layout.join(plan.packageRoot, 'src', 'build-info.mjs'), 'utf8').catch(() => null);
  if (installedVersion !== pair.version || installedBuild !== pair.buildInfoSource) {
    fail('npm finished, but ' + plan.packageRoot + ' does not hold the SFlow ' + pair.version + ' build that was checked. Try again.');
  }
  const cli = layout.join(plan.packageRoot, 'bin', PACKAGE + '.mjs');
  const cliEnv = { ...environment, NODE_OPTIONS: undefined, SINGULARITY_FLOW_PRODUCT_ALIGNMENT: 'off' };
  log('Uninstalling the SFlow Copilot plugin and its skills…');
  await execute(npm.node, [cli, 'plugin', 'uninstall'], { cwd: work, env: cliEnv, timeoutMs: 300_000 });
  log('Installing the SFlow Copilot plugin and its skills again…');
  await execute(npm.node, [cli, 'plugin', 'install'], { cwd: work, timeoutMs: 300_000,
    env: { ...cliEnv, SINGULARITY_FLOW_PLUGIN_SOURCE: layout.join(plan.packageRoot, 'plugin'), SINGULARITY_FLOW_MARKETPLACE_SOURCE: '' } });
  log('Installing the SFlow VS Code extension ' + pair.version + '…');
  await execute(vscode.command, [...vscode.args, '--install-extension', pair.vsix, '--force'],
    { cwd: work, env: { ...environment, ...vscode.env }, timeoutMs: 300_000 });
  await verifyExtension(vscode, pair, pair.version, { execute, environment });
  return { route: 'npm-global', cli, prefix: plan.prefix, version: pair.version };
}
