import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stampBuildInfoFile } from './build-info-stamp.mjs';
import {
  installDirectSkills, isManagedDirectSkill, uninstallDirectSkills
} from './direct-skills.mjs';
import { commandExists, run, SingularityFlowError } from './util.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { copilotSkillForCommand } from './copilot-guidance.mjs';
import {
  renderCommandPromptCommand, renderPlatformCommand
} from './safe-command-guidance.mjs';
import { verifyPluginInstallation } from './plugin.mjs';
import { inspectDistributionBundle } from './distribution-bundle.mjs';
import { readSecurePublicKey } from './secure-private-key.mjs';
import {
  acquireActivationLease, inspectNpmTarball, inspectVsix, releaseActivationLease
} from '../scripts/install-staged-artifacts.mjs';
import {
  VSIX_SOURCE_MANIFEST_ENV,
  VSIX_SOURCE_MANIFEST_SHA256_ENV,
  writeVsixSourceManifest
} from './vsix-source-manifest.mjs';

export const REINSTALL_SURFACES = Object.freeze({
  npmPackage: 'singularity-flow',
  copilotPlugins: Object.freeze(['singularity-flow', 'singularity-flow@singularity-flow']),
  directSkillPrefix: 'sf-',
  vscodeExtension: 'singularityflow.singularity-flow-vscode',
  telemetryWrapper: '.singularity-flow/copilot-otel.sh'
});

const CONFIRMATION_PREFIX = 'REINSTALL SINGULARITY FLOW ';
const PLAN_SCHEMA_VERSION = currentSchemaVersion('reinstall-plan');
const MANAGED_TELEMETRY_MARKER = '# Managed by the Singularity Flow installer.';
const MINIMUM_NODE_MAJOR = 20;
const PRODUCT_READ_TIMEOUT_MS = 30_000;
const PRODUCT_MUTATION_TIMEOUT_MS = 300_000;
const TELEMETRY_PROFILE_COMMENT = '# Singularity Flow: Copilot model/token/cost telemetry';
const TELEMETRY_PROFILE_SOURCE = '[ -r "$HOME/.singularity-flow/copilot-otel.sh" ] && . "$HOME/.singularity-flow/copilot-otel.sh"';
const RETAINED_ARTIFACT_NAMES = Object.freeze({
  tarball: 'singularity-flow.tgz',
  vsix: 'singularity-flow.vsix'
});
const SHA256_HEX = /^[a-f0-9]{64}$/u;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Refuse an unsupported runtime before the isolated reinstall build starts. */
export function assertReinstallNodeVersion(version = process.versions.node) {
  const normalized = String(version ?? '').trim();
  const match = normalized.match(/^v?(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  const major = match ? Number(match[1]) : null;
  if (!Number.isInteger(major)) {
    throw new SingularityFlowError(`Could not determine the Node.js version from '${normalized || 'unknown'}'.`);
  }
  if (major < MINIMUM_NODE_MAJOR) {
    throw new SingularityFlowError(
      `Node.js ${MINIMUM_NODE_MAJOR} or newer is required; found ${normalized}.`
    );
  }
  return { version: normalized.replace(/^v/, ''), major };
}

export function normalizeReinstallRegistry(value) {
  let registry;
  try { registry = new URL(String(value)); }
  catch { throw new SingularityFlowError(`Invalid npm registry URL: ${value}`); }
  if (!['http:', 'https:'].includes(registry.protocol)) {
    throw new SingularityFlowError('The npm registry must use http:// or https://.');
  }
  if (registry.username || registry.password) {
    throw new SingularityFlowError('Do not place registry credentials in the URL; configure authentication in .npmrc.');
  }
  if (registry.search || registry.hash) {
    throw new SingularityFlowError('The npm registry URL cannot contain a query string or fragment.');
  }
  if (!registry.pathname.endsWith('/')) registry.pathname += '/';
  return registry.toString();
}

async function regularFile(file, label) {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new SingularityFlowError(`The selected checkout does not contain a regular ${label}: ${file}`);
  }
}

export async function validateReinstallCheckout(requestedCheckout) {
  const requested = path.resolve(requestedCheckout);
  const checkout = await realpath(requested).catch(() => requested);
  const info = await lstat(checkout).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new SingularityFlowError(`Reinstall requires a Singularity Flow source checkout directory: ${checkout}`);
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
    throw new SingularityFlowError(`Unable to read the checkout manifests: ${error.message}`);
  }
  if (product.name !== REINSTALL_SURFACES.npmPackage) {
    throw new SingularityFlowError(`The selected checkout is not the Singularity Flow package: ${checkout}`);
  }
  if (plugin.name !== 'singularity-flow' || vscode.publisher !== 'singularityflow' || vscode.name !== 'singularity-flow-vscode') {
    throw new SingularityFlowError(`The selected checkout does not contain the expected Copilot plugin and VS Code extension: ${checkout}`);
  }
  if (product.version !== plugin.version || product.version !== vscode.version) {
    throw new SingularityFlowError(
      `Product versions do not match: npm ${product.version}, Copilot ${plugin.version}, VS Code ${vscode.version}.`
    );
  }
  return { checkout, version: product.version, product, plugin, vscode };
}

function excludedSource(relative, entry) {
  const segments = relative.split(path.sep);
  if (segments.includes('.git') || segments.includes('node_modules')) return true;
  if (segments.includes('release') && segments.includes('apps') && segments.includes('vscode')) return true;
  if (entry.isFile() && (/\.tgz$/i.test(entry.name) || /\.vsix$/i.test(entry.name))) return true;
  return false;
}

async function sourceEntries(root, current = root, records = []) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute);
    if (excludedSource(relative, entry)) continue;
    if (entry.isDirectory()) {
      records.push({ type: 'directory', relative });
      await sourceEntries(root, absolute, records);
    } else if (entry.isSymbolicLink()) {
      records.push({ type: 'symlink', relative, target: await fs.promises.readlink(absolute) });
    } else if (entry.isFile()) {
      const info = await stat(absolute);
      records.push({ type: 'file', relative, mode: info.mode & 0o777, sha256: sha256(await readFile(absolute)) });
    }
  }
  return records;
}

export async function reinstallSourceDigest(checkout) {
  return sha256(JSON.stringify(await sourceEntries(checkout)));
}

function executeOrThrow(execute, command, args, options = {}) {
  const result = execute(command, args, { ...options, allowFailure: true });
  if (result.status !== 0) {
    throw new SingularityFlowError(
      `${command} ${args.join(' ')} failed: ${String(result.stderr || result.stdout || `exit ${result.status}`).trim()}`
    );
  }
  return result;
}

async function packageCliBuild(buildRequest) {
  const { expectedVersion, execute, environment, label } = buildRequest;
  const executable = path.join(buildRequest.packageRoot, 'bin', 'singularity-flow.mjs');
  await regularFile(executable, `${label} bin/singularity-flow.mjs`);
  const result = executeOrThrow(execute, process.execPath, [executable, '--build'], {
    env: environment,
    timeoutMs: productTimeout(
      environment, 'SINGULARITY_FLOW_PRODUCT_READ_TIMEOUT_MS', PRODUCT_READ_TIMEOUT_MS
    )
  });
  const build = String(result.stdout ?? '').trim();
  if (!build.startsWith(`${expectedVersion} (`) || !build.endsWith(')') || /[\r\n]/u.test(build)
      || /development checkout|not a stamped package/iu.test(build)) {
    throw new SingularityFlowError(
      `The ${label} CLI returned an invalid build identity: ${build || 'unavailable'}.`
    );
  }
  return build;
}

async function admittedCliBuild(plan, candidateSource, execute, environment) {
  return packageCliBuild({
    packageRoot: candidateSource,
    expectedVersion: plan.version,
    execute,
    environment,
    label: 'admitted candidate'
  });
}

function liveCliBuild(execute, environment, expectedVersion, label = 'installed') {
  const result = executeOrThrow(execute, 'singularity-flow', ['--build'], {
    env: environment,
    timeoutMs: productTimeout(
      environment, 'SINGULARITY_FLOW_PRODUCT_READ_TIMEOUT_MS', PRODUCT_READ_TIMEOUT_MS
    )
  });
  const build = String(result.stdout ?? '').trim();
  if (!build.startsWith(`${expectedVersion} (`) || !build.endsWith(')') || /[\r\n]/u.test(build)
      || /development checkout|not a stamped package/iu.test(build)) {
    throw new SingularityFlowError(
      `The ${label} CLI returned an invalid build identity: ${build || 'unavailable'}.`
    );
  }
  return build;
}

function productTimeout(environment, name, fallback) {
  const value = Number(environment?.[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function configuredRegistry(execute, environment) {
  const result = execute('npm', ['config', 'get', 'registry'], {
    allowFailure: true,
    timeoutMs: productTimeout(environment, 'SINGULARITY_FLOW_PRODUCT_READ_TIMEOUT_MS', PRODUCT_READ_TIMEOUT_MS)
  });
  if (result.status !== 0 || result.timedOut || result.error) {
    throw new SingularityFlowError(
      `Could not read the configured npm registry: ${String(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`
    );
  }
  return normalizeReinstallRegistry(String(result.stdout ?? '').trim());
}

function installedNpmVersion(execute, { strict, environment }) {
  const result = execute('npm', [
    'list', '--global', REINSTALL_SURFACES.npmPackage, '--depth=0', '--json'
  ], {
    allowFailure: true,
    timeoutMs: productTimeout(environment, 'SINGULARITY_FLOW_PRODUCT_READ_TIMEOUT_MS', PRODUCT_READ_TIMEOUT_MS)
  });
  let parsed;
  try { parsed = JSON.parse(result.stdout || '{}'); }
  catch {
    if (strict) {
      throw new SingularityFlowError(
        `Could not inspect the installed npm package: ${String(result.stderr || result.error?.message || 'invalid npm output').trim()}`
      );
    }
    return null;
  }
  const version = parsed?.dependencies?.[REINSTALL_SURFACES.npmPackage]?.version ?? null;
  const expectedAbsent = result.status === 1 && version === null && !parsed?.error
    && !result.timedOut && !result.error && !result.blocked;
  if (strict && result.status !== 0 && !expectedAbsent) {
    throw new SingularityFlowError(
      `npm reported an inconsistent installed-package inventory: ${String(result.stderr || `exit ${result.status}`).trim()}`
    );
  }
  if (strict && (result.timedOut || result.error || result.blocked)) {
    throw new SingularityFlowError('The installed npm package inventory was unavailable or timed out.');
  }
  // npm list exits 1 for a well-formed JSON result when the named package is absent. That is an
  // observed absence, not an inventory failure.
  return version;
}

function managedDirectSkillInventory({ targetRoot, strict = false }) {
  let entries;
  try { entries = fs.readdirSync(targetRoot, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    if (strict) {
      throw new SingularityFlowError(
        `Could not inspect managed direct skills under ${targetRoot}: ${error.message}`
      );
    }
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(REINSTALL_SURFACES.directSkillPrefix))
    .filter((entry) => {
      try { return isManagedDirectSkill(fs.readFileSync(path.join(targetRoot, entry.name, 'SKILL.md'), 'utf8')); }
      catch { return false; }
    })
    .map((entry) => entry.name)
    .sort();
}

function telemetryProfileCandidates(homeDirectory, environment) {
  const result = new Set([
    path.join(homeDirectory, '.zshrc'),
    path.join(homeDirectory, '.bashrc'),
    path.join(homeDirectory, '.bash_profile')
  ]);
  if (environment.ZDOTDIR) result.add(path.resolve(environment.ZDOTDIR, '.zshrc'));
  return [...result];
}

function managedTelemetryProfiles({ homeDirectory, environment, strict = false }) {
  const result = [];
  for (const file of telemetryProfileCandidates(homeDirectory, environment)) {
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) {
        if (strict) throw new SingularityFlowError(`Shell profile is not an ordinary file: ${file}`);
        continue;
      }
      const contents = fs.readFileSync(file, 'utf8');
      if (contents.split(/\r?\n/u).includes(TELEMETRY_PROFILE_SOURCE)) result.push(file);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      if (strict || error instanceof SingularityFlowError) throw error;
    }
  }
  return result.sort();
}

function installedCopilotPluginIdentities(output) {
  const configured = new Set(REINSTALL_SURFACES.copilotPlugins);
  return String(output || '').split(/\r?\n/).map((line) => line
    .replace(/^[\s*\-•]+/, '')
    .replace(/\s+\(v[^)]*\)\s*$/, '')
    .trim())
    .filter((identity) => configured.has(identity));
}

export function inspectLocalProduct({
  execute = run,
  exists = commandExists,
  homeDirectory = os.homedir(),
  environment = process.env,
  strict = false
} = {}) {
  const skillsRoot = path.resolve(
    environment.SINGULARITY_FLOW_COPILOT_SKILLS_DIR
      || path.join(environment.COPILOT_HOME || path.join(homeDirectory, '.copilot'), 'skills')
  );
  const copilotAvailable = exists('copilot');
  const codeAvailable = exists('code');
  const readTimeout = productTimeout(
    environment, 'SINGULARITY_FLOW_PRODUCT_READ_TIMEOUT_MS', PRODUCT_READ_TIMEOUT_MS
  );
  const pluginResult = copilotAvailable
    ? execute('copilot', ['plugin', 'list'], { allowFailure: true, timeoutMs: readTimeout })
    : null;
  const extensionResult = codeAvailable
    ? execute('code', ['--list-extensions', '--show-versions'], { allowFailure: true, timeoutMs: readTimeout })
    : null;
  if (strict && pluginResult && pluginResult.status !== 0) {
    throw new SingularityFlowError(
      `Could not inspect installed Copilot plugins: ${String(pluginResult.stderr || pluginResult.error?.message || `exit ${pluginResult.status}`).trim()}`
    );
  }
  if (strict && extensionResult && extensionResult.status !== 0) {
    throw new SingularityFlowError(
      `Could not inspect installed VS Code extensions: ${String(extensionResult.stderr || extensionResult.error?.message || `exit ${extensionResult.status}`).trim()}`
    );
  }
  const plugins = pluginResult?.stdout ?? '';
  const extensions = extensionResult?.stdout ?? '';
  const extensionLine = extensions.split(/\r?\n/).find((line) => line.toLowerCase().startsWith(`${REINSTALL_SURFACES.vscodeExtension}@`));
  const telemetryProfiles = managedTelemetryProfiles({ homeDirectory, environment, strict });
  return {
    npmVersion: installedNpmVersion(execute, { strict, environment }),
    copilotAvailable,
    codeAvailable,
    copilotPlugins: installedCopilotPluginIdentities(plugins),
    vscodeVersion: extensionLine?.split('@').at(-1) ?? null,
    skillsRoot,
    managedDirectSkills: managedDirectSkillInventory({ targetRoot: skillsRoot, strict }),
    telemetryWrapper: path.join(homeDirectory, REINSTALL_SURFACES.telemetryWrapper),
    telemetryManaged: (() => {
      const file = path.join(homeDirectory, REINSTALL_SURFACES.telemetryWrapper);
      try {
        const info = fs.lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink()) {
          if (strict) throw new SingularityFlowError(`Telemetry helper is not an ordinary file: ${file}`);
          return false;
        }
        return fs.readFileSync(file, 'utf8').startsWith(MANAGED_TELEMETRY_MARKER);
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        if (strict || error instanceof SingularityFlowError) throw error;
        return false;
      }
    })(),
    managedTelemetryProfiles: telemetryProfiles,
    telemetryProfileManaged: telemetryProfiles.length > 0
  };
}

