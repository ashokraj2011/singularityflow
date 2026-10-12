/**
 * What an author needs to know at entry about everything before its step. `[A7, B5]`
 *
 * A step used to learn at its end that an earlier step left something open: an input that is no
 * longer approved, an issue nobody decided, an amendment still to revalidate. The entry packet now
 * names them up front, with the command each owner runs. The step that ends the Story also gets a
 * preview of the final evaluation, so what would refuse completion is routed while its owner is still
 * reachable. Nothing here blocks or changes anything; a failed preview reports itself unavailable.
 */
import { resolvedPhaseInputs } from './inputs.mjs';
import { openUpstreamIssues, upstreamIssueDecideCommand } from './upstream-issues.mjs';
import { forwardAmendmentTerminalBlockers } from './forward-amendments.mjs';

const MAX_LISTED = 8;

function producerOf(input) {
  return typeof input === 'string' ? input : input?.phase ?? input?.from ?? null;
}

/** The step a completion would come from: this one, when every later step is skipped. */
export function endsStory(workflow, phase) {
  const order = workflow?.phaseOrder ?? [];
  const index = order.indexOf(phase?.id);
  return index >= 0 && order.slice(index + 1).every((id) => workflow.phases?.[id]?.status === 'skipped');
}

export async function upstreamEntrySummary(root, definition, workflow, phase, { evaluateTerminalReadiness = null } = {}) {
  const workId = workflow.workItem.id;
  const inputs = resolvedPhaseInputs(workflow, phase).map(producerOf).filter(Boolean).map((id) => ({
    phase: id, status: workflow.phases?.[id]?.status ?? 'missing', generation: Number(workflow.phases?.[id]?.generation ?? 0)
  }));
  const openIssues = openUpstreamIssues(workflow).map(({ issue, status }) => ({
    id: issue.id, phase: issue.phase, about: issue.about, status, decide: upstreamIssueDecideCommand(workId, issue)
  }));
  const amendments = forwardAmendmentTerminalBlockers(workflow);
  let finalGate = null;
  if (evaluateTerminalReadiness && endsStory(workflow, phase)) {
    try {
      const result = await evaluateTerminalReadiness(root, definition, workflow, { stage: 'submission' });
      finalGate = {
        advisory: true,
        status: result.blockers.length ? 'blocked' : 'ready',
        blockers: result.blockers.slice(0, MAX_LISTED),
        more: Math.max(0, result.blockers.length - MAX_LISTED),
        owners: [...new Set((result.gate?.findings ?? []).map((finding) => finding.phase).filter(Boolean))].sort(),
        recovery: result.recovery.slice(0, MAX_LISTED)
      };
    } catch (error) {
      finalGate = { advisory: true, status: 'unavailable', reason: error?.code ?? 'evaluation-failed' };
    }
  }
  const attention = inputs.some((entry) => !['approved', 'skipped'].includes(entry.status))
    || openIssues.length > 0 || amendments.length > 0 || finalGate?.status === 'blocked';
  return {
    attention,
    inputs,
    openIssues,
    amendments,
    finalGate,
    instruction: attention
      ? 'These are owned by earlier steps or people, not by this draft. Keep working; never edit an earlier step to clear one. Record a defect you find with upstream-issue raise; the Story completes only when each item here is decided.'
      : 'Nothing earlier is open.'
  };
}
