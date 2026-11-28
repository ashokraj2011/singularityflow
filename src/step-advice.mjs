/**
 * What a person is told around one step, by what the step is for (its intent), never by which workflow or work type it
 * belongs to [owner, 2026-11-28: "these things should be part of sf-phase, sf-code etc and some kind of internal advice
 * to each phase so this will be generic"]. Every approval and stop surface reads its why line here: the CLI's approval
 * item and its --for-agent ask, the VS Code approval page, the Decide card, the Needs-you card, the browser check and
 * the repeated-finding stop. A custom workflow gets the same lines with no change to its definition: the advice only
 * adds words around a step and changes nothing it does.
 *
 * Per intent, one line each:
 *   decides    what the person decides at the approval, and why they are the one asked
 *   yes        what Approve does
 *   sendBack   what Send back does (its reason goes to the next version)
 *   notNow     what Not now does
 *   settles    what SFlow settles itself, so the person is never asked it
 *   stops      the way forward for each stop a person can meet on the step, by kind (STOP_KINDS)
 * `{step}` is the step's name. test/step-advice.test.mjs checks every intent has every field and that no surface writes
 * these lines itself.
 *
 * Pure data and string filling. It imports only modules that import nothing, so it adds next to nothing wherever it
 * loads (the VS Code pages read it too); the step-intent inference is step-advice-intent.mjs's, for the CLI.
 */
import { PACKAGED_STEP_INTENTS } from './packaged-step-intents.mjs';
import { STEP_INTENTS } from './phase-roles.mjs';

/** The advice for a step whose intent SFlow cannot tell. */
export const GENERIC_INTENT = 'generic';
export const ADVICE_FIELDS = Object.freeze(['decides', 'yes', 'sendBack', 'notNow', 'settles', 'stops']);
/**
 * The stops a person can meet on a step's approval or its way there, each with its way forward:
 *   undecided  items on the approval page that must be decided first
 *   changed    the step's own files changed after it was reviewed
 *   review     its reviewer asked for changes
 *   approver   nobody is set to approve it
 *   repeated   the same check failed again after repairs
 *   browser    it needs a browser check SFlow saw itself
 */
export const STOP_KINDS = Object.freeze(['undecided', 'changed', 'review', 'approver', 'repeated', 'browser']);

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

// Lines most intents share; an intent's own lines replace them.
const SEND_BACK = 'Send back returns {step} with your reason; its next version is written to answer it.';
const NOT_NOW = 'Not now closes this and records nothing; {step} keeps waiting for you.';
const OWN_RECORDS = 'SFlow\'s own records (decisions, issues, notes) never undo your Yes; code changed meanwhile goes to the code step.';
const STOPS = Object.freeze({
  undecided: 'Approve stays off until each item below is decided: each one changes what the Story carries on with.',
  changed: '{step} changed after it was reviewed, so this is not what was reviewed: Send back so the change is reviewed.',
  review: 'The reviewer asked for changes: Send back with its findings, or dispute one with your reason.',
  approver: 'Nobody is set to approve {step}: add yourself as its approver, then approve it here.',
  repeated: 'This check keeps failing on the same thing: override it with your reason, or return it to the step that owns it.',
  browser: '{step} needs a page SFlow saw itself: let SFlow set up the browser check, or sign off on its screenshot yourself.'
});
const entry = (lines) => ({ sendBack: SEND_BACK, notNow: NOT_NOW, settles: OWN_RECORDS, ...lines, stops: { ...STOPS, ...(lines.stops ?? {}) } });

