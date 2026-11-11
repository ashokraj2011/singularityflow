/** Display only verified context; an unpublished successor has no reviewable artifact packet. */
import { formatCommandRouteLines } from './model-free-commands.mjs';

export function sourceReviewContextText(packet) {
  if (packet.status === 'documents-required') return [packet.documentReadiness.instruction,
    ...packet.documentReadiness.missing.map(record => `${record.id} — ${record.name}\n${record.commandGuidance.command}`)].join('\n');
  if (packet.reviewer?.activation === 'awaiting-successor-publication') return (
    `Source review waits for ${packet.phase} generation ${packet.continuation.targetGeneration} publication.`
  );
  return [
    `Source review context: ${packet.workId} ${packet.phase} generation ${packet.generation}`,
    ...(packet.progress ? [`Review progress: ${packet.progress.state}`, packet.progress.instruction,
      ...(packet.progress.error ? [`${packet.progress.error.code}: ${packet.progress.error.message}`] : []),
      ...(packet.progress.nextAction ? ['', ...formatCommandRouteLines(packet.progress.nextAction), ''] : [])] : []),
    // Files by name; each digest stays in the packet's JSON, which the reviewer reads (owner, 2026-11-11: no hash shown).
    `Artifact: ${packet.artifact.path} (its registered bytes verified)`,
    ...packet.sources.map(source => `Source: ${source.id} · ${source.path}`),
    ...(packet.visualSources ?? []).map(source => `Inspect: ${source.id} · ${source.absolutePath}`),
    ...(packet.upstreamSpec ? [`Approved specification: ${packet.upstreamSpec.path}`] : []),
    `Independent reviewer: ${packet.requiredReviewerAgentId} (${packet.reviewer.activation}; operation-scoped; no agent setup)`,
    ...(packet.recovery?.actions ?? []).map(action => `Recovery: ${action.command}`),
    `Report staging path: ${packet.stagingPath}`
  ].join('\n');
}
