import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SingularityFlowError, ensureDir, exists, nowIso, readJson, run, writeAtomic, writeJson
} from './util.mjs';
import { readRefTree as readRefTreeShared } from './git-ref-tree.mjs';
import { scopedRead } from './read-scope.mjs';
import {
  defaultBranchName, gitCommitIdentity, gitDir, hasRemote, identity, refExists
} from './git.mjs';
import { normalizeLedgerConfig } from './ledger-config.mjs';
import { LIFECYCLE_EVENT_TYPES } from './lifecycle-event.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { runRemoteGit, runRemoteGitAsync } from './git-execution.mjs';
import {
  configuredRemoteAuthority, configuredRemoteIdentity, frozenRemoteTransport,
  safeGitDiagnosticReference
} from './git-remote-diagnostics.mjs';

export const LEDGER_SCHEMA_VERSION = currentSchemaVersion('ledger-entry');
export const LEDGER_INTENT_DIRECTORY = 'context/ledger-intents';
export const LEDGER_EVENT_TYPES = Object.freeze([
  ...LIFECYCLE_EVENT_TYPES,
  'retention-expired',
  'capability-lease-granted',
  'capability-lease-revoked',
  'capability-configuration-activated'
]);
const HEAD_PATH = 'ledger/head.json';
const README_PATH = 'README.md';

function git(root, args, {
  allowFailure = false, stdio = 'pipe', env = process.env,
  encoding = 'utf8', input = undefined, maxBuffer = undefined
} = {}) {
  if (['fetch', 'push', 'pull', 'ls-remote', 'clone'].includes(args[0])) {
    return runRemoteGit(args, {
      cwd: root,
      operation: args[0] === 'push' ? 'remote-push' : args[0] === 'ls-remote' ? 'remote-probe' : 'remote-configuration',
      allowFailure,
      env
    });
  }
  return run('git', args, {
    cwd: root, allowFailure, stdio, env, encoding, input, maxBuffer
  });
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeSegment(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized || normalized === '.' || normalized === '..') throw new SingularityFlowError(`${label} cannot be represented safely in the ledger.`);
  return normalized;
}

function entryPath(entry) {
  const capability = safeSegment(entry.capabilityId, 'Ledger capability ID');
  const hash = sha256(canonicalJson(entry));
  return { hash, path: `ledger/entries/${capability}/${hash}.json` };
}

function eventPath(eventId) {
  return `ledger/events/${safeSegment(eventId, 'Ledger event ID')}.json`;
}

function idempotencyPath(idempotencyHash) {
  return `ledger/idempotency/${safeSegment(idempotencyHash, 'Ledger idempotency hash')}.json`;
}

function remoteRef(config) {
  return `refs/remotes/${config.remote}/${config.branch}`;
}

function localRef(config) {
  return `refs/heads/${config.branch}`;
}

function refExistsInEnvironment(root, ref, env = process.env) {
  return git(root, ['show-ref', '--verify', '--quiet', ref], { allowFailure: true, env }).status === 0;
}

function synchronizeRemoteTrackingRefAfterPush(root, config, commit, expectedRemoteSha, env = process.env) {
  const ref = remoteRef(config);
  const current = refExistsInEnvironment(root, ref, env)
    ? git(root, ['rev-parse', '--verify', `${ref}^{commit}`], { env }).stdout.trim()
    : null;
  if (current === commit) return;

  // A fetch may have observed a publication made after ours while `git push` was returning. Never
  // move that authority cache backwards. A stale tracking ref is replaceable only when it is the
  // exact pre-push value (or one of its ancestors); update-ref's old-value lease closes the race
  // between this inspection and the write.
  if (current && git(root, ['merge-base', '--is-ancestor', commit, current], {
    allowFailure: true, env
  }).status === 0) return;
  const currentPrecedesPublishedCommit = Boolean(current) && git(root, [
    'merge-base', '--is-ancestor', current, commit
  ], { allowFailure: true, env }).status === 0;
  const replaceable = current === null || currentPrecedesPublishedCommit || Boolean(expectedRemoteSha && (
    current === expectedRemoteSha
    || git(root, ['merge-base', '--is-ancestor', current, expectedRemoteSha], {
      allowFailure: true, env
    }).status === 0
  ));
  if (!replaceable) return;
  git(root, [
    'update-ref', ref, commit, current ?? '0'.repeat(commit.length)
  ], { allowFailure: true, env });
}

function synchronizeLocalStateRefAfterRemotePush(root, config, commit, env = process.env) {
  const ref = localRef(config);
  const current = refExistsInEnvironment(root, ref, env)
    ? git(root, ['rev-parse', '--verify', `${ref}^{commit}`], { env }).stdout.trim()
    : null;
  if (current === commit) return;
  if (current && git(root, ['merge-base', '--is-ancestor', commit, current], {
    allowFailure: true, env
  }).status === 0) return;
  const replaceable = current === null || git(root, [
    'merge-base', '--is-ancestor', current, commit
  ], { allowFailure: true, env }).status === 0;
  if (!replaceable) return;
  git(root, [
    'update-ref', ref, commit, current ?? '0'.repeat(commit.length)
  ], { allowFailure: true, env });
}

function localStateConcurrencyError(config, expectedLocalSha, observedLocalSha) {
  const error = new SingularityFlowError(
    `Concurrent publication changed the local ${config.branch} branch before the candidate could be applied.`,
    {
      code: 'state_branch.concurrent_publication',
      details: {
        branch: config.branch,
        expectedLocalSha,
        observedLocalSha
      }
    }
  );
  error.concurrent = true;
  return error;
}

async function safeStateWorktreeTarget(worktree, relative, { createDirectories = false } = {}) {
  const root = await realpath(worktree);
  const segments = relative.split('/');
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    cursor = path.join(cursor, segment);
    let info = await lstat(cursor).catch((error) => {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      throw error;
    });
    if (info == null && createDirectories) {
      await mkdir(cursor, { mode: 0o700 });
      info = await lstat(cursor);
    }
    if (info == null) continue;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new SingularityFlowError(
        `State-branch path '${relative}' has a non-directory or symbolic-link ancestor.`,
        { code: 'state_branch.path_unsafe', details: { path: relative } }
      );
    }
    const rebound = await realpath(cursor);
    const relation = path.relative(root, rebound);
    if (relation === '..' || relation.startsWith(`..${path.sep}`)
        || path.isAbsolute(relation)) {
      throw new SingularityFlowError(
        `State-branch path '${relative}' escapes its isolated worktree.`,
        { code: 'state_branch.path_unsafe', details: { path: relative } }
      );
    }
  }
  const target = path.join(root, ...segments);
  const targetInfo = await lstat(target).catch((error) => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  });
  if (targetInfo?.isSymbolicLink() || targetInfo?.isDirectory()) {
    throw new SingularityFlowError(
      `State-branch path '${relative}' is not a safe regular-file target.`,
      { code: 'state_branch.path_unsafe', details: { path: relative } }
    );
  }
  return target;
}

function hasRemoteInEnvironment(root, remote, env = process.env) {
  return git(root, ['config', '--get', `remote.${remote}.url`], { allowFailure: true, env }).status === 0;
}

function ledgerHead(root, config, { env = process.env } = {}) {
  const remote = remoteRef(config);
  if (refExistsInEnvironment(root, remote, env)) return remote;
  if (refExistsInEnvironment(root, localRef(config), env)) return localRef(config);
  return null;
}

/**
 * Resolve the exact configured and effective push endpoint behind a state-branch remote name.
 *
 * Both identities matter. The local configuration is the repository authority a reviewer sees,
 * while `git remote get-url --push` includes machine-level URL rewriting and is the endpoint Git
 * will actually contact. Binding only the remote name allows either layer to redirect a confirmed
 * publication without changing HEAD or the working tree.
 */
export function stateBranchPublicationTargetIdentity(root, rawConfig) {
  const config = normalizeLedgerConfig(rawConfig);
  const configured = configuredRemoteIdentity(root, config.remote, { direction: 'push' });
  if (configured.ambiguous) {
    throw new SingularityFlowError(
      `State publication remote '${config.remote}' has more than one configured push endpoint.`,
      { code: 'state_branch.remote_ambiguous', details: { remote: config.remote } }
    );
  }
  const effective = configuredRemoteAuthority(root, config.remote, { direction: 'push' });
  if (configured.configured && (!configured.url || !effective.url)) {
    throw new SingularityFlowError(
      `State publication remote '${config.remote}' does not resolve to one exact push endpoint.`,
      { code: 'state_branch.remote_unavailable', details: { remote: config.remote } }
    );
  }
  return Object.freeze({
    remote: config.remote,
    branch: config.branch,
    targetRef: `refs/heads/${config.branch}`,
    configured: configured.configured,
    configuredUrl: configured.url,
    configuredUrlSha256: configured.fingerprint ? `sha256:${configured.fingerprint}` : null,
    effectiveUrl: effective.url,
    effectiveUrlSha256: effective.fingerprint ? `sha256:${effective.fingerprint}` : null
  });
}

/**
 * Capture the exact state authority an immutable projection will publish against.
 *
 * Publication normally derives this inside its temporary worktree. A recovery marker must retain
 * it before that worktree exists, otherwise a retry could silently adopt a newer state branch and
 * replace a sibling projection the reviewed publication never observed.
 */
export function captureStateBranchPublicationAuthority(root, rawConfig, {
  env = process.env, refreshRemote = true
} = {}) {
  const config = normalizeLedgerConfig(rawConfig);
  if (refreshRemote) ensureRemoteBranchFetched(root, config, { env });
  const trackedRemote = remoteRef(config);
  const remoteConfigured = hasRemoteInEnvironment(root, config.remote, env);
  const remoteExists = refExistsInEnvironment(root, trackedRemote, env);
  const base = ledgerHead(root, config, { env });
  const baseRef = base
    ? git(root, ['rev-parse', '--verify', `${base}^{commit}`], { env }).stdout.trim()
    : undefined;
  const expectedRemoteSha = remoteConfigured
    ? remoteExists
      ? git(root, ['rev-parse', '--verify', `${trackedRemote}^{commit}`], { env }).stdout.trim()
      : null
    : undefined;
  return Object.freeze({
    ...(expectedRemoteSha !== undefined ? { expectedRemoteSha } : {}),
    ...(baseRef ? { baseRef } : {}),
    refreshRemote: false
  });
}

/**
 * Materialize an already reviewed remote state tip for execution without changing its authority.
 *
 * Planning observes with `ls-remote`, which is read-only and therefore cannot refresh the local
 * remote-tracking ref. Execution calls this only after exact host confirmation. The fetch is
 * accepted solely when the branch still advertises the reviewed SHA; an absent, moved, malformed,
 * or unreachable branch fails before the publication worktree or recovery marker is created.
 */
export function materializeStateBranchPublicationAuthority(root, rawConfig, {
  expectedRemoteSha = undefined, env = process.env, transportRemote = undefined
} = {}) {
  const config = normalizeLedgerConfig(rawConfig);
  const configured = hasRemoteInEnvironment(root, config.remote, env);
  if (!configured) {
    if (expectedRemoteSha !== undefined) {
      throw new SingularityFlowError('The reviewed state publication remote is no longer configured.', {
        code: 'state_branch.publication_observation_unavailable',
        details: { branch: config.branch, expectedRemoteSha }
      });
    }
    return Object.freeze({ expectedRemoteSha: undefined, baseRef: refExistsInEnvironment(root, localRef(config), env)
      ? git(root, ['rev-parse', '--verify', `${localRef(config)}^{commit}`], { env }).stdout.trim()
      : undefined });
  }

  const before = observeRemoteBranch(root, config, { env, transportRemote });
  if (before.status !== 'observed') {
    throw new SingularityFlowError(
      `Unable to verify the ${config.branch} branch before materializing the reviewed publication. ${before.detail}`,
      {
        code: 'state_branch.publication_observation_unavailable',
        details: { branch: config.branch, expectedRemoteSha }
      }
    );
  }
  if (before.commit !== expectedRemoteSha) {
    throw new SingularityFlowError(
      `Concurrent publication changed the ${config.branch} branch after it was reviewed.`,
      {
        code: 'state_branch.concurrent_publication',
        details: { branch: config.branch, expectedRemoteSha, observedRemoteSha: before.commit }
      }
    );
  }

  if (expectedRemoteSha !== null) {
    const fetched = ensureRemoteBranchFetched(root, config, { env, transportRemote });
    const local = fetched === LEDGER_REMOTE_VIEW.REFRESHED
      ? git(root, ['rev-parse', '--verify', `${remoteRef(config)}^{commit}`], {
          allowFailure: true, env
        }).stdout.trim()
      : null;
    if (local !== expectedRemoteSha) {
      throw new SingularityFlowError('The reviewed state publication base could not be materialized exactly.', {
        code: 'state_branch.publication_base_unavailable',
        details: { branch: config.branch, expectedRemoteSha, observedRemoteSha: local }
      });
    }
    const after = observeRemoteBranch(root, config, { env, transportRemote });
    if (after.status !== 'observed' || after.commit !== expectedRemoteSha) {
      throw new SingularityFlowError(
        `Concurrent publication changed the ${config.branch} branch while its reviewed base was materialized.`,
        {
          code: after.status === 'observed'
            ? 'state_branch.concurrent_publication'
            : 'state_branch.publication_observation_unavailable',
          details: {
            branch: config.branch, expectedRemoteSha,
            observedRemoteSha: after.status === 'observed' ? after.commit : null
          }
        }
      );
    }
  }

  const localBase = expectedRemoteSha ?? (refExistsInEnvironment(root, localRef(config), env)
    ? git(root, ['rev-parse', '--verify', `${localRef(config)}^{commit}`], { env }).stdout.trim()
    : undefined);
  return Object.freeze({ expectedRemoteSha, baseRef: localBase });
}

