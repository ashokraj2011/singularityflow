import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

import { BUILD_INFO } from './build-info.mjs';
import { configurationAssetPaths, CONFIGURATION_BRANCH, ensureConfigurationBranch } from './configuration-branch.mjs';
import { validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { identity } from './git.mjs';
import { publishToStateBranch } from './ledger.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { sanitizeRemote } from './git-remote-diagnostics.mjs';
import { SingularityFlowError, run, writeAtomic } from './util.mjs';
import { VERSION } from './version.mjs';
import { readWorkspace, readWorkspaceRegistry, workspaceRepositoryPath } from './workspace.mjs';

export const PACKAGE_BASELINE_PATH = 'singularity/.product/configuration-baseline.yml';
export const STATE_CONFIGURATION_ROOT = 'configuration';
export const STATE_CONFIGURATION_MANIFEST = `${STATE_CONFIGURATION_ROOT}/manifest.json`;
const BASELINE_FORMAT = 'singularity-flow-configuration-baseline/v1';
const MIRROR_FORMAT = 'singularity-flow-configuration-mirror/v1';

const FIXED_PACKAGE_ASSETS = Object.freeze([
  ['agent-mappings.yml', 'singularity/agent-mappings.yml'],
  ['impact.yml', 'singularity/impact.yml'],
  ['modelTiers.yml', 'singularity/modelTiers.yml'],
  ['worldmodel-builder.md', 'singularity/prompts/worldmodel-builder.md'],
  ['copilot-planning.md', 'singularity/prompts/copilot-planning.md']
]);

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
 * Three-way merge one packaged value into approved repository configuration.
 *
 * The package baseline is the version last examined by a refresh. A repository value that still
 * equals that baseline can move automatically; a value changed by both the repository and the new
 * package is retained and reported. With no baseline, recursive additions are safe but differing
 * scalar/array values are treated as customizations rather than guessed at.
 */
export function mergePackagedConfiguration(base, local, incoming, {
  acceptBundledConflicts = false
} = {}) {
  const conflicts = [];

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
      conflict(parts, localValue, undefined, 'preserved-local');
      return { present: true, value: clone(localValue) };
    }

    if (!localPresent) {
      if (!basePresent) return { present: true, value: clone(incomingValue) };
      if (equal(incomingValue, baseValue)) return { present: false, value: undefined };
      conflict(parts, undefined, incomingValue,
        acceptBundledConflicts ? 'accepted-bundled' : 'preserved-local-deletion');
      return acceptBundledConflicts
        ? { present: true, value: clone(incomingValue) }
        : { present: false, value: undefined };
    }

    if (!basePresent) {
      if (equal(localValue, incomingValue)) return { present: true, value: clone(localValue) };
      if (plainObject(localValue) && plainObject(incomingValue)) {
        return { present: true, value: mergeObject({}, localValue, incomingValue, parts) };
      }
      conflict(parts, localValue, incomingValue,
        acceptBundledConflicts ? 'accepted-bundled' : 'preserved-local');
      return { present: true, value: clone(acceptBundledConflicts ? incomingValue : localValue) };
    }

    if (equal(localValue, baseValue)) return { present: true, value: clone(incomingValue) };
    if (equal(incomingValue, baseValue) || equal(localValue, incomingValue)) {
      return { present: true, value: clone(localValue) };
    }
    if (plainObject(baseValue) && plainObject(localValue) && plainObject(incomingValue)) {
      return { present: true, value: mergeObject(baseValue, localValue, incomingValue, parts) };
    }
    conflict(parts, localValue, incomingValue,
      acceptBundledConflicts ? 'accepted-bundled' : 'preserved-local');
    return { present: true, value: clone(acceptBundledConflicts ? incomingValue : localValue) };
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
  acceptBundledConflicts = false
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

  const merged = mergePackagedConfiguration(baseline?.workflow ?? {}, current, incoming, {
    acceptBundledConflicts
  });
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
    const safeToWrite = !info || currentHash === bundledHash || (priorHash && currentHash === priorHash);
    if (currentHash === bundledHash) continue;
    if (!safeToWrite && !acceptBundledConflicts) {
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
    if (currentHash !== prior.sha256 && !acceptBundledConflicts) {
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

  return {
    product: lock.product,
    changed: changedFiles.size > 0,
    files: [...changedFiles].sort(),
    removed: [...removedFiles].sort(),
    conflicts,
    dryRun
  };
}

function remoteHead(remote, branch = CONFIGURATION_BRANCH) {
  const observed = run('git', ['ls-remote', '--heads', remote, `refs/heads/${branch}`], { allowFailure: true });
  if (observed.status !== 0) {
    throw new SingularityFlowError(`Cannot read '${sanitizeRemote(remote)}': ${(observed.stderr || observed.stdout).trim().split('\n')[0]}`);
  }
  const line = observed.stdout.split(/\r?\n/).find((entry) => entry.trim());
  return line ? line.trim().split(/\s+/)[0] : null;
}

async function cloneConfiguration(remote) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-refresh-'));
  const cloned = run('git', [
    'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
    '--branch', CONFIGURATION_BRANCH, remote, scratch
  ], { allowFailure: true });
  if (cloned.status !== 0) {
    await rm(scratch, { recursive: true, force: true });
    throw new SingularityFlowError(
      `Cannot clone '${sanitizeRemote(remote)}' branch '${CONFIGURATION_BRANCH}': ${(cloned.stderr || cloned.stdout).trim().split('\n')[0]}`
    );
  }
  return scratch;
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
    return { repository, root, sourceCommit, refresh };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function proposalBranch(candidateCommit, sourceCommit, product) {
  const revision = String(product.revision).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 16);
  return `sflow/config-refresh/${revision}-${sourceCommit.slice(0, 8)}-${candidateCommit.slice(0, 8)}`;
}

async function publishCandidate(candidate) {
  const { root, repository, refresh, sourceCommit } = candidate;
  let approvedCommit = sourceCommit;
  let configurationChanged = false;
  if (refresh.changed) {
    run('git', ['add', '-A', '--', ...refresh.files], { cwd: root });
    const staged = run('git', ['diff', '--cached', '--name-only'], { cwd: root }).stdout
      .split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    if (staged.length) {
      const actor = identity(root);
      run('git', [
        '-c', `user.name=${actor.name || 'Singularity Flow'}`,
        '-c', `user.email=${actor.email || 'unknown@invalid'}`,
        'commit', '-m', `[configuration][product:${refresh.product.revision}] refresh packaged configuration`
      ], { cwd: root });
      const candidateCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
      const pushed = run('git', ['push', 'origin', `HEAD:refs/heads/${CONFIGURATION_BRANCH}`], {
        cwd: root, allowFailure: true
      });
      if (pushed.status !== 0) {
        const branch = proposalBranch(candidateCommit, sourceCommit, refresh.product);
        const retained = run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], {
          cwd: root, allowFailure: true
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

  const paths = await configurationAssetPaths(root);
  const mirrored = {};
  const hashes = {};
  for (const relative of paths) {
    const contents = await readFile(path.join(root, relative));
    mirrored[`${STATE_CONFIGURATION_ROOT}/files/${relative}`] = contents;
    hashes[relative] = sha256(contents);
  }
  const manifest = {
    format: MIRROR_FORMAT,
    source: { branch: CONFIGURATION_BRANCH, commit: approvedCommit },
    product: refresh.product,
    files: Object.fromEntries(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)))
  };
  mirrored[STATE_CONFIGURATION_MANIFEST] = `${JSON.stringify(manifest, null, 2)}\n`;
  const approved = YAML.parse(await readFile(path.join(root, WORKFLOW_PATH), 'utf8'));
  const stateConfig = {
    ...(approved.ledger ?? {}),
    enabled: true,
    remote: 'origin',
    branch: approved.ledger?.branch ?? 'state'
  };
  const state = await publishToStateBranch(
    root,
    stateConfig,
    mirrored,
    `[configuration][source:${approvedCommit.slice(0, 12)}] mirror approved configuration`,
    { replaceRoots: [STATE_CONFIGURATION_ROOT] }
  );
  const stateRef = state.commit
    ?? run('git', ['rev-parse', `refs/remotes/origin/${stateConfig.branch}`], { cwd: root }).stdout.trim();
  const verified = run('git', ['show', `${stateRef}:${STATE_CONFIGURATION_MANIFEST}`], { cwd: root });
  let verifiedManifest;
  try { verifiedManifest = JSON.parse(verified.stdout); }
  catch { throw new SingularityFlowError(`State configuration mirror for '${repository.displayRemote}' is not valid JSON.`); }
  if (verifiedManifest?.source?.commit !== approvedCommit) {
    throw new SingularityFlowError(`State configuration mirror for '${repository.displayRemote}' does not pin the approved configuration commit.`);
  }
  return {
    status: 'updated',
    repository: repository.id,
    remote: repository.displayRemote,
    memberships: repository.memberships,
    sourceCommit,
    configurationCommit: approvedCommit,
    stateCommit: stateRef,
    configurationChanged,
    stateChanged: state.changed,
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
  acceptBundledConflicts = false
} = {}) {
  if (!registryFile) throw new SingularityFlowError('Workspace configuration refresh requires the workspace registry path.');
  const targets = await registeredRepositories(registryFile, { workspace, repositories });
  const observations = [];
  for (const repository of targets) {
    try {
      const commit = remoteHead(repository.remote);
      observations.push({ repository, commit, error: null });
    } catch (error) {
      observations.push({ repository, commit: null, error });
    }
  }
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
    const results = [];
    for (const observation of observations) {
      if (!observation.commit) {
        results.push({
          status: 'would-initialize', repository: observation.repository.id,
          remote: observation.repository.displayRemote, memberships: observation.repository.memberships,
          configurationChanged: true, stateChanged: true
        });
        continue;
      }
      const candidate = await prepareCandidate(observation.repository, {
        dryRun: true, acceptBundledConflicts
      });
      try {
        results.push({
          status: candidate.refresh.changed ? 'would-update' : 'current',
          repository: observation.repository.id,
          remote: observation.repository.displayRemote,
          memberships: observation.repository.memberships,
          configurationChanged: candidate.refresh.changed,
          stateChanged: true,
          files: candidate.refresh.files,
          conflicts: candidate.refresh.conflicts
        });
      } finally {
        await rm(candidate.root, { recursive: true, force: true });
      }
    }
    return { status: 'preview', dryRun: true, total: targets.length, updated: 0, results };
  }

  // New workspace repositories receive the same authority as a normal bootstrap before candidate
  // preparation. Existing authorities remain untouched during this step.
  const initializationFailures = [];
  for (const observation of observations.filter((item) => !item.commit)) {
    try {
      await ensureConfigurationBranch(observation.repository.remote, {
        sourceBranch: observation.repository.defaultBranch
      });
    } catch (error) {
      initializationFailures.push({ observation, error });
    }
  }
  if (initializationFailures.length) {
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

  const candidates = [];
  const preparationFailures = [];
  for (const observation of observations) {
    try {
      candidates.push(await prepareCandidate(observation.repository, { acceptBundledConflicts }));
    } catch (error) {
      preparationFailures.push({ observation, error });
    }
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

  const results = [];
  try {
    for (const candidate of candidates) {
      try { results.push(await publishCandidate(candidate)); }
      catch (error) {
        results.push({
          status: 'failed', repository: candidate.repository.id,
          remote: candidate.repository.displayRemote, memberships: candidate.repository.memberships,
          configurationChanged: false, stateChanged: false, error: error.message
        });
      }
    }
  } finally {
    await Promise.all(candidates.map((candidate) => rm(candidate.root, { recursive: true, force: true })));
  }
  const failed = results.filter((result) => ['failed', 'review-required'].includes(result.status));
  return {
    status: failed.length ? 'partial' : 'complete',
    dryRun: false,
    total: targets.length,
    updated: results.filter((result) => result.status === 'updated').length,
    failed: failed.length,
    results
  };
}
