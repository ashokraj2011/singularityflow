import path from 'node:path';
import { canonicalJson } from './records.mjs';
import { readStoryReviewPacket } from './story-lineage.mjs';
import { evaluateQuickFixWaiver, supportedWaiverPolicy } from './quick-fix-policy.mjs';
import { assertWorkReconciliationIntegrity } from './work-intervals.mjs';
import { exactFileAtObject } from './git.mjs';

function committedJson(root, commit, relative) {
  const bytes = exactFileAtObject(root, commit, relative, { maximumBytes: 16 * 1024 * 1024 });
  if (!bytes) throw new Error(`committed waiver evidence is missing: ${relative}`);
  return JSON.parse(bytes.toString('utf8'));
}

/** Replay a policy waiver from its hash-verified submission and sealed reconciliation. */
export async function verifyPhaseApprovalWaiver(root, config, workflow, phase) {
  try {
    const policy = supportedWaiverPolicy(phase.approvalPolicy);
    if (!policy || phase.approvalDisposition !== 'policy_waived') {
      throw new Error('the phase has no supported policy-waiver disposition');
    }
    const entry = [...(workflow.lineage?.submissions ?? [])].reverse().find((candidate) =>
      candidate.phase === phase.id && Number(candidate.generation) === Number(phase.generation));
    if (!entry) throw new Error('the waived generation has no immutable submission');
    const packet = await readStoryReviewPacket(root, config, workflow, entry.packetSha256);
    if (packet.workId !== workflow.workItem.id || packet.phase !== phase.id
        || Number(packet.generation) !== Number(phase.generation) || packet.status !== 'policy_waived'
        || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(packet.submissionCommit ?? '')) {
      throw new Error('the immutable submission does not authorize this waived generation');
    }
    const relative = path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'workflow.json');
    const retained = committedJson(root, packet.evidenceCommit, relative);
    const historical = retained.phases?.[phase.id];
    const waiver = historical?.approvalWaiver;
    const pinned = workflow.resolution?.phases?.find((candidate) => candidate.id === phase.id)?.approval;
    if (retained.workItem?.id !== workflow.workItem.id || Number(historical?.generation) !== Number(phase.generation)
        || historical?.approvalDisposition !== 'policy_waived' || !waiver
        || canonicalJson(waiver) !== canonicalJson(phase.approvalWaiver)
        || canonicalJson(historical.approvalPolicy) !== canonicalJson(phase.approvalPolicy)
        || canonicalJson(pinned) !== canonicalJson(phase.approvalPolicy)
        || canonicalJson(retained.workItem.source) !== canonicalJson(workflow.workItem.source)
        || canonicalJson(packet.checks) !== canonicalJson(phase.checks)
        || waiver.sourceCommit !== packet.submissionCommit || waiver.waivedAt !== packet.submittedAt) {
      throw new Error('waiver, policy, source, or checks differ from the committed submission');
    }
    const reference = historical.workIntervalReconciliation;
    const expectedPath = path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id,
      'context/work-intervals/reconciliations', `${waiver.reconciliationSha256}.json`);
    if (!/^[a-f0-9]{64}$/u.test(waiver.reconciliationSha256 ?? '') || reference?.path !== expectedPath) {
      throw new Error('the waiver has no owned reconciliation binding');
    }
    const reconciliation = assertWorkReconciliationIntegrity(
      committedJson(root, packet.evidenceCommit, reference.path), {
        reference, workId: workflow.workItem.id, phaseId: phase.id, generation: phase.generation
      });
    if (reconciliation.reconciliationSha256 !== waiver.reconciliationSha256
        || reconciliation.target?.head !== packet.submissionCommit
        || canonicalJson(reconciliation.summary) !== canonicalJson(reference.summary)
        || canonicalJson(reconciliation.decision) !== canonicalJson(reference.decision)) {
      throw new Error('the sealed reconciliation differs from the waiver decision');
    }
    const replay = evaluateQuickFixWaiver(root, config, retained, {
      ...historical, checks: packet.checks, workIntervalReconciliation: reconciliation
    }, policy, { targetCommit: packet.submissionCommit });
    if (!replay.eligible || replay.policyHash !== waiver.policySha256 || replay.policyId !== waiver.policyId
        || canonicalJson(replay.predicates) !== canonicalJson(waiver.predicates)) {
      throw new Error('the exact submitted checks and changes no longer reproduce the policy waiver');
    }
    const events = (retained.history ?? []).filter((event) => event.event === 'phase-approval-waived'
      && event.phase === phase.id && event.at === waiver.waivedAt);
    if (events.length !== 1 || events[0].policyHash !== replay.policyHash
        || events[0].sourceCommit !== replay.sourceCommit || events[0].changedPathsHash !== replay.changedPathsHash
        || events[0].reconciliationSha256 !== waiver.reconciliationSha256
        || canonicalJson(events[0].predicates) !== canonicalJson(replay.predicates)) {
      throw new Error('the committed lifecycle decision does not bind the replayed waiver');
    }
    return { valid: true, errors: [], evidenceCommit: packet.evidenceCommit, packetSha256: packet.packetSha256 };
  } catch (error) {
    return { valid: false, errors: [error.message] };
  }
}