/**
 * How a read came by its view of the remote, in the words the rest of the product already uses.
 *
 * `resolveWorldModelSource` in `grounding.mjs` settled this vocabulary and a second one here would
 * be a second thing to translate. `not-checked` is the addition, and it is the whole point of it:
 * the existing states all describe an attempt — refreshed, timed out, no remote configured — and a
 * read path that *deliberately did not look* is none of those.
 *
 * Without it, `offline: true` is what `src/git.mjs` already objected to: a slow truth turned into a
 * fast lie. The cached answer is served either way; the difference is whether the caller is told it
 * is cached, and only one of those lets them decide whether it is good enough.
 */
export const LEDGER_REMOTE_VIEW = Object.freeze({
  REFRESHED: 'refreshed',
  NOT_CHECKED: 'not-checked',
  NO_REMOTE: 'no-remote',
  OFFLINE_CACHED: 'offline-cached',
  TIMEOUT_CACHED: 'timeout-cached'
});

/**
 * Bring the ledger branch up to date, unless this is a read that promised not to.
 *
 * Returns which of the states above happened, because the caller has to be able to say so. It used
 * to return nothing, which is why `ledgerStatus` could guard the call and still report its result
 * as though the remote had been consulted.
 */
function ensureRemoteBranchFetched(root, config, {
  offline = false, env = process.env, transportRemote = undefined
} = {}) {
  if (!hasRemoteInEnvironment(root, config.remote, env)) return LEDGER_REMOTE_VIEW.NO_REMOTE;
  if (offline) return LEDGER_REMOTE_VIEW.NOT_CHECKED;
  const frozen = transportRemote === undefined
    ? null
    : frozenRemoteTransport(transportRemote, { env });
  const fetched = git(root, [
    'fetch', '--no-tags', frozen?.remote ?? config.remote,
    `+refs/heads/${config.branch}:${remoteRef(config)}`
  ], { allowFailure: true, env: frozen?.env ?? env });
  if (fetched.status === 0) return LEDGER_REMOTE_VIEW.REFRESHED;
  return fetched.timedOut ? LEDGER_REMOTE_VIEW.TIMEOUT_CACHED : LEDGER_REMOTE_VIEW.OFFLINE_CACHED;
}

/** Async initialization-only counterpart: onboarding must never block the extension event loop. */
async function ensureRemoteBranchFetchedAsync(root, config, {
  offline = false, env = process.env, transportRemote = undefined
} = {}) {
  if (!hasRemoteInEnvironment(root, config.remote, env)) return LEDGER_REMOTE_VIEW.NO_REMOTE;
  if (offline) return LEDGER_REMOTE_VIEW.NOT_CHECKED;
  const frozen = transportRemote === undefined
    ? null
    : frozenRemoteTransport(transportRemote, { env });
  const fetched = await runRemoteGitAsync([
    'fetch', '--no-tags', frozen?.remote ?? config.remote,
    `+refs/heads/${config.branch}:${remoteRef(config)}`
  ], {
    cwd: root, operation: 'remote-configuration', env: frozen?.env ?? env
  });
  if (fetched.status === 0) return LEDGER_REMOTE_VIEW.REFRESHED;
  return fetched.timedOut ? LEDGER_REMOTE_VIEW.TIMEOUT_CACHED : LEDGER_REMOTE_VIEW.OFFLINE_CACHED;
}

function installPinRefspec(root, config, { env = process.env } = {}) {
  if (config.pinTransport !== 'refs' || !hasRemoteInEnvironment(root, config.remote, env)) return false;
  const refspec = '+refs/singularity/pins/*:refs/singularity/pins/*';
  const configured = git(root, ['config', '--get-all', `remote.${config.remote}.fetch`], { allowFailure: true, env })
    .stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (configured.includes(refspec)) return false;
  git(root, ['config', '--add', `remote.${config.remote}.fetch`, refspec], { env });
  return true;
}

function pinRefspecStatus(root, config) {
  const refspec = '+refs/singularity/pins/*:refs/singularity/pins/*';
  if (config.pinTransport !== 'refs') {
    return { required: false, configured: true, refspec: null };
  }
  if (!hasRemote(root, config.remote)) {
    return { required: true, configured: false, refspec };
  }
  const configured = git(root, ['config', '--get-all', `remote.${config.remote}.fetch`], { allowFailure: true })
    .stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  return { required: true, configured: configured.includes(refspec), refspec };
}

async function temporaryWorktree(root, ref, callback, { env = process.env } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-ledger-'));
  const worktree = path.join(parent, 'worktree');
  const args = ref
    ? ['worktree', 'add', '--detach', worktree, ref]
    : ['worktree', 'add', '--orphan', '-b', '__sflow_ledger_bootstrap__', worktree];
  const added = git(root, args, { allowFailure: true, env });
  if (added.status !== 0) {
    await rm(parent, { recursive: true, force: true });
    throw new SingularityFlowError(
      `Unable to create the isolated ledger worktree. ${safeGitDiagnosticReference(
        added, 'State worktree creation failed'
      )}`,
      { code: 'state_branch.worktree_unavailable' }
    );
  }
  try {
    return await callback(worktree);
  } finally {
    git(root, ['worktree', 'remove', '--force', worktree], { allowFailure: true, env });
    git(root, ['branch', '-D', '__sflow_ledger_bootstrap__'], { allowFailure: true, env });
    await rm(parent, { recursive: true, force: true });
  }
}

async function writeCanonicalJson(file, value) {
  await writeAtomic(file, canonicalJson(value));
}

function commitArgs(config, message) {
  return ['commit', ...(config.signing === 'commit' ? ['-S'] : []), '-m', message];
}

function normalizedGuardedRemoteRefs(worktree, guardedRemoteRefs = {}, { env = process.env } = {}) {
  return Object.entries(guardedRemoteRefs ?? {}).map(([ref, requestedCommit]) => {
    if (!ref.startsWith('refs/heads/')
      || git(worktree, ['check-ref-format', ref], { allowFailure: true, env }).status !== 0) {
      throw new SingularityFlowError(`State publication guard contains an invalid remote ref '${ref}'.`);
    }
    const commit = git(worktree, ['rev-parse', '--verify', `${requestedCommit}^{commit}`], {
      allowFailure: true, env
    }).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
      throw new SingularityFlowError(`State publication guard commit for '${ref}' is unavailable.`);
    }
    return { ref, commit };
  });
}

function pushLedger(worktree, config, expectedRemoteSha = undefined, {
  env = process.env, transportRemote = undefined
} = {}) {
  const lease = expectedRemoteSha !== undefined
    ? `--force-with-lease=refs/heads/${config.branch}:${expectedRemoteSha ?? ''}`
    : '--force-with-lease';
  const frozen = transportRemote === undefined
    ? null
    : frozenRemoteTransport(transportRemote, { push: true, env });
  return git(worktree, [
    'push', lease,
    frozen?.remote ?? config.remote,
    `HEAD:refs/heads/${config.branch}`
  ], { allowFailure: true, env: frozen?.env ?? env });
}

async function pushLedgerAsync(worktree, config, expectedRemoteSha = undefined, {
  env = process.env, transportRemote = undefined
} = {}) {
  const lease = expectedRemoteSha !== undefined
    ? `--force-with-lease=refs/heads/${config.branch}:${expectedRemoteSha ?? ''}`
    : '--force-with-lease';
  const frozen = transportRemote === undefined
    ? null
    : frozenRemoteTransport(transportRemote, { push: true, env });
  return runRemoteGitAsync([
    'push', lease,
    frozen?.remote ?? config.remote,
    `HEAD:refs/heads/${config.branch}`
  ], { cwd: worktree, operation: 'remote-push', env: frozen?.env ?? env });
}

function observeGuardedRemoteRefs(worktree, config, guards, {
  env = process.env, transportRemote = undefined
} = {}) {
  if (!guards.length) return { status: 'observed', refs: new Map() };
  const frozen = transportRemote === undefined
    ? null
    : frozenRemoteTransport(transportRemote, { env });
  const observed = git(worktree, [
    'ls-remote', '--heads', '--', frozen?.remote ?? config.remote, ...guards.map(({ ref }) => ref)
  ], { allowFailure: true, env: frozen?.env ?? env });
  if (observed.status !== 0) {
    return {
      status: 'unavailable', refs: new Map(),
      detail: safeGitDiagnosticReference(
        observed, 'State source-authority observation failed'
      )
    };
  }
  const advertised = new Map();
  for (const line of observed.stdout.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([0-9a-f]{40,64})\s+(refs\/heads\/[^\s]+)$/i);
    if (!match || !guards.some(({ ref }) => ref === match[2]) || advertised.has(match[2])) {
      return { status: 'malformed', refs: new Map(), detail: 'remote returned an ambiguous ref advertisement' };
    }
    advertised.set(match[2], match[1].toLowerCase());
  }
  return { status: 'observed', refs: advertised };
}

function assertGuardedRemoteRefsCurrent(worktree, config, guards, phase, {
  env = process.env, transportRemote = undefined
} = {}) {
  if (!guards.length) return;
  const observed = observeGuardedRemoteRefs(worktree, config, guards, { env, transportRemote });
  if (observed.status !== 'observed') {
    throw new SingularityFlowError(
      `Unable to verify the state projection source authority ${phase}: ${observed.detail || 'remote observation failed'}`,
      {
        code: 'state_branch.source_authority_observation_unavailable',
        details: { branch: config.branch, guardedRefs: guards.map(({ ref }) => ref), phase }
      }
    );
  }
  const changed = guards.find(({ ref, commit }) => observed.refs.get(ref) !== commit);
  if (!changed) return;
  throw new SingularityFlowError(
    `The state projection source authority '${changed.ref}' changed ${phase}; the state update must not be reported current.`,
    {
      code: 'state_branch.source_authority_changed',
      details: {
        branch: config.branch,
        sourceRef: changed.ref,
        expectedSourceSha: changed.commit,
        observedSourceSha: observed.refs.get(changed.ref) ?? null,
        phase
      }
    }
  );
}

function observeRemoteBranch(worktree, config, {
  env = process.env, transportRemote = undefined
} = {}) {
  const frozen = transportRemote === undefined
    ? null
    : frozenRemoteTransport(transportRemote, { env });
  const observed = git(worktree, [
    'ls-remote', '--heads', frozen?.remote ?? config.remote, `refs/heads/${config.branch}`
  ], { allowFailure: true, env: frozen?.env ?? env });
  if (observed.status !== 0) {
    return {
      status: 'unavailable',
      detail: safeGitDiagnosticReference(observed, 'State branch observation failed')
    };
  }
  const line = observed.stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  return { status: 'observed', commit: line ? line.split(/\s+/)[0] : null };
}

export function isStateBranchConcurrencyFailure(detail) {
  return /stale info|fetch first|non-fast-forward|cannot lock ref.*expected|force-with-lease|incorrect old value/i
    .test(String(detail ?? ''));
}

function initialHead() {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    sequence: 0,
    entryHash: null,
    previousHeadHash: null,
    updatedAt: nowIso()
  };
}

