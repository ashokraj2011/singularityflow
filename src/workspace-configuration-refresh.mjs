import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

import { BUILD_INFO } from './build-info.mjs';
import {
  configurationAssetPaths, CONFIGURATION_BRANCH, ensureConfigurationBranch, isConfigurationAsset
} from './configuration-branch.mjs';
import { loadDefinition, validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { gitCommitIdentity } from './git.mjs';
import { publishToStateBranch } from './ledger.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { sanitizeRemote } from './git-remote-diagnostics.mjs';
import { mapLimit, SingularityFlowError, run, writeAtomic } from './util.mjs';
import { runRemoteGit, runRemoteGitAsync } from './git-execution.mjs';
import { VERSION } from './version.mjs';
import { readWorkspace, readWorkspaceRegistry, workspaceRepositoryPath } from './workspace.mjs';

export const PACKAGE_BASELINE_PATH = 'singularity/.product/configuration-baseline.yml';
export const STATE_CONFIGURATION_ROOT = 'configuration';
export const STATE_CONFIGURATION_MANIFEST = `${STATE_CONFIGURATION_ROOT}/manifest.json`;
const BASELINE_FORMAT = 'singularity-flow-configuration-baseline/v1';
const MIRROR_FORMAT = 'singularity-flow-configuration-mirror/v2';
// These profiles are part of the executable product contract, not optional catalog samples. They
// may remain unused, but an upgraded approved configuration must keep them available so the CLI,
// Copilot skills and VS Code all expose the same standard product surface.
const REQUIRED_PACKAGED_WORK_TYPES = Object.freeze(['spec-driven-standard']);

const FIXED_PACKAGE_ASSETS = Object.freeze([
  ['agent-mappings.yml', 'singularity/agent-mappings.yml'],
  ['impact.yml', 'singularity/impact.yml'],
  ['modelTiers.yml', 'singularity/modelTiers.yml'],
  ['worldmodel-builder.md', 'singularity/prompts/worldmodel-builder.md'],
  ['copilot-planning.md', 'singularity/prompts/copilot-planning.md']
]);

// Exact bytes of model maps shipped by earlier SFlow packages. Repositories with no recorded
// package baseline used to preserve these as if they were local customizations, leaving retired
// model pins active forever. Exact hashes let refresh advance product-owned bytes while continuing
// to preserve even a one-byte repository customization.
const RETIRED_PACKAGE_ASSET_HASHES = Object.freeze({
  'singularity/modelTiers.yml': Object.freeze([
    '9a6b011b1033b205981d7dd1e87a215a3de53f81c2e422a85d9f8d6438d36faf',
    '68f5da2150926169e8316944b9f11a33271d46127abdadcd88a233d2b4e2860a'
  ])
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function displayPath(parts) {
  return ['workflow', ...parts].join('.');
}

/**
 * Paths needed to restore a missing standard workflow as one valid contract.
 *
 * A prior package baseline normally lets the three-way merge recognize a new work type as an
 * additive product change. If a repository later lacks that profile, however, ordinary merge
 * semantics interpret the absence as an intentional local deletion. Standard product workflows
 * are not optional in that sense: people may choose another workflow, but refresh must keep the
 * standard profile and any missing phase/authority dependencies installed.
 */
function requiredPackagedWorkflowPaths(current, incoming) {
  const paths = new Set();
  for (const workTypeId of REQUIRED_PACKAGED_WORK_TYPES) {
    const profile = incoming.workTypes?.[workTypeId];
    if (!profile || current.workTypes?.[workTypeId]) continue;
    paths.add(`workflow.workTypes.${workTypeId}`);
    for (const phaseId of profile.phases ?? []) {
      if (!current.phases?.[phaseId]) paths.add(`workflow.phases.${phaseId}`);
      for (const authorityId of incoming.phases?.[phaseId]?.approval?.authorities ?? []) {
        if (!current.approvalAuthorities?.[authorityId]) {
          paths.add(`workflow.approvalAuthorities.${authorityId}`);
        }
      }
    }
  }
  return paths;
}

/**
 * Three-way merge one packaged value into approved repository configuration.
 *
 * The package baseline is the version last examined by a refresh. A repository value that still
 * equals that baseline can move automatically; a value changed by both the repository and the new
 * package is retained and reported. With no baseline, recursive additions and compatible closed
 * string-list expansions are safe; other differing values remain explicit customizations.
 */
export function mergePackagedConfiguration(base, local, incoming, {
  acceptBundledConflicts = false,
  resolutions = {}
} = {}) {
  const conflicts = [];
  const resolutionFor = (parts) => resolutions[displayPath(parts)]
    ?? (acceptBundledConflicts ? 'bundled' : 'local');

  const primitiveStringArray = (value) => Array.isArray(value)
    && value.every((entry) => typeof entry === 'string');

  const additiveArray = (left, right) => [...new Set([...left, ...right])];

  const conflict = (parts, localValue, bundledValue, resolution) => {
    conflicts.push({
      path: displayPath(parts),
      local: clone(localValue),
      bundled: clone(bundledValue),
      resolution
    });
  };

  const mergeNode = ({
    basePresent, localPresent, incomingPresent,
    baseValue, localValue, incomingValue, parts
  }) => {
    if (!incomingPresent) {
      if (!basePresent || !localPresent) return { present: localPresent, value: clone(localValue) };
      if (equal(localValue, baseValue)) return { present: false, value: undefined };
      const resolution = resolutionFor(parts);
      if (resolution === 'merge') {
        throw new SingularityFlowError(`Configuration conflict '${displayPath(parts)}' cannot be merged; choose local or bundled.`);
      }
      conflict(parts, localValue, undefined,
        resolution === 'bundled' ? 'accepted-bundled-deletion' : 'preserved-local');
      return resolution === 'bundled'
        ? { present: false, value: undefined }
        : { present: true, value: clone(localValue) };
    }

    if (!localPresent) {
      if (!basePresent) return { present: true, value: clone(incomingValue) };
      const resolution = resolutionFor(parts);
      if (equal(incomingValue, baseValue)) {
        // A missing local node normally represents an intentional repository deletion. An exact
        // reviewed `bundled` resolution must still be able to restore it; previously the early
        // return ignored both --resolve PATH=bundled and --accept-bundled-conflicts.
        if (resolution !== 'bundled') return { present: false, value: undefined };
        conflict(parts, undefined, incomingValue, 'accepted-bundled');
        return { present: true, value: clone(incomingValue) };
      }
      if (resolution === 'merge') {
        throw new SingularityFlowError(`Configuration conflict '${displayPath(parts)}' cannot be merged; choose local or bundled.`);
      }
      conflict(parts, undefined, incomingValue,
        resolution === 'bundled' ? 'accepted-bundled' : 'preserved-local-deletion');
      return resolution === 'bundled'
        ? { present: true, value: clone(incomingValue) }
        : { present: false, value: undefined };
    }

    if (!basePresent) {
      if (equal(localValue, incomingValue)) return { present: true, value: clone(localValue) };
      if (plainObject(localValue) && plainObject(incomingValue)) {
        return { present: true, value: mergeObject({}, localValue, incomingValue, parts) };
      }
      // First-upgrade repositories have no package baseline. A common safe case is a package
      // expanding a closed string allowlist (agents, phases, tools). Retain every local addition and
      // add every packaged requirement; this avoids producing a cross-field-invalid intermediate
      // workflow merely because the previous package revision did not record its baseline.
      if (primitiveStringArray(localValue) && primitiveStringArray(incomingValue)
        && (localValue.every((entry) => incomingValue.includes(entry))
          || incomingValue.every((entry) => localValue.includes(entry)))) {
        return { present: true, value: additiveArray(localValue, incomingValue) };
      }
      const resolution = resolutionFor(parts);
      if (resolution === 'merge'
        && !(primitiveStringArray(localValue) && primitiveStringArray(incomingValue))) {
        throw new SingularityFlowError(`Configuration conflict '${displayPath(parts)}' cannot be merged; choose local or bundled.`);
      }
      const selected = resolution === 'bundled' ? incomingValue
        : resolution === 'merge' && primitiveStringArray(localValue) && primitiveStringArray(incomingValue)
          ? additiveArray(localValue, incomingValue)
          : localValue;
      conflict(parts, localValue, incomingValue,
        resolution === 'bundled' ? 'accepted-bundled'
          : resolution === 'merge' ? 'merged-additively' : 'preserved-local');
      return { present: true, value: clone(selected) };
    }

    if (equal(localValue, baseValue)) return { present: true, value: clone(incomingValue) };
    if (plainObject(baseValue) && plainObject(localValue) && plainObject(incomingValue)) {
      return { present: true, value: mergeObject(baseValue, localValue, incomingValue, parts) };
    }
    if (equal(incomingValue, baseValue) || equal(localValue, incomingValue)) {
      return { present: true, value: clone(localValue) };
    }
    const resolution = resolutionFor(parts);
    if (resolution === 'merge'
      && !(primitiveStringArray(localValue) && primitiveStringArray(incomingValue))) {
      throw new SingularityFlowError(`Configuration conflict '${displayPath(parts)}' cannot be merged; choose local or bundled.`);
    }
    const selected = resolution === 'bundled' ? incomingValue
      : resolution === 'merge' && primitiveStringArray(localValue) && primitiveStringArray(incomingValue)
        ? additiveArray(localValue, incomingValue)
        : localValue;
    conflict(parts, localValue, incomingValue,
      resolution === 'bundled' ? 'accepted-bundled'
        : resolution === 'merge' ? 'merged-additively' : 'preserved-local');
    return { present: true, value: clone(selected) };
  };

  const mergeObject = (baseObject, localObject, incomingObject, parts) => {
    const output = {};
    const keys = [...new Set([
      ...Object.keys(baseObject ?? {}), ...Object.keys(localObject ?? {}), ...Object.keys(incomingObject ?? {})
    ])].sort();
    for (const key of keys) {
      const merged = mergeNode({
        basePresent: Object.hasOwn(baseObject ?? {}, key),
        localPresent: Object.hasOwn(localObject ?? {}, key),
        incomingPresent: Object.hasOwn(incomingObject ?? {}, key),
        baseValue: baseObject?.[key],
        localValue: localObject?.[key],
        incomingValue: incomingObject?.[key],
        parts: [...parts, key]
      });
      if (merged.present) output[key] = merged.value;
    }
    return output;
  };

  if (!plainObject(local) || !plainObject(incoming)) {
    throw new SingularityFlowError('Workflow configuration refresh requires object-valued YAML documents.');
  }
  const baseline = plainObject(base) ? base : {};
  return { value: mergeObject(baseline, local, incoming, []), conflicts };
}

async function walkPackageDirectory(sourceRoot, targetRoot, output) {
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    const source = path.join(sourceRoot, entry.name);
    const target = path.posix.join(targetRoot, entry.name);
    if (entry.isDirectory()) await walkPackageDirectory(source, target, output);
    else if (entry.isFile() && !entry.isSymbolicLink()) output.set(target, await readFile(source));
  }
}

async function packagedAssets(templatesRoot) {
  const output = new Map();
  for (const [source, target] of FIXED_PACKAGE_ASSETS) {
    output.set(target, await readFile(path.join(PACKAGE_ROOT, 'templates', source)));
  }
  await walkPackageDirectory(
    path.join(PACKAGE_ROOT, 'templates', 'artifacts'),
    String(templatesRoot ?? 'singularity/templates').replaceAll('\\', '/'), output
  );
  await walkPackageDirectory(
    path.join(PACKAGE_ROOT, 'templates', 'agents'), '.github/agents', output
  );
  return new Map([...output.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function productIdentity() {
  const revision = BUILD_INFO.commit ?? BUILD_INFO.sourceSha256 ?? `version-${VERSION}`;
  return { version: VERSION, revision };
}

function safeRelative(value) {
  const relative = String(value ?? '').replaceAll('\\', '/');
  if (!relative || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)
    || path.posix.normalize(relative) !== relative || relative.split('/').includes('..')) {
    throw new SingularityFlowError(`Packaged configuration target must stay inside the repository: ${value}`);
  }
  return relative;
}

export function normalizeRefreshResolutions(value = {}) {
  if (!plainObject(value)) throw new SingularityFlowError('Configuration conflict resolutions must be an object.');
  const output = {};
  for (const [rawPath, rawResolution] of Object.entries(value)) {
    const conflictPath = String(rawPath).trim();
    const resolution = String(rawResolution).trim();
    if (!conflictPath || (!conflictPath.startsWith('workflow.') && !isConfigurationAsset(conflictPath))) {
      throw new SingularityFlowError(`Configuration conflict path is not managed: ${rawPath}`);
    }
    if (!['local', 'bundled', 'merge'].includes(resolution)) {
      throw new SingularityFlowError(`Configuration conflict '${conflictPath}' must resolve to local, bundled, or merge.`);
    }
    output[conflictPath] = resolution;
  }
  return output;
}

async function assertSafeTarget(root, relative) {
  const parts = safeRelative(relative).split('/');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const info = await lstat(current).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (info?.isSymbolicLink()) {
      throw new SingularityFlowError(`Packaged configuration target cannot traverse a symbolic link: ${relative}`);
    }
  }
  return path.join(root, ...parts);
}

async function readBaseline(root) {
  const file = path.join(root, PACKAGE_BASELINE_PATH);
  const info = await lstat(file).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SingularityFlowError(`${PACKAGE_BASELINE_PATH} must be a regular file.`);
  }
  let baseline;
  try { baseline = YAML.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new SingularityFlowError(`Packaged configuration baseline is invalid YAML: ${error.message}`); }
  if (baseline?.format !== BASELINE_FORMAT || !plainObject(baseline.workflow) || !plainObject(baseline.assets)) {
    throw new SingularityFlowError(`Packaged configuration baseline must use ${BASELINE_FORMAT}.`);
  }
  return baseline;
}

/** Refresh one isolated checkout from the package while retaining proven repository customizations. */
export async function refreshPackagedConfiguration(root, {
  dryRun = false,
  acceptBundledConflicts = false,
  resolutions = {}
} = {}) {
  const workflowFile = path.join(root, WORKFLOW_PATH);
  const [currentText, incomingText, baseline] = await Promise.all([
    readFile(workflowFile, 'utf8'),
    readFile(path.join(PACKAGE_ROOT, 'templates', 'workflow.yml'), 'utf8'),
    readBaseline(root)
  ]);
  let current;
  let incoming;
  try {
    current = YAML.parse(currentText);
    incoming = YAML.parse(incomingText);
  } catch (error) {
    throw new SingularityFlowError(`Workflow configuration refresh requires valid YAML: ${error.message}`);
  }
  validateDefinition(structuredClone(current));
  validateDefinition(structuredClone(incoming));

  const requiredWorkflowPaths = requiredPackagedWorkflowPaths(current, incoming);
  const merged = mergePackagedConfiguration(baseline?.workflow ?? {}, current, incoming, {
    acceptBundledConflicts,
    // A standard product workflow is always restored as packaged when it is absent. Repository
    // customizations inside an installed profile continue through the normal three-way merge.
    resolutions: {
      ...resolutions,
      ...Object.fromEntries([...requiredWorkflowPaths].map((entry) => [entry, 'bundled']))
    }
  });
  // Required restoration is an invariant, not a choice the preview can switch back to local. Keep
  // ordinary repository customizations visible while avoiding a misleading dropdown for these
  // product-owned missing nodes.
  merged.conflicts = merged.conflicts.filter((entry) => !requiredWorkflowPaths.has(entry.path));
  validateDefinition(structuredClone(merged.value));

  const assets = await packagedAssets(merged.value.templatesRoot);
  const priorAssets = baseline?.assets ?? {};
  const conflicts = [...merged.conflicts];
  const changedFiles = new Set();
  const removedFiles = new Set();

  if (!equal(current, merged.value)) {
    changedFiles.add(WORKFLOW_PATH);
    if (!dryRun) await writeAtomic(workflowFile, YAML.stringify(merged.value));
  }

  for (const [relative, bundled] of assets) {
    const target = await assertSafeTarget(root, relative);
    const info = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (info && (!info.isFile() || info.isSymbolicLink())) {
      throw new SingularityFlowError(`Packaged configuration asset must be a regular file: ${relative}`);
    }
    const currentBytes = info ? await readFile(target) : null;
    const currentHash = currentBytes ? sha256(currentBytes) : null;
    const bundledHash = sha256(bundled);
    const priorHash = priorAssets[relative]?.sha256 ?? null;
    const retiredPackagedAsset = RETIRED_PACKAGE_ASSET_HASHES[relative]?.includes(currentHash) === true;
    const safeToWrite = !info || currentHash === bundledHash
      || (priorHash && currentHash === priorHash) || retiredPackagedAsset;
    if (currentHash === bundledHash) continue;
    const resolution = resolutions[relative] ?? (acceptBundledConflicts ? 'bundled' : 'local');
    if (resolution === 'merge') {
      throw new SingularityFlowError(`Configuration asset conflict '${relative}' cannot be merged; choose local or bundled.`);
    }
    if (!safeToWrite && resolution !== 'bundled') {
      conflicts.push({
        path: relative,
        localSha256: currentHash,
        bundledSha256: bundledHash,
        resolution: 'preserved-local'
      });
      continue;
    }
    if (!safeToWrite) {
      conflicts.push({
        path: relative,
        localSha256: currentHash,
        bundledSha256: bundledHash,
        resolution: 'accepted-bundled'
      });
    }
    changedFiles.add(relative);
    if (!dryRun) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeAtomic(target, bundled);
    }
  }

  // A package may retire a managed asset. Remove it only when its bytes still equal the baseline;
  // otherwise it has become repository-owned and is retained as a visible conflict.
  for (const [relative, prior] of Object.entries(priorAssets)) {
    if (assets.has(relative)) continue;
    const target = await assertSafeTarget(root, relative);
    const info = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new SingularityFlowError(`Retired packaged configuration asset must be a regular file: ${relative}`);
    }
    const currentHash = sha256(await readFile(target));
    const resolution = resolutions[relative] ?? (acceptBundledConflicts ? 'bundled' : 'local');
    if (resolution === 'merge') {
      throw new SingularityFlowError(`Configuration asset conflict '${relative}' cannot be merged; choose local or bundled.`);
    }
    if (currentHash !== prior.sha256 && resolution !== 'bundled') {
      conflicts.push({ path: relative, localSha256: currentHash, bundledSha256: null, resolution: 'preserved-local' });
      continue;
    }
    if (currentHash !== prior.sha256) {
      conflicts.push({ path: relative, localSha256: currentHash, bundledSha256: null, resolution: 'accepted-bundled-deletion' });
    }
    changedFiles.add(relative);
    removedFiles.add(relative);
    if (!dryRun) await rm(target, { force: true });
  }

  const lock = {
    format: BASELINE_FORMAT,
    product: productIdentity(),
    workflow: incoming,
    assets: Object.fromEntries([...assets.entries()].map(([relative, contents]) => [relative, { sha256: sha256(contents) }]))
  };
  const lockText = YAML.stringify(lock);
  const previousLockText = await readFile(path.join(root, PACKAGE_BASELINE_PATH), 'utf8').catch(() => null);
  if (previousLockText !== lockText) {
    changedFiles.add(PACKAGE_BASELINE_PATH);
    if (!dryRun) {
      const lockTarget = await assertSafeTarget(root, PACKAGE_BASELINE_PATH);
      await mkdir(path.dirname(lockTarget), { recursive: true });
      await writeAtomic(lockTarget, lockText);
    }
  }

  if (!dryRun) {
    try {
      // Workflow fields, agents, templates and prompts are one executable contract. Validating only
      // the merged workflow allowed a preserved, older agent to omit a newly introduced phase and
      // still be pushed to sflow/config; every later Story then failed while loading configuration.
      await loadDefinition(root);
    } catch (error) {
      const preserved = conflicts.filter((entry) => entry.resolution === 'preserved-local'
        || entry.resolution === 'preserved-local-deletion').map((entry) => entry.path);
      const guidance = preserved.length
        ? ` Resolve the relevant preserved conflict with --resolve PATH=bundled and preview again. Preserved: ${preserved.join(', ')}.`
        : '';
      const cause = String(error.message).replace(/[.\s]+$/, '');
      throw new SingularityFlowError(
        `The refreshed configuration is not operational: ${cause}.${guidance}`,
        {
          code: 'CONFIGURATION_REFRESH_INVALID',
          details: { conflicts, cause: error.message }
        }
      );
    }
  }

  return {
    product: lock.product,
    changed: changedFiles.size > 0,
    files: [...changedFiles].sort(),
    removed: [...removedFiles].sort(),
    conflicts,
    dryRun
  };
}

