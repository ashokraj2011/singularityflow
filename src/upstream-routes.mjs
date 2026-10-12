/**
 * The legal ways an earlier, approved phase can change, seen from where the Story stands now.
 *
 * An approved phase is never edited in place, by recovery or by a later phase. It changes only when
 * a later phase returns work to it (`reject <later> --to <earlier>`, legal once the later phase
 * awaits approval and its policy names the earlier one), or, for the step that defines scope,
 * through a reviewed intent amendment proposed from an active later phase. Every route returned
 * with a command is one the CLI accepts from the current status. A route that becomes legal only
 * later is described in words and never offered as a command, so no caller hands an agent a route
 * the CLI then refuses.
 */
import { intentAmendmentSource, scopeStepOf } from './phase-roles.mjs';

/**
 * The route that is open from any status of a later phase: record the defect for the earlier
 * phase's approvers and keep working [UIF-M4]. They decide a plan correction, a return, an accepted
 * risk or a dismissal; the Story completes only once it is decided. Null when the producer is not an
 * earlier phase that has run, or the Story is not in progress.
 */
export function raiseUpstreamIssueRoute(workflow, producerId, currentPhaseId) {
  const order = workflow?.phaseOrder ?? [];
  const producer = workflow?.phases?.[producerId];
  if ((workflow?.status ?? 'in_progress') !== 'in_progress' || !producer || !(Number(producer.generation) > 0)
      || producer.status === 'not_started' || !currentPhaseId || producerId === currentPhaseId
      || order.indexOf(producerId) < 0 || order.indexOf(producerId) >= order.indexOf(currentPhaseId)) return null;
  const workId = workflow.workItem?.id ?? null;
  return {
    kind: 'upstream-issue', phase: producerId, legal: true, skill: null,
    command: `singularity-flow upstream-issue raise --work-id ${workId} --phase ${producerId} --about <clause-or-section> --problem <what-is-wrong>`,
    label: `Record the defect for ${producerId}'s approvers and keep working; they decide a plan correction, a return, an accepted risk or a dismissal, and the Story completes once it is decided.`
  };
}

/** Routes, plus a sentence for each route that is not open now, for one earlier producer. */
export function upstreamChangeRoutes(workflow, producerId, { currentPhaseId = workflow?.currentPhase ?? null } = {}) {
  const workId = workflow?.workItem?.id ?? null;
  const producer = workflow?.phases?.[producerId] ?? null;
  const current = currentPhaseId ? workflow?.phases?.[currentPhaseId] ?? null : null;
  const order = workflow?.phaseOrder ?? [];
  const routes = [];
  const notes = [];
  if (!producer || !current || producerId === current.id) {
    return { producer: producerId ?? null, current: current?.id ?? null, routes, notes };
  }
  const earlier = order.includes(producerId) && order.indexOf(producerId) < order.indexOf(current.id);
  const allowed = current.approvalPolicy?.rejectTo ?? [current.id];
  const returnable = earlier && allowed.includes(producerId);
  const active = workflow.currentPhase === current.id;
  if (returnable && active && current.status === 'awaiting_approval') {
    routes.push({
      kind: 'return', phase: producerId, legal: true, skill: '/sf-reject',
      command: `singularity-flow reject ${current.id} --work-id ${workId} --to ${producerId} --reason <reason>`,
      label: `An authorized approver returns ${current.id} to ${producerId}. ${producerId} then publishes an amended generation for review, and the phases after it run again.`
    });
  } else if (returnable && active && current.status === 'in_progress') {
    notes.push(`Once ${current.id} is submitted, an authorized approver can return it to ${producerId} with: singularity-flow reject ${current.id} --to ${producerId}.`);
  } else if (earlier && !allowed.includes(producerId)) {
    notes.push(`${current.id} may not return work to ${producerId}; its allowed return targets are ${allowed.join(', ') || 'none'}. A workflow maintainer decides how ${producerId} is corrected.`);
  }
  if (scopeStepOf(workflow)?.id === producerId && intentAmendmentSource(workflow, current.id)) {
    routes.push({
      kind: 'intent-amendment', phase: producerId, legal: true, skill: null,
      command: 'singularity-flow story intent-amendment propose --file <AMENDED-SPEC.md> --reason <reason>',
      label: `Propose a reviewed amendment of the approved ${producerId} scope from ${current.id}. Its approvers decide; ${current.id} keeps its draft meanwhile.`
    });
  }
  const raised = raiseUpstreamIssueRoute(workflow, producerId, current.id);
  if (raised) routes.push(raised);
  return { producer: producerId, current: current.id, routes, notes };
}

/** One sentence for the reader: the first legal route, or why there is none from here. */
export function upstreamRouteSummary(entry) {
  const route = entry?.routes?.[0];
  if (route) return `${route.label} Command: ${route.command}`;
  return entry?.notes?.[0] ?? `${entry?.producer ?? 'The earlier phase'} is approved; it changes only by an authorized return or amendment.`;
}
