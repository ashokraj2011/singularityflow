import { createHash, randomUUID } from 'node:crypto';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

import { BUILD_INFO } from './build-info.mjs';
import {
  canonicalConfigurationAssets, configurationAssetPaths, CONFIGURATION_BRANCH,
  configurationAssetPolicyFromDirectory, configurationAssetPolicyFromRef,
  ensureConfigurationBranch, isConfigurationAsset, retainStateConfigurationHistory,
  stateConfigurationHistoryBranch
} from './configuration-branch.mjs';
import {
  configurationAssetSearchRoots, mergeConfigurationAssetPolicies
} from './configuration-assets.mjs';
import { loadDefinition, validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { gitCommitIdentity } from './git.mjs';
import { enterpriseGitEnvironment } from './git-enterprise-environment.mjs';
import { publishToStateBranch } from './ledger.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import {
  assertCredentialFreeRemote, frozenRemoteTransport, redactDiagnosticText, remoteFingerprint,
  sanitizeRemote
} from './git-remote-diagnostics.mjs';
import { gitWorkerCount, isGitRefName, mapLimit, SingularityFlowError, run, writeAtomic } from './util.mjs';
import { runRemoteGitAsync } from './git-execution.mjs';
import { VERSION } from './version.mjs';
import { readWorkspace, readWorkspaceRegistry, workspaceRepositoryPath } from './workspace.mjs';

export const PACKAGE_BASELINE_PATH = 'singularity/.product/configuration-baseline.yml';
export const STATE_CONFIGURATION_ROOT = 'configuration';
export const STATE_CONFIGURATION_MANIFEST = `${STATE_CONFIGURATION_ROOT}/manifest.json`;
const BASELINE_FORMAT = 'singularity-flow-configuration-baseline/v1';
const MIRROR_FORMAT = 'singularity-flow-configuration-mirror/v2';
const REFRESH_CACHE_FORMAT = 'singularity-flow-configuration-refresh-cache/v1';
const REFRESH_CACHE_OWNER_FORMAT = 'singularity-flow-configuration-refresh-cache-owner/v1';
const REFRESH_CACHE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const REFRESH_CACHE_MAX_PLANS = 8;
const REFRESH_CACHE_RECORD_MAX_BYTES = 1024 * 1024;
const REFRESH_CACHE_OWNER_FILE = '.owner.json';
const REFRESH_CACHE_CLAIM_FORMAT = 'singularity-flow-configuration-refresh-cache-claim/v1';
const REFRESH_CACHE_CLAIM_FILE = '.git/sflow-cache-claim.json';
const REFRESH_CACHE_LOCK_FORMAT = 'singularity-flow-configuration-refresh-cache-lock/v1';
const REFRESH_CACHE_LOCK_FILE = '.owner.json';
// A just-created lock may briefly exist before its owner receipt is durable. Never reclaim that
// window. Once the receipt/directory is older than this grace period, only a proven-dead owner may
// be reclaimed; a live PID is never stolen, regardless of age.
const REFRESH_CACHE_LOCK_STALE_MS = 60 * 1000;
const REFRESH_CACHE_PROCESS_STARTED_AT = new Date(
  Date.now() - Math.max(0, Math.round(process.uptime() * 1000))
).toISOString();
const REFRESH_CACHE_PROCESS_TOKEN = randomUUID();
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

function refreshErrorMessage(error) {
  return error?.message == null ? null : redactDiagnosticText(error.message);
}

