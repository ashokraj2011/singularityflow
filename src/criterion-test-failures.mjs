/**
 * A criterion's own test that failed, exactly attributed to it (its test's own occurrence failed), is the code
 * step's to rectify before it is submitted [PHR:REQ-002, REQ-006], finding 11: the refusal names the criterion
 * and the same-step repair. A failure no exact identity ties to a criterion is left to the command's own
 * refusal, or warned at submission and judged at approval. Loaded only at a code step's test runs.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { exactFileAtObject } from './git.mjs';
import { canonicalJson } from './records.mjs';
import { describeWitnessResult, witnessResult } from './verification/witness-results.mjs';
import { SingularityFlowError } from './util.mjs';

/** Each witness whose own test failed in its attempt, exactly attributed. */
export function exactCriterionFailures(witnesses, attemptFor) {
  return (witnesses ?? []).map((witness) => {
    const attempt = attemptFor(witness);
    return attempt ? witnessResult(witness, attempt) : null;
  }).filter((result) => result?.identityKey && result.outcome === 'failed' && (result.occurrences ?? []).length > 0
    && !(result.reasons ?? []).some((reason) => ['RUN_FAILED', 'RUN_FAILED_WITHOUT_RESULT'].includes(reason)));
}

/** The words and structured repair for those failures, in the code step itself. */
export function criterionFailureRepair(phase, failing) {
  return {
    lines: failing.map((result) => `${result.clauseId}: ${describeWitnessResult(result)}`),
    details: { ownerPhase: phase.id, repairScope: 'current-draft',
      criteria: failing.slice(0, 20).map((result) => ({ clauseId: result.clauseId, test: result.label, testSource: result.testSource, commandId: result.commandId })),
      nextAction: { command: `singularity-flow phase prepublish ${phase.id} --for-agent --json --publish-if-ready`, skill: '/sf-code',
        label: `Fix the code or the test in ${phase.id} so each criterion's own tests pass, publish it again, then submit again.` } }
  };
}

const RECTIFY = (phase) => `Fix the code or the test so each criterion's own tests pass, publish ${phase.id} again, then submit again.`;

/**
 * Name the exactly attributed criterion failures on a refused required test run (CODE_TEST_FAILED), in place:
 * at publication from the candidate's witnesses, at submission from the published receipt's.
 */
export async function withCriterionTestFailures(root, phase, refusal, recordedRuns, witnesses = null) {
  if (refusal?.code !== 'CODE_TEST_FAILED') return;
  const published = witnesses ? null : phase.deliveryEvidence?.receiptPath
    ? await readFile(path.join(root, phase.deliveryEvidence.receiptPath), 'utf8').then(JSON.parse, () => null) : null;
  const commands = [...recordedRuns.keys()];
  const failing = exactCriterionFailures(witnesses ?? published?.traceability?.witnesses ?? [], (witness) =>
    recordedRuns.get(witness.commandId ?? (commands.length === 1 ? commands[0] : null))?.attempt ?? null);
  if (!failing.length) return;
  const repair = criterionFailureRepair(phase, failing);
  refusal.message = `${refusal.message}\nA criterion's own test fails:\n- ${repair.lines.join('\n- ')}\n${RECTIFY(phase)}`;
  refusal.details = { ...(refusal.details ?? {}), ...repair.details };
}

/** Submission's refusal when a criterion's own test failed in a run that still let the step through, or null. */
export function criterionTestFailureRefusal(workflow, phase, witnesses, attemptFor) {
  const failing = exactCriterionFailures(witnesses, attemptFor);
  if (!failing.length) return null;
  const workId = workflow.workItem.id;
  const repair = criterionFailureRepair(phase, failing);
  return new SingularityFlowError(`Phase ${phase.id} cannot be submitted while a criterion's own test fails:\n- ${repair.lines.join('\n- ')}\n${RECTIFY(phase)}`,
    { code: 'CRITERION_TESTS_FAILED', details: { workId, phase: phase.id, ...repair.details,
      recoveryCommands: [{ command: `singularity-flow submit ${phase.id} --work-id ${workId}`, label: 'Then submit it again; the tests run once more.' }] } });
}

// Worst first: one test that did not pass keeps its criterion's gap, named.
const TEST_RESULTS = Object.freeze(['failed', 'skipped', 'missing', 'inconclusive', 'stale', 'passed']);
const OUTCOME_EVIDENCE = Object.freeze({ failed: 'failed', 'unverified-skipped': 'skipped', missing: 'missing', 'not-run': 'missing' });

/**
 * Each criterion's test evidence from its own tagged tests (the delivery's witnesses) in retained runs
 * [fix E, Story anu-bin 2026-11-11]: `established` only when every test tagged for it passed through its
 * own occurrence in the run of the command that covers it, and that run is bound to the current source
 * tree (`bindingFor` says matched). A failed, skipped, missing or unjoinable test keeps the gap, and a run
 * the code moved past is `stale`. Suite counts never establish a criterion; this join does.
 */
