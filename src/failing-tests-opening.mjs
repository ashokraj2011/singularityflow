/**
 * The acts of a failing test's return to the code step (owner, 2026-11-20, step intents D1), each recorded and, where it
 * says so, undoable: SFlow's own return of a test step's failing tests with the code step's next version started for them
 * (returnFailingTests), that version started on a person's own return at the brake (versionAfterPersonReturn), and the test
 * step's run again once the fix is approved (rerunTestsAfterFix). The rules they follow are failing-tests-return.mjs.
 * Loaded only by the submit, approve and reject commands, never by VS Code's bundles.
 */
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { AUTOMATIC_RETURNER, FAILING_TESTS, TESTS_RERUN, autoReturnStep, automaticRun, brakeChoices, codeStepOf, failingTestChecks, failingTestFacts,
  failingTestsHold, stepWords as name, testWords, testsRerunDue } from './failing-tests-return.mjs';

const clean = (value, maximum = 240) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum);

/**
 * The settlement for a code step's version SFlow starts for a test step's failing tests: on its own return (`round`), or
 * on a person's own return of them (`byPerson`, the change request), which asked for exactly that version.
 */
function failingTestsSettlement(phase, code, facts, { changeRequest, next, round, byPerson = null }) {
  const tests = facts.keys.slice(0, 4).map(testWords).join('; ');
  return { kind: FAILING_TESTS, by: 'sflow', phase: code.id,
    subject: `${code.id} version ${code.generation}: the failing tests of ${phase.id} version ${phase.generation}`,
    answer: `${byPerson ? `Started version ${next} of ${name(code)} on the person's return of` : `Returned ${name(phase)} version ${phase.generation}'s failing tests to ${name(code)} and started its version ${next} to fix`} ${byPerson ? `${name(phase)} version ${phase.generation}'s failing tests` : 'them'}`,
    evidence: [
      { what: `${facts.keys.length === 1 ? 'a test' : `${facts.keys.length} tests`} failed when ${name(phase)} version ${phase.generation} was submitted: ${tests || 'its test run'}`,
        where: `${phase.id} test run (${facts.commands.map((command) => command.id).join(', ') || 'its checks'})` },
      { what: `${name(phase)} changes no source code, so the code step ${name(code)} fixes it`, where: `${phase.id} settings` },
      byPerson ? { what: `a person returned ${name(phase)} to ${name(code)} for another version (${byPerson})`, where: `${phase.id} change requests` }
        : { what: `SFlow's ${round === 1 ? 'first' : `round ${round}`} in a row of versions it starts for failing tests`, where: 'the workflow\'s review fixes (sourceReview.autoFixVersions)' }
    ],
    effect: { generation: Number(code.generation), toGeneration: next, testPhase: phase.id, testGeneration: Number(phase.generation), tests: facts.keys.slice(0, 50),
      changeRequest, ...(byPerson ? { byPerson } : { round }) } };
}

/** The code step's next version for the failing tests, settled with an undo, once the test step was returned to it. */
async function startCodeVersion(root, config, workflow, phase, code, facts, { changeRequest, from, actor = null, byPerson = null }) {
  const workId = workflow.workItem.id;
  const [opening, { actorKey }] = await Promise.all([import('./commands/phase-opening.mjs'), import('./state-stores.mjs')]);
  const proposed = await opening.proposalNow(root, workflow, code, { reason: await opening.successorReason(workflow, code) });
  const next = proposed.proposal.version;
  const round = automaticRun(workflow, code).filter((entry) => entry.kind === FAILING_TESTS).length + 1;
  const settlement = failingTestsSettlement({ ...phase, generation: from.test }, { ...code, generation: from.code }, facts, { changeRequest, next, round, byPerson });
  const opened = await opening.openSuccessor(root, config, workflow, code, { ...proposed,
    settled: { kind: FAILING_TESTS, settlement, actor: actor ? actorKey(actor) : null }, open: opening.codeOpening(root, config) });
  const settled = opened.settled ?? null;
  return { opened: { phase: code.id, generation: next, status: 'open' }, settled: settled ? { id: settled.id, kind: settled.kind, answer: settled.answer,
    undo: { copilotCommand: `/sf-decide ${workId}`, words: `An undo does not withdraw version ${next} of ${name(code)}: it stays open. It makes SFlow ask you before it returns ${name(phase)}'s failing tests again.` } } : null,
  nextAction: (await opening.kernelRoute(root, workflow, code, { config })).route };
}

