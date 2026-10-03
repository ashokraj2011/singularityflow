/**
 * How a criterion stands against its verification contract [E2G-013, E2G-016, E2G-017].
 *
 * Pure. Each slot of the contract is judged on its own: a test slot by the witnesses that serve it
 * (each joined to the authoritative attempt of its command), an inspection or visual slot by the
 * record that witnesses it. Primary slots combine with `all` or `any`; supporting slots are shown
 * but never satisfy. A reviewer's adequacy decision that a test does not verify the criterion
 * removes it from its slot; an adequacy exception keeps it, visibly excepted.
 */
import { ASSURANCE, EXECUTION_ASSURANCE } from '../evidence/vocabulary.mjs';
import { testSlotFor } from './contracts.mjs';
import { aggregateWitnesses, witnessResult } from './witness-results.mjs';

const BLOCKERS = Object.freeze(['failed', 'inconclusive', 'missing', 'pending']);

const WITNESS_FINDINGS = Object.freeze({
  failed: ['EVIDENCE_TEST_FAILED', (id, entry) => !entry.identityKey ? `The test command covering ${id} failed.`
    : (entry.reasons ?? []).includes('RUN_FAILED') ? `The test command covering ${id} failed; its test ${entry.label} passed, but a pass inside a failed run does not count.`
      : (entry.reasons ?? []).includes('RUN_FAILED_WITHOUT_RESULT') ? `The test command covering ${id} failed without a result for its test ${entry.label}.`
        : `${id}'s test ${entry.label} failed.`],
  unavailable: ['EVIDENCE_TEST_UNAVAILABLE', (id) => `The test command covering ${id} produced no usable result.`],
  'passed-with-skips': ['EVIDENCE_TESTS_SKIPPED', (id, entry) => `The test command covering ${id} passed with ${entry.skipped} skipped test(s); which test was skipped is not joined to the criterion.`],
  flaky: ['EVIDENCE_TEST_FLAKY', (id, entry) => `${id}'s test ${entry.label} passed only after failing in the same run; a flaky pass is not a pass.`],
  'unverified-skipped': ['EVIDENCE_TEST_SKIPPED', (id, entry) => `${id}'s test ${entry.label} was skipped, so it verified nothing.`],
  missing: ['EVIDENCE_TEST_NOT_RUN', (id, entry) => `${id}'s test ${entry.label} has no result in the run of its candidate.`],
  ambiguous: ['EVIDENCE_TEST_AMBIGUOUS', (id, entry) => `${id}'s test ${entry.label} matches more than one result, so none can be credited.`],
  inconclusive: ['EVIDENCE_TEST_IDENTITY_INCONCLUSIVE', (id, entry) => `${id}'s test ${entry.label} cannot be tied to one exact result (${(entry.reasons ?? []).join(', ') || 'unknown'}).`],
  'not-run': ['EVIDENCE_TEST_NOT_RUN', (id, entry) => `${id}'s test ${entry.label} has not run against the published candidate.`]
});

/** One finding for a witness that did not verify its criterion. */
export function witnessFindingOf(id, entry) {
  if (entry.shortfall) {
    return { code: 'EVIDENCE_ASSURANCE_SHORTFALL', message: `${id}'s test ${entry.label} reached ${entry.assurance}; its module's runner can reach ${entry.requiredAssurance}, so that is required.` };
  }
  const [code, message] = WITNESS_FINDINGS[entry.outcome] ?? WITNESS_FINDINGS.inconclusive;
  return { code, message: message(id, entry) };
}

function strongest(list, values) {
  return values.reduce((left, right) => (list.indexOf(left) >= list.indexOf(right) ? left : right));
}

function weakest(list, values) {
  return values.reduce((left, right) => (list.indexOf(left) <= list.indexOf(right) ? left : right));
}

/** One word for what a criterion's witnesses' runs showed, from the strongest blocker down. */
export function executionWord(results) {
  const outcomes = results.map((entry) => entry.outcome);
  for (const outcome of ['failed', 'unavailable', 'flaky', 'ambiguous', 'inconclusive', 'unverified-skipped', 'missing', 'passed-with-skips', 'not-run']) {
    if (outcomes.includes(outcome)) return outcome === 'unverified-skipped' ? 'skipped' : outcome;
  }
  return outcomes.length ? 'passed' : 'not-run';
}

