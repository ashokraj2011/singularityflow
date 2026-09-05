/** Read the locally fetched, approved `sflow/config` commit without changing the checkout. */
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import {
  configurationReadScope, isConfigurationReadPath, withConfigurationReadRoot
} from './configuration-read-scope.mjs';
import {
  configurationAssetPolicy, configurationAssetSearchRoots
} from './configuration-assets.mjs';
import {
  configuredRemoteIdentity, frozenRemoteTransport
} from './git-remote-diagnostics.mjs';
import { removeTemporaryTree, run, SingularityFlowError } from './util.mjs';
import { runRemoteGitAsync } from './git-execution.mjs';

const WORKFLOW_PATH = 'singularity/workflow.yml';
const CONFIGURATION_BRANCH = 'sflow/config';
const STATE_BRANCH = 'state';
const STATE_MANIFEST = 'configuration/manifest.json';
const STATE_FORMAT = 'singularity-flow-configuration-mirror/v2';
const STATE_CONFIGURATION_HISTORY_PREFIX = 'sflow/config-history';
const MAX_FILES = 10_000;
const MAX_BYTES = 128 * 1024 * 1024;

function stateConfigurationHistoryBranch(sourceCommit) {
  const commit = String(sourceCommit ?? '').trim();
  return /^[0-9a-f]{40,64}$/.test(commit)
    ? `${STATE_CONFIGURATION_HISTORY_PREFIX}/${commit}`
    : null;
}

async function withExistingConfigurationRead(root, scope, fn, { selectPaths = null } = {}) {
  if (selectPaths == null) return fn(scope.authority);
  const selected = [...new Set(selectPaths)].sort();
  if (!selected.includes(WORKFLOW_PATH)
      || selected.some((relative) => !isConfigurationReadPath(relative, scope.assetPolicy))) {
    throw new SingularityFlowError('Approved configuration selection contains an unsupported path.', {
      code: 'APPROVED_CONFIGURATION_SELECTION_INVALID'
    });
  }
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-approved-config-narrow-read-'));
  try {
    for (const relative of selected) {
      const source = path.join(scope.configurationRoot, relative);
      const info = await lstat(source).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
      if (!info?.isFile() || info.isSymbolicLink()) {
        throw new SingularityFlowError(
          `Approved configuration ${scope.authority?.ref ?? 'scope'} does not contain '${relative}'.`,
          { code: 'APPROVED_CONFIGURATION_INCOMPLETE', details: { missing: [relative] } }
        );
      }
      const target = path.join(temporaryRoot, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await readFile(source));
      await chmod(target, info.mode & 0o111 ? 0o755 : 0o644);
    }
    return await withConfigurationReadRoot(
      root, temporaryRoot, scope.authority, () => fn(scope.authority),
      { assetPolicy: scope.assetPolicy }
    );
  } finally {
    await removeTemporaryTree(temporaryRoot);
  }
}

function yamlAtCommit(root, commit, relative) {
  const shown = run('git', ['show', `${commit}:${relative}`], { cwd: root, allowFailure: true });
  if (shown.status !== 0) return {};
  return YAML.parse(shown.stdout) ?? {};
}

function assetPolicyAtCommit(root, commit) {
  return configurationAssetPolicy(
    yamlAtCommit(root, commit, WORKFLOW_PATH),
    yamlAtCommit(root, commit, 'singularity/portfolio.yml')
  );
}

