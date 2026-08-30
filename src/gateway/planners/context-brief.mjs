import { composeContextBrief, CONTEXT_BRIEF_SLICES } from '../../context-broker.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { plannerNavigation } from '../result.mjs';
import { noEffects, sflowResult } from '../result.mjs';

const LABELS = Object.freeze({
  brief: 'Open the approved phase brief',
  impact: 'Open accepted Flight Plan impact',
  'world-model': 'Expand repository world-model context',
  ast: 'Expand bounded structural context',
  evidence: 'Expand governed evidence references',
  history: 'Find similar completed governed work',
  knowledge: 'Open bounded prior knowledge guidance',
  observation: 'Open the current compressed observation'
});

export async function contextBrief({ arguments: args = {}, subject = null, root = null } = {}) {
  if (!root) throw new SingularityFlowError('context.brief requires a repository root.', { code: 'CONTEXT_BRIEF_NO_ROOT' });
  const data = await composeContextBrief(root, {
    workId: args.workId,
    slice: args.slice ?? 'brief',
    flightPlanId: args.flightPlanId,
    expandHandle: args.expandHandle,
    maxOutputBytes: args.maxOutputBytes
  });
  const isPacket = data.kind === 'evidence-packet';
  const isExpansion = data.kind === 'evidence-packet-expansion';
  const workId = data.work?.id ?? data.binding?.workId ?? null;
  const phaseId = data.phase?.id ?? data.binding?.phase ?? 'complete';
  const sliceNavigation = isPacket
    ? CONTEXT_BRIEF_SLICES.filter((slice) => !data.requestedSlices?.includes(slice)).map((slice) => ({ slice }))
    : isExpansion ? [] : (data.expansion ?? []).map((slice) => ({ slice }));
  const expansionNavigation = isPacket
    ? (data.expansion ?? []).map((entry) => ({ expansion: entry })) : [];
  const next = [...expansionNavigation, ...sliceNavigation]
    .map((slice, index) => plannerNavigation({
      handle: slice.expansion?.handle ?? `context:${workId}:${slice.slice}`,
      id: slice.expansion?.itemId
        ? `context:${data.packetId}:${slice.expansion.itemId}`
        : slice.expansion ? `context:${data.packetId}:${slice.expansion.kind}`
          : `context:${workId}:${slice.slice}`,
      label: slice.expansion
        ? `Expand ${slice.expansion.kind.replaceAll('-', ' ')}` : LABELS[slice.slice],
      rank: index,
      kind: 'read',
      reasonCode: 'context.expand-slice',
      confirmation: 'none',
      interaction: 'navigation',
      emphasis: 'link',
      executable: false,
      fallback: {
        label: slice.expansion
          ? `Expand ${slice.expansion.kind.replaceAll('-', ' ')}` : LABELS[slice.slice],
        command: slice.expansion
          ? `singularity-flow session context --expand-handle ${slice.expansion.handle}`
          : `singularity-flow session context --work-id ${workId} --slice ${slice.slice}`
      }
    }, 'context.brief', {
      ...(slice.expansion ? { expandHandle: slice.expansion.handle } : {
        workId, slice: slice.slice, ...(data.binding?.flightPlanId ? { flightPlanId: data.binding.flightPlanId } : {})
      }),
      maxOutputBytes: data.accounting?.maximumOutputBytes ?? data.budget?.maximumOutputBytes
    }));

  return sflowResult({
    kind: 'read',
    operation: { id: 'context.brief', classification: 'read' },
    subject,
    outcome: {
      status: 'succeeded', messageId: 'gateway.read',
      slots: { work: workId ?? data.packetId, phase: phaseId }
    },
    effects: noEffects(),
    why: [{
      code: 'context.bounded-brief', source: 'deterministic',
      reference: data.sourceRevision?.commit ?? data.binding?.sourceRevision ?? null,
      slots: {
        slice: data.slice ?? data.requestedSlices?.join(',') ?? data.representation,
        bytes: String(data.accounting?.includedContentBytes ?? data.budget?.includedContentBytes ?? 0)
      }
    }],
    warnings: [
      ...(data.omissions ?? []).map((omission) => ({
        code: 'context.coverage-limited', source: 'unavailable',
        slots: { omission: typeof omission === 'string' ? omission : omission.reason }
      })),
      ...(data.unavailable ?? []).map((entry) => ({
        code: 'context.coverage-limited', source: 'unavailable', slots: { omission: entry.code }
      }))
    ],
    next,
    restState: next.length ? null : 'informational',
    data: { context: data }
  });
}
