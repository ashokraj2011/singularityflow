/**
 * The single next action for an initiative phase.
 *
 * Advancing a phase means: author the required outputs, publish a generation, satisfy every
 * blocking checklist gate, then approve with an exact confirmation. Nothing surfaced that sequence,
 * so a user had to know the engine's internals to make progress — and a blocked step usually
 * announced itself as a refusal from whatever command was tried next.
 *
 * This resolves state that is already present (output status, checklist status, phase status) into
 * one action, one reason, and one exact command. It is read-only and never throws: a state it does
 * not recognise returns a `blocked` action naming what it saw, which is more useful than an
 * exception in a status bar.
 */

export const NEXT_ACTIONS = Object.freeze({
  AUTHOR: 'author',
  PUBLISH: 'publish',
  EVIDENCE: 'evidence',
  APPROVE: 'approve',
  ADVANCE: 'advance',
  COMPLETE: 'complete',
  BLOCKED: 'blocked',
  // Journey-only actions. They are not phase transitions, but they are actions a caller can be
  // asked to take, so they belong in the same vocabulary rather than a second one.
  SOURCES: 'sources',
  MATERIALIZE: 'materialize',
  REPORT: 'report',
  STATUS: 'status'
});

/**
 * initiativeNextActions in initiative-report.mjs predates this module and emits its own action
 * names. Two vocabularies for the same concept is how the Epic journey's "Approve Intake &
 * continue" button came to do nothing: it carried 'approve-phase', the renderer compared against
 * 'approve', no branch matched, and the click fell through to a navigate-to-the-current-stage
 * fallback — a fully clickable button that changed nothing.
 *
 * Every id crosses into the UI through here, so a name can only diverge in one place.
 */
const LEGACY_ACTION_IDS = Object.freeze({
  prepare: NEXT_ACTIONS.AUTHOR,
  author: NEXT_ACTIONS.AUTHOR,
  'author-and-publish': NEXT_ACTIONS.PUBLISH,
  'add-evidence': NEXT_ACTIONS.EVIDENCE,
  'approve-phase': NEXT_ACTIONS.APPROVE,
  'add-sources': NEXT_ACTIONS.SOURCES,
  materialize: NEXT_ACTIONS.MATERIALIZE,
  report: NEXT_ACTIONS.REPORT,
  status: NEXT_ACTIONS.STATUS
});

const CANONICAL_ACTIONS = new Set(Object.values(NEXT_ACTIONS));

// Returns null for an unrecognised id rather than guessing. A caller that cannot map an action must
// say so; silently treating it as something else is what produced the original defect.
export function normalizeNextActionId(id) {
  if (!id) return null;
  if (CANONICAL_ACTIONS.has(id)) return id;
  return LEGACY_ACTION_IDS[id] ?? null;
}

import { initiativeCheckRequirement, initiativeOutputRequired } from './initiative-policy.mjs';
import { copilotSkillForCommand } from './copilot-guidance.mjs';

export const EPIC_JOURNEY_STAGES = Object.freeze([
  { id: 'intake', label: 'Intake', phase: 'epic-intake' },
  { id: 'requirements', label: 'Requirements', phase: 'epic-requirements' },
  { id: 'planning', label: 'Planning', phase: 'epic-planning' },
  { id: 'stories', label: 'Stories', phase: 'epic-publish' },
  { id: 'complete', label: 'Complete', phase: null }
]);

function epicStageIndex(initiative) {
  if (!initiative) return 0;
  if (initiative.status === 'complete' || initiative.delivery?.status === 'complete') return 4;
  const phase = initiative.currentPhase;
  if (phase === 'epic-publish') return 3;
  if (phase === 'epic-planning') return 2;
  if (phase === 'epic-requirements') return 1;
  if (phase === 'epic-intake') return 0;
  const approved = (initiative.phaseOrder ?? []).filter((id) => initiative.phases?.[id]?.status === 'approved');
  return Math.min(4, Math.max(0, approved.length));
}

