/**
 * Tests that could not run: a step approver's accepted risk.
 *
 * A required test command sometimes cannot run on the machine doing the work: the build tool
 * cannot reach its dependency repository, the JDK or Docker is missing, a proxy refuses the
 * connection. The run fails or is blocked before a single test executes, so it says nothing about
 * the change. A person in the group that approves the step may accept that risk for one command,
 * naming the cause, why it is acceptable and when the acceptance expires.
 *
 * The tests still run at every publication and submission. A decision only lets through a run of
 * the same command in which no test executed; a run in which tests executed and failed is never
 * covered, and a changed command needs a new decision. An accepted run carries the step through
 * approval, later steps and the Story's completion while the decision is active: until it expires,
 * is revoked, or a newer decision on the same command replaces it. Decisions and revocations are
 * append-only. Pure.
 */
import { recordSha256 } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

export const MAX_TEST_RUN_RISK_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;
const NOT_RUN_STATUSES = new Set(['failed', 'blocked']);

/** How many tests a recorded attempt executed: passed plus failed; skipped ones did not run. */
export function testsExecuted(attempt) {
  const tests = attempt?.tests;
  if (!tests || typeof tests !== 'object') return 0;
  return (Number(tests.passed) || 0) + (Number(tests.failed) || 0);
}

/** A run of the command failed or was blocked before any test executed. */
export function noTestExecuted(attempt) {
  return Boolean(attempt) && NOT_RUN_STATUSES.has(attempt.status) && testsExecuted(attempt) === 0;
}

/** The digest an execution or check binds a decision by. */
export function testRunRiskSha256(decision) {
  return `sha256:${recordSha256(decision)}`;
}

function textBetween(value, minimum, maximum, option, what) {
  const text = String(value ?? '').trim();
  if (text.length < minimum || text.length > maximum) {
    throw new SingularityFlowError(`Say ${what} in ${minimum} to ${maximum} characters with ${option}.`, {
      code: 'TEST_RUN_RISK_INVALID'
    });
  }
  return text;
}

/** Why a person may not accept the risk of this attempt, or null when they may. */
export function testRunRiskIneligibility(attempt) {
  if (!attempt) return 'no run of this command is recorded for the step yet; publish or submit it first so its failure is recorded';
  if (attempt.status === 'passed') return 'its latest run passed';
  if (!NOT_RUN_STATUSES.has(attempt.status)) return `its latest run is ${attempt.status}, not a run that failed or was blocked`;
  const executed = testsExecuted(attempt);
  if (executed > 0) return `${executed} test(s) executed in its latest run; a test that ran and failed is fixed, never accepted`;
  return null;
}

/** Record a decision on the aggregate; the caller found the attempt and checked authority. */
export function recordTestRunRisk(workflow, { phaseId, attempt, cause, reason, expires, actor, authorityGroup, identityAssurance = null, at }) {
  const ineligible = testRunRiskIneligibility(attempt);
  if (ineligible) {
    throw new SingularityFlowError(`The risk of ${attempt?.commandId ?? 'this test command'} cannot be accepted: ${ineligible}.`, {
      code: 'TEST_RUN_RISK_NOT_ELIGIBLE', details: { phase: phaseId, commandId: attempt?.commandId ?? null }
    });
  }
  const statedCause = textBetween(cause, 10, 300, '--cause', 'what in the environment stops the tests');
  const text = textBetween(reason, 20, 1000, '--reason', 'why the risk is acceptable');
  const expiry = /^\d{4}-\d{2}-\d{2}$/u.test(String(expires ?? '')) ? new Date(`${expires}T23:59:59.999Z`) : null;
  const now = new Date(at);
  if (!expiry || Number.isNaN(expiry.getTime()) || expiry <= now || expiry - now > MAX_TEST_RUN_RISK_DAYS * DAY) {
    throw new SingularityFlowError(`--expires must be a date after today and at most ${MAX_TEST_RUN_RISK_DAYS} days ahead (YYYY-MM-DD).`, {
      code: 'TEST_RUN_RISK_INVALID'
    });
  }
  workflow.testRunRisks ??= [];
  const decision = {
    id: `TRR-${String(workflow.testRunRisks.filter((entry) => !entry.revokes).length + 1).padStart(3, '0')}`,
    phase: phaseId, commandId: attempt.commandId, argvSha256: attempt.argvSha256,
    cause: statedCause, reason: text, expiresAt: expiry.toISOString(),
    observation: {
      attemptId: attempt.attemptId, status: attempt.status,
      exitCode: Number.isInteger(attempt.exitCode) ? attempt.exitCode : null, testsExecuted: 0
    },
    actor, authorityGroup, identityAssurance, at
  };
  workflow.testRunRisks.push(decision);
  return decision;
}

