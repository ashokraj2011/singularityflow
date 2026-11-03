/** Review-only metadata may follow submission; it cannot smuggle source or policy into approval. */
import { exactFileAtObject } from './git.mjs';
import { recordSha256 } from './records.mjs';
import { projectReview, reviewDigest } from './application-review-contract.mjs';
import { recordApplicationReviewAcceptance } from './verification/witness-records.mjs';

export function isApplicationReviewEventChange(change) {
  if (!change) return false;
  const { before, after, event, identity, changed, ownPaths, item } = change;
  if (event?.type !== 'evidence-recorded' || event.payload?.kind !== 'application-review'
      || event.subject?.id !== after.workItem?.id || identity.eventSha256 !== reviewDigest(event)) return false;
  const keys = ['applicationReviews', 'applicationAcceptanceRecords', 'history', 'publicationProjections'];
  if ([...new Set([...Object.keys(before), ...Object.keys(after)])].some(key => !keys.includes(key)
      && recordSha256(before[key] ?? null) !== recordSha256(after[key] ?? null))) return false;
  const beforeSessions = before.applicationReviews ?? [];
  const afterSessions = after.applicationReviews ?? [];
  const session = afterSessions.find(value => value.id === event.payload.sessionId);
  const prior = beforeSessions.find(value => value.id === session?.id);
  if (!session || afterSessions.length !== beforeSessions.length + (prior ? 0 : 1)
      || recordSha256(afterSessions.filter(value => value.id !== session.id)) !== recordSha256(beforeSessions.filter(value => value.id !== session.id))) return false;
  try { projectReview(session); } catch { return false; }
  if (prior && recordSha256({ ...session, revision: prior.revision, events: session.events.slice(0, -1) }) !== recordSha256(prior)) return false;
  if (session.revision !== (prior?.revision ?? 0) + 1) return false;
  const reviewEvent = session.events.at(-1);
  if (reviewEvent.digest !== event.payload.eventSha256 || reviewEvent.actionId !== event.payload.actionId) return false;
  const recordPath = `${item}/context/application-reviews/${reviewEvent.digest.slice(7)}.json`;
  const snapshotPath = reviewEvent.type === 'target-ready' ? reviewEvent.payload.target?.snapshot?.path : null;
  if (snapshotPath && snapshotPath !== `${item}/context/application-reviews/snapshots/${reviewEvent.payload.target.snapshot.digest.slice(7)}.json`) return false;
  if (!changed.includes(recordPath) || changed.some(file => !ownPaths.includes(file) && file !== recordPath && file !== snapshotPath)) return false;
  if (recordSha256(before.history ?? []) !== recordSha256((after.history ?? []).slice(0, -1))
      || (after.history?.length ?? 0) !== (before.history?.length ?? 0) + 1
      || recordSha256(before.publicationProjections ?? []) !== recordSha256((after.publicationProjections ?? []).slice(0, -1))) return false;
  const expected = { ...after, applicationAcceptanceRecords: structuredClone(before.applicationAcceptanceRecords ?? []) };
  if (reviewEvent.type === 'acceptance-finalized') {
    try {
      const view = projectReview(session);
      recordApplicationReviewAcceptance(expected, { confirmation: view.confirmation,
        captures: view.captures.filter(value => value.confirmation === view.confirmation.id), decisions: reviewEvent.payload.decisions,
        target: view.target, actor: reviewEvent.actor, authorityGroup: reviewEvent.payload.authorityGroup, at: reviewEvent.at });
    } catch { return false; }
  }
  return recordSha256(expected.applicationAcceptanceRecords) === recordSha256(after.applicationAcceptanceRecords ?? []);
}

export function applicationReviewCommit(root, change) {
  if (!isApplicationReviewEventChange(change)) return false;
  const digest = change.event.payload.eventSha256;
  const recordPath = `${change.item}/context/application-reviews/${digest.slice(7)}.json`;
  try {
    const record = JSON.parse(exactFileAtObject(root, change.identity.commit, recordPath)?.toString('utf8') ?? 'null');
    const snapshot = record?.payload?.target?.snapshot;
    if (snapshot?.path) {
      const body = JSON.parse(exactFileAtObject(root, change.identity.commit, snapshot.path)?.toString('utf8') ?? 'null');
      if (reviewDigest(body) !== snapshot.digest) return false;
    }
    return record?.digest === digest && recordSha256(record) === recordSha256(change.after.applicationReviews.find(item => item.id === change.event.payload.sessionId).events.at(-1));
  } catch { return false; }
}
