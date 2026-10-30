/** Reusable exact Git objects; fresh remote advertisements and disposable indexes remain mandatory. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, readdir, rename, rm } from 'node:fs/promises';
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
// Authority pools kept per repository. A new remote evicts the least recently borrowed idle pool.
const MAXIMUM_AUTHORITIES = 8;
const AUTHORITY = /^[a-f0-9]{64}$/u;
const EVICTED = /^\.evicted-[a-f0-9]{64}-[a-f0-9-]{36}$/u;
const privacy = { enforceWindowsAcl: true };

function recordStorageDecline(error) {
  incrementCommandCounter('configuration.object-store-declined');
  const reason = error?.code === 'MCP_AUTH_WINDOWS_ACL_FAILED' ? 'acl-unavailable'
    : error?.code === 'MCP_AUTH_WINDOWS_ACL_UNSAFE' ? 'acl-unsafe'
      : error?.code === 'PRIVATE_SIDECAR_PATH_UNSAFE' ? 'path-unsafe'
        : ['EACCES', 'EPERM'].includes(error?.code) ? 'access' : 'storage-error';
  // Closed categories only: never put exception messages, filenames or remote URLs in metrics.
  incrementCommandCounter(`configuration.object-store-declined.${reason}`);
}

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

/**
 * Make room for a new authority: remove the least recently borrowed pools nobody holds, oldest
 * first, until `needed` are gone. The caller holds the allocation lease and every borrow is taken
 * under it, so a pool whose borrow lease we can acquire is idle and cannot gain a borrower before it
 * is removed. That lease is released before the move (Windows cannot rename a directory with an
 * open file inside). A borrowed or quarantined pool (an unproven cleanup) refuses the lease and is
 * kept. Each borrow adds and removes the pool's borrow.lock, so the directory's modification time
 * is its last use. Returns how many pools were removed.
 */
async function evictIdleAuthorities(local, authorities, needed) {
  // An earlier eviction's leftover directory never counts as a pool; finish removing it.
  for (const name of (await readdir(local)).filter(name => EVICTED.test(name))) {
    await rm(path.join(local, name), { recursive: true, force: true }).catch(() => {});
  }
  const used = await Promise.all(authorities.map(async name => {
    const info = await lstat(path.join(local, name)).catch(() => null);
    return info?.isDirectory() && !info.isSymbolicLink() ? { name, at: info.mtimeMs } : null;
  }));
  let removed = 0;
  for (const { name } of used.filter(Boolean).sort((a, b) => a.at - b.at || a.name.localeCompare(b.name))) {
    if (removed >= needed) break;
    const pool = path.join(local, name);
    const idle = await acquireFileLease(path.join(pool, 'borrow.lock'), { waitMs: 0 }).catch(() => null);
    if (!idle) continue;
    await idle.release({ cleanupConfirmed: true }).catch(() => {});
    const retired = path.join(local, `.evicted-${name}-${randomUUID()}`);
    try { await rename(pool, retired); } catch { continue; }
    await rm(retired, { recursive: true, force: true }).catch(() => {});
    incrementCommandCounter('configuration.object-store-evicted');
    removed += 1;
  }
  return removed;
}

function inertConfig(bytes) {
  // A cached repo must never inject transports, includes, credential helpers, fsmonitor or hooks.
  // This is exactly the inert bare init shape, not arbitrary repository configuration.
  return /^\[core\]\n\trepositoryformatversion = [01]\n\tfilemode = (?:true|false)\n\tbare = true\n(?:\t(?:ignorecase|precomposeunicode|symlinks|longpaths) = (?:true|false)\n){0,4}(?:\[extensions\]\n\tobjectformat = sha256\n)?$/u
    .test(bytes.toString('utf8').replace(/\r\n/g, '\n'));
}

async function qualifiedConfig(root, store) {
  return inertConfig(await readPrivateSidecar(root, path.join(store, 'config'), { ...privacy, maximumBytes: 4_096 }));
}

/**
 * Acquire one bounded private authority pool. Returns null before transport if cache admission is
 * unsupported/busy. No remote failure is retried through a second clone. The lease outlives the
 * disposable checkout and its alternate readers; no GC or pack removal occurs while borrowed.
 *
 * `checkout: false` is for a read that needs only exact objects (proposal listing and inspection,
 * SDA-AC-013): no `scratch` is cloned, the pool's own `store` is returned to read from directly,
 * and `refs/heads/<branch>` there names each included proposal for as long as the lease is held.
 * `includeFiles(commit, paths)` then makes those files' blobs readable in place (a blobless pool
 * holds commits and trees only).
 */
