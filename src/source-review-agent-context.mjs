import path from 'node:path';
import { phaseEntryContext } from './phase-entry.mjs';
import { sourceReviewContext } from './source-review-lifecycle.mjs';
import { sourceReviewKind } from './phase-roles.mjs';
import { branch, gitDir } from './git.mjs';
import { workflowBranchAllowed } from './state-stores.mjs';
import { SingularityFlowError } from './util.mjs';

/** Lossless review projection: one authoritative binding, no duplicated inventory. */
export function compactSourceReviewContext(packet, binding) {
  const { binding: duplicate, ...context } = packet;
  if (packet.canReview && JSON.stringify(duplicate) !== JSON.stringify(packet.reportTemplate?.binding)) {
    throw new SingularityFlowError('Review template does not preserve the exact context binding.', {
      code: 'SOURCE_REVIEW_BINDING_MISMATCH'
    });
  }
  return { ...binding, ...context, resultType: 'source-review-agent-context',
    bindingPath: packet.reportTemplate ? 'reportTemplate.binding' : null,
    reviewGuide: { readOrder: ['reviewer.instructions', 'clarifications', 'sources', 'upstreamSpec', 'artifact', 'reportTemplate', 'reportSchema'],
      exactTexts: true, bindingCopies: packet.reportTemplate ? 1 : 0,
      next: 'Start from reportTemplate; preserve binding/metadata, supply independent assessments/citations, then check the Git-private report. Do not enumerate JSON keys or reread inventories; exact material is already in this packet.' } };
}

/** A single model-free pause, session and published-review context boundary. */
export async function sourceReviewAgentContext({ cwd = process.cwd(), phaseId = null } = {}) {
  const entry = await phaseEntryContext({ cwd, phaseId });
  if (entry.packet.paused) return entry.packet;
  const { root, definition, workflow, phase, session } = entry;
  if (!entry.packet.ready) return { ...entry.packet, resultType: 'source-review-agent-context',
    status: 'binding-required', canReview: false,
    continuation: { actions: session.phaseAgent?.handoff ? [session.phaseAgent.handoff] : [] } };
  if (!sourceReviewKind(workflow, phase.id)) throw new SingularityFlowError(
    `Source review applies only to a step that defines the scope or plans the claims; '${phase.id}' does neither.`);
  if (!workflowBranchAllowed(workflow, branch(root))) throw new SingularityFlowError(
    `Current branch is not registered for Story '${workflow.workItem.id}'.`);
  if (phase.status !== 'in_progress') throw new SingularityFlowError(
    `Source review context requires current in-progress phase '${phase.id}'.`);
  const stagingPath = path.join(gitDir(root), 'singularity-flow', 'source-reviews',
    `${workflow.workItem.id}-${phase.id}-gen${phase.generation}.json`);
  return compactSourceReviewContext(await sourceReviewContext(root, definition, workflow, phase.id, stagingPath), entry.packet);
}
