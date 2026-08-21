import { composeContextBrief, CONTEXT_BRIEF_SLICES } from '../../context-broker.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { plannerNavigation } from '../result.mjs';
import { noEffects, sflowResult } from '../result.mjs';

const LABELS = Object.freeze({
  brief: 'Open the approved phase brief',
  'world-model': 'Expand repository world-model context',
  ast: 'Expand bounded structural context',
  evidence: 'Expand governed evidence references'
});

export async function contextBrief({ arguments: args = {}, subject = null, root = null } = {}) {
  if (!root) throw new SingularityFlowError('context.brief requires a repository root.', { code: 'CONTEXT_BRIEF_NO_ROOT' });
  const data = await composeContextBrief(root, {
    workId: args.workId,
    slice: args.slice ?? 'brief',
    maxOutputBytes: args.maxOutputBytes
  });
  const next = CONTEXT_BRIEF_SLICES
    .filter((slice) => slice !== data.slice)
    .map((slice, index) => plannerNavigation({
      handle: `context:${data.work.id}:${slice}`,
      id: `context:${data.work.id}:${slice}`,
      label: LABELS[slice],
      rank: index,
      kind: 'read',
      reasonCode: 'context.expand-slice',
      confirmation: 'none',
      interaction: 'navigation',
      emphasis: 'link',
      executable: false,
      fallback: {
        label: LABELS[slice],
        command: `singularity-flow session context --work-id ${data.work.id} --slice ${slice}`
      }
    }, 'context.brief', {
      workId: data.work.id,
      slice,
      maxOutputBytes: data.accounting.maximumOutputBytes
    }));

  return sflowResult({
    kind: 'read',
    operation: { id: 'context.brief', classification: 'read' },
    subject,
    outcome: {
      status: 'succeeded', messageId: 'gateway.read',
      slots: { work: data.work.id, phase: data.phase?.id ?? 'complete' }
    },
    effects: noEffects(),
    why: [{
      code: 'context.bounded-brief', source: 'deterministic',
      reference: data.sourceRevision.commit,
      slots: { slice: data.slice, bytes: String(data.accounting.includedContentBytes) }
    }],
    warnings: data.omissions.map((omission) => ({
      code: 'context.coverage-limited', source: 'unavailable', slots: { omission }
    })),
    next,
    restState: next.length ? null : 'informational',
    data: { context: data }
  });
}
