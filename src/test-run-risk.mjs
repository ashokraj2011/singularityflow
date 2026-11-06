/**
 * Tests the environment stops: a step approver's accepted risk.
 *
 * A required test command sometimes cannot run on the machine doing the work: the build tool
 * cannot reach its dependency repository, the JDK or Docker is missing, a proxy refuses the
 * connection, a database the tests need is not running. A person in the group that approves the
 * step may accept that risk for one command, naming the cause, why it is acceptable and when the
 * acceptance expires.
 *
 * Every failed or blocked run carries its classified cause (src/test-run-cause.mjs) [TCE:REQ-041].
 * Only an environment cause can be accepted: a run in which no test executed, or one in which every
 * failed test failed from the environment [TCE:REQ-043]. The decision records the cause class it
 * accepted and lets through only a later run of the same command whose cause is that same class; a
 * code cause (a compile, syntax or import error, a failed assertion), a timeout or an unrecognised
 * failure is never covered [TCE:REQ-042]. Decisions on different classes of one command stand side
 * by side. A decision recorded before causes were classified stays valid until it expires, for runs
 * in which no test executed and whose cause is the environment [TCE:REQ-044].
 *
 * The tests still run at every publication and submission, and a changed command needs a new
 * decision. An accepted run carries the step through approval, later steps and the Story's
 * completion while the decision is active: until it expires, is revoked, or a newer decision on the
 * same command and class replaces it. Decisions and revocations are append-only. Pure.
 *
 * A decision binds the command by its ID and argv digest. The run that prompted it is kept in the
 * private Git storage of the checkout that ran it, so an approver on another machine may bind the
 * command by the digest and cause class the refusal names instead; every use still re-checks the
 * cause of the run it lets through.
 */
import { testReceiptPassing } from './code-delivery-tests.mjs';
import { recordSha256 } from './records.mjs';
import { countedRecords } from './presence/counted.mjs';
import { classifyTestRunCause, testRunCauseCategory, testRunCauseWords } from './test-run-cause.mjs';
import { SingularityFlowError } from './util.mjs';

export const MAX_TEST_RUN_RISK_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;
const NOT_RUN_STATUSES = new Set(['failed', 'blocked']);
const ARGV_DIGEST = /^[a-f0-9]{64}$/u;

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

/**
 * What stopped a failed or blocked attempt: the cause recorded with it, or, for an attempt recorded
 * before causes were classified, what its shape alone says (a missing launcher, a timeout, every
 * test skipped, tests that failed; anything else is unrecognised).
 */
export function testRunCause(attempt) {
  if (attempt?.cause && typeof attempt.cause === 'object' && testRunCauseCategory(attempt.cause.class) === attempt.cause.category) return attempt.cause;
  return classifyTestRunCause({ check: { status: attempt?.status, timedOut: attempt?.timedOut === true,
    infrastructureUnavailable: attempt?.process?.infrastructureUnavailable === true }, tests: attempt?.tests });
}

/** A cause as a person reads it: its words, the changed file it names, its class and marker. */
export function testRunCauseText(cause) {
  return `${testRunCauseWords(cause?.class)}${cause?.file ? ` in ${cause.file}` : ''} (${[cause?.class, cause?.signal].filter(Boolean).join(', ')})`;
}

/**
 * Who may accept the risk of a step's test commands: the step's approval groups. A step nobody
 * approves (quick-fix's implement) is answered for by the next step on the route that has
 * approvers, since they review its evidence.
 */
export function testRunRiskAuthorities(workflow, phaseId) {
  const groups = (id) => {
    const policy = workflow?.phases?.[id]?.approvalPolicy ?? {};
    return [...new Set([...(policy.authorities ?? []), ...(policy.requiredAuthorities ?? [])])].sort();
  };
  const own = groups(phaseId);
  if (own.length) return own;
  const order = workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {});
  for (const id of order.slice(order.indexOf(phaseId) + 1)) {
    const next = groups(id);
    if (next.length) return next;
  }
  return [];
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

/** The command a person who approves the step runs to accept, or renew, the risk of one command and cause. */
export function testRunRiskDecisionCommand(workflow, { phaseId, commandId, argvSha256 = null, causeClass = null }) {
  return `singularity-flow decision test-risk ${workflow?.workItem?.id ?? '<WORK-ID>'} --phase ${phaseId} --command ${commandId}`
    + (testRunCauseCategory(causeClass) === 'environment' ? ` --cause-class ${causeClass}` : '')
    + ' --cause "<what in the environment stops it>" --reason "<why the risk is acceptable>" --expires <YYYY-MM-DD>'
    + (ARGV_DIGEST.test(String(argvSha256 ?? '')) ? ` --argv-sha256 ${argvSha256}` : '');
}