function testSlotResult(id, slot, contract, entries, { submitted, rowSubmitted, requiredAssurance, decisionFor, unattached, at }) {
  const findings = [];
  const serving = entries.filter((entry) => testSlotFor(contract, entry.witness)?.slot === slot.slot);
  // A reviewer decided some of these tests do not verify the criterion: they no longer count. An
  // adequacy exception that lapsed no longer stands in for the test it excused.
  const decided = serving.map((entry) => ({ entry, decision: decisionFor(entry) }));
  for (const { entry, decision } of decided) {
    if (decision?.decision === 'exception' && !(Date.parse(decision.expiresAt ?? '') > Date.parse(at))) {
      findings.push({ code: 'EVIDENCE_WITNESS_EXCEPTION_EXPIRED', message: `The adequacy exception for ${id}'s test in ${entry.witness.testSource} expired at ${decision.expiresAt ?? 'an unknown time'}; review the test again.` });
    }
  }
  const counted = decided.filter(({ decision }) => decision?.decision !== 'not-applicable'
    && !(decision?.decision === 'exception' && !(Date.parse(decision.expiresAt ?? '') > Date.parse(at))));
  const excepted = counted.some(({ decision }) => decision?.decision === 'exception');
  const judged = counted.filter(({ entry }) => entry.ready === submitted);
  const results = judged.map(({ entry }) => witnessResult(entry.witness, entry.attempt, { submitted }));
  const required = strongest(ASSURANCE, [requiredAssurance, slot.requiredAssurance ?? 'none',
    ...results.map((entry) => entry.requiredAssurance)]);
  if (!results.length) {
    const status = rowSubmitted ? 'missing' : 'pending';
    if (status === 'missing' && slot.role === 'primary') {
      findings.push(unattached?.length
        ? { code: 'EVIDENCE_TAG_NOT_ON_TEST', message: `${id} is tagged at ${unattached.join(', ')}, but not on a test, so it verifies nothing.` }
        : decided.length
          ? { code: 'EVIDENCE_WITNESS_NOT_APPLICABLE', message: `Every test tagged for ${id}${contract.stated ? ` in slot ${slot.slot}` : ''} was reviewed as not verifying it.` }
          : { code: 'EVIDENCE_WITNESS_MISSING', message: `No submitted test is tagged for ${id}${contract.stated ? ` in slot ${slot.slot} (${slot.witness.path})` : ''}.` });
    }
    return { status, assurance: 'none', identity: 'none', execution: 'none', requiredAssurance: required, results, excepted: false, findings };
  }
  if (!submitted) {
    // Published, not yet submitted: what the preflight run showed, still pending its submission.
    return { status: 'pending', assurance: 'declared', identity: 'declared', execution: 'none', requiredAssurance: required, results, excepted: false, findings };
  }
  const aggregate = aggregateWitnesses(results);
  let status = aggregate.status;
  if (status === 'met' && ASSURANCE.indexOf(aggregate.assurance) < ASSURANCE.indexOf(required)) {
    status = 'inconclusive';
    findings.push({ code: 'EVIDENCE_ASSURANCE_SHORTFALL', message: `${id} reached ${aggregate.assurance}; ${required} is required.` });
  }
  for (const result of results.filter((entry) => entry.status !== 'met')) findings.push(witnessFindingOf(id, result));
  return { status, assurance: aggregate.assurance, identity: aggregate.identity, execution: aggregate.execution, requiredAssurance: required, results, excepted, findings };
}

