/**
 * One build on every product surface of a machine.
 *
 * The terminal and Copilot run the CLI on PATH, while VS Code runs the CLI bundled in its
 * extension. The installers replace every surface together, but a partial install, an
 * out-of-band `npm install --global` or VSIX, or a skipped Copilot step leaves them on different
 * builds. Every surface still reports the same semantic version, so the skew is invisible until
 * an older build refuses a record that a newer one wrote.
 *
 * The committed installation receipt (`installations/current.json`) names the build the person
 * last installed, and its content-addressed artifacts hold that build's exact bytes. Alignment
 * brings a lagging surface to the build its retained artifact carries. That is the same trust the
 * installers already place in those bytes when they roll back. It never downgrades a surface that
 * is newer than the installed build, never replaces a development checkout, and never invents
 * bytes: a surface that needs a build the machine does not hold gets one exact next command
 * instead.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  chmod, lstat, mkdir, readFile, rename, rm, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildDescription } from './build-info.mjs';
import { PRODUCT_ALIGNMENT_SWITCH } from './product-alignment-gate.mjs';
import { inspectLocalProduct, REINSTALL_SURFACES } from './reinstall.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { commandExists, run, SingularityFlowError } from './util.mjs';
import {
  acquireActivationLease, inspectNpmTarballBuildSources, inspectVsixBuildSources,
  releaseActivationLease
} from '../scripts/install-staged-artifacts.mjs';

const RETAINED_ARTIFACT_NAMES = Object.freeze({
  tarball: 'singularity-flow.tgz',
  vsix: 'singularity-flow.vsix'
});
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const BUILD_FIELDS = Object.freeze(['commit', 'sourceSha256', 'branch', 'dirty', 'builtAt']);
const READ_TIMEOUT_MS = 30_000;
const MUTATION_TIMEOUT_MS = 300_000;
const RECEIPT_BUILDS = 8;
export const PRODUCT_ALIGNMENT_RECEIPT = 'alignment-current.json';

/** Surface states, in the order a person should read them. */
export const PRODUCT_SURFACE_STATES = Object.freeze({
  aligned: 'Runs the installed build.',
  repair: 'Runs another build; the installed build is retained on this machine and will replace it.',
  'held-newer': 'Runs a newer build than the installed one; it is never downgraded.',
  'held-development': 'Runs a development checkout, which alignment never replaces.',
  unverifiable: 'The installed build\'s retained bytes are missing or changed, so they cannot be reused.',
  'not-installed': 'Not installed on this machine.',
  unavailable: 'Its manager command is not on PATH.'
});

// ------------------------------------------------------------------------------------------
// Build identities

/**
 * The exact inverse of `src/build-info-stamp.mjs`: each field is one JSON-compatible literal on its
 * own line. Anything else is not a stamp this product wrote, so it is rejected rather than guessed.
 */
export function parseStampedBuildInfo(source) {
  if (typeof source !== 'string') return null;
  const info = {};
  for (const key of BUILD_FIELDS) {
    const match = new RegExp(
      `^\\s*${key}:\\s*(null|true|false|"(?:[^"\\\\\\n]|\\\\.)*")\\s*,?\\s*$`, 'mu'
    ).exec(source);
    if (!match) return null;
    try { info[key] = JSON.parse(match[1]); }
    catch { return null; }
  }
  const text = (value) => value === null || typeof value === 'string';
  if (!text(info.commit) || !text(info.sourceSha256) || !text(info.branch) || !text(info.builtAt)
      || !(info.dirty === null || typeof info.dirty === 'boolean')) return null;
  return Object.freeze(info);
}

export function parseVersionSource(source) {
  const match = /^export const VERSION = '([^'\n]{1,64})';$/mu.exec(String(source ?? ''));
  return match ? match[1] : null;
}