async function remoteHead(remote, branch = CONFIGURATION_BRANCH) {
  const observed = await runRemoteGitAsync([
    'ls-remote', '--heads', remote, `refs/heads/${branch}`
  ], { operation: 'remote-probe' });
  if (observed.status !== 0) {
    throw new SingularityFlowError(
      `Cannot read '${sanitizeRemote(remote)}'. ${observed.failure?.advice ?? 'Git remote access failed.'}`,
      { code: observed.failure?.code ?? 'REMOTE_UNKNOWN' }
    );
  }
  const line = observed.stdout.split(/\r?\n/).find((entry) => entry.trim());
  return line ? line.trim().split(/\s+/)[0] : null;
}

async function cloneConfiguration(remote) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-refresh-'));
  const cloned = await runRemoteGitAsync([
    'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
    '--branch', CONFIGURATION_BRANCH, remote, scratch
  ], { operation: 'remote-configuration' });
  if (cloned.status !== 0) {
    await rm(scratch, { recursive: true, force: true });
    throw new SingularityFlowError(
      `Cannot clone '${sanitizeRemote(remote)}' branch '${CONFIGURATION_BRANCH}': ${(cloned.stderr || cloned.stdout).trim().split('\n')[0]}`
    );
  }
  return scratch;
}

function stateConfiguration(approved) {
  return {
    ...(approved.ledger ?? {}),
    enabled: true,
    remote: 'origin',
    branch: approved.ledger?.branch ?? 'state'
  };
}

