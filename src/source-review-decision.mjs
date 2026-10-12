/** An exact human disposition packet; preparing it never grants reviewer or lifecycle authority. */
import { createHash } from 'node:crypto';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { SingularityFlowError } from './util.mjs';

export function sourceReviewDecisionPacket({ workflow, phaseId, status, findingId, reason, actor, authority }) {
  const pending = status.pendingDispositions?.find(entry => entry.id === findingId);
  if (!pending || !status.reportSha256 || status.status === 'stale'
      || status.generation !== workflow.phases[phaseId]?.generation) throw new SingularityFlowError(
    'Review the exact current pending disposition before recording a human decision.',
    { code: 'SOURCE_REVIEW_DISPOSITION_NOT_PENDING' });
  if (typeof reason !== 'string' || !reason.trim()) throw new SingularityFlowError(
    'A human-authored reason is required for a source review disposition.',
    { code: 'SOURCE_REVIEW_DISPOSITION_REASON_REQUIRED' });
  if (!authority?.authorityGroup || !actor?.email && !actor?.login) throw new SingularityFlowError(
    'An authorized human identity is required before preparing a source review decision.',
    { code: 'SOURCE_REVIEW_DISPOSITION_AUTHORITY_REQUIRED' });
  const binding = { workId: workflow.workItem.id, phase: phaseId, generation: status.generation,
    reportSha256: status.reportSha256, finding: pending, reason: reason.trim(),
    actor: { email: actor?.email ?? null, login: actor?.login ?? null },
    authorityGroup: authority.authorityGroup };
  const packetSha256 = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
  const commandGuidance = safeCommandGuidance({ argv: ['review-source', 'decide', phaseId,
    '--work-id', workflow.workItem.id, '--finding', findingId, '--reason', reason.trim(),
    '--confirm', packetSha256, '--json'] });
  if (!commandGuidance?.copyable) throw new SingularityFlowError(
    'The disposition reason cannot be relayed as a bounded, literal command. Supply a concise human reason without control characters or placeholder text, then prepare the packet again.',
    { code: 'SOURCE_REVIEW_DISPOSITION_COMMAND_UNAVAILABLE' });
  return { schemaVersion: 1, resultType: 'source-review-decision-context', ready: true,
    binding, packetSha256, reportPath: status.reportPath,
    instruction: 'Confirm this exact finding, report, reason and human authority. This disposition does not accept visual evidence, approve the phase or advance the Story.',
    effects: { stateChanged: false, filesChanged: false, publicationCreated: false },
    commandGuidance };
}

export function assertSourceReviewDecisionConfirmation(packet, confirmation) {
  if (confirmation !== packet.packetSha256) throw new SingularityFlowError(
    'Review and confirm the exact current human source-review disposition packet.',
    { code: 'SOURCE_REVIEW_DECISION_STALE', details: { packetSha256: packet.packetSha256,
      recoveryCommand: `singularity-flow review-source decision-context ${packet.binding.phase} --work-id ${packet.binding.workId} --finding ${packet.binding.finding.id} --reason <TEXT> --json` } });
}
