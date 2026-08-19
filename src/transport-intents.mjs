/** Durable, exact commit-to-ref transport intents for pushes outside Story publication. */
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  assertCredentialFreeRemote, classifyGitRemoteFailure, redactDiagnosticText,
  remoteFingerprint, sanitizeRemote
} from './git-remote-diagnostics.mjs';
import { workspaceRegistryFile } from './workspace-context.mjs';
import { run, SingularityFlowError, writeAtomic } from './util.mjs';
import { healerReceipt } from './workspace-healers.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';

export const TRANSPORT_INTENT_SCHEMA_VERSION = currentSchemaVersion('transport-intent');
export const TRANSPORT_INTENT_STATUSES = Object.freeze([
  'pending', 'pushing', 'succeeded', 'outcome-unknown', 'remote-diverged',
  'needs-user', 'attempt-budget-exhausted'
]);
const AUTO_RETRYABLE = new Set(['network-transient', 'rate-limited']);
const TERMINAL = new Set(['succeeded', 'remote-diverged', 'needs-user', 'attempt-budget-exhausted']);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function nowIso() { return new Date().toISOString(); }

function integrityFor(record) {
  const copy = structuredClone(record);
  delete copy.integrity;
  return digest(canonical(copy));
}

function signed(record) {
  const next = { ...record, updatedAt: nowIso() };
  return { ...next, integrity: { algorithm: 'sha256', sha256: integrityFor(next) } };
}

function verified(record, file) {
  if (record?.integrity?.algorithm !== 'sha256' || record.integrity.sha256 !== integrityFor(record)) {
    throw new SingularityFlowError(`Transport intent failed its integrity check: ${file}`, {
      code: 'TRANSPORT_INTENT_INTEGRITY_INVALID', details: { file }
    });
  }
  return record;
}

export function transportOutboxRoot(env = process.env, home = os.homedir()) {
  const root = path.resolve(env.SINGULARITY_FLOW_TRANSPORT_OUTBOX
    || path.join(path.dirname(workspaceRegistryFile(env, home)), 'transport-outbox'));
  if (root === path.parse(root).root || root === path.resolve(home)) {
    throw new SingularityFlowError('The transport outbox cannot be a filesystem root or home directory.', {
      code: 'TRANSPORT_OUTBOX_PATH_UNSAFE'
    });
  }
  return root;
}

function intentFile(root, intentId) {
  const id = String(intentId ?? '').trim();
  if (!/^psh_[a-f0-9-]{20,64}$/.test(id)) {
    throw new SingularityFlowError(`Invalid transport intent ID '${id}'.`, { code: 'TRANSPORT_INTENT_ID_INVALID' });
  }
  return path.join(root, 'intents', `${id}.json`);
}