function epicActionLabel(action, stage) {
  if (!action) return stage === 'complete' ? 'Review Epic report' : `Open ${stage}`;
  return {
    'add-sources': 'Add source documents',
    prepare: `Open ${stage} workspace`,
    author: `Compose ${stage}`,
    'author-and-publish': `Publish ${stage}`,
    'add-evidence': `Add ${stage} evidence`,
    'approve-phase': `Approve ${stage} & continue`,
    materialize: 'Create Jira and Git Stories',
    report: 'Open Epic report',
    status: 'Refresh Epic status'
  }[action.action] ?? action.action.replaceAll('-', ' ');
}

/**
 * The stages to show for an initiative.
 *
 * Epic planning has named business stages — Intake, Requirements, Planning, Stories — and the
 * desktop routes on those ids, so they stay exactly as they are. Every other profile pins its own
 * phases, and hard-coding the Epic stages onto them was why they were given no journey at all:
 * the workspace showed the artifacts but never where the work stood or what came next.
 */
function journeyStages(initiative) {
  const phaseOrder = initiative?.phaseOrder ?? [];
  // Decided by the pinned phases, not by the profile name: the named business stages apply
  // exactly when the phases they name are the ones this initiative runs.
  const epicPhases = EPIC_JOURNEY_STAGES.map((stage) => stage.phase).filter(Boolean);
  if (epicPhases.every((id) => phaseOrder.includes(id))) return EPIC_JOURNEY_STAGES;
  const phases = phaseOrder.map((id) => ({
    id,
    label: initiative.phases?.[id]?.label ?? id,
    phase: id
  }));
  return phases.length ? [...phases, { id: 'complete', label: 'Complete', phase: null }] : EPIC_JOURNEY_STAGES;
}

function stageIndex(initiative, stages) {
  if (stages === EPIC_JOURNEY_STAGES) return epicStageIndex(initiative);
  if (initiative.status === 'complete' || initiative.delivery?.status === 'complete') return stages.length - 1;
  const current = stages.findIndex((stage) => stage.phase === initiative.currentPhase);
  if (current >= 0) return current;
  const approved = (initiative.phaseOrder ?? []).filter((id) => initiative.phases?.[id]?.status === 'approved').length;
  return Math.min(stages.length - 1, Math.max(0, approved));
}

/**
 * A compact business-facing projection of governed initiative state. It deliberately contains no
 * new mutable state: the phase engine and initiativeNextActions remain the source of truth.
 */
export function epicJourney(initiative, nextActions = []) {
  if (!initiative) return null;
  const stages = journeyStages(initiative);
  const activeStep = stageIndex(initiative, stages);
  const current = stages[activeStep];
  const finalStep = stages.length - 1;
  const next = nextActions[0] ?? null;
  const approved = (initiative.phaseOrder ?? []).filter((id) => initiative.phases?.[id]?.status === 'approved').length;
  const total = Math.max(1, initiative.phaseOrder?.length ?? 1);
  const completionPercent = initiative.status === 'complete'
    ? 100
    : Math.min(99, Math.round((approved / total) * 100));
  const stageStatus = stages.map((stage, index) => ({
    ...stage,
    status: index < activeStep ? 'complete' : index === activeStep ? 'current' : 'upcoming',
    phaseStatus: stage.phase ? initiative.phases?.[stage.phase]?.status ?? 'not_started' : initiative.status
  }));
  return {
    version: 1,
    stage: current.id,
    stageLabel: current.label,
    activeStep,
    completionPercent,
    stages: stageStatus,
    nextAction: next ? {
      id: normalizeNextActionId(next.action) ?? next.action,
      // Preserved so an unmapped action can be reported precisely rather than guessed at.
      sourceId: next.action,
      label: epicActionLabel(next, current.label),
      skill: next.skill ?? copilotSkillForCommand(next.command, '/sf-initiative-next'),
      command: next.command ?? null,
      reason: next.reason ?? next.detail ?? null,
      phaseId: next.phaseId ?? initiative.currentPhase ?? null,
      outputs: next.outputs ?? [],
      checks: next.checks ?? []
    } : {
      id: activeStep === finalStep ? NEXT_ACTIONS.REPORT : NEXT_ACTIONS.STATUS,
      sourceId: activeStep === finalStep ? 'report' : 'status',
      label: epicActionLabel(null, current.label),
      skill: activeStep === finalStep ? '/sf-initiative-status' : '/sf-initiative-next',
      command: null,
      reason: null,
      phaseId: initiative.currentPhase ?? null,
      outputs: [],
      checks: []
    }
  };
}

