/**
 * The five-verb fast path: `specify`, `plan`, `implement`, `verify`, `converge`. `[SPK:REQ-010]`
 *
 * The product sentence this serves is "keep the kernel's sophistication; make the experience feel
 * as small as Spec Kit's" `[SPK:CON-001]`. The way to fail it would be to reimplement the lifecycle
 * behind a friendlier name — so this module computes *nothing* about what is legal. It asks the
 * existing planner (`workflowGuide` → `nextActions`, the same one `nextsteps` and the narration
 * contract already use) and reports the answer in the fast path's vocabulary `[SPK:CON-002]`.
 *
 * A verb is a router with a stopping rule, not an autopilot. It runs the registered operations that
 * are legal before the next checkpoint and stops `[SPK:CON-014]`; a checkpoint is any boundary that
 * needs model generation, consent, human review, approval, external completion, or recovery
 * `[SPK:REQ-004]`. Five words never become an autopilot (Appendix D.6).
 *
 * Everything here is a pure function of the workflow snapshot and the resolved definition. That is
 * deliberate: `[SPK:REQ-180]` demands byte-identical authoritative state between the fast path and
 * the advanced operations, and a planner you can call without a repository is a planner you can
 * actually prove that about.
 */
import { workflowGuide } from './guide.mjs';
import { SingularityFlowError } from './util.mjs';

/**
 * The public vocabulary, in journey order. `[SPK:REQ-010]`
 *
 * `converge` sits before `verify`, matching the phase order in `[SPK:REQ-031]`
 * (…implementation → convergence → verification…). The spec's own prose lists the verbs as
 * "specify, plan, implement, verify, and converge", which is a readable sentence and the wrong
 * sequence: convergence is the pre-verification closure loop `[SPK:CON-038]`, so handing over from
 * `implement` straight to `verify` would skip it.
 */
export const FAST_PATH_VERBS = Object.freeze(['specify', 'plan', 'implement', 'converge', 'verify']);

/**
 * Why a verb stopped. `[SPK:REQ-004]`
 *
 * `recovery` sorts first because a pending publication must be routed before any new lifecycle work
 * is proposed `[SPK:CON-016]` — offering someone a next step while a retained commit has not reached
 * its remote is how a Story ends up with two truths.
 */
export const CHECKPOINT_KINDS = Object.freeze([
  'recovery', 'model-generation', 'human-review', 'approval', 'external-completion',
  // Not a boundary the spec names, but a real stopping condition: the reader asked for a verb that
  // does not route the phase the Story is actually at. Calling that a `milestone` would have been a
  // lie in the one field a reader uses to decide what to do next.
  'not-routed', 'milestone'
]);

/** Outcomes a verb can report. A verb that reached its milestone is not "done with the Story". */
export const FAST_PATH_OUTCOMES = Object.freeze(['milestone-reached', 'checkpoint', 'blocked']);

/**
 * The fast-path configuration for a work type, or null when the profile does not opt in.
 *
 * Returning null rather than a default is the point: the five verbs are a property of
 * `spec-driven-standard` and any other profile that configures them, never an engine branch
 * `[SPK:CON-020]`. A work type that says nothing about the fast path does not get it.
 */
export function fastPathProfile(definition, workType) {
  const configured = definition?.workTypes?.[workType]?.fastPath;
  if (!configured || typeof configured !== 'object') return null;
  const verbs = {};
  for (const verb of FAST_PATH_VERBS) {
    const entry = configured[verb];
    if (!entry) continue;
    const milestone = typeof entry === 'string' ? entry : entry.milestone;
    if (!milestone) throw new SingularityFlowError(`workTypes.${workType}.fastPath.${verb} needs a milestone.`);
    verbs[verb] = {
      milestone,
      // A verb owns the phases it routes. Absent an explicit list the verb owns the phase it is
      // named for, which is the common case and keeps the profile short.
      phases: Object.freeze(entry.phases ?? [defaultPhaseForVerb(verb)])
    };
  }
  return Object.keys(verbs).length ? Object.freeze({ workType, verbs: Object.freeze(verbs) }) : null;
}

function defaultPhaseForVerb(verb) {
  return ({
    specify: 'specification', plan: 'planning', implement: 'implementation',
    verify: 'verification', converge: 'convergence'
  })[verb];
}

/** Every phase the profile's verbs own, in the order the workflow declares them. */
function phasesForVerb(workflow, profile, verb) {
  const declared = profile.verbs[verb]?.phases ?? [];
  return (workflow.phaseOrder ?? []).filter((id) => declared.includes(id));
}

