/** Shared binding only: importing it must not load authoring/recovery or publication writers. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadAcceptedStoryExecution } from './accepted-story-execution.mjs';
import { phaseInspectionGeneration } from './kernel/phase-policy.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { branch, head, repoRoot } from './git-execution.mjs';
import { agentSessionStatus } from './session.mjs';
import { readCopilotMode, copilotModePresentation } from './copilot-mode.mjs';
import { resolvePersonalization } from './personalization.mjs';
import { activeWorkspaceFile, workspaceRegistryFile, resolveWorkspaceExecutionContext } from './workspace-context.mjs';
import { contextBoundaryPresentation, pendingContextBoundary } from './context-policy.mjs';
import { storyRequestSummary } from './story-request-summary.mjs';
import { approvedInputPhases } from './kernel/phase-inputs.mjs';
import { SingularityFlowError } from './util.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { PHASE_JOURNEY_CONTRACT } from './phase-journey.mjs';
import { BUILD_INFO, versionLine } from './build-info.mjs';
import { assertStoryNotArchived } from './governance-archive.mjs';
import { deriveMutationContract, mutationContractPresentation } from './phase-mutation-contract.mjs';
import { phaseAuthoringContract } from './phase-authoring-contract.mjs';
import { repositoryCheckStatus } from './repository-check-cache.mjs';
import {currentEntryPhase} from './kernel/phase-admission.mjs';

export async function phaseEntryContext({ cwd = process.cwd(), phaseId = null, workId = null,
  allowTerminal = false, turnMode = 'authoring', root: explicitRoot = null } = {}) {
  const mode = readCopilotMode();
  if (mode.paused) return { packet: copilotModePresentation(mode) };
  const selected = explicitRoot ? null : await resolveWorkspaceExecutionContext(activeWorkspaceFile(), workspaceRegistryFile(), { cwd });
  const root = path.resolve(explicitRoot ?? selected?.repositoryPath ?? repoRoot(cwd));
  // Keep the exact effective definition: operation-local catalog verification is reusable.
  // Explicit ids verify, never silently select a different Story in this checkout.
  const accepted = await loadAcceptedStoryExecution(root);
  const { definition, workflow } = accepted;
  const actualId = workflow.workItem.id;
  if ([workId, selected?.storyId].some(id => id && id !== actualId)) throw new SingularityFlowError(
    'Requested or selected Story does not match the active checkout. Attach it explicitly.', {
      code: 'ACTIVE_SUBJECT_MISMATCH', details: { expectedWorkId: workId ?? selected?.storyId,
        actualWorkId: actualId, repositoryPath: root,
        nextCommand: `singularity-flow session attach ${workId ?? selected?.storyId} --json` }
    });
  // Entry grants authoring guidance; archived Stories remain inspectable through phase show,
  // but must not hand an agent permission to edit their preserved application or draft files.
  assertStoryNotArchived(root, workflow);
  const phase = currentEntryPhase(workflow,phaseId,{allowTerminal});
  const session = await agentSessionStatus(root, definition, workflow);
  const ready = (selected?.selectionStatus ?? 'ready') === 'ready' && (phase ? session.ready : true);
  // The request near the top, so an agent that reads only the start of the packet still has it,
  // marked as refined by the approved outputs this step receives from the steps before it.
  const refinedBy = approvedInputPhases(workflow, phase);
  const story = await readFile(path.join(root, definition.workItemRoot, actualId, 'source.json'), 'utf8')
    .then((text) => storyRequestSummary(JSON.parse(text), { refinedBy })).catch(() => null);
  const binding = { ready, repositoryPath: root, workItemRoot: definition.workItemRoot,
    workId: actualId, ...(story ? { story } : {}), phase: phase?.id ?? null, phaseStatus: phase?.status ?? null, generation: phase?.generation ?? null,
    inspectionGeneration: phase ? phaseInspectionGeneration(workflow, phase) : null,
    activeAgent: session.activeAgent, phaseAgent: session.phaseAgent,
    selectionSource: selected?.selectionSource ?? 'cwd', branch: branch(root), head: head(root) };
  const contextBoundary = phase ? contextBoundaryPresentation(pendingContextBoundary(workflow)) : null;
  // The planned evidence files this open code generation owes are listed with its artifacts.
  const evidence = phase?.generationIntent?.status === 'open' && turnMode === 'authoring'
    ? await (await import('./delivery-evidence.mjs')).plannedEvidencePaths(root, definition, workflow, phase).catch(() => [])
    : [];
  const packet = { schemaVersion: 1, resultType: 'sflow-phase-entry', paused: false,
    repositoryChecks: repositoryCheckStatus(root),
    personalization: resolvePersonalization({ root }), ...binding,
    mutationContract: mutationContractPresentation(deriveMutationContract({ root, definition, workflow, phase, turnMode, evidence })),
    authoringContract: phaseAuthoringContract(definition, workflow, phase),
    build: { description: versionLine(), ...BUILD_INFO },
    continuationReview: phase ? { contractRevision: PHASE_JOURNEY_CONTRACT, readOnly: true,
      commandGuidance: safeCommandGuidance({ executable: 'singularity-flow', argv: ['appeal', 'resolve',
        '--work-id', actualId, '--phase', phase.id, '--json'] }),
      detail: 'Inspect one preserved-work journey when blocked. This route does not repair, run tests, accept evidence or approve.' } : null,
    generationPolicy: phase?.generationPolicy ?? null, generatesCode: phase ? phaseRequiresCodeDelivery(phase) : false,
    intent: phase?.generationIntent ?? null,
    ...(contextBoundary ? { contextBoundary } : {}) };
  return { packet, root, ...accepted, phase, session };
}
