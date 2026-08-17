import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {
  access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installDirectSkills, isManagedDirectSkill, uninstallDirectSkills } from './direct-skills.mjs';
import { commandExists, run, SingularityFlowError } from './util.mjs';

export const REINSTALL_SURFACES = Object.freeze({
  npmPackage: 'singularity-flow',
  copilotPlugins: Object.freeze(['singularity-flow', 'singularity-flow@singularity-flow']),
  directSkillPrefix: 'sf-',
  vscodeExtension: 'singularityflow.singularity-flow-vscode',
  telemetryWrapper: '.singularity-flow/copilot-otel.sh'
});

const CONFIRMATION_PREFIX = 'REINSTALL SINGULARITY FLOW ';
const PLAN_SCHEMA_VERSION = 1;
const MANAGED_TELEMETRY_MARKER = '# Managed by the Singularity Flow installer.';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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

function installedNpmVersion(execute) {
  const result = execute('npm', ['list', '--global', REINSTALL_SURFACES.npmPackage, '--depth=0', '--json'], { allowFailure: true });
  try { return JSON.parse(result.stdout || '{}')?.dependencies?.[REINSTALL_SURFACES.npmPackage]?.version ?? null; }
  catch { return null; }
}

function managedDirectSkillInventory({ targetRoot }) {
  if (!fs.existsSync(targetRoot)) return [];
  return fs.readdirSync(targetRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(REINSTALL_SURFACES.directSkillPrefix))
    .filter((entry) => {
      try { return isManagedDirectSkill(fs.readFileSync(path.join(targetRoot, entry.name, 'SKILL.md'), 'utf8')); }
      catch { return false; }
    })
    .map((entry) => entry.name)
    .sort();
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
  environment = process.env
} = {}) {
  const skillsRoot = path.resolve(
    environment.SINGULARITY_FLOW_COPILOT_SKILLS_DIR
      || path.join(environment.COPILOT_HOME || path.join(homeDirectory, '.copilot'), 'skills')
  );
  const copilotAvailable = exists('copilot');
  const codeAvailable = exists('code');
  const plugins = copilotAvailable
    ? execute('copilot', ['plugin', 'list'], { allowFailure: true }).stdout
    : '';
  const extensions = codeAvailable
    ? execute('code', ['--list-extensions', '--show-versions'], { allowFailure: true }).stdout
    : '';
  const extensionLine = extensions.split(/\r?\n/).find((line) => line.toLowerCase().startsWith(`${REINSTALL_SURFACES.vscodeExtension}@`));
  return {
    npmVersion: installedNpmVersion(execute),
    copilotAvailable,
    codeAvailable,
    copilotPlugins: installedCopilotPluginIdentities(plugins),
    vscodeVersion: extensionLine?.split('@').at(-1) ?? null,
    skillsRoot,
    managedDirectSkills: managedDirectSkillInventory({ targetRoot: skillsRoot }),
    telemetryWrapper: path.join(homeDirectory, REINSTALL_SURFACES.telemetryWrapper),
    telemetryManaged: (() => {
      try { return fs.readFileSync(path.join(homeDirectory, REINSTALL_SURFACES.telemetryWrapper), 'utf8').startsWith(MANAGED_TELEMETRY_MARKER); }
      catch { return false; }
    })()
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
  // Validation is isolated from the user's npm cache as well as the checkout. A preview may
  // download dependencies, but every temporary byte stays inside the content-addressed plan.
  const env = { ...process.env, NPM_CONFIG_REGISTRY: registry, NPM_CONFIG_CACHE: npmCache };
  log(`Building validated reinstall bundle under ${stagingParent}`);
  executeOrThrow(execute, 'npm', ['ci', ...(cliOnly ? ['--workspaces=false'] : []), `--registry=${registry}`], { cwd: source, env, stdio: 'inherit' });
  if (!cliOnly) {
    executeOrThrow(execute, 'npm', ['run', 'vscode:typecheck'], { cwd: source, env, stdio: 'inherit' });
    executeOrThrow(execute, 'npm', ['run', 'vscode:build'], { cwd: source, env, stdio: 'inherit' });
  }
  // The product reinstall contract forbids Git access. The full project test/check
  // commands inspect Git metadata, so this transaction runs a focused safety suite
  // that covers its package, plugin, and direct-skill surfaces without invoking Git.
  executeOrThrow(execute, 'npm', ['run', 'test:reinstall'], { cwd: source, env, stdio: 'inherit' });
  executeOrThrow(execute, 'npm', ['pack', '--pack-destination', artifacts, `--registry=${registry}`], { cwd: source, env, stdio: 'inherit' });
  const tarball = await findPackedFile(artifacts, '.tgz');
  let vsix = null;
  if (!cliOnly) {
    executeOrThrow(execute, 'npm', ['run', 'vscode:package'], { cwd: source, env, stdio: 'inherit' });
    const packaged = await findPackedFile(path.join(source, 'apps', 'vscode'), '.vsix');
    vsix = path.join(artifacts, path.basename(packaged));
    await fs.promises.copyFile(packaged, vsix);
  }
  return { stagingParent, source, artifacts, tarball, vsix };
}

function reinstallFingerprint({ checkout, version, tarballSha256, vsixSha256 }) {
  return sha256(JSON.stringify({ checkout, version, tarballSha256, vsixSha256 })).slice(0, 16);
}

async function fileHash(file) {
  return file ? sha256(await readFile(file)) : null;
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
  const validated = await validateReinstallCheckout(requestedCheckout);
  if (!exists('npm') || !exists('node')) throw new SingularityFlowError('Reinstall requires the existing node and npm commands on PATH.');
  if (!cliOnly && !exists('copilot')) {
    throw new SingularityFlowError('Copilot CLI was not found. Install it first, or use --cli-only to replace only the Node CLI.');
  }
  const effectiveRegistry = normalizeReinstallRegistry(registry || execute('npm', ['config', 'get', 'registry'], { allowFailure: true }).stdout.trim());
  const installed = inspectLocalProduct({ execute, exists, homeDirectory, environment });
  const sourceSha256 = await reinstallSourceDigest(validated.checkout);
  const bundle = await build({ checkout: validated.checkout, registry: effectiveRegistry, cliOnly, execute, tempRoot, log });
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
      'global npm package singularity-flow and only its npm-created command shims',
      ...(cliOnly ? [] : [
        `Copilot plugin identities: ${REINSTALL_SURFACES.copilotPlugins.join(', ')}`,
        'managed direct /sf-* skills carrying the Singularity Flow ownership marker',
        `VS Code extension ${REINSTALL_SURFACES.vscodeExtension}${installed.codeAvailable ? '' : ' (code CLI unavailable; skipped)'}`,
        'installer-managed Copilot telemetry wrapper'
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

async function loadCachedPlan(fingerprint, tempRoot) {
  const file = path.join(planCacheRoot(tempRoot), fingerprint, 'reinstall-plan.json');
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return null; }
}

async function validatePreparedPlan(plan) {
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION || plan.operation !== 'local-product-reinstall') {
    throw new SingularityFlowError('The prepared reinstall plan is not supported. Create a new --dry-run preview.');
  }
  if (await reinstallSourceDigest(plan.checkout) !== plan.sourceSha256) {
    throw new SingularityFlowError('The source checkout changed after the preview. Run reinstall --dry-run again and use its new confirmation.');
  }
  if (await fileHash(plan.bundle.tarball) !== plan.artifacts.tarballSha256
      || await fileHash(plan.bundle.vsix) !== plan.artifacts.vsixSha256) {
    throw new SingularityFlowError('The prepared reinstall bundle changed after validation. Run reinstall --dry-run again.');
  }
  const fingerprint = reinstallFingerprint({
    checkout: plan.checkout,
    version: plan.version,
    tarballSha256: plan.artifacts.tarballSha256,
    vsixSha256: plan.artifacts.vsixSha256
  });
  if (plan.fingerprint !== fingerprint || plan.confirmation !== `${CONFIRMATION_PREFIX}${fingerprint}`) {
    throw new SingularityFlowError('The prepared reinstall plan does not match its fingerprint. Run reinstall --dry-run again.');
  }
  return plan;
}

async function installedPluginRoot(execute, environment, expectedVersion) {
  const npmRoot = executeOrThrow(execute, 'npm', ['root', '--global'], { env: environment }).stdout.trim();
  if (!npmRoot) throw new SingularityFlowError('npm did not report its global package directory after installation.');
  const installedPackageDirectory = path.join(npmRoot, REINSTALL_SURFACES.npmPackage);
  const packageFile = path.join(installedPackageDirectory, 'package.json');
  const pluginFile = path.join(installedPackageDirectory, 'plugin', 'plugin.json');
  await regularFile(packageFile, 'installed package.json');
  await regularFile(pluginFile, 'installed plugin/plugin.json');
  const [product, plugin] = await Promise.all([
    readFile(packageFile, 'utf8').then(JSON.parse),
    readFile(pluginFile, 'utf8').then(JSON.parse)
  ]).catch((error) => {
    throw new SingularityFlowError(`Unable to verify the installed Copilot plugin: ${error.message}`);
  });
  if (product.name !== REINSTALL_SURFACES.npmPackage || product.version !== expectedVersion
      || plugin.name !== 'singularity-flow' || plugin.version !== expectedVersion) {
    throw new SingularityFlowError('The installed npm package does not contain the expected versioned Copilot plugin.');
  }
  return path.join(installedPackageDirectory, 'plugin');
}

function renderTelemetryWrapper() {
  return `${MANAGED_TELEMETRY_MARKER}\n` +
    '# Records model, token, timing, and cost metadata. Prompt/response content remains disabled.\n' +
    'copilot() {\n' +
    '  local sflow_git_dir sflow_telemetry_file\n' +
    '  sflow_git_dir="$(command git rev-parse --absolute-git-dir 2>/dev/null || true)"\n' +
    '  if [ -n "$sflow_git_dir" ] && [ -z "${COPILOT_OTEL_FILE_EXPORTER_PATH:-}" ] && [ -z "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ] && [ -z "${COPILOT_OTEL_ENABLED:-}" ]; then\n' +
    '    sflow_telemetry_file="$sflow_git_dir/singularity-flow/copilot-otel.jsonl"\n' +
    '    command mkdir -p "$sflow_git_dir/singularity-flow"\n' +
    '    command touch "$sflow_telemetry_file"\n' +
    '    command chmod 600 "$sflow_telemetry_file"\n' +
    '    COPILOT_OTEL_ENABLED=true COPILOT_OTEL_EXPORTER_TYPE=file COPILOT_OTEL_FILE_EXPORTER_PATH="$sflow_telemetry_file" command copilot "$@"\n' +
    '  else\n    command copilot "$@"\n  fi\n}\n';
}

async function replaceTelemetryWrapper({ homeDirectory, enabled }) {
  const file = path.join(homeDirectory, REINSTALL_SURFACES.telemetryWrapper);
  const current = await readFile(file, 'utf8').catch(() => null);
  if (current && !current.startsWith(MANAGED_TELEMETRY_MARKER)) {
    return { enabled: null, file, preservedPersonalFile: true };
  }
  if (!enabled) {
    if (current) await fs.promises.unlink(file);
    return { enabled: false, file };
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.reinstall-${process.pid}`;
  await writeFile(temporary, renderTelemetryWrapper(), { mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
  return { enabled: true, file };
}

function recoveryText(plan) {
  const lines = [
    'Validated recovery bundle retained locally. Retry the complete transaction with:',
    `  sf-reinstall --checkout ${JSON.stringify(plan.checkout)} --confirm ${JSON.stringify(plan.confirmation)}${plan.cliOnly ? ' --cli-only' : ''}`,
    'Or restore individual surfaces with:',
    `  npm install --global ${JSON.stringify(plan.bundle.tarball)} --registry=${JSON.stringify(plan.registry)}`
  ];
  if (!plan.cliOnly && plan.bundle.vsix) lines.push(`  code --install-extension ${JSON.stringify(plan.bundle.vsix)} --force`);
  if (!plan.cliOnly) lines.push('  singularity-flow plugin install');
  return lines.join('\n');
}

async function writeReceipt(plan, receipt, homeDirectory) {
  const directory = path.join(homeDirectory, '.singularity-flow', 'installations');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stamp = receipt.completedAt.replace(/[:.]/g, '-');
  const file = path.join(directory, `reinstall-${stamp}-${plan.fingerprint}.json`);
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export async function applyLocalReinstall(plan, {
  confirmation,
  execute = run,
  exists = commandExists,
  homeDirectory = os.homedir(),
  environment = process.env,
  installAliases = installDirectSkills,
  uninstallAliases = uninstallDirectSkills
} = {}) {
  await validatePreparedPlan(plan);
  if (confirmation !== plan.confirmation) {
    throw new SingularityFlowError(`Reinstall requires exact confirmation '${plan.confirmation}'. Run with --dry-run first.`);
  }
  const env = { ...environment, NPM_CONFIG_REGISTRY: plan.registry };
  let removalStarted = false;
  try {
    removalStarted = true;
    if (!plan.cliOnly) {
      for (const identity of REINSTALL_SURFACES.copilotPlugins) {
        execute('copilot', ['plugin', 'uninstall', identity], { allowFailure: true, env });
      }
      uninstallAliases({ targetRoot: plan.installed.skillsRoot });
      if (plan.installed.codeAvailable) {
        execute('code', ['--uninstall-extension', REINSTALL_SURFACES.vscodeExtension], { allowFailure: true, env });
      }
      await replaceTelemetryWrapper({ homeDirectory, enabled: false });
    }
    execute('npm', ['uninstall', '--global', REINSTALL_SURFACES.npmPackage], { allowFailure: true, env });
    executeOrThrow(execute, 'npm', ['install', '--global', plan.bundle.tarball, `--registry=${plan.registry}`], { env, stdio: 'inherit' });
    const cliVersion = executeOrThrow(execute, 'singularity-flow', ['--version'], { env }).stdout.trim();
    if (cliVersion !== plan.version) throw new SingularityFlowError(`Installed CLI reports ${cliVersion || 'no version'}, expected ${plan.version}.`);
    let expectedDirectSkills = [];
    if (!plan.cliOnly) {
      if (plan.installed.codeAvailable) {
        executeOrThrow(execute, 'code', ['--install-extension', plan.bundle.vsix, '--force'], { env, stdio: 'inherit' });
      }
      // Install Copilot assets from the already verified global npm package, not from the mutable
      // checkout or build cache. That keeps every installed byte anchored to the validated tarball.
      const pluginRoot = await installedPluginRoot(execute, env, plan.version);
      executeOrThrow(execute, 'copilot', ['plugin', 'install', pluginRoot], { env, stdio: 'inherit' });
      const aliases = installAliases({ sourceRoot: path.join(pluginRoot, 'skills'), targetRoot: plan.installed.skillsRoot });
      expectedDirectSkills = aliases.installed;
      await replaceTelemetryWrapper({ homeDirectory, enabled: plan.telemetry });
    }
    const verified = inspectLocalProduct({ execute, exists, homeDirectory, environment: env });
    if (!plan.cliOnly && !verified.copilotPlugins.length) throw new SingularityFlowError('Copilot plugin verification did not find Singularity Flow.');
    if (!plan.cliOnly && JSON.stringify(verified.managedDirectSkills) !== JSON.stringify(expectedDirectSkills)) {
      throw new SingularityFlowError(
        `Managed direct-skill verification found ${verified.managedDirectSkills.length}, expected ${expectedDirectSkills.length}.`
      );
    }
    if (!plan.cliOnly && plan.installed.codeAvailable && verified.vscodeVersion !== plan.version) {
      throw new SingularityFlowError(`Installed VS Code extension reports ${verified.vscodeVersion ?? 'no version'}, expected ${plan.version}.`);
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
    receipt.receipt = await writeReceipt(plan, receipt, homeDirectory);
    return { ...plan, completed: true, verified, receipt: receipt.receipt };
  } catch (error) {
    if (removalStarted) {
      throw new SingularityFlowError(`${error.message}\n\n${recoveryText(plan)}`, { cause: error });
    }
    throw error;
  }
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

function renderedApplyCommand(plan, executable) {
  const parts = [executable];
  if (executable === 'singularity-flow') parts.push('reinstall');
  parts.push(
    '--checkout', JSON.stringify(plan.checkout),
    '--registry', JSON.stringify(plan.registry),
    '--confirm', JSON.stringify(plan.confirmation)
  );
  if (plan.cliOnly) parts.push('--cli-only');
  if (!plan.telemetry && !plan.cliOnly) parts.push('--no-copilot-telemetry');
  return parts.join(' ');
}

export function reinstallPlanText(plan) {
  const lines = [
    `Singularity Flow local product reinstall — ${plan.completed ? 'complete' : 'preview'}`,
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
      'No Git command was run and no installed product or repository was changed.',
      `Confirmation required: ${plan.confirmation}`,
      `Run: ${renderedApplyCommand(plan, 'singularity-flow')}`,
      `Short: ${renderedApplyCommand(plan, 'sf-reinstall')}`);
  } else {
    lines.push('', `Receipt: ${plan.receipt}`, 'Local tooling was replaced. Repository and workspace data were preserved.');
  }
  return lines.join('\n');
}