export async function prepareConfigurationObjectCheckout(root, scratch, {
  remote, transport, authorityCommit, branches = [], runRemoteCommand, env = process.env,
  completeObjects = false, independent = false, checkout = true
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
      const authorities = (await readdir(local)).filter(name => AUTHORITY.test(name));
      const needed = authorities.includes(key) ? 0 : authorities.length - MAXIMUM_AUTHORITIES + 1;
      if (needed > 0 && await evictIdleAuthorities(local, authorities, needed) < needed) return null;
      store = path.join(local, key);
      await safePrivateSidecarDirectory(root, store, { ...privacy, create: true });
      lease = await acquireFileLease(path.join(store, 'borrow.lock'), { waitMs: 250 });
    } finally { await allocation.release({ cleanupConfirmed: true }); }
    if (!lease) return null;
    const config = await lstat(path.join(store, 'config')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!config) {
      git(store, ['init', '--quiet', '--bare', '--template=', `--object-format=${authorityCommit.length === 64 ? 'sha256' : 'sha1'}`]);
      // Local-clone internals open this repository independently of the caller's command config.
      // Keep the private pool portable even when its retained proposal ref exceeds MAX_PATH.
      if (process.platform === 'win32') git(store, ['config', 'core.longpaths', 'true']);
      await chmod(path.join(store, 'config'), 0o600);
      // Windows applies/checks the protected DACL as a tree, not one icacls launch per object.
      // Git-created files inherit an owner-only ACL but are not themselves protected. The strict
      // private config reader requires protection too. Apply it only to this newly initialized
      // pool; existing pools must still pass read-only qualification, never an implicit ACL repair.
      if (process.platform === 'win32') {
        const { secureWindowsAuthAcl } = await import('./mcp-auth-profile.mjs');
        await secureWindowsAuthAcl(store, { directory: true, recursive: true, apply: true });
      }
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
    recordStorageDecline(error);
    return null;
  }
  let exposed = false, transferStarted = false;
  const storeReader = new ConfigurationObjectReader(store, transport.remote, transport.env, runRemoteCommand);
  const download = async (args, options) => {
    const configBefore = process.platform === 'win32' ? await lstat(path.join(store, 'config'), { bigint: true }) : null;
    transferStarted = true;
    const result = await runRemoteCommand(args, { ...options, cwd: store });
    if (result.status === 0) {
      storeReader.seal();
      if (configBefore) {
        const after = await lstat(path.join(store, 'config'), { bigint: true });
        if (!after.ino || after.ino !== configBefore.ino || after.dev !== configBefore.dev) {
          // Filtered fetch/seal replaces config through Git's config.lock, dropping the old
          // file's protected DACL. Only our successful Git operation may qualify this replacement:
          // first prove bounded inert bytes and a unique regular inode, then restore protection.
          // Never run this repair for a pre-existing/unqualified pool or failed transfer.
          const bytes = await readPrivateSidecar(root, path.join(store, 'config'), { maximumBytes: 4_096 });
          if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || !inertConfig(bytes)) {
            throw new SingularityFlowError('Git produced an unsafe configuration pool replacement.', { code: 'CONFIGURATION_OBJECT_STORE_UNSAFE' });
          }
          const { secureWindowsAuthAcl } = await import('./mcp-auth-profile.mjs');
          await secureWindowsAuthAcl(path.join(store, 'config'), { directory: false, apply: true });
        }
      }
    }
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
      if (fetched.status !== 0) {
        const error = new SingularityFlowError(fetched.failure?.advice ?? 'Configuration object transfer failed.', {
          code: fetched.failure?.code ?? 'WORKFLOW_PROPOSAL_AUTHORITY_UNAVAILABLE'
        });
        // The transfer's own result, so a caller reports it exactly as it reports a failed clone:
        // classified diagnosis and a doctor route. Not enumerable: raw output never reaches JSON.
        Object.defineProperty(error, 'remoteResult', { value: fetched });
        throw error;
      }
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
    if (checkout) git(scratch, ['update-ref', '--stdin'], { input: entries.map(entry =>
      `update refs/remotes/origin/${entry.branch} ${entry.proposalCommit}\n`).join('') });
  };
  try {
    await includeCommits([...new Set([authorityCommit, ...branches.map(entry => entry.proposalCommit)])]);
    // Private refs are retention, never authority. Every checkout ref below is bound to this
    // invocation's fresh advertisement, including deletion/movement of a pending proposal.
    git(store, ['update-ref', 'refs/heads/sflow/config', authorityCommit]);
    git(store, ['symbolic-ref', 'HEAD', 'refs/heads/sflow/config']);
    for (const entry of branches) git(store, ['update-ref', `refs/heads/${entry.branch}`, entry.proposalCommit]);
    // Git for Windows' local-clone ref iterator can reject a deep loose ref even though update-ref
    // created it successfully with longpaths enabled. Compact only our leased, bounded private
    // retention refs; application refs, objects, hooks and remote authority are untouched.
    if (process.platform === 'win32') git(store, ['pack-refs', '--all', '--prune']);
    const release = async ({ cleanupConfirmed = true } = {}) => {
      // Scratch must already be removed. Retain an uncertain borrow rather than deleting/pruning
      // objects from beneath a child whose completion the caller could not prove.
      if (!cleanupConfirmed) await lease.retainQuarantine({ unknownChildren: true });
      return lease.release({ cleanupConfirmed });
    };
    if (!checkout) {
      const includeFiles = async (commit, paths) => {
        const blobs = git(store, ['ls-tree', '-z', commit, '--', ...paths]).stdout.split('\0')
          .map(row => /^\d{6} blob ([a-f0-9]{40}|[a-f0-9]{64})\t/u.exec(row)?.[1]).filter(Boolean);
        if (blobs.length) await new ConfigurationObjectReader(store, transport.remote, transport.env, download)
          .hydrate(blobs.map(oid => ({ oid })));
      };
      incrementCommandCounter('configuration.object-store-read');
      return { store, download, includeBranches, includeFiles, release };
    }
    git(root, ['clone', '--quiet', '--shared', ...(independent
      ? ['--dissociate', '--single-branch', '--branch', 'sflow/config'] : []),
      '--no-checkout', '--', store, scratch]);
    exposed = true;
    git(scratch, ['remote', 'set-url', 'origin', transport.remote]);
    incrementCommandCounter('configuration.object-store-checkout');
    return { download, includeBranches, release };
  } catch (error) {
    if (error.temporaryGitCleanupUnproven) {
      await lease.retainQuarantine({ unknownChildren: true }).catch(() => {});
      await lease.release().catch(() => {});
    } else await lease.release({ cleanupConfirmed: true }).catch(() => {});
    // After transfer starts, never retry network work through a fallback path.
    if (exposed || transferStarted || error.temporaryGitCleanupUnproven) throw error;
    recordStorageDecline(error);
    return null;
  }
}