function configurationAuthorityAtRef(root, ref) {
  const commit = run('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: root, allowFailure: true
  }).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) return null;
  if (ref.endsWith(`/${CONFIGURATION_BRANCH}`)
      || ref === `refs/heads/${CONFIGURATION_BRANCH}`) {
    const workflow = run('git', ['cat-file', '-e', `${commit}:${WORKFLOW_PATH}`], {
      cwd: root, allowFailure: true
    });
    return workflow.status === 0
      ? {
          kind: 'approved-configuration-ref', ref, commit,
          remote: remoteIdentityForAuthorityRef(root, ref)
        }
      : null;
  }
  if (!(ref.endsWith(`/${STATE_BRANCH}`) || ref === `refs/heads/${STATE_BRANCH}`)) return null;
  const shown = run('git', ['show', `${commit}:${STATE_MANIFEST}`], { cwd: root, allowFailure: true });
  if (shown.status !== 0) return null;
  let manifest;
  try { manifest = JSON.parse(shown.stdout); } catch { return null; }
  const files = manifest?.files;
  const assets = manifest?.assets ?? null;
  const policy = assetPolicyAtCommit(root, commit);
  if (manifest?.format !== STATE_FORMAT || manifest?.layout !== 'canonical-paths'
    || manifest?.source?.branch !== CONFIGURATION_BRANCH
    || !/^[0-9a-f]{40,64}$/.test(manifest?.source?.commit ?? '')
    || !files || typeof files !== 'object' || Array.isArray(files)
    || !Object.hasOwn(files, WORKFLOW_PATH)
    || Object.entries(files).some(([relative, sha]) =>
      !isConfigurationReadPath(relative, policy) || !/^[0-9a-f]{64}$/.test(sha))) return null;
  if (assets != null && (typeof assets !== 'object' || Array.isArray(assets)
    || JSON.stringify(Object.keys(assets).sort()) !== JSON.stringify(Object.keys(files).sort())
      || Object.entries(assets).some(([relative, descriptor]) =>
      descriptor?.sha256 !== files[relative]
      || !/^[0-9a-f]{40,64}$/.test(descriptor?.object ?? '')
      || !/^100(?:644|755)$/.test(descriptor?.mode ?? '')))) return null;
  if (manifest.history != null
    && (manifest.history?.branch !== stateConfigurationHistoryBranch(manifest.source.commit)
      || manifest.history?.commit !== manifest.source.commit)) return null;
  return {
    kind: 'verified-state-mirror', ref, commit, manifest,
    remote: remoteIdentityForAuthorityRef(root, ref)
  };
}

function remoteNameForAuthorityRef(ref) {
  const prefix = 'refs/remotes/';
  if (!ref.startsWith(prefix)) return null;
  for (const branch of [CONFIGURATION_BRANCH, STATE_BRANCH]) {
    const suffix = `/${branch}`;
    if (ref.endsWith(suffix)) return ref.slice(prefix.length, -suffix.length);
  }
  return null;
}

/**
 * Freeze the credential-free fetch identity at the same moment the authority ref is selected.
 * Reconstructing it later from mutable `.git/config` could stamp a different repository into a
 * Story even though the configuration bytes came from the already-selected ref.
 */
function remoteIdentityForAuthorityRef(root, ref) {
  const remote = remoteNameForAuthorityRef(ref);
  if (!remote) return null;
  const identity = configuredRemoteIdentity(root, remote, { direction: 'fetch' });
  if (!identity.configured || identity.ambiguous || !identity.url) {
    throw new SingularityFlowError(
      `Approved configuration remote '${remote}' does not have one exact raw fetch identity.`,
      {
        code: 'APPROVED_CONFIGURATION_REMOTE_UNAVAILABLE',
        details: {
          remote, configured: identity.configured, ambiguous: identity.ambiguous
        }
      }
    );
  }
  return identity.url;
}

function approvedConfigurationAuthority(root, {
  allowLocalHeads = true,
  canonicalRemote = null
} = {}) {
  const listed = run('git', [
    'for-each-ref', '--format=%(refname)',
    `refs/remotes/*/${CONFIGURATION_BRANCH}`, `refs/heads/${CONFIGURATION_BRANCH}`,
    `refs/remotes/*/${STATE_BRANCH}`, `refs/heads/${STATE_BRANCH}`
  ], { cwd: root, allowFailure: true });
  if (listed.status !== 0) return null;
  const priority = (ref) => {
    if (ref === `refs/remotes/origin/${CONFIGURATION_BRANCH}`) return 0;
    if (ref.endsWith(`/${CONFIGURATION_BRANCH}`)) return 1;
    if (ref === `refs/remotes/origin/${STATE_BRANCH}`) return 2;
    return 3;
  };
  const refs = listed.stdout.trim().split('\n').map((entry) => entry.trim()).filter(Boolean)
    .filter((ref) => allowLocalHeads || !ref.startsWith('refs/heads/'))
    .filter((ref) => canonicalRemote == null
      || remoteNameForAuthorityRef(ref) === canonicalRemote)
    .sort((left, right) => priority(left) - priority(right) || left.localeCompare(right));
  for (const ref of refs) {
    const authority = configurationAuthorityAtRef(root, ref);
    if (authority) return authority;
  }
  return null;
}