function stateTree(root, ref) {
  const listed = run('git', [
    'ls-tree', '-r', '-z', '--format=%(objectname) %(path)', ref, '--',
    'configuration', 'singularity', '.github/agents'
  ], { cwd: root });
  const entries = listed.stdout.split('\0').filter(Boolean).map((line) => {
    const separator = line.indexOf(' ');
    return { oid: line.slice(0, separator), file: line.slice(separator + 1) };
  });
  if (!entries.length) return new Map();
  const batch = run('git', ['cat-file', '--batch'], {
    cwd: root, encoding: 'buffer', input: `${entries.map((entry) => entry.oid).join('\n')}\n`
  });
  const output = new Map();
  let cursor = 0;
  for (const entry of entries) {
    const newline = batch.stdout.indexOf(0x0a, cursor);
    if (newline < 0) throw new SingularityFlowError(`State configuration object '${entry.file}' was truncated.`);
    const header = batch.stdout.toString('utf8', cursor, newline).trim().split(' ');
    const size = Number(header[2]);
    if (header[0] !== entry.oid || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
      throw new SingularityFlowError(`State configuration path '${entry.file}' is not a readable file.`);
    }
    const start = newline + 1;
    const end = start + size;
    if (end > batch.stdout.length) {
      throw new SingularityFlowError(`State configuration object '${entry.file}' was truncated.`);
    }
    output.set(entry.file, batch.stdout.subarray(start, end));
    cursor = end + 1;
  }
  return output;
}