function remoteFailureMessage(result, fallback = 'Git remote access failed. Inspect repository access and retry.') {
  // Provider output can contain proxy URLs, CA paths, credential-helper commands/output, and hook
  // diagnostics. Configuration refresh records are durable and UI-visible, so expose only the
  // closed-vocabulary classifier/advice produced by the shared Git boundary.
  return result?.failure?.advice ?? fallback;
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

async function remoteHeads(remote, branches, { env = process.env } = {}) {
  const requested = [...new Set(branches.filter(Boolean))];
  const transport = frozenRemoteTransport(remote, { env });
  const observed = await runRemoteGitAsync([
    'ls-remote', '--heads', '--', transport.remote,
    ...requested.map((branch) => `refs/heads/${branch}`)
  ], { operation: 'remote-probe', env: transport.env });
  if (observed.status !== 0) {
    throw new SingularityFlowError(
      `Cannot read '${sanitizeRemote(remote)}'. ${observed.failure?.advice ?? 'Git remote access failed.'}`,
      { code: observed.failure?.code ?? 'REMOTE_UNKNOWN' }
    );
  }
  const heads = new Map(requested.map((branch) => [branch, null]));
  for (const line of observed.stdout.split(/\r?\n/).filter((entry) => entry.trim())) {
    const [commit, ref] = line.trim().split(/\s+/);
    const prefix = 'refs/heads/';
    if (ref?.startsWith(prefix) && heads.has(ref.slice(prefix.length))) {
      heads.set(ref.slice(prefix.length), commit);
    }
  }
  return heads;
}

async function cloneConfiguration(remote, { env = process.env } = {}) {
  // Keep one alias/environment for the clone and every later fetch/push from the ephemeral
  // candidate. Git persists the user-supplied clone argument as origin, so retaining the alias here
  // lets named-origin ledger operations share the same frozen authority without consulting a
  // mutable url.* rewrite again.
  const transport = frozenRemoteTransport(remote, { push: true, env });
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-refresh-'));
  const cloned = await runRemoteGitAsync([
    'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
    '--branch', CONFIGURATION_BRANCH, transport.remote, scratch
  ], { operation: 'remote-configuration', env: transport.env });
  if (cloned.status !== 0) {
    await rm(scratch, { recursive: true, force: true });
    throw new SingularityFlowError(
      `Cannot clone '${sanitizeRemote(remote)}' branch '${CONFIGURATION_BRANCH}'. `
        + remoteFailureMessage(cloned)
    );
  }
  return { root: scratch, env: transport.env };
}

function refreshCacheRoot(registryFile) {
  if (process.platform === 'win32') {
    // Node does not expose Windows ACL ownership through lstat. Keep reusable cache bytes under the
    // OS-provided per-user application-data boundary instead of beside a registry that may live on
    // a shared drive. Without that boundary the optional optimization is disabled, fail-closed.
    const localAppData = String(process.env.LOCALAPPDATA ?? '').trim();
    if (!localAppData) return null;
    return path.join(
      path.resolve(localAppData), 'Singularity Flow', 'configuration-refresh-cache',
      sha256(path.resolve(registryFile)).slice(0, 32)
    );
  }
  return path.join(path.dirname(path.resolve(registryFile)), '.configuration-refresh-cache');
}

function refreshCacheRepositoryKey(remote) {
  return remoteFingerprint(assertCredentialFreeRemote(remote)).slice(0, 32);
}

async function boundedCacheRecord(file, maxBytes = REFRESH_CACHE_RECORD_MAX_BYTES) {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > maxBytes) return null;
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

function cacheAclIsSafe(target, { privatePath = false } = {}) {
  // Windows cache placement is already restricted to the per-user LocalAppData boundary because
  // Node does not expose its ACLs. Keep that platform's documented fail-closed placement contract.
  if (process.platform === 'win32') return true;
  const listed = run('ls', [process.platform === 'darwin' ? '-lde' : '-ld', target], {
    allowFailure: true
  });
  if (listed.status !== 0) return false;
  const mode = listed.stdout.split(/\s+/, 1)[0] ?? '';
  if (process.platform !== 'darwin') {
    if (!mode.includes('+')) return true;
    // GNU `ls` exposes the presence, but not the effective/default ACL. The optional cache is safer
    // to skip than to guess whether a named or inherited ACL defeats classic mode bits.
    return false;
  }
  const accessEntries = listed.stdout.split(/\r?\n/).slice(1)
    .map((line) => line.trim()).filter((line) => /^\d+:/.test(line));
  return !accessEntries.some((entry) => {
    if (!/\ballow\b/i.test(entry)) return false;
    if (privatePath) return true;
    // Traversal-only ACLs do not authorize replacing a private descendant. Mutation, deletion, ACL
    // inheritance, or ownership rights do, so an ancestor carrying one is not a safe pathname root.
    return /\b(?:add_file|add_subdirectory|delete_child|delete|write|writeattr|writeextattr|writesecurity|chown|file_inherit|directory_inherit)\b/i
      .test(entry);
  });
}

async function securePrivateCachePath(target, { directory, mode }) {
  let info = await lstat(target).catch(() => null);
  const expectedKind = directory ? info?.isDirectory() : info?.isFile();
  if (!expectedKind || info.isSymbolicLink()) return null;
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return null;
  try { await chmod(target, mode); } catch { return null; }
  info = await lstat(target).catch(() => null);
  const securedKind = directory ? info?.isDirectory() : info?.isFile();
  if (!securedKind || info.isSymbolicLink()) return null;
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return null;
  // POSIX permission bits are not meaningful on Windows. On platforms that expose a uid, however,
  // a cache is reusable only when other users cannot mutate the directory or its ownership receipt.
  if (typeof process.getuid === 'function' && (info.mode & 0o077) !== 0) return null;
  if (!cacheAclIsSafe(target, { privatePath: true })) return null;
  return info;
}

async function approvedCacheAncestorChain(start) {
  if (process.platform === 'win32') {
    const info = await lstat(start).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) return null;
    const canonical = await realpath(start).catch(() => null);
    return canonical ? { path: canonical, dev: info.dev, ino: info.ino } : null;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  let current = start;
  let childInfo = null;
  let first = null;
  while (true) {
    const info = await lstat(current).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) return null;
    if (await realpath(current).catch(() => null) !== current) return null;
    if (!cacheAclIsSafe(current)) return null;
    if (!first) first = { path: current, dev: info.dev, ino: info.ino };
    if (uid !== null) {
      const sharedWritable = (info.mode & 0o022) !== 0;
      const sticky = (info.mode & 0o1000) !== 0;
      if (sharedWritable && !sticky) return null;
      // Sticky semantics protect only entries owned by this principal (or the directory owner). A
      // shared temp ancestor therefore cannot safely anchor a child belonging to somebody else.
      if (sharedWritable && childInfo && childInfo.uid !== uid && info.uid !== uid) return null;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    const rebound = await lstat(path.join(parent, path.basename(current))).catch(() => null);
    if (!rebound || rebound.dev !== info.dev || rebound.ino !== info.ino) return null;
    childInfo = info;
    current = parent;
  }
  return first;
}

async function approvedRefreshCacheParent(target, { create = false } = {}) {
  const parent = path.dirname(target);
  if (create) {
    try { await mkdir(parent, { recursive: true, mode: 0o700 }); }
    catch { return null; }
  }
  const canonical = await realpath(parent).catch(() => null);
  if (!canonical) return null;
  return approvedCacheAncestorChain(canonical);
}

async function approvedRefreshCacheRoot(registryFile, { create = false } = {}) {
  const requested = refreshCacheRoot(registryFile);
  if (!requested) return null;
  const parentBoundary = await approvedRefreshCacheParent(requested, { create });
  if (!parentBoundary) return null;
  const securedRequest = path.join(parentBoundary.path, path.basename(requested));
  let created = false;
  if (create) {
    try {
      await mkdir(securedRequest, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') return null;
    }
  }
  const rootInfo = await securePrivateCachePath(securedRequest, { directory: true, mode: 0o700 });
  if (!rootInfo) return null;
  const registryBinding = sha256(path.resolve(registryFile));
  const ownerFile = path.join(securedRequest, REFRESH_CACHE_OWNER_FILE);
  if (created) {
    try {
      await writeFile(ownerFile, `${JSON.stringify({
        format: REFRESH_CACHE_OWNER_FORMAT,
        registrySha256: registryBinding,
        createdAt: new Date().toISOString()
      }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    } catch {
      await rm(securedRequest, { recursive: true, force: true });
      return null;
    }
  }
  const ownerInfo = await securePrivateCachePath(ownerFile, { directory: false, mode: 0o600 });
  if (!ownerInfo) return null;
  const owner = await boundedCacheRecord(ownerFile, 4096);
  if (owner?.format !== REFRESH_CACHE_OWNER_FORMAT
    || owner?.registrySha256 !== registryBinding) return null;
  // Return the canonical directory, rather than requiring textual equality. On macOS `/tmp` is a
  // system alias for `/private/tmp`; ownership and the private marker above establish the boundary.
  const canonicalRoot = await realpath(securedRequest).catch(() => null);
  if (!canonicalRoot || path.dirname(canonicalRoot) !== parentBoundary.path) return null;
  const reboundParent = await approvedCacheAncestorChain(parentBoundary.path);
  if (!reboundParent || reboundParent.dev !== parentBoundary.dev || reboundParent.ino !== parentBoundary.ino) return null;
  return {
    path: canonicalRoot,
    dev: rootInfo.dev,
    ino: rootInfo.ino,
    parent: parentBoundary,
    owner: { path: ownerFile, dev: ownerInfo.dev, ino: ownerInfo.ino },
    registrySha256: registryBinding
  };
}

async function refreshCacheBoundaryCurrent(boundary) {
  if (!boundary?.path) return false;
  const parent = await approvedCacheAncestorChain(boundary.parent?.path);
  if (!parent || parent.dev !== boundary.parent.dev || parent.ino !== boundary.parent.ino) return false;
  const rootInfo = await securePrivateCachePath(boundary.path, { directory: true, mode: 0o700 });
  if (!rootInfo || rootInfo.dev !== boundary.dev || rootInfo.ino !== boundary.ino) return false;
  const ownerInfo = await securePrivateCachePath(boundary.owner?.path, { directory: false, mode: 0o600 });
  if (!ownerInfo || ownerInfo.dev !== boundary.owner.dev || ownerInfo.ino !== boundary.owner.ino) return false;
  const owner = await boundedCacheRecord(boundary.owner.path, 4096);
  return owner?.format === REFRESH_CACHE_OWNER_FORMAT
    && owner?.registrySha256 === boundary.registrySha256;
}

function refreshCacheOwnerAlive(pid) {
  const ownerPid = Number(pid);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return false;
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    // EPERM proves that a process owns the PID even when this principal cannot signal it.
    return error?.code === 'EPERM';
  }
}

function refreshCacheLockIdentity(record, info) {
  const token = /^[A-Za-z0-9-]{20,80}$/.test(String(record?.token ?? ''))
    ? record.token : null;
  return token ?? sha256(JSON.stringify({
    dev: String(info?.dev ?? ''), ino: String(info?.ino ?? ''),
    birthtimeMs: Number(info?.birthtimeMs ?? 0), mtimeMs: Number(info?.mtimeMs ?? 0)
  })).slice(0, 32);
}

async function refreshCacheLockState(boundary, lock) {
  if (!(await refreshCacheBoundaryCurrent(boundary))) return null;
  const info = await securePrivateCachePath(lock, { directory: true, mode: 0o700 });
  if (!info || await realpath(lock).catch(() => null) !== lock) return null;
  const record = await boundedCacheRecord(path.join(lock, REFRESH_CACHE_LOCK_FILE), 4096);
  const acquiredAt = record?.format === REFRESH_CACHE_LOCK_FORMAT
    ? Date.parse(record.acquiredAt) : Number.NaN;
  const ageBasis = Number.isFinite(acquiredAt) ? acquiredAt : info.mtimeMs;
  const oldEnough = Number.isFinite(ageBasis)
    && Date.now() - ageBasis >= REFRESH_CACHE_LOCK_STALE_MS;
  return {
    info,
    record,
    stale: oldEnough && !refreshCacheOwnerAlive(record?.pid),
    identity: refreshCacheLockIdentity(record, info)
  };
}

/**
 * Move one proven-dead lock out of the acquisition pathname.
 *
 * The tombstone name is deterministic for the old lock identity and intentionally remains in the
 * private cache. Two reclaimers that inspected the same stale inode therefore race to the same
 * destination: only one can move it, and a paused loser can never rename a newly acquired live lock
 * after the winner frees `.operation-lock`. Each crashed owner leaves at most one tiny tombstone.
 */
async function reclaimStaleRefreshCacheLock(boundary, lock) {
  const state = await refreshCacheLockState(boundary, lock);
  if (!state?.stale) return false;
  const tombstone = path.join(boundary.path, `.operation-lock-reclaimed-${state.identity}`);
  try {
    await rename(lock, tombstone);
  } catch {
    return false;
  }
  const moved = await lstat(tombstone).catch(() => null);
  // `rename` moved one directory atomically. Retain rather than delete even on an unexpected inode
  // mismatch: deleting an object we did not inspect would violate the cache's fail-closed boundary.
  return Boolean(moved?.isDirectory() && !moved.isSymbolicLink()
    && moved.dev === state.info.dev && moved.ino === state.info.ino);
}

async function acquireRefreshCacheLock(boundary) {
  const lock = path.join(boundary.path, '.operation-lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!(await refreshCacheBoundaryCurrent(boundary))) return null;
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt > 0
        || !(await reclaimStaleRefreshCacheLock(boundary, lock))) return null;
      continue;
    }
    const owner = {
      format: REFRESH_CACHE_LOCK_FORMAT,
      pid: process.pid,
      processStartedAt: REFRESH_CACHE_PROCESS_STARTED_AT,
      processToken: REFRESH_CACHE_PROCESS_TOKEN,
      token: randomUUID(),
      acquiredAt: new Date().toISOString()
    };
    try {
      await writeFile(path.join(lock, REFRESH_CACHE_LOCK_FILE), `${JSON.stringify(owner, null, 2)}\n`, {
        flag: 'wx', mode: 0o600
      });
      const state = await refreshCacheLockState(boundary, lock);
      if (state?.record?.token !== owner.token || state.record?.pid !== owner.pid) throw new Error('lock receipt changed');
      return { path: lock, owner };
    } catch {
      const current = await boundedCacheRecord(path.join(lock, REFRESH_CACHE_LOCK_FILE), 4096);
      if (!current || current.token === owner.token) await rm(lock, { recursive: true, force: true });
      return null;
    }
  }
  return null;
}

async function releaseRefreshCacheLock(lease) {
  if (!lease) return;
  const current = await boundedCacheRecord(path.join(lease.path, REFRESH_CACHE_LOCK_FILE), 4096);
  // Never remove a successor's lease if the pathname was replaced while the action was running.
  if (current?.token === lease.owner.token && current?.processToken === lease.owner.processToken) {
    await rm(lease.path, { recursive: true, force: true });
  }
}

async function withRefreshCacheLock(boundary, action) {
  const lease = await acquireRefreshCacheLock(boundary);
  if (!lease) return null;
  try {
    if (!(await refreshCacheBoundaryCurrent(boundary))) return null;
    return await action(boundary.path);
  }
  finally { await releaseRefreshCacheLock(lease); }
}

async function maintainRefreshPlanCache(base, now = Date.now()) {
  const claims = path.join(base, '.claims');
  const claimsInfo = await lstat(claims).catch(() => null);
  if (claimsInfo?.isDirectory() && !claimsInfo.isSymbolicLink()
    && await realpath(claims).catch(() => null) === claims) {
    for (const entry of await readdir(claims, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()
        || !/^\.claim-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
      const directory = path.join(claims, entry.name);
      const info = await lstat(directory).catch(() => null);
      const record = await boundedCacheRecord(path.join(directory, REFRESH_CACHE_CLAIM_FILE), 4096);
      const claimedAt = record?.format === REFRESH_CACHE_CLAIM_FORMAT
        ? Date.parse(record.claimedAt) : Number.NaN;
      const pid = Number(record?.pid);
      let alive = false;
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); alive = true; }
        catch (error) { alive = error?.code === 'EPERM'; }
      }
      const ageBasis = Number.isFinite(claimedAt) ? claimedAt : info?.mtimeMs;
      if (!alive && Number.isFinite(ageBasis) && now - ageBasis > REFRESH_CACHE_MAX_AGE_MS) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
  const retained = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()
      || !/^cfgp-[a-f0-9]{24}$/.test(entry.name)) continue;
    const directory = path.join(base, entry.name);
    const record = await boundedCacheRecord(path.join(directory, 'plan.json'));
    const createdAt = record?.format === REFRESH_CACHE_FORMAT && record?.planId === entry.name
      ? Date.parse(record.createdAt) : Number.NaN;
    if (!Number.isFinite(createdAt) || now - createdAt > REFRESH_CACHE_MAX_AGE_MS) {
      // This directory is beneath the private cache root, has an exact generated plan name, and is
      // either malformed or past its documented reuse window. It is never authority or user data.
      await rm(directory, { recursive: true, force: true });
    } else {
      retained.push({ directory, createdAt });
    }
  }
  retained.sort((left, right) => right.createdAt - left.createdAt);
  await Promise.all(retained.slice(REFRESH_CACHE_MAX_PLANS)
    .map((entry) => rm(entry.directory, { recursive: true, force: true })));
}

async function readRefreshPlanCache(registryFile, planId) {
  if (!/^cfgp-[a-f0-9]{24}$/.test(String(planId ?? ''))) return null;
  const boundary = await approvedRefreshCacheRoot(registryFile);
  if (!boundary) return null;
  const base = boundary.path;
  const directory = path.join(base, planId);
  const directoryInfo = await lstat(directory).catch(() => null);
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) return null;
  try {
    const record = await boundedCacheRecord(path.join(directory, 'plan.json'));
    if (record?.format !== REFRESH_CACHE_FORMAT || record?.planId !== planId
      || !Array.isArray(record.repositories)
      || !Number.isFinite(Date.parse(record.createdAt))
      || Date.now() - Date.parse(record.createdAt) > REFRESH_CACHE_MAX_AGE_MS) return null;
    const repositories = new Map();
    for (const entry of record.repositories) {
      const operationalRemote = assertCredentialFreeRemote(entry?.remote);
      if (operationalRemote !== entry.remote
        || entry.remoteFingerprint !== remoteFingerprint(operationalRemote)
        || repositories.has(operationalRemote)) return null;
      repositories.set(operationalRemote, entry);
    }
    return { base, boundary, directory, repositories };
  } catch {
    return null;
  }
}

/**
 * Retain the already-validated shallow clone between UI preview and apply.
 *
 * This is an untrusted, disposable acceleration cache, never authority. Apply re-observes the
 * exact configuration and state SHAs, recomputes the complete plan ID, and force-with-lease binds
 * publication to those SHAs before any cached object can affect a remote ref.
 */
async function retainRefreshPlanCache(registryFile, planId, candidates) {
  const boundary = await approvedRefreshCacheRoot(registryFile, { create: true });
  if (!boundary) return false;
  const env = isolatedCacheGitEnvironment();
  return await withRefreshCacheLock(boundary, async (base) => {
    await maintainRefreshPlanCache(base);
    const existing = path.join(base, planId);
    const existingInfo = await lstat(existing).catch(() => null);
    if (existingInfo) return existingInfo.isDirectory() && !existingInfo.isSymbolicLink();
    const staging = await mkdtemp(path.join(base, `.${planId}-`));
    const repositories = [];
    try {
      await mkdir(path.join(staging, 'repositories'), { mode: 0o700 });
      for (const candidate of candidates.filter((entry) => entry?.root && entry.sourceCommit)) {
        const key = refreshCacheRepositoryKey(candidate.repository.remote);
        const destination = path.join(staging, 'repositories', key);
        // Clone from the local object database so preview's uncommitted candidate bytes are not
        // retained as authority. This is local I/O: no second remote clone or credential exchange.
        if (candidate.stateBefore.stateCommit) {
          run('git', [
            'update-ref', 'refs/heads/sflow-cache-state', candidate.stateBefore.stateCommit
          ], { cwd: candidate.root, env });
        }
        try {
          run('git', [
            'clone', '--quiet', '--no-hardlinks', '--branch', CONFIGURATION_BRANCH,
            candidate.root, destination
          ], { env });
        } finally {
          if (candidate.stateBefore.stateCommit) {
            run('git', ['update-ref', '-d', 'refs/heads/sflow-cache-state'], {
              cwd: candidate.root, env, allowFailure: true
            });
          }
        }
        if (candidate.stateBefore.stateCommit) {
          run('git', [
            'update-ref', 'refs/heads/sflow-cache-state', candidate.stateBefore.stateCommit
          ], { cwd: destination, env });
        }
        // The operational URL is credential-free but otherwise byte-for-byte exact. A display-safe
        // URL is not transport authority: local and SCP-like paths may legitimately contain `?` or
        // `#`, for which diagnostic redaction would name a different repository.
        run('git', ['remote', 'set-url', 'origin', candidate.repository.remote], {
          cwd: destination, env
        });
        repositories.push({
          key,
          remote: candidate.repository.remote,
          remoteFingerprint: remoteFingerprint(candidate.repository.remote),
          configurationCommit: candidate.sourceCommit,
          stateBranch: candidate.desired.stateConfig.branch,
          stateCommit: candidate.stateBefore.stateCommit,
          productRevision: candidate.refresh.product.revision
        });
      }
      await writeAtomic(path.join(staging, 'plan.json'), `${JSON.stringify({
        // Schema-transient: this cache is optional and authority is revalidated before reuse.
        format: REFRESH_CACHE_FORMAT,
        planId,
        createdAt: new Date().toISOString(),
        repositories
      }, null, 2)}\n`);
      try {
        await rename(staging, existing);
        return true;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
        return true;
      }
    } catch {
      return false;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }) ?? false;
}

async function hardenClaimedRefreshCheckout(root, { env = isolatedCacheGitEnvironment() } = {}) {
  const canonicalRoot = await realpath(root).catch(() => null);
  if (!canonicalRoot) return false;
  const gitPath = path.join(canonicalRoot, '.git');
  const gitInfo = await lstat(gitPath).catch(() => null);
  if (!gitInfo?.isDirectory() || gitInfo.isSymbolicLink()) return false;
  const canonicalGit = await realpath(gitPath).catch(() => null);
  if (canonicalGit !== gitPath) return false;
  // A retained checkout is always an ordinary clone with its own complete .git directory. Git's
  // `commondir` indirection is valid for linked worktrees, but it has no legitimate place here and
  // can redirect objects, repository config and hooks outside this private disposable cache.
  // Refuse it before invoking Git at all; merely rewriting .git/config would otherwise rewrite the
  // wrong (per-worktree) file while Git continued to trust the external common directory.
  if (await lstat(path.join(gitPath, 'commondir')).catch(() => null)) return false;
  for (const name of ['objects', 'refs', 'info']) {
    const info = await lstat(path.join(gitPath, name)).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) return false;
    if (await realpath(path.join(gitPath, name)).catch(() => null) !== path.join(gitPath, name)) return false;
  }
  if (await lstat(path.join(gitPath, 'objects/info/alternates')).catch(() => null)) return false;
  const configFile = path.join(gitPath, 'config');
  const configInfo = await lstat(configFile).catch(() => null);
  if (!configInfo?.isFile() || configInfo.isSymbolicLink() || configInfo.size > 64 * 1024) return false;
  const previous = await readFile(configFile, 'utf8').catch(() => '');
  const objectFormat = previous.match(/^\s*objectformat\s*=\s*(sha1|sha256)\s*$/im)?.[1] ?? 'sha1';
  const fileMode = previous.match(/^\s*filemode\s*=\s*(true|false)\s*$/im)?.[1] ?? 'true';
  const ignoreCase = previous.match(/^\s*ignorecase\s*=\s*(true|false)\s*$/im)?.[1] ?? 'false';
  // Treat the cache as an object bag only. All mutable repository metadata is rebuilt after the
  // claim so replacement refs, grafts, index flags, ignore rules and reflogs cannot change the
  // meaning or visible bytes of the exact remote commit observed for this apply.
  await rm(path.join(gitPath, 'refs'), { recursive: true, force: true });
  await mkdir(path.join(gitPath, 'refs/heads'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(gitPath, 'refs/remotes'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(gitPath, 'refs/tags'), { recursive: true, mode: 0o700 });
  await rm(path.join(gitPath, 'packed-refs'), { force: true });
  await rm(path.join(gitPath, 'logs'), { recursive: true, force: true });
  await rm(path.join(gitPath, 'index'), { force: true });
  await rm(path.join(gitPath, 'index.lock'), { force: true });
  await rm(path.join(gitPath, 'info/grafts'), { force: true });
  await writeAtomic(path.join(gitPath, 'info/exclude'), '');
  await writeAtomic(path.join(gitPath, 'info/attributes'), '');
  await rm(path.join(gitPath, 'sflow-empty-hooks'), { recursive: true, force: true });
  await mkdir(path.join(gitPath, 'sflow-empty-hooks'), { mode: 0o700 });
  await writeAtomic(configFile, [
    '[core]',
    `\trepositoryformatversion = ${objectFormat === 'sha256' ? '1' : '0'}`,
    `\tfilemode = ${fileMode}`,
    '\tbare = false',
    '\tlogallrefupdates = true',
    `\tignorecase = ${ignoreCase}`,
    '\tfsmonitor = false',
    '\thooksPath = .git/sflow-empty-hooks',
    ...(objectFormat === 'sha256' ? ['[extensions]', '\tobjectFormat = sha256'] : []),
    '[remote "origin"]',
    '\turl = invalid://untrusted-cache',
    '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    `[branch "${CONFIGURATION_BRANCH}"]`,
    '\tremote = origin',
    `\tmerge = refs/heads/${CONFIGURATION_BRANCH}`,
    ''
  ].join('\n'));
  const common = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: canonicalRoot, env, allowFailure: true
  });
  if (common.status !== 0) return false;
  const canonicalCommon = await realpath(common.stdout.trim()).catch(() => null);
  if (canonicalCommon !== canonicalGit) return false;
  return true;
}

async function claimRefreshPlanRoot(cache, entry, { env = isolatedCacheGitEnvironment() } = {}) {
  if (!cache || !entry?.key || !/^[a-f0-9]{32}$/.test(entry.key)) return null;
  try {
    const claimed = await withRefreshCacheLock(cache.boundary, async () => {
      const repositoriesRoot = path.join(cache.directory, 'repositories');
      const repositoriesInfo = await lstat(repositoriesRoot).catch(() => null);
      if (!repositoriesInfo?.isDirectory() || repositoriesInfo.isSymbolicLink()) return null;
      if (await realpath(repositoriesRoot).catch(() => null) !== repositoriesRoot) return null;
      const repositoryRoot = path.join(repositoriesRoot, entry.key);
      const info = await lstat(repositoryRoot).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) return null;
      if (await realpath(repositoryRoot).catch(() => null) !== repositoryRoot) return null;
      const claims = path.join(cache.base, '.claims');
      await mkdir(claims, { recursive: true, mode: 0o700 });
      const claimsInfo = await lstat(claims);
      if (!claimsInfo.isDirectory() || claimsInfo.isSymbolicLink()) return null;
      if (await realpath(claims).catch(() => null) !== claims) return null;
      const claim = await mkdtemp(path.join(claims, '.claim-'));
      await rm(claim, { recursive: true, force: true });
      try {
        await rename(repositoryRoot, claim);
        await writeAtomic(path.join(claim, REFRESH_CACHE_CLAIM_FILE), `${JSON.stringify({
          format: REFRESH_CACHE_CLAIM_FORMAT,
          claimedAt: new Date().toISOString(),
          pid: process.pid
        }, null, 2)}\n`);
        return claim;
      } catch {
        await rm(claim, { recursive: true, force: true });
        return null;
      }
    });
    if (!claimed) return null;
    if (!(await hardenClaimedRefreshCheckout(claimed, { env }))) {
      await rm(claimed, { recursive: true, force: true });
      return null;
    }
    return claimed;
  } catch {
    return null;
  }
}

