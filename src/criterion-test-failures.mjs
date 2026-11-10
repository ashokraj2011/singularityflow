/**
 * A criterion's own test that failed, exactly attributed to it (its test's own occurrence failed), is the code
 * step's to rectify before it is submitted [PHR:REQ-002, REQ-006], finding 11: the refusal names the criterion
 * and the same-step repair. A failure no exact identity ties to a criterion is left to the command's own
 * refusal, or warned at submission and judged at approval. Loaded only at a code step's test runs.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
