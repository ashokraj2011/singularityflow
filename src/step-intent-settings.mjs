/**
 * What a work type's step intents give it as workflow.yml settings (step intents spec §5, §7.2 and §7.5; Stage 2),
 * with the profiles and workflow rules that give them (§4, §5): every published profile version as frozen data
 * (INTENT_PROFILES), what one step's intent gives in its workflow (deriveStepSettings) and the rules that depend on
 * the other steps (workflowIntentFacts). step-intents.mjs re-exports these with the inference (§6.1).
 *
 * Opt-in only. A work type derives when its workflow.yml is version 4 or later and every step it runs says what it is
 * for (`intent:`); any other work type derives nothing and resolves exactly as before (workTypeDerivesIntents).
 *
 * Two passes over the steps as the workflow has them (deriveWorkTypeSettings):
 * 1. each step's own settings merged with the workflow's override (phase-overrides.mjs), as today;
 * 2. the workflow rules read those steps (who changes source, which step is a code step, which SFlow builds), the
 *    step's intent profile fills every framework setting the step does not set itself, and the explicit settings
 *    are laid over it key by key.
 * Precedence, highest first: SFlow's safety rules, the workflow's override, the shared step's own value, the intent
 * profile with the workflow rules, then the engine's defaults. Every value says where it came from (`sources`), for
 * `workflow check --settings`.
 *
 * What a profile gives and is written here: whether the step changes source files, the kind SFlow recognises its
 * output as, whether it is a code step, its questions, whether SFlow approves it when clean, its approver group (the
 * profile's when this repository has that group, else today's first group), where a person may send it back (any
 * earlier step or itself), the repository's tests, the code step's results it cites, what it reads, and for the work
 * type the requirement IDs and plan owners, what a workflow that changes no code leaves out, and which steps take
 * attached documents. Not written: the agent (agent files map it; Stage 3 asks), the template (content; the six
 * starters the profile names come with Stage 3), the repair budget (unset already means 3 at run time), the review
 * brake (sourceReview.autoFixVersions unset already means 2) and the runtime check by kind of software (D6, once a
 * project's kind is confirmed).
 *
 * Pure: it reads only the definition it is given and imports only modules that read nothing, so Workflow Studio's
 * page can run the same derivation (Stage 3).
 */
import { mergePhaseOverride } from './phase-overrides.mjs';
import {
  automaticApprovalRefusal, BECAUSE_SETTINGS, INTENTS_FILE_VERSION, isConvergencePhase, pinnedIntentProfile, STEP_INTENTS,
  workTypeDerivesIntents
} from './phase-roles.mjs';

// The cheap gate and the pin reader live in the import-free phase-roles.mjs, so a workflow without intents never loads this.
export { BECAUSE_SETTINGS, INTENTS_FILE_VERSION, pinnedIntentProfile, STEP_INTENTS, workTypeDerivesIntents };

/** The work-type settings a work type's own `because:` may name (spec §7.3): those its steps' intents give. */
export const WORK_TYPE_BECAUSE_SETTINGS = Object.freeze(['plannedClaims', 'plannedClaims.clausePhases', 'plannedClaims.owners', 'sourceReview', 'sourceReview.skip',
  'documents', 'documents.allowedPhases']);

// ---------------------------------------------------------------------------------------------
// Profiles (spec §4), shared with step-intents.mjs, which re-exports them with the inference (§6.1)

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

/** The intents that write documents only; the others deliver or judge a change. */
export const DOCUMENT_INTENTS = Object.freeze(['intake', 'requirements', 'design', 'plan', 'document']);

const doc = (overrides) => ({
  family: 'document', changesSource: false, generationTask: null, testsAtSubmit: 'none', citesCodeTestResults: false,
  preparesCodeEnvironment: false, reviewVersions: { automatic: 2 }, repairBudget: null, ...overrides
});
const delivery = (overrides) => ({
  family: 'delivery', changesSource: false, generationTask: null, attachedDocuments: false, testsAtSubmit: 'none',
  citesCodeTestResults: false, preparesCodeEnvironment: false, reviewVersions: { automatic: 2 }, repairBudget: null, ...overrides
});
const REPAIR = { limit: 3, exit: 'a person may grant one more round' };

/**
 * Profile version 1 (spec §4.2, with the owner's decisions D1, D5 and D6 of 2026-11-20).
 *
 * Per intent: whether it changes source files, the artifact kind it is recognised as, whether it writes the
 * requirement IDs and plans code steps (settled by the workflow rules), its default agent and approver group, its
 * questions, whether SFlow or a person approves it, what it reads, whether it takes attached documents, the tests it
 * runs at submit (none, the repository's, or a code step's own and the later test steps' selections), whether it
 * cites the code step's test results, the versions after review findings, its repair limit and its starter template.
 * `workflow` holds what every step gets whatever its intent (§4.1) and the limits with their exits. The starter
 * templates other than common/intake.md, implementation.md, verification.md and conformance.md come with Stage 3.
 */
