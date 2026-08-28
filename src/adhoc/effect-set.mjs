import path from 'node:path';

import { buildRepositoryChangeSet, changeSetPaths } from '../repository-change-set.mjs';
import { nowIso } from '../util.mjs';
import { adhocError, assertSessionMutable } from './contracts.mjs';
import { readAdhocSession, updateAdhocSession } from './session.mjs';
import { readSessionRecord, writeSessionRecord } from './session-store.mjs';

function resource(entry) {
  const resourceId = entry.newPath ?? entry.oldPath;
  return {
    resourceId,
    kind: entry.newContent?.kind === 'symlink' || entry.newMode === '120000' ? 'symlink' : 'file',
    operation: entry.status,
    beforeSha256: entry.oldObject ? `git:${entry.oldObject}` : null,
    afterSha256: entry.newContent?.sha256 ?? (entry.newObject ? `git:${entry.newObject}` : null),
    bytes: entry.newContent?.bytes ?? 0,
    oldPath: entry.oldPath,
    newPath: entry.newPath,
    resourceSha256: entry.changeId,
    classification: 'author-owned'
  };
}

export async function observeAdhocEffects(root, requested = null) {
  const session = assertSessionMutable(await readAdhocSession(root, requested));
  const baseline = await readSessionRecord(root, session.sessionId, 'baseline');
  const repository = await buildRepositoryChangeSet(root, {
    baseCommit: baseline.revision.gitCommit,
    subject: { kind: 'adhoc', id: session.sessionId }
  });
  if (!repository.entries.length) {
    throw adhocError('ADH_CHANGE_SET_EMPTY', 'No repository changes exist relative to the exact ad hoc baseline.', 'Make the intended change, or close the session as local-only.');
  }
  // Observation time is evidence, not effect identity. Reuse the existing content-addressed record
  // when Git produced the same repository change set so a status/preview refresh cannot invalidate
  // already confirmed intent merely because the clock advanced.
  const existingPreview = await readSessionRecord(root, session.sessionId, 'preview', { required: false });
  if (existingPreview?.baselineSha256 === baseline.baselineSha256
      && existingPreview.repositoryChangeSet?.digest === repository.digest) {
    return existingPreview;
  }
  const preview = await writeSessionRecord(root, session.sessionId, 'preview', {
    kind: 'adhoc-change-set',
    sessionId: session.sessionId,
    baselineSha256: baseline.baselineSha256,
    subjectRevisionBefore: baseline.revision.gitCommit,
    subjectRevisionObserved: repository.target.head,
    resources: repository.entries.map(resource),
    externalEffects: [],
    currentStateSha256: repository.digest,
    repositoryChangeSet: repository,
    changedPaths: changeSetPaths(repository),
    observedAt: nowIso()
  });
  const existingIntent = await readSessionRecord(root, session.sessionId, 'intent', { required: false });
  const status = existingIntent?.changeSetSha256 === preview.changeSetSha256
    ? 'needs-disposition'
    : 'needs-intent';
  await updateAdhocSession(root, session.sessionId, {
    status,
    landing: { changeSetSha256: preview.changeSetSha256, observedAt: preview.observedAt }
  });
  return preview;
}

export function candidateObjective(root, session, changeSet) {
  if (session.initialNote?.trim()) return session.initialNote.trim();
  const paths = changeSet.resources.map((entry) => entry.resourceId);
  if (paths.length === 1) return `Land the reviewed change to ${paths[0]}`;
  const common = paths.map((item) => item.split('/')[0]);
  const scope = common.every((item) => item === common[0]) ? `${common[0]}/` : path.basename(root);
  return `Land ${paths.length} reviewed repository changes in ${scope}`;
}

export async function createIntentCandidate(root, requested = null) {
  const session = await readAdhocSession(root, requested);
  const changeSet = await readSessionRecord(root, session.sessionId, 'preview');
  return writeSessionRecord(root, session.sessionId, 'candidate', {
    kind: 'adhoc-intent-candidate',
    sessionId: session.sessionId,
    changeSetSha256: changeSet.changeSetSha256,
    objective: {
      statement: candidateObjective(root, session, changeSet),
      provenance: 'deterministic-summary-discovered-at-landing'
    },
    claims: [],
    risks: [],
    unknowns: [],
    possibleWorkType: 'ad-hoc-change',
    modelObservationSha256: null,
    createdAt: nowIso()
  });
}
