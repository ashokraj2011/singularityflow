/**
 * Whether a person's record accepted or rejected a departure [CQF:REQ-025, REQ-026], read from counted
 * records only. Kept apart from departures.mjs so a reader on a hot path (the conformance gap decisions,
 * [SCS:REQ-013]) can ask without loading the departure model and the plan amendment rules.
 */
import { countedRecords, isWithdrawn } from './presence/counted.mjs';

// The same plan row change, whatever the row's digest was when it was asked for.
const sameOperation = (left, right) => {
  const strip = ({ previousClaimSha256, ...rest } = {}) => JSON.stringify(Object.keys(rest).sort().map((key) => [key, rest[key]]));
  return strip(left) === strip(right);
};

/**
 * The counted record that accepted a departure, or null: a decided plan amendment naming it, the approved
 * forward amendment proposed from it, a plan row correction asking for its exact change since it was
 * recorded, or the approved intent amendment proposed from it. `hashes` is what that record bound for each file.
 */
export function departureAcceptance(workflow, departure) {
  if (['path', 'supporting'].includes(departure.kind)) {
    const amendment = countedRecords(workflow, workflow?.planAmendments)
      .filter((entry) => (entry.departures ?? []).includes(departure.id) && !isWithdrawn(workflow, entry)).at(-1);
    return amendment ? { kind: 'plan-amendment', id: amendment.id, at: amendment.at, hashes: amendment.contentHashes ?? {} } : null;
  }
  if (departure.kind === 'wording') {
    const proposal = (workflow?.forwardAmendments ?? []).findLast((entry) => entry.departure === departure.id);
    const decision = proposal ? countedRecords(workflow, workflow?.forwardAmendmentDecisions).findLast((entry) => entry.amendment === proposal.id) : null;
    return decision?.decision === 'approved' ? { kind: 'forward-amendment', id: proposal.id, at: decision.at, hashes: null } : null;
  }
  if (departure.kind === 'clause') {
    const amendment = (workflow?.intentAmendments ?? []).findLast((entry) => entry.departure === departure.id && entry.status === 'approved');
    return amendment ? { kind: 'intent-amendment', id: amendment.id, at: amendment.decision?.at ?? amendment.at ?? null, hashes: null } : null;
  }
  if (departure.kind === 'finding') {
    const accepted = countedRecords(workflow, workflow?.departureDecisions)
      .filter((entry) => entry.decision === 'accepted' && (entry.departures ?? []).includes(departure.id)).at(-1);
    return accepted ? { kind: 'departure-acceptance', id: accepted.id, at: accepted.at, hashes: accepted.hashes ?? {} } : null;
  }
  const correction = countedRecords(workflow, workflow?.planRowCorrections)
    .filter((entry) => String(entry.at) >= String(departure.at) && (entry.operations ?? []).some((operation) => sameOperation(operation, departure.change))).at(-1);
  return correction ? { kind: 'plan-row-correction', id: correction.id, at: correction.at, hashes: null } : null;
}

/** The latest counted rejection of a departure, or null. */
export function departureRejection(workflow, departure) {
  return countedRecords(workflow, workflow?.departureDecisions)
    .filter((entry) => entry.decision === 'rejected' && (entry.departures ?? []).includes(departure.id)).at(-1) ?? null;
}

/**
 * Whether a departure stands accepted by its counted records: not superseded, accepted, and not
 * rejected since. Its files are not read here: an accepted file edited later reopens it only where
 * departureStatus (departures.mjs) reads what the files hold.
 */
export function departureStandsAccepted(workflow, departure) {
  if ((workflow?.departures ?? []).some((entry) => entry.supersedes === departure.id)) return false;
  const acceptance = departureAcceptance(workflow, departure);
  const rejection = departureRejection(workflow, departure);
  return Boolean(acceptance) && !(rejection && String(rejection.at) >= String(acceptance.at));
}
