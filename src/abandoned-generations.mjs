/**
 * The generations a governed rework rollback (`story rework roll-forward`) abandoned or withdrew, proven by its own commit,
 * for the final audit (governance.mjs). Moved out of governance.mjs so a Story's eager commands do not load it.
 */
import path from 'node:path';
import { canonicalJson, recordSha256 } from './records.mjs';
import { exactFileAtObject, firstParentCommitsMentioning, governedCommitIdentity, head } from './git.mjs';
import { publishedGenerationCommit } from './generation-publication-store.mjs';
import { posix } from './util.mjs';

/**
 * Abandoned draft files may be absent only when the governed rollback proves that history.
 *
 * Each abandoned change request is verified on its own: one whose history cannot be read records
 * an error in `errors` and exempts nothing, while the others are still verified. A version the
 * rollback withdrew before it was published has no publication at all; it is verified the same way
 * and also added to `withdrawn` [OSA §4.3].
 */
export function verifiedAbandonedGenerations(root, config, workflow, { errors = [], withdrawn = new Set() } = {}) {
  const verified = new Set();
  const identities = new Map();
  const identityAt = (commit) => {
    if (!identities.has(commit)) identities.set(commit, governedCommitIdentity(root, commit));
    return identities.get(commit);
  };
  const relative = posix(path.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'workflow.json'));
  const committedWorkflow = (commit) => {
    const bytes = exactFileAtObject(root, commit, relative, { maximumBytes: 16 * 1024 * 1024 });
    return bytes ? JSON.parse(bytes.toString('utf8')) : null;
  };
  let tip = null;
  for (const request of workflow.changeRequests ?? []) {
    const discarded = Array.isArray(request.resolution?.abandonedGenerations) ? request.resolution.abandonedGenerations : [];
    const withdrawals = Array.isArray(request.resolution?.withdrawnVersions) ? request.resolution.withdrawnVersions : [];
    if (request.status !== 'abandoned' || request.resolution?.status !== 'abandoned'
        || !(discarded.length || withdrawals.length)) continue;
    try {
      const events = (workflow.publicationProjections ?? []).map((entry) => entry.event).filter((event) =>
        event?.type === 'rework-rolled-forward' && event.subject?.kind === 'story'
        && event.subject.id === workflow.workItem.id && event.payload?.changeRequestId === request.id
        && event.payload?.decision === 'abandoned'
        && event.payload?.checkpointId === request.forwardCheckpoint?.id
        && event.payload?.confirmation === request.resolution.confirmation);
      if (events.length !== 1) continue;
      const event = events[0];
      const eventSha256 = `sha256:${recordSha256(event)}`;
      tip ??= head(root);
      // The rollback commit was made after the rejection captured its forward checkpoint, so only
      // first-parent history after that checkpoint (and after the event's own source) can hold it.
      // A copied projection has no commit whose event trailer authenticates it: no exception.
      const identity = firstParentCommitsMentioning(root, eventSha256, {
        tip, after: [event.sourceCommit, request.forwardCheckpoint?.sourceCommit]
      }).map(identityAt).find((candidate) => candidate?.eventSha256 === eventSha256) ?? null;
      if (!identity?.transactionId || identity.parents.length !== 1
          || (event.sourceCommit && identity.parents[0] !== event.sourceCommit)) continue;
      const retained = committedWorkflow(identity.commit);
      const before = committedWorkflow(identity.parents[0]);
      const committed = retained?.changeRequests?.find((entry) => entry.id === request.id);
      const prior = before?.changeRequests?.find((entry) => entry.id === request.id);
      if (canonicalJson(committed?.resolution) !== canonicalJson(request.resolution)
          || committed?.status !== 'abandoned' || prior?.status !== 'open'
          || canonicalJson(committed.forwardCheckpoint) !== canonicalJson(prior.forwardCheckpoint)
          || !(retained?.publicationProjections ?? []).some((entry) =>
            canonicalJson(entry.event) === canonicalJson(event))
          || (before?.publicationProjections ?? []).some((entry) => entry.event?.eventId === event.eventId)) continue;
      const exempt = [];
      for (const { phase: phaseId, generation } of discarded) {
        const phase = workflow.phases?.[phaseId];
        if (!phase || !Number.isInteger(generation) || generation < 1 || generation === Number(phase.generation)
            || Number(before.phases?.[phaseId]?.generation ?? 0) < generation
            || Number(retained.phases?.[phaseId]?.generation ?? 0) >= generation) continue;
        const publication = publishedGenerationCommit(root, before, before.phases[phaseId], generation);
        if (publication) exempt.push(`${phaseId}:${generation}`);
      }
      // Withdrawn unpublished: opened by an operation and not published just before the rollback, its number still
      // reserved just after it.
      const unpublished = [];
      for (const { phase: phaseId, version } of withdrawals) {
        const phase = workflow.phases?.[phaseId], opening = before.phases?.[phaseId]?.versionOpening;
        if (!phase || !Number.isInteger(version) || version < 1 || version === Number(phase.generation)
            || !opening?.operationId || Number(opening.version) !== version || Number(before.phases[phaseId].generation ?? 0) >= version
            || Number(retained.phases?.[phaseId]?.generationHighWatermark ?? 0) < version) continue;
        unpublished.push(`${phaseId}:${version}`);
      }
      // A request whose verification fails part-way exempts nothing.
      for (const key of exempt) verified.add(key);
      for (const key of unpublished) { verified.add(key); withdrawn.add(key); }
    } catch (error) {
      errors.push(`abandoned rework ${request.id} could not be verified: ${error.message}`);
    }
  }
  return verified;
}