/**
 * Isolate confirmed-refresh Git metadata without discarding enterprise transport and auth.
 *
 * Only effective system/global proxy, CA and credential-helper controls are copied into a fresh
 * command-scoped configuration. Values remain private child-process environment bytes: they are
 * never returned in refresh results, cache records, diagnostics, timing labels, or repository
 * files. Exported so the transport boundary can be exercised without contacting a real provider.
 */
export function isolatedCacheGitEnvironment(sourceEnv = process.env, { runCommand = run } = {}) {
  return enterpriseGitEnvironment(sourceEnv, { runCommand });
}

function stateConfiguration(approved) {
  return {
    ...(approved.ledger ?? {}),
    enabled: true,
    remote: 'origin',
    branch: approved.ledger?.branch ?? 'state'
  };
}

function stateTree(root, ref, policy, { env = process.env } = {}) {
  const listed = run('git', [
    'ls-tree', '-r', '-z', '--format=%(objectmode) %(objectname) %(path)', ref, '--',
    'configuration', ...configurationAssetSearchRoots(policy)
  ], { cwd: root, env });
  const entries = listed.stdout.split('\0').filter(Boolean).map((line) => {
    const first = line.indexOf(' ');
    const second = line.indexOf(' ', first + 1);
    return {
      mode: line.slice(0, first),
      oid: line.slice(first + 1, second),
      file: line.slice(second + 1)
    };
  });
  if (!entries.length) return new Map();
  const batch = run('git', ['cat-file', '--batch'], {
    cwd: root, env, encoding: 'buffer', input: `${entries.map((entry) => entry.oid).join('\n')}\n`
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
    output.set(entry.file, {
      mode: entry.mode,
      object: entry.oid,
      contents: batch.stdout.subarray(start, end)
    });
    cursor = end + 1;
  }
  return output;
}

async function fetchStateRefAsync(root, config, { env = process.env } = {}) {
  const remoteRef = `refs/remotes/${config.remote}/${config.branch}`;
  const fetched = await runRemoteGitAsync([
    'fetch', '--no-tags', config.remote,
    `+refs/heads/${config.branch}:${remoteRef}`
  ], { cwd: root, operation: 'remote-configuration', env });
  if (fetched.status !== 0) return null;
  return run('git', ['rev-parse', remoteRef], { cwd: root, env }).stdout.trim();
}

async function desiredStateProjection(root, { env = process.env } = {}) {
  const policy = await configurationAssetPolicyFromDirectory(root);
  const paths = await configurationAssetPaths(root, policy);
  const files = {};
  const hashes = {};
  const assets = {};
  const canonicalAssets = await canonicalConfigurationAssets(root, paths, { env });
  for (const relative of paths) {
    const asset = canonicalAssets.get(relative);
    files[relative] = asset.contents;
    hashes[relative] = asset.sha256;
    assets[relative] = { sha256: asset.sha256, object: asset.object, mode: asset.mode };
  }
  const approved = YAML.parse(await readFile(path.join(root, WORKFLOW_PATH), 'utf8'));
  return {
    paths,
    files,
    hashes: Object.fromEntries(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right))),
    assets: Object.fromEntries(Object.entries(assets).sort(([left], [right]) => left.localeCompare(right))),
    approved,
    policy,
    stateConfig: stateConfiguration(approved)
  };
}