/**
 * Repair a narrow/single-branch clone by fetching only a published configuration authority.
 *
 * The ref is written to the ordinary remote-tracking namespace, exactly as a full clone would have
 * done. The selected branch, HEAD, index and application files are never changed. Prefer the
 * reviewed configuration authority; `state` is recovery-only and is accepted later only after its
 * complete manifest and every declared byte have been verified.
 */
async function refreshApprovedConfigurationAuthority(root, {
  allowLocalHeads = true,
  canonicalRemote = null
} = {}) {
  const listed = run('git', ['remote'], { cwd: root, allowFailure: true });
  if (listed.status !== 0) return null;
  const remotes = listed.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)
    .filter((remote) => canonicalRemote == null || remote === canonicalRemote)
    .sort((left, right) => (left === 'origin' ? -1 : 0) - (right === 'origin' ? -1 : 0)
      || left.localeCompare(right));
  for (const remote of remotes) {
    const identity = configuredRemoteIdentity(root, remote, { direction: 'fetch' });
    if (!identity.configured || identity.ambiguous || !identity.url) {
      if (canonicalRemote === remote) {
        throw new SingularityFlowError(
          `Approved configuration remote '${remote}' does not have one exact raw fetch identity.`,
          {
            code: 'APPROVED_CONFIGURATION_REMOTE_UNAVAILABLE',
            details: {
              remote, configured: identity.configured, ambiguous: identity.ambiguous
            }
          }
        );
      }
      continue;
    }
    // Both advertisement and fetch address the same reviewed raw URL through a one-pass alias.
    // The checkout's remote-tracking namespace keeps its ordinary name, but mutable ambient
    // insteadOf/pushInsteadOf rules can never substitute configuration bytes behind that name.
    const transport = frozenRemoteTransport(identity.url);
    const advertised = await runRemoteGitAsync([
      'ls-remote', '--heads', '--', transport.remote,
      `refs/heads/${CONFIGURATION_BRANCH}`, `refs/heads/${STATE_BRANCH}`
    ], { cwd: root, operation: 'remote-probe', env: transport.env });
    if (advertised.status !== 0) continue;
    const branches = new Map(advertised.stdout.split(/\r?\n/).map((line) => {
      const [commit, ref] = line.trim().split(/\s+/);
      return /^[a-f0-9]{40,64}$/.test(commit ?? '') && ref ? [ref, commit] : null;
    }).filter(Boolean));
    for (const branch of [CONFIGURATION_BRANCH, STATE_BRANCH]) {
      const source = `refs/heads/${branch}`;
      const advertisedCommit = branches.get(source);
      if (!advertisedCommit) continue;
      const destination = `refs/remotes/${remote}/${branch}`;
      const validRef = run('git', ['check-ref-format', destination], { cwd: root, allowFailure: true });
      if (validRef.status !== 0) continue;
      const localCommit = run('git', ['rev-parse', '--verify', `${destination}^{commit}`], {
        cwd: root, allowFailure: true
      }).stdout.trim();
      if (localCommit !== advertisedCommit) {
        const fetched = await runRemoteGitAsync([
          'fetch', '--quiet', '--no-tags', '--force', '--', transport.remote,
          `+${source}:${destination}`
        ], { cwd: root, operation: 'remote-configuration', env: transport.env });
        if (fetched.status !== 0) continue;
        const fetchedCommit = run('git', ['rev-parse', '--verify', `${destination}^{commit}`], {
          cwd: root, allowFailure: true
        }).stdout.trim();
        // The branch moved between advertisement and fetch. Do not bind a commit that this exact
        // proof round did not observe; the next operation will negotiate the new head.
        if (fetchedCommit !== advertisedCommit) continue;
      }
      // Bind the result to the exact ref just advertised and fetched. Selecting a generic cached
      // ref here would let a locally forged `refs/remotes/origin/*` win after another remote was
      // successfully contacted.
      const authority = configurationAuthorityAtRef(root, destination);
      if (authority) return authority;
    }
  }
  return null;
}

