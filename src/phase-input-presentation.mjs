import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extractInputsBlock } from './inputs.mjs';

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

/** Return exact kernel-rendered metadata, never a request to hunt for the audit or its markers. */
export async function phaseInputArtifacts(root, phase, result, dryRun) {
  const audit = !dryRun && phase.inputContext ? {
    path: phase.inputContext.path, sha256: phase.inputContext.sha256,
    generation: phase.inputContext.generation
  } : null;
  if (dryRun) return { audit, artifact: { path: result.path, status: 'not-written' } };
  const bytes = await readFile(path.join(root, result.path));
  const managed = extractInputsBlock(bytes.toString('utf8'));
  const hash = content => createHash('sha256').update(content).digest('hex');
  return { audit, artifact: { path: result.path, size: bytes.length, sha256: hash(bytes),
    status: 'rendered', managedBlock: { status: managed ? 'rendered' : 'not-applicable',
      sha256: managed ? hash(managed) : null,
      matchesRendered: managed ? hash(managed) === result.renderedSha256 : result.renderedSha256 === null,
      startMarker: '<!-- singularity-flow:inputs:start -->',
      endMarker: '<!-- singularity-flow:inputs:end -->' } } };
}

export function compactInputContinuation(continuation) {
  return { ...continuation, actions: continuation.actions.filter(action => action.timing !== 'then'),
    projection: { omitted: ['actions[timing=then]'],
      fullCommand: `singularity-flow nextsteps ${continuation.workId} --json` } };
}
