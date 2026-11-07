import { agentPacketPresentation } from './agent-packet-presentation.mjs';

/** A smaller approved projection is not byte-limit truncation or a missing source. */
export function inputRepresentationLabel(record) {
  if (record.status !== 'captured') return '';
  const bytes = record.injectedBytes ?? record.representation?.bytes ?? 0;
  const source = record.authoredBytes ?? record.bytes;
  const kind = record.representation?.kind ?? record.projection?.kind;
  if (kind === 'summary' || kind === 'approved-summary') return `approved summary: ${bytes} bytes; authored source: ${source} bytes`;
  if (kind === 'clauses') return `selected clauses: ${bytes} bytes${record.truncated ? ' (truncated)' : ''}`;
  return `${bytes}/${source} bytes${record.truncated ? ' (truncated)' : ''}`;
}

export { phaseInputArtifacts } from './inputs.mjs';

export function compactInputContinuation(continuation) {
  return agentPacketPresentation({ ...continuation, actions: continuation.actions.filter(action => action.timing !== 'then'),
    projection: { omitted: ['actions[timing=then]'],
      fullCommand: `singularity-flow nextsteps ${continuation.workId} --json` } });
}