function observeStateProjection(root, desired, sourceCommit, product, {
  stateCommit,
  env = process.env
} = {}) {
  // Remote observation is deliberately not hidden inside this deterministic projection reader.
  // Callers fetch through `fetchStateRefAsync` first and supply the exact observed commit (including
  // null for a missing branch), keeping every remote operation behind the process-tree supervisor.
  if (!stateCommit) {
    return {
      status: 'missing', stateCommit: null, changed: true,
      missingPaths: desired.paths, changedPaths: [], extraPaths: [], legacyPaths: [], manifest: null
    };
  }
  // Search both the incoming policy and the policy currently mirrored on state. A configuration
  // upgrade can move templates or agents from one custom root to another; looking only under the
  // new roots would declare the projection current while silently leaving the retired root behind.
  let statePolicy = desired.policy;
  try {
    statePolicy = mergeConfigurationAssetPolicies(
      desired.policy,
      configurationAssetPolicyFromRef(root, stateCommit, { env })
    );
  } catch {
    // A malformed old state workflow is repairable. The valid incoming policy remains authoritative,
    // and manifest/source mismatch below forces replacement instead of making refresh unrecoverable.
  }
  const tree = stateTree(root, stateCommit, statePolicy, { env });
  const paths = [...tree.keys()].sort();
  const canonical = paths.filter((relative) => isConfigurationAsset(relative, statePolicy));
  const desiredSet = new Set(desired.paths);
  const missingPaths = desired.paths.filter((relative) => !canonical.includes(relative));
  const changedPaths = desired.paths.filter((relative) => {
    const entry = tree.get(relative);
    const expected = desired.assets[relative];
    return entry != null && (sha256(entry.contents) !== expected.sha256
      || entry.object !== expected.object || entry.mode !== expected.mode);
  });
  const extraPaths = canonical.filter((relative) => !desiredSet.has(relative));
  const legacyPaths = paths.filter((relative) => relative.startsWith(`${STATE_CONFIGURATION_ROOT}/files/`));
  let manifest = null;
  const manifestEntry = tree.get(STATE_CONFIGURATION_MANIFEST);
  if (manifestEntry) {
    try { manifest = JSON.parse(manifestEntry.contents.toString('utf8')); }
    catch { manifest = null; }
  }
  const manifestCurrent = manifest?.format === MIRROR_FORMAT
    && manifest?.layout === 'canonical-paths'
    && manifest?.source?.branch === CONFIGURATION_BRANCH
    && manifest?.source?.commit === sourceCommit
    && equal(manifest?.history ?? null, {
      branch: stateConfigurationHistoryBranch(sourceCommit), commit: sourceCommit
    })
    && manifest?.product?.revision === product.revision
    && equal(manifest?.files ?? {}, desired.hashes)
    && equal(manifest?.assets ?? {}, desired.assets);
  const changed = !manifestCurrent || missingPaths.length > 0 || changedPaths.length > 0
    || extraPaths.length > 0 || legacyPaths.length > 0;
  return {
    status: changed ? 'stale' : 'current', stateCommit, changed,
    missingPaths, changedPaths, extraPaths, legacyPaths, manifest
  };
}

