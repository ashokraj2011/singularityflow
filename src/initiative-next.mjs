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
  BLOCKED: 'blocked'
});

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
export function nextInitiativeAction(initiative, phaseId = null, { checklist = null } = {}) {
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
    .filter((output) => output.required !== false)
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
