import { createHash, randomUUID } from 'node:crypto';
import {
  chmod, lstat, mkdir, readFile, rename, rm, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { uninstallDirectSkills } from './direct-skills.mjs';
import { inspectLocalProduct, REINSTALL_SURFACES } from './reinstall.mjs';
import {
  renderCommandPromptCommand, renderPlatformCommand
} from './safe-command-guidance.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { commandExists, run, SingularityFlowError } from './util.mjs';
import {
  acquireActivationLease, releaseActivationLease
} from '../scripts/install-staged-artifacts.mjs';

const CONFIRMATION_PREFIX = 'UNINSTALL SINGULARITY FLOW ';
const TELEMETRY_MARKER = '# Managed by the Singularity Flow installer.';
const TELEMETRY_COMMENT = '# Singularity Flow: Copilot model/token/cost telemetry';
const TELEMETRY_SOURCE = '[ -r "$HOME/.singularity-flow/copilot-otel.sh" ] && . "$HOME/.singularity-flow/copilot-otel.sh"';
const PRODUCT_READ_TIMEOUT_MS = 30_000;
const PRODUCT_MUTATION_TIMEOUT_MS = 300_000;
const PENDING_RECEIPT = 'uninstall-pending.json';
const UNINSTALL_SURFACES = Object.freeze(['vscode', 'copilot', 'skills', 'telemetry', 'cli']);
const UNINSTALL_SURFACE_STATUSES = new Set(['untouched', 'pending', 'completed']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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

async function currentReceiptDigest(homeDirectory) {
  const file = path.join(homeDirectory, '.singularity-flow', 'installations', 'current.json');
  const info = await lstat(file).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return { file, sha256: null, record: null };
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SingularityFlowError(`Installation receipt is not an ordinary file: ${file}`);
  }
  const bytes = await readFile(file);
  let record;
  try { record = JSON.parse(bytes); }
  catch { throw new SingularityFlowError(`Installation receipt is not valid JSON: ${file}`); }
  return { file, sha256: `sha256:${sha256(bytes)}`, record };
}

async function pendingReceipt(homeDirectory) {
  const file = path.join(
    homeDirectory, '.singularity-flow', 'installations', PENDING_RECEIPT
  );
  const info = await lstat(file).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return { file, present: false, record: null };
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 1024 * 1024) {
    throw new SingularityFlowError(`Pending uninstall receipt is not a bounded ordinary file: ${file}`);
  }
  let record;
  try { record = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new SingularityFlowError(`Pending uninstall receipt is not valid JSON: ${file}`); }
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || record.operation !== 'product-uninstall'
      || !/^[a-f0-9]{16}$/u.test(String(record.initialFingerprint || ''))
      || (record.removed !== undefined && (!Array.isArray(record.removed)
        || record.removed.some((item) => typeof item !== 'string' || !item)))
      || (record.surfaces !== undefined && (!record.surfaces
        || typeof record.surfaces !== 'object' || Array.isArray(record.surfaces)
        || Object.entries(record.surfaces).some(([surface, status]) => (
          !UNINSTALL_SURFACES.includes(surface) || !UNINSTALL_SURFACE_STATUSES.has(status)
        ))))
      || (record.surfaceEntries !== undefined && (!record.surfaceEntries
        || typeof record.surfaceEntries !== 'object' || Array.isArray(record.surfaceEntries)
        || Object.entries(record.surfaceEntries).some(([surface, entry]) => (
          !UNINSTALL_SURFACES.includes(surface) || typeof entry !== 'string' || !entry
        ))))) {
    throw new SingularityFlowError(`Pending uninstall receipt has an invalid transaction identity: ${file}`);
  }
  return {
    file,
    present: true,
    record: {
      ...record,
      removed: [...new Set(record.removed || [])],
      surfaces: Object.fromEntries(UNINSTALL_SURFACES.map((surface) => [
        surface, record.surfaces?.[surface] ?? 'untouched'
      ])),
      surfaceEntries: { ...(record.surfaceEntries ?? {}) }
    }
  };
}

