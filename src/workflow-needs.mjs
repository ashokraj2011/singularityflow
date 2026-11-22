/**
 * The steps SFlow needs a workflow to have, and where each goes [owner, 2026-11-22: "When an agent directory is imported
 * it should create the needed phases and inject sflow things", and "a way to identify and fix the issues in existing
 * custom workflows"]. The agent import (agent-workflow.mjs convertAgent) adds each, said to be SFlow's own and why.
 *
 * - Requirements: a workflow whose code steps have no step before them that writes the requirement IDs cannot start a
 *   Story (step-intent-settings.mjs unplannedClaims): the code has nothing to cite. A requirements step goes first.
 * - Requirements also plan the code when nothing else does (the step writing the IDs is its planner), so no plan step
 *   is added. Nor is a verification step: a code step runs its tests at submission and holds verification itself
 *   (evidence/responsibilities.mjs), and a step a Story does not need is a turn the person pays for (ceremony cuts,
 *   2026-11-19). A workflow whose route still leaves one out is found by `workflow check`, and `workflow fix` offers
 *   to add the step first.
 *
 * A responsibility the workflow declares it leaves out (`omits`, with its reason and group) is never added. Pure: it
 * reads only the step list it is given, `{ id, intent, label? }` in order.
 */
import { workflowIntentFacts } from './step-intent-settings.mjs';

/** Each step SFlow may add: what it is for and the name it gets. */
export const NEEDED_STEPS = Object.freeze({
  scope: Object.freeze({ responsibility: 'scope', intent: 'requirements', label: 'Requirements', name: 'requirements' })
});

const nameOf = (step) => step?.label ?? step?.id;

/**
 * The steps `steps` needs, each `{ responsibility, intent, label, name, before | after, why }`: `before`/`after` is the
 * ID of the step it goes next to. `omits` lists the responsibilities the workflow leaves out on purpose.
 */
export function neededSteps(steps, { omits = [] } = {}) {
  const list = (steps ?? []).filter((step) => step?.id && step.intent);
  if (!list.length) return [];
  const leftOut = new Set((omits ?? []).map((entry) => (typeof entry === 'string' ? entry : entry?.responsibility)).filter(Boolean));
  const facts = workflowIntentFacts(list.map(({ id, intent }) => ({ id, intent })), { omitsScope: leftOut.has('scope') });
  if (!facts.hasCode) return [];
  const first = list.find((step) => step.id === facts.codeSteps[0]);
  const needed = [];
  if (!leftOut.has('scope') && !facts.scopeSteps.length) {
    needed.push({ ...NEEDED_STEPS.scope, before: list[0].id,
      why: `No step before ${nameOf(first)} writes the requirements it builds, so the code has nothing to cite and a Story cannot start. `
        + 'Requirements writes them first, each with an ID later steps cite.' });
  }
  return needed;
}

/** `steps` with each of `needed` in its place, built by `make(entry)`; the order the workflow then runs in. */
export function withNeededSteps(steps, needed, make) {
  const result = [...steps];
  for (const entry of needed) {
    const anchor = result.findIndex((step) => step.id === (entry.before ?? entry.after));
    const at = anchor < 0 ? (entry.before ? 0 : result.length) : entry.before ? anchor : anchor + 1;
    result.splice(at, 0, make(entry));
  }
  return result;
}
