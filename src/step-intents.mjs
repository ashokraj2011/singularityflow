/**
 * Step intents (spec "SFlow step intents", owner-approved 2026-11-20): what each workflow step is for, the one
 * profile of framework settings each intent gives, the workflow rules that depend on the other steps, and how SFlow
 * tells a step's intent from its structure when the step declares none.
 *
 * - INTENT_PROFILES holds every published profile version as data. A published version never changes
 *   (test/step-intents.test.mjs locks each one by its hash); an improvement is a new version.
 * - deriveStepSettings(intent, context) is what one step's intent gives in its workflow; workflowIntentFacts holds
 *   the workflow rules (spec §5) it reads: who writes the requirement IDs, which step plans each code step, which
 *   steps a person approves, which step asks every time.
 * - inferStepIntents tells each step's intent from its structure first, then its position, words and agent (§6.1),
 *   with how sure it is: certain, likely or unclear.
 *
 * Stage 0 and 1: nothing in the engine derives a setting from these yet. A Story's resolution (config.mjs
 * resolveWorkType) is unchanged; `workflow check` shows the inferred intents, and a test compares what the shipped
 * workflows would derive with what they have today (test/step-intents-comparison.test.mjs).
 *
 * Pure: no file, process or clock is read, and it imports only the import-free phase-roles.mjs, so Workflow Studio's
 * page can run the same derivation (spec §6.4).
 */
import { BECAUSE_SETTINGS, STEP_INTENTS } from './phase-roles.mjs';

export { BECAUSE_SETTINGS, STEP_INTENTS };

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

/**
 * The intent of each step SFlow ships (templates/workflow.yml), by step ID: spec §4.3 and Appendix B. A step that is
 * an exact shipped revision (packaged-workflow-history.mjs) has this intent for certain.
 */
export const PACKAGED_STEP_INTENTS = deepFreeze({
  intake: 'intake', requirements: 'requirements', design: 'design', 'implementation-spec': 'plan', implementation: 'code',
  verification: 'test', conformance: 'review',
  reproduction: 'design', 'fix-design': 'design', 'fix-spec': 'plan',
  'findings-intake': 'requirements', 'remediation-plan': 'plan',
  'design-intake': 'intake', 'design-inventory': 'design', 'component-mapping': 'design', 'mobile-spec': 'plan', 'visual-verification': 'test',
  implement: 'code', verify: 'test',
  'careful-change': 'code', 'test-run': 'test', testing: 'test', specification: 'requirements',
  'document-intake': 'intake', 'scenario-check': 'test', 'scenario-repair': 'code', 'scenario-retest': 'test',
  'demo-web-intake': 'intake', 'demo-web-check': 'test', 'demo-web-repair': 'code', 'demo-web-retest': 'test',
  'demo-intake': 'intake', 'demo-check': 'test', 'demo-repair': 'code', 'demo-close': 'report',
  'demo-instruction-intake': 'intake', 'demo-instruction-test': 'test', 'demo-instruction-repair': 'code', 'demo-instruction-close': 'report',
  'poc-lite-plan': 'plan', 'poc-lite-act': 'code', 'poc-lite-verify': 'test', 'poc-lite-finalize': 'release',
  'poc-intake': 'intake', 'poc-impact-analysis': 'design', 'poc-ui-exploration': 'design', 'poc-test-generation': 'code',
  'poc-validation': 'test', 'poc-publication-review': 'release',
  planning: 'plan', convergence: 'review', release: 'review'
});

// ---------------------------------------------------------------------------------------------
// Workflow rules (spec §5)

const indexOf = (steps, id) => steps.findIndex((step) => step.id === id);

/**
 * The workflow rules for one workflow's steps, in order. Each step is `{ id, intent, editsSource?, codeStep?,
 * builtBySflow? }`: `editsSource` is whether the step changes source files as the workflow has it, `codeStep` whether
 * it is a code step as the workflow has it (both default to: its intent is code; a kept override can differ, as
 * chore's `generation.task: analyze`), and `builtBySflow` whether SFlow builds it itself. The options name what the
 * workflow declares: `omitsScope` (it leaves the scope out), `decisionsAfter`, `loopSources`, `designCaptureStep`,
 * and `heldForPerson` (step ID → why a person approves it, from its own approval or a safety rule).
 */