/** Why a person may not accept the risk of this attempt, or null when they may: only an environment cause. */
export function testRunRiskIneligibility(attempt) {
  if (!attempt) return 'no run of this command is recorded for the step in this checkout yet; publish or submit it first so its failure is recorded, or name the cause class and command digest its refusal gave with --cause-class and --argv-sha256';
  if (attempt.status === 'passed') return 'its latest run passed';
  if (!NOT_RUN_STATUSES.has(attempt.status)) return `its latest run is ${attempt.status}, not a run that failed or was blocked`;
  const cause = testRunCause(attempt);
  if (cause.category === 'environment') return null;
  const executed = testsExecuted(attempt);
  if (cause.category === 'code') {
    return `its latest run stopped on a code cause, ${testRunCauseText(cause)}; ${executed > 0 ? `${executed} test(s) executed, and ` : ''}a code fault is fixed, never accepted`;
  }
  return `nothing in its latest run says the environment stopped it: ${testRunCauseText(cause)}; fix the cause and run it again`;
}

/**
 * Record a decision on the aggregate; the caller found the attempt and checked authority. With no
 * run recorded in this checkout, the command is bound by `commandId`, its `argvSha256` and the
 * `causeClass` its refusal named instead.
 */
export function recordTestRunRisk(workflow, { phaseId, attempt, commandId = null, argvSha256 = null, causeClass = null, cause, reason, expires, actor, authorityGroup, identityAssurance = null, at }) {
  const byDigest = !attempt && Boolean(commandId) && ARGV_DIGEST.test(String(argvSha256 ?? ''));
  const ineligible = byDigest ? null : testRunRiskIneligibility(attempt);
  const named = attempt?.commandId ?? commandId ?? 'this test command';
  if (ineligible) {
    throw new SingularityFlowError(`The risk of ${named} cannot be accepted: ${ineligible}.`, {
      code: 'TEST_RUN_RISK_NOT_ELIGIBLE', details: { phase: phaseId, commandId: attempt?.commandId ?? commandId ?? null }
    });
  }
  const observed = byDigest ? null : testRunCause(attempt);
  if (byDigest && testRunCauseCategory(causeClass) !== 'environment') {
    throw new SingularityFlowError('Name the environment cause class the refusal gave with --cause-class, beside --argv-sha256.', { code: 'TEST_RUN_RISK_INVALID' });
  }
  if (observed && causeClass && causeClass !== observed.class) {
    throw new SingularityFlowError(`The risk of ${named} cannot be accepted as ${causeClass}: its latest run stopped on ${testRunCauseText(observed)}.`, {
      code: 'TEST_RUN_RISK_NOT_ELIGIBLE', details: { phase: phaseId, commandId: named }
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
    phase: phaseId, commandId: byDigest ? commandId : attempt.commandId, argvSha256: byDigest ? argvSha256 : attempt.argvSha256,
    causeClass: byDigest ? causeClass : observed.class,
    cause: statedCause, reason: text, expiresAt: expiry.toISOString(),
    // Bound by digest, the decision saw no run here; each run it lets through is checked at use.
    ...(byDigest ? { boundBy: 'command-digest' } : { observation: {
      attemptId: attempt.attemptId, status: attempt.status,
      exitCode: Number.isInteger(attempt.exitCode) ? attempt.exitCode : null, testsExecuted: testsExecuted(attempt)
    } }),
    actor, authorityGroup, identityAssurance, at
  };
  workflow.testRunRisks.push(decision);
  return decision;
}

/** Revoke a decision; the record stays, and so does the revocation. */
export function recordTestRunRiskRevocation(workflow, { riskId, reason, actor, authorityGroup, identityAssurance = null, at }) {
  const target = countedRecords(workflow, workflow.testRunRisks).find((entry) => !entry.revokes && entry.id === riskId);
  if (!target) throw new SingularityFlowError(`This Story has no test-run risk decision ${riskId}.`, { code: 'TEST_RUN_RISK_UNKNOWN' });
  if (countedRecords(workflow, workflow.testRunRisks).some((entry) => entry.revokes === riskId)) {
    throw new SingularityFlowError(`${riskId} is already revoked.`, { code: 'TEST_RUN_RISK_REVOKED' });
  }
  const text = textBetween(reason, 20, 1000, '--reason', 'why the decision is revoked');
  const revocation = { revokes: riskId, phase: target.phase, commandId: target.commandId, reason: text,
    actor, authorityGroup, identityAssurance, at };
  workflow.testRunRisks.push(revocation);
  return revocation;
}

/**
 * The decision that governs one command and cause class of one step now: the latest one recorded
 * for it, and whether it is `active`, `revoked` or `expired`. A null class is a decision recorded
 * before causes were classified. Null when nobody decided.
 */
export function testRunRiskState(workflow, { phaseId, commandId, argvSha256, causeClass = null }, { at } = {}) {
  const entries = countedRecords(workflow, workflow?.testRunRisks);
  const decision = [...entries].reverse().find((entry) => !entry.revokes && entry.phase === phaseId
    && entry.commandId === commandId && entry.argvSha256 === argvSha256 && (entry.causeClass ?? null) === causeClass) ?? null;
  if (!decision) return null;
  if (entries.some((entry) => entry.revokes === decision.id)) return { decision, state: 'revoked' };
  if (new Date(decision.expiresAt) <= new Date(at ?? Date.now())) return { decision, state: 'expired' };
  return { decision, state: 'active' };
}

/** The decision governing a recorded attempt: the one for its cause class, else one recorded before classes. */
export function testRunRiskStateFor(workflow, { phaseId, attempt }, { at } = {}) {
  const key = { phaseId, commandId: attempt?.commandId, argvSha256: attempt?.argvSha256 };
  const cause = testRunCause(attempt);
  return (cause.category === 'environment' ? testRunRiskState(workflow, { ...key, causeClass: cause.class }, { at }) : null)
    ?? testRunRiskState(workflow, { ...key, causeClass: null }, { at });
}

/** Why `decision` does not cover what stopped `attempt`, or null when it does. */
function causeGap(decision, attempt) {
  if (!NOT_RUN_STATUSES.has(attempt?.status)) return `this run ${attempt?.status === 'passed' ? 'passed' : `is ${attempt?.status ?? 'missing'}`}, so no test-run risk decision applies to it`;
  // An attempt and a decision both recorded before causes were classified are judged as they were then.
  if (!attempt.cause && !decision.causeClass) return noTestExecuted(attempt) ? null : 'tests executed in this run, which no test-run risk decision covers';
  const cause = testRunCause(attempt);
  if (cause.category !== 'environment') return `this run stopped on ${testRunCauseText(cause)}, which no test-run risk decision covers`;
  if (!decision.causeClass) return noTestExecuted(attempt) ? null : `${decision.id} was accepted before causes were classified and covers only runs in which no test executed`;
  return decision.causeClass === cause.class ? null
    : `this run stopped on ${testRunCauseText(cause)}, not on the cause ${decision.id} accepted (${decision.causeClass})`;
}

/** The active decision that lets this recorded attempt through, or null. */
export function coveringTestRunRisk(workflow, { phaseId, attempt, at }) {
  if (!attempt || !NOT_RUN_STATUSES.has(attempt.status)) return null;
  const state = testRunRiskStateFor(workflow, { phaseId, attempt }, { at });
  return state?.state === 'active' && !causeGap(state.decision, attempt) ? state.decision : null;
}

/** The binding a check or execution carries for the decision that let its run through. */
export function testRunRiskBinding(decision) {
  return { id: decision.id, sha256: testRunRiskSha256(decision) };
}

/**
 * Whether a bound decision still carries its run at `at`: it was recorded on this Story with these
 * exact bytes, and the decision now governing the same command and class (it, or a renewal) is active.
 */
export function boundTestRunRiskActive(workflow, binding, { at } = {}) {
  if (!binding?.id) return false;
  const decision = countedRecords(workflow, workflow?.testRunRisks).find((entry) => !entry.revokes && entry.id === binding.id);
  if (!decision || testRunRiskSha256(decision) !== binding.sha256) return false;
  return testRunRiskState(workflow, governedBy(decision), { at })?.state === 'active';
}

function governedBy(decision) {
  return { phaseId: decision.phase, commandId: decision.commandId, argvSha256: decision.argvSha256, causeClass: decision.causeClass ?? null };
}

function renewalCommand(workflow, decision) {
  return testRunRiskDecisionCommand(workflow, { phaseId: decision.phase, commandId: decision.commandId,
    argvSha256: decision.argvSha256, causeClass: decision.causeClass ?? null });
}

/**
 * What a refused run whose cause is the environment adds to its refusal: what SFlow reads the cause
 * as, and the command a person who approves the step runs to accept it. Null for any other run.
 */
export function testRunRiskRoute(workflow, { phaseId, attempt, at }) {
  if (!attempt || testRunRiskIneligibility(attempt)) return null;
  const cause = testRunCause(attempt);
  const state = testRunRiskStateFor(workflow, { phaseId, attempt }, { at });
  // The digest and class let an approver on another machine bind the same command without this run.
  const command = testRunRiskDecisionCommand(workflow, { phaseId, commandId: attempt.commandId, argvSha256: attempt.argvSha256, causeClass: cause.class });
  const lapsed = state && state.state !== 'active'
    ? ` ${state.decision.id} ${state.state === 'expired' ? `expired on ${state.decision.expiresAt.slice(0, 10)}` : 'was revoked'}.` : '';
  return {
    eligible: true, phase: phaseId, commandId: attempt.commandId, causeClass: cause.class, decision: state?.decision.id ?? null, lapsed: state?.state ?? null, command,
    guidance: `${noTestExecuted(attempt) ? 'No test executed in this run, so the environment may be what stopped it'
      : Number(attempt.tests?.failed) > 0 ? 'Every failed test of this run failed from the environment' : 'A test file of this run failed outside its tests because of the environment'}:`
      + ` ${testRunCauseText(cause)}.${lapsed} Fix the environment and run it again, or a person who approves ${phaseId} can accept the risk in their own terminal`
      + ` (an agent cannot), for later runs with this same cause only: ${command}`
  };
}

/**
 * What a refused run that failed or was blocked adds to its refusal: `testRunRisk`, the route above,
 * for an environment cause; otherwise `testRunCause`, saying a code or unknown cause is never covered
 * (worded when no test ran, or when a decision on the command did not cover it).
 */
export function testRunRiskRefusalDetails(workflow, { phaseId, attempt, at }) {
  if (!attempt || !NOT_RUN_STATUSES.has(attempt.status)) return {};
  const route = testRunRiskRoute(workflow, { phaseId, attempt, at });
  if (route) return { testRunRisk: route };
  const cause = testRunCause(attempt);
  const decided = countedRecords(workflow, workflow?.testRunRisks).some((entry) => !entry.revokes && entry.phase === phaseId && entry.commandId === attempt.commandId);
  const guidance = !decided && cause.class === 'assertion-failure' ? null : cause.category === 'code'
    ? `This run stopped on a code cause, ${testRunCauseText(cause)}: fix it in the step. A test-run risk decision never covers a code cause.`
    : `Nothing in this run says the environment stopped it: ${testRunCauseText(cause)}. No test-run risk decision covers it; read the saved output and fix the cause.`;
  return { testRunCause: { category: cause.category, class: cause.class, ...(cause.file ? { file: cause.file } : {}), ...(guidance ? { guidance } : {}) } };
}

/**
 * A suite beside the one that refused a gate, as that refusal reports it; null when it passed or a
 * person's decision carries it. Reading it decides nothing and runs nothing.
 */
export function otherFailedTest(workflow, phase, command, attempt, { at }) {
  const minimumPassed = Math.max(command.result.minimumPassed ?? 1, workflow.resolution?.codeDelivery?.tests?.minimumPassed ?? 1);
  if (attempt && testReceiptPassing(attempt, command.result.minimumDiscovered ?? 1, minimumPassed)) return null;
  if (coveringTestRunRisk(workflow, { phaseId: phase.id, attempt, at })) return null;
  const cause = attempt ? testRunCause(attempt) : null;
  return { commandId: command.id, attemptId: attempt?.attemptId ?? null, status: attempt?.status ?? 'skipped', exitCode: attempt?.exitCode ?? null,
    tests: attempt?.tests ?? null, causeClass: cause?.class ?? null, cause: cause ? testRunCauseWords(cause.class) : null, ...(cause?.file ? { file: cause.file } : {}) };
}

/** A gate's refusal, naming the other suites of the same run that failed. Its full diagnostic stays the first's. */
export function withOtherFailedTests(refusal, others) {
  const failed = others.filter(Boolean);
  if (!failed.length) return refusal;
  const words = failed.map(({ commandId, status, exitCode, tests, cause }) => {
    const ended = [exitCode ? `exit ${exitCode}` : status, tests?.failed ? `${tests.failed} of ${tests.discovered} tests failed` : null].filter(Boolean).join(', ');
    return `'${commandId}' (${ended}${cause ? `: ${cause}` : ''})`;
  });
  refusal.message = `${refusal.message} Also failed: ${words.join(', ')}.`;
  refusal.details = { ...(refusal.details ?? {}), otherFailedTests: failed };
  return refusal;
}

/**
 * Why a bound decision does not cover this recorded attempt of this step, or null when it does:
 * the decision is on the Story with the bound bytes, names the same step, command and argv, the
 * attempt's cause is the class it accepted, and the decision governing that command and class is
 * active at `at`.
 */
export function testRunRiskCoverageProblem(workflow, binding, { phaseId, attempt, at }) {
  const decision = countedRecords(workflow, workflow?.testRunRisks).find((entry) => !entry.revokes && entry.id === binding?.id);
  if (!decision || testRunRiskSha256(decision) !== binding?.sha256) return `test-run risk ${binding?.id ?? '?'} is not recorded on the Story with these bytes`;
  if (decision.phase !== phaseId || decision.commandId !== attempt?.commandId || decision.argvSha256 !== attempt?.argvSha256) {
    return `test-run risk ${decision.id} was accepted for another step or command`;
  }
  const gap = causeGap(decision, attempt);
  if (gap) return gap;
  const state = testRunRiskState(workflow, governedBy(decision), { at });
  if (state?.state !== 'active') {
    return `test-run risk ${state?.decision.id ?? decision.id} is ${state?.state ?? 'unknown'}; a person who approves ${phaseId} must accept it again: `
      + renewalCommand(workflow, decision);
  }
  return null;
}

/**
 * The decisions that no longer carry runs they let through, because the decision now governing
 * the command and class expired or was revoked: one entry per command and class, each with the
 * renewal a person who approves that step runs (`decision test-risk ... --expires`). Empty when
 * nothing lapsed.
 */
export function lapsedTestRunRiskRenewals(workflow, entries, { at } = {}) {
  const renewals = new Map();
  for (const entry of entries ?? []) {
    const binding = entry?.testRunRisk;
    const decision = binding?.id
      ? countedRecords(workflow, workflow?.testRunRisks).find((record) => !record.revokes && record.id === binding.id) : null;
    if (!decision || testRunRiskSha256(decision) !== binding.sha256) continue;
    const key = [decision.phase, decision.commandId, decision.argvSha256, decision.causeClass ?? ''].join('\u0000');
    if (renewals.has(key)) continue;
    const state = testRunRiskState(workflow, governedBy(decision), { at });
    if (!state || state.state === 'active') continue;
    const command = renewalCommand(workflow, decision);
    renewals.set(key, {
      decision: state.decision.id, state: state.state, phase: decision.phase, commandId: decision.commandId, command,
      words: `${state.decision.id} ${state.state === 'expired' ? `expired on ${state.decision.expiresAt.slice(0, 10)}` : 'was revoked'},`
        + ` so the run of ${decision.commandId} it let through (${(decision.observation?.testsExecuted ?? 0) > 0 ? 'its failed tests failed from the environment' : 'no test executed'}) is no longer carried.`
        + ` A person who approves ${decision.phase} can renew it in their own terminal (an agent cannot), or the environment is fixed and the tests run again: ${command}`
    });
  }
  return [...renewals.values()];
}

/** How the review names a run a decision let through: by the run the decision itself observed. */
function stoppedRun(decision, commandId) {
  if (decision.boundBy === 'command-digest') return `The environment stopped the tests of ${commandId}`;
  return (decision.observation?.testsExecuted ?? 0) > 0 ? `The failed tests of ${commandId} failed only from the environment` : `No test ran for ${commandId}`;
}

/**
 * What a reviewer is told about the runs of a step that a decision let through: which command,
 * the accepted cause class and stated cause, who accepted it until when, and whether that still
 * holds now.
 */
export function acceptedTestRunSummaries(workflow, phaseId, entries, { at } = {}) {
  const summaries = [];
  for (const entry of entries ?? []) {
    if (!entry?.testRunRisk) continue;
    const decision = countedRecords(workflow, workflow?.testRunRisks).find((record) => !record.revokes && record.id === entry.testRunRisk.id);
    if (!decision) continue;
    const active = boundTestRunRiskActive(workflow, entry.testRunRisk, { at });
    const commandId = entry.commandId ?? decision.commandId;
    const accepted = decision.causeClass ? ` (${testRunCauseWords(decision.causeClass)})` : '';
    summaries.push({
      id: decision.id, commandId, causeClass: decision.causeClass ?? null, cause: decision.cause, actor: decision.actor,
      authorityGroup: decision.authorityGroup, expiresAt: decision.expiresAt, active,
      words: `${stoppedRun(decision, commandId)}${accepted}:`
        + ` ${decision.cause.replace(/[.\s]+$/u, '')}. Accepted as ${decision.id} by ${decision.actor}`
        + ` (${decision.authorityGroup}) until ${decision.expiresAt.slice(0, 10)}${active ? '' : '; no longer active, so the next gate refuses it'}.`
        + ` The run stays ${entry.status ?? 'failed'}; it is not a pass.`
    });
  }
  return summaries;
}