async function extractConfiguration(root, authority, destination, { selectPaths = null } = {}) {
  const policy = assetPolicyAtCommit(root, authority.commit);
  const selected = selectPaths == null ? null : [...new Set(selectPaths)].sort();
  if (selected != null && (!selected.includes(WORKFLOW_PATH)
      || selected.some((relative) => !isConfigurationReadPath(relative, policy)))) {
    throw new SingularityFlowError('Approved configuration selection contains an unsupported path.', {
      code: 'APPROVED_CONFIGURATION_SELECTION_INVALID'
    });
  }
  const listed = run('git', [
    'ls-tree', '-r', '-z', '--format=%(objectmode) %(objectname) %(path)', authority.commit, '--',
    ...(selected ?? configurationAssetSearchRoots(policy))
  ], { cwd: root });
  const entries = listed.stdout.split('\0').filter(Boolean).map((line) => {
    const first = line.indexOf(' ');
    const second = line.indexOf(' ', first + 1);
    return { mode: line.slice(0, first), oid: line.slice(first + 1, second), file: line.slice(second + 1) };
  }).filter((entry) => /^100(?:644|755)$/.test(entry.mode)
    && isConfigurationReadPath(entry.file, policy));
  if (selected != null) {
    const available = new Set(entries.map((entry) => entry.file));
    const missing = selected.filter((relative) => !available.has(relative));
    if (missing.length) {
      throw new SingularityFlowError(
        `Approved configuration ${authority.ref} does not contain '${missing[0]}'.`,
        { code: 'APPROVED_CONFIGURATION_INCOMPLETE', details: { missing } }
      );
    }
  }
  if (!entries.some((entry) => entry.file === WORKFLOW_PATH)) {
    throw new SingularityFlowError(
      `Approved configuration ${authority.ref} does not contain ${WORKFLOW_PATH}.`,
      { code: 'APPROVED_CONFIGURATION_INCOMPLETE' }
    );
  }
  if (entries.length > MAX_FILES) {
    throw new SingularityFlowError(`Approved configuration contains more than ${MAX_FILES} files.`, {
      code: 'APPROVED_CONFIGURATION_TOO_LARGE'
    });
  }
  const batch = run('git', ['cat-file', '--batch'], {
    cwd: root, encoding: 'buffer', input: `${entries.map((entry) => entry.oid).join('\n')}\n`
  });
  let cursor = 0;
  let total = 0;
  for (const entry of entries) {
    const newline = batch.stdout.indexOf(0x0a, cursor);
    if (newline < 0) throw new SingularityFlowError(`Could not read approved configuration file '${entry.file}'.`);
    const [oid, type, rawSize] = batch.stdout.toString('utf8', cursor, newline).trim().split(' ');
    const size = Number(rawSize);
    if (oid !== entry.oid || type !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
      throw new SingularityFlowError(`Could not read approved configuration file '${entry.file}'.`);
    }
    total += size;
    if (total > MAX_BYTES) {
      throw new SingularityFlowError(`Approved configuration exceeds ${MAX_BYTES} bytes.`, {
        code: 'APPROVED_CONFIGURATION_TOO_LARGE'
      });
    }
    const start = newline + 1;
    const end = start + size;
    if (end > batch.stdout.length) {
      throw new SingularityFlowError(`Approved configuration file '${entry.file}' is truncated.`);
    }
    const target = path.join(destination, entry.file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, batch.stdout.subarray(start, end));
    await chmod(target, entry.mode === '100755' ? 0o755 : 0o644);
    cursor = end + 1;
  }
  if (authority.kind === 'verified-state-mirror') {
    const declared = Object.keys(authority.manifest.files).sort();
    const copied = entries.map((entry) => entry.file).sort();
    if (selected == null && JSON.stringify(declared) !== JSON.stringify(copied)) {
      throw new SingularityFlowError('State configuration mirror files do not exactly match its manifest.', {
        code: 'STATE_CONFIGURATION_MIRROR_INVALID'
      });
    }
    if (copied.some((relative) => !declared.includes(relative))) {
      throw new SingularityFlowError('Selected state configuration file is absent from its manifest.', {
        code: 'STATE_CONFIGURATION_MIRROR_INVALID'
      });
    }
    if (authority.manifest.assets) {
      for (const entry of entries) {
        const descriptor = authority.manifest.assets[entry.file];
        if (descriptor.object !== entry.oid || descriptor.mode !== entry.mode) {
          throw new SingularityFlowError(`State configuration mirror Git identity does not match for '${entry.file}'.`, {
            code: 'STATE_CONFIGURATION_MIRROR_INVALID'
          });
        }
      }
    }
    for (const relative of copied) {
      const actual = createHash('sha256').update(await readFile(path.join(destination, relative))).digest('hex');
      if (actual !== authority.manifest.files[relative]) {
        throw new SingularityFlowError(`State configuration mirror hash does not match for '${relative}'.`, {
          code: 'STATE_CONFIGURATION_MIRROR_INVALID'
        });
      }
    }
  }
  return policy;
}