const PROFILE_V1 = {
  version: 1,
  intents: {
    intake: doc({ kind: 'intake', kindWhenWritingRequirementIds: 'requirements', writesRequirementIds: 'when-no-requirements-or-plan-step',
      plansCode: 'when-nothing-nearer', agent: 'product-owner', questions: { mode: 'required', maxQuestions: 5 },
      approval: 'sflow-when-clean', approvers: 'product-approvers', reads: 'nothing', attachedDocuments: true,
      placement: 'first, and at most one', template: 'common/intake.md' }),
    requirements: doc({ kind: 'requirements', writesRequirementIds: 'always', plansCode: 'when-nothing-nearer', agent: 'product-owner',
      questions: { mode: 'when-needed', maxQuestions: 5, requiredWhenFirstWithoutIntake: true }, approval: 'sflow-when-clean',
      approvers: 'product-approvers', reads: { intents: ['intake'] }, attachedDocuments: true, placement: 'before the plan',
      template: 'common/requirements.md' }),
    design: doc({ kind: 'design', writesRequirementIds: 'never', plansCode: 'when-no-plan-step', agent: 'architect',
      questions: { mode: 'when-needed', maxQuestions: 5 }, approval: 'sflow-when-clean', approvers: 'architecture-reviewers',
      reads: 'earlier-document-steps', attachedDocuments: true, placement: 'before the code step', template: 'common/design.md' }),
    plan: doc({ kind: 'implementation-plan', kindWhenWritingRequirementIds: 'implementation-spec', writesRequirementIds: 'when-no-requirements-step',
      plansCode: 'always', agent: 'architect', questions: { mode: 'when-needed', maxQuestions: 5 }, approval: 'person',
      approvers: 'architecture-reviewers', reads: 'earlier-document-steps', attachedDocuments: true,
      placement: 'right before the code step it plans', template: 'common/plan.md' }),
    document: doc({ kind: 'document', writesRequirementIds: 'never', plansCode: 'never', agent: null,
      questions: { mode: 'when-needed', maxQuestions: 3 }, approval: 'sflow-when-clean', approvers: null,
      reads: 'earlier-document-steps', attachedDocuments: false, placement: 'anywhere', template: 'common/document.md' }),
    code: delivery({ changesSource: true, kind: 'implementation-summary', generationTask: 'code', agent: 'developer',
      questions: { mode: 'when-needed', maxQuestions: 3 }, approval: 'person', approvers: 'engineering-reviewers',
      testsAtSubmit: 'own-and-later-test-steps', preparesCodeEnvironment: true, repairBudget: REPAIR,
      reads: { intents: ['requirements', 'design', 'plan'] }, placement: 'after the step that plans it',
      // D6: the runtime check by the kind of software the code step changes; a team may lower it to optional with a reason.
      runtimeCheck: { required: ['web', 'backend', 'job', 'cli', 'mobile'], library: 'api-compatibility', artifact: 'validation', lowerTo: 'optional', lowering: 'needs a reason' },
      template: 'common/implementation.md' }),
    test: delivery({ kind: 'test-evidence', kindWithScreenProfiles: 'visual-test-evidence', agent: 'qa',
      questions: { mode: 'when-needed', maxQuestions: 3 }, approval: 'sflow-when-clean', approvers: 'quality-reviewers',
      testsAtSubmit: 'repository', citesCodeTestResults: true, preparesCodeEnvironment: true, repairBudget: REPAIR,
      // D1: a test step changes no source; a failing test starts the code step's next version, with the failure as its
      // task, automatically, under the workflow's review brake.
      onFailure: 'code-step-next-version',
      reads: { intents: ['requirements', 'code'] }, placement: 'after a code step, or on its own', template: 'common/verification.md' }),
    review: delivery({ kind: 'conformance-report', agent: 'qa', questions: { mode: 'when-needed', maxQuestions: 3 },
      approval: 'sflow-when-clean', approvers: 'quality-reviewers', citesCodeTestResults: true,
      reads: { intents: ['requirements', 'plan', 'code', 'test'] }, placement: 'after the last code step', template: 'common/conformance.md' }),
    release: delivery({ kind: 'publication-review', agent: 'qa', questions: { mode: 'when-needed', maxQuestions: 3 },
      approval: 'sflow-when-clean', approvers: 'quality-reviewers', reads: 'all-earlier-steps', placement: 'after the last code step',
      template: 'common/release.md' }),
    report: delivery({ kind: 'report', agent: 'qa', questions: { mode: 'when-needed', maxQuestions: 3 },
      approval: 'sflow-when-clean', approvers: 'quality-reviewers', reads: 'all-earlier-steps', placement: 'anywhere after the intake, usually last',
      template: 'common/report.md' })
  },
  workflow: {
    review: 'every drafted step has an independent reviewer; a code step\'s is a code review',
    choices: 'optional choices are offered, never asked as required questions',
    sendBack: 'any earlier step, or the step itself',
    reviewBrake: { rounds: 2, setting: 'per workflow' },
    approvalFallbacks: ['a decision follows the step', 'it starts a rework loop', 'it captures design sources',
      'its approval names a required group or more than one approver', 'self-approval is off', 'the Story takes signatures',
      'the reviewer has not said ready'],
    codeFree: { leaveOut: 'implement', reason: 'This workflow changes no code', personApproves: ['the scope step', 'the last step'] },
    limits: {
      questions: 'the agent goes on and writes down its assumptions',
      reviewVersions: 'a person\'s "Start version N?"',
      repairBudget: 'a person grants one more round',
      reviewerContinuation: 'a fresh budget on the next request',
      decisionRounds: 'the decision\'s own way out'
    }
  }
};

/** Every published profile version, by number. Append only. */
export const INTENT_PROFILES = deepFreeze({ 1: PROFILE_V1 });
export const CURRENT_INTENT_PROFILE = 1;

/** A published profile version; an unknown one is refused, never guessed. */
export function intentProfile(version = CURRENT_INTENT_PROFILE) {
  const profile = INTENT_PROFILES[version];
  if (!profile) throw new RangeError(`Step intent profile ${String(version)} is not one this SFlow has (it has ${Object.keys(INTENT_PROFILES).join(', ')}).`);
  return profile;
}

// ---------------------------------------------------------------------------------------------
// Workflow rules (spec §5)

const indexOf = (steps, id) => steps.findIndex((step) => step.id === id);

/**
 * The workflow rules for one workflow's steps, in order. Each step is `{ id, intent, editsSource?, codeStep?,
 * builtBySflow?, noApproval? }`: `editsSource` is whether the step changes source files as the workflow has it,
 * `codeStep` whether it is a code step as the workflow has it (both default to: its intent is code; a kept override
 * can differ, as chore's `generation.task: analyze`), `builtBySflow` whether SFlow builds it itself, and `noApproval`
 * whether the workflow gives it `approval: none`. The options name what the workflow declares: `omitsScope` (it
 * leaves the scope out), `decisionsAfter`, `loopSources`, `designCaptureStep`, `heldForPerson` (step ID → why a
 * person approves it, from its own approval or a safety rule), and `declaredOwners`, the plan owners the workflow's
 * own planned claims name (code step → the step that plans it): the step a workflow names as a code step's plan is
 * the plan a person approves, over the rule's nearest step (precedence, §7.2).
 */
export function workflowIntentFacts(steps, {
  omitsScope = false, decisionsAfter = [], loopSources = [], designCaptureStep = null, heldForPerson = {}, declaredOwners = null
} = {}) {
  const of = (intent) => steps.filter((step) => step.intent === intent);
  const edits = (step) => (typeof step.editsSource === 'boolean' ? step.editsSource : step.intent === 'code');
  const codeSteps = steps.filter((step) => (typeof step.codeStep === 'boolean' ? step.codeStep : step.intent === 'code'));
  const hasCode = codeSteps.length > 0;
  const changesSource = steps.some(edits);
  // Who writes the requirement IDs: every requirements step; else the first plan; else the intake.
  const scopeSteps = omitsScope ? [] : of('requirements').length ? of('requirements')
    : of('plan').length ? [of('plan')[0]] : of('intake').length ? [of('intake')[0]] : [];
  const scopeIds = new Set(scopeSteps.map((step) => step.id));
  // Who plans each code step: the nearest plan before it; else the nearest design; else the step writing the IDs.
  const planners = {};
  const unplanned = [];
  for (const code of codeSteps) {
    const before = steps.slice(0, indexOf(steps, code.id)).reverse();
    const pick = before.find((step) => step.intent === 'plan') ?? before.find((step) => step.intent === 'design')
      ?? before.find((step) => scopeIds.has(step.id));
    if (pick) planners[code.id] = pick.id;
    else unplanned.push(code.id);
  }
  // The plan a person approves: the planners; with none, the last step before the first step that changes source
  // files that a person can approve, which is the rule configuration holds automatic approval to
  // (phase-roles.mjs planStepIds), so the two always name the same step.
  const named = Object.entries(declaredOwners ?? {}).filter(([code, owner]) => codeSteps.some((step) => step.id === code)
    && indexOf(steps, owner) >= 0 && indexOf(steps, owner) < indexOf(steps, code));
  let planSteps = [...new Set(Object.values({ ...planners, ...Object.fromEntries(named) }))];
  const firstEdit = steps.findIndex(edits);
  if (!planSteps.length && firstEdit > 0) {
    const pick = steps.slice(0, firstEdit).filter((step) => !step.noApproval).at(-1);
    if (pick) planSteps = [pick.id];
  }
  const intake = of('intake')[0];
  const questionStep = intake ? intake.id : steps[0] && DOCUMENT_INTENTS.includes(steps[0].intent) ? steps[0].id : null;
  return deepFreeze({
    hasCode,
    codeFree: !changesSource,
    codeSteps: codeSteps.map((step) => step.id),
    scopeSteps: [...scopeIds],
    // IDs are pinned only when the workflow has a code step (config.mjs normalizePlannedClaimsPolicy).
    requirementIdSteps: hasCode ? [...scopeIds] : [],
    planners,
    // The planners the planned claims name: none when no step writes requirement IDs, as plannedClaims has none then.
    plannedClaimOwners: hasCode && scopeIds.size ? { ...planners } : {},
    unplanned,
    planSteps,
    questionStep,
    lastStep: steps.at(-1)?.id ?? null,
    decisionsAfter: [...decisionsAfter], loopSources: [...loopSources], designCaptureStep, heldForPerson: { ...heldForPerson }
  });
}

