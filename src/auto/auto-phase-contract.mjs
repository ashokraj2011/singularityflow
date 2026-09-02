/** Exact, per-generation contracts that authorize one Auto execution unit. */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { head } from '../git.mjs';
import { recordSha256 } from '../records.mjs';
import { sourceTreeHash } from '../state-stores.mjs';
import { SingularityFlowError } from '../util.mjs';
import { autoAttemptId } from './auto-candidate.mjs';
import {
  buildAutoAgentTaskContract, buildAutoContextManifest, buildAutoExecutionSelection,
  validateAutoPhaseContractSnapshot
} from './auto-contract-records.mjs';
import { AUTO_AUTHORING_TOOLS } from './auto-policy.mjs';

function digest(value) { return `sha256:${recordSha256(value)}`; }

function textDigest(value) {
  return `sha256:${createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')}`;
}

function unique(values) { return [...new Set(values.filter(Boolean))].sort(); }

function normalizeScope(value) {
  const supplied = String(value ?? '').trim();
  const normalized = path.posix.normalize(supplied.replaceAll('\\', '/')).replace(/\/+$/, '');
  if (!normalized || normalized === '.'
      || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(supplied)
      || path.win32.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)
      || normalized === '..' || normalized.startsWith('../')
      || normalized.includes('/../')) {
    throw new SingularityFlowError(`Auto Task Contract scope '${normalized}' is unsafe.`, {
      code: 'AUTO_TASK_SCOPE_INVALID'
    });
  }
  return normalized;
}

