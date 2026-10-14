/** Only an exact completed kernel receipt may acknowledge a GUI publication. */
export function phasePublicationProgressLabel(step: string): string | null {
  const labels: Record<string, string> = {
    'publication.preflight': 'Checking the saved artifact',
    'publication.discovery': 'Collecting changed files',
    'publication.validation': 'Validating the generation and required tests',
    'publication.commit': 'Recording the governed commit',
    'publication.push': 'Publishing the exact commit'
  };
  return Object.hasOwn(labels, step) ? labels[step]! : null;
}

export function phasePublicationSummary(value: unknown, expected: { workId: string; phaseId: string }): string {
  const receipt = value as Record<string, unknown> | null;
  const effects = receipt?.effects as Record<string, unknown> | null;
  const retained = receipt?.status === 'retained';
  if (!receipt || receipt.schemaVersion !== 1 || receipt.resultType !== 'sflow-phase-publication'
      || (!retained && receipt.status !== 'published') || receipt.workId !== expected.workId || receipt.phase !== expected.phaseId
      || !Number.isSafeInteger(receipt.generation) || Number(receipt.generation) < 1
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(String(receipt.commit ?? ''))
      || typeof receipt.pushed !== 'boolean' || effects?.committed !== !retained || effects.pushed !== receipt.pushed
      || (retained && (receipt.pushed !== false || receipt.remoteSynchronization !== 'not-checked'))) {
    throw new Error('Publication returned an unverified receipt. Inspect Story status before retrying; do not assume the mutation failed.');
  }
  if (retained) return `${expected.phaseId} generation ${receipt.generation} for ${expected.workId} is already published at ${String(receipt.commit).slice(0, 8)}; no new commit. Remote synchronization was not rechecked.`;
  return `Published ${expected.phaseId} generation ${receipt.generation} for ${expected.workId} at ${String(receipt.commit).slice(0, 8)}${receipt.pushed ? ' and pushed' : ' locally'}.`;
}
