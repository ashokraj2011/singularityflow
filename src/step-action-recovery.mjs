/** Reconstruct missing required deliveries from committed, hash-bound lifecycle events.
 * Never sends: a lost local outbox cannot establish whether another machine already sent it.
 */
import path from 'node:path';
import { commitIsAncestor, exactRemoteBranchObservationAsync, firstParentCommitsMentioning, governedCommitIdentity, remoteContains } from './git.mjs';
import { configuredRemoteAuthority } from './git-remote-diagnostics.mjs';
import { recordSha256 } from './records.mjs';
import { enqueueStepActions, readStepActionDelivery } from './step-action-delivery.mjs';
import { lifecycleOf } from './step-action-pipeline.mjs';
import { missingRequiredStepActionReceipts, requiredStepActionDeliveries } from './step-action-receipts.mjs';

export async function reconstructRequiredStepActions(root, config, workflow, { keys = null } = {}) {
  const missing = await missingRequiredStepActionReceipts(root, config, workflow);
  const wanted = new Map();
  for (const entry of missing) {
    if (keys && !keys.includes(entry.key)) continue;
    // Never replace even a damaged outbox record: it may contain delivery history.
    if (!await readStepActionDelivery(root, entry.key)) wanted.set(entry.key, entry);
  }
  const restored = [];
  const unavailable = [];
  if (!wanted.size) return { restored, unavailable: [] };
  const storyFile = path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'workflow.json');
  for (const commit of firstParentCommitsMentioning(root, 'Singularity-Flow-Event-SHA256:')) {
    const identity = governedCommitIdentity(root, commit);
    if (!identity?.eventSha256) continue;
    const lifecycle = lifecycleOf(root, identity);
    if (!lifecycle || lifecycle.file !== storyFile || lifecycle.workflow.workItem?.id !== workflow.workItem.id) continue;
    const { workflow: committed, event } = lifecycle;
    if (!['phase-approved', 'approval-requested'].includes(event.type)) continue;
    const candidates = requiredStepActionDeliveries(committed).filter(entry => wanted.has(entry.key) && entry.phaseId === event.phaseId);
    for (const entry of candidates) {
      if (event.generation !== entry.generation) continue;
      const pinned = value => value.resolution?.phases?.find(phase => phase.id === entry.phaseId)?.afterStep?.find(action => action.id === entry.action);
      if (recordSha256(pinned(committed)) !== recordSha256(pinned(workflow))) continue;
      let published = identity.publicationMode === 'off'
        || remoteContains(root, commit, config.git?.remote ?? 'origin', committed.workItem.branch);
      if (!published) {
        // URL-based pushes need not advance origin/* locally. Check the exact remote tip before
        // making a new waiting record that `sync` cannot release when its pending marker is gone.
        try {
          const authority = configuredRemoteAuthority(root, config.git?.remote ?? 'origin');
          const observed = await exactRemoteBranchObservationAsync(root, authority.url, committed.workItem.branch);
          published = observed.reachable && !observed.malformed && observed.sha
            && commitIsAncestor(root, commit, observed.sha);
        } catch { /* No publication proof: keep the delivery absent and offer a recoverable route. */ }
      }
      if (!published) {
        unavailable.push({ key: entry.key, commit,
          reason: 'Approval publication could not be verified. If publication is pending, run singularity-flow sync; otherwise publish the reviewed Story branch. Run singularity-flow refresh-branch to load its remote history, then retry this delivery key. No request or waiting record was created.' });
        wanted.delete(entry.key);
        continue;
      }
      const records = await enqueueStepActions(root, committed, {
        event, commit, published, fromCommit: true, recovered: true,
        include: (action, trigger) => action.id === entry.action && trigger === 'approved'
      });
      for (const record of records) restored.push({
        key: record.key, commit, status: record.status, phaseId: record.phaseId,
        priorOutcome: 'unknown',
        message: 'Reconstructed from committed approval; no request was sent. Check the receiver for this delivery key before explicitly retrying; duplicate side effects are possible.',
        command: record.status === 'waiting' ? 'singularity-flow sync'
          : record.status === 'pipeline' ? `singularity-flow integrations deliver --commit ${commit} --record`
            : `singularity-flow integrations retry ${record.key}`
      });
      wanted.delete(entry.key);
    }
    if (!wanted.size) break;
  }
  return { restored, unavailable: [...unavailable, ...[...wanted.keys()].map(key => ({ key,
    reason: 'No matching hash-bound approval with the pinned action was found in this branch. Fetch the complete Story history and retry; no delivery was invented.' }))] };
}
