/**
 * What a refusal or hold met on a workflow walk means (`workflow walk`, src/workflow-walk/walk.mjs).
 *
 *   expected-person-step  a real decision a person is meant to make: an answer, a scope or plan
 *                         decision, an approval, a sign-off, a step run in their own terminal.
 *   expected-review       the step's independent reviewer reviews here.
 *   stop                  anything else: a gate the walk's stub could not satisfy because the
 *                         configuration makes it impossible or contradictory, a missing route, a
 *                         refusal with no usable repair.
 *   not-judged            the walk itself ran out of time or met a step kind its stub cannot author;
 *                         a gap in the walk, never a verdict on the workflow.
 *
 * A code listed here is one the walk knows how to meet as a person or reviewer would; every other
 * refusal is a stop, reported with its code, message, the routes SFlow offered and the most likely
 * configuration cause the walk can name.
 */
export const WALK_CLASSES = Object.freeze(['expected-person-step', 'expected-review', 'stop', 'not-judged']);

/** Refusals a person or reviewer clears, and what the walk does in their place. */
export const MET_REFUSALS = Object.freeze({
  SOURCE_REVIEW_REQUIRED: { class: 'expected-review', handler: 'review',
    ask: "The step's independent reviewer reviews the published draft before it is submitted." },
  CONVERGENCE_ADVANCE_CONFIRMATION_REQUIRED: { class: 'expected-person-step', handler: 'advance',
    ask: "A person reviews the convergence result (story advance) and confirms it with the digest it gives." },
  STORY_TERMINAL_READINESS_REFUSED: { class: 'expected-person-step', handler: 'decisions',
    ask: 'Before the Story ends, its approvers record each open obligation in the decision list: a scope decision, or why a responsibility the route omits does not apply.' },
  DEPARTURES_UNDECIDED: { class: 'expected-person-step', handler: 'decisions',
    ask: "An approver accepts or rejects each departure from the approved documents (a path the plan does not name), in the decision list." },
  SCOPE_ITEMS_UNRESOLVED: { class: 'expected-person-step', handler: 'decisions',
    ask: "An approver links each statement of the Story's sources to the clauses that carry it, or includes, excludes or defers it, in the decision list." },
  APPROVAL_IDENTITY_NOT_AUTHORIZED: { class: 'expected-person-step', handler: 'approver',
    ask: 'A member of the step\'s approval group approves it.' },
  APPROVAL_SELF_APPROVAL_FORBIDDEN: { class: 'expected-person-step', handler: 'approver',
    ask: 'Someone other than the author approves the step.' },
  SELF_APPROVAL_NOT_ALLOWED: { class: 'expected-person-step', handler: 'approver',
    ask: 'Someone other than the author approves the step.' }
});

/**
 * Refusals that need something outside any workflow walk: a live web application, a browser, an MCP
 * server's live smoke. The step is not judged; its message says what it needs.
 */
export const NOT_JUDGED_REFUSALS = Object.freeze({
  MCP_PHASE_NOT_READY: 'The step needs an MCP server ready on this machine (a host entry, a warm package and a live smoke against an authorized target), which the walk does not have.',
  POC_TARGET_ORIGIN_REQUIRED: 'The workflow needs a live web application and a browser smoke at Story start, which the walk does not have.'
});

/** The most likely configuration cause of a refusal the walk could not get past, by code. */
const CAUSES = Object.freeze({
  APPROVAL_POLICY_UNATTAINABLE: "An approval group a step needs lists nobody who may approve it (no members, nobody besides the Story's author where self-approval is off, or fewer people than its minimum). Add members to the group, or allow self-approval, in singularity/workflow.yml.",
  APPROVAL_IDENTITY_NOT_AUTHORIZED: "Nobody the step's approval groups list may approve it here. Add members to the group in approvalAuthorities.",
  CLARIFICATION_MARKERS_UNRESOLVED: "The step blocks on an open clarification marker but no answer can be recorded for it: its clarification is off. Turn clarification on for the step, or set its markers to warn or off.",
  CLARIFICATION_DISABLED: "The step's clarification is off, so a question its draft raises can never be answered. Turn clarification on for the step, or set its markers to warn or off.",
  WORKFLOW_WALK_NO_TEST_COMMAND: "The code step has no test command it can run: the repository's test commands, the step's quality commands and the platform's detection found none for the walk's Node project.",
  REPOSITORY_TEST_COMMAND_REQUIRED: "The code step requires a configured test command and none is configured or detected. Name the test command for the step, or let the repository's tests be detected.",
  UNKNOWN_WORK_TYPE: 'The workflow is not one the configuration defines for Stories.',
  WORK_TYPE_UNKNOWN: 'The workflow is not one the configuration defines for Stories.'
});

/** Why a code step's required test failed, from the refusal's own record of the run. */
function testCause(details) {
  const run = details?.requiredTestExecution;
  if (!run) return null;
  const why = run.failure?.kind === 'missing-launcher'
    ? `cannot start on this machine (${shortMessage(run.stderr?.text ?? 'its launcher is missing', 160)})`
    : `fails on the walk's passing change (status ${run.status ?? 'unknown'}, exit ${run.exitCode ?? 'unknown'})`;
  return `The code step's ${run.provenance ?? ''} test command '${run.commandId}' ${why}, so no Story's code step can pass its tests. `
    + 'Configure a test command the repository can run (kind: test with a result adapter), or let the repository\'s own tests be detected; '
    + 'the only way past it in a Story is a person accepting a dated test-run risk.';
}

/** A refusal's message, first sentence first, short enough to read in a list. */
export function shortMessage(message, limit = 600) {
  const text = String(message ?? '').replace(/\s+/gu, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * The cause the walk names for a stop: a known code's configuration cause, else the refusal's own
 * words with the routes SFlow offered, and what that says about the workflow.
 */
export function likelyCause(code, { message = '', routes = [], step = null, details = null } = {}) {
  if (code === 'CODE_TEST_FAILED' && testCause(details)) return testCause(details);
  if (CAUSES[code]) return CAUSES[code];
  const offered = routes.filter(Boolean);
  if (!offered.length) return `SFlow refused ${step ? `step ${step} ` : ''}with ${code ?? 'no code'} and returned no route to clear it, so a person following it would be stuck here too.`;
  return `SFlow refused ${step ? `step ${step} ` : ''}with ${code ?? 'no code'}; the walk's stub could not satisfy what it asks with the routes it returned (${offered.slice(0, 3).join('; ')}). Check the step's template, inputs and gates in singularity/workflow.yml against: ${shortMessage(message, 240)}`;
}
