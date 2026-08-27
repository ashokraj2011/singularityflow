import { currentSchemaVersion } from './schema-migrations.mjs';
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
  const record = existing?.record ?? {
    schemaVersion: currentSchemaVersion('pending-publication'),
    subject: { kind: 'story', id: workId },
    branch: publication.branch,
    remote: publication.remote,
    commit: publication.commit,
    event: null,
    createdAt: nowIso()
  };
  const next = {
    ...record,
    recoveryStage: record.recoveryStage ?? 'capability-publication-pending',
    capabilityPublications: entries,
    error: error?.message ?? String(error ?? 'Capability Story publication is incomplete.')
  };
  await writePendingPublication(root, { kind: 'story', id: workId, record: next });
  return next;
}
