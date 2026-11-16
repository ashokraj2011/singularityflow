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
import { phaseKernelOwned, phaseRequiresCodeDelivery, generationSkillForPhase } from './code-delivery-policy.mjs';
import { intentAmendmentPause } from './intent-amendment-pause.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { submitRoute } from './submit-route.mjs';

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
  const facts = (step) => step ? { id: step.id, ...observed(step, versionFactsOf(workflow, step)),
    kind: { executionOwner: executionOwner(step), code: phaseRequiresCodeDelivery(step),
      changeCapabilities: [...(onlyDeterministic(step) ? [] : ['step-artifacts']),
        ...(step.writeScope === 'source-and-artifact' && (!onlyDeterministic(step) || phaseRequiresCodeDelivery(step)) ? ['application'] : [])] },
    pause: intentAmendmentPause(workflow, step.id) ? { id: intentAmendmentPause(workflow, step.id).id } : null,
    // An approved amendment waits for a person's acknowledgement before downstream submission, not before authoring.
    holds: pendingIntentAmendmentAcknowledgement(workflow) ? [{ code: 'INTENT_AMENDMENT_ACKNOWLEDGEMENT_REQUIRED', owner: 'person',
      blocks: ['submission'], resolution: 'decide' }] : [],
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
 * The host's rendering of the kernel's primary action [OSA:REQ-021]: the command and skill each operation maps to. The
 * entry, the edit guard, the authoring task and every surface render it from the same decision, so they give one next
 * step [OSA:REQ-010, REQ-020, C7]; recovery appears only for a positively damaged step [OSA:REQ-003, C1]. `exactSubmit`:
 * a surface that names the submission itself (sequence guidance, the guide) gives its exact command, where the edit
 * guard leads with the readiness read; both are the same `submit-version` action.
 */
export function decisionRoutes(decision, workflow, requested, { exactSubmit = false } = {}) {
  const { next } = decision;
  const workId = workflow.workItem.id;
  // The action's own step: from an inspected step, the current one it names [§4.2 target].
  const phase = workflow.phases?.[next.target?.phase] ?? requested;
  const author = generationSkillForPhase(phase, workflow);
  const code = phaseRequiresCodeDelivery(phase);
  switch (next.operation) {
    // An opening whose shared acceptance is lost or uncertain is reconciled as the same operation; nothing new opens [REQ-033].
    case 'recover-operation': return [next.inputs.operation === 'version-opening'
      ? route(['phase', 'opening', phase.id, '--reconcile', '--json'], `Find out whether version ${next.inputs.version} of ${phase.id} reached the shared Story branch; this settles the same opening and opens no other version.`, author)
      : route(['recover', workId, '--phase', phase.id, '--json'], 'Preserve published bytes and review the successor boundary before application edits.', '/sf-recover')];
    // Another checkout holds the version's writer fence: this one inspects it, or takes it over with its writer's agreement [REQ-034].
    case 'takeover-writer': return [route(['session', 'takeover', workId, '--json'],
      `Another checkout writes version ${next.inputs.version} of ${phase.id}. Take it over here only when that checkout's work is published or set aside; this checkout may still inspect it.`, '/sf-session')];
    case 'open-version':
      // A successor, for any reason, is previewed and opened only on the person's yes [D3, OSA:REQ-030]; version 1 opens directly.
      if (next.inputs.consent === 'required') return [route(['phase', 'rollover', phase.id, '--json'],
        `Preview starting version ${next.inputs.version} of ${phase.id} and ask the person to confirm it; ${next.inputs.from ? `version ${next.inputs.from} stays as published` : 'nothing published changes'}.`, author)];
      return [code ? route(['phase', 'begin', phase.id, '--json'], 'Open the exact code generation before application edits.', author)
        : route(['prepare', phase.id], 'Continue the configured phase author; publish only after its checks pass.', author)];
    case 'author-version': case 'build-version': return [route(['prepare', phase.id], 'Continue the configured phase author; publish only after its checks pass.', author)];
    case 'decide': return [next.inputs.decision === 'story-decision'
      ? route(['decision', 'show', workId], 'Choose what happens next; a member of the deciding group decides.', '/sf-decide')
      : route(['decisions', workId], next.inputs.decision === 'task-outcome' ? taskOutcomeWords(next.inputs, phase)
        : `A person ${next.inputs.decision === 'review-disposition' ? 'decides what the review left to them' : `who approves the scope decides ${next.inputs.id ?? 'the amendment'}`} on the decisions card.`, '/sf-decide')];
    case 'approve-step': return [commandRoute(`singularity-flow approve ${phase.id} --work-id ${workId} --fetch`, `Review submitted ${phase.id}, then approve it or return it for correction.`, '/sf-approve'),
      commandRoute(`singularity-flow reject ${phase.id} --work-id ${workId} --fetch --to <phase> --reason <reason>`, 'Or return it for correction.', '/sf-reject')].filter(Boolean);
    case 'submit-version': if (exactSubmit) {
      const exact = submitRoute(workflow, phase);
      return [commandRoute(exact.command, exact.reason, exact.skill)].filter(Boolean);
    }
    // falls through: submission readiness reports the review and the workflow decisions a submission records, then the exact submit.
    case 'refresh-facts': return [route(['status', workId, '--submission-readiness', '--json'],
      `Check ${phase.id}'s submission readiness: it names its review, if one is owed, and then the exact submission.`, '/sf-submit')];
    case 'start-review': return [route(['review-source', 'context', phase.id, '--for-agent', '--json'], 'Review the exact published version against its sources.', '/sf-review-source')];
    // A step's task waits for its repair within the step's own budget: the same work command repairs and republishes it.
    case 'repair-version': return [route(['prepare', phase.id], `Repair ${phase.id} within its own work: ${next.inputs.code ?? 'its last check'} is what to fix, then publish it.`, author)];
    // The step's task waits for an input that is not on this laptop: the person restores the same original.
    case 'provide-input': return [route(['documents', 'readiness', '--phase', phase.id, '--work-id', workId, '--json'],
      `${phase.id} waits for an input that is not on this laptop (${next.inputs.code ?? 'a missing input'}). The person restores the same original file; nothing is repeated meanwhile.`)];
    // A running execution is observed, never repeated or called damaged [§5, OSA:REQ-051].
    case 'inspect': if (next.inputs.task === 'execution') return [route(['session', 'current', '--for-agent', '--json'],
      `${phase.id}'s work is still running: see how far it got. Nothing is started again while it runs.`)];
      return [route(['phase', 'show', phase.id, '--json'], `Inspect ${phase.id} as it is (${next.reasonCodes.join(', ') || 'no action'}); nothing is written now.`)];
    case 'none': return [route(['nextsteps', '--json'], 'Nothing is written now; see where the Story stands.')];
    // The shared Story branch moved past this checkout: bring it in (it only fast-forwards), then the entry decides again.
    case 'refresh-authority': return [next.inputs.source === 'lifecycle'
      ? route(['refresh-branch'], 'Bring in what the shared Story branch holds now; this checkout\'s view of the step is old.')
      : route(['session', 'current', '--for-agent', '--json'], 'Run this read in this turn: it binds the turn to the Story as it is now.')];
    // A commit retained here [OSA:REQ-012].
    case 'publish-version': if (next.inputs.pending) return [route(['sync'], `${phase.id}'s commit is made here and has not reached the shared Story branch: sync sends that exact commit. Nothing is written again.`)];
    // falls through
    default: return [route(['phase', 'show', phase.id, '--json'], `Inspect ${phase.id} as it is (${next.reasonCodes.join(', ') || 'no action'}); nothing is written now.`)];
  }
}
