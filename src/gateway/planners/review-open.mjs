/**
 * `review.open`: where the decision is made, and nothing that could make it. `[INT:CON-113]` `[INT:IFC-052]`
 *
 * An approval is an authorization, so this planner never returns a plan and the kernel would not
 * sign one if it did. What it returns is the ceremony *destination*: the exact subject, phase and
 * generation the decision is about, read from governed records at the moment of asking, plus the
 * trusted host action and the explicit terminal command a person uses to decide. Both are
 * `executable: false` for an ambient tool — the result contract forces that for every ceremony
 * action — so a host that stops reading at `next[]` still cannot turn this into a verdict.
 *
 * The guide may explain readiness; it may not recommend or record a verdict `[INT:CON-061]`. So the
 * result carries who may decide and what is blocking, and no word of advice about which way.
 */
import { SingularityFlowError } from '../../util.mjs';
import { subjectWith } from '../handles.mjs';
import { noEffects, preservedAll, sflowResult } from '../result.mjs';
import { resolveWorkRecord, workRecords } from '../work-records.mjs';

function refusal(code, slots) {
  return sflowResult({
    kind: 'refusal',
    operation: { id: 'review.open', classification: 'read' },
    outcome: { status: 'refused', messageId: 'gateway.refused', slots },
    effects: noEffects(),
    why: [{ code, source: 'lifecycle', slots }],
    preserved: preservedAll('review.no-decision-was-recorded'),
    restState: 'blocked'
  });
}

/** The terminal form of the decision, for the host that has no ceremony surface of its own. */
export function ceremonyFallback(item) {
  return item.kind === 'story' && item.phase
    ? { label: 'Decide in the terminal', command: `sflow approve ${item.phase} --work-id ${item.id} --fetch` }
    : { label: 'See approvals in the terminal', command: 'sflow approvals' };
}

export function reviewOpenResult(item, { subject = null } = {}) {
  const decidable = item.group === 'waiting-on-you';
  return sflowResult({
    kind: 'ceremony',
    operation: { id: 'review.open', classification: 'authorization' },
    subject: subjectWith(subject?.id === item.id ? subject : null, { kind: item.kind, id: item.id }),
    outcome: {
      status: 'succeeded', messageId: 'gateway.ceremony',
      slots: { work: item.id, phase: item.phase ?? 'none', generation: String(item.generation ?? 0) }
    },
    effects: noEffects(),
    why: [{
      code: decidable ? 'approval.you-are-authorized' : 'approval.requires-an-authorized-reviewer',
      source: 'lifecycle', reference: item.id,
      slots: { phase: item.phase ?? 'none', generation: String(item.generation ?? 0) }
    }],
    preserved: preservedAll('review.no-decision-was-recorded', { reference: item.id }),
    next: [{
      handle: `ceremony:review.open:${item.id}`,
      id: 'ceremony:review.open',
      label: `Open the ${item.phaseLabel ?? item.phase ?? 'current'} review`,
      rank: 0,
      kind: 'ceremony',
      reasonCode: 'review.ceremony-destination',
      confirmation: 'ceremony',
      interaction: 'ceremony',
      emphasis: 'primary',
      executable: false,
      slots: { work: item.id, phase: item.phase ?? 'none' },
      /**
       * The trusted review surface, by opaque identifiers only. `[INT:IFC-061]` `[INT:CON-131]`
       *
       * Typed by `host-action-vscode-open-review-ceremony-v1`; the kernel checks it on the way out and
       * the editor again on the way in, and the review it opens reads the decision from records itself.
       */
      hostAction: {
        id: 'vscode.openReviewCeremony',
        arguments: {
          workId: item.id,
          ...(['story', 'initiative'].includes(item.kind) ? { workKind: item.kind } : {}),
          ...(item.phase ? { phase: item.phase } : {}),
          generation: Number.isInteger(item.generation) ? item.generation : 0
        }
      },
      fallback: ceremonyFallback(item)
    }],
    restState: 'awaiting-decision',
    data: {
      ceremony: {
        decisionAvailableToActor: decidable,
        blockers: item.blockers ?? [],
        executable: false
      }
    }
  });
}

export async function reviewOpen({ arguments: args = {}, subject = null, root = null, context = {} } = {}) {
  if (!root) throw new SingularityFlowError('review.open requires the repository root it should read.', { code: 'REVIEW_OPEN_NO_ROOT' });
  const item = resolveWorkRecord(await workRecords(root, { includeCompleted: true, ...context }), args);
  if (!item) return refusal('work.not-in-this-repository', { workId: args.workId });
  if (!['waiting-on-you', 'waiting-on-others'].includes(item.group)) {
    return refusal('review.nothing-awaiting-decision', { workId: item.id, group: item.group });
  }
  return reviewOpenResult(item, { subject });
}
