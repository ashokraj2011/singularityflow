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
import YAML from 'yaml';
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
import {
  GitRemoteSession, requireRemoteObservation, runRemoteGit, runRemoteGitAsync
} from './git-execution.mjs';
import {
  activeWorkspaceFile, workspaceMemberContextForRepository, workspaceRegistryFile
} from './workspace-context.mjs';
import { removeTemporaryTree, SingularityFlowError, run } from './util.mjs';
import {
  assertCredentialFreeRemote, frozenRemoteTransport, sanitizeRemote
} from './git-remote-diagnostics.mjs';
import {
  createAndPushTransportIntent, listTransportIntents, retryTransportIntent
} from './transport-intents.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { incrementCommandCounter } from './dx-command-timing.mjs';
import {
  configurationAssetPolicy, configurationAssetSearchRoots, DEFAULT_CONFIGURATION_ASSET_POLICY,
  isConfigurationAssetPath,
  mergeConfigurationAssetPolicies
} from './configuration-assets.mjs';
import { withConfigurationReadRoot } from './configuration-read-scope.mjs';

export const CONFIGURATION_BRANCH = 'sflow/config';
export const CONFIGURATION_SOURCE_PATH = 'singularity/configuration-source.json';
export const STATE_CONFIGURATION_BRANCH = 'state';
export const STATE_CONFIGURATION_MANIFEST = 'configuration/manifest.json';
export const STATE_CONFIGURATION_FORMAT = 'singularity-flow-configuration-mirror/v2';
export const STATE_CONFIGURATION_HISTORY_PREFIX = 'sflow/config-history';