/** The `--build` line a package with these version and build-information sources prints. */
export function stampedBuildLine(versionSource, buildInfoSource) {
  const version = parseVersionSource(versionSource);
  const info = parseStampedBuildInfo(buildInfoSource);
  if (!version || !info) return null;
  return parseBuildLine(`${version} (${buildDescription(info)})`);
}

/** A `--build` line, with the instant its stamp was written when it has one. */
export function parseBuildLine(value) {
  const line = String(value ?? '').trim();
  const match = /^([^\s()]+) \((.+)\)$/u.exec(line);
  if (!match || /[\r\n]/u.test(line)) return null;
  const description = match[2];
  const stamped = !/development checkout|not a stamped package/iu.test(description);
  const builtAt = /(?:^| · )built (\S+)$/u.exec(description)?.[1] ?? null;
  return Object.freeze({ line, version: match[1], stamped, builtAt });
}

/** -1, 0 or 1 when two stamped builds can be ordered by their stamp instant; otherwise null. */
export function compareBuilds(left, right) {
  if (!left || !right) return null;
  if (left.line === right.line) return 0;
  const leftTime = Date.parse(left.builtAt ?? '');
  const rightTime = Date.parse(right.builtAt ?? '');
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime) || leftTime === rightTime) return null;
  return leftTime < rightTime ? -1 : 1;
}

// ------------------------------------------------------------------------------------------
// Observation

function installationsDirectory(homeDirectory) {
  return path.join(homeDirectory, '.singularity-flow', 'installations');
}

/** The environment for every command alignment starts: none of them may start another pass. */
function childEnvironment(environment) {
  return { ...environment, [PRODUCT_ALIGNMENT_SWITCH]: 'off' };
}

function productTimeout(environment, name, fallback) {
  const value = Number(environment?.[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

async function regularFileBytes(file) {
  const info = await lstat(file).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SingularityFlowError(`Installation receipt is not a regular, non-symlink file: ${file}`, {
      code: 'PRODUCT_RECEIPT_INVALID'
    });
  }
  return readFile(file);
}

async function readInstallationReceipt(installations) {
  const file = path.join(installations, 'current.json');
  let bytes;
  try { bytes = await regularFileBytes(file); }
  catch (error) { return { status: 'invalid', path: file, reason: error.message }; }
  if (!bytes) return { status: 'absent', path: file };
  try {
    const { record } = readRecord('installation-current', bytes);
    return { status: 'present', path: file, record };
  } catch (error) {
    return { status: 'invalid', path: file, reason: error.message, code: error.code ?? null };
  }
}

/** A receipt artifact, admitted only at its content-addressed path and only with matching bytes. */
async function retainedArtifact(kind, recorded, installations) {
  if (!recorded) return Object.freeze({ status: 'absent' });
  const digest = String(recorded.sha256 ?? '').replace(/^sha256:/u, '');
  if (!SHA256_HEX.test(digest)) return Object.freeze({ status: 'changed', reason: 'invalid digest' });
  const expected = path.join(installations, 'versions', 'sha256', digest, RETAINED_ARTIFACT_NAMES[kind]);
  if (path.resolve(String(recorded.path ?? '')) !== expected) {
    return Object.freeze({ status: 'changed', reason: 'not at its content-addressed path' });
  }
  let inspected;
  try {
    inspected = kind === 'tarball'
      ? await inspectNpmTarballBuildSources(expected)
      : await inspectVsixBuildSources(expected);
  } catch (error) {
    return Object.freeze({
      status: error?.code === 'ENOENT' || /not a regular/iu.test(String(error?.message))
        ? 'absent' : 'changed',
      reason: String(error?.message ?? error)
    });
  }
  if (inspected.sha256 !== `sha256:${digest}`) {
    return Object.freeze({ status: 'changed', reason: 'bytes do not match the recorded digest' });
  }
  const build = stampedBuildLine(inspected.versionSource, inspected.buildInfoSource);
  if (!build?.stamped) return Object.freeze({ status: 'changed', reason: 'the artifact carries no build stamp' });
  return Object.freeze({
    status: 'verified', path: expected, sha256: inspected.sha256, version: inspected.version, build
  });
}

/**
 * The VS Code launcher. A window passes its own through SINGULARITY_FLOW_CODE_CLI, because on
 * macOS `code` is not on PATH until someone runs "Install 'code' command in PATH".
 */
function withCodeCommand(execute, exists, environment) {
  const configured = String(environment?.SINGULARITY_FLOW_CODE_CLI ?? '').trim();
  if (!configured || !path.isAbsolute(configured) || !fs.existsSync(configured)) return { execute, exists };
  return {
    execute: (command, args, options) => execute(command === 'code' ? configured : command, args, options),
    exists: (command) => (command === 'code' ? true : exists(command))
  };
}

function liveCliBuild(execute, environment) {
  const result = execute('singularity-flow', ['--build'], {
    allowFailure: true, env: childEnvironment(environment),
    timeoutMs: productTimeout(environment, 'SINGULARITY_FLOW_PRODUCT_READ_TIMEOUT_MS', READ_TIMEOUT_MS)
  });
  if (result.status !== 0 || result.timedOut || result.error) return null;
  return parseBuildLine(result.stdout);
}

function extensionManifest(directory) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    return `${manifest.publisher}.${manifest.name}`.toLowerCase() === REINSTALL_SURFACES.vscodeExtension
      ? manifest : null;
  } catch { return null; }
}