/**
 * Use the working-tree configuration when present; otherwise mount the verified approved commit in
 * a disposable directory. Online new-work reads select the same remote authority as Story start and
 * retain one private snapshot without changing refs, HEAD, index, or application files. Explicit
 * cached/offline reads retain the legacy local-ref path for reviewed local-head operation.
 *
 * `preferAuthority` is for operations that describe a *new* Story. An active Story must keep
 * reading its immutable pinned configuration, while new-work intake must see the latest approved
 * catalog even when launched from that older Story checkout.
 */
export async function withApprovedConfigurationRead(root, fn, {
  preferAuthority = false,
  allowLocalHeads = true,
  refreshAuthority = true,
  requireAuthorityRefresh = false,
  canonicalRemote = null,
  selectPaths = null
} = {}) {
  const existingScope = configurationReadScope(root);
  if (existingScope) {
    // Nested readers share the already-observed authority. A narrower caller receives a genuinely
    // narrower private view; it must not trigger a second remote observation or inherit files the
    // caller deliberately excluded.
    return withExistingConfigurationRead(root, existingScope, fn, { selectPaths });
  }
  const workflow = await lstat(path.join(root, WORKFLOW_PATH)).catch((error) => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  });
  if (workflow && !preferAuthority) return fn({ kind: 'working-tree', ref: null, commit: null });

  // Online new-work reads must use the same authority precedence as Story start. In a managed
  // workspace the explicit capabilityAuthority can be repository A while the member's origin is B;
  // refreshing B's remote-tracking refs here previously made Auto/CFP/help see a different policy
  // than the Story created one command later. The canonical resolver observes the chosen remote,
  // and the retained snapshot is mounted without changing this checkout or its refs.
  const canonicalOnlineRead = refreshAuthority && canonicalRemote == null;
  if (canonicalOnlineRead) {
    // Keep fast read-only commands out of the full configuration-authority dependency graph.
    // Workspace/remote authority is needed only when this online branch is actually executed.
    const {
      hasStoryConfigurationAuthorityCandidate, loadStoryConfigurationSnapshot,
      resolveStoryConfigurationAuthority, withStoryConfigurationSnapshotRead
    } = await import('./configuration-branch.mjs');
    const resolved = await resolveStoryConfigurationAuthority(root);
    if (resolved) {
      const snapshot = await loadStoryConfigurationSnapshot(resolved);
      return withStoryConfigurationSnapshotRead(root, snapshot, fn, { selectPaths });
    }
    if (requireAuthorityRefresh) return fn(null);
    // A truly local repository may deliberately author an offline configuration head. Preserve
    // that mode, but never substitute a cached local/remote-tracking ref after a configured remote
    // positively reported that no approved authority exists.
    if (await hasStoryConfigurationAuthorityCandidate(root)) {
      return workflow
        ? fn({ kind: 'working-tree', ref: null, commit: null })
        : fn(null);
    }
  }
  const authority = preferAuthority
    ? (refreshAuthority
      ? await refreshApprovedConfigurationAuthority(root, { allowLocalHeads, canonicalRemote })
        ?? (requireAuthorityRefresh
          ? null
          : approvedConfigurationAuthority(root, { allowLocalHeads, canonicalRemote }))
      : approvedConfigurationAuthority(root, { allowLocalHeads, canonicalRemote }))
    : (requireAuthorityRefresh
      ? null
      : approvedConfigurationAuthority(root, { allowLocalHeads, canonicalRemote }))
      ?? (refreshAuthority
        ? await refreshApprovedConfigurationAuthority(root, { allowLocalHeads, canonicalRemote })
        : null);
  if (!authority && workflow) return fn({ kind: 'working-tree', ref: null, commit: null });
  if (!authority) return fn(null);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-approved-config-read-'));
  try {
    const assetPolicy = await extractConfiguration(root, authority, temporaryRoot, { selectPaths });
    return await withConfigurationReadRoot(root, temporaryRoot, authority, () => fn(authority), {
      assetPolicy
    });
  } finally {
    await removeTemporaryTree(temporaryRoot);
  }
}
