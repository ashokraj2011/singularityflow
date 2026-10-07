import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadAcceptedStoryExecution } from './accepted-story-execution.mjs';
import { recoveryPlan } from './collaboration.mjs';
import { verifyClarificationRecord } from './clarifications.mjs';
import { phaseInspectionGeneration, requiresProspectivePhaseInspection } from './code-submission-evidence.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { phaseAuthoringSummary } from './phase-authoring-summary.mjs';
import { branch, head, repoRoot } from './git.mjs';
import { agentSessionStatus } from './session.mjs';
import { storyReferenceRepositories, verifyReferenceRepositories } from './reference-repositories.mjs';
import { readCopilotMode, copilotModePresentation } from './copilot-mode.mjs';
import { resolvePersonalization } from './personalization.mjs';
import { activeWorkspaceFile, workspaceRegistryFile, resolveWorkspaceExecutionContext } from './workspace-context.mjs';
import { SingularityFlowError } from './util.mjs';
import { phaseUsesDeterministicGeneration } from './manual-authorship.mjs';

/** One model-free entry packet; no tests, begin, prepare, commit, push or lifecycle decisions. */
export async function enterPhase({ cwd = process.cwd(), phaseId = null, workId = null,
  compose = false, modelEnabled = true } = {}) {
  const mode = readCopilotMode();
  if (mode.paused) return copilotModePresentation(mode);
  const selected = await resolveWorkspaceExecutionContext(activeWorkspaceFile(), workspaceRegistryFile(), { cwd });
  const root = path.resolve(selected?.repositoryPath ?? repoRoot(cwd));
  // Keep the exact effective definition: operation-local catalog verification is reusable.
  // Explicit ids verify, never silently select a different Story in this checkout.
  const { definition, workflow } = await loadAcceptedStoryExecution(root);
  const actualId = workflow.workItem.id;
  if ([workId, selected?.storyId].some(id => id && id !== actualId)) throw new SingularityFlowError(
    'Requested or selected Story does not match the active checkout. Attach it explicitly.', {
      code: 'ACTIVE_SUBJECT_MISMATCH', details: { expectedWorkId: workId ?? selected?.storyId,
        actualWorkId: actualId, repositoryPath: root }
    });
  const phase = workflow.phases?.[phaseId ?? workflow.currentPhase];
  if (!phase || phase.id !== workflow.currentPhase) throw new SingularityFlowError(
    'Phase entry must name the current Story phase; historical inspection uses phase show.',
    { code: 'PHASE_DRAFT_NOT_ACTIVE', details: { requestedPhase: phaseId, currentPhase: workflow.currentPhase } });
  const session = await agentSessionStatus(root, definition, workflow);
  const ready = (selected?.selectionStatus ?? 'ready') === 'ready' && session.ready;
  const binding = { ready, repositoryPath: root, workItemRoot: definition.workItemRoot,
    workId: actualId, phase: phase.id, phaseStatus: phase.status, generation: phase.generation,
    inspectionGeneration: phaseInspectionGeneration(workflow, phase),
    activeAgent: session.activeAgent, phaseAgent: session.phaseAgent,
    selectionSource: selected?.selectionSource ?? 'cwd', branch: branch(root), head: head(root) };
  const base = { schemaVersion: 1, resultType: 'sflow-phase-entry', paused: false,
    personalization: resolvePersonalization({ root }), ...binding,
    generationPolicy: phase.generationPolicy, generatesCode: phaseRequiresCodeDelivery(phase),
    intent: phase.generationIntent ?? null,
    effects: { contextCompositionRequested: compose, testsRun: false, storyAdvanced: false,
      committed: false, pushed: false }, modelInvocations: 0 };
  if (!ready) return { ...base, status: 'binding-required', context: null,
    next: session.phaseAgent?.handoff ? [session.phaseAgent.handoff] : [], authoringAllowed: false };
  const authoring = await phaseAuthoringSummary(root, definition, workflow, phase);
  const recovery = await recoveryPlan(root, definition, workflow, {
    phaseId: phase.id, inspectActivePhase: true, modelEnabled
  });
  const references = await verifyReferenceRepositories(root,
    await storyReferenceRepositories(root, definition, workflow));
  const prospective = requiresProspectivePhaseInspection(workflow, phase);
  const requiresDecision = recovery.actions.some(action => action.id === 'working-tree'
    && action.confirmation !== 'none');
  const canCompose = prospective && !phaseUsesDeterministicGeneration(phase)
    && authoring.policyVerified && authoring.effectiveAuthoringSkill
    && !recovery.requiresRecovery && !requiresDecision && references.status !== 'blocked';
  let context = null;
  if (compose && canCompose) {
    // The existing composer owns pinned inputs, immutable reuse, authority replay and locking.
    const { composePhasePrompt } = await import('./worldmodel.mjs');
    const text = await composePhasePrompt(root, { workId: actualId, phase: phase.id });
    context = { text, deliveredSha256: createHash('sha256').update(text).digest('hex'),
      generation: binding.inspectionGeneration };
  }
  const clarification = await verifyClarificationRecord(root, definition, workflow, phase, {
    generation: binding.inspectionGeneration
  });
  const authoringAllowed = Boolean(canCompose && clarification.errors.length === 0);
  return { ...base, status: !prospective ? 'retained-generation' : authoringAllowed
    ? 'authoring-entry' : 'attention-required', authoringAllowed,
    authoring, recovery, references, clarification, context,
    contextComposition: !compose ? 'not-requested' : context ? 'delivered' : 'not-admitted',
    next: !prospective ? authoring.handoff : recovery.actions,
    inspectionCommands: { recovery: `singularity-flow recover ${actualId} --phase ${phase.id} --json`,
      documents: `singularity-flow phase show ${phase.id} --json` } };
}