/** The installed extension's directory: the one VS Code indexed, or its conventional location. */
export function installedExtensionDirectory({ homeDirectory, environment, version }) {
  if (!version) return null;
  const roots = [...new Set([
    environment?.SINGULARITY_FLOW_VSCODE_EXTENSIONS_DIR,
    path.join(homeDirectory, '.vscode', 'extensions')
  ].filter(Boolean).map((entry) => path.resolve(entry)))];
  const id = REINSTALL_SURFACES.vscodeExtension;
  for (const root of roots) {
    const candidates = [];
    try {
      const index = JSON.parse(fs.readFileSync(path.join(root, 'extensions.json'), 'utf8'));
      for (const entry of Array.isArray(index) ? index : []) {
        if (String(entry?.identifier?.id ?? '').toLowerCase() !== id || entry?.version !== version) continue;
        if (typeof entry.relativeLocation === 'string') candidates.push(path.join(root, entry.relativeLocation));
        const location = entry.location?.fsPath ?? entry.location?.path;
        if (typeof location === 'string') candidates.push(location);
      }
    } catch { /* No index: fall back to the conventional directory name. */ }
    candidates.push(path.join(root, `${id}-${version}`));
    for (const candidate of candidates) {
      if (extensionManifest(candidate)?.version === version) return path.resolve(candidate);
    }
  }
  return null;
}

/**
 * The build an extension directory's bundled CLI prints, read from its stamped sources.
 *
 * A development host loads the extension from a checkout, which stages no CLI beside it. That is a
 * development build, never a broken install to be replaced.
 */
export function extensionDirectoryBuild(directory) {
  const manifest = directory ? extensionManifest(directory) : null;
  if (!manifest) return null;
  if (!fs.existsSync(path.join(directory, 'cli', 'package.json'))) {
    return parseBuildLine(`${manifest.version} (development checkout, not a stamped package)`);
  }
  try {
    return stampedBuildLine(
      fs.readFileSync(path.join(directory, 'cli', 'src', 'version.mjs'), 'utf8'),
      fs.readFileSync(path.join(directory, 'cli', 'src', 'build-info.mjs'), 'utf8')
    );
  } catch { return null; }
}

