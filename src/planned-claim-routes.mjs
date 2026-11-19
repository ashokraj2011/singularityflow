/**
 * The routes out of a missing planned-test refusal (state.mjs assertPlannedSpecificationClaims), loaded only when it
 * refuses. The plan's approvers may plan the missing rows in place, or hear of it as an upstream issue [PHR:REQ-003,
 * finding 15]. The way back to the plan step leads, whole [audit 2026-11-19, entry 18]: its approvers return it to its
 * author while it waits for approval; once approved, the upstream issue with the clauses and the problem filled in.
 * Its owner's correction, never recovery of a healthy step [D4].
 */
import { returnRoute } from './action-command-map.mjs';
import { raiseUpstreamIssueRoute, upstreamChangeRoutes } from './upstream-routes.mjs';

export function plannedClaimRoutes(workflow, codePhase, owner, gaps, ownedPlanned) {
  const workId = workflow.workItem.id;
  const planned = Object.assign({}, ...ownedPlanned.map((entry) => entry.claims ?? {}));
  const raised = owner && ownedPlanned.length ? raiseUpstreamIssueRoute(workflow, owner.id, codePhase.id) : null;
  const planCorrections = owner && ownedPlanned.length ? [
    ...gaps.slice(0, 3).map((clause) => (planned[clause]
      ? { command: `singularity-flow decision plan ${workId} --owner ${owner.id} --add-test ${clause}=<TEST> --reason <why>`,
        label: `An approver of ${owner.id} plans ${clause}'s test in their own terminal.` }
      : { command: `singularity-flow decision plan ${workId} --owner ${owner.id} --add-row ${clause}=<PATH> --test <TEST> --reason <why>`,
        label: `An approver of ${owner.id} plans ${clause} in their own terminal.` })),
    ...(raised ? [{ command: raised.command.replace('<clause-or-section>', gaps.join(',')).replace('<what-is-wrong>', `"The plan has no test for ${gaps.join(', ')}."`), skill: '/sf-decide',
      label: `Or record it for ${owner.id}'s approvers: they decide a plan correction, a return, an accepted risk or a dismissal.` }] : [])] : [];
  const returnPlan = owner?.status === 'awaiting_approval' && (owner.approvalPolicy?.rejectTo ?? [owner.id]).includes(owner.id)
    ? { ...returnRoute(workflow, owner), label: `Return ${owner.id} to its author to plan a test for ${gaps.join(', ') || 'each clause'}.` } : null;
  const leading = returnPlan ?? planCorrections.find((entry) => / upstream-issue raise /u.test(entry.command));
  return { planCorrections, route: owner ? leading ?? planCorrections[0] ?? upstreamChangeRoutes(workflow, owner.id).routes[0] : null };
}
