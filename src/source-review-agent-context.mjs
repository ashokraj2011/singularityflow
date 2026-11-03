import { phaseEntryContext } from './phase-entry-context.mjs';
import { sourceReviewContext } from './source-review-lifecycle.mjs';
import { sourceReviewKind } from './phase-roles.mjs';
import { branch, gitDir } from './git-execution.mjs';
import { workflowBranchAllowed } from './story-paths.mjs';
import { sourceReviewStagingPath } from './phase-staging-paths.mjs';
import { SingularityFlowError } from './util.mjs';
import { withAgentPathProtocol } from './safe-command-guidance.mjs';
import { withRequirementReviewProtocol, REQUIREMENT_REVIEW_PROTOCOL } from './requirement-coverage.mjs';

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
  'progress', 'taskResume', 'reviewGuide', 'citationGuide', 'bindingPath', 'reportTemplate', 'stagingPath', 'stagingProtocol', 'authorAgentId', 'requiredReviewerAgentId',
  'reviewer', 'documentReadiness', 'clarifications', 'clarificationGuidance', 'visualSources', 'visualGuidance', 'unreadableSources', 'sources', 'upstreamSpec', 'artifact', 'reportSchema'];

/** Lossless review projection: one authoritative binding, no duplicated inventory. */
export function compactSourceReviewContext(packet, binding) {
  const { binding: duplicate, ...context } = packet;
  if (packet.canReview && JSON.stringify(duplicate) !== JSON.stringify(packet.reportTemplate?.binding)) {
    throw new SingularityFlowError('Review template does not preserve the exact context binding.', {
      code: 'SOURCE_REVIEW_BINDING_MISMATCH'
    });
  }
  const merged = { ...binding, ...context, resultType: 'source-review-agent-context',
    ...(typeof packet.reviewer?.instructions === 'string' ? { reviewer: { ...packet.reviewer,
      effectiveInstructions: withAgentPathProtocol(packet.kind === 'specification'
        ? withRequirementReviewProtocol(packet.reviewer.instructions) : packet.reviewer.instructions),
      instructionsNote: 'instructions and sha256 preserve the pinned agent. effectiveInstructions adds current runtime path and applicable requirement-review guidance; it changes no authority or review binding.' } } : {}),
    bindingPath: packet.reportTemplate ? 'reportTemplate.binding' : null,
    reviewGuide: {
      role: packet.canReview
        ? 'You are this operation\'s reviewer: activation is automatic, so act under reviewer.effectiveInstructions (otherwise reviewer.instructions) yourself in this conversation; no other agent, setup or selection is needed. Do the whole review now: fill reportTemplate, stage it at stagingPath, check it, then retain it. This packet is complete: a bounded copy lists omittedFields with their line ranges in agentOutput.path; read those ranges with your file tool before concluding anything is missing.'
        : 'No review can be prepared here; relay continuation.actions and stop.',
      readOrder: [typeof packet.reviewer?.instructions === 'string' ? 'reviewer.effectiveInstructions' : 'reviewer.instructions', 'documentReadiness', 'clarifications', 'citationGuide', 'sources', ...(packet.visualSources?.length ? ['visualSources', 'visualGuidance'] : []), 'upstreamSpec', 'artifact', 'reportTemplate', 'reportSchema']
        .filter(field => field === 'reviewer.effectiveInstructions' || packet[field] != null),
      progress: 'Read progress first. Resume its exact staged draft and nextAction; retained ends the review. afterRetention is future guidance until the report is retained. Never restart context merely to avoid authoring the report.',
      exactTexts: true, bindingCopies: packet.reportTemplate ? 1 : 0,
      ...(packet.kind === 'specification' ? { requirementCoverage: typeof packet.reviewer?.instructions === 'string'
        ? 'Apply the requirement-review calibration in reviewer.effectiveInstructions; existing acceptance criteria count as coverage.'
        : REQUIREMENT_REVIEW_PROTOCOL } : {}),
      verification: 'Specification: assess declared verification intent against pinned source obligations, not tool availability. Planning: preserve approved methods and exact verificationCriterion; primary visual/inspection proof is not a test exemption. A real omitted-test exemption still needs a pending human disposition. Neither a contract nor file presence establishes a visual pass.',
      next: 'Start from reportTemplate; preserve binding/metadata and supply independent assessments/citations. Read the exact source text files; their 1-based lines, not packet JSON lines, are citation lines. Use citationGuide to check all scenarios/clauses. Stage, check, repair format/citations using repair hints in this turn (at most two changed packets), then retain when retentionReady, even with honest semantic gaps. Use stagingProtocol; native file-read tools, not shell parsers or duplicate inventories.' } };
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
  const stagingPath = sourceReviewStagingPath(gitDir(root), workflow, phase);
  return compactSourceReviewContext(await sourceReviewContext(root, definition, workflow, phase.id, stagingPath), entry.packet);
}
