/** Source snapshot and packaging used by the installer before dependencies are installed. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stampBuildInfoFile } from './build-info-stamp.mjs';
import { nodeVersionProblem } from './node-requirement.mjs';
import { run, SingularityFlowError } from './util.mjs';
import {
  VSIX_SOURCE_MANIFEST_ENV, VSIX_SOURCE_MANIFEST_SHA256_ENV, writeVsixSourceManifest
} from './vsix-source-manifest.mjs';

export const COPILOT_DIRECT_PLUGIN = 'singularity-flow';

export const REINSTALL_SURFACES = Object.freeze({
  npmPackage: 'singularity-flow',
  copilotPlugins: Object.freeze([COPILOT_DIRECT_PLUGIN, 'singularity-flow@singularity-flow']),
  directSkillPrefix: 'sf-',
  vscodeExtension: 'singularityflow.singularity-flow-vscode',
  telemetryWrapper: '.singularity-flow/copilot-otel.sh'
});

/** The way on from a registry address the installer cannot use: the place to give a usable one. */
const REGISTRY_ADDRESS_FIX = 'Give the registry\'s full address, such as https://registry.npmjs.org/, with --registry or with npm config set registry <address>.';
/** The way on from a folder that is not Singularity Flow's source. */
const CHOOSE_SOURCE_FOLDER = 'Use the folder that holds the Singularity Flow source, the one with install.sh and package.json; reinstall takes it with --checkout.';

export const PRODUCT_READ_TIMEOUT_MS = 30_000;
export const PRODUCT_MUTATION_TIMEOUT_MS = 300_000;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Refuse an unsupported runtime before the isolated reinstall build starts. */
export function assertReinstallNodeVersion(version = process.versions.node, platform = process.platform) {
  const normalized = String(version ?? '').trim();
  const problem = nodeVersionProblem(normalized, platform);
  if (problem) throw new SingularityFlowError(problem);
  return { version: normalized.replace(/^v/, ''), major: Number(normalized.replace(/^v/, '').split('.')[0]) };
}

export function normalizeReinstallRegistry(value) {
  let registry;
  try { registry = new URL(String(value)); }
  catch {
    throw new SingularityFlowError(`Invalid npm registry URL: ${value}`, { code: 'INSTALL_SOURCE_REGISTRY_INVALID', details: {
      nextAction: REGISTRY_ADDRESS_FIX } });
  }
  if (!['http:', 'https:'].includes(registry.protocol)) {
    throw new SingularityFlowError('The npm registry must use http:// or https://.', { code: 'INSTALL_SOURCE_REGISTRY_NOT_WEB', details: {
      nextAction: REGISTRY_ADDRESS_FIX } });
  }
  if (registry.username || registry.password) {
    throw new SingularityFlowError('Do not place registry credentials in the URL; configure authentication in .npmrc.', { code: 'INSTALL_SOURCE_REGISTRY_LOGIN_IN_ADDRESS',
      details: { nextAction: 'Take the user name and password out of the registry address and put the login in your .npmrc file instead.' } });
  }
  if (registry.search || registry.hash) {
    throw new SingularityFlowError('The npm registry URL cannot contain a query string or fragment.', { code: 'INSTALL_SOURCE_REGISTRY_QUERY',
      details: { nextAction: 'Take everything from the first ? or # out of the registry address, then run the same command again.' } });
  }
  if (!registry.pathname.endsWith('/')) registry.pathname += '/';
  return registry.toString();
}

export async function regularFile(file, label) {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new SingularityFlowError(`The selected checkout does not contain a regular ${label}: ${file}`, { code: 'INSTALL_SOURCE_FILE_MISSING',
      details: { file, nextAction: `Put an ordinary ${label} file (not a link) back at ${file}, from a complete copy of the source, then run the same command again.` } });
  }
}