function concreteScopeAnchor(root, value) {
  const normalized = normalizeScope(value);
  const wildcard = normalized.search(/[?*[{]/);
  if (wildcard < 0) return path.resolve(root, normalized);
  const prefix = normalized.slice(0, wildcard);
  const directory = prefix.endsWith('/') ? prefix.slice(0, -1) : path.posix.dirname(prefix);
  const resolved = path.resolve(root, directory === '.' ? '' : directory);
  if (resolved === path.resolve(root)) {
    throw new SingularityFlowError(
      `Auto Task Contract scope '${normalized}' cannot be enforced without repository-wide access.`, {
        code: 'AUTO_TASK_SCOPE_TOO_BROAD'
      }
    );
  }
  return resolved;
}

export function absoluteAutoWriteScope(root, values) {
  return unique(values.map((entry) => concreteScopeAnchor(root, entry)));
}

export function absoluteAutoReadScope(root, values) {
  return unique(values.map((entry) => concreteScopeAnchor(root, entry)));
}

function relativeArtifactPath(definition, state, phase) {
  return phase.requiredArtifact?.path
    ? path.posix.join(
      String(definition.workItemRoot ?? 'singularity/work-items').replaceAll('\\', '/'),
      state.story.workId,
      String(phase.requiredArtifact.path).replaceAll('\\', '/')
    )
    : null;
}

function estimatedTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(Buffer.byteLength(text) / 4);
}

/** Render the exact text whose digest is admitted by the Context Manifest. */
export function renderAutoAuthoringPrompt({
  composed, flightId, attemptId, plan, state, deterministic = false
}) {
  const repair = state.activeRepair;
  const priorAttempts = Number(state.counters?.authoringAttempts?.[state.story?.phase] ?? 0);
  const attemptKind = repair ? 'repair' : priorAttempts > 0 ? 'resume' : 'initial';
  return [
    String(composed ?? '').trimEnd(), '', '# Ratified Auto execution boundary', '',
    `- Flight: ${flightId}`,
    `- Attempt: ${attemptId} (${attemptKind})`,
    `- Plan: ${plan.planId} (${plan.planSha256})`,
    `- Requirement: ${plan.requirement.text}`,
    `- Predicted repository paths: ${plan.proposal.predictedPaths.join(', ') || 'none'}`,
    ...(repair ? [
      `- Exact Repair Plan: ${repair.repairPlanId} (${repair.repairPlanSha256})`,
      `- Repair objective: ${repair.objective}`,
      `- Repair write scope: ${(repair.writeScope ?? []).join(', ') || 'none'}`,
      `- Required repair evidence: ${(repair.requiredEvidence ?? []).join('; ') || 'none'}`,
      '- This is the only authorized repair attempt. Do not expand scope or repeat prior work.'
    ] : []),
    '- Work only in this managed worktree. Do not commit, push, approve, waive policy, answer clarification, change lifecycle state, or run Singularity Flow commands.',
    deterministic
      ? '- Implement and test the requirement. Do not edit the phase artifact; the kernel will regenerate its deterministic summary from your changes.'
      : '- Implement and test the requirement, and completely author the configured phase artifact. Do not leave placeholders.'
  ].join('\n');
}

export function nextAutoAttemptId(state, phase) {
  const attemptNumber = Number(state.counters?.authoringAttempts?.[phase.id] ?? 0) + 1;
  return autoAttemptId({
    flightId: state.flightId, phase: phase.id, attemptNumber,
    generationIntentId: phase.generationIntent?.id ?? null
  });
}

export async function buildAutoPhaseContract(root, {
  state, plan, definition, workflow, phase, task, composed, modelPrompt = composed, provider
}) {
  const generation = Number(phase.generationIntent?.generation ?? phase.generation ?? 0);
  const attemptId = nextAutoAttemptId(state, phase);
  const predictedScope = unique((plan.proposal?.predictedPaths ?? []).map(normalizeScope));
  const repairReadScope = state.activeRepair?.readScope?.length
    ? unique(state.activeRepair.readScope.map(normalizeScope)) : null;
  const repairWriteScope = state.activeRepair?.writeScope?.length
    ? unique(state.activeRepair.writeScope.map(normalizeScope)) : null;
  const artifactPath = relativeArtifactPath(definition, state, phase);
  const readScope = unique([...(repairReadScope ?? predictedScope), artifactPath]);
  const writeScope = unique([...(repairWriteScope ?? predictedScope), artifactPath]);
  if (!readScope.length || !writeScope.length) {
    throw new SingularityFlowError('Auto Task Contract resolved to an empty repository scope.', {
      code: 'AUTO_TASK_SCOPE_EMPTY'
    });
  }
  const protectedScope = unique([
    ...(definition.governance?.protectedPaths ?? []),
    ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])
  ].map(normalizeScope));
  const forbiddenScope = unique([
    'singularity/workflow.yml', 'singularity/capabilities.yml',
    'singularity/templates/**', '.github/agents/**'
  ]);
  const recordCreatedAt = state.createdAt;
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
    // Match the model-runner audit boundary: this is the raw UTF-8 prompt digest, not the
    // canonical-JSON digest used for structured records.
    promptSha256: textDigest(modelPrompt),
    worldModelReference: state.worldModelReference ?? null,
    comprehensionReference: state.comprehensionReference ?? null
  };
  const sections = [{
    id: 'phase-authority',
    sourceRef: `sfref:auto-plan/${plan.planId}/phase/${phase.id}/authority`,
    contentSha256: digest(context),
    representation: 'digest-bound-authority',
    estimatedTokens: 0,
    mandatory: true
  }, {
    id: 'phase-prompt',
    sourceRef: `sfref:story/${state.story.workId}/phase/${phase.id}/generation/${generation}`,
    contentSha256: textDigest(modelPrompt),
    representation: 'exact-model-prompt',
    estimatedTokens: estimatedTokens(String(modelPrompt ?? '')),
    mandatory: true
  }, {
    id: 'acceptance-clauses',
    sourceRef: `sfref:auto-plan/${plan.planId}/acceptance-criteria`,
    contentSha256: digest(plan.proposal?.acceptanceCriteria ?? []),
    representation: 'full',
    estimatedTokens: estimatedTokens(plan.proposal?.acceptanceCriteria ?? []),
    mandatory: true
  }];
  if (state.worldModelReference) sections.push({
    id: 'world-model',
    sourceRef: `sfref:world-model/${state.worldModelReference.manifestSha256}`,
    contentSha256: digest(state.worldModelReference),
    representation: 'bounded-view', estimatedTokens: 0, mandatory: false
  });
  if (state.comprehensionReference) sections.push({
    id: 'comprehension',
    sourceRef: `sfref:comprehension/${state.comprehensionReference.packetSha256}`,
    contentSha256: digest(state.comprehensionReference),
    representation: 'bounded-packet', estimatedTokens: 0, mandatory: false
  });
  const contextManifest = buildAutoContextManifest({
    flightId: state.flightId, attemptId, phase: phase.id, sections,
    omitted: [
      ...(!state.worldModelReference
        ? [{ id: 'world-model', reason: 'unavailable-or-not-required' }] : []),
      ...(!state.comprehensionReference
        ? [{ id: 'comprehension', reason: 'unavailable-or-observe-only' }] : [])
    ],
    expansionPolicySha256: digest({
      policy: 'ratified-scope-only', automaticExpansion: false
    }),
    budgetSha256: digest(plan.execution?.ceilings ?? {}), createdAt: recordCreatedAt
  });
  const taskContract = buildAutoAgentTaskContract({
    flightId: state.flightId, attemptId, phase: phase.id,
    objective: plan.requirement?.text,
    acceptanceClauses: plan.proposal?.acceptanceCriteria ?? [],
    readScope, writeScope, protectedScope, forbiddenScope,
    allowedTools: [...AUTO_AUTHORING_TOOLS],
    requiredOutputs: unique([
      artifactPath ? 'phase-artifact' : null,
      ...(phase.requiredArtifact ? ['configured-phase-artifact'] : []),
      ...(predictedScope.length ? ['repository-change-set'] : [])
    ]),
    requiredEvidence: plan.proposal?.acceptanceCriteria ?? [],
    budgets: {
      maximumTouchedPaths: plan.execution.ceilings.maximumTouchedPaths,
      maximumTouchedChanges: plan.execution.ceilings.maximumTouchedChanges,
      maximumModelInvocations: plan.execution.ceilings.maximumModelInvocations,
      maximumTotalTokens: plan.execution.ceilings.tokenBudget.maximum,
      tokenAssurance: plan.execution.ceilings.tokenBudget.assurance
    },
    stopConditions: [
      'protected-path', 'scope-expansion', 'architecture-choice',
      'credential-required', 'budget-exceeded', 'unknown-tool-result'
    ],
    createdAt: recordCreatedAt
  });
  const executionUnit = {
    protocol: 'auto-execution-unit-v1',
    provider: provider.provider,
    model: provider.model ?? 'auto',
    task,
    toolScopeProtocol: 'path-v1',
    readScopeSha256: digest(readScope),
    writeScopeSha256: digest(writeScope),
    allowedTools: [...AUTO_AUTHORING_TOOLS]
  };
  const executionSelection = buildAutoExecutionSelection({
    flightId: state.flightId, attemptId, phase: phase.id,
    executionUnitId: provider.provider,
    manifestSha256: state.executionUnit?.manifestSha256 ?? digest(executionUnit),
    reason: state.executionUnit?.id
      ? 'flight-pinned-execution-unit' : `approved-default-for-${phase.id}`,
    createdAt: recordCreatedAt
  });
  const contract = {
    attemptId,
    generation,
    generationIntentId: context.generationIntentId,
    contextContractSha256: contextManifest.manifestSha256,
    taskContractSha256: taskContract.contractSha256,
    executionUnitContractSha256: digest(executionUnit),
    executionSelectionSha256: executionSelection.selectionSha256,
    contextManifest,
    taskContract,
    executionSelection,
    allowedTools: [...AUTO_AUTHORING_TOOLS]
  };
  contract.contractSha256 = digest(contract);
  return validateAutoPhaseContractSnapshot(contract, { flightId: state.flightId });
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
  const validatedNext = validateAutoPhaseContractSnapshot(next);
  if (!existing) return validatedNext;
  const validatedExisting = validateAutoPhaseContractSnapshot(existing);
  if (validatedExisting.generation === validatedNext.generation
      && validatedExisting.contractSha256 === validatedNext.contractSha256) {
    return validatedExisting;
  }
  throw new SingularityFlowError(
    `Auto phase contract for '${phaseId}' changed after its execution unit was pinned.`,
    {
      code: 'AUTO_PLAN_AMENDMENT_REQUIRED',
      details: {
        phase: phaseId,
        expected: validatedExisting.contractSha256,
        actual: validatedNext.contractSha256,
        expectedGeneration: validatedExisting.generation,
        actualGeneration: validatedNext.generation
      }
    }
  );
}