/**
 * The return itself, right after the test step's submission: SFlow returns it to its code step with the failures as
 * the change request, then starts the code step's next version, settled with an undo. Returns `{ applies: false }` for a
 * step it does not cover, `{ applies: true, returned: false, held, choices }` when the person decides, or
 * `{ applies: true, returned: true, ... }`. A failure after the return leaves the code step returned: its next version is
 * then the person's yes, as after any return.
 */
export async function returnFailingTests(root, workId, phaseId, options = {}) {
  return withReport(await returnNow(root, workId, phaseId, options));
}

/** What the submission says and records of a return or a stop: its lines for a person's terminal, its data for --json. */
function withReport(result) {
  if (!result?.applies) return result;
  const returned = result.returned === true;
  const lines = returned ? [result.line] : [`Its tests failed. SFlow did not return it on its own: ${result.held?.words ?? 'its approvers decide.'} Your choices:`,
    ...(result.choices ?? []).map((choice) => `- ${choice.label}: ${choice.command}`)];
  const data = { returned, code: result.code, line: result.line ?? null,
    ...(returned ? { changeRequest: result.changeRequest, opened: result.opened, settled: result.settled ?? null, nextAction: result.nextAction ?? null }
      : { held: result.held, choices: result.choices ?? [] }),
    failing: { tests: result.facts?.tests?.slice(0, 12) ?? [], clauses: result.facts?.clauses ?? [], files: result.facts?.files ?? [] } };
  return { ...result, lines, data };
}

async function returnNow(root, workId, phaseId, { actor = null } = {}) {
  const { loadAcceptedStoryExecution } = await import('./accepted-story-execution.mjs');
  let { config, workflow } = await loadAcceptedStoryExecution(root, workId);
  const phase = workflow.phases?.[phaseId];
  if (!autoReturnStep(workflow, phase) || phase.status !== 'awaiting_approval' || workflow.currentPhase !== phase.id
    || phase.validationVerdict !== 'failed') return { applies: false };
  const failed = failingTestChecks(phase);
  const code = failed ? codeStepOf(workflow, phase) : null;
  if (!failed || !code) return { applies: false };
  const { facts, choices } = await brakeChoices(root, workflow, phase, code, failed);
  const held = failingTestsHold(workflow, phase, code, facts.keys);
  if (held) return { applies: true, returned: false, held, facts, code: code.id, choices };
  const from = { test: Number(phase.generation), code: Number(code.generation) };
  const [{ transactStory, rejectPhase }, { LIFECYCLE_EVENT }] = await Promise.all([import('./state-stores.mjs'), import('./lifecycle-event.mjs')]);
  const returner = { ...AUTOMATIC_RETURNER };
  let returned;
  try {
    ({ value: returned } = await transactStory(root, config, workflow,
      { type: LIFECYCLE_EVENT.PHASE_REJECTED, phaseId: phase.id, generation: phase.generation, actor: returner, agent: null, authorityGroup: null,
        payload: { targetPhaseId: code.id, automatic: FAILING_TESTS } },
      `[${workId}][phase:${phase.id}][reject] failing tests returned automatically to ${code.id}`,
      (aggregate) => rejectPhase(root, config, aggregate, { phaseId: phase.id, target: code.id, reason: facts.words, clauseIds: facts.clauses,
        actor: returner, agent: null, automatic: { kind: FAILING_TESTS, tests: facts.tests, commands: facts.commands, files: facts.files } }),
      { eventFromResult: (transition) => ({ actor: returner, agent: null, authorityGroup: null, identityAssurance: 'automatic',
        payload: { targetPhaseId: code.id, changeRequestId: transition.changeRequest.id, automatic: FAILING_TESTS } }) }));
  } catch (error) {
    // The workflow's rework rounds are spent (REPAIR_BUDGET_EXHAUSTED), or the return was refused: the person decides.
    return { applies: true, returned: false, held: { reason: 'refused', code: error?.code ?? null, words: clean(error?.message, 600) }, facts, code: code.id, choices };
  }
  ({ config, workflow } = await loadAcceptedStoryExecution(root, workId));
  const changeRequest = returned.changeRequest?.id ?? null;
  const base = { applies: true, returned: true, phase: phase.id, generation: from.test, code: code.id, fromGeneration: from.code, changeRequest, facts };
  try {
    const started = await startCodeVersion(root, config, workflow, phase, workflow.phases[code.id], facts, { changeRequest, from, actor });
    const line = `${name(phase)}'s tests failed, so SFlow returned it to ${name(code)} and started version ${started.opened.generation} to fix them. `
      + `${name(phase)} runs them again once that version is approved. An undo on the decisions card (/sf-decide ${workId}) only makes SFlow ask you first next time.`;
    return { ...base, ...started, line };
  } catch (error) {
    return { ...base, opened: null, line: `${name(phase)}'s tests failed, so SFlow returned it to ${name(code)}. Its next version could not start on its own (${clean(error?.message, 300)}), so it is your yes, as after any return.` };
  }
}