function planCacheRoot(tempRoot = os.tmpdir()) {
  return path.join(tempRoot, 'singularity-flow-reinstall-plans');
}

async function copyCheckout(checkout, target) {
  await cp(checkout, target, {
    recursive: true,
    preserveTimestamps: true,
    filter: (source) => {
      const relative = path.relative(checkout, source);
      if (!relative) return true;
      const segments = relative.split(path.sep);
      if (segments.includes('.git') || segments.includes('node_modules')) return false;
      if (segments.includes('release') && segments.includes('apps') && segments.includes('vscode')) return false;
      return !(/\.tgz$/i.test(path.basename(source)) || /\.vsix$/i.test(path.basename(source)));
    }
  });
}

async function findPackedFile(directory, suffix) {
  const entries = await readdir(directory);
  const match = entries.filter((entry) => entry.endsWith(suffix)).sort().at(-1);
  if (!match) throw new SingularityFlowError(`Packaging did not create a ${suffix} artifact under ${directory}.`);
  return path.join(directory, match);
}

export async function buildReinstallBundle({
  checkout,
  registry,
  cliOnly = false,
  sourceSha256 = null,
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
  await copyCheckout(checkout, source);
  const copiedSourceSha256 = await reinstallSourceDigest(source);
  if (sourceSha256 && copiedSourceSha256 !== sourceSha256) {
    throw new SingularityFlowError(
      'The reinstall checkout changed while its isolated package source was being copied. Preview the reinstall again.'
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
  // The product reinstall contract forbids Git access. The full project test/check
  // commands inspect Git metadata, so this transaction runs a focused safety suite
  // that covers its package, plugin, and direct-skill surfaces without invoking Git.
  executeOrThrow(execute, 'npm', ['run', 'test:reinstall'], { cwd: source, env, stdio: 'inherit' });
  const buildInfoFile = path.join(source, 'src', 'build-info.mjs');
  const buildInfo = await lstat(buildInfoFile).catch(() => null);
  if (buildInfo) {
    if (!buildInfo.isFile() || buildInfo.isSymbolicLink()) {
      throw new SingularityFlowError(`The selected checkout does not contain a regular build-information module: ${buildInfoFile}`);
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

function reinstallFingerprint({ checkout, version, tarballSha256, vsixSha256 }) {
  return sha256(JSON.stringify({ checkout, version, tarballSha256, vsixSha256 })).slice(0, 16);
}

function distributionInstallFingerprint({
  directory, artifactKeyPath, entrypoint, version, releaseSha256, sumsSha256, receiptSha256, signerKeySha256,
  tarballSha256, vsixSha256, rollbackTarballSha256, rollbackVsixSha256, rollbackPackageSha256,
  rollbackCliBuild, registry, cliOnly, telemetry, installed
}) {
  return sha256(JSON.stringify({
    directory, artifactKeyPath, entrypoint: entrypoint ? path.resolve(entrypoint) : null,
    version, releaseSha256, sumsSha256, receiptSha256, signerKeySha256,
    tarballSha256, vsixSha256, rollbackTarballSha256: rollbackTarballSha256 ?? null,
    rollbackVsixSha256: rollbackVsixSha256 ?? null,
    rollbackPackageSha256: rollbackPackageSha256 ?? null,
    rollbackCliBuild: rollbackCliBuild ?? null,
    registry, cliOnly: Boolean(cliOnly),
    telemetry: Boolean(telemetry), installed: comparableInstalledState(installed)
  })).slice(0, 16);
}

function comparableInstalledState(value) {
  return {
    npmVersion: value?.npmVersion ?? null,
    copilotAvailable: Boolean(value?.copilotAvailable),
    codeAvailable: Boolean(value?.codeAvailable),
    copilotPlugins: [...(value?.copilotPlugins ?? [])],
    vscodeVersion: value?.vscodeVersion ?? null,
    skillsRoot: path.resolve(String(value?.skillsRoot ?? '')),
    managedDirectSkills: [...(value?.managedDirectSkills ?? [])],
    telemetryWrapper: path.resolve(String(value?.telemetryWrapper ?? '')),
    telemetryManaged: Boolean(value?.telemetryManaged),
    managedTelemetryProfiles: [...(value?.managedTelemetryProfiles ?? [])]
      .map((entry) => path.resolve(entry)).sort(),
    telemetryProfileManaged: Boolean(value?.telemetryProfileManaged)
  };
}

function distributionOriginPath(environment, name, fallback) {
  if (environment?.SINGULARITY_FLOW_DISTRIBUTION_BOOTSTRAPPED !== '1') return fallback;
  const value = String(environment?.[name] ?? '').trim();
  return value && path.isAbsolute(value) ? path.resolve(value) : fallback;
}

async function fileHash(file) {
  return file ? sha256(await readFile(file)) : null;
}

async function packageTreeSha256(root) {
  const base = path.resolve(String(root ?? ''));
  const rootInfo = await lstat(base).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new SingularityFlowError(`Rollback package is not a regular, non-symlink directory: ${base}`);
  }
  const records = [];
  const visit = async (directory) => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(base, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        throw new SingularityFlowError(`Rollback package contains a symbolic link: ${relative}`);
      }
      if (entry.isDirectory()) {
        records.push({ path: `${relative}/`, type: 'directory' });
        await visit(absolute);
      } else if (entry.isFile()) {
        const info = await lstat(absolute);
        records.push({
          path: relative,
          type: 'file',
          size: info.size,
          sha256: `sha256:${await fileHash(absolute)}`
        });
      } else {
        throw new SingularityFlowError(`Rollback package contains an unsupported entry: ${relative}`);
      }
    }
  };
  await visit(base);
  return `sha256:${sha256(JSON.stringify(records))}`;
}

async function stageDistributionPackage({
  tarball, directory, registry, execute, environment, prefixName = 'candidate-package'
}) {
  const prefix = path.join(directory, prefixName);
  await mkdir(prefix, { mode: 0o700 });
  executeOrThrow(execute, 'npm', [
    'install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--offline',
    tarball, `--registry=${registry}`
  ], {
    env: { ...environment, NPM_CONFIG_REGISTRY: registry },
    timeoutMs: Number(environment.SINGULARITY_FLOW_PRODUCT_MUTATION_TIMEOUT_MS || 300_000)
  });
  const stagedPackageRoot = path.join(prefix, 'node_modules', REINSTALL_SURFACES.npmPackage);
  const manifestFile = path.join(stagedPackageRoot, 'package.json');
  const pluginFile = path.join(stagedPackageRoot, 'plugin', 'plugin.json');
  await Promise.all([
    regularFile(manifestFile, 'staged distribution package.json'),
    regularFile(pluginFile, 'staged distribution plugin/plugin.json')
  ]);
  const [manifest, plugin] = await Promise.all([
    readFile(manifestFile, 'utf8').then(JSON.parse),
    readFile(pluginFile, 'utf8').then(JSON.parse)
  ]);
  if (manifest.name !== REINSTALL_SURFACES.npmPackage || plugin.name !== 'singularity-flow'
      || manifest.version !== plugin.version) {
    throw new SingularityFlowError('The privately staged distribution package or Copilot plugin identity is invalid.');
  }
  return stagedPackageRoot;
}

async function persistPlan(plan, tempRoot) {
  const parent = planCacheRoot(tempRoot);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const target = path.join(parent, plan.fingerprint);
  const cached = await access(target).then(() => true).catch(() => false);
  if (cached) {
    // The content-addressed plan already exists. Discard only the new OS-temporary
    // staging directory; no repository or user-data path can reach this branch.
    await rm(plan.bundle.stagingParent, { recursive: true, force: true });
  } else {
    await rename(plan.bundle.stagingParent, target);
  }
  const normalized = {
    ...plan,
    bundle: {
      stagingParent: target,
      source: path.join(target, 'source'),
      artifacts: path.join(target, 'artifacts'),
      tarball: path.join(target, 'artifacts', path.basename(plan.bundle.tarball)),
      vsix: plan.bundle.vsix ? path.join(target, 'artifacts', path.basename(plan.bundle.vsix)) : null
    }
  };
  await writeFile(path.join(target, 'reinstall-plan.json'), `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}

async function persistDistributionPlan(plan, tempRoot) {
  const root = planCacheRoot(tempRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const parent = await managedInstallDirectory(root, 'Distribution install plan cache');
  const target = path.join(parent, plan.fingerprint);
  const normalized = {
    ...plan,
    distribution: {
      ...plan.distribution,
      planCacheRoot: parent,
      rollback: plan.distribution.rollback ? {
        ...plan.distribution.rollback,
        tarball: plan.distribution.rollback.tarball
          ? path.join(target, path.basename(plan.distribution.rollback.tarball)) : null,
        vsix: plan.distribution.rollback.vsix
          ? path.join(target, path.basename(plan.distribution.rollback.vsix)) : null,
        package: plan.distribution.rollback.package
          ? path.join(target, path.relative(
            plan.bundle.stagingParent, plan.distribution.rollback.package
          )) : null
      } : null
    },
    bundle: {
      stagingParent: target,
      source: plan.bundle.source
        ? path.join(target, path.relative(plan.bundle.stagingParent, plan.bundle.source))
        : null,
      artifacts: target,
      tarball: path.join(target, path.basename(plan.bundle.tarball)),
      vsix: path.join(target, path.basename(plan.bundle.vsix))
    }
  };
  let created = false;
  try {
    await rename(plan.bundle.stagingParent, target);
    created = true;
    const file = path.join(target, 'reinstall-plan.json');
    await writeFile(file, `${JSON.stringify(normalized, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await chmod(file, 0o600);
    return normalized;
  } catch (error) {
    const existingTarget = !created
      ? await lstat(target).catch((failure) => {
        if (failure?.code === 'ENOENT') return null;
        throw failure;
      }) : null;
    if (!created && existingTarget?.isDirectory() && !existingTarget.isSymbolicLink()) {
      await rm(plan.bundle.stagingParent, { recursive: true, force: true });
      const cached = await loadCachedPlan(plan.fingerprint, tempRoot);
      if (cached && JSON.stringify({ ...cached, createdAt: null })
          === JSON.stringify({ ...normalized, createdAt: null })) return validatePreparedPlan(cached);
      throw new SingularityFlowError(
        'A conflicting distribution install plan already uses this fingerprint. Remove only the reported plan cache after review and preview again.'
      );
    }
    if (created) await rm(target, { recursive: true, force: true });
    else await rm(plan.bundle.stagingParent, { recursive: true, force: true });
    throw error;
  }
}

export async function prepareLocalReinstall({
  checkout: requestedCheckout,
  registry,
  cliOnly = false,
  telemetry = true,
  execute = run,
  exists = commandExists,
  homeDirectory = os.homedir(),
  environment = process.env,
  tempRoot = os.tmpdir(),
  build = buildReinstallBundle,
  log = console.log
}) {
  assertReinstallNodeVersion();
  const validated = await validateReinstallCheckout(requestedCheckout);
  if (!exists('npm') || !exists('node')) throw new SingularityFlowError('Reinstall requires the existing node and npm commands on PATH.');
  if (!cliOnly && !exists('copilot')) {
    throw new SingularityFlowError('Copilot CLI was not found. Install it first, or use --cli-only to replace only the Node CLI.');
  }
  const effectiveRegistry = registry
    ? normalizeReinstallRegistry(registry)
    : configuredRegistry(execute, environment);
  const installed = inspectLocalProduct({ execute, exists, homeDirectory, environment, strict: true });
  await assertCliOnlyVsixRollbackAuthority({
    cliOnly, installed, homeDirectory, checkout: validated.checkout
  });
  const sourceSha256 = await reinstallSourceDigest(validated.checkout);
  const bundle = await build({
    checkout: validated.checkout,
    registry: effectiveRegistry,
    cliOnly,
    sourceSha256,
    execute,
    tempRoot,
    log
  });
  const tarballSha256 = await fileHash(bundle.tarball);
  const vsixSha256 = await fileHash(bundle.vsix);
  const fingerprint = reinstallFingerprint({ checkout: validated.checkout, version: validated.version, tarballSha256, vsixSha256 });
  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    operation: 'local-product-reinstall',
    completed: false,
    checkout: validated.checkout,
    version: validated.version,
    sourceSha256,
    registry: effectiveRegistry,
    cliOnly,
    telemetry,
    fingerprint,
    confirmation: `${CONFIRMATION_PREFIX}${fingerprint}`,
    createdAt: new Date().toISOString(),
    installed,
    artifacts: {
      tarball: path.basename(bundle.tarball), tarballSha256,
      vsix: bundle.vsix ? path.basename(bundle.vsix) : null, vsixSha256
    },
    remove: [
      'global npm package singularity-flow in place, including its npm-created command shims',
      ...(cliOnly ? [] : [
        `Copilot plugin identities: ${REINSTALL_SURFACES.copilotPlugins.join(', ')}`,
        'managed direct /sf-* skills carrying the Singularity Flow ownership marker',
        `VS Code extension ${REINSTALL_SURFACES.vscodeExtension}${installed.codeAvailable ? '' : ' (code CLI unavailable; skipped)'}`,
        'installer-managed sflow_copilot compatibility helper (never the user\'s copilot command)'
      ])
    ],
    preserve: [
      'all Git repositories, worktrees, branches, commits, remotes, and working trees',
      'all repository singularity/, .singularity/, and .git/singularity-flow/ data',
      'workspace directories, repository clones, and ~/.singularity-flow workspace selection',
      'VS Code settings, global state, SecretStorage, and Jira credentials',
      'personal Copilot skills without the managed marker',
      'Node.js, npm, npm cache, and unrelated global packages'
    ],
    bundle
  };
  return persistPlan(plan, tempRoot);
}

/** Prepare an install directly from one promoted release directory; no Git checkout is required. */
export async function prepareDistributionInstall({
  releaseDirectory,
  artifactKey,
  registry,
  cliOnly = false,
  telemetry = true,
  execute = run,
  exists = commandExists,
  homeDirectory = os.homedir(),
  environment = process.env,
  tempRoot = os.tmpdir()
}) {
  assertReinstallNodeVersion();
  const interrupted = await loadDistributionTransaction({ homeDirectory, environment });
  if (interrupted) {
    throw new SingularityFlowError(
      `A prior distribution install transaction requires recovery: ${interrupted.pending}. `
      + 'Run this installer once without --dry-run before creating another preview. '
      + 'The retained transaction will restore and verify the previous installation first.'
    );
  }
  if (!exists('npm') || !exists('node')) {
    throw new SingularityFlowError('Distribution installation requires Node.js and npm on PATH.');
  }
  if (!cliOnly && !exists('copilot')) {
    throw new SingularityFlowError(
      'Copilot CLI was not found. Install it first, or pass --cli-only to install only the Node CLI.'
    );
  }
  if (!cliOnly && !exists('code')) {
    throw new SingularityFlowError(
      'VS Code CLI was not found. Install VS Code and expose its code command, or pass --cli-only for a terminal-only install.'
    );
  }
  const key = await readSecurePublicKey(artifactKey, {
    repository: releaseDirectory,
    label: 'Trusted artifact-builder public key'
  });
  const distribution = await inspectDistributionBundle(releaseDirectory, {
    trustedPublicKeyPem: key.bytes,
    snapshot: true,
    tempRoot
  });
  let persisted = false;
  try {
  // A trusted distribution bootstrap supplies only private snapshot paths as operative inputs.
  // Original paths remain provenance for stable preview/recovery identity and are never reopened.
  const originDirectory = distributionOriginPath(
    environment, 'SINGULARITY_FLOW_DISTRIBUTION_ORIGIN_RELEASE_DIR', distribution.directory
  );
  const originKeyPath = distributionOriginPath(
    environment, 'SINGULARITY_FLOW_DISTRIBUTION_ORIGIN_ARTIFACT_KEY', key.path
  );
  const effectiveRegistry = registry
    ? normalizeReinstallRegistry(registry)
    : configuredRegistry(execute, environment);
  const installed = inspectLocalProduct({ execute, exists, homeDirectory, environment, strict: true });
  await assertCliOnlyVsixRollbackAuthority({
    cliOnly, installed, homeDirectory, checkout: distribution.directory
  });
  const prior = await distributionRollbackAuthority({
    installed, homeDirectory, checkout: distribution.directory
  });
  const tarballSha256 = distribution.tarball.sha256.replace(/^sha256:/u, '');
  const vsixSha256 = distribution.vsix.sha256.replace(/^sha256:/u, '');
  const priorTarball = prior.tarball
    ? path.join(distribution.snapshotDirectory, 'rollback-singularity-flow.tgz') : null;
  const priorVsix = prior.vsix
    ? path.join(distribution.snapshotDirectory, 'rollback-singularity-flow.vsix') : null;
  if (priorTarball) {
    await fs.promises.copyFile(prior.tarball.path, priorTarball, fs.constants.COPYFILE_EXCL);
    if (await fileHash(priorTarball) !== prior.tarball.sha256.replace(/^sha256:/u, '')) {
      throw new SingularityFlowError('The retained CLI rollback artifact changed while it was snapshotted.');
    }
  }
  if (priorVsix) {
    await fs.promises.copyFile(prior.vsix.path, priorVsix, fs.constants.COPYFILE_EXCL);
    if (await fileHash(priorVsix) !== prior.vsix.sha256.replace(/^sha256:/u, '')) {
      throw new SingularityFlowError('The retained VS Code rollback artifact changed while it was snapshotted.');
    }
  }
  // Every distribution mode needs a privately staged executable so activation can compare the
  // exact candidate build identity with the command that becomes reachable on PATH. A matching
  // semantic version is deliberately insufficient because release builds keep that version stable.
  const stagedPackage = await stageDistributionPackage({
    tarball: distribution.tarball.path,
    directory: distribution.snapshotDirectory,
    registry: effectiveRegistry,
    execute,
    environment
  });
  // Stage the retained package for every installed CLI, including CLI-only upgrades. Its exact
  // executable build identity—not just its semver and archive digest—must reproduce the live CLI
  // before any installed surface is touched.
  const priorPackage = priorTarball ? await stageDistributionPackage({
      tarball: priorTarball,
      directory: distribution.snapshotDirectory,
      registry: effectiveRegistry,
      execute,
      environment,
      prefixName: 'rollback-package'
    }) : null;
  const priorPackageSha256 = priorPackage ? await packageTreeSha256(priorPackage) : null;
  const priorCliBuild = priorPackage ? await packageCliBuild({
    packageRoot: priorPackage,
    expectedVersion: installed.npmVersion,
    execute,
    environment,
    label: 'retained rollback'
  }) : null;
  if (priorCliBuild) {
    const observedCliBuild = liveCliBuild(
      execute, environment, installed.npmVersion, 'currently installed'
    );
    if (observedCliBuild !== priorCliBuild) {
      throw new SingularityFlowError(
        `The retained CLI rollback package reports build '${priorCliBuild}', but the currently `
        + `installed CLI reports '${observedCliBuild}'. Run one full source install to refresh `
        + 'the retained rollback authority before applying this distribution. No product surface was changed.'
      );
    }
  }
  const fingerprint = distributionInstallFingerprint({
    directory: originDirectory,
    artifactKeyPath: originKeyPath,
    entrypoint: environment.SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT,
    version: distribution.version,
    releaseSha256: distribution.releaseSha256,
    sumsSha256: distribution.sumsSha256,
    receiptSha256: distribution.receiptSha256,
    signerKeySha256: distribution.artifactAuthority.signerKeySha256,
    tarballSha256,
    vsixSha256,
    rollbackTarballSha256: prior.tarball?.sha256 ?? null,
    rollbackVsixSha256: prior.vsix?.sha256 ?? null,
    rollbackPackageSha256: priorPackageSha256,
    rollbackCliBuild: priorCliBuild,
    registry: effectiveRegistry,
    cliOnly,
    telemetry,
    installed
  });
  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    operation: 'distribution-product-install',
    completed: false,
    checkout: originDirectory,
    version: distribution.version,
    sourceSha256: distribution.releaseSha256,
    registry: effectiveRegistry,
    cliOnly,
    telemetry,
    fingerprint,
    confirmation: `INSTALL SINGULARITY FLOW ${fingerprint}`,
    createdAt: new Date().toISOString(),
    installed,
    distribution: {
      artifactKeyPath: originKeyPath,
      entrypoint: environment.SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT
        ? path.resolve(environment.SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT) : null,
      receiptSha256: distribution.receiptSha256,
      releaseSha256: distribution.releaseSha256,
      sumsSha256: distribution.sumsSha256,
      authority: distribution.artifactAuthority,
      operatorScripts: distribution.operatorScripts.map(({ name, sha256: digest }) => ({ name, sha256: digest })),
      rollback: {
        tarball: priorTarball,
        tarballSha256: prior.tarball?.sha256 ?? null,
        vsix: priorVsix,
        vsixSha256: prior.vsix?.sha256 ?? null,
        package: priorPackage,
        packageSha256: priorPackageSha256,
        cliBuild: priorCliBuild
      }
    },
    artifacts: {
      tarball: path.basename(distribution.tarball.path),
      tarballSha256,
      vsix: path.basename(distribution.vsix.path),
      vsixSha256
    },
    remove: [
      'global npm package singularity-flow in place, including its npm-created command shims',
      ...(cliOnly ? [] : [
        `Copilot plugin identities: ${REINSTALL_SURFACES.copilotPlugins.join(', ')}`,
        'managed direct /sf-* skills carrying the Singularity Flow ownership marker',
        `VS Code extension ${REINSTALL_SURFACES.vscodeExtension}${installed.codeAvailable ? '' : ' (code CLI unavailable; skipped)'}`,
        'installer-managed sflow_copilot compatibility helper (never the user\'s copilot command)'
      ])
    ],
    preserve: [
      'all Git repositories, worktrees, branches, commits, remotes, and working trees',
      'all repository singularity/, .singularity/, and .git/singularity-flow/ data',
      'workspace directories, repository clones, and ~/.singularity-flow workspace selection',
      'VS Code settings, global state, SecretStorage, and credentials',
      'personal Copilot skills without the managed marker',
      'Node.js, npm, npm cache, and unrelated global packages'
    ],
    bundle: {
      stagingParent: distribution.snapshotDirectory,
      source: stagedPackage,
      artifacts: distribution.snapshotDirectory,
      tarball: distribution.tarball.path,
      vsix: distribution.vsix.path
    }
  };
  const result = await persistDistributionPlan(plan, tempRoot);
  persisted = true;
  return result;
  } finally {
    if (!persisted && distribution.snapshotDirectory) {
      await rm(distribution.snapshotDirectory, { recursive: true, force: true });
    }
  }
}

async function loadCachedPlan(fingerprint, tempRoot) {
  const file = path.join(planCacheRoot(tempRoot), fingerprint, 'reinstall-plan.json');
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 4 * 1024 * 1024) return null;
    return JSON.parse(await readFile(file, 'utf8'));
  } catch { return null; }
}

async function validatePreparedPlan(plan) {
  plan = readRecord('reinstall-plan', plan).record;
  if (!['local-product-reinstall', 'distribution-product-install'].includes(plan.operation)) {
    throw new SingularityFlowError('The prepared reinstall plan is not supported. Create a new --dry-run preview.');
  }
  if (plan.operation === 'local-product-reinstall') {
    if (await reinstallSourceDigest(plan.checkout) !== plan.sourceSha256) {
      throw new SingularityFlowError('The source checkout changed after the preview. Run reinstall --dry-run again and use its new confirmation.');
    }
  } else {
    const cacheDirectory = path.resolve(
      String(plan.distribution?.planCacheRoot ?? ''), plan.fingerprint
    );
    const bundleDirectory = path.resolve(plan.bundle?.stagingParent ?? '');
    const expectedSource = path.join(
      cacheDirectory, 'candidate-package', 'node_modules', REINSTALL_SURFACES.npmPackage
    );
    if (bundleDirectory !== cacheDirectory
        || path.dirname(path.resolve(plan.bundle?.tarball ?? '')) !== cacheDirectory
        || path.dirname(path.resolve(plan.bundle?.vsix ?? '')) !== cacheDirectory
        || path.resolve(plan.bundle?.source ?? '') !== expectedSource
        || !plan.distribution?.receiptSha256
        || !plan.distribution?.authority?.signerKeySha256) {
      throw new SingularityFlowError(
        'The private distribution snapshot escaped its fingerprinted plan cache. Re-run the distribution installer preview.'
      );
    }
    await Promise.all([
      regularFile(path.join(expectedSource, 'package.json'), 'private distribution package.json'),
      regularFile(path.join(expectedSource, 'plugin', 'plugin.json'), 'private distribution plugin/plugin.json'),
      regularFile(path.join(expectedSource, 'bin', 'singularity-flow.mjs'), 'private distribution CLI')
    ]);
    const rollback = plan.distribution.rollback;
    const expectedRollbackTarball = path.join(cacheDirectory, 'rollback-singularity-flow.tgz');
    const expectedRollbackVsix = path.join(cacheDirectory, 'rollback-singularity-flow.vsix');
    const expectedRollbackPackage = path.join(
      cacheDirectory, 'rollback-package', 'node_modules', REINSTALL_SURFACES.npmPackage
    );
    if (plan.installed.npmVersion) {
      if (path.resolve(String(rollback?.tarball ?? '')) !== expectedRollbackTarball
          || !rollback.tarballSha256
          || await fileHash(rollback.tarball) !== rollback.tarballSha256.replace(/^sha256:/u, '')) {
        throw new SingularityFlowError(
          'The exact retained CLI rollback artifact changed after distribution preview.'
        );
      }
    }
    if (plan.installed.vscodeVersion) {
      if (path.resolve(String(rollback?.vsix ?? '')) !== expectedRollbackVsix
          || !rollback.vsixSha256
          || await fileHash(rollback.vsix) !== rollback.vsixSha256.replace(/^sha256:/u, '')) {
        throw new SingularityFlowError(
          'The exact retained VS Code rollback artifact changed after distribution preview.'
        );
      }
    }
    if (plan.installed.npmVersion) {
      if (path.resolve(String(rollback?.package ?? '')) !== expectedRollbackPackage) {
        throw new SingularityFlowError(
          'The private CLI rollback package escaped its fingerprinted plan cache.'
        );
      }
      await Promise.all([
        regularFile(path.join(rollback?.package ?? '', 'package.json'), 'private rollback package.json'),
        regularFile(path.join(rollback?.package ?? '', 'plugin', 'plugin.json'), 'private rollback plugin/plugin.json'),
        regularFile(path.join(rollback?.package ?? '', 'bin', 'singularity-flow.mjs'), 'private rollback CLI')
      ]);
      if (!rollback.packageSha256
          || await packageTreeSha256(rollback.package) !== rollback.packageSha256) {
        throw new SingularityFlowError(
          'The private CLI rollback package changed after distribution preview.'
        );
      }
      if (!String(rollback.cliBuild ?? '').startsWith(`${plan.installed.npmVersion} (`)
          || !String(rollback.cliBuild).endsWith(')')
          || /[\r\n]/u.test(String(rollback.cliBuild))) {
        throw new SingularityFlowError(
          'The private CLI rollback package has no valid exact build binding.'
        );
      }
    }
  }
  if (await fileHash(plan.bundle.tarball) !== plan.artifacts.tarballSha256
      || await fileHash(plan.bundle.vsix) !== plan.artifacts.vsixSha256) {
    throw new SingularityFlowError('The prepared reinstall bundle changed after validation. Run reinstall --dry-run again.');
  }
  const fingerprint = plan.operation === 'distribution-product-install'
    ? distributionInstallFingerprint({
      directory: plan.checkout,
      artifactKeyPath: plan.distribution?.artifactKeyPath,
      entrypoint: plan.distribution?.entrypoint,
      version: plan.version,
      releaseSha256: plan.distribution?.releaseSha256,
      sumsSha256: plan.distribution?.sumsSha256,
      receiptSha256: plan.distribution?.receiptSha256,
      signerKeySha256: plan.distribution?.authority?.signerKeySha256,
      tarballSha256: plan.artifacts.tarballSha256,
      vsixSha256: plan.artifacts.vsixSha256,
      rollbackTarballSha256: plan.distribution?.rollback?.tarballSha256,
      rollbackVsixSha256: plan.distribution?.rollback?.vsixSha256,
      rollbackPackageSha256: plan.distribution?.rollback?.packageSha256,
      rollbackCliBuild: plan.distribution?.rollback?.cliBuild,
      registry: plan.registry,
      cliOnly: plan.cliOnly,
      telemetry: plan.telemetry,
      installed: plan.installed
    })
    : reinstallFingerprint({
      checkout: plan.checkout,
      version: plan.version,
      tarballSha256: plan.artifacts.tarballSha256,
      vsixSha256: plan.artifacts.vsixSha256
    });
  const confirmation = plan.operation === 'distribution-product-install'
    ? `INSTALL SINGULARITY FLOW ${fingerprint}`
    : `${CONFIRMATION_PREFIX}${fingerprint}`;
  if (plan.fingerprint !== fingerprint || plan.confirmation !== confirmation) {
    throw new SingularityFlowError('The prepared reinstall plan does not match its fingerprint. Run reinstall --dry-run again.');
  }
  return plan;
}

function renderTelemetryWrapper() {
  return `${MANAGED_TELEMETRY_MARKER}\n` +
    '# Never shadows the user\'s copilot executable. SFlow provisions only processes it launches.\n' +
    'sflow_copilot() {\n' +
    '  command singularity-flow copilot "$@"\n' +
    '}\n';
}

function selectedTelemetryProfile(homeDirectory, environment) {
  const shell = path.basename(String(environment.SHELL ?? '')).toLowerCase();
  if (shell === 'zsh') return path.join(environment.ZDOTDIR || homeDirectory, '.zshrc');
  if (shell === 'bash') {
    const profile = path.join(homeDirectory, '.bash_profile');
    return fs.existsSync(profile) ? profile : path.join(homeDirectory, '.bashrc');
  }
  return null;
}

async function replaceOrdinaryText(file, updatedOrTransform, label) {
  const info = await lstat(file).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (info && (!info.isFile() || info.isSymbolicLink())) {
    throw new SingularityFlowError(`${label} is not an ordinary file: ${file}`);
  }
  const original = info ? await readFile(file, 'utf8') : null;
  const updated = typeof updatedOrTransform === 'function'
    ? updatedOrTransform(original ?? '')
    : updatedOrTransform;
  if (typeof updated !== 'string') {
    throw new SingularityFlowError(`${label} update did not produce text: ${file}`);
  }
  if (original === updated) return false;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.sflow-${process.pid}-${randomUUID()}.tmp`;
  await writeFile(temporary, updated, { flag: 'wx', mode: info ? info.mode & 0o777 : 0o600 });
  try {
    const current = await lstat(file).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (Boolean(current) !== Boolean(info)
        || (current && (!current.isFile() || current.isSymbolicLink()
          || await readFile(file, 'utf8') !== original
          || (info.ino && current.ino && (info.ino !== current.ino || info.dev !== current.dev))))) {
      throw new SingularityFlowError(`${label} changed while it was being updated: ${file}`);
    }
    await rename(temporary, file);
    await chmod(file, info ? info.mode & 0o777 : 0o600);
  } finally { await rm(temporary, { force: true }); }
  return true;
}

async function removeOrdinaryText(file, label, predicate = () => true) {
  const info = await lstat(file).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return false;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SingularityFlowError(`${label} is not an ordinary file: ${file}`);
  }
  const original = await readFile(file, 'utf8');
  if (!predicate(original)) return false;
  const current = await lstat(file);
  const currentText = await readFile(file, 'utf8');
  if (!current.isFile() || current.isSymbolicLink() || currentText !== original
      || (info.ino && current.ino && (info.ino !== current.ino || info.dev !== current.dev))) {
    throw new SingularityFlowError(`${label} changed while it was being removed: ${file}`);
  }
  const quarantine = `${file}.sflow-remove-${process.pid}-${randomUUID()}.tmp`;
  await rename(file, quarantine);
  let preserveQuarantine = false;
  try {
    const moved = await lstat(quarantine);
    const movedText = await readFile(quarantine, 'utf8');
    if (!moved.isFile() || moved.isSymbolicLink() || movedText !== original
        || (current.ino && moved.ino && (current.ino !== moved.ino || current.dev !== moved.dev))) {
      const replacement = await lstat(file).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (!replacement) await rename(quarantine, file);
      else preserveQuarantine = true;
      throw new SingularityFlowError(
        `${label} changed during removal; concurrent bytes were preserved`
        + `${preserveQuarantine ? ` at ${quarantine}` : ` at ${file}`}.`
      );
    }
  } finally {
    if (!preserveQuarantine) await rm(quarantine, { force: true });
  }
  return true;
}

function telemetryProfileText(original, enabled) {
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  let lines = original.split(/\r?\n/u)
    .filter((line) => line !== TELEMETRY_PROFILE_COMMENT && line !== TELEMETRY_PROFILE_SOURCE);
  while (lines.at(-1) === '') lines.pop();
  if (enabled) lines.push('', TELEMETRY_PROFILE_COMMENT, TELEMETRY_PROFILE_SOURCE);
  return lines.length ? `${lines.join(newline)}${newline}` : '';
}

async function replaceTelemetryWrapper({
  homeDirectory, environment, enabled, beforeProfileMutation = null
}) {
  const file = path.join(homeDirectory, REINSTALL_SURFACES.telemetryWrapper);
  const current = await readFile(file, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  const preservedPersonalFile = Boolean(
    current && !current.startsWith(MANAGED_TELEMETRY_MARKER)
  );
  if (enabled && preservedPersonalFile) {
    return { enabled: null, file, preservedPersonalFile: true };
  }
  const profile = selectedTelemetryProfile(homeDirectory, environment);
  const profileCandidates = new Set(telemetryProfileCandidates(homeDirectory, environment)
    .map((entry) => path.resolve(entry)));
  if (!enabled) {
    for (const candidate of profileCandidates) {
      const original = await readFile(candidate, 'utf8').catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (original != null && original.split(/\r?\n/u).some((line) => (
        line === TELEMETRY_PROFILE_COMMENT || line === TELEMETRY_PROFILE_SOURCE
      ))) {
        if (beforeProfileMutation) await beforeProfileMutation({ candidate, enabled: false });
        await replaceOrdinaryText(
          candidate,
          (exactCurrent) => telemetryProfileText(exactCurrent, false),
          'Shell telemetry profile'
        );
      }
    }
    if (current && !preservedPersonalFile) {
      await removeOrdinaryText(
        file, 'Managed telemetry helper',
        (exactCurrent) => exactCurrent.startsWith(MANAGED_TELEMETRY_MARKER)
      );
    }
    return { enabled: false, file, profile: null, preservedPersonalFile };
  }
  await replaceOrdinaryText(file, (exactCurrent) => {
    if (exactCurrent && !exactCurrent.startsWith(MANAGED_TELEMETRY_MARKER)) {
      throw new SingularityFlowError(`Managed telemetry helper preserved a personal file: ${file}`);
    }
    return renderTelemetryWrapper();
  }, 'Managed telemetry helper');
  for (const candidate of profileCandidates) {
    const original = await readFile(candidate, 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return '';
      throw error;
    });
    const selected = profile && path.resolve(profile) === candidate;
    if (!selected && !original.split(/\r?\n/u).some((line) => (
      line === TELEMETRY_PROFILE_COMMENT || line === TELEMETRY_PROFILE_SOURCE
    ))) continue;
    if (beforeProfileMutation) {
      await beforeProfileMutation({ candidate, enabled: Boolean(selected) });
    }
    await replaceOrdinaryText(
      candidate,
      (exactCurrent) => telemetryProfileText(exactCurrent, Boolean(selected)),
      'Shell telemetry profile'
    );
  }
  return { enabled: true, file, profile };
}

function renderedShellLines(argv, prefix = '', {
  posixLabel = null, windowsQualifier = ''
} = {}) {
  if (process.platform === 'win32') {
    return [
      `${prefix}${windowsQualifier}PowerShell: ${renderPlatformCommand(argv, 'win32')}`,
      `${prefix}${windowsQualifier}Command Prompt: ${renderCommandPromptCommand(argv)}`
    ];
  }
  return [`${prefix}${posixLabel ? `${posixLabel}: ` : ''}${renderPlatformCommand(argv)}`];
}

function recoveryText(plan) {
  if (plan.operation === 'distribution-product-install') {
    const argv = [
      plan.distribution?.entrypoint ?? 'sf-install',
      ...(plan.distribution?.entrypoint ? [] : ['--release-dir', plan.checkout]),
      '--artifact-key', plan.distribution.artifactKeyPath,
      '--confirm', plan.confirmation,
      ...(plan.cliOnly ? ['--cli-only'] : [])
    ];
    return [
      'The promoted release directory remains unchanged. Re-run its installer after correcting the reported surface:',
      ...renderedShellLines(argv, '  '),
      'Repositories, workspace data, credentials, and personal Copilot skills were not recovery targets.'
    ].join('\n');
  }
  const retry = [
    'sf-reinstall', '--checkout', plan.checkout, '--confirm', plan.confirmation,
    ...(plan.cliOnly ? ['--cli-only'] : [])
  ];
  const lines = [
    'Validated recovery bundle retained locally. Retry the complete transaction with:',
    ...renderedShellLines(retry, '  '),
    'Or restore individual surfaces with:',
    ...renderedShellLines([
      'npm', 'install', '--global', plan.bundle.tarball, `--registry=${plan.registry}`
    ], '  ')
  ];
  if (!plan.cliOnly && plan.bundle.vsix) lines.push(...renderedShellLines([
    'code', '--install-extension', plan.bundle.vsix, '--force'
  ], '  '));
  if (!plan.cliOnly) lines.push(...renderedShellLines([
    'singularity-flow', 'plugin', 'install'
  ], '  '));
  return lines.join('\n');
}

async function writeReceipt(plan, receipt, homeDirectory) {
  const directory = path.join(homeDirectory, '.singularity-flow', 'installations');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stamp = receipt.completedAt.replace(/[:.]/g, '-');
  const file = path.join(directory, `reinstall-${stamp}-${plan.fingerprint}.json`);
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return file;
}

async function managedInstallDirectory(directory, label) {
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new SingularityFlowError(`${label} is not a regular, non-symlink directory: ${directory}`);
  }
  await chmod(directory, 0o700);
  return directory;
}

async function retainReinstallArtifact({ source, digest, kind, version, installations }) {
  if (!source) return null;
  if (!SHA256_HEX.test(String(digest ?? ''))) {
    throw new SingularityFlowError(`The validated reinstall ${kind} digest is invalid.`);
  }
  const sourceInfo = await lstat(source).catch(() => null);
  if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink()) {
    throw new SingularityFlowError(`The validated reinstall ${kind} is not a regular, non-symlink file: ${source}`);
  }
  const versions = await managedInstallDirectory(path.join(installations, 'versions'), 'Reinstall version store');
  const algorithm = await managedInstallDirectory(path.join(versions, 'sha256'), 'Reinstall SHA-256 store');
  const digestDirectory = await managedInstallDirectory(path.join(algorithm, digest), 'Reinstall digest store');
  const target = path.join(digestDirectory, RETAINED_ARTIFACT_NAMES[kind]);
  const temporary = path.join(digestDirectory, `.${RETAINED_ARTIFACT_NAMES[kind]}.${process.pid}.${randomUUID()}.tmp`);
  let targetInfo = await lstat(target).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!targetInfo) {
    await fs.promises.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
    try {
      if (await fileHash(temporary) !== digest) {
        throw new SingularityFlowError(`The validated reinstall ${kind} changed while it was retained.`);
      }
      await chmod(temporary, 0o600);
      try { await fs.promises.link(temporary, target); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
    } finally {
      await rm(temporary, { force: true });
    }
    targetInfo = await lstat(target).catch(() => null);
  }
  if (!targetInfo?.isFile() || targetInfo.isSymbolicLink() || await fileHash(target) !== digest) {
    throw new SingularityFlowError(`The retained reinstall ${kind} conflicts with its content-addressed path: ${target}`);
  }
  await chmod(target, 0o600);
  return kind === 'tarball'
    ? { path: target, sha256: `sha256:${digest}`, package: REINSTALL_SURFACES.npmPackage, version }
    : { path: target, sha256: `sha256:${digest}`, extensionId: REINSTALL_SURFACES.vscodeExtension, version };
}

async function trustedCurrentVsix(currentFile, installations, observedVersion) {
  if (!observedVersion) return null;
  const info = await lstat(currentFile).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SingularityFlowError(`Installation receipt is not a regular, non-symlink file: ${currentFile}`);
  }
  let current;
  try { current = readRecord('installation-current', await readFile(currentFile)).record; }
  catch { return null; }
  const recorded = current.artifacts?.vsix;
  const digest = String(recorded?.sha256 ?? '').replace(/^sha256:/u, '');
  if (!SHA256_HEX.test(digest)) return null;
  const expected = path.join(installations, 'versions', 'sha256', digest, RETAINED_ARTIFACT_NAMES.vsix);
  if (path.resolve(String(recorded.path ?? '')) !== expected) return null;
  let inspected;
  try { inspected = await inspectVsix(expected); }
  catch { return null; }
  if (inspected.sha256 !== `sha256:${digest}`
      || inspected.extensionId !== REINSTALL_SURFACES.vscodeExtension
      || inspected.version !== observedVersion) return null;
  return inspected;
}

async function trustedCurrentTarball(currentFile, installations, observedVersion) {
  if (!observedVersion) return null;
  const info = await lstat(currentFile).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SingularityFlowError(`Installation receipt is not a regular, non-symlink file: ${currentFile}`);
  }
  let current;
  try { current = readRecord('installation-current', await readFile(currentFile)).record; }
  catch { return null; }
  const recorded = current.artifacts?.tarball;
  const digest = String(recorded?.sha256 ?? '').replace(/^sha256:/u, '');
  if (!SHA256_HEX.test(digest)) return null;
  const expected = path.join(installations, 'versions', 'sha256', digest, RETAINED_ARTIFACT_NAMES.tarball);
  if (path.resolve(String(recorded.path ?? '')) !== expected) return null;
  let inspected;
  try { inspected = await inspectNpmTarball(expected); }
  catch { return null; }
  if (inspected.sha256 !== `sha256:${digest}`
      || inspected.package !== REINSTALL_SURFACES.npmPackage
      || inspected.version !== observedVersion) return null;
  return inspected;
}

async function distributionRollbackAuthority({ installed, homeDirectory, checkout }) {
  const installations = path.join(homeDirectory, '.singularity-flow', 'installations');
  const currentFile = path.join(installations, 'current.json');
  const [tarball, vsix] = await Promise.all([
    trustedCurrentTarball(currentFile, installations, installed.npmVersion),
    trustedCurrentVsix(currentFile, installations, installed.vscodeVersion)
  ]);
  const missing = [];
  if (installed.npmVersion && !tarball) missing.push(`CLI ${installed.npmVersion}`);
  if (installed.vscodeVersion && !vsix) missing.push(`VS Code extension ${installed.vscodeVersion}`);
  if ((installed.copilotPlugins.length || installed.managedDirectSkills.length) && !tarball) {
    missing.push('Copilot plugin/direct-skill package');
  }
  const pluginIdentities = [...installed.copilotPlugins].sort();
  if (pluginIdentities.length
      && JSON.stringify(pluginIdentities) !== JSON.stringify(['singularity-flow'])) {
    throw new SingularityFlowError(
      `Distribution install cannot reproduce the exact currently installed Copilot plugin identities: `
      + `${pluginIdentities.join(', ')}. Run one full source install from the current trusted checkout `
      + `to normalize the plugin identity before retrying ${checkout}. No product surface was changed.`
    );
  }
  if (missing.length) {
    throw new SingularityFlowError(
      `Distribution install cannot prove exact rollback bytes for the currently installed ${missing.join(' and ')}. `
      + 'Run one full source install from the current trusted checkout to seed the schema-v2 retained-artifact receipt, '
      + `then retry the promoted distribution at ${checkout}. No product surface was changed.`
    );
  }
  return { tarball, vsix };
}

async function assertCliOnlyVsixRollbackAuthority({ cliOnly, installed, homeDirectory, checkout }) {
  if (!cliOnly || !installed.vscodeVersion) return;
  const installations = path.join(homeDirectory, '.singularity-flow', 'installations');
  const currentFile = path.join(installations, 'current.json');
  if (await trustedCurrentVsix(currentFile, installations, installed.vscodeVersion)) return;
  const fullReinstall = renderedShellLines([
    'sf-reinstall', '--checkout', checkout, '--dry-run'
  ], '  ', { posixLabel: 'Shell' }).join('\n');
  throw new SingularityFlowError(
    `CLI-only clean reinstall cannot preserve rollback authority for the installed VS Code extension `
    + `${REINSTALL_SURFACES.vscodeExtension}@${installed.vscodeVersion}. The current installation receipt `
    + 'does not contain a trusted schema-v2 content-addressed VSIX binding. Run a full clean reinstall '
    + `first (without --cli-only):\n${fullReinstall}\nThen `
    + 'apply its reviewed fingerprint confirmation.'
  );
}

async function writeCurrentInstallationReceipt(plan, verified, receipt, homeDirectory) {
  const machineState = await managedInstallDirectory(
    path.join(homeDirectory, '.singularity-flow'), 'Singularity Flow machine-state directory'
  );
  const installations = await managedInstallDirectory(
    path.join(machineState, 'installations'), 'Singularity Flow installation directory'
  );
  const currentFile = path.join(installations, 'current.json');
  const artifacts = {
    tarball: await retainReinstallArtifact({
      source: plan.bundle.tarball,
      digest: plan.artifacts.tarballSha256,
      kind: 'tarball',
      version: plan.version,
      installations
    }),
    vsix: !plan.cliOnly && plan.installed.codeAvailable
      ? await retainReinstallArtifact({
        source: plan.bundle.vsix,
        digest: plan.artifacts.vsixSha256,
        kind: 'vsix',
        version: plan.version,
        installations
      })
      : await trustedCurrentVsix(currentFile, installations, verified.vscodeVersion)
  };
  const surfaces = {
    cli: true,
    vscode: Boolean(artifacts.vsix),
    copilot: !plan.cliOnly && verified.copilotPlugins.length > 0,
    telemetry: !plan.cliOnly && verified.telemetryManaged,
    manifest: true
  };
  const current = {
    schemaVersion: currentSchemaVersion('installation-current'),
    status: Object.values(surfaces).every(Boolean) ? 'complete' : 'complete-with-skips',
    version: plan.version,
    build: { cli: verified.cliBuild },
    checkout: plan.checkout,
    artifacts,
    surfaces,
    workspaceRefresh: 'skipped',
    activation: null,
    reinstall: { fingerprint: plan.fingerprint, receipt },
    installedAt: new Date().toISOString()
  };
  const existing = await lstat(currentFile).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new SingularityFlowError(`Installation receipt is not a regular, non-symlink file: ${currentFile}`);
  }
  const temporary = `${currentFile}.reinstall-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try { await rename(temporary, currentFile); }
  finally { await rm(temporary, { force: true }); }
  await chmod(currentFile, 0o600);
  return currentFile;
}

const DISTRIBUTION_TRANSACTION_FILE = 'distribution-install-pending.json';
const DISTRIBUTION_TRANSACTION_SURFACES = Object.freeze([
  'vscode', 'copilot', 'skills', 'telemetry', 'cli', 'receipt'
]);

function distributionReceiptName(name, fingerprint) {
  return name.startsWith('reinstall-') && name.endsWith(`-${fingerprint}.json`)
    && /^[A-Za-z0-9._-]+$/u.test(name);
}

async function distributionReceiptInventory(installations, fingerprint) {
  const entries = await readdir(installations, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (!distributionReceiptName(entry.name, fingerprint)) continue;
    const file = path.join(installations, entry.name);
    const info = await lstat(file);
    if (!entry.isFile() || !info.isFile() || info.isSymbolicLink()) {
      throw new SingularityFlowError(`Distribution receipt path is not an ordinary file: ${file}`);
    }
    names.push(entry.name);
  }
  return names.sort();
}

async function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try { await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
  await chmod(file, 0o600);
}

async function stableRollbackBytes(target) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await lstat(target).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!before) {
      const confirmedAbsent = await lstat(target).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (!confirmedAbsent) return null;
      continue;
    }
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new SingularityFlowError(`Distribution rollback target is not an ordinary file: ${target}`);
    }
    if (before.size > 4 * 1024 * 1024) {
      throw new SingularityFlowError(`Distribution rollback target exceeds the 4 MiB safety limit: ${target}`);
    }
    const bytes = await readFile(target);
    const after = await lstat(target).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (after?.isFile() && !after.isSymbolicLink()
        && before.dev === after.dev && before.ino === after.ino
        && before.size === after.size && before.mtimeMs === after.mtimeMs
        && before.ctimeMs === after.ctimeMs && bytes.length === after.size) {
      return { bytes, info: after };
    }
  }
  throw new SingularityFlowError(`Distribution rollback target changed while it was being snapshotted: ${target}`);
}

