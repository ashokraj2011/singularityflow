/** Exact, per-generation contracts that authorize one Auto execution unit. */
import path from 'node:path';

import { head } from '../git.mjs';
import { recordSha256 } from '../records.mjs';
import { sourceTreeHash } from '../state-stores.mjs';
import { SingularityFlowError } from '../util.mjs';
import { AUTO_AUTHORING_TOOLS } from './auto-policy.mjs';

function digest(value) { return `sha256:${recordSha256(value)}`; }

function unique(values) { return [...new Set(values.filter(Boolean))].sort(); }

function concreteScopeAnchor(root, value) {
  const normalized = String(value ?? '').replaceAll('\\', '/');
  const wildcard = normalized.search(/[?*[{]/);
  if (wildcard < 0) return path.resolve(root, normalized);
  const prefix = normalized.slice(0, wildcard);
  const directory = prefix.endsWith('/') ? prefix.slice(0, -1) : path.posix.dirname(prefix);
  return path.resolve(root, directory === '.' ? '' : directory);
}

export function absoluteAutoWriteScope(root, values) {
  return unique(values.map((entry) => concreteScopeAnchor(root, entry)));
}

export async function buildAutoPhaseContract(root, {
  state, plan, definition, workflow, phase, task, composed, provider
}) {
  const generation = Number(phase.generationIntent?.generation ?? phase.generation ?? 0);
  const readRoots = [path.resolve(root)];
  const writeRoots = absoluteAutoWriteScope(root, [
    ...((state.activeRepair?.writeScope?.length
      ? state.activeRepair.writeScope : plan.proposal?.predictedPaths) ?? []),
    phase.requiredArtifact?.path
      ? path.join(definition.workItemRoot ?? 'singularity/work-items', state.story.workId,
        'artifacts', phase.id, phase.requiredArtifact.path)
      : null
  ]);
  const context = {
    protocol: 'auto-context-v1',
    flightId: state.flightId,
    planSha256: state.planSha256,
    workId: state.story.workId,
    phase: phase.id,
    generation,
    generationIntentId: phase.generationIntent?.id ?? null,
    sourceRevision: head(root),
    sourceTreeSha256: await sourceTreeHash(root, definition, workflow),
    configSha256: workflow.resolution?.configSha256 ?? null,
    workflowSha256: plan.bindings?.workflowSha256 ?? null,
    promptSha256: digest(String(composed ?? '')),
    worldModelReference: state.worldModelReference ?? null,
    comprehensionReference: state.comprehensionReference ?? null
  };
  const taskContract = {
    protocol: 'auto-task-v1',
    task,
    requirementSha256: plan.requirement?.sha256 ?? null,
    acceptanceSha256: digest(plan.proposal?.acceptanceCriteria ?? []),
    predictedPaths: [...(plan.proposal?.predictedPaths ?? [])].sort(),
    requiredArtifact: phase.requiredArtifact?.path ?? null,
    readRootsSha256: digest(readRoots),
    writeRootsSha256: digest(writeRoots),
    allowedTools: [...AUTO_AUTHORING_TOOLS]
  };
  const executionUnit = {
    protocol: 'auto-execution-unit-v1',
    provider: provider.provider,
    model: provider.model ?? 'auto',
    task,
    toolScopeProtocol: 'path-v1',
    readRootsSha256: taskContract.readRootsSha256,
    writeRootsSha256: taskContract.writeRootsSha256,
    allowedTools: [...AUTO_AUTHORING_TOOLS]
  };
  const contract = {
    generation,
    generationIntentId: context.generationIntentId,
    contextContractSha256: digest(context),
    taskContractSha256: digest(taskContract),
    executionUnitContractSha256: digest(executionUnit),
    readRoots,
    writeRoots,
    allowedTools: [...AUTO_AUTHORING_TOOLS]
  };
  contract.contractSha256 = digest(contract);
  return Object.freeze(contract);
}

/** One stable slot per exact generation/attempt authorization; older contracts remain auditable. */
export function autoPhaseContractKey(phaseId, contract, { repairPlanId = null } = {}) {
  const phase = String(phaseId ?? '').trim();
  if (!phase || !Number.isSafeInteger(contract?.generation) || contract.generation < 0) {
    throw new SingularityFlowError('Auto phase-contract identity is invalid.', {
      code: 'AUTO_PHASE_CONTRACT_INVALID'
    });
  }
  const generationIntent = String(contract.generationIntentId ?? 'no-intent');
  const attempt = repairPlanId ? `repair:${repairPlanId}` : 'initial';
  return `${phase}@${contract.generation}@${generationIntent}@${attempt}`;
}

export function assertCompatibleAutoPhaseContract(existing, next, phaseId) {
  if (!existing) return;
  if (existing.generation === next.generation
      && existing.contractSha256 === next.contractSha256) return;
  throw new SingularityFlowError(
    `Auto phase contract for '${phaseId}' changed after its execution unit was pinned.`,
    {
      code: 'AUTO_PLAN_AMENDMENT_REQUIRED',
      details: {
        phase: phaseId,
        expected: existing.contractSha256,
        actual: next.contractSha256,
        expectedGeneration: existing.generation,
        actualGeneration: next.generation
      }
    }
  );
}