export function workflowIntentFacts(steps, {
  omitsScope = false, decisionsAfter = [], loopSources = [], designCaptureStep = null, heldForPerson = {}
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
  // The plan a person approves: the planners; with none, the last document step before the first step that changes
  // source files (phase-roles.mjs planStepIds).
  let planSteps = [...new Set(Object.values(planners))];
  const firstEdit = steps.findIndex(edits);
  if (!planSteps.length && firstEdit > 0) {
    const pick = steps.slice(0, firstEdit).filter((step) => DOCUMENT_INTENTS.includes(step.intent)).at(-1);
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
  const kind = writesRequirementIds && entry.kindWhenWritingRequirementIds ? entry.kindWhenWritingRequirementIds
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
    const code = steps.slice(0, index).findLastIndex((candidate) => candidate.intent === 'code');
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
// Inference (spec §6.1)

const INTAKE_KINDS = new Set(['intake', 'design-intake', 'poc-intake']);
const DESIGN_KINDS = new Set(['design', 'reproduction', 'fix-design', 'impact-analysis', 'ui-exploration-evidence', 'design-inventory', 'component-mapping']);
const PLAN_KINDS = new Set(['implementation-spec', 'delivery-plan', 'implementation-plan']);
const TEST_KINDS = new Set(['test-evidence', 'visual-test-evidence']);
const REVIEW_KINDS = new Set(['conformance-report', 'convergence-report']);

/** The words that lean a step to an intent, found in its ID, label, description and template headings (§6.1). */
export const INTENT_WORDS = deepFreeze({
  intake: ['intake', 'request', 'brief', 'triage', 'capture', 'ticket'],
  requirements: ['requirement', 'spec', 'specification', 'acceptance criteria', 'user story', 'prd', 'scope'],
  design: ['design', 'architecture', 'analysis', 'investigate', 'reproduce', 'research', 'explore', 'impact', 'inventory', 'mapping'],
  plan: ['plan', 'implementation spec', 'technical spec', 'fix spec', 'approach', 'task breakdown'],
  code: ['implement', 'code', 'build', 'develop', 'fix', 'repair', 'change', 'refactor', 'migrate', 'generate tests'],
  test: ['test', 'verify', 'validation', 'qa', 'check', 'retest', 'regression', 'e2e', 'scenario', 'smoke'],
  review: ['conformance', 'compliance', 'traceability', 'requirement check', 'code checking', 'audit'],
  release: ['release', 'publish', 'pr', 'pull request', 'ship', 'finalize', 'handoff'],
  report: ['report', 'summary', 'close', 'gaps', 'retrospective', 'outcome']
});

/** The agents that lean a step to intents (§6.1). An agent whose ID ends in one of these leans the same way. */
export const AGENT_LEANS = deepFreeze({
  'product-owner': ['intake', 'requirements'], architect: ['design', 'plan'], developer: ['code'], qa: ['test', 'review']
});

const tokens = (text) => String(text ?? '').toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
const commonPrefix = (left, right) => {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) length += 1;
  return length;
};
/** A word matches a token as written, as the token's start, or as the same stem (verify, verification). */
const wordMatches = (word, token) => token === word || (word.length >= 4 && token.startsWith(word))
  || (word.length >= 6 && token.length >= 6 && commonPrefix(word, token) >= Math.min(word.length, token.length) - 2);

/** Each intent's word score for `texts` ([text, weight] pairs), with the words found. Phrases count before their words. */
export function intentWordScores(texts) {
  const scores = new Map();
  for (const [text, weight] of texts) {
    const words = tokens(text);
    const used = new Array(words.length).fill(false);
    for (const [intent, list] of Object.entries(INTENT_WORDS)) {
      for (const phrase of list.filter((entry) => entry.includes(' '))) {
        const parts = phrase.split(' ');
        for (let start = 0; start + parts.length <= words.length; start += 1) {
          if (parts.every((part, offset) => !used[start + offset] && wordMatches(part, words[start + offset]))) {
            for (let offset = 0; offset < parts.length; offset += 1) used[start + offset] = true;
            const entry = scores.get(intent) ?? { score: 0, words: [] };
            entry.score += weight * 2;
            if (!entry.words.includes(phrase)) entry.words.push(phrase);
            scores.set(intent, entry);
          }
        }
      }
    }
    words.forEach((token, position) => {
      if (used[position]) return;
      for (const [intent, list] of Object.entries(INTENT_WORDS)) {
        const word = list.find((entry) => !entry.includes(' ') && wordMatches(entry, token));
        if (!word) continue;
        const entry = scores.get(intent) ?? { score: 0, words: [] };
        entry.score += weight;
        if (!entry.words.includes(token)) entry.words.push(token);
        scores.set(intent, entry);
      }
    });
  }
  return scores;
}

const agentLeans = (agent) => {
  const id = String(agent ?? '').toLowerCase();
  const key = Object.keys(AGENT_LEANS).find((name) => id === name || id.endsWith(`-${name}`));
  return key ? [...AGENT_LEANS[key]] : [];
};

const certain = (intent, why, source = 'structure') => ({ intent, confidence: 'certain', source, why });
const likely = (intent, why, source = 'structure') => ({ intent, confidence: 'likely', source, why });

/** The structural signals of §6.1, in its order; null when the step has none. */
function structuralIntent(step, index, steps, planners) {
  const kind = step.kind ?? null;
  const task = step.task ?? null;
  const intakeLike = (candidate, position) => INTAKE_KINDS.has(candidate.kind) || (candidate.task === 'clarify' && position === 0);
  if (task === 'code' || (kind === 'implementation-summary' && task == null)) {
    return certain('code', task === 'code' ? 'its generation task is code' : 'its output kind is implementation-summary');
  }
  if (TEST_KINDS.has(kind)) return certain('test', `its output kind is ${kind}`);
  if (step.testEvidenceFrom) return certain('test', `it cites ${step.testEvidenceFrom}'s test results`);
  if (step.repositoryTests === 'run') return certain('test', 'it runs the repository\'s tests');
  if (REVIEW_KINDS.has(kind)) return certain('review', `its output kind is ${kind}`);
  if (PLAN_KINDS.has(kind)) return certain('plan', `its output kind is ${kind}`);
  if (planners.has(step.id)) return certain('plan', 'the workflow names it as the plan of a code step');
  if (kind === 'requirements') {
    const otherIntake = steps.some((candidate, position) => position !== index && intakeLike(candidate, position));
    return index === 0 && !otherIntake ? certain('intake', 'it is the first step and writes the requirements')
      : certain('requirements', 'its output kind is requirements');
  }
  if (intakeLike(step, index)) return certain('intake', INTAKE_KINDS.has(kind) ? `its output kind is ${kind}` : 'it is the first step and asks questions');
  if (DESIGN_KINDS.has(kind)) return certain('design', `its output kind is ${kind}`);
  if (kind === 'publication-review') {
    const words = intentWordScores(stepTexts(step)).get('report');
    return task === 'summarize' && words ? likely('report', 'its output is a publication review that summarizes')
      : likely('release', 'its output kind is publication-review');
  }
  if (step.writeScope === 'source-and-artifact' && task !== 'code' && intentWordScores(stepTexts(step)).has('test')) {
    return { ...likely('test', 'it may change source files and its words say test'), changesSourceKept: true };
  }
  return null;
}

function stepTexts(step) {
  return [[step.id, 2], [step.label, 2], [step.description, 1], ...(step.headings ?? []).map((heading) => [heading, 1])];
}

const POSITION_WORDS = Object.freeze({
  first: 'it is the first step',
  'before-code': 'it comes right before the first code step',
  'after-code': 'it comes after the last code step',
  'last-code-free': 'it is the last step of a workflow that changes no code'
});

/** Which intents a step's place leans to, given the steps known to be code (§6.1 position signals). */
function positionLeans(index, steps, codeIndexes) {
  const leans = [];
  if (index === 0) leans.push(['first', ['intake']]);
  if (codeIndexes.length && index === Math.min(...codeIndexes) - 1) leans.push(['before-code', ['plan']]);
  if (codeIndexes.length && index > Math.max(...codeIndexes)) leans.push(['after-code', ['test', 'review', 'release', 'report']]);
  if (!codeIndexes.length && index === steps.length - 1 && index > 0) leans.push(['last-code-free', ['report']]);
  return leans;
}

const quote = (words) => words.slice(0, 3).map((word) => `"${word}"`).join(', ');

/**
 * Each step's intent and how sure SFlow is, in workflow order: `{ step, intent, confidence, source, why }`, where
 * confidence is certain, likely or unclear and source is declared, shipped, structure, words, position or agent.
 *
 * `steps` are `{ id, label?, description?, headings?, agent?, declared?, shipped?, kind?, task?, writeScope?,
 * testEvidenceFrom?, repositoryTests? }` as the workflow resolves them: `declared` is the step's own `intent:`,
 * `shipped` the packaged intent of an exact shipped revision. `planOwners` names the steps the workflow's planned
 * claims make the plan of a code step. A declared intent that differs from the structure keeps what the structure
 * says under `inferred`.
 */
export function inferStepIntents(steps, { planOwners = [] } = {}) {
  const planners = new Set(planOwners);
  const fromStructure = steps.map((step, index) => (step.shipped && STEP_INTENTS.includes(step.shipped)
    ? certain(step.shipped, 'a step SFlow ships', 'shipped')
    : structuralIntent(step, index, steps, planners)));
  const known = steps.map((step, index) => (STEP_INTENTS.includes(step.declared) ? step.declared : fromStructure[index]?.intent ?? null));
  const codeIndexes = known.flatMap((intent, index) => (intent === 'code' ? [index] : []));
  return steps.map((step, index) => {
    let inferred = fromStructure[index];
    if (!inferred) {
      const scores = intentWordScores(stepTexts(step));
      const leans = positionLeans(index, steps, codeIndexes);
      const placed = new Set(leans.flatMap(([, intents]) => intents));
      const agent = agentLeans(step.agent);
      const best = Math.max(0, ...[...scores.values()].map((entry) => entry.score));
      const top = STEP_INTENTS.filter((intent) => scores.get(intent)?.score === best && best > 0);
      const rank = (candidates) => [...candidates].sort((left, right) => Number(placed.has(right)) - Number(placed.has(left))
        || Number(agent.includes(right)) - Number(agent.includes(left)) || STEP_INTENTS.indexOf(left) - STEP_INTENTS.indexOf(right));
      const where = (intent) => leans.filter(([, intents]) => intents.includes(intent)).map(([key]) => POSITION_WORDS[key]).join(' and ');
      const agreed = top.filter((intent) => placed.has(intent));
      if (agreed.length) {
        const intent = rank(agreed)[0];
        inferred = { intent, confidence: 'likely', source: 'words', why: `its words say ${quote(scores.get(intent).words)}, and ${where(intent)}` };
      } else if (top.length) {
        const intent = rank(top)[0];
        inferred = { intent, confidence: 'unclear', source: 'words', why: `its words say ${quote(scores.get(intent).words)}, but nothing else agrees` };
      } else {
        const candidates = rank([...placed].filter((intent) => agent.includes(intent)));
        const intent = candidates[0] ?? rank([...placed])[0] ?? rank(agent)[0] ?? 'document';
        const why = placed.has(intent) ? `only its place: ${where(intent)}`
          : agent.includes(intent) ? `only its agent, ${step.agent}` : 'nothing in it says what it is for';
        inferred = { intent, confidence: 'unclear', source: placed.has(intent) ? 'position' : agent.includes(intent) ? 'agent' : 'none', why };
      }
    }
    if (STEP_INTENTS.includes(step.declared)) {
      return { step: step.id, intent: step.declared, confidence: 'certain', source: 'declared', why: 'it says so in workflow.yml',
        ...(inferred.intent !== step.declared ? { inferred: { intent: inferred.intent, confidence: inferred.confidence, source: inferred.source, why: inferred.why } } : {}) };
    }
    return { step: step.id, ...inferred };
  });
}