/**
 * Has the verb's milestone actually been reached? `[SPK:CON-011]`
 *
 * Proved from workflow state, never from a command having returned successfully. The distinction
 * matters most at exactly the moment it is tempting to skip: `submit` returning 0 means the phase is
 * awaiting approval, which is emphatically not "specification approved".
 */
export function milestoneReached(workflow, profile, verb) {
  const phases = phasesForVerb(workflow, profile, verb);
  if (!phases.length) return false;
  return phases.every((id) => {
    const phase = workflow.phases?.[id];
    if (!phase) return false;
    // `approved` and `complete` are both terminal for a phase; a phase the profile skipped is not.
    return phase.status === 'approved' || phase.status === 'complete' || phase.status === 'completed';
  });
}

/**
 * The verb whose phases contain the current phase — the journey context to keep showing.
 *
 * `[SPK:REQ-021]` asks that `next[]` teach the checkpoint action while retaining the current verb,
 * so a reader mid-`specify` is never told to run `plan` because the underlying phase happens to
 * have moved.
 */
export function verbForPhase(workflow, profile, phaseId) {
  if (!phaseId) return null;
  return FAST_PATH_VERBS.find((verb) => phasesForVerb(workflow, profile, verb).includes(phaseId)) ?? null;
}

/** The verb after this one, or null at the end of the journey. `[SPK:REQ-022]` */
export function nextVerb(profile, verb) {
  const configured = FAST_PATH_VERBS.filter((name) => profile.verbs[name]);
  const index = configured.indexOf(verb);
  return index >= 0 && index + 1 < configured.length ? configured[index + 1] : null;
}

/**
 * Classify the boundary the verb has run into.
 *
 * Read straight off the same state the guide reads, so the fast path and the advanced interface can
 * never disagree about whether a human is required.
 */
function checkpointFor(workflow, phase, { publicationPending }) {
  if (publicationPending) {
    return {
      kind: 'recovery',
      reason: 'A retained lifecycle commit has not reached its remote; publication must be recovered before new work.'
    };
  }
  if (!phase) return { kind: 'milestone', reason: 'No phase is active for this Story.' };
  if (phase.status === 'awaiting_approval') {
    return { kind: 'approval', reason: `${phase.label ?? phase.id} is awaiting an authorized human approval.` };
  }
  if (phase.status === 'blocked') {
    return { kind: 'external-completion', reason: `${phase.label ?? phase.id} is blocked on work outside this Story.` };
  }
  return null;
}

/**
 * Plan one fast-path invocation. Pure: no repository, no model, no mutation.
 *
 * Returns the `[SPK:REQ-020]` payload. `underlyingOperations[]` names the registered operations the
 * verb would run — naming them is most of the honesty here, because a vocabulary that hides which
 * kernel operation ran is a vocabulary that can quietly stop matching it.
 */
