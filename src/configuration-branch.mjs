/**
 * Shared Singularity configuration lives on a branch that is independent of application history.
 *
 * `main` is application code, `sflow/config` is approved configuration, and a lifecycle branch
 * receives an exact copy of the approved configuration when it is created.  The copy is deliberate:
 * every later phase must see the same prompts, agents, templates and policies even when the shared
 * configuration branch moves on.
 */
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import YAML from 'yaml';
import {
  chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, utimes, writeFile
} from 'node:fs/promises';
import { initializeDefinition, loadDefinition, resolveWorkType } from './config.mjs';
import {
  describeCapability, describeRepository, enableLedger, repositoryIdFromUrl,
  setDefaultBaseBranch, setGroundingMode
} from './bootstrap.mjs';
import { loadCapabilities } from './capabilities.mjs';
import { gitCommitIdentity } from './git.mjs';
import {
  GitRemoteSession, requireRemoteObservation, runRemoteGit, runRemoteGitAsync,
  sealTemporaryGitReadTransport
} from './git-execution.mjs';
import {
  activeWorkspaceFile, workspaceMemberContextForRepository, workspaceRegistryFile
} from './workspace-context.mjs';
import { removeTemporaryTree, SingularityFlowError, run } from './util.mjs';
import {
  assertCredentialFreeRemote, configuredRemoteAuthority, configuredRemoteIdentity,
  frozenRemoteTransport, isPortableAbsoluteGitPath, sanitizeRemote
} from './git-remote-diagnostics.mjs';
import { executeGitQuery } from './git-query.mjs';
import { enterpriseGitEnvironment, inheritEnterpriseGitEnvironment } from './git-enterprise-environment.mjs';
import { gitDisabledHooksPath } from './git-isolation-paths.mjs';
import { processResultCompleted, processResultSucceeded } from './process-result.mjs';
import {
  createAndPushTransportIntent, listTransportIntents, retryTransportIntent
} from './transport-intents.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { incrementCommandCounter } from './dx-command-timing.mjs';
import { acquireFileLease, inspectFileLease } from './file-lease.mjs';
import {
  configurationAssetPolicy, configurationAssetSearchRoots, DEFAULT_CONFIGURATION_ASSET_POLICY,
  isConfigurationAssetPath,
  mergeConfigurationAssetPolicies
} from './configuration-assets.mjs';
import { withConfigurationReadRoot } from './configuration-read-scope.mjs';
import { recordSha256 } from './records.mjs';
import { readLocalGitBlobs } from './git-blob-batch.mjs';
import {
  assertSkillPackagePath, inspectSkillPackageContents, SKP_CAPTURE_LIMITS
} from './skp-package.mjs';
import {
  gitRepositoryComparisonKey, sameGitRepository
} from './git-repository-identity.mjs';

export const CONFIGURATION_BRANCH = 'sflow/config';
export const CONFIGURATION_SOURCE_PATH = 'singularity/configuration-source.json';
export const STATE_CONFIGURATION_BRANCH = 'state';
export const STATE_CONFIGURATION_MANIFEST = 'configuration/manifest.json';
export const STATE_CONFIGURATION_FORMAT = 'singularity-flow-configuration-mirror/v2';
export const STATE_CONFIGURATION_HISTORY_PREFIX = 'sflow/config-history';

const STORY_CONFIGURATION_SNAPSHOT = Symbol('story-configuration-snapshot');
const STORY_CONFIGURATION_AUTHORITY_SNAPSHOT = Symbol('story-configuration-authority-snapshot');
// The public snapshot projection is convenient for ordinary readers but nested objects remain
// mutable. Keep the verified definition in a private slot so later Story policy/authority reads
// cannot be widened by changing snapshot.definition after the approved bytes were loaded.
const STORY_CONFIGURATION_VERIFIED_DEFINITIONS = new WeakMap();
// New authoring replacements require committed object bytes. Do not reinterpret the historical
// Story projection, whose ordinary assets may preserve checked-out EOL/filter compatibility.
const STORY_CONFIGURATION_AUTHORING_GIT_BYTES = new WeakMap();
const MIRROR_AUTHORING_GIT_BYTES = new WeakMap();
const AUTHORING_GIT_BYTE_LIMITS = Object.freeze({ assets: 1024, objectBytes: 8 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 });
const LEGACY_MIRROR_GIT_LIMITS = Object.freeze({ assets: 16 * 1024, listingBytes: 16 * 1024 * 1024,
  objectBytes: 8 * 1024 * 1024, totalBytes: 128 * 1024 * 1024 });
const SNAPSHOT_TYPED_ARRAY = Object.getPrototypeOf(Uint8Array.prototype);
const SNAPSHOT_BYTE_LENGTH = Object.getOwnPropertyDescriptor(SNAPSHOT_TYPED_ARRAY, 'byteLength').get;
const SNAPSHOT_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(SNAPSHOT_TYPED_ARRAY, 'buffer').get;
const SNAPSHOT_COPY_BYTES = Uint8Array.prototype.set;
// This receipt is written by configuration refresh after it has compared repository bytes with the
// installed package.  A copy found on an application branch is not approved authority and must not
// be imported into a newly-created sflow/config branch.  Importing it let an application commit
// claim arbitrary files as framework-owned before the first reviewed configuration existed.
const PACKAGE_CONFIGURATION_BASELINE = 'singularity/.product/configuration-baseline.yml';
// Remote-only Git reads do not need the host application's ambient cwd. VS Code extension hosts
// can start at the filesystem root, where the hardened executable resolver must reject every
// absolute executable as a possible cwd-local binary. Bind those reads to the OS temp directory;
// repository-aware observations use their verified repository root, while private clones use the
// parent of their freshly-created scratch directory.
const REMOTE_GIT_READ_CWD = path.resolve(os.tmpdir());
// A performance-only, explicitly requested CLI profile. Gateway/default reads never create or
// inspect this store. Each key retains one full, exact configuration commit, not a snapshot or an
// approval receipt. Unsupported checkout transforms keep the original remote-clone path.
export const STORY_CONFIGURATION_OBJECT_CACHE_LIMITS = Object.freeze({
  entries: 32, files: 4096, listingBytes: 2 * 1024 * 1024,
  objectBytes: 8 * 1024 * 1024, materializedBytes: 64 * 1024 * 1024,
  storageFiles: 16 * 1024, storageBytes: 256 * 1024 * 1024,
  leaseWaitMs: 250
});

function stateMirrorRepositoryIdentity(remote) {
  const repositoryKey = gitRepositoryComparisonKey(remote);
  return repositoryKey ? `sha256:${recordSha256({ repositoryKey })}` : null;
}

async function legacyMirrorAssetsMatch(root, manifest, { env = process.env } = {}) {
  const declared = Object.keys(manifest?.files ?? {}).sort();
  const descriptors = manifest?.assets;
  if (!declared.length || !descriptors || typeof descriptors !== 'object'
      || Array.isArray(descriptors)
      || JSON.stringify(Object.keys(descriptors).sort()) !== JSON.stringify(declared)) return false;
  let policy;
  let paths;
  try {
    policy = configurationAssetPolicyFromRef(root, 'HEAD', { env });
    paths = await configurationAssetPaths(root, policy);
  } catch { return false; }
  if (JSON.stringify(paths) !== JSON.stringify(declared)) return false;
  const entries = configurationTreeEntries(root, 'HEAD', policy, { env });
  for (const relative of declared) {
    const file = path.join(root, ...relative.split('/'));
    const info = await lstat(file).catch(() => null);
    const descriptor = descriptors[relative];
    const actual = entries.get(relative);
    if (!info?.isFile() || info.isSymbolicLink() || !descriptor || !actual
        || descriptor.sha256 !== manifest.files[relative]
        || descriptor.object !== actual.object || descriptor.mode !== actual.mode
        || createHash('sha256').update(await readFile(file)).digest('hex') !== descriptor.sha256) {
      return false;
    }
  }
  return true;
}

/**
 * Compatibility proof for deployed v2 mirrors written before subject.repositoryIdentity.
 *
 * A portfolio URL inside the mirror is self-asserted and cannot bind it to this repository. The
 * legacy adapter therefore also requires the same repository to retain the exact approved
 * configuration commit under the source-addressed history branch, with every mirrored blob and
 * Git mode matching that retained tree. Callers outside onboarding share this strict proof so an
 * old copied mirror cannot become Story or capability authority through another read path.
 */
export async function legacyStateMirrorMatchesRepository(root, remote, {
  env = process.env, runRemoteCommand = runRemoteGitAsync
} = {}) {
  const file = path.join(root, 'singularity', 'portfolio.yml');
  const info = await lstat(file).catch((error) => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!info?.isFile() || info.isSymbolicLink()) return false;
  let portfolio;
  try { portfolio = YAML.parse(await readFile(file, 'utf8')) ?? {}; }
  catch { return false; }
  const matches = Object.values(portfolio?.repositories ?? {})
    .filter((entry) => sameGitRepository(entry?.url, remote));
  if (matches.length !== 1) return false;

  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(root, STATE_CONFIGURATION_MANIFEST), 'utf8'));
  } catch { return false; }
  if (manifest?.subject?.repositoryIdentity != null
      || manifest?.format !== STATE_CONFIGURATION_FORMAT
      || manifest?.source?.branch !== CONFIGURATION_BRANCH
      || !/^[0-9a-f]{40,64}$/u.test(manifest?.source?.commit ?? '')) return false;
  const historyBranch = stateConfigurationHistoryBranch(manifest.source.commit);
  if (manifest?.history?.branch !== historyBranch
      || manifest?.history?.commit !== manifest.source.commit
      || !await legacyMirrorAssetsMatch(root, manifest, { env })) return false;

  return legacyMirrorRetainedHistoryMatches(remote, manifest, {
    env, runRemoteCommand, verifyAssets: legacyMirrorAssetsMatch
  });
}

async function legacyMirrorRetainedHistoryMatches(remote, manifest, {
  env, runRemoteCommand, verifyAssets, checkout = true
}) {
  const historyBranch = stateConfigurationHistoryBranch(manifest.source.commit);
  const retained = await mkdtemp(path.join(os.tmpdir(), 'sflow-legacy-state-proof-'));
  try {
    const transport = frozenRemoteTransport(remote, { env });
    const cloned = await runRemoteCommand([
      '-c', 'core.autocrlf=false', 'clone', '--quiet', '--no-local', '--no-tags',
      ...(checkout ? [] : ['--no-checkout']),
      '--single-branch', '--depth', '1', '--branch', historyBranch,
      transport.remote, retained
    ], {
      cwd: path.dirname(retained), operation: 'remote-configuration', env: transport.env
    });
    if (cloned.status !== 0) return false;
    const retainedCommit = run('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: retained, env: transport.env, allowFailure: true
    }).stdout.trim();
    return retainedCommit === manifest.source.commit
      && await verifyAssets(retained, manifest, { env: transport.env, ref: retainedCommit });
  } catch { return false; }
  finally { await removeTemporaryTree(retained); }
}

// The generic mirror reader has no checkout. Prove its compatibility from bounded immutable Git
// objects instead of asking a missing filesystem projection to establish repository ownership.
function legacyMirrorGitAssets(root, manifest, { env, ref }) {
  try {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(ref ?? '')) return null;
    const declared = Object.keys(manifest?.files ?? {}).sort();
    const descriptors = manifest?.assets;
    if (!declared.length || declared.length > LEGACY_MIRROR_GIT_LIMITS.assets
        || !descriptors || typeof descriptors !== 'object' || Array.isArray(descriptors)
        || JSON.stringify(Object.keys(descriptors).sort()) !== JSON.stringify(declared)
        || !declared.includes('singularity/workflow.yml') || !declared.includes('singularity/portfolio.yml')) return null;
    const localEnv = { ...env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' };
    const options = { env: localEnv, maxBuffer: LEGACY_MIRROR_GIT_LIMITS.listingBytes, includeNonRegular: true };
    const initial = configurationTreeEntries(root, ref, DEFAULT_CONFIGURATION_ASSET_POLICY, options);
    const policyEntries = ['singularity/workflow.yml', 'singularity/portfolio.yml'].map((relative) => initial.get(relative));
    if (policyEntries.some((entry) => !entry || !/^100(?:644|755)$/u.test(entry.mode))) return null;
    const limits = { env: localEnv, maximumBytes: LEGACY_MIRROR_GIT_LIMITS.totalBytes,
      maximumObjectBytes: LEGACY_MIRROR_GIT_LIMITS.objectBytes,
      maximumBatchBytes: LEGACY_MIRROR_GIT_LIMITS.listingBytes,
      code: 'STATE_CONFIGURATION_MIRROR_INVALID', label: 'Legacy mirror exact Git proof' };
    const policyBlobs = readLocalGitBlobs(root, policyEntries.map((entry) => entry.object), limits);
    const yaml = policyEntries.map((entry) => {
      const bytes = policyBlobs.get(entry.object); const text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes)) throw new Error('Legacy policy is not literal UTF-8.');
      return YAML.parse(text) ?? {};
    });
    const entries = configurationTreeEntries(root, ref, configurationAssetPolicy(...yaml), options);
    if (JSON.stringify([...entries.keys()].sort()) !== JSON.stringify(declared)) return null;
    for (const relative of declared) {
      const descriptor = descriptors[relative]; const actual = entries.get(relative);
      if (!descriptor || !/^100(?:644|755)$/u.test(actual?.mode ?? '')
          || !/^[0-9a-f]{64}$/u.test(manifest.files[relative] ?? '')
          || descriptor.sha256 !== manifest.files[relative]
          || descriptor.object !== actual.object || descriptor.mode !== actual.mode) return null;
    }
    const blobs = readLocalGitBlobs(root, [...entries.values()].map((entry) => entry.object), limits);
    let retainedBytes = 0;
    for (const relative of declared) {
      const bytes = blobs.get(entries.get(relative).object);
      retainedBytes += bytes.length;
      if (retainedBytes > LEGACY_MIRROR_GIT_LIMITS.totalBytes
          || createHash('sha256').update(bytes).digest('hex') !== manifest.files[relative]) return null;
    }
    return { portfolio: yaml[1] };
  } catch { return null; }
}

async function legacyStateMirrorGitMatchesRepository(root, remote, manifest, { env, ref }) {
  if (manifest?.subject?.repositoryIdentity != null || manifest?.format !== STATE_CONFIGURATION_FORMAT
      || manifest?.source?.branch !== CONFIGURATION_BRANCH
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(manifest?.source?.commit ?? '')) return false;
  const historyBranch = stateConfigurationHistoryBranch(manifest.source.commit);
  if (manifest?.history?.branch !== historyBranch || manifest?.history?.commit !== manifest.source.commit) return false;
  const current = legacyMirrorGitAssets(root, manifest, { env, ref });
  if (!current || Object.values(current.portfolio?.repositories ?? {})
    .filter((entry) => sameGitRepository(entry?.url, remote)).length !== 1) return false;
  return legacyMirrorRetainedHistoryMatches(remote, manifest, { env, runRemoteCommand: runRemoteGitAsync,
    checkout: false,
    verifyAssets: (retained, expected, options) => Boolean(legacyMirrorGitAssets(retained, expected, options)) });
}

function configurationRepositoryHead(root, env = process.env) {
  const commit = executeGitQuery(root, 'repository.head', {}, { env });
  if (commit) return commit;
  throw new SingularityFlowError('The configuration repository has no readable HEAD commit.', {
    code: 'CONFIGURATION_REPOSITORY_HEAD_UNAVAILABLE'
  });
}

/**
 * The publisher's transport ref retains one exact reviewed commit for outbox recovery. It is not
 * a movable branch: a symbolic ref must never be followed, even when it resolves to that commit.
 * Keep this observation private to the configuration owner rather than granting a generic Git
 * mutation adapter authority over the repository's ref namespace.
 */
function observedPublisherConfigurationRetention(root, ref, env) {
  const options = { cwd: root, env, allowFailure: true };
  // One Git listing reports the object and symbolic target together. A separate symbolic-ref
  // probe followed by for-each-ref leaves a gap in which an alias can replace the direct ref.
  const listed = run('git', [
    'for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', ref
  ], options);
  if (listed.status !== 0 || listed.error || listed.timedOut || listed.outputOverflow) {
    return { kind: 'unknown' };
  }
  if (listed.stdout === '') return { kind: 'absent' };
  const match = /^([^\0\r\n]+)\0([^\0\r\n]*)\0([^\0\r\n]*)\r?\n$/u.exec(listed.stdout);
  if (!match || match[1] !== ref) return { kind: 'unknown' };
  if (match[3]) return { kind: 'symbolic' };
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(match[2])) return { kind: 'unknown' };
  return { kind: 'direct', commit: match[2] };
}

function retainPublisherConfigurationCommit(root, commit, env) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) {
    throw new SingularityFlowError('The reviewed configuration commit is not an exact Git object ID.', {
      code: 'CONFIGURATION_RETENTION_REF_UNAVAILABLE'
    });
  }
  const ref = `refs/singularity/transport/configuration/${commit}`;
  const created = run('git', [
    'update-ref', '--no-deref', ref, commit, '0'.repeat(commit.length)
  ], { cwd: root, env, allowFailure: true });
  if (created.status === 0 && !created.error && !created.timedOut) return ref;

  // A failed/unknown acknowledgement may be an identical concurrent winner. Only the exact
  // direct ref can prove that outcome; rev-parse follows symbolic refs and is unsafe here.
  const observed = observedPublisherConfigurationRetention(root, ref, env);
  if (observed.kind === 'direct' && observed.commit === commit) return ref;
  if (observed.kind === 'direct' || observed.kind === 'symbolic') {
    throw new SingularityFlowError('The immutable configuration retention ref is already occupied.', {
      code: 'CONFIGURATION_RETENTION_REF_COLLISION'
    });
  }
  throw new SingularityFlowError('The reviewed configuration commit could not be retained for recoverable publication.', {
    code: 'CONFIGURATION_RETENTION_REF_UNAVAILABLE'
  });
}

export function stateConfigurationHistoryBranch(sourceCommit) {
  const commit = String(sourceCommit ?? '').trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new SingularityFlowError(
      'State configuration history requires an exact approved configuration commit.',
      { code: 'STATE_CONFIGURATION_HISTORY_INVALID' }
    );
  }
  return `${STATE_CONFIGURATION_HISTORY_PREFIX}/${commit}`;
}

