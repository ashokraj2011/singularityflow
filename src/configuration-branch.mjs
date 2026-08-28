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
import {
  chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile
} from 'node:fs/promises';
import { initializeDefinition, loadDefinition } from './config.mjs';
import {
  describeCapability, describeRepository, enableLedger, repositoryIdFromUrl,
  setDefaultBaseBranch, setGroundingMode
} from './bootstrap.mjs';
import { loadCapabilities } from './capabilities.mjs';
import { gitCommitIdentity } from './git.mjs';
import { GitRemoteSession, requireRemoteObservation, runRemoteGit } from './git-execution.mjs';
import { activeWorkspaceFile, readActiveWorkspaceContext, workspaceRegistryFile } from './workspace-context.mjs';
import { readWorkspace, workspaceRepositoryPath } from './workspace.mjs';
import { removeTemporaryTree, SingularityFlowError, run } from './util.mjs';
import { sanitizeRemote } from './git-remote-diagnostics.mjs';
import {
  createAndPushTransportIntent, listTransportIntents, retryTransportIntent
} from './transport-intents.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { incrementCommandCounter } from './dx-command-timing.mjs';

export const CONFIGURATION_BRANCH = 'sflow/config';
export const CONFIGURATION_SOURCE_PATH = 'singularity/configuration-source.json';
export const STATE_CONFIGURATION_BRANCH = 'state';
export const STATE_CONFIGURATION_MANIFEST = 'configuration/manifest.json';
export const STATE_CONFIGURATION_FORMAT = 'singularity-flow-configuration-mirror/v2';

// These directories are lifecycle state or generated evidence, never shared configuration.
const RUNTIME_ROOTS = new Set([
  'initiatives', 'work-items', 'seeds', 'world-model', 'knowledge', 'pins',
  'identity-reservations', 'telemetry',
  // Product refresh metadata belongs only to the configuration authority. Story branches pin the
  // approved configuration bytes, not the package baseline used to decide how a later release may
  // merge them, so this directory must never be materialized into lifecycle history.
  '.product'
]);

const STORY_CONFIGURATION_SNAPSHOT = Symbol('story-configuration-snapshot');

function slash(value) { return value.split(path.sep).join('/'); }