function uninstallSubject(installed, receiptSha256, pending) {
  return {
    npmVersion: installed.npmVersion,
    copilotPlugins: installed.copilotPlugins,
    vscodeVersion: installed.vscodeVersion,
    managedDirectSkills: installed.managedDirectSkills,
    telemetryManaged: installed.telemetryManaged,
    telemetryProfileManaged: Boolean(installed.telemetryProfileManaged),
    receiptSha256,
    pending: Boolean(pending)
  };
}

function fingerprintFor(subject) {
  return sha256(JSON.stringify(subject)).slice(0, 16);
}

export async function prepareProductUninstall({
  execute = run,
  exists = commandExists,
  homeDirectory = os.homedir(),
  environment = process.env
} = {}) {
  const installed = inspectLocalProduct({
    execute, exists, homeDirectory, environment, strict: true
  });
  const receipt = await currentReceiptDigest(homeDirectory);
  const pending = await pendingReceipt(homeDirectory);
  if (receipt.record?.surfaces?.vscode && !installed.codeAvailable) {
    throw new SingularityFlowError(
      'The installation receipt records a VS Code extension, but the code command is unavailable. '
      + 'Restore the VS Code CLI to PATH so uninstall can prove and remove that surface.'
    );
  }
  if (receipt.record?.surfaces?.copilot && !installed.copilotAvailable) {
    throw new SingularityFlowError(
      'The installation receipt records a Copilot plugin, but the copilot command is unavailable. '
      + 'Restore Copilot CLI to PATH so uninstall can prove and remove that surface.'
    );
  }
  const subject = uninstallSubject(installed, receipt.sha256, pending.present);
  // Once the first mutation starts, the installed-surface inventory necessarily changes. The
  // durable transaction identity, rather than that partial inventory, is therefore the authority
  // for every exact retry.
  const fingerprint = pending.record?.initialFingerprint || fingerprintFor(subject);
  const present = Boolean(
    installed.npmVersion || installed.copilotPlugins.length || installed.vscodeVersion
    || installed.managedDirectSkills.length || installed.telemetryManaged
    || installed.telemetryProfileManaged || receipt.sha256 || pending.present
  );
  return Object.freeze({
    operation: 'product-uninstall',
    present,
    installed,
    receipt,
    pending,
    distributionEntrypoint: environment.SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT
      ? path.resolve(environment.SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT) : null,
    artifactKeyPath: environment.SINGULARITY_FLOW_ARTIFACT_PUBLIC_KEY
      ? path.resolve(environment.SINGULARITY_FLOW_ARTIFACT_PUBLIC_KEY) : null,
    subject,
    fingerprint,
    confirmation: `${CONFIRMATION_PREFIX}${fingerprint}`,
    preserve: Object.freeze([
      'all Git repositories, branches, worktrees, remotes, commits, and working trees',
      'all workspace directories, capability maps, state/config branches, and work-item artifacts',
      'VS Code settings, global state, SecretStorage, Git credentials, SSH keys, and npm credentials',
      'personal Copilot skills and plugins not carrying a Singularity Flow managed identity',
      'retained installation artifacts and historical receipts for audit or later reinstall'
    ])
  });
}