const STORY_CONFIGURATION_SNAPSHOT = Symbol('story-configuration-snapshot');
const STORY_CONFIGURATION_AUTHORITY_SNAPSHOT = Symbol('story-configuration-authority-snapshot');

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
  const branch = stateConfigurationHistoryBranch(sourceCommit);
  const ref = `refs/heads/${branch}`;
  const available = run('git', ['rev-parse', '--verify', `${sourceCommit}^{commit}`], {
    cwd: root, env, allowFailure: true
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
  const observe = async () => {
    const result = await runRemoteGitAsync([
      'ls-remote', '--heads', '--', remote, ref
    ], { cwd: root, operation: 'remote-configuration', env });
    if (result.status !== 0) {
      throw new SingularityFlowError(
        'The remote configuration history ref could not be inspected before state publication.',
        {
          code: 'STATE_CONFIGURATION_HISTORY_UNAVAILABLE',
          details: { sourceCommit, branch, classification: result.failure?.classification ?? 'unknown' }
        }
      );
    }
    const rows = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const commits = rows.map((line) => line.split(/\s+/u))
      .filter(([, name]) => name === ref)
      .map(([commit]) => commit);
    if (commits.length > 1 || commits.some((commit) => !/^[0-9a-f]{40,64}$/.test(commit))) {
      throw new SingularityFlowError('The remote configuration history ref is ambiguous.', {
        code: 'STATE_CONFIGURATION_HISTORY_INVALID', details: { sourceCommit, branch }
      });
    }
    return commits[0] ?? null;
  };

  // The immutable namespace lets the ordinary path be one push instead of probe-then-push. The
  // empty lease makes an existing ref (whether exact or hostile) non-mutating; after rejection one
  // observation distinguishes an identical concurrent winner from a permanent collision.
  const pushed = await runRemoteGitAsync([
    'push', `--force-with-lease=${ref}:`, '--', remote, `${sourceCommit}:${ref}`
  ], { cwd: root, operation: 'remote-push', env });
  if (pushed.status !== 0) {
    const concurrent = await observe();
    if (concurrent !== sourceCommit) {
      throw new SingularityFlowError(
        concurrent == null
          ? 'The approved configuration history ref could not be retained before state publication.'
          : 'An immutable configuration history ref points at a different commit.',
        {
          code: concurrent == null
            ? 'STATE_CONFIGURATION_HISTORY_UNAVAILABLE'
            : 'STATE_CONFIGURATION_HISTORY_COLLISION',
          details: {
            sourceCommit, branch,
            classification: pushed.failure?.classification ?? 'unknown',
            actualCommit: concurrent
          }
        }
      );
    }
  }
  return Object.freeze({ branch, commit: sourceCommit });
}

function slash(value) { return value.split(path.sep).join('/'); }

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
    if (entry.isDirectory()) {
      const portable = slash(child);
      const containsExplicit = [...policy.roots, ...policy.files]
        .some((configured) => configured.startsWith(`${portable}/`));
      if (isConfigurationAsset(portable, policy) || containsExplicit) {
        await filesBelow(root, child, policy, output);
      }
    }
    else if (entry.isFile() && isConfigurationAsset(child, policy)) output.push(slash(child));
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
  env = process.env
} = {}) {
  const selectedPolicy = policy ?? configurationAssetPolicyFromRef(root, ref, { env });
  const listed = run('git', [
    'ls-tree', '-r', '-z', '--format=%(objectmode) %(objectname) %(path)', ref, '--',
    ...configurationAssetSearchRoots(selectedPolicy)
  ], { cwd: root, allowFailure: true, env });
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
  }).filter(([, entry]) => /^100(?:644|755)$/.test(entry.mode)
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
  const entries = listed.stdout.split('\0').filter(Boolean).map((line) => {
    const first = line.indexOf(' ');
    const second = line.indexOf(' ', first + 1);
    return {
      mode: line.slice(0, first),
      oid: line.slice(first + 1, second),
      file: line.slice(second + 1)
    };
  }).filter((entry) => /^100(?:644|755)$/.test(entry.mode)
    && isConfigurationAsset(entry.file, policy));
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
    const capabilities = await loadCapabilities(scratch, { required: Boolean(capability) });
    assertRequestedCapability(capabilities, capability, remote, options);
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
  sourceCommit = null, publisherRoot = null, transport = {}, remoteSession = null, observedHead = null,
  env = process.env
} = {}) {
  const url = String(remote ?? '').trim();
  if (!url) throw new SingularityFlowError('A configuration repository URL is required.');
  const frozen = frozenRemoteTransport(url, { push: true, env });
  const session = remoteSession ?? new GitRemoteSession({ env });
  const configurationHead = observedHead ?? configurationBranchHead(url, { session });
  requireRemoteObservation(configurationHead.observation, 'configuration authority');
  if (configurationHead.exists) return await inspectApprovedConfiguration(url, capability, { env });

  let canonicalPublisher = null;
  if (publisherRoot) {
    canonicalPublisher = await realpath(path.resolve(publisherRoot));
    const configuredRemote = run('git', ['remote', 'get-url', 'origin'], {
      cwd: canonicalPublisher, allowFailure: true
    }).stdout.trim();
    if (assertCredentialFreeRemote(configuredRemote) !== assertCredentialFreeRemote(url)) {
      throw new SingularityFlowError('The configuration publisher origin does not match the reviewed configuration remote.', {
        code: 'CONFIGURATION_PUBLISHER_REMOTE_MISMATCH'
      });
    }
    // A prior attempt may have retained its exact commit in this repository. Join it rather than
    // authoring another commit with a new timestamp and producing two recovery paths.
    const existing = (await listTransportIntents({
      ...transport, includeSucceeded: true
    })).find((intent) => intent.repositoryRoot === canonicalPublisher
      && intent.remoteUrl === assertCredentialFreeRemote(url)
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
      return { ...(await inspectApprovedConfiguration(url, capability, { env })), transportIntent: resumed.intentId };
    }
  }

  const remoteHead = configurationHead.observation?.includedHead
    ? configurationHead.observation
    : session.observe(url, { includeHead: true });
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
      '--filter=blob:none', '--no-checkout', '--branch', importBranch, frozen.remote, scratch
    ], { operation: 'remote-configuration', env: frozen.env });
    if (clone.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read '${url}': ${(clone.stderr || clone.stdout).trim().split('\n')[0]}`);
    }
    const importedCommit = run('git', ['rev-parse', 'HEAD'], {
      cwd: scratch, env: frozen.env
    }).stdout.trim();
    if (sourceCommit && importedCommit !== sourceCommit) {
      throw new SingularityFlowError(
        `The '${importBranch}' source branch changed after configuration preview. Preview the refresh again before creating '${CONFIGURATION_BRANCH}'.`,
        {
          code: 'CONFIGURATION_BOOTSTRAP_SOURCE_CHANGED',
          details: { expectedCommit: sourceCommit, actualCommit: importedCommit, branch: importBranch }
        }
      );
    }
    const imported = await copyConfigurationAssetsFromRef(scratch, 'HEAD', seed, {
      env: frozen.env
    });
    const importedCapabilityMap = imported.includes('singularity/capabilities.yml');
    run('git', ['switch', '--quiet', '--orphan', CONFIGURATION_BRANCH], {
      cwd: scratch, env: frozen.env
    });
    await clearScratchWorktree(scratch);
    await copyAssets(seed, scratch);
    const wrote = await initializeDefinition(scratch);
    if (wrote.includes('singularity/workflow.yml')) await setDefaultBaseBranch(scratch, defaultBranch);
    // The packaged map is an instructional placeholder. A new organisation does not have a map
    // until its first real capability is proposed; otherwise the first capability collides with a
    // fictional root. An existing map imported from the code branch is real configuration and is
    // retained.
    if (!importedCapabilityMap) await rm(path.join(scratch, 'singularity/capabilities.yml'), { force: true });
    const actor = gitCommitIdentity(scratch, { env: frozen.env });
    await describeRepository(scratch, repositoryIdFromUrl(url), url, defaultBranch, actor);
    if (grounding) await setGroundingMode(scratch, grounding);
    if (capability) await describeCapability(scratch, capability);
    await enableLedger(scratch, 'state');
    run('git', ['add', '-A'], { cwd: scratch, env: frozen.env });
    run('git', [
      '-c', `user.name=${actor.name || 'Singularity Flow'}`,
      '-c', `user.email=${actor.email || 'unknown@invalid'}`,
      'commit', '-m', '[configuration] establish Singularity configuration authority'
    ], { cwd: scratch, env: frozen.env });
    const commit = run('git', ['rev-parse', 'HEAD'], { cwd: scratch, env: frozen.env }).stdout.trim();
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
      if (!remoteHasConfigurationBranch(url, { session, refresh: true })) {
        throw new SingularityFlowError(
          `Cannot create '${CONFIGURATION_BRANCH}' on '${url}': ${(push.stderr || push.stdout).trim().split('\n')[0]}`);
      }
      // Another bootstrap won the create race. It is success only when the winning authority
      // contains the exact capability this caller requested; branch existence alone proves nothing.
      return await inspectApprovedConfiguration(url, capability, { exactBootstrap: true, env });
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
    await removeTemporaryTree(seed);
  }
}

async function cloneConfiguration(remote, target, { env = process.env } = {}) {
  const frozen = frozenRemoteTransport(remote, { env });
  const clone = runRemoteGit([
    '-c', 'core.autocrlf=false', 'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
    '--filter=blob:none', '--branch', CONFIGURATION_BRANCH, frozen.remote, target
  ], { operation: 'remote-configuration', env: frozen.env });
  if (clone.status !== 0) {
    throw new SingularityFlowError(
      `Cannot read approved configuration from '${remote}' branch '${CONFIGURATION_BRANCH}': `
      + `${(clone.stderr || clone.stdout).trim().split('\n')[0]}`);
  }
  return run('git', ['rev-parse', 'HEAD'], { cwd: target, env: frozen.env }).stdout.trim();
}

async function copyVerifiedStateConfiguration(remote, destination, branch = STATE_CONFIGURATION_BRANCH, {
  env = process.env,
  allowUnmarked = false,
  expectedCommit = null
} = {}) {
  const source = await mkdtemp(path.join(os.tmpdir(), 'sflow-state-config-read-'));
  try {
    const frozen = frozenRemoteTransport(remote, { env });
    const clone = runRemoteGit([
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
      '--filter=blob:none', '--no-checkout', '--branch', branch, frozen.remote, source
    ], { operation: 'remote-configuration', env: frozen.env });
    if (clone.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read configuration recovery mirror from '${remote}' branch '${branch}': `
        + `${(clone.stderr || clone.stdout).trim().split('\n')[0]}`
      );
    }
    const mirrorCommit = run('git', ['rev-parse', 'HEAD'], { cwd: source, env: frozen.env }).stdout.trim();
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
    return {
      remote, branch, mirrorCommit,
      sourceBranch: CONFIGURATION_BRANCH,
      sourceCommit: manifest.source.commit,
      history: manifest.history ?? null,
      files: manifest.files,
      assets: Object.fromEntries(copied.map((relative) => [relative, treeEntries.get(relative)])),
      definition
    };
  } finally {
    await removeTemporaryTree(source);
  }
}