/** The IDs of the steps before `index` that pass `test`, in workflow order. */
function earlier(steps, index, test) {
  return steps.slice(0, index).filter(test).map((step) => step.id);
}

/**
 * What one step's intent gives in its workflow: every framework setting of its profile, settled by the workflow
 * rules. `context` is `{ steps, index, profile?, facts?, screenProfiles?, ...workflowIntentFacts options }`; a lone
 * step needs none of it. A step's own overrides are not applied here: `editsSource`, `codeStep` and `builtBySflow`
 * only settle the rules that read them (who writes the IDs, the plan, citing test results, questions, attached
 * documents). Stage 2 merges overrides and the safety rules over this result (spec §7.2).
 */
export function deriveStepSettings(intent, context = {}) {
  const profile = intentProfile(context.profile ?? CURRENT_INTENT_PROFILE);
  const entry = profile.intents[intent];
  if (!entry) throw new RangeError(`'${String(intent)}' is not a step intent. Use one of: ${STEP_INTENTS.join(', ')}.`);
  const steps = context.steps ?? [{ id: context.id ?? 'step', intent }];
  const index = Number.isInteger(context.index) ? context.index : 0;
  const step = steps[index] ?? { id: 'step', intent };
  const facts = context.facts ?? workflowIntentFacts(steps, context);
  const id = step.id;
  const edits = (candidate) => (typeof candidate.editsSource === 'boolean' ? candidate.editsSource : candidate.intent === 'code');

  const writesRequirementIds = facts.requirementIdSteps.includes(id);
  // The step that defines the scope is recognised by a kind that defines clauses (requirements, implementation-spec),
  // in a workflow with no code step too: there no IDs are pinned, but its clauses are still the scope and the plan
  // (evidence/responsibilities.mjs reads the kind).
  const definesScope = facts.scopeSteps.includes(id);
  const kind = definesScope && entry.kindWhenWritingRequirementIds ? entry.kindWhenWritingRequirementIds
    : context.screenProfiles && entry.kindWithScreenProfiles ? entry.kindWithScreenProfiles : entry.kind;

  // Who approves it: the profile, then the workflow rules that hand a step to a person.
  const person = (why) => ({ by: 'person', why });
  const approval = entry.approval === 'person' ? person(intent === 'code' ? 'it changes source files' : 'it is the plan')
    : facts.planSteps.includes(id) ? person('it is the plan')
      : facts.codeFree && facts.scopeSteps.includes(id) ? person('it sets the scope of a workflow that changes no code')
        : facts.codeFree && facts.lastStep === id ? person('it is what a workflow that changes no code delivers')
          : facts.designCaptureStep === id ? person('it captures the design sources')
            : facts.loopSources.includes(id) ? person('it starts a rework loop')
              : facts.decisionsAfter.includes(id) ? person('a decision follows it')
                : facts.heldForPerson[id] ? person(facts.heldForPerson[id])
                  : { by: 'sflow-when-clean', why: `the ${intent} profile` };

  // One step asks every time; a step SFlow builds itself asks nothing.
  const clarification = step.builtBySflow ? { mode: 'off', maxQuestions: entry.questions.maxQuestions }
    : facts.questionStep === id ? { mode: 'required', maxQuestions: entry.questions.maxQuestions }
      : { mode: entry.questions.mode === 'required' ? 'when-needed' : entry.questions.mode, maxQuestions: entry.questions.maxQuestions };

  // A test or review step that changes no source cites the latest code step's committed test results, when no step
  // since has changed source; it then reads that code step too (config.mjs requires it).
  let testEvidenceFrom = null;
  if (entry.citesCodeTestResults && !edits({ ...step, intent }) && !step.builtBySflow) {
    // A code step as the workflow has it: chore's configuration change (task analyze) commits no code test results.
    const code = steps.slice(0, index).findLastIndex((candidate) => (typeof candidate.codeStep === 'boolean' ? candidate.codeStep : candidate.intent === 'code'));
    if (code >= 0 && !steps.slice(code + 1, index).some(edits)) testEvidenceFrom = steps[code].id;
  }

  const scope = new Set(facts.scopeSteps);
  const reads = entry.reads === 'nothing' ? []
    : entry.reads === 'all-earlier-steps' ? earlier(steps, index, () => true)
      : entry.reads === 'earlier-document-steps' ? earlier(steps, index, (candidate) => DOCUMENT_INTENTS.includes(candidate.intent))
        // The step that writes the requirement IDs stands for the requirements when the workflow has no requirements step.
        : earlier(steps, index, (candidate) => entry.reads.intents.includes(candidate.intent)
          || (entry.reads.intents.includes('requirements') && scope.has(candidate.id)));
  if (testEvidenceFrom && !reads.includes(testEvidenceFrom)) reads.push(testEvidenceFrom);
  const order = new Map(steps.map((candidate, position) => [candidate.id, position]));
  reads.sort((left, right) => order.get(left) - order.get(right));

  return deepFreeze({
    id, intent, intentProfile: profile.version,
    writeScope: entry.changesSource ? 'source-and-artifact' : 'artifact-only',
    artifactKind: kind,
    generationTask: entry.generationTask,
    writesRequirementIds,
    definesScope,
    plans: Object.entries(facts.planners).filter(([, planner]) => planner === id).map(([code]) => code),
    isPlan: facts.planSteps.includes(id),
    clarification,
    approval,
    approvers: entry.approvers,
    repositoryTests: entry.testsAtSubmit === 'repository' ? 'run' : 'off',
    testEvidenceFrom,
    inputs: reads,
    attachedDocuments: Boolean(entry.attachedDocuments) && !step.builtBySflow,
    defaultAgent: entry.agent,
    preparesCodeEnvironment: entry.preparesCodeEnvironment,
    reviewVersions: entry.reviewVersions,
    repairBudget: entry.repairBudget,
    template: entry.template,
    ...(entry.runtimeCheck ? { runtimeCheck: entry.runtimeCheck } : {})
  });
}

/** Every step's derived settings, with the workflow rules they share. `steps` and `options` as workflowIntentFacts. */
export function deriveWorkflowSettings(steps, options = {}) {
  const facts = workflowIntentFacts(steps, options);
  return { facts, steps: steps.map((step, index) => deriveStepSettings(step.intent, { ...options, steps, index, facts })) };
}

// ---------------------------------------------------------------------------------------------
// A work type's settings (spec §7.2)