export const STEP_ADVICE = deepFreeze({
  intake: entry({
    decides: 'You decide if {step} says what was asked: every later step builds on it.',
    yes: 'Approve keeps this version of {step} and starts the next step.'
  }),
  requirements: entry({
    decides: 'You decide if {step} says what must be true when the work is done: the code and tests are checked against it.',
    yes: 'Approve keeps these requirements; later steps are checked against them.'
  }),
  design: entry({
    decides: 'You decide if {step} is the way to build it: the plan and the code follow it.',
    yes: 'Approve keeps this design and starts the next step.'
  }),
  plan: entry({
    decides: 'You decide if {step} is the work to build: the code step changes what it names and tests each part.',
    yes: 'Approve keeps this plan; the code step builds what it names.'
  }),
  code: entry({
    decides: 'You decide if this code does what the plan said: it goes into the pull request as it is.',
    yes: 'Approve keeps this code for the pull request and starts the next step.',
    sendBack: 'Send back returns {step} with your reason; Copilot writes the next version of the code to answer it.',
    settles: 'SFlow\'s own records never undo your Yes; it commits code changed outside the plan with this step and lists it here.',
    stops: { changed: 'The code changed after it was reviewed, so this is not what was reviewed: Send back so the change is reviewed.' }
  }),
  test: entry({
    decides: 'You decide if these test results are enough to trust the change: later steps rely on them.',
    yes: 'Approve keeps these results; later steps use them and do not run the tests again.',
    settles: 'SFlow runs the tests itself and keeps its own records out of the review, so they never undo your Yes.'
  }),
  review: entry({
    decides: 'You decide if the work matches what was agreed: a gap you accept goes into the pull request as a known risk.',
    yes: 'Approve keeps this review; an accepted gap is listed in the pull request.'
  }),
  release: entry({
    decides: 'You decide if the work is ready to leave the Story: SFlow then prepares the pull request.',
    yes: 'Approve marks the work ready; SFlow prepares the pull request next.'
  }),
  report: entry({
    decides: 'You decide if {step} says what happened: it is the Story\'s last word.',
    yes: 'Approve keeps this report; the Story ends when nothing else is open.'
  }),
  document: entry({
    decides: 'You decide if {step} says what it should: later steps read it as written.',
    yes: 'Approve keeps this version of {step} and starts the next step.'
  }),
  [GENERIC_INTENT]: entry({
    decides: 'You decide if {step} is right as it is: later steps build on it.',
    yes: 'Approve keeps this version of {step} and starts the next step.'
  })
});

/** Every intent the table answers for: the ten step intents and the generic one. */
export const ADVICE_INTENTS = Object.freeze([...STEP_INTENTS, GENERIC_INTENT]);

const fill = (line, step) => line.replaceAll('{step}', step);
export const shipped = (phaseId) => (Object.hasOwn(PACKAGED_STEP_INTENTS, phaseId ?? '') ? PACKAGED_STEP_INTENTS[phaseId] : null);

/** The advice for an intent with `{step}` filled; an unknown intent gets the generic lines. */
export function stepAdvice(intent, { step = 'this step' } = {}) {
  const key = Object.hasOwn(STEP_ADVICE, intent) ? intent : GENERIC_INTENT;
  const lines = STEP_ADVICE[key];
  return {
    intent: key,
    ...Object.fromEntries(ADVICE_FIELDS.filter((field) => field !== 'stops').map((field) => [field, fill(lines[field], step)])),
    stops: Object.fromEntries(STOP_KINDS.map((kind) => [kind, fill(lines.stops[kind], step)]))
  };
}

/** One stop's way forward for a step, filled. */
export function stopAdvice(intent, kind, { step = 'this step' } = {}) {
  return stepAdvice(intent, { step }).stops[kind] ?? null;
}

export const resolvedPhase = (workflow, phaseId) => (workflow?.resolution?.phases ?? []).find((phase) => phase?.id === phaseId) ?? null;
export const declaredIntent = (workflow, phaseId) => {
  const intent = resolvedPhase(workflow, phaseId)?.intent ?? workflow?.phases?.[phaseId]?.intent ?? null;
  return STEP_INTENTS.includes(intent) ? intent : null;
};

/**
 * A step's intent from what is known without inference: the intent it names, else the one SFlow ships for its ID, else
 * `inferred` (step-advice-intent.mjs storyStepIntent's answer), else the generic one.
 */
export function stepIntentOf(workflow, phaseId, inferred = null) {
  return declaredIntent(workflow, phaseId) ?? shipped(phaseId) ?? (STEP_INTENTS.includes(inferred) ? inferred : GENERIC_INTENT);
}

/** The advice for one step of a Story, filled with its name; `intent` is storyStepIntent's answer when a caller has it. */
export function adviceForStep(workflow, phaseId, intent = null) {
  const step = workflow?.phases?.[phaseId]?.label ?? phaseId ?? 'this step';
  return stepAdvice(intent ?? stepIntentOf(workflow, phaseId), { step });
}
