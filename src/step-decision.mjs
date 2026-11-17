/**
 * SPEC-OSA v1.1 Stage 3: the kernel's decision for every surface [OSA:REQ-020, REQ-021]. The adapter side of the kernel
 * (`stepSnapshotOf`, from the Story record a caller already holds) and the host's one rendering of the decision
 * (`decisionRoutes`). The edit guard, the entry, the authoring task, sequence guidance, the guide and next steps, the
 * review continuation, submission readiness, phase show and the session's task all take a step's primary action from
 * here, so the same basis gives the same action wherever a person or an agent reads it.
 *
 * Small on purpose: no file, Git or process access, so a planner that imports it loads no path checks or writers.
 */
import { versionFactsOf } from './phase-generation-need.mjs';
import { stepState } from './kernel/step-state.mjs';
import { pendingIntentAmendmentAcknowledgement, sourceReviewRequired } from './source-review-policy.mjs';
import { phaseKernelOwned, phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { intentAmendmentPause } from './intent-amendment-pause.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { submitRoute } from './action-command-map.mjs';
import { ACTION_SKILLS, actionCommand, actionSkill } from './action-command-map.mjs';

export { WORK_COMMANDS, isWorkCommand } from './command-skills.mjs';

// ------------------------------------------------------------------------------------ the action-to-command map

// SPEC-OSA v1.1 §10: the one versioned action-to-command map lives in action-command-map.mjs (pure, no kernel), so the
// review delegation and every renderer read its Shell forms and skills without loading the reducer. Rendered here as routes.
export { ACTION_COMMAND_MAP_VERSION, ACTION_MODEL_FREE, ACTION_SKILLS, ACTION_COMMANDS, actionCommand, actionCommandLine, actionSkill, workCommandOf } from './action-command-map.mjs';

/**
 * One form of an operation's Shell command as a route with the skill the host shows for it: the only way a route's command
 * is built [OSA:REQ-021]. A form that keeps a placeholder for the person is shown as written; null for a form the map does
 * not name.
 */
export function actionRoute(operation, form, { step, workId, detail, skill = null }) {
  const words = actionCommand(operation, form, { step, workId });
  if (!words) return null;
  if (/(?:^| )<[a-z-]+>(?: |$)/u.test(words)) return commandRoute(`singularity-flow ${words}`, detail, skill);
  return route(words.split(' '), detail, skill);
}

function route(argv, detail, skill = null) {
  const guidance = safeCommandGuidance({ argv, ...(skill ? { skill } : {}) });
  return { detail, ...guidance, commandGuidance: guidance,
    modelFreeStatus: guidance?.modelFreeCommand ? 'available' : 'unavailable' };
}

/** One Shell command as a route, with the skill the host shows for it. */
function commandRoute(command, detail, skill = null) {
  const guidance = safeCommandGuidance({ command, ...(skill ? { skill } : {}) });
  return guidance ? { detail, ...guidance, commandGuidance: guidance, modelFreeStatus: guidance.modelFreeCommand ? 'available' : 'unavailable' } : null;
}

/** Only the step's own configuration decides what it may change: no producer but the kernel builds no files (P-9). */
export const onlyDeterministic = (phase) => phase?.generationPolicy?.allowedProducers?.length === 1 && phase.generationPolicy.allowedProducers[0] === 'deterministic';
/** Who builds the step (the entry's phaseKernelOwned); a policy that contradicts itself is classified by its producers alone. */
function executionOwner(phase) {
  try { return phaseKernelOwned(phase) ? 'kernel' : 'agent'; } catch { return onlyDeterministic(phase) && !phaseRequiresCodeDelivery(phase) ? 'kernel' : 'agent'; }
}

/**
 * A retained review as the kernel reads it [OSA:REQ-004]: `ready`, `correction-required` when its blocking findings ask
 * the author for corrections, `disposition-required` when only a person's decision is left, otherwise `pending`. Null
 * when the caller read no review, so the decision says the review is unavailable, never that it is absent.
 */
export function reviewFactOf(phase, review) {
  if (!phase || !review) return null;
  const blocking = (review.findings ?? []).some((finding) => finding?.code !== 'human-disposition-required');
  const status = review.status === 'ready' ? 'ready'
    : review.status === 'correction-required' && blocking ? 'correction-required'
      : review.pendingDispositions?.length || review.status === 'correction-required' ? 'disposition-required' : 'pending';
  const version = Number.isSafeInteger(review.generation) ? review.generation : null;
  return { phaseId: phase.id, status, version };
}

const ACKNOWLEDGEMENT = 'INTENT_AMENDMENT_ACKNOWLEDGEMENT_REQUIRED';

/**
 * `StepSnapshot/v1` from the Story record the caller already loaded: the adapter side of the kernel [OSA:REQ-040, REQ-041].
 * No Git, history walk or review record is read here, so the entry's permission and the edit guard decide on one basis.
 * Sources the caller did not read are `unavailable`, never empty or allowed [OSA:REQ-004]; the review status is one of them.
 * `task`: the step's durable task outcome as the caller read it (workflow-task-outcome.mjs), or null.
 */
export function stepSnapshotOf({ workflow, phase = workflow?.phases?.[workflow?.currentPhase], turnMode = 'authoring', sources = {},
  review = null, revoked = false, basis = {}, opening = null, task = null, reviewOwed = false } = {}) {
  // What this checkout observed of an operation's opening (story-version-acceptance.mjs): its shared acceptance and writer.
  const observed = (step, version) => version.opening?.record === 'operation' && step.id === phase?.id && opening
    ? { ...version, opening: { ...version.opening, acceptance: opening.acceptance, writer: opening.writer } } : version;
  const acknowledgement = pendingIntentAmendmentAcknowledgement(workflow);
  const facts = (step) => step ? { id: step.id, ...observed(step, versionFactsOf(workflow, step)),
    kind: { executionOwner: executionOwner(step), code: phaseRequiresCodeDelivery(step),
      changeCapabilities: [...(onlyDeterministic(step) ? [] : ['step-artifacts']),
        ...(step.writeScope === 'source-and-artifact' && (!onlyDeterministic(step) || phaseRequiresCodeDelivery(step)) ? ['application'] : [])] },
    pause: intentAmendmentPause(workflow, step.id) ? { id: intentAmendmentPause(workflow, step.id).id } : null,
    // An approved amendment is acknowledged before what the engine refuses until then (owner, 2026-11-17).
    holds: acknowledgement ? [{ code: ACKNOWLEDGEMENT, owner: 'person', id: acknowledgement.id,
      blocks: ['opening', 'publication', 'submission'], resolution: 'decide' }] : [],
    // A review the caller read for this step is owed by it, whatever its policy says now (a retained review stands).
    review: { required: sourceReviewRequired(workflow, step.id) || (reviewOwed && review?.phaseId === step.id), status: review?.phaseId === step.id ? review.status : 'unavailable',
      version: review?.phaseId === step.id ? review.version ?? null : null }, damage: null,
    ...(task && step.id === phase?.id ? { task } : {}) } : null;
  const currentPhaseId = workflow?.currentPhase ?? null;
  return { schemaVersion: 1, record: { family: 'story-workflow', version: Number(workflow?.schemaVersion ?? 1) },
    subject: { projectId: null, workId: workflow?.workItem?.id ?? null, requestedPhaseId: phase?.id ?? null, currentPhaseId },
    basis, sources: { lifecycle: { status: 'verified' }, configuration: { status: 'verified' }, review: { status: review ? 'verified' : 'unavailable' }, ...sources },
    // The working record against the accepted one is not compared here (no Git per tool call): unknown, never "same".
    differences: [{ field: 'lifecycle-record', state: 'unknown' }],
    // The record's step order; a record that names none is read in its steps' own order.
    story: { status: workflow?.status === 'cancelled' ? 'cancelled' : currentPhaseId ? 'active' : 'complete',
      phaseOrder: workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {}),
      pendingDecision: workflow?.pendingDecision ? { id: workflow.pendingDecision.key ?? null } : null },
    step: facts(phase), current: phase && phase.id !== currentPhaseId ? facts(workflow?.phases?.[currentPhaseId]) : null,
    actor: { principalKind: 'agent', role: turnMode === 'read-only-review' ? 'reviewer' : 'author', turnMode, permissionsRevoked: revoked === true } };
}