function plural(count, singular, suffix = 's') {
  return `${count} ${singular}${count === 1 ? '' : suffix}`;
}

/**
 * @param initiative committed initiative state (`state.json`)
 * @param phaseId    the phase to resolve; defaults to the current phase
 * @param checklist  evaluated checklist entries when available. Status is derived from evidence
 *                   records rather than stored, so a caller that has already evaluated the phase
 *                   should pass the result; without it, gate reporting is skipped rather than
 *                   guessed at.
 */
function resolveNextInitiativeAction(initiative, phaseId = null, { checklist = null } = {}) {
  const id = phaseId ?? initiative?.currentPhase ?? null;
  if (!initiative) return { action: NEXT_ACTIONS.BLOCKED, phaseId: null, title: 'No initiative is open.', detail: null, command: null };
  if (!id) {
    return {
      action: NEXT_ACTIONS.COMPLETE,
      phaseId: null,
      title: 'Every phase is approved.',
      detail: 'The initiative has no further governed phase.',
      command: null
    };
  }

  const phase = initiative.phases?.[id];
  const definition = initiative.resolution?.phases?.find((candidate) => candidate.id === id);
  if (!phase || !definition) {
    return { action: NEXT_ACTIONS.BLOCKED, phaseId: id, title: `Phase '${id}' is not part of this initiative.`, detail: null, command: null };
  }

  // A phase that is not current cannot be acted on: the engine is sequence-aware and will refuse.
  if (initiative.currentPhase && initiative.currentPhase !== id) {
    return {
      action: NEXT_ACTIONS.BLOCKED,
      phaseId: id,
      title: `${definition.label} is not the active phase.`,
      detail: `The initiative is at '${initiative.currentPhase}'. Finish that phase first.`,
      command: null
    };
  }

  if (phase.status === 'approved') {
    return {
      action: NEXT_ACTIONS.ADVANCE,
      phaseId: id,
      title: `${definition.label} is approved.`,
      detail: 'Move on to the next phase.',
      command: null
    };
  }

  if (phase.status === 'awaiting_approval') {
    // Blocking gates are evaluated from evidence, so only report them when the caller supplied an
    // evaluation. Claiming "ready to approve" without checking would be worse than saying nothing.
    const blocking = (checklist ?? []).filter((check) => check.gate === 'block' && !['satisfied', 'waived', 'not_applicable', 'optional'].includes(check.status));
    if (blocking.length) {
      return {
        action: NEXT_ACTIONS.EVIDENCE,
        phaseId: id,
        title: `${plural(blocking.length, 'required check')} still ${blocking.length === 1 ? 'has' : 'have'} no evidence.`,
        detail: blocking.map((check) => check.label ?? check.id).join('; '),
        checks: blocking.map((check) => check.id),
        command: `singularity-flow initiative evidence add ${blocking[0].id}`
      };
    }
    return {
      action: NEXT_ACTIONS.APPROVE,
      phaseId: id,
      title: `${definition.label} is ready to approve.`,
      detail: `Generation ${phase.generation} is published. Approving requires the exact confirmation '${id}:phase'.`,
      confirmation: `${id}:phase`,
      command: 'singularity-flow initiative approve phase'
    };
  }

  // in_progress: the outputs decide. Only required outputs gate publication — the engine reports a
  // missing output only when its definition is required, and the desktop used to be stricter.
  const pending = definition.outputs
    .filter((output) => initiativeOutputRequired(initiative, id, output))
    .filter((output) => {
      const state = phase.outputs?.[output.id];
      return !(state?.sha256 && ['draft', 'published', 'approved'].includes(state.status));
    });

  if (pending.length) {
    return {
      action: NEXT_ACTIONS.AUTHOR,
      phaseId: id,
      title: `${plural(pending.length, 'required output')} still ${pending.length === 1 ? 'needs' : 'need'} authoring.`,
      detail: pending.map((output) => output.label ?? output.id).join('; '),
      outputs: pending.map((output) => output.id),
      command: `singularity-flow initiative phase ${id}`
    };
  }

  return {
    action: NEXT_ACTIONS.PUBLISH,
    phaseId: id,
    title: `${definition.label} is ready to publish.`,
    detail: `Publishing records generation ${phase.generation + 1} and its machine evidence.`,
    command: `singularity-flow initiative phase publish ${id}`
  };
}

