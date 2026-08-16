import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SingularityFlowError, ensureDir, exists, nowIso, readJson, run, writeAtomic, writeJson
} from './util.mjs';
import { scopedRead } from './read-scope.mjs';
import { defaultBranchName, gitDir, hasRemote, identity, refExists } from './git.mjs';
import { normalizeLedgerConfig } from './ledger-config.mjs';
import { LIFECYCLE_EVENT_TYPES } from './lifecycle-event.mjs';

export const LEDGER_SCHEMA_VERSION = 1;
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

function git(root, args, { allowFailure = false, stdio = 'pipe' } = {}) {
  return run('git', args, { cwd: root, allowFailure, stdio });
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

function ledgerHead(root, config) {
  const remote = remoteRef(config);
  if (refExists(root, remote)) return remote;
  if (refExists(root, localRef(config))) return localRef(config);
  return null;
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
function ensureRemoteBranchFetched(root, config, { offline = false } = {}) {
  if (!hasRemote(root, config.remote)) return LEDGER_REMOTE_VIEW.NO_REMOTE;
  if (offline) return LEDGER_REMOTE_VIEW.NOT_CHECKED;
  const fetched = git(root, ['fetch', '--no-tags', config.remote, `+refs/heads/${config.branch}:${remoteRef(config)}`], { allowFailure: true });
  if (fetched.status === 0) return LEDGER_REMOTE_VIEW.REFRESHED;
  return fetched.timedOut ? LEDGER_REMOTE_VIEW.TIMEOUT_CACHED : LEDGER_REMOTE_VIEW.OFFLINE_CACHED;
}

function installPinRefspec(root, config) {
  if (config.pinTransport !== 'refs' || !hasRemote(root, config.remote)) return false;
  const refspec = '+refs/singularity/pins/*:refs/singularity/pins/*';
  const configured = git(root, ['config', '--get-all', `remote.${config.remote}.fetch`], { allowFailure: true })
    .stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (configured.includes(refspec)) return false;
  git(root, ['config', '--add', `remote.${config.remote}.fetch`, refspec]);
  return true;
}

async function temporaryWorktree(root, ref, callback) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-ledger-'));
  const worktree = path.join(parent, 'worktree');
  const args = ref
    ? ['worktree', 'add', '--detach', worktree, ref]
    : ['worktree', 'add', '--orphan', '-b', '__sflow_ledger_bootstrap__', worktree];
  const added = git(root, args, { allowFailure: true });
  if (added.status !== 0) {
    await rm(parent, { recursive: true, force: true });
    throw new SingularityFlowError(`Unable to create the isolated ledger worktree: ${(added.stderr || added.stdout).trim()}`);
  }
  try {
    return await callback(worktree);
  } finally {
    git(root, ['worktree', 'remove', '--force', worktree], { allowFailure: true });
    git(root, ['branch', '-D', '__sflow_ledger_bootstrap__'], { allowFailure: true });
    await rm(parent, { recursive: true, force: true });
  }
}

async function writeCanonicalJson(file, value) {
  await writeAtomic(file, canonicalJson(value));
}

function commitArgs(config, message) {
  return ['commit', ...(config.signing === 'commit' ? ['-S'] : []), '-m', message];
}

function pushLedger(worktree, config, expectedRemoteSha = null) {
  const lease = expectedRemoteSha
    ? `--force-with-lease=refs/heads/${config.branch}:${expectedRemoteSha}`
    : '--force-with-lease';
  return git(worktree, ['push', lease, config.remote, `HEAD:refs/heads/${config.branch}`], { allowFailure: true });
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

export async function initializeLedger(root, rawConfig = {}, { publish = true } = {}) {
  const config = normalizeLedgerConfig(rawConfig);
  const refspecInstalled = installPinRefspec(root, config);
  ensureRemoteBranchFetched(root, config);
  const existing = ledgerHead(root, config);
  if (existing) return { created: false, branch: config.branch, ref: existing, refspecInstalled };
  const actor = identity(root);
  return temporaryWorktree(root, null, async (worktree) => {
    await writeCanonicalJson(path.join(worktree, HEAD_PATH), initialHead());
    await writeAtomic(path.join(worktree, README_PATH),
      '# Singularity Flow Capability Ledger\n\n'
      + 'This orphan branch is an append-only workflow ledger. It has no shared ancestry with application branches and must never be merged into them.\n');
    git(worktree, ['add', README_PATH, HEAD_PATH]);
    git(worktree, ['-c', `user.name=${actor.name}`, '-c', `user.email=${actor.email ?? 'unknown@invalid'}`, ...commitArgs(config, 'Initialize Singularity Flow capability ledger')]);
    const sha = git(worktree, ['rev-parse', 'HEAD']).stdout.trim();
    // Keep the orphan root reachable locally before attempting the network operation.
    // If the first push fails, `ledger init` can be retried without losing the commit
    // when this temporary worktree is removed.
    git(root, ['update-ref', localRef(config), sha]);
    if (publish && hasRemote(root, config.remote)) {
      const pushed = pushLedger(worktree, config);
      if (pushed.status !== 0) throw new SingularityFlowError(`Ledger root commit ${sha.slice(0, 8)} was retained locally but push failed: ${(pushed.stderr || pushed.stdout).trim()}`);
    }
    return { created: true, branch: config.branch, commit: sha, orphan: true, refspecInstalled };
  });
}

export async function ledgerDoctor(root, rawConfig = {}) {
  const config = normalizeLedgerConfig(rawConfig);
  const checks = [];
  const remoteAvailable = hasRemote(root, config.remote);
  checks.push({ id: 'enabled', status: config.enabled ? 'pass' : 'warn', detail: config.enabled ? 'ledger enabled' : 'ledger disabled (no lifecycle dual-write)' });
  checks.push({ id: 'remote', status: remoteAvailable ? 'pass' : 'warn', detail: remoteAvailable ? `${config.remote} is configured` : `${config.remote} is not configured` });
  ensureRemoteBranchFetched(root, config);
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
  ensureRemoteBranchFetched(root, config);
  const ref = ledgerHead(root, config);
  if (!ref) throw new SingularityFlowError(`Ledger branch '${config.branch}' does not exist.`);
  if (config.pinTransport === 'refs' && hasRemote(root, config.remote)) {
    git(root, ['fetch', '--no-tags', config.remote, '+refs/singularity/pins/*:refs/singularity/pins/*'], { allowFailure: true });
  } else if (config.pinTransport === 'branches' && hasRemote(root, config.remote)) {
    git(root, ['fetch', '--no-tags', config.remote, `+refs/heads/singularity/pins/*:refs/remotes/${config.remote}/singularity/pins/*`], { allowFailure: true });
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
    schemaVersion: 1,
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
  return readJson(path.join(worktree, HEAD_PATH));
}

async function eventAlreadyRecorded(worktree, idempotencyHash) {
  const file = path.join(worktree, idempotencyPath(idempotencyHash));
  if (!(await exists(file))) return null;
  return readJson(file);
}

function pinRef(config, intent) {
  if (config.pinTransport === 'none') return null;
  const suffix = `${safeSegment(intent.capabilityId, 'Ledger capability ID')}/${safeSegment(intent.eventId, 'Ledger event ID')}`;
  return config.pinTransport === 'refs'
    ? `refs/singularity/pins/${suffix}`
    : `refs/heads/singularity/pins/${suffix}`;
}

function publishPin(root, config, intent, publishedCommit) {
  const ref = pinRef(config, intent);
  if (!ref) return null;
  if (!hasRemote(root, config.remote)) {
    const current = git(root, ['rev-parse', '--verify', ref], { allowFailure: true }).stdout.trim();
    if (current && current !== publishedCommit) throw new SingularityFlowError(`Ledger pin ${ref} already points to a different commit.`);
    if (!current) git(root, ['update-ref', ref, publishedCommit]);
    return ref;
  }
  const existing = git(root, ['ls-remote', config.remote, ref], { allowFailure: true });
  const existingSha = existing.status === 0 ? existing.stdout.trim().split(/\s+/)[0] : null;
  if (existingSha) {
    if (existingSha !== publishedCommit) throw new SingularityFlowError(`Ledger pin ${ref} already points to a different commit.`);
    return ref;
  }
  const pushed = git(root, ['push', config.remote, `${publishedCommit}:${ref}`], { allowFailure: true });
  if (pushed.status !== 0) throw new SingularityFlowError(`Unable to publish ledger pin ${ref}: ${(pushed.stderr || pushed.stdout).trim()}`);
  return ref;
}

function fetchPin(root, config, ref) {
  if (!ref || !hasRemote(root, config.remote)) return;
  git(root, ['fetch', '--no-tags', config.remote, `+${ref}:${ref}`], { allowFailure: true });
}

async function appendOnce(root, config, intent, publishedCommit) {
  const idempotency = ledgerIdempotencyKey(intent, publishedCommit);
  ensureRemoteBranchFetched(root, config);
  let ref = ledgerHead(root, config);
  if (!ref) {
    await initializeLedger(root, config);
    ensureRemoteBranchFetched(root, config);
    ref = ledgerHead(root, config);
  }
  const expectedRemoteSha = refExists(root, remoteRef(config))
    ? git(root, ['rev-parse', remoteRef(config)]).stdout.trim()
    : null;
  return temporaryWorktree(root, ref, async (worktree) => {
    const duplicate = await eventAlreadyRecorded(worktree, idempotency.hash);
    if (duplicate) {
      return {
        duplicate: true,
        eventId: duplicate.eventId,
        entryHash: duplicate.entryHash,
        sequence: duplicate.sequence,
        ledgerCommit: git(worktree, ['rev-parse', 'HEAD']).stdout.trim()
      };
    }
    const head = await loadHead(worktree);
    const publishedPin = publishPin(root, config, intent, publishedCommit);
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
    git(worktree, ['add', location.path, idempotencyPath(idempotency.hash), eventPath(intent.eventId), HEAD_PATH]);
    git(worktree, commitArgs(config, `[ledger:${nextHead.sequence}] ${intent.eventType} ${intent.subject.workId}`));
    const ledgerCommit = git(worktree, ['rev-parse', 'HEAD']).stdout.trim();
    if (hasRemote(root, config.remote)) {
      const pushed = pushLedger(worktree, config, expectedRemoteSha);
      if (pushed.status !== 0) {
        const error = new SingularityFlowError(`Concurrent ledger append or push failure: ${(pushed.stderr || pushed.stdout).trim()}`);
        error.concurrent = true;
        throw error;
      }
    } else {
      git(root, ['update-ref', localRef(config), ledgerCommit, git(root, ['rev-parse', ref]).stdout.trim()]);
    }
    return {
      duplicate: false,
      eventId: intent.eventId,
      entryHash: location.hash,
      sequence: nextHead.sequence,
      ledgerCommit
    };
  });
}

export async function appendLedgerIntent(root, rawConfig, intent, publishedCommit) {
  const config = normalizeLedgerConfig(rawConfig);
  let lastError;
  for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
    try {
      return await appendOnce(root, config, intent, publishedCommit);
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
 * `files` are removed. No path outside an explicitly named replacement root is ever pruned.
 */
export async function publishToStateBranch(root, rawConfig, files, message, { replaceRoots = [] } = {}) {
  const config = normalizeLedgerConfig(rawConfig);
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
  if (!entries.length && !replacementRoots.length) {
    return { branch: config.branch, commit: null, changed: false, published: [], removed: [] };
  }

  ensureRemoteBranchFetched(root, config);
  let ref = ledgerHead(root, config);
  if (!ref) {
    await initializeLedger(root, config);
    ensureRemoteBranchFetched(root, config);
    ref = ledgerHead(root, config);
  }
  const expectedRemoteSha = refExists(root, remoteRef(config))
    ? git(root, ['rev-parse', remoteRef(config)]).stdout.trim()
    : null;

  return temporaryWorktree(root, ref, async (worktree) => {
    const desired = new Set(entries.map(([file]) => file));
    const removed = new Set();
    for (const replacementRoot of replacementRoots) {
      const tracked = git(worktree, ['ls-files', '--', replacementRoot]).stdout
        .split(/\r?\n/).map((file) => file.trim()).filter(Boolean);
      for (const file of tracked) {
        if (!desired.has(file)) removed.add(file);
      }
    }
    const removedFiles = [...removed].sort();
    if (removedFiles.length) git(worktree, ['rm', '-f', '--', ...removedFiles]);
    for (const [file, contents] of entries) {
      const target = path.join(worktree, file);
      await ensureDir(path.dirname(target));
      await writeAtomic(target, contents);
    }
    if (entries.length) git(worktree, ['add', '--', ...entries.map(([file]) => file)]);
    // Publishing the same bytes twice is a no-op rather than an empty commit: this runs on every
    // capability edit, and most edits change one file out of several.
    if (!git(worktree, ['diff', '--cached', '--name-only']).stdout.trim()) {
      return { branch: config.branch, commit: null, changed: false, published: [], removed: [] };
    }
    const actor = identity(root);
    git(worktree, ['-c', `user.name=${actor.name || 'Singularity Flow'}`,
      '-c', `user.email=${actor.email || 'unknown@invalid'}`,
      ...commitArgs(config, message)]);
    const commit = git(worktree, ['rev-parse', 'HEAD']).stdout.trim();
    if (hasRemote(root, config.remote)) {
      const pushed = pushLedger(worktree, config, expectedRemoteSha);
      if (pushed.status !== 0) {
        const detail = (pushed.stderr || pushed.stdout).trim();
        const error = new SingularityFlowError(
          `Unable to publish to the ${config.branch} branch: ${detail}`,
          { code: 'state_branch.concurrent_publication', details: { branch: config.branch, expectedRemoteSha } });
        // Callers that can deterministically rebase an immutable payload may retry. Lifecycle
        // decisions do not use this path and remain fail-fast.
        error.concurrent = /stale info|fetch first|non-fast-forward|cannot lock ref.*expected|force-with-lease/i.test(detail);
        throw error;
      }
      // The local branch follows what was just published. Readers name the branch plainly —
      // `git rev-parse state:singularity/world-model` — so a push that left the local ref behind
      // means the machine that did the publishing is the one that cannot see it. Allowed to fail:
      // if the branch is checked out somewhere, the remote ref still answers.
      git(root, ['update-ref', localRef(config), commit], { allowFailure: true });
    } else {
      git(root, ['update-ref', localRef(config), commit, git(root, ['rev-parse', ref]).stdout.trim()]);
    }
    return {
      branch: config.branch,
      commit,
      changed: true,
      published: entries.map(([file]) => file),
      removed: removedFiles
    };
  });
}

function localOutbox(root) {
  return path.join(gitDir(root), 'singularity-flow', 'ledger-outbox');
}

export async function recordLedgerOutbox(root, intentPath, publishedCommit, error) {
  const intent = await readJson(path.join(root, intentPath));
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
  if (!offline) git(root, ['fetch', '--prune', config.remote], { allowFailure: true });
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
        intent = JSON.parse(content.stdout);
      } catch {
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
      intent: await readJson(file),
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
 */
function readRefTree(root, ref, prefix) {
  const listed = git(root, ['ls-tree', '-r', '-z', '--format=%(objectname) %(path)', ref, '--', prefix], { allowFailure: true });
  if (listed.status !== 0) return new Map();
  const entries = listed.stdout.split('\0').filter(Boolean).map((line) => {
    const separator = line.indexOf(' ');
    return { oid: line.slice(0, separator), file: line.slice(separator + 1) };
  });
  if (!entries.length) return new Map();

  const batch = run('git', ['cat-file', '--batch'], {
    cwd: root,
    allowFailure: true,
    encoding: 'buffer',
    input: `${entries.map((entry) => entry.oid).join('\n')}\n`
  });
  if (batch.status !== 0) return new Map();

  const contents = new Map();
  const buffer = batch.stdout;
  let cursor = 0;
  for (const entry of entries) {
    const newline = buffer.indexOf(0x0a, cursor);
    if (newline < 0) break;
    // `<oid> <type> <size>` — the size is in bytes and is what makes this walk exact.
    const size = Number(buffer.toString('utf8', cursor, newline).trim().split(' ')[2]);
    if (!Number.isFinite(size)) break;
    const start = newline + 1;
    contents.set(entry.file, buffer.toString('utf8', start, start + size));
    // Git writes a newline after each object's contents, so the next header starts one byte later.
    cursor = start + size + 1;
  }
  return contents;
}

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
  ensureRemoteBranchFetched(root, config, { offline });
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
    head: JSON.parse(head),
    /** `path -> contents`, keyed by the path as it appears in the tree. */
    tree,
    has: (relative) => tree(path.posix.dirname(relative)).has(relative),
    file: (relative) => readRefFile(root, ref, relative)
  });
}

export async function verifyLedger(root, rawConfig, { offline = false } = {}) {
  const config = normalizeLedgerConfig(rawConfig);
  return ledgerRefSnapshot(root, config, async (snapshot) => {
    const errors = [], warnings = [];
    const { head } = snapshot;
    const entries = new Map();
    for (const [file, contents] of snapshot.tree('ledger/entries')) {
      if (!file.endsWith('.json')) continue;
      const entry = JSON.parse(contents);
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
      const index = JSON.parse(contents);
      if (!entries.has(index.entryHash)) errors.push(`Idempotency index ${index.eventId} references missing entry ${index.entryHash}.`);
    }
    const retentionExpired = new Set();
    for (const entry of entries.values()) {
      if (entry.eventType !== 'retention-expired') continue;
      if (entry.payload?.entryHash) retentionExpired.add(entry.payload.entryHash);
      if (entry.payload?.pinRef) retentionExpired.add(entry.payload.pinRef);
    }
    for (const [hash, entry] of entries) {
      const expected = ledgerIdempotencyKey(entry, entry.transport?.publishedCommit);
      if (entry.idempotencyKey !== expected.value) errors.push(`Entry ${hash} has an invalid idempotency key.`);
      if (!snapshot.has(idempotencyPath(expected.hash))) {
        errors.push(`Entry ${hash} is missing its idempotency index.`);
      }
      if (entry.transport?.pinRef) {
        if (!offline) fetchPin(root, config, entry.transport.pinRef);
        const pinned = git(root, ['rev-parse', `${entry.transport.pinRef}^{commit}`], { allowFailure: true });
        if (pinned.status !== 0 && (retentionExpired.has(hash) || retentionExpired.has(entry.transport.pinRef))) {
          warnings.push(`Entry ${hash} source pin is retention-expired.`);
        } else if (pinned.status !== 0) errors.push(`Entry ${hash} pin ${entry.transport.pinRef} is not reachable.`);
        else if (pinned.stdout.trim() !== entry.transport.publishedCommit) {
          errors.push(`Entry ${hash} pin does not match source commit ${entry.transport.publishedCommit}.`);
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
      errors,
      warnings
    };
  }, { offline });
}

export async function ledgerLog(root, rawConfig, { limit = 20, offline = false } = {}) {
  const config = normalizeLedgerConfig(rawConfig);
  return ledgerRefSnapshot(root, config, async (snapshot) => {
    const { head } = snapshot;
    const entries = new Map();
    for (const [file, contents] of snapshot.tree('ledger/entries')) {
      if (!file.endsWith('.json')) continue;
      entries.set(path.posix.basename(file, '.json'), JSON.parse(contents));
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
    const hash = index === null ? hashOrEventId : JSON.parse(index).entryHash;
    // The entry lives under a capability directory, so the name is matched rather than the path.
    const found = [...snapshot.tree('ledger/entries')]
      .find(([file]) => path.posix.basename(file) === `${hash}.json`);
    if (!found) throw new SingularityFlowError(`Ledger entry or event '${hashOrEventId}' was not found.`);
    return { hash, entry: JSON.parse(found[1]) };
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
  const remoteView = ensureRemoteBranchFetched(root, config, { offline });
  const ref = ledgerHead(root, config);
  const outbox = (await exists(localOutbox(root)))
    ? (await readdir(localOutbox(root))).filter((name) => name.endsWith('.json')).length
    : 0;
  const intents = await allLedgerIntents(root, config, { offline });
  if (!ref) return { enabled: true, initialized: false, outbox, durableIntents: intents.length, remoteView, config };
  const verification = await verifyLedger(root, config, { offline });
  const log = await ledgerLog(root, config, { limit: 1000000, offline });
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