export function planFastPath(workflow, definition, verb, {
  publicationPending = false, modelMode = { enabled: true }
} = {}) {
  if (!FAST_PATH_VERBS.includes(verb)) {
    throw new SingularityFlowError(`Unknown fast-path verb '${verb}'. Use one of ${FAST_PATH_VERBS.join(', ')}.`);
  }
  const workType = workflow?.workItem?.workType;
  const profile = fastPathProfile(definition, workType);
  if (!profile) {
    throw new SingularityFlowError(
      `Work type '${workType ?? 'unknown'}' does not configure the fast path. Use the phase commands, or start a Story with a profile that declares workTypes.<type>.fastPath.`
    );
  }
  if (!profile.verbs[verb]) {
    const offered = Object.keys(profile.verbs).join(', ');
    throw new SingularityFlowError(`'${verb}' is not configured for ${workType}. It offers: ${offered}.`);
  }

  const milestone = profile.verbs[verb].milestone;
  const activeId = workflow.currentPhase ?? null;
  const phase = activeId ? workflow.phases?.[activeId] ?? null : null;
  const owned = phasesForVerb(workflow, profile, verb);
  const context = verbForPhase(workflow, profile, activeId);

  // Recovery outranks everything, including a milestone that looks reached. `[SPK:CON-016]`
  const checkpoint = checkpointFor(workflow, phase, { publicationPending });
  if (checkpoint?.kind === 'recovery') {
    return result({
      verb, milestone, checkpoint, outcome: 'blocked',
      underlyingOperations: ['sync'],
      why: [{ code: 'publication.pending', source: 'sequence' }],
      next: [{ id: 'fastpath.recover', label: 'Recover the retained publication', command: 'sflow sync', rank: 'NOW' }]
    });
  }

  if (milestoneReached(workflow, profile, verb)) {
    const following = nextVerb(profile, verb);
    return result({
      verb, milestone, outcome: 'milestone-reached',
      checkpoint: { kind: 'milestone', reason: `${milestone} is proved by workflow state.` },
      underlyingOperations: [],
      // After the milestone, the next verb is the primary continuation. `[SPK:REQ-022]`
      next: following
        ? [{ id: `fastpath.${following}`, label: `Continue with ${following}`, command: `sflow ${following}`, rank: 'NOW' }]
        : [{ id: 'fastpath.progress', label: 'Review the completed journey', command: 'sflow progress', rank: 'LATER' }],
      restState: following ? null : 'complete'
    });
  }

  // The verb is not finished, and the Story is somewhere its phases do not own — the reader asked
  // for the wrong verb. Say which one owns the current phase rather than guessing an action.
  if (activeId && !owned.includes(activeId)) {
    return result({
      verb, milestone, outcome: 'blocked',
      checkpoint: { kind: 'not-routed', reason: `This Story is at ${activeId}, which ${verb} does not route.` },
      underlyingOperations: [],
      why: [{ code: 'fastpath.phase-not-owned', source: 'sequence' }],
      next: context
        ? [{ id: `fastpath.${context}`, label: `Use ${context} for ${activeId}`, command: `sflow ${context}`, rank: 'NOW' }]
        : [{ id: 'fastpath.nextsteps', label: 'Show the deterministic action set', command: 'sflow nextsteps', rank: 'NOW' }]
    });
  }

  // Everything below is the ordinary case: the verb owns the active phase and has work to route.
  const planned = workflowGuide(workflow).nextActions ?? [];
  const stop = checkpoint ?? modelCheckpoint(planned, modelMode);
  return result({
    verb, milestone, outcome: stop ? 'checkpoint' : 'checkpoint',
    checkpoint: stop ?? { kind: 'model-generation', reason: 'The next step authors an artifact.' },
    underlyingOperations: planned.map((action) => operationOf(action.command)).filter(Boolean),
    // The checkpoint action is taught, and the verb stays as the journey context. `[SPK:REQ-021]`
    next: planned.map((action, index) => ({
      id: `fastpath.${verb}.${index}`,
      label: action.reason ?? action.command,
      command: action.command,
      skill: action.skill ?? null,
      rank: index === 0 ? 'NOW' : 'SOON'
    })),
    journeyVerb: context ?? verb
  });
}

/** A step that needs authoring is a model-generation checkpoint, and consent is explicit. */
function modelCheckpoint(planned, modelMode) {
  const authoring = planned.some((action) => /\b(prepare|generate)\b/.test(action.command ?? ''));
  if (!authoring) return null;
  return modelMode?.enabled
    ? { kind: 'model-generation', reason: 'The next step authors an artifact and needs an agent.' }
    : { kind: 'model-generation', reason: 'The next step authors an artifact, and models are disabled for this run.' };
}

/** The registered operation a planned command maps to, for `underlyingOperations[]`. */
function operationOf(command) {
  const match = /^singularity-flow\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/.exec(String(command ?? ''));
  if (!match) return null;
  return match[2] && !match[2].startsWith('-') ? `${match[1]}.${match[2]}` : match[1];
}

/** Assemble the `[SPK:REQ-020]` payload with every field present, so consumers never branch. */
function result({
  verb, milestone, checkpoint, outcome, underlyingOperations = [], why = [], next = [],
  preserved = null, stateEffects = [], restState = null, journeyVerb = null
}) {
  return Object.freeze({
    schemaVersion: 1,
    resultType: 'fast-path',
    verb,
    journeyVerb: journeyVerb ?? verb,
    milestone,
    checkpoint: Object.freeze({ ...checkpoint }),
    outcome,
    underlyingOperations: Object.freeze([...new Set(underlyingOperations)]),
    why: Object.freeze(why.map((entry) => Object.freeze({ ...entry }))),
    // A planning call changes nothing, and says so rather than leaving the reader to assume.
    preserved: Object.freeze(preserved ?? [
      'governed state', 'artifacts', 'approvals', 'publications', 'external systems'
    ]),
    stateEffects: Object.freeze(stateEffects),
    next: Object.freeze(next.map((entry) => Object.freeze({ ...entry }))),
    restState
  });
}