/**
 * Retain the complete approved configuration ancestry behind an immutable advertised ref.
 *
 * Hosted Git services commonly refuse fetches by an arbitrary object ID and may garbage-collect an
 * object after `sflow/config` is retired. One source-specific branch avoids both failure modes and
 * cannot race with another refresh: a branch whose name embeds SHA A may only ever point at SHA A.
 */
export async function retainStateConfigurationHistory(root, remote, sourceCommit, {
  env = process.env
} = {}) {
  // One environment owns the complete proof: source-object availability, checkout-local authority
  // selection, remote observations, the leased push, and its postcondition read. In particular,
  // never let caller/process GIT_DIR, GIT_WORK_TREE, command-scoped url.* rewrites, alternates, or
  // trace sinks select a different repository for only one step of this sequence.
  const gitEnv = enterpriseGitEnvironment(env);
  const branch = stateConfigurationHistoryBranch(sourceCommit);
  const ref = `refs/heads/${branch}`;
  const available = run('git', ['rev-parse', '--verify', `${sourceCommit}^{commit}`], {
    cwd: root, env: gitEnv, allowFailure: true
  }).stdout.trim();
  if (available !== sourceCommit) {
    throw new SingularityFlowError(
      'The exact approved configuration commit is unavailable for durable state history.',
      {
        code: 'STATE_CONFIGURATION_HISTORY_UNAVAILABLE',
        details: { sourceCommit, branch }
      }
    );
  }
  // A configured remote name is mutable repository state, not an authority identity. Freeze the
  // one checkout-local push endpoint selected for this operation so observation and publication
  // cannot be redirected independently by a later pushurl or ambient insteadOf rule.
  const configured = configuredRemoteIdentity(root, remote, {
    direction: 'push', env: gitEnv
  });
  if (configured.ambiguous) {
    throw new SingularityFlowError(
      'The state configuration history remote has more than one push authority.', {
        code: 'STATE_CONFIGURATION_HISTORY_INVALID',
        details: { sourceCommit, branch }
      }
    );
  }
  const endpoint = configured.configured && configured.url
    ? configured.url
    : assertCredentialFreeRemote(remote);
  const session = new GitRemoteSession({
    env: gitEnv,
    runAsyncCommand(args, options) {
      return runRemoteGitAsync(args, { ...options, cwd: root });
    }
  });
  const observe = async ({ refresh = false } = {}) => {
    const observed = await session.observeAsync(endpoint, {
      refs: [ref], includeHead: false, refresh
    });
    if (!observed.ok) {
      if (observed.failure?.code === 'REMOTE_SYMBOLIC_REF_UNSUPPORTED') {
        throw new SingularityFlowError(
          'The remote configuration history authority is a symbolic ref.', {
            code: 'STATE_CONFIGURATION_HISTORY_INVALID',
            details: { sourceCommit, branch, symbolic: true }
          }
        );
      }
      throw new SingularityFlowError(
        'The remote configuration history ref could not be inspected before state publication.',
        {
          code: 'STATE_CONFIGURATION_HISTORY_UNAVAILABLE',
          details: {
            sourceCommit, branch,
            classification: observed.failure?.classification ?? 'unknown'
          }
        }
      );
    }
    return observed.refs?.get(ref) ?? null;
  };

  // Git can report an update to a symbolic remote ref as "Everything up-to-date" when its target
  // already has the requested object. That successful exit is not proof that the immutable name is
  // direct, so observation must bracket the push. The empty lease protects the absent case; the
  // refreshed observation distinguishes a verified write/concurrent winner from a collision even
  // when the push acknowledgement was lost or a symbolic ref raced with the lease.
  const before = await observe();
  if (before === sourceCommit) return Object.freeze({ branch, commit: sourceCommit });
  if (before != null) {
    throw new SingularityFlowError(
      'An immutable configuration history ref points at a different commit.', {
        code: 'STATE_CONFIGURATION_HISTORY_COLLISION',
        details: { sourceCommit, branch, actualCommit: before }
      }
    );
  }
  const transport = frozenRemoteTransport(endpoint, { push: true, env: gitEnv });
  const pushed = await runRemoteGitAsync([
    'push', `--force-with-lease=${ref}:`, '--', transport.remote, `${sourceCommit}:${ref}`
  ], { cwd: root, operation: 'remote-push', env: transport.env });
  const after = await observe({ refresh: true });
  if (after === sourceCommit) return Object.freeze({ branch, commit: sourceCommit });
  throw new SingularityFlowError(
    after == null
      ? 'The approved configuration history ref could not be retained before state publication.'
      : 'An immutable configuration history ref points at a different commit.',
    {
      code: after == null
        ? 'STATE_CONFIGURATION_HISTORY_UNAVAILABLE'
        : 'STATE_CONFIGURATION_HISTORY_COLLISION',
      details: {
        sourceCommit, branch,
        classification: pushed.failure?.classification
          ?? (pushed.status === 0 ? 'postcondition-failed' : 'unknown'),
        actualCommit: after
      }
    }
  );
}

/** Canonicalize a host traversal path before applying portable Git-path policy. */
export function portableConfigurationTraversalPath(value, separator = path.sep) {
  return String(value).split(separator).join('/');
}

function slash(value) { return portableConfigurationTraversalPath(value); }

export function isConfigurationAsset(relative, policy = DEFAULT_CONFIGURATION_ASSET_POLICY) {
  return isConfigurationAssetPath(relative, policy);
}

function yamlAtRef(root, ref, relative, { env = process.env } = {}) {
  const shown = run('git', ['show', `${ref}:${relative}`], { cwd: root, env, allowFailure: true });
  if (shown.status !== 0) return {};
  return YAML.parse(shown.stdout) ?? {};
}

async function yamlInDirectory(root, relative) {
  const target = path.join(root, relative);
  const info = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info) return {};
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SingularityFlowError(`Configuration policy source must be a regular file: ${relative}`);
  }
  return YAML.parse(await readFile(target, 'utf8')) ?? {};
}

export function configurationAssetPolicyFromRef(root, ref = 'HEAD', { env = process.env } = {}) {
  return configurationAssetPolicy(
    yamlAtRef(root, ref, 'singularity/workflow.yml', { env }),
    yamlAtRef(root, ref, 'singularity/portfolio.yml', { env })
  );
}

export async function configurationAssetPolicyFromDirectory(root) {
  return configurationAssetPolicy(
    await yamlInDirectory(root, 'singularity/workflow.yml'),
    await yamlInDirectory(root, 'singularity/portfolio.yml')
  );
}

async function filesBelow(root, relative, policy, output = []) {
  const directory = path.join(root, relative);
  const rootInfo = await lstat(directory).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!rootInfo) return output;
  if (rootInfo.isSymbolicLink()) {
    throw new SingularityFlowError(`Configuration asset root must not be a symbolic link: ${relative}`);
  }
  if (rootInfo.isFile()) {
    if (isConfigurationAsset(relative, policy)) output.push(slash(relative));
    return output;
  }
  if (!rootInfo.isDirectory()) {
    throw new SingularityFlowError(`Configuration asset root must be a directory or regular file: ${relative}`);
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    const portable = slash(child);
    if (entry.isDirectory()) {
      const containsExplicit = [...policy.roots, ...policy.files]
        .some((configured) => configured.startsWith(`${portable}/`));
      if (isConfigurationAsset(portable, policy) || containsExplicit) {
        await filesBelow(root, child, policy, output);
      }
    }
    else if (entry.isFile() && isConfigurationAsset(portable, policy)) output.push(portable);
  }
  return output;
}

/**
 * Enumerate the complete approved configuration payload without exposing lifecycle/runtime state.
 *
 * Configuration refresh uses this exact predicate for its orphan-state mirror. Exporting the
 * enumeration keeps materialization and mirroring from growing two subtly different definitions
 * of "configuration" as new governed files are introduced.
 */
export async function configurationAssetPaths(root, policy = null) {
  const selectedPolicy = policy ?? await configurationAssetPolicyFromDirectory(root);
  // Do not walk the application tree (especially node_modules/build output) to discover two
  // bounded configuration roots. Custom roots remain bounded pathspecs from the reviewed workflow.
  const output = [];
  for (const relative of configurationAssetSearchRoots(selectedPolicy)) {
    await filesBelow(root, relative, selectedPolicy, output);
  }
  return [...new Set(output)].sort();
}

/**
 * Read the repository's canonical Git bytes for the current configuration worktree without
 * touching its real index. This is the line-ending-safe source for state mirrors and receipts.
 */
export async function canonicalConfigurationAssets(root, paths = null, { env: baseEnv = process.env } = {}) {
  const selected = paths ?? await configurationAssetPaths(root);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-index-'));
  const index = path.join(temporary, 'index');
  const env = { ...baseEnv, GIT_INDEX_FILE: index };
  try {
    run('git', ['read-tree', '--empty'], { cwd: root, env });
    for (let offset = 0; offset < selected.length; offset += 200) {
      run('git', ['add', '--', ...selected.slice(offset, offset + 200)], { cwd: root, env });
    }
    const staged = run('git', ['ls-files', '--stage', '-z'], { cwd: root, env }).stdout
      .split('\0').filter(Boolean).map((line) => {
        const match = line.match(/^(\d{6}) ([0-9a-f]{40,64}) \d\t(.+)$/s);
        if (!match) throw new SingularityFlowError('Temporary configuration index is not readable.');
        return { mode: match[1], object: match[2], relative: slash(match[3]) };
      });
    const expected = [...selected].sort();
    const actual = staged.map((entry) => entry.relative).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new SingularityFlowError('Canonical configuration index does not match the approved asset set.');
    }
    const batch = run('git', ['cat-file', '--batch'], {
      cwd: root, env, encoding: 'buffer', input: `${staged.map((entry) => entry.object).join('\n')}\n`
    });
    let cursor = 0;
    const assets = new Map();
    for (const entry of staged) {
      const newline = batch.stdout.indexOf(0x0a, cursor);
      const header = newline >= 0
        ? batch.stdout.toString('utf8', cursor, newline).trim().split(' ')
        : [];
      const size = Number(header[2]);
      if (header[0] !== entry.object || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
        throw new SingularityFlowError(`Canonical configuration blob is not readable: ${entry.relative}`);
      }
      const start = newline + 1;
      const end = start + size;
      if (end > batch.stdout.length) {
        throw new SingularityFlowError(`Canonical configuration blob was truncated: ${entry.relative}`);
      }
      const contents = Buffer.from(batch.stdout.subarray(start, end));
      assets.set(entry.relative, {
        ...entry, contents,
        sha256: createHash('sha256').update(contents).digest('hex')
      });
      cursor = end + 1;
    }
    return assets;
  } finally {
    await removeTemporaryTree(temporary);
  }
}

export function configurationTreeEntries(root, ref = 'HEAD', policy = null, {
  env = process.env, maxBuffer, includeNonRegular = false
} = {}) {
  const selectedPolicy = policy ?? configurationAssetPolicyFromRef(root, ref, { env });
  const listed = run('git', [
    'ls-tree', '-r', '-z', '--format=%(objectmode) %(objectname) %(path)', ref, '--',
    ...configurationAssetSearchRoots(selectedPolicy)
  ], { cwd: root, allowFailure: true, env, ...(maxBuffer == null ? {} : { maxBuffer }) });
  if (listed.status !== 0) return new Map();
  return new Map(listed.stdout.split('\0').filter(Boolean).map((line) => {
    const first = line.indexOf(' ');
    const second = line.indexOf(' ', first + 1);
    const entry = {
      mode: line.slice(0, first),
      object: line.slice(first + 1, second),
      relative: slash(line.slice(second + 1))
    };
    return [entry.relative, entry];
  }).filter(([, entry]) => (includeNonRegular || /^100(?:644|755)$/.test(entry.mode))
    && isConfigurationAsset(entry.relative, selectedPolicy)));
}

async function copyAssets(source, destination) {
  const copied = [];
  for (const relative of await configurationAssetPaths(source)) {
    const from = path.join(source, relative);
    const info = await lstat(from);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new SingularityFlowError(`Configuration asset must be a regular file: ${relative}`);
    }
    const to = path.join(destination, relative);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
    copied.push(relative);
  }
  return copied.sort();
}

/**
 * Extract configuration assets from a fetched ref without checking out the application tree.
 *
 * The first capability may be mapped into a multi-gigabyte monorepo. A normal shallow clone still
 * downloads and checks out every blob at the branch tip, and can invoke LFS/smudge filters, even
 * though configuration bootstrap only imports `singularity/` and `.github/agents/`. The clone that
 * calls this helper is blobless and has no checkout. `ls-tree` identifies the bounded file set and
 * one `cat-file --batch` asks the promisor remote only for those blobs.
 */
async function copyConfigurationAssetsFromRef(source, ref, destination, { env = process.env } = {}) {
  const policy = configurationAssetPolicyFromRef(source, ref, { env });
  const listed = run('git', [
    'ls-tree', '-r', '-z', '--format=%(objectmode) %(objectname) %(path)', ref, '--',
    ...configurationAssetSearchRoots(policy)
  ], { cwd: source, env });
  const candidates = listed.stdout.split('\0').filter(Boolean).map((line) => {
    const first = line.indexOf(' ');
    const second = line.indexOf(' ', first + 1);
    return {
      mode: line.slice(0, first),
      oid: line.slice(first + 1, second),
      file: line.slice(second + 1)
    };
  }).filter((entry) => isConfigurationAsset(entry.file, policy));
  const nonRegular = candidates.filter((entry) => !/^100(?:644|755)$/.test(entry.mode));
  if (nonRegular.length) {
    throw new SingularityFlowError(
      `Configuration authority contains non-regular framework asset path(s): ${nonRegular.map((entry) => entry.file).sort().join(', ')}. Replace symlinks or submodules with reviewed regular files before reinitializing.`, {
        code: 'CONFIGURATION_ASSET_NOT_REGULAR',
        details: { paths: nonRegular.map((entry) => entry.file).sort() }
      }
    );
  }
  const entries = candidates;
  if (!entries.length) return [];

  const batch = run('git', ['cat-file', '--batch'], {
    cwd: source,
    env,
    encoding: 'buffer',
    input: `${entries.map((entry) => entry.oid).join('\n')}\n`
  });
  let cursor = 0;
  for (const entry of entries) {
    const newline = batch.stdout.indexOf(0x0a, cursor);
    if (newline < 0) {
      throw new SingularityFlowError(`Could not read configuration asset '${entry.file}' from '${ref}'.`);
    }
    const [oid, type, rawSize] = batch.stdout.toString('utf8', cursor, newline).trim().split(' ');
    const size = Number(rawSize);
    if (oid !== entry.oid || type !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
      throw new SingularityFlowError(`Could not read configuration asset '${entry.file}' from '${ref}'.`);
    }
    const start = newline + 1;
    const end = start + size;
    if (end > batch.stdout.length) {
      throw new SingularityFlowError(`Configuration asset '${entry.file}' was truncated while reading '${ref}'.`);
    }
    const target = path.join(destination, entry.file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, batch.stdout.subarray(start, end));
    await chmod(target, entry.mode === '100755' ? 0o755 : 0o644);
    cursor = end + 1; // `cat-file --batch` terminates every blob with one newline.
  }
  return entries.map((entry) => entry.file).sort();
}

async function clearConfigurationAssets(root) {
  const removed = await configurationAssetPaths(root);
  for (const relative of removed) await rm(path.join(root, relative), { force: true });
  return removed;
}

async function configurationStatePaths(root) {
  const files = await configurationAssetPaths(root);
  const provenance = path.join(root, CONFIGURATION_SOURCE_PATH);
  const provenanceInfo = await lstat(provenance).catch(() => null);
  if (provenanceInfo) {
    if (!provenanceInfo.isFile() || provenanceInfo.isSymbolicLink()) {
      throw new SingularityFlowError(`${CONFIGURATION_SOURCE_PATH} must be a regular file.`);
    }
    files.push(CONFIGURATION_SOURCE_PATH);
  }
  return [...new Set(files)].sort();
}

/**
 * Capture the exact configuration bytes that exist before a materialization attempt.
 *
 * This is an in-memory transaction savepoint, not a durable record. Story start uses it while the
 * newly-created branch is checked out so a later validation refusal can put that branch back to its
 * base before switching to the caller's branch. Runtime work-item state is deliberately outside the
 * asset predicate and is never hidden by this rollback.
 */
export async function captureConfigurationState(root) {
  const captured = new Map();
  for (const relative of await configurationStatePaths(root)) {
    const file = path.join(root, relative);
    const info = await lstat(file);
    captured.set(relative, {
      contents: await readFile(file),
      mode: info.mode & 0o777
    });
  }
  return captured;
}

/** Restore one in-memory configuration savepoint without touching runtime or source files. */
export async function restoreConfigurationState(root, captured) {
  if (!(captured instanceof Map)) {
    throw new SingularityFlowError('Configuration rollback requires its in-memory savepoint.');
  }
  const current = await configurationStatePaths(root);
  for (const relative of current) {
    if (!captured.has(relative)) await rm(path.join(root, relative), { force: true });
  }
  for (const [relative, entry] of captured) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.contents);
    await chmod(target, entry.mode);
  }
}

async function clearScratchWorktree(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    await removeTemporaryTree(path.join(root, entry.name));
  }
}

/**
 * Turn one exact application revision into the parentless configuration tree used by bootstrap.
 *
 * Preview and publication must call this same transformation.  Keeping a second approximation in
 * workspace refresh previously omitted repository/ledger mutations, retained application history,
 * and trusted an application-side package receipt.  The resulting confirmation token described
 * bytes other than the first authority that was actually pushed.
 *
 * This helper deliberately does not commit or publish.  Callers may apply their reviewed package
 * refresh, validate the complete tree, and create a deterministic candidate commit before any
 * remote ref becomes visible.
 */