function fetchStateRef(root, config) {
  const remoteRef = `refs/remotes/${config.remote}/${config.branch}`;
  const fetched = runRemoteGit([
    'fetch', '--no-tags', config.remote,
    `+refs/heads/${config.branch}:${remoteRef}`
  ], { cwd: root, operation: 'remote-configuration' });
  if (fetched.status !== 0) return null;
  return run('git', ['rev-parse', remoteRef], { cwd: root }).stdout.trim();
}

async function desiredStateProjection(root) {
  const paths = await configurationAssetPaths(root);
  const files = {};
  const hashes = {};
  for (const relative of paths) {
    const contents = await readFile(path.join(root, relative));
    files[relative] = contents;
    hashes[relative] = sha256(contents);
  }
  const approved = YAML.parse(await readFile(path.join(root, WORKFLOW_PATH), 'utf8'));
  return {
    paths,
    files,
    hashes: Object.fromEntries(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right))),
    approved,
    stateConfig: stateConfiguration(approved)
  };
}

function observeStateProjection(root, desired, sourceCommit, product) {
  const stateCommit = fetchStateRef(root, desired.stateConfig);
  if (!stateCommit) {
    return {
      status: 'missing', stateCommit: null, changed: true,
      missingPaths: desired.paths, changedPaths: [], extraPaths: [], legacyPaths: [], manifest: null
    };
  }
  const tree = stateTree(root, stateCommit);
  const paths = [...tree.keys()].sort();
  const canonical = paths.filter(isConfigurationAsset);
  const desiredSet = new Set(desired.paths);
  const missingPaths = desired.paths.filter((relative) => !canonical.includes(relative));
  const changedPaths = desired.paths.filter((relative) => {
    const bytes = tree.get(relative);
    return bytes != null && sha256(bytes) !== desired.hashes[relative];
  });
  const extraPaths = canonical.filter((relative) => !desiredSet.has(relative));
  const legacyPaths = paths.filter((relative) => relative.startsWith(`${STATE_CONFIGURATION_ROOT}/files/`));
  let manifest = null;
  const manifestBytes = tree.get(STATE_CONFIGURATION_MANIFEST);
  if (manifestBytes) {
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
    catch { manifest = null; }
  }
  const manifestCurrent = manifest?.format === MIRROR_FORMAT
    && manifest?.layout === 'canonical-paths'
    && manifest?.source?.branch === CONFIGURATION_BRANCH
    && manifest?.source?.commit === sourceCommit
    && manifest?.product?.revision === product.revision
    && equal(manifest?.files ?? {}, desired.hashes);
  const changed = !manifestCurrent || missingPaths.length > 0 || changedPaths.length > 0
    || extraPaths.length > 0 || legacyPaths.length > 0;
  return {
    status: changed ? 'stale' : 'current', stateCommit, changed,
    missingPaths, changedPaths, extraPaths, legacyPaths, manifest
  };
}

