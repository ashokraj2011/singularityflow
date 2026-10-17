/** Reusable exact Git objects; fresh remote advertisements and disposable indexes remain mandatory. */
import path from 'node:path';
import { chmod, lstat, readdir } from 'node:fs/promises';
import { gitCommonDir } from './git.mjs';
import { acquireFileLease } from './file-lease.mjs';
import { ConfigurationObjectReader } from './configuration-object-reader.mjs';
import { remoteFingerprint } from './git-remote-diagnostics.mjs';
import { safePrivateSidecarDirectory, readPrivateSidecar } from './private-sidecar.mjs';
import { incrementCommandCounter } from './dx-timing-context.mjs';
import { run, SingularityFlowError } from './util.mjs';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAXIMUM_BYTES = 64 * 1024 * 1024;
const MAXIMUM_FILES = 8_192;
const privacy = { enforceWindowsAcl: true };

async function qualifiedTree(root) {
  let bytes = 0, files = 0;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++files > MAXIMUM_FILES) return false;
      const file = path.join(directory, entry.name);
      const metadata = await lstat(file);
      if (metadata.isSymbolicLink()) return false;
      if (metadata.isDirectory()) pending.push(file);
      else if (!metadata.isFile() || metadata.nlink !== 1 || (bytes += metadata.size) > MAXIMUM_BYTES) return false;
    }
  }
  return true;
}

async function qualifiedConfig(root, store) {
  const bytes = await readPrivateSidecar(root, path.join(store, 'config'), { ...privacy, maximumBytes: 4_096 });
  // A cached repo must never inject transports, includes, credential helpers, fsmonitor or hooks.
  // This is exactly the inert bare init shape, not arbitrary repository configuration.
  return /^\[core\]\n\trepositoryformatversion = [01]\n\tfilemode = (?:true|false)\n\tbare = true\n(?:\t(?:ignorecase|precomposeunicode|symlinks|longpaths) = (?:true|false)\n){0,4}(?:\[extensions\]\n\tobjectformat = sha256\n)?$/u
    .test(bytes.toString('utf8').replace(/\r\n/g, '\n'));
}

/**
 * Acquire one bounded private authority pool. Returns null before transport if cache admission is
 * unsupported/busy. No remote failure is retried through a second clone. The lease outlives the
 * disposable checkout and its alternate readers; no GC or pack removal occurs while borrowed.
 */