async function snapshotRollbackFile(target, root, name, { kind = 'ordinary' } = {}) {
  const stable = await stableRollbackBytes(target);
  if (!stable) return { target, present: false, snapshot: null, mode: null, kind };
  const snapshot = path.join(root, name);
  await writeFile(snapshot, stable.bytes, { flag: 'wx', mode: 0o600 });
  await chmod(snapshot, 0o600);
  return {
    target, present: true, snapshot, mode: stable.info.mode & 0o777, kind,
    sha256: `sha256:${sha256(stable.bytes)}`
  };
}

async function restoreRollbackFile(binding) {
  const current = await lstat(binding.target).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (current && (!current.isFile() || current.isSymbolicLink())) {
    throw new SingularityFlowError(`Distribution rollback target became unsafe: ${binding.target}`);
  }
  if (binding.kind === 'telemetry-profile') {
    let prior = '';
    if (binding.present) {
      const source = await lstat(binding.snapshot).catch(() => null);
      if (!source?.isFile() || source.isSymbolicLink()
          || `sha256:${await fileHash(binding.snapshot)}` !== binding.sha256) {
        throw new SingularityFlowError(`Distribution rollback snapshot changed: ${binding.snapshot}`);
      }
      prior = await readFile(binding.snapshot, 'utf8');
    }
    const priorManaged = prior.split(/\r?\n/u).some((line) => (
      line === TELEMETRY_PROFILE_COMMENT || line === TELEMETRY_PROFILE_SOURCE
    ));
    // Shell profiles are shared user files. Reverse only the two exact installer-owned lines so a
    // concurrent editor change survives compensation. The transform runs from the exact text that
    // replaceOrdinaryText subsequently CAS-checks; computing it before that read would reintroduce
    // a lost-update window. An originally absent profile may remain as an empty ordinary file;
    // preserving bytes always wins over deleting a concurrently used path.
    await replaceOrdinaryText(
      binding.target,
      (exactCurrent) => telemetryProfileText(exactCurrent, priorManaged),
      'Shell telemetry profile rollback'
    );
    return;
  }
  if (binding.kind === 'telemetry-wrapper') {
    if (!binding.present) {
      await removeOrdinaryText(
        binding.target, 'Managed telemetry helper rollback',
        (exactCurrent) => exactCurrent.startsWith(MANAGED_TELEMETRY_MARKER)
      );
      return;
    }
    const source = await lstat(binding.snapshot).catch(() => null);
    if (!source?.isFile() || source.isSymbolicLink()
        || `sha256:${await fileHash(binding.snapshot)}` !== binding.sha256) {
      throw new SingularityFlowError(`Distribution rollback snapshot changed: ${binding.snapshot}`);
    }
    const prior = await readFile(binding.snapshot, 'utf8');
    // A personal helper is never an installer mutation target. Preserve whatever the user did to
    // it while the transaction ran instead of restoring an older personal snapshot.
    if (!prior.startsWith(MANAGED_TELEMETRY_MARKER)) return;
    await replaceOrdinaryText(binding.target, (exactCurrent) => {
      if (exactCurrent && !exactCurrent.startsWith(MANAGED_TELEMETRY_MARKER)) {
        throw new SingularityFlowError(
          `Managed telemetry rollback preserved a concurrent personal helper: ${binding.target}`
        );
      }
      return prior;
    }, 'Managed telemetry helper rollback');
    return;
  }
  if (!binding.present) {
    if (current) await rm(binding.target);
    return;
  }
  const source = await lstat(binding.snapshot).catch(() => null);
  if (!source?.isFile() || source.isSymbolicLink()
      || `sha256:${await fileHash(binding.snapshot)}` !== binding.sha256) {
    throw new SingularityFlowError(`Distribution rollback snapshot changed: ${binding.snapshot}`);
  }
  await mkdir(path.dirname(binding.target), { recursive: true, mode: 0o700 });
  const temporary = `${binding.target}.sflow-rollback-${process.pid}-${randomUUID()}`;
  await fs.promises.copyFile(binding.snapshot, temporary, fs.constants.COPYFILE_EXCL);
  try {
    await chmod(temporary, binding.mode ?? 0o600);
    await rename(temporary, binding.target);
  } finally { await rm(temporary, { force: true }); }
}