export async function prepareConfigurationBootstrapWorktree(root, {
  sourceRef = 'HEAD', remote, defaultBranch, capability = null, grounding = null,
  authorIdentity = null, identityRoot = null, env = process.env, identityEnv = env,
  preserveImportedApprovalAuthorities = false, frameworkApprovalAuthoritySeeds = null,
  preserveImportedRepositoryPolicy = false, preserveImportedLedgerPolicy = false
} = {}) {
  const url = assertCredentialFreeRemote(String(remote ?? '').trim());
  const branch = String(defaultBranch ?? '').trim();
  if (!url || !branch) {
    throw new SingularityFlowError('Configuration bootstrap requires an exact remote and default branch.', {
      code: 'CONFIGURATION_BOOTSTRAP_INPUT_REQUIRED'
    });
  }
  const seed = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-seed-'));
  try {
    const imported = await copyConfigurationAssetsFromRef(root, sourceRef, seed, { env });
    // The application branch may contain an old or forged refresh receipt.  Only refresh may write
    // a new receipt after comparing the actual candidate against this installation.
    await rm(path.join(seed, PACKAGE_CONFIGURATION_BASELINE), { force: true });
    const importedAssets = imported.filter((relative) => relative !== PACKAGE_CONFIGURATION_BASELINE);
    const importedCapabilityMap = importedAssets.includes('singularity/capabilities.yml');
    const importedWorkflow = importedAssets.includes('singularity/workflow.yml');
    const importedPortfolio = importedAssets.includes('singularity/portfolio.yml');
    let exactFrameworkApprovalAuthorities = [];
    let exactFrameworkPortfolioAuthorities = [];
    if (preserveImportedApprovalAuthorities && importedWorkflow
        && frameworkApprovalAuthoritySeeds && typeof frameworkApprovalAuthoritySeeds === 'object') {
      let importedDefinition = null;
      try {
        importedDefinition = YAML.parse(await readFile(
          path.join(seed, 'singularity/workflow.yml'), 'utf8'
        ));
      } catch (error) {
        throw new SingularityFlowError(
          `Imported workflow approval authority catalog is invalid: ${error.message}`, {
            code: 'CONFIGURATION_BOOTSTRAP_INVALID'
          }
        );
      }
      exactFrameworkApprovalAuthorities = Object.entries(
        frameworkApprovalAuthoritySeeds.workflow ?? {}
      )
        .filter(([id, authority]) => isDeepStrictEqual(
          importedDefinition?.approvalAuthorities?.[id], authority
        ))
        .map(([id]) => id);
      const importedPortfolioFile = path.join(seed, 'singularity/portfolio.yml');
      const importedPortfolioInfo = await lstat(importedPortfolioFile).catch((error) =>
        error?.code === 'ENOENT' ? null : Promise.reject(error));
      const portfolioSeeds = frameworkApprovalAuthoritySeeds.portfolio ?? {};
      if (importedPortfolioInfo && importedPortfolioInfo.isFile()
          && !importedPortfolioInfo.isSymbolicLink()) {
        const importedPortfolio = YAML.parse(await readFile(importedPortfolioFile, 'utf8'));
        exactFrameworkPortfolioAuthorities = Object.entries(portfolioSeeds)
          .filter(([id, authority]) => isDeepStrictEqual(
            importedPortfolio?.approvalAuthorities?.[id], authority
          ))
          .map(([id]) => id);
      } else if (!importedPortfolioInfo) exactFrameworkPortfolioAuthorities = Object.keys(portfolioSeeds);
    }

    run('git', ['switch', '--quiet', '--orphan', CONFIGURATION_BRANCH], { cwd: root, env });
    await clearScratchWorktree(root);
    await copyAssets(seed, root);
    const wrote = await initializeDefinition(root);
    if (wrote.includes('singularity/workflow.yml')) await setDefaultBaseBranch(root, branch);
    if (!importedCapabilityMap) {
      await rm(path.join(root, 'singularity/capabilities.yml'), { force: true });
    }

    const actor = authorIdentity ?? gitCommitIdentity(identityRoot ?? root, { env: identityEnv });
    if (authorIdentity && (typeof actor?.name !== 'string' || !actor.name.trim()
        || typeof actor?.email !== 'string' || !actor.email.trim())) {
      throw new SingularityFlowError(
        'Configuration authority creation requires a verified Git author identity.', {
          code: 'CONFIGURATION_AUTHOR_IDENTITY_REQUIRED'
        }
      );
    }
    await describeRepository(root, repositoryIdFromUrl(url), url, branch, actor, {
      // Safe reinitialize may have imported organisation-owned approval groups from the
      // application branch while reconstructing a missing authority. Recording the Git author in
      // the commit must not silently grant that person membership in those existing groups.
      enrollActor: !(preserveImportedApprovalAuthorities && importedWorkflow),
      // An exact untouched framework seed still needs one usable bootstrap member. Customised,
      // populated, and repository-created groups are deliberately absent from this allowlist.
      enrollActorAuthorityIds: exactFrameworkApprovalAuthorities,
      enrollActorPortfolioAuthorityIds: exactFrameworkPortfolioAuthorities,
      preserveExistingRepository: preserveImportedRepositoryPolicy && importedPortfolio
    });
    if (grounding) await setGroundingMode(root, grounding);
    if (capability && importedCapabilityMap) {
      const importedCapabilities = await loadCapabilities(root, { required: true });
      const requestedCapabilityId = String(capability.capabilityId ?? '').trim();
      if (!importedCapabilities.capabilities?.[requestedCapabilityId]) {
        throw new SingularityFlowError(
          `The imported capability map does not define requested capability '${requestedCapabilityId}'. `
          + 'Nothing was published; map it through the normal reviewed capability proposal workflow.', {
            code: 'CONFIGURATION_BOOTSTRAP_CAPABILITY_REVIEW_REQUIRED',
            details: {
              requestedCapabilityId,
              importedCapabilityIds: Object.keys(importedCapabilities.capabilities ?? {}).sort(),
              nextAction: {
                command: 'singularity-flow capability map <CAPABILITY-ID> --lead <LEAD-URL> --json',
                skill: '/sf-capability-map'
              },
              preserved: ['imported-capability-map', 'application-branches', 'remote-configuration-refs']
            }
          }
        );
      }
    } else if (capability) await describeCapability(root, capability);
    // A safe reinitialize may be reconstructing a missing sflow/config authority from an older
    // application branch. Its ledger block is organisation policy, not a framework seed: retain a
    // valid imported block exactly and let the subsequent full-definition/state-authority checks
    // refuse it if it cannot be honored safely. Ordinary bootstrap and a missing imported workflow
    // still receive the standard state authority.
    if (!(preserveImportedLedgerPolicy && importedWorkflow)) {
      await enableLedger(root, 'state');
    }
    if (preserveImportedLedgerPolicy && importedWorkflow) {
      let importedLedgerRemote = null;
      try {
        const importedDefinition = YAML.parse(await readFile(
          path.join(root, 'singularity/workflow.yml'), 'utf8'
        ));
        importedLedgerRemote = String(importedDefinition?.ledger?.remote ?? 'origin').trim();
      } catch (error) {
        throw new SingularityFlowError(
          `Imported ledger policy is invalid: ${error.message}`, {
            code: 'CONFIGURATION_BOOTSTRAP_INVALID',
            cause: error
          }
        );
      }
      // The first-authority candidate is an isolated clone with one frozen `origin`. Silently
      // substituting it for a different authored ledger remote would publish state under authority
      // the repository never selected. Preserve that policy by refusing before either remote ref is
      // created; an existing sflow/config authority can be restored, or the application-side policy
      // can be reviewed to use the registered repository origin before retrying.
      if (importedLedgerRemote !== 'origin') {
        throw new SingularityFlowError(
          `Imported ledger policy selects remote '${importedLedgerRemote}', which cannot be proven in the isolated first-authority candidate. Nothing was changed; restore the reviewed sflow/config authority or review the application policy to use origin before reinitializing.`, {
            code: 'CONFIGURATION_BOOTSTRAP_LEDGER_POLICY_UNAVAILABLE',
            details: {
              remote: importedLedgerRemote,
              preserved: ['application-branches', 'remote-configuration-refs', 'remote-state-refs']
            }
          }
        );
      }
    }
    try {
      await loadDefinition(root);
    } catch (error) {
      throw new SingularityFlowError(
        `The configuration authority was not created because its final packaged and imported assets are incompatible: ${error.message}`, {
          code: 'CONFIGURATION_BOOTSTRAP_INVALID',
          cause: error,
          details: {
            underlyingCode: error?.code ?? 'CONFIGURATION_INVALID',
            preserved: ['application-branches', 'remote-configuration-refs']
          }
        }
      );
    }
    return { imported: importedAssets, importedCapabilityMap, actor };
  } finally {
    await removeTemporaryTree(seed);
  }
}

export async function remoteHasConfigurationBranch(remote, options = {}) {
  const head = await configurationBranchHead(remote, options);
  return head.reachable && head.exists;
}

/**
 * Read the exact configuration-authority tip without throwing away reachability diagnostics.
 * Callers that only need a boolean keep using `remoteHasConfigurationBranch`; organisation reads
 * use the SHA as their durable cache validator and distinguish a missing branch from an offline
 * remote so stale data is never presented as an empty organisation.
 */
export async function configurationBranchHead(remote, {
  session = new GitRemoteSession({ cwd: REMOTE_GIT_READ_CWD }), refresh = false, observation = null
} = {}) {
  const observed = observation ?? await session.observeAsync(remote, {
    refs: [`refs/heads/${CONFIGURATION_BRANCH}`], includeHead: false, refresh
  });
  const sha = observed.refs?.get(`refs/heads/${CONFIGURATION_BRANCH}`) ?? null;
  return {
    reachable: observed.ok,
    exists: observed.ok && Boolean(sha),
    sha,
    error: observed.ok
      ? null
      : `Git remote failed (${observed.failure?.classification ?? 'unknown'}). ${observed.failure?.advice ?? 'The remote did not answer.'}`,
    observation: observed
  };
}

function sameStrings(left = [], right = []) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function assertRequestedCapability(capabilities, capability, remote, { exactBootstrap = false } = {}) {
  if (!capability) return;
  const id = String(capability.capabilityId ?? '').trim();
  const configured = capabilities?.capabilities?.[id];
  if (!configured) {
    throw new SingularityFlowError(
      `${CONFIGURATION_BRANCH} already exists on '${remote}' but does not define requested capability '${id}'. `
      + 'Propose the capability through the governed capability-map workflow instead of re-running bootstrap.');
  }
  // Existing approved values win. Name, kind, repositories, Jira and teams can all evolve through
  // reviewed capability proposals; repeating an old bootstrap request on a new laptop must not turn
  // that legitimate evolution into an initialization blocker. This guard exists only to prove that
  // a create race did not publish a *different capability ID*.
  if (!exactBootstrap) return;
  const expected = {
    name: capability.capabilityName ?? id,
    kind: capability.kind,
    repository: capability.kind === 'delivery' ? capability.repositoryId : undefined,
    jiraProject: capability.jiraProject ?? null,
    teams: capability.teams ?? []
  };
  const matches = configured.name === expected.name
    && configured.kind === expected.kind
    && configured.repository === expected.repository
    && (configured.jira?.projectKey ?? null) === expected.jiraProject
    && sameStrings(configured.teams ?? [], expected.teams);
  if (!matches) {
    throw new SingularityFlowError(
      `${CONFIGURATION_BRANCH} was created concurrently with capability '${id}', but its values do not match this bootstrap request. `
      + 'Inspect the winning approved capability map before retrying.');
  }
}

async function inspectApprovedConfiguration(remote, capability = null, options = {}) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-inspect-'));
  try {
    const commit = await cloneConfiguration(remote, scratch, { env: options.env ?? process.env });
    // A configuration authority is one joined contract, not a bag of independently readable
    // YAML/Markdown files.  In particular, an MCP assignment in workflow.yml is invalid when the
    // referenced governed-agent Markdown does not allow the same tool namespace.  Validate the
    // complete authority here so a race-winning or previously-created mixed-version branch cannot
    // be mistaken for a healthy map merely because capabilities.yml parses.
    await loadDefinition(scratch);
    const capabilities = await loadCapabilities(scratch, { required: Boolean(capability) });
    assertRequestedCapability(capabilities, capability, remote, options);
    return { branch: CONFIGURATION_BRANCH, commit, created: false };
  } finally {
    await removeTemporaryTree(scratch);
  }
}

async function publishPreparedConfigurationCandidate(remote, {
  root, commit: expectedCommit, tree: expectedTree, sourceCommit, sourceBranch,
  session, env
}) {
  const candidateRoot = await realpath(path.resolve(root));
  const candidateRemote = configuredRemoteAuthority(candidateRoot, 'origin', {
    direction: 'fetch', env
  });
  if (!candidateRemote.url || candidateRemote.url !== assertCredentialFreeRemote(remote)) {
    throw new SingularityFlowError(
      'The prepared configuration candidate origin does not match the reviewed remote.', {
        code: 'CONFIGURATION_BOOTSTRAP_CANDIDATE_REMOTE_MISMATCH'
      }
    );
  }
  const branch = run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: candidateRoot, env, allowFailure: true
  }).stdout.trim();
  const commit = run('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: candidateRoot, env, allowFailure: true
  }).stdout.trim();
  const tree = run('git', ['rev-parse', '--verify', 'HEAD^{tree}'], {
    cwd: candidateRoot, env, allowFailure: true
  }).stdout.trim();
  const parents = run('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], {
    cwd: candidateRoot, env, allowFailure: true
  }).stdout.trim().split(/\s+/u).filter(Boolean);
  const clean = run('git', ['status', '--porcelain'], { cwd: candidateRoot, env }).stdout;
  if (branch !== CONFIGURATION_BRANCH || commit !== expectedCommit || tree !== expectedTree
      || parents.length !== 1 || clean !== '') {
    throw new SingularityFlowError(
      'The prepared configuration candidate changed after preview. Preview the refresh again before creating the authority.', {
        code: 'CONFIGURATION_BOOTSTRAP_CANDIDATE_CHANGED',
        details: {
          expectedCommit, actualCommit: commit || null,
          expectedTree, actualTree: tree || null,
          branch: branch || null, parentCount: Math.max(0, parents.length - 1)
        }
      }
    );
  }
  await loadDefinition(candidateRoot);

  // Re-observe both authorities immediately before the only remote mutation.  The empty expected
  // object in force-with-lease is the final CAS; this observation supplies an actionable refusal
  // before the push and binds the candidate to the application revision reviewed in the plan.
  const observed = await session.observeAsync(remote, {
    refs: [
      `refs/heads/${CONFIGURATION_BRANCH}`,
      `refs/heads/${sourceBranch}`
    ],
    includeHead: false,
    refresh: true
  });
  requireRemoteObservation(observed, 'configuration bootstrap authority');
  const currentAuthority = observed.refs.get(`refs/heads/${CONFIGURATION_BRANCH}`) ?? null;
  const currentSource = observed.refs.get(`refs/heads/${sourceBranch}`) ?? null;
  if (currentAuthority) {
    throw new SingularityFlowError(
      'The configuration authority was created concurrently after preview. Create and review a fresh plan before applying it.', {
        code: 'CONFIGURATION_BOOTSTRAP_AUTHORITY_CHANGED',
        details: { observedCommit: currentAuthority }
      }
    );
  }
  if (currentSource !== sourceCommit) {
    throw new SingularityFlowError(
      `The '${sourceBranch}' source branch changed after configuration preview. Preview the refresh again before creating '${CONFIGURATION_BRANCH}'.`, {
        code: 'CONFIGURATION_BOOTSTRAP_SOURCE_CHANGED',
        details: { expectedCommit: sourceCommit, actualCommit: currentSource, branch: sourceBranch }
      }
    );
  }

  const pushed = await runRemoteGitAsync([
    'push', `--force-with-lease=refs/heads/${CONFIGURATION_BRANCH}:`, 'origin',
    `${commit}:refs/heads/${CONFIGURATION_BRANCH}`
  ], { cwd: candidateRoot, operation: 'remote-push', env });
  if (pushed.status !== 0) {
    session.invalidate(remote);
    const raced = await session.observeAsync(remote, {
      refs: [`refs/heads/${CONFIGURATION_BRANCH}`], includeHead: false, refresh: true
    });
    const winner = raced.ok
      ? raced.refs.get(`refs/heads/${CONFIGURATION_BRANCH}`) ?? null : null;
    throw new SingularityFlowError(
      winner
        ? 'The configuration authority changed concurrently after preview. Nothing else was published; review a fresh plan.'
        : `Cannot create '${CONFIGURATION_BRANCH}' on '${sanitizeRemote(remote)}'. ${pushed.failure?.advice ?? 'Git rejected the exact branch creation.'}`, {
        code: winner ? 'CONFIGURATION_BOOTSTRAP_AUTHORITY_CHANGED'
          : pushed.failure?.code ?? 'REMOTE_UNKNOWN',
        details: { expectedCommit: commit, observedCommit: winner }
      }
    );
  }
  session.invalidate(remote);
  return {
    branch: CONFIGURATION_BRANCH, commit, created: true, importedFrom: sourceBranch,
    candidateTree: tree, transportIntent: null
  };
}

/** Create the configuration authority once, importing only configuration from an approved source. */
/**
 * Establish the configuration authority on a remote, seeded entirely in a scratch clone.
 *
 * `capability` describes the capability this repository delivers. It is written here rather than on
 * a code branch because this branch *is* the authority: `start` materializes the approved
 * configuration from it into each Story branch, so nothing governed ever needs to live on the
 * application branch. That is what makes a protected `main` a non-issue rather than an obstacle.
 */
