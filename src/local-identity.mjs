import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import {
  branch, checkout, fetchRemote, fileAtRef, hasRemote, head, refExists, refHead, remoteBranches
} from './git.mjs';
import {
  ensureDir, exists, gitHeadIsUnborn, gitReadOutput, nowIso, posix, run, SingularityFlowError, writeJson
} from './util.mjs';
import { LIFECYCLE_EVENT, lifecycleEvent } from './lifecycle-event.mjs';
import { createLedgerIntent } from './ledger.mjs';
import { normalizeLedgerConfig } from './ledger-config.mjs';
import { lifecycleAuthority } from './sda/story-branch-authority.mjs';
import {
  clearPendingPublication, readPendingPublication, syncPendingLifecyclePublication
} from './publication-pending.mjs';

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function identityPattern(prefix, pad, { scoped = false } = {}) {
  const suffix = scoped ? `(\\d{${pad},})-(\\d{${pad},})` : `(\\d{${pad},})`;
  return new RegExp(`^${escaped(prefix)}-${suffix}$`);
}

function localPolicy(portfolio) {
  const policy = portfolio?.identity?.local;
  if (!policy) throw new SingularityFlowError('Portfolio local identity policy is unavailable.');
  return policy;
}

function branchId(value) {
  const normalized = String(value ?? '').replace(/^refs\/(?:heads|remotes\/[^/]+)\//, '');
  const segments = normalized.split('/');
  return segments.at(-1);
}

async function directoryNames(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function collectBreakdownIds(parsed, target) {
  for (const epic of parsed?.epics ?? []) {
    if (epic?.planId) target.push(String(epic.planId));
    if (epic?.id) target.push(String(epic.id));
    if (epic?.workId) target.push(String(epic.workId));
    for (const story of epic?.stories ?? []) {
      if (story?.planId) target.push(String(story.planId));
      if (story?.id) target.push(String(story.id));
      if (story?.workId) target.push(String(story.workId));
    }
  }
}

async function workingTreeBreakdownIds(root, portfolio) {
  const values = [];
  const initiativeRoot = path.join(root, portfolio.initiativeRoot);
  for (const id of await directoryNames(initiativeRoot)) {
    const file = path.join(initiativeRoot, id, 'breakdown.yml');
    if (!await exists(file)) continue;
    try { collectBreakdownIds(YAML.parse(await readFile(file, 'utf8')), values); } catch {
      // Invalid breakdowns are reported by the normal governance gate. Identity
      // scanning ignores their contents but still reserves the initiative ID.
    }
  }
  return values;
}

function remoteBreakdownIds(root, portfolio, remote, branches) {
  const values = [];
  for (const name of branches) {
    const id = branchId(name);
    const text = fileAtRef(root, `refs/remotes/${remote}/${name}`, posix(path.join(portfolio.initiativeRoot, id, 'breakdown.yml')));
    if (!text) continue;
    try { collectBreakdownIds(YAML.parse(text), values); } catch {
      // The branch remains visible to the normal initiative gate. Do not let a
      // malformed remote document prevent allocation from inspecting others.
    }
  }
  return values;
}

// Identity records (and the ledger page reader behind them) load only when an allocation runs.
const identityRecords = () => import('./subject-identity-records.mjs');

/** The ledger configuration identity reads use: the caller's, else the workflow definition's. */
async function identityLedger(root, ledger) {
  return ledger === undefined ? (await identityRecords()).definitionLedgerConfig(root) : (ledger ?? {});
}

function identityScan(values, identitySource) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return {
    identitySource,
    values: [...new Set(values)].sort(),
    duplicates: [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([id, count]) => ({ id, count }))
  };
}

/**
 * Every identity an allocation must not reuse: the state ledger's Epic and Initiative records plus
 * this working tree's own Initiative directories and breakdown IDs (local authored state). `taken`
 * names IDs a concurrent reservation already won in this allocation. Only with the ledger off,
 * where no authority record exists, are local and remote branches scanned instead.
 */
export async function scanLocalIdentities(root, portfolio, {
  remote = portfolio.git?.remote ?? 'origin',
  fetch = false,
  ledger = undefined,
  taken = []
} = {}) {
  const { IDENTITY_SOURCE, initiativeIdentityRecords } = await identityRecords();
  const identities = await initiativeIdentityRecords(root, await identityLedger(root, ledger), { offline: !fetch });
  const initiatives = await directoryNames(path.join(root, portfolio.initiativeRoot));
  if (identities.records) {
    return {
      ...identityScan([
        ...identities.records.map((record) => record.id), ...initiatives,
        ...await workingTreeBreakdownIds(root, portfolio), ...taken
      ], IDENTITY_SOURCE.LEDGER),
      recorded: identities.records.length
    };
  }
  // Ledger off: no authority records exist, so the branch inventory is the only shared evidence.
  if (fetch && hasRemote(root, remote)) await fetchRemote(root, remote);
  const localRefs = run('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: root }).stdout
    .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const remotes = remoteBranches(root, remote);
  const breakdownIds = [
    ...await workingTreeBreakdownIds(root, portfolio),
    ...remoteBreakdownIds(root, portfolio, remote, remotes)
  ];
  return identityScan([
    ...initiatives, ...localRefs.map(branchId), ...remotes.map(branchId), ...breakdownIds, ...taken
  ], IDENTITY_SOURCE.LEDGER_OFF);
}

export async function nextLocalEpicId(root, portfolio, options = {}) {
  const policy = localPolicy(portfolio);
  const scan = await scanLocalIdentities(root, portfolio, options);
  const pattern = identityPattern(policy.epicPrefix, policy.pad);
  let maximum = 0;
  for (const value of scan.values) {
    const match = pattern.exec(value);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  }
  const sequence = maximum + 1;
  return {
    id: `${policy.epicPrefix}-${String(sequence).padStart(policy.pad, '0')}`,
    sequence,
    identitySource: scan.identitySource,
    scan
  };
}

const RESERVATION_ROOT = posix(path.join('singularity', 'identity-reservations'));

/**
 * The reservation bound to this checkout, read from its recorded ID and branch rather than inferred
 * from the branch name. A reservation whose Initiative already started is spent.
 */
async function boundLocalEpicReservation(root, portfolio, policy) {
  const current = branch(root);
  const pattern = identityPattern(policy.epicPrefix, policy.pad);
  let names;
  try { names = await readdir(path.join(root, RESERVATION_ROOT), { withFileTypes: true }); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const bound = [];
  for (const entry of names) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const stem = entry.name.slice(0, -'.json'.length);
    const relative = posix(path.join(RESERVATION_ROOT, entry.name));
    let record;
    try {
      record = readRecord('local-identity-reservation', await readFile(path.join(root, relative))).record;
    } catch {
      // An unreadable record is only this checkout's problem when its name is this branch.
      if (stem === current) throw new SingularityFlowError(`Local Epic reservation ${relative} is not valid JSON.`);
      continue;
    }
    const recordedBranch = text(record?.branch) ?? text(record?.id);
    if (recordedBranch !== current && stem !== current) continue;
    if (record?.id !== stem || recordedBranch !== current || record?.kind !== 'epic'
        || record?.authority !== 'local' || !pattern.test(record.id)) {
      throw new SingularityFlowError(`Local Epic reservation ${relative} does not match branch '${current}'.`);
    }
    if (await exists(path.join(root, portfolio.initiativeRoot, record.id, 'state.json'))) continue;
    bound.push({ record, relative });
  }
  if (bound.length > 1) {
    throw new SingularityFlowError(
      `Branch '${current}' holds more than one unstarted local Epic reservation: ${bound.map((item) => item.record.id).join(', ')}.`,
      { code: 'LOCAL_EPIC_RESERVATION_AMBIGUOUS' }
    );
  }
  return bound[0] ?? null;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function currentLocalEpicReservation(root, portfolio, {
  remote = portfolio.git?.remote ?? 'origin',
  fetch = false
} = {}) {
  const policy = localPolicy(portfolio);
  const bound = await boundLocalEpicReservation(root, portfolio, policy);
  if (!bound) return null;
  const { record, relative } = bound;
  const id = record.id;
  const reservedBranch = text(record.branch) ?? id;
  if (fetch && hasRemote(root, remote)) await fetchRemote(root, remote);
  // Only a history Git could read may say the reservation "has not been committed".
  const reservationCommit = (gitReadOutput(run(
    'git',
    ['log', '-1', '--format=%H', '--', relative],
    { cwd: root, allowFailure: true }
  ), `Local Epic reservation ${relative}`, { absentWhen: () => gitHeadIsUnborn(root) }) ?? '').trim();
  if (!reservationCommit) {
    throw new SingularityFlowError(`Local Epic reservation ${relative} has not been committed.`);
  }
  return {
    id,
    branch: reservedBranch,
    reservationCommit,
    pushed: refExists(root, `refs/remotes/${remote}/${reservedBranch}`)
      && refHead(root, `refs/remotes/${remote}/${reservedBranch}`) === reservationCommit,
    recoverable: true,
    reservedAt: record.reservedAt ?? null,
    reservedBy: record.reservedBy ?? null
  };
}

export function assignLocalStoryIds(breakdown, initiative, portfolio) {
  const authority = initiative?.resolution?.identity?.authority;
  if (authority !== 'local') return breakdown;
  const policy = initiative.resolution.identity.local ?? localPolicy(portfolio);
  const epicMatch = identityPattern(policy.epicPrefix, policy.pad).exec(initiative.initiative.id);
  if (!epicMatch) {
    throw new SingularityFlowError(
      `Local Epic '${initiative.initiative.id}' does not match the pinned prefix '${policy.epicPrefix}'.`
    );
  }
  const epicSequence = String(Number(epicMatch[1])).padStart(policy.pad, '0');
  const existing = new Set();
  let ordinal = 0;
  for (const epic of breakdown.epics) {
    for (const story of epic.stories) {
      ordinal += 1;
      const expected = policy.scopeStoriesByEpic
        ? `${policy.storyPrefix}-${epicSequence}-${String(ordinal).padStart(policy.pad, '0')}`
        : `${policy.storyPrefix}-${String(ordinal).padStart(policy.pad, '0')}`;
      if (story.workId && story.workId !== story.id && story.workId !== expected) {
        const pattern = identityPattern(policy.storyPrefix, policy.pad, { scoped: policy.scopeStoriesByEpic });
        if (!pattern.test(story.workId)) {
          throw new SingularityFlowError(`Story '${story.id}' Work ID '${story.workId}' does not match the pinned local identity policy.`);
        }
      } else {
        story.workId = expected;
      }
      if (existing.has(story.workId)) throw new SingularityFlowError(`Local Story ID '${story.workId}' is duplicated.`);
      existing.add(story.workId);
      story.idAuthority = 'local';
    }
  }
  breakdown.stories = breakdown.epics.flatMap((epic) => epic.stories);
  return breakdown;
}

export async function reserveLocalEpicBranch(root, portfolio, {
  base = 'main',
  actor,
  remote = portfolio.git?.remote ?? 'origin',
  maxAttempts = 5,
  fault = null,
  ledger = undefined
} = {}) {
  if (branch(root) !== base) {
    throw new SingularityFlowError(`Local Epic allocation must start on base branch '${base}', not '${branch(root)}'.`);
  }
  const { EPIC_RESERVATION_OPERATION, IDENTITY_SOURCE } = await identityRecords();
  const ledgerConfig = normalizeLedgerConfig(await identityLedger(root, ledger));
  // IDs this allocation must pass over: lost to a concurrent create-only lease, or whose branch
  // name is already bound here. Records lag a concurrent winner's push; the lease does not.
  const taken = new Set();
  let collisions = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const allocation = await nextLocalEpicId(root, portfolio, {
      remote, fetch: true, ledger: ledgerConfig, taken: [...taken]
    });
    const id = allocation.id;
    if (allocation.identitySource === IDENTITY_SOURCE.LEDGER) {
      // The chosen name only, never an inventory: an existing branch of that name is not this Epic.
      if (refExists(root, `refs/heads/${id}`) || refExists(root, `refs/remotes/${remote}/${id}`)) {
        taken.add(id);
        if ((collisions += 1) > 100) break;
        attempt -= 1;
        continue;
      }
      // The ledger refresh read no application branch. Refresh only the base the Epic forks from.
      if (hasRemote(root, remote)) await fetchRemote(root, remote, { branches: [base] });
    }
    // Allocation refreshed the organisation authority to discover concurrent reservations. The new
    // Epic must also fork from the refreshed base; otherwise it can omit configuration and a
    // repository world model already published by another contributor.
    await checkout(root, id, { base, remote, preferRemoteBase: true });
    const relative = posix(path.join('singularity', 'identity-reservations', `${id}.json`));
    const absolute = path.join(root, relative);
    const reservation = {
      schemaVersion: currentSchemaVersion('local-identity-reservation'),
      id,
      kind: 'epic',
      authority: 'local',
      reservedAt: nowIso(),
      reservedBy: actor ?? null,
      branch: id
    };
    const subject = { kind: 'initiative', id, branch: id };
    const publicationMode = portfolio.git?.publish === 'off' ? 'off' : 'required';
    const expectedHead = head(root);
    const event = lifecycleEvent({
      type: LIFECYCLE_EVENT.BINDING, subject, actor,
      payload: { operation: EPIC_RESERVATION_OPERATION, authority: 'local' }
    });
    // The reservation is an identity record: the state ledger carries it, so the next allocation
    // reads it there instead of listing this branch.
    const ledgerIntent = ledgerConfig.enabled ? createLedgerIntent({
      eventId: event.eventId, eventType: event.type, capabilityId: `initiative-${id}`,
      subject: { workId: id, branch: id }, actor,
      payload: { lifecycleEventId: event.eventId, lifecyclePayload: event.payload, reservationPath: relative }
    }) : null;
    let publication;
    try {
      publication = await lifecycleAuthority(root).publish({
        subject,
        expectedRevision: { head: expectedHead },
        allowedPaths: [relative],
        event,
        ...(ledgerIntent ? {
          ledger: { config: ledgerConfig, intent: ledgerIntent, intentDirectory: posix(path.join(RESERVATION_ROOT, id)) }
        } : {}),
        commit: { message: `[${id}][identity:reserve] Reserve local Epic ID` },
        publication: {
          mode: publicationMode, branch: id, remote,
          expectedLocalHead: expectedHead,
          ...(publicationMode === 'off' ? {} : { expectedRemoteSha: null })
        },
        fault,
        // The UoW must capture the absent-file preimage before reservation bytes exist. Writing
        // earlier made an admission/Candidate failure restore the already-mutated state as if it
        // were the stable baseline.
        state: {
          write: async () => {
            await ensureDir(path.dirname(absolute));
            await writeJson(absolute, reservation);
          }
        }
      });
    } catch (error) {
      const discardUncommittedReservation = () => {
        if (error?.publicationRefAdvanced === true
            || branch(root) !== id
            || head(root) !== expectedHead
            || run('git', ['status', '--porcelain'], { cwd: root }).stdout.trim()) return false;
        run('git', ['switch', base], { cwd: root });
        run('git', ['branch', '-D', id], { cwd: root });
        return true;
      };
      if (publicationMode === 'off' || !hasRemote(root, remote)) {
        discardUncommittedReservation();
        throw error;
      }
      // Never infer create-only ownership from remote equality after a failed push. Only the
      // machine-sealed `transport-indeterminate` outcome may reconcile exact equality; a
      // definitive rejection can mean another actor installed the same object ID first.
      const recoveryReceipt = await readPendingPublication(root, {
        ...subject, migrate: false
      });
      if (!['rejected', 'transport-indeterminate']
        .includes(recoveryReceipt?.record?.pushOutcome)) {
        discardUncommittedReservation();
        throw error;
      }
      let syncFailure = null;
      try {
        const recovered = await syncPendingLifecyclePublication(root, {
          ...subject, branch: id, remote
        });
        if (recovered.pushed) {
          return {
            id, reservationCommit: recovered.pushed,
            pushed: true, recovered: true, attempt
          };
        }
      } catch (failure) {
        syncFailure = failure;
        if (failure?.code !== 'PUBLICATION_PUSH_FAILED') throw failure;
      }
      await fetchRemote(root, remote);
      const remoteRef = `refs/remotes/${remote}/${id}`;
      if (!refExists(root, remoteRef)) {
        discardUncommittedReservation();
        throw syncFailure ?? error;
      }
      if (refHead(root, remoteRef) === head(root)) throw syncFailure ?? error;
      // A different contributor won the create-only lease. Remove only this exact local attempt
      // after its pending receipt is cleared, then allocate the next ID from refreshed authority.
      await clearPendingPublication(root, subject);
      run('git', ['switch', base], { cwd: root });
      run('git', ['branch', '-D', id], { cwd: root });
      taken.add(id);
      continue;
    }
    const reservationCommit = publication.sha;
    if (publicationMode === 'off') return { id, reservationCommit, pushed: false, attempt };
    if (publication.pushed) return { id, reservationCommit, pushed: true, attempt };
    throw new SingularityFlowError(
      `Local Epic reservation ${id} did not reach its required publication boundary.`
    );
  }
  throw new SingularityFlowError(`Unable to reserve a unique local Epic ID after ${maxAttempts} concurrent attempts.`);
}

/** Finish only the exact Candidate-bound local Epic reservation retained by a failed start. */
export async function syncLocalEpicReservation(root, portfolio, reservation = null, {
  remote = portfolio.git?.remote ?? 'origin'
} = {}) {
  const current = reservation ?? await currentLocalEpicReservation(root, portfolio, {
    remote, fetch: true
  });
  if (!current) {
    throw new SingularityFlowError('No recoverable local Epic reservation is active.', {
      code: 'LOCAL_EPIC_RESERVATION_NOT_FOUND'
    });
  }
  const subject = { kind: 'initiative', id: current.id };
  const reservedBranch = current.branch ?? current.id;
  const pending = await readPendingPublication(root, { ...subject, migrate: false });
  if (!pending) {
    if (current.pushed) return { ...current, recovered: false, noOp: true };
    throw new SingularityFlowError(
      `Local Epic reservation '${current.id}' has no exact pending-publication receipt. `
      + 'Automatic push was refused; inspect the reservation commit before continuing.',
      { code: 'LOCAL_EPIC_RESERVATION_RECEIPT_REQUIRED' }
    );
  }
  const result = await syncPendingLifecyclePublication(root, {
    ...subject, branch: reservedBranch, remote
  });
  return {
    ...current,
    reservationCommit: result.pushed ?? current.reservationCommit,
    pushed: Boolean(result.pushed),
    recovered: result.recovered === true
  };
}
