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
 * Hook for a governed "raise upstream issue" route from an in-progress phase (analysis Tier C1).
 * Today no such route exists, so it returns null; when it lands it returns one route of the same
 * shape as `upstreamChangeRoutes` builds, and every caller offers it with no further change.
 */
export function raiseUpstreamIssueRoute(_workflow, _producerId, _currentPhaseId) {
  return null;
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