export async function ensureConfigurationBranch(remote, {
  sourceBranch = null, capability = null, grounding = null,
  sourceCommit = null, publisherRoot = null, transport = {}, remoteSession = null, observedHead = null,
  authorIdentity = null, preparedCandidate = null, env = process.env
} = {}) {
  const url = String(remote ?? '').trim();
  if (!url) throw new SingularityFlowError('A configuration repository URL is required.');
  const gitEnv = remoteSession?.env ?? enterpriseGitEnvironment(env);
  const transportOptions = { ...transport, env: gitEnv };
  const frozen = frozenRemoteTransport(url, { push: true, env: gitEnv });
  const session = remoteSession ?? new GitRemoteSession({ cwd: REMOTE_GIT_READ_CWD, env: gitEnv });
  const configurationObservation = observedHead?.observation ?? await session.observeAsync(url, {
    refs: [`refs/heads/${CONFIGURATION_BRANCH}`], includeHead: false
  });
  const configurationHead = observedHead ?? await configurationBranchHead(url, {
    session, observation: configurationObservation
  });
  requireRemoteObservation(configurationHead.observation, 'configuration authority');
  if (configurationHead.exists) return await inspectApprovedConfiguration(url, capability, {
    env: gitEnv
  });

  let canonicalPublisher = null;
  if (publisherRoot) {
    canonicalPublisher = await realpath(path.resolve(publisherRoot));
    const publisherRemote = configuredRemoteIdentity(canonicalPublisher, 'origin', {
      direction: 'fetch', env: gitEnv
    });
    if (!publisherRemote.configured || publisherRemote.ambiguous || !publisherRemote.url
        || publisherRemote.url !== assertCredentialFreeRemote(url)) {
      throw new SingularityFlowError('The configuration publisher origin does not match the reviewed configuration remote.', {
        code: 'CONFIGURATION_PUBLISHER_REMOTE_MISMATCH'
      });
    }
    // A prior attempt may have retained its exact commit in this repository. Join it rather than
    // authoring another commit with a new timestamp and producing two recovery paths.
    const existing = (await listTransportIntents({
      ...transportOptions, includeSucceeded: true
    })).find((intent) => intent.repositoryRoot === canonicalPublisher
      && intent.remoteUrl === assertCredentialFreeRemote(url)
      && intent.targetRef === `refs/heads/${CONFIGURATION_BRANCH}`
      && intent.status !== 'succeeded');
    if (existing) {
      const resumed = await retryTransportIntent(existing.intentId, transportOptions);
      if (resumed.status !== 'succeeded') {
        throw new SingularityFlowError(
          `Configuration publication ${resumed.intentId} is ${resumed.status}; its exact local commit remains available for 'singularity-flow push status ${resumed.intentId}'.`,
          { code: 'CONFIGURATION_PUBLICATION_PENDING', details: { intentId: resumed.intentId, status: resumed.status } }
        );
      }
      return { ...(await inspectApprovedConfiguration(url, capability, { env: gitEnv })), transportIntent: resumed.intentId };
    }
  }

  const remoteHead = configurationHead.observation?.includedHead
    ? configurationHead.observation
    : await session.observeAsync(url, { includeHead: true });
  requireRemoteObservation(remoteHead, 'configuration repository');
  let defaultBranch = remoteHead.defaultBranch;
  if (!defaultBranch) {
    const advertised = await session.observeAsync(url, {
      includeHead: true, includeAllHeads: true
    });
    requireRemoteObservation(advertised, 'configuration repository');
    defaultBranch = advertised.defaultBranch
      ?? advertised.branches.find((item) => item === 'main' || item === 'master')
      ?? advertised.branches[0]
      ?? 'main';
  }
  const importBranch = String(sourceBranch ?? defaultBranch).trim() || defaultBranch;
  if (preparedCandidate) {
    if (!sourceCommit) {
      throw new SingularityFlowError(
        'A prepared configuration candidate requires the exact reviewed application source commit.', {
          code: 'CONFIGURATION_BOOTSTRAP_SOURCE_REQUIRED'
        }
      );
    }
    return await publishPreparedConfigurationCandidate(url, {
      ...preparedCandidate, sourceCommit, sourceBranch: importBranch, session, env: gitEnv
    });
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-bootstrap-'));
  try {
    const clone = await runRemoteGitAsync([
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
      '--no-checkout', '--branch', importBranch, frozen.remote, scratch
    ], { cwd: path.dirname(scratch), operation: 'remote-configuration', env: frozen.env });
    if (clone.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read '${sanitizeRemote(url)}'. ${clone.failure?.advice ?? 'Git remote access failed.'}`,
        { code: clone.failure?.code ?? 'REMOTE_UNKNOWN' });
    }
    const importedCommit = configurationRepositoryHead(scratch, frozen.env);
    if (sourceCommit && importedCommit !== sourceCommit) {
      throw new SingularityFlowError(
        `The '${importBranch}' source branch changed after configuration preview. Preview the refresh again before creating '${CONFIGURATION_BRANCH}'.`,
        {
          code: 'CONFIGURATION_BOOTSTRAP_SOURCE_CHANGED',
          details: { expectedCommit: sourceCommit, actualCommit: importedCommit, branch: importBranch }
        }
      );
    }
    const { actor } = await prepareConfigurationBootstrapWorktree(scratch, {
      sourceRef: 'HEAD', remote: url, defaultBranch, capability, grounding,
      authorIdentity,
      // Ordinary bootstrap discovers identity outside the transport-isolated scratch clone.
      identityRoot: canonicalPublisher ?? scratch,
      identityEnv: env,
      env: frozen.env
    });
    run('git', ['add', '-A'], { cwd: scratch, env: frozen.env });
    run('git', [
      '-c', `user.name=${actor.name || 'Singularity Flow'}`,
      '-c', `user.email=${actor.email || 'unknown@invalid'}`,
      'commit', '-m', '[configuration] establish Singularity configuration authority'
    ], { cwd: scratch, env: frozen.env });
    const commit = configurationRepositoryHead(scratch, frozen.env);
    let push;
    let transportIntent = null;
    let transportStatus = null;
    if (canonicalPublisher) {
      const imported = run('git', ['fetch', '--no-tags', '--', scratch, commit], {
        cwd: canonicalPublisher, env: gitEnv, allowFailure: true
      });
      if (imported.status !== 0) {
        throw new SingularityFlowError('The reviewed configuration commit could not be retained in the publisher repository.');
      }
      retainPublisherConfigurationCommit(canonicalPublisher, commit, gitEnv);
      const published = await createAndPushTransportIntent({
        repositoryRoot: canonicalPublisher,
        remote: 'origin',
        sourceCommit: commit,
        targetRef: `refs/heads/${CONFIGURATION_BRANCH}`,
        expectedRemote: null,
        scope: { operation: 'sflow.configuration.initialize', sourceBranch: importBranch }
      }, transportOptions);
      transportIntent = published.intentId;
      transportStatus = published.status;
      push = published.status === 'succeeded'
        ? { status: 0, stdout: '', stderr: '' }
        : { status: 1, stdout: '', stderr: `transport ${published.intentId} is ${published.status}` };
    } else {
      push = await runRemoteGitAsync(['push', 'origin', `HEAD:refs/heads/${CONFIGURATION_BRANCH}`], {
        cwd: scratch, operation: 'remote-push', env: frozen.env
      });
    }
    if (push.status !== 0) {
      if (transportIntent) {
        throw new SingularityFlowError(
          `Configuration publication ${transportIntent} is ${transportStatus}; its exact local commit remains available for 'singularity-flow push status ${transportIntent}'.`,
          {
            code: 'CONFIGURATION_PUBLICATION_PENDING',
            details: { intentId: transportIntent, status: transportStatus }
          }
        );
      }
      session.invalidate(url);
      const raced = await session.observeAsync(url, {
        refs: [`refs/heads/${CONFIGURATION_BRANCH}`], includeHead: false, refresh: true
      });
      const racedHead = await configurationBranchHead(url, { session, observation: raced });
      if (!racedHead.reachable || !racedHead.exists) {
        throw new SingularityFlowError(
          `Cannot create '${CONFIGURATION_BRANCH}' on '${sanitizeRemote(url)}'. ${push.failure?.advice ?? 'Git rejected the exact branch creation.'}`,
          { code: push.failure?.code ?? 'REMOTE_UNKNOWN' });
      }
      // Another bootstrap won the create race. It is success only when the winning authority
      // contains the exact capability this caller requested; branch existence alone proves nothing.
      return await inspectApprovedConfiguration(url, capability, {
        exactBootstrap: true, env: gitEnv
      });
    }
    // The caller may deliberately reuse one observation session across bootstrap and its
    // immediately-following reads.  Its pre-push observation necessarily says that this branch
    // is absent; do not let that stale negative result survive a successful publication.
    session.invalidate(url);
    return {
      branch: CONFIGURATION_BRANCH, commit, created: true, importedFrom: importBranch,
      transportIntent
    };
  } finally {
    await removeTemporaryTree(scratch);
  }
}

async function cloneConfiguration(remote, target, { env = process.env } = {}) {
  const gitEnv = enterpriseGitEnvironment(env);
  const frozen = frozenRemoteTransport(remote, { env: gitEnv });
  // This checkout is mutated or copied immediately. A blobless depth-one clone only defers the
  // exact configuration blobs into a second negotiation, so fetch them in the single clone.
  const clone = await runRemoteGitAsync([
    '-c', 'core.autocrlf=false', 'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
    '--branch', CONFIGURATION_BRANCH, frozen.remote, target
  ], { cwd: path.dirname(target), operation: 'remote-configuration', env: frozen.env });
  if (clone.status !== 0) {
    throw new SingularityFlowError(
      `Cannot read approved configuration from '${sanitizeRemote(remote)}' branch '${CONFIGURATION_BRANCH}'. `
      + (clone.failure?.advice ?? 'Git remote access failed.'),
      { code: clone.failure?.code ?? 'REMOTE_UNKNOWN' });
  }
  return configurationRepositoryHead(target, frozen.env);
}

async function copyVerifiedStateConfiguration(remote, destination, branch = STATE_CONFIGURATION_BRANCH, {
  env = process.env,
  allowUnmarked = false,
  expectedCommit = null,
  captureAuthoringBytes = false
} = {}) {
  const source = await mkdtemp(path.join(os.tmpdir(), 'sflow-state-config-read-'));
  try {
    const gitEnv = enterpriseGitEnvironment(env);
    const frozen = frozenRemoteTransport(remote, { env: gitEnv });
    const clone = await runRemoteGitAsync([
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
      '--no-checkout', '--branch', branch, frozen.remote, source
    ], { cwd: path.dirname(source), operation: 'remote-configuration', env: frozen.env });
    if (clone.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read configuration recovery mirror from '${sanitizeRemote(remote)}' branch '${branch}'. `
        + (clone.failure?.advice ?? 'Git remote access failed.'),
        { code: clone.failure?.code ?? 'REMOTE_UNKNOWN' }
      );
    }
    const mirrorCommit = configurationRepositoryHead(source, frozen.env);
    if (expectedCommit && mirrorCommit !== expectedCommit) {
      throw new SingularityFlowError(
        `Approved state configuration authority moved from ${expectedCommit.slice(0, 12)} to ${mirrorCommit.slice(0, 12)} while its snapshot was being prepared. Refresh and retry; nothing was changed.`,
        {
          code: 'STORY_CONFIGURATION_AUTHORITY_STALE',
          details: {
            branch,
            expectedCommit,
            actualCommit: mirrorCommit
          }
        }
      );
    }
    // Identify the marker from the commit tree before reading its blob. A missing path is an ordinary
    // application `state` branch; a present path whose object cannot be read is a corrupt SFlow mirror
    // and must never be downgraded to absence.
    const markerResult = run('git', [
      'ls-tree', '--full-tree', '--name-only', 'HEAD', '--', STATE_CONFIGURATION_MANIFEST
    ], { cwd: source, allowFailure: true, env: frozen.env });
    const marked = markerResult.status === 0
      && markerResult.stdout.split(/\r?\n/).includes(STATE_CONFIGURATION_MANIFEST);
    if (!marked) {
      if (markerResult.status !== 0) {
        throw new SingularityFlowError(`Cannot inspect state configuration marker on branch '${branch}'.`, {
          code: 'STATE_CONFIGURATION_MIRROR_INVALID'
        });
      }
      if (allowUnmarked) return null;
      throw new SingularityFlowError(
        `State branch '${branch}' does not contain ${STATE_CONFIGURATION_MANIFEST}.`,
        { code: 'STATE_CONFIGURATION_MIRROR_INVALID' }
      );
    }
    const manifestResult = run('git', ['show', `HEAD:${STATE_CONFIGURATION_MANIFEST}`], {
      cwd: source, allowFailure: true, env: frozen.env
    });
    if (manifestResult.status !== 0) {
      throw new SingularityFlowError(
        `State branch '${branch}' contains an unreadable ${STATE_CONFIGURATION_MANIFEST}.`,
        { code: 'STATE_CONFIGURATION_MIRROR_INVALID' }
      );
    }
    let manifest;
    try { manifest = JSON.parse(manifestResult.stdout); }
    catch (error) {
      throw new SingularityFlowError(`State configuration manifest is invalid JSON: ${error.message}`, {
        code: 'STATE_CONFIGURATION_MIRROR_INVALID'
      });
    }
    if (manifest?.format !== STATE_CONFIGURATION_FORMAT || manifest?.layout !== 'canonical-paths'
      || manifest?.source?.branch !== CONFIGURATION_BRANCH
      || !/^[0-9a-f]{40,64}$/.test(manifest?.source?.commit ?? '')
      || !manifest?.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
      throw new SingularityFlowError(
        `State configuration manifest must be ${STATE_CONFIGURATION_FORMAT} with canonical paths and an exact ${CONFIGURATION_BRANCH} source.`,
        { code: 'STATE_CONFIGURATION_MIRROR_INVALID' }
      );
    }
    const declaredSubject = manifest?.subject?.repositoryIdentity ?? null;
    if (declaredSubject != null && declaredSubject !== stateMirrorRepositoryIdentity(remote)) {
      throw new SingularityFlowError(
        'State configuration mirror belongs to another repository.', {
          code: 'STATE_CONFIGURATION_MIRROR_SUBJECT_MISMATCH'
        }
      );
    }
    if (manifest.history != null
      && (manifest.history?.branch !== stateConfigurationHistoryBranch(manifest.source.commit)
        || manifest.history?.commit !== manifest.source.commit)) {
      throw new SingularityFlowError(
        'State configuration manifest contains an invalid immutable history authority.',
        { code: 'STATE_CONFIGURATION_MIRROR_INVALID' }
      );
    }
    const declared = Object.keys(manifest.files).sort();
    const policy = configurationAssetPolicyFromRef(source, 'HEAD', { env: frozen.env });
    if (!declared.includes('singularity/workflow.yml') || declared.some((relative) =>
      !isConfigurationAsset(relative, policy) || !/^[0-9a-f]{64}$/.test(manifest.files[relative] ?? ''))) {
      throw new SingularityFlowError('State configuration manifest contains an invalid or incomplete file set.', {
        code: 'STATE_CONFIGURATION_MIRROR_INVALID'
      });
    }
    const treeEntries = configurationTreeEntries(source, 'HEAD', policy, { env: frozen.env });
    const declaredAssets = manifest.assets ?? null;
    if (declaredAssets != null) {
      if (typeof declaredAssets !== 'object' || Array.isArray(declaredAssets)
          || JSON.stringify(Object.keys(declaredAssets).sort()) !== JSON.stringify(declared)) {
        throw new SingularityFlowError('State configuration mirror asset identities do not match its file set.', {
          code: 'STATE_CONFIGURATION_MIRROR_INVALID'
        });
      }
      for (const relative of declared) {
        const descriptor = declaredAssets[relative];
        const actual = treeEntries.get(relative);
        if (!descriptor || descriptor.sha256 !== manifest.files[relative]
            || !/^[0-9a-f]{40,64}$/.test(descriptor.object ?? '')
            || !/^100(?:644|755)$/.test(descriptor.mode ?? '')
            || actual?.object !== descriptor.object || actual?.mode !== descriptor.mode) {
          throw new SingularityFlowError(`State configuration mirror Git identity does not match for '${relative}'.`, {
            code: 'STATE_CONFIGURATION_MIRROR_INVALID'
          });
        }
      }
    }
    if (declaredSubject == null
        && !await legacyStateMirrorGitMatchesRepository(source, remote, manifest, { env: frozen.env, ref: mirrorCommit })) {
      throw new SingularityFlowError(
        'Legacy state configuration mirror has no repository binding proof.', {
          code: 'STATE_CONFIGURATION_MIRROR_SUBJECT_MISMATCH'
        }
      );
    }
    // Keep selected skill bytes in this private owner before the mirror clone is removed. A later
    // filesystem read of the materialized package cannot re-establish its committed identity.
    const skillEntries = approvedSkillTreeEntries(source, frozen.env, mirrorCommit);
    const skillBlobs = approvedSkillBlobs(source, skillEntries, frozen.env, manifest.files);
    const authoringBytes = captureAuthoringBytes === true ? captureAuthoringGitBytes(source, treeEntries, frozen.env) : null;
    const copied = await copyConfigurationAssetsFromRef(source, 'HEAD', destination, {
      env: frozen.env
    });
    if (JSON.stringify(copied) !== JSON.stringify(declared)) {
      throw new SingularityFlowError('State configuration mirror files do not exactly match its manifest.', {
        code: 'STATE_CONFIGURATION_MIRROR_INVALID'
      });
    }
    for (const relative of copied) {
      const actual = createHash('sha256').update(await readFile(path.join(destination, relative))).digest('hex');
      if (actual !== manifest.files[relative]) {
        throw new SingularityFlowError(`State configuration mirror hash does not match for '${relative}'.`, {
          code: 'STATE_CONFIGURATION_MIRROR_INVALID'
        });
      }
    }
    // Hash integrity is necessary but not sufficient. A mirror is usable only when its complete
    // workflow, agent, prompt and template contract is operational under this engine build.
    const definition = await loadDefinition(destination);
    const result = {
      remote, branch, mirrorCommit,
      sourceBranch: CONFIGURATION_BRANCH,
      sourceCommit: manifest.source.commit,
      history: manifest.history ?? null,
      files: manifest.files,
      assets: Object.fromEntries(copied.map((relative) => [relative, treeEntries.get(relative)])),
      skillEntries, skillBlobs,
      definition
    };
    if (captureAuthoringBytes === true) MIRROR_AUTHORING_GIT_BYTES.set(result, authoringBytes);
    return result;
  } finally {
    await removeTemporaryTree(source);
  }
}

async function storyConfigurationAuthorityObservation(remote, {
  session = new GitRemoteSession({ cwd: REMOTE_GIT_READ_CWD })
} = {}) {
  const url = String(remote ?? '').trim();
  if (!url) return { url, configurationCommit: null, stateCommit: null, observation: null };
  const observed = await session.observeAsync(url, {
    includeHead: false,
    refs: [
      `refs/heads/${CONFIGURATION_BRANCH}`,
      `refs/heads/${STATE_CONFIGURATION_BRANCH}`
    ]
  });
  requireRemoteObservation(observed, 'Story configuration authority');
  return {
    url,
    configurationCommit: observed.refs.get(`refs/heads/${CONFIGURATION_BRANCH}`) ?? null,
    stateCommit: observed.refs.get(`refs/heads/${STATE_CONFIGURATION_BRANCH}`) ?? null,
    observation: observed
  };
}