async function rewriteProfile(file) {
  const info = await lstat(file).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return false;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SingularityFlowError(`Shell profile is not an ordinary file; it was preserved: ${file}`);
  }
  const original = await readFile(file, 'utf8');
  const hadTrailingNewline = /\r?\n$/u.test(original);
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/u);
  const filtered = lines.filter((line) => line !== TELEMETRY_SOURCE && line !== TELEMETRY_COMMENT);
  let updated = filtered.join(newline);
  updated = updated.replace(new RegExp(`${newline}{3,}`, 'gu'), `${newline}${newline}`);
  if (hadTrailingNewline && updated && !updated.endsWith(newline)) updated += newline;
  if (updated === original) return false;
  const temporary = `${file}.sflow-uninstall-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, updated, { flag: 'wx', mode: info.mode & 0o777 });
  try {
    const currentInfo = await lstat(file);
    const current = await readFile(file, 'utf8');
    if (!currentInfo.isFile() || currentInfo.isSymbolicLink() || current !== original
        || (info.ino && currentInfo.ino && (info.ino !== currentInfo.ino || info.dev !== currentInfo.dev))) {
      throw new SingularityFlowError(
        `Shell profile changed during uninstall; no profile bytes were replaced: ${file}`
      );
    }
    // rename-over-file is one atomic replacement on every supported Node platform. The original
    // pathname therefore never disappears between two filesystem operations.
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}

async function managedDirectory(directory, label) {
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new SingularityFlowError(`${label} is not a regular, non-symlink directory: ${directory}`);
  }
  await chmod(directory, 0o700);
  return directory;
}

async function preflightRemovalTargets({ installed, homeDirectory, environment }) {
  const skills = await lstat(installed.skillsRoot).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (skills && (!skills.isDirectory() || skills.isSymbolicLink())) {
    throw new SingularityFlowError(
      `Managed direct-skill root is not a regular, non-symlink directory: ${installed.skillsRoot}`
    );
  }
  if (!installed.telemetryManaged && !installed.telemetryProfileManaged) return;
  const wrapper = path.join(homeDirectory, REINSTALL_SURFACES.telemetryWrapper);
  const wrapperInfo = await lstat(wrapper).catch(() => null);
  if (wrapperInfo && (!wrapperInfo.isFile() || wrapperInfo.isSymbolicLink()
      || !(await readFile(wrapper, 'utf8')).startsWith(TELEMETRY_MARKER))) {
    throw new SingularityFlowError(
      `Telemetry helper ownership cannot be proved; it was preserved: ${wrapper}`
    );
  }
  if (installed.telemetryManaged && !wrapperInfo) {
    throw new SingularityFlowError(`Managed telemetry helper disappeared after inventory: ${wrapper}`);
  }
  const profiles = new Set([
    path.join(homeDirectory, '.zshrc'),
    path.join(homeDirectory, '.bashrc'),
    path.join(homeDirectory, '.bash_profile')
  ]);
  if (environment.ZDOTDIR) profiles.add(path.resolve(environment.ZDOTDIR, '.zshrc'));
  for (const file of profiles) {
    const info = await lstat(file).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (info && (!info.isFile() || info.isSymbolicLink())) {
      throw new SingularityFlowError(`Shell profile is not an ordinary file; it was preserved: ${file}`);
    }
  }
}

async function removeManagedTelemetry({ homeDirectory, environment }) {
  const wrapper = path.join(homeDirectory, REINSTALL_SURFACES.telemetryWrapper);
  const info = await lstat(wrapper).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (info) {
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new SingularityFlowError(`Telemetry helper is not an ordinary file; it was preserved: ${wrapper}`);
    }
    const content = await readFile(wrapper, 'utf8');
    if (!content.startsWith(TELEMETRY_MARKER)) {
      throw new SingularityFlowError(`Telemetry helper is not owned by Singularity Flow; it was preserved: ${wrapper}`);
    }
  }
  const candidates = new Set([
    path.join(homeDirectory, '.zshrc'),
    path.join(homeDirectory, '.bashrc'),
    path.join(homeDirectory, '.bash_profile')
  ]);
  if (environment.ZDOTDIR) candidates.add(path.resolve(environment.ZDOTDIR, '.zshrc'));
  const changedProfiles = [];
  for (const file of candidates) if (await rewriteProfile(file)) changedProfiles.push(file);
  // The helper is the ownership sentinel. Remove it only after every profile update succeeds so a
  // retry can still discover and finish a partially completed telemetry cleanup.
  if (info) await rm(wrapper);
  return { wrapperRemoved: Boolean(info), changedProfiles };
}

async function verifyManagedTelemetryRemoved({ homeDirectory, environment }) {
  const wrapper = path.join(homeDirectory, REINSTALL_SURFACES.telemetryWrapper);
  const wrapperInfo = await lstat(wrapper).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (wrapperInfo) {
    throw new SingularityFlowError(`Managed telemetry helper remained after removal: ${wrapper}`);
  }
  const candidates = new Set([
    path.join(homeDirectory, '.zshrc'),
    path.join(homeDirectory, '.bashrc'),
    path.join(homeDirectory, '.bash_profile')
  ]);
  if (environment.ZDOTDIR) candidates.add(path.resolve(environment.ZDOTDIR, '.zshrc'));
  for (const file of candidates) {
    const contents = await readFile(file, 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (contents != null && contents.split(/\r?\n/u).some((line) => (
      line === TELEMETRY_SOURCE || line === TELEMETRY_COMMENT
    ))) {
      throw new SingularityFlowError(`Managed telemetry activation remained after removal: ${file}`);
    }
  }
}

function hasExtension(output) {
  return String(output).split(/\r?\n/u)
    .some((line) => line.toLowerCase().startsWith(`${REINSTALL_SURFACES.vscodeExtension}@`));
}

function hasManagedPlugin(output) {
  const installed = new Set(String(output).split(/\r?\n/u).map((line) => line
    .replace(/^[\s*\-•]+/u, '').replace(/\s+\(v[^)]*\)\s*$/u, '').trim()));
  return REINSTALL_SURFACES.copilotPlugins.some((identity) => installed.has(identity));
}

async function preflightReceiptStorage(plan, installations) {
  const target = path.join(installations, 'uninstall-current.json');
  for (const [file, label] of [
    [target, 'Prior uninstall receipt'],
    [path.join(installations, PENDING_RECEIPT), 'Pending uninstall receipt']
  ]) {
    const info = await lstat(file).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (info && (!info.isFile() || info.isSymbolicLink())) {
      throw new SingularityFlowError(`${label} is not an ordinary file: ${file}`);
    }
  }
  if (plan.receipt.sha256) {
    const digest = `sha256:${sha256(await readFile(plan.receipt.file))}`;
    if (digest !== plan.receipt.sha256) {
      throw new SingularityFlowError('Installation receipt changed after preview. Preview uninstall again.');
    }
  }
  const probe = path.join(installations, `.uninstall-write-probe-${process.pid}-${randomUUID()}`);
  await writeFile(probe, 'preflight\n', { flag: 'wx', mode: 0o600 });
  await rm(probe);
}

async function ensurePendingReceipt(plan, installations) {
  const target = path.join(installations, PENDING_RECEIPT);
  const current = await lstat(target).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (current) return target;
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const record = {
    schemaVersion: currentSchemaVersion('product-uninstall-transaction'),
    operation: plan.operation,
    startedAt: new Date().toISOString(),
    initialFingerprint: plan.fingerprint,
    status: 'removing-product-surfaces',
    removed: [],
    surfaces: Object.fromEntries(UNINSTALL_SURFACES.map((surface) => [surface, 'untouched'])),
    surfaceEntries: {}
  };
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try { await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
  return target;
}

async function updatePendingSurface(file, surface, status, receiptEntry = null) {
  if (!UNINSTALL_SURFACES.includes(surface) || !UNINSTALL_SURFACE_STATUSES.has(status)) {
    throw new SingularityFlowError(`Unsupported uninstall surface transition: ${surface}/${status}`);
  }
  const info = await lstat(file).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new SingularityFlowError(`Pending uninstall receipt is not an ordinary file: ${file}`);
  }
  const original = await readFile(file);
  let record;
  try { record = JSON.parse(original); }
  catch { throw new SingularityFlowError(`Pending uninstall receipt is not valid JSON: ${file}`); }
  const surfaces = Object.fromEntries(UNINSTALL_SURFACES.map((name) => [
    name, record.surfaces?.[name] ?? 'untouched'
  ]));
  const surfaceEntries = { ...(record.surfaceEntries ?? {}) };
  const entry = surfaceEntries[surface] ?? receiptEntry;
  if (!entry) throw new SingularityFlowError(`Uninstall surface '${surface}' has no receipt identity.`);
  if (surfaces[surface] === 'completed' && status !== 'completed') return;
  surfaces[surface] = status;
  surfaceEntries[surface] = entry;
  const removed = [...new Set([
    ...(Array.isArray(record.removed) ? record.removed : []),
    ...(status === 'completed' ? [entry] : [])
  ])];
  if (record.surfaces?.[surface] === status
      && record.surfaceEntries?.[surface] === entry
      && JSON.stringify(removed) === JSON.stringify(record.removed ?? [])) return;
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({
    ...record, removed, surfaces, surfaceEntries
  }, null, 2)}\n`, {
    flag: 'wx', mode: 0o600
  });
  try {
    const currentInfo = await lstat(file);
    const current = await readFile(file);
    if (!currentInfo.isFile() || currentInfo.isSymbolicLink()
        || !current.equals(original)
        || (info.ino && currentInfo.ino
          && (info.ino !== currentInfo.ino || info.dev !== currentInfo.dev))) {
      throw new SingularityFlowError(
        `Pending uninstall receipt changed during surface removal: ${file}`
      );
    }
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function reconcilePendingSurfaces(file, installed) {
  const receipt = await pendingReceipt(path.dirname(path.dirname(path.dirname(file))));
  // pendingReceipt resolves its pathname from a home directory. Confirm that the caller and parsed
  // transaction are the same file before using its normalized state.
  if (path.resolve(receipt.file) !== path.resolve(file) || !receipt.present) {
    throw new SingularityFlowError(`Pending uninstall receipt disappeared before recovery: ${file}`);
  }
  const absent = {
    vscode: !installed.vscodeVersion,
    copilot: installed.copilotPlugins.length === 0,
    skills: installed.managedDirectSkills.length === 0,
    telemetry: !installed.telemetryManaged && !installed.telemetryProfileManaged,
    cli: !installed.npmVersion
  };
  for (const surface of UNINSTALL_SURFACES) {
    const status = receipt.record.surfaces[surface];
    if (status === 'pending' && absent[surface]) {
      await updatePendingSurface(
        file, surface, 'completed', receipt.record.surfaceEntries[surface]
      );
    } else if (status === 'completed' && !absent[surface]) {
      throw new SingularityFlowError(
        `Uninstall surface '${surface}' reappeared after its completed removal. Preview a new installation operation before continuing.`
      );
    }
  }
}

async function cumulativeRemovedSurfaces(pending, removed) {
  const info = await lstat(pending).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new SingularityFlowError(`Pending uninstall receipt is not an ordinary file: ${pending}`);
  }
  let record;
  try { record = JSON.parse(await readFile(pending, 'utf8')); }
  catch { throw new SingularityFlowError(`Pending uninstall receipt is not valid JSON: ${pending}`); }
  return [...new Set([...(Array.isArray(record.removed) ? record.removed : []), ...removed])];
}

