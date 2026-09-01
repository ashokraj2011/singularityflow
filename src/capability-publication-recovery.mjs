import { currentSchemaVersion } from './schema-migrations.mjs';
import { governedCommitIdentity } from './git.mjs';
import {
  clearPendingPublication, readPendingPublication, writePendingPublication
} from './publication-pending.mjs';
import { publishCapabilityRepositories } from './capability-start.mjs';
import { recordSha256 } from './records.mjs';
import { nowIso } from './util.mjs';

const CAPABILITY_PUBLICATION_IDENTITY_FIELDS = Object.freeze([
  'schemaVersion', 'repository', 'root', 'remote', 'branch', 'commit', 'destinationRef',
  'remoteFingerprint', 'expectedRemoteSha'
]);

function capabilityPublicationIdentity(entry) {
  const fields = (entry?.schemaVersion ?? 1) >= 2
    ? [...CAPABILITY_PUBLICATION_IDENTITY_FIELDS, 'baseCommit', 'candidate']
    : CAPABILITY_PUBLICATION_IDENTITY_FIELDS;
  return Object.fromEntries(fields.map((field) => [
    field,
    entry?.[field] === undefined ? null : entry[field]
  ]));
}

export function capabilityPublicationEntrySha256(entry) {
  return `sha256:${recordSha256(capabilityPublicationIdentity(entry))}`;
}

/** Immutable cross-repository transport authority bound into the governed root event digest. */
export function capabilityPublicationPlanSha256(entries = []) {
  return `sha256:${recordSha256(entries.map(capabilityPublicationIdentity))}`;
}

export function verifyCapabilityPublicationRecoveryPlan(record) {
  const failures = [];
  const plan = record?.capabilityPublicationPlan;
  const pending = record?.capabilityPublications ?? [];
  const expectedSha256 = record?.event?.payload?.capabilityPublicationPlanSha256 ?? null;
  if (!Array.isArray(plan) || !plan.length) failures.push('authenticated capability publication plan is missing');
  if (!expectedSha256) failures.push('governed event does not bind a capability publication plan digest');
  if (Array.isArray(plan) && expectedSha256
    && capabilityPublicationPlanSha256(plan) !== expectedSha256) {
    failures.push('capability publication plan digest does not match the governed event');
  }
  if (!Array.isArray(pending)) failures.push('remaining capability publications are invalid');
  if (Array.isArray(plan) && Array.isArray(pending)) {
    const identities = new Map(plan.map((entry) => [
      JSON.stringify(capabilityPublicationIdentity(entry)), entry
    ]));
    if (identities.size !== plan.length) failures.push('capability publication plan contains duplicate entries');
    for (const entry of pending) {
      const identity = JSON.stringify(capabilityPublicationIdentity(entry));
      if (!identities.has(identity)) {
        failures.push(`remaining capability publication '${entry?.repository ?? 'unknown'}' is not in the governed plan`);
      }
      if (!['not-attempted', 'rejected', 'transport-indeterminate'].includes(entry?.pushOutcome)) {
        failures.push(`remaining capability publication '${entry?.repository ?? 'unknown'}' has an invalid push outcome`);
      }
      if ((entry?.schemaVersion ?? 1) >= 2 && (!entry.candidate
          || entry.commit !== entry.candidate.candidateCommit
          || entry.baseCommit == null)) {
        failures.push(`remaining capability publication '${entry?.repository ?? 'unknown'}' has no exact Candidate binding`);
      }
    }
  }
  return Object.freeze({ valid: failures.length === 0, failures: Object.freeze(failures) });
}

/**
 * Bind unfinished cross-repository Story refs to the exact durable lifecycle commit.
 *
 * Story creation has more than one entry surface. Keeping this receipt builder in the CLI made the
 * terminal recoverable while desktop/Change-Flight-Plan starts silently forgot their sibling refs.
 * The root publication remains the authority boundary: before it exists, ordinary Story-start
 * rollback removes the prepared branches and there is deliberately nothing to synchronize.
 */