export async function resolveRemoteStoryConfigurationAuthority(remote, options = {}) {
  const captureAuthoringBytes = options.captureAuthoringBytes === true;
  const selected = await storyConfigurationAuthorityObservation(remote, options);
  const { url, configurationCommit, stateCommit } = selected;
  if (!url) return null;
  if (configurationCommit) {
    return { remote: url, branch: CONFIGURATION_BRANCH, commit: configurationCommit, source: 'configuration' };
  }
  if (!stateCommit) return null;
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-state-config-probe-'));
  try {
    const mirror = await copyVerifiedStateConfiguration(url, scratch, STATE_CONFIGURATION_BRANCH, {
      allowUnmarked: true,
      expectedCommit: stateCommit,
      captureAuthoringBytes
    });
    if (!mirror) return null;
    const authority = {
      remote: url, branch: STATE_CONFIGURATION_BRANCH, commit: mirror.mirrorCommit,
      sourceCommit: mirror.sourceCommit, source: 'verified-state-mirror'
    };
    incrementCommandCounter('configuration.snapshot-read');
    const retainedSnapshot = await storyConfigurationSnapshotFromDirectory(authority, scratch, {
      observedCommit: mirror.mirrorCommit,
      sourceCommit: mirror.sourceCommit,
      mirror,
      definition: mirror.definition,
      captureAuthoringBytes
    });
    Object.defineProperty(authority, STORY_CONFIGURATION_AUTHORITY_SNAPSHOT, {
      configurable: false, enumerable: false, writable: false, value: retainedSnapshot
    });
    return authority;
  } finally {
    await removeTemporaryTree(scratch);
  }
}

async function activeWorkspaceForRepository(root) {
  // Workspace authority applies to every manifest member, including a linked Story worktree whose
  // path differs from the canonical clone. Resolve membership by canonical path/Git common directory
  // so opening another repository in VS Code cannot silently drop the external authority.
  const active = await workspaceMemberContextForRepository(
    root, activeWorkspaceFile(), workspaceRegistryFile(), { strict: true }
  );
  if (!active?.workspacePath) return null;
  // Use the exact, identity-verified manifest bytes retained with the membership decision. Reading
  // workspace.json again here would allow a concurrent edit to swap configuration authority after
  // membership was proven (a classic check/use race).
  if (!active.workspace) {
    throw new SingularityFlowError(
      'The active workspace authority is not bound to a validated manifest snapshot.',
      { code: 'ACTIVE_WORKSPACE_UNAVAILABLE' }
    );
  }
  return active.workspace;
}

function configuredStoryRemote(root, remoteName) {
  let remotes;
  try {
    remotes = executeGitQuery(root, 'repository.remotes');
  } catch {
    throw new SingularityFlowError(
      'Cannot enumerate configured Git remotes while resolving Story configuration authority.',
      { code: 'STORY_CONFIGURATION_AUTHORITY_UNAVAILABLE' }
    );
  }
  if (!remotes.includes(remoteName)) return { configured: false, url: null };
  // Resolve authority from the raw checkout-local setting. `git remote get-url` applies ambient
  // url.*.insteadOf rules and must never be used as the identity or input to the frozen authority
  // transport: doing so would turn a machine-local rewrite into configuration authority.
  const identity = configuredRemoteIdentity(root, remoteName, { direction: 'fetch' });
  if (!identity.configured || identity.ambiguous || !identity.url) {
    throw new SingularityFlowError(
      identity.ambiguous
        ? `Configured Story authority remote '${remoteName}' has more than one fetch URL.`
        : `Configured Story authority remote '${remoteName}' has no readable fetch URL.`,
      { code: 'STORY_CONFIGURATION_AUTHORITY_UNAVAILABLE' }
    );
  }
  return { configured: true, url: identity.url };
}

/** Find a Story-readable authority in this repository or its active workspace lead. */
export async function resolveStoryConfigurationAuthority(root, remoteName = 'origin', {
  session = new GitRemoteSession({ cwd: root }),
  captureAuthoringBytes = false
} = {}) {
  const workspace = await activeWorkspaceForRepository(root);
  // A capability-derived workspace records the organisation repository that actually owns
  // sflow/config. It is deliberately separate from the delivery repository chosen to hold
  // workspace/runtime state, so it must win over both the member's origin and the delivery lead.
  const configuredAuthority = workspace?.capabilityAuthority?.url;
  if (configuredAuthority) {
    return resolveRemoteStoryConfigurationAuthority(configuredAuthority, { session, captureAuthoringBytes });
  }

  const own = configuredStoryRemote(root, remoteName);
  // Candidate order is authority precedence. A failed higher-priority observation must throw and
  // may never be converted to absence merely because a lower-priority lead happens to answer.
  const ownAuthority = own.url
    ? await resolveRemoteStoryConfigurationAuthority(own.url, { session, captureAuthoringBytes })
    : null;
  if (ownAuthority) return ownAuthority;

  const lead = workspace?.repositories?.[workspace.leadRepository]?.url;
  return lead ? resolveRemoteStoryConfigurationAuthority(lead, { session, captureAuthoringBytes }) : null;
}

/**
 * Resolve authority for genuinely new work without trusting the workflow checked out by an older
 * Story to name today's Git remote. The caller may supply a repository URL only after proving it is
 * carried by an immutable, branch-bound configuration pin.
 */
export async function resolveNewStoryConfigurationAuthority(root, {
  pinnedRemote = null,
  session = new GitRemoteSession({ cwd: root })
} = {}) {
  const workspace = await activeWorkspaceForRepository(root);
  const configuredAuthority = workspace?.capabilityAuthority?.url;
  if (configuredAuthority) {
    // An explicit organisation authority is authoritative even when it positively contains no
    // configuration yet; never fall through to an older Story pin in that case.
    return resolveRemoteStoryConfigurationAuthority(configuredAuthority, { session });
  }

  const origin = configuredStoryRemote(root, 'origin');
  const candidates = [origin.url, pinnedRemote]
    .map((value) => String(value ?? '').trim())
    .filter((value, index, values) => value && values.indexOf(value) === index);
  for (const candidate of candidates) {
    const authority = await resolveRemoteStoryConfigurationAuthority(candidate, { session });
    if (authority) return authority;
  }

  const lead = workspace?.repositories?.[workspace.leadRepository]?.url;
  if (lead && !candidates.includes(lead)) {
    return resolveRemoteStoryConfigurationAuthority(lead, { session });
  }
  return null;
}

/**
 * Report whether Story authority resolution had an explicit remote candidate.
 *
 * A null authority can mean either "the configured remote positively has no authority" or "this
 * is a deliberately local repository". Read-only callers use this distinction to avoid falling
 * through from the first case to an unrelated cached local sflow/config head.
 */
export async function hasStoryConfigurationAuthorityCandidate(root, remoteName = 'origin') {
  const workspace = await activeWorkspaceForRepository(root);
  if (workspace?.capabilityAuthority?.url) return true;
  if (configuredStoryRemote(root, remoteName).configured) return true;
  return Boolean(workspace?.repositories?.[workspace.leadRepository]?.url);
}

/** Load one Story authority as a complete disposable definition without touching the checkout. */
export async function loadStoryConfigurationDefinition(authority) {
  return (await loadStoryConfigurationSnapshot(authority)).definition;
}

function missingStoryConfigurationWorkflow(authority, sourceCommit) {
  const commit = String(sourceCommit ?? authority?.sourceCommit ?? authority?.commit ?? 'unknown');
  return new SingularityFlowError(
    `Approved configuration ${CONFIGURATION_BRANCH}@${commit.slice(0, 12)} is incomplete: it does not contain singularity/workflow.yml. Nothing was changed. Preview the seeded-only workspace reinitialization, review its exact plan, and apply that plan before creating a Story.`,
    {
      code: 'STORY_CONFIGURATION_WORKFLOW_MISSING',
      details: {
        branch: CONFIGURATION_BRANCH,
        commit,
        missing: ['singularity/workflow.yml'],
        recoveryCommand: {
          command: 'singularity-flow workspace reinitialize --dry-run --json',
          skill: '/sf-admin'
        }
      }
    }
  );
}

/** Keep the complete skill subtree of the approved commit, including entries a checkout skips. */
function approvedSkillTreeEntries(root, env, commit) {
  if (typeof commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
    throw new SingularityFlowError('Approved skill capture requires the exact observed commit.', {
      code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID'
    });
  }
  const listed = run('git', [
    'ls-tree', '-r', '-z', '--full-tree',
    '--format=%(objectmode) %(objectname) %(path)', commit, '--', 'singularity/skills'
  ], { cwd: root, env, encoding: 'buffer', timeoutClass: 'local-read' }).stdout;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries = new Map();
  const aliases = new Map();
  let cursor = 0;
  while (cursor < listed.length) {
    const end = listed.indexOf(0, cursor);
    if (end < 0) {
      throw new SingularityFlowError('Approved skill tree listing was truncated.', {
        code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID'
      });
    }
    const record = listed.subarray(cursor, end);
    const first = record.indexOf(0x20);
    const second = record.indexOf(0x20, first + 1);
    let relative;
    try { relative = decoder.decode(record.subarray(second + 1)); }
    catch {
      throw new SingularityFlowError('Approved skill tree contains a non-UTF-8 path.', {
        code: 'SKP_PATH_REFUSED'
      });
    }
    const mode = record.toString('ascii', 0, first);
    const object = record.toString('ascii', first + 1, second);
    const prefix = 'singularity/skills/';
    if (first < 0 || second < 0 || !relative.startsWith(prefix)
        || !/^100(?:644|755)$/.test(mode)
        || !/^[0-9a-f]{40,64}$/.test(object)) {
      throw new SingularityFlowError(`Approved skill tree contains an unsupported entry: ${relative}.`, {
        code: 'CONFIGURATION_ASSET_NOT_REGULAR', details: { paths: [relative] }
      });
    }
    const parts = relative.slice(prefix.length).split('/');
    const skillId = parts.shift();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skillId ?? '') || !parts.length) {
      throw new SingularityFlowError(`Approved skill tree contains an invalid skill path: ${relative}.`, {
        code: 'SKP_PATH_REFUSED', details: { paths: [relative] }
      });
    }
    const skillPath = parts.join('/');
    assertSkillPackagePath(skillPath);
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const segmentPath = parts.slice(0, depth).join('/');
      const alias = `${skillId}/${assertSkillPackagePath(segmentPath)}`;
      const kind = depth === parts.length ? 'file' : 'directory';
      const previous = aliases.get(alias);
      if (previous && (previous.path !== segmentPath || previous.kind !== kind)) {
        throw new SingularityFlowError(
          `Approved skill tree paths '${previous.path}' and '${segmentPath}' alias.`, {
            code: 'SKP_ID_CASE_COLLISION', details: { paths: [previous.path, segmentPath] }
          }
        );
      }
      aliases.set(alias, { path: segmentPath, kind });
    }
    if (entries.has(relative)) {
      throw new SingularityFlowError(`Approved skill tree repeats '${relative}'.`, {
        code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID'
      });
    }
    entries.set(relative, { relative, mode, object, skillId, skillPath });
    cursor = end + 1;
  }
  return entries;
}

/** Raw committed package bytes only; no checkout, filter or materialized skill source read. */
function approvedSkillBlobs(root, skillEntries, env, expectedHashes = null) {
  const skillBlobs = new Map();
  const bySkill = new Map();
  for (const entry of skillEntries.values()) {
    if (expectedHashes && (!Object.hasOwn(expectedHashes, entry.relative)
        || !/^[a-f0-9]{64}$/.test(expectedHashes[entry.relative]))) {
      throw new SingularityFlowError('Approved mirror skill is absent from its exact declared file closure.', {
        code: 'STATE_CONFIGURATION_MIRROR_INVALID'
      });
    }
    const group = bySkill.get(entry.skillId) ?? [];
    group.push(entry); bySkill.set(entry.skillId, group);
  }
  for (const [skillId, entries] of bySkill) {
    if (entries.length > SKP_CAPTURE_LIMITS.files) {
      throw new SingularityFlowError(`Approved skill '${skillId}' exceeds its file limit.`, {
        code: 'SKP_BUDGET_EXCEEDED', details: {
          dimension: 'files', limit: SKP_CAPTURE_LIMITS.files, actual: entries.length
        }
      });
    }
    const blobs = readLocalGitBlobs(root, entries.map((entry) => entry.object), {
      env, maximumBytes: SKP_CAPTURE_LIMITS.totalBytes,
      maximumObjectBytes: SKP_CAPTURE_LIMITS.referenceBytes,
      maximumBatchBytes: SKP_CAPTURE_LIMITS.totalBytes,
      code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID', limitCode: 'SKP_BUDGET_EXCEEDED',
      label: `Approved skill '${skillId}'`
    });
    let totalBytes = 0;
    for (const entry of entries) {
      const contents = blobs.get(entry.object);
      if (!contents || (entry.skillPath === 'SKILL.md' && contents.length > SKP_CAPTURE_LIMITS.entryBytes)) {
        throw new SingularityFlowError(`Approved skill entry is unavailable or too large: ${entry.relative}.`, {
          code: contents ? 'SKP_BUDGET_EXCEEDED' : 'STORY_CONFIGURATION_SNAPSHOT_INVALID'
        });
      }
      totalBytes += contents.length;
      if (totalBytes > SKP_CAPTURE_LIMITS.totalBytes) {
        throw new SingularityFlowError(`Approved skill '${skillId}' exceeds its byte limit.`, {
          code: 'SKP_BUDGET_EXCEEDED', details: {
            dimension: 'totalBytes', limit: SKP_CAPTURE_LIMITS.totalBytes, actual: totalBytes
          }
        });
      }
      if (expectedHashes && createHash('sha256').update(contents).digest('hex') !== expectedHashes[entry.relative]) {
        throw new SingularityFlowError('Approved mirror skill bytes differ from the exact declared Git package.', {
          code: 'STATE_CONFIGURATION_MIRROR_INVALID'
        });
      }
      skillBlobs.set(entry.relative, Buffer.from(contents));
    }
  }
  return skillBlobs;
}

async function storyConfigurationSnapshotFromDirectory(authority, scratch, {
  observedCommit,
  sourceCommit,
  mirror = null,
  definition: retainedDefinition = null,
  env = process.env,
  captureAuthoringBytes = false
}) {
  // A remote authority must use reviewed workspace repair, not repository-local init advice.
  const workflow = await lstat(path.join(scratch, 'singularity/workflow.yml')).catch((error) => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!workflow) throw missingStoryConfigurationWorkflow(authority, sourceCommit);
  const definition = retainedDefinition ?? await loadDefinition(scratch);
  const assets = [];
  // The clone was obtained under frozen enterprise Git policy. Keep every subsequent tree/blob
  // query on that same authority boundary; ambient GIT_DIR, alternates, and command-scoped config
  // must not retarget only the package read after the remote commit was verified.
  const gitEnv = mirror ? null : enterpriseGitEnvironment(env);
  const treeEntries = mirror?.assets
    ? new Map(Object.entries(mirror.assets))
    : configurationTreeEntries(scratch, 'HEAD', null, { env: gitEnv });
  const authoringBytes = captureAuthoringBytes === true
    ? (mirror ? MIRROR_AUTHORING_GIT_BYTES.get(mirror) : captureAuthoringGitBytes(scratch, treeEntries, gitEnv))
    : null;
  // Both direct clones and recovery mirrors retain skill bytes directly from exact commit objects.
  // Materialized package paths are never authority to replace that already captured byte closure.
  if (mirror && (!(mirror.skillEntries instanceof Map) || !(mirror.skillBlobs instanceof Map))) {
    throw new SingularityFlowError('Approved mirror has no retained exact skill byte closure.', {
      code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID'
    });
  }
  const skillEntries = mirror ? mirror.skillEntries : approvedSkillTreeEntries(scratch, gitEnv, observedCommit);
  const materializedPaths = await configurationAssetPaths(scratch);
  // A recovery mirror's package membership is the closed committed inventory retained above,
  // not whichever skill paths happen to remain in its disposable materialization afterward.
  const assetPaths = mirror ? [...new Set([
    ...materializedPaths.filter((relative) => !relative.startsWith('singularity/skills/')),
    ...skillEntries.keys()
  ])].sort() : materializedPaths;
  if (!mirror) {
    const retainedSkills = assetPaths.filter((relative) =>
      relative.startsWith('singularity/skills/')).sort();
    const approvedSkills = [...skillEntries.keys()].sort();
    if (JSON.stringify(retainedSkills) !== JSON.stringify(approvedSkills)) {
      throw new SingularityFlowError('Approved skill tree and retained configuration paths differ.', {
        code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID',
        details: { missing: approvedSkills.filter((relative) => !retainedSkills.includes(relative)),
          unexpected: retainedSkills.filter((relative) => !skillEntries.has(relative)) }
      });
    }
  }
  const skillBlobs = mirror ? mirror.skillBlobs : approvedSkillBlobs(scratch, skillEntries, gitEnv);
  for (const relative of assetPaths) {
    const file = path.join(scratch, relative);
    if (!skillEntries.has(relative)) {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new SingularityFlowError(`Configuration asset must be a regular file: ${relative}`);
      }
    } else if (!skillBlobs.has(relative)) {
      throw new SingularityFlowError('Approved skill package has incomplete committed byte closure.', {
        code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID'
      });
    }
    const contents = skillBlobs.has(relative)
      ? Buffer.from(skillBlobs.get(relative)) : Buffer.from(await readFile(file));
    const treeEntry = skillEntries.get(relative) ?? treeEntries.get(relative);
    if (!treeEntry || !/^100(?:644|755)$/.test(treeEntry.mode)
        || !/^[0-9a-f]{40,64}$/.test(treeEntry.object ?? '')) {
      throw new SingularityFlowError(`Configuration asset has no canonical Git blob identity: ${relative}`);
    }
    assets.push(Object.freeze({
      relative,
      contents,
      sha256: createHash('sha256').update(contents).digest('hex'),
      mode: treeEntry.mode === '100755' ? 0o755 : 0o644,
      gitMode: treeEntry.mode,
      object: treeEntry.object
    }));
  }
  if (!assets.some((entry) => entry.relative === 'singularity/workflow.yml')) {
    throw missingStoryConfigurationWorkflow(authority, sourceCommit);
  }
  const snapshot = Object.freeze({
    [STORY_CONFIGURATION_SNAPSHOT]: true,
    authority: Object.freeze({
      remote: authority.remote,
      branch: authority.branch,
      commit: authority.commit,
      ...(authority.sourceCommit ? { sourceCommit: authority.sourceCommit } : {}),
      source: authority.source
    }),
    observedCommit,
    sourceCommit,
    mirror: mirror ? Object.freeze({
      branch: mirror.branch,
      commit: mirror.mirrorCommit,
      history: mirror.history == null ? null : Object.freeze({ ...mirror.history })
    }) : null,
    definition,
    assets: Object.freeze(assets)
  });
  STORY_CONFIGURATION_VERIFIED_DEFINITIONS.set(snapshot, Object.freeze({
    definition: structuredClone(definition),
    definitionSha256: recordSha256(definition)
  }));
  if (captureAuthoringBytes === true) STORY_CONFIGURATION_AUTHORING_GIT_BYTES.set(snapshot, authoringBytes ?? { unavailable: true });
  return snapshot;
}