/** The profile a version-4 workflow.yml without `intentProfiles` derives from: always the first, so it never moves. */
export const FIRST_INTENT_PROFILE = 1;

const isMapping = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const present = (value) => value !== undefined && value !== null;
const at = (value, path) => path.reduce((node, key) => (isMapping(node) && Object.hasOwn(node, key) ? node[key] : undefined), value);
const KEY_BY_KEY = new Set(['artifact', 'approval', 'generation', 'worldModel', 'comparison', 'because']);
const NESTED = Object.freeze(['artifact', 'approval', 'generation', 'clarification']);

/** The profile version this workflow.yml's work types derive from: its `intentProfiles`, the first when absent. */
export function declaredIntentProfile(definition) {
  return present(definition?.intentProfiles) ? definition.intentProfiles : FIRST_INTENT_PROFILE;
}

/** The profile versions this build has, and whether it has `version` (published profiles are append only). */
export const INTENT_PROFILE_VERSIONS = Object.freeze(Object.keys(INTENT_PROFILES).map(Number));
export const knownIntentProfile = (version) => Number.isSafeInteger(version) && Object.hasOwn(INTENT_PROFILES, String(version));

/** Each step a work type runs, with the intent it declares (null when none) and whether it is a compiled skill step. */
export function workTypeIntentSteps(definition, workType) {
  const ids = Array.isArray(workType?.phases) ? workType.phases : [];
  return ids.map((id) => {
    const step = isMapping(definition?.phases?.[id]) ? definition.phases[id] : {};
    return { id, label: typeof step.label === 'string' ? step.label : id, intent: STEP_INTENTS.includes(step.intent) ? step.intent : null,
      skill: step.kind === 'skill' };
  });
}

// ---------------------------------------------------------------------------------------------
// What a step sets itself

/** Whether only SFlow builds the step, as raw configuration says (code-delivery-policy.mjs deterministicOnlyGeneration). */
function builtBySflow(generation) {
  if (!isMapping(generation)) return false;
  if (Array.isArray(generation.allowedProducers) && generation.allowedProducers.length) {
    return generation.allowedProducers.length === 1 && generation.allowedProducers[0] === 'deterministic';
  }
  return generation.producer === 'deterministic' || generation.defaultProducer === 'deterministic';
}

/** Why the step's own approval keeps it with a person (approval-authority.mjs automaticApprovalHeldBy), or null. */
function approvalHeldBy(approval) {
  if (!isMapping(approval)) return null;
  if ((approval.minimum ?? 1) !== 1) return 'it needs more than one approver';
  if ((approval.requiredAuthorities ?? []).length) return 'a named group must approve it';
  return approval.allowSelfApproval === false ? 'this repository asks someone other than the author to approve it' : null;
}

const approvalMode = (approval) => (approval === 'none' ? 'none' : isMapping(approval) ? approval.mode ?? 'required' : typeof approval === 'string' ? approval : 'required');

/** Whether the step is a code step as written: its generation task, else kind implementation-summary; undefined when it says neither. */
function writtenCodeStep(merged) {
  const task = isMapping(merged.generation) ? merged.generation.task ?? null : null;
  if (task != null) return task === 'code';
  return merged.artifact?.kind === 'implementation-summary' ? true : undefined;
}

/** Where an explicit setting came from: the workflow's override, the shared step, or null when neither sets it. */
function explicitOrigin(written, path) {
  const [top, ...rest] = path;
  const replaced = rest.length && typeof written.merged?.[top] === 'string';
  if (!replaced && !present(at(written.merged, path))) return null;
  const override = isMapping(written.override) ? written.override : {};
  if (!Object.hasOwn(override, top) || override[top] === undefined) return 'shared-step';
  if (!rest.length || typeof override[top] === 'string' || !KEY_BY_KEY.has(top)) return 'override';
  return present(at(override, path)) ? 'override' : 'shared-step';
}