async function finishReceipt(plan, { installations, removed, pending }) {
  const completedAt = new Date().toISOString();
  const formerCurrent = plan.receipt.sha256 ? path.join(
    installations,
    `installed-before-uninstall-${completedAt.replace(/[:.]/gu, '-')}-${plan.fingerprint}-${randomUUID()}.json`
  ) : null;
  const currentInfo = await lstat(plan.receipt.file).catch(() => null);
  if (plan.receipt.sha256) {
    if (!currentInfo?.isFile() || currentInfo.isSymbolicLink()) {
      throw new SingularityFlowError(`Installation receipt changed before uninstall completion: ${plan.receipt.file}`);
    }
    const digest = `sha256:${sha256(await readFile(plan.receipt.file))}`;
    if (digest !== plan.receipt.sha256) {
      throw new SingularityFlowError('Installation receipt changed during uninstall; product surfaces were removed but receipt reconciliation is required.');
    }
  }
  const record = {
    schemaVersion: currentSchemaVersion('product-uninstall-receipt'),
    operation: plan.operation,
    fingerprint: plan.fingerprint,
    completedAt,
    removed,
    preserved: plan.preserve,
    previousInstallationReceipt: formerCurrent
  };
  const target = path.join(installations, 'uninstall-current.json');
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  let previous = null;
  let movedCurrent = false;
  try {
    const current = await lstat(target).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (current) {
      if (!current.isFile() || current.isSymbolicLink()) {
        throw new SingularityFlowError(`Prior uninstall receipt is not an ordinary file: ${target}`);
      }
      previous = path.join(
        installations,
        `uninstall-${completedAt.replace(/[:.]/gu, '-')}-${randomUUID()}.json`
      );
      await rename(target, previous);
    }
    if (formerCurrent) {
      await rename(plan.receipt.file, formerCurrent);
      movedCurrent = true;
    }
    try {
      await rename(temporary, target);
      await chmod(target, 0o600);
    }
    catch (error) {
      if (movedCurrent) await rename(formerCurrent, plan.receipt.file).catch(() => undefined);
      if (previous) await rename(previous, target).catch(() => undefined);
      throw error;
    }
  } finally { await rm(temporary, { force: true }); }
  await rm(pending, { force: true });
  return target;
}