export async function initializeLedger(root, rawConfig = {}, {
  publish = true, refreshRemote = true, env = process.env, repairPins = true,
  transportRemote = undefined
} = {}) {
  const config = normalizeLedgerConfig(rawConfig);
  const refspecInstalled = installPinRefspec(root, config, { env });
  if (refreshRemote) await ensureRemoteBranchFetchedAsync(root, config, { env, transportRemote });
  const existing = ledgerHead(root, config, { env });
  if (existing) {
    let pinRepair = null;
    if (config.enabled && repairPins) {
      try {
        pinRepair = await repairLedgerPins(root, config);
      } catch (error) {
        pinRepair = { valid: false, error: error.message, code: error.code ?? null };
      }
    }
    return { created: false, branch: config.branch, ref: existing, refspecInstalled, pinRepair };
  }
  const actor = env === process.env ? identity(root) : gitCommitIdentity(root, { env });
  return temporaryWorktree(root, null, async (worktree) => {
    await writeCanonicalJson(path.join(worktree, HEAD_PATH), initialHead());
    await writeAtomic(path.join(worktree, README_PATH),
      '# Singularity Flow Capability Ledger\n\n'
      + 'This orphan branch is an append-only workflow ledger. It has no shared ancestry with application branches and must never be merged into them.\n');
    git(worktree, ['add', README_PATH, HEAD_PATH], { env });
    git(worktree, ['-c', `user.name=${actor.name}`, '-c', `user.email=${actor.email ?? 'unknown@invalid'}`, ...commitArgs(config, 'Initialize Singularity Flow capability ledger')], { env });
    const sha = git(worktree, ['rev-parse', 'HEAD'], { env }).stdout.trim();
    // Keep the orphan root reachable locally before attempting the network operation.
    // If the first push fails, `ledger init` can be retried without losing the commit
    // when this temporary worktree is removed.
    git(root, ['update-ref', localRef(config), sha], { env });
    if (publish && hasRemoteInEnvironment(root, config.remote, env)) {
      // This is an orphan-root create, so bind it explicitly to an absent remote ref. A concurrent
      // initializer is joined after one recovery fetch; no force update can replace its state root.
      const pushed = await pushLedgerAsync(worktree, config, null, { env, transportRemote });
      if (pushed.status !== 0) {
        await ensureRemoteBranchFetchedAsync(root, config, { env, transportRemote });
        const concurrent = refExistsInEnvironment(root, remoteRef(config), env) ? remoteRef(config) : null;
        if (concurrent) {
          const concurrentCommit = git(root, ['rev-parse', `${concurrent}^{commit}`], { env }).stdout.trim();
          // The losing initializer created a local orphan before its absent-ref lease was refused.
          // Point that local convenience ref at the proven winner so direct `state:` reads cannot
          // observe the losing root while ledgerHead correctly prefers the remote-tracking ref.
          git(root, ['update-ref', localRef(config), concurrentCommit], { env });
          return {
            created: false, branch: config.branch, ref: concurrent,
            commit: concurrentCommit,
            refspecInstalled, joinedConcurrentInitialization: true
          };
        }
        throw new SingularityFlowError(
          `Ledger root commit ${sha.slice(0, 8)} was retained locally but push failed. `
          + `${pushed.failure?.advice ?? 'Git remote access failed.'} `
          + safeGitDiagnosticReference(pushed, 'State branch creation was refused'),
          { code: pushed.failure?.code ?? 'REMOTE_UNKNOWN' }
        );
      }
      // The successful CAS is an exact observation of the new remote tip. Keep the normal tracking
      // ref current so the caller can append immediately without fetching the commit it just pushed.
      synchronizeRemoteTrackingRefAfterPush(root, config, sha, null, env);
    }
    return { created: true, branch: config.branch, commit: sha, orphan: true, refspecInstalled };
  }, { env });
}

export async function ledgerDoctor(root, rawConfig = {}) {
  const config = normalizeLedgerConfig(rawConfig);
  const checks = [];
  const remoteAvailable = hasRemote(root, config.remote);
  checks.push({ id: 'enabled', status: config.enabled ? 'pass' : 'warn', detail: config.enabled ? 'ledger enabled' : 'ledger disabled (no lifecycle dual-write)' });
  checks.push({ id: 'remote', status: remoteAvailable ? 'pass' : 'warn', detail: remoteAvailable ? `${config.remote} is configured` : `${config.remote} is not configured` });
  await ensureRemoteBranchFetchedAsync(root, config);
  const ref = ledgerHead(root, config);
  checks.push({ id: 'branch', status: ref ? 'pass' : 'fail', detail: ref ? `${config.branch} exists` : `${config.branch} is not initialized` });
  if (ref) {
    const applicationBranch = defaultBranchName(root, rawConfig, config.remote);
    const applicationRef = refExists(root, `refs/heads/${applicationBranch}`)
      ? `refs/heads/${applicationBranch}`
      : git(root, ['rev-parse', '--verify', 'HEAD']).stdout.trim();
    const mergeBase = git(root, ['merge-base', applicationRef, ref], { allowFailure: true });
    checks.push({
      id: 'orphan',
      status: mergeBase.status === 0 ? 'fail' : 'pass',
      detail: mergeBase.status === 0 ? `ledger shares ancestry at ${mergeBase.stdout.trim()}` : 'ledger has no shared application ancestry'
    });
  }
  if (config.pinTransport === 'refs' && remoteAvailable) {
    const refspec = '+refs/singularity/pins/*:refs/singularity/pins/*';
    const configured = git(root, ['config', '--get-all', `remote.${config.remote}.fetch`], { allowFailure: true }).stdout;
    checks.push({
      id: 'pin-refspec',
      status: configured.split(/\r?\n/).includes(refspec) ? 'pass' : 'warn',
      detail: configured.split(/\r?\n/).includes(refspec) ? 'custom pin refs are fetched by this clone' : 'run ledger init to install the custom pin refspec'
    });
  } else {
    checks.push({ id: 'pin-refspec', status: config.pinTransport === 'none' ? 'warn' : 'pass', detail: `pin transport is ${config.pinTransport}` });
  }
  const signingReady = config.signing === 'off'
    ? config.trustTier === 'T0' || config.trustTier === 'T1'
    : git(root, ['config', '--get', 'user.signingkey'], { allowFailure: true }).status === 0;
  checks.push({
    id: 'signing',
    status: signingReady ? 'pass' : 'fail',
    detail: config.signing === 'off' ? `commit signing is off for ${config.trustTier}` : signingReady ? 'Git signing key is configured' : 'ledger signing is required but user.signingkey is missing'
  });
  return {
    valid: !checks.some((check) => check.status === 'fail'),
    trustTier: config.trustTier,
    config,
    checks
  };
}

export async function archiveLedger(root, rawConfig, output, { sign = false } = {}) {
  const config = normalizeLedgerConfig(rawConfig);
  await ensureRemoteBranchFetchedAsync(root, config);
  const ref = ledgerHead(root, config);
  if (!ref) throw new SingularityFlowError(`Ledger branch '${config.branch}' does not exist.`);
  if (config.pinTransport === 'refs' && hasRemote(root, config.remote)) {
    await runRemoteGitAsync([
      'fetch', '--no-tags', config.remote, '+refs/singularity/pins/*:refs/singularity/pins/*'
    ], { cwd: root, operation: 'remote-configuration' });
  } else if (config.pinTransport === 'branches' && hasRemote(root, config.remote)) {
    await runRemoteGitAsync([
      'fetch', '--no-tags', config.remote,
      `+refs/heads/singularity/pins/*:refs/remotes/${config.remote}/singularity/pins/*`
    ], { cwd: root, operation: 'remote-configuration' });
  }
  const target = path.resolve(root, output);
  if (await exists(target)) {
    throw new SingularityFlowError(`Ledger archive already exists and will not be replaced: ${target}`);
  }
  await ensureDir(path.dirname(target));
  const pinPattern = config.pinTransport === 'refs'
    ? 'refs/singularity/pins/'
    : `refs/remotes/${config.remote}/singularity/pins/`;
  const pins = git(root, ['for-each-ref', '--format=%(refname)', pinPattern], { allowFailure: true })
    .stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const bundled = git(root, ['bundle', 'create', target, ref, ...pins], { allowFailure: true });
  if (bundled.status !== 0) throw new SingularityFlowError(`Unable to create ledger archive: ${(bundled.stderr || bundled.stdout).trim()}`);
  const verified = git(root, ['bundle', 'verify', target], { allowFailure: true });
  if (verified.status !== 0) throw new SingularityFlowError(`Ledger archive verification failed: ${(verified.stderr || verified.stdout).trim()}`);
  const bytes = await readFile(target);
  const references = Object.fromEntries([ref, ...pins].map((name) => [
    name,
    git(root, ['rev-parse', name]).stdout.trim()
  ]));
  const manifestPath = `${target}.manifest.json`;
  const manifest = {
    schemaVersion: currentSchemaVersion('ledger-archive-manifest'),
    createdAt: nowIso(),
    ledgerBranch: config.branch,
    trustTier: config.trustTier,
    bundle: path.basename(target),
    bytes: bytes.length,
    sha256: sha256(bytes),
    references,
    signature: sign ? 'detached-gpg' : 'unsigned'
  };
  await writeCanonicalJson(manifestPath, manifest);
  let signaturePath = null;
  if (sign) {
    signaturePath = `${manifestPath}.asc`;
    const signed = run('gpg', ['--armor', '--detach-sign', '--output', signaturePath, manifestPath], {
      cwd: root,
      allowFailure: true
    });
    if (signed.status !== 0) {
      throw new SingularityFlowError(`Ledger archive was created but its manifest could not be signed: ${(signed.stderr || signed.stdout).trim()}`);
    }
  }
  return { path: target, manifestPath, signaturePath, ...manifest };
}

export function createLedgerIntent({
  eventId = null,
  eventType,
  capabilityId,
  subject,
  actor,
  agent = null,
  authorityGroup = null,
  identityAssurance = null,
  payload = {}
}) {
  if (!eventType || !capabilityId || !subject?.workId) throw new SingularityFlowError('Ledger intents require eventType, capabilityId, and subject.workId.');
  if (!LEDGER_EVENT_TYPES.includes(eventType)) {
    throw new SingularityFlowError(`Unsupported ledger event type '${eventType}'. Allowed: ${LEDGER_EVENT_TYPES.join(', ')}.`);
  }
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    eventId: eventId ?? randomUUID(),
    eventType,
    capabilityId,
    subject: canonicalValue(subject),
    actor: {
      name: actor?.name ?? null,
      email: actor?.email ?? null,
      githubLogin: actor?.login ?? actor?.githubLogin ?? null,
      identityAssurance: identityAssurance ?? (actor?.email ? 'configured-local' : actor?.login ? 'github-authenticated' : 'unavailable')
    },
    agent,
    authorityGroup,
    payload: canonicalValue(payload),
    createdAt: nowIso()
  };
}

export function ledgerIdempotencyKey(intent, publishedCommit) {
  const sourceCommit = String(publishedCommit ?? '').trim();
  if (!/^[0-9a-f]{40,64}$/i.test(sourceCommit)) {
    throw new SingularityFlowError('Ledger publication requires a full source commit SHA.');
  }
  const value = [
    intent.subject.workId,
    intent.eventType,
    intent.subject.phase ?? '-',
    intent.subject.generation ?? '-',
    sourceCommit.toLowerCase()
  ].join(' · ');
  return { value, hash: sha256(value) };
}

export async function persistLedgerIntent(root, workDirectory, intent) {
  const relative = path.posix.join(workDirectory.split(path.sep).join('/'), LEDGER_INTENT_DIRECTORY, `${intent.eventId}.json`);
  await writeCanonicalJson(path.join(root, relative), intent);
  return relative;
}

function entryFromIntent(intent, publishedCommit, idempotencyKey) {
  return {
    ...intent,
    idempotencyKey,
    transport: {
      publishedCommit,
      recordedAt: nowIso()
    }
  };
}

async function loadHead(worktree) {
  if (!(await exists(path.join(worktree, HEAD_PATH)))) throw new SingularityFlowError(`Ledger branch is missing ${HEAD_PATH}.`);
  return readRecord('ledger-entry', await readFile(path.join(worktree, HEAD_PATH))).record;
}

async function eventAlreadyRecorded(worktree, idempotencyHash) {
  const file = path.join(worktree, idempotencyPath(idempotencyHash));
  if (!(await exists(file))) return null;
  return readRecord('ledger-entry', await readFile(file)).record;
}

function pinRef(config, intent) {
  if (config.pinTransport === 'none') return null;
  const suffix = `${safeSegment(intent.capabilityId, 'Ledger capability ID')}/${safeSegment(intent.eventId, 'Ledger event ID')}`;
  return config.pinTransport === 'refs'
    ? `refs/singularity/pins/${suffix}`
    : `refs/heads/singularity/pins/${suffix}`;
}