function storyConfigurationAuthorityObservation(remote, {
  session = new GitRemoteSession()
} = {}) {
  const url = String(remote ?? '').trim();
  if (!url) return { url, configurationCommit: null, stateCommit: null, observation: null };
  const observed = session.observe(url, {
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
  const selected = storyConfigurationAuthorityObservation(remote, options);
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
      expectedCommit: stateCommit
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
      definition: mirror.definition
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
  const listed = run('git', ['remote'], { cwd: root, allowFailure: true });
  if (listed.status !== 0) {
    throw new SingularityFlowError(
      'Cannot enumerate configured Git remotes while resolving Story configuration authority.',
      { code: 'STORY_CONFIGURATION_AUTHORITY_UNAVAILABLE' }
    );
  }
  const remotes = listed.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (!remotes.includes(remoteName)) return { configured: false, url: null };
  // `git remote get-url NAME` prints NAME itself when a remote section exists without a URL. Read
  // the underlying setting first so that Git's fallback cannot be mistaken for a usable authority.
  const configured = run('git', ['config', '--get-all', `remote.${remoteName}.url`], {
    cwd: root, allowFailure: true
  });
  if (configured.status !== 0 || !configured.stdout.trim()) {
    throw new SingularityFlowError(
      `Configured Story authority remote '${remoteName}' has no readable fetch URL.`,
      { code: 'STORY_CONFIGURATION_AUTHORITY_UNAVAILABLE' }
    );
  }
  const resolved = run('git', ['remote', 'get-url', remoteName], {
    cwd: root, allowFailure: true
  });
  if (resolved.status === 0 && resolved.stdout.trim()) {
    return { configured: true, url: resolved.stdout.trim() };
  }
  throw new SingularityFlowError(
    `Configured Story authority remote '${remoteName}' has no readable fetch URL.`,
    { code: 'STORY_CONFIGURATION_AUTHORITY_UNAVAILABLE' }
  );
}

/** Find a Story-readable authority in this repository or its active workspace lead. */
export async function resolveStoryConfigurationAuthority(root, remoteName = 'origin', {
  session = new GitRemoteSession()
} = {}) {
  const workspace = await activeWorkspaceForRepository(root);
  // A capability-derived workspace records the organisation repository that actually owns
  // sflow/config. It is deliberately separate from the delivery repository chosen to hold
  // workspace/runtime state, so it must win over both the member's origin and the delivery lead.
  const configuredAuthority = workspace?.capabilityAuthority?.url;
  if (configuredAuthority) {
    return resolveRemoteStoryConfigurationAuthority(configuredAuthority, { session });
  }

  const own = configuredStoryRemote(root, remoteName);
  // Candidate order is authority precedence. A failed higher-priority observation must throw and
  // may never be converted to absence merely because a lower-priority lead happens to answer.
  const ownAuthority = own.url
    ? await resolveRemoteStoryConfigurationAuthority(own.url, { session })
    : null;
  if (ownAuthority) return ownAuthority;

  const lead = workspace?.repositories?.[workspace.leadRepository]?.url;
  return lead ? resolveRemoteStoryConfigurationAuthority(lead, { session }) : null;
}

/**
 * Resolve authority for genuinely new work without trusting the workflow checked out by an older
 * Story to name today's Git remote. The caller may supply a repository URL only after proving it is
 * carried by an immutable, branch-bound configuration pin.
 */
export async function resolveNewStoryConfigurationAuthority(root, {
  pinnedRemote = null,
  session = new GitRemoteSession()
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

async function storyConfigurationSnapshotFromDirectory(authority, scratch, {
  observedCommit,
  sourceCommit,
  mirror = null,
  definition: retainedDefinition = null
}) {
  const definition = retainedDefinition ?? await loadDefinition(scratch);
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
  const retained = authority[STORY_CONFIGURATION_AUTHORITY_SNAPSHOT];
  if (retained) {
    if (retained.authority.remote !== authority.remote
        || retained.authority.branch !== authority.branch
        || (authority.commit && retained.observedCommit !== authority.commit)
        || (authority.sourceCommit && retained.sourceCommit !== authority.sourceCommit)) {
      throw new SingularityFlowError(
        'Retained Story configuration snapshot does not match its selected authority.',
        { code: 'STORY_CONFIGURATION_AUTHORITY_STALE' }
      );
    }
    incrementCommandCounter('configuration.snapshot-reused');
    return retained;
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
    return await storyConfigurationSnapshotFromDirectory(authority, scratch, {
      observedCommit,
      sourceCommit,
      mirror,
      definition: mirror?.definition ?? null
    });
  } finally {
    await removeTemporaryTree(scratch);
  }
}

async function copyStoryConfigurationSnapshot(snapshot, destination, { selectPaths = null } = {}) {
  if (!snapshot?.[STORY_CONFIGURATION_SNAPSHOT]) {
    throw new SingularityFlowError('Story configuration materialization requires a verified snapshot.');
  }
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
  const copied = [];
  for (const entry of snapshot.assets) {
    if (selected && !selected.has(entry.relative)) continue;
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

/**
 * Mount one already-verified Story configuration snapshot for a read-only operation.
 *
 * This is deliberately separate from `materializeConfigurationSnapshot`: diagnostics must be able
 * to inspect the authority selected by Story-start precedence without writing configuration into
 * the application checkout. The snapshot's retained bytes are copied once to a private directory,
 * then the ordinary configuration readers are redirected there for the callback only.
 */
export async function withStoryConfigurationSnapshotRead(root, snapshot, fn, { selectPaths = null } = {}) {
  if (!snapshot?.[STORY_CONFIGURATION_SNAPSHOT]) {
    throw new SingularityFlowError(
      'Approved configuration diagnosis requires a verified Story configuration snapshot.'
    );
  }
  const yamlFromSnapshot = (relative) => {
    const entry = snapshot.assets.find((candidate) => candidate.relative === relative);
    if (!entry) return {};
    if (createHash('sha256').update(entry.contents).digest('hex') !== entry.sha256) {
      throw new SingularityFlowError(
        `Verified Story configuration snapshot changed in memory: ${relative}.`,
        { code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID' }
      );
    }
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
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-config-read-overlay-'));
  try {
    await copyStoryConfigurationSnapshot(snapshot, scratch, { selectPaths });
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
  session = new GitRemoteSession()
} = {}) {
  const workspace = await activeWorkspaceForRepository(root);
  const resolveCandidate = (remote, label) => {
    const selected = configurationBranchHead(remote, { session });
    requireRemoteObservation(selected.observation, label);
    return selected.exists ? remote : null;
  };
  const configuredAuthority = workspace?.capabilityAuthority?.url;
  if (configuredAuthority) {
    return resolveCandidate(configuredAuthority, 'workspace capability authority');
  }

  const own = run('git', ['remote', 'get-url', remoteName], { cwd: root, allowFailure: true }).stdout.trim();
  if (own) {
    const selected = resolveCandidate(own, `repository remote '${remoteName}'`);
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
  const authority = typeof remote === 'string'
    ? await resolveRemoteStoryConfigurationAuthority(remote)
    : remote;
  if (!authority) throw new SingularityFlowError('No Story-readable configuration authority is available.');
  const snapshot = await loadStoryConfigurationSnapshot(authority);
  return resolveStoryConfigurationSnapshotCapability(snapshot, capabilityId);
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
