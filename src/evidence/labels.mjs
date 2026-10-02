/**
 * The only module that may call a Story complete [E2G-030].
 *
 * Lifecycle words say where the Story stands ("In progress at Code", "Every step decided",
 * "Cancelled"). Completion labels say what its evidence proves, and only a terminal evaluation in
 * decision mode, at the current candidate, may produce the first two. Everything else reads one of
 * the two Incomplete labels, so no view can derive completion from lifecycle state alone.
 */

export const COMPLETION_LABELS = Object.freeze({
  complete: 'Complete',
  completeWithExceptions: 'Complete with accepted exceptions',
  incomplete: 'Incomplete — verification pending or insufficient',
  notEvaluated: 'Incomplete — final verification not evaluated'
});

/** Where the Story stands, in words that never claim its obligations were met. */
export function lifecycleWords(workflow) {
  if (workflow?.status === 'cancelled') return 'Cancelled';
  if (workflow?.status === 'complete' || workflow?.status === 'closed') return 'Every step decided';
  if (workflow?.pendingDecision) {
    return `Waiting for a decision: ${workflow.pendingDecision.label ?? workflow.pendingDecision.after ?? 'unnamed'}`;
  }
  const current = workflow?.currentPhase ? workflow.phases?.[workflow.currentPhase] : null;
  if (current) return `In progress at ${current.label ?? current.id}`;
  return 'Not started';
}

/**
 * The label for an evaluation. `terminal` is a decision-mode terminal evaluation of the current
 * inputs, or null when none exists; a projection can never supply one, so views read Incomplete.
 */
export function completionLabel({ workflow, rows = [], terminal = null }) {
  const counts = resultCounts(rows);
  // Anything but a decision-mode terminal evaluation is no final evaluation at all.
  const decisive = terminal?.mode === 'decision' && terminal.boundary === 'terminal';
  if (decisive && rows.length > 0) {
    if (terminal.decision?.gate === 'allow') {
      return { label: COMPLETION_LABELS.complete, kind: 'complete', reasons: [] };
    }
    if (terminal.decision?.gate === 'allow-with-risk') {
      return {
        label: COMPLETION_LABELS.completeWithExceptions, kind: 'complete-with-exceptions',
        reasons: [`${counts['satisfied-with-exception'] ?? 0} criterion row(s) passed through an accepted exception`]
      };
    }
  }
  const closed = workflow?.status === 'complete' || workflow?.status === 'closed';
  if (closed && !decisive) {
    return {
      label: COMPLETION_LABELS.notEvaluated, kind: 'not-evaluated',
      reasons: ['no final governance evaluation is recorded for the current evidence']
    };
  }
  const reasons = [];
  if (workflow?.status === 'cancelled') reasons.push('the Story was cancelled');
  if (!rows.length) reasons.push('no requirement or acceptance criterion is indexed for this Story');
  for (const result of ['failed', 'inconclusive', 'missing', 'pending']) {
    if (counts[result]) reasons.push(`${counts[result]} ${result}`);
  }
  if (!reasons.length) reasons.push('the Story has steps left to decide, and only the final check can call it complete');
  return { label: COMPLETION_LABELS.incomplete, kind: 'incomplete', reasons };
}

export function resultCounts(rows) {
  const counts = {};
  for (const row of rows) counts[row.result] = (counts[row.result] ?? 0) + 1;
  return counts;
}