async function publishPinAsync(root, config, intent, publishedCommit, {
  env = process.env, transportRemote = undefined
} = {}) {
  const ref = pinRef(config, intent);
  if (!ref) return null;
  if (!hasRemoteInEnvironment(root, config.remote, env)) {
    const current = git(root, ['rev-parse', '--verify', ref], {
      allowFailure: true, env
    }).stdout.trim();
    if (current && current !== publishedCommit) {
      throw new SingularityFlowError(`Ledger pin ${ref} already points to a different commit.`);
    }
    if (!current) git(root, ['update-ref', ref, publishedCommit], { env });
    return ref;
  }
  const frozen = transportRemote === undefined
    ? null
    : frozenRemoteTransport(transportRemote, { push: true, env });
  const remote = frozen?.remote ?? config.remote;
  const remoteEnv = frozen?.env ?? env;
  const existing = await runRemoteGitAsync(['ls-remote', '--', remote, ref], {
    cwd: root, operation: 'remote-probe', env: remoteEnv
  });
  const existingSha = existing.status === 0 ? existing.stdout.trim().split(/\s+/)[0] : null;
  if (existingSha) {
    if (existingSha !== publishedCommit) {
      throw new SingularityFlowError(`Ledger pin ${ref} already points to a different commit.`);
    }
    return ref;
  }
  if (existing.status !== 0) {
    throw new SingularityFlowError(
      `Unable to inspect ledger pin ${ref}. ${existing.failure?.advice ?? 'Git remote access failed.'} `
      + safeGitDiagnosticReference(existing, 'Ledger pin inspection failed'),
      { code: existing.failure?.code ?? 'REMOTE_UNKNOWN' }
    );
  }
  const pushed = await runRemoteGitAsync([
    'push', remote, `${publishedCommit}:${ref}`
  ], { cwd: root, operation: 'remote-push', env: remoteEnv });
  if (pushed.status !== 0) {
    throw new SingularityFlowError(
      `Unable to publish ledger pin ${ref}. ${pushed.failure?.advice ?? 'Git remote access failed.'} `
      + safeGitDiagnosticReference(pushed, 'Ledger pin publication failed'),
      { code: pushed.failure?.code ?? 'REMOTE_UNKNOWN' }
    );
  }
  return ref;
}

function validRemoteName(root, remote, { configured = true } = {}) {
  const name = String(remote ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || (configured && !hasRemote(root, name))) {
    throw new SingularityFlowError(`Ledger pin repair requires a valid${configured ? ' configured' : ''} Git remote name; '${name || '(empty)'}' is not available.`, {
      code: 'LEDGER_PIN_REMOTE_INVALID'
    });
  }
  return name;
}

function validPinBinding(pinRef, expectedCommit) {
  return typeof pinRef === 'string'
    // A repair command must never be able to turn a ledger entry into a write to main, state, or
    // any other namespace. These are the only two shapes `pinRef()` has ever issued.
    && /^refs\/(?:singularity\/pins|heads\/singularity\/pins)\/[a-z0-9._-]+\/[a-z0-9._-]+$/.test(pinRef)
    && /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(String(expectedCommit ?? ''));
}

function localPinObservation(root, pinRef, expectedCommit) {
  if (!validPinBinding(pinRef, expectedCommit)) return { status: 'invalid', commit: null };
  const current = git(root, ['rev-parse', '--verify', `${pinRef}^{commit}`], { allowFailure: true });
  if (current.status !== 0) return { status: 'missing', commit: null };
  const commit = current.stdout.trim();
  return { status: commit === expectedCommit ? 'expected' : 'mismatch', commit };
}

async function remotePinObservation(root, remote, pinRef, expectedCommit) {
  if (!hasRemote(root, remote)) return { status: 'unconfigured', commit: null, remote };
  const observed = await runRemoteGitAsync([
    'ls-remote', '--exit-code', remote, pinRef
  ], { cwd: root, operation: 'remote-probe' });
  if (observed.status === 0 && observed.stdout.trim()) {
    const commit = observed.stdout.trim().split(/\s+/)[0];
    return { status: commit === expectedCommit ? 'expected' : 'mismatch', commit, remote };
  }
  if (observed.status === 2 || (observed.status === 0 && !observed.stdout.trim())) {
    return { status: 'missing', commit: null, remote };
  }
  return {
    status: observed.blocked ? 'network-disabled' : observed.timedOut ? 'timeout' : 'unavailable',
    commit: null,
    remote
  };
}

/** Observe every ledger pin with one remote round trip instead of one per entry. */
async function remotePinObservations(root, remote, bindings) {
  const results = new Map();
  if (!hasRemote(root, remote)) {
    for (const { pinRef } of bindings) results.set(pinRef, { status: 'unconfigured', commit: null, remote });
    return results;
  }
  const valid = bindings.filter(({ pinRef, expectedCommit }) => validPinBinding(pinRef, expectedCommit));
  if (!valid.length) return results;
  const observed = await runRemoteGitAsync([
    'ls-remote', remote, ...valid.map(({ pinRef }) => pinRef)
  ], { cwd: root, operation: 'remote-probe' });
  if (observed.status !== 0) {
    const status = observed.blocked ? 'network-disabled' : observed.timedOut ? 'timeout' : 'unavailable';
    for (const { pinRef } of valid) results.set(pinRef, { status, commit: null, remote });
    return results;
  }
  const advertised = new Map(observed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((line) => {
      const [commit, ref] = line.split(/\s+/, 2);
      return [ref, commit];
    }));
  for (const { pinRef, expectedCommit } of valid) {
    const commit = advertised.get(pinRef) ?? null;
    results.set(pinRef, {
      status: commit == null ? 'missing' : commit === expectedCommit ? 'expected' : 'mismatch',
      commit, remote
    });
  }
  return results;
}

function expectedCommitAvailable(root, expectedCommit) {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(String(expectedCommit ?? ''))) return false;
  return git(root, ['cat-file', '-e', `${expectedCommit}^{commit}`], { allowFailure: true }).status === 0;
}

function validatePinnedSource(root, entry) {
  const expectedCommit = entry.transport?.publishedCommit;
  if (!expectedCommitAvailable(root, expectedCommit)) {
    return { valid: false, reason: `source commit ${expectedCommit ?? '(missing)'} is unavailable` };
  }
  if (entry.payload?.configSha256 && entry.payload?.configPath) {
    const source = git(root, ['show', `${expectedCommit}:${entry.payload.configPath}`], { allowFailure: true });
    if (source.status !== 0) {
      return { valid: false, reason: `pinned configuration ${entry.payload.configPath} cannot be read` };
    }
    if (sha256(source.stdout) !== entry.payload.configSha256) {
      return { valid: false, reason: `pinned configuration ${entry.payload.configPath} has the wrong hash` };
    }
  }
  return { valid: true, reason: null };
}

/**
 * Fetch one exact pin without allowing a hostile or stale remote ref to replace the local cache.
 *
 * Git's ordinary `+remote:local` refspec updates the local ref before the caller can compare it to
 * the commit recorded by the ledger. Fetching to FETCH_HEAD first makes the comparison possible;
 * only the exact recorded commit is installed, with a compare-and-swap when a local ref exists.
 */
async function fetchExpectedPin(root, remote, pinRef, expectedCommit, observed = null) {
  if (!hasRemote(root, remote)) return { status: 'unconfigured', remote, pinRef };
  if (!validPinBinding(pinRef, expectedCommit)) return { status: 'invalid', remote, pinRef };
  const advertised = observed ?? await remotePinObservation(root, remote, pinRef, expectedCommit);
  if (['mismatch', 'unavailable', 'timeout', 'network-disabled', 'unconfigured'].includes(advertised.status)) {
    return { ...advertised, pinRef };
  }
  const fetched = await runRemoteGitAsync([
    'fetch', '--no-tags', remote, pinRef
  ], { cwd: root, operation: 'remote-configuration' });
  if (fetched.status !== 0) {
    return {
      status: advertised.status === 'missing'
        ? 'missing'
        : fetched.blocked ? 'network-disabled' : fetched.timedOut ? 'timeout' : 'unavailable',
      remote,
      pinRef
    };
  }
  const fetchedCommit = git(root, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], { allowFailure: true });
  const commit = fetchedCommit.status === 0 ? fetchedCommit.stdout.trim() : null;
  if (commit !== expectedCommit) return { status: 'mismatch', remote, pinRef, commit };
  const validation = validatePinnedSource(root, { transport: { publishedCommit: expectedCommit } });
  if (!validation.valid) return { status: 'invalid-source', remote, pinRef, reason: validation.reason };
  const local = localPinObservation(root, pinRef, expectedCommit);
  const args = local.commit
    ? ['update-ref', pinRef, expectedCommit, local.commit]
    : ['update-ref', pinRef, expectedCommit, '0'.repeat(expectedCommit.length)];
  const updated = git(root, args, { allowFailure: true });
  return updated.status === 0
    ? { status: local.status === 'expected' ? 'expected' : 'fetched', remote, pinRef, commit: expectedCommit }
    : { status: 'concurrent-change', remote, pinRef };
}

async function appendOnce(root, config, intent, publishedCommit, {
  env = process.env, transportRemote = undefined
} = {}) {
  const idempotency = ledgerIdempotencyKey(intent, publishedCommit);
  await ensureRemoteBranchFetchedAsync(root, config, { env, transportRemote });
  let ref = ledgerHead(root, config, { env });
  if (!ref) {
    // The fetch above already proved there is no usable state ref locally. Initialization uses an
    // absent-ref lease and joins a concurrent winner, so repeating the same fetch inside init and
    // once again afterwards adds latency without weakening or strengthening the CAS.
    await initializeLedger(root, config, {
      refreshRemote: false, env, transportRemote
    });
    ref = ledgerHead(root, config, { env });
  }
  const expectedRemoteSha = refExistsInEnvironment(root, remoteRef(config), env)
    ? git(root, ['rev-parse', remoteRef(config)], { env }).stdout.trim()
    : null;
  return temporaryWorktree(root, ref, async (worktree) => {
    const duplicate = await eventAlreadyRecorded(worktree, idempotency.hash);
    if (duplicate) {
      return {
        duplicate: true,
        eventId: duplicate.eventId,
        entryHash: duplicate.entryHash,
        sequence: duplicate.sequence,
        ledgerCommit: git(worktree, ['rev-parse', 'HEAD'], { env }).stdout.trim()
      };
    }
    const head = await loadHead(worktree);
    const publishedPin = await publishPinAsync(
      root, config, intent, publishedCommit, { env, transportRemote }
    );
    const entry = entryFromIntent(intent, publishedCommit, idempotency.value);
    entry.transport.pinRef = publishedPin;
    entry.transport.pinTransport = config.pinTransport;
    entry.transport.retentionDays = config.retentionDays;
    entry.parentEntryHash = head.entryHash;
    const location = entryPath(entry);
    const nextHead = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      sequence: Number(head.sequence) + 1,
      entryHash: location.hash,
      previousHeadHash: sha256(canonicalJson(head)),
      updatedAt: nowIso()
    };
    await writeCanonicalJson(path.join(worktree, location.path), entry);
    await writeCanonicalJson(path.join(worktree, idempotencyPath(idempotency.hash)), {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      eventId: intent.eventId,
      idempotencyKey: idempotency.value,
      idempotencyHash: idempotency.hash,
      entryHash: location.hash,
      entryPath: location.path,
      sequence: nextHead.sequence
    });
    await writeCanonicalJson(path.join(worktree, eventPath(intent.eventId)), {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      eventId: intent.eventId,
      idempotencyHash: idempotency.hash,
      entryHash: location.hash,
      sequence: nextHead.sequence
    });
    await writeCanonicalJson(path.join(worktree, HEAD_PATH), nextHead);
    git(worktree, ['add', location.path, idempotencyPath(idempotency.hash), eventPath(intent.eventId), HEAD_PATH], { env });
    git(worktree, commitArgs(config, `[ledger:${nextHead.sequence}] ${intent.eventType} ${intent.subject.workId}`), { env });
    const ledgerCommit = git(worktree, ['rev-parse', 'HEAD'], { env }).stdout.trim();
    if (hasRemoteInEnvironment(root, config.remote, env)) {
      const pushed = await pushLedgerAsync(
        worktree, config, expectedRemoteSha, { env, transportRemote }
      );
      if (pushed.status !== 0) {
        const error = new SingularityFlowError(
          `Concurrent ledger append or push failure. ${pushed.failure?.advice ?? 'Git remote access failed.'} `
          + safeGitDiagnosticReference(pushed, 'Ledger append publication failed'),
          { code: pushed.failure?.code ?? 'REMOTE_UNKNOWN' }
        );
        error.concurrent = true;
        throw error;
      }
    } else {
      git(root, [
        'update-ref', localRef(config), ledgerCommit,
        git(root, ['rev-parse', ref], { env }).stdout.trim()
      ], { env });
    }
    return {
      duplicate: false,
      eventId: intent.eventId,
      entryHash: location.hash,
      sequence: nextHead.sequence,
      ledgerCommit
    };
  }, { env });
}