async function writeIntent(root, record) {
  const next = signed(record);
  await writeAtomic(intentFile(root, next.intentId), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

export async function readTransportIntent(intentId, { env = process.env, home = os.homedir() } = {}) {
  const root = transportOutboxRoot(env, home);
  const file = intentFile(root, intentId);
  let record;
  try { record = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new SingularityFlowError(`Transport intent '${intentId}' was not found.`, {
      code: 'TRANSPORT_INTENT_NOT_FOUND'
    });
    throw new SingularityFlowError(`Transport intent '${intentId}' cannot be read.`, {
      code: 'TRANSPORT_INTENT_INVALID'
    });
  }
  return verified(readRecord('transport-intent', record).record, file);
}

export async function listTransportIntents({
  env = process.env, home = os.homedir(), includeSucceeded = true
} = {}) {
  const root = transportOutboxRoot(env, home);
  const directory = path.join(root, 'intents');
  const files = await readdir(directory).catch(() => []);
  const records = [];
  for (const name of files.filter((entry) => /^psh_[a-f0-9-]{20,64}\.json$/.test(entry))) {
    const file = path.join(directory, name);
    try {
      const record = verified(readRecord('transport-intent', await readFile(file)).record, file);
      if (includeSucceeded || record.status !== 'succeeded') records.push(record);
    } catch (error) {
      if (String(error?.code ?? '').startsWith('SCHEMA_')) throw error;
      /* Corrupt records stay on disk and cannot authorize retry. */
    }
  }
  return records.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

async function repositoryFingerprint(root) {
  return `sha256:${digest(await realpath(root))}`;
}

function assertTargetRef(targetRef) {
  const value = String(targetRef ?? '').trim();
  if (!/^refs\/heads\/(?!-)(?!.*(?:\.\.|@\{|\\|\s|~|\^|:|\?|\*|\[|\/\/))[A-Za-z0-9._/-]+$/.test(value)
    || value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock')) {
    throw new SingularityFlowError(`Transport target '${value}' is not a safe branch ref.`, {
      code: 'TRANSPORT_TARGET_REF_INVALID'
    });
  }
  return value;
}

function gitResultEvidence(result) {
  const bounded = redactDiagnosticText(`${result?.stderr ?? ''}\n${result?.stdout ?? ''}`).slice(0, 4096);
  return {
    exitCode: Number.isInteger(result?.status) ? result.status : null,
    signal: result?.signal ?? null,
    diagnostic: bounded.split('\n').find(Boolean) ?? null,
    outputSha256: `sha256:${digest(bounded)}`
  };
}

export async function createTransportIntent({
  repositoryRoot, remote = 'origin', sourceCommit, targetRef, expectedRemote = null, scope = {}
}, { env = process.env, home = os.homedir(), runCommand = run } = {}) {
  const root = await realpath(path.resolve(repositoryRoot));
  if (!/^[A-Za-z0-9._-]+$/.test(remote) || remote.startsWith('-')) {
    throw new SingularityFlowError(`Transport remote '${remote}' is not a configured remote name.`, {
      code: 'TRANSPORT_REMOTE_INVALID'
    });
  }
  const commit = runCommand('git', ['rev-parse', '--verify', `${sourceCommit}^{commit}`], {
    cwd: root, allowFailure: true
  });
  if (commit.status !== 0) throw new SingularityFlowError(`Commit '${sourceCommit}' is not available locally.`, {
    code: 'TRANSPORT_SOURCE_COMMIT_MISSING'
  });
  const remoteUrl = runCommand('git', ['remote', 'get-url', remote], { cwd: root, allowFailure: true });
  if (remoteUrl.status !== 0 || !remoteUrl.stdout.trim()) {
    throw new SingularityFlowError(`Remote '${remote}' is not configured.`, { code: 'TRANSPORT_REMOTE_MISSING' });
  }
  const safeRemoteUrl = assertCredentialFreeRemote(remoteUrl.stdout.trim());
  const outbox = transportOutboxRoot(env, home);
  const repositoryRootFingerprint = await repositoryFingerprint(root);
  const normalizedRemoteFingerprint = `sha256:${remoteFingerprint(sanitizeRemote(safeRemoteUrl))}`;
  const normalizedTargetRef = assertTargetRef(targetRef);
  const normalizedExpectedRemote = expectedRemote || null;
  const existing = (await listTransportIntents({ env, home, includeSucceeded: true })).find((candidate) =>
    candidate.repositoryRootFingerprint === repositoryRootFingerprint
      && candidate.remoteFingerprint === normalizedRemoteFingerprint
      && candidate.remote === remote
      && candidate.sourceCommit === commit.stdout.trim()
      && candidate.targetRef === normalizedTargetRef
      && candidate.expectedRemote === normalizedExpectedRemote);
  if (existing) return existing;
  const intentId = `psh_${randomUUID()}`;
  return writeIntent(outbox, {
    schemaVersion: TRANSPORT_INTENT_SCHEMA_VERSION,
    intentId,
    scope: { ...scope, kind: 'transport' },
    repositoryRoot: root,
    repositoryRootFingerprint,
    remote,
    remoteUrl: sanitizeRemote(safeRemoteUrl),
    remoteFingerprint: normalizedRemoteFingerprint,
    sourceCommit: commit.stdout.trim(),
    targetRef: normalizedTargetRef,
    expectedRemote: normalizedExpectedRemote,
    status: 'pending',
    createdAt: nowIso(),
    attempts: [],
    attemptBudget: { used: 0, maximum: 2 },
    circuit: { key: null, consecutiveFailures: 0, openedAt: null },
    healers: [],
    nextAction: { command: `singularity-flow push retry ${intentId}`, skill: '/sf-push' }
  });
}

export function observeRemoteTarget(intent, { runCommand = run } = {}) {
  const result = runCommand('git', ['ls-remote', '--refs', intent.remote, intent.targetRef], {
    cwd: intent.repositoryRoot, allowFailure: true
  });
  if (result.status !== 0) return { readable: false, commit: null, result };
  const line = String(result.stdout ?? '').split('\n').find((entry) => entry.trim().endsWith(`\t${intent.targetRef}`));
  return { readable: true, commit: line?.trim().split(/\s+/)[0] ?? null, result };
}

async function withIntentLease(outbox, intentId, operation) {
  const lock = path.join(outbox, 'leases', `${intentId}.lock`);
  let handle;
  try {
    handle = await open(lock, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      await writeAtomic(path.join(outbox, 'leases', '.keep'), '', { mode: 0o600 });
      return withIntentLease(outbox, intentId, operation);
    }
    if (error?.code === 'EEXIST') throw new SingularityFlowError(`Transport intent '${intentId}' is already being changed.`, {
      code: 'TRANSPORT_INTENT_BUSY'
    });
    throw error;
  }
  try { return await operation(); }
  finally { await handle.close(); await rm(lock, { force: true }); }
}

function classified(result) {
  const failure = classifyGitRemoteFailure(result);
  const text = `${result?.stderr ?? ''}\n${result?.stdout ?? ''}`;
  if (/non-fast-forward|fetch first|stale info/i.test(text)) return { ...failure, classification: 'remote-diverged', retryable: false };
  if (/hook declined|pre-receive hook|protected branch|branch protection|GH006/i.test(text)) {
    return { ...failure, classification: /hook/i.test(text) ? 'hook-rejected' : 'branch-protected', retryable: false };
  }
  return { ...failure, retryable: AUTO_RETRYABLE.has(failure.classification) };
}

function circuitAfter(intent, failure) {
  const consecutiveFailures = Number(intent.circuit?.consecutiveFailures ?? 0) + 1;
  const opened = !failure.retryable || consecutiveFailures >= 2;
  return {
    key: `sha256:${digest(`${intent.remoteFingerprint}:git.push:${failure.classification}`)}`,
    consecutiveFailures,
    openedAt: opened ? nowIso() : null,
    errorClass: failure.classification
  };
}

export async function retryTransportIntent(intentId, {
  env = process.env, home = os.homedir(), runCommand = run, allowNeedsUser = false
} = {}) {
  const outbox = transportOutboxRoot(env, home);
  return withIntentLease(outbox, intentId, async () => {
    let intent = await readTransportIntent(intentId, { env, home });
    if (intent.status === 'succeeded') return intent;
    if (intent.status === 'remote-diverged' || (intent.status === 'needs-user' && !allowNeedsUser)) {
      throw new SingularityFlowError(`Transport intent '${intentId}' requires human reconciliation.`, {
        code: 'TRANSPORT_INTENT_NEEDS_USER', details: { status: intent.status }
      });
    }
    if (await repositoryFingerprint(intent.repositoryRoot) !== intent.repositoryRootFingerprint) {
      throw new SingularityFlowError('The repository no longer matches the transport intent.', {
        code: 'TRANSPORT_REPOSITORY_DRIFTED'
      });
    }

    const observed = observeRemoteTarget(intent, { runCommand });
    if (!observed.readable) {
      return writeIntent(outbox, {
        ...intent, status: 'outcome-unknown',
        fault: { ...classified(observed.result), evidence: gitResultEvidence(observed.result) },
        nextAction: { command: `singularity-flow push status ${intentId}`, skill: '/sf-push' }
      });
    }
    if (observed.commit === intent.sourceCommit) {
      return writeIntent(outbox, {
        ...intent, status: 'succeeded', observedRemote: observed.commit,
        healers: [...intent.healers, healerReceipt('remote-push-already-succeeded', {
          postconditions: [{ id: 'remote-target-equals-source-commit', status: 'pass' }],
          proof: { targetRef: intent.targetRef, remoteCommit: observed.commit }
        })],
        nextAction: null
      });
    }
    if (observed.commit !== intent.expectedRemote) {
      return writeIntent(outbox, {
        ...intent, status: 'remote-diverged', observedRemote: observed.commit,
        fault: { classification: 'remote-diverged', retryable: false },
        nextAction: { command: `git -C ${JSON.stringify(intent.repositoryRoot)} fetch ${intent.remote}`, skill: null }
      });
    }
    if (intent.circuit?.openedAt && !allowNeedsUser) {
      const cooldownMs = Number(env.SINGULARITY_FLOW_TRANSPORT_COOLDOWN_MS ?? 30_000);
      const elapsed = Date.now() - Date.parse(intent.circuit.openedAt);
      if (Number.isFinite(elapsed) && elapsed < cooldownMs) {
        return writeIntent(outbox, {
          ...intent,
          status: 'pending',
          nextAction: { command: `singularity-flow push status ${intentId}`, skill: '/sf-push' },
          cooldown: { remainingMs: Math.max(0, cooldownMs - elapsed), openedAt: intent.circuit.openedAt }
        });
      }
    }
    if (intent.attemptBudget.used >= intent.attemptBudget.maximum) {
      return writeIntent(outbox, {
        ...intent, status: 'attempt-budget-exhausted',
        nextAction: { command: `singularity-flow push status ${intentId}`, skill: '/sf-push' }
      });
    }

    const attempt = { number: intent.attemptBudget.used + 1, startedAt: nowIso(), completedAt: null };
    intent = await writeIntent(outbox, {
      ...intent, status: 'pushing',
      attemptBudget: { ...intent.attemptBudget, used: attempt.number },
      attempts: [...intent.attempts, attempt]
    });
    const refspec = `${intent.sourceCommit}:${intent.targetRef}`;
    const dryRun = runCommand('git', ['push', '--dry-run', '--porcelain', intent.remote, refspec], {
      cwd: intent.repositoryRoot, allowFailure: true
    });
    if (dryRun.status !== 0) {
      const failure = classified(dryRun);
      const status = failure.classification === 'remote-diverged'
        ? 'remote-diverged'
        : (failure.retryable ? 'pending' : 'needs-user');
      return writeIntent(outbox, {
        ...intent, status, fault: { ...failure, evidence: gitResultEvidence(dryRun) },
        attempts: intent.attempts.map((entry) => entry.number === attempt.number
          ? { ...entry, completedAt: nowIso(), result: status, stage: 'dry-run' } : entry),
        circuit: circuitAfter(intent, failure)
      });
    }
    const pushed = runCommand('git', ['push', intent.remote, refspec], {
      cwd: intent.repositoryRoot, allowFailure: true
    });
    const after = observeRemoteTarget(intent, { runCommand });
    if (after.readable && after.commit === intent.sourceCommit) {
      return writeIntent(outbox, {
        ...intent, status: 'succeeded', observedRemote: after.commit, fault: null,
        attempts: intent.attempts.map((entry) => entry.number === attempt.number
          ? { ...entry, completedAt: nowIso(), result: 'succeeded', stage: 'verified' } : entry),
        circuit: { key: null, consecutiveFailures: 0, openedAt: null }, nextAction: null
      });
    }
    if (after.readable && after.commit !== intent.expectedRemote) {
      return writeIntent(outbox, {
        ...intent, status: 'remote-diverged', observedRemote: after.commit,
        fault: { classification: 'remote-diverged', retryable: false, evidence: gitResultEvidence(pushed) },
        attempts: intent.attempts.map((entry) => entry.number === attempt.number
          ? { ...entry, completedAt: nowIso(), result: 'remote-diverged', stage: 'verify' } : entry)
      });
    }
    const failure = classified(pushed);
    const status = after.readable
      ? (failure.retryable ? 'pending' : 'needs-user')
      : 'outcome-unknown';
    return writeIntent(outbox, {
      ...intent, status,
      fault: { ...failure, evidence: gitResultEvidence(pushed) },
      attempts: intent.attempts.map((entry) => entry.number === attempt.number
          ? { ...entry, completedAt: nowIso(), result: status, stage: 'push' } : entry),
      circuit: circuitAfter(intent, failure),
      nextAction: { command: `singularity-flow push status ${intentId}`, skill: '/sf-push' }
    });
  });
}

export async function createAndPushTransportIntent(input, options = {}) {
  const intent = await createTransportIntent(input, options);
  return retryTransportIntent(intent.intentId, options);
}

export function transportIntentTerminal(intent) { return TERMINAL.has(intent?.status); }
