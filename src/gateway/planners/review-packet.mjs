/**
 * `review.packet`: resolve the governed work and route the host to its existing review surface.
 *
 * This planner does not duplicate the approval engine or manufacture an approval action. The
 * Approvals surface already loads the exact artifact, pinned authority and ceremony state. The
 * gateway contributes the stable, record-derived selection that gets a person there.
 */
import { SingularityFlowError } from '../../util.mjs';
import { subjectWith } from '../handles.mjs';
import { noEffects, preservedAll, sflowResult } from '../result.mjs';
import { resolveWorkRecord, workRecords } from '../work-records.mjs';

function notFound(workId) {
  return sflowResult({
    kind: 'refusal',
    operation: { id: 'review.packet', classification: 'read' },
    outcome: { status: 'refused', messageId: 'gateway.refused', slots: { workId } },
    effects: noEffects(),
    why: [{ code: 'work.not-in-this-repository', source: 'lifecycle', slots: { workId } }],
    preserved: preservedAll('work.nothing-was-carried-out', { reference: workId }),
    restState: 'blocked'
  });
}

export function reviewPacketResult(item, { subject = null } = {}) {
  const matchingSubject = subject?.id === item.id && (!subject.kind || subject.kind === item.kind)
    ? subject
    : null;
  return sflowResult({
    kind: 'read',
    operation: { id: 'review.packet', classification: 'read' },
    subject: subjectWith(matchingSubject, { kind: item.kind, id: item.id }),
    outcome: {
      status: 'succeeded',
      messageId: 'gateway.read',
      slots: { work: item.id, phase: item.phase ?? 'none' }
    },
    effects: noEffects(),
    why: [{
      code: item.group === 'waiting-on-you'
        ? 'approval.you-are-authorized'
        : item.group === 'waiting-on-others'
          ? 'approval.requires-an-authorized-reviewer'
          : 'work.reconstructed-from-records',
      source: 'lifecycle',
      reference: item.id,
      slots: { phase: item.phase ?? 'none', generation: String(item.generation ?? 0) }
    }],
    restState: 'informational',
    data: {
      surface: 'approvals',
      requestedWork: { id: item.id, kind: item.kind },
      packet: {
        state: 'summary-only',
        exactReviewArtifactRead: false,
        work: { id: item.id, kind: item.kind, title: item.title },
        phase: item.phase,
        phaseLabel: item.phaseLabel,
        generation: item.generation,
        status: item.status,
        decisionAvailableToActor: item.group === 'waiting-on-you',
        blockers: item.blockers ?? [],
        lastMaterialEvent: item.lastMaterialEvent ?? null
      },
      work: item,
      rail: item.rail ?? []
    }
  });
}

export async function reviewPacket({ arguments: args = {}, subject = null, root = null, context = {} } = {}) {
  if (!root) {
    throw new SingularityFlowError('review.packet requires the repository root it should read.', {
      code: 'REVIEW_PACKET_NO_ROOT'
    });
  }
  const records = await workRecords(root, { includeCompleted: true, ...context });
  const item = resolveWorkRecord(records, args);
  return item ? reviewPacketResult(item, { subject }) : notFound(args.workId);
}
