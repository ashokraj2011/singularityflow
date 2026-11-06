/**
 * `choices begin approve <WORK-ID> [--fetch] --json --review-packet`: everything `/sf-approve`
 * shows before the person's review, in one command.
 *
 * The skill ran submission readiness, then `choices begin approve`, then `phase show` for the
 * phase awaiting approval: three Copilot round trips with no decision between them. This runs the
 * same three. The output is the selection receipt unchanged plus `approvalPacket` (the readiness
 * result and the `phase show --for-agent` review). Nothing is answered or approved here: the
 * person's review, their typed phase, `choices answer` and `approve` stay separate, exactly as before.
 * Terminal obligations stop before a receipt exists, as the skill did.
 */
import { step, stop } from '../cli-steps.mjs';
import { SingularityFlowError } from '../util.mjs';
import { approvalHoldContinuation } from '../copilot-guidance.mjs';
import { safeCommandGuidance } from '../safe-command-guidance.mjs';

export async function run({ positionals, options }) {
  if (options.json !== true) {
    throw new SingularityFlowError('--review-packet requires --json.', { code: 'APPROVAL_PACKET_OPTIONS' });
  }
  console.log(JSON.stringify(await loadApprovalPacket({ workId: positionals[3], cwd: process.cwd(), fetch: options.fetch === true }), null, 2));
}

/** Stop at known holds before creating consent receipts or loading complete review documents. */
export async function loadApprovalPacket({ workId, cwd, fetch = false }, { runStep = step, stopStep = stop } = {}) {
  const checked = await runStep(['status', workId, '--submission-readiness', '--json'], cwd);
  if (!checked.ok) stopStep(checked, 'status --submission-readiness');
  // No agent reads the step sheet yet, so it costs no agent a token (study 6.6, S3).
  const { sheet: _unread, ...read } = checked.value ?? {};
  const readiness = checked.value?.sheet ? read : checked.value;
  // Decisions approval would refuse for open the decision list first; no receipt is begun.
  if (['terminal-obligations-required', 'decisions-required'].includes(readiness?.classification)) {
    return { resultType: 'sflow-approval-packet', begun: false,
      reason: readiness.classification, approvalPacket: { readiness, review: null } };
  }
  // SF Guard takes this signature in the person's own terminal, so no chat can record it: it says so
  // here, with their exact command, not after the review they would read again there.
  const ownTerminal = (readiness?.approvalCheck?.holds ?? []).find((hold) => hold.owner === 'you-decide' && hold.clearedBy?.kind === 'viewer-terminal');
  if (ownTerminal && readiness.approvalCheck.ready !== false && ownTerminal.action?.command) {
    return { resultType: 'sflow-approval-packet', begun: false, reason: 'approval-holds',
      nextAction: { command: ownTerminal.action.command, label: ownTerminal.action.label, reason: ownTerminal.summary, skill: null, copilotCommand: null },
      approvalPacket: { readiness, review: null } };
  }
  if (readiness?.approvalCheck?.ready === false && readiness.approvalCheck.holds?.length) {
    return { resultType: 'sflow-approval-packet', begun: false, reason: 'approval-holds',
      nextAction: readiness.approvalContinuation ?? approvalHoldContinuation(workId, readiness.approvalCheck),
      approvalPacket: { readiness, review: null } };
  }
  if ((readiness.phaseStatus && readiness.phaseStatus !== 'awaiting_approval')
      || (!readiness.phaseStatus && readiness.classification !== 'already-submitted')) {
    const command = readiness.nextCommand ?? readiness.command ?? 'singularity-flow nextsteps --json';
    const nextAction = readiness.authoringProgress?.next ?? safeCommandGuidance({
      command,
      skill: readiness.nextSkill ?? undefined
    }) ?? safeCommandGuidance(command) ?? safeCommandGuidance('singularity-flow nextsteps --json');
    return { resultType: 'sflow-approval-packet', begun: false,
      reason: readiness.classification, preserveDraft: true, turnBoundary: 'end', nextAction,
      approvalPacket: { readiness, review: null } };
  }
  const begun = await runStep(['choices', 'begin', 'approve', workId, ...(fetch ? ['--fetch'] : []), '--json'], cwd);
  if (!begun.ok) stopStep(begun, 'choices begin approve');
  const phase = begun.value?.approvalContext?.phase;
  if (typeof phase !== 'string') {
    throw new SingularityFlowError(`The approval selection for ${workId} names no phase awaiting approval.`, { code: 'APPROVAL_PACKET_PHASE_MISSING' });
  }
  const shown = await runStep(['phase', 'show', phase, '--for-agent', '--json'], cwd);
  if (!shown.ok) stopStep(shown, 'phase show');
  return { ...begun.value, approvalPacket: { readiness, review: shown.value } };
}