function captureAuthoringGitBytes(root, treeEntries, env) {
  incrementCommandCounter('configuration.authoring-byte-capture');
  // Keep the additive bounded profile unavailable on overflow without changing old Story reads.
  try {
    const selected = [...treeEntries].filter(([relative]) => !relative.startsWith('singularity/skills/'));
    if (selected.length > AUTHORING_GIT_BYTE_LIMITS.assets || selected.some(([, entry]) => !/^100(?:644|755)$/u.test(entry.mode))) {
      return { unavailable: true };
    }
    const blobs = readLocalGitBlobs(root, selected.map(([, entry]) => entry.object), {
      env, maximumBytes: AUTHORING_GIT_BYTE_LIMITS.totalBytes,
      maximumObjectBytes: AUTHORING_GIT_BYTE_LIMITS.objectBytes,
      maximumBatchBytes: AUTHORING_GIT_BYTE_LIMITS.totalBytes,
      code: 'APPROVED_CONFIGURATION_EXACT_BYTES_UNAVAILABLE', limitCode: 'APPROVED_CONFIGURATION_EXACT_BYTES_UNAVAILABLE',
      label: 'Exact approved authoring content'
    });
    // The batch reader deduplicates Git object IDs. Retention copies per path, so account for
    // repeated identical blobs before allocating any path-owned buffers.
    let retainedBytes = 0;
    for (const [, entry] of selected) {
      const contents = blobs.get(entry.object);
      if (!Buffer.isBuffer(contents) || (retainedBytes += SNAPSHOT_BYTE_LENGTH.call(contents)) > AUTHORING_GIT_BYTE_LIMITS.totalBytes) {
        return { unavailable: true };
      }
    }
    const files = new Map(selected.map(([relative, entry]) => {
      const contents = Buffer.from(blobs.get(entry.object));
      return [relative, { relative, contents, sha256: createHash('sha256').update(contents).digest('hex'),
        mode: entry.mode === '100755' ? 0o755 : 0o644, object: entry.object }];
    }));
    return { files };
  } catch { return { unavailable: true }; }
}

function verifiedStoryDefinition(snapshot) {
  const retained = snapshot && STORY_CONFIGURATION_VERIFIED_DEFINITIONS.get(snapshot);
  if (!snapshot?.[STORY_CONFIGURATION_SNAPSHOT] || !retained) {
    throw new SingularityFlowError(
      'Story work-type resolution requires a verified approved configuration snapshot.',
      { code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID' }
    );
  }
  let projectionSha256;
  try { projectionSha256 = recordSha256(snapshot.definition); }
  catch { projectionSha256 = null; }
  if (projectionSha256 !== retained.definitionSha256
      || !snapshot.assets.some((asset) => asset.relative === 'singularity/workflow.yml')
      || snapshot.assets.some((asset) => !Buffer.isBuffer(asset.contents)
        || createHash('sha256').update(asset.contents).digest('hex') !== asset.sha256)) {
    throw new SingularityFlowError(
      'Verified Story configuration definition or retained asset bytes changed in memory.',
      { code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID' }
    );
  }
  return retained.definition;
}

/** Resolve a Story work type and approval authority from the exact approved, retained bytes. */
export function resolveApprovedStoryWorkType(snapshot, workTypeId) {
  // resolveWorkType normalizes a fresh copy; neither the returned policy nor a caller-supplied
  // snapshot projection can modify the private approved definition used by later operations.
  return resolveWorkType(structuredClone(verifiedStoryDefinition(snapshot)), workTypeId);
}

/** Current approved reviewer catalog, even if that source removed the old Story work type. */
export function approvedStoryApprovalAuthorities(snapshot) {
  return structuredClone(verifiedStoryDefinition(snapshot).approvalAuthorities);
}

function storyObjectCacheRoot(env) {
  const configured = String(env.SINGULARITY_FLOW_STORY_CONFIGURATION_CACHE ?? '').trim();
  if (configured.toLowerCase() === 'off') return null;
  // Do not reinterpret a relative cache path against a disposable clone's cwd.
  if (configured && (!path.isAbsolute(configured) || path.parse(configured).root === configured)) return null;
  const registry = String(env.SINGULARITY_FLOW_LEAD_REGISTRY ?? '').trim();
  return configured || (registry
    ? path.join(path.dirname(path.resolve(registry)), '.cache', 'story-configuration', 'v1')
    : path.join(os.homedir(), '.singularity-flow', 'cache', 'story-configuration', 'v1'));
}

async function storyObjectCacheStorageUsage(root) {
  let files = 0;
  let directories = 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length) {
    directories += 1;
    if (files + directories + pending.length > STORY_CONFIGURATION_OBJECT_CACHE_LIMITS.storageFiles) {
      return { valid: true, files: files + directories + pending.length, bytes, over: true };
    }
    const directory = pending.pop();
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()
        || (typeof process.getuid === 'function' && info.uid !== process.getuid())) return { valid: false };
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const item = await lstat(candidate);
      if (item.isSymbolicLink()
          || (typeof process.getuid === 'function' && item.uid !== process.getuid())) return { valid: false };
      if (item.isDirectory()) pending.push(candidate);
      else if (item.isFile() && item.nlink === 1) {
        files += 1;
        bytes += item.size;
      } else return { valid: false };
      if (files + directories + pending.length > STORY_CONFIGURATION_OBJECT_CACHE_LIMITS.storageFiles
          || bytes > STORY_CONFIGURATION_OBJECT_CACHE_LIMITS.storageBytes) {
        return { valid: true, files: files + directories + pending.length, bytes, over: true };
      }
    }
  }
  return { valid: true, files: files + directories, bytes, over: false };
}

async function storyObjectCacheStorage(root) {
  const usage = await storyObjectCacheStorageUsage(root);
  return usage.valid && !usage.over;
}

// Retire an exact derived store by rename before removing it. A fresh entry lease already guards
// the key, so two recoverers cannot reuse partially written objects or delete a successor. The
// tombstone is on the same filesystem, outside the active cache namespace, and is never read.
async function retireStoryObjectCacheDirectory(directory) {
  const info = await lstat(directory).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('unsafe derived cache entry');
  const retiredRoot = await mkdtemp(path.join(path.dirname(path.dirname(directory)), '.story-configuration-retired-'));
  const retired = path.join(retiredRoot, 'store');
  try { await rename(directory, retired); }
  catch (error) { await removeTemporaryTree(retiredRoot).catch(() => {}); throw error; }
  await removeTemporaryTree(retiredRoot).catch(() => {});
  return true;
}

async function storyObjectCacheEntries(root) {
  const entries = await readdir(root);
  if (entries.some((entry) => entry !== '.allocation.lock' && entry !== '.file-lease-reclaims'
      && !/^[a-f0-9]{64}(?:\.incomplete)?$/u.test(entry))) return null;
  if (entries.includes('.file-lease-reclaims')) {
    const info = await lstat(path.join(root, '.file-lease-reclaims'));
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && info.uid !== process.getuid())) return null;
  }
  const rows = [];
  for (const key of entries.filter((entry) => /^[a-f0-9]{64}$/u.test(entry))) {
    const directory = path.join(root, key);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && info.uid !== process.getuid())) return null;
    const lease = await inspectFileLease(`${directory}.incomplete`, { legacyQuarantine: true });
    rows.push({ key, directory, modified: info.mtimeMs, lease });
  }
  return rows;
}

// This is only local admission work. It must be called under the short allocation lease and
// never across a native Git operation. Locked/unverifiable stores cannot become eviction victims.
async function admitStoryObjectCacheEntry(root, key) {
  const rows = await storyObjectCacheEntries(root);
  if (!rows) return false;
  let remaining = rows.length;
  const exists = rows.some((row) => row.key === key);
  let usage = await storyObjectCacheStorageUsage(root);
  if (!usage.valid) return false;
  const within = () => remaining + (exists ? 0 : 1) <= STORY_CONFIGURATION_OBJECT_CACHE_LIMITS.entries
    && !usage.over && usage.files < STORY_CONFIGURATION_OBJECT_CACHE_LIMITS.storageFiles
    && usage.bytes < STORY_CONFIGURATION_OBJECT_CACHE_LIMITS.storageBytes;
  if (within()) return true;
  const candidates = rows.filter((row) => row.key !== key
    && ['missing', 'reclaimable'].includes(row.lease.state)).sort((left, right) =>
    Number(right.lease.state === 'reclaimable') - Number(left.lease.state === 'reclaimable')
    || left.modified - right.modified || left.key.localeCompare(right.key));
  for (const candidate of candidates) {
    const lease = await acquireFileLease(`${candidate.directory}.incomplete`, {
      legacyQuarantine: true,
      onReclaimed: () => retireStoryObjectCacheDirectory(candidate.directory)
    });
    if (!lease) continue;
    try {
      await retireStoryObjectCacheDirectory(candidate.directory);
      remaining -= 1;
      incrementCommandCounter('configuration.object-cache-evicted');
    } finally { await lease.release({ cleanupConfirmed: true }); }
    usage = await storyObjectCacheStorageUsage(root);
    if (!usage.valid) return false;
    if (within()) return true;
  }
  return false;
}

function storyObjectCacheConfigRows(rows, commit) {
  const values = new Map();
  const allowed = new Map([
    ['core.repositoryformatversion', new Set([commit.length === 64 ? '1' : '0'])],
    ['core.bare', new Set(['true'])],
    ...['filemode', 'logallrefupdates', 'ignorecase', 'precomposeunicode']
      .map((key) => [`core.${key}`, new Set(['true', 'false'])]),
    ['extensions.objectformat', new Set([commit.length === 64 ? 'sha256' : 'sha1'])]
  ]);
  for (const [key, value] of rows) {
    if (!allowed.get(key)?.has(value) || values.has(key)) return false;
    values.set(key, value);
  }
  return values.has('core.repositoryformatversion') && values.get('core.bare') === 'true'
    && (commit.length !== 64 || values.get('extensions.objectformat') === 'sha256');
}

async function storyObjectCacheMetadata(directory, commit) {
  const file = path.join(directory, 'config');
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16 * 1024) return false;
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file)); }
  catch { return false; }
  let section = null;
  const rows = [];
  for (const line of content.split(/\r?\n/u)) {
    const text = line.trim();
    if (!text || /^[#;]/u.test(text)) continue;
    const header = /^\[(core|extensions)\]$/u.exec(text);
    if (header) { section = header[1]; continue; }
    const entry = /^([a-z]+)\s*=\s*([a-z0-9]+)$/iu.exec(text);
    if (!section || !entry) return false;
    rows.push([`${section}.${entry[1].toLowerCase()}`, entry[2]]);
  }
  return storyObjectCacheConfigRows(rows, commit);
}

function storyObjectCacheLocal(state, args, options) {
  if (state.cleanupUnproven) return { status: 1, stdout: '', stderr: '', blocked: true };
  let result;
  try {
    result = run('git', [
      '-c', `core.hooksPath=${gitDisabledHooksPath()}`, '-c', 'gc.auto=0',
      '-c', 'maintenance.auto=false', ...args
    ], { ...options, allowFailure: true, timeoutMs: 30_000 });
  } catch {
    state.cleanupUnproven = true;
    return { status: 1, stdout: '', stderr: '', blocked: true };
  }
  if (!processResultCompleted(result)) state.cleanupUnproven = true;
  return processResultSucceeded(result) ? result : { ...result, status: result.status === 0 ? 1 : result.status };
}

async function storyObjectCacheRemote(state, args, options) {
  if (state.cleanupUnproven) return { status: 1, stdout: '', stderr: '', blocked: true };
  try {
    const result = await runRemoteGitAsync(args, options);
    if (!processResultCompleted(result)) state.cleanupUnproven = true;
    return result;
  } catch (error) {
    // A rejected async runner can lose acknowledgement after dispatch. Do not infer that it
    // rejected before starting a helper, nor let an outer fallback retire the child's store.
    state.cleanupUnproven = true;
    state.transportErrorRaised = true;
    state.transportError = error;
    throw error;
  }
}

function storyObjectCacheProfile(directory, commit, env, state) {
  const declined = (reason) => { incrementCommandCounter(`configuration.object-cache-profile-${reason}`); return false; };
  const local = (args, maxBuffer = 64 * 1024, options = {}) => storyObjectCacheLocal(state, args, {
    cwd: directory, env, maxBuffer, ...options
  });
  // A cache cannot introduce arbitrary local configuration, alternates, hooks, or automatic
  // transport. Its metadata was initialized here, and the remote owner seals it after transfer.
  const config = local(['config', '--local', '--no-includes', '--null', '--list']);
  if (!processResultSucceeded(config) || !config.stdout.endsWith('\0')
      || !storyObjectCacheConfigRows(config.stdout.slice(0, -1).split('\0')
        .map((row) => row.split('\n')), commit)) return declined('config');
  const head = local(['rev-parse', '--verify', 'HEAD'], 1024);
  if (!processResultSucceeded(head) || head.stdout.trim() !== commit) return declined('head');
  const checked = local(['fsck', '--strict', '--no-reflogs', '--no-dangling', commit]);
  if (!processResultSucceeded(checked)) return declined('integrity');
  const listed = local(['ls-tree', '-r', '-z', '--full-tree', commit],
    STORY_CONFIGURATION_OBJECT_CACHE_LIMITS.listingBytes, { encoding: 'buffer' });
  let listing;
  try { listing = new TextDecoder('utf-8', { fatal: true }).decode(listed.stdout); }
  catch { return declined('listing'); }
  if (!processResultSucceeded(listed) || !listing.endsWith('\0')) return declined('listing');
  const rows = listing.slice(0, -1).split('\0');
  if (rows.length > STORY_CONFIGURATION_OBJECT_CACHE_LIMITS.files) return declined('files');
  const objects = [];
  const aliases = new Map();
  for (const row of rows) {
    const matched = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/u.exec(row);
    // This limited profile deliberately declines *any* committed attributes, even an unrelated
    // one, rather than proving Git's ordered EOL/encoding/filter rules against a different cwd.
    if (!matched || matched[2].length !== commit.length
        || matched[3].split('/').some((part) => part === '.gitattributes' || part === '.gitmodules')
        || /[\u0000-\u001f\u007f]/u.test(matched[3])) return declined('shape');
    const parts = matched[3].split('/');
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const prefix = parts.slice(0, depth).join('/');
      const alias = prefix.normalize('NFC').toLowerCase();
      const kind = depth === parts.length ? 'file' : 'directory';
      const previous = aliases.get(alias);
      if (prefix !== prefix.normalize('NFC')
          || (previous && (previous.path !== prefix || previous.kind !== kind))) return declined('shape');
      aliases.set(alias, { path: prefix, kind });
    }
    objects.push(matched[2]);
  }
  const sizes = storyObjectCacheLocal(state, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
    cwd: directory, env, input: `${objects.join('\n')}\n`, maxBuffer: Math.max(1024, objects.length * 160)
  });
  if (!processResultSucceeded(sizes)) return declined('sizes');
  const sized = sizes.stdout.trimEnd().split('\n');
  let total = 0;
  const withinBounds = sized.length === objects.length && sized.every((row, index) => {
    const [object, type, rawSize] = row.split(' ');
    const bytes = Number(rawSize);
    return object === objects[index] && type === 'blob' && Number.isSafeInteger(bytes) && bytes >= 0
      && bytes <= STORY_CONFIGURATION_OBJECT_CACHE_LIMITS.objectBytes
      && (total += bytes) <= STORY_CONFIGURATION_OBJECT_CACHE_LIMITS.materializedBytes;
  });
  return withinBounds || declined('bytes');
}