export async function prepareConfigurationObjectCheckout(root, scratch, {
  remote, transport, authorityCommit, branches = [], runRemoteCommand, env = process.env,
  completeObjects = false, independent = false
}) {
  if (env.SINGULARITY_FLOW_CONFIGURATION_OBJECT_STORE === 'off' || !OID.test(authorityCommit ?? '')
      || branches.length > 100 || branches.some(entry => !OID.test(entry.proposalCommit ?? ''))) return null;
  let local, store, lease;
  const git = (cwd, args, extra = {}) => run('git', args, { cwd, env: transport.env,
    timeoutMs: 15_000, maxBuffer: 4 * 1024 * 1024, ...extra });
  try {
    // Capability validation materializes ordinary worktrees. Its pool must contain complete
    // objects, never borrow missing blobs from the filtered workflow-reader pool implicitly.
    local = path.join(gitCommonDir(root), 'singularity-flow', completeObjects
      ? 'configuration-objects-complete-v1' : 'configuration-objects-v1');
    await safePrivateSidecarDirectory(root, local, { ...privacy, create: true });
    // Do not silently grow one pool for every repository URL encountered on a machine.
    const key = remoteFingerprint(remote);
    const allocation = await acquireFileLease(path.join(local, 'allocation.lock'), { waitMs: 250 });
    if (!allocation) return null;
    try {
      const authorities = (await readdir(local)).filter(name => /^[a-f0-9]{64}$/u.test(name));
      if (!authorities.includes(key) && authorities.length >= 8) return null;
      store = path.join(local, key);
      await safePrivateSidecarDirectory(root, store, { ...privacy, create: true });
      lease = await acquireFileLease(path.join(store, 'borrow.lock'), { waitMs: 250 });
    } finally { await allocation.release({ cleanupConfirmed: true }); }
    if (!lease) return null;
    const config = await lstat(path.join(store, 'config')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!config) {
      git(store, ['init', '--quiet', '--bare', '--template=', `--object-format=${authorityCommit.length === 64 ? 'sha256' : 'sha1'}`]);
      await chmod(path.join(store, 'config'), 0o600);
      // Windows applies/checks the protected DACL as a tree, not one icacls launch per object.
      await safePrivateSidecarDirectory(root, store, { ...privacy });
    }
    const configQualified = await qualifiedConfig(root, store);
    const treeQualified = await qualifiedTree(store);
    if (!configQualified || !treeQualified) {
      await lease.release({ cleanupConfirmed: true });
      incrementCommandCounter('configuration.object-store-declined');
      incrementCommandCounter(configQualified ? 'configuration.object-store-tree-declined' : 'configuration.object-store-config-declined');
      return null;
    }
  } catch (error) {
    if (error.temporaryGitCleanupUnproven) {
      await lease?.retainQuarantine({ unknownChildren: true }).catch(() => {});
      await lease?.release().catch(() => {});
      throw error;
    }
    await lease?.release({ cleanupConfirmed: true }).catch(() => {});
    incrementCommandCounter('configuration.object-store-declined');
    return null;
  }
  let exposed = false, transferStarted = false;
  const storeReader = new ConfigurationObjectReader(store, transport.remote, transport.env, runRemoteCommand);
  const download = async (args, options) => {
    transferStarted = true;
    const result = await runRemoteCommand(args, { ...options, cwd: store });
    if (result.status === 0) storeReader.seal();
    return result;
  };
  const includeCommits = async (commits) => {
    const checked = git(store, ['cat-file', '--batch-check'], { input: commits.join('\n') + '\n' }).stdout.trimEnd().split('\n');
    if (checked.length !== commits.length) throw new Error('Incomplete object pool presence proof');
    const missing = commits.filter((commit, index) => {
      if (checked[index] === `${commit} missing`) return true;
      if (!new RegExp(`^${commit} commit [0-9]+$`, 'u').test(checked[index])) throw new Error('Invalid object pool commit');
      return false;
    });
    if (missing.length) {
      const fetched = await download(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head',
        ...(completeObjects ? [] : ['--filter=blob:none']),
        '--recurse-submodules=no', '--', transport.remote, ...missing],
      { cwd: store, operation: 'remote-configuration', env: transport.env });
      if (fetched.status !== 0) throw new SingularityFlowError(fetched.failure?.advice ?? 'Configuration object transfer failed.', {
        code: fetched.failure?.code ?? 'WORKFLOW_PROPOSAL_AUTHORITY_UNAVAILABLE'
      });
      incrementCommandCounter('configuration.object-store-fetch');
    } else incrementCommandCounter('configuration.object-store-hit');
    if (!await qualifiedTree(store) || !await qualifiedConfig(root, store)) throw new SingularityFlowError(
      'The derived configuration object pool exceeded its safe storage profile.', { code: 'CONFIGURATION_OBJECT_STORE_UNSAFE' });
  };
  const includeBranches = async (entries) => {
    if (entries.length > 100 || entries.some(entry => !OID.test(entry.proposalCommit ?? '')
        || typeof entry.branch !== 'string' || !/^[^\s\0]+$/u.test(entry.branch))) {
      throw new SingularityFlowError('Configuration object pages require bounded, exact proposal refs.', {
        code: 'CONFIGURATION_OBJECT_STORE_UNSAFE'
      });
    }
    if (!entries.length) return;
    await includeCommits([...new Set(entries.map(entry => entry.proposalCommit))]);
    // One transaction per page, not two Git processes per retained proposal on Windows.
    git(store, ['update-ref', '--stdin'], { input: entries.map(entry =>
      `update refs/heads/${entry.branch} ${entry.proposalCommit}\n`).join('') });
    git(scratch, ['update-ref', '--stdin'], { input: entries.map(entry =>
      `update refs/remotes/origin/${entry.branch} ${entry.proposalCommit}\n`).join('') });
  };
  try {
    await includeCommits([...new Set([authorityCommit, ...branches.map(entry => entry.proposalCommit)])]);
    // Private refs are retention, never authority. Every checkout ref below is bound to this
    // invocation's fresh advertisement, including deletion/movement of a pending proposal.
    git(store, ['update-ref', 'refs/heads/sflow/config', authorityCommit]);
    git(store, ['symbolic-ref', 'HEAD', 'refs/heads/sflow/config']);
    for (const entry of branches) git(store, ['update-ref', `refs/heads/${entry.branch}`, entry.proposalCommit]);
    git(root, ['clone', '--quiet', '--shared', ...(independent
      ? ['--dissociate', '--single-branch', '--branch', 'sflow/config'] : []),
      '--no-checkout', '--', store, scratch]);
    exposed = true;
    git(scratch, ['remote', 'set-url', 'origin', transport.remote]);
    incrementCommandCounter('configuration.object-store-checkout');
    return { download, includeBranches, async release({ cleanupConfirmed = true } = {}) {
      // Scratch must already be removed. Retain an uncertain borrow rather than deleting/pruning
      // objects from beneath a child whose completion the caller could not prove.
      if (!cleanupConfirmed) await lease.retainQuarantine({ unknownChildren: true });
      return lease.release({ cleanupConfirmed });
    } };
  } catch (error) {
    if (error.temporaryGitCleanupUnproven) {
      await lease.retainQuarantine({ unknownChildren: true }).catch(() => {});
      await lease.release().catch(() => {});
    } else await lease.release({ cleanupConfirmed: true }).catch(() => {});
    // After transfer starts, never retry network work through a fallback path.
    if (exposed || transferStarted || error.temporaryGitCleanupUnproven) throw error;
    incrementCommandCounter('configuration.object-store-declined');
    return null;
  }
}