function copilotPluginVerification(execute, environment) {
  const result = execute('singularity-flow', ['plugin', 'verify', '--json'], {
    allowFailure: true, env: childEnvironment(environment),
    timeoutMs: productTimeout(environment, 'SINGULARITY_FLOW_PRODUCT_READ_TIMEOUT_MS', READ_TIMEOUT_MS)
  });
  if (result.status === 0 && !result.timedOut && !result.error) return { verified: true };
  const detail = String(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`)
    .trim().split('\n').at(-1) ?? '';
  return { verified: false, reason: detail.slice(0, 400) };
}

/**
 * Read-only: the installed build per surface and what each surface runs now.
 *
 * Nothing here installs, writes, or reaches the network. `extensionPath` is the directory of the
 * VS Code extension asking, which is authoritative for that window.
 */
export async function observeProductSurfaces({
  execute = run,
  exists = commandExists,
  homeDirectory = os.homedir(),
  environment = process.env,
  extensionPath = null,
  inspectProduct = inspectLocalProduct
} = {}) {
  ({ execute, exists } = withCodeCommand(execute, exists, environment));
  const installations = installationsDirectory(homeDirectory);
  const receipt = await readInstallationReceipt(installations);
  const record = receipt.status === 'present' ? receipt.record : null;
  const [tarball, vsix] = record
    ? await Promise.all([
      retainedArtifact('tarball', record.artifacts?.tarball ?? null, installations),
      retainedArtifact('vsix', record.artifacts?.vsix ?? null, installations)
    ])
    : [null, null];
  const product = inspectProduct({ execute, exists, homeDirectory, environment, strict: false });
  const cliBuild = product.npmVersion ? liveCliBuild(execute, environment) : null;
  const directory = extensionPath
    ? path.resolve(extensionPath)
    : installedExtensionDirectory({ homeDirectory, environment, version: product.vscodeVersion });
  const vscodeBuild = directory ? extensionDirectoryBuild(directory) : null;
  const copilotInstalled = product.copilotAvailable
    && (product.copilotPlugins.length > 0 || product.managedDirectSkills.length > 0);
  return Object.freeze({
    receipt: Object.freeze({
      status: receipt.status,
      path: receipt.path,
      ...(receipt.reason ? { reason: receipt.reason } : {}),
      ...(record ? {
        installStatus: record.status ?? null,
        installedAt: record.installedAt ?? null,
        checkout: record.checkout ?? null,
        surfaces: Object.freeze({ ...(record.surfaces ?? {}) })
      } : {})
    }),
    installed: Object.freeze({ cli: tarball, vscode: vsix }),
    live: Object.freeze({
      cli: Object.freeze({ present: Boolean(product.npmVersion), version: product.npmVersion, build: cliBuild }),
      vscode: Object.freeze({
        available: product.codeAvailable,
        present: Boolean(product.vscodeVersion) || Boolean(extensionPath),
        version: product.vscodeVersion,
        extensionPath: directory,
        build: vscodeBuild
      }),
      copilot: Object.freeze({
        available: product.copilotAvailable,
        present: copilotInstalled,
        verification: copilotInstalled && cliBuild?.stamped
          ? copilotPluginVerification(execute, environment) : null
      })
    }),
    installations
  });
}

// ------------------------------------------------------------------------------------------
// Plan

function binarySurface(id, { recorded, installed, live, available }) {
  const base = { id, installed: installed?.build?.line ?? null, live: live.build?.line ?? null };
  if (available === false) return { ...base, state: 'unavailable' };
  if (live.present && live.build && !live.build.stamped) return { ...base, state: 'held-development' };
  if (installed?.status !== 'verified') {
    if (!recorded && !live.present) return { ...base, state: 'not-installed' };
    return { ...base, state: 'unverifiable',
      reason: installed?.status === 'changed'
        ? `retained but ${installed.reason}`
        : 'not retained by an installer (it was installed some other way)' };
  }
  if (!recorded && !live.present) return { ...base, state: 'not-installed' };
  if (!live.present || !live.build) {
    return { ...base, state: 'repair', reason: live.present ? 'its build could not be read' : 'it is missing' };
  }
  if (live.build.line === installed.build.line) return { ...base, state: 'aligned' };
  if (compareBuilds(live.build, installed.build) === 1) return { ...base, state: 'held-newer' };
  return { ...base, state: 'repair', reason: 'it runs an older or unknown build' };
}

/**
 * Decide what alignment would do, from one observation. Pure: the same observation always yields
 * the same plan, so a status read and the later apply agree.
 */
export function planProductAlignment(observation) {
  const receipt = observation.receipt;
  if (receipt.status !== 'present') {
    return Object.freeze({
      verdict: receipt.status === 'absent' ? 'no-receipt' : 'receipt-invalid',
      surfaces: Object.freeze([]),
      actions: Object.freeze([]),
      split: null,
      next: Object.freeze(receipt.status === 'absent' ? [] : [{
        command: 'singularity-flow doctor --json',
        reason: `The installation receipt could not be read: ${receipt.reason ?? 'invalid'}`
      }])
    });
  }
  const recordedSurfaces = receipt.surfaces ?? {};
  const cli = binarySurface('cli', {
    recorded: recordedSurfaces.cli === true,
    installed: observation.installed.cli,
    live: observation.live.cli
  });
  const vscode = binarySurface('vscode', {
    recorded: recordedSurfaces.vscode === true,
    installed: observation.installed.vscode,
    live: observation.live.vscode,
    available: observation.live.vscode.available || observation.live.vscode.present
  });
  // Copilot's plugin and direct skills belong to the CLI on PATH they invoke. They are repaired
  // from that CLI's own package, after the CLI itself is aligned.
  const copilotLive = observation.live.copilot;
  const copilot = !copilotLive.available
    ? { id: 'copilot', state: 'unavailable' }
    : !copilotLive.present && recordedSurfaces.copilot !== true
      ? { id: 'copilot', state: 'not-installed' }
      : cli.state === 'held-development'
        ? { id: 'copilot', state: 'held-development' }
        : cli.state === 'repair' || !copilotLive.present || copilotLive.verification?.verified === false
          ? { id: 'copilot', state: 'repair',
            reason: cli.state === 'repair' ? 'it follows the CLI being aligned'
              : copilotLive.verification?.reason ?? 'the plugin is missing' }
          : { id: 'copilot', state: 'aligned' };
  const surfaces = [vscode, cli, copilot].map((entry) => Object.freeze(entry));
  // VS Code first and the CLI before Copilot: the extension carries its own engine, and Copilot's
  // skills are installed by the aligned CLI from its own package.
  const actions = surfaces.filter((entry) => entry.state === 'repair').map((entry) => Object.freeze({
    surface: entry.id,
    kind: entry.id === 'copilot' ? 'copilot-plugin-install' : `install-${entry.id}`,
    ...(entry.id === 'cli' ? { artifact: observation.installed.cli.path, build: entry.installed } : {}),
    ...(entry.id === 'vscode' ? { artifact: observation.installed.vscode.path, build: entry.installed } : {})
  }));
  const installedCli = observation.installed.cli?.status === 'verified' ? observation.installed.cli.build : null;
  const installedVscode = observation.installed.vscode?.status === 'verified'
    ? observation.installed.vscode.build : null;
  const liveBuilds = [
    vscode.state === 'held-newer' ? vscode.live : null,
    cli.state === 'held-newer' ? cli.live : null
  ].filter(Boolean);
  const split = (installedCli && installedVscode && installedCli.line !== installedVscode.line) || liveBuilds.length
    ? Object.freeze({
      cli: cli.state === 'held-newer' ? cli.live : installedCli?.line ?? null,
      vscode: vscode.state === 'held-newer' ? vscode.live : installedVscode?.line ?? null
    })
    : null;
  const next = [];
  if (actions.length) {
    next.push({ command: 'singularity-flow product align', reason: 'Bring every surface to the installed build.' });
  }
  if (split) {
    next.push({
      command: receipt.checkout
        ? `Run a full install from ${receipt.checkout} (./install.sh, or the release's install wrapper).`
        : 'Run a full install of one build (./install.sh, or a promoted release\'s install wrapper).',
      reason: 'VS Code and the terminal hold different installed builds; a full install puts one build on every surface.'
    });
  }
  for (const entry of surfaces.filter((item) => item.state === 'unverifiable')) {
    next.push({
      command: 'Run a full install of the build you want (./install.sh, or the release\'s install wrapper).',
      reason: `The ${entry.id === 'cli' ? 'CLI' : 'VS Code'} build retained on this machine is ${entry.reason}.`
    });
  }
  const verdict = actions.length ? 'repairable'
    : split || surfaces.some((entry) => entry.state === 'unverifiable') ? 'split'
      : 'aligned';
  return Object.freeze({
    verdict,
    surfaces: Object.freeze(surfaces),
    actions: Object.freeze(actions),
    split,
    next: Object.freeze(next.map((entry) => Object.freeze(entry)))
  });
}