async function observeFreshStateProjection(root, desired, sourceCommit, product, {
  env = process.env
} = {}) {
  const stateCommit = await fetchStateRefAsync(root, desired.stateConfig, { env });
  return observeStateProjection(root, desired, sourceCommit, product, { stateCommit, env });
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
      const operationalRemote = assertCredentialFreeRemote(repository.url);
      const displayRemote = sanitizeRemote(operationalRemote);
      const existing = unique.get(operationalRemote);
      const membership = { workspaceId: manifest.id, workspaceName: manifest.name, repositoryId: repository.id };
      if (existing) {
        existing.memberships.push(membership);
        continue;
      }
      unique.set(operationalRemote, {
        id: repository.id,
        remote: operationalRemote,
        remoteFingerprint: remoteFingerprint(operationalRemote),
        displayRemote,
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
  return [...unique.values()].sort((left, right) =>
    left.displayRemote.localeCompare(right.displayRemote)
      || left.remote.localeCompare(right.remote));
}

async function prepareCandidate(repository, options, { env = process.env } = {}) {
  const cloned = await cloneConfiguration(repository.remote, { env });
  const { root } = cloned;
  const gitEnv = cloned.env;
  try {
    const sourceCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root, env: gitEnv }).stdout.trim();
    const refresh = await refreshPackagedConfiguration(root, options);
    const desired = await desiredStateProjection(root, { env: gitEnv });
    const stateCommit = await fetchStateRefAsync(root, desired.stateConfig, { env: gitEnv });
    const stateBefore = observeStateProjection(root, desired, sourceCommit, refresh.product, {
      stateCommit, env: gitEnv
    });
    return { repository, root, sourceCommit, refresh, desired, stateBefore, gitEnv };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function prepareCachedCandidate(observation, cache, options, { env = isolatedCacheGitEnvironment() } = {}) {
  const entry = cache?.repositories.get(observation.repository.remote);
  if (!entry
    || entry.remoteFingerprint !== observation.repository.remoteFingerprint
    || entry.configurationCommit !== observation.commit
    || entry.stateCommit !== observation.stateCommit
    || entry.productRevision !== productIdentity().revision) return null;
  const root = await claimRefreshPlanRoot(cache, entry, { env });
  if (!root) return null;
  try {
    // Git normally trusts the pathname of a loose object. A strict fsck is therefore mandatory:
    // without it, replacing the bytes stored at an approved SHA can make cat-file/reset consume a
    // different commit while rev-parse still prints the approved name.
    const objectCheck = run('git', [
      'fsck', '--strict', '--no-reflogs', '--full', '--no-progress',
      entry.configurationCommit, ...(entry.stateCommit ? [entry.stateCommit] : [])
    ], { cwd: root, env, allowFailure: true });
    if (objectCheck.status !== 0) throw new Error('cached Git objects failed strict verification');
    const available = run('git', ['cat-file', '-e', `${entry.configurationCommit}^{commit}`], {
      cwd: root, env, allowFailure: true
    });
    if (available.status !== 0) throw new Error('cached configuration commit is unavailable');
    // The cache supplies objects only. Reconstruct both the branch/index and every tracked byte from
    // the exact re-observed commit after replacing untrusted repository config. This clears hidden
    // assume-unchanged/skip-worktree state and refuses any untracked cache modification.
    run('git', ['update-ref', `refs/heads/${CONFIGURATION_BRANCH}`, entry.configurationCommit], { cwd: root, env });
    run('git', ['symbolic-ref', 'HEAD', `refs/heads/${CONFIGURATION_BRANCH}`], { cwd: root, env });
    run('git', ['reset', '--hard', entry.configurationCommit], { cwd: root, env });
    run('git', ['clean', '-ffdx'], { cwd: root, env });
    const sourceCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root, env }).stdout.trim();
    if (sourceCommit !== entry.configurationCommit) throw new Error('cached configuration commit changed');
    if (run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, env }).stdout.trim()) {
      throw new Error('cached configuration checkout is not clean');
    }
    if (entry.stateCommit) {
      const stateObject = run('git', ['cat-file', '-e', `${entry.stateCommit}^{commit}`], {
        cwd: root, env, allowFailure: true
      });
      if (stateObject.status !== 0) throw new Error('cached state commit is unavailable');
      run('git', [
        'update-ref', `refs/remotes/origin/${entry.stateBranch}`, entry.stateCommit
      ], { cwd: root, env });
    }
    const transport = frozenRemoteTransport(observation.repository.remote, { push: true, env });
    // The claimed checkout is disposable. Store the private alias, not the operational URL, so
    // every later named-origin transport must carry the invocation-local exact rewrite below.
    run('git', ['remote', 'set-url', 'origin', transport.remote], {
      cwd: root, env: transport.env
    });
    const refresh = await refreshPackagedConfiguration(root, options);
    const desired = await desiredStateProjection(root, { env: transport.env });
    if (desired.stateConfig.branch !== entry.stateBranch) {
      throw new Error('cached state branch no longer matches approved configuration');
    }
    const stateBefore = observeStateProjection(root, desired, sourceCommit, refresh.product, {
      stateCommit: entry.stateCommit, env: transport.env
    });
    return {
      repository: observation.repository, root, sourceCommit, refresh, desired, stateBefore,
      reusedPreview: true, gitEnv: transport.env
    };
  } catch {
    await rm(root, { recursive: true, force: true });
    return null;
  }
}

