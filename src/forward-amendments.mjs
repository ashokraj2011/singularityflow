/**
 * Forward amendment records and the revalidation they ask for. `[UIF-M3]`
 *
 * An earlier document step's corrected artifact is proposed (its bytes saved in the Story) and then
 * approved by that step's approvers as a new generation, without re-running the step. Later steps
 * that read it keep their approval but are listed for revalidation: a person records that each one
 * still holds under the amended input (`unchanged`), or returns the Story to it. Input integrity
 * honours an `unchanged` revalidation only for the exact producer generation and bytes it names and
 * only while the revalidated step keeps the input record it was approved with.
 *
 * Three append-only lists: `forwardAmendments` (proposals), `forwardAmendmentDecisions` and
 * `amendmentRevalidations`. Pure: no I/O.
 */
import { countedRecords } from './presence/counted.mjs';

import {
  forwardAmendmentDecision as amendmentDecision,
  pendingForwardAmendments as pendingProposals,
  pendingAmendmentRevalidations as pendingRevalidations,
  acceptedRevalidationBindings as acceptedBindings
} from './kernel/upstream-issues.mjs';
export {nextForwardAmendmentProposal} from './kernel/upstream-issues.mjs';

export function forwardAmendmentDecision(workflow, amendmentId) {
  return amendmentDecision(workflow, amendmentId, countedRecords(workflow, workflow?.forwardAmendmentDecisions));
}
export function pendingForwardAmendments(workflow) {
  return pendingProposals(workflow, countedRecords(workflow, workflow?.forwardAmendmentDecisions));
}
export function pendingAmendmentRevalidations(workflow) {
  return pendingRevalidations(workflow, {
    decisions: countedRecords(workflow, workflow?.forwardAmendmentDecisions),
    revalidations: countedRecords(workflow, workflow?.amendmentRevalidations)
  });
}

export function revalidateCommand(workId, entry) {
  return `singularity-flow upstream-issue revalidate ${entry.phase} --work-id ${workId} --amendment ${entry.amendment} --outcome unchanged|return --reason "<why>"`;
}

export function acceptedRevalidationBindings(workflow, phase, inputRecordSha256) {
  return acceptedBindings(workflow, phase, inputRecordSha256, countedRecords(workflow, workflow?.amendmentRevalidations));
}

/** Completion waits for every proposal to be decided and every listed step to be revalidated. */
export function forwardAmendmentTerminalBlockers(workflow) {
  const workId = workflow?.workItem?.id ?? '<WORK-ID>';
  return [
    ...pendingForwardAmendments(workflow).map((proposal) => ({
      code: 'FORWARD_AMENDMENT_PENDING',
      message: `${proposal.id} proposes a corrected ${proposal.phase}; ${proposal.phase}'s approvers have not decided it.`,
      command: `singularity-flow upstream-issue decide-amendment ${proposal.id} --work-id ${workId} --decision approve|reject --reason "<why>" --confirm ${proposal.id}`
    })),
    ...pendingAmendmentRevalidations(workflow).map((entry) => ({
      code: 'AMENDMENT_REVALIDATION_REQUIRED',
      message: `${entry.phase} read ${entry.producer} before ${entry.amendment} amended it; ${entry.phase}'s approvers have not revalidated it.`,
      command: revalidateCommand(workId, entry)
    }))
  ];
}