async function cachedStoryConfigurationSnapshot(authority, { env, captureAuthoringBytes, session }) {
  // Capture scalar selectors before the first await; a caller may otherwise change the selected
  // remote/commit while the fresh observation is in flight.
  authority = Object.freeze({ remote: authority.remote, branch: authority.branch,
    commit: authority.commit, source: authority.source,
    ...(authority.sourceCommit ? { sourceCommit: authority.sourceCommit } : {}) });
  const root = storyObjectCacheRoot(env);
  const remote = assertCredentialFreeRemote(authority.remote);
  if (!root || process.platform === 'win32' || authority.branch !== CONFIGURATION_BRANCH
      || (/^file:/iu.test(remote) && !/^file:\/\/\//u.test(remote))
      || /^[a-z]:[^/\\]/iu.test(remote)
      || (!isPortableAbsoluteGitPath(remote)
        && !/^(?:https?|ssh|git):\/\//u.test(remote) && !/^file:\/\/\//u.test(remote)
        && !/^(?:[^/@:\s]+@)?[^/:\s]+:[^\s]+$/u.test(remote))
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(authority.commit ?? '')) return null;
  // Cache metadata and a caller's pin are not current authority. Preserve the original clone's
  // mutable-ref fence even on a warm hit and even if a prior session observation was memoized.
  const admittedEnv = enterpriseGitEnvironment(env);
  const gitEnv = Object.freeze(inheritEnterpriseGitEnvironment(admittedEnv, { ...admittedEnv }));
  const observed = await configurationBranchHead(authority.remote, {
    session: session ?? new GitRemoteSession({ cwd: REMOTE_GIT_READ_CWD, env: gitEnv }), refresh: true
  });
  requireRemoteObservation(observed.observation, 'Story configuration authority');
  if (observed.sha !== authority.commit) throw new SingularityFlowError(
    'Approved Story configuration authority changed before its exact cached read. Refresh and retry; nothing was changed.', {
      code: 'STORY_CONFIGURATION_AUTHORITY_STALE',
      details: { branch: authority.branch, expectedCommit: authority.commit, actualCommit: observed.sha }
    }
  );
  const key = recordSha256({ remote: assertCredentialFreeRemote(authority.remote),
    branch: authority.branch, commit: authority.commit });
  let allocation = null;
  let quarantine = null;
  let scratch = null;
  const state = { cleanupUnproven: false };
  const localEnv = inheritEnterpriseGitEnvironment(gitEnv, {
    ...gitEnv, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1'
  });
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && rootInfo.uid !== process.getuid())) return null;
    const canonical = await realpath(root);
    allocation = await acquireFileLease(path.join(canonical, '.allocation.lock'), {
      waitMs: STORY_CONFIGURATION_OBJECT_CACHE_LIMITS.leaseWaitMs
    });
    if (!allocation) {
      incrementCommandCounter('configuration.object-cache-allocation-timeout');
      return null;
    }
    if (!await admitStoryObjectCacheEntry(canonical, key)) return null;
    const directory = path.join(canonical, key);
    quarantine = await acquireFileLease(`${directory}.incomplete`, {
      legacyQuarantine: true, onReclaimed: () => retireStoryObjectCacheDirectory(directory)
    });
    if (!quarantine) {
      incrementCommandCounter('configuration.object-cache-quarantined');
      return null;
    }
    const exists = await lstat(directory).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (exists && (!exists.isDirectory() || exists.isSymbolicLink())) return null;
    if (!exists) await mkdir(directory, { mode: 0o700 });
    // No transfer, local clone, metadata probe, or snapshot validation may hold the allocator.
    // A second key can therefore be admitted even while this key's native work is slow.
    if (!await allocation.release({ cleanupConfirmed: true })) return null;
    allocation = null;
    await quarantine.protect();
    for (const forbidden of ['objects/info/alternates', 'info/attributes']) {
      if (await lstat(path.join(directory, forbidden)).then(() => true, (error) => error?.code !== 'ENOENT')) return null;
    }
    if (!exists) {
      const initialized = storyObjectCacheLocal(state, [
        'init', '--bare', '--quiet', '--template=',
        ...(authority.commit.length === 64 ? ['--object-format=sha256'] : []), directory
      ], { cwd: canonical, env: localEnv, maxBuffer: 4096 });
      if (!processResultSucceeded(initialized)) return null;
      if (!await storyObjectCacheMetadata(directory, authority.commit)) return null;
      const transport = frozenRemoteTransport(authority.remote, { env: gitEnv });
      incrementCommandCounter('configuration.object-cache-fetch');
      const fetched = await storyObjectCacheRemote(state, [
        '-c', `core.hooksPath=${gitDisabledHooksPath()}`, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
        'fetch', '--quiet', '--no-tags', '--depth', '1', transport.remote,
        `+refs/heads/${CONFIGURATION_BRANCH}:refs/heads/${CONFIGURATION_BRANCH}`
      ], { cwd: directory, env: transport.env, operation: 'remote-configuration', maxBuffer: 64 * 1024 });
      if (!processResultSucceeded(fetched)) return null;
      const selected = storyObjectCacheLocal(state, ['symbolic-ref', 'HEAD', `refs/heads/${CONFIGURATION_BRANCH}`], {
        cwd: directory, env: localEnv, maxBuffer: 4096
      });
      if (!processResultSucceeded(selected)) return null;
    }
    if (!await storyObjectCacheMetadata(directory, authority.commit)) {
      incrementCommandCounter('configuration.object-cache-profile-config');
      return null;
    }
    const sealed = sealTemporaryGitReadTransport(directory, { env: gitEnv });
    if (sealed.cleanupUnproven) state.cleanupUnproven = true;
    if (!sealed.ok) return null;
    if (!storyObjectCacheProfile(directory, authority.commit, localEnv, state)) {
      // A just-created, unsupported/over-budget derived entry has no admitted consumers. Reclaim
      // only that exact key while its lease is held and all native process outcomes are known.
      if (!exists && !state.cleanupUnproven) await removeTemporaryTree(directory);
      return null;
    }
    if (!await storyObjectCacheStorage(canonical)) {
      allocation = await acquireFileLease(path.join(canonical, '.allocation.lock'), {
        waitMs: STORY_CONFIGURATION_OBJECT_CACHE_LIMITS.leaseWaitMs
      });
      if (!allocation) {
        incrementCommandCounter('configuration.object-cache-allocation-timeout');
        return null;
      }
      if (!await admitStoryObjectCacheEntry(canonical, key)) {
        if (!exists && !state.cleanupUnproven) await retireStoryObjectCacheDirectory(directory);
        return null;
      }
      if (!await allocation.release({ cleanupConfirmed: true })) return null;
      allocation = null;
    }
    if (exists) {
      const now = new Date();
      await utimes(directory, now, now);
    }
    // Local transport copies (never hardlinks) the verified objects into the same disposable
    // checkout profile used by ordinary reads. No cache file or serialized definition is mounted.
    scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-config-cache-read-'));
    const transport = frozenRemoteTransport(directory, { env: gitEnv });
    const cloned = await storyObjectCacheRemote(state, [
      '-c', `core.hooksPath=${gitDisabledHooksPath()}`, '-c', 'core.autocrlf=false',
      '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
      '--branch', CONFIGURATION_BRANCH, transport.remote, scratch
    ], { cwd: path.dirname(scratch), env: transport.env, operation: 'remote-configuration', maxBuffer: 64 * 1024 });
    if (!processResultSucceeded(cloned)) return null;
    const head = storyObjectCacheLocal(state, ['rev-parse', '--verify', 'HEAD'], {
      cwd: scratch, env: localEnv, maxBuffer: 1024
    });
    if (!processResultSucceeded(head) || head.stdout.trim() !== authority.commit) return null;
    incrementCommandCounter(exists ? 'configuration.object-cache-hit' : 'configuration.object-cache-miss');
    incrementCommandCounter('configuration.snapshot-read');
    try {
      return await storyConfigurationSnapshotFromDirectory(authority, scratch, {
        observedCommit: authority.commit, sourceCommit: authority.commit, env: gitEnv,
        captureAuthoringBytes
      });
    } catch (error) {
      // Older snapshot readers can turn an opaque allowFailure Git result into an ordinary
      // missing-identity diagnostic. Do not infer complete child cleanup from that error's shape.
      // Conservatively quarantine every exceptional validation read, retaining its original error
      // rather than labelling a semantic invalid configuration as a proven native failure.
      state.cleanupUnproven = true;
      state.snapshotError = error;
      incrementCommandCounter('configuration.object-cache-validation-quarantined');
      throw error;
    }
  } catch (error) {
    if (String(error?.code ?? '').startsWith('FILE_LEASE_')) return null;
    if (error instanceof SingularityFlowError) throw error;
    // Pure local cache admission/IO failures do not hide a readable live authority.
    return null;
  } finally {
    if (quarantine) {
      if (!state.cleanupUnproven) {
        if (!await quarantine.release({ cleanupConfirmed: true }).catch(() => false)) state.cleanupUnproven = true;
      } else {
        await quarantine.retainQuarantine({ unknownChildren: true }).catch(() => {});
        await quarantine.release().catch(() => {}); // closes the descriptor, preserves the fence
      }
    }
    if (allocation && !await allocation.release({ cleanupConfirmed: true }).catch(() => false)) state.cleanupUnproven = true;
    if (scratch && !state.cleanupUnproven) await removeTemporaryTree(scratch).catch(() => { state.cleanupUnproven = true; });
    // A transfer exception is not local cache corruption. Preserve the original transport or
    // admission refusal (including non-SingularityFlowError launchers) without retrying network
    // work through a second clone. Unknown completion still leaves the store quarantined.
    if (state.transportErrorRaised) throw state.transportError;
    if (state.cleanupUnproven && state.snapshotError) throw state.snapshotError;
    // Unknown child completion fences this derived store, not the independent original reader.
    // Cache-local uncertainty must never convert readable authority into a permanent refusal.
    if (state.cleanupUnproven) {
      incrementCommandCounter('configuration.object-cache-quarantined');
      return null;
    }
  }
}

/**
 * Read and verify one exact approved configuration revision once for the complete Story-start
 * operation. The bounded configuration payload is retained in memory after the disposable clone
 * is removed, so validation and later branch materialization cannot perform two network clones or
 * observe two different authority revisions.
 * The separate raw Git authoring-byte profile is opt-in; ordinary Story snapshots neither read
 * its additional blob batch nor retain its additional private copies.
 */
export async function loadStoryConfigurationSnapshot(authority, {
  env = process.env, captureAuthoringBytes = false, useObjectCache = false, session = null
} = {}) {
  if (!authority?.remote || !authority?.branch) {
    throw new SingularityFlowError('A Story configuration definition requires a resolved authority.');
  }
  authority = Object.freeze({ remote: authority.remote, branch: authority.branch,
    commit: authority.commit, source: authority.source,
    ...(authority.sourceCommit ? { sourceCommit: authority.sourceCommit } : {}),
    ...(authority[STORY_CONFIGURATION_AUTHORITY_SNAPSHOT]
      ? { [STORY_CONFIGURATION_AUTHORITY_SNAPSHOT]: authority[STORY_CONFIGURATION_AUTHORITY_SNAPSHOT] } : {}) });
  const retained = authority[STORY_CONFIGURATION_AUTHORITY_SNAPSHOT];
  if (retained) {
    if (!STORY_CONFIGURATION_VERIFIED_DEFINITIONS.has(retained)
        || retained.authority.remote !== authority.remote
        || retained.authority.branch !== authority.branch
        || (authority.commit && retained.observedCommit !== authority.commit)
        || (authority.sourceCommit && retained.sourceCommit !== authority.sourceCommit)) {
      throw new SingularityFlowError(
        'Retained Story configuration snapshot does not match its selected authority.',
        { code: 'STORY_CONFIGURATION_AUTHORITY_STALE' }
      );
    }
    if (captureAuthoringBytes !== true || STORY_CONFIGURATION_AUTHORING_GIT_BYTES.has(retained)) {
      incrementCommandCounter('configuration.snapshot-reused');
      return retained;
    }
  }
  if (useObjectCache === true) {
    const cached = await cachedStoryConfigurationSnapshot(authority, { env, captureAuthoringBytes, session });
    if (cached) return cached;
    incrementCommandCounter('configuration.object-cache-declined');
  }
  let lastMoved = null;
  // A mutable authority ref can advance between its ls-remote observation and the bounded clone.
  // Retry that exact read once. A second mismatch is a stable authority-moved refusal, never an
  // invitation to consume whichever revision happened to win the race.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-config-read-'));
    incrementCommandCounter('configuration.snapshot-read');
    try {
      let observedCommit;
      let sourceCommit;
      let mirror = null;
      if (authority.branch === STATE_CONFIGURATION_BRANCH) {
        mirror = await copyVerifiedStateConfiguration(authority.remote, scratch, authority.branch, {
          env,
          captureAuthoringBytes
        });
        observedCommit = mirror.mirrorCommit;
        sourceCommit = mirror.sourceCommit;
        if (authority.sourceCommit && mirror.sourceCommit !== authority.sourceCommit) {
          throw new SingularityFlowError(
            `Approved configuration source moved from ${authority.sourceCommit.slice(0, 12)} to ${mirror.sourceCommit.slice(0, 12)} while Story intake was being prepared. Refresh and retry; nothing was changed.`,
            {
              code: 'STORY_CONFIGURATION_AUTHORITY_STALE',
              details: {
                branch: authority.branch,
                expectedCommit: authority.sourceCommit,
                actualCommit: mirror.sourceCommit
              }
            }
          );
        }
      } else {
        observedCommit = await cloneConfiguration(authority.remote, scratch, { env });
        sourceCommit = observedCommit;
      }
      if (authority.commit && observedCommit !== authority.commit) {
        throw new SingularityFlowError(
          `Approved configuration authority moved from ${authority.commit.slice(0, 12)} to ${observedCommit.slice(0, 12)} while Story intake was being prepared. Refresh and retry; nothing was changed.`,
          {
            code: 'STORY_CONFIGURATION_AUTHORITY_STALE',
            details: { branch: authority.branch, expectedCommit: authority.commit, actualCommit: observedCommit }
          }
        );
      }
      return await storyConfigurationSnapshotFromDirectory(authority, scratch, {
        observedCommit,
        sourceCommit,
        mirror,
        definition: mirror?.definition ?? null,
        env,
        captureAuthoringBytes
      });
    } catch (error) {
      if (error?.code !== 'STORY_CONFIGURATION_AUTHORITY_STALE') throw error;
      lastMoved = error;
      if (attempt === 2) {
        error.details = { ...(error.details ?? {}), attempts: 2, disposition: 'authority-moved' };
        throw error;
      }
    } finally {
      await removeTemporaryTree(scratch);
    }
  }
  throw lastMoved;
}