export async function applyProductUninstall(plan, {
  confirmation,
  execute = run,
  exists = commandExists,
  homeDirectory = os.homedir(),
  environment = process.env,
  uninstallAliases = uninstallDirectSkills
} = {}) {
  if (confirmation !== plan.confirmation) {
    throw new SingularityFlowError(`Uninstall requires exact confirmation '${plan.confirmation}'.`);
  }
  const machineState = await managedDirectory(
    path.join(homeDirectory, '.singularity-flow'), 'Singularity Flow machine-state directory'
  );
  const installations = await managedDirectory(
    path.join(machineState, 'installations'), 'Singularity Flow installation directory'
  );
  const journal = path.join(installations, 'activation-current.json');
  const lease = await acquireActivationLease({
    journal, checkout: installations, mode: 'create'
  });
  let result;
  let operationFailure = null;
  try {
  const current = await prepareProductUninstall({ execute, exists, homeDirectory, environment });
  if (current.fingerprint !== plan.fingerprint) {
    throw new SingularityFlowError('Installed product state changed after preview. Run the uninstall preview again.');
  }
  await preflightReceiptStorage(current, installations);
  if (!current.present) {
    result = { ...plan, completed: true, alreadyAbsent: true, removed: [] };
  } else {
  const pending = await ensurePendingReceipt(current, installations);
  await reconcilePendingSurfaces(pending, current.installed);
  await preflightRemovalTargets({ installed: current.installed, homeDirectory, environment });
  const mutationTimeout = Number(
    environment.SINGULARITY_FLOW_PRODUCT_MUTATION_TIMEOUT_MS || PRODUCT_MUTATION_TIMEOUT_MS
  );
  const readTimeout = Number(
    environment.SINGULARITY_FLOW_PRODUCT_READ_TIMEOUT_MS || PRODUCT_READ_TIMEOUT_MS
  );
  const boundedExecute = (command, args, options = {}) => execute(command, args, {
    timeoutMs: options.timeoutMs ?? mutationTimeout,
    ...options
  });
  const removed = [];
  // VS Code is the surface most likely to require an application restart. Attempt it first so a
  // restart refusal leaves Copilot, aliases, telemetry, and the global CLI fully usable.
  if (current.installed.vscodeVersion) {
    await updatePendingSurface(pending, 'vscode', 'pending', 'vscode-extension');
    executeOrThrow(boundedExecute, 'code', [
      '--uninstall-extension', REINSTALL_SURFACES.vscodeExtension
    ], { timeoutMs: mutationTimeout });
    const extensions = executeOrThrow(boundedExecute, 'code', [
      '--list-extensions', '--show-versions'
    ], { timeoutMs: readTimeout }).stdout;
    if (hasExtension(extensions)) {
      throw new SingularityFlowError(
        'VS Code still reports the Singularity Flow extension. Close every VS Code window, retry this exact uninstall, and let CLI removal remain last.'
      );
    }
    removed.push('vscode-extension');
    await updatePendingSurface(pending, 'vscode', 'completed', 'vscode-extension');
  }
  if (current.installed.copilotPlugins.length) {
    await updatePendingSurface(pending, 'copilot', 'pending', 'copilot-plugin');
    for (const identity of current.installed.copilotPlugins) {
      executeOrThrow(boundedExecute, 'copilot', ['plugin', 'uninstall', identity], {
        timeoutMs: mutationTimeout
      });
    }
    const remaining = executeOrThrow(boundedExecute, 'copilot', ['plugin', 'list'], {
      timeoutMs: readTimeout
    }).stdout;
    if (hasManagedPlugin(remaining)) throw new SingularityFlowError('Copilot still reports a Singularity Flow plugin after removal.');
    removed.push('copilot-plugin');
    await updatePendingSurface(pending, 'copilot', 'completed', 'copilot-plugin');
  }
  if (current.installed.managedDirectSkills.length) {
    const surface = `direct-skills:${current.installed.managedDirectSkills.length}`;
    await updatePendingSurface(pending, 'skills', 'pending', surface);
    const aliases = uninstallAliases({ targetRoot: current.installed.skillsRoot });
    for (const name of current.installed.managedDirectSkills) {
      const remaining = await lstat(path.join(current.installed.skillsRoot, name)).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (remaining) {
        throw new SingularityFlowError(`Managed direct skill remained after removal: ${name}`);
      }
    }
    if (aliases.removed.length) removed.push(surface);
    await updatePendingSurface(pending, 'skills', 'completed', surface);
  }
  if (current.installed.telemetryManaged || current.installed.telemetryProfileManaged) {
    await updatePendingSurface(pending, 'telemetry', 'pending', 'telemetry-helper');
    await removeManagedTelemetry({ homeDirectory, environment });
    await verifyManagedTelemetryRemoved({ homeDirectory, environment });
    removed.push('telemetry-helper');
    await updatePendingSurface(pending, 'telemetry', 'completed', 'telemetry-helper');
  }
  if (current.installed.npmVersion) {
    await updatePendingSurface(pending, 'cli', 'pending', 'global-cli');
    executeOrThrow(boundedExecute, 'npm', [
      'uninstall', '--global', '--ignore-scripts', REINSTALL_SURFACES.npmPackage
    ], { timeoutMs: mutationTimeout });
    const npmState = inspectLocalProduct({
      execute,
      exists: (command) => command === 'npm' && exists(command),
      homeDirectory,
      environment,
      strict: true
    });
    if (npmState.npmVersion) throw new SingularityFlowError('npm still reports the global singularity-flow package after removal.');
    removed.push('global-cli');
    await updatePendingSurface(pending, 'cli', 'completed', 'global-cli');
  }
  const cumulativeRemoved = await cumulativeRemovedSurfaces(pending, removed);
  const receipt = await finishReceipt(current, {
    installations, removed: cumulativeRemoved, pending
  });
  result = {
    ...plan, completed: true, alreadyAbsent: false, removed: cumulativeRemoved, receipt
  };
  }
  } catch (error) {
    operationFailure = error;
  }
  let releaseFailure = null;
  try { await releaseActivationLease({ journal, ...lease }); }
  catch (error) { releaseFailure = error; }
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

export function productUninstallText(plan) {
  const lines = [
    `Singularity Flow product uninstall — ${plan.completed ? 'complete' : 'preview'}`,
    `Installed CLI: ${plan.installed.npmVersion ?? 'absent'}`,
    `VS Code extension: ${plan.installed.vscodeVersion ?? 'absent'}`,
    `Copilot plugin copies: ${plan.installed.copilotPlugins.length}`,
    `Managed direct skills: ${plan.installed.managedDirectSkills.length}`,
    `Managed telemetry helper: ${plan.installed.telemetryManaged ? 'present' : 'absent'}`,
    '',
    'Preserve:',
    ...plan.preserve.map((item) => `- ${item}`)
  ];
  if (!plan.present) {
    lines.push('', 'No managed Singularity Flow product surface is installed. Nothing changed.');
  } else if (!plan.completed) {
    const command = plan.distributionEntrypoint && plan.artifactKeyPath
      ? [
        plan.distributionEntrypoint, '--artifact-key', plan.artifactKeyPath,
        '--confirm', plan.confirmation
      ]
      : ['sf-uninstall', '--confirm', plan.confirmation];
    const shellLines = process.platform === 'win32'
      ? [
        `PowerShell: ${renderPlatformCommand(command, 'win32')}`,
        `Command Prompt: ${renderCommandPromptCommand(command)}`
      ]
      : [`Shell: ${renderPlatformCommand(command)}`];
    lines.push(
      '',
      'The CLI is removed last so an extension or Copilot removal failure remains safely retryable.',
      `Confirmation required: ${plan.confirmation}`,
      ...shellLines,
      'Copilot: unavailable after uninstall by design; this machine-level removal has no chat mutation.'
    );
  } else {
    lines.push('', `Removed: ${plan.removed.join(', ') || 'already absent'}.`);
    if (plan.receipt) lines.push(`Receipt: ${plan.receipt}`);
  }
  return lines.join('\n');
}
