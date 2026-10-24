import { composeContextBrief, CONTEXT_BRIEF_SLICES } from '../../context-broker.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { plannerNavigation } from '../result.mjs';
import { noEffects, sflowResult } from '../result.mjs';

const LABELS = Object.freeze({
  brief: 'Open the approved phase brief',
  impact: 'Open accepted Flight Plan impact',
  'world-model': 'Expand repository world-model context',
  ast: 'Expand bounded structural context',
  evidence: 'Expand evidence references',
  history: 'Find similar completed work',
  knowledge: 'Open bounded prior knowledge guidance',
  observation: 'Open the current compressed observation'
});

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The packet's recorded receipt, in the editor's Context Receipt view. `[INT:REQ-175]` `[INT:IFC-061]`
 *
 * Compiling a packet writes its content-free receipt (sources by digest, bytes, estimated tokens,
 * omissions, expansions) beside the repository's Git data, so the view reads that record by the
 * packet ID rather than this page. Offered only when the packet names its Story, which is what the
 * record is read by; the terminal route reads the same record.
 */
function receiptView(data, workId, rank) {
  const packetId = data.packetId ?? null;
  if (!['evidence-packet', 'evidence-packet-expansion'].includes(data.kind)) return null;
  if (!IDENTIFIER.test(String(packetId ?? '')) || !IDENTIFIER.test(String(workId ?? ''))) return null;
  const phase = IDENTIFIER.test(String(data.binding?.phase ?? '')) ? data.binding.phase : null;
  return {
    handle: `host-action:context-receipt:${packetId}`, id: 'context:open-receipt', label: 'Open the context receipt', rank,
    kind: 'host-action', reasonCode: 'context.open-receipt-view', confirmation: 'none', interaction: 'navigation',
    emphasis: 'link', executable: false,
    hostAction: { id: 'vscode.openContextReceipt', arguments: { receiptId: packetId, workId } },
    fallback: {
      label: 'Show the receipt in the terminal',
      command: phase
        ? `singularity-flow context xray --work-id ${workId} --phase ${phase} --packet ${packetId}`
        : `singularity-flow tokens report --work-id ${workId} --packet ${packetId}`
    }
  };
}

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
  const phaseId = data.phase?.id ?? data.binding?.phase ?? 'closed';
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
  const receipt = receiptView(data, workId, next.length);
  if (receipt) next.push(receipt);

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
