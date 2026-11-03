/** Canonical story state write; legacy state exports delegate here. */
import { SingularityFlowError, ensureSecureRepositoryDirectory, stateFingerprint, writeJson, writeText } from "./util.mjs";
import { assertStoryNotArchived } from "./governance-archive.mjs";
import { markerSummary } from "./specification-gate.mjs";
import { default as path } from "node:path";
import { validateId } from "./work-id.mjs";
export { validateId };
import { workDir, workDirRelative, workflowPath } from "./story-paths.mjs";


export function statusPath(root, config, id) { return path.join(workDir(root, config, id), 'STATUS.md'); }

export function legacyPendingPublicationPath(root, config, id) { return path.join(workDir(root, config, id), 'publication-pending.json'); }

export function storyStatusMarkdown(workflow) {
  const lines = [
    `# ${workflow.workItem.id} — ${workflow.workItem.title}`, '',
    `- Branch: \`${workflow.workItem.branch}\``,
    `- Work type: **${workflow.workItem.workType}**`,
    ...(workflow.resolution?.capability
      ? [`- Capability: **${workflow.resolution.capability.name}** (\`${workflow.resolution.capability.id}\`)`,
        `- Capability map: \`${workflow.resolution.capability.map.sha256}\``]
      : []),
    ...(workflow.measurement?.plan?.kind === 'prompt-set-randomized'
      ? [`- Prompt study: **${workflow.measurement.plan.variantId}** · \`${workflow.measurement.plan.studyRunId}\``]
      : []),
    ...((workflow.resolution?.referenceRepositories ?? []).length
      ? [`- Read-only references: ${(workflow.resolution.referenceRepositories)
          .map((reference) => `**${reference.id}** \`${reference.requestedBranch}@${reference.commit.slice(0, 12)}\``)
          .join(', ')}`]
      : []),
    `- Overall status: **${workflow.status}**`,
    `- Current phase: **${workflow.currentPhase ?? (workflow.status === 'cancelled' ? 'cancelled and archived' : 'none — every step is decided')}**`,
    ...(workflow.pendingDecision
      ? [`- Waiting for a decision: **${workflow.pendingDecision.label}** — ${workflow.pendingDecision.by.join(', ')} choose${workflow.pendingDecision.reason === 'limit' ? ' (its rounds are used)' : ''}`]
      : []),
    ...(workflow.cancellation ? [
      `- Cancelled during: **${workflow.cancellation.phase}**`,
      `- Cancellation reason: ${workflow.cancellation.reason}`,
      `- Cancelled at: ${workflow.cancellation.cancelledAt}`
    ] : []), '',
    '| # | Phase | Agent | Status | Generation | Approvals | Tokens |',
    '|---:|---|---|---|---:|---:|---:|'
  ];
  for (const id of workflow.phaseOrder) {
    const phase = workflow.phases[id];
    const approvals = phase.approvals.filter((item) => !item.invalidatedAt).length;
    const tokens = phase.usage.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0);
    lines.push(`| ${phase.order + 1} | ${phase.label} (\`${id}\`) | ${phase.defaultAgent ?? 'unavailable'} | **${phase.status}** | ${phase.generation} | ${approvals} | ${tokens || 'unavailable'} |`);
    for (const approval of phase.approvals.filter((item) => !item.invalidatedAt && item.selfApproval)) lines.push(`|  | ⚠ self-approval | ${approval.actor.name ?? approval.actor.email ?? 'unknown'} via ${approval.authorityGroup ?? 'unrecorded authority'}; agent ${approval.agent ?? 'unavailable'} | **warning** |  |  |  |`);
  }
  const openChangeRequests = (workflow.changeRequests ?? []).filter((request) => request.status === 'open');
  if (openChangeRequests.length) {
    lines.push('', '## Open stakeholder change requests', '');
    for (const request of openChangeRequests) {
      const requester = request.requestedBy?.name ?? request.requestedBy?.email ?? request.requestedBy?.login ?? 'unknown';
      lines.push(`- **${request.id}** — return \`${request.sourcePhase}\` to \`${request.targetPhase}\`: ${request.comment} _(requested by ${requester} at ${request.requestedAt})_`);
      if (request.forwardCheckpoint) {
        lines.push(`  - Reversible checkpoint: \`${request.forwardCheckpoint.id}\` — preview with \`singularity-flow story rework roll-forward --work-id ${workflow.workItem.id} --change-request ${request.id} --json\`.`);
      }
    }
  }
  /**
   * Open clarification markers `[SPK:REQ-065]`.
   *
   * Under `warn` a marker reaches a published generation, and the clause asks that it be visible in
   * status rather than only at the gate. A reviewer who first learns of an open question on the
   * approval screen has already read the artifact once believing it settled.
   */
  const openMarkers = workflow.phaseOrder
    .map((id) => [workflow.phases[id], markerSummary(workflow.phases[id])])
    .filter(([, summary]) => summary);
  if (openMarkers.length) {
    lines.push('', '## Open clarification markers', '');
    for (const [phase, summary] of openMarkers) {
      for (const question of summary.questions) lines.push(`- **${phase.label}** generation ${summary.generation} (\`${summary.mode}\`): ${question}`);
    }
  }
  lines.push('', '## Recent history', '');
  workflow.history.slice(-15).reverse().forEach((item) => lines.push(`- ${item.at} — **${item.event}**${item.phase ? ` (${item.phase})` : ''} by ${item.actor ?? 'unknown'}${item.agent ? ` · agent ${item.agent}` : ''}${item.detail ? `: ${item.detail}` : ''}`));
  if (workflow.sequenceOverrides?.length) lines.push('', `> ⚠ ${workflow.sequenceOverrides.length} confirmed soft sequence override(s) are recorded for this work item.`);
  return `${lines.join('\n')}\n`;
}

export async function saveWorkflow(root, config, workflow) {
  validateId(config, workflow?.workItem?.id);
  assertStoryNotArchived(root, workflow);
  await ensureSecureRepositoryDirectory(
    root,
    workDirRelative(config, workflow.workItem.id),
    { label: `Story '${workflow.workItem.id}' state directory` }
  );
  const file = workflowPath(root, config, workflow.workItem.id);
  // SF Guard M3: on a Story it requires, the person records this command added are signed (the card,
  // then one touch) before anything is written; a refusal writes nothing.
  if (workflow.resolution?.presence) await (await import('./presence/person-steps.mjs')).signNewPersonRecords(root, workflow, file);
  await (await import('./workflow-task-store.mjs')).batchWorkflowTaskProgress(root, workflow);
  await writeJson(file, workflow);
  await writeText(statusPath(root, config, workflow.workItem.id), storyStatusMarkdown(workflow));
  // Keep the aggregate's idea of what is on disk current. Every legitimate write by this process
  // goes through here, so refreshing the fingerprint means the publication check ahead can treat any
  // remaining mismatch as what it is: a different process writing the same work item.
  const tracked = workflow[Symbol.for('singularity-flow.state-revision')];
  if (tracked) tracked.stateSha256 = stateFingerprint(file);
}