export async function appendLedgerIntent(root, rawConfig, intent, publishedCommit, {
  env = process.env, transportRemote = undefined
} = {}) {
  const config = normalizeLedgerConfig(rawConfig);
  let lastError;
  for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
    try {
      return await appendOnce(root, config, intent, publishedCommit, { env, transportRemote });
    } catch (error) {
      lastError = error;
      if (!error.concurrent || attempt === config.maxRetries) break;
    }
  }
  throw lastError;
}

/**
 * Put a governed file on the orphan state branch, beside the ledger.
 *
 * Two remote readers prefer state-branch copies over application working trees: the world model in
 * `resolveWorldModelSource` and the organisation capability reader in `readOrganisation`. This
 * writer supplies those current-value projections after their reviewed authorities have changed.
 *
 * The state branch is right for this and the working tree is not. A rebase of the code cannot
 * rewrite an orphan branch, so the governed copy of what an organisation builds and what its model
 * says survives history being rewritten underneath it. This is deliberately not a ledger event:
 * these are files with a current value, not acts with an order, and putting them in the append-only
 * entry chain would make "what does it say now" a replay.
 *
 * Written through an isolated worktree for the same reason the reader extracts rather than checks
 * out — nobody's working tree moves because something was published from it.
 *
 * @param files a map of state-branch-relative path to contents; identical contents commit nothing.
 * @param options.replaceRoots optional state-branch-relative directories whose tracked contents are
 * authoritative mirrors of `files`. Files previously tracked beneath those roots but absent from
 * `files` are removed. `removePaths` names additional exact managed files to retire. No path outside
 * an explicitly named replacement root or exact removal is ever pruned. `exactBlobSha256` maps
 * authority-bearing paths to their reviewed SHA-256; those bytes bypass worktree filters and are
 * verified in the temporary index and commit before any push.
 */
export async function publishToStateBranch(root, rawConfig, files, message, {
  replaceRoots = [], removePaths = [], expectedRemoteSha: suppliedExpectedRemoteSha = undefined,
  baseRef: suppliedBaseRef = null, refreshRemote = true, guardedRemoteRefs = {},
  env = process.env, transportRemote = undefined, exactBlobSha256 = {}
} = {}) {
  const config = normalizeLedgerConfig(rawConfig);
  const sourceGuards = normalizedGuardedRemoteRefs(root, guardedRemoteRefs, { env });
  const safePath = (value) => {
    const original = String(value ?? '').trim();
    const portable = original.replaceAll('\\', '/');
    const normalized = path.posix.normalize(portable).replace(/\/$/, '');
    // A path that climbs out of the branch would write into whatever the temporary worktree's
    // parent happens to be, which on this path is a directory in the system temp folder.
    if (!original || path.isAbsolute(original) || path.win32.isAbsolute(original)
      || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
      throw new SingularityFlowError(`A state-branch path must stay inside the branch: ${value}`);
    }
    return normalized;
  };
  const entries = Object.entries(files ?? {}).filter(([file]) => file)
    .map(([file, contents]) => [safePath(file), contents]);
  if (new Set(entries.map(([file]) => file)).size !== entries.length) {
    throw new SingularityFlowError('State-branch publication contains duplicate normalized paths.');
  }
  const replacementRoots = [...new Set((replaceRoots ?? []).map(safePath))].sort();
  const exactRemovals = [...new Set((removePaths ?? []).map(safePath))].sort();
  if (!exactBlobSha256 || typeof exactBlobSha256 !== 'object'
      || Array.isArray(exactBlobSha256)) {
    throw new SingularityFlowError('Exact state-branch blob expectations must be an object.');
  }
  const exactBlobs = new Map(Object.entries(exactBlobSha256).map(([file, expected]) => {
    const normalized = safePath(file);
    if (!/^sha256:[a-f0-9]{64}$/.test(String(expected ?? ''))) {
      throw new SingularityFlowError(
        `Exact state-branch blob digest for '${normalized}' is invalid.`
      );
    }
    return [normalized, expected];
  }));
  if (exactBlobs.size !== Object.keys(exactBlobSha256).length) {
    throw new SingularityFlowError('State-branch publication contains duplicate exact blob paths.');
  }
  const entryPaths = new Set(entries.map(([file]) => file));
  for (const file of exactBlobs.keys()) {
    if (!entryPaths.has(file)) {
      throw new SingularityFlowError(
        `Exact state-branch blob '${file}' has no matching publication entry.`
      );
    }
  }
  if (!entries.length && !replacementRoots.length && !exactRemovals.length) {
    return { branch: config.branch, commit: null, changed: false, published: [], removed: [] };
  }

  if (refreshRemote) await ensureRemoteBranchFetchedAsync(root, config, { env, transportRemote });
  let ref = ledgerHead(root, config, { env });
  let initializedCommit = null;
  if (!ref) {
    const initialized = await initializeLedger(root, config, {
      env, repairPins: false, transportRemote
    });
    if (suppliedExpectedRemoteSha === null && !initialized.created) {
      const error = new SingularityFlowError(
        `Concurrent publication created the ${config.branch} branch after it was confirmed absent.`,
        {
          code: 'state_branch.concurrent_publication',
          details: { branch: config.branch, expectedRemoteSha: null, observedRemoteSha: initialized.commit }
        }
      );
      error.concurrent = true;
      throw error;
    }
    initializedCommit = initialized.created ? initialized.commit : null;
    await ensureRemoteBranchFetchedAsync(root, config, { env, transportRemote });
    ref = ledgerHead(root, config, { env });
  }
  const expectedRemoteSha = suppliedExpectedRemoteSha !== undefined
    ? suppliedExpectedRemoteSha === null && initializedCommit
      ? initializedCommit
      : suppliedExpectedRemoteSha
    : refExistsInEnvironment(root, remoteRef(config), env)
      ? git(root, ['rev-parse', remoteRef(config)], { env }).stdout.trim()
      : null;
  const publicationBase = suppliedBaseRef ?? ref;
  if (suppliedBaseRef && git(root, ['cat-file', '-e', `${suppliedBaseRef}^{commit}`], { allowFailure: true, env }).status !== 0) {
    throw new SingularityFlowError('The bound state-branch publication base is unavailable locally.', {
      code: 'state_branch.publication_base_unavailable',
      details: { branch: config.branch, expectedRemoteSha }
    });
  }
  const publicationBaseCommit = git(root, ['rev-parse', '--verify', `${publicationBase}^{commit}`], {
    env
  }).stdout.trim();

  return temporaryWorktree(root, publicationBase, async (worktree) => {
    const desired = new Set(entries.map(([file]) => file));
    const removed = new Set(exactRemovals.filter((file) => !desired.has(file)));
    for (const replacementRoot of replacementRoots) {
      const tracked = git(worktree, ['ls-files', '--', replacementRoot], { env }).stdout
        .split(/\r?\n/).map((file) => file.trim()).filter(Boolean);
      for (const file of tracked) {
        if (!desired.has(file)) removed.add(file);
      }
    }
    const removedFiles = [...removed].sort();
    if (removedFiles.length) git(worktree, ['rm', '-f', '--ignore-unmatch', '--', ...removedFiles], { env });
    const ordinaryEntries = entries.filter(([file]) => !exactBlobs.has(file));
    for (const [file, contents] of ordinaryEntries) {
      const target = await safeStateWorktreeTarget(worktree, file, {
        createDirectories: true
      });
      await writeAtomic(target, contents);
    }
    if (ordinaryEntries.length) {
      git(worktree, ['add', '--', ...ordinaryEntries.map(([file]) => file)], { env });
    }
    // Authority-bearing projections must not traverse a checked-out symlink or run a repository
    // clean filter after the person confirmed their bytes. Write the exact bytes as an ordinary
    // Git blob and update only the temporary index; no application/state worktree path is opened.
    for (const [file, contents] of entries.filter(([candidate]) => exactBlobs.has(candidate))) {
      await safeStateWorktreeTarget(worktree, file);
      const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), 'utf8');
      const expected = exactBlobs.get(file);
      if (`sha256:${sha256(bytes)}` !== expected) {
        throw new SingularityFlowError(
          `Exact state-branch blob '${file}' does not match its reviewed digest.`,
          { code: 'state_branch.projection_bytes_changed', details: { path: file } }
        );
      }
      const blob = git(worktree, ['hash-object', '-w', '--no-filters', '--stdin'], {
        env, input: bytes
      }).stdout.trim();
      git(worktree, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], {
        env
      });
      const staged = git(worktree, ['cat-file', 'blob', blob], {
        env, encoding: 'buffer', maxBuffer: bytes.length + 1024
      }).stdout;
      if (!Buffer.isBuffer(staged) || !staged.equals(bytes)) {
        throw new SingularityFlowError(
          `Exact state-branch blob '${file}' changed while it was staged.`,
          { code: 'state_branch.projection_bytes_changed', details: { path: file } }
        );
      }
    }
    // Publishing the same bytes twice is a no-op rather than an empty commit: this runs on every
    // capability edit, and most edits change one file out of several.
    if (!git(worktree, ['diff', '--cached', '--name-only'], { env }).stdout.trim()) {
      if (hasRemoteInEnvironment(root, config.remote, env) && suppliedExpectedRemoteSha !== undefined) {
        const observed = observeRemoteBranch(worktree, config, { env, transportRemote });
        if (observed.status !== 'observed') {
          throw new SingularityFlowError(
            `Unable to verify the ${config.branch} branch before completing a no-op publication. ${observed.detail}`,
            { code: 'state_branch.publication_observation_unavailable', details: { branch: config.branch, expectedRemoteSha } }
          );
        }
        if (observed.commit !== expectedRemoteSha) {
          const error = new SingularityFlowError(
            `Concurrent publication changed the ${config.branch} branch before the candidate was confirmed current.`,
            { code: 'state_branch.concurrent_publication', details: { branch: config.branch, expectedRemoteSha, observedRemoteSha: observed.commit } }
          );
          error.concurrent = true;
          throw error;
        }
      }
      if (hasRemoteInEnvironment(root, config.remote, env)) {
        assertGuardedRemoteRefsCurrent(
          worktree, config, sourceGuards, 'when the unchanged state projection was verified', {
            env, transportRemote
          }
        );
      } else {
        const observedLocalSha = refExistsInEnvironment(root, localRef(config), env)
          ? git(root, ['rev-parse', '--verify', `${localRef(config)}^{commit}`], { env }).stdout.trim()
          : null;
        if (observedLocalSha !== publicationBaseCommit) {
          throw localStateConcurrencyError(config, publicationBaseCommit, observedLocalSha);
        }
      }
      return {
        branch: config.branch,
        commit: suppliedExpectedRemoteSha !== undefined ? publicationBase : null,
        changed: false,
        published: [],
        removed: []
      };
    }
    const actor = env === process.env ? identity(root) : gitCommitIdentity(root, { env });
    git(worktree, ['-c', `user.name=${actor.name || 'Singularity Flow'}`,
      '-c', `user.email=${actor.email || 'unknown@invalid'}`,
      ...commitArgs(config, message)], { env });
    const commit = git(worktree, ['rev-parse', 'HEAD'], { env }).stdout.trim();
    for (const [file, expected] of exactBlobs) {
      const committed = git(worktree, ['show', `${commit}:${file}`], {
        env, encoding: 'buffer'
      }).stdout;
      if (!Buffer.isBuffer(committed) || `sha256:${sha256(committed)}` !== expected) {
        throw new SingularityFlowError(
          `Exact state-branch blob '${file}' changed before publication.`,
          { code: 'state_branch.projection_bytes_changed', details: { path: file } }
        );
      }
    }
    if (hasRemoteInEnvironment(root, config.remote, env)) {
      const pushed = pushLedger(worktree, config, expectedRemoteSha, { env, transportRemote });
      if (pushed.status !== 0) {
        const detail = (pushed.stderr || pushed.stdout).trim();
        const concurrent = isStateBranchConcurrencyFailure(detail);
        const diagnostic = safeGitDiagnosticReference(
          pushed, 'State branch publication was refused'
        );
        const error = new SingularityFlowError(
          `Unable to publish to the ${config.branch} branch. ${diagnostic}`,
          {
            code: concurrent ? 'state_branch.concurrent_publication' : 'state_branch.publication_failed',
            details: {
              branch: config.branch, expectedRemoteSha,
              guardedRefs: Object.keys(guardedRemoteRefs),
              diagnostic
            }
          });
        // Callers that can deterministically rebase an immutable payload may retry. Lifecycle
        // decisions do not use this path and remain fail-fast.
        error.concurrent = concurrent;
        throw error;
      }
      // `git push --atomic <old-source>:<source>` does not guard an unchanged source ref: Git elides
      // the no-op update before receive-pack, so a concurrent source push can land while the state
      // update is accepted. Re-observe after the exact state CAS and fail closed if that happened.
      assertGuardedRemoteRefsCurrent(
        worktree, config, sourceGuards, 'during state publication', { env, transportRemote }
      );
      // The successful compare-and-swap push is an exact observation of the new remote tip. Keep
      // the tracking ref aligned immediately; otherwise authority-first readers can see the
      // initialization commit while the local convenience ref already contains the projection.
      synchronizeRemoteTrackingRefAfterPush(root, config, commit, expectedRemoteSha, env);
      // The local branch follows what was just published. Readers name the branch plainly —
      // `git rev-parse state:singularity/world-model` — so a push that left the local ref behind
      // means the machine that did the publishing is the one that cannot see it. Allowed to fail:
      // if the branch is checked out somewhere, the remote ref still answers.
      synchronizeLocalStateRefAfterRemotePush(root, config, commit, env);
    } else {
      const advanced = git(root, [
        'update-ref', localRef(config), commit, publicationBaseCommit
      ], { allowFailure: true, env });
      if (advanced.status !== 0) {
        const observedLocalSha = refExistsInEnvironment(root, localRef(config), env)
          ? git(root, ['rev-parse', '--verify', `${localRef(config)}^{commit}`], { env }).stdout.trim()
          : null;
        throw localStateConcurrencyError(config, publicationBaseCommit, observedLocalSha);
      }
    }
    return {
      branch: config.branch,
      commit,
      changed: true,
      published: entries.map(([file]) => file),
      removed: removedFiles
    };
  }, { env });
}

