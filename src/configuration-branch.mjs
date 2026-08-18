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
import { initializeDefinition } from './config.mjs';
import {
  describeCapability, describeRepository, enableLedger, repositoryIdFromUrl,
  setDefaultBaseBranch, setGroundingMode
} from './bootstrap.mjs';
import { loadCapabilities } from './capabilities.mjs';
import { identity } from './git.mjs';
import { activeWorkspaceFile, readActiveWorkspaceContext, workspaceRegistryFile } from './workspace-context.mjs';
import { readWorkspace, remoteDefaultBranch } from './workspace.mjs';
import { SingularityFlowError, run } from './util.mjs';

export const CONFIGURATION_BRANCH = 'sflow/config';
export const CONFIGURATION_SOURCE_PATH = 'singularity/configuration-source.json';

// These directories are lifecycle state or generated evidence, never shared configuration.
const RUNTIME_ROOTS = new Set([
  'initiatives', 'work-items', 'seeds', 'world-model', 'knowledge', 'pins',
  'identity-reservations', 'telemetry'
]);

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

async function copyAssets(source, destination) {
  const copied = [];
  for (const relative of await filesBelow(source)) {
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

async function clearScratchWorktree(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    await rm(path.join(root, entry.name), { recursive: true, force: true });
  }
}

export function remoteHasConfigurationBranch(remote) {
  const head = configurationBranchHead(remote);
  return head.reachable && head.exists;
}

/**
 * Read the exact configuration-authority tip without throwing away reachability diagnostics.
 * Callers that only need a boolean keep using `remoteHasConfigurationBranch`; organisation reads
 * use the SHA as their durable cache validator and distinguish a missing branch from an offline
 * remote so stale data is never presented as an empty organisation.
 */
export function configurationBranchHead(remote) {
  const result = run('git', ['ls-remote', '--heads', remote, `refs/heads/${CONFIGURATION_BRANCH}`], {
    allowFailure: true
  });
  const line = result.stdout.trim().split('\n').find(Boolean) ?? '';
  const sha = line.split(/\s+/)[0] || null;
  return {
    reachable: result.status === 0,
    exists: result.status === 0 && Boolean(sha),
    sha,
    error: result.status === 0 ? null : (result.stderr || result.stdout || 'remote did not answer').trim()
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
    await rm(scratch, { recursive: true, force: true });
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
export async function ensureConfigurationBranch(remote, { sourceBranch = null, capability = null, grounding = null } = {}) {
  const url = String(remote ?? '').trim();
  if (!url) throw new SingularityFlowError('A configuration repository URL is required.');
  if (remoteHasConfigurationBranch(url)) return await inspectApprovedConfiguration(url, capability);

  const defaultBranch = remoteDefaultBranch(
    url, run('git', ['ls-remote', '--symref', url, 'HEAD'], { allowFailure: true }).stdout
  );
  const importBranch = String(sourceBranch ?? defaultBranch).trim() || defaultBranch;
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-bootstrap-'));
  const seed = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-seed-'));
  try {
    const clone = run('git', [
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
      '--filter=blob:none', '--no-checkout', '--branch', importBranch, url, scratch
    ], { allowFailure: true });
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
    await describeRepository(
      scratch, repositoryIdFromUrl(url), url, defaultBranch, identity(scratch)
    );
    if (grounding) await setGroundingMode(scratch, grounding);
    if (capability) await describeCapability(scratch, capability);
    await enableLedger(scratch, 'state');
    run('git', ['add', '-A'], { cwd: scratch });
    const actor = identity(scratch);
    run('git', [
      '-c', `user.name=${actor.name || 'Singularity Flow'}`,
      '-c', `user.email=${actor.email || 'unknown@invalid'}`,
      'commit', '-m', '[configuration] establish Singularity configuration authority'
    ], { cwd: scratch });
    const commit = run('git', ['rev-parse', 'HEAD'], { cwd: scratch }).stdout.trim();
    const push = run('git', ['push', 'origin', `HEAD:refs/heads/${CONFIGURATION_BRANCH}`], {
      cwd: scratch, allowFailure: true
    });
    if (push.status !== 0) {
      if (!remoteHasConfigurationBranch(url)) {
        throw new SingularityFlowError(
          `Cannot create '${CONFIGURATION_BRANCH}' on '${url}': ${(push.stderr || push.stdout).trim().split('\n')[0]}`);
      }
      // Another bootstrap won the create race. It is success only when the winning authority
      // contains the exact capability this caller requested; branch existence alone proves nothing.
      return await inspectApprovedConfiguration(url, capability);
    }
    return { branch: CONFIGURATION_BRANCH, commit, created: true, importedFrom: importBranch };
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await rm(seed, { recursive: true, force: true });
  }
}

async function cloneConfiguration(remote, target) {
  const clone = run('git', [
    'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
    '--filter=blob:none', '--branch', CONFIGURATION_BRANCH, remote, target
  ], { allowFailure: true });
  if (clone.status !== 0) {
    throw new SingularityFlowError(
      `Cannot read approved configuration from '${remote}' branch '${CONFIGURATION_BRANCH}': `
      + `${(clone.stderr || clone.stdout).trim().split('\n')[0]}`);
  }
  return run('git', ['rev-parse', 'HEAD'], { cwd: target }).stdout.trim();
}

/** Find the organisation configuration for a repository inside or outside a managed workspace. */
export async function resolveConfigurationRemote(root, remoteName = 'origin') {
  const own = run('git', ['remote', 'get-url', remoteName], { cwd: root, allowFailure: true }).stdout.trim();
  if (own && remoteHasConfigurationBranch(own)) return own;

  const active = await readActiveWorkspaceContext(
    activeWorkspaceFile(), workspaceRegistryFile(), { refresh: false }
  ).catch(() => null);
  if (active?.workspacePath) {
    const workspace = await readWorkspace(active.workspacePath).catch(() => null);
    // A machine-wide active workspace is navigation context, not authority for every repository
    // on the machine. Without this membership check a standalone checkout could silently import
    // prompts, policies and publication settings from an unrelated workspace merely because that
    // workspace was selected last in VS Code.
    const canonical = async (value) => realpath(value).catch(() => path.resolve(value));
    const repositoryRoot = await canonical(root);
    const memberRoots = workspace
      ? await Promise.all(Object.values(workspace.repositories).map((repository) =>
        canonical(path.join(workspace.path, repository.path))))
      : [];
    if (!memberRoots.includes(repositoryRoot)) return null;
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
  remoteName = 'origin'
} = {}) {
  const sourceRemote = remote ?? await resolveConfigurationRemote(root, remoteName);
  if (!sourceRemote) return null;
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-materialize-'));
  try {
    const commit = await cloneConfiguration(sourceRemote, scratch);
    const removed = await clearConfigurationAssets(root);
    const files = await copyAssets(scratch, root);
    if (!files.includes('singularity/workflow.yml')) {
      throw new SingularityFlowError(
        `${CONFIGURATION_BRANCH}@${commit.slice(0, 12)} does not contain singularity/workflow.yml.`);
    }
    const hashes = {};
    for (const relative of files) {
      hashes[relative] = createHash('sha256').update(await readFile(path.join(root, relative))).digest('hex');
    }
    const record = {
      schemaVersion: 1,
      repository: sourceRemote,
      branch: CONFIGURATION_BRANCH,
      commit,
      materializedAt: new Date().toISOString(),
      files: Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)))
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
  } finally {
    await rm(scratch, { recursive: true, force: true });
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
  let record;
  try { record = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    throw new SingularityFlowError(`Cannot read ${CONFIGURATION_SOURCE_PATH}: ${error.message}`);
  }
  if (record?.schemaVersion !== 1 || record.branch !== CONFIGURATION_BRANCH
    || !/^[0-9a-f]{40}$/.test(record.commit ?? '') || !record.repository) {
    throw new SingularityFlowError(`${CONFIGURATION_SOURCE_PATH} is not a valid configuration provenance record.`);
  }
  for (const [relative, expected] of Object.entries(record.files ?? {})) {
    if (!isConfigurationAsset(relative) || !/^[0-9a-f]{64}$/.test(expected)) {
      throw new SingularityFlowError(`${CONFIGURATION_SOURCE_PATH} contains an invalid asset entry '${relative}'.`);
    }
    if (!verify) continue;
    const asset = path.join(root, relative);
    const assetInfo = await lstat(asset).catch(() => null);
    if (!assetInfo?.isFile() || assetInfo.isSymbolicLink()) {
      throw new SingularityFlowError(`Pinned configuration asset is missing or unsafe: ${relative}`);
    }
    const actual = createHash('sha256').update(await readFile(asset)).digest('hex');
    if (actual !== expected) {
      throw new SingularityFlowError(
        `Pinned configuration asset changed after materialization: ${relative}. Start from the approved configuration again.`);
    }
  }
  // Derived, never stored. The loop above compares each asset to a hash held in the very file it is
  // verifying, so editing an asset and repasting its hash passes — the record attests to itself.
  // This digest of the whole pinned set is what the Story's immutable resolution compares against,
  // and because it is computed rather than read, it cannot be edited alongside the map.
  const files = Object.entries(record.files ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const filesSha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return { ...structuredClone(record), filesSha256 };
}