function workspaceMatches(entry, reference) {
  if (!reference) return true;
  const raw = String(reference).trim();
  const requested = raw.toLocaleLowerCase('en-US');
  if ([entry.id, entry.name, entry.anchorKey]
    .some((value) => String(value ?? '').toLocaleLowerCase('en-US') === requested)) return true;
  return path.resolve(entry.path) === path.resolve(raw);
}

async function registeredRepositories(registryFile, { workspace = null, repositories = [] } = {}) {
  const entries = (await readWorkspaceRegistry(registryFile))
    .filter((entry) => !entry.archivedAt && workspaceMatches(entry, workspace));
  if (workspace && !entries.length) throw new SingularityFlowError(`Workspace '${workspace}' is not registered.`);
  const requestedRepositories = new Set((repositories ?? []).map((value) => String(value).trim()).filter(Boolean));
  const unique = new Map();
  for (const entry of entries) {
    const manifest = await readWorkspace(entry.path);
    for (const repository of Object.values(manifest.repositories).sort((left, right) => left.id.localeCompare(right.id))) {
      if (requestedRepositories.size && !requestedRepositories.has(repository.id)) continue;
      const key = sanitizeRemote(repository.url);
      const existing = unique.get(key);
      const membership = { workspaceId: manifest.id, workspaceName: manifest.name, repositoryId: repository.id };
      if (existing) {
        existing.memberships.push(membership);
        continue;
      }
      unique.set(key, {
        id: repository.id,
        remote: repository.url,
        displayRemote: key,
        defaultBranch: repository.defaultBranch,
        localPath: workspaceRepositoryPath(manifest, repository),
        memberships: [membership]
      });
    }
  }
  if (requestedRepositories.size) {
    const found = new Set([...unique.values()].map((item) => item.id));
    const missing = [...requestedRepositories].filter((id) => !found.has(id));
    if (missing.length) throw new SingularityFlowError(`Registered workspaces do not contain repository IDs: ${missing.join(', ')}.`);
  }
  return [...unique.values()].sort((left, right) => left.displayRemote.localeCompare(right.displayRemote));
}