export function nextInitiativeAction(initiative, phaseId = null, options = {}) {
  const result = resolveNextInitiativeAction(initiative, phaseId, options);
  return {
    ...result,
    skill: result.command ? copilotSkillForCommand(result.command, '/sf-initiative-next') : '/sf-initiative-next'
  };
}

/**
 * Everything still standing between this phase and its approval, in the order it must happen.
 *
 * `initiativeNextActions` answers "what is the single next command", which is the right answer for
 * a CLI and the wrong one for a workspace: it returned `prepare` — "open the Discover & Define
 * workspace" — to someone already standing in it, while four separate things were actually
 * outstanding, each surfaced in a different panel. Nobody could see the shape of the remaining
 * work, so nobody could tell how close the phase was or what to do next.
 *
 * This is a projection, not new state: every item is derived from the phase's own outputs, its
 * checklist and the gate that already decides them.
 */
export function initiativePhaseWork(initiative, phaseId = initiative?.currentPhase) {
  const phase = initiative?.phases?.[phaseId];
  if (!phase) return [];
  const definition = initiative.resolution.phases.find((item) => item.id === phaseId);
  const steps = [];

  for (const output of definition?.outputs ?? []) {
    if (!initiativeOutputRequired(initiative, phaseId, output)) continue;
    const state = phase.outputs?.[output.id];
    steps.push({
      id: `author:${output.id}`,
      kind: 'author',
      outputId: output.id,
      label: `Draft ${output.label}`,
      done: Boolean(state?.sha256),
      detail: state?.sha256 ? `${state.status.replaceAll('_', ' ')}` : 'Not written yet'
    });
  }

  for (const check of definition?.checklist ?? []) {
    if (initiativeCheckRequirement(initiative, phaseId, check) !== 'must') continue;
    const state = phase.checklist?.[check.id];
    steps.push({
      id: `attest:${check.id}`,
      kind: 'attest',
      checkId: check.id,
      label: `Record judgement — ${check.label}`,
      done: Boolean(state && state.status !== 'missing'),
      detail: state?.status === 'missing' || !state
        ? `No evidence yet · accepts ${(check.acceptedAssurance ?? []).join(', ') || 'human-approved'}`
        : state.status.replaceAll('_', ' ')
    });
  }

  steps.push({
    id: 'publish',
    kind: 'publish',
    label: `Publish ${definition?.label ?? phaseId} for review`,
    done: ['awaiting_approval', 'approved'].includes(phase.status),
    detail: 'Commits this generation and opens it for approval'
  });
  steps.push({
    id: 'approve',
    kind: 'approve',
    label: `Approve ${definition?.label ?? phaseId}`,
    done: phase.status === 'approved',
    detail: 'The governed decision that advances the Epic'
  });

  // Exactly one step is "now": the first thing not yet done. Everything after it waits on it, and
  // saying so is the difference between a list of controls and an account of where the work stands.
  const next = steps.findIndex((step) => !step.done);
  return steps.map((step, index) => ({ ...step, state: step.done ? 'done' : index === next ? 'now' : 'later' }));
}