export async function validateReinstallCheckout(requestedCheckout) {
  const requested = path.resolve(requestedCheckout);
  const checkout = await realpath(requested).catch(() => requested);
  const info = await lstat(checkout).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new SingularityFlowError(`Reinstall requires a Singularity Flow source checkout directory: ${checkout}`, { code: 'INSTALL_SOURCE_NOT_A_FOLDER',
      details: { checkout, nextAction: CHOOSE_SOURCE_FOLDER } });
  }
  const packageFile = path.join(checkout, 'package.json');
  const installer = path.join(checkout, 'install.sh');
  const pluginFile = path.join(checkout, 'plugin', 'plugin.json');
  const vscodeFile = path.join(checkout, 'apps', 'vscode', 'package.json');
  await regularFile(packageFile, 'package.json');
  await regularFile(installer, 'install.sh');
  await regularFile(pluginFile, 'plugin/plugin.json');
  await regularFile(vscodeFile, 'apps/vscode/package.json');
  let product;
  let plugin;
  let vscode;
  try {
    [product, plugin, vscode] = await Promise.all([
      readFile(packageFile, 'utf8').then(JSON.parse),
      readFile(pluginFile, 'utf8').then(JSON.parse),
      readFile(vscodeFile, 'utf8').then(JSON.parse)
    ]);
  } catch (error) {
    throw new SingularityFlowError(`Unable to read the checkout manifests: ${error.message}`, { code: 'INSTALL_SOURCE_MANIFEST_UNREADABLE', details: { checkout,
      nextAction: 'Restore package.json, plugin/plugin.json and apps/vscode/package.json in the source folder so each is valid JSON, then run the same command again.' } });
  }
  if (product.name !== REINSTALL_SURFACES.npmPackage) {
    throw new SingularityFlowError(`The selected checkout is not the Singularity Flow package: ${checkout}`, { code: 'INSTALL_SOURCE_NOT_SFLOW',
      details: { checkout, nextAction: CHOOSE_SOURCE_FOLDER } });
  }
  if (plugin.name !== 'singularity-flow' || vscode.publisher !== 'singularityflow' || vscode.name !== 'singularity-flow-vscode') {
    throw new SingularityFlowError(`The selected checkout does not contain the expected Copilot plugin and VS Code extension: ${checkout}`, { code: 'INSTALL_SOURCE_PARTS_MISSING',
      details: { checkout, nextAction: 'Use a complete copy of the Singularity Flow source, with its Copilot plugin in plugin/ and its VS Code extension in apps/vscode/.' } });
  }
  if (product.version !== plugin.version || product.version !== vscode.version) {
    throw new SingularityFlowError(
      `Product versions do not match: npm ${product.version}, Copilot ${plugin.version}, VS Code ${vscode.version}.`,
      { code: 'INSTALL_SOURCE_VERSIONS_DIFFER', details: { checkout, nextAction: 'Use a source copy whose package.json, plugin/plugin.json and apps/vscode/package.json name the same version, such as a released one.' } }
    );
  }
  return { checkout, version: product.version, product, plugin, vscode };
}

/** The bundled CLI and its build/test leftovers are generated at packaging time, never source. */
function generatedBundle(relative) {
  const [first] = relative.split(path.sep);
  return first === 'bundle' || first.startsWith('bundle.building-') || first.startsWith('.bundle-test-');
}

function excludedSource(relative, entry) {
  const segments = relative.split(path.sep);
  if (segments.includes('.git') || segments.includes('node_modules')) return true;
  // SFlow's own runtime folder (agent results, test reports), written when a command runs in this
  // checkout, is never its source: nothing there is tracked or packed, and a reinstall preview
  // printed there must not change the digest its apply rechecks.
  if (segments[0] === '.sflow') return true;
  if (generatedBundle(relative)) return true;
  if (segments.includes('release') && segments.includes('apps') && segments.includes('vscode')) return true;
  if (entry.isFile() && (/\.tgz$/i.test(entry.name) || /\.vsix$/i.test(entry.name))) return true;
  return false;
}

async function sourceEntries(root, excludeSource, current = root, records = []) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute);
    if (excludeSource?.(relative) || excludedSource(relative, entry)) continue;
    if (entry.isDirectory()) {
      records.push({ type: 'directory', relative });
      await sourceEntries(root, excludeSource, absolute, records);
    } else if (entry.isSymbolicLink()) {
      records.push({ type: 'symlink', relative, target: await fs.promises.readlink(absolute) });
    } else if (entry.isFile()) {
      const info = await stat(absolute);
      records.push({ type: 'file', relative, mode: info.mode & 0o777, sha256: sha256(await readFile(absolute)) });
    }
  }
  return records;
}

export async function reinstallSourceDigest(checkout, { excludeSource } = {}) {
  return sha256(JSON.stringify(await sourceEntries(checkout, excludeSource)));
}