/**
 * The step's decision as a surface reads it: the Story record it holds, and the review, opening and task facts it read.
 * A surface never decides on its own what the step's next action is; it renders this [OSA:REQ-020].
 */
export function stepDecisionOf(workflow, phase = workflow?.phases?.[workflow?.currentPhase], { review = null, opening = null, task = null } = {}) {
  // A view reads; it grants no write, so an opening it did not observe is named as being written (kernel `advisory`).
  return phase ? stepState(stepSnapshotOf({ workflow, phase, turnMode: 'view', review: reviewFactOf(phase, review), reviewOwed: true, opening, task })) : null;
}

/** The step's own next action as a planner names it: the first route of its decision, or null on any doubt. */
export function stepRoute(workflow, phase, options) {
  try { return decisionRoutes(stepDecisionOf(workflow, phase), workflow, phase, options).find((entry) => entry?.command) ?? null; } catch { return null; }
}

/** What a step's task waits for, in the person's words: its original code is kept, and nothing is retried meanwhile. */
function taskOutcomeWords(inputs, phase) {
  const code = inputs.code ? ` (${inputs.code})` : '';
  if (inputs.outcome === 'repair-exhausted') return `The repairs allowed for ${phase.id} are used${code}. A person decides on the decisions card what happens next; the evidence of each attempt is kept and nothing is retried.`;
  if (inputs.outcome === 'waiting-environment') return `${phase.id} waits for its environment${code}. A person decides on the decisions card how to go on; nothing is retried until then.`;
  return `${phase.id} waits for a person's decision${code} on the decisions card; nothing is retried until then.`;
}