async function ordinaryManagedSkill(directory) {
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) return false;
  try { await packageTreeSha256(directory); }
  catch { return false; }
  const entries = await readdir(directory, { withFileTypes: true });
  const skill = entries.find((entry) => entry.name === 'SKILL.md');
  if (!skill?.isFile()) return false;
  return isManagedDirectSkill(await readFile(path.join(directory, 'SKILL.md'), 'utf8'));
}

async function beginDistributionTransaction(plan, { homeDirectory, environment }) {
  const installations = await managedInstallDirectory(
    path.join(homeDirectory, '.singularity-flow', 'installations'),
    'Singularity Flow installation directory'
  );
  const pending = path.join(installations, DISTRIBUTION_TRANSACTION_FILE);
  const existing = await lstat(pending).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    throw new SingularityFlowError(
      `A prior distribution install transaction requires recovery: ${pending}. `
      + 'Retry its exact printed installer command; do not delete the transaction or retained rollback bytes.'
    );
  }
  const transactions = await managedInstallDirectory(
    path.join(installations, 'distribution-install-transactions'),
    'Distribution install transaction directory'
  );
  const root = path.join(transactions, `${plan.fingerprint}-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  const rollbackSource = plan.distribution.rollback ?? {};
  const rollbackDirectory = path.join(root, 'rollback-authority');
  await mkdir(rollbackDirectory, { mode: 0o700 });
  const rollback = {
    tarball: null,
    tarballSha256: rollbackSource.tarballSha256 ?? null,
    vsix: null,
    vsixSha256: rollbackSource.vsixSha256 ?? null,
    package: null,
    packageSha256: rollbackSource.packageSha256 ?? null,
    cliBuild: rollbackSource.cliBuild ?? null
  };
  if (rollbackSource.tarball) {
    rollback.tarball = path.join(rollbackDirectory, 'singularity-flow.tgz');
    await fs.promises.copyFile(
      rollbackSource.tarball, rollback.tarball, fs.constants.COPYFILE_EXCL
    );
    await chmod(rollback.tarball, 0o600);
    if (`sha256:${await fileHash(rollback.tarball)}` !== rollback.tarballSha256) {
      throw new SingularityFlowError('CLI rollback bytes changed while durable transaction authority was created.');
    }
  }
  if (rollbackSource.vsix) {
    rollback.vsix = path.join(rollbackDirectory, 'singularity-flow.vsix');
    await fs.promises.copyFile(
      rollbackSource.vsix, rollback.vsix, fs.constants.COPYFILE_EXCL
    );
    await chmod(rollback.vsix, 0o600);
    if (`sha256:${await fileHash(rollback.vsix)}` !== rollback.vsixSha256) {
      throw new SingularityFlowError('VS Code rollback bytes changed while durable transaction authority was created.');
    }
  }
  if (rollbackSource.package) {
    rollback.package = path.join(rollbackDirectory, 'package');
    await cp(rollbackSource.package, rollback.package, {
      recursive: true, force: false, errorOnExist: true
    });
    await Promise.all([
      regularFile(path.join(rollback.package, 'package.json'), 'durable rollback package.json'),
      regularFile(path.join(rollback.package, 'plugin', 'plugin.json'), 'durable rollback plugin/plugin.json'),
      regularFile(path.join(rollback.package, 'bin', 'singularity-flow.mjs'), 'durable rollback CLI')
    ]);
    if (await packageTreeSha256(rollback.package) !== rollback.packageSha256) {
      throw new SingularityFlowError(
        'Copilot rollback package changed while durable transaction authority was created.'
      );
    }
  }
  const files = [];
  const currentFile = path.join(installations, 'current.json');
  files.push(await snapshotRollbackFile(currentFile, root, 'current.json'));
  const wrapper = path.join(homeDirectory, REINSTALL_SURFACES.telemetryWrapper);
  files.push(await snapshotRollbackFile(
    wrapper, root, 'telemetry-wrapper', { kind: 'telemetry-wrapper' }
  ));
  const profiles = new Set([
    ...(plan.installed.managedTelemetryProfiles ?? []),
    selectedTelemetryProfile(homeDirectory, environment)
  ].filter(Boolean).map((entry) => path.resolve(entry)));
  let profileIndex = 0;
  for (const profile of profiles) {
    files.push(await snapshotRollbackFile(
      profile, root, `profile-${profileIndex += 1}`, { kind: 'telemetry-profile' }
    ));
  }
  const skillsRoot = path.resolve(plan.installed.skillsRoot);
  const skillSnapshots = [];
  const skillRootInfo = await lstat(skillsRoot).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (skillRootInfo && (!skillRootInfo.isDirectory() || skillRootInfo.isSymbolicLink())) {
    throw new SingularityFlowError(`Direct-skill rollback root is unsafe: ${skillsRoot}`);
  }
  const skillsBackup = path.join(root, 'skills');
  await mkdir(skillsBackup, { mode: 0o700 });
  for (const name of plan.installed.managedDirectSkills) {
    if (!/^sf-[a-z0-9][a-z0-9-]*$/u.test(name)) {
      throw new SingularityFlowError(`Managed direct-skill identity is unsafe: ${name}`);
    }
    const source = path.join(skillsRoot, name);
    if (!await ordinaryManagedSkill(source)) {
      throw new SingularityFlowError(`Managed direct-skill rollback source is unsafe: ${source}`);
    }
    const digest = await packageTreeSha256(source);
    const snapshot = path.join(skillsBackup, name);
    await cp(source, snapshot, { recursive: true, force: false, errorOnExist: true });
    if (await packageTreeSha256(snapshot) !== digest) {
      throw new SingularityFlowError(`Managed direct-skill bytes changed while snapshotted: ${source}`);
    }
    skillSnapshots.push({ name, snapshot, sha256: digest });
  }
  const state = {
    schemaVersion: currentSchemaVersion('distribution-install-transaction'),
    operation: 'distribution-product-install',
    fingerprint: plan.fingerprint,
    status: 'prepared',
    createdAt: new Date().toISOString(),
    root,
    installed: comparableInstalledState(plan.installed),
    rollback,
    registry: plan.registry,
    skillsRoot,
    skillSnapshots,
    files,
    telemetryProfileTargets: [...profiles].sort(),
    receiptBaseline: await distributionReceiptInventory(installations, plan.fingerprint),
    surfaces: Object.fromEntries(DISTRIBUTION_TRANSACTION_SURFACES.map((name) => [name, 'untouched']))
  };
  await atomicJson(pending, state);
  return { pending, state };
}

function pathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..'
    && !relative.startsWith(`..${path.sep}`));
}

async function loadDistributionTransaction({ homeDirectory }) {
  const installations = path.join(homeDirectory, '.singularity-flow', 'installations');
  const pending = path.join(installations, DISTRIBUTION_TRANSACTION_FILE);
  const info = await lstat(pending).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 4 * 1024 * 1024) {
    throw new SingularityFlowError(`Pending distribution transaction is not a bounded ordinary file: ${pending}`);
  }
  let state;
  try {
    state = readRecord(
      'distribution-install-transaction', await readFile(pending)
    ).record;
  } catch (error) {
    throw new SingularityFlowError(`Pending distribution transaction cannot be read safely: ${error.message}`);
  }
  const transactions = path.join(installations, 'distribution-install-transactions');
  if (state.operation !== 'distribution-product-install'
      || typeof state.fingerprint !== 'string'
      || !/^[a-f0-9]{16}$/u.test(state.fingerprint)
      || typeof state.root !== 'string'
      || typeof state.skillsRoot !== 'string'
      || !pathInside(transactions, state.root)
      || path.resolve(state.skillsRoot) !== path.resolve(state.installed?.skillsRoot ?? '')) {
    throw new SingularityFlowError(`Pending distribution transaction has an unsafe identity: ${pending}`);
  }
  const telemetryProfileTargets = state.telemetryProfileTargets ?? [];
  if (!Array.isArray(telemetryProfileTargets) || telemetryProfileTargets.length > 8
      || new Set(telemetryProfileTargets).size !== telemetryProfileTargets.length
      || telemetryProfileTargets.some((entry) => (
        typeof entry !== 'string' || !path.isAbsolute(entry)
        || !['.zshrc', '.bashrc', '.bash_profile'].includes(path.basename(entry))
      ))) {
    throw new SingularityFlowError(`Pending distribution transaction has unsafe telemetry profile bindings: ${pending}`);
  }
  const allowedTargets = new Set([
    path.resolve(path.join(installations, 'current.json')),
    path.resolve(path.join(homeDirectory, REINSTALL_SURFACES.telemetryWrapper)),
    ...(state.installed?.managedTelemetryProfiles ?? []).map((entry) => path.resolve(entry)),
    ...telemetryProfileTargets.map((entry) => path.resolve(entry))
  ].filter(Boolean));
  if (!Array.isArray(state.files) || state.files.some((binding) => (
    !allowedTargets.has(path.resolve(String(binding?.target ?? '')))
    || (binding.snapshot && !pathInside(state.root, binding.snapshot))
  ))) {
    throw new SingularityFlowError(`Pending distribution transaction contains an unsafe file target: ${pending}`);
  }
  const currentTarget = path.resolve(path.join(installations, 'current.json'));
  const wrapperTarget = path.resolve(path.join(homeDirectory, REINSTALL_SURFACES.telemetryWrapper));
  const profileTargets = new Set([
    ...(state.installed?.managedTelemetryProfiles ?? []), ...telemetryProfileTargets
  ].map((entry) => path.resolve(entry)));
  for (const binding of state.files) {
    const target = path.resolve(binding.target);
    const expectedKind = target === currentTarget
      ? 'ordinary'
      : target === wrapperTarget
        ? 'telemetry-wrapper'
        : profileTargets.has(target) ? 'telemetry-profile' : null;
    if (!expectedKind || (binding.kind != null && binding.kind !== expectedKind)) {
      throw new SingularityFlowError(`Pending distribution transaction has an unsafe file binding: ${pending}`);
    }
    // v1 transactions created before file kinds were recorded remain recoverable, but the trusted
    // target classification above—not the serialized record—chooses their rollback semantics.
    binding.kind = expectedKind;
  }
  if (!Array.isArray(state.skillSnapshots) || state.skillSnapshots.some((binding) => (
    !/^sf-[a-z0-9][a-z0-9-]*$/u.test(String(binding?.name ?? ''))
    || !pathInside(state.root, binding.snapshot)
    || !/^sha256:[a-f0-9]{64}$/u.test(String(binding?.sha256 ?? ''))
  ))) {
    throw new SingularityFlowError(`Pending distribution transaction contains an unsafe skill snapshot: ${pending}`);
  }
  if (['tarball', 'vsix', 'package'].some((name) => (
    state.rollback?.[name] && !pathInside(state.root, state.rollback[name])
  )) || (state.rollback?.package && !/^sha256:[a-f0-9]{64}$/u.test(
    String(state.rollback.packageSha256 ?? '')
  ))) {
    throw new SingularityFlowError(`Pending distribution transaction contains escaped rollback authority: ${pending}`);
  }
  if (state.installed?.npmVersion && (
    !state.rollback?.tarball
    || !/^sha256:[a-f0-9]{64}$/u.test(String(state.rollback.tarballSha256 ?? ''))
    || !state.rollback?.package
    || !String(state.rollback.cliBuild ?? '').startsWith(`${state.installed.npmVersion} (`)
    || !String(state.rollback.cliBuild).endsWith(')')
    || /[\r\n]/u.test(String(state.rollback.cliBuild))
  )) {
    throw new SingularityFlowError(
      `Pending distribution transaction has no exact CLI rollback build authority: ${pending}`
    );
  }
  if (!Array.isArray(state.receiptBaseline)
      || state.receiptBaseline.some((name) => !distributionReceiptName(name, state.fingerprint))) {
    throw new SingularityFlowError(`Pending distribution transaction has an unsafe receipt baseline: ${pending}`);
  }
  return { pending, state };
}

async function updateDistributionTransaction(transaction, surface, status) {
  transaction.state = {
    ...transaction.state,
    status: status === 'rolling-back' ? 'rolling-back' : 'applying',
    surfaces: { ...transaction.state.surfaces, [surface]: status },
    updatedAt: new Date().toISOString()
  };
  await atomicJson(transaction.pending, transaction.state);
}

async function finishDistributionTransaction(transaction, status, { preserve = false } = {}) {
  transaction.state = { ...transaction.state, status, updatedAt: new Date().toISOString() };
  await atomicJson(transaction.pending, transaction.state);
  if (!preserve) {
    // Once the terminal status is durable, cleanup is not part of activation correctness. Remove
    // rollback authority first and the marker last. A Windows AV/file lock may leave the complete
    // marker for the next installer to clean, but must never turn a verified install into rollback.
    const rootRemoved = await rm(transaction.state.root, { recursive: true, force: true })
      .then(() => true, () => false);
    if (rootRemoved) await rm(transaction.pending, { force: true }).catch(() => undefined);
  }
}

function surfaceWasTouched(transaction, surface) {
  return transaction.state.surfaces[surface] !== 'untouched';
}

async function rollbackDistributionTransaction(transaction, {
  execute, exists, homeDirectory, environment, uninstallAliases
}) {
  transaction.state = { ...transaction.state, status: 'rolling-back', updatedAt: new Date().toISOString() };
  await atomicJson(transaction.pending, transaction.state);
  const timeout = productTimeout(
    environment, 'SINGULARITY_FLOW_PRODUCT_MUTATION_TIMEOUT_MS', PRODUCT_MUTATION_TIMEOUT_MS
  );
  const invoke = (command, args, options = {}) => execute(command, args, {
    timeoutMs: options.timeoutMs ?? timeout, ...options
  });
  const rollback = transaction.state.rollback ?? {};
  const failures = [];
  if (transaction.state.installed.npmVersion) {
    const priorCli = await inspectNpmTarball(rollback.tarball).catch(() => null);
    if (!priorCli || priorCli.sha256 !== rollback.tarballSha256
        || priorCli.version !== transaction.state.installed.npmVersion) {
      failures.push('authority: retained CLI rollback bytes are missing or changed');
    }
    const retainedPackageBuild = await packageCliBuild({
      packageRoot: rollback.package,
      expectedVersion: transaction.state.installed.npmVersion,
      execute: invoke,
      environment,
      label: 'retained rollback'
    }).catch(() => null);
    if (!rollback.packageSha256
        || await packageTreeSha256(rollback.package).catch(() => null) !== rollback.packageSha256
        || retainedPackageBuild !== rollback.cliBuild) {
      failures.push('authority: retained CLI rollback package build is missing or changed');
    }
  }
  if (transaction.state.installed.vscodeVersion) {
    const priorVsix = await inspectVsix(rollback.vsix).catch(() => null);
    if (!priorVsix || priorVsix.sha256 !== rollback.vsixSha256
        || priorVsix.version !== transaction.state.installed.vscodeVersion) {
      failures.push('authority: retained VS Code rollback bytes are missing or changed');
    }
  }
  if (!transaction.state.installed.npmVersion && (
    transaction.state.installed.copilotPlugins.length
      || transaction.state.installed.managedDirectSkills.length
  )) {
    const plugin = await lstat(path.join(String(rollback.package ?? ''), 'plugin', 'plugin.json'))
      .catch(() => null);
    if (!plugin?.isFile() || plugin.isSymbolicLink()
        || !rollback.packageSha256
        || await packageTreeSha256(rollback.package).catch(() => null) !== rollback.packageSha256) {
      failures.push('authority: retained Copilot rollback package is missing or changed');
    }
  }
  for (const binding of transaction.state.skillSnapshots) {
    if (await packageTreeSha256(binding.snapshot).catch(() => null) !== binding.sha256
        || !await ordinaryManagedSkill(binding.snapshot)) {
      failures.push(`authority: retained direct-skill rollback bytes changed for ${binding.name}`);
    }
  }
  if (failures.length) {
    transaction.state = {
      ...transaction.state,
      status: 'rollback-failed',
      rollbackFailures: failures,
      updatedAt: new Date().toISOString()
    };
    await atomicJson(transaction.pending, transaction.state);
    throw new SingularityFlowError(
      `Distribution rollback authority failed closed: ${failures.join(' | ')}. `
      + `Recovery state was retained at ${transaction.pending}.`
    );
  }
  const attempt = async (surface, action) => {
    if (!surfaceWasTouched(transaction, surface)) return;
    try {
      await action();
      transaction.state.surfaces[surface] = 'restored';
      await atomicJson(transaction.pending, {
        ...transaction.state, updatedAt: new Date().toISOString()
      });
    } catch (error) { failures.push(`${surface}: ${error.message}`); }
  };
  await attempt('receipt', async () => {
    const current = transaction.state.files.find(({ target }) => path.basename(target) === 'current.json');
    if (current) await restoreRollbackFile(current);
    const installations = path.dirname(current?.target
      ?? path.join(homeDirectory, '.singularity-flow', 'installations', 'current.json'));
    const baseline = new Set(transaction.state.receiptBaseline);
    for (const name of await distributionReceiptInventory(
      installations, transaction.state.fingerprint
    )) {
      if (!baseline.has(name)) await rm(path.join(installations, name));
    }
  });
  await attempt('cli', async () => {
    if (transaction.state.installed.npmVersion) {
      executeOrThrow(invoke, 'npm', [
        'install', '--global', rollback.tarball, `--registry=${transaction.state.registry}`
      ], { env: { ...environment, NPM_CONFIG_REGISTRY: transaction.state.registry } });
    } else {
      invoke('npm', [
        'uninstall', '--global', '--ignore-scripts', REINSTALL_SURFACES.npmPackage
      ], { allowFailure: true });
    }
  });
  await attempt('telemetry', async () => {
    for (const binding of transaction.state.files.filter(({ target }) => path.basename(target) !== 'current.json')) {
      await restoreRollbackFile(binding);
    }
  });
  await attempt('skills', async () => {
    uninstallAliases({ targetRoot: transaction.state.skillsRoot });
    await mkdir(transaction.state.skillsRoot, { recursive: true, mode: 0o700 });
    for (const binding of transaction.state.skillSnapshots) {
      const target = path.join(transaction.state.skillsRoot, binding.name);
      const existing = await lstat(target).catch(() => null);
      if (existing) throw new SingularityFlowError(`Skill rollback target remained occupied: ${target}`);
      await cp(binding.snapshot, target, { recursive: true, force: false, errorOnExist: true });
      if (await packageTreeSha256(target) !== binding.sha256) {
        throw new SingularityFlowError(`Restored direct-skill bytes do not match: ${binding.name}`);
      }
    }
  });
  await attempt('copilot', async () => {
    for (const identity of REINSTALL_SURFACES.copilotPlugins) {
      invoke('copilot', ['plugin', 'uninstall', identity], { allowFailure: true });
    }
    if (transaction.state.installed.copilotPlugins.length) {
      executeOrThrow(invoke, 'copilot', [
        'plugin', 'install', path.join(rollback.package, 'plugin')
      ], { env: environment });
    }
  });
  await attempt('vscode', async () => {
    if (transaction.state.installed.vscodeVersion) {
      executeOrThrow(invoke, 'code', ['--install-extension', rollback.vsix, '--force'], {
        env: environment
      });
    } else {
      invoke('code', ['--uninstall-extension', REINSTALL_SURFACES.vscodeExtension], {
        allowFailure: true, env: environment
      });
    }
  });
  if (transaction.state.installed.npmVersion) {
    try {
      const restoredBuild = liveCliBuild(
        invoke, environment, transaction.state.installed.npmVersion, 'restored'
      );
      if (restoredBuild !== rollback.cliBuild) {
        transaction.state.surfaces.cli = 'verification-failed';
        failures.push(
          `CLI: restored build '${restoredBuild}' does not match '${rollback.cliBuild}'`
        );
      }
    } catch (error) {
      transaction.state.surfaces.cli = 'verification-failed';
      failures.push(`CLI: ${error.message}`);
    }
  }
  if (transaction.state.installed.copilotPlugins.length) {
    try {
      verifyPluginInstallation({
        execute: invoke,
        exists,
        expectedDirectSkills: transaction.state.installed.managedDirectSkills,
        targetRoot: transaction.state.skillsRoot,
        directSourceRoot: path.join(rollback.package, 'plugin', 'skills'),
        env: environment
      });
    } catch (error) {
      transaction.state.surfaces.copilot = 'verification-failed';
      failures.push(`Copilot: ${error.message}`);
    }
  }
  for (const binding of transaction.state.skillSnapshots) {
    const target = path.join(transaction.state.skillsRoot, binding.name);
    if (await packageTreeSha256(target).catch(() => null) !== binding.sha256
        || !await ordinaryManagedSkill(target)) {
      transaction.state.surfaces.skills = 'verification-failed';
      failures.push(`direct skills: restored bytes do not match for ${binding.name}`);
    }
  }
  if (failures.length) {
    transaction.state = {
      ...transaction.state,
      status: 'rollback-failed',
      rollbackFailures: failures,
      updatedAt: new Date().toISOString()
    };
    await atomicJson(transaction.pending, transaction.state);
    throw new SingularityFlowError(
      `Distribution install rollback could not restore every prior surface: ${failures.join(' | ')}. `
      + `Recovery state and exact rollback bytes were retained at ${transaction.pending}.`
    );
  }
  const observed = inspectLocalProduct({
    execute, exists, homeDirectory, environment, strict: true
  });
  const expected = transaction.state.installed;
  const mismatches = [];
  if (observed.npmVersion !== expected.npmVersion) mismatches.push('CLI');
  if (observed.vscodeVersion !== expected.vscodeVersion) mismatches.push('VS Code');
  if (JSON.stringify([...observed.copilotPlugins].sort())
      !== JSON.stringify([...expected.copilotPlugins].sort())) mismatches.push('Copilot');
  if (JSON.stringify(observed.managedDirectSkills) !== JSON.stringify(expected.managedDirectSkills)) mismatches.push('direct skills');
  if (observed.telemetryManaged !== expected.telemetryManaged
      || observed.telemetryProfileManaged !== expected.telemetryProfileManaged) mismatches.push('telemetry');
  if (mismatches.length) {
    transaction.state = {
      ...transaction.state,
      status: 'rollback-failed',
      rollbackFailures: [`verification: ${mismatches.join(', ')}`],
      updatedAt: new Date().toISOString()
    };
    await atomicJson(transaction.pending, transaction.state);
    throw new SingularityFlowError(
      `Distribution rollback verification did not reproduce the prior ${mismatches.join(', ')} state. `
      + `Recovery state was retained at ${transaction.pending}.`
    );
  }
  await finishDistributionTransaction(transaction, 'rolled-back');
}

/**
 * Recover an interrupted promoted-distribution install from its durable home-directory authority.
 * This entry point deliberately does not require the OS-temporary preview cache, so recovery still
 * works after a reboot or temporary-directory cleanup.
 */
export async function recoverPendingDistributionInstall({
  execute = run,
  exists = commandExists,
  homeDirectory = os.homedir(),
  environment = process.env,
  uninstallAliases = uninstallDirectSkills
} = {}) {
  const transaction = await loadDistributionTransaction({ homeDirectory, environment });
  if (!transaction) return { recovered: false, status: 'none' };
  const installations = path.join(homeDirectory, '.singularity-flow', 'installations');
  const activationJournal = path.join(installations, 'activation-current.json');
  const activationLease = await acquireActivationLease({
    journal: activationJournal,
    checkout: transaction.state.root,
    mode: 'create'
  });
  const env = {
    ...environment,
    NPM_CONFIG_REGISTRY: transaction.state.registry
  };
  const timeout = productTimeout(
    env, 'SINGULARITY_FLOW_PRODUCT_MUTATION_TIMEOUT_MS', PRODUCT_MUTATION_TIMEOUT_MS
  );
  const boundedExecute = (command, args, options = {}) => execute(command, args, {
    timeoutMs: options.timeoutMs ?? timeout,
    ...options
  });
  let failure = null;
  let result = null;
  try {
    if (['complete', 'rolled-back'].includes(transaction.state.status)) {
      const status = transaction.state.status;
      await finishDistributionTransaction(transaction, status);
      result = { recovered: true, status, fingerprint: transaction.state.fingerprint };
    } else {
      await rollbackDistributionTransaction(transaction, {
        execute: boundedExecute,
        exists,
        homeDirectory,
        environment: env,
        uninstallAliases
      });
      result = {
        recovered: true,
        status: 'rolled-back',
        fingerprint: transaction.state.fingerprint
      };
    }
  } catch (error) {
    failure = error;
  }
  let releaseFailure = null;
  try {
    await releaseActivationLease({ journal: activationJournal, ...activationLease });
  } catch (error) {
    releaseFailure = error;
  }
  if (failure && releaseFailure) {
    throw new SingularityFlowError(
      `${failure.message}\n\nThe shared activation lease could not be released safely: ${releaseFailure.message}`,
      { cause: failure }
    );
  }
  if (failure) throw failure;
  if (releaseFailure) throw releaseFailure;
  return result;
}

export async function applyLocalReinstall(plan, {
  confirmation,
  execute = run,
  exists = commandExists,
  homeDirectory = os.homedir(),
  environment = process.env,
  installAliases = installDirectSkills,
  beforeTelemetryProfileMutation = null
} = {}) {
  await validatePreparedPlan(plan);
  if (confirmation !== plan.confirmation) {
    throw new SingularityFlowError(`Reinstall requires exact confirmation '${plan.confirmation}'. Run with --dry-run first.`);
  }
  const machineState = await managedInstallDirectory(
    path.join(homeDirectory, '.singularity-flow'), 'Singularity Flow machine-state directory'
  );
  const installations = await managedInstallDirectory(
    path.join(machineState, 'installations'), 'Singularity Flow installation directory'
  );
  const activationJournal = path.join(installations, 'activation-current.json');
  const activationLease = await acquireActivationLease({
    journal: activationJournal,
    checkout: plan.checkout,
    mode: 'create'
  });
  const env = { ...environment, NPM_CONFIG_REGISTRY: plan.registry };
  const mutationTimeout = productTimeout(
    env, 'SINGULARITY_FLOW_PRODUCT_MUTATION_TIMEOUT_MS', PRODUCT_MUTATION_TIMEOUT_MS
  );
  const boundedExecute = (command, args, options = {}) => execute(command, args, {
    timeoutMs: options.timeoutMs ?? mutationTimeout,
    ...options
  });
  let removalStarted = false;
  let result = null;
  let operationFailure = null;
  let distributionTransaction = null;
  let interruptedSignal = null;
  const rememberSignal = (signal) => { interruptedSignal = interruptedSignal ?? signal; };
  const signalHandlers = new Map(
    ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => rememberSignal(signal)])
  );
  const refuseInterrupted = () => {
    if (interruptedSignal) {
      throw new SingularityFlowError(
        `Distribution installation was interrupted by ${interruptedSignal}; compensating rollback started.`
      );
    }
  };
  if (plan.operation === 'distribution-product-install') {
    for (const [signal, handler] of signalHandlers) process.once(signal, handler);
  }
  try {
    if (plan.operation === 'distribution-product-install') {
      const interrupted = await loadDistributionTransaction({ homeDirectory, environment: env });
      if (interrupted) {
        if (['complete', 'rolled-back'].includes(interrupted.state.status)) {
          await finishDistributionTransaction(interrupted, interrupted.state.status);
        } else {
          await rollbackDistributionTransaction(interrupted, {
            execute: boundedExecute, exists, homeDirectory, environment: env,
            uninstallAliases: uninstallDirectSkills
          });
        }
      }
    }
    const observedInstalled = inspectLocalProduct({
      execute, exists, homeDirectory, environment, strict: true
    });
    const installedState = (value) => ({
      npmVersion: value?.npmVersion ?? null,
      copilotAvailable: Boolean(value?.copilotAvailable),
      codeAvailable: Boolean(value?.codeAvailable),
      copilotPlugins: [...(value?.copilotPlugins ?? [])],
      vscodeVersion: value?.vscodeVersion ?? null,
      skillsRoot: path.resolve(String(value?.skillsRoot ?? '')),
      managedDirectSkills: [...(value?.managedDirectSkills ?? [])],
      telemetryWrapper: path.resolve(String(value?.telemetryWrapper ?? '')),
      telemetryManaged: Boolean(value?.telemetryManaged),
      managedTelemetryProfiles: [...(value?.managedTelemetryProfiles ?? [])]
        .map((entry) => path.resolve(entry)).sort(),
      telemetryProfileManaged: Boolean(value?.telemetryProfileManaged)
    });
    if (JSON.stringify(installedState(observedInstalled)) !== JSON.stringify(installedState(plan.installed))) {
      throw new SingularityFlowError(
        'Installed product state changed after preview. Preview again before replacing any surface.'
      );
    }
    if (plan.operation === 'distribution-product-install' && plan.installed.npmVersion) {
      const rollback = plan.distribution.rollback;
      const retainedBuild = await packageCliBuild({
        packageRoot: rollback.package,
        expectedVersion: plan.installed.npmVersion,
        execute: boundedExecute,
        environment: env,
        label: 'retained rollback'
      });
      const observedBuild = liveCliBuild(
        boundedExecute, env, plan.installed.npmVersion, 'currently installed'
      );
      if (retainedBuild !== rollback.cliBuild || observedBuild !== rollback.cliBuild) {
        throw new SingularityFlowError(
          `Installed CLI build changed after preview (retained '${retainedBuild}', live `
          + `'${observedBuild}', expected '${rollback.cliBuild}'). Preview again before replacing any surface.`
        );
      }
    }
    if (plan.cliOnly) {
      const installed = inspectLocalProduct({
        execute, exists, homeDirectory, environment: env, strict: true
      });
      await assertCliOnlyVsixRollbackAuthority({
        cliOnly: true, installed, homeDirectory, checkout: plan.checkout
      });
    }
    // Reconstruct the executable and plugin inputs from the exact retained tarball immediately
    // before activation. The preview cache is mutable machine state and is never executable
    // authority, even though the tarball itself is digest-bound by the confirmed plan.
    const candidatePrefix = path.join(plan.bundle.stagingParent, 'candidate-package');
    await rm(candidatePrefix, { recursive: true, force: true });
    const candidateSource = await stageDistributionPackage({
      tarball: plan.bundle.tarball,
      directory: plan.bundle.stagingParent,
      registry: plan.registry,
      execute: boundedExecute,
      environment: env
    });
    if (plan.operation === 'distribution-product-install'
        && path.resolve(candidateSource) !== path.resolve(plan.bundle.source)) {
      throw new SingularityFlowError(
        'The verified distribution package did not re-extract to its fingerprinted private path.'
      );
    }
    const expectedCliBuild = await admittedCliBuild(plan, candidateSource, boundedExecute, env);
    if (plan.operation === 'distribution-product-install') {
      distributionTransaction = await beginDistributionTransaction(plan, {
        homeDirectory, environment: env
      });
    }
    refuseInterrupted();
    removalStarted = true;
    let expectedDirectSkills = [];
    if (!plan.cliOnly) {
      if (plan.installed.codeAvailable) {
        if (distributionTransaction) {
          await updateDistributionTransaction(distributionTransaction, 'vscode', 'pending');
        }
        executeOrThrow(boundedExecute, 'code', ['--install-extension', plan.bundle.vsix, '--force'], {
          env, stdio: 'inherit', timeoutMs: mutationTimeout
        });
        if (distributionTransaction) {
          await updateDistributionTransaction(distributionTransaction, 'vscode', 'applied');
        }
      }
      refuseInterrupted();
      if (distributionTransaction) {
        await updateDistributionTransaction(distributionTransaction, 'copilot', 'pending');
      }
      for (const identity of REINSTALL_SURFACES.copilotPlugins) {
        boundedExecute('copilot', ['plugin', 'uninstall', identity], {
          allowFailure: true, env, timeoutMs: mutationTimeout
        });
      }
      // Use the already admitted candidate package, never the old global CLI, while the callable
      // global CLI remains untouched. Distribution runs use the package executing this process;
      // source reinstall uses the isolated, validated source copy that produced the tarball.
      const candidatePluginRoot = path.join(candidateSource, 'plugin');
      executeOrThrow(boundedExecute, 'copilot', ['plugin', 'install', candidatePluginRoot], {
        env, stdio: 'inherit', timeoutMs: mutationTimeout
      });
      if (distributionTransaction) {
        await updateDistributionTransaction(distributionTransaction, 'copilot', 'applied');
        await updateDistributionTransaction(distributionTransaction, 'skills', 'pending');
      }
      const aliases = installAliases({
        sourceRoot: path.join(candidatePluginRoot, 'skills'), targetRoot: plan.installed.skillsRoot
      });
      expectedDirectSkills = aliases.installed;
      if (distributionTransaction) {
        await updateDistributionTransaction(distributionTransaction, 'skills', 'applied');
      }
      verifyPluginInstallation({
        execute: boundedExecute, exists, expectedDirectSkills, targetRoot: plan.installed.skillsRoot,
        directSourceRoot: path.join(candidatePluginRoot, 'skills'), env
      });
      if (distributionTransaction) {
        await updateDistributionTransaction(distributionTransaction, 'telemetry', 'pending');
      }
      await replaceTelemetryWrapper({
        homeDirectory,
        environment: env,
        enabled: plan.telemetry,
        beforeProfileMutation: beforeTelemetryProfileMutation
      });
      if (distributionTransaction) {
        await updateDistributionTransaction(distributionTransaction, 'telemetry', 'applied');
      }
    }
    refuseInterrupted();
    // The globally callable CLI is the final mutable product surface. Any earlier refusal leaves a
    // known working CLI available to run the exact recovery command printed below.
    if (distributionTransaction) {
      await updateDistributionTransaction(distributionTransaction, 'cli', 'pending');
    }
    executeOrThrow(boundedExecute, 'npm', [
      'install', '--global', plan.bundle.tarball, `--registry=${plan.registry}`
    ], { env, stdio: 'inherit', timeoutMs: mutationTimeout });
    if (distributionTransaction) {
      await updateDistributionTransaction(distributionTransaction, 'cli', 'applied');
    }
    refuseInterrupted();
    const cliVersion = executeOrThrow(boundedExecute, 'singularity-flow', ['--version'], {
      env,
      timeoutMs: productTimeout(env, 'SINGULARITY_FLOW_PRODUCT_READ_TIMEOUT_MS', PRODUCT_READ_TIMEOUT_MS)
    }).stdout.trim();
    if (cliVersion !== plan.version) {
      throw new SingularityFlowError(`Installed CLI reports ${cliVersion || 'no version'}, expected ${plan.version}.`);
    }
    const cliBuild = executeOrThrow(boundedExecute, 'singularity-flow', ['--build'], {
      env,
      timeoutMs: productTimeout(env, 'SINGULARITY_FLOW_PRODUCT_READ_TIMEOUT_MS', PRODUCT_READ_TIMEOUT_MS)
    }).stdout.trim();
    if (cliBuild !== expectedCliBuild) {
      throw new SingularityFlowError(
        `Installed CLI build '${cliBuild || 'unavailable'}' does not match the admitted candidate build '${expectedCliBuild}'.`
      );
    }
    if (!plan.cliOnly) {
      executeOrThrow(boundedExecute, 'singularity-flow', ['plugin', 'verify', '--json'], {
        env,
        timeoutMs: productTimeout(env, 'SINGULARITY_FLOW_PRODUCT_READ_TIMEOUT_MS', PRODUCT_READ_TIMEOUT_MS)
      });
    }
    const verified = {
      ...inspectLocalProduct({
        execute, exists, homeDirectory, environment: env, strict: true
      }),
      cliBuild
    };
    if (!plan.cliOnly && !verified.copilotPlugins.length) throw new SingularityFlowError('Copilot plugin verification did not find Singularity Flow.');
    if (!plan.cliOnly && JSON.stringify(verified.managedDirectSkills) !== JSON.stringify(expectedDirectSkills)) {
      throw new SingularityFlowError(
        `Managed direct-skill verification found ${verified.managedDirectSkills.length}, expected ${expectedDirectSkills.length}.`
      );
    }
    if (!plan.cliOnly && plan.installed.codeAvailable && verified.vscodeVersion !== plan.version) {
      throw new SingularityFlowError(`Installed VS Code extension reports ${verified.vscodeVersion ?? 'no version'}, expected ${plan.version}.`);
    }
    const expectedTelemetryProfile = !plan.cliOnly && plan.telemetry
      ? selectedTelemetryProfile(homeDirectory, env) : null;
    if (!plan.cliOnly && plan.telemetry && (!verified.telemetryManaged
        || (expectedTelemetryProfile
          && !verified.managedTelemetryProfiles.includes(path.resolve(expectedTelemetryProfile))))) {
      throw new SingularityFlowError(
        'Managed Copilot telemetry helper or its shell-profile activation could not be verified.'
      );
    }
    if (!plan.cliOnly && !plan.telemetry && (verified.telemetryManaged
        || verified.managedTelemetryProfiles.length)) {
      throw new SingularityFlowError(
        'Copilot telemetry opt-out could not remove every installer-managed helper and profile activation.'
      );
    }
    const receipt = {
      schemaVersion: 1,
      operation: plan.operation,
      fingerprint: plan.fingerprint,
      checkout: plan.checkout,
      version: plan.version,
      registry: plan.registry,
      cliOnly: plan.cliOnly,
      completedAt: new Date().toISOString(),
      artifacts: plan.artifacts,
      verified
    };
    if (distributionTransaction) {
      await updateDistributionTransaction(distributionTransaction, 'receipt', 'pending');
    }
    receipt.receipt = await writeReceipt(plan, receipt, homeDirectory);
    receipt.installationManifest = await writeCurrentInstallationReceipt(
      plan, verified, receipt.receipt, homeDirectory
    );
    if (distributionTransaction) {
      await updateDistributionTransaction(distributionTransaction, 'receipt', 'applied');
      await finishDistributionTransaction(distributionTransaction, 'complete');
      distributionTransaction = null;
    }
    result = {
      ...plan,
      completed: true,
      verified,
      receipt: receipt.receipt,
      installationManifest: receipt.installationManifest
    };
  } catch (error) {
    let rollbackFailure = null;
    if (distributionTransaction) {
      try {
        await rollbackDistributionTransaction(distributionTransaction, {
          execute: boundedExecute, exists, homeDirectory, environment: env,
          uninstallAliases: uninstallDirectSkills
        });
        distributionTransaction = null;
      } catch (failure) { rollbackFailure = failure; }
    }
    const suffix = rollbackFailure
      ? `\n\n${rollbackFailure.message}`
      : removalStarted && plan.operation === 'distribution-product-install'
        ? '\n\nEvery touched product surface was restored and verified against the pre-install snapshot.'
        : '';
    operationFailure = removalStarted
      ? new SingularityFlowError(`${error.message}${suffix}\n\n${recoveryText(plan)}`, { cause: error })
      : error;
  } finally {
    if (plan.operation === 'distribution-product-install') {
      for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    }
  }
  let releaseFailure = null;
  try {
    await releaseActivationLease({ journal: activationJournal, ...activationLease });
  } catch (error) {
    releaseFailure = error;
  }
  if (operationFailure && releaseFailure) {
    throw new SingularityFlowError(
      `${operationFailure.message}\n\nThe shared activation lease could not be released safely: ${releaseFailure.message}`,
      { cause: operationFailure }
    );
  }
  if (operationFailure) throw operationFailure;
  if (releaseFailure) throw releaseFailure;
  return result;
}

export async function resolveReinstallPlan({
  checkout,
  confirmation,
  registry,
  cliOnly,
  telemetry,
  tempRoot = os.tmpdir(),
  ...dependencies
}) {
  const supplied = String(confirmation ?? '');
  if (supplied) {
    if (!supplied.startsWith(CONFIRMATION_PREFIX)) {
      throw new SingularityFlowError('The reinstall confirmation is not valid. Run --dry-run and copy its exact confirmation.');
    }
    const fingerprint = supplied.slice(CONFIRMATION_PREFIX.length).trim();
    if (!/^[0-9a-f]{16}$/.test(fingerprint)) {
      throw new SingularityFlowError('The reinstall confirmation fingerprint is not valid. Run --dry-run again.');
    }
    const cached = await loadCachedPlan(fingerprint, tempRoot);
    if (!cached) {
      throw new SingularityFlowError('No validated reinstall preview matches this confirmation. Run --dry-run again.');
    }
    const resolvedCheckout = await realpath(path.resolve(checkout)).catch(() => path.resolve(checkout));
    if (resolvedCheckout !== path.resolve(cached.checkout)) {
      throw new SingularityFlowError('The confirmation belongs to a different source checkout. Run --dry-run for this checkout.');
    }
    if (registry && normalizeReinstallRegistry(registry) !== cached.registry) {
      throw new SingularityFlowError('The confirmation belongs to a different npm registry. Run --dry-run with the requested registry.');
    }
    if (Boolean(cliOnly) !== Boolean(cached.cliOnly) || Boolean(telemetry) !== Boolean(cached.telemetry)) {
      throw new SingularityFlowError('The confirmation belongs to different reinstall options. Run --dry-run with the requested options.');
    }
    return validatePreparedPlan(cached);
  }
  return prepareLocalReinstall({ checkout, registry, cliOnly, telemetry, tempRoot, ...dependencies });
}

export async function resolveDistributionInstallPlan({
  releaseDirectory,
  artifactKey,
  confirmation,
  registry,
  cliOnly,
  telemetry,
  environment = process.env,
  tempRoot = os.tmpdir(),
  ...dependencies
}) {
  const directory = await realpath(path.resolve(releaseDirectory)).catch(() => path.resolve(releaseDirectory));
  const originDirectory = distributionOriginPath(
    environment,
    'SINGULARITY_FLOW_DISTRIBUTION_ORIGIN_RELEASE_DIR',
    directory
  );
  const supplied = String(confirmation ?? '');
  if (supplied) {
    const prefix = 'INSTALL SINGULARITY FLOW ';
    if (!supplied.startsWith(prefix)) {
      throw new SingularityFlowError('The distribution install confirmation is invalid. Run --dry-run and copy its exact confirmation.');
    }
    const fingerprint = supplied.slice(prefix.length).trim();
    if (!/^[0-9a-f]{16}$/u.test(fingerprint)) {
      throw new SingularityFlowError('The distribution install fingerprint is invalid. Run --dry-run again.');
    }
    let cached = await loadCachedPlan(fingerprint, tempRoot);
    if (!cached) {
      const rebuilt = await prepareDistributionInstall({
        releaseDirectory: directory,
        artifactKey,
        registry,
        cliOnly,
        telemetry,
        environment,
        tempRoot,
        ...dependencies
      });
      if (rebuilt.confirmation !== supplied) {
        throw new SingularityFlowError(
          'The validated distribution state changed after the original preview. Review a new --dry-run confirmation.'
        );
      }
      cached = rebuilt;
    }
    if (cached.operation !== 'distribution-product-install') {
      throw new SingularityFlowError('No validated distribution preview matches this confirmation. Run --dry-run again.');
    }
    if (originDirectory !== path.resolve(cached.checkout)) {
      throw new SingularityFlowError('The confirmation belongs to a different release directory. Run --dry-run for this directory.');
    }
    if (registry && normalizeReinstallRegistry(registry) !== cached.registry) {
      throw new SingularityFlowError('The confirmation belongs to a different npm registry. Run --dry-run with that registry.');
    }
    if (Boolean(cliOnly) !== Boolean(cached.cliOnly) || Boolean(telemetry) !== Boolean(cached.telemetry)) {
      throw new SingularityFlowError('The confirmation belongs to different installation options. Run --dry-run with those options.');
    }
    const key = await readSecurePublicKey(artifactKey, {
      repository: directory,
      label: 'Trusted artifact-builder public key'
    });
    const originKeyPath = distributionOriginPath(
      environment,
      'SINGULARITY_FLOW_DISTRIBUTION_ORIGIN_ARTIFACT_KEY',
      key.path
    );
    let keyDigest;
    try {
      const publicKey = createPublicKey(key.bytes);
      keyDigest = `sha256:${sha256(publicKey.export({ type: 'spki', format: 'der' }))}`;
    } catch {
      throw new SingularityFlowError('The trusted artifact-builder public key is invalid.');
    }
    if (originKeyPath !== cached.distribution?.artifactKeyPath
        || keyDigest !== cached.distribution?.authority?.signerKeySha256) {
      throw new SingularityFlowError(
        'The confirmation belongs to a different trusted artifact-builder key. Run --dry-run with this key.'
      );
    }
    return validatePreparedPlan(cached);
  }
  return prepareDistributionInstall({
    releaseDirectory: directory, artifactKey, registry, cliOnly, telemetry, environment, tempRoot,
    ...dependencies
  });
}

function applyCommandArgv(plan, executable) {
  const parts = [executable];
  if (executable === 'singularity-flow') parts.push('reinstall');
  parts.push(
    '--checkout', plan.checkout,
    '--registry', plan.registry,
    '--confirm', plan.confirmation
  );
  if (plan.cliOnly) parts.push('--cli-only');
  if (!plan.telemetry && !plan.cliOnly) parts.push('--no-copilot-telemetry');
  return parts;
}

function completedActivationOutcome(plan) {
  if (plan.cliOnly || !plan.telemetry) return 'PARTIAL BY REQUEST';
  if (plan.verified?.codeAvailable === false) return 'COMPLETE WITH SKIPS';
  return 'COMPLETE AND VERIFIED';
}

export function reinstallPlanText(plan) {
  const heading = plan.completed
    ? 'Singularity Flow local product reinstall — result'
    : 'Singularity Flow local product reinstall — preview';
  const lines = [
    heading,
    `Checkout: ${plan.checkout}`,
    `Version: ${plan.version}`,
    `Registry: ${plan.registry}`,
    `Bundle fingerprint: ${plan.fingerprint}`,
    '',
    'Replace:',
    ...plan.remove.map((item) => `- ${item}`),
    '',
    'Preserve:',
    ...plan.preserve.map((item) => `- ${item}`)
  ];
  if (!plan.completed) {
    const artifacts = plan.cliOnly
      ? 'The isolated CLI build, reinstall safety tests, and npm tarball completed before this preview.'
      : 'The isolated CLI and VS Code builds, reinstall safety tests, npm tarball, and VSIX completed before this preview.';
    lines.push('', artifacts,
      'Candidate artifacts are staged only; product activation has not started.',
      'No Git command was run and no installed product or repository was changed.',
      `Confirmation required: ${plan.confirmation}`,
      ...renderedShellLines(applyCommandArgv(plan, 'singularity-flow'), '', {
        posixLabel: 'Shell'
      }),
      `Copilot: ${copilotSkillForCommand('singularity-flow reinstall')}`,
      ...renderedShellLines(applyCommandArgv(plan, 'sf-reinstall'), '', {
        posixLabel: 'Short shell alias', windowsQualifier: 'Short alias — '
      }));
  } else {
    lines.push(
      '',
      `Installed CLI build: ${plan.verified?.cliBuild ?? 'unavailable'}`,
      `Copilot plugin and managed skills: ${plan.cliOnly ? 'not selected' : 'verified through the installed CLI'}`,
      `VS Code extension: ${plan.cliOnly ? 'not selected' : plan.verified?.vscodeVersion ?? 'skipped because the code CLI was unavailable'}`,
      `Installation receipt: ${plan.receipt}`,
      'Selected product surfaces and their exact build identity were verified after activation.',
      'Repository and workspace data were preserved.',
      '',
      `Singularity Flow product activation — ${completedActivationOutcome(plan)}`
    );
  }
  return lines.join('\n');
}

export function distributionInstallPlanText(plan) {
  const heading = plan.completed
    ? 'Singularity Flow distribution install — result'
    : 'Singularity Flow distribution install — preview';
  const lines = [
    heading,
    `Release directory: ${plan.checkout}`,
    `Version: ${plan.version}`,
    `Bundle fingerprint: ${plan.fingerprint}`,
    '',
    'Replace or install:',
    ...plan.remove.map((item) => `- ${item}`),
    '',
    'Preserve:',
    ...plan.preserve.map((item) => `- ${item}`)
  ];
  if (!plan.completed) {
    const command = [
      plan.distribution.entrypoint ?? 'sf-install',
      ...(plan.distribution.entrypoint ? [] : ['--release-dir', plan.checkout]),
      '--artifact-key', plan.distribution.artifactKeyPath,
      '--confirm', plan.confirmation,
      ...(plan.cliOnly ? ['--cli-only'] : []),
      ...(!plan.telemetry && !plan.cliOnly ? ['--no-copilot-telemetry'] : [])
    ];
    lines.push(
      '',
      'The release manifest, checksums, npm package identity, VSIX identity, and version match.',
      'Candidate artifacts are staged only; product activation has not started.',
      'No Git command was run and no installed product or repository was changed.',
      `Confirmation required: ${plan.confirmation}`,
      ...renderedShellLines(command, '', { posixLabel: 'Shell' }),
      'Copilot: unavailable until installation completes; this machine-level operation intentionally has no chat mutation.'
    );
  } else {
    lines.push(
      '',
      `Installed CLI build: ${plan.verified?.cliBuild ?? 'unavailable'}`,
      `Copilot plugin and managed skills: ${plan.cliOnly ? 'not selected' : 'verified through the installed CLI'}`,
      `VS Code extension: ${plan.cliOnly ? 'not selected' : plan.verified?.vscodeVersion ?? 'skipped because the code CLI was unavailable'}`,
      `Installation receipt: ${plan.receipt}`,
      'Selected product surfaces and their exact build identity were verified after activation.',
      'Repository, workspace, credential, and personal-skill data were preserved.',
      '',
      `Singularity Flow product activation — ${completedActivationOutcome(plan)}`
    );
  }
  return lines.join('\n');
}
