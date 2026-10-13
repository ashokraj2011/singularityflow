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

export async function run({ positionals, options }) {
  if (options.json !== true) {
    throw new SingularityFlowError('--review-packet requires --json.', { code: 'APPROVAL_PACKET_OPTIONS' });
  }
  const workId = positionals[3];
  const cwd = process.cwd();
  const checked = step(['status', workId, '--submission-readiness', '--json'], cwd);
  if (!checked.ok) stop(checked, 'status --submission-readiness');
  const readiness = checked.value;
  if (readiness?.classification === 'terminal-obligations-required') {
    return console.log(JSON.stringify({ resultType: 'sflow-approval-packet', begun: false,
      reason: 'terminal-obligations-required', approvalPacket: { readiness, review: null } }, null, 2));
  }
  const begun = step(['choices', 'begin', 'approve', workId, ...(options.fetch === true ? ['--fetch'] : []), '--json'], cwd);
  if (!begun.ok) stop(begun, 'choices begin approve');
  const phase = begun.value?.approvalContext?.phase;
  if (typeof phase !== 'string') {
    throw new SingularityFlowError(`The approval selection for ${workId} names no phase awaiting approval.`, { code: 'APPROVAL_PACKET_PHASE_MISSING' });
  }
  const shown = step(['phase', 'show', phase, '--for-agent', '--json'], cwd);
  if (!shown.ok) stop(shown, 'phase show');
  console.log(JSON.stringify({ ...begun.value, approvalPacket: { readiness, review: shown.value } }, null, 2));
}