/**
 * The host's rendering of the kernel's primary action [OSA:REQ-021]: the command and skill each operation maps to, from the one
 * action-to-command map above. The
 * entry, the edit guard, the authoring task and every surface render it from the same decision, so they give one next
 * step [OSA:REQ-010, REQ-020, C7]; recovery appears only for a positively damaged step [OSA:REQ-003, C1]. `exactSubmit`:
 * a surface that names the submission itself (sequence guidance, the guide) gives its exact command, where the edit
 * guard leads with the readiness read; both are the same `submit-version` action.
 */
export function decisionRoutes(decision, workflow, requested, { exactSubmit = false } = {}) {
  const { next } = decision;
  const workId = workflow.workItem?.id;
  // The action's own step: from an inspected step, the current one it names [§4.2 target].
  const phase = workflow.phases?.[next.target?.phase] ?? requested;
  // The step's own work command (D1: /sf-code and /sf-phase are one; a step's routes show the name its kind always had).
  const author = actionSkill('author-version', { phase, workflow });
  const code = phaseRequiresCodeDelivery(phase);
  // Every command comes from the map's named form [OSA:REQ-021]; the cases below choose the form and say why.
  const render = (operation, form, detail, skill = null) => actionRoute(operation, form, { step: phase.id, workId, detail, skill });
  const owed = (next.prerequisites ?? []).find((entry) => entry.code === ACKNOWLEDGEMENT);
  switch (next.operation) {
    // An opening whose shared acceptance is lost or uncertain is reconciled as the same operation; nothing new opens [REQ-033].
    case 'recover-operation': return [next.inputs.operation === 'version-opening'
      ? render('recover-operation', 'reconcile', `Find out whether version ${next.inputs.version} of ${phase.id} reached the shared Story branch; this settles the same opening and opens no other version.`, author)
      : render('recover-operation', 'recover', 'Preserve published bytes and review the successor boundary before application edits.', ACTION_SKILLS.recover)];
    // Another checkout holds the version's writer fence: this one inspects it, or takes it over with its writer's agreement [REQ-034].
    case 'takeover-writer': return [render('takeover-writer', 'takeover',
      `Another checkout writes version ${next.inputs.version} of ${phase.id}. Take it over here only when that checkout's work is published or set aside; this checkout may still inspect it.`, ACTION_SKILLS.takeover)];
    case 'open-version':
      // A successor, for any reason, is previewed and opened only on the person's yes [D3, OSA:REQ-030]; version 1 opens directly.
      if (next.inputs.consent === 'required') return [render('open-version', 'preview',
        `Preview starting version ${next.inputs.version} of ${phase.id} and ask the person to confirm it; ${next.inputs.from ? `version ${next.inputs.from} stays as published` : 'nothing published changes'}.`, author)];
      return [code ? render('open-version', 'begin', 'Open the exact code generation before application edits.', author)
        : render('open-version', 'prepare', 'Continue the configured phase author; publish only after its checks pass.', author)];
    // A kernel-built step's next version opens on the person's yes like any successor [D3, D5]; then its generator builds it.
    case 'build-version': if (next.inputs.consent === 'required') return [render('build-version', 'preview',
      `Preview building version ${next.inputs.version} of ${phase.id} and ask the person to confirm it; ${next.inputs.from ? `version ${next.inputs.from} stays as published` : 'nothing published changes'}. Its generator builds it once it opens.`, author)];
      return [render('build-version', 'prepare', 'Continue the configured phase author; publish only after its checks pass.', author)];
    case 'author-version': return [render('author-version', 'prepare', 'Continue the configured phase author; publish only after its checks pass.', author)];
    case 'decide': return [next.inputs.decision === 'story-decision'
      ? render('decide', 'story', 'Choose what happens next; a member of the deciding group decides.', ACTION_SKILLS.decide)
      : render('decide', 'card', next.inputs.hold === ACKNOWLEDGEMENT ? `A person reads what ${next.inputs.id ?? 'the amendment'} changed and acknowledges it on the decisions card. ${
          next.inputs.effect === 'opening' ? `Then they are asked to start ${phase.id}'s next version.` : `Then ${phase.id} goes on.`}`
        : next.inputs.decision === 'task-outcome' ? taskOutcomeWords(next.inputs, phase)
        : `A person ${next.inputs.decision === 'review-disposition' ? 'decides what the review left to them' : `who approves the scope decides ${next.inputs.id ?? 'the amendment'}`} on the decisions card.`, ACTION_SKILLS.decide)];
    case 'approve-step': return [render('approve-step', 'approve', `Review submitted ${phase.id}, then approve it or return it for correction.`, ACTION_SKILLS.approve),
      render('approve-step', 'reject', 'Or return it for correction.', ACTION_SKILLS.reject)].filter(Boolean);
    // An acknowledgement the submission waits for is its route, as the engine refuses it until then.
    case 'submit-version': if (owed) return decisionRoutes({ ...decision, next: { ...next, operation: 'decide', prerequisites: [],
      inputs: { hold: owed.code, id: owed.id }, then: [] } }, workflow, requested);
      if (exactSubmit) {
      // The map's exact form with the decision values the step records, or its readiness read when a review comes first.
      const exact = submitRoute(workflow, phase);
      return [commandRoute(exact.command, exact.reason, exact.skill)].filter(Boolean);
    }
    // falls through: submission readiness reports the review and the workflow decisions a submission records, then the exact submit.
    case 'refresh-facts': return [render('refresh-facts', 'readiness',
      `Check ${phase.id}'s submission readiness: it names its review, if one is owed, and then the exact submission.`, ACTION_SKILLS.readiness)];
    case 'start-review': return [render('start-review', 'context', 'Review the exact published version against its sources.', ACTION_SKILLS.review)];
    // A step's task waits for its repair within the step's own budget: the same work command repairs and republishes it.
    case 'repair-version': return [render('repair-version', 'prepare', `Repair ${phase.id} within its own work: ${next.inputs.code ?? 'its last check'} is what to fix, then publish it.`, author)];
    // The step's task waits for an input that is not on this laptop: the person restores the same original.
    case 'provide-input': return [render('provide-input', 'readiness',
      `${phase.id} waits for an input that is not on this laptop (${next.inputs.code ?? 'a missing input'}). The person restores the same original file; nothing is repeated meanwhile.`)];
    // A running execution is observed, never repeated or called damaged [§5, OSA:REQ-051].
    case 'inspect': if (next.inputs.task === 'execution') return [render('inspect', 'session',
      `${phase.id}'s work is still running: see how far it got. Nothing is started again while it runs.`)];
      return [render('inspect', 'show', `Inspect ${phase.id} as it is (${next.reasonCodes.join(', ') || 'no action'}); nothing is written now.`)];
    case 'none': return [render('none', 'nextsteps', 'Nothing is written now; see where the Story stands.')];
    // The shared Story branch moved past this checkout: bring it in (it only fast-forwards), then the entry decides again.
    case 'refresh-authority': return [next.inputs.source === 'lifecycle'
      ? render('refresh-authority', 'branch', 'Bring in what the shared Story branch holds now; this checkout\'s view of the step is old.')
      : render('refresh-authority', 'session', 'Run this read in this turn: it binds the turn to the Story as it is now.')];
    // A commit retained here [OSA:REQ-012].
    case 'publish-version': if (next.inputs.pending) return [render('publish-version', 'pending', `${phase.id}'s commit is made here and has not reached the shared Story branch: sync sends that exact commit. Nothing is written again.`)];
    // falls through
    default: return [render('inspect', 'show', `Inspect ${phase.id} as it is (${next.reasonCodes.join(', ') || 'no action'}); nothing is written now.`)];
  }
}
