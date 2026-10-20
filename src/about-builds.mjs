/** Machine-local build inventory. No Git, repository lookup, receipt authority or product mutation. */
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_INFO, versionLine } from './build-info.mjs';
import { parseBuildLine, stampedBuildLine } from './build-stamp-reader.mjs';
import { VERSION } from './version.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import runtimeResolver from '../runtime/resolve.cjs';

const EXTENSION = 'singularityflow.singularity-flow-vscode';
const MAX_FILE_BYTES = 1024 * 1024;

async function localText(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) {
    throw new Error(`Build metadata is not a bounded regular file: ${file}`);
  }
  return readFile(file, 'utf8');
}

function surface(id, label, build, extra = {}) {
  return { id, label, status: build ? (build.stamped ? 'available' : 'development') : 'unavailable',
    version: build?.version ?? null, build: build?.line ?? null,
    identity: build?.stamped ? build.line.slice(build.line.indexOf('(') + 1, -1).split(' · ')[0] : null,
    builtAt: build?.builtAt && Number.isFinite(Date.parse(build.builtAt)) ? new Date(build.builtAt).toISOString() : null,
    ...extra };
}

async function extensionSurface(directory) {
  const extra = { path: directory };
  try {
    const manifest = JSON.parse(await localText(path.join(directory, 'package.json')));
    if (`${manifest.publisher}.${manifest.name}`.toLowerCase() !== EXTENSION) throw new Error('Not a Singularity Flow extension.');
    extra.version = typeof manifest.version === 'string' ? manifest.version : null;
    if (!extra.version) throw new Error('Extension version is unavailable or invalid.');
    const cli = path.join(directory, 'cli');
    const build = stampedBuildLine(await localText(path.join(cli, 'src/version.mjs')),
      await localText(path.join(cli, 'src/build-info.mjs')));
    if (!build) throw new Error('Bundled CLI build stamp is unavailable or invalid.');
    return surface('vscode', 'VS Code extension', build, { ...extra, engineVersion: build.version });
  } catch (error) {
    return surface('vscode', 'VS Code extension', null, { ...extra, reason: error.message });
  }
}