export function executeOrThrow(execute, command, args, options = {}) {
  const result = execute(command, args, { ...options, allowFailure: true });
  if (result.status !== 0) {
    // A step that ran out of time says which setting gives it more [limit audit, codeless limit errors]; any other failure
    // keeps its own output, under a code a plan can route.
    const timedOut = Boolean(result.timedOut) || result.error?.code === 'ETIMEDOUT';
    const setting = Number(options.timeoutMs) > PRODUCT_READ_TIMEOUT_MS ? 'SINGULARITY_FLOW_PRODUCT_MUTATION_TIMEOUT_MS' : 'SINGULARITY_FLOW_PRODUCT_READ_TIMEOUT_MS';
    throw new SingularityFlowError(timedOut
      ? `${command} ${args.join(' ')} did not finish within ${Math.round(Number(options.timeoutMs) / 1000) || 'its'} seconds. Run it again once the machine is less busy, or give it more time with ${setting} (milliseconds).`
      : `${command} ${args.join(' ')} failed: ${String(result.stderr || result.stdout || `exit ${result.status}`).trim()}`,
    { code: timedOut ? 'PRODUCT_COMMAND_TIMEOUT' : 'PRODUCT_COMMAND_FAILED', details: { command, ...(timedOut ? { timeoutMs: Number(options.timeoutMs) || null, setting } : { exitStatus: result.status ?? null }) } });
  }
  return result;
}