/** The reason the step or the workflow gives for a setting: its own key, else the setting it belongs to. */
function reasonFor(because, key) {
  if (!isMapping(because)) return null;
  for (let name = key; name; name = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : null) {
    if (typeof because[name] === 'string' && because[name].trim()) return because[name].trim();
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Contradictions (spec §7.5)

/** Output kinds the engine reads as a role, with the intents that may have them. Any other kind is the step's own name for its output. */
const KIND_INTENTS = Object.freeze({
  requirements: ['intake', 'requirements'],
  'implementation-spec': ['requirements', 'plan'],
  'implementation-plan': ['plan'],
  'delivery-plan': ['plan'],
  'implementation-summary': ['code'],
  'test-evidence': ['test'],
  'visual-test-evidence': ['test'],
  'conformance-report': ['review'],
  'convergence-report': ['review'],
  'publication-review': ['release', 'report']
});
/** Whether a step whose intent is `intent` may keep output kind `kind`: a kind the engine reads as another role may not. */
export const kindFitsIntent = (kind, intent) => !Object.hasOwn(KIND_INTENTS, kind) || KIND_INTENTS[kind].includes(intent);
/** The intents a step with output kind `kind` may have, or null when the kind is the step's own name for its output. */
export const intentsForKind = (kind) => (Object.hasOwn(KIND_INTENTS, kind) ? [...KIND_INTENTS[kind]] : null);
const CLAUSE_KINDS = new Set(['requirements', 'implementation-spec']);
const TEST_KINDS = new Set(['test-evidence', 'visual-test-evidence']);
const AFTER_CODE = new Set(['review', 'release', 'report']);

/** Why a workflow that changes no code leaves each responsibility out: true of any such workflow (workflow-build/engine.mjs). */
const NO_CODE_REASONS = Object.freeze({
  scope: 'This workflow works from the product as it is; it defines no new requirements.',
  plan: 'This workflow changes no code, so there is no change to plan.',
  implement: 'This workflow changes no code; a change it finds is made in a Story of its own.',
  verify: 'This workflow changes nothing in the product, so there is no change of its own to verify.'
});

// ---------------------------------------------------------------------------------------------
// Refusals configuration raises for a workflow that opts in (config.mjs throws them; built here so a workflow
// without intents loads none of their words). Each is `{ message, code, details }`.

const listed = (values) => (values.length < 2 ? values.join('') : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`);
const UPDATE = Object.freeze({ executable: 'singularity-flow', argv: ['update'], label: 'Update SFlow, then run the command again.' });
const STUDIO = (label) => ({ command: 'singularity-flow workflow studio', label });

/** A profile this build does not have: the repository's, or one a Story pinned. Refused with the update (§7.5). */
export function unknownProfileProblem(profile, { version = INTENTS_FILE_VERSION, pinned = false, running = null } = {}) {
  if (knownIntentProfile(profile)) return null;
  const said = pinned ? `This Story's workflow derives its settings from step intent profile ${profile}, which this SFlow does not have.`
    : `This repository's workflows need a newer SFlow: they derive their settings from step intent profile ${profile}, and this SFlow has `
      + `profile ${listed(INTENT_PROFILE_VERSIONS.map(String))}.`;
  return { message: `${said} Update SFlow, then run the command again. Nothing was changed.`, code: 'WORKFLOW_VERSION_NEWER',
    details: { version, intentProfiles: profile, running, nextAction: UPDATE } };
}

/**
 * `intentProfiles` as written (spec §7.1, §7.6): read only in a version 4 file; absent there it is 1, so its meaning never
 * moves with the build. Null when it is fine.
 */
export function intentProfilesProblem(definition, { running = null } = {}) {
  const value = definition?.intentProfiles;
  if (value === undefined) return null;
  const invalid = (message) => ({ message, code: 'STEP_INTENT_INVALID',
    details: { field: 'intentProfiles', nextAction: STUDIO('Fix intentProfiles in workflow.yml, or in Workflow Studio.') } });
  if (!(definition.version >= INTENTS_FILE_VERSION)) {
    return invalid(`intentProfiles is read only in a version ${INTENTS_FILE_VERSION} workflow.yml, and this one is version ${definition.version}. `
      + `Set version: ${INTENTS_FILE_VERSION} to derive step settings from intents, or remove intentProfiles.`);
  }
  if (!Number.isSafeInteger(value) || value < 1) return invalid(`intentProfiles must be a profile number, such as ${FIRST_INTENT_PROFILE}; it is ${JSON.stringify(value)}.`);
  return unknownProfileProblem(value, { version: definition.version, running });
}

/** The first contradiction of a work type's derivation, with every one in its details (§7.5); null when there is none. */
export function contradictionProblem(workTypeId, refusals) {
  const [first] = refusals ?? [];
  if (!first) return null;
  return { message: `Work type '${workTypeId}': ${first.message} ${first.fix}`, code: 'STEP_INTENT_INVALID',
    details: { workType: workTypeId, phase: first.step, field: first.field, fix: first.fix,
      problems: refusals.map(({ step, field, message, fix }) => ({ step, field, message, fix })),
      nextAction: STUDIO('Fix the step in Workflow Studio, or in workflow.yml.') } };
}

/**
 * A planned-claims contract the workflow rules could not give (§5): nothing before a code step plans it, or no step
 * writes the requirement IDs. Story start then names the two ways on, with these words, instead of the legacy ones.
 */
export function unplannedClaims(plannedClaims, derivation, labelOf) {
  if (plannedClaims?.mode !== 'migration-required' || !derivation) return plannedClaims;
  const { facts } = derivation;
  const omits = 'declare omits for scope and plan on the workflow, with the reason and the group that decides.';
  if (facts.unplanned.length) {
    const names = facts.unplanned.map(labelOf);
    return { ...plannedClaims, unplanned: [...facts.unplanned], reason: names.length === 1
      ? `Nothing before ${names[0]} plans its change. Add a short plan step before it (recommended), or let it plan its own change: ${omits}`
      : `Nothing before ${listed(names)} plans their changes. Add a short plan step before ${names[0]} (recommended), or let them plan their own changes: ${omits}` };
  }
  if (!facts.hasCode || facts.scopeSteps.length) return plannedClaims;
  const name = labelOf(facts.codeSteps[0]);
  return { ...plannedClaims, unplanned: [facts.codeSteps[0]], unscoped: true,
    reason: `No step before ${name} writes the requirements it builds. Add an intake or requirements step before it (recommended), or let it work `
      + `without requirement IDs: ${omits}` };
}

/**
 * A work type's derivation as configuration resolves it (config.mjs, behind workTypeDerivesIntents): with its profile,
 * a Story's pinned one for an amendment (§7.6), refused when this build lacks it or a step contradicts its intent
 * (§7.5). `{ derivation }` or `{ problem }`; the derivation's `pin(order)` is what each resolved step pins.
 */
export function workTypeIntents(definition, workTypeId, { intentProfile = null, groups = null, running = null } = {}) {
  const profile = intentProfile ?? declaredIntentProfile(definition);
  const unknown = unknownProfileProblem(profile, { version: definition.version, pinned: intentProfile != null, running });
  if (unknown) return { problem: unknown };
  const derivation = deriveWorkTypeSettings(definition, workTypeId, { profile, groups });
  const problem = contradictionProblem(workTypeId, derivation.refusals);
  if (problem) return { problem };
  derivation.pin = (order) => ({ intent: derivation.steps[order].intent, intentProfile: derivation.profile,
    ...(derivation.steps[order].because ? { because: structuredClone(derivation.steps[order].because) } : {}) });
  return { derivation };
}

/** Story start's refusal of such a contract, with its two ways on. */
export function unplannedStartProblem(resolved, steps) {
  const claims = resolved.plannedClaims;
  return { message: `Workflow '${resolved.id}' cannot start a Story: ${claims.reason}`, code: 'WORKFLOW_PLANNED_CLAIMS_MIGRATION_REQUIRED',
    details: { workType: resolved.id, reason: claims.reason, unplanned: [...claims.unplanned], steps,
      nextAction: STUDIO(`Add a ${claims.unscoped ? 'requirements' : 'plan'} step before it in Workflow Studio.`) } };
}

// ---------------------------------------------------------------------------------------------
// Derivation


/**
 * The settings a work type's intents give (null when it does not derive). `profile` is the profile version to derive
 * with: a Story's pinned one for an amendment, else the file's (declaredIntentProfile). `groups` are the approval
 * groups the repository registers, in order (the first is today's default).
 *
 * Returns `{ profile, facts, planSteps, steps, workType, refusals, warnings }`: each step's `settings` (the merged
 * workflow.yml settings resolveWorkType normalizes), `intent`, `because` and `sources` (setting → `{ from, reason }`,
 * from one of override, shared-step, intent, workflow-rule, safety-rule); the work type's `plannedClaims`, `omits` and
 * `allowedPhases` with their sources; `refusals` (contradictions configuration refuses, each `{ step, field, message,
 * fix }`) and `warnings` (`workflow check` shows them).
 */
export function deriveWorkTypeSettings(definition, workTypeId, { profile = null, groups = null } = {}) {
  const workType = isMapping(definition?.workTypes) && Object.hasOwn(definition.workTypes, workTypeId) ? definition.workTypes[workTypeId] : null;
  if (!workTypeDerivesIntents(definition, workType)) return null;
  const version = present(profile) ? profile : declaredIntentProfile(definition);
  const profileData = intentProfile(version);
  const ids = workType.phases;
  const registered = groups ?? (isMapping(definition.approvalAuthorities) ? Object.keys(definition.approvalAuthorities) : []);
  const overrides = isMapping(workType.phaseOverrides) ? workType.phaseOverrides : {};
  const label = (id) => (typeof definition.phases?.[id]?.label === 'string' ? definition.phases[id].label : id);

  // Pass 1: each step as the workflow writes it, before any intent.
  const written = ids.map((id) => {
    const shared = structuredClone(definition.phases[id]);
    const override = structuredClone(isMapping(overrides[id]) ? overrides[id] : {});
    return { id, intent: shared.intent, shared, override, merged: mergePhaseOverride(shared, override) };
  });

  // Pass 2: the workflow rules read the steps as overridden.
  const declaredOmits = Array.isArray(workType.omits) ? workType.omits : [];
  const factSteps = written.map(({ id, intent, merged }) => ({
    id, intent,
    ...(present(merged.writeScope) ? { editsSource: merged.writeScope === 'source-and-artifact' } : {}),
    ...(typeof writtenCodeStep(merged) === 'boolean' ? { codeStep: writtenCodeStep(merged) } : {}),
    builtBySflow: builtBySflow(merged.generation),
    noApproval: approvalMode(merged.approval) === 'none'
  }));
  const heldForPerson = Object.fromEntries(written.flatMap(({ id, merged }) => {
    if (isConvergencePhase(merged)) return [[id, 'only a person moves the Story on from convergence']];
    const held = approvalHeldBy(merged.approval);
    return held ? [[id, held]] : [];
  }));
  const designCaptureStep = isMapping(workType.designSources) ? workType.designSources.capturePhase ?? 'design-intake' : null;
  const { facts, steps: derived } = deriveWorkflowSettings(factSteps, {
    profile: version,
    omitsScope: declaredOmits.some((entry) => entry?.responsibility === 'scope'),
    decisionsAfter: (Array.isArray(workType.decisions) ? workType.decisions : []).map((entry) => entry?.after).filter(Boolean),
    loopSources: (Array.isArray(workType.reworkLoops) ? workType.reworkLoops : []).map((entry) => entry?.from).filter(Boolean),
    designCaptureStep,
    screenProfiles: (workType.verification?.profiles ?? []).length > 0,
    heldForPerson,
    declaredOwners: isMapping(workType.plannedClaims) && workType.plannedClaims.mode === 'required' && isMapping(workType.plannedClaims.owners)
      ? workType.plannedClaims.owners : null
  });

  const declaredClaims = isMapping(workType.plannedClaims) ? workType.plannedClaims : null;
  const declaredClauses = new Set(Array.isArray(declaredClaims?.clausePhases) ? declaredClaims.clausePhases : []);
  const refusals = [];
  const warnings = [];
  const refuse = (step, field, message, fix) => refusals.push({ step, field, message, fix });
  const firstCode = factSteps.findIndex((step) => (typeof step.codeStep === 'boolean' ? step.codeStep : step.intent === 'code'));

  const steps = written.map((entry, index) => {
    const { id, intent, merged } = entry;
    const d = derived[index];
    const entryProfile = profileData.intents[intent];
    const sources = {};
    const because = isMapping(merged.because) ? merged.because : null;
    const source = (key, from, reason) => { sources[key] = { from, ...(reason ? { reason } : {}) }; };
    const explicit = (key) => {
      const from = explicitOrigin(entry, key.split('.'));
      if (from) source(key, from, reasonFor(because, key));
      return from;
    };

    // What the profile and the workflow rules give, in workflow.yml's own keys.
    const patch = {};
    // Written out either way: a step that cites a code step's results must say artifact-only (config.mjs checks it).
    patch.writeScope = d.writeScope;
    // A step the workflow itself names among those writing requirement IDs (G6) is recognised as defining clauses.
    const namedClauses = !d.definesScope && declaredClauses.has(id) && entryProfile.kindWhenWritingRequirementIds;
    patch.artifact = { kind: namedClauses ? entryProfile.kindWhenWritingRequirementIds : d.artifactKind };
    if (d.generationTask) patch.generation = { task: d.generationTask };
    patch.clarification = { mode: d.clarification.mode, maxQuestions: d.clarification.maxQuestions };
    const group = entryProfile.approvers && registered.includes(entryProfile.approvers) ? entryProfile.approvers : null;
    patch.approval = { ...(group ? { authorities: [group] } : {}), rejectTo: ids.slice(0, index + 1),
      ...(d.approval.by === 'sflow-when-clean' ? { automatic: 'when-ready' } : {}) };
    if (d.repositoryTests === 'run') patch.repositoryTests = 'run';
    if (d.testEvidenceFrom && !present(merged.testEvidenceFrom)) patch.testEvidenceFrom = d.testEvidenceFrom;

    // The explicit settings over it, key by key for the nested ones; a string (approval: none) replaces the whole.
    const settings = { ...patch, ...merged };
    for (const key of NESTED) {
      const mine = merged[key];
      if (mine === undefined) { if (patch[key] === undefined) delete settings[key]; else settings[key] = patch[key]; continue; }
      settings[key] = isMapping(mine) && isMapping(patch[key]) ? { ...patch[key], ...mine } : mine;
    }
    // A step whose own kind is its intent's own (an intake's `intake`) and which defines this workflow's scope is
    // recognised as defining clauses, as if it set none: SFlow's shipped intake writes its kind out, so a repository on
    // version 2 or 3 reads it the same, and a workflow whose scope it is gets the kind the rules give (Stage 4).
    const baseKind = present(merged.artifact?.kind) && merged.artifact.kind === entryProfile.kind && d.definesScope
      && Boolean(entryProfile.kindWhenWritingRequirementIds);
    if (baseKind) settings.artifact = { ...settings.artifact, kind: entryProfile.kindWhenWritingRequirementIds };
    // `testEvidenceFrom: false` keeps a step from citing a code step's results, which its intent would have it cite
    // (an upgrade keeps a step that ran its own tests before step intents that way): it says what absent said then.
    if (settings.testEvidenceFrom === false) delete settings.testEvidenceFrom;
    if (!present(merged.inputs)) settings.inputs = [...d.inputs];
    else if (patch.testEvidenceFrom && !merged.inputs.some((input) => (isMapping(input) ? input.phase : input) === patch.testEvidenceFrom)) {
      // A step that cites a code step's results reads that step (config.mjs requires it): the rule adds it.
      settings.inputs = [...merged.inputs, patch.testEvidenceFrom];
      source('inputs', 'workflow-rule', `it cites ${label(patch.testEvidenceFrom)}'s test results, so it reads that step`);
    }

    // Where each value came from.
    const ruleKind = d.definesScope && entryProfile.kindWhenWritingRequirementIds ? 'it defines the scope, so its output is recognised as defining clauses'
      : namedClauses ? 'the workflow names it among the steps that write requirement IDs'
        : d.artifactKind !== entryProfile.kind ? 'the workflow declares screen profiles' : null;
    if (!explicit('writeScope')) source('writeScope', 'intent');
    if (baseKind) source('artifact.kind', 'workflow-rule', 'it defines the scope, so its output is recognised as defining clauses');
    else if (!explicit('artifact.kind')) source('artifact.kind', ruleKind ? 'workflow-rule' : 'intent', ruleKind);
    if (!explicit('generation.task')) source('generation.task', 'intent');
    if (!explicit('clarification.mode')) {
      if (d.clarification.mode === 'off') source('clarification.mode', 'workflow-rule', 'SFlow builds it, so nobody is asked');
      else if (facts.questionStep === id) {
        source('clarification.mode', entryProfile.questions.mode === 'required' ? 'intent' : 'workflow-rule', 'it is the one step that asks every time');
      } else if (entryProfile.questions.mode === 'required') source('clarification.mode', 'workflow-rule', 'only one step asks every time');
      else source('clarification.mode', 'intent');
    }
    if (!explicit('clarification.maxQuestions')) source('clarification.maxQuestions', 'intent');
    if (!explicit('approval.authorities')) {
      source('approval.authorities', 'intent', group ? null
        : entryProfile.approvers ? `this repository has no ${entryProfile.approvers} group, so its first group approves` : 'its first group approves');
    }
    if (!explicit('approval.rejectTo')) source('approval.rejectTo', 'intent', 'a person may send it back to any earlier step or to itself');
    if (!explicit('repositoryTests')) source('repositoryTests', 'intent');
    if (!explicit('testEvidenceFrom')) {
      const code = ids.slice(0, index).findLast((candidate, position) => (typeof factSteps[position].codeStep === 'boolean' ? factSteps[position].codeStep : factSteps[position].intent === 'code'));
      if (!entryProfile.citesCodeTestResults) source('testEvidenceFrom', 'intent');
      else if (patch.testEvidenceFrom) source('testEvidenceFrom', 'workflow-rule', `nothing since ${label(patch.testEvidenceFrom)} changed source files, so it cites its committed test results`);
      else source('testEvidenceFrom', 'workflow-rule', !code ? 'no code step comes before it'
        : factSteps[index].builtBySflow ? 'SFlow builds it, so it runs its own checks'
          : factSteps[index].editsSource ? 'it changes source files itself, so it runs the tests on its own change'
            : `a step since ${label(code)} changes source files, so it runs the tests itself`);
    }
    if (!sources.inputs && !explicit('inputs')) source('inputs', 'intent');

    // Who approves it: the step's own approval, the profile with the workflow rules, then SFlow's safety rules.
    const mode = approvalMode(settings.approval);
    // `approval: none` replaces the whole approval, so it writes no `automatic` of its own: its reason is the mode's.
    const writtenAutomatic = isMapping(merged.approval) ? explicitOrigin(entry, ['approval', 'automatic']) : null;
    if (isMapping(settings.approval) && settings.approval.automatic === 'off') delete settings.approval.automatic;
    const derivedAutomatic = !writtenAutomatic && isMapping(settings.approval) && settings.approval.automatic === 'when-ready';
    let held = null;
    if (derivedAutomatic) {
      held = mode !== 'required' ? `its approval is ${mode === 'none' ? 'none' : 'a policy'}`
        : (settings.writeScope ?? 'artifact-only') === 'source-and-artifact' ? 'it changes source files, so a person approves it'
          : automaticApprovalRefusal({ ...settings, id }, { workType, phases: [], planSteps: facts.planSteps });
      if (held) delete settings.approval.automatic;
    }
    if (writtenAutomatic) source('approval', writtenAutomatic, reasonFor(because, 'approval.automatic'));
    else if (mode !== 'required' && explicitOrigin(entry, ['approval', 'mode'])) source('approval', explicitOrigin(entry, ['approval', 'mode']), reasonFor(because, 'approval.mode'));
    else if (held) source('approval', 'safety-rule', held);
    else if (d.approval.by === 'person' && entryProfile.approval === 'person') source('approval', 'intent', d.approval.why);
    else if (d.approval.by === 'person') source('approval', 'workflow-rule', d.approval.why);
    else source('approval', 'intent');

    // Contradictions: settings that say the step is something its intent is not (spec §7.5).
    const name = label(id);
    const kind = settings.artifact?.kind ?? null;
    const kindWritten = present(merged.artifact?.kind) && !baseKind;
    if (intent === 'code' && present(merged.writeScope) && merged.writeScope !== 'source-and-artifact') {
      refuse(id, 'writeScope', `${name} is a code step (intent code), so it changes source files, but it sets writeScope ${merged.writeScope}.`,
        `Remove writeScope from ${name}, or set its intent to test, document or report if it changes no code.`);
    } else if (intent !== 'code' && writtenCodeStep(merged) === true) {
      const field = isMapping(merged.generation) && merged.generation.task === 'code' ? 'generation.task' : 'artifact.kind';
      refuse(id, field, `${name} is a ${intent} step, but its ${field === 'generation.task' ? 'generation task is code' : 'output kind is implementation-summary'}, which makes it a code step.`,
        `Set ${name}'s intent to code, or remove ${field} from it.`);
    } else if (kindWritten && Object.hasOwn(KIND_INTENTS, kind) && !KIND_INTENTS[kind].includes(intent)) {
      refuse(id, 'artifact.kind', `${name} is a ${intent} step, but its output kind ${kind} is what a ${KIND_INTENTS[kind].join(' or ')} step writes.`,
        `Remove artifact.kind from ${name}: its intent decides what SFlow recognises its output as. Or set its intent to ${KIND_INTENTS[kind][0]}.`);
    } else if (kindWritten && d.definesScope && !CLAUSE_KINDS.has(kind)) {
      refuse(id, 'artifact.kind', `${name} defines this workflow's requirements, so SFlow recognises its output as requirements, but it sets output kind ${kind}.`,
        `Remove artifact.kind from ${name}, or set it to requirements.`);
    } else if (kindWritten && intent === 'test' && !TEST_KINDS.has(kind)) {
      refuse(id, 'artifact.kind', `${name} is a test step, so SFlow recognises its output as test results (test-evidence), but it sets output kind ${kind}.`,
        `Remove artifact.kind from ${name}, or set it to test-evidence.`);
    }
    if (intent === 'intake' && index > 0) {
      const first = written.findIndex((candidate) => candidate.intent === 'intake');
      refuse(id, 'intent', first < index ? `${name} is a second intake: ${label(written[first].id)} already captures the request, and a workflow has at most one.`
        : `${name} is the intake, so it comes first, but it is step ${index + 1}.`,
      first < index ? `Set ${name}'s intent to requirements if it defines the acceptance criteria, otherwise document.`
        : `Move ${name} to the start of the workflow, or set its intent to requirements or document.`);
    }
    // A test step with approval none is refused only when its results can reach the end without a review: the
    // obligation graph's OBLIGATION_VERIFY_WITHOUT_REVIEW, as for any workflow (a step SFlow builds, such as
    // poc-lite's check, is reviewed by a later step). Its approval none is an override that says why.

    // Warnings: a review before any code, and framework settings changed with no reason.
    if (firstCode >= 0 && AFTER_CODE.has(intent) && index < firstCode) {
      warnings.push({ step: id, code: 'CHECK_INTENT_BEFORE_CODE', title: `${name} is a ${intent} step before any code step`,
        detail: `A ${intent} step works on the delivered change, which no step before ${label(ids[firstCode])} has made yet.`,
        fix: `Move ${name} after ${label(ids[firstCode])}, or set its intent to design or document.` });
    } else if (facts.codeFree && intent === 'review') {
      // §5: a review checks a delivered change against the requirements; a workflow that changes no code reports instead.
      // A workflow whose only change is not a code step (chore's configuration change) still delivers one to review.
      warnings.push({ step: id, code: 'CHECK_INTENT_BEFORE_CODE', title: `${name} is a review step, but this workflow changes no code`,
        detail: `A review step checks a delivered change against every requirement, and no step of this workflow changes code.`,
        fix: `Set ${name}'s intent to report: it then writes what the workflow found for people to read.` });
    }
    for (const key of changedFrameworkSettings(entry, settings, d, { intent })) {
      if (reasonFor(because, key)) continue;
      warnings.push({ step: id, setting: key, code: 'CHECK_INTENT_OVERRIDE_WITHOUT_REASON', title: `${name} sets ${key} itself, with no reason`,
        detail: `${name}'s intent (${intent}) gives ${key} a different value. A setting a step changes from its intent says why, so the next person knows it is meant.`,
        fix: `Say why under because on ${name} (for example because: { ${key}: "Why this step differs from its intent." }, 20 to 1000 characters), or remove ${key} so its intent decides it.` });
    }
    return { id, intent, settings, because, sources, derived: d };
  });

  // The work type: requirement IDs and plan owners, what a code-free workflow leaves out, attached documents.
  const workTypeSources = {};
  const workTypeBecause = isMapping(workType.because) ? workType.because : null;
  const derivedClaims = facts.hasCode && facts.requirementIdSteps.length && !facts.unplanned.length
    ? { mode: 'required', clausePhases: [...facts.requirementIdSteps], owners: { ...facts.plannedClaimOwners } } : null;
  const plannedClaims = !declaredClaims ? derivedClaims ?? undefined
    : declaredClaims.mode === 'required' && derivedClaims ? { ...derivedClaims, ...declaredClaims } : declaredClaims;
  for (const key of ['clausePhases', 'owners']) {
    workTypeSources[`plannedClaims.${key}`] = declaredClaims && Object.hasOwn(declaredClaims, key)
      ? { from: 'override', ...(reasonFor(workTypeBecause, `plannedClaims.${key}`) ? { reason: reasonFor(workTypeBecause, `plannedClaims.${key}`) } : {}) }
      : { from: 'workflow-rule', reason: key === 'clausePhases' ? 'every requirements step writes them; with none, the first plan; with no plan, the intake'
        : 'the nearest plan before each code step; otherwise the nearest design; otherwise the step that writes the IDs' };
  }
  if (declaredClaims && derivedClaims && !reasonFor(workTypeBecause, 'plannedClaims')
      && ['clausePhases', 'owners'].some((key) => Object.hasOwn(declaredClaims, key) && JSON.stringify(declaredClaims[key]) !== JSON.stringify(derivedClaims[key]))) {
    warnings.push({ step: null, setting: 'plannedClaims', code: 'CHECK_INTENT_OVERRIDE_WITHOUT_REASON', title: 'The workflow sets its requirement IDs or plan owners itself, with no reason',
      detail: 'Its steps\' intents give other requirement-ID steps or plan owners. A setting a workflow changes from its intents says why.',
      fix: 'Say why under because on the workflow (because: { plannedClaims: "Why the IDs or plans differ." }, 20 to 1000 characters), or remove plannedClaims so its intents decide it.' });
  }
  if (isMapping(workType.sourceReview) && (workType.sourceReview.skip ?? []).length && !reasonFor(workTypeBecause, 'sourceReview.skip')) {
    warnings.push({ step: null, setting: 'sourceReview.skip', code: 'CHECK_INTENT_OVERRIDE_WITHOUT_REASON', title: 'The workflow leaves steps without their independent review, with no reason',
      detail: 'Every drafted step is reviewed whatever its intent. A workflow that skips a step\'s review says why.',
      fix: 'Say why under because on the workflow (because: { sourceReview: "Why these steps need no review." }, 20 to 1000 characters), or remove sourceReview.skip.' });
  }

  const omitted = new Set(declaredOmits.map((entry) => entry?.responsibility));
  const omits = [...declaredOmits];
  const omitSources = declaredOmits.map((entry) => ({ responsibility: entry?.responsibility, from: 'override' }));
  if (facts.codeFree) {
    const last = steps.at(-1);
    const authority = Array.isArray(last?.settings.approval?.authorities) && last.settings.approval.authorities.length
      ? last.settings.approval.authorities[0] : registered[0] ?? null;
    const held = {
      scope: facts.scopeSteps.length > 0,
      plan: facts.scopeSteps.length > 0 || steps.some((step) => step.intent === 'plan'),
      implement: false,
      verify: steps.some((step) => TEST_KINDS.has(step.settings.artifact?.kind) || present(step.settings.testEvidenceFrom))
    };
    for (const responsibility of ['scope', 'plan', 'implement', 'verify']) {
      if (held[responsibility] || omitted.has(responsibility)) continue;
      omits.push({ responsibility, reason: NO_CODE_REASONS[responsibility], authority });
      omitSources.push({ responsibility, from: 'workflow-rule', reason: 'this workflow changes no code' });
    }
  }
  const ownDocuments = Array.isArray(workType.documents?.allowedPhases);
  const allowedPhases = ownDocuments ? [...workType.documents.allowedPhases]
    : steps.filter((step) => step.derived.attachedDocuments).map((step) => step.id);
  const documentsReason = reasonFor(workTypeBecause, 'documents.allowedPhases');
  workTypeSources['documents.allowedPhases'] = ownDocuments ? { from: 'override', ...(documentsReason ? { reason: documentsReason } : {}) } : { from: 'intent' };

  return {
    profile: version, facts, planSteps: [...facts.planSteps], steps,
    workType: { plannedClaims, omits, allowedPhases, sources: workTypeSources, omitSources },
    refusals, warnings
  };
}

/**
 * The framework settings (BECAUSE_SETTINGS) a step sets itself to something its intent does not give: each needs a
 * reason. The output kind is not one: a kind the engine reads as another role is refused, and any other kind is the
 * step's own name for its output.
 */
function changedFrameworkSettings(entry, settings, derived, { intent }) {
  const { merged } = entry;
  const changed = [];
  const written = (path) => explicitOrigin(entry, path) != null;
  const modeOf = (value) => (typeof value === 'string' ? value : value?.mode ?? 'off');
  if (written(['writeScope']) && merged.writeScope !== derived.writeScope) changed.push('writeScope');
  if (written(['sourceBoundary']) && merged.sourceBoundary !== 'unrestricted') changed.push('sourceBoundary');
  const task = isMapping(merged.generation) ? merged.generation.task ?? null : null;
  if (task != null && (task === 'code') !== (intent === 'code')) changed.push('generation.task');
  if (builtBySflow(merged.generation)) changed.push('generation.producer');
  const requirement = isMapping(merged.generation) ? merged.generation.requirement ?? merged.generation.mode : typeof merged.generation === 'string' ? merged.generation : null;
  if (requirement === 'none') changed.push('generation.requirement');
  if (written(['clarification', 'mode']) && modeOf(settings.clarification) !== derived.clarification.mode) changed.push('clarification.mode');
  const mode = approvalMode(merged.approval);
  if (mode !== 'required') changed.push('approval.mode');
  else if (written(['approval', 'automatic'])
      && (merged.approval.automatic === 'when-ready') !== (derived.approval.by === 'sflow-when-clean')) changed.push('approval.automatic');
  // Send-back targets need no reason: the intent lets a person send work back to any earlier step or to the step
  // itself, the widest set, so a workflow that names fewer only narrows a person's choice (a shipped step's own list is
  // narrower than the steps before it in most workflows that use it, and a Workflow Studio copy keeps that list); one
  // beyond it, a later step or one the workflow lacks, is configuration's own refusal (WORKFLOW_REJECTION_TARGET).
  if (written(['repositoryTests']) && merged.repositoryTests !== derived.repositoryTests) changed.push('repositoryTests');
  if (written(['testEvidenceFrom']) && (merged.testEvidenceFrom === false ? null : merged.testEvidenceFrom) !== derived.testEvidenceFrom) changed.push('testEvidenceFrom');
  if (written(['testRuns']) && merged.testRuns === 'fresh') changed.push('testRuns');
  if (written(['repairBudget'])) changed.push('repairBudget');
  return changed;
}