function localOutbox(root) {
  return path.join(gitDir(root), 'singularity-flow', 'ledger-outbox');
}

export async function recordLedgerOutbox(root, intentPath, publishedCommit, error) {
  const intent = readRecord('ledger-intent', await readFile(path.join(root, intentPath))).record;
  const file = path.join(localOutbox(root), `${intent.eventId}.json`);
  await writeJson(file, {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    eventId: intent.eventId,
    intentPath,
    publishedCommit,
    error: error?.message ?? String(error),
    recordedAt: nowIso()
  });
  return file;
}

export async function clearLedgerOutbox(root, eventId) {
  await rm(path.join(localOutbox(root), `${eventId}.json`), { force: true });
}

async function findFiles(directory, suffix, output = []) {
  if (!(await exists(directory))) return output;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) await findFiles(candidate, suffix, output);
    else if (entry.isFile() && entry.name.endsWith(suffix)) output.push(candidate);
  }
  return output;
}

export async function discoverLedgerIntents(root) {
  const files = await findFiles(path.join(root, 'singularity'), '.json');
  const marker = `${path.sep}${LEDGER_INTENT_DIRECTORY.split('/').join(path.sep)}${path.sep}`;
  return files.filter((file) => file.includes(marker)).sort();
}

/**
 * Intents published on other branches.
 *
 * `offline` is honoured here rather than only at the caller because this is where the fetch is: the
 * top of `ledgerStatus` guarded the fetch *it* made and then called this, which fetched again with
 * no idea a promise had been made. Read-only callers got two network round trips they had asked not
 * to have, and the disclosure they were handed said nothing about it.
 *
 * Cache-only, not blind: the remote-tracking refs already on disk are read exactly as before, so a
 * warm clone gets the same answer for free. What it does not do is populate them.
 */
