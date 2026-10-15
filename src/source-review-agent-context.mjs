import path from 'node:path';
import { phaseEntryContext } from './phase-entry.mjs';
import { sourceReviewContext } from './source-review-lifecycle.mjs';
import { sourceReviewKind } from './phase-roles.mjs';
import { branch, gitDir } from './git.mjs';
import { workflowBranchAllowed } from './state-stores.mjs';
import { SingularityFlowError } from './util.mjs';

/**
 * What a reviewer must act on comes first. `[review-packet-order]`
 *
 * The packet spread the phase entry (its long mutation and authoring contracts) and then the review
 * material, and appended the guide last. A real planning review is hundreds of kilobytes, so
 * Copilot saved it to a file, read its beginning, saw only that `sflow-source-reviewer` was
 * required, never reached the guide, template or staging protocol, and stopped with the review
 * undone. Same fields, same values: identity, then the guide (with who acts and that the packet is
 * complete), the template and staging, then the material to read, then everything else.
 */
const FIRST_FIELDS = ['schemaVersion', 'resultType', 'paused', 'personalization', 'ready', 'repositoryPath', 'workItemRoot',
  'workId', 'story', 'phase', 'phaseStatus', 'generation', 'kind', 'canReview', 'status', 'reason', 'continuation', 'recovery',
  'reviewGuide', 'bindingPath', 'reportTemplate', 'stagingPath', 'stagingProtocol', 'authorAgentId', 'requiredReviewerAgentId',
  'reviewer', 'clarifications', 'clarificationGuidance', 'unreadableSources', 'sources', 'upstreamSpec', 'artifact', 'reportSchema'];

/** Lossless review projection: one authoritative binding, no duplicated inventory. */
export function compactSourceReviewContext(packet, binding) {
  const { binding: duplicate, ...context } = packet;
  if (packet.canReview && JSON.stringify(duplicate) !== JSON.stringify(packet.reportTemplate?.binding)) {
    throw new SingularityFlowError('Review template does not preserve the exact context binding.', {
      code: 'SOURCE_REVIEW_BINDING_MISMATCH'
    });
  }
  const merged = { ...binding, ...context, resultType: 'source-review-agent-context',
    bindingPath: packet.reportTemplate ? 'reportTemplate.binding' : null,
    reviewGuide: {
      role: packet.canReview
        ? 'You are this operation\'s reviewer: activation is automatic, so act under reviewer.instructions yourself in this conversation; no other agent, setup or selection is needed. Do the whole review now: fill reportTemplate, stage it at stagingPath, check it, then retain it. This packet is complete: a bounded copy lists omittedFields with their line ranges in agentOutput.path; read those ranges with your file tool before concluding anything is missing.'
        : 'No review can be prepared here; relay continuation.actions and stop.',
      readOrder: ['reviewer.instructions', 'clarifications', 'sources', 'upstreamSpec', 'artifact', 'reportTemplate', 'reportSchema'],
      exactTexts: true, bindingCopies: packet.reportTemplate ? 1 : 0,
      verification: 'Specification: assess declared verification intent against pinned source obligations, not tool availability. Planning: preserve approved methods and exact verificationCriterion; primary visual/inspection proof is not a test exemption. A real omitted-test exemption still needs a pending human disposition. Neither a contract nor file presence establishes a visual pass.',
      next: 'Start from reportTemplate; preserve binding/metadata and supply independent assessments/citations. Use stagingProtocol: exact file-edit staging or the standalone kernel stage command, then check and retain. Read captured output with native file-read tools, not shell parsers. Do not enumerate JSON keys or reread inventories; exact material is already in this packet.' } };
  const ordered = {};
  for (const key of FIRST_FIELDS) if (Object.hasOwn(merged, key)) ordered[key] = merged[key];
  for (const [key, value] of Object.entries(merged)) if (!Object.hasOwn(ordered, key)) ordered[key] = value;
  return ordered;
}

/** A single model-free pause, session and published-review context boundary. */
export async function sourceReviewAgentContext({ cwd = process.cwd(), phaseId = null } = {}) {
  const entry = await phaseEntryContext({ cwd, phaseId, turnMode: 'read-only-review' });
  if (entry.packet.paused) return entry.packet;
  const { root, definition, workflow, phase, session } = entry;
  if (!entry.packet.ready) return { ...entry.packet, resultType: 'source-review-agent-context',
    status: 'binding-required', canReview: false,
    continuation: { actions: session.phaseAgent?.handoff ? [session.phaseAgent.handoff] : [] } };
  // A step with no source review is answered, not refused, so a reviewer never stops on it.
  if (!sourceReviewKind(workflow, phase.id)) return { ...entry.packet, resultType: 'source-review-agent-context',
    status: 'not-required', canReview: false,
    reason: `'${phase.id}' neither defines the scope nor plans the claims, so it has no source review.`,
    continuation: { actions: [] } };
  if (!workflowBranchAllowed(workflow, branch(root))) throw new SingularityFlowError(
    `Current branch is not registered for Story '${workflow.workItem.id}'.`);
  if (phase.status !== 'in_progress') throw new SingularityFlowError(
    `Source review context requires current in-progress phase '${phase.id}'.`);
  const stagingPath = path.join(gitDir(root), 'singularity-flow', 'source-reviews',
    `${workflow.workItem.id}-${phase.id}-gen${phase.generation}.json`);
  return compactSourceReviewContext(await sourceReviewContext(root, definition, workflow, phase.id, stagingPath), entry.packet);
}
