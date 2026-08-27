export interface ReworkRollForwardPreview {
  workId: string;
  changeRequestId: string;
  checkpointId: string;
  sourceCommit: string;
  sourcePhase: string;
  paths: string[];
}

/** Render every digest-bound path into a scrollable editor document before confirmation. */
export function renderReworkRollForwardPreview(plan: ReworkRollForwardPreview): string {
  return [
    `# Rework roll-forward preview — ${plan.workId}`,
    '',
    `- Change request: \`${plan.changeRequestId}\``,
    `- Checkpoint: \`${plan.checkpointId}\``,
    `- Source commit: \`${plan.sourceCommit}\``,
    `- Return phase: \`${plan.sourcePhase}\``,
    `- Paths restored: ${plan.paths.length}`,
    '',
    'Every path covered by the confirmation digest:',
    '',
    ...plan.paths.map((candidate, index) => `${index + 1}. ${JSON.stringify(candidate)}`),
    '',
    'The current Git history is preserved and a local backup is created before these paths are restored.'
  ].join('\n');
}