/** Revoke a decision; the record stays, and so does the revocation. */
export function recordTestRunRiskRevocation(workflow, { riskId, reason, actor, authorityGroup, identityAssurance = null, at }) {
  const target = (workflow.testRunRisks ?? []).find((entry) => !entry.revokes && entry.id === riskId);
  if (!target) throw new SingularityFlowError(`This Story has no test-run risk decision ${riskId}.`, { code: 'TEST_RUN_RISK_UNKNOWN' });
  if ((workflow.testRunRisks ?? []).some((entry) => entry.revokes === riskId)) {
    throw new SingularityFlowError(`${riskId} is already revoked.`, { code: 'TEST_RUN_RISK_REVOKED' });
  }
  const text = textBetween(reason, 20, 1000, '--reason', 'why the decision is revoked');
  const revocation = { revokes: riskId, phase: target.phase, commandId: target.commandId, reason: text,
    actor, authorityGroup, identityAssurance, at };
  workflow.testRunRisks.push(revocation);
  return revocation;
}

/**
 * The decision that governs one command of one step now: the latest one recorded for it, and
 * whether it is `active`, `revoked` or `expired`. Null when nobody decided.
 */
export function testRunRiskState(workflow, { phaseId, commandId, argvSha256 }, { at } = {}) {
  const entries = workflow?.testRunRisks ?? [];
  const decision = [...entries].reverse().find((entry) => !entry.revokes && entry.phase === phaseId
    && entry.commandId === commandId && entry.argvSha256 === argvSha256) ?? null;
  if (!decision) return null;
  if (entries.some((entry) => entry.revokes === decision.id)) return { decision, state: 'revoked' };
  if (new Date(decision.expiresAt) <= new Date(at ?? Date.now())) return { decision, state: 'expired' };
  return { decision, state: 'active' };
}

/** The active decision that lets this recorded attempt through, or null. */
export function coveringTestRunRisk(workflow, { phaseId, attempt, at }) {
  if (!noTestExecuted(attempt)) return null;
  const state = testRunRiskState(workflow, { phaseId, commandId: attempt.commandId, argvSha256: attempt.argvSha256 }, { at });
  return state?.state === 'active' ? state.decision : null;
}

/** The binding a check or execution carries for the decision that let its run through. */
export function testRunRiskBinding(decision) {
  return { id: decision.id, sha256: testRunRiskSha256(decision) };
}

/**
 * Whether a bound decision still carries its run at `at`: it was recorded on this Story with these
 * exact bytes, and the decision now governing the same command (it, or a renewal) is active.
 */
export function boundTestRunRiskActive(workflow, binding, { at } = {}) {
  if (!binding?.id) return false;
  const decision = (workflow?.testRunRisks ?? []).find((entry) => !entry.revokes && entry.id === binding.id);
  if (!decision || testRunRiskSha256(decision) !== binding.sha256) return false;
  return testRunRiskState(workflow, { phaseId: decision.phase, commandId: decision.commandId,
    argvSha256: decision.argvSha256 }, { at })?.state === 'active';
}