async function prepareObservedCandidate(observation, options, cache, { env = process.env } = {}) {
  return await prepareCachedCandidate(observation, cache, options, { env })
    ?? await prepareCandidate(observation.repository, options, { env });
}

function refreshPlanId(candidates, { resolutions, acceptBundledConflicts }) {
  const identity = {
    repositories: candidates.map((candidate) => ({
      remote: candidate.repository.remote,
      remoteFingerprint: candidate.repository.remoteFingerprint,
      configurationCommit: candidate.sourceCommit,
      bootstrapCommit: candidate.bootstrapCommit ?? null,
      stateCommit: candidate.stateBefore.stateCommit,
      productRevision: candidate.refresh.product.revision,
      // These are the exact approved-configuration bytes/modes the preview would publish. Binding
      // only source SHAs and explicit per-path resolutions allowed a later apply to toggle the
      // default conflict policy while retaining the same confirmation token.
      configurationAssets: candidate.desired?.assets ?? null,
      changedFiles: [...(candidate.refresh?.files ?? [])].sort(),
      conflictDecisions: (candidate.refresh?.conflicts ?? []).map((entry) => ({
        path: entry.path, resolution: entry.resolution
      })).sort((left, right) => left.path.localeCompare(right.path))
    })).sort((left, right) => left.remote.localeCompare(right.remote)),
    policy: {
      acceptBundledConflicts: acceptBundledConflicts === true,
      resolutions: canonical(resolutions)
    }
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
    error: refreshErrorMessage(error) ?? 'Configuration refresh preflight failed.'
  };
}

