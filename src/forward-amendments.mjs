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
 * `amendmentRevalidations`, which also keeps the answers for an intent amendment's rows. Pure: no I/O.
 */
import { countedRecords } from './presence/counted.mjs';

/** Where the next proposal's bytes are saved: the Story's own record, never the step's artifact. */
export function nextForwardAmendmentProposal(itemRelative, workflow, artifactRelative) {
  const id = `FAM-${String((workflow?.forwardAmendments ?? []).length + 1).padStart(3, '0')}`;
  return { id, proposedPath: `${itemRelative}/context/amendments/${id}-${String(artifactRelative).split('/').at(-1)}` };
}

/** The latest decision on a proposal, or null while it waits. */
export function forwardAmendmentDecision(workflow, amendmentId) {
  return countedRecords(workflow, workflow?.forwardAmendmentDecisions).findLast((entry) => entry?.amendment === amendmentId) ?? null;
}

/** Proposals nobody has decided yet. */
export function pendingForwardAmendments(workflow) {
  return (workflow?.forwardAmendments ?? []).filter((proposal) => !forwardAmendmentDecision(workflow, proposal.id));
}

/**
 * Each step an approved amendment listed for revalidation that has no revalidation yet and still
 * stands at the generation it was approved with. A step sent back for rework reads its inputs again
 * in its next generation, so nothing is owed for it any more.
 *
 * An approved intent amendment that updated the spec to what a conformance report found the code doing
 * lists the steps that read the scope the same way, the report's own step among them, waiting for its
 * approval [SCS:REQ-022]; the scope step is their producer.
 */
export function pendingAmendmentRevalidations(workflow) {
  const decided = new Set(countedRecords(workflow, workflow?.amendmentRevalidations).map((entry) => `${entry.amendment}\u0000${entry.phase}`));
  const owed = (amendment, producer, items) => (items ?? [])
    .filter((item) => ['approved', 'awaiting_approval'].includes(workflow.phases?.[item.phase]?.status)
      && Number(workflow.phases[item.phase].generation) === Number(item.generation)
      && !decided.has(`${amendment}\u0000${item.phase}`))
    .map((item) => ({ amendment, phase: item.phase, generation: item.generation, producer,
      // A step an intent amendment kept while its prompt held a changed clause (D1, CIC:REQ-021), with what to recommend.
      ...(item.reason ? { reason: item.reason, clauses: item.clauses ?? [], recommend: item.recommend ?? null, namedPaths: item.namedPaths ?? [] } : {}) }));
  return [
    ...countedRecords(workflow, workflow?.forwardAmendmentDecisions).filter((entry) => entry?.decision === 'approved')
      .flatMap((entry) => owed(entry.amendment, entry.phase, entry.revalidate)),
    ...(workflow?.intentAmendments ?? []).filter((entry) => ['approved', 'revalidated'].includes(entry?.status) && entry.producer)
      .flatMap((entry) => owed(entry.id, entry.producer, entry.revalidate))
  ];
}

export function revalidateCommand(workId, entry) {
  // The outcome is the approvers' choice, so it is a placeholder: a bare `unchanged|return` failed the
  // route filter, and every refusal plan and hold dropped the revalidation [PHR:REQ-003].
  return `singularity-flow upstream-issue revalidate ${entry.phase} --work-id ${workId} --amendment ${entry.amendment} --outcome <unchanged|return> --reason "<why>"`;
}

/**
 * Producers whose amended generation this step was revalidated against, keyed by producer, for the
 * step's current generation and exact input record. A later amendment of the same producer needs
 * its own revalidation, because the binding names the producer's generation and bytes.
 */
export function acceptedRevalidationBindings(workflow, phase, inputRecordSha256) {
  const bindings = new Map();
  for (const entry of countedRecords(workflow, workflow?.amendmentRevalidations)) {
    if (entry?.phase !== phase?.id || entry.outcome !== 'unchanged'
        || Number(entry.generation) !== Number(phase.generation)
        || entry.binding?.inputRecordSha256 !== inputRecordSha256) continue;
    bindings.set(entry.binding.producer, { ...entry.binding, amendment: entry.amendment });
  }
  // A plan kept by an approved intent amendment that carried its rows, signed by its approvers [PHR:REQ-008].
  const signed = countedRecords(workflow, workflow?.planAmendments).filter((row) => row?.kind === 'plan-row-correction' && row.ownerPhase === phase?.id);
  for (const amendment of workflow?.intentAmendments ?? []) {
    if (!['approved', 'revalidated'].includes(amendment?.status) || !signed.some((row) => row.intentAmendment === amendment.id)) continue;
    for (const entry of amendment.planBindings ?? []) {
      if (entry?.phase !== phase?.id || Number(entry.generation) !== Number(phase.generation) || entry.binding?.inputRecordSha256 !== inputRecordSha256) continue;
      bindings.set(entry.binding.producer, { ...entry.binding, amendment: amendment.id });
    }
  }
  return bindings;
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
