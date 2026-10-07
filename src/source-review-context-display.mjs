/** Display only verified context; an unpublished successor has no reviewable artifact packet. */
export function sourceReviewContextText(packet) {
  if (packet.reviewer.activation === 'awaiting-successor-publication') return (
    `Source review waits for ${packet.phase} generation ${packet.continuation.targetGeneration} publication.`
  );
  return [
    `Source review context: ${packet.workId} ${packet.phase} generation ${packet.generation}`,
    `Artifact: ${packet.artifact.path} · authored-content SHA-256 ${packet.artifact.authoredContentSha256}`,
    `Registered full-file SHA-256: ${packet.artifact.registeredFileSha256} (includes managed metadata; verified)`,
    ...packet.sources.map(source => `Source: ${source.id} · ${source.path} · ${source.originalSha256}`),
    ...(packet.upstreamSpec ? [
      `Approved specification: ${packet.upstreamSpec.path} · authored-content SHA-256 ${packet.upstreamSpec.authoredContentSha256} · registered full-file SHA-256 ${packet.upstreamSpec.registeredFileSha256}`
    ] : []),
    `Independent reviewer: ${packet.requiredReviewerAgentId} (${packet.reviewer.activation}; operation-scoped; no agent setup)`,
    ...(packet.recovery?.actions ?? []).map(action => `Recovery: ${action.command}`),
    `Report staging path: ${packet.stagingPath}`
  ].join('\n');
}