export async function retainCapabilityPublicationRecovery(root, workId, publication, entries, error, {
  rootPublished = false
} = {}) {
  if (!entries?.length) return null;
  const normalizedEntries = entries.map((entry) => ({
    ...entry,
    pushOutcome: entry.pushOutcome ?? 'not-attempted'
  }));
  const existing = await readPendingPublication(root, { kind: 'story', id: workId });
  if (!rootPublished && !existing) return null;
  const commit = publication.commit ?? publication.sha ?? null;
  const identity = commit ? governedCommitIdentity(root, commit) : null;
  const record = existing?.record ?? {
    schemaVersion: currentSchemaVersion('pending-publication'),
    subject: { kind: 'story', id: workId },
    branch: publication.branch,
    remote: publication.remote,
    commit,
    event: publication.event ?? null,
    transactionId: identity?.transactionId ?? null,
    tree: identity?.tree ?? null,
    eventSha256: identity?.eventSha256 ?? null,
    stateSha256: identity?.stateSha256 ?? null,
    publicationMode: identity?.publicationMode ?? null,
    createdAt: nowIso()
  };
  const next = {
    ...record,
    // This bit cannot authorize a push: sync independently verifies every marker field against the
    // governed commit. It only records whether the lifecycle ref already landed, so a sibling-only
    // retry does not hide a still-pending root publication.
    rootPublished: record.rootPublished === true || rootPublished === true,
    recoveryStage: record.recoveryStage ?? 'capability-publication-pending',
    capabilityPublicationPlan: record.capabilityPublicationPlan ?? normalizedEntries,
    capabilityPublications: normalizedEntries,
    error: error?.message ?? String(error ?? 'Capability Story publication is incomplete.')
  };
  await writePendingPublication(root, { kind: 'story', id: workId, record: next });
  return next;
}

/**
 * Publish the cross-repository tail one ref at a time, moving its durable recovery boundary before
 * every network operation.
 *
 * The marker deliberately says `transport-indeterminate` while Git is running. If this process is
 * killed after receive-pack advances the ref but before Git returns, `sync` may prove that exact
 * recorded tip and finish idempotently. The in-memory entry retains its previous outcome, though:
 * a definitive create-only collision returned to this process must still be recorded as rejected,
 * and must never acquire equality authority merely because the pre-push receipt was durable.
 */
export async function publishCapabilityRepositoriesDurably(
  root, workId, publication, entries = [], { rootPublished = true } = {}
) {
  const subject = { kind: 'story', id: workId };
  const published = [];
  let remaining = entries.map((entry) => ({
    ...entry,
    pushOutcome: entry.pushOutcome ?? 'not-attempted'
  }));

  while (remaining.length) {
    const [entry, ...tail] = remaining;
    const inFlight = { ...entry, pushOutcome: 'transport-indeterminate' };
    const durablePlan = [inFlight, ...tail];
    await retainCapabilityPublicationRecovery(
      root, workId, publication, durablePlan,
      new Error(`Capability Story branch publication is in flight for '${entry.repository}'.`),
      { rootPublished }
    );

    let result;
    try {
      // Use the pre-attempt outcome in memory. The durable in-flight receipt is recovery authority
      // only if this process disappears or the transport itself reports an ambiguous outcome.
      result = await publishCapabilityRepositories([entry]);
    } catch (error) {
      await retainCapabilityPublicationRecovery(
        root, workId, publication, durablePlan, error, { rootPublished }
      );
      return {
        published,
        pending: durablePlan,
        error: error?.message ?? String(error)
      };
    }

    published.push(...result.published);
    if (result.pending.length) {
      remaining = [...result.pending, ...tail];
      await retainCapabilityPublicationRecovery(
        root, workId, publication, remaining,
        new Error(result.error || `Capability Story publication failed for '${entry.repository}'.`),
        { rootPublished }
      );
      return { published, pending: remaining, error: result.error };
    }

    remaining = tail;
    if (remaining.length) {
      await retainCapabilityPublicationRecovery(
        root, workId, publication, remaining,
        new Error('Capability Story branch publication is continuing.'),
        { rootPublished }
      );
    } else {
      await clearPendingPublication(root, subject);
    }
  }

  return { published, pending: [], error: null };
}
