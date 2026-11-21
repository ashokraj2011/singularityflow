/**
 * Convergence folds into the code approval (owner, 2026-11-21, step intents spec §11: "too many approvals of almost
 * similar documents"). The spec-versus-code check is SFlow's own: requirement by requirement, the convergence report's
 * table, as one section of the code approval. No person approves the convergence step on its own: SFlow approves it
 * when this check is clean (automatic-approval.mjs), and a real gap never approves itself. It goes back to the code
 * step or to a person's decision, with filled routes (the convergence items on the decisions card).
 *
 * - convergenceSection(...): pure. Each requirement of the Story's specification, delivered or a gap (a deterministic
 *   fact names it); each gap with who fixes it (the code step, for its own missing or failing evidence; a person, for a
 *   change outside the plan, a deviation or a clause that changed); what the approved plan settled; and whether the
 *   check is clean: nothing found, nothing proposed, nothing a person decided, nothing blocking.
 * - convergenceSectionForCode(root, config, workflow): the same check on the code step's submitted version while it
 *   waits for its approval, before the Story reaches its convergence step, so the code approval can show it. How an
 *   approval shows it is the approval page's (the approval-focus work); this keeps its data.
 * - convergenceSectionOf(projection, context): the convergence step's own, from its sealed projection.
 *
 * Read only: nothing here approves, decides or writes anything.
 */
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { convergencePhaseOf, latestStepBefore } from './phase-roles.mjs';

/** The gaps the code step fixes itself: its own evidence for a requirement is missing, stale or failing. */
export const CODE_STEP_GAPS = Object.freeze(['absent-observed-claim', 'missing-bound-test', 'failing-bound-test', 'stale-claim-binding', 'missing-required-evidence']);

const GAP_WORDS = Object.freeze({
  'absent-observed-claim': 'no code claims it',
  'unclaimed-changed-path': 'a change no requirement or plan entry accounts for',
  'stale-claim-binding': 'its claim points at code that changed',
  'missing-bound-test': 'no test proves it',
  'failing-bound-test': 'its test fails',
  'claimed-withdrawn-clause': 'code claims a requirement the specification no longer has',
  'unresolved-deviation': 'a recorded deviation nobody decided',
  'missing-required-evidence': 'evidence it requires is missing',
  'verdict-against-superseded-clause': 'its verdict is about words the specification changed'
});

const clauseIdsOf = (indexes) => [...new Set((indexes ?? []).flatMap((index) => (index?.clauses ?? []).map((clause) => clause?.id)).filter(Boolean))].sort();

/**
 * The section a code approval shows for the spec-versus-code check. `clauses` are the specification's requirement
 * IDs; `facts`, `settledByPlan`, `candidates`, `findings` and `unresolvedBlockers` are the convergence projection's
 * (or, before the convergence step, the facts the same check finds on the submitted code). Pure.
 */
export function convergenceSection({ iteration = null, clauses = [], facts = [], settledByPlan = [], candidates = [], findings = [], unresolvedBlockers = [], at = null } = {}) {
  const gapsByClause = new Map();
  for (const fact of facts) for (const clause of fact.clauseIds ?? []) gapsByClause.set(clause, [...(gapsByClause.get(clause) ?? []), fact.id]);
  const requirements = [...new Set([...clauses, ...gapsByClause.keys()])].sort().map((clause) => (gapsByClause.has(clause)
    ? { clause, status: 'gap', gaps: gapsByClause.get(clause) } : { clause, status: 'delivered' }));
  const gaps = facts.map((fact) => ({
    id: fact.id, kind: fact.kind, clauseIds: [...(fact.clauseIds ?? [])], paths: [...(fact.paths ?? [])],
    words: GAP_WORDS[fact.kind] ?? fact.kind, fixedBy: CODE_STEP_GAPS.includes(fact.kind) ? 'code-step' : 'person',
    ...(fact.detail ? { detail: String(fact.detail).slice(0, 400) } : {})
  }));
  const clean = !facts.length && !candidates.length && !findings.length && !unresolvedBlockers.length;
  const delivered = requirements.filter((entry) => entry.status === 'delivered').length;
  const words = clean
    ? `SFlow checked the code against the specification: ${delivered === 1 ? 'its one requirement is' : `all ${delivered} requirements are`} delivered${settledByPlan.length ? `, and the approved plan accounts for ${settledByPlan.length === 1 ? 'the one other change' : `the ${settledByPlan.length} other changes`}` : ''}.`
    : `SFlow checked the code against the specification and found ${gaps.length === 1 ? 'one gap' : `${gaps.length} gaps`}${candidates.length ? ` and ${candidates.length} proposed by the assisted pass` : ''}`
      + `${findings.length ? `; ${findings.length === 1 ? 'one is' : `${findings.length} are`} decided` : ''}${unresolvedBlockers.length ? `; ${unresolvedBlockers.length} still block${unresolvedBlockers.length === 1 ? 's' : ''} it` : ''}.`;
  return {
    schemaVersion: 1, kind: 'convergence-check', iteration, clean, words, requirements, gaps,
    settledByPlan: settledByPlan.map((item) => ({ id: item.id, paths: [...(item.paths ?? [])], settledBy: item.settledBy?.kind ?? null })),
    ...(candidates.length ? { candidates: candidates.map(({ id, classification, clauseIds }) => ({ id, classification, clauseIds })) } : {}),
    ...(findings.length ? { decided: findings.map(({ id, itemId, disposition }) => ({ id, itemId, disposition })) } : {}),
    ...(unresolvedBlockers.length ? { blocking: [...unresolvedBlockers] } : {}),
    ...(at ? { at } : {})
  };
}

/** The convergence step's own section, from its sealed projection and the context it was verified against. */
export function convergenceSectionOf(projection, context = null) {
  return convergenceSection({
    iteration: projection?.iteration ?? null,
    clauses: clauseIdsOf(context?.records?.indexes),
    facts: projection?.facts ?? [],
    settledByPlan: projection?.settledByPlan ?? [],
    candidates: projection?.candidates ?? [],
    findings: projection?.findings ?? [],
    unresolvedBlockers: projection?.unresolvedBlockers ?? []
  });
}

/**
 * The spec-versus-code check on the code step's submitted version, while it waits for its approval: the convergence
 * step's facts, from the same records (convergence-context.mjs, with the code step not yet approved). Null when the
 * Story has no convergence step after a code step, or the code step is not the one waiting; `{ unavailable }` with its
 * reason when its records cannot be read yet. Never throws.
 */
export async function convergenceSectionForCode(root, config, workflow) {
  const convergence = convergencePhaseOf(workflow);
  if (!convergence) return null;
  const code = latestStepBefore(workflow, convergence.id, phaseRequiresCodeDelivery);
  if (!code || workflow.currentPhase !== code.id || code.status !== 'awaiting_approval') return null;
  try {
    const { currentConvergenceContext } = await import('./convergence-context.mjs');
    const context = await currentConvergenceContext(root, config, workflow, { codeAwaitingApproval: code.id });
    return { phase: code.id, generation: Number(code.generation ?? 0),
      ...convergenceSection({ iteration: context.iteration, clauses: clauseIdsOf(context.records?.indexes), facts: context.facts, settledByPlan: context.settlement?.settled ?? [] }) };
  } catch (error) {
    return { phase: code.id, generation: Number(code.generation ?? 0), unavailable: { code: error?.code ?? null, words: String(error?.message ?? error).split('\n')[0].slice(0, 300) } };
  }
}