/** Inspect one skill retained by an exact, verified approved configuration snapshot. */
export async function inspectApprovedSkillPackage(snapshot, skillId, {
  expectedPackageSha256, requireInertGitMode = false
} = {}) {
  if (!snapshot?.[STORY_CONFIGURATION_SNAPSHOT]
      || !STORY_CONFIGURATION_VERIFIED_DEFINITIONS.has(snapshot)) {
    throw new SingularityFlowError(
      'Approved skill inspection requires a verified Story configuration snapshot.',
      { code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID' }
    );
  }
  if (typeof skillId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skillId)) {
    throw new SingularityFlowError('Skill ID must be a portable lowercase kebab-case name.',
      { code: 'SKP_ID_CASE_COLLISION' });
  }
  const prefix = `singularity/skills/${skillId}/`;
  const contents = new Map();
  const expectedFiles = new Map();
  for (const entry of snapshot.assets) {
    if (!entry.relative.startsWith(prefix)) continue;
    // Snapshot membership is private and each path/mode record was frozen from the exact Git
    // tree by this owner. The artifact-only replacement writer emits 100644; it cannot chmod a
    // previously executable package resource by losing this committed mode evidence.
    if (requireInertGitMode === true && entry.gitMode !== '100644') {
      throw new SingularityFlowError('The selected retained package contains a non-inert Git mode; this replacement dialect cannot change it.', {
        code: 'SKP_PACKAGE_MODE_UNSUPPORTED'
      });
    }
    if (!Buffer.isBuffer(entry.contents)
        || createHash('sha256').update(entry.contents).digest('hex') !== entry.sha256) {
      throw new SingularityFlowError(
        `Verified Story configuration snapshot changed in memory: ${entry.relative}.`,
        { code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID' }
      );
    }
    const relative = entry.relative.slice(prefix.length);
    if (!relative || contents.has(relative)) {
      throw new SingularityFlowError('Approved skill snapshot contains a duplicate or empty path.',
        { code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID' });
    }
    // The byte owner copies through native internal slots, never caller valueOf/length/iterator
    // hooks. Keep this complete capture synchronous so the public snapshot cannot change between
    // its committed identity check and byte ownership; do not reintroduce an import/await here.
    contents.set(relative, entry.contents);
    expectedFiles.set(relative, `sha256:${entry.sha256}`);
  }
  const capture = inspectSkillPackageContents(skillId, contents, { expectedPackageSha256 });
  if (capture.manifest.files.some((entry) => entry.sha256 !== expectedFiles.get(entry.path))) {
    throw new SingularityFlowError('Copied approved skill differs from its verified snapshot identity.', {
      code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID'
    });
  }
  capture.source = Object.freeze({
    kind: 'approved-configuration', branch: CONFIGURATION_BRANCH, commit: snapshot.sourceCommit
  });
  return capture;
}

function assertVerifiedStorySnapshot(snapshot) {
  // Symbols are public projection metadata and can be copied. Check the private owner receipt
  // before reading any caller properties, so a lookalike (including a Proxy) cannot mount bytes.
  if (!STORY_CONFIGURATION_VERIFIED_DEFINITIONS.has(snapshot)) {
    throw new SingularityFlowError('Story configuration reads require a verified owner snapshot.', {
      code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID'
    });
  }
}

function captureStoryConfigurationSnapshotAssets(snapshot, { selectPaths = null } = {}) {
  assertVerifiedStorySnapshot(snapshot);
  const selected = selectPaths == null ? null : new Set([...new Set(selectPaths)].sort());
  if (selected && !selected.has('singularity/workflow.yml')) {
    throw new SingularityFlowError(
      'Approved configuration selection must include singularity/workflow.yml.',
      { code: 'APPROVED_CONFIGURATION_SELECTION_INVALID' }
    );
  }
  if (selected) {
    const available = new Set(snapshot.assets.map((entry) => entry.relative));
    const missing = [...selected].filter((relative) => !available.has(relative));
    if (missing.length) {
      throw new SingularityFlowError(
        `Approved configuration ${snapshot.authority.branch}@${snapshot.sourceCommit.slice(0, 12)} does not contain '${missing[0]}'.`,
        { code: 'APPROVED_CONFIGURATION_INCOMPLETE', details: { missing } }
      );
    }
  }
  const captured = [];
  for (const entry of snapshot.assets) {
    if (selected && !selected.has(entry.relative)) continue;
    const bytes = entry.contents;
    if (types.isProxy(bytes) || !Buffer.isBuffer(bytes)
        || Object.getPrototypeOf(bytes) !== Buffer.prototype) {
      throw new SingularityFlowError('Verified configuration contains non-native byte storage.', {
        code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID'
      });
    }
    // Native internal-slot access and copying do not invoke public length, buffer, valueOf or
    // iterator hooks. Shared-memory bytes cannot supply a stable retained configuration capture.
    if (types.isSharedArrayBuffer(SNAPSHOT_ARRAY_BUFFER.call(bytes))) {
      throw new SingularityFlowError('Shared-memory configuration bytes are not a stable snapshot.', {
        code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID'
      });
    }
    const contents = Buffer.alloc(SNAPSHOT_BYTE_LENGTH.call(bytes));
    SNAPSHOT_COPY_BYTES.call(contents, bytes);
    if (createHash('sha256').update(contents).digest('hex') !== entry.sha256) {
      throw new SingularityFlowError(
        `Verified Story configuration snapshot changed in memory: ${entry.relative}.`,
        { code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID' }
      );
    }
    captured.push({ ...entry, contents });
  }
  return captured;
}

/** Read-only extraction from private verified membership; returned bytes are independent copies. */
export function captureVerifiedConfigurationAssetBytes(snapshot, { selectPaths } = {}) {
  assertVerifiedStorySnapshot(snapshot);
  if (types.isProxy(selectPaths) || !Array.isArray(selectPaths) || Object.getPrototypeOf(selectPaths) !== Array.prototype || !selectPaths.length
      || selectPaths.length > 1024 || Object.keys(selectPaths).length !== selectPaths.length
      || Reflect.ownKeys(selectPaths).some((key) => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key)))
      || Object.values(Object.getOwnPropertyDescriptors(selectPaths)).some((entry) => !Object.hasOwn(entry, 'value'))
      || selectPaths.some((relative) => typeof relative !== 'string')) {
    throw new SingularityFlowError('Exact approved byte extraction requires a bounded literal selected-path array.', {
      code: 'APPROVED_CONFIGURATION_SELECTION_INVALID'
    });
  }
  if (!selectPaths.includes('singularity/workflow.yml')) throw new SingularityFlowError('Exact approved byte selection must include singularity/workflow.yml.', {
    code: 'APPROVED_CONFIGURATION_SELECTION_INVALID'
  });
  const retained = STORY_CONFIGURATION_AUTHORING_GIT_BYTES.get(snapshot);
  if (!retained?.files) throw new SingularityFlowError('The bounded immutable approved authoring byte capture is unavailable; no live file fallback is allowed.', {
    code: 'APPROVED_CONFIGURATION_EXACT_BYTES_UNAVAILABLE'
  });
  return Object.freeze([...new Set(selectPaths)].sort().map((relative) => {
    const entry = retained.files.get(relative);
    if (!entry) throw new SingularityFlowError('An exact selected approved Git asset is unavailable.', { code: 'APPROVED_CONFIGURATION_INCOMPLETE' });
    const contents = Buffer.alloc(SNAPSHOT_BYTE_LENGTH.call(entry.contents)); SNAPSHOT_COPY_BYTES.call(contents, entry.contents);
    return Object.freeze({ relative, mode: entry.mode, sha256: entry.sha256, contents });
  }));
}

async function writeCapturedStoryConfigurationAssets(captured, destination) {
  const copied = [];
  for (const entry of captured) {
    const target = path.join(destination, entry.relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.contents);
    await chmod(target, entry.mode);
    copied.push(entry.relative);
  }
  return copied.sort();
}

async function copyStoryConfigurationSnapshot(snapshot, destination, { selectPaths = null } = {}) {
  // Capture and hash-check the complete selected closure before the first filesystem await.
  const captured = captureStoryConfigurationSnapshotAssets(snapshot, { selectPaths });
  return writeCapturedStoryConfigurationAssets(captured, destination);
}

/**
 * Mount one already-verified Story configuration snapshot for a read-only operation.
 *
 * This is deliberately separate from `materializeConfigurationSnapshot`: diagnostics must be able
 * to inspect the authority selected by Story-start precedence without writing configuration into
 * the application checkout. The snapshot's retained bytes are copied once to a private directory,
 * then the ordinary configuration readers are redirected there for the callback only.
 */
export async function withStoryConfigurationSnapshotRead(root, snapshot, fn, { selectPaths = null } = {}) {
  assertVerifiedStorySnapshot(snapshot);
  const policyPaths = snapshot.assets.filter((entry) =>
    ['singularity/workflow.yml', 'singularity/portfolio.yml'].includes(entry.relative))
    .map((entry) => entry.relative);
  const policyAssets = captureStoryConfigurationSnapshotAssets(snapshot, { selectPaths: policyPaths });
  const yamlFromSnapshot = (relative) => {
    const entry = policyAssets.find((candidate) => candidate.relative === relative);
    if (!entry) return {};
    return YAML.parse(entry.contents.toString('utf8')) ?? {};
  };
  // Compute the policy from the complete retained snapshot before applying a selected-path view.
  // Deriving it from the partial scratch directory would treat an omitted portfolio as defaults and
  // could silently broaden which custom roots the read scope accepts.
  const assetPolicy = configurationAssetPolicy(
    yamlFromSnapshot('singularity/workflow.yml'),
    yamlFromSnapshot('singularity/portfolio.yml')
  );
  if (selectPaths != null) {
    const selected = [...new Set(selectPaths)];
    if (!selected.includes('singularity/workflow.yml')
        || selected.some((relative) => !isConfigurationAsset(relative, assetPolicy))) {
      throw new SingularityFlowError(
        'Approved configuration selection contains an unsupported path.',
        { code: 'APPROVED_CONFIGURATION_SELECTION_INVALID' }
      );
    }
  }
  const captured = captureStoryConfigurationSnapshotAssets(snapshot, { selectPaths });
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-config-read-overlay-'));
  try {
    await writeCapturedStoryConfigurationAssets(captured, scratch);
    // Match the durable configuration-source record rather than the transport branch. A verified
    // state mirror transports these bytes through `state`, but the authority it attests remains
    // the reviewed `sflow/config` source commit.
    const stateMirror = snapshot.authority.source === 'verified-state-mirror';
    const readAuthority = Object.freeze({
      kind: stateMirror ? 'verified-state-mirror' : 'approved-configuration-ref',
      ref: snapshot.authority.branch,
      remote: snapshot.authority.remote,
      commit: snapshot.observedCommit,
      ...(stateMirror ? {
        manifest: Object.freeze({
          source: Object.freeze({ branch: CONFIGURATION_BRANCH, commit: snapshot.sourceCommit }),
          ...(snapshot.mirror?.history == null ? {} : {
            history: Object.freeze({ ...snapshot.mirror.history })
          })
        })
      } : {})
    });
    return await withConfigurationReadRoot(root, scratch, readAuthority, () => fn(readAuthority), {
      assetPolicy,
      // A partial mount must not expose bytes omitted by selectPaths through request-local state.
      configurationSnapshot: selectPaths == null ? snapshot : null
    });
  } finally {
    await removeTemporaryTree(scratch);
  }
}

/** Find the organisation configuration for a repository inside or outside a managed workspace. */
export async function resolveConfigurationRemote(root, remoteName = 'origin', {
  session = new GitRemoteSession({ cwd: root })
} = {}) {
  const workspace = await activeWorkspaceForRepository(root);
  const resolveCandidate = async (remote, label) => {
    const selected = await configurationBranchHead(remote, { session });
    requireRemoteObservation(selected.observation, label);
    return selected.exists ? remote : null;
  };
  const configuredAuthority = workspace?.capabilityAuthority?.url;
  if (configuredAuthority) {
    return await resolveCandidate(configuredAuthority, 'workspace capability authority');
  }

  const own = configuredStoryRemote(root, remoteName);
  if (own.url) {
    const selected = await resolveCandidate(own.url, `repository remote '${remoteName}'`);
    if (selected) return selected;
  }

  if (workspace) {
    // A machine-wide active workspace is navigation context, not authority for every repository
    // on the machine. activeWorkspaceForRepository already proved membership before this fallback.
    const lead = workspace?.repositories?.[workspace.leadRepository]?.url;
    if (lead) return resolveCandidate(lead, 'workspace lead authority');
  }
  return null;
}

/**
 * Copy one approved configuration revision into the current lifecycle branch and record provenance.
 */
export async function materializeConfigurationSnapshot(root, {
  remote = null,
  remoteName = 'origin',
  authority = null,
  snapshot = null
} = {}) {
  const resolvedAuthority = authority ?? snapshot?.authority
    ?? (remote ? await resolveRemoteStoryConfigurationAuthority(remote) : await resolveStoryConfigurationAuthority(root, remoteName));
  if (!resolvedAuthority) return null;
  const verifiedSnapshot = snapshot ?? await loadStoryConfigurationSnapshot(resolvedAuthority);
  if (snapshot) incrementCommandCounter('configuration.snapshot-reused');
  if (!STORY_CONFIGURATION_VERIFIED_DEFINITIONS.has(verifiedSnapshot)
      || verifiedSnapshot.authority.remote !== resolvedAuthority.remote
      || verifiedSnapshot.authority.branch !== resolvedAuthority.branch
      || (resolvedAuthority.commit && verifiedSnapshot.observedCommit !== resolvedAuthority.commit)
      || (resolvedAuthority.sourceCommit && verifiedSnapshot.sourceCommit !== resolvedAuthority.sourceCommit)) {
    throw new SingularityFlowError(
      'Approved configuration snapshot does not match the selected authority. Refresh Story intake and retry; nothing was changed.',
      { code: 'STORY_CONFIGURATION_AUTHORITY_STALE' }
    );
  }
  const sourceRemote = resolvedAuthority.remote;
  const commit = verifiedSnapshot.sourceCommit;
  const mirror = verifiedSnapshot.mirror;
  // No existing configuration is removed until every retained byte has been copied and checked.
  const captured = captureStoryConfigurationSnapshotAssets(verifiedSnapshot);
  {
    const baseCommit = configurationRepositoryHead(root);
    const before = configurationTreeEntries(root, baseCommit);
    const removed = await clearConfigurationAssets(root);
    const files = await writeCapturedStoryConfigurationAssets(captured, root);
    if (!files.includes('singularity/workflow.yml')) {
      throw new SingularityFlowError(
        `${CONFIGURATION_BRANCH}@${commit.slice(0, 12)} does not contain singularity/workflow.yml.`);
    }
    const assets = Object.fromEntries(verifiedSnapshot.assets.map((entry) => [entry.relative, {
      sha256: entry.sha256,
      object: entry.object,
      mode: entry.gitMode
    }]).sort(([a], [b]) => a.localeCompare(b)));
    const hashes = Object.fromEntries(Object.entries(assets).map(([relative, entry]) => [relative, entry.sha256]));
    const removedAssets = Object.fromEntries([...before.entries()]
      .filter(([relative]) => !assets[relative])
      .map(([relative, entry]) => [relative, { object: entry.object, mode: entry.mode }])
      .sort(([a], [b]) => a.localeCompare(b)));
    const projectionSha256 = createHash('sha256').update(JSON.stringify({
      baseCommit, assets, removed: removedAssets
    })).digest('hex');
    const record = {
      schemaVersion: currentSchemaVersion('configuration-source'),
      repository: sourceRemote,
      branch: CONFIGURATION_BRANCH,
      commit,
      ...(mirror ? { mirror: { branch: mirror.branch, commit: mirror.commit ?? mirror.mirrorCommit } } : {}),
      materializedAt: new Date().toISOString(),
      baseCommit,
      files: Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b))),
      assets,
      removed: removedAssets,
      projectionSha256
    };
    const recordFile = path.join(root, CONFIGURATION_SOURCE_PATH);
    await mkdir(path.dirname(recordFile), { recursive: true });
    await writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    // Include removed paths so the isolated lifecycle commit records configuration deletions too.
    // Returning only the copied files would leave an asset removed from `sflow/config` silently
    // tracked on the Story branch.
    return {
      ...record,
      paths: [...new Set([...removed, ...files, CONFIGURATION_SOURCE_PATH])].sort()
    };
  }
}

/**
 * Resolve one capability from the approved configuration authority without touching the caller's
 * checkout. Application branches are allowed to contain only application code, so Story preflight
 * cannot assume the current worktree carries the governed capability catalog.
 */
export async function resolveApprovedConfigurationCapability(
  remote, capabilityId, repositoryContext = null
) {
  const authority = typeof remote === 'string'
    ? await resolveRemoteStoryConfigurationAuthority(remote)
    : remote;
  if (!authority) throw new SingularityFlowError('No Story-readable configuration authority is available.');
  const snapshot = await loadStoryConfigurationSnapshot(authority);
  return resolveStoryConfigurationSnapshotCapability(snapshot, capabilityId, repositoryContext);
}

/** Resolve a capability from an already-verified operation snapshot without another clone. */
export async function resolveStoryConfigurationSnapshotCapability(
  snapshot, capabilityId, repositoryContext = null
) {
  if (!snapshot?.[STORY_CONFIGURATION_SNAPSHOT]) {
    throw new SingularityFlowError('Capability resolution requires a verified Story configuration snapshot.');
  }
  // The approved bytes intentionally live in a Git-less projection. Capability resolution is still
  // repository-specific, so its application identity must arrive separately from the exact checkout
  // which selected this snapshot. Never let `git config --local` search above the disposable
  // projection or substitute the configuration authority for the delivery repository.
  if (!repositoryContext) {
    throw new SingularityFlowError(
      'Capability resolution from an approved configuration snapshot requires a verified application repository context.', {
        code: 'CAPABILITY_REPOSITORY_CONTEXT_REQUIRED'
      }
    );
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-capability-snapshot-'));
  try {
    await copyStoryConfigurationSnapshot(snapshot, scratch);
    const { resolveLifecycleCapability } = await import('./capability-context.mjs');
    const capability = await resolveLifecycleCapability(scratch, {
      capabilityId,
      required: true,
      offline: true,
      repositoryContext
    });
    return {
      branch: snapshot.authority.branch,
      commit: snapshot.sourceCommit,
      mirrorCommit: snapshot.mirror?.commit ?? null,
      capability
    };
  } finally {
    await removeTemporaryTree(scratch);
  }
}

/** Read and optionally verify the provenance record carried by a lifecycle branch. */
export async function readConfigurationSource(root, { verify = false } = {}) {
  const file = path.join(root, CONFIGURATION_SOURCE_PATH);
  const info = await lstat(file).catch(() => null);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SingularityFlowError(`${CONFIGURATION_SOURCE_PATH} must be a regular file.`);
  }
  let record; let storedVersion;
  try {
    ({ record, storedVersion } = readRecord('configuration-source', await readFile(file)));
  }
  catch (error) {
    throw new SingularityFlowError(`Cannot read ${CONFIGURATION_SOURCE_PATH}: ${error.message}`);
  }
  if (record.branch !== CONFIGURATION_BRANCH
    || !/^[0-9a-f]{40}$/.test(record.commit ?? '') || !record.repository) {
    throw new SingularityFlowError(`${CONFIGURATION_SOURCE_PATH} is not a valid configuration provenance record.`);
  }
  const assetEntries = record.assets ?? Object.fromEntries(Object.entries(record.files ?? {})
    .map(([relative, sha256]) => [relative, { sha256, object: null, mode: null }]));
  if (!assetEntries || typeof assetEntries !== 'object' || Array.isArray(assetEntries)) {
    throw new SingularityFlowError(`${CONFIGURATION_SOURCE_PATH} has no valid asset catalog.`);
  }
  const policy = await configurationAssetPolicyFromDirectory(root);
  for (const [relative, descriptor] of Object.entries(assetEntries)) {
    const expected = descriptor?.sha256 ?? record.files?.[relative];
    if (!isConfigurationAsset(relative, policy) || !/^[0-9a-f]{64}$/.test(expected)) {
      throw new SingularityFlowError(`${CONFIGURATION_SOURCE_PATH} contains an invalid asset entry '${relative}'.`);
    }
    if (descriptor?.object != null && !/^[0-9a-f]{40,64}$/.test(descriptor.object)) {
      throw new SingularityFlowError(`${CONFIGURATION_SOURCE_PATH} contains an invalid Git object for '${relative}'.`);
    }
    if (descriptor?.mode != null && !/^100(?:644|755)$/.test(descriptor.mode)) {
      throw new SingularityFlowError(`${CONFIGURATION_SOURCE_PATH} contains an invalid Git mode for '${relative}'.`);
    }
    if (!verify) continue;
    const asset = path.join(root, relative);
    const assetInfo = await lstat(asset).catch(() => null);
    if (!assetInfo?.isFile() || assetInfo.isSymbolicLink()) {
      throw new SingularityFlowError(`Pinned configuration asset is missing or unsafe: ${relative}`);
    }
    const actual = createHash('sha256').update(await readFile(asset)).digest('hex');
    let canonicalMatch = actual === expected;
    if (!canonicalMatch && descriptor?.object) {
      const indexed = run('git', ['ls-files', '--stage', '-z', '--', relative], {
        cwd: root, allowFailure: true
      }).stdout.split('\0').find(Boolean)?.match(/^(\d{6}) ([0-9a-f]{40,64}) \d\t/);
      const clean = run('git', ['diff', '--quiet', '--', relative], { cwd: root, allowFailure: true }).status === 0;
      canonicalMatch = Boolean(indexed && indexed[2] === descriptor.object
        && (!descriptor.mode || indexed[1] === descriptor.mode) && clean);
    }
    if (!canonicalMatch) {
      throw new SingularityFlowError(
        `Pinned configuration asset changed after materialization: ${relative}. Start from the approved configuration again.`);
    }
  }
  const removalPolicy = record.baseCommit
    ? mergeConfigurationAssetPolicies(policy, configurationAssetPolicyFromRef(root, record.baseCommit))
    : policy;
  for (const [relative, descriptor] of Object.entries(record.removed ?? {})) {
    if (!isConfigurationAsset(relative, removalPolicy)
        || !/^[0-9a-f]{40,64}$/.test(descriptor?.object ?? '')
        || !/^100(?:644|755)$/.test(descriptor?.mode ?? '')) {
      throw new SingularityFlowError(`${CONFIGURATION_SOURCE_PATH} contains an invalid approved removal '${relative}'.`);
    }
  }
  if (verify) {
    const actualAssets = await configurationAssetPaths(root);
    const expectedAssets = Object.keys(assetEntries).sort();
    if (JSON.stringify(actualAssets) !== JSON.stringify(expectedAssets)) {
      const extra = actualAssets.filter((relative) => !assetEntries[relative]);
      const missing = expectedAssets.filter((relative) => !actualAssets.includes(relative));
      throw new SingularityFlowError(
        `Pinned configuration asset set changed after materialization.`
        + `${extra.length ? ` Unexpected: ${extra.join(', ')}.` : ''}`
        + `${missing.length ? ` Missing: ${missing.join(', ')}.` : ''}`
      );
    }
  }
  if (storedVersion >= 2) {
    const expectedProjection = createHash('sha256').update(JSON.stringify({
      baseCommit: record.baseCommit, assets: assetEntries, removed: record.removed ?? {}
    })).digest('hex');
    if (record.projectionSha256 !== expectedProjection) {
      throw new SingularityFlowError(`${CONFIGURATION_SOURCE_PATH} projection digest is invalid.`);
    }
  }
  // Derived, never stored. The loop above compares each asset to a hash held in the very file it is
  // verifying, so editing an asset and repasting its hash passes — the record attests to itself.
  // This digest of the whole pinned set is what the Story's immutable resolution compares against,
  // and because it is computed rather than read, it cannot be edited alongside the map.
  const files = Object.entries(record.files ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const attestation = storedVersion >= 2
    ? {
        files: Object.fromEntries(files),
        baseCommit: record.baseCommit,
        assets: assetEntries,
        removed: record.removed ?? {},
        projectionSha256: record.projectionSha256
      }
    : files;
  const filesSha256 = createHash('sha256').update(JSON.stringify(attestation)).digest('hex');
  return { ...structuredClone(record), filesSha256 };
}