async function prepareCandidate(repository, options) {
  const root = await cloneConfiguration(repository.remote);
  try {
    const sourceCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
    const refresh = await refreshPackagedConfiguration(root, options);
    const desired = await desiredStateProjection(root);
    const stateBefore = observeStateProjection(root, desired, sourceCommit, refresh.product);
    return { repository, root, sourceCommit, refresh, desired, stateBefore };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function refreshPlanId(candidates, resolutions) {
  const identity = {
    repositories: candidates.map((candidate) => ({
      remote: candidate.repository.displayRemote,
      configurationCommit: candidate.sourceCommit,
      stateCommit: candidate.stateBefore.stateCommit,
      productRevision: candidate.refresh.product.revision
    })).sort((left, right) => left.remote.localeCompare(right.remote)),
    resolutions: canonical(resolutions)
  };
  return `cfgp-${sha256(JSON.stringify(identity)).slice(0, 24)}`;
}

/**
 * Preserve enough of a failed configuration preflight for an editor to offer a reviewed repair.
 *
 * `refreshPackagedConfiguration` validates the workflow, agents, templates, and prompts as one
 * executable contract. A preserved older agent can therefore make the preview fail before the UI
 * receives the conflict list it needs to repair that agent. Keep the refusal, but return only its
 * bounded configuration conflicts and the packaged agent paths that can be selected for a second
 * preview. No resolution is applied here.
 */
function refreshPreflightFailure(observation, error) {
  const conflicts = Array.isArray(error?.details?.conflicts)
    ? error.details.conflicts.filter((entry) => entry && typeof entry.path === 'string')
    : [];
  const repairPaths = conflicts
    .filter((entry) => entry.path.startsWith('.github/agents/')
      && (entry.resolution === 'preserved-local' || entry.resolution === 'preserved-local-deletion'))
    .map((entry) => entry.path)
    .sort();
  return {
    status: 'blocked',
    repository: observation.repository.id,
    remote: observation.repository.displayRemote,
    memberships: observation.repository.memberships,
    configurationChanged: false,
    stateChanged: false,
    conflicts,
    repair: repairPaths.length ? {
      kind: 'packaged-agents',
      label: 'Restore packaged agents',
      paths: repairPaths
    } : null,
    error: error?.message ?? 'Configuration refresh preflight failed.'
  };
}

function proposalBranch(candidateCommit, sourceCommit, product) {
  const revision = String(product.revision).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 16);
  return `sflow/config-refresh/${revision}-${sourceCommit.slice(0, 8)}-${candidateCommit.slice(0, 8)}`;
}

async function publishCandidate(candidate) {
  const { root, repository, refresh, sourceCommit, desired } = candidate;
  let approvedCommit = sourceCommit;
  let configurationChanged = false;
  if (refresh.changed) {
    run('git', ['add', '-A', '--', ...refresh.files], { cwd: root });
    const staged = run('git', ['diff', '--cached', '--name-only'], { cwd: root }).stdout
      .split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    if (staged.length) {
      const actor = gitCommitIdentity(root);
      run('git', [
        '-c', `user.name=${actor.name || 'Singularity Flow'}`,
        '-c', `user.email=${actor.email || 'unknown@invalid'}`,
        'commit', '-m', `[configuration][product:${refresh.product.revision}] refresh packaged configuration`
      ], { cwd: root });
      const candidateCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
      const pushed = await runRemoteGitAsync(['push', 'origin', `HEAD:refs/heads/${CONFIGURATION_BRANCH}`], {
        cwd: root, operation: 'remote-push'
      });
      if (pushed.status !== 0) {
        const branch = proposalBranch(candidateCommit, sourceCommit, refresh.product);
        const retained = await runRemoteGitAsync(['push', 'origin', `HEAD:refs/heads/${branch}`], {
          cwd: root, operation: 'remote-push'
        });
        if (retained.status !== 0) {
          throw new SingularityFlowError(
            `Configuration update for '${repository.displayRemote}' was rejected and its review branch could not be retained: ${(retained.stderr || retained.stdout).trim()}`
          );
        }
        return {
          status: 'review-required',
          repository: repository.id,
          remote: repository.displayRemote,
          memberships: repository.memberships,
          sourceCommit,
          candidateCommit,
          proposalBranch: branch,
          conflicts: refresh.conflicts,
          configurationChanged: false,
          stateChanged: false,
          error: (pushed.stderr || pushed.stdout).trim().split('\n')[0]
        };
      }
      approvedCommit = candidateCommit;
      configurationChanged = true;
    }
  }

  const projection = configurationChanged ? await desiredStateProjection(root) : desired;
  const stateBefore = observeStateProjection(root, projection, approvedCommit, refresh.product);
  const mirrored = { ...projection.files };
  const manifest = {
    format: MIRROR_FORMAT,
    layout: 'canonical-paths',
    source: { branch: CONFIGURATION_BRANCH, commit: approvedCommit },
    product: refresh.product,
    files: projection.hashes
  };
  mirrored[STATE_CONFIGURATION_MANIFEST] = `${JSON.stringify(manifest, null, 2)}\n`;
  const state = await publishToStateBranch(
    root,
    projection.stateConfig,
    mirrored,
    `[configuration][source:${approvedCommit.slice(0, 12)}] mirror approved configuration`,
    {
      replaceRoots: [STATE_CONFIGURATION_ROOT],
      removePaths: stateBefore.extraPaths
    }
  );
  const stateRef = state.commit
    ?? run('git', ['rev-parse', `refs/remotes/origin/${projection.stateConfig.branch}`], { cwd: root }).stdout.trim();
  const verified = run('git', ['show', `${stateRef}:${STATE_CONFIGURATION_MANIFEST}`], { cwd: root });
  let verifiedManifest;
  try { verifiedManifest = JSON.parse(verified.stdout); }
  catch { throw new SingularityFlowError(`State configuration mirror for '${repository.displayRemote}' is not valid JSON.`); }
  if (verifiedManifest?.source?.commit !== approvedCommit) {
    throw new SingularityFlowError(`State configuration mirror for '${repository.displayRemote}' does not pin the approved configuration commit.`);
  }
  const stateAfter = observeStateProjection(root, projection, approvedCommit, refresh.product);
  if (stateAfter.status !== 'current') {
    throw new SingularityFlowError(`State configuration projection for '${repository.displayRemote}' did not verify after publication.`);
  }
  const changed = configurationChanged || state.changed;
  return {
    status: changed ? 'updated' : 'current',
    repository: repository.id,
    remote: repository.displayRemote,
    memberships: repository.memberships,
    sourceCommit,
    configurationCommit: approvedCommit,
    stateCommit: stateRef,
    configurationChanged,
    stateChanged: state.changed,
    stateStatus: stateAfter.status,
    removedStatePaths: state.removed,
    files: refresh.files,
    conflicts: refresh.conflicts
  };
}

/**
 * Refresh every unique repository remote registered by machine-local workspaces.
 *
 * All reachable existing authorities are prepared and validated before the first update is pushed.
 * A rerun is the recovery protocol: completed repositories become no-ops, failed repositories retry,
 * and the state mirror is verified even when configuration itself was already current.
 */
export async function refreshWorkspaceConfigurations({
  registryFile,
  workspace = null,
  repositories = [],
  dryRun = false,
  acceptBundledConflicts = false,
  resolutions = {},
  confirmPlan = null
} = {}) {
  if (!registryFile) throw new SingularityFlowError('Workspace configuration refresh requires the workspace registry path.');
  const normalizedResolutions = normalizeRefreshResolutions(resolutions);
  const targets = await registeredRepositories(registryFile, { workspace, repositories });
  const workers = Math.max(1, Math.min(
    8,
    Number(process.env.SINGULARITY_FLOW_GIT_WORKERS ?? 4) || 4,
    targets.length || 1
  ));
  const observations = await mapLimit(targets, workers, async (repository) => {
    try {
      const commit = await remoteHead(repository.remote);
      return { repository, commit, error: null };
    } catch (error) {
      return { repository, commit: null, error };
    }
  });
  const unreachable = observations.filter((item) => item.error);
  if (unreachable.length) {
    return {
      status: 'blocked', dryRun, total: targets.length, updated: 0,
      results: observations.map((item) => ({
        status: item.error ? 'failed' : 'preflight-passed',
        repository: item.repository.id,
        remote: item.repository.displayRemote,
        memberships: item.repository.memberships,
        error: item.error?.message ?? null
      }))
    };
  }

  if (dryRun) {
    const prepared = await mapLimit(observations, workers, async (observation) => {
      if (!observation.commit) {
        const planCandidate = {
          repository: observation.repository, sourceCommit: null,
          stateBefore: { stateCommit: null }, refresh: { product: productIdentity() }
        };
        return { planCandidate, result: {
          status: 'would-initialize', repository: observation.repository.id,
          remote: observation.repository.displayRemote, memberships: observation.repository.memberships,
          configurationChanged: true, stateChanged: true
        } };
      }
      let candidate;
      try {
        candidate = await prepareCandidate(observation.repository, {
          dryRun: false, acceptBundledConflicts, resolutions: normalizedResolutions
        });
      } catch (error) {
        return { planCandidate: null, result: refreshPreflightFailure(observation, error) };
      }
      try {
        const stateChanged = candidate.refresh.changed || candidate.stateBefore.changed;
        return { planCandidate: candidate, result: {
          status: candidate.refresh.changed || stateChanged ? 'would-update' : 'current',
          repository: observation.repository.id,
          remote: observation.repository.displayRemote,
          memberships: observation.repository.memberships,
          configurationChanged: candidate.refresh.changed,
          stateChanged,
          stateStatus: candidate.refresh.changed ? 'would-follow-configuration' : candidate.stateBefore.status,
          stateCommit: candidate.stateBefore.stateCommit,
          missingStatePaths: candidate.stateBefore.missingPaths,
          changedStatePaths: candidate.stateBefore.changedPaths,
          extraStatePaths: candidate.stateBefore.extraPaths,
          files: candidate.refresh.files,
          conflicts: candidate.refresh.conflicts
        } };
      } finally {
        await rm(candidate.root, { recursive: true, force: true });
      }
    });
    const planCandidates = prepared.map((entry) => entry.planCandidate).filter(Boolean);
    const results = prepared.map((entry) => entry.result);
    const blocked = results.some((entry) => entry.status === 'blocked');
    return {
      status: blocked ? 'blocked' : 'preview', dryRun: true,
      ...(blocked ? {} : { planId: refreshPlanId(planCandidates, normalizedResolutions) }),
      total: targets.length, updated: 0, results
    };
  }

  // A UI apply is bound to the preview even when one repository has not created its configuration
  // authority yet. Existing repositories can be prepared without mutation, while missing ones use
  // the same sentinel identity emitted by dry-run. Validate that combined plan before initialization
  // so a stale page cannot create a branch and only then discover that its confirmation was stale.
  let candidates = [];
  let previewBoundPlanId = null;
  if (confirmPlan && observations.some((item) => !item.commit)) {
    const confirmationCandidates = [];
    const confirmationFailures = [];
    const prepared = await mapLimit(observations, workers, async (observation) => {
      if (!observation.commit) {
        return { observation, candidate: {
          repository: observation.repository, sourceCommit: null,
          stateBefore: { stateCommit: null }, refresh: { product: productIdentity() }
        }, retained: false, error: null };
      }
      try {
        const candidate = await prepareCandidate(observation.repository, {
          acceptBundledConflicts, resolutions: normalizedResolutions
        });
        return { observation, candidate, retained: true, error: null };
      } catch (error) {
        return { observation, candidate: null, retained: false, error };
      }
    });
    for (const entry of prepared) {
      if (entry.error) confirmationFailures.push({ observation: entry.observation, error: entry.error });
      else {
        confirmationCandidates.push(entry.candidate);
        if (entry.retained) candidates.push(entry.candidate);
      }
    }
    if (confirmationFailures.length) {
      await Promise.all(candidates.map((candidate) => rm(candidate.root, { recursive: true, force: true })));
      return {
        status: 'blocked', dryRun: false, total: targets.length, updated: 0,
        results: observations.map((item) => {
          const failed = confirmationFailures.find((entry) => entry.observation === item);
          return {
            status: failed ? 'failed' : 'preflight-passed', repository: item.repository.id,
            remote: item.repository.displayRemote, memberships: item.repository.memberships,
            error: failed?.error?.message ?? null
          };
        })
      };
    }
    previewBoundPlanId = refreshPlanId(confirmationCandidates, normalizedResolutions);
    if (previewBoundPlanId !== confirmPlan) {
      await Promise.all(candidates.map((candidate) => rm(candidate.root, { recursive: true, force: true })));
      return {
        status: 'blocked', dryRun: false, planId: previewBoundPlanId,
        total: targets.length, updated: 0, failed: 0,
        results: observations.map((item) => ({
          status: 'stale-plan', repository: item.repository.id,
          remote: item.repository.displayRemote, memberships: item.repository.memberships,
          configurationChanged: false, stateChanged: false,
          error: 'Configuration or state authority changed after preview. Refresh the plan before applying it.'
        }))
      };
    }
  }

  // New workspace repositories receive the same authority as a normal bootstrap after any bound
  // preview has been validated. Existing authorities remain untouched during this step.
  const initialized = await mapLimit(
    observations.filter((item) => !item.commit), workers, async (observation) => {
    try {
      await ensureConfigurationBranch(observation.repository.remote, {
        sourceBranch: observation.repository.defaultBranch
      });
      return { observation, error: null };
    } catch (error) {
      return { observation, error };
    }
  });
  const initializationFailures = initialized.filter((entry) => entry.error);
  if (initializationFailures.length) {
    await Promise.all(candidates.map((candidate) => rm(candidate.root, { recursive: true, force: true })));
    return {
      status: 'blocked', dryRun: false, total: targets.length, updated: 0,
      results: observations.map((item) => {
        const failed = initializationFailures.find((entry) => entry.observation === item);
        return {
          status: failed ? 'failed' : 'preflight-passed', repository: item.repository.id,
          remote: item.repository.displayRemote, memberships: item.repository.memberships,
          error: failed?.error?.message ?? null
        };
      })
    };
  }

  const toPrepare = observations.filter((observation) => !(previewBoundPlanId && observation.commit));
  const prepared = await mapLimit(toPrepare, workers, async (observation) => {
    try {
      const candidate = await prepareCandidate(observation.repository, {
        acceptBundledConflicts, resolutions: normalizedResolutions
      });
      return { observation, candidate, error: null };
    } catch (error) {
      return { observation, candidate: null, error };
    }
  });
  const preparationFailures = prepared.filter((entry) => entry.error);
  for (const entry of prepared) {
    if (entry.candidate) candidates.push(entry.candidate);
  }
  if (preparationFailures.length) {
    await Promise.all(candidates.map((candidate) => rm(candidate.root, { recursive: true, force: true })));
    return {
      status: 'blocked', dryRun: false, total: targets.length, updated: 0,
      results: observations.map((item) => {
        const failed = preparationFailures.find((entry) => entry.observation === item);
        return {
          status: failed ? 'failed' : 'preflight-passed', repository: item.repository.id,
          remote: item.repository.displayRemote, memberships: item.repository.memberships,
          error: failed?.error?.message ?? null
        };
      })
    };
  }

  const planId = previewBoundPlanId ?? refreshPlanId(candidates, normalizedResolutions);
  if (!previewBoundPlanId && confirmPlan && confirmPlan !== planId) {
    await Promise.all(candidates.map((candidate) => rm(candidate.root, { recursive: true, force: true })));
    return {
      status: 'blocked', dryRun: false, planId, total: targets.length, updated: 0, failed: 0,
      results: candidates.map((candidate) => ({
        status: 'stale-plan', repository: candidate.repository.id,
        remote: candidate.repository.displayRemote, memberships: candidate.repository.memberships,
        configurationChanged: false, stateChanged: false,
        error: 'Configuration or state authority changed after preview. Refresh the plan before applying it.'
      }))
    };
  }

  let results = [];
  try {
    results = await mapLimit(candidates, workers, async (candidate) => {
      try { return await publishCandidate(candidate); }
      catch (error) {
        return {
          status: 'failed', repository: candidate.repository.id,
          remote: candidate.repository.displayRemote, memberships: candidate.repository.memberships,
          configurationChanged: false, stateChanged: false, error: error.message
        };
      }
    });
  } finally {
    await Promise.all(candidates.map((candidate) => rm(candidate.root, { recursive: true, force: true })));
  }
  const failed = results.filter((result) => ['failed', 'review-required'].includes(result.status));
  return {
    status: failed.length ? 'partial' : 'complete',
    dryRun: false, planId,
    total: targets.length,
    updated: results.filter((result) => result.status === 'updated').length,
    failed: failed.length,
    results
  };
}
