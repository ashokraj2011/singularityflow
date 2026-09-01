import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import {
  branch, checkout, fetchRemote, fileAtRef, hasRemote, head, refExists, refHead, remoteBranches
} from './git.mjs';
import {
  ensureDir, exists, nowIso, posix, run, SingularityFlowError, writeJson
} from './util.mjs';
import { LIFECYCLE_EVENT, lifecycleEvent } from './lifecycle-event.mjs';
import { publishLifecycleChange } from './publication-unit-of-work.mjs';
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

export async function scanLocalIdentities(root, portfolio, {
  remote = portfolio.git?.remote ?? 'origin',
  fetch = false
} = {}) {
  if (fetch && hasRemote(root, remote)) fetchRemote(root, remote);
  const localRefs = run('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: root }).stdout
    .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const remotes = remoteBranches(root, remote);
  const initiatives = await directoryNames(path.join(root, portfolio.initiativeRoot));
  const breakdownIds = [
    ...await workingTreeBreakdownIds(root, portfolio),
    ...remoteBreakdownIds(root, portfolio, remote, remotes)
  ];
  const values = [...initiatives, ...localRefs.map(branchId), ...remotes.map(branchId), ...breakdownIds];
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return {
    values: [...new Set(values)].sort(),
    duplicates: [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([id, count]) => ({ id, count }))
  };
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
    scan
  };
}

export async function currentLocalEpicReservation(root, portfolio, {
  remote = portfolio.git?.remote ?? 'origin',
  fetch = false
} = {}) {
  const policy = localPolicy(portfolio);
  const id = branch(root);
  if (!identityPattern(policy.epicPrefix, policy.pad).test(id)) return null;
  const relative = posix(path.join('singularity', 'identity-reservations', `${id}.json`));
  const absolute = path.join(root, relative);
  if (!await exists(absolute)) return null;
  const state = path.join(root, portfolio.initiativeRoot, id, 'state.json');
  if (await exists(state)) return null;
  let record;
  try {
    record = readRecord('local-identity-reservation', await readFile(absolute)).record;
  } catch {
    throw new SingularityFlowError(`Local Epic reservation ${relative} is not valid JSON.`);
  }
  if (record?.id !== id || record?.kind !== 'epic' || record?.authority !== 'local') {
    throw new SingularityFlowError(`Local Epic reservation ${relative} does not match branch '${id}'.`);
  }
  if (fetch && hasRemote(root, remote)) fetchRemote(root, remote);
  const reservationCommit = run(
    'git',
    ['log', '-1', '--format=%H', '--', relative],
    { cwd: root, allowFailure: true }
  ).stdout.trim();
  if (!reservationCommit) {
    throw new SingularityFlowError(`Local Epic reservation ${relative} has not been committed.`);
  }
  return {
    id,
    reservationCommit,
    pushed: refExists(root, `refs/remotes/${remote}/${id}`)
      && refHead(root, `refs/remotes/${remote}/${id}`) === reservationCommit,
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
  fault = null
} = {}) {
  if (branch(root) !== base) {
    throw new SingularityFlowError(`Local Epic allocation must start on base branch '${base}', not '${branch(root)}'.`);
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const allocation = await nextLocalEpicId(root, portfolio, { remote, fetch: true });
    const id = allocation.id;
    // Allocation fetched the organisation remote to discover concurrent reservations. The new
    // Epic must also fork from that refreshed base; otherwise it can omit configuration and a
    // repository world model already published by another contributor.
    checkout(root, id, { base, remote, preferRemoteBase: true });
    const relative = posix(path.join('singularity', 'identity-reservations', `${id}.json`));
    const absolute = path.join(root, relative);
    const reservation = {
      schemaVersion: currentSchemaVersion('local-identity-reservation'),
      id,
      kind: 'epic',
      authority: 'local',
      reservedAt: nowIso(),
      reservedBy: actor ?? null
    };
    const subject = { kind: 'initiative', id, branch: id };
    const publicationMode = portfolio.git?.publish === 'off' ? 'off' : 'required';
    const expectedHead = head(root);
    let publication;
    try {
      publication = await publishLifecycleChange(root, {
        subject,
        expectedRevision: { head: expectedHead },
        allowedPaths: [relative],
        event: lifecycleEvent({
          type: LIFECYCLE_EVENT.BINDING, subject, actor,
          payload: { operation: 'reserve-local-epic-identity', authority: 'local' }
        }),
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
      fetchRemote(root, remote);
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
    ...subject, branch: current.id, remote
  });
  return {
    ...current,
    reservationCommit: result.pushed ?? current.reservationCommit,
    pushed: Boolean(result.pushed),
    recovered: result.recovered === true
  };
}