/**
 * A person's own return of a test step's failing tests to its code step, at the brake ("start another version"): the
 * version they asked for starts with it, settled with an undo, so they are not asked "Start version N?" a second time.
 * Null when the return was anything else (another target, a step that may change source, a run that did not fail).
 */
export async function versionAfterPersonReturn(root, workId, phaseId, changeRequestId, { actor = null } = {}) {
  const { loadAcceptedStoryExecution } = await import('./accepted-story-execution.mjs');
  const { config, workflow } = await loadAcceptedStoryExecution(root, workId);
  const phase = workflow.phases?.[phaseId];
  const request = (workflow.changeRequests ?? []).find((entry) => entry.id === changeRequestId);
  const code = workflow.phases?.[request?.targetPhase];
  if (!request || request.automatic || request.sourcePhase !== phaseId || !autoReturnStep(workflow, phase) || phase.validationVerdict !== 'failed'
    || !code || !phaseRequiresCodeDelivery(code) || workflow.currentPhase !== code.id || code.status !== 'in_progress'
    || Number(code.versionOpening?.version ?? 0) > Number(code.generation)) return null;
  const failed = failingTestChecks(phase);
  if (!failed) return null;
  const facts = await failingTestFacts(root, workflow, phase, code, failed);
  const started = await startCodeVersion(root, config, workflow, phase, code, facts,
    { changeRequest: request.id, from: { test: Number(request.sourceGeneration ?? phase.generation), code: Number(code.generation) }, actor, byPerson: request.id });
  return { ...started, line: `SFlow started version ${started.opened.generation} of ${name(code)} for the failing tests you returned; ${name(phase)} runs them again once it is approved.` };
}

/**
 * Start the test step's next version when its run again is due (testsRerunDue), settled with an undo, so its tests run
 * on the fixed code without asking the person. Returns null when nothing is due; on any refusal the version stays the
 * person's yes, as for any step reopened by a return.
 */
export async function rerunTestsAfterFix(root, workId, { actor = null } = {}) {
  const { loadAcceptedStoryExecution } = await import('./accepted-story-execution.mjs');
  const { config, workflow } = await loadAcceptedStoryExecution(root, workId);
  const phase = workflow.phases?.[workflow.currentPhase];
  const due = phase ? testsRerunDue(workflow, phase) : null;
  if (!due) return null;
  const opening = await import('./commands/phase-opening.mjs');
  const proposed = await opening.proposalNow(root, workflow, phase, { reason: await opening.successorReason(workflow, phase) });
  const next = proposed.proposal.version;
  const settlement = { kind: TESTS_RERUN, by: 'sflow', phase: phase.id,
    subject: `${phase.id} version ${phase.generation}: its tests again after ${due.code.id} version ${due.code.generation}`,
    answer: `Started version ${next} of ${name(phase)} to run its tests again on ${name(due.code)} version ${due.code.generation}`,
    evidence: [
      { what: `${name(due.code)} version ${due.code.generation} was approved to fix ${name(phase)} version ${phase.generation}'s failing tests`, where: `${due.code.id} approval` },
      { what: `${due.start.effect?.byPerson ? `a person returned those failing tests to ${name(due.code)} (${due.start.effect.byPerson})`
        : `SFlow returned those failing tests to ${name(due.code)}`} (${due.start.id})`, where: 'settled decisions' }
    ],
    effect: { generation: Number(phase.generation), toGeneration: next, codePhase: due.code.id, codeGeneration: Number(due.code.generation), after: due.start.id } };
  const { actorKey } = await import('./state-stores.mjs');
  const opened = await opening.openSuccessor(root, config, workflow, phase, { ...proposed,
    settled: { kind: TESTS_RERUN, settlement, actor: actor ? actorKey(actor) : null }, open: opening.documentOpening() });
  return { phase: phase.id, generation: next, settled: opened.settled ? { id: opened.settled.id, kind: TESTS_RERUN } : null,
    line: `${name(due.code)} version ${due.code.generation} is approved, so SFlow started version ${next} of ${name(phase)} to run its tests again.` };
}