export function productTimeout(environment, name, fallback) {
  const value = Number(environment?.[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

export function configuredReinstallRegistry(execute, environment, cwd) {
  const result = execute('npm', ['config', 'get', 'registry'], {
    ...(cwd ? { cwd, env: environment } : {}),
    allowFailure: true,
    timeoutMs: productTimeout(environment, 'SINGULARITY_FLOW_PRODUCT_READ_TIMEOUT_MS', PRODUCT_READ_TIMEOUT_MS)
  });
  if (result.status !== 0 || result.timedOut || result.error) {
    throw new SingularityFlowError(
      `Could not read the configured npm registry: ${String(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`,
      { code: 'INSTALL_SOURCE_REGISTRY_UNREADABLE', details: { nextAction: 'Name the registry with --registry <address>, or fix npm here until npm config get registry prints it.' } }
    );
  }
  return normalizeReinstallRegistry(String(result.stdout ?? '').trim());
}

async function copyCheckout(checkout, target, excludeSource) {
  await cp(checkout, target, {
    recursive: true,
    preserveTimestamps: true,
    filter: (source) => {
      const relative = path.relative(checkout, source);
      if (!relative) return true;
      if (excludeSource?.(relative)) return false;
      const segments = relative.split(path.sep);
      if (segments.includes('.git') || segments.includes('node_modules')) return false;
      if (segments[0] === '.sflow') return false;
      if (generatedBundle(relative)) return false;
      if (segments.includes('release') && segments.includes('apps') && segments.includes('vscode')) return false;
      return !(/\.tgz$/i.test(path.basename(source)) || /\.vsix$/i.test(path.basename(source)));
    }
  });
}

async function findPackedFile(directory, suffix) {
  const entries = await readdir(directory);
  const match = entries.filter((entry) => entry.endsWith(suffix)).sort().at(-1);
  if (!match) {
    throw new SingularityFlowError(`Packaging did not create a ${suffix} artifact under ${directory}.`, { code: 'INSTALL_SOURCE_PACKAGE_MISSING',
      details: { directory, nextAction: 'Read the packaging output above for what went wrong, fix it in the source folder, then run the same command again.' } });
  }
  return path.join(directory, match);
}

export async function buildReinstallBundle({
  checkout,
  registry,
  cliOnly = false,
  skipTests = false,
  testScript = 'test:reinstall',
  sourceSha256 = null,
  excludeSource,
  execute = run,
  tempRoot = os.tmpdir(),
  log = console.log
}) {
  const stagingParent = await mkdtemp(path.join(tempRoot, 'singularity-flow-reinstall-build-'));
  const source = path.join(stagingParent, 'source');
  const artifacts = path.join(stagingParent, 'artifacts');
  const npmCache = path.join(stagingParent, 'npm-cache');
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  await mkdir(npmCache, { recursive: true, mode: 0o700 });
  await copyCheckout(checkout, source, excludeSource);
  const copiedSourceSha256 = await reinstallSourceDigest(source, { excludeSource });
  if (sourceSha256 && copiedSourceSha256 !== sourceSha256) {
    throw new SingularityFlowError(
      'The reinstall checkout changed while its isolated package source was being copied. Preview the reinstall again.',
      { code: 'INSTALL_SOURCE_CHANGED_WHILE_COPIED', details: { checkout, nextAction: 'Wait until nothing is changing files in the source folder (an editor, a build or a Git command), then run the same command again.' } }
    );
  }
  // Validation is isolated from the user's npm cache as well as the checkout. A preview may
  // download dependencies, but every temporary byte stays inside the content-addressed plan.
  const env = { ...process.env, NPM_CONFIG_REGISTRY: registry, NPM_CONFIG_CACHE: npmCache };
  log(`Building validated reinstall bundle under ${stagingParent}`);
  executeOrThrow(execute, 'npm', ['ci', ...(cliOnly ? ['--workspaces=false'] : []), `--registry=${registry}`], { cwd: source, env, stdio: 'inherit' });
  if (!cliOnly) {
    executeOrThrow(execute, 'npm', ['run', 'vscode:typecheck'], { cwd: source, env, stdio: 'inherit' });
  }
  // Source-only packaging can run on a machine without Git. It only needs tests for packaging
  // and recovery, while the full reinstall suite also exercises the normal Git-backed installer.
  if (skipTests) log('WARNING: safety tests skipped by request (--skip-tests). Build and artifact checks remain enabled.');
  else executeOrThrow(execute, 'npm', ['run', testScript], { cwd: source, env, stdio: 'inherit' });
  const buildInfoFile = path.join(source, 'src', 'build-info.mjs');
  const buildInfo = await lstat(buildInfoFile).catch(() => null);
  if (buildInfo) {
    if (!buildInfo.isFile() || buildInfo.isSymbolicLink()) {
      throw new SingularityFlowError(`The selected checkout does not contain a regular build-information module: ${buildInfoFile}`, { code: 'INSTALL_SOURCE_BUILD_INFO_NOT_A_FILE',
        details: { nextAction: `Make src/build-info.mjs in ${checkout} an ordinary file (not a link), or delete it, then run the same command again.` } });
    }
    // Reinstall intentionally runs no Git command. Its pre-existing source digest is stronger than
    // a guessed commit: it identifies the exact validated bytes that were copied into this isolated
    // package source, including legitimate local changes.
    await stampBuildInfoFile(buildInfoFile, {
      commit: null,
      sourceSha256: copiedSourceSha256,
      branch: null,
      dirty: null,
      builtAt: new Date().toISOString()
    });
  }
  // The bundled CLI belongs to this exact stamp (scripts/build-cli-bundle.mjs). Without it the
  // installed CLI still works, from src/, so a failed build only costs speed.
  const bundleBuilder = path.join(source, 'scripts', 'build-cli-bundle.mjs');
  if (await lstat(bundleBuilder).catch(() => null)) {
    const built = execute(process.execPath, [bundleBuilder], { cwd: source, env, stdio: 'inherit', allowFailure: true });
    if (built?.status !== 0) log('Warning: the bundled CLI could not be built; the installed CLI will run from its sources.');
  }
  executeOrThrow(execute, 'npm', ['pack', '--pack-destination', artifacts, `--registry=${registry}`], { cwd: source, env, stdio: 'inherit' });
  const tarball = await findPackedFile(artifacts, '.tgz');
  let vsix = null;
  if (!cliOnly) {
    // The isolated source intentionally has no .git. Seal every static CLI/extension input after
    // validation and build-info stamping, then let the VSIX packager re-admit only those exact
    // bytes plus its fixed generated-output roots. The manifest lives outside the package root.
    const vsixSourceManifest = await writeVsixSourceManifest({
      rootDir: source,
      targetFile: path.join(stagingParent, 'vsix-source-manifest.json'),
      sourceSha256: copiedSourceSha256
    });
    const vsixEnvironment = {
      ...env,
      [VSIX_SOURCE_MANIFEST_ENV]: vsixSourceManifest.path,
      [VSIX_SOURCE_MANIFEST_SHA256_ENV]: vsixSourceManifest.sha256
    };
    try {
      executeOrThrow(execute, 'npm', ['run', 'vscode:package'], {
        cwd: source, env: vsixEnvironment, stdio: 'inherit'
      });
    } finally {
      await rm(vsixSourceManifest.path, { force: true });
    }
    const packaged = await findPackedFile(path.join(source, 'apps', 'vscode'), '.vsix');
    vsix = path.join(artifacts, path.basename(packaged));
    await fs.promises.copyFile(packaged, vsix);
  }
  return { stagingParent, source, artifacts, tarball, vsix };
}