function recordSlotResult(id, slot, { rowSubmitted, records }) {
  // An inspection or visual slot is witnessed by its own record, bound to this criterion and slot.
  const record = (records ?? []).find((entry) => entry.clauseId === id && entry.slot === slot.slot && entry.method === slot.method) ?? null;
  if (record?.status === 'met') {
    return { status: 'met', assurance: record.assurance ?? 'source-bound', identity: record.assurance === 'declared' ? 'declared' : 'source-bound',
      execution: 'none', requiredAssurance: slot.requiredAssurance ?? 'source-bound', results: [], record, excepted: record.exception === true, findings: [] };
  }
  const status = record?.status ?? (rowSubmitted ? 'missing' : 'pending');
  const findings = status === 'pending' || slot.role !== 'primary' ? [] : [{
    code: slot.method === 'inspection' ? 'EVIDENCE_INSPECTION_MISSING' : 'EVIDENCE_VISUAL_MISSING',
    message: record?.message ?? (slot.method === 'inspection'
      ? `${id}'s slot ${slot.slot} needs an inspection of ${slot.witness.path} recorded by a reviewer.`
      : `${id}'s slot ${slot.slot} needs visual evidence of ${slot.witness.target} for this generation.`)
  }];
  return { status, assurance: 'none', identity: 'none', execution: 'none', requiredAssurance: slot.requiredAssurance ?? 'source-bound', results: [], record, excepted: false, findings };
}

/**
 * The verify result of one criterion against its contract. `entries` are its witnesses, each
 * `{ witness, attempt, ready, delivery }`; `submitted` says whether its delivery reached submission;
 * `decisionFor(entry)` returns the reviewer's adequacy decision for an exact witness, if any.
 */
export function contractResult(id, contract, entries, {
  submitted, rowSubmitted, requiredAssurance, decisionFor = () => null, unattached = [], records = [], acceptedRisk = false,
  at = new Date().toISOString()
}) {
  const slots = contract.slots.map((slot) => ({
    slot: slot.slot, method: slot.method, role: slot.role,
    ...(slot.method === 'test'
      ? testSlotResult(id, slot, contract, entries, { submitted, rowSubmitted, requiredAssurance, decisionFor, unattached, at })
      : recordSlotResult(id, slot, { rowSubmitted, records }))
  }));
  const primary = slots.filter((entry) => entry.role === 'primary');
  const met = primary.filter((entry) => entry.status === 'met');
  const counted = contract.combination === 'any' && met.length ? met : primary;
  let status = contract.combination === 'any'
    ? (met.length ? 'met' : ['pending', 'missing', 'inconclusive', 'failed'].find((value) => primary.some((entry) => entry.status === value)) ?? 'missing')
    : (BLOCKERS.find((value) => primary.some((entry) => entry.status === value)) ?? 'met');
  const witnessResults = slots.flatMap((entry) => entry.results);
  const countedResults = counted.flatMap((entry) => entry.results);
  let exception = 'none';
  if (status === 'met' && counted.some((entry) => entry.excepted)) {
    status = 'excepted';
    exception = 'witness-exception';
  }
  // A recovery decision that accepted the observed test failure carries the criterion, visibly.
  if (acceptedRisk && ['failed', 'inconclusive'].includes(status)
      && countedResults.length && countedResults.every((entry) => ['failed', 'unavailable'].includes(entry.outcome) || entry.status === 'met')) {
    status = 'excepted';
    exception = 'accepted-risk';
  }
  const satisfied = status === 'met' || exception === 'witness-exception';
  const assurance = satisfied
    ? (contract.combination === 'any' ? strongest : weakest)(ASSURANCE, counted.map((entry) => entry.assurance))
    : exception === 'accepted-risk' ? 'declared'
      : countedResults.length ? weakest(ASSURANCE, countedResults.map((entry) => entry.assurance)) : 'none';
  return {
    status, exception, assurance,
    identity: countedResults.length ? (countedResults.every((entry) => entry.identity === 'source-bound') ? 'source-bound' : 'declared')
      : counted.some((entry) => entry.status === 'met') ? weakest(['none', 'declared', 'source-bound'], counted.map((entry) => entry.identity)) : 'none',
    execution: countedResults.length ? weakest(EXECUTION_ASSURANCE, countedResults.map((entry) => entry.execution)) : 'none',
    requiredAssurance: strongest(ASSURANCE, [requiredAssurance, ...counted.map((entry) => entry.requiredAssurance)]),
    executionWord: executionWord(witnessResults),
    skipped: witnessResults.reduce((sum, entry) => sum + Number(entry.skipped ?? 0), 0),
    witnessResults,
    slots,
    findings: status === 'met' || status === 'excepted' ? [] : slots.filter((entry) => entry.role === 'primary').flatMap((entry) => entry.findings)
  };
}