function proposalBranch(candidateCommit, sourceCommit, product) {
  const revision = String(product.revision).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 16);
  return `sflow/config-refresh/${revision}-${sourceCommit.slice(0, 8)}-${candidateCommit.slice(0, 8)}`;
}

/**
 * Recognize the benign publication race where another refresh pushed the same configuration.
 *
 * Git correctly rejects the second sibling commit as non-fast-forward even when its complete tree
 * is byte-identical. Fetch the new authority tip and compare tree objects; only exact identity may
 * join the winner. A genuinely different remote update still takes the review-branch path.
 */
async function identicalConcurrentConfiguration(root, candidateCommit, { env = process.env } = {}) {
  const remoteRef = `refs/remotes/origin/${CONFIGURATION_BRANCH}`;
  const fetched = await runRemoteGitAsync([
    'fetch', '--quiet', '--no-tags', '--force', 'origin',
    `+refs/heads/${CONFIGURATION_BRANCH}:${remoteRef}`
  ], { cwd: root, operation: 'remote-configuration', env });
  if (fetched.status !== 0) return null;
  const approvedCommit = run('git', ['rev-parse', '--verify', `${remoteRef}^{commit}`], {
    cwd: root, env, allowFailure: true
  }).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(approvedCommit)) return null;
  const candidateTree = run('git', ['rev-parse', `${candidateCommit}^{tree}`], { cwd: root, env }).stdout.trim();
  const approvedTree = run('git', ['rev-parse', `${approvedCommit}^{tree}`], { cwd: root, env }).stdout.trim();
  return candidateTree === approvedTree ? approvedCommit : null;
}