async function remoteLedgerIntents(root, config, { offline = false } = {}) {
  if (!offline) {
    await runRemoteGitAsync(['fetch', '--prune', config.remote], {
      cwd: root, operation: 'remote-configuration'
    });
  }
  const refs = git(root, [
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/remotes/${config.remote}`
  ], { allowFailure: true }).stdout.trim().split('\n').filter(Boolean)
    .filter((ref) => ref !== `${config.remote}/HEAD` && ref !== `${config.remote}/${config.branch}`);
  const candidates = [];
  for (const ref of refs) {
    const files = git(root, [
      'ls-tree',
      '-r',
      '--name-only',
      ref,
      'singularity'
    ], { allowFailure: true }).stdout.trim().split('\n').filter(
      (file) => file.includes(`/${LEDGER_INTENT_DIRECTORY}/`) && file.endsWith('.json')
    );
    const published = publishingCommits(root, ref);
    for (const intentPath of files) {
      const content = git(root, ['show', `${ref}:${intentPath}`], { allowFailure: true });
      if (content.status !== 0 || !content.stdout.trim()) continue;
      let intent;
      try {
        intent = readRecord('ledger-intent', content.stdout).record;
      } catch (error) {
        if (String(error?.code ?? '').startsWith('SCHEMA_')) throw error;
        continue;
      }
      candidates.push({ intent, intentPath, publishedCommit: published.get(intentPath) ?? null, source: ref });
    }
  }
  return candidates;
}

/**
 * The commit that last touched each intent file on a ref, in one history walk.
 *
 * This was `git log -1 --format=%H <ref> -- <path>`, once per intent file. On a real repository
 * that is 420 subprocesses inside a *read* — measured, and the largest remaining share of the
 * snapshot after the fetches came out. The cost is not the history walk, which Git does quickly; it
 * is spawning 420 processes to walk the same history 420 times.
 *
 * `--name-only` reports the paths each commit touched, newest first, so one pass answers every
 * path. First mention wins: that is the newest commit touching it, which is exactly what `log -1`
 * returned per path.
 *
 * Scoped to the intent directory so the walk skips commits that touched nothing relevant, and
 * `allowFailure` because a ref that cannot be read is a missing fact rather than a broken read —
 * callers already treat a null publishing commit as "not published from here".
 */
function publishingCommits(root, ref) {
  const walked = git(root, [
    'log', '--format=%H', '--name-only', ref, '--', 'singularity'
  ], { allowFailure: true });
  const commits = new Map();
  if (walked.status !== 0) return commits;

  let commit = null;
  for (const line of walked.stdout.split('\n')) {
    const value = line.trim();
    if (!value) continue;
    if (/^[0-9a-f]{40}$/.test(value)) { commit = value; continue; }
    // First mention wins: `git log` is newest-first, so this is the same answer `-1` gave.
    if (commit && !commits.has(value)) commits.set(value, commit);
  }
  return commits;
}

async function allLedgerIntents(root, config, { offline = false } = {}) {
  const candidates = [];
  /**
   * One history walk for every working-tree intent, not one per file.
   *
   * `publishingCommits` was written for exactly this — its own note explains that `log -1` per path
   * was 420 subprocesses inside a read — and then it was wired into the *remote* branch loop only.
   * The working-tree loop kept calling `commitContaining` per file: 127 processes walking the same
   * history 127 times, the largest single row in the probe once the fetches came out.
   *
   * The answers are identical by construction. `log --name-only` is newest-first and first mention
   * wins, which is what `log -1` returned for each path; both are scoped to `singularity`, which is
   * where intents live.
   */
  const published = publishingCommits(root, 'HEAD');
  for (const file of await discoverLedgerIntents(root)) {
    const intentPath = path.relative(root, file).split(path.sep).join('/');
    candidates.push({
      intent: readRecord('ledger-intent', await readFile(file)).record,
      intentPath,
      publishedCommit: published.get(intentPath) ?? null,
      source: 'working-tree'
    });
  }
  candidates.push(...await remoteLedgerIntents(root, config, { offline }));
  const unique = new Map();
  for (const candidate of candidates) {
    const current = unique.get(candidate.intent.eventId);
    if (!current || (!current.publishedCommit && candidate.publishedCommit)) {
      unique.set(candidate.intent.eventId, candidate);
    }
  }
  return [...unique.values()].sort((left, right) => left.intent.eventId.localeCompare(right.intent.eventId));
}

export async function reconcileLedger(root, rawConfig, { workId = null } = {}) {
  const config = normalizeLedgerConfig(rawConfig);
  if (!config.enabled) return { enabled: false, appended: [], existing: [], failed: [] };
  const appended = [], existing = [], failed = [];
  for (const candidate of await allLedgerIntents(root, config)) {
    const { intent, intentPath, publishedCommit } = candidate;
    if (workId && intent.subject?.workId !== workId) continue;
    if (!publishedCommit) {
      failed.push({ eventId: intent.eventId, intentPath, error: 'Intent has not been committed.' });
      continue;
    }
    try {
      const result = await appendLedgerIntent(root, config, intent, publishedCommit);
      (result.duplicate ? existing : appended).push(result);
      await clearLedgerOutbox(root, intent.eventId);
    } catch (error) {
      if (candidate.source === 'working-tree') {
        await recordLedgerOutbox(root, intentPath, publishedCommit, error);
      }
      failed.push({ eventId: intent.eventId, intentPath, source: candidate.source, error: error.message });
      if (config.behind === 'block') break;
    }
  }
  return { enabled: true, appended, existing, failed };
}

/**
 * `offline` rather than `fetch`, so the two spellings of one decision stop drifting apart.
 *
 * `verifyLedger` was passing `{ fetch: !offline }` and `ledgerLog` was passing nothing at all —
 * which defaulted to fetching, from inside a `ledgerStatus` the caller had explicitly asked to stay
 * offline. One name for the flag, expressed the way every caller already expresses it, is what
 * stops the next helper defaulting the other way.
 */
/**
 * Every blob under a prefix of a ref, in two subprocesses and without touching the disk.
 * `[UXH:REQ-120]` `[DHR:REQ-093]`
 *
 * The three read-only ledger queries — verify, log, show — each materialised a **temporary
 * worktree** to read a handful of JSON files: `git worktree add`, then `git worktree remove` and
 * `git branch -D` on the way out, plus an `mkdtemp` and a recursive delete. Measured at 312 ms of a
 * 2.2 s snapshot once the fetches and the triple read were gone, and the cost is the smaller half
 * of the objection.
 *
 * The larger half is that **a read was writing to the repository**. `worktree add` records an entry
 * under `.git/worktrees`, takes the index lock, and creates a branch that `branch -D` then deletes;
 * an interrupted read leaves that debris behind, and two concurrent reads contend for the lock. A
 * command that only answers questions should not be able to do any of that.
 *
 * `ls-tree` lists the blobs, `cat-file --batch` reads all of them in one process — its work list
 * arrives on stdin, which is why `run()` grew an `input` option. Output is taken as **bytes**: the
 * format is a header line followed by exactly `size` bytes of content, and walking that as a string
 * is right only until an entry contains a character outside ASCII.
 *
 * The implementation now lives in `git-ref-tree.mjs`, because the subject index needed the same two
 * subprocesses for the same reason — it was running `git show` once per work item per ref — and a
 * second copy of a byte-offset walk is a second place for it to be subtly wrong. This wrapper keeps
 * the single-prefix call shape the queries below already use.
 */
const readRefTree = (root, ref, prefix) => readRefTreeShared(root, ref, [prefix]);

/** One file from a ref, or null when the ref does not carry it. */
function readRefFile(root, ref, file) {
  const shown = git(root, ['show', `${ref}:${file}`], { allowFailure: true });
  return shown.status === 0 ? shown.stdout : null;
}

/**
 * The read-only half of `ledgerSnapshot`: a ref, read directly.
 *
 * Writers keep `temporaryWorktree`, which they genuinely need — they commit. Readers never did.
 */
async function ledgerRefSnapshot(root, config, callback, { offline = false } = {}) {
  await ensureRemoteBranchFetchedAsync(root, config, { offline });
  const ref = ledgerHead(root, config);
  if (!ref) throw new SingularityFlowError(`Ledger branch '${config.branch}' does not exist. Run singularity-flow ledger init.`);
  const head = readRefFile(root, ref, HEAD_PATH);
  if (head === null) throw new SingularityFlowError(`Ledger branch is missing ${HEAD_PATH}.`);
  /**
   * Each prefix is read at most once per snapshot.
   *
   * `verifyLedger` wants `ledger/entries` and `ledger/idempotency`, and asks whether individual
   * idempotency files exist — which is a question the tree it already read can answer, rather than
   * one `git show` per entry. That per-entry loop is what a worktree made invisible: on a checkout
   * an `exists()` call is free, so nothing objected to one per entry, and the cost only appears
   * when the checkout does.
   */
  const trees = new Map();
  const tree = (prefix) => {
    if (!trees.has(prefix)) trees.set(prefix, readRefTree(root, ref, prefix));
    return trees.get(prefix);
  };
  return callback({
    ref,
    head: readRecord('ledger-entry', head).record,
    /** `path -> contents`, keyed by the path as it appears in the tree. */
    tree,
    has: (relative) => tree(path.posix.dirname(relative)).has(relative),
    file: (relative) => readRefFile(root, ref, relative)
  });
}

export async function verifyLedger(root, rawConfig, { offline = false } = {}) {
  const config = normalizeLedgerConfig(rawConfig);
  return ledgerRefSnapshot(root, config, async (snapshot) => {
    const errors = [], warnings = [], pinDiagnostics = [];
    const { head } = snapshot;
    const entries = new Map();
    for (const [file, contents] of snapshot.tree('ledger/entries')) {
      if (!file.endsWith('.json')) continue;
      const entry = readRecord('ledger-entry', contents).record;
      const actual = sha256(canonicalJson(entry));
      const expected = path.posix.basename(file, '.json');
      if (actual !== expected) errors.push(`Entry hash mismatch: ${file}`);
      if (entries.has(actual)) errors.push(`Duplicate entry hash: ${actual}`);
      entries.set(actual, entry);
    }
    let cursor = head.entryHash;
    let count = 0;
    const visited = new Set();
    while (cursor) {
      if (visited.has(cursor)) { errors.push(`Ledger chain contains a cycle at ${cursor}.`); break; }
      visited.add(cursor);
      const entry = entries.get(cursor);
      if (!entry) { errors.push(`Ledger head references missing entry ${cursor}.`); break; }
      count += 1;
      cursor = entry.parentEntryHash;
    }
    if (count !== Number(head.sequence)) errors.push(`Ledger sequence is ${head.sequence}, but the reachable chain contains ${count} entries.`);
    if (visited.size !== entries.size) warnings.push(`${entries.size - visited.size} unreferenced ledger entr${entries.size - visited.size === 1 ? 'y' : 'ies'} exist.`);
    for (const [file, contents] of snapshot.tree('ledger/idempotency')) {
      if (!file.endsWith('.json')) continue;
      const index = readRecord('ledger-entry', contents).record;
      if (!entries.has(index.entryHash)) errors.push(`Idempotency index ${index.eventId} references missing entry ${index.entryHash}.`);
    }
    const retentionExpired = new Set();
    for (const entry of entries.values()) {
      if (entry.eventType !== 'retention-expired') continue;
      if (entry.payload?.entryHash) retentionExpired.add(entry.payload.entryHash);
      if (entry.payload?.pinRef) retentionExpired.add(entry.payload.pinRef);
    }
    const pinBindings = [...entries.values()]
      .filter((entry) => entry.transport?.pinRef)
      .map((entry) => ({
        pinRef: entry.transport.pinRef,
        expectedCommit: entry.transport.publishedCommit
      }));
    const remotePins = offline
      ? new Map()
      : await remotePinObservations(root, config.remote, pinBindings);
    for (const [hash, entry] of entries) {
      const expected = ledgerIdempotencyKey(entry, entry.transport?.publishedCommit);
      if (entry.idempotencyKey !== expected.value) errors.push(`Entry ${hash} has an invalid idempotency key.`);
      if (!snapshot.has(idempotencyPath(expected.hash))) {
        errors.push(`Entry ${hash} is missing its idempotency index.`);
      }
      if (entry.transport?.pinRef) {
        const pinRef = entry.transport.pinRef;
        const expectedCommit = entry.transport.publishedCommit;
        const bindingValid = validPinBinding(pinRef, expectedCommit);
        const localBefore = bindingValid ? localPinObservation(root, pinRef, expectedCommit) : { status: 'invalid' };
        const remoteObserved = remotePins.get(pinRef) ?? null;
        const fetched = offline
          ? { status: 'not-checked', remote: config.remote, pinRef }
          : remoteObserved?.status === 'expected' && localBefore.status === 'expected'
              && expectedCommitAvailable(root, expectedCommit)
            ? { ...remoteObserved, pinRef }
            : await fetchExpectedPin(root, config.remote, pinRef, expectedCommit, remoteObserved);
        const pinned = bindingValid
          ? git(root, ['rev-parse', `${entry.transport.pinRef}^{commit}`], { allowFailure: true })
          : { status: 1, stdout: '' };
        const localStatus = pinned.status !== 0
          ? 'missing'
          : pinned.stdout.trim() === expectedCommit ? 'expected' : 'mismatch';
        pinDiagnostics.push({
          entryHash: hash,
          pinRef,
          expectedCommit,
          remote: config.remote,
          fetchStatus: fetched.status,
          localStatus
        });
        if (!bindingValid) {
          errors.push(`Entry ${hash} contains an invalid source-pin ref or commit binding.`);
        } else if (pinned.status !== 0 && (retentionExpired.has(hash) || retentionExpired.has(entry.transport.pinRef))) {
          warnings.push(`Entry ${hash} source pin is retention-expired.`);
        } else if (pinned.status !== 0) {
          const reason = fetched.status === 'missing'
            ? `${config.remote} does not advertise the recorded ref`
            : fetched.status === 'network-disabled'
              ? 'network access is disabled'
              : fetched.status === 'timeout'
                ? `${config.remote} timed out`
                : fetched.status === 'unavailable'
                  ? `${config.remote} is unavailable or denied access`
                  : fetched.status === 'unconfigured'
                    ? `${config.remote} is not configured`
                    : offline ? 'the local cache has no copy and remote checks were skipped' : 'the ref could not be fetched';
          errors.push(`Entry ${hash} pin ${entry.transport.pinRef} is not reachable: ${reason}. Run singularity-flow ledger repair --dry-run.`);
        } else if (fetched.status === 'mismatch') {
          errors.push(`Entry ${hash} remote pin ${entry.transport.pinRef} does not match source commit ${expectedCommit}. Refusing to overwrite it.`);
        }
        else if (pinned.stdout.trim() !== entry.transport.publishedCommit) {
          errors.push(`Entry ${hash} pin does not match source commit ${entry.transport.publishedCommit}.`);
        } else if (!offline && fetched.status === 'missing'
          && (retentionExpired.has(hash) || retentionExpired.has(entry.transport.pinRef))) {
          warnings.push(`Entry ${hash} source pin is retention-expired on ${config.remote}.`);
        } else if (!offline && fetched.status === 'missing') {
          errors.push(`Entry ${hash} remote pin ${entry.transport.pinRef} is missing from ${config.remote}. Run singularity-flow ledger repair --restore-remote --dry-run.`);
        } else if (!offline && ['unavailable', 'timeout', 'network-disabled', 'unconfigured'].includes(fetched.status)) {
          warnings.push(`Entry ${hash} verified from the local pin cache, but ${config.remote} did not confirm ${entry.transport.pinRef} (${fetched.status}).`);
        }
      } else if (config.pinTransport !== 'none') {
        errors.push(`Entry ${hash} has no source pin.`);
      }
      if (entry.payload?.configSha256 && entry.payload?.configPath) {
        const configAtSource = git(root, [
          'show',
          `${entry.transport.publishedCommit}:${entry.payload.configPath}`
        ], { allowFailure: true });
        if (configAtSource.status !== 0) {
          errors.push(`Entry ${hash} cannot read pinned configuration ${entry.payload.configPath}.`);
        } else if (sha256(configAtSource.stdout) !== entry.payload.configSha256) {
          errors.push(`Entry ${hash} pinned configuration hash does not match ${entry.payload.configPath}.`);
        }
      }
    }
    if (config.signing === 'commit') {
      // Fail closed. A failed `rev-list` used to yield an empty list, so the loop verified nothing
      // and the ledger still reported `valid: true` — "every commit is signature-verified" and "we
      // could not check" produced the same green answer for the trust tier that most depends on the
      // difference.
      const listed = git(root, ['rev-list', '--reverse', snapshot.ref], { allowFailure: true });
      const commits = listed.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      if (listed.status !== 0) {
        errors.push(`Ledger commits could not be enumerated for signature verification: ${(listed.stderr || listed.stdout).trim().split('\n')[0] || 'rev-list failed'}.`);
      } else if (!commits.length) {
        errors.push('Ledger signing is required but the branch has no commits to verify.');
      }
      for (const commit of commits) {
        const verified = git(root, ['verify-commit', commit], { allowFailure: true });
        if (verified.status !== 0) errors.push(`Ledger commit ${commit} signature could not be verified.`);
      }
    }
    return {
      valid: errors.length === 0,
      branch: config.branch,
      trustTier: config.trustTier,
      sequence: Number(head.sequence),
      headEntryHash: head.entryHash,
      entries: entries.size,
      retentionExpired: retentionExpired.size,
      pinDiagnostics,
      errors,
      warnings
    };
  }, { offline });
}

function installLocalPin(root, entry) {
  const pinRef = entry.transport?.pinRef;
  const expectedCommit = entry.transport?.publishedCommit;
  if (!validPinBinding(pinRef, expectedCommit)) return { status: 'invalid', pinRef };
  const validation = validatePinnedSource(root, entry);
  if (!validation.valid) return { status: 'invalid-source', pinRef, reason: validation.reason };
  const local = localPinObservation(root, pinRef, expectedCommit);
  if (local.status === 'expected') return { status: 'expected', pinRef, commit: expectedCommit };
  const args = local.commit
    ? ['update-ref', pinRef, expectedCommit, local.commit]
    : ['update-ref', pinRef, expectedCommit, '0'.repeat(expectedCommit.length)];
  const updated = git(root, args, { allowFailure: true });
  return updated.status === 0
    ? { status: 'installed', pinRef, commit: expectedCommit }
    : { status: 'concurrent-change', pinRef };
}

function pinRepairPlanHash({ remote, sourceRemote, restorations }) {
  return sha256(canonicalJson({
    schemaVersion: 1,
    operation: 'ledger.pin-repair',
    remote,
    sourceRemote,
    restorations: restorations.map(({ pinRef, expectedCommit }) => ({ pinRef, expectedCommit }))
  }));
}

/**
 * Repair source-pin reachability without weakening the ledger's trust boundary.
 *
 * Local Git configuration, object fetches and cache refs are safe to repair automatically because
 * they are derived from the content-addressed ledger. Publishing a missing remote ref is not: that
 * requires an exact, hash-bound confirmation and a dry-run push of only the recorded refspecs.
 */
export async function repairLedgerPins(root, rawConfig, {
  sourceRemote = null,
  dryRun = false,
  restoreRemote = false,
  confirmation = null
} = {}) {
  const config = normalizeLedgerConfig(rawConfig);
  if (!config.enabled) {
    throw new SingularityFlowError('The capability ledger is disabled; there are no governed source pins to repair.', {
      code: 'LEDGER_DISABLED'
    });
  }
  const remote = validRemoteName(root, config.remote, { configured: false });
  const alternate = sourceRemote == null ? null : validRemoteName(root, sourceRemote);
  if (alternate === remote) {
    throw new SingularityFlowError('--source-remote must name a different configured remote.', {
      code: 'LEDGER_PIN_SOURCE_REMOTE_INVALID'
    });
  }
  if (dryRun && confirmation != null) {
    throw new SingularityFlowError('ledger repair --dry-run does not accept --confirm. Review the preview first.', {
      code: 'LEDGER_PIN_REPAIR_PREVIEW_ONLY'
    });
  }

  const records = await ledgerRefSnapshot(root, config, async (snapshot) => {
    const parsed = [...snapshot.tree('ledger/entries')]
      .filter(([file]) => file.endsWith('.json'))
      .map(([file, contents]) => ({ entryHash: path.posix.basename(file, '.json'), entry: readRecord('ledger-entry', contents).record }));
    const expired = new Set();
    for (const { entry } of parsed) {
      if (entry.eventType !== 'retention-expired') continue;
      if (entry.payload?.entryHash) expired.add(entry.payload.entryHash);
      if (entry.payload?.pinRef) expired.add(entry.payload.pinRef);
    }
    return parsed.filter(({ entry }) => Boolean(entry.transport?.pinRef))
      .map((record) => ({
        ...record,
        retentionExpired: expired.has(record.entryHash) || expired.has(record.entry.transport.pinRef)
      }))
      .sort((left, right) => left.entry.transport.pinRef.localeCompare(right.entry.transport.pinRef));
  });

  const pinBindings = records.map(({ entry }) => ({
    pinRef: entry.transport.pinRef,
    expectedCommit: entry.transport.publishedCommit
  }));
  const targetObservations = await remotePinObservations(root, remote, pinBindings);
  const sourceObservations = alternate
    ? await remotePinObservations(root, alternate, pinBindings)
    : new Map();
  const pins = records.map(({ entryHash, entry, retentionExpired }) => {
    const pinRef = entry.transport.pinRef;
    const expectedCommit = entry.transport.publishedCommit;
    const bindingValid = validPinBinding(pinRef, expectedCommit);
    const local = localPinObservation(root, pinRef, expectedCommit);
    const target = bindingValid
      ? targetObservations.get(pinRef)
      : { status: 'invalid', commit: null, remote };
    const source = alternate && bindingValid
      ? sourceObservations.get(pinRef)
      : null;
    const sourceObject = expectedCommitAvailable(root, expectedCommit);
    const recoverable = bindingValid && (
      sourceObject || target.status === 'expected' || source?.status === 'expected'
    );
    const restoreCandidate = !retentionExpired && target.status === 'missing' && recoverable;
    return {
      entryHash,
      pinRef,
      expectedCommit,
      local,
      remote: target,
      sourceRemote: source,
      sourceObject,
      recoverable,
      retentionExpired,
      restoreCandidate
    };
  });
  const restorations = pins.filter((pin) => pin.restoreCandidate)
    .map(({ entryHash, pinRef, expectedCommit }) => ({ entryHash, pinRef, expectedCommit }));
  const planHash = pinRepairPlanHash({ remote, sourceRemote: alternate, restorations });
  const expectedConfirmation = `RESTORE LEDGER PINS ${planHash}`;

  if (restoreRemote && !dryRun && confirmation !== expectedConfirmation) {
    throw new SingularityFlowError(
      `Remote ledger-pin restoration requires the exact confirmation '${expectedConfirmation}'. Run ledger repair --restore-remote --dry-run first.`,
      {
        code: 'LEDGER_PIN_RESTORE_CONFIRMATION_REQUIRED',
        details: { planHash, expectedConfirmation, remote, restorations }
      }
    );
  }
  if (restoreRemote && !dryRun) {
    const mismatch = pins.find((pin) => !pin.retentionExpired && pin.remote.status === 'mismatch');
    if (mismatch) {
      throw new SingularityFlowError(
        `Refusing remote repair for ${mismatch.pinRef}: ${remote} already points at a different commit. No ref was changed.`,
        { code: 'LEDGER_PIN_REMOTE_MISMATCH', details: { pinRef: mismatch.pinRef, expectedCommit: mismatch.expectedCommit } }
      );
    }
    const unavailable = pins.find((pin) => !pin.retentionExpired
      && ['unavailable', 'timeout', 'network-disabled', 'unconfigured'].includes(pin.remote.status));
    if (unavailable) {
      throw new SingularityFlowError(
        `Refusing remote repair for ${unavailable.pinRef}: ${remote} reports ${unavailable.remote.status}. No ref was changed.`,
        { code: 'LEDGER_PIN_REMOTE_UNAVAILABLE', details: { pinRef: unavailable.pinRef, status: unavailable.remote.status } }
      );
    }
    const unproven = pins.find((pin) => !pin.retentionExpired && pin.remote.status === 'missing' && !pin.recoverable);
    if (unproven) {
      throw new SingularityFlowError(
        `Refusing remote repair for ${unproven.pinRef}: the exact recorded source commit is unavailable. No ref was changed.`,
        { code: 'LEDGER_PIN_SOURCE_UNPROVEN', details: { pinRef: unproven.pinRef, expectedCommit: unproven.expectedCommit } }
      );
    }
  }

  const result = {
    schemaVersion: 1,
    operation: 'ledger.pin-repair',
    mode: restoreRemote ? 'restore-remote' : 'local',
    dryRun: Boolean(dryRun),
    remote,
    sourceRemote: alternate,
    planHash,
    confirmation: expectedConfirmation,
    refspec: pinRefspecStatus(root, config),
    pins,
    localActions: [],
    restored: [],
    unresolved: [],
    verification: null,
    valid: false
  };
  if (dryRun) {
    result.unresolved = pins.filter((pin) => !pin.retentionExpired && pin.remote.status !== 'expected')
      .map((pin) => ({ pinRef: pin.pinRef, status: pin.remote.status, recoverable: pin.recoverable }));
    result.valid = result.unresolved.length === 0;
    return result;
  }

  const installedRefspec = installPinRefspec(root, config);
  result.refspec = { ...pinRefspecStatus(root, config), installed: installedRefspec };
  for (const record of records) {
    const { entry } = record;
    const pinRef = entry.transport.pinRef;
    const expectedCommit = entry.transport.publishedCommit;
    if (record.retentionExpired && localPinObservation(root, pinRef, expectedCommit).status === 'missing') {
      result.localActions.push({ entryHash: record.entryHash, pinRef, status: 'retention-expired' });
      continue;
    }
    let action = localPinObservation(root, pinRef, expectedCommit);
    if (action.status !== 'expected') {
      const target = await fetchExpectedPin(root, remote, pinRef, expectedCommit);
      action = target.status === 'fetched' || target.status === 'expected'
        ? target
        : alternate ? await fetchExpectedPin(root, alternate, pinRef, expectedCommit) : target;
    }
    if (!['fetched', 'expected'].includes(action.status) && expectedCommitAvailable(root, expectedCommit)) {
      action = installLocalPin(root, entry);
    }
    result.localActions.push({ entryHash: record.entryHash, pinRef, status: action.status });
  }

  if (restoreRemote) {
    const toPush = [];
    for (const restoration of restorations) {
      const record = records.find((candidate) => candidate.entryHash === restoration.entryHash);
      let target = await remotePinObservation(root, remote, restoration.pinRef, restoration.expectedCommit);
      // Some hosts permit exact fetches while hiding custom refs from ls-remote. Prove that case
      // before treating an advertised absence as permission to create the ref.
      if (target.status === 'missing') {
        const fetched = await fetchExpectedPin(root, remote, restoration.pinRef, restoration.expectedCommit);
        if (['fetched', 'expected'].includes(fetched.status)) target = { status: 'expected', commit: restoration.expectedCommit, remote };
      }
      if (target.status === 'expected') continue;
      if (target.status !== 'missing') {
        throw new SingularityFlowError(
          `Refusing remote repair for ${restoration.pinRef}: ${remote} reports ${target.status}. No remote ref was changed.`,
          { code: target.status === 'mismatch' ? 'LEDGER_PIN_REMOTE_MISMATCH' : 'LEDGER_PIN_REMOTE_UNAVAILABLE' }
        );
      }
      const local = installLocalPin(root, record.entry);
      if (!['installed', 'expected'].includes(local.status)) {
        throw new SingularityFlowError(
          `Refusing remote repair for ${restoration.pinRef}: the exact recorded source could not be proven (${local.reason ?? local.status}).`,
          { code: 'LEDGER_PIN_SOURCE_UNPROVEN' }
        );
      }
      toPush.push(restoration);
    }
    if (toPush.length) {
      const refspecs = toPush.map((item) => `${item.expectedCommit}:${item.pinRef}`);
      const atomic = toPush.length > 1 ? ['--atomic'] : [];
      const preflight = await runRemoteGitAsync([
        'push', '--dry-run', ...atomic, remote, ...refspecs
      ], { cwd: root, operation: 'remote-push' });
      if (preflight.status !== 0) {
        throw new SingularityFlowError(
          `Ledger pin restoration preflight was refused by ${remote}; no remote ref was changed.`,
          { code: 'LEDGER_PIN_RESTORE_PREFLIGHT_FAILED' }
        );
      }
      const pushed = await runRemoteGitAsync([
        'push', ...atomic, remote, ...refspecs
      ], { cwd: root, operation: 'remote-push' });
      if (pushed.status !== 0) {
        throw new SingularityFlowError(
          `Ledger pin restoration failed after preflight. Re-run the preview; no force push was attempted.`,
          { code: 'LEDGER_PIN_RESTORE_FAILED' }
        );
      }
      result.restored = toPush.map((item) => ({ pinRef: item.pinRef, commit: item.expectedCommit, remote }));
    }
  }

  result.verification = await verifyLedger(root, config);
  const verifiedPins = await remotePinObservations(root, remote, pinBindings);
  result.unresolved = pins.filter((pin) => !pin.retentionExpired).map((pin) => ({
    pinRef: pin.pinRef,
    observation: verifiedPins.get(pin.pinRef)
  })).filter((item) => item.observation.status !== 'expected')
    .map((item) => ({ pinRef: item.pinRef, status: item.observation.status }));
  result.valid = result.verification.valid && result.unresolved.length === 0;
  return result;
}

export async function ledgerLog(root, rawConfig, { limit = 20, offline = false } = {}) {
  const config = normalizeLedgerConfig(rawConfig);
  return ledgerRefSnapshot(root, config, async (snapshot) => {
    const { head } = snapshot;
    const entries = new Map();
    for (const [file, contents] of snapshot.tree('ledger/entries')) {
      if (!file.endsWith('.json')) continue;
      entries.set(path.posix.basename(file, '.json'), readRecord('ledger-entry', contents).record);
    }
    const output = [];
    let cursor = head.entryHash;
    while (cursor && output.length < limit) {
      const entry = entries.get(cursor);
      if (!entry) break;
      output.push({ hash: cursor, ...entry });
      cursor = entry.parentEntryHash;
    }
    return output;
  }, { offline });
}

export async function ledgerShow(root, rawConfig, hashOrEventId) {
  const config = normalizeLedgerConfig(rawConfig);
  return ledgerRefSnapshot(root, config, async (snapshot) => {
    const index = snapshot.file(eventPath(hashOrEventId));
    const hash = index === null ? hashOrEventId : readRecord('ledger-entry', index).record.entryHash;
    // The entry lives under a capability directory, so the name is matched rather than the path.
    const found = [...snapshot.tree('ledger/entries')]
      .find(([file]) => path.posix.basename(file) === `${hash}.json`);
    if (!found) throw new SingularityFlowError(`Ledger entry or event '${hashOrEventId}' was not found.`);
    return { hash, entry: readRecord('ledger-entry', found[1]).record };
  });
}

/**
 * The ledger as it stands, computed once per read scope. `[UXH:REQ-120]`
 *
 * Three callers inside one `snapshot --json` ask for this: `fullRepositorySnapshot` directly, and
 * `doctorSnapshot` twice. None of them is wrong to ask, and none of them can see the others — which
 * is exactly the situation a scope is for. Measured on a real repository, the three reads were most
 * of what was left after the fetches came out.
 *
 * Keyed on everything that changes the answer: the repository, the resolved config, and whether the
 * remote was consulted. Keying on `root` alone would serve a cached-offline answer to a caller that
 * asked to go to the network, which is the failure mode a cache like this exists to avoid.
 *
 * Outside a scope this is a plain call, so writers are untouched.
 */
export async function ledgerStatus(root, rawConfig, { offline = false } = {}) {
  const config = normalizeLedgerConfig(rawConfig);
  const key = `ledger.status:${root}:${offline ? 'offline' : 'online'}:${canonicalJson(config)}`;
  return scopedRead(key, () => ledgerStatusUncached(root, config, { offline }));
}

async function ledgerStatusUncached(root, config, { offline }) {
  if (!config.enabled) return { enabled: false, config };
  /**
   * One fetch decision for the whole call, and it is reported rather than assumed. `[UXH:REQ-120]`
   *
   * This line used to be `if (!offline) ensureRemoteBranchFetched(...)`, which is correct about
   * itself and was the entire extent of the promise: `allLedgerIntents` and `ledgerLog` below both
   * fetched on their own, having never been told. A read path that asked for offline got two
   * network round trips anyway — 4.5 seconds of a 12-second snapshot, on every refresh the editor
   * makes — and nothing in the result said so.
   *
   * Threading it is half the fix. The other half is `remoteView`: a cached answer and a fresh one
   * are different facts, and a reader who cannot tell them apart is being handed the second when
   * they have the first.
   */
  const remoteView = await ensureRemoteBranchFetchedAsync(root, config, { offline });
  const ref = ledgerHead(root, config);
  const outbox = (await exists(localOutbox(root)))
    ? (await readdir(localOutbox(root))).filter((name) => name.endsWith('.json')).length
    : 0;
  // The one refresh above already established the remote view for this status snapshot. Every
  // nested read is cache-only so status cannot multiply office-network latency by the number of
  // projections it composes.
  const intents = await allLedgerIntents(root, config, { offline: true });
  if (!ref) return { enabled: true, initialized: false, outbox, durableIntents: intents.length, remoteView, config };
  const verification = await verifyLedger(root, config, { offline: true });
  const log = await ledgerLog(root, config, { limit: 1000000, offline: true });
  const recorded = new Set(log.map((entry) => entry.eventId));
  const pending = [];
  for (const candidate of intents) {
    const { intent } = candidate;
    if (!recorded.has(intent.eventId)) {
      pending.push({
        eventId: intent.eventId,
        workId: intent.subject?.workId,
        path: candidate.intentPath,
        source: candidate.source
      });
    }
  }
  return {
    enabled: true,
    initialized: true,
    outbox,
    durableIntents: intents.length,
    pending,
    verification,
    /** Which of `LEDGER_REMOTE_VIEW` produced this answer. Never absent, so it cannot be assumed. */
    remoteView,
    config
  };
}
