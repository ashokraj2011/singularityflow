/**
 * A failing test goes back to the code step on its own (owner, 2026-11-20, step intents spec §11, D1: "this should be
 * automatic .. not too many ceremonies").
 *
 * A test step changes no source code: the code step writes the tests, the test step runs them and reports. So when a test
 * step's run fails at its submission, the fix is the code step's, and SFlow makes the return itself, right after the
 * submission, instead of leaving the person to send the step back:
 * 1. it returns the test step to the code step whose code the tests ran on (the step it cites, else the nearest approved
 *    code step it may return to), with the failures as the change request: the failing tests, what they said, the files
 *    and the clauses involved;
 * 2. it starts that code step's next version, settled for the person with an undo (`failing-tests`), in the opening's own
 *    commit, as a review's findings start one (review-findings-opening.mjs). The code step's author fixes it there.
 * Once the code step's new version is approved (or completes, as its workflow says) and the Story reaches the test step
 * again, SFlow starts the test step's next version the same way (`tests-rerun`), so its tests run again.
 *
 * Both count against the workflow's review brake (sourceReview.autoFixVersions, per step with autoFixVersionsByStep, 2
 * unless set). SFlow stops and the person decides when the brake is reached, when a test fails again after SFlow's own fix,
 * when a person undid an earlier start, when the Story takes people's signatures, or when the workflow's rework rounds are
 * spent. The step then waits for its approvers as before, with filled choices (heldChoices): another version of the code
 * step, the risk accepted on the Decide card where SFlow's rules allow one, or running the tests again.
 *
 * Which steps: a step whose output is test results, that may not change source files, is not a code step and is approved
 * (by a person or by SFlow), in a Story that pinned owner-step checks level 4 (phase-roles.mjs OWNER_STEP_CHECKS, raised
 * to 4 for this on 2026-11-20). A Story already running
 * keeps what it started with. The shipped verification and testing steps change no source files since Stage 7 adopted D1
 * for them; a test step that may still change source files (the POC validation, the visual verification, the quick fix's
 * verify) is unchanged: its approvers return it, or it repairs itself.
 *
 * This module holds the rules, which the submission and the approval read (state.mjs), so VS Code's bundles take only
 * them; the acts that commit, the return and the two version starts, are failing-tests-opening.mjs, which only the
 * submit, approve and reject commands load.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { decideRoute, returnRoute } from './action-command-map.mjs';
import { phaseCorrectionTargets } from './approval-fallback.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { editsSource, isTestEvidencePhase, ownerStepChecks } from './phase-roles.mjs';
import { settledDecisions } from './settled-decisions.mjs';
import { autoFixVersionsOf } from './source-review-policy.mjs';

/** Who returns a test step's failing tests: SFlow itself, never a person or an agent (as AUTOMATIC_APPROVER approves). */
export const AUTOMATIC_RETURNER = Object.freeze({ name: 'SFlow (returned automatically)', login: 'sflow-returned-automatically', automatic: true });
export const FAILING_TESTS = 'failing-tests';
export const TESTS_RERUN = 'tests-rerun';
/** The owner-step checks level a Story pins to have its failing tests returned on their own. */
export const FAILING_TESTS_LEVEL = 4;

const MAX_TESTS = 12;
const MAX_WORDS = 1800;
/** A step as a person reads it: its label, else its ID. */
export const stepWords = (phase) => phase?.label ?? phase?.id ?? 'the step';
const name = stepWords;
const clean = (value, maximum = 240) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum);

/** Whether `phase` is a test step whose failing tests SFlow returns on its own, in this Story. Pure. */
export function autoReturnStep(workflow, phase) {
  return Boolean(phase) && ownerStepChecks(workflow, FAILING_TESTS_LEVEL) && isTestEvidencePhase(phase) && !phaseRequiresCodeDelivery(phase)
    && !editsSource(phase) && (phase.approvalPolicy?.mode ?? 'required') !== 'none';
}