async function extensionDirectories(homeDirectory, environment, warnings) {
  const directories = new Set();
  const roots = [...new Set([environment.SINGULARITY_FLOW_VSCODE_EXTENSIONS_DIR,
    path.join(homeDirectory, '.vscode/extensions'), path.join(homeDirectory, '.vscode-insiders/extensions')].filter(Boolean))];
  for (const root of roots) {
    try {
      const index = JSON.parse(await localText(path.join(root, 'extensions.json')));
      if (!Array.isArray(index)) throw new Error('Extension index is not an array.');
      for (const entry of index) {
        if (String(entry?.identifier?.id ?? '').toLowerCase() !== EXTENSION) continue;
        if (typeof entry.relativeLocation === 'string') {
          const directory = path.resolve(root, entry.relativeLocation);
          if (path.dirname(directory) === path.resolve(root)) directories.add(directory);
        } else if (entry.location?.scheme === 'file' && entry.location.path) {
          directories.add(fileURLToPath(new URL(`file://${entry.location.authority ?? ''}${entry.location.path}`)));
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') warnings.push(`Cannot read VS Code extension index: ${error.message}`);
      // Only this conventional extension directory is listed; never search the home or repositories.
      try {
        let found = false;
        for (const entry of (await readdir(root, { withFileTypes: true }))) {
          if (entry.isDirectory() && entry.name.startsWith(`${EXTENSION}-`)) {
            directories.add(path.join(root, entry.name)); found = true;
          }
        }
        if (found) warnings.push('The VS Code index is missing or unreadable; showing detected extension files, not a verified running window.');
      } catch (readError) {
        if (readError.code !== 'ENOENT') warnings.push(`Cannot inspect VS Code extension directory: ${readError.message}`);
      }
    }
  }
  if (directories.size > 32) warnings.push('Extension inventory is limited to 32 installations; select one with --extension-path.');
  return [...directories].slice(0, 32);
}

export async function aboutBuilds({ execute = null, environment = process.env, homeDirectory = os.homedir(),
  extensionPath = null, runningInfo = BUILD_INFO, packageRoot = PACKAGE_ROOT, now = () => new Date() } = {}) {
  const warnings = [];
  const running = surface('running', 'Running command', parseBuildLine(versionLine(runningInfo)), { path: packageRoot });
  if (!execute) ({ run: execute } = await import('./util.mjs'));
  let cli;
  try {
    const result = execute('singularity-flow', ['--build'], { allowFailure: true, timeoutMs: 30_000,
      maxBuffer: 64 * 1024, env: { ...environment, SINGULARITY_FLOW_PRODUCT_ALIGNMENT: 'off' } });
    const build = result.status === 0 && !result.timedOut && !result.error ? parseBuildLine(result.stdout) : null;
    cli = surface('cli', 'CLI on PATH (terminal / Copilot)', build, { executable: 'singularity-flow',
      ...(!build ? { reason: result.timedOut ? 'Build query timed out after 30000 ms.'
        : String(result.stderr || result.error?.message || (result.stdout
          ? `Unrecognized --build output: ${String(result.stdout).slice(0, 300)}` : 'CLI build output is unavailable.')).trim().slice(0, 1000),
      exitCode: result.status ?? null, timedOut: result.timedOut === true } : {}) });
  } catch (error) { cli = surface('cli', 'CLI on PATH (terminal / Copilot)', null, { reason: error.message }); }
  const directories = extensionPath ? [path.resolve(extensionPath)] : await extensionDirectories(homeDirectory, environment, warnings);
  const vscode = await Promise.all(directories.map(extensionSurface));
  if (!vscode.length) vscode.push(surface('vscode', 'VS Code extension', null,
    { reason: 'No installed extension was found in the local VS Code indexes. An extension in a custom directory can be selected with --extension-path.' }));
  const comparable = vscode.filter(item => item.status === 'available' && item.engineVersion === item.version);
  const mismatch = comparable.some(item => cli.status === 'available' && item.build !== cli.build)
    || vscode.some(item => item.engineVersion && item.engineVersion !== item.version);
  const alignment = mismatch ? 'mismatch' : cli.status === 'available' && comparable.length === vscode.length ? 'matched' : 'unknown';
  if (alignment === 'mismatch') warnings.push('Installed CLI and VS Code builds differ. Matching version numbers alone do not mean matching builds.');
  const runningMatchesPath = running.status === 'available' && cli.status === 'available' ? running.build === cli.build : null;
  if (runningMatchesPath === false) warnings.push('The command displaying this report is a different build from singularity-flow on PATH.');
  if (vscode.length > 1) warnings.push('Multiple installed extensions are listed; the shell cannot determine which VS Code window is running.');
  const receiptPath = path.join(homeDirectory, '.singularity-flow/installations/current.json');
  let receipt;
  try {
    const { readRecord } = await import('./schema-migrations.mjs');
    readRecord('installation-current', await localText(receiptPath));
    receipt = { status: 'present', path: receiptPath };
  } catch (error) { receipt = { status: error.code === 'ENOENT' ? 'missing' : 'invalid', path: receiptPath,
    ...(error.code === 'ENOENT' ? {} : { reason: error.message }) }; }
  let managed = null;
  try { managed = runtimeResolver.resolveManagedEngine({ environment, homeDirectory }); }
  catch (error) { warnings.push(`Managed runtime: ${error.message}`); }
  const actualExecutable = await realpath(process.execPath).catch(() => process.execPath);
  return { schemaVersion: 1, resultType: 'sflow-about', version: VERSION, checkedAt: now().toISOString(),
    running, cli, vscode, alignment, runningMatchesPath, receipt, warnings, runtime: {
      node: process.versions.node, executable: process.execPath, platform: process.platform,
      architecture: process.arch, managed: Boolean(managed && managed.executable === actualExecutable),
      selected: managed ? { node: managed.runtime, executable: managed.executable, cli: managed.cli } : null } };
}

const cell = value => String(value ?? 'unknown').replace(/[\r\n]+/gu, ' ').replace(/\|/gu, '\\|').replace(/`/gu, "'");

export function aboutBuildsMarkdown(report) {
  const rows = [report.running, report.cli, ...report.vscode];
  return [`Singularity Flow ${report.version}`, '', '## Build information', '',
    '| Surface | Version | Build identity | Build date (UTC) |', '| --- | --- | --- | --- |',
    ...rows.map(item => `| ${cell(item.label)} | ${cell(item.version)} | ${cell(item.identity ?? (item.status === 'development' ? 'development checkout' : null))} | ${cell(item.builtAt)} |`), '',
    `CLI / VS Code alignment: ${report.alignment}. Installation receipt: ${report.receipt.status}.`,
    `Engine Node: ${cell(report.runtime?.node)} (${report.runtime?.managed ? 'SFlow-managed' : 'external / host runtime'}).`,
    `Engine executable: ${cell(report.runtime?.executable)}.`,
    ...rows.filter(item => item.reason).map(item => `${cell(item.label)}: ${cell(item.reason)}`),
    ...report.warnings.map(warning => `Warning: ${cell(warning)}`), '',
    'Dates are recorded build stamps, not installation times. Unknown values are not inferred from matching version numbers.',
    'VS Code rows describe installed bytes; use About in the VS Code window to see its loaded UI build.',
    '', 'Copilot: /sf-about · Shell: singularity-flow about (or sflow-about).'
  ].join('\n');
}
