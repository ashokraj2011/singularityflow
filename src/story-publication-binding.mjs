/** Canonical story publication binding; legacy state exports delegate here. */
import { SingularityFlowError } from "./util.mjs";
import { branch } from "./git.mjs";
import { storyLifecycleProgress } from "./session-roster.mjs";
import { workflowBranchAllowed } from "./story-paths.mjs";


export function workflowPublicationMode(config, workflow) {
  const configured = config.git?.publish ?? 'required';
  const capability = workflow.resolution?.capability?.policy?.gitPublication;
  if (configured === 'required' || capability === 'required') return 'required';
  if (capability === 'warn') return 'warn';
  return configured;
}

export function workflowPublicationBranch(root, workflow) {
  const current = branch(root);
  if (!workflowBranchAllowed(workflow, current)) {
    throw new SingularityFlowError(`Branch '${current}' is not registered for Story '${workflow.workItem.id}'. Run singularity-flow story branch attach --parent ${workflow.workItem.id}.`);
  }
  return current;
}

export function storyLedgerSummary(workflow) {
  const lineage = workflow.lineage ?? {};
  return {
    title: workflow.workItem.title ?? workflow.workItem.id,
    status: workflow.status ?? null,
    currentPhase: workflow.currentPhase ?? null,
    progress: structuredClone(storyLifecycleProgress(workflow)),
    canonicalBranch: lineage.canonicalBranch ?? workflow.workItem.branch ?? workflow.workItem.id,
    createdAt: workflow.workItem.createdAt ?? null,
    updatedAt: workflow.history?.at(-1)?.at ?? workflow.workItem.createdAt ?? null,
    aliases: [lineage.planId, lineage.jiraIssueId, lineage.sourceStableId, workflow.workItem.source?.stableId,
      lineage.initialJiraKey, lineage.currentJiraKey,
      ...(lineage.aliases ?? []).map((entry) => typeof entry === 'string' ? entry : entry?.value ?? entry?.key)]
      .filter((alias) => typeof alias === 'string' && alias)
  };
}