const testCheck = (check) => check?.kind === 'test' || check?.source === 'repository-tests';
const failedCheck = (check) => ['failed', 'blocked'].includes(check?.status) && !check.testRunRisk && !check.trpObservationSha256;

/**
 * The step's failed checks, when every check that failed ran tests and nothing required was unavailable; null otherwise
 * (a failed lint or a missing tool is not a failing test, and stays with the step's people). Pure.
 */
export function failingTestChecks(phase) {
  const checks = phase?.checks ?? [];
  const failed = checks.filter(failedCheck);
  if (!failed.length || !failed.every(testCheck)) return null;
  const unavailable = checks.some((check) => ['skipped-warning', 'unavailable'].includes(check?.status) && (check.requirement ?? 'required') === 'required');
  return unavailable ? null : failed;
}

/** The approved code step the test step's tests ran on, that it may return work to; null when there is none. Pure. */
export function codeStepOf(workflow, phase) {
  const order = workflow?.phaseOrder ?? [];
  const targets = phaseCorrectionTargets(phase);
  const pinned = (workflow?.resolution?.phases ?? []).find((entry) => entry.id === phase?.id)?.testEvidenceFrom ?? null;
  const before = order.slice(0, Math.max(0, order.indexOf(phase?.id))).reverse().map((id) => workflow.phases?.[id]);
  const code = (pinned ? workflow.phases?.[pinned] : null) ?? before.find((candidate) => candidate?.status === 'approved' && phaseRequiresCodeDelivery(candidate));
  return code && phaseRequiresCodeDelivery(code) && code.status === 'approved' && targets.includes(code.id) ? code : null;
}

/** The versions of `code` SFlow started in a row (for a review's findings or for failing tests), newest first. Pure. */
export function automaticRun(workflow, code) {
  const starts = settledDecisions(workflow).filter((entry) => [FAILING_TESTS, 'review-corrections'].includes(entry.kind) && entry.phase === code.id);
  const run = [];
  for (let version = Number(code.generation ?? 0); version > 1;) {
    const start = starts.findLast((entry) => Number(entry.effect?.toGeneration) === version);
    // A version a person started breaks the run: their yes, or their own return.
    if (!start || start.undone || start.effect?.byPerson || !(Number(start.effect?.generation) < version)) break;
    if (Number(code.versionOpening?.version) === version && code.versionOpening.consent?.surface !== 'settled') break;
    run.push(start);
    version = Number(start.effect.generation);
  }
  return run;
}

/**
 * Why the return is the person's to make although the tests failed at a test step, or null: the workflow asks every
 * time, SFlow already returned failing tests as many times in a row as it may, a test failed again after SFlow's own
 * fix, a person undid an earlier start, or the Story takes people's signatures. Pure.
 */
export function failingTestsHold(workflow, phase, code, keys = []) {
  if (workflow?.resolution?.presence) return { reason: 'signatures', words: 'Returns on this Story take a person\'s signature.' };
  const undone = settledDecisions(workflow).some((entry) => [FAILING_TESTS, TESTS_RERUN].includes(entry.kind) && entry.undone
    && (entry.effect?.testPhase === phase.id || entry.phase === phase.id));
  if (undone) return { reason: 'undone', words: `A person undid an earlier start for ${name(phase)}'s failing tests, so SFlow asks first.` };
  const limit = autoFixVersionsOf(workflow, code.id);
  if (limit === 0) return { reason: 'setting', words: 'This workflow asks you before every version that fixes failing tests.' };
  const run = automaticRun(workflow, code);
  const returns = run.filter((entry) => entry.kind === FAILING_TESTS);
  if (returns.length >= limit) return { reason: 'rounds', words: `${name(phase)}'s tests failed ${returns.length + 1} times in a row.` };
  const before = new Set(returns[0]?.effect?.tests ?? []);
  const back = keys.filter((key) => before.has(key));
  return back.length ? { reason: 'repeated', tests: back, words: `${testWords(back[0])} failed again after SFlow's fix.` } : null;
}