/**
 * What a refused run in which no test executed adds to its refusal: that the environment may be
 * the cause, and the command a person who approves the step runs to accept the risk. Null for a
 * run in which tests executed.
 */
export function testRunRiskRoute(workflow, { phaseId, attempt, at }) {
  if (!noTestExecuted(attempt)) return null;
  const state = testRunRiskState(workflow, { phaseId, commandId: attempt.commandId, argvSha256: attempt.argvSha256 }, { at });
  const command = `singularity-flow decision test-risk ${workflow.workItem.id} --phase ${phaseId} --command ${attempt.commandId}`
    + ' --cause "<what in the environment stops it>" --reason "<why the risk is acceptable>" --expires <YYYY-MM-DD>';
  const lapsed = state && state.state !== 'active'
    ? ` ${state.decision.id} ${state.state === 'expired' ? `expired on ${state.decision.expiresAt.slice(0, 10)}` : 'was revoked'}.` : '';
  return {
    eligible: true, phase: phaseId, commandId: attempt.commandId, decision: state?.decision.id ?? null, lapsed: state?.state ?? null, command,
    guidance: 'No test executed in this run, so the environment may be what stopped it (for example the build tool cannot reach its'
      + ` dependency repository, or a JDK or Docker it needs is missing).${lapsed} Fix the environment and run it again, or a person`
      + ` who approves ${phaseId} can accept the risk in their own terminal (an agent cannot): ${command}`
  };
}

/**
 * Why a bound decision does not cover this recorded attempt of this step, or null when it does:
 * the decision is on the Story with the bound bytes, names the same step, command and argv, the
 * attempt executed no test, and the decision governing that command is active at `at`.
 */
export function testRunRiskCoverageProblem(workflow, binding, { phaseId, attempt, at }) {
  const decision = (workflow?.testRunRisks ?? []).find((entry) => !entry.revokes && entry.id === binding?.id);
  if (!decision || testRunRiskSha256(decision) !== binding?.sha256) return `test-run risk ${binding?.id ?? '?'} is not recorded on the Story with these bytes`;
  if (decision.phase !== phaseId || decision.commandId !== attempt?.commandId || decision.argvSha256 !== attempt?.argvSha256) {
    return `test-run risk ${decision.id} was accepted for another step or command`;
  }
  if (!noTestExecuted(attempt)) return `tests executed in this run, which no test-run risk decision covers`;
  const state = testRunRiskState(workflow, { phaseId, commandId: decision.commandId, argvSha256: decision.argvSha256 }, { at });
  if (state?.state !== 'active') return `test-run risk ${state?.decision.id ?? decision.id} is ${state?.state ?? 'unknown'}; a person who approves ${phaseId} must accept it again`;
  return null;
}

/**
 * What a reviewer is told about the runs of a step that a decision let through: which command,
 * the stated cause, who accepted it until when, and whether that still holds now.
 */
export function acceptedTestRunSummaries(workflow, phaseId, entries, { at } = {}) {
  const summaries = [];
  for (const entry of entries ?? []) {
    if (!entry?.testRunRisk) continue;
    const decision = (workflow?.testRunRisks ?? []).find((record) => !record.revokes && record.id === entry.testRunRisk.id);
    if (!decision) continue;
    const active = boundTestRunRiskActive(workflow, entry.testRunRisk, { at });
    summaries.push({
      id: decision.id, commandId: entry.commandId ?? decision.commandId, cause: decision.cause, actor: decision.actor,
      authorityGroup: decision.authorityGroup, expiresAt: decision.expiresAt, active,
      words: `No test ran for ${entry.commandId ?? decision.commandId}: ${decision.cause.replace(/[.\s]+$/u, '')}. Accepted as ${decision.id} by ${decision.actor}`
        + ` (${decision.authorityGroup}) until ${decision.expiresAt.slice(0, 10)}${active ? '' : '; no longer active, so the next gate refuses it'}.`
        + ` The run stays ${entry.status ?? 'failed'}; it is not a pass.`
    });
  }
  return summaries;
}