export function isConfigurationAsset(relative) {
  const value = slash(String(relative ?? '').replace(/^\.\//, ''));
  if (!value || value.startsWith('/') || value.includes('\0')
    || path.posix.normalize(value) !== value || value.split('/').includes('..')) return false;
  if (value === CONFIGURATION_SOURCE_PATH) return false;
  if (value === '.github/agents' || value.startsWith('.github/agents/')) return true;
  if (!value.startsWith('singularity/')) return false;
  const root = value.slice('singularity/'.length).split('/')[0];
  return Boolean(root) && !RUNTIME_ROOTS.has(root);
}

async function filesBelow(root, relative = '', output = []) {
  const directory = path.join(root, relative);
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (relative === '' && entry.name === '.git') continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) await filesBelow(root, child, output);
    else if (entry.isFile() && isConfigurationAsset(child)) output.push(slash(child));
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
export async function configurationAssetPaths(root) {
  // Do not walk the application tree (especially node_modules/build output) to discover two
  // bounded configuration roots. Large monorepos otherwise pay this cost on every refresh and
  // capability publication.
  return [
    ...await filesBelow(root, 'singularity'),
    ...await filesBelow(root, '.github/agents')
  ].sort();
}

/**
 * Read the repository's canonical Git bytes for the current configuration worktree without
 * touching its real index. This is the line-ending-safe source for state mirrors and receipts.
 */
export async function canonicalConfigurationAssets(root, paths = null) {
  const selected = paths ?? await configurationAssetPaths(root);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-index-'));
  const index = path.join(temporary, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
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
      cwd: root, encoding: 'buffer', input: `${staged.map((entry) => entry.object).join('\n')}\n`
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

function configurationTreeEntries(root, ref = 'HEAD') {
  const listed = run('git', [
    'ls-tree', '-r', '-z', '--format=%(objectmode) %(objectname) %(path)', ref, '--',
    'singularity', '.github/agents'
  ], { cwd: root, allowFailure: true });
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
  }).filter(([, entry]) => /^100(?:644|755)$/.test(entry.mode) && isConfigurationAsset(entry.relative)));
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
async function copyConfigurationAssetsFromRef(source, ref, destination) {
  const listed = run('git', [
    'ls-tree', '-r', '-z', '--format=%(objectmode) %(objectname) %(path)', ref, '--',
    'singularity', '.github/agents'
  ], { cwd: source });
  const entries = listed.stdout.split('\0').filter(Boolean).map((line) => {
    const first = line.indexOf(' ');
    const second = line.indexOf(' ', first + 1);
    return {
      mode: line.slice(0, first),
      oid: line.slice(first + 1, second),
      file: line.slice(second + 1)
    };
  }).filter((entry) => /^100(?:644|755)$/.test(entry.mode) && isConfigurationAsset(entry.file));
  if (!entries.length) return [];

  const batch = run('git', ['cat-file', '--batch'], {
    cwd: source,
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
  const removed = await filesBelow(root);
  for (const relative of removed) await rm(path.join(root, relative), { force: true });
  return removed;
}

async function configurationStatePaths(root) {
  const files = await filesBelow(root);
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

export function remoteHasConfigurationBranch(remote, options = {}) {
  const head = configurationBranchHead(remote, options);
  return head.reachable && head.exists;
}

/**
 * Read the exact configuration-authority tip without throwing away reachability diagnostics.
 * Callers that only need a boolean keep using `remoteHasConfigurationBranch`; organisation reads
 * use the SHA as their durable cache validator and distinguish a missing branch from an offline
 * remote so stale data is never presented as an empty organisation.
 */
export function configurationBranchHead(remote, {
  session = new GitRemoteSession(), refresh = false, observation = null
} = {}) {
  const observed = observation ?? session.observe(remote, {
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

function assertRequestedCapability(capabilities, capability, remote) {
  if (!capability) return;
  const id = String(capability.capabilityId ?? '').trim();
  const configured = capabilities?.capabilities?.[id];
  if (!configured) {
    throw new SingularityFlowError(
      `${CONFIGURATION_BRANCH} already exists on '${remote}' but does not define requested capability '${id}'. `
      + 'Propose the capability through the governed capability-map workflow instead of re-running bootstrap.');
  }
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
      `${CONFIGURATION_BRANCH} already defines capability '${id}', but its governed values differ from this bootstrap request. `
      + 'Inspect the approved capability map and propose changes through the capability-map workflow.');
  }
}

async function inspectApprovedConfiguration(remote, capability = null) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-inspect-'));
  try {
    const commit = await cloneConfiguration(remote, scratch);
    const capabilities = await loadCapabilities(scratch, { required: Boolean(capability) });
    assertRequestedCapability(capabilities, capability, remote);
    return { branch: CONFIGURATION_BRANCH, commit, created: false };
  } finally {
    await removeTemporaryTree(scratch);
  }
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
  publisherRoot = null, transport = {}, remoteSession = null, observedHead = null
} = {}) {
  const url = String(remote ?? '').trim();
  if (!url) throw new SingularityFlowError('A configuration repository URL is required.');
  const session = remoteSession ?? new GitRemoteSession();
  const configurationHead = observedHead ?? configurationBranchHead(url, { session });
  requireRemoteObservation(configurationHead.observation, 'configuration authority');
  if (configurationHead.exists) return await inspectApprovedConfiguration(url, capability);

  let canonicalPublisher = null;
  if (publisherRoot) {
    canonicalPublisher = await realpath(path.resolve(publisherRoot));
    const configuredRemote = run('git', ['remote', 'get-url', 'origin'], {
      cwd: canonicalPublisher, allowFailure: true
    }).stdout.trim();
    if (sanitizeRemote(configuredRemote) !== sanitizeRemote(url)) {
      throw new SingularityFlowError('The configuration publisher origin does not match the reviewed configuration remote.', {
        code: 'CONFIGURATION_PUBLISHER_REMOTE_MISMATCH'
      });
    }
    // A prior attempt may have retained its exact commit in this repository. Join it rather than
    // authoring another commit with a new timestamp and producing two recovery paths.
    const existing = (await listTransportIntents({
      ...transport, includeSucceeded: true
    })).find((intent) => intent.repositoryRoot === canonicalPublisher
      && intent.remoteUrl === sanitizeRemote(url)
      && intent.targetRef === `refs/heads/${CONFIGURATION_BRANCH}`
      && intent.status !== 'succeeded');
    if (existing) {
      const resumed = await retryTransportIntent(existing.intentId, transport);
      if (resumed.status !== 'succeeded') {
        throw new SingularityFlowError(
          `Configuration publication ${resumed.intentId} is ${resumed.status}; its exact local commit remains available for 'singularity-flow push status ${resumed.intentId}'.`,
          { code: 'CONFIGURATION_PUBLICATION_PENDING', details: { intentId: resumed.intentId, status: resumed.status } }
        );
      }
      return { ...(await inspectApprovedConfiguration(url, capability)), transportIntent: resumed.intentId };
    }
  }

  const remoteHead = session.observe(url, { includeHead: true });
  requireRemoteObservation(remoteHead, 'configuration repository');
  let defaultBranch = remoteHead.defaultBranch;
  if (!defaultBranch) {
    const advertised = session.observe(url, { includeHead: true, includeAllHeads: true });
    requireRemoteObservation(advertised, 'configuration repository');
    defaultBranch = advertised.defaultBranch
      ?? advertised.branches.find((item) => item === 'main' || item === 'master')
      ?? advertised.branches[0]
      ?? 'main';
  }
  const importBranch = String(sourceBranch ?? defaultBranch).trim() || defaultBranch;
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-bootstrap-'));
  const seed = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-seed-'));
  try {
    const clone = runRemoteGit([
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
      '--filter=blob:none', '--no-checkout', '--branch', importBranch, url, scratch
    ], { operation: 'remote-configuration' });
    if (clone.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read '${url}': ${(clone.stderr || clone.stdout).trim().split('\n')[0]}`);
    }
    const imported = await copyConfigurationAssetsFromRef(scratch, 'HEAD', seed);
    const importedCapabilityMap = imported.includes('singularity/capabilities.yml');
    run('git', ['switch', '--quiet', '--orphan', CONFIGURATION_BRANCH], { cwd: scratch });
    await clearScratchWorktree(scratch);
    await copyAssets(seed, scratch);
    const wrote = await initializeDefinition(scratch);
    if (wrote.includes('singularity/workflow.yml')) await setDefaultBaseBranch(scratch, defaultBranch);
    // The packaged map is an instructional placeholder. A new organisation does not have a map
    // until its first real capability is proposed; otherwise the first capability collides with a
    // fictional root. An existing map imported from the code branch is real configuration and is
    // retained.
    if (!importedCapabilityMap) await rm(path.join(scratch, 'singularity/capabilities.yml'), { force: true });
    const actor = gitCommitIdentity(scratch);
    await describeRepository(scratch, repositoryIdFromUrl(url), url, defaultBranch, actor);
    if (grounding) await setGroundingMode(scratch, grounding);
    if (capability) await describeCapability(scratch, capability);
    await enableLedger(scratch, 'state');
    run('git', ['add', '-A'], { cwd: scratch });
    run('git', [
      '-c', `user.name=${actor.name || 'Singularity Flow'}`,
      '-c', `user.email=${actor.email || 'unknown@invalid'}`,
      'commit', '-m', '[configuration] establish Singularity configuration authority'
    ], { cwd: scratch });
    const commit = run('git', ['rev-parse', 'HEAD'], { cwd: scratch }).stdout.trim();
    let push;
    let transportIntent = null;
    let transportStatus = null;
    if (canonicalPublisher) {
      const imported = run('git', ['fetch', '--no-tags', '--', scratch, commit], {
        cwd: canonicalPublisher, allowFailure: true
      });
      if (imported.status !== 0) {
        throw new SingularityFlowError('The reviewed configuration commit could not be retained in the publisher repository.');
      }
      const retentionRef = `refs/singularity/transport/configuration/${commit}`;
      run('git', ['update-ref', retentionRef, commit], { cwd: canonicalPublisher });
      const published = await createAndPushTransportIntent({
        repositoryRoot: canonicalPublisher,
        remote: 'origin',
        sourceCommit: commit,
        targetRef: `refs/heads/${CONFIGURATION_BRANCH}`,
        expectedRemote: null,
        scope: { operation: 'sflow.configuration.initialize', sourceBranch: importBranch }
      }, transport);
      transportIntent = published.intentId;
      transportStatus = published.status;
      push = published.status === 'succeeded'
        ? { status: 0, stdout: '', stderr: '' }
        : { status: 1, stdout: '', stderr: `transport ${published.intentId} is ${published.status}` };
    } else {
      push = runRemoteGit(['push', 'origin', `HEAD:refs/heads/${CONFIGURATION_BRANCH}`], {
        cwd: scratch, operation: 'remote-push'
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
      if (!remoteHasConfigurationBranch(url, { session, refresh: true })) {
        throw new SingularityFlowError(
          `Cannot create '${CONFIGURATION_BRANCH}' on '${url}': ${(push.stderr || push.stdout).trim().split('\n')[0]}`);
      }
      // Another bootstrap won the create race. It is success only when the winning authority
      // contains the exact capability this caller requested; branch existence alone proves nothing.
      return await inspectApprovedConfiguration(url, capability);
    }
    return {
      branch: CONFIGURATION_BRANCH, commit, created: true, importedFrom: importBranch,
      transportIntent
    };
  } finally {
    await removeTemporaryTree(scratch);
    await removeTemporaryTree(seed);
  }
}

async function cloneConfiguration(remote, target) {
  const clone = runRemoteGit([
    '-c', 'core.autocrlf=false', 'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
    '--filter=blob:none', '--branch', CONFIGURATION_BRANCH, remote, target
  ], { operation: 'remote-configuration' });
  if (clone.status !== 0) {
    throw new SingularityFlowError(
      `Cannot read approved configuration from '${remote}' branch '${CONFIGURATION_BRANCH}': `
      + `${(clone.stderr || clone.stdout).trim().split('\n')[0]}`);
  }
  return run('git', ['rev-parse', 'HEAD'], { cwd: target }).stdout.trim();
}

function remoteBranchHead(remote, branch, session = new GitRemoteSession()) {
  const observed = session.observe(remote, {
    includeHead: false, refs: [`refs/heads/${branch}`]
  });
  if (!observed.ok) return null;
  const sha = observed.refs.get(`refs/heads/${branch}`) ?? '';
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

async function copyVerifiedStateConfiguration(remote, destination, branch = STATE_CONFIGURATION_BRANCH) {
  const source = await mkdtemp(path.join(os.tmpdir(), 'sflow-state-config-read-'));
  try {
    const clone = runRemoteGit([
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
      '--filter=blob:none', '--no-checkout', '--branch', branch, remote, source
    ], { operation: 'remote-configuration' });
    if (clone.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read configuration recovery mirror from '${remote}' branch '${branch}': `
        + `${(clone.stderr || clone.stdout).trim().split('\n')[0]}`
      );
    }
    const mirrorCommit = run('git', ['rev-parse', 'HEAD'], { cwd: source }).stdout.trim();
    const manifestResult = run('git', ['show', `HEAD:${STATE_CONFIGURATION_MANIFEST}`], {
      cwd: source, allowFailure: true
    });
    if (manifestResult.status !== 0) {
      throw new SingularityFlowError(
        `State branch '${branch}' does not contain ${STATE_CONFIGURATION_MANIFEST}.`,
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
    const declared = Object.keys(manifest.files).sort();
    if (!declared.includes('singularity/workflow.yml') || declared.some((relative) =>
      !isConfigurationAsset(relative) || !/^[0-9a-f]{64}$/.test(manifest.files[relative] ?? ''))) {
      throw new SingularityFlowError('State configuration manifest contains an invalid or incomplete file set.', {
        code: 'STATE_CONFIGURATION_MIRROR_INVALID'
      });
    }
    const treeEntries = configurationTreeEntries(source, 'HEAD');
    const copied = await copyConfigurationAssetsFromRef(source, 'HEAD', destination);
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
    await loadDefinition(destination);
    return {
      remote, branch, mirrorCommit,
      sourceBranch: CONFIGURATION_BRANCH,
      sourceCommit: manifest.source.commit,
      files: manifest.files,
      assets: Object.fromEntries(copied.map((relative) => [relative, treeEntries.get(relative)]))
    };
  } finally {
    await removeTemporaryTree(source);
  }
}

export async function resolveRemoteStoryConfigurationAuthority(remote) {
  const url = String(remote ?? '').trim();
  if (!url) return null;
  const configurationCommit = remoteBranchHead(url, CONFIGURATION_BRANCH);
  if (configurationCommit) {
    return { remote: url, branch: CONFIGURATION_BRANCH, commit: configurationCommit, source: 'configuration' };
  }
  if (!remoteBranchHead(url, STATE_CONFIGURATION_BRANCH)) return null;
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-state-config-probe-'));
  try {
    const mirror = await copyVerifiedStateConfiguration(url, scratch);
    return {
      remote: url, branch: STATE_CONFIGURATION_BRANCH, commit: mirror.mirrorCommit,
      sourceCommit: mirror.sourceCommit, source: 'verified-state-mirror'
    };
  } finally {
    await removeTemporaryTree(scratch);
  }
}

async function activeWorkspaceForRepository(root) {
  const active = await readActiveWorkspaceContext(
    activeWorkspaceFile(), workspaceRegistryFile(), { refresh: false }
  ).catch(() => null);
  if (!active?.workspacePath) return null;
  const workspace = await readWorkspace(active.workspacePath).catch(() => null);
  if (!workspace) return null;
  const canonical = async (value) => realpath(value).catch(() => path.resolve(value));
  const repositoryRoot = await canonical(root);
  const memberRoots = await Promise.all(Object.values(workspace.repositories).map((repository) =>
    canonical(workspaceRepositoryPath(workspace, repository))));
  return memberRoots.includes(repositoryRoot) ? workspace : null;
}

/** Find a Story-readable authority in this repository or its active workspace lead. */
export async function resolveStoryConfigurationAuthority(root, remoteName = 'origin') {
  const workspace = await activeWorkspaceForRepository(root);
  // A capability-derived workspace records the organisation repository that actually owns
  // sflow/config. It is deliberately separate from the delivery repository chosen to hold
  // workspace/runtime state, so it must win over both the member's origin and the delivery lead.
  const configuredAuthority = workspace?.capabilityAuthority?.url;
  if (configuredAuthority) return resolveRemoteStoryConfigurationAuthority(configuredAuthority);

  const own = run('git', ['remote', 'get-url', remoteName], { cwd: root, allowFailure: true }).stdout.trim();
  const ownAuthority = own ? await resolveRemoteStoryConfigurationAuthority(own) : null;
  if (ownAuthority) return ownAuthority;

  const lead = workspace?.repositories?.[workspace.leadRepository]?.url;
  return lead ? resolveRemoteStoryConfigurationAuthority(lead) : null;
}

/** Load one Story authority as a complete disposable definition without touching the checkout. */
export async function loadStoryConfigurationDefinition(authority) {
  return (await loadStoryConfigurationSnapshot(authority)).definition;
}

/**
 * Read and verify one exact approved configuration revision once for the complete Story-start
 * operation. The bounded configuration payload is retained in memory after the disposable clone
 * is removed, so validation and later branch materialization cannot perform two network clones or
 * observe two different authority revisions.
 */
export async function loadStoryConfigurationSnapshot(authority) {
  if (!authority?.remote || !authority?.branch) {
    throw new SingularityFlowError('A Story configuration definition requires a resolved authority.');
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-config-read-'));
  incrementCommandCounter('configuration.snapshot-read');
  try {
    let observedCommit;
    let sourceCommit;
    let mirror = null;
    if (authority.branch === STATE_CONFIGURATION_BRANCH) {
      mirror = await copyVerifiedStateConfiguration(authority.remote, scratch, authority.branch);
      observedCommit = mirror.mirrorCommit;
      sourceCommit = mirror.sourceCommit;
      if (authority.sourceCommit && mirror.sourceCommit !== authority.sourceCommit) {
        throw new SingularityFlowError(
          `Approved configuration source moved from ${authority.sourceCommit.slice(0, 12)} to ${mirror.sourceCommit.slice(0, 12)} while Story intake was being prepared. Refresh and retry; nothing was changed.`,
          { code: 'STORY_CONFIGURATION_AUTHORITY_STALE' }
        );
      }
    } else {
      observedCommit = await cloneConfiguration(authority.remote, scratch);
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
    const definition = await loadDefinition(scratch);
    const assets = [];
    const treeEntries = mirror?.assets
      ? new Map(Object.entries(mirror.assets))
      : configurationTreeEntries(scratch, 'HEAD');
    for (const relative of await configurationAssetPaths(scratch)) {
      const file = path.join(scratch, relative);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new SingularityFlowError(`Configuration asset must be a regular file: ${relative}`);
      }
      const contents = Buffer.from(await readFile(file));
      const treeEntry = treeEntries.get(relative);
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
      throw new SingularityFlowError(
        `${CONFIGURATION_BRANCH}@${sourceCommit.slice(0, 12)} does not contain singularity/workflow.yml.`);
    }
    return Object.freeze({
      [STORY_CONFIGURATION_SNAPSHOT]: true,
      authority: Object.freeze({ ...authority }),
      observedCommit,
      sourceCommit,
      mirror: mirror ? Object.freeze({ branch: mirror.branch, commit: mirror.mirrorCommit }) : null,
      definition,
      assets: Object.freeze(assets)
    });
  } finally {
    await removeTemporaryTree(scratch);
  }
}

async function copyStoryConfigurationSnapshot(snapshot, destination) {
  if (!snapshot?.[STORY_CONFIGURATION_SNAPSHOT]) {
    throw new SingularityFlowError('Story configuration materialization requires a verified snapshot.');
  }
  const copied = [];
  for (const entry of snapshot.assets) {
    if (createHash('sha256').update(entry.contents).digest('hex') !== entry.sha256) {
      throw new SingularityFlowError(
        `Verified Story configuration snapshot changed in memory: ${entry.relative}.`,
        { code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID' }
      );
    }
    const target = path.join(destination, entry.relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.contents);
    await chmod(target, entry.mode);
    copied.push(entry.relative);
  }
  return copied.sort();
}

/** Find the organisation configuration for a repository inside or outside a managed workspace. */
export async function resolveConfigurationRemote(root, remoteName = 'origin') {
  const workspace = await activeWorkspaceForRepository(root);
  const configuredAuthority = workspace?.capabilityAuthority?.url;
  if (configuredAuthority) {
    return remoteHasConfigurationBranch(configuredAuthority) ? configuredAuthority : null;
  }

  const own = run('git', ['remote', 'get-url', remoteName], { cwd: root, allowFailure: true }).stdout.trim();
  if (own && remoteHasConfigurationBranch(own)) return own;

  if (workspace) {
    // A machine-wide active workspace is navigation context, not authority for every repository
    // on the machine. activeWorkspaceForRepository already proved membership before this fallback.
    const lead = workspace?.repositories?.[workspace.leadRepository]?.url;
    if (lead && remoteHasConfigurationBranch(lead)) return lead;
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
  if (!verifiedSnapshot?.[STORY_CONFIGURATION_SNAPSHOT]
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
  {
    const baseCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
    const before = configurationTreeEntries(root, baseCommit);
    const removed = await clearConfigurationAssets(root);
    const files = await copyStoryConfigurationSnapshot(verifiedSnapshot, root);
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
export async function resolveApprovedConfigurationCapability(remote, capabilityId) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-capability-'));
  try {
    const authority = typeof remote === 'string'
      ? await resolveRemoteStoryConfigurationAuthority(remote)
      : remote;
    if (!authority) throw new SingularityFlowError('No Story-readable configuration authority is available.');
    const materialized = authority.branch === STATE_CONFIGURATION_BRANCH
      ? await copyVerifiedStateConfiguration(authority.remote, scratch, authority.branch)
      : { sourceCommit: await cloneConfiguration(authority.remote, scratch) };
    const { resolveLifecycleCapability } = await import('./capability-context.mjs');
    const capability = await resolveLifecycleCapability(scratch, {
      capabilityId,
      required: true,
      offline: true
    });
    return {
      branch: authority.branch,
      commit: materialized.sourceCommit,
      mirrorCommit: materialized.mirrorCommit ?? null,
      capability
    };
  } finally {
    await removeTemporaryTree(scratch);
  }
}

/** Resolve a capability from an already-verified operation snapshot without another clone. */
export async function resolveStoryConfigurationSnapshotCapability(snapshot, capabilityId) {
  if (!snapshot?.[STORY_CONFIGURATION_SNAPSHOT]) {
    throw new SingularityFlowError('Capability resolution requires a verified Story configuration snapshot.');
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-capability-snapshot-'));
  try {
    await copyStoryConfigurationSnapshot(snapshot, scratch);
    const { resolveLifecycleCapability } = await import('./capability-context.mjs');
    const capability = await resolveLifecycleCapability(scratch, {
      capabilityId,
      required: true,
      offline: true
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
  for (const [relative, descriptor] of Object.entries(assetEntries)) {
    const expected = descriptor?.sha256 ?? record.files?.[relative];
    if (!isConfigurationAsset(relative) || !/^[0-9a-f]{64}$/.test(expected)) {
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
  for (const [relative, descriptor] of Object.entries(record.removed ?? {})) {
    if (!isConfigurationAsset(relative)
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