/** A failing test's key as a person reads it: "returns the approved value", or "the test command e2e". */
export function testWords(key) {
  const [kind, ...rest] = String(key ?? '').split(':');
  return kind === 'command' ? `The test command ${rest.join(':')}` : `The test '${rest.slice(1).join(':')}'`;
}

/** What a failed check's output says, in a few lines: the failing assertions first, else its last lines. */
function outputLines(check) {
  const lines = `${check?.stderr ?? ''}\n${check?.stdout ?? ''}`.split('\n').map((line) => line.trim()).filter(Boolean)
    .filter((line) => !/^(?:#|ok \d|TAP version|1\.\.\d|duration_ms|\.\.\.|---)/u.test(line));
  const telling = lines.filter((line) => /not ok|fail|error|assert|expected|actual|✖|×/iu.test(line));
  return [...new Set((telling.length ? telling : lines.slice(-4)).map((line) => clean(line, 200)))].slice(0, 4);
}

async function readJson(root, relative) {
  if (typeof relative !== 'string' || !relative) return null;
  try { return JSON.parse(await readFile(path.join(root, relative), 'utf8')); } catch { return null; }
}

/**
 * What failed, read from the step's own run and the code step's records: each failed command with what its output says,
 * each failing test (its name, file and line, from the run's recorded attempt), the clauses whose tests those are (the
 * code step's witnesses), and the files involved (the failing tests' and the code step's changed files). `keys` say which
 * tests they are, so one back after SFlow's fix is told apart. `words` is the change request the code step reads.
 */
export async function failingTestFacts(root, workflow, phase, code, failed) {
  const runs = new Map((phase.stepTestRuns?.testExecutions ?? []).map((entry) => [entry.commandId, entry]));
  const commands = [];
  const tests = [];
  for (const check of failed) {
    const run = runs.get(check.id);
    const attempt = run ? await readJson(root, run.receiptPath) : null;
    const failing = (attempt?.occurrences ?? []).filter((occurrence) => occurrence?.outcome === 'failed' && occurrence.name);
    for (const occurrence of failing) tests.push({ command: check.id, name: clean([...(occurrence.suitePath ?? []), occurrence.name].join(' › '), 200),
      ...(occurrence.file ? { file: occurrence.file } : {}), ...(Number.isInteger(occurrence.line) ? { line: occurrence.line } : {}) });
    const counts = attempt?.tests ?? run?.counts ?? null;
    commands.push({ id: check.id, command: clean(check.command, 200), exitCode: Number.isInteger(check.exitCode) ? check.exitCode : null,
      ...(counts ? { counts: { discovered: counts.discovered ?? null, failed: counts.failed ?? null } } : {}), said: outputLines(check),
      ...(failing.length ? {} : { tests: false }) });
  }
  const keys = [...new Set([...tests.map((test) => `test:${test.command}:${test.name}`),
    ...commands.filter((command) => command.tests === false).map((command) => `command:${command.id}`)])];
  const receipt = await readJson(root, code.deliveryEvidence?.receiptPath);
  const witnesses = receipt?.traceability?.witnesses ?? [];
  const clauses = [...new Set(witnesses.filter((witness) => witness?.clauseId && tests.some((test) => (test.file && test.file === witness.testSource)
    || (witness.identity?.name && test.name.endsWith(witness.identity.name)))).map((witness) => witness.clauseId))].sort();
  const { affectedDeliveryPaths } = await import('./delivery-evidence.mjs');
  const files = [...new Set([...tests.map((test) => test.file).filter(Boolean), ...affectedDeliveryPaths(code.deliveryEvidence ?? {}, code.sourceBoundary)])].slice(0, 12);
  const named = tests.slice(0, MAX_TESTS).map((test) => `${test.name}${test.file ? ` (${test.file}${test.line ? `:${test.line}` : ''})` : ''}`);
  const ran = commands.map((command) => `${command.id} (${command.command}${command.exitCode !== null ? `, exit ${command.exitCode}` : ''}${command.counts?.failed
    ? `, ${command.counts.failed} of ${command.counts.discovered ?? '?'} tests failed` : ''})${command.said.length ? `: ${command.said.join(' | ')}` : ''}`);
  const words = [`${name(phase)} version ${phase.generation} ran its tests and they failed. ${name(phase)} changes no source code, so ${name(code)} fixes it.`,
    `Failed: ${ran.join('; ')}.`,
    named.length ? `Failing tests: ${named.join('; ')}${tests.length > MAX_TESTS ? `; and ${tests.length - MAX_TESTS} more` : ''}.` : '',
    clauses.length ? `Clauses: ${clauses.join(', ')}.` : '',
    files.length ? `Files: ${files.join(', ')}.` : '',
    `Fix the code, or its tests, in ${name(code)} so these pass; ${name(phase)} then runs them again.`].filter(Boolean).join(' ').slice(0, MAX_WORDS);
  return { commands, tests: tests.slice(0, 50), keys, clauses, files, words };
}

const quoted = (words) => `"${String(words).replaceAll('"', '\'').replace(/\s+/gu, ' ').trim()}"`;

/**
 * The person's choices once SFlow stops (held), each filled so nothing is typed: return the test step to the code step
 * for another version, with SFlow's words for why; accept the risk on the Decide card, where SFlow's rules allow one (a run
 * the environment stopped: a failing test with a code cause is never accepted as a risk); or dispute it, which returns the
 * test step to itself so its tests run again. Pure.
 */
export function heldChoices(workflow, phase, code, facts, { riskEligible = false } = {}) {
  // Each a form of the one action-to-command map, its reason filled with SFlow's words.
  const back = (to, words) => { const route = returnRoute(workflow, phase, to); return { ...route, command: route.command.replace('<reason>', quoted(words)) }; };
  return [
    { id: 'another-version', label: `Start another version of ${name(code)} to fix the failing tests`,
      ...back(code.id, `The tests ${name(phase)} version ${phase.generation} ran failed: ${facts.keys.slice(0, 3).map(testWords).join('; ')}. Fix them in ${name(code)}'s next version.`) },
    ...(riskEligible ? [{ id: 'accept-risk', label: 'Accept the risk on the Decide card: the environment stopped this run', ...decideRoute(workflow) }] : []),
    { id: 'dispute', label: `Dispute it: run ${name(phase)}'s tests again`, ...back(phase.id, `Disputed: the failure is not ${name(code)}'s code. Run ${name(phase)}'s tests again.`) }
  ];
}

/** The approval's refusal at the brake, in words: why the code step fixes it, and each filled choice with its command. */
export function heldWords(phase, code, choices) {
  return `${phase.id} changes no source code, and its tests fail on the code ${code.id} delivered, which ${code.id} fixes. `
    + `Start another version of ${code.id} (${choices[0].command}); ${choices.slice(1).map((choice) => `or ${choice.label.charAt(0).toLowerCase()}${choice.label.slice(1)} (${choice.command})`).join('; ')}.`;
}

/** Whether any failed run of the step was stopped by its environment, so a person may accept its risk (test-run-risk.mjs). */
async function riskEligibleRun(root, phase, failed) {
  const runs = new Map((phase.stepTestRuns?.testExecutions ?? []).map((entry) => [entry.commandId, entry]));
  const { testRunRiskIneligibility } = await import('./test-run-risk.mjs');
  for (const check of failed) {
    const attempt = await readJson(root, runs.get(check.id)?.receiptPath);
    if (attempt && !testRunRiskIneligibility(attempt)) return true;
  }
  return false;
}

const named = (list, limit = 4) => `${list.slice(0, limit).join(', ')}${list.length > limit ? ` and ${list.length - limit} more` : ''}`;

/**
 * The code step whose repository tests a refactor's checks are (`tests base` runs a code step's commands): `phase` itself
 * when it is one, else the nearest code step before it. Null when there is none. Pure.
 */
export function refactorCodeStep(workflow, phase) {
  if (phaseRequiresCodeDelivery(phase)) return phase;
  const order = workflow?.phaseOrder ?? [];
  return order.slice(0, Math.max(0, order.indexOf(phase?.id))).reverse().map((id) => workflow.phases?.[id]).find((step) => phaseRequiresCodeDelivery(step)) ?? null;
}

/**
 * A refactor's step after the change [ITW:REQ-015]: each failed test command's latest run, at the code step or at the test
 * step after it, against its run on the Story's base, which the start's `task.before` (`tests base`, on the code step's
 * commands) kept (verification/base-run.mjs baseCheckFacts). A test that passed before and fails after is a behaviour
 * change (`changed`); one that failed before too stays a finding (`before`); a command with no run before the change kept,
 * or one on another Node, cannot be told (`unknown`). `pick` chooses the run compared among a command's runs of `phase`
 * (the latest by default). Reads only what is kept; runs nothing. Null when the Story is not a refactor.
 */
export async function refactorAfterCheck(root, config, workflow, phase, failed, { pick = null } = {}) {
  if (workflow?.resolution?.composition?.kind !== 'refactor' || !config) return null;
  const code = refactorCodeStep(workflow, phase);
  if (!code) return null;
  const { baseCheckFacts } = await import('./verification/base-run.mjs');
  const ids = [...new Set(failed.map((check) => check.id))];
  return afterCheckOf(ids, await baseCheckFacts(root, config, workflow, code, ids, { here: phase, ...(pick ? { pick } : {}) }).catch(() => new Map()));
}

/** The after-check from what the kept base runs say of each failed command (baseCheckFacts' map). Pure. */
export function afterCheckOf(ids, facts) {
  const changed = [];
  const before = [];
  const unknown = [];
  for (const id of ids) {
    const fact = facts.get(id);
    if (fact?.status !== 'checked' || !['passes-on-base', 'fails-on-base', 'partly-on-base'].includes(fact.verdict)) { unknown.push(id); continue; }
    const onlyHere = fact.onlyHere ?? [];
    const alsoOnBase = fact.alsoOnBase ?? [];
    // A command that failed with no test named fails only with the change when it passed before, and failed before too
    // when it failed there.
    if (onlyHere.length || (fact.verdict === 'passes-on-base' && !alsoOnBase.length)) changed.push({ command: id, tests: [...onlyHere] });
    if (alsoOnBase.length || (fact.verdict === 'fails-on-base' && !onlyHere.length)) before.push({ command: id, tests: [...alsoOnBase] });
  }
  return { changed, before, unknown };
}

/** The checks of an after-check entry as a person reads them: each test by name, or its command when it named none. */
export const checkNames = (entries) => entries.flatMap((entry) => (entry.tests.length ? entry.tests.map((test) => `'${test}'`) : [`the test command ${entry.command}`]));

/**
 * Why a refactor's test step stops, and the person's choices [ITW:REQ-015]: a behaviour change is named, and the person
 * keeps the old behaviour (the code step's next version) or accepts the new one (back to the plan, which is revised: the
 * task becomes a change, task-amendment.mjs acceptBehaviourAfterReturn); a check that already failed before stays a
 * finding the refactor does not approve; with no run before the change kept, the checks are run on the base first. Pure.
 */
export function refactorHold(workflow, phase, code, check, choices) {
  if (!check) return null;
  const back = (to, words) => { const route = returnRoute(workflow, phase, to); return { ...route, command: route.command.replace('<reason>', quoted(words)) }; };
  const dispute = choices.find((choice) => choice.id === 'dispute');
  if (check.changed.length) {
    const changed = checkNames(check.changed);
    const plan = (workflow.resolution?.composition?.steps ?? []).find((step) => step.intent === 'plan');
    const keep = { id: 'keep-behaviour', label: `Keep the old behaviour: start another version of ${name(code)}`,
      ...back(code.id, `Keep the old behaviour: ${named(changed)} passed before the change and fail after it. Restore it in ${name(code)}'s next version.`) };
    const accept = plan && (phase.approvalPolicy?.rejectTo ?? []).includes(plan.id) ? { id: 'accept-behaviour',
      label: 'Accept the new behaviour: the task becomes a change, and its plan is revised',
      ...back(plan.id, `Accept the new behaviour: ${named(changed)} behave differently after the change, as intended. Revise the plan to say what changes; the code and its tests follow it.`) } : null;
    const held = [keep, ...(accept ? [accept] : []), ...(dispute ? [dispute] : [])];
    return { reason: 'behaviour-change', changed: check.changed, choices: held,
      words: `The refactor changed behaviour: ${named(changed)} passed before the change and ${changed.length === 1 ? 'fails' : 'fail'} after it. `
        + `Keep the old behaviour (${keep.command})${accept ? `, or accept the new one (${accept.command})` : ''}.` };
  }
  if (check.unknown.length) {
    const before = { id: 'run-before', label: 'Run the checks on the base first, to tell what changed',
      command: `singularity-flow tests base --work-id ${workflow.workItem.id} --phase ${(refactorCodeStep(workflow, phase) ?? code).id} --within 600 --json`, skill: null };
    return { reason: 'no-before', choices: [before, ...choices], words: `No run before the change is kept for ${named(check.unknown)}, so SFlow cannot tell a changed behaviour from an old failure. Run them before the change: ${before.command}` };
  }
  if (check.before.length) {
    return { reason: 'failed-before', before: check.before, choices,
      words: `${named(checkNames(check.before))} already failed before the change: ${check.before.length === 1 && check.before[0].tests.length <= 1 ? 'a finding' : 'findings'} the refactor does not approve. A person decides them.` };
  }
  return null;
}

/** What failed and the person's filled choices for it, as the submission and the approval give them when SFlow stops. */
export async function brakeChoices(root, workflow, phase, code, failed, { config = null } = {}) {
  const facts = await failingTestFacts(root, workflow, phase, code, failed);
  const choices = heldChoices(workflow, phase, code, facts, { riskEligible: await riskEligibleRun(root, phase, failed) });
  // A refactor's test step compares with its run before the change [ITW:REQ-015]: it stops on what changed.
  const refactor = refactorHold(workflow, phase, code, await refactorAfterCheck(root, config, workflow, phase, failed), choices);
  return { facts, choices: refactor?.choices ?? choices, ...(refactor ? { refactor } : {}) };
}

/**
 * The test step's run again, due when the Story reached it after SFlow returned its failing tests to the code step and
 * that step's next version was approved: `{ code, start }`, or null. Pure.
 */
export function testsRerunDue(workflow, phase) {
  if (!autoReturnStep(workflow, phase) || workflow.currentPhase !== phase.id || phase.status !== 'in_progress' || !(Number(phase.generation) >= 1)) return null;
  if (Number(phase.versionOpening?.version ?? 0) > Number(phase.generation)) return null;
  const start = settledDecisions(workflow).findLast((entry) => entry.kind === FAILING_TESTS && entry.effect?.testPhase === phase.id);
  if (!start || start.undone || Number(start.effect?.testGeneration) !== Number(phase.generation)) return null;
  const code = workflow.phases?.[start.phase];
  if (!code || code.status !== 'approved' || !(Number(code.generation) >= Number(start.effect?.toGeneration))) return null;
  const request = (workflow.changeRequests ?? []).find((entry) => entry.id === start.effect?.changeRequest);
  if (!request || request.sourcePhase !== phase.id || Number(request.sourceGeneration) !== Number(phase.generation)) return null;
  if (settledDecisions(workflow).some((entry) => entry.kind === TESTS_RERUN && entry.phase === phase.id && (entry.undone
    || Number(entry.effect?.generation) === Number(phase.generation)))) return null;
  return { code, start };
}
