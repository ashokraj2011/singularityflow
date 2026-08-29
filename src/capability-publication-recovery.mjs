import { currentSchemaVersion } from './schema-migrations.mjs';
import { governedCommitIdentity } from './git.mjs';
import { readPendingPublication, writePendingPublication } from './publication-pending.mjs';
import { nowIso } from './util.mjs';

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
    capabilityPublications: entries,
    error: error?.message ?? String(error ?? 'Capability Story publication is incomplete.')
  };
  await writePendingPublication(root, { kind: 'story', id: workId, record: next });
  return next;
}