async function publishCandidate(candidate) {
  const { root, repository, refresh, sourceCommit, desired } = candidate;
  const env = candidate.gitEnv ?? process.env;
  let approvedCommit = sourceCommit;
  let configurationChanged = false;
  if (refresh.changed) {
    run('git', ['add', '-A', '--', ...refresh.files], { cwd: root, env });
    const staged = run('git', ['diff', '--cached', '--name-only'], { cwd: root, env }).stdout
      .split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    if (staged.length) {
      const actor = gitCommitIdentity(root, { env });
      run('git', [
        '-c', `user.name=${actor.name || 'Singularity Flow'}`,
        '-c', `user.email=${actor.email || 'unknown@invalid'}`,
        'commit', '-m', `[configuration][product:${refresh.product.revision}] refresh packaged configuration`
      ], { cwd: root, env });
      const candidateCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root, env }).stdout.trim();
      const pushed = await runRemoteGitAsync([
        'push', `--force-with-lease=refs/heads/${CONFIGURATION_BRANCH}:${sourceCommit}`,
        'origin', `HEAD:refs/heads/${CONFIGURATION_BRANCH}`
      ], {
        cwd: root, operation: 'remote-push', env
      });
      if (pushed.status !== 0) {
        const concurrentCommit = await identicalConcurrentConfiguration(root, candidateCommit, { env });
        if (concurrentCommit) {
          approvedCommit = concurrentCommit;
          configurationChanged = true;
        } else {
          const branch = proposalBranch(candidateCommit, sourceCommit, refresh.product);
          const retained = await runRemoteGitAsync([
            'push', `--force-with-lease=refs/heads/${branch}:`,
            'origin', `HEAD:refs/heads/${branch}`
          ], {
            cwd: root, operation: 'remote-push', env
          });
          if (retained.status !== 0) {
            const observed = await remoteHeads(repository.remote, [branch], { env });
            if (observed.get(branch) !== candidateCommit) {
              throw new SingularityFlowError(
                `Configuration update for '${repository.displayRemote}' was rejected and its review branch could not be retained. `
                  + remoteFailureMessage(retained)
              );
            }
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
            error: remoteFailureMessage(pushed, 'Git rejected the exact configuration update; review repository policy and retry.')
          };
        }
      } else {
        approvedCommit = candidateCommit;
        configurationChanged = true;
      }
    }
  }

  try {
  const projection = configurationChanged ? await desiredStateProjection(root, { env }) : desired;
  const stateBefore = observeStateProjection(root, projection, approvedCommit, refresh.product, {
    stateCommit: candidate.stateBefore.stateCommit, env
  });
  const mirrored = { ...projection.files };
  const history = await retainStateConfigurationHistory(
    root, projection.stateConfig.remote, approvedCommit, { env }
  );
  const manifest = {
    format: MIRROR_FORMAT,
    layout: 'canonical-paths',
    source: { branch: CONFIGURATION_BRANCH, commit: approvedCommit },
    history,
    product: refresh.product,
    files: projection.hashes,
    assets: projection.assets
  };
  mirrored[STATE_CONFIGURATION_MANIFEST] = `${JSON.stringify(manifest, null, 2)}\n`;
  let state;
  try {
    const publicationOptions = {
      replaceRoots: [STATE_CONFIGURATION_ROOT],
      removePaths: stateBefore.extraPaths,
      // Absence is an authority value too. A concurrent first state publisher must make this
      // confirmed plan stale rather than becoming an unreviewed base for its projection.
      expectedRemoteSha: stateBefore.stateCommit,
      guardedRemoteRefs: {
        [`refs/heads/${CONFIGURATION_BRANCH}`]: approvedCommit
      },
      env,
      ...(stateBefore.stateCommit ? {
        baseRef: stateBefore.stateCommit,
        refreshRemote: false
      } : {})
    };
    state = await publishToStateBranch(
      root,
      projection.stateConfig,
      mirrored,
      `[configuration][source:${approvedCommit.slice(0, 12)}] mirror approved configuration`,
      publicationOptions
    );
  } catch (error) {
    // The matching configuration race can continue into the state projection: both publishers
    // create the same mirror and one loses the lease. The winner may have created the empty state
    // root but not its mirror commit yet, so wait for that bounded in-flight publication. Join only
    // when a fresh fetch proves that the complete projection, source commit and product identity are
    // exact; a different or stalled publication remains a failure.
    if (error?.code !== 'state_branch.concurrent_publication' && error?.concurrent !== true) throw error;
    let concurrentState = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      concurrentState = await observeFreshStateProjection(
        root, projection, approvedCommit, refresh.product, { env }
      );
      if (concurrentState.status === 'current') break;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
    if (concurrentState.status !== 'current') throw error;
    state = { commit: concurrentState.stateCommit, changed: false, removed: [] };
  }
  const stateRef = state.commit
    ?? run('git', ['rev-parse', `refs/remotes/origin/${projection.stateConfig.branch}`], { cwd: root, env }).stdout.trim();
  const verified = run('git', ['show', `${stateRef}:${STATE_CONFIGURATION_MANIFEST}`], { cwd: root, env });
  let verifiedManifest;
  try { verifiedManifest = JSON.parse(verified.stdout); }
  catch { throw new SingularityFlowError(`State configuration mirror for '${repository.displayRemote}' is not valid JSON.`); }
  if (verifiedManifest?.source?.commit !== approvedCommit) {
    throw new SingularityFlowError(`State configuration mirror for '${repository.displayRemote}' does not pin the approved configuration commit.`);
  }
  const stateAfter = observeStateProjection(root, projection, approvedCommit, refresh.product, {
    stateCommit: stateRef, env
  });
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
  } catch (error) {
    // Configuration and state are two remote publications. If the first succeeded, never report
    // the repository as unchanged merely because the second failed: that hides the exact durable
    // progress a retry must resume from and led operators to repeat configuration publication.
    if (configurationChanged) {
      error.details = {
        ...(error?.details && typeof error.details === 'object' ? error.details : {}),
        partialPublication: {
          configurationChanged: true,
          configurationCommit: approvedCommit,
          stateChanged: false
        }
      };
    }
    throw error;
  }
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
  // Preview and apply are two halves of one reviewed operation, so they must observe the authority
  // through the same transport/authentication environment. In particular, preview must not succeed
  // through a hostile command-scoped rewrite or fail because it discarded the system/global proxy,
  // CA, or credential helper that apply will use. The isolated snapshot preserves only the reviewed
  // enterprise allowlist and neutralizes repository selectors, hooks, replacements, alternates,
  // trace sinks, and inherited command-scoped configuration for both halves. A rejected cache falls
  // back to a fresh clone under this exact same boundary.
  const gitEnv = isolatedCacheGitEnvironment();
  const targets = await registeredRepositories(registryFile, { workspace, repositories });
  const workers = gitWorkerCount(targets.length);
  const cachedPlan = confirmPlan ? await readRefreshPlanCache(registryFile, confirmPlan) : null;
  const observations = await mapLimit(targets, workers, async (repository) => {
    try {
      const cacheEntry = cachedPlan?.repositories.get(repository.remote) ?? null;
      const cachedStateBranch = isGitRefName(cacheEntry?.stateBranch ?? '')
        ? cacheEntry.stateBranch : null;
      const heads = await remoteHeads(repository.remote, [
        CONFIGURATION_BRANCH, repository.defaultBranch, cachedStateBranch
      ], { env: gitEnv });
      const commit = heads.get(CONFIGURATION_BRANCH) ?? null;
      // A missing configuration authority is seeded from the application default branch. Bind the
      // preview to that exact revision as well: otherwise main can move after preview and the apply
      // operation can silently approve bytes the user never reviewed.
      const bootstrapCommit = commit
        ? null
        : heads.get(repository.defaultBranch) ?? null;
      if (!commit && !bootstrapCommit) {
        throw new SingularityFlowError(
          `Cannot initialize '${repository.id}': remote branch '${repository.defaultBranch}' does not exist.`,
          { code: 'CONFIGURATION_BOOTSTRAP_SOURCE_MISSING' }
        );
      }
      return {
        repository, commit, bootstrapCommit,
        stateCommit: cachedStateBranch ? heads.get(cachedStateBranch) ?? null : undefined,
        error: null
      };
    } catch (error) {
      return { repository, commit: null, bootstrapCommit: null, error };
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
        error: refreshErrorMessage(item.error)
      }))
    };
  }

  if (dryRun) {
    const prepared = await mapLimit(observations, workers, async (observation) => {
      if (!observation.commit) {
        const planCandidate = {
          repository: observation.repository, sourceCommit: null,
          bootstrapCommit: observation.bootstrapCommit,
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
        }, { env: gitEnv });
      } catch (error) {
        return { planCandidate: null, result: refreshPreflightFailure(observation, error) };
      }
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
    });
    const planCandidates = prepared.map((entry) => entry.planCandidate).filter(Boolean);
    const results = prepared.map((entry) => entry.result);
    const blocked = results.some((entry) => entry.status === 'blocked');
    const planId = blocked ? null : refreshPlanId(planCandidates, {
      resolutions: normalizedResolutions, acceptBundledConflicts
    });
    if (planId) {
      await retainRefreshPlanCache(registryFile, planId, planCandidates).catch(() => false);
    }
    await Promise.all(planCandidates
      .filter((candidate) => candidate.root)
      .map((candidate) => rm(candidate.root, { recursive: true, force: true })));
    return {
      status: blocked ? 'blocked' : 'preview', dryRun: true,
      ...(planId ? { planId } : {}),
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
          bootstrapCommit: observation.bootstrapCommit,
          stateBefore: { stateCommit: null }, refresh: { product: productIdentity() }
        }, retained: false, error: null };
      }
      try {
        const candidate = await prepareObservedCandidate(observation, {
          acceptBundledConflicts, resolutions: normalizedResolutions
        }, cachedPlan, { env: gitEnv });
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
            error: refreshErrorMessage(failed?.error)
          };
        })
      };
    }
    previewBoundPlanId = refreshPlanId(confirmationCandidates, {
      resolutions: normalizedResolutions, acceptBundledConflicts
    });
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
      const initialization = await ensureConfigurationBranch(observation.repository.remote, {
        sourceBranch: observation.repository.defaultBranch,
        sourceCommit: observation.bootstrapCommit,
        env: gitEnv
      });
      return { observation, initialization, error: null };
    } catch (error) {
      return { observation, initialization: null, error };
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
          error: refreshErrorMessage(failed?.error)
        };
      })
    };
  }
  const concurrentInitializations = confirmPlan
    ? initialized.filter((entry) => !entry.error && entry.initialization?.created === false)
    : [];
  if (concurrentInitializations.length) {
    await Promise.all(candidates.map((candidate) => rm(candidate.root, { recursive: true, force: true })));
    return {
      status: 'blocked', dryRun: false, total: targets.length, updated: 0,
      results: observations.map((item) => {
        const moved = concurrentInitializations.find((entry) => entry.observation === item);
        return {
          status: moved ? 'stale-plan' : 'preflight-passed', repository: item.repository.id,
          remote: item.repository.displayRemote, memberships: item.repository.memberships,
          configurationChanged: false, stateChanged: false,
          error: moved
            ? 'Configuration authority was created concurrently after preview. Create and review a fresh plan before applying it.'
            : null
        };
      })
    };
  }

  const toPrepare = observations.filter((observation) => !(previewBoundPlanId && observation.commit));
  const prepared = await mapLimit(toPrepare, workers, async (observation) => {
    try {
      const candidate = await prepareObservedCandidate(observation, {
        acceptBundledConflicts, resolutions: normalizedResolutions
      }, cachedPlan, { env: gitEnv });
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
          error: refreshErrorMessage(failed?.error)
        };
      })
    };
  }

  const planId = previewBoundPlanId ?? refreshPlanId(candidates, {
    resolutions: normalizedResolutions, acceptBundledConflicts
  });
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
        const partial = error?.details?.partialPublication ?? {};
        return {
          status: 'failed', repository: candidate.repository.id,
          remote: candidate.repository.displayRemote, memberships: candidate.repository.memberships,
          configurationChanged: partial.configurationChanged === true,
          configurationCommit: partial.configurationCommit ?? null,
          stateChanged: partial.stateChanged === true,
          error: refreshErrorMessage(error)
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