export function criterionTestEvidence(witnesses, attemptFor, bindingFor = () => 'matched') {
  const byClause = new Map();
  for (const witness of witnesses ?? []) {
    if (!witness?.clauseId) continue;
    const attempt = attemptFor(witness);
    const result = witnessResult(witness, attempt ?? null);
    const exact = Boolean(result.identityKey) && (result.occurrences ?? []).length > 0;
    const evidence = OUTCOME_EVIDENCE[result.outcome]
      ?? (result.outcome !== 'passed' || result.status !== 'met' || !exact ? 'inconclusive'
        : bindingFor(result.commandId ?? attempt?.commandId ?? null) === 'matched' ? 'passed' : 'stale');
    byClause.set(witness.clauseId, [...(byClause.get(witness.clauseId) ?? []),
      { test: result.label, attemptId: result.attemptId, result: evidence }]);
  }
  return [...byClause.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([clauseId, tests]) => ({
    clauseId, testEvidence: TEST_RESULTS.find((value) => tests.some((entry) => entry.result === value)).replace(/^passed$/u, 'established'),
    tests: tests.slice(0, 4), ...(tests.length > 4 ? { omittedTests: tests.length - 4 } : {})
  }));
}

/**
 * The same, for one retained submission packet: its delivery receipt's witnesses at the packet's own
 * commit (only when its bytes are the ones the packet binds), joined to the runs `receipts` holds by
 * command. Empty when the step delivered no tagged tests or its receipt cannot be read exactly.
 */
export function retainedCriterionTests(root, packet, receipts, checks = []) {
  const reference = packet?.submissionEvidence?.codeDelivery;
  if (!reference?.path || !packet.evidenceCommit || !receipts?.size) return [];
  let witnesses;
  try {
    const value = JSON.parse(exactFileAtObject(root, packet.evidenceCommit, reference.path,
      { regularOnly: true, maximumBytes: 8 * 1024 * 1024 })?.toString('utf8') ?? 'null');
    if (String(reference.sha256 ?? '').replace(/^sha256:/u, '') !== createHash('sha256').update(canonicalJson(value)).digest('hex')) return [];
    witnesses = value?.traceability?.witnesses;
  } catch { return []; }
  if (!Array.isArray(witnesses) || !witnesses.length) return [];
  const only = receipts.size === 1 ? [...receipts.values()][0] : null;
  return criterionTestEvidence(witnesses, (witness) => receipts.get(witness.commandId) ?? (witness.commandId ? null : only),
    (commandId) => checks.find((check) => check.commandId === commandId)?.binding ?? null);
}

/**
 * The code step's coverage [fix E]: a criterion covered by its delivered test files alone is test
 * presence only until its own tagged tests passed in the step's run; then it is established and not
 * listed. A failed, skipped or missing tagged test keeps it listed (and the step's own refusals hold it).
 */
export async function withTestedCriteria(root, phase, coverage) {
  const established = new Set((await phaseCriterionTests(root, phase)).filter((entry) => entry.testEvidence === 'established').map((entry) => entry.clauseId));
  coverage.testPresenceOnly = coverage.testPresenceOnly.filter((id) => !established.has(id));
  return coverage;
}

/**
 * A code step's own criteria against its own recorded runs: the published delivery's witnesses and the
 * attempts it recorded, each read only when its bytes are the ones the step recorded. With `current`
 * (the tree's digests now) a run counts only on that same code; without it, at the step's own coverage,
 * its runs are of its submitted candidate (submission refuses a run the source moved past).
 */
export async function phaseCriterionTests(root, phase, current = null) {
  const read = (relative, sha256) => readFile(path.join(root, relative), 'utf8').then(JSON.parse).then((value) =>
    !sha256 || String(sha256).replace(/^sha256:/u, '') === createHash('sha256').update(canonicalJson(value)).digest('hex') ? value : null, () => null);
  const evidence = phase?.deliveryEvidence;
  const delivery = evidence?.receiptPath ? await read(evidence.receiptPath, evidence.receiptSha256) : null;
  if (!delivery?.traceability?.witnesses?.length) return [];
  const receipts = new Map();
  for (const execution of evidence.testExecutions ?? []) {
    if (execution.kind === 'phase-validation-observation' || !execution.receiptPath) continue;
    const receipt = await read(execution.receiptPath, execution.receiptSha256);
    if (receipt?.kind === 'test-execution' && receipt.commandId === execution.commandId) receipts.set(execution.commandId, receipt);
  }
  const only = receipts.size === 1 ? [...receipts.values()][0] : null;
  const bound = (candidate) => !current || ((candidate?.treeSha256 === current.treeSha256
    || Boolean(candidate?.codeTreeSha256 && candidate.codeTreeSha256 === current.codeTreeSha256))
    && (candidate?.testInputSha256 ?? null) === (current.testInputSha256 ?? null));
  return criterionTestEvidence(delivery.traceability.witnesses, (witness) => receipts.get(witness.commandId) ?? (witness.commandId ? null : only),
    (commandId) => (bound((receipts.get(commandId) ?? only)?.candidate) ? 'matched' : 'stale'));
}
