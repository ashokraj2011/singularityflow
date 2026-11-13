/**
 * Applicability decisions for the responsibilities a route declares it omits [E2G-005, D18].
 *
 * A workflow may end a Story without a responsibility only where it declared `omits` with an
 * approval group; a person in that group then records why the responsibility does not apply to
 * this Story. Pure: these helpers read and change the aggregate and perform no I/O.
 */
import { countedRecords, inDecisionOrder, isWithdrawn } from '../presence/counted.mjs';
import {endpointTaken,omissionAuthorities,applicabilityStatusValue} from '../kernel/applicability.mjs';
export {endpointTaken,omissionAuthorities,recordApplicabilityDecision} from '../kernel/applicability.mjs';

/**
 * The end a Story reached, or will reach if nothing changes: the decision route that finished it,
 * otherwise the natural end after its last step.
 */
/** The current applicability decision for a responsibility, if one was recorded. */
export function applicabilityDecision(workflow, responsibility) {
  return [...inDecisionOrder(workflow, countedRecords(workflow, workflow?.applicability))].reverse().find((entry) => entry.responsibility === responsibility && !isWithdrawn(workflow, entry)) ?? null;
}

/**
 * What the end a Story reached still needs: each omitted responsibility with its decision, if any,
 * and whether that decision was made by the group the omission names.
 */
export function applicabilityStatus(workflow, endpoint = endpointTaken(workflow)) {
  const selected=(endpoint?.omits??[]).map(entry=>applicabilityDecision(workflow,entry.responsibility)).filter(Boolean)
    .map(({withdrawnAt,...entry})=>entry);
  return applicabilityStatusValue(workflow,endpoint,selected);
}
