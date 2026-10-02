/**
 * The final evaluation every transition that ends a Story must pass [E2G-028, decision D3].
 *
 * It runs in decision mode on the Story its transition is about to commit, inside the same
 * transaction. If anything is open (a criterion pending, failed or inconclusive, a governance
 * error, or an omitted responsibility nobody has decided) the transition is refused and nothing is
 * written. On success the evaluation is recorded on the Story, and only that record, while it still
 * matches the evidence, can label the Story Complete.
 */
import { runGovernanceGate } from '../governance.mjs';
import { nowIso, SingularityFlowError } from '../util.mjs';
import { evaluateEvidence } from './evaluate.mjs';
import { evidenceGraphFromAggregate } from './graph.mjs';
import { completionLabel } from './labels.mjs';

const MAX_LISTED = 20;
const BLOCKING_RESULTS = new Set(['failed', 'inconclusive', 'missing', 'pending']);

/**
 * Why a blocked evaluation blocks, one line per reason: every blocking finding, and every blocking
 * row no finding explains, so a refusal never lists nothing.
 */
function evidenceBlockersOf(evaluation) {
  if (evaluation.decision.gate !== 'block') return [];
  const blocking = evaluation.findings.filter((entry) => entry.blocking !== false);
  const explained = new Set(blocking.flatMap((entry) => entry.obligationIds ?? []));
  const unexplained = evaluation.rows
    .filter((row) => BLOCKING_RESULTS.has(row.result) && !row.obligations.some((obligation) => explained.has(obligation.id)))
    .map((row) => `${row.id} is ${row.result}.`);
  return [...blocking.map((entry) => entry.message), ...unexplained];
}

/** Evaluate an ending without changing anything. */
export async function evaluateTerminalTransition(root, definition, workflow) {
  const graph = await evidenceGraphFromAggregate(root, definition, workflow);
  graph.terminal = null;
  const evaluation = evaluateEvidence(graph, { boundary: 'terminal', mode: 'decision' });
  const gate = await runGovernanceGate(root, definition, workflow, { terminal: true, pendingTransition: true });
  const evidenceBlockers = evidenceBlockersOf(evaluation);
  const blockers = [...new Set([...evidenceBlockers, ...gate.errors])];
  const recovery = [...new Set([
    ...evaluation.rows.flatMap((row) => row.result === 'pending' ? row.actions.filter((action) => action.kind === 'decide').map((action) => action.command) : []),
    ...(gate.findings ?? []).map((finding) => finding.recovery?.command).filter(Boolean),
    ...(evidenceBlockers.length ? ['singularity-flow evidence matrix'] : []),
    ...(gate.errors.length ? ['singularity-flow gate --terminal'] : [])
  ])];
  return { evaluation, gate, blockers, recovery };
}

export function terminalRefusalMessage(workId, { blockers, recovery }) {
  const listed = blockers.slice(0, MAX_LISTED);
  return [
    `Story ${workId} cannot finish yet: its final evaluation found ${blockers.length === 1 ? 'an open obligation' : `${blockers.length} open obligations`}.`,
    ...listed.map((message) => `- ${message}`),
    ...(blockers.length > listed.length ? [`- …and ${blockers.length - listed.length} more`] : []),
    'Nothing was recorded; the Story stays where it was.',
    ...(recovery.length ? ['Recover:', ...recovery.map((command) => `  ${command}`)] : [])
  ].join('\n');
}

/**
 * Refuse the ending, or record its evaluation on the aggregate the transaction is about to write.
 * Call only with a Story whose transition has just made it complete.
 */
export async function assertTerminalTransition(root, definition, workflow) {
  const result = await evaluateTerminalTransition(root, definition, workflow);
  if (result.blockers.length) {
    throw new SingularityFlowError(terminalRefusalMessage(workflow.workItem.id, result), {
      code: 'STORY_COMPLETION_REFUSED',
      exitCode: 2,
      details: { blockers: result.blockers.slice(0, MAX_LISTED), recovery: result.recovery }
    });
  }
  const decision = { gate: result.evaluation.decision.gate };
  const label = completionLabel({
    workflow, rows: result.evaluation.rows, gate: decision.gate,
    terminal: { mode: 'decision', boundary: 'terminal', decision }
  });
  // A passing evaluation always labels the Story complete; anything else is a defect, never a record.
  if (!['complete', 'complete-with-exceptions'].includes(label.kind)) {
    throw new SingularityFlowError(terminalRefusalMessage(workflow.workItem.id, { blockers: label.reasons, recovery: ['singularity-flow evidence matrix'] }), {
      code: 'STORY_COMPLETION_REFUSED', exitCode: 2, details: { blockers: label.reasons, recovery: ['singularity-flow evidence matrix'] }
    });
  }
  workflow.completion = {
    label: label.label, kind: label.kind, mode: 'decision', boundary: 'terminal', decision,
    inputSha256: result.evaluation.inputSha256,
    assuranceFloor: result.evaluation.summary.assuranceFloor,
    evaluatedAt: nowIso()
  };
  return result;
}