// ------------------------------------------------------------------------------------------
// Apply

function executeOrThrow(execute, command, args, options, label) {
  const result = execute(command, args, { ...options, allowFailure: true });
  if (result.status === 0 && !result.timedOut && !result.error) return result;
  const detail = String(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim();
  throw new SingularityFlowError(`${label} failed: ${detail.split('\n').slice(-3).join(' ')}`, {
    code: 'PRODUCT_ALIGNMENT_STEP_FAILED', details: { command, args }
  });
}

function configuredRegistry(execute, environment) {
  const result = execute('npm', ['config', 'get', 'registry'], {
    allowFailure: true,
    timeoutMs: productTimeout(environment, 'SINGULARITY_FLOW_PRODUCT_READ_TIMEOUT_MS', READ_TIMEOUT_MS)
  });
  const value = String(result.stdout ?? '').trim();
  if (result.status !== 0 || !/^https?:\/\/\S+$/u.test(value)) return null;
  return value;
}

async function assertNoInstallRecovery(installations) {
  const pending = path.join(installations, 'distribution-install-pending.json');
  if (await lstat(pending).catch(() => null)) {
    throw new SingularityFlowError(
      'An interrupted distribution install still owns the product surfaces. Run that installer once to finish its recovery; alignment changed nothing.',
      { code: 'PRODUCT_ALIGNMENT_INSTALL_RECOVERY_PENDING', details: { pending } }
    );
  }
}

async function writeAlignmentReceipt(installations, runningBuild, entry) {
  const file = path.join(installations, PRODUCT_ALIGNMENT_RECEIPT);
  let prior = null;
  try {
    const bytes = await regularFileBytes(file);
    if (bytes) prior = readRecord('product-alignment', bytes).record;
  } catch { prior = null; }
  const builds = Object.entries(prior?.builds ?? {})
    .filter(([line]) => line !== runningBuild)
    .sort(([, left], [, right]) => String(right?.at ?? '').localeCompare(String(left?.at ?? '')))
    .slice(0, RECEIPT_BUILDS - 1);
  const record = {
    schemaVersion: currentSchemaVersion('product-alignment'),
    builds: Object.fromEntries([[runningBuild, entry], ...builds])
  };
  await mkdir(installations, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try { await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
  await chmod(file, 0o600);
  return file;
}

/** The alignment pass one build last recorded on this machine, or null. */
export async function recordedAlignment({ homeDirectory = os.homedir(), runningBuild } = {}) {
  const file = path.join(installationsDirectory(homeDirectory), PRODUCT_ALIGNMENT_RECEIPT);
  try {
    const bytes = await regularFileBytes(file);
    if (!bytes) return null;
    return readRecord('product-alignment', bytes).record.builds?.[runningBuild] ?? null;
  } catch { return null; }
}

/**
 * Apply one plan under the installers' activation lease, re-observing first so a surface that
 * moved since the plan was read is judged again. Each step is verified before the next starts; a
 * failed step stops the pass and leaves every later surface untouched.
 */
export async function applyProductAlignment({
  execute = run,
  exists = commandExists,
  homeDirectory = os.homedir(),
  environment = process.env,
  extensionPath = null,
  runningBuild = null,
  trigger = 'command',
  inspectProduct = inspectLocalProduct,
  log = () => {}
} = {}) {
  ({ execute, exists } = withCodeCommand(execute, exists, environment));
  const installations = installationsDirectory(homeDirectory);
  const observe = () => observeProductSurfaces({
    execute, exists, homeDirectory, environment, extensionPath, inspectProduct
  });
  let plan = planProductAlignment(await observe());
  if (!plan.actions.length) {
    if (runningBuild && !['no-receipt', 'receipt-invalid'].includes(plan.verdict)) {
      await writeAlignmentReceipt(installations, runningBuild, {
        at: new Date().toISOString(), trigger, outcome: plan.verdict, steps: []
      }).catch(() => undefined);
    }
    return Object.freeze({ status: plan.verdict, plan, steps: Object.freeze([]) });
  }
  await assertNoInstallRecovery(installations);
  const journal = path.join(installations, 'activation-current.json');
  let lease;
  try {
    lease = await acquireActivationLease({ journal, checkout: installations, mode: 'create' });
  } catch (error) {
    throw new SingularityFlowError(
      `Another install or its recovery owns the product surfaces (${String(error?.message ?? error)}). Alignment changed nothing; retry after it finishes.`,
      { code: 'PRODUCT_ALIGNMENT_INSTALL_ACTIVE', cause: error }
    );
  }
  const steps = [];
  let failure = null;
  try {
    // Judge again under the lease: another window may have aligned the machine meanwhile.
    plan = planProductAlignment(await observe());
    const mutation = productTimeout(environment, 'SINGULARITY_FLOW_PRODUCT_MUTATION_TIMEOUT_MS', MUTATION_TIMEOUT_MS);
    for (const action of plan.actions) {
      const step = { surface: action.surface, kind: action.kind, build: action.build ?? null };
      try {
        if (action.kind === 'install-vscode') {
          log(`Aligning the VS Code extension to ${action.build}.`);
          executeOrThrow(execute, 'code', ['--install-extension', action.artifact, '--force'], {
            env: childEnvironment(environment), timeoutMs: mutation
          }, 'VS Code extension install');
          const after = planProductAlignment(await observe());
          const surface = after.surfaces.find((entry) => entry.id === 'vscode');
          if (surface.state !== 'aligned') {
            throw new SingularityFlowError(
              `VS Code reports ${surface.live ?? 'no readable build'} after installing ${action.build}.`,
              { code: 'PRODUCT_ALIGNMENT_VERIFICATION_FAILED' }
            );
          }
        } else if (action.kind === 'install-cli') {
          log(`Aligning the terminal and Copilot CLI to ${action.build}.`);
          const registry = configuredRegistry(execute, environment);
          executeOrThrow(execute, 'npm', [
            'install', '--global', action.artifact, ...(registry ? [`--registry=${registry}`] : [])
          ], {
            env: childEnvironment(registry ? { ...environment, NPM_CONFIG_REGISTRY: registry } : environment),
            timeoutMs: mutation
          }, 'CLI install');
          const live = liveCliBuild(execute, environment);
          if (live?.line !== action.build) {
            throw new SingularityFlowError(
              `The CLI on PATH reports ${live?.line ?? 'no readable build'} after installing ${action.build}.`,
              { code: 'PRODUCT_ALIGNMENT_VERIFICATION_FAILED' }
            );
          }
        } else if (action.kind === 'copilot-plugin-install') {
          if (copilotPluginVerification(execute, environment).verified) {
            step.outcome = 'already-aligned';
            steps.push(Object.freeze(step));
            continue;
          }
          log('Reinstalling the Copilot plugin and direct skills from the CLI on PATH.');
          executeOrThrow(execute, 'singularity-flow', ['plugin', 'install'], {
            env: childEnvironment(environment), timeoutMs: mutation
          }, 'Copilot plugin install');
          const verified = copilotPluginVerification(execute, environment);
          if (!verified.verified) {
            throw new SingularityFlowError(`Copilot still does not match the CLI: ${verified.reason}`, {
              code: 'PRODUCT_ALIGNMENT_VERIFICATION_FAILED'
            });
          }
        }
        step.outcome = 'aligned';
        steps.push(Object.freeze(step));
      } catch (error) {
        step.outcome = 'failed';
        step.reason = String(error?.message ?? error);
        steps.push(Object.freeze(step));
        failure = error;
        break;
      }
    }
  } finally {
    await releaseActivationLease({ journal, operationId: lease.operationId }).catch(() => undefined);
  }
  const status = failure ? 'failed' : 'aligned';
  if (runningBuild) {
    await writeAlignmentReceipt(installations, runningBuild, {
      at: new Date().toISOString(), trigger, outcome: status,
      steps: steps.map((entry) => ({ ...entry }))
    }).catch(() => undefined);
  }
  return Object.freeze({ status, plan, steps: Object.freeze(steps), ...(failure ? { failure } : {}) });
}

// ------------------------------------------------------------------------------------------
// The first mutation a build runs

/**
 * One contained pass before the first mutation command a stamped build runs on this machine.
 *
 * It never blocks the command: a failure is one line on stderr with the command that retries it.
 * When the CLI it replaced is the one running this command, the command is handed to the newly
 * installed build instead of continuing on the old one, which could refuse records the new build
 * already wrote. The handed-off command runs with alignment switched off, so it cannot loop.
 */
export async function alignBeforeFirstMutation({
  runningBuild,
  argv,
  execute = run,
  exists = commandExists,
  homeDirectory = os.homedir(),
  environment = process.env,
  write = (line) => process.stderr.write(`${line}\n`)
} = {}) {
  let result;
  try {
    result = await applyProductAlignment({
      execute, exists, homeDirectory, environment, runningBuild, trigger: 'first-mutation',
      log: (line) => write(`Singularity Flow: ${line}`)
    });
  } catch (error) {
    // An install owning the surfaces is not recorded: the next mutation tries again after it.
    write(`Singularity Flow could not align its product surfaces: ${error.message} Retry with: singularity-flow product align`);
    return Object.freeze({ status: 'skipped', reason: error.code ?? 'PRODUCT_ALIGNMENT_UNAVAILABLE' });
  }
  if (result.status === 'failed') {
    const failed = result.steps.find((entry) => entry.outcome === 'failed');
    write(`Singularity Flow stopped aligning at the ${failed?.surface ?? 'product'} surface: ${failed?.reason ?? 'unknown failure'} Retry with: singularity-flow product align`);
    return Object.freeze({ status: 'failed' });
  }
  const replacedCli = result.steps.some((entry) => entry.surface === 'cli' && entry.outcome === 'aligned');
  const runningWasReplaced = result.plan.surfaces.find((entry) => entry.id === 'cli')?.live === runningBuild;
  if (!replacedCli || !runningWasReplaced) return Object.freeze({ status: result.status });
  write('Singularity Flow: continuing this command on the newly aligned build.');
  const handed = execute('singularity-flow', argv, {
    stdio: 'inherit', allowFailure: true, env: childEnvironment(environment)
  });
  return Object.freeze({ status: 'handed-off', exitCode: Number.isInteger(handed.status) ? handed.status : 1 });
}
