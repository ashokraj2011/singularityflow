import { copyFile, lstat, mkdir, readFile, readlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  SingularityFlowError, exists, invariant, nowIso, posix, readJson, repoRelative,
  run, secureRepositoryPath, snapshot, stateFingerprint, truncate, writeJson, writeText
} from './util.mjs';
import {
  branch, changedFiles, head, identity, pushBranch, pushCommitToBranch, remoteContains, untrackedFiles
} from './git.mjs';
import {
  WORKFLOW_PATH, loadDefinition, normalizeArtifactTemplateCompatibility, normalizeSequenceGates,
  normalizeSessionPolicy, renderArtifactTemplate, resolveWorkType, snapshotResolution
} from './config.mjs';
import { loadSession } from './session.mjs';
import { buildArtifactSidecar, serializeArtifactSidecar, sidecarRelativePath } from './artifact-sidecar.mjs';
import { createAgentBriefs, planAgentBriefs, verifyAgentBriefsForReview } from './agent-briefs.mjs';
import {
  applyInputsBlock, collectInputs, recordInputs, renderInputsBlock, resolvedPhaseInputs, workflowInputsMode
} from './inputs.mjs';
import { prepareRemoteOutputs, updateRemoteOutputRenderedHashes } from './agents.mjs';
import {
  assertPhaseSequence, enforceSequenceGate, phaseNeedsGeneration
} from './sequence.mjs';
import { verifyGroundingRecord } from './grounding.mjs';
import { answeredMarkerHashes, verifyClarificationRecord } from './clarifications.mjs';
import {
  artifactSetDiff, catalogArtifactSet, disclosureLines, memberRoot, resolvedArtifactSet
} from './artifact-sets.mjs';
import {
  citedArticleIds, constitutionIndex, constitutionPin, loadConstitution, validateCitations
} from './constitution.mjs';
import {
  evaluateApprovalChecklist, evaluateSpecificationGate, markerSummary,
  resolvedSpecificationQualityPolicy
} from './specification-gate.mjs';
import { beginTelemetryCapture, collectCopilotUsage, recordPhaseTelemetry } from './telemetry.mjs';
import { contextBoundaryHandoff, normalizeContextPolicy } from './context-policy.mjs';
import {
  approvalRequirementsMet, assertApprovalPolicyAttainable, DEFAULT_APPROVAL_AUTHORITY, normalizeApprovalAuthorities,
  normalizeApprovalSecurity, remainingRequiredAuthorities, requireApprovalAuthority
} from './approval-authority.mjs';
import { assertSourceBoundary, normalizeSourceBoundary } from './source-boundary.mjs';
import {
  evaluateCodeDeliveryPreflight, phaseRequiresCodeDelivery, resolveDeliveryQualityCommands,
  verifyCodeDeliveryReceipt
} from './delivery-evidence.mjs';
import { pinCodeDeliveryTask } from './code-delivery-policy.mjs';
import {
  beginCodeGeneration, consumeGenerationIntent, persistGenerationPublicationRecord,
  publishedGenerationCommit, verifyOpenGenerationIntent
} from './generation-boundary.mjs';
import { blockingConformanceVerdicts } from './conformance-verdicts.mjs';
import { runQualityCommand } from './quality-command-runner.mjs';
import { createLedgerIntent, ledgerLog, ledgerStatus, reconcileLedger } from './ledger.mjs';
import { normalizeLedgerConfig } from './ledger-config.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import {
  applyCapabilityPolicyToWorkResolution,
  assertCapabilitySource,
  capabilityWorldModelGrounding,
  materializeCapabilityWorldModelPack,
  resolveLifecycleCapability
} from './capability-context.mjs';
import { worldModelDisabledForWorkflow } from './intelligence-policy.mjs';
import { buildRepositorySubjectIndex, resolveContext } from './repository-subject-index.mjs';
import {
  clearPendingPublication,
  hasPendingPublication,
  livePreparedPublicationOwner,
  localPendingPublicationPath,
  readPendingPublication,
  recoverPreparedPublication,
  writePendingPublication,
} from './publication-pending.mjs';
import { restorePublicationPreimage } from './publication-recovery.mjs';
import { publishCapabilityRepositories } from './capability-start.mjs';
import { lifecycleEvent, recordPublicationProjection } from './lifecycle-event.mjs';
import { publishLifecycleChange } from './publication-unit-of-work.mjs';
import { deliverLifecycleNotifications, warnNotificationFailures } from './notifications.mjs';
import { readConfigurationSource } from './configuration-branch.mjs';
import { buildDesignSourceSet, classifyDesignSourceCandidates, approvedDesignSourceBinding } from './design-sources.mjs';
import { verifyMcpEvidence, verifyPhaseMcpRequirements } from './mcp-evidence.mjs';
import { assertMcpPhaseReadiness } from './mcp-readiness.mjs';
import { assertVisualCoverage } from './visual-coverage.mjs';
import { buildSpecIndex, loadActiveSpecRecords, predecessorSpecClauses } from './specifications.mjs';
import {
  hydrateImpactPlan, impactImplementationGate, initializeStoryImpact, invalidateImpactReceipt
} from './impact.mjs';
import { evaluateQuickFixWaiver } from './quick-fix-policy.mjs';
import {
  closeWorkInterval, ensureWorkIntervalBaseline, isApplicationChangePath, isApplicationPath, isGeneratedOutputPath, phaseUsesWorkInterval, reconcileWorkInterval, recordFinalReconciliation
} from './work-intervals.mjs';
import { operationContext } from './operation-context.mjs';
import { evaluateExternalCommandForModelMode, externalCommandText } from './external-command-policy.mjs';
import { assertProducerAllowed } from './manual-authorship.mjs';
import { consumeRepairAttempt, repairBudgetPhaseForRejection } from './repair-budget.mjs';
import { normalizeMcpTargetOrigin } from './mcp-target.mjs';
import {
  assertAstLifecycleGate, evaluateAstLifecycleGate, persistAstLifecycleReceipt,
  requireAstLifecycleReceipt
} from './ast-lifecycle.mjs';
import {
  evaluateChangeFlightPlanBoundary, persistChangeFlightPlanBoundary
} from './change-flight-plan.mjs';
import { normalizeTokenEconomy } from './token-economy.mjs';
import { canonicalJson } from './records.mjs';
import {
  buildTestExecutionReceipt, normalizeRequiredTestCommand, parseTestResult, resolveAffectedModule,
  testReceiptPassing
} from './code-delivery-tests.mjs';
import { repositoryCaseInsensitivePaths } from './repository-change-set.mjs';
import {
  artifactFindingMessage, authoredArtifactFingerprint, authoredArtifactText,
  inspectRequiredArtifactContent, requiredArtifactRepoPath,
  validateRequiredArtifactContent as validateRequiredArtifactContentPreflight
} from './publication-preflight.mjs';

export const CONFIG_PATH = WORKFLOW_PATH;
export const loadConfig = loadDefinition;
const DEFAULT_QUALITY_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const MODEL_ASSURANCE_RANK = Object.freeze({
  unavailable: 0, 'host-observed': 1, 'provider-reported': 2, 'policy-selected': 3
});

function requiredModelAssuranceRank(value) {
  return ({ unavailable: 0, observed: 1, 'provider-reported': 2, 'policy-selected': 3 })[value] ?? 1;
}

export function validateId(config, id) {
  if (!id || id === '.' || id === '..' || id.includes('/') || id.includes('\\')) throw new SingularityFlowError('Work ID must be one safe identifier without slashes.');
  if (!(new RegExp(config.idPattern ?? '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')).test(id)) throw new SingularityFlowError(`Work ID ${id} does not match ${config.idPattern}.`);
  const reserved = new Set(['main', 'master', String(config.defaultBaseBranch ?? '').trim()].filter(Boolean));
  if (reserved.has(id)) {
    throw new SingularityFlowError(`Work ID '${id}' is reserved for application integration and cannot identify governed work.`);
  }
}

export function workDir(root, config, id) { return path.join(root, config.workItemRoot ?? 'singularity/work-items', id); }
export function workDirRelative(config, id) { return posix(path.join(config.workItemRoot ?? 'singularity/work-items', id)); }
export function workflowPath(root, config, id) { return path.join(workDir(root, config, id), 'workflow.json'); }
export function statusPath(root, config, id) { return path.join(workDir(root, config, id), 'STATUS.md'); }
export function sourcePath(root, config, id) { return path.join(workDir(root, config, id), 'source.json'); }
export function userStoryPath(root, config, id) { return path.join(workDir(root, config, id), 'USER-STORY.md'); }
export function approvalPath(root, config, id, phase) { return path.join(workDir(root, config, id), 'approvals', `${phase}.json`); }
export function decisionDir(root, config, id, phase) { return path.join(workDir(root, config, id), 'approvals', phase); }
export function pendingPublicationPath(root, _config, id) { return localPendingPublicationPath(root, 'story', id); }
function legacyPendingPublicationPath(root, config, id) { return path.join(workDir(root, config, id), 'publication-pending.json'); }
/**
 * @param migrate `false` for read-only callers. Migration deletes a tracked file, and the snapshot
 *   coordinator's did-anything-change check fails when a capture mutates the working tree — which
 *   made the first snapshot after an upgrade error out blaming a concurrent writer that never existed.
 */
export async function storyPublicationPending(root, config, id, { migrate = true } = {}) {
  return hasPendingPublication(root, {
    kind: 'story',
    id,
    legacyPath: legacyPendingPublicationPath(root, config, id),
    roots: { workItemRoot: config?.workItemRoot },
    migrate
  });
}

/**
 * The one identity string every governed record uses.
 *
 * Exported because a second surface needed it and the alternative was a second copy of the
 * precedence rule — the kind of duplication that stays correct until someone adds a field.
 */
export function actorKey(actor) { return actor.login ?? actor.email ?? actor.name; }

function workflowPublicationMode(config, workflow) {
  const configured = config.git?.publish ?? 'required';
  const capability = workflow.resolution?.capability?.policy?.gitPublication;
  if (configured === 'required' || capability === 'required') return 'required';
  if (capability === 'warn') return 'warn';
  return configured;
}

export function workflowBranchNames(workflow) {
  return [...new Set([
    workflow.workItem.branch,
    workflow.lineage?.canonicalBranch,
    ...(workflow.lineage?.childBranches ?? []).map((entry) => entry.name)
  ].filter(Boolean))];
}

export function workflowBranchAllowed(workflow, branchName) {
  return workflowBranchNames(workflow).includes(branchName);
}

export function workflowPublicationBranch(root, workflow) {
  const current = branch(root);
  if (!workflowBranchAllowed(workflow, current)) {
    throw new SingularityFlowError(`Branch '${current}' is not registered for Story '${workflow.workItem.id}'. Run singularity-flow story branch attach --parent ${workflow.workItem.id}.`);
  }
  return current;
}

function markdownValue(value) {
  if (value == null || value === '') return '';
  if (Array.isArray(value)) return value.map((item) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n');
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `- ${key}: ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n');
  return String(value);
}

function sourceSection(label, value, fallback = null) {
  const text = markdownValue(value);
  return text || fallback ? `\n## ${label}\n\n${text || fallback}\n` : '';
}

function sourceMarkdown(source) {
  const details = [
    `- Source: ${source.type}`, source.url ? `- URL: ${source.url}` : null,
    source.targetOrigin ? `- Authorized POC target origin: ${source.targetOrigin}` : null,
    source.status ? `- Status: ${source.status}` : null,
    source.priority ? `- Priority: ${source.priority}` : null,
    source.storyPoints != null ? `- Story points: ${source.storyPoints}` : null,
    source.assignee ? `- Assignee: ${source.assignee}` : null
  ].filter(Boolean).join('\n');
  const subtasks = source.subtasks?.length ? source.subtasks.map((item) => `- ${item.key}${item.status ? ` [${item.status}]` : ''}${item.title ? ` — ${item.title}` : ''}`).join('\n') : '_None._';
  return `# ${source.key ?? source.id} — ${source.title}\n\n${details}\n`
    + sourceSection('User or audience', source.user ?? source.audience)
    + sourceSection('Description', source.description ?? source.problem, '_No description provided._')
    + sourceSection('Desired outcome', source.desiredOutcome)
    + sourceSection('Scope', source.scope)
    + sourceSection('Out of scope', source.outOfScope)
    + sourceSection('Stakeholders', source.stakeholders)
    + sourceSection('Priority and urgency', source.urgency ?? source.priority)
    + sourceSection('Constraints', source.constraints)
    + sourceSection('Dependencies', source.dependencies)
    + sourceSection('Acceptance criteria', source.acceptanceCriteria, '_Not provided._')
    + sourceSection('Risks', source.risks)
    + sourceSection('Notes', source.notes)
    + `\n## Subtasks\n\n${subtasks}\n`;
}

function phaseState(definition, index) {
  const requiredArtifact = structuredClone(definition.artifact);
  return {
    id: definition.id,
    label: definition.label,
    order: index,
    defaultAgent: definition.defaultAgent ?? null,
    status: index === 0 ? 'in_progress' : 'not_started',
    requiredArtifact,
    template: definition.template,
    worldModel: structuredClone(definition.worldModel ?? {}),
    writeScope: definition.writeScope ?? 'artifact-only',
    sourceBoundary: normalizeSourceBoundary(definition.sourceBoundary, definition.id),
    comparison: structuredClone(definition.comparison ?? {}),
    mcp: structuredClone(definition.mcp ?? { requiredServers: [], requireSmoke: false, evidence: [] }),
    repairBudget: structuredClone(definition.repairBudget ?? null),
    inputs: structuredClone(definition.inputs ?? []),
    generationPolicy: structuredClone(definition.generation ?? { requirement: 'required', producer: 'agent' }),
    approvalPolicy: structuredClone(definition.approval ?? { authorities: [DEFAULT_APPROVAL_AUTHORITY], minimum: 1, rejectTo: [definition.id] }),
    qualityCommands: [...(definition.qualityCommands ?? [])],
    startedAt: index === 0 ? nowIso() : null,
    submittedAt: null,
    approvedAt: null,
    approvedBy: null,
    rejectedAt: null,
    rejectedBy: null,
    rejectionReason: null,
    generation: 0,
    generatedBy: null,
    generatedAgent: null,
    authorship: [],
    usage: [],
    telemetry: [],
    approvals: [],
    designSourceSets: [],
    artifacts: [],
    checks: []
  };
}

export function storyArtifactMetadata(workflow, phase) {
  return {
    schemaVersion: 1,
    workId: workflow.workItem.id,
    workType: workflow.workItem.workType,
    phase: phase.id,
    generation: phase.generation,
    status: phase.status,
    generatedBy: phase.generatedBy,
    generatedAgent: phase.generatedAgent,
    authorship: [...(phase.authorship ?? [])].reverse().find((record) => record.generation === phase.generation) ?? {
      schemaVersion: 1, producer: 'legacy-unspecified', channel: 'legacy', governedAgentContext: null,
      kernelModel: { invoked: false, status: 'unavailable', invocationIds: [] },
      externalAiUse: { value: 'unknown', status: 'unavailable' }, source: null
    },
    sourceCommit: phase.sourceCommit ?? null,
    generationCommit: phase.generationCommit ?? null,
    publicationCommit: phase.publicationCommit ?? null,
    configSha256: workflow.resolution.configSha256,
    sourceSha256: workflow.resolution.sourceSha256 ?? null,
    template: workflow.resolution.templates[phase.id],
    inputs: phase.inputContext ?? null,
    designSources: {
      sets: phase.designSourceSets ?? [],
      approved: [...(phase.approvals ?? [])].reverse().find((approval) => !approval.invalidatedAt && approval.designSourceSet)?.designSourceSet ?? null
    },
    remoteAgent: phase.agentContext ?? null,
    clarification: [...(phase.clarifications ?? [])].reverse().find((record) => record.generation === phase.generation) ?? null,
    telemetry: phase.telemetry ?? [],
    remoteOutputs: (phase.remoteOutputs ?? []).map((output) => ({
      agent: output.agent,
      resource: output.resource,
      target: output.target,
      url: output.url,
      sourceSha256: output.sourceSha256,
      generation: output.generation
    })),
    usage: phase.usage,
    sequenceOverrides: (workflow.sequenceOverrides ?? []).filter((override) =>
      override.requestedPhase === phase.id || override.before?.currentPhase === phase.id),
    approvals: phase.approvals,
    selfApproval: phase.approvals.some((approval) => approval.selfApproval && !approval.invalidatedAt),
    conformanceTree: phase.conformanceTree ?? null
  };
}

export function artifactMetadataBlock(metadata) {
  return `<!-- singularity-flow:metadata\n${JSON.stringify(metadata, null, 2)}\n-->`;
}

async function updateArtifactMetadata(root, config, workflow, phase) {
  const file = path.join(workDir(root, config, workflow.workItem.id), phase.requiredArtifact.path);
  if (!(await exists(file))) return;
  const text = await readFile(file, 'utf8');
  const block = artifactMetadataBlock(storyArtifactMetadata(workflow, phase));
  const pattern = /^<!-- singularity-flow:metadata\n[\s\S]*?\n-->/;
  await writeText(file, pattern.test(text) ? text.replace(pattern, block) : `${block}\n\n${text}`);
}

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
    `- Overall status: **${workflow.status}**`,
    `- Current phase: **${workflow.currentPhase ?? (workflow.status === 'cancelled' ? 'cancelled and archived' : 'complete')}**`,
    ...(workflow.cancellation ? [
      `- Cancelled during: **${workflow.cancellation.phase}**`,
      `- Cancellation reason: ${workflow.cancellation.reason}`,
      `- Cancelled at: ${workflow.cancellation.cancelledAt}`
    ] : []), '',
    '| # | Phase | Governed agent | Status | Generation | Approvals | Tokens |',
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
  workflow.history.slice(-15).reverse().forEach((item) => lines.push(`- ${item.at} — **${item.event}**${item.phase ? ` (${item.phase})` : ''} by ${item.actor ?? 'unknown'}${item.agent ? ` · governed agent ${item.agent}` : ''}${item.detail ? `: ${item.detail}` : ''}`));
  if (workflow.sequenceOverrides?.length) lines.push('', `> ⚠ ${workflow.sequenceOverrides.length} confirmed soft sequence override(s) are recorded for this work item.`);
  return `${lines.join('\n')}\n`;
}

export async function saveWorkflow(root, config, workflow) {
  const file = workflowPath(root, config, workflow.workItem.id);
  await writeJson(file, workflow);
  await writeText(statusPath(root, config, workflow.workItem.id), storyStatusMarkdown(workflow));
  // Keep the aggregate's idea of what is on disk current. Every legitimate write by this process
  // goes through here, so refreshing the fingerprint means the publication check ahead can treat any
  // remaining mismatch as what it is: a different process writing the same work item.
  const tracked = workflow[Symbol.for('singularity-flow.state-revision')];
  if (tracked) tracked.stateSha256 = stateFingerprint(file);
}

export async function createWorkflow(root, config, {
  id, title, source, baseBranch, baseCommit = null, baseRemote = null,
  canonicalBranch = id, workType, agent, resolved, capabilityId = null,
  executionOrigin = null
} = {}) {
  validateId(config, id);
  if (branch(root) !== canonicalBranch) {
    throw new SingularityFlowError(`Current branch ${branch(root)} must match the canonical Story branch ${canonicalBranch}.`);
  }
  if (await exists(workflowPath(root, config, id))) throw new SingularityFlowError(`${id} already exists. Use singularity-flow resume ${id}.`);
  const selectedType = workType ?? Object.keys(config.workTypes)[0];
  const targetOrigin = normalizeMcpTargetOrigin(source?.targetOrigin, {
    required: selectedType === 'poc-workflow',
    label: 'POC target URL'
  });
  const capability = await resolveLifecycleCapability(root, { capabilityId });
  assertCapabilitySource(capability, source);
  const selectedResolution = resolved ?? resolveWorkType(config, selectedType);
  const resolution = applyCapabilityPolicyToWorkResolution(
    { ...selectedResolution, storage: structuredClone(config.storage ?? null) },
    capability
  );
  const snapshotState = await snapshotResolution(root, config, resolution);
  const creator = identity(root);
  const pinnedApprovalAuthorities = structuredClone(snapshotState.approvalAuthorities
    ?? resolution.approvalAuthorities
    ?? normalizeApprovalAuthorities(config.approvalAuthorities));
  if (normalizeApprovalSecurity(config.approvalSecurity ?? {}).autoEnrollNewIdentities) {
    const email = String(creator.email ?? '').trim().toLowerCase();
    const githubLogin = String(creator.login ?? creator.githubLogin ?? '').trim();
    for (const authority of Object.values(pinnedApprovalAuthorities)) {
      authority.members ??= [];
      const enrolled = authority.members.some((member) =>
        (email && String(member.email ?? '').trim().toLowerCase() === email)
        || (githubLogin && String(member.githubLogin ?? '').trim().toLowerCase() === githubLogin.toLowerCase()));
      if (!enrolled && (email || githubLogin)) {
        authority.members.push({
          name: String(creator.name ?? '').trim() || null,
          email: email || null,
          githubLogin: githubLogin || null
        });
      }
    }
  }
  for (const phase of resolution.phases) {
    assertApprovalPolicyAttainable(pinnedApprovalAuthorities, phase.approval, phase.id);
  }
  snapshotState.configurationSource = await readConfigurationSource(root, { verify: true });
  // Benchmark B is an explicit generic control. A stricter capability policy must not silently
  // re-introduce world-model context into that arm; every other work type retains normal merging.
  snapshotState.worldModelGrounding = resolution.intelligence?.worldModel === 'off'
    ? 'off'
    : capabilityWorldModelGrounding(snapshotState.worldModelGrounding, capability);
  snapshotState.worldModelStaleness = resolution.worldModelStaleness ?? config.worldModel?.staleness ?? 'warn';
  snapshotState.storage = structuredClone(resolution.storage ?? null);
  snapshotState.capability = capability;
  /**
   * Pin the constitution this Story is held to `[SPK:REQ-091]`.
   *
   * Pinned once, here, and never refreshed: `[SPK:CON-039]` says an active Story keeps its pinned
   * constitution while `sflow/config` advances, so the rules someone is judged against are the ones
   * that were in force when they started. Refusing an integrity problem at *start* rather than
   * later is the same reasoning — a Story should not begin under a constitution that already
   * disagrees with itself.
   */
  if (resolution.constitution?.mode !== 'off') {
    const constitution = await loadConstitution(root, resolution.constitution.path, { resolution });
    if (!constitution) {
      if (resolution.constitution.mode === 'enforce') {
        throw new SingularityFlowError(
          `Work type '${selectedType}' requires a constitution at ${resolution.constitution.path} and none exists. `
          + 'Copy examples/constitution/constitution.md there, replace the sample articles, and run singularity-flow constitution generate.'
        );
      }
      console.warn(`Warning: no constitution at ${resolution.constitution.path}; this Story pins none.`);
    } else {
      const blocking = constitution.findings.filter((finding) => ['hand-edited', 'stale-policy', 'judged-prose-changed', 'unresolved-policy'].includes(finding.kind));
      if (blocking.length && resolution.constitution.mode === 'enforce') {
        throw new SingularityFlowError(`The constitution at ${constitution.path} is not consistent with the approved policy:\n- ${blocking.map((finding) => finding.message).join('\n- ')}`);
      }
      constitution.findings.forEach((finding) => console.warn(`Warning: constitution ${finding.kind}: ${finding.message}`));
      snapshotState.constitutionPin = constitutionPin({
        constitution,
        index: constitutionIndex({
          articles: constitution.articles, path: constitution.path, fileSha256: constitution.fileSha256,
          configurationCommit: snapshotState.configurationSource?.commit ?? null, resolution
        }),
        configurationCommit: snapshotState.configurationSource?.commit ?? null,
        resolution
      });
    }
  }
  const actor = creator;
  const phases = resolution.phases.map(phaseState);
  const createdAt = nowIso();
  const workflow = {
    schemaVersion: currentSchemaVersion('story-workflow'),
    ...(executionOrigin ? { executionOrigin: structuredClone(executionOrigin) } : {}),
    mcpAuthorizations: targetOrigin ? {
      playwright: { schemaVersion: currentSchemaVersion('mcp-authorization'), origins: [targetOrigin], source: 'story-intake', pinnedAt: createdAt }
    } : {},
    workItem: {
      id, title: title || id, workType: selectedType, workTypeLabel: resolution.label,
      branch: branch(root), baseBranch,
      ...(baseCommit ? { baseCommit } : {}),
      ...(baseRemote ? { baseRemote } : {}),
      createdAt, createdBy: actor, source: {
      type: source.type,
      stableId: source.stableId ?? null,
      key: source.key ?? null,
      rawRef: source.rawRef ?? null,
      url: source.url ?? null,
      fetchedAt: source.fetchedAt ?? null,
      contentSha256: source.contentSha256 ?? null,
      risk: source.risk ?? null,
      repositoryCount: source.repositoryCount ?? 1,
      publicInterfaceChange: source.publicInterfaceChange ?? null,
      dataMigration: source.dataMigration ?? null,
      securityBoundaryChange: source.securityBoundaryChange ?? null,
      regulatedDataChange: source.regulatedDataChange ?? null,
      targetOrigin,
      deploymentPolicyChange: source.deploymentPolicyChange ?? null,
      crossRepositoryChange: source.crossRepositoryChange ?? null
      }
    },
    lineage: {
      schemaVersion: currentSchemaVersion('story-lineage'),
      canonicalBranch: branch(root),
      parentStoryId: id,
      epicId: source.epicId ?? source.parent?.key ?? null,
      planId: source.planId ?? null,
      jiraIssueId: source.id ?? null,
      sourceStableId: source.stableId ?? null,
      initialJiraKey: source.key ?? (source.type === 'jira' ? id : null),
      currentJiraKey: source.key ?? (source.type === 'jira' ? id : null),
      branchCompletionPolicy: source.branchCompletionPolicy ?? 'pr',
      requiredChecks: [...new Set([
        ...(source.requiredChecks ?? []),
        ...(capability?.policy?.requiredChecks ?? [])
      ])],
      childBranches: []
    },
    resolution: {
      ...snapshotState,
      workType: selectedType,
      workTypeLabel: resolution.label,
      approvalAuthorities: structuredClone(pinnedApprovalAuthorities),
      sequenceGates: snapshotState.sequenceGates ?? resolution.sequenceGates ?? { default: 'hard' },
      documents: structuredClone(resolution.documents ?? config.documents ?? {}),
      collaboration: structuredClone(config.collaboration ?? { assignmentMode: 'off', notifications: ['terminal'] }),
      session: normalizeSessionPolicy(config.session ?? {}),
      contextPolicy: snapshotState.contextPolicy ?? normalizeContextPolicy(config.contextPolicy ?? {}, { phaseIds: Object.keys(config.phases ?? {}) }),
      tokenEconomy: structuredClone(snapshotState.tokenEconomy ?? normalizeTokenEconomy(config.tokenEconomy ?? {})),
      ledger: structuredClone(snapshotState.ledger ?? normalizeLedgerConfig(config.ledger ?? {})),
      sourceSha256: createHash('sha256').update(`${JSON.stringify(source, null, 2)}\n`).digest('hex'),
      phases: resolution.phases
    },
    status: 'in_progress',
    currentPhase: phases[0]?.id ?? null,
    phaseOrder: phases.map((phase) => phase.id),
    phases: Object.fromEntries(phases.map((phase) => [phase.id, phase])),
    usage: {
      mode: config.tokens?.mode ?? 'exact-or-unavailable', totalTokens: 0, records: 0,
      exactRecords: 0, unavailableRecords: 0, byPhase: {}, byAgent: {}, byWorkType: {}, byWorkItem: {}
    },
    telemetry: { schemaVersion: currentSchemaVersion('work-item-telemetry'), mode: 'work-item-sanitized' },
    documents: { count: 0, updatedAt: null },
    collaboration: { assignments: {}, notifications: [] },
    sequenceOverrides: [],
    changeRequests: [],
    history: [{ at: createdAt, actor: actorKey(actor), agent: agent ?? null, event: 'work_started', phase: phases[0]?.id ?? null, detail: `Created ${selectedType} branch ${branch(root)}` }]
  };
  if (capability?.policy?.maxDocumentBytes) {
    workflow.resolution.documents.maxFileBytes = Math.min(
      workflow.resolution.documents.maxFileBytes ?? capability.policy.maxDocumentBytes,
      capability.policy.maxDocumentBytes
    );
  }
  if (capability && !worldModelDisabledForWorkflow(workflow)) {
    await mkdir(workDir(root, config, id), { recursive: true });
    const context = await materializeCapabilityWorldModelPack(root, capability, {
      itemDirectory: workDir(root, config, id),
      itemRelative: workDirRelative(config, id),
      views: [...new Set(resolution.phases.flatMap((phase) => phase.worldModel?.views ?? []))]
    });
    workflow.resolution.capability = { ...capability, context };
  }
  await initializeStoryImpact(root, config, workflow, source);
  for (const [phaseId, template] of Object.entries(workflow.resolution.templates ?? {})) {
    if (template.source !== 'agent' || !template.cachePath) continue;
    const destination = path.join(workDir(root, config, id), 'context/agent-templates', template.agent, `${template.resource}-${template.sha256}.md`);
    await mkdir(path.dirname(destination), { recursive: true }); await copyFile(template.cachePath, destination);
    template.path = posix(path.relative(root, destination)); delete template.cachePath;
    workflow.resolution.phases.find((phase) => phase.id === phaseId).templateSnapshot = { ...template };
  }
  await writeJson(sourcePath(root, config, id), source);
  await writeText(userStoryPath(root, config, id), sourceMarkdown(source));
  await writeText(path.join(workDir(root, config, id), 'README.md'), `# ${id} — ${workflow.workItem.title}\n\nDurable ${selectedType} workflow state for branch \`${id}\`.\n\n- [workflow.json](./workflow.json) — machine state\n- [STATUS.md](./STATUS.md) — human status\n- [source.json](./source.json) — source context\n- [USER-STORY.md](./USER-STORY.md) — ${source.type === 'jira' ? 'Jira' : 'manual'} story snapshot\n- [documents.json](./documents.json) — supporting-document catalog (created on first upload)\n- [inputs/](./inputs/) — uploaded files (created on first upload)\n- [context/](./context/) — per-generation prompt-grounding audit records\n- [telemetry/](./telemetry/) — sanitized per-generation model, token, and cost records\n- [artifacts/](./artifacts/) — generated phase artifacts\n- [approvals/](./approvals/) — append-only decisions\n`);
  await ensureWorkIntervalBaseline(root, config, workflow, {
    phaseId: phases[0]?.id,
    itemDirectory: workDir(root, config, id),
    itemRelative: workDirRelative(config, id)
  });
  await saveWorkflow(root, config, workflow);
  await preparePhase(root, config, workflow, phases[0]?.id);
  await saveWorkflow(root, config, workflow);
  return workflow;
}

function normalizeCurrentWorkflow(workflow) {
  workflow = readRecord('story-workflow', workflow).record;
  const missing = [
    ['resolution', workflow.resolution],
    ['resolution.session', workflow.resolution?.session],
    ['resolution.contextPolicy', workflow.resolution?.contextPolicy],
    ['resolution.sequenceGates', workflow.resolution?.sequenceGates],
    ['lineage', workflow.lineage],
    ['usage', workflow.usage],
    ['telemetry', workflow.telemetry]
  ].filter(([, value]) => value == null).map(([name]) => name);
  if (missing.length) {
    throw new SingularityFlowError(`Story workflow schema 2 is incomplete (${missing.join(', ')}). Run singularity-flow factory-reset and recreate the Story.`);
  }
  workflow.resolution.session = normalizeSessionPolicy(workflow.resolution.session);
  workflow.resolution.contextPolicy = normalizeContextPolicy(workflow.resolution.contextPolicy);
  workflow.lineage.childBranches ??= [];
  workflow.documents ??= { count: 0, updatedAt: null };
  workflow.collaboration ??= { assignments: {}, notifications: [] };
  workflow.collaboration.assignments ??= {};
  workflow.collaboration.notifications ??= [];
  workflow.sequenceOverrides ??= [];
  workflow.changeRequests ??= [];
  workflow.repairBudgets ??= {};
  workflow.workIntervals ??= { schemaVersion: 1, current: null, history: [], escalations: [] };
  workflow.workIntervals.history ??= [];
  workflow.workIntervals.escalations ??= [];
  workflow.usage.exactRecords ??= 0; workflow.usage.unavailableRecords ??= 0;
  workflow.usage.byPhase ??= {}; workflow.usage.byAgent ??= {}; workflow.usage.byWorkType ??= {}; workflow.usage.byWorkItem ??= {};
  for (const id of workflow.phaseOrder) {
    const phase = workflow.phases[id];
    if (phase.owner != null || phase.suggestedAgents != null) throw new SingularityFlowError(`Workflow phase '${id}' contains removed role-selection state. Recreate this development work item with the current agent-only workflow.`);
    phase.defaultAgent ??= workflow.resolution.phases?.find((item) => item.id === id)?.defaultAgent ?? null;
    phase.approvalPolicy ??= { authorities: [DEFAULT_APPROVAL_AUTHORITY], minimum: 1, rejectTo: [id] };
    phase.approvalPolicy.mode ??= 'required';
    if (phase.approvalPolicy.mode !== 'none') phase.approvalPolicy.authorities ??= [DEFAULT_APPROVAL_AUTHORITY];
    phase.generationPolicy ??= workflow.resolution.phases?.find((item) => item.id === id)?.generation ?? { requirement: 'required', producer: 'agent' };
    phase.generationPolicy = pinCodeDeliveryTask(phase, 'generationPolicy');
    phase.mcp ??= structuredClone(workflow.resolution.phases?.find((item) => item.id === id)?.mcp ?? { requiredServers: [], requireSmoke: false, evidence: [] });
    phase.repairBudget ??= structuredClone(workflow.resolution.phases?.find((item) => item.id === id)?.repairBudget ?? null);
    delete phase.approvalPolicy.agents;
    phase.writeScope ??= 'source-and-artifact'; phase.comparison ??= {};
    phase.sourceBoundary ??= normalizeSourceBoundary(
      workflow.resolution.phases?.find((item) => item.id === id)?.sourceBoundary,
      id
    );
    phase.inputs ??= workflow.resolution.phases?.find((item) => item.id === id)?.inputs ?? [];
    phase.remoteOutputs ??= [];
    phase.generation ??= phase.artifacts?.length ? 1 : 0;
    phase.usage ??= [];
    phase.telemetry ??= [];
    phase.approvals ??= [];
  }
  return workflow;
}

export async function loadWorkflow(root, config, id = undefined) {
  const index = await buildRepositorySubjectIndex(root, { definition: config });
  let selected = resolveContext(index, {
    reference: id ?? branch(root),
    kind: 'story',
    required: false
  });
  if (id == null && !selected) {
    const session = await loadSession(root, { required: false });
    if (session?.workId) selected = resolveContext(index, { reference: session.workId, kind: 'story', required: false });
  }
  if (!selected) {
    const requested = id ?? branch(root);
    // A state file that exists but will not parse is the likeliest reason a Story "does not exist",
    // and saying so is the difference between fixing a file and hunting for a missing directory.
    const unreadable = index.unreadable ?? [];
    throw new SingularityFlowError(
      `No workflow found for ${requested}. The repository subject index contains no matching Story ID or registered branch alias.`
      + (unreadable.length
        ? ` These state files exist but could not be read: ${unreadable.map((entry) => `${entry.path} (${entry.reason})`).join('; ')}.`
        : '')
    );
  }
  const file = path.join(root, selected.location.path);
  const workflow = normalizeCurrentWorkflow(await readJson(file));
  invariant(workflow.workItem?.id === selected.id, `Workflow ID does not match indexed Story ${selected.id}.`);
  if (id == null && !workflowBranchAllowed(workflow, branch(root))) {
    throw new SingularityFlowError(`Current branch '${branch(root)}' is not registered for Story '${workflow.workItem.id}'. Run singularity-flow story branch attach --parent ${workflow.workItem.id}.`);
  }
  return workflow;
}

export async function resolveWorkItem(root, config, idOrRef = branch(root), { mutation = false, creation = false } = {}) {
  const requested = String(idOrRef ?? '').trim();
  if (!requested) throw new SingularityFlowError('Enter a Work ID or canonical/child branch reference.');
  const index = await buildRepositorySubjectIndex(root, { definition: config });
  const indexed = resolveContext(index, { reference: requested, kind: 'story', required: false });
  if (indexed) {
    const workflow = normalizeCurrentWorkflow(indexed.state);
    return {
      workId: workflow.workItem.id,
      branch: indexed.canonicalBranch,
      selectedBranch: indexed.selectedBranch,
      workflow,
      source: indexed.source
    };
  }

  const ledgerConfig = normalizeLedgerConfig(config.ledger ?? {});
  if (ledgerConfig.enabled) {
    try {
      // Ledger bindings are evidence-only and never enter RepositorySubjectIndex. Keep their
      // mutation guard here, where the caller's requested access and the ledger source are both
      // explicit; a ref-backed lifecycle subject is materializable by resume and is not read-only.
      const entries = await ledgerLog(root, ledgerConfig, { limit: 1000000 });
      const binding = entries.find((entry) =>
        entry.eventType === 'binding'
        && (entry.subject?.workId === requested || entry.subject?.branch === requested));
      if (binding) {
        if (mutation) {
          throw new SingularityFlowError(`Work item '${binding.subject.workId}' is known only from the capability ledger. Fetch its lifecycle branch before mutating it.`);
        }
        return {
          workId: binding.subject.workId,
          branch: binding.subject.branch ?? binding.subject.workId,
          workflow: null,
          source: 'ledger',
          readOnly: true,
          entryHash: binding.hash
        };
      }
    } catch (error) {
      if (mutation || ledgerConfig.enforcement === 'required') {
        throw new SingularityFlowError(`Work-item binding cannot be verified from the capability ledger: ${error.message}`);
      }
    }
  }
  if (creation) return { workId: requested, branch: requested, workflow: null, source: 'creation-fallback' };
  throw new SingularityFlowError(`No governed Story matches '${requested}'. Use a creation command to reserve a new Work ID.`);
}

export function currentPhase(workflow) {
  if (!workflow.currentPhase) return null;
  const phase = workflow.phases[workflow.currentPhase];
  invariant(phase, `Unknown current phase ${workflow.currentPhase}.`);
  return phase;
}

export async function assertNoPendingPublication(root, config, workflow, action = 'continue') {
  if (await storyPublicationPending(root, config, workflow.workItem.id)) {
    await enforceSequenceGate(root, workflow, 'publicationPending', action, {
      reason: 'Publication is pending because a retained local lifecycle commit has not reached its configured remote.'
    });
  }
}

function requiredRepoPath(config, workflow, phase) { return requiredArtifactRepoPath(config, workflow, phase); }

/** The artifact's text, or empty when it is not there yet — a missing artifact is `validatePhase`'s. */
async function readArtifactText(root, relative) {
  const absolute = path.join(root, relative);
  return await exists(absolute) ? readFile(absolute, 'utf8') : '';
}


export async function preparePhase(root, config, workflow, requested = undefined) {
  const result = await preparePhaseInputs(root, config, workflow, requested);
  return result.path;
}

export async function beginPhaseGeneration(root, config, workflow, {
  phaseId = workflow.currentPhase,
  adoptExisting = false,
  confirm = null
} = {}) {
  await assertNoPendingPublication(root, config, workflow, 'begin code generation');
  const phase = await assertPhaseSequence(root, workflow, 'begin code generation', { requestedPhase: phaseId });
  if (!phaseRequiresCodeDelivery(phase)) {
    throw new SingularityFlowError(`Phase '${phase.id}' is not a code-generation phase.`, { code: 'GENERATION_INTENT_NOT_APPLICABLE' });
  }
  const itemDirectory = workDir(root, config, workflow.workItem.id);
  const itemRelative = workDirRelative(config, workflow.workItem.id);
  await ensureWorkIntervalBaseline(root, config, workflow, { phaseId: phase.id, itemDirectory, itemRelative });
  const session = await loadSession(root, { required: false });
  return beginCodeGeneration(root, config, workflow, phase, {
    adoptExisting,
    confirm,
    actor: session?.actor ?? null,
    agent: session?.agent ?? null
  });
}

export async function preparePhaseInputs(root, config, workflow, requested = undefined, {
  dryRun = false
} = {}) {
  if (!dryRun) await assertNoPendingPublication(root, config, workflow, 'prepare or change phase inputs');
  const phase = await assertPhaseSequence(root, workflow, 'prepare', { requestedPhase: requested });
  const explicitlyReopened = (workflow.changeRequests ?? []).some((request) =>
    request.status === 'open' && request.targetPhase === phase.id)
    || (phase.intentAmendmentRevalidation && !phase.intentAmendmentRevalidation.revalidatedAt);
  if (!dryRun
      && phaseRequiresCodeDelivery(phase)
      && phase.generationIntent?.status === 'consumed'
      && Number(phase.generationIntent.generation) === Number(phase.generation)
      && !explicitlyReopened) {
    throw new SingularityFlowError(
      `Phase '${phase.id}' generation ${phase.generation} is already published. `
      + `Run singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json, `
      + 'then execute its exact phase-begin action before preparing the next generation.',
      { code: 'GENERATION_INTENT_ALREADY_CONSUMED' }
    );
  }
  await assertMcpPhaseReadiness(root, workflow, phase);
  await hydrateImpactPlan(root, workflow);
  const impactGate = impactImplementationGate(workflow, phase.id);
  if (impactGate) throw new SingularityFlowError(impactGate);
  const itemDirectory = workDir(root, config, workflow.workItem.id);
  const itemRelative = workDirRelative(config, workflow.workItem.id);
  if (!dryRun) {
    await ensureWorkIntervalBaseline(root, config, workflow, {
      phaseId: phase.id,
      itemDirectory,
      itemRelative
    });
  }
  const target = path.join(itemDirectory, phase.requiredArtifact.path);
  const artifactExistedBeforePreparation = await exists(target);
  const session = await loadSession(root, { required: false });
  const inputs = await collectInputs(root, workflow, phase, { itemDirectory, itemRelative });
  if (inputs.errors.length) throw new SingularityFlowError(`Phase ${phase.id} inputs are not ready:\n- ${inputs.errors.join('\n- ')}`);
  const rendered = renderInputsBlock(inputs);
  if (!dryRun) {
    if (phaseRequiresCodeDelivery(phase)) {
      if (phase.generationIntent?.status !== 'open') {
        await beginCodeGeneration(root, config, workflow, phase, {
          actor: session?.actor ?? null,
          agent: session?.agent ?? null,
          inputRenderedSha256: rendered.sha256
        });
      }
    } else await beginTelemetryCapture(root, workflow, phase);
  }
  const remote = dryRun ? { outputs: [], warnings: [] } : await prepareRemoteOutputs(root, workflow, phase, session, { itemDirectory });
  if (remote.outputs.length) {
    phase.remoteOutputs = [...(phase.remoteOutputs ?? []).filter((entry) => !remote.outputs.some((output) => output.resource === entry.resource && output.generation === entry.generation)), ...remote.outputs];
  }
  if (!dryRun) {
    let text;
    if (phase.generationPolicy?.producer === 'deterministic') {
      const paths = changedFiles(root).filter((file) => !file.startsWith('singularity/'));
      const checks = (phase.qualityCommands ?? []).length
        ? phase.qualityCommands.map((command, index) => `- \`${externalCommandText(command, index)}\``).join('\n')
        : '- No mandatory commands are configured for this phase.';
      const claims = Object.values(workflow.spec?.claims ?? {})
        .flatMap((value) => Array.isArray(value) ? value : [value])
        .filter(Boolean);
      text = [
        `# ${phase.label}`,
        '',
        '> Deterministically assembled by Singularity Flow. No model call was used.',
        '',
        '## Work item',
        '',
        `- ID: **${workflow.workItem.id}**`,
        `- Title: ${workflow.workItem.title}`,
        `- Work type: ${workflow.workItem.workType}`,
        `- Phase: ${phase.id}`,
        `- Source commit: \`${head(root)}\``,
        '',
        '## Changed paths',
        '',
        ...(paths.length ? paths.map((file) => `- \`${file}\``) : ['- No source paths are currently changed.']),
        '',
        '## Configured checks',
        '',
        checks,
        '',
        '## Specification claims',
        '',
        ...(claims.length ? claims.map((claim) => `- ${claim.id ?? claim.clauseId ?? 'claim'}: ${claim.verdict ?? claim.kind ?? 'recorded'}`) : ['- No clause claims are currently recorded.']),
        '',
        '## Governed inputs',
        '',
        rendered.text || '_No phase inputs are declared._',
        ''
      ].join('\n');
    } else if (artifactExistedBeforePreparation) {
      text = normalizeArtifactTemplateCompatibility(await readFile(target, 'utf8'), {
        id: workflow.workItem.id
      });
    }
    else text = await renderArtifactTemplate(root, config, workflow.resolution.phases.find((item) => item.id === phase.id), {
      id: workflow.workItem.id,
      title: workflow.workItem.title,
      workType: workflow.workItem.workType,
      inputs: rendered.text,
      templateSnapshot: workflow.resolution.templates?.[phase.id]
    });
    text = applyInputsBlock(text, rendered.text, inputs.mode);
    if (!/^<!-- singularity-flow:metadata\n[\s\S]*?\n-->/.test(text)) text = `${artifactMetadataBlock(storyArtifactMetadata(workflow, phase))}\n\n${text}`;
    await writeText(target, text);
    const targetGeneration = Number(phase.generation) + 1;
    // Capture only bytes the kernel itself just rendered. Capturing an existing generation-one
    // artifact after an upgrade or repeated prepare would redefine completed authoring as the
    // baseline and make a valid artifact fail until it changed again. Every path that actually
    // creates the template captures it, including the lower-level input-preparation path.
    if (!artifactExistedBeforePreparation
        && targetGeneration === 1
        && phase.generationPolicy?.producer !== 'deterministic'
        && phase.authoringBaseline?.generation !== targetGeneration) {
      const authored = authoredArtifactText(text);
      phase.authoringBaseline = {
        generation: targetGeneration,
        path: phase.requiredArtifact.path,
        fingerprint: authoredArtifactFingerprint(authored),
        bytes: Buffer.byteLength(authored)
      };
    }
    if (workflowInputsMode(workflow) !== 'off' && resolvedPhaseInputs(workflow, phase).length) {
      const recorded = await recordInputs(root, workflow, phase, inputs, { itemDirectory });
      phase.inputContext = { generation: inputs.generation, path: recorded.path, sha256: recorded.sha256, renderedSha256: recorded.record.renderedSha256, mode: inputs.mode };
      await updateArtifactMetadata(root, config, workflow, phase);
    }
    if (remote.outputs.length) {
      phase.agentContext = { agent: session.agent, generation: phase.generation + 1, outputs: remote.outputs.map((output) => output.resource), warnings: remote.warnings };
      await updateArtifactMetadata(root, config, workflow, phase);
      await updateRemoteOutputRenderedHashes(root, workflow, phase, { itemDirectory, generation: phase.generation + 1 });
    }
  }
  return { phase, path: posix(path.relative(root, target)), ...inputs, renderedSha256: rendered.sha256, remoteOutputs: remote.outputs, remoteWarnings: remote.warnings };
}

const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.clj', '.cljc', '.cljs', '.cpp', '.cs', '.css', '.ex', '.exs', '.fs',
  '.fsi', '.fsx', '.go', '.groovy', '.gsh', '.gvy', '.gy', '.h', '.hpp', '.html',
  '.java', '.js', '.jsx', '.kt', '.kts', '.lua', '.mjs', '.php', '.pl', '.proto',
  '.py', '.r', '.rb', '.rs', '.scala', '.scss', '.sh', '.sol', '.sql', '.swift',
  '.ts', '.tsx', '.vue', '.zig'
]);
export function inferKind(relativePath) {
  const value = relativePath.toLowerCase();
  if (value.includes('/implementation-spec')) return 'implementation-spec';
  if (value.includes('/spec-code-comparison')) return 'conformance-report';
  if (/(^|\/)(test|tests|spec|specs)(\/|$)/.test(value) || /\.(test|spec)\.[^.]+$/.test(value)) return 'test';
  if (SOURCE_EXTENSIONS.has(path.extname(value))) return 'code';
  if (/\.(md|mdx|txt|adoc|rst)$/.test(value)) return 'document';
  if (/\.(json|ya?ml|toml|ini|properties)$/.test(value)) return 'configuration';
  return 'file';
}

function artifactFor(phase, relativePath) { return phase.artifacts.find((item) => item.path === relativePath); }
export async function registerArtifact(root, workflow, candidate, { phaseId, kind } = {}) {
  const phase = await assertPhaseSequence(root, workflow, 'register artifacts', { requestedPhase: phaseId });
  const absolute = path.resolve(root, candidate); const relativePath = repoRelative(root, absolute);
  const info = await snapshot(absolute); const existing = artifactFor(phase, relativePath); const timestamp = nowIso();
  const record = { path: relativePath, kind: kind ?? inferKind(relativePath), status: 'pending', exists: info.exists, size: info.size, sha256: info.sha256, registeredAt: existing?.registeredAt ?? timestamp, updatedAt: timestamp };
  if (existing) Object.assign(existing, record); else phase.artifacts.push(record);
  phase.artifacts.sort((a, b) => a.path.localeCompare(b.path));
  return record;
}

function ignored(config, workflow, relativePath, { untracked = false } = {}) {
  if (untracked && isGeneratedOutputPath(relativePath)) return true;
  if ([WORKFLOW_PATH, 'singularity/config.json', 'singularity/worldmodel.json'].includes(relativePath)) return true;
  if (relativePath.startsWith('singularity/world-model/')) return true;
  if (['.git/', '.idea/', '.vscode/'].some((prefix) => relativePath.startsWith(prefix))) return true;
  const itemRoot = workDirRelative(config, workflow.workItem.id);
  return relativePath.startsWith(`${itemRoot}/`) && !relativePath.startsWith(`${itemRoot}/artifacts/`);
}

export async function scanArtifacts(root, config, workflow, phaseId = undefined) {
  await assertNoPendingPublication(root, config, workflow, 'scan or register artifacts');
  const phase = await assertPhaseSequence(root, workflow, 'scan artifacts', { requestedPhase: phaseId }); const records = [];
  const untracked = new Set(untrackedFiles(root));
  // `prepare` creates the required phase artifact on purpose. Calling that expected output an
  // "adopted" file makes the ordinary authoring path look like accidental scope expansion and, on
  // a failed publication retry, repeats the same alarming warning indefinitely. Still register it
  // below — it is governed evidence — but reserve the adoption warning for files the phase did not
  // explicitly declare.
  const requiredArtifact = requiredRepoPath(config, workflow, phase);
  const adopted = [];
  for (const file of changedFiles(root).filter((item) => !ignored(config, workflow, item, { untracked: untracked.has(item) }))) {
    records.push(await registerArtifact(root, workflow, file, { phaseId: phase.id }));
    if (untracked.has(file) && file !== requiredArtifact) adopted.push(file);
  }
  // Untracked files are registered on purpose: a brand-new source file is a legitimate part of a
  // source-and-artifact generation, and excluding it would silently drop real work from the governed
  // commit — a worse failure than including scratch. But this is also exactly how a stray notes file
  // or an un-ignored output directory becomes a phase artifact: committed, pinned, and attested by
  // the approval's `artifactSha256`. Name them, so adopting them is a decision rather than an
  // accident.
  if (adopted.length) {
    console.warn(`Warning: ${phase.id} is adopting ${adopted.length} untracked file(s) as governed artifacts:`);
    adopted.forEach((file) => console.warn(`  ${file}`));
    console.warn('Delete or .gitignore anything above that is not part of this change, then scan again.');
  }
  return records;
}

async function validatePhase(root, config, workflow, phase, { placeholders = true } = {}) {
  const errors = await validateRequiredArtifactContentPreflight(root, config, workflow, phase, { placeholders });
  const required = requiredRepoPath(config, workflow, phase);
  if (!errors.some((error) => error.startsWith('Required artifact missing:')) && !artifactFor(phase, required)) {
    errors.push(`Required artifact is not registered to ${phase.id}: ${required}`);
  }
  for (const artifact of phase.artifacts) {
    const current = await snapshot(path.join(root, artifact.path));
    if (current.exists !== artifact.exists || current.size !== artifact.size || current.sha256 !== artifact.sha256) errors.push(`Artifact changed after registration: ${artifact.path}. Run singularity-flow artifact scan.`);
  }
  /**
   * The bundle still has to be the bundle. `[SPK:CON-045]`
   *
   * The registered-artifact check above covers whatever someone chose to register. A set member is
   * owed whether or not it was registered — an unregistered `tasks.md` edited between publication
   * and submission would otherwise pass every check while the approval named a bundle that no
   * longer exists. Publication re-catalogues before this runs, so this can only fire on a change
   * made outside a generation.
   */
  if (phase.artifactSet?.bundleSha256) {
    const set = resolvedArtifactSet(config, workflow, phase);
    const current = set ? await catalogArtifactSet(root, workDirRelative(config, workflow.workItem.id), phase, set) : null;
    if (current && current.bundleSha256 !== phase.artifactSet.bundleSha256) {
      const moved = artifactSetDiff(phase.artifactSet, current).changed.map((member) => member.path);
      errors.push(`Artifact set '${current.setId}' changed after generation ${phase.artifactSet.generation}: ${moved.join(', ')}. Publish a new generation so the bundle and its approval agree.`);
    }
  }
  return errors;
}

function normalizeUsage(raw, session, generation = null) {
  const startedAt = raw?.startedAt ?? nowIso(); const completedAt = raw?.completedAt ?? nowIso();
  const inputExact = Number.isFinite(raw?.inputTokens);
  const outputExact = Number.isFinite(raw?.outputTokens);
  const totalExact = Number.isFinite(raw?.totalTokens);
  const status = ['exact', 'partial', 'unavailable'].includes(raw?.status)
    ? raw.status
    : inputExact && outputExact ? 'exact'
      : (inputExact || outputExact || totalExact) ? (totalExact ? 'exact' : 'partial') : 'unavailable';
  const usage = {
    status, source: raw?.source ?? (status !== 'unavailable' ? 'provider' : 'copilot-unavailable'),
    provider: raw?.provider ?? null, model: raw?.model ?? null,
    requestedModel: raw?.requestedModel ?? null,
    resolvedModel: raw?.resolvedModel ?? null,
    resolvedModelAssurance: raw?.resolvedModelAssurance ?? (raw?.resolvedModel ? 'host-observed' : 'unavailable'),
    inputTokens: raw?.inputTokens ?? null, outputTokens: raw?.outputTokens ?? null,
    cachedInputTokens: raw?.cachedInputTokens ?? null, cacheWriteInputTokens: raw?.cacheWriteInputTokens ?? null,
    totalTokens: raw?.totalTokens ?? (inputExact && outputExact ? raw.inputTokens + raw.outputTokens : null),
    providerCost: Number.isFinite(raw?.providerCost) ? raw.providerCost : null,
    costStatus: raw?.costStatus ?? (Number.isFinite(raw?.providerCost) ? 'exact' : 'unavailable'),
    observations: raw?.observations ? structuredClone(raw.observations) : undefined,
    spans: Number.isInteger(raw?.spans) ? raw.spans : null,
    startedAt, completedAt, agent: session.agent, generation
  };
  return usage;
}

function addUsageAggregate(workflow, phase, usage) {
  const increment = (collection, key) => {
    const aggregate = collection[key] ??= { records: 0, exactRecords: 0, unavailableRecords: 0, totalTokens: 0 };
    aggregate.records += 1;
    aggregate[usage.status === 'exact' ? 'exactRecords' : 'unavailableRecords'] += 1;
    aggregate.totalTokens += usage.totalTokens ?? 0;
  };
  workflow.usage.records += 1;
  workflow.usage[usage.status === 'exact' ? 'exactRecords' : 'unavailableRecords'] += 1;
  workflow.usage.totalTokens += usage.totalTokens ?? 0;
  increment(workflow.usage.byPhase, phase.id);
  increment(workflow.usage.byAgent, usage.agent);
  increment(workflow.usage.byWorkType, workflow.workItem.workType);
  increment(workflow.usage.byWorkItem, workflow.workItem.id);
}

function rebuildUsageAggregates(workflow) {
  workflow.usage = {
    mode: workflow.usage?.mode ?? 'exact-or-unavailable',
    totalTokens: 0,
    records: 0,
    exactRecords: 0,
    unavailableRecords: 0,
    byPhase: {},
    byAgent: {},
    byWorkType: {},
    byWorkItem: {}
  };
  for (const phaseId of workflow.phaseOrder) {
    const phase = workflow.phases[phaseId];
    for (const usage of phase.usage ?? []) addUsageAggregate(workflow, phase, usage);
  }
}

export async function sourceTreeHash(root) {
  const indexed = run('git', ['ls-files', '--stage', '-z'], { cwd: root }).stdout.split('\0').filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const [mode, object, stage] = line.slice(0, tab).split(' ');
      return { path: posix(line.slice(tab + 1)), mode, object, stage: Number(stage) };
    })
    .filter((entry) => entry.stage === 0 && isApplicationPath(entry.path));
  const unstaged = new Set(run('git', ['diff', '--name-only', '-z', 'HEAD', '--'], { cwd: root }).stdout.split('\0').filter(Boolean).map(posix));
  const byPath = new Map(indexed.map((entry) => [entry.path, entry]));
  for (const relative of untrackedFiles(root).filter((candidate) => isApplicationChangePath(candidate, { untracked: true }))) {
    byPath.set(relative, { path: relative, mode: null, object: null, stage: 0, untracked: true });
    unstaged.add(relative);
  }
  const manifest = [];
  const objectFormat = run('git', ['rev-parse', '--show-object-format'], { cwd: root }).stdout.trim() || 'sha1';
  const blobObject = (bytes) => createHash(objectFormat)
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest('hex');
  for (const entry of [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path))) {
    if (!entry.untracked && !unstaged.has(entry.path)) {
      manifest.push({ path: entry.path, mode: entry.mode, kind: entry.mode === '120000' ? 'symlink' : 'git-object', object: entry.object });
      continue;
    }
    const absolute = path.join(root, entry.path);
    const info = await lstat(absolute).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info) {
      // The final committed tree does not contain a deleted path. Omitting it now makes the
      // working-state manifest stable when Git commits the exact deletion a moment later.
      continue;
    } else if (info.isSymbolicLink()) {
      const target = Buffer.from(await readlink(absolute));
      manifest.push({
        path: entry.path, mode: '120000', kind: 'symlink',
        object: blobObject(target)
      });
    } else if (info.isFile()) {
      const bytes = await readFile(absolute);
      manifest.push({
        path: entry.path, mode: (info.mode & 0o111) ? '100755' : '100644', kind: 'git-object',
        object: blobObject(bytes)
      });
    } else {
      manifest.push({ path: entry.path, mode: String(info.mode), kind: 'non-regular', object: null });
    }
  }
  return `sha256:${createHash('sha256').update(canonicalJson(manifest)).digest('hex')}`;
}

export async function generationResultDigest(root, config, workflow, phase) {
  const declaredPaths = [...new Set([
    ...(phase.artifacts ?? []).map((entry) => entry.path),
    ...(phase.sidecars ?? []).map((entry) => entry.path),
    ...(phase.clarifications ?? []).filter((entry) => entry.generation === phase.generation).map((entry) => entry.path),
    ...(phase.agentBriefs ?? []).filter((entry) => entry.generation === phase.generation)
      .flatMap((entry) => [entry.path, entry.renderedPath]),
    ...(phase.astGates ?? []).filter((entry) => entry.generation === phase.generation).map((entry) => entry.path),
    ...(phase.telemetry ?? []).filter((entry) => entry.generation === phase.generation).map((entry) => entry.path),
    Number(phase.inputContext?.generation) === Number(phase.generation) ? phase.inputContext?.path : null,
    Number(phase.specIndex?.generation) === Number(phase.generation) ? phase.specIndex?.path : null,
    phase.deliveryEvidence?.receiptPath,
    phase.deliveryEvidence?.changeSetPath,
    phase.workIntervalReconciliation?.path
  ].filter(Boolean))].sort();
  const publicationFiles = [];
  for (const relative of declaredPaths) {
    const current = await snapshot(path.join(root, relative));
    publicationFiles.push({ path: relative, exists: current.exists, sha256: current.sha256, bytes: current.size });
  }
  return `sha256:${createHash('sha256').update(canonicalJson({
    sourceTreeSha256: await sourceTreeHash(root),
    publicationFiles,
    bindings: {
      phase: phase.id,
      generation: phase.generation,
      artifactSet: phase.artifactSet?.bundleSha256 ?? null,
      deliveryChangeSet: phase.deliveryEvidence?.changeSet?.digest ?? null,
      generationIntentId: phase.generationIntent?.id ?? null,
      generationStartSha256: phase.generationIntent?.receiptSha256 ?? null,
      generationBaseline: phase.generationIntent?.baseline ?? null
    }
  })).digest('hex')}`;
}

function assertRequiredAssignment(workflow, phase) {
  if (workflow.resolution?.collaboration?.assignmentMode === 'required' && !workflow.collaboration?.assignments?.[phase.id]) {
    throw new SingularityFlowError(`Phase '${phase.id}' requires an assignment. Run singularity-flow assign ${phase.id} <assignee> before publishing.`);
  }
}

export async function publishGeneration(root, config, workflow, {
  phaseId, usage: rawUsage, authorship = null, persist = true, publicationTransaction = null
} = {}) {
  await assertNoPendingPublication(root, config, workflow, 'publish a generation');
  const phase = await assertPhaseSequence(root, workflow, 'publish a generation', { requestedPhase: phaseId }); const session = await loadSession(root);
  if (phaseRequiresCodeDelivery(phase)
      && phase.generationIntent?.status === 'consumed'
      && Number(phase.generationIntent.generation) === Number(phase.generation)) {
    const digest = await generationResultDigest(root, config, workflow, phase);
    if (digest === phase.generationIntent.publication?.resultDigest) return phase;
    throw new SingularityFlowError(
      `Generation intent ${phase.generationIntent.id} was already consumed and the source or artifact bytes now differ. Begin a new generation intent before publishing again.`,
      { code: 'GENERATION_INTENT_ALREADY_CONSUMED' }
    );
  }
  const generationIntent = await verifyOpenGenerationIntent(root, workflow, phase);
  assertRequiredAssignment(workflow, phase);
  await assertMcpPhaseReadiness(root, workflow, phase);
  // Template completeness is a publication preflight, not a late transaction failure. In
  // particular, do this before `preparePhaseInputs` records context or the generation counter,
  // sidecars and telemetry begin to move. An untouched prepared template should cost the author one
  // clear correction, not leave a half-started generation that produces the same adoption warning
  // on every retry.
  // Use the same authored-byte boundary as manual import and recovery. Report every deterministic
  // authoring blocker together so a host can repair the artifact once instead of chasing one
  // first-error failure per retry.
  const contentFindings = await inspectRequiredArtifactContent(root, config, workflow, phase);
  if (contentFindings.length) {
    const required = requiredRepoPath(config, workflow, phase);
    throw new SingularityFlowError(
      `Phase ${phase.id} generation is not publishable:\n- ${contentFindings.map(artifactFindingMessage).join('\n- ')}\n`
      + `Complete ${required}, then run singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json. `
      + 'A Copilot host may re-author and retry publication once only after the artifact fingerprint changes.',
      {
        code: 'ARTIFACT_AUTHORING_INCOMPLETE',
        details: {
          findings: contentFindings,
          fingerprint: contentFindings.find((finding) => finding.fingerprint)?.fingerprint ?? null,
          retry: {
            skill: '/sf-phase', maximumAttempts: 1, requiresFingerprintChange: true,
            command: `singularity-flow phase publish ${phase.id} --authored governed-agent --channel copilot-host`
          }
        }
      }
    );
  }
  // A code-generation phase must deliver code and acceptance-mapped tests. This is deliberately
  // before prompt/input preparation and telemetry capture: an artifact-only attempt is a refused
  // preflight, not a half-started generation that has to be repaired in durable state.
  let deliveryPreflight = await evaluateCodeDeliveryPreflight(root, config, workflow, phase);
  // Execute the exact structured test command before consuming the generation intent. Submission
  // still reruns it against the committed generation, but command inference, test discovery, and
  // result-adapter incompatibility must be found while the current generation is still editable.
  // Otherwise the only way to repair a bad adapter is to mutate bytes after publication and enter
  // generation recovery for a failure the kernel could have detected earlier.
  if (deliveryPreflight) {
    await preflightCodeDeliveryTests(root, config, workflow, phase, deliveryPreflight);
    // Tests are repository-owned programs and may generate or rewrite files. Rebind delivery
    // evidence after they finish so publication never commits bytes that were absent from the
    // preflight change set or retains hashes for bytes the test command changed.
    deliveryPreflight = await evaluateCodeDeliveryPreflight(root, config, workflow, phase);
  }
  // Downstream briefs are derived later from the exact published bytes, but their authored
  // heading contract can be validated now. This keeps ambiguity, missing preserved sections, and
  // size-bound failures on the no-mutation side of the publication boundary.
  await planAgentBriefs(root, workflow, phase, {
    itemDirectory: workDir(root, config, workflow.workItem.id),
    itemRelative: workDirRelative(config, workflow.workItem.id),
    generation: phase.generation + 1
  });
  await preparePhaseInputs(root, config, workflow, phase.id);
  let effectiveAuthorship = authorship ?? {
    schemaVersion: currentSchemaVersion('artifact-authorship'), producer: 'legacy-unspecified', channel: 'legacy', actor: structuredClone(session.actor),
    governedAgentContext: session.agent ? { agentId: session.agent } : null,
    kernelModel: { invoked: false, status: 'unavailable', invocationIds: [] },
    externalAiUse: { value: 'unknown', status: 'unavailable' }, source: null
  };
  if (workflow.executionOrigin?.mode === 'auto') {
    effectiveAuthorship = {
      ...effectiveAuthorship,
      executionOrigin: structuredClone(workflow.executionOrigin)
    };
  }
  assertProducerAllowed(phase, effectiveAuthorship.producer);
  // Grounding and telemetry preserve the existing legacy behavior. Clarification is narrower:
  // only explicit governed-agent authorship proves that an interactive model path ran and must
  // therefore carry a generation-bound human response. Never guess that from legacy provenance.
  const modelAssisted = ['governed-agent', 'legacy-unspecified'].includes(effectiveAuthorship.producer);
  const clarificationRequired = effectiveAuthorship.producer === 'governed-agent';
  const grounding = modelAssisted
    ? await verifyGroundingRecord(root, config, workflow, phase, { agent: session.agent })
    : { warnings: [], errors: [] };
  grounding.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  if (grounding.errors.length) throw new SingularityFlowError(`Phase ${phase.id} grounding is not ready:\n- ${grounding.errors.join('\n- ')}`);
  const clarification = clarificationRequired
    ? await verifyClarificationRecord(root, config, workflow, phase, { groundingRecord: grounding.record })
    : { warnings: [], errors: [], record: null, path: null, sha256: null };
  clarification.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  if (clarification.errors.length) throw new SingularityFlowError(`Phase ${phase.id} clarification is not ready:\n- ${clarification.errors.join('\n- ')}`);
  const mcpEvidence = await verifyPhaseMcpRequirements(root, workflow, phase, {
    itemDirectory: workDir(root, config, workflow.workItem.id),
    targetGeneration: phase.generation + 1
  });
  if (mcpEvidence.errors.length) throw new SingularityFlowError(`Phase ${phase.id} MCP evidence is not ready:\n- ${mcpEvidence.errors.join('\n- ')}`, { code: 'MCP_EVIDENCE_REQUIRED' });
  // Code delivery has already evaluated protected paths and source boundaries against its one
  // baseline-aware, rename-aware RepositoryChangeSet. Reconstructing those facts from a name-only
  // dirty-tree list here would both disagree on committed changes and reintroduce rename bypasses.
  if (!deliveryPreflight) {
    const changed = changedFiles(root);
    const untracked = new Set(untrackedFiles(root));
    const protectedPaths = [...new Set([
      ...(config.governance?.protectedPaths ?? []),
      ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])
    ])];
    const caseInsensitivePaths = repositoryCaseInsensitivePaths(root);
    const comparePath = (value) => caseInsensitivePaths ? value.toLocaleLowerCase('en-US') : value;
    const protectedChange = protectedPaths.find((protectedPath) => changed.some((file) => {
      const candidate = comparePath(file);
      const guard = comparePath(protectedPath.replace(/\/$/, ''));
      return candidate === guard || candidate.startsWith(`${guard}/`);
    }));
    if (protectedChange) throw new SingularityFlowError(`Generation cannot modify protected process path: ${protectedChange}`);
    if ((phase.writeScope ?? 'artifact-only') === 'artifact-only') {
      const allowed = `${workDirRelative(config, workflow.workItem.id)}/artifacts/${phase.id}/`;
      const outside = changed.filter((file) => !ignored(config, workflow, file, { untracked: untracked.has(file) }) && !file.startsWith(allowed));
      if (outside.length) throw new SingularityFlowError(`Phase ${phase.id} is artifact-only; move these changes to implementation/verification: ${outside.join(', ')}`);
    } else {
      const allowedArtifact = `${workDirRelative(config, workflow.workItem.id)}/artifacts/${phase.id}/`;
      const sourceChanges = changed.filter((file) => !ignored(config, workflow, file, { untracked: untracked.has(file) }) && !file.startsWith(allowedArtifact));
      assertSourceBoundary(phase.sourceBoundary, sourceChanges, { phaseId: phase.id });
    }
  }
  /**
   * The specification gate `[SPK:REQ-065]`.
   *
   * Deliberately the last thing before the first mutation on line `phase.generation += 1`. A
   * blocking marker has to cost nothing but the answer — if an honest `[NEEDS CLARIFICATION: ...]`
   * left a half-published generation to unwind, the rational move would be to delete the question
   * and write a plausible sentence, which is precisely the behaviour the marker exists to prevent.
   *
   * Both policies default to `off`, so a Story that pinned neither reaches the same code it always
   * did and behaves identically.
   */
  const gate = await evaluateSpecificationGate(root, config, workflow, phase, {
    generation: phase.generation + 1,
    artifactRelativePath: requiredRepoPath(config, workflow, phase),
    namespace: (workflow.resolution?.spec ?? config.spec)?.namespace ?? null,
    pendingClarification: clarification.record
  });
  gate.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  if (gate.errors.length) {
    throw new SingularityFlowError(
      `Phase ${phase.id} is not publishable:\n- ${gate.errors.join('\n- ')}\n`
      + `Answer each question and record it with singularity-flow clarification record ${phase.id} --marker "<question>" --answer "..." before regenerating.`
    );
  }

  /**
   * Constitution citations `[SPK:REQ-101]`.
   *
   * Validated against the Story's **pin**, not the file on disk. An article added since the Story
   * started exists today and did not when the author wrote the citation, so accepting it would
   * record a reference to a rule nobody read. Checked here, beside the marker gate, so a citation
   * problem costs the same as a marker: the answer, and nothing else.
   */
  const citations = validateCitations(
    workflow.resolution?.constitutionPin ?? null,
    citedArticleIds(await readArtifactText(root, requiredRepoPath(config, workflow, phase))),
    { label: `Phase ${phase.id}` }
  );
  citations.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  if (citations.errors.length && (workflow.resolution?.constitution?.mode ?? 'off') === 'enforce') {
    throw new SingularityFlowError(`Phase ${phase.id} is not publishable:\n- ${citations.errors.join('\n- ')}`);
  }
  citations.errors.forEach((error) => console.warn(`Warning: ${error}`));

  const codeModelObservation = effectiveAuthorship.kernelModel?.observations
    ?.find((observation) => observation.task === 'code') ?? null;
  const codeModelAssurance = codeModelObservation?.assurance ?? 'unavailable';
  if (deliveryPreflight && effectiveAuthorship.producer === 'governed-agent') {
    const minimum = workflow.resolution?.codeDelivery?.model?.minimumAssurance ?? 'unavailable';
    if ((MODEL_ASSURANCE_RANK[codeModelAssurance] ?? -1) < requiredModelAssuranceRank(minimum)) {
      throw new SingularityFlowError(
        `Governed code generation requires ${minimum} model assurance; the host supplied ${codeModelAssurance}.`,
        { code: 'CODE_MODEL_ASSURANCE_REQUIRED' }
      );
    }
    if (codeModelAssurance !== 'unavailable' && !codeModelObservation?.invocationId) {
      throw new SingularityFlowError('Observed code-model assurance requires a host invocation binding.', {
        code: 'CODE_MODEL_ASSURANCE_REQUIRED'
      });
    }
    if (codeModelAssurance !== 'unavailable' && (!codeModelObservation?.provider
        || !codeModelObservation?.resolvedModel
        || codeModelObservation?.host !== 'singularity-flow-kernel'
        || codeModelObservation?.source !== 'model-invocation-audit'
        || !codeModelObservation?.observedAt
        || codeModelObservation?.observationIntegrity !== 'external-host-attested'
        || Number(codeModelObservation?.generation) !== Number(phase.generation + 1))) {
      throw new SingularityFlowError('Code-model assurance is missing its provider, model, host audit source, timestamp, or generation binding.', {
        code: 'CODE_MODEL_ASSURANCE_REQUIRED'
      });
    }
  }

  // AST is optional. This boundary may collect structural diagnostics, but it never blocks or
  // mutates publication when AST, a language pack, an adapter, or its evidence store is absent.
  const astGate = await evaluateAstLifecycleGate(root, config, workflow, phase, {
    generation: phase.generation + 1
  });
  assertAstLifecycleGate(astGate, `publication of phase '${phase.id}'`);

  const capture = !modelAssisted
    ? { source: 'not-invoked', usage: [], spans: 0, rawBytes: 0, pending: false, warnings: [] }
    : rawUsage
    ? { source: 'usage-json', usage: Array.isArray(rawUsage) ? rawUsage : [rawUsage], spans: 0, rawBytes: 0, startedAt: rawUsage.startedAt, completedAt: rawUsage.completedAt, warnings: [] }
    : { source: 'copilot-otel', ...await collectCopilotUsage(root, workflow, phase) };
  capture.pending = modelAssisted && !rawUsage && capture.usage.length === 0;
  if (capture.pending) capture.warnings.push('The active Copilot turn has not been exported yet; telemetry will be reconciled automatically before submission.');
  capture.warnings.forEach((warning) => console.warn(`Telemetry warning: ${warning}`));
  const normalizedUsage = modelAssisted
    ? (capture.usage.length ? capture.usage : [{ source: 'copilot-otel-unavailable' }]).map((record) => normalizeUsage(record, session, phase.generation + 1))
    : [];
  const capabilityBudget = workflow.resolution?.capability?.policy?.tokenBudget;
  if (capabilityBudget) {
    const used = Object.values(workflow.phases).flatMap((entry) => entry.usage ?? [])
      .reduce((total, record) => total + (record.totalTokens ?? 0), 0)
      + normalizedUsage.reduce((total, record) => total + (record.totalTokens ?? 0), 0);
    if (used > capabilityBudget) {
      throw new SingularityFlowError(`Capability '${workflow.resolution.capability.id}' token budget exceeded: ${used}/${capabilityBudget}.`);
    }
  }
  phase.generation += 1; phase.generatedBy = session.actor;
  phase.generatedAgent = effectiveAuthorship.producer === 'governed-agent' ? session.agent : null;
  phase.authorship ??= [];
  const publishedAt = nowIso();
  phase.authorship.push({ ...structuredClone(effectiveAuthorship), generation: phase.generation, publishedAt });
  if (deliveryPreflight) {
    const deliveryRoot = posix(path.join(
      workDirRelative(config, workflow.workItem.id), 'context', 'code-delivery'
    ));
    const receiptPath = `${deliveryRoot}/${phase.id}-gen${phase.generation}.json`;
    const changeSetPath = `${deliveryRoot}/${phase.id}-gen${phase.generation}-changes.json`;
    await writeJson(path.join(root, changeSetPath), deliveryPreflight.changeSet);
    const workingStateDigest = await sourceTreeHash(root);
    const receipt = {
      schemaVersion: currentSchemaVersion('code-delivery'),
      kind: 'code-delivery',
      workId: workflow.workItem.id,
      phase: phase.id,
      generation: phase.generation,
      generationIntentId: deliveryPreflight.generationIntentId,
      changeSet: {
        path: changeSetPath,
        digest: deliveryPreflight.changeSet.digest,
        sourcePaths: deliveryPreflight.sourcePaths,
        deletedSourcePaths: deliveryPreflight.deletedSourcePaths,
        executableTestPaths: deliveryPreflight.testPaths,
        supportingTestPaths: deliveryPreflight.supportingTestPaths
      },
      traceability: {
        required: deliveryPreflight.acceptanceCriteria.required,
        bound: deliveryPreflight.acceptanceCriteria.tagged,
        missing: deliveryPreflight.acceptanceCriteria.missing,
        ambiguous: deliveryPreflight.acceptanceCriteria.ambiguous,
        bindings: deliveryPreflight.acceptanceCriteria.bindings
      },
      testExecutions: [],
      tree: { workingStateDigest, generationCommit: null, generationTree: null },
      model: {
        task: 'code',
        required: effectiveAuthorship.producer === 'governed-agent',
        authorshipProducer: effectiveAuthorship.producer,
        minimumAssurance: workflow.resolution?.codeDelivery?.model?.minimumAssurance ?? 'unavailable',
        mappingRevision: codeModelObservation?.mappingRevision ?? null,
        provider: codeModelObservation?.provider ?? null,
        requestedModel: codeModelObservation?.requestedModel ?? null,
        resolvedModel: codeModelObservation?.resolvedModel ?? null,
        assurance: codeModelAssurance,
        invocationIds: codeModelObservation ? [codeModelObservation.invocationId] : [],
        host: codeModelObservation?.host ?? null,
        observationSource: codeModelObservation?.source ?? null,
        observationIntegrity: codeModelObservation?.observationIntegrity ?? 'unverified-local',
        observedAt: codeModelObservation?.observedAt ?? null,
        generation: codeModelObservation?.generation ?? null
      },
      status: 'pending-tests',
      capturedAt: publishedAt
    };
    await writeJson(path.join(root, receiptPath), receipt);
    phase.deliveryEvidence = {
      ...deliveryPreflight,
      generation: phase.generation,
      receiptPath,
      changeSetPath,
      sourceTreeSha256: workingStateDigest,
      status: 'pending-tests',
      capturedAt: publishedAt,
      validation: null
    };
  }
  const astReceipt = await persistAstLifecycleReceipt(root, config, workflow, phase, astGate);
  if (astReceipt) {
    phase.astGates = [
      ...(phase.astGates ?? []).filter((record) => record.generation !== phase.generation),
      astReceipt
    ].sort((left, right) => left.generation - right.generation);
  }

  /**
   * Canonical provenance for this generation's artifacts `[SPK:REQ-043]`.
   *
   * Written here because this is the one place a generation becomes governed, and written by the
   * kernel rather than by whoever authored the artifact — which is the entire point. The records
   * land under `context/sidecars/`, outside the `artifact-only` scope checked a few lines above, so
   * a model that tried to write one would already have been refused `[SPK:CON-023]`.
   */
  const sidecarDir = workDirRelative(config, workflow.workItem.id);
  phase.sidecars = [];
  for (const artifact of phase.artifacts ?? []) {
    if (!artifact.sha256) continue;
    const relative = sidecarRelativePath(sidecarDir, phase.id, phase.generation, artifact.path);
    const record = buildArtifactSidecar({
      subject: { kind: 'story', id: workflow.workItem.id },
      phase: phase.id,
      generation: phase.generation,
      artifact: { path: artifact.path, sha256: artifact.sha256, bytes: artifact.size ?? null, role: artifact.kind ?? null },
      configuration: { sha256: workflow.resolution?.configSha256 ?? null, revision: workflow.resolution?.configurationSource?.commit ?? null },
      template: {
        path: workflow.resolution?.templates?.[phase.id]?.path ?? null,
        sha256: workflow.resolution?.templates?.[phase.id]?.sha256 ?? null
      },
      inputs: (phase.inputs ?? []).map((entry) => ({ path: entry.path, sha256: entry.sha256 ?? null, kind: entry.kind ?? null })),
      producer: {
        kind: effectiveAuthorship.producer,
        actor: session.actor?.email ?? session.actor?.name ?? null,
        agent: phase.generatedAgent
      },
      // The commit is not known until the publication transaction closes, so the binding records
      // the branch and time now and is completed by the transaction rather than guessed at here.
      publication: { commit: null, branch: workflow.workItem.branch ?? null, publishedAt }
    });
    await writeText(path.join(root, relative), serializeArtifactSidecar(record));
    phase.sidecars.push({ path: relative, artifact: artifact.path, integritySha256: record.integritySha256 });
  }
  if (clarification.record) {
    phase.clarifications ??= [];
    phase.clarifications = [
      ...phase.clarifications.filter((record) => record.generation !== phase.generation),
      {
        generation: phase.generation,
        path: clarification.path,
        sha256: clarification.sha256,
        promptSha256: clarification.record.promptSha256,
        responses: clarification.record.responses.length,
        // Which artifact markers this batch answered `[SPK:REQ-066]`. Kept on the summary so the
        // gate can tell a resolved marker from a deleted one without reading every record off disk
        // on a path that already does a lot of I/O.
        markers: answeredMarkerHashes(clarification.record),
        recordedAt: clarification.record.recordedAt,
        recordedBy: structuredClone(clarification.record.recordedBy)
      }
    ];
  }
  /**
   * What this generation left open, so the next one can tell resolution from deletion.
   *
   * `[SPK:REQ-067]` only works if there is a prior list to have vanished from: without it, quietly
   * removing a question is indistinguishable from answering it.
   */
  if (gate.applies && gate.record) {
    phase.markers = [
      ...(phase.markers ?? []).filter((record) => record.generation !== phase.generation),
      { ...gate.record, generation: phase.generation, recordedAt: publishedAt }
    ].sort((left, right) => left.generation - right.generation);
  }
  phase.sourceCommit = head(root);
  if (phase.id === 'conformance') phase.conformanceTree = await sourceTreeHash(root);
  phase.usage.push(...normalizedUsage);
  const telemetry = await recordPhaseTelemetry(root, workflow, phase, normalizedUsage, capture, {
    itemDirectory: workDir(root, config, workflow.workItem.id), itemRelative: workDirRelative(config, workflow.workItem.id)
  });
  phase.telemetry = [...(phase.telemetry ?? []).filter((item) => item.generation !== phase.generation), {
    generation: telemetry.generation, path: telemetry.path, sha256: telemetry.sha256, status: telemetry.status,
    models: telemetry.models, providerCost: telemetry.providerCost
  }];
  await updateArtifactMetadata(root, config, workflow, phase);
  await scanArtifacts(root, config, workflow, phase.id);
  // Generate the downstream projection from the exact generation bytes that this publication
  // commits. Submission later binds these hashes into its immutable review packet; subsequent
  // approval metadata must not redefine what the reviewer and downstream consumer received.
  const agentBriefs = await createAgentBriefs(root, workflow, phase, {
    itemDirectory: workDir(root, config, workflow.workItem.id),
    itemRelative: workDirRelative(config, workflow.workItem.id)
  });
  if (agentBriefs.length) {
    phase.agentBriefs = [
      ...(phase.agentBriefs ?? []).filter((entry) => entry.generation !== phase.generation),
      ...agentBriefs
    ].sort((left, right) => left.generation - right.generation || left.consumerPhase.localeCompare(right.consumerPhase));
  }
  /**
   * The typed artifact set `[SPK:REQ-110]` `[SPK:REQ-111]`.
   *
   * Catalogued after the scan, so the set describes the bundle as published. A missing required
   * member is reported rather than refused: no clause asks for a refusal, and turning a descriptive
   * declaration into a hard gate would break every Story already using a profile that ships one.
   *
   * When the phase was reopened for named members, this is also where the promise is checked. The
   * clause asks that incidental change be *disclosed*, not forbidden — a regeneration that reflowed
   * a neighbouring paragraph is usually harmless, and refusing it would push people into rewriting
   * the whole bundle, which is the outcome surgical reopen exists to avoid.
   */
  const artifactSet = resolvedArtifactSet(config, workflow, phase);
  if (artifactSet) {
    const previous = phase.artifactSet ?? null;
    const catalog = await catalogArtifactSet(root, workDirRelative(config, workflow.workItem.id), phase, artifactSet);
    const diff = artifactSetDiff(previous, catalog, { declared: phase.surgicalReopen?.members ?? [] });
    for (const line of disclosureLines(diff)) console.warn(`Warning: ${line}`);
    for (const missing of catalog.missingRequired) console.warn(`Warning: artifact set '${catalog.setId}' is missing its required member ${missing}.`);
    phase.artifactSet = {
      ...catalog,
      generation: phase.generation,
      preserved: diff.preserved.map((member) => member.path),
      changed: diff.changed.map((member) => member.path),
      // Member names, not repository paths: this block is read beside `reopen.members`, which is
      // the list the reviewer wrote, and the two have to be comparable at a glance.
      ...(phase.surgicalReopen ? { reopen: { ...phase.surgicalReopen, incidental: diff.incidental.map((member) => member.member) } } : {})
    };
    // Consumed by the generation that answered it. A reopen that stayed on the phase would keep
    // re-disclosing the same incidental change at every later generation.
    delete phase.surgicalReopen;
  }

  await refreshPhaseSpecificationIndex(root, config, workflow, phase);
  await updateRemoteOutputRenderedHashes(root, workflow, phase, { itemDirectory: workDir(root, config, workflow.workItem.id) });
  const errors = await validatePhase(root, config, workflow, phase);
  if (errors.length) throw new SingularityFlowError(`Phase ${phase.id} generation is not publishable:\n- ${errors.join('\n- ')}`);
  if (generationIntent) {
    const resultDigest = await generationResultDigest(root, config, workflow, phase);
    await consumeGenerationIntent(root, phase, {
      generation: phase.generation,
      publishedAt,
      changeSetDigest: deliveryPreflight?.changeSet?.digest ?? null,
      resultDigest
    });
  }
  const generationPublication = {
    generation: phase.generation,
    publishedAt,
    changeSetDigest: deliveryPreflight?.changeSet?.digest ?? null,
    resultDigest: generationIntent?.publication?.resultDigest
      ?? await generationResultDigest(root, config, workflow, phase),
    record: null
  };
  phase.generationPublications = [
    ...(phase.generationPublications ?? []).filter((entry) => Number(entry.generation) !== Number(phase.generation)),
    generationPublication
  ].sort((left, right) => Number(left.generation) - Number(right.generation));
  if (publicationTransaction) {
    await persistGenerationPublicationRecord(root, workflow, phase, {
      ...publicationTransaction,
      workDirectory: workDirRelative(config, workflow.workItem.id)
    });
  }
  normalizedUsage.forEach((usage) => addUsageAggregate(workflow, phase, usage));
  workflow.history.push({ at: nowIso(), actor: actorKey(session.actor), agent: session.agent, event: 'phase_generated', phase: phase.id, detail: `generation ${phase.generation}` });
  if (persist) await saveWorkflow(root, config, workflow);
  return phase;
}

export async function reconcilePhaseTelemetry(root, config, workflow, { phaseId } = {}) {
  const phase = phaseId ? workflow.phases[phaseId] : currentPhase(workflow);
  if (!phase) return { updated: false, reason: 'No active phase is available.' };
  const generation = phase.generation;
  const context = (phase.telemetry ?? []).find((item) => item.generation === generation);
  if (!context) return { updated: false, phase: phase.id, generation, reason: 'No telemetry record exists for the current generation.' };
  if (context.status !== 'pending') return { updated: false, phase: phase.id, generation, status: context.status, reason: `Telemetry is already ${context.status}.` };

  const capture = { source: 'copilot-otel', ...await collectCopilotUsage(root, workflow, phase, { generation }) };
  if (!capture.usage.length) return {
    updated: false,
    pending: true,
    phase: phase.id,
    generation,
    status: 'pending',
    reason: capture.warnings.at(-1) ?? 'The completed Copilot turn is not available yet.',
    warnings: capture.warnings
  };

  const session = await loadSession(root, { required: false });
  const usageSession = { agent: phase.generatedAgent ?? session?.agent ?? null };
  const normalizedUsage = capture.usage.map((record) => normalizeUsage(record, usageSession, generation));
  phase.usage = [...(phase.usage ?? []).filter((item) => item.generation !== generation), ...normalizedUsage];
  const telemetry = await recordPhaseTelemetry(root, workflow, phase, normalizedUsage, capture, {
    itemDirectory: workDir(root, config, workflow.workItem.id),
    itemRelative: workDirRelative(config, workflow.workItem.id)
  });
  phase.telemetry = [...(phase.telemetry ?? []).filter((item) => item.generation !== generation), {
    generation,
    path: telemetry.path,
    sha256: telemetry.sha256,
    status: telemetry.status,
    models: telemetry.models,
    providerCost: telemetry.providerCost
  }];
  rebuildUsageAggregates(workflow);
  workflow.history.push({
    at: nowIso(),
    actor: actorKey(session?.actor ?? phase.generatedBy ?? {}) ?? 'unknown',
    agent: session?.agent ?? phase.generatedAgent ?? null,
    event: 'phase_telemetry_reconciled',
    phase: phase.id,
    detail: `generation ${generation}: ${telemetry.status}`
  });
  await updateArtifactMetadata(root, config, workflow, phase);
  await refreshRequiredArtifact(root, config, workflow, phase);
  await saveWorkflow(root, config, workflow);
  return {
    updated: true,
    phase: phase.id,
    generation,
    status: telemetry.status,
    models: telemetry.models,
    usage: normalizedUsage,
    providerCost: telemetry.providerCost,
    path: telemetry.path
  };
}

function boundedQualityDiagnostic(value, max = 2000) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  const marker = '\n… diagnostic output truncated …\n';
  const remaining = max - marker.length;
  const first = Math.ceil(remaining / 2);
  return `${text.slice(0, first)}${marker}${text.slice(-(remaining - first))}`;
}

async function qualityChecks(root, phase, config, commands = phase.qualityCommands ?? []) {
  const checks = [];
  const sourceCommit = head(root);
  const sourceTreeSha256 = await sourceTreeHash(root);
  const modelEnabled = operationContext()?.modelMode?.enabled !== false;
  const unknownStrictness = config.noModel?.unknownExternalCommands ?? 'warn';
  for (const [index, value] of commands.entries()) {
    const policy = evaluateExternalCommandForModelMode(value, { modelEnabled, unknownStrictness, index });
    const command = policy.command ?? policy.argv.join(' ');
    const startedAt = nowIso();
    if (policy.action === 'block') throw new SingularityFlowError(policy.reason, { code: 'EXTERNAL_MODEL_POLICY_BLOCKED' });
    if (policy.action === 'skip') {
      checks.push({
        id: policy.id, command, requirement: policy.requirement,
        externalModelPolicy: policy.modelPolicy, sourceCommit, sourceTreeSha256,
        startedAt, completedAt: nowIso(), status: 'skipped-warning', exitCode: null,
        stdout: '', stderr: policy.reason
      });
      continue;
    }
    const commandTarget = await secureRepositoryPath(
      root,
      policy.workingDirectory && policy.workingDirectory !== '.' ? policy.workingDirectory : '.',
      { label: `Quality command '${policy.id}' working directory`, mustExist: true, type: 'directory' }
    );
    const commandRoot = commandTarget.absolute;
    if (policy.kind === 'test' && policy.result?.path) {
      const resultTarget = path.resolve(commandRoot, policy.result.path);
      // `secureRepositoryPath` resolves macOS' /var -> /private/var alias. Compare the result to the
      // same canonical root; mixing the caller's lexical root with the secured real path falsely
      // classified repository-contained reports as external.
      const repositoryTarget = await secureRepositoryPath(root, '.', {
        label: 'Repository root', mustExist: true, type: 'directory'
      });
      if (resultTarget !== repositoryTarget.absolute
          && !resultTarget.startsWith(`${repositoryTarget.absolute}${path.sep}`)) {
        throw new SingularityFlowError(`Test result path resolves outside the repository: ${policy.result.path}`, { code: 'CODE_TEST_RESULT_REQUIRED' });
      }
      await secureRepositoryPath(root, path.relative(repositoryTarget.absolute, resultTarget), {
        label: `Test result '${policy.result.path}'`, mustExist: false
      });
      await mkdir(path.dirname(resultTarget), { recursive: true });
      await secureRepositoryPath(root, path.relative(repositoryTarget.absolute, path.dirname(resultTarget)), {
        label: `Test result parent '${policy.result.path}'`, mustExist: true, type: 'directory'
      });
      // A timestamp is not execution evidence: touching yesterday's report made it fresh. The
      // configured structured-result path is disposable command output, so remove it before the
      // process starts. Anything parsed afterwards must have been created by this invocation.
      await rm(resultTarget, { recursive: true, force: true });
    }
    // A CLI invoked from Node's own test runner inherits NODE_TEST_CONTEXT. Passing that private
    // harness marker to a nested `node --test` process makes Node treat the required repository
    // test as an internal child and emit no reporter events. External quality commands are a new
    // execution boundary, so they receive the ordinary process environment without the parent's
    // test-runner control marker.
    const commandEnvironment = { ...process.env };
    delete commandEnvironment.NODE_TEST_CONTEXT;
    const result = policy.argv
      ? await runQualityCommand(policy.argv[0], policy.argv.slice(1), {
        cwd: commandRoot,
        env: commandEnvironment,
        timeoutMs: policy.timeoutMs ?? DEFAULT_QUALITY_COMMAND_TIMEOUT_MS,
        killTree: true,
        stdoutFile: policy.kind === 'test' && (policy.result?.adapter === 'go-test-json'
          || policy.result?.adapter === 'node-tap'
          || (policy.result?.adapter === 'junit-xml'
            && policy.argv.some((argument) => argument === '--test-reporter=junit')))
          ? path.resolve(commandRoot, policy.result.path)
          : null
      })
      : await runQualityCommand(policy.command, [], {
        cwd: commandRoot, env: commandEnvironment, shell: true,
        timeoutMs: policy.timeoutMs ?? DEFAULT_QUALITY_COMMAND_TIMEOUT_MS,
        killTree: true
      });
    const infrastructureError = result.error
      ? `Unable to run quality command: ${result.error.message}`
      : null;
    checks.push({
      id: policy.id, command, kind: policy.kind, requirement: policy.requirement,
      workingDirectory: policy.workingDirectory,
      externalModelPolicy: policy.modelPolicy,
      timeoutMs: policy.timeoutMs ?? DEFAULT_QUALITY_COMMAND_TIMEOUT_MS,
      sourceCommit, sourceTreeSha256, startedAt, completedAt: nowIso(),
      status: result.timedOut || infrastructureError ? 'blocked' : result.status === 0 ? 'passed' : 'failed',
      exitCode: result.status, stdout: boundedQualityDiagnostic(result.stdout),
      stderr: boundedQualityDiagnostic(result.timedOut
        ? `Command exceeded its ${policy.timeoutMs ?? DEFAULT_QUALITY_COMMAND_TIMEOUT_MS}ms timeout.`
        : infrastructureError ?? result.stderr),
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated
    });
  }
  return checks;
}

async function preflightCodeDeliveryTests(root, config, workflow, phase, deliveryEvidence) {
  if (workflow.resolution?.codeDelivery?.tests?.executionAssurance === 'testcase-exact') {
    throw new SingularityFlowError(
      'testcase-exact assurance requires an adapter that binds source annotations to executed test identities; no such binding is configured.',
      { code: 'CODE_TEST_RESULT_REQUIRED' }
    );
  }
  const commands = (await resolveDeliveryQualityCommands(root, { ...phase, deliveryEvidence }))
    .filter((command) => command && typeof command === 'object' && !Array.isArray(command) && command.kind === 'test')
    .map((command, index) => normalizeRequiredTestCommand(command, index))
    .map((command) => ({
      ...command,
      result: {
        ...command.result,
        minimumDiscovered: Math.max(
          command.result.minimumDiscovered,
          workflow.resolution?.codeDelivery?.tests?.minimumDiscovered ?? 1
        ),
        minimumPassed: Math.max(
          command.result.minimumPassed,
          workflow.resolution?.codeDelivery?.tests?.minimumPassed ?? 1
        )
      }
    }));
  if (!commands.length) {
    throw new SingularityFlowError(
      `Phase ${phase.id} has no structured repository test command. Configure kind: test, argv, workingDirectory, affectedRoots, and a result adapter before publication.`,
      { code: 'CODE_DELIVERY_TEST_COMMAND_REQUIRED' }
    );
  }
  const checks = await qualityChecks(root, phase, config, commands);
  const passing = [];
  for (const command of commands) {
    const check = checks.find((entry) => entry.id === command.id);
    if (!check || check.status === 'skipped-warning') {
      throw new SingularityFlowError(`Required test command '${command.id}' was skipped before publication.`, { code: 'CODE_TEST_SKIPPED' });
    }
    if (check.status === 'blocked') {
      throw new SingularityFlowError(`Required test command '${command.id}' was blocked before publication: ${check.stderr}`, { code: 'CODE_TEST_FAILED' });
    }
    if (check.status !== 'passed' || check.exitCode !== 0) {
      throw new SingularityFlowError(`Required test command '${command.id}' failed before publication.`, { code: 'CODE_TEST_FAILED' });
    }
    const parsed = await parseTestResult(root, command, { startedAt: check.startedAt });
    const receipt = buildTestExecutionReceipt(command, check, parsed);
    if (receipt.tests.discovered < parsed.minimumDiscovered) {
      throw new SingularityFlowError(`Required test command '${command.id}' discovered zero or too few tests before publication.`, { code: 'CODE_TEST_ZERO_DISCOVERED' });
    }
    if (!testReceiptPassing(receipt, parsed.minimumDiscovered, command.result.minimumPassed)) {
      throw new SingularityFlowError(`Required test command '${command.id}' did not produce passing executable-test evidence before publication.`, { code: 'CODE_TEST_FAILED' });
    }
    passing.push(command);
  }
  if (workflow.resolution?.codeDelivery?.tests?.requireAffectedModuleCoverage !== false) {
    const paths = phase.sourceBoundary === 'test-automation'
      ? deliveryEvidence.testPaths : deliveryEvidence.sourcePaths;
    const uncovered = paths.filter((candidate) => !passing.some((command) =>
      command.affectedRoots.some((root) => root === '.' || candidate === root
        || candidate.startsWith(`${root.replace(/\/$/, '')}/`))));
    if (uncovered.length) {
      throw new SingularityFlowError(`No passing test command covers affected paths before publication: ${uncovered.join(', ')}`, { code: 'TEST_MODULE_UNCOVERED' });
    }
  }
  return { commands, checks };
}

export function qualityValidationVerdict(checks = [], { required = false } = {}) {
  const known = new Set(['passed', 'failed', 'blocked', 'skipped-warning', 'unavailable']);
  const invalid = checks.filter((check) => !known.has(check?.status));
  const explicitFailures = checks.filter((check) => check.status === 'failed' || check.status === 'blocked');
  // Invalid or unknown output is never equivalent to a passing command. Keep it in `failed` as
  // well as `invalid` so every existing gate fails closed while callers gain the precise reason.
  const failed = [...explicitFailures, ...invalid];
  const unavailable = checks.filter((check) => ['skipped-warning', 'unavailable'].includes(check.status));
  const unavailableRequired = unavailable.filter((check) => (check.requirement ?? 'required') === 'required');
  let verdict;
  if (!checks.length) verdict = required ? 'invalid' : 'not-required';
  else if (invalid.length) verdict = 'invalid';
  else if (explicitFailures.length) verdict = 'failed';
  else if (unavailable.length === checks.length) verdict = 'unavailable';
  else if (unavailable.length) verdict = 'partial';
  else verdict = 'passed';
  return {
    verdict,
    failed,
    invalid,
    unavailable,
    unavailableRequired
  };
}

export async function submitPhase(root, config, workflow, { phaseId, runChecks = true, persist = true } = {}) {
  await assertNoPendingPublication(root, config, workflow, 'submit for approval');
  const phase = await assertPhaseSequence(root, workflow, 'submit for approval', { requestedPhase: phaseId }); const session = await loadSession(root);
  const unacknowledgedAmendment = pendingIntentAmendmentAcknowledgement(workflow);
  if (unacknowledgedAmendment) {
    throw new SingularityFlowError(
      `Intent amendment '${unacknowledgedAmendment.id}' changed ${unacknowledgedAmendment.changedClauses?.join(', ') || 'the specification'}. `
      + `Acknowledge it before revalidation with singularity-flow story intent-amendment acknowledge ${unacknowledgedAmendment.id}.`,
      { code: 'INTENT_AMENDMENT_ACKNOWLEDGEMENT_REQUIRED' }
    );
  }
  assertRequiredAssignment(workflow, phase);
  await assertMcpPhaseReadiness(root, workflow, phase);
  const mcpEvidence = await verifyPhaseMcpRequirements(root, workflow, phase, {
    itemDirectory: workDir(root, config, workflow.workItem.id),
    targetGeneration: phase.generation
  });
  if (mcpEvidence.errors.length) throw new SingularityFlowError(`Phase ${phase.id} MCP evidence is not ready:\n- ${mcpEvidence.errors.join('\n- ')}`, { code: 'MCP_EVIDENCE_REQUIRED' });
  if (phaseNeedsGeneration(workflow, phase)) await enforceSequenceGate(root, workflow, 'freshGeneration', 'submit for approval', {
    requestedPhase: phase.id,
    reason: phase.generation < 1 ? 'The phase has no published generation.' : 'The phase was returned for correction and has not been regenerated.'
  });
  /**
   * The same gate again, at the other boundary `[SPK:REQ-065]` names.
   *
   * Placed here rather than beside the quality commands so it precedes every assignment in this
   * function: `[SPK:REQ-065]` says a blocking marker stops submission *before any state mutation*,
   * and `phase.generationCommit` on the next line is one. The freshness gate above it is not a
   * mutation and has to come first — telling someone about an unresolved question in a phase that
   * has nothing to submit yet would be answering a question they have not reached.
   *
   * Not redundant with the publication check either: a generation may have been published while the
   * policy was `warn` and the policy tightened since. Reading the artifact from disk rather than
   * trusting `phase.markers` keeps the verdict about the artifact as it stands.
   */
  const gate = await evaluateSpecificationGate(root, config, workflow, phase, {
    generation: phase.generation,
    artifactRelativePath: requiredRepoPath(config, workflow, phase),
    namespace: (workflow.resolution?.spec ?? config.spec)?.namespace ?? null
  });
  gate.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  if (gate.errors.length) {
    throw new SingularityFlowError(`Phase ${phase.id} cannot be submitted for approval:\n- ${gate.errors.join('\n- ')}`);
  }

  // Legacy AST receipts are observed diagnostically. Their absence or invalidity cannot prevent
  // submission because normal repository file access is the permanent fallback.
  await requireAstLifecycleReceipt(root, config, workflow, phase, { generation: phase.generation });
  const codeDeliveryRequired = phaseRequiresCodeDelivery(phase);
  const deliveryCommands = await resolveDeliveryQualityCommands(root, phase);
  let requiredTestCommands = [];
  if (codeDeliveryRequired) {
    if (workflow.resolution?.codeDelivery?.tests?.executionAssurance === 'testcase-exact') {
      throw new SingularityFlowError(
        'testcase-exact assurance requires an adapter that binds source annotations to executed test identities; no such binding is configured.',
        { code: 'CODE_TEST_RESULT_REQUIRED' }
      );
    }
    const evidence = phase.deliveryEvidence;
    if (!evidence || Number(evidence.generation) !== Number(phase.generation)) {
      throw new SingularityFlowError(
        `Phase ${phase.id} cannot be submitted because generation ${phase.generation} has no code-delivery receipt. Republish it with source and acceptance-mapped tests.`,
        { code: 'CODE_DELIVERY_RECEIPT_MISSING' }
      );
    }
    const currentTree = await sourceTreeHash(root);
    if (evidence.sourceTreeSha256 !== currentTree) {
      throw new SingularityFlowError(
        `Phase ${phase.id} code or tests changed after publication. Publish a fresh generation before submission.`,
        { code: 'CODE_DELIVERY_RECEIPT_STALE' }
      );
    }
    requiredTestCommands = deliveryCommands
      .filter((command) => command && typeof command === 'object' && !Array.isArray(command) && command.kind === 'test')
      .map((command, index) => normalizeRequiredTestCommand(command, index))
      .map((command) => ({
        ...command,
        result: {
          ...command.result,
          minimumDiscovered: Math.max(
            command.result.minimumDiscovered,
            workflow.resolution?.codeDelivery?.tests?.minimumDiscovered ?? 1
          ),
          minimumPassed: Math.max(
            command.result.minimumPassed,
            workflow.resolution?.codeDelivery?.tests?.minimumPassed ?? 1
          )
        }
      }));
    if (!requiredTestCommands.length) {
      throw new SingularityFlowError(
        `Phase ${phase.id} has no structured repository test command. Configure kind: test, argv, workingDirectory, affectedRoots, and a result adapter.`,
        { code: 'CODE_DELIVERY_TEST_COMMAND_REQUIRED' }
      );
    }
  }
  // A Change Flight Plan is advisory until accepted, then becomes an exact scope binding. Compute
  // actual-versus-expected before the first submission mutation so an unexamined expansion cannot
  // be hidden by a later workflow write. The receipt itself is persisted only after every ordinary
  // submission gate below has passed.
  const flightPlanBoundary = evaluateChangeFlightPlanBoundary(root, workflow, { phaseId: phase.id });

  phase.generationCommit = publishedGenerationCommit(root, workflow, phase);
  if (!phase.generationCommit) await enforceSequenceGate(root, workflow, 'generationCommit', 'submit for approval', {
    requestedPhase: phase.id,
    reason: `Generation commit is missing for generation ${phase.generation}.`
  });
  const publicationBranch = workflowPublicationBranch(root, workflow);
  const publicationMode = workflowPublicationMode(config, workflow);
  phase.publicationCommit = phase.generationCommit && (publicationMode === 'off' || remoteContains(root, phase.generationCommit, config.git?.remote ?? 'origin', publicationBranch)) ? phase.generationCommit : null;
  if (publicationMode !== 'off' && !phase.publicationCommit) await enforceSequenceGate(root, workflow, 'remoteGeneration', 'submit for approval', {
    requestedPhase: phase.id,
    reason: phase.generationCommit ? `Generation commit ${phase.generationCommit.slice(0, 8)} is not published.` : 'No generation commit is available on the configured remote.'
  });
  if (codeDeliveryRequired && !runChecks) {
    throw new SingularityFlowError(
      `Phase ${phase.id} is a code delivery and cannot skip validation commands.`,
      { code: 'CODE_DELIVERY_TESTS_CANNOT_BE_SKIPPED' }
    );
  }
  phase.checks = runChecks ? await qualityChecks(root, phase, config, deliveryCommands) : [];
  const testExecutions = [];
  if (codeDeliveryRequired) {
    for (const command of requiredTestCommands) {
      const check = phase.checks.find((entry) => entry.id === command.id);
      if (!check || check.status === 'skipped-warning') {
        throw new SingularityFlowError(`Required test command '${command.id}' was skipped.`, { code: 'CODE_TEST_SKIPPED' });
      }
      if (check.status === 'blocked') {
        throw new SingularityFlowError(`Required test command '${command.id}' was blocked: ${check.stderr}`, { code: 'CODE_TEST_FAILED' });
      }
      if (check.status !== 'passed' || check.exitCode !== 0) {
        throw new SingularityFlowError(`Required test command '${command.id}' failed.`, { code: 'CODE_TEST_FAILED' });
      }
      const parsed = await parseTestResult(root, command, { startedAt: check.startedAt });
      const receipt = buildTestExecutionReceipt(command, check, parsed);
      const minimumPassed = Math.max(
        parsed.minimumPassed,
        workflow.resolution?.codeDelivery?.tests?.minimumPassed ?? 1
      );
      if (receipt.tests.discovered < parsed.minimumDiscovered) {
        throw new SingularityFlowError(`Required test command '${command.id}' discovered zero or too few tests.`, { code: 'CODE_TEST_ZERO_DISCOVERED' });
      }
      if (!testReceiptPassing(receipt, parsed.minimumDiscovered, minimumPassed)) {
        throw new SingularityFlowError(`Required test command '${command.id}' did not produce passing executable-test evidence.`, { code: 'CODE_TEST_FAILED' });
      }
      const safeId = command.id.replace(/[^A-Za-z0-9._-]+/g, '-');
      const receiptPath = posix(path.join(
        workDirRelative(config, workflow.workItem.id), 'context', 'code-delivery', 'tests',
        `${phase.id}-gen${phase.generation}-${safeId}.json`
      ));
      await writeJson(path.join(root, receiptPath), receipt);
      testExecutions.push({
        commandId: command.id, receiptPath,
        receiptSha256: createHash('sha256').update(canonicalJson(receipt)).digest('hex'),
        status: receipt.status,
        affectedRoots: command.affectedRoots
      });
    }
    if (workflow.resolution?.codeDelivery?.tests?.requireAffectedModuleCoverage !== false) {
      const pathsRequiringCoverage = phase.sourceBoundary === 'test-automation'
        ? phase.deliveryEvidence.testPaths
        : phase.deliveryEvidence.sourcePaths;
      const uncovered = pathsRequiringCoverage.filter((candidate) => !testExecutions.some((execution) =>
        execution.affectedRoots.some((affectedRoot) => affectedRoot === '.'
          || candidate === affectedRoot || candidate.startsWith(`${affectedRoot.replace(/\/$/, '')}/`))));
      if (uncovered.length) {
        throw new SingularityFlowError(`No passing test command covers affected paths: ${uncovered.join(', ')}`, { code: 'TEST_MODULE_UNCOVERED' });
      }
    }
  }
  if (phase.id === 'visual-verification') await assertVisualCoverage(root, workflow, { itemDirectory: workDir(root, config, workflow.workItem.id) });
  const errors = await validatePhase(root, config, workflow, phase);
  const validation = qualityValidationVerdict(phase.checks);
  const { failed, unavailable, unavailableRequired } = validation;
  const reviewableFailure = Boolean(phase.repairBudget && failed.length);
  if (failed.length && !reviewableFailure) errors.push(`Quality command failed: ${failed.map((check) => check.command).join(', ')}`);
  if (unavailableRequired.length) {
    errors.push(`Required quality command was unavailable: ${unavailableRequired.map((check) => check.command).join(', ')}`);
  }
  if (errors.length) throw new SingularityFlowError(`Phase ${phase.id} is not ready:\n- ${errors.join('\n- ')}`);
  phase.validationVerdict = validation.verdict;
  if (codeDeliveryRequired) {
    const generationTree = phase.generationCommit
      ? run('git', ['rev-parse', `${phase.generationCommit}^{tree}`], { cwd: root }).stdout.trim()
      : null;
    phase.deliveryEvidence.validation = {
      sourceCommit: phase.generationCommit,
      sourceTreeSha256: await sourceTreeHash(root),
      commands: deliveryCommands.map((command, index) => ({
        id: phase.checks[index]?.id ?? `quality-${index + 1}`,
        command: externalCommandText(command, index)
      })),
      checks: phase.checks.map((check) => ({ id: check.id, status: check.status, sourceTreeSha256: check.sourceTreeSha256 })),
      status: failed.length ? 'failed' : 'passed',
      validatedAt: nowIso()
    };
    phase.deliveryEvidence.status = 'ready';
    phase.deliveryEvidence.testExecutions = testExecutions;
    const deliveryReceipt = await readJson(path.join(root, phase.deliveryEvidence.receiptPath));
    const traceabilityBindings = [];
    for (const binding of deliveryReceipt.traceability?.bindings ?? []) {
      const execution = testExecutions.find((candidate) => candidate.affectedRoots.some((affectedRoot) =>
        affectedRoot === '.' || binding.testSource === affectedRoot
          || binding.testSource.startsWith(`${affectedRoot.replace(/\/$/, '')}/`)));
      if (!execution) {
        throw new SingularityFlowError(
          `Acceptance clause '${binding.clauseId}' is not bound to a passing command for '${binding.testSource}'.`,
          { code: 'AC_BINDING_MISSING' }
        );
      }
      const module = await resolveAffectedModule(root, binding.testSource).catch((error) => {
        // The deterministic direct-node fallback is an explicit root-module adapter for
        // repositories that intentionally have executable .mjs tests but no package manifest.
        // It is valid only when the passing command names the repository root as its affected root.
        if (error?.code === 'TEST_MODULE_UNCOVERED' && execution.affectedRoots.includes('.')) {
          return { root: '.', system: 'node-direct' };
        }
        throw error;
      });
      traceabilityBindings.push({
        ...binding,
        testIdentity: null,
        moduleRoot: module.root,
        commandId: execution.commandId,
        executionAssurance: 'module-executed',
        testcaseExecutionProven: false,
        assuranceNotice: 'module executed; tagged test execution not independently proven'
      });
    }
    const readyReceipt = {
      ...deliveryReceipt,
      traceability: { ...deliveryReceipt.traceability, bindings: traceabilityBindings },
      testExecutions: testExecutions.map(({ affectedRoots: _affectedRoots, ...entry }) => entry),
      tree: {
        ...deliveryReceipt.tree,
        workingStateDigest: await sourceTreeHash(root),
        generationCommit: phase.generationCommit,
        generationTree
      },
      status: 'ready',
      validatedAt: phase.deliveryEvidence.validation.validatedAt
    };
    await writeJson(path.join(root, phase.deliveryEvidence.receiptPath), readyReceipt);
    phase.deliveryEvidence.receiptSha256 = createHash('sha256').update(canonicalJson(readyReceipt)).digest('hex');
  }
  if (phaseUsesWorkInterval(phase)) {
    const itemDirectory = workDir(root, config, workflow.workItem.id);
    const itemRelative = workDirRelative(config, workflow.workItem.id);
    const interval = workflow.workIntervals?.current;
    if (!interval || interval.phaseId !== phase.id || interval.status !== 'open') {
      throw new SingularityFlowError(
        `Phase '${phase.id}' has no open governed work interval. Run singularity-flow prepare ${phase.id} before changing source or submitting.`
      );
    }
    const reconciliation = await reconcileWorkInterval(root, config, workflow, {
      phaseId: phase.id,
      itemDirectory,
      requireCleanTarget: true
    });
    if (!reconciliation.decision.eligibleForSubmission) {
      const target = reconciliation.decision.escalationTarget;
      throw new SingularityFlowError(
        `Phase ${phase.id} exceeds its governed work interval:\n- ${reconciliation.decision.reasons.join('\n- ')}\n`
        + (target
          ? `Review the non-destructive escalation plan with singularity-flow story interval escalate --to ${target}.`
          : 'Use a stronger configured workflow before submitting.')
      );
    }
    const final = await recordFinalReconciliation(root, workflow, reconciliation, { itemRelative });
    phase.workIntervalReconciliation = {
      reconciliationSha256: final.reconciliationSha256,
      baselineSha256: final.baselineSha256,
      path: final.path,
      status: final.decision.status,
      summaryStatus: final.decision.summaryStatus,
      targetHead: final.target.head,
      summary: final.summary,
      decision: final.decision,
      baseline: final.baseline
    };
  }
  phase.submittedAt = nowIso();
  const waiver = phase.approvalPolicy.mode === 'policy'
    ? evaluateQuickFixWaiver(root, config, workflow, phase)
    : null;
  if (!reviewableFailure && (phase.approvalPolicy.mode === 'none' || waiver?.eligible)) {
    phase.status = 'approved';
    phase.approvedAt = phase.submittedAt;
    phase.approvedBy = null;
    phase.approvalDisposition = waiver?.eligible ? 'policy_waived' : 'not_required';
    phase.approvalWaiver = waiver?.eligible ? {
      policyId: waiver.policyId,
      policySha256: waiver.policyHash,
      sourceCommit: waiver.sourceCommit,
      reconciliationSha256: phase.workIntervalReconciliation?.reconciliationSha256 ?? null,
      predicates: waiver.predicates,
      waivedAt: phase.submittedAt
    } : null;
    closeWorkInterval(workflow, {
      phaseId: phase.id,
      at: phase.submittedAt,
      actor: actorKey(session.actor),
      agent: session.agent
    });
    const upcoming = nextPhase(workflow, phase);
    if (upcoming) {
      upcoming.status = 'in_progress'; upcoming.startedAt = phase.submittedAt; workflow.currentPhase = upcoming.id;
      await ensureWorkIntervalBaseline(root, config, workflow, {
        phaseId: upcoming.id,
        itemDirectory: workDir(root, config, workflow.workItem.id),
        itemRelative: workDirRelative(config, workflow.workItem.id)
      });
    }
    else { workflow.currentPhase = null; workflow.status = 'complete'; }
    await markIntentAmendmentRevalidated(root, config, workflow, phase, phase.submittedAt, session.actor);
    workflow.history.push(waiver?.eligible ? {
      at: phase.submittedAt,
      actor: actorKey(session.actor),
      agent: session.agent,
      event: 'phase-approval-waived',
      phase: phase.id,
      policyId: waiver.policyId,
      policyHash: waiver.policyHash,
      sourceCommit: waiver.sourceCommit,
      reconciliationSha256: phase.workIntervalReconciliation?.reconciliationSha256 ?? null,
      changedPathsHash: waiver.changedPathsHash,
      predicates: waiver.predicates,
      detail: `deterministic policy waiver${workflow.currentPhase ? `; advanced to ${workflow.currentPhase}` : '; complete'}`
    } : { at: phase.submittedAt, actor: actorKey(session.actor), agent: session.agent, event: 'phase_completed_without_approval', phase: phase.id, detail: `approval mode none${workflow.currentPhase ? `; advanced to ${workflow.currentPhase}` : '; complete'}` });
  } else {
    phase.status = 'awaiting_approval';
    workflow.history.push({
      at: phase.submittedAt,
      actor: actorKey(session.actor),
      agent: session.agent,
      event: reviewableFailure ? 'phase_validation_failed' : 'phase_submitted',
      phase: phase.id,
      detail: reviewableFailure
        ? `${failed.length} quality command(s) failed; human rejection may authorize bounded repair`
        : `${phase.artifacts.length} artifacts`
    });
  }
  await updateArtifactMetadata(root, config, workflow, phase);
  await refreshRequiredArtifact(root, config, workflow, phase);
  // A phase completed by an explicit no-approval contract or deterministic policy is still an
  // approved producer for downstream dataflow. Bind the final managed artifact bytes exactly as a
  // human approval would; otherwise an approved phase paradoxically appears "unapproved" to its
  // consumer because no artifact hash was promoted.
  if (phase.status === 'approved') {
    await registerApprovedSnapshot(root, config, workflow, phase);
    await refreshPhaseSpecificationIndex(root, config, workflow, phase);
  }
  if (persist && flightPlanBoundary) {
    await persistChangeFlightPlanBoundary(root, config, workflow, flightPlanBoundary);
  }
  if (persist) await saveWorkflow(root, config, workflow);
  return phase;
}

function nextPhase(workflow, phase) { const id = workflow.phaseOrder[workflow.phaseOrder.indexOf(phase.id) + 1]; return id ? workflow.phases[id] : null; }

async function writeDecision(root, config, workflow, phase, decision) {
  const safe = decision.at.replace(/[:.]/g, '-');
  await writeJson(path.join(decisionDir(root, config, workflow.workItem.id, phase.id), `${safe}-${decision.decision}.json`), decision);
  await writeJson(approvalPath(root, config, workflow.workItem.id, phase.id), {
    schemaVersion: currentSchemaVersion('phase-approval'), phase: phase.id, decisions: phase.approvals
  });
}

export async function approvePhase(root, config, workflow, {
  phaseId,
  channel = 'terminal',
  actionContext = null,
  checklist = [],
  persist = true
} = {}) {
  await assertNoPendingPublication(root, config, workflow, 'approve');
  const phase = await assertPhaseSequence(root, workflow, 'approve', { requestedPhase: phaseId, allowedStatuses: ['awaiting_approval'] });
  const packetEntry = [...(workflow.lineage?.submissions ?? [])].reverse().find((entry) =>
    entry.phase === phase.id && Number(entry.generation) === Number(phase.generation));
  if (!packetEntry) {
    throw new SingularityFlowError(
      `Phase '${phase.id}' cannot be approved without an immutable review packet for generation ${phase.generation}.`,
      { code: 'STORY_REVIEW_EVIDENCE_REQUIRED' }
    );
  }
  const { readStoryReviewPacket, reviewArtifactSetSha256 } = await import('./story-lineage.mjs');
  const submittedReview = await readStoryReviewPacket(root, config, workflow, packetEntry.packetSha256);
  if (submittedReview.phase !== phase.id || Number(submittedReview.generation) !== Number(phase.generation)) {
    throw new SingularityFlowError(`Phase '${phase.id}' review packet does not bind its current generation.`, {
      code: 'STORY_REVIEW_EVIDENCE_INVALID'
    });
  }
  const currentArtifacts = [];
  for (const artifact of phase.artifacts ?? []) {
    const current = await snapshot(path.join(root, artifact.path));
    if (!current.exists || !current.sha256) {
      throw new SingularityFlowError(
        `Phase '${phase.id}' artifact '${artifact.path}' is absent or no longer a regular file. Submit a fresh generation.`,
        { code: 'STORY_REVIEW_EVIDENCE_STALE' }
      );
    }
    currentArtifacts.push({
      path: artifact.path,
      kind: artifact.kind ?? null,
      sha256: current.sha256,
      size: current.size
    });
  }
  const currentChecksSha256 = createHash('sha256').update(JSON.stringify(phase.checks ?? [])).digest('hex');
  if (submittedReview.submissionEvidence?.artifactSetSha256 !== reviewArtifactSetSha256(currentArtifacts)
    || submittedReview.submissionEvidence?.checksSha256 !== currentChecksSha256) {
    throw new SingularityFlowError(
      `Phase '${phase.id}' artifacts or quality evidence changed after submission. Submit a fresh immutable review packet.`,
      { code: 'STORY_REVIEW_EVIDENCE_STALE' }
    );
  }
  const validation = qualityValidationVerdict(submittedReview.checks ?? [], {
    required: (phase.qualityCommands ?? []).some((check) => (check.requirement ?? 'required') === 'required')
  });
  const failedChecks = validation.failed;
  const unavailableRequiredChecks = validation.unavailableRequired;
  if (failedChecks.length || unavailableRequiredChecks.length) {
    throw new SingularityFlowError(
      `Phase '${phase.id}' cannot be approved because ${failedChecks.length} quality command(s) failed and ${unavailableRequiredChecks.length} required command(s) were unavailable. Reject it to an allowed repair phase.`,
      { code: 'PHASE_VALIDATION_FAILED' }
    );
  }
  if (phaseRequiresCodeDelivery(phase)) {
    const validation = phase.deliveryEvidence?.validation;
    const currentTree = await sourceTreeHash(root);
    if (!validation || validation.status !== 'passed') {
      throw new SingularityFlowError(
        `Phase '${phase.id}' cannot be approved without a passing code-delivery validation receipt.`,
        { code: 'CODE_DELIVERY_VALIDATION_REQUIRED' }
      );
    }
    if (validation.sourceTreeSha256 !== currentTree) {
      throw new SingularityFlowError(
        `Phase '${phase.id}' code or tests changed after validation. Submit a fresh validated generation.`,
        { code: 'CODE_DELIVERY_VALIDATION_STALE' }
      );
    }
    const submittedChecksSha256 = createHash('sha256')
      .update(JSON.stringify(submittedReview.checks ?? []))
      .digest('hex');
    if (submittedReview.sourceTreeSha256 !== currentTree
        || submittedReview.submissionEvidence?.checksSha256 !== submittedChecksSha256
        || (submittedReview.checks ?? []).some((check) => check.status === 'failed' || check.status === 'blocked')) {
      throw new SingularityFlowError(
        `Phase '${phase.id}' immutable review packet does not bind the currently validated source tree and passing checks.`,
        { code: 'CODE_DELIVERY_VALIDATION_REQUIRED' }
      );
    }
    const receiptPath = submittedReview.submissionEvidence?.codeDelivery?.path;
    const historicalReceipt = receiptPath
      ? run('git', ['show', `${submittedReview.evidenceCommit}:${receiptPath}`], { cwd: root, allowFailure: true })
      : null;
    const receipt = historicalReceipt?.status === 0
      ? readRecord('code-delivery', historicalReceipt.stdout).record
      : null;
    if (!receipt || receipt.legacyV1) {
      // A generation published before code-delivery v2 has only the inline validation checked
      // above. It remains approvable for migration compatibility, but every generation begun by
      // this build has an intent and therefore must take the strict v2 path below.
      if (phase.generationIntent?.id) {
        throw new SingularityFlowError(
          `Phase '${phase.id}' requires a current code-delivery v2 receipt before approval.`,
          { code: 'CODE_DELIVERY_VALIDATION_REQUIRED' }
        );
      }
      console.warn(`Warning: phase '${phase.id}' uses legacy inline code-delivery validation; regenerate to obtain v2 assurance.`);
    } else {
      const receiptSha256 = createHash('sha256').update(canonicalJson(receipt)).digest('hex');
      if (receipt.status !== 'ready'
        || receiptSha256 !== submittedReview.submissionEvidence?.codeDelivery?.sha256
        || receipt.tree?.generationCommit !== phase.generationCommit
        || (receipt.testExecutions ?? []).some((execution) => execution.status !== 'passed')) {
        throw new SingularityFlowError(
          `Phase '${phase.id}' code-delivery receipt is absent, stale, or does not contain passing test evidence.`,
          { code: 'CODE_DELIVERY_VALIDATION_REQUIRED' }
        );
      }
      const committedBeforeReview = run('git', [
        'merge-base', '--is-ancestor', receipt.tree.generationCommit, submittedReview.evidenceCommit
      ], { cwd: root, allowFailure: true });
      if (committedBeforeReview.status !== 0) {
        throw new SingularityFlowError(
          `Phase '${phase.id}' immutable review evidence is not descended from its generation commit.`,
          { code: 'CODE_DELIVERY_VALIDATION_REQUIRED' }
        );
      }
      const replay = await verifyCodeDeliveryReceipt(root, receipt, {
        protectedPaths: [...new Set([
          ...(config.governance?.protectedPaths ?? []),
          ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])
        ])],
        sourceBoundary: phase.sourceBoundary,
        symlinkPolicy: workflow.resolution?.codeDelivery?.changeSet?.symlinks ?? 'reject',
        minimumDiscovered: workflow.resolution?.codeDelivery?.tests?.minimumDiscovered ?? 1,
        minimumPassed: workflow.resolution?.codeDelivery?.tests?.minimumPassed ?? 1,
        requireAffectedModuleCoverage: workflow.resolution?.codeDelivery?.tests?.requireAffectedModuleCoverage !== false,
        minimumModelAssurance: workflow.resolution?.codeDelivery?.model?.minimumAssurance ?? 'unavailable',
        evidenceCommit: submittedReview.evidenceCommit
      });
      if (!replay.valid) {
        throw new SingularityFlowError(
          `Phase '${phase.id}' committed code-delivery evidence no longer verifies:\n- ${replay.errors.join('\n- ')}`,
          { code: 'CODE_DELIVERY_VALIDATION_REQUIRED' }
        );
      }
    }
  }
  if (phase.requiredArtifact?.kind === 'conformance-report') {
    const report = await readArtifactText(root, requiredRepoPath(config, workflow, phase));
    const blocking = blockingConformanceVerdicts(report);
    if (blocking.length) {
      throw new SingularityFlowError(
        `Phase '${phase.id}' cannot be approved while conformance is incomplete:\n- `
        + blocking.map((finding) => `${finding.clauseId}: ${finding.verdict}`).join('\n- '),
        { code: 'CONFORMANCE_BLOCKING_VERDICTS' }
      );
    }
  }
  const briefReview = await verifyAgentBriefsForReview(root, workflow, phase, {
    itemRelative: workDirRelative(config, workflow.workItem.id)
  });
  if (!briefReview.valid) {
    throw new SingularityFlowError(
      `Phase ${phase.id} downstream agent-brief review failed:\n- ${briefReview.errors.join('\n- ')}`
    );
  }
  const session = await loadSession(root);
  const actor = session.actor;
  const key = actorKey(actor);
  const active = phase.approvals.filter((item) => !item.invalidatedAt && item.decision === 'approved');
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    phase.approvalPolicy,
    actor,
    { preferredAuthorities: remainingRequiredAuthorities(phase.approvalPolicy, active) }
  );
  if (active.some((item) => actorKey(item.actor) === key)) throw new SingularityFlowError(`${key} already approved phase ${phase.id}; approvals require distinct identities.`);

  /**
   * The reviewer's checklist `[SPK:REQ-060]` `[SPK:REQ-061]` `[SPK:REQ-181]`.
   *
   * Evaluated before the decision is constructed, so an approval that does not carry its articles
   * never becomes one. There is deliberately no shortcut that fills the articles in: `[SPK:CON-030]`
   * says a model may summarize the evidence but must not produce the confirmation attributed to a
   * human, and a `--all-satisfied` flag would be precisely that flag with a human's name on it.
   */
  const review = evaluateApprovalChecklist({
    policy: resolvedSpecificationQualityPolicy(config, workflow, phase),
    decisions: checklist,
    authorities: workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    actor
  });
  review.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  if (review.errors.length) {
    throw new SingularityFlowError(
      `Phase ${phase.id} approval is incomplete:\n- ${review.errors.join('\n- ')}\n`
      + `Record one decision for every article with singularity-flow approve ${phase.id} --article <id>=satisfied|exception|not-applicable [--article-reason TEXT], or --checklist <file.json>.`
    );
  }
  const decision = {
    decision: 'approved',
    phase: phase.id,
    at: nowIso(),
    actor,
    agent: session.agent,
    authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance,
    channel,
    generation: phase.generation,
    artifactSha256: (phase.artifacts ?? []).map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 ?? null })),
    // `[SPK:CON-045]`: a reviewer may discuss one member, but the approval binds the whole bundle.
    // Recorded as the single hash of the complete set, so an approval cannot survive a member being
    // regenerated underneath it — the bundle it named no longer exists.
    ...(phase.artifactSet ? { artifactSet: phase.artifactSet.setId, bundleSha256: phase.artifactSet.bundleSha256 } : {}),
    reviewPacketSha256: submittedReview.packetSha256,
    evidenceCommit: submittedReview.evidenceCommit,
    artifactSetSha256: submittedReview.submissionEvidence.artifactSetSha256,
    // Compatibility alias for consumers introduced with code-delivery v2.
    ...(phaseRequiresCodeDelivery(phase) ? { reviewEvidenceCommit: submittedReview.evidenceCommit } : {}),
    // Recorded on the decision, not on the phase: the articles are what *this reviewer* confirmed,
    // and a second approver's exceptions are their own. The checklist hash travels with them so a
    // later reader knows which version of the articles was answered.
    ...(review.mode === 'off' ? {} : { checklist: review.decisions, checklistSha256: review.checklistSha256 }),
    ...(actionContext ? { actionContext } : {}),
    selfApproval: actorKey(phase.generatedBy ?? {}) === key
  };
  if (decision.selfApproval && phase.approvalPolicy.allowSelfApproval === false) {
    throw new SingularityFlowError(`Capability and workflow policy prohibit self-approval for phase '${phase.id}'. Ask another authorized Git identity to approve this generation.`);
  }
  phase.approvals.push(decision);
  const reached = approvalRequirementsMet(phase.approvalPolicy, phase.approvals);
  if (reached) {
    phase.status = 'approved'; phase.approvedAt = decision.at; phase.approvedBy = key;
    closeWorkInterval(workflow, {
      phaseId: phase.id,
      at: decision.at,
      actor: key,
      agent: session.agent
    });
    const resolved = (workflow.changeRequests ?? []).filter((request) =>
      request.status === 'open' && request.targetPhase === phase.id
    );
    for (const request of resolved) {
      request.status = 'resolved';
      request.resolvedAt = decision.at;
      request.resolvedBy = key;
      request.resolution = {
        phase: phase.id,
        generation: phase.generation,
        artifactSha256: (phase.artifacts ?? []).map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 ?? null })),
        approvalDecisionAt: decision.at
      };
    }
    if (resolved.length) decision.resolvedChangeRequests = resolved.map((request) => request.id);
    const upcoming = nextPhase(workflow, phase);
    if (upcoming) {
      upcoming.status = 'in_progress'; upcoming.startedAt = decision.at; workflow.currentPhase = upcoming.id;
      // Gated with every other durable write here. Under `persist: false` the caller owns
      // persistence, and the publication unit's `phase-approved` branch writes this baseline inside
      // the transaction instead.
      if (persist) {
        await ensureWorkIntervalBaseline(root, config, workflow, {
          phaseId: upcoming.id,
          itemDirectory: workDir(root, config, workflow.workItem.id),
          itemRelative: workDirRelative(config, workflow.workItem.id)
        });
      }
    }
    else { workflow.currentPhase = null; workflow.status = 'complete'; }
    await markIntentAmendmentRevalidated(root, config, workflow, phase, decision.at, session.actor);
  }
  workflow.history.push({ at: decision.at, actor: key, agent: session.agent, event: decision.selfApproval ? 'phase_self_approved' : 'phase_approved', phase: phase.id, detail: reached ? `threshold reached${workflow.currentPhase ? `; advanced to ${workflow.currentPhase}` : '; complete'}` : 'approval recorded' });
  if (persist) {
    // A partial threshold decision must not rewrite the artifact under review. Doing so made the
    // next reviewer see different bytes and invalidated the immutable submission packet even
    // though no authored content changed. The workflow and decision receipt record partial votes;
    // managed artifact metadata is rendered only once the threshold is actually reached.
    if (reached) {
      await updateArtifactMetadata(root, config, workflow, phase);
      await registerApprovedSnapshot(root, config, workflow, phase);
      await refreshPhaseSpecificationIndex(root, config, workflow, phase);
    }
    await writeDecision(root, config, workflow, phase, decision);
    await saveWorkflow(root, config, workflow);
  }
  const next = reached ? currentPhase(workflow) : phase;
  const contextBoundary = reached
    ? contextBoundaryHandoff(workflow.resolution.contextPolicy, phase.id, {
      nextPhase: next?.id ?? null,
      complete: workflow.status === 'complete'
    })
    : null;
  return { phase, next, approval: { approvedBy: key, ...decision }, reached, contextBoundary };
}

async function registerApprovedSnapshot(root, config, workflow, phase) {
  const required = requiredRepoPath(config, workflow, phase); const current = await snapshot(path.join(root, required)); const existing = artifactFor(phase, required);
  if (existing) Object.assign(existing, { ...current, status: phase.status === 'approved' ? 'approved' : 'pending', approvedAt: phase.approvedAt, approvedBy: phase.approvedBy });
}

async function refreshPhaseSpecificationIndex(root, config, workflow, phase) {
  const specPolicy = workflow.resolution?.spec ?? config.spec ?? { mode: 'off' };
  if (specPolicy.mode === 'off'
      || !['requirements', 'implementation-spec', 'conformance-report'].includes(phase.requiredArtifact?.kind)) return null;
  const itemDirectory = workDir(root, config, workflow.workItem.id);
  const priorSpecRecords = await loadActiveSpecRecords(itemDirectory, workflow);
  const specIndexPath = posix(path.join(
    workDirRelative(config, workflow.workItem.id), 'context', 'spec-indexes',
    `${phase.id}-gen${phase.generation}.json`
  ));
  const specIndex = await buildSpecIndex(root, requiredRepoPath(config, workflow, phase), {
    workId: workflow.workItem.id,
    phase: phase.id,
    generation: phase.generation,
    outputPath: specIndexPath,
    policy: specPolicy,
    externalClauses: predecessorSpecClauses(priorSpecRecords, workflow, phase.id)
  });
  phase.specIndex = {
    generation: phase.generation,
    path: specIndexPath,
    clauses: specIndex.clauses.length,
    indexSha256: specIndex.indexSha256,
    sourceSha256: specIndex.source.sha256
  };
  if (specPolicy.mode === 'enforce' && !specIndex.clauses.length) {
    throw new SingularityFlowError(
      `Phase ${phase.id} requires stable clause anchors such as [${specPolicy.namespace ?? 'APP'}:REQ-001].`
    );
  }
  return specIndex;
}

async function refreshRequiredArtifact(root, config, workflow, phase) {
  const required = requiredRepoPath(config, workflow, phase); const current = await snapshot(path.join(root, required)); const existing = artifactFor(phase, required);
  if (existing) Object.assign(existing, { ...current, updatedAt: nowIso() });
  else phase.artifacts.push({ path: required, kind: phase.requiredArtifact.kind ?? inferKind(required), status: 'pending', ...current, registeredAt: nowIso(), updatedAt: nowIso() });
}

export async function rejectPhase(root, config, workflow, { phaseId, target, reason, clauseIds = [], members = [], convergenceRework = null, channel = 'terminal', actionContext = null } = {}) {
  await assertNoPendingPublication(root, config, workflow, 'reject');
  /**
   * Governed rework out of convergence `[SPK:REQ-182]`.
   *
   * Convergence is `in_progress` when its findings are adjudicated — nobody has submitted it, and
   * asking a reviewer to approve a phase so that it can immediately be rejected would put a second
   * person in the loop for a decision the first already made.
   *
   * So this is the one caller that may reject an unsubmitted phase, and the exception is narrow on
   * purpose: it is honoured only when the projection it names actually carries blocking rework
   * findings. The flag cannot be used to skip an approval, because a phase with nothing to rework
   * has nothing to authorise it. Everything after this line is the ordinary rejection path — the
   * same authority check, change request, invalidation and transition `[SPK:REQ-082]`.
   */
  const reworkBlockers = convergenceRework?.unresolvedBlockers ?? [];
  if (convergenceRework && !reworkBlockers.length) {
    throw new SingularityFlowError('Convergence rework needs at least one finding dispositioned as rework.');
  }
  const phase = await assertPhaseSequence(root, workflow, 'reject', {
    requestedPhase: phaseId,
    allowedStatuses: reworkBlockers.length ? ['awaiting_approval', 'in_progress'] : ['awaiting_approval']
  });
  if (phase.approvalPolicy.changeRequests?.commentRequired !== false && !reason?.trim()) {
    throw new SingularityFlowError('A change-request comment is required.');
  }
  const session = await loadSession(root);
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    phase.approvalPolicy,
    session.actor
  );
  const targetId = target ?? phase.id; if (!(phase.approvalPolicy.rejectTo ?? [phase.id]).includes(targetId)) throw new SingularityFlowError(`Phase '${phase.id}' cannot be rejected to '${targetId}'. Allowed: ${(phase.approvalPolicy.rejectTo ?? []).join(', ')}.`);
  const targetIndex = workflow.phaseOrder.indexOf(targetId); if (targetIndex < 0 || targetIndex > workflow.phaseOrder.indexOf(phase.id)) throw new SingularityFlowError(`Invalid rejection target '${targetId}'.`);
  const requestedClauses = [...new Set(clauseIds)];
  if (requestedClauses.length) {
    const records = await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow);
    const known = new Set(records.indexes.flatMap((index) => (index.clauses ?? []).map((clause) => clause.id)));
    const unknown = requestedClauses.filter((id) => !known.has(id));
    if (unknown.length) throw new SingularityFlowError(`Change request references unknown specification clause(s): ${unknown.join(', ')}.`);
  }
  /**
   * Surgical reopen `[SPK:REQ-111]`.
   *
   * A rejection may name the members it expects to be regenerated. That is a promise, and the next
   * publication checks it: unchanged members must still hash the same, and anything else that moved
   * is disclosed. Naming a member that is not in the set is refused here rather than silently
   * ignored — a typo that quietly widens the promise to "nothing in particular" would make the whole
   * disclosure vacuous.
   */
  const requestedMembers = [...new Set(members.map((member) => posix(String(member).trim())).filter(Boolean))];
  if (requestedMembers.length) {
    const set = resolvedArtifactSet(config, workflow, phase);
    if (!set) throw new SingularityFlowError(`Phase '${phase.id}' has no artifact set, so it has no members to reopen.`);
    const known = new Set(set.members.flatMap((member) => [
      member.path, posix(path.posix.join(workDirRelative(config, workflow.workItem.id), memberRoot(phase), member.path))
    ]));
    const unknown = requestedMembers.filter((member) => !known.has(member));
    if (unknown.length) {
      throw new SingularityFlowError(`Artifact set '${set.id}' has no member(s): ${unknown.join(', ')}. Members are ${set.members.map((member) => member.path).join(', ')}.`);
    }
  }

  const timestamp = nowIso(); const key = actorKey(session.actor);
  workflow.changeRequests ??= [];
  const changeRequest = {
    schemaVersion: 1,
    id: `CR-${String(workflow.changeRequests.length + 1).padStart(3, '0')}`,
    status: 'open',
    sourcePhase: phase.id,
    sourceGeneration: phase.generation,
    targetPhase: targetId,
    clauseIds: requestedClauses,
    // The convergence iteration this rework came out of, so the next one can be read against it
    // `[SPK:REQ-083]` and the prior findings stay reachable rather than merely preserved on disk.
    ...(convergenceRework ? {
      convergence: {
        iteration: convergenceRework.iteration,
        convergenceSha256: convergenceRework.convergenceSha256 ?? null,
        findingIds: reworkBlockers
      }
    } : {}),
    ...(requestedMembers.length ? { members: requestedMembers } : {}),
    comment: reason?.trim() || 'Changes requested.',
    requestedAt: timestamp,
    requestedBy: session.actor,
    agent: session.agent,
    channel,
    authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance,
    sourceArtifactSha256: (phase.artifacts ?? []).map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 ?? null })),
    reviewPacketSha256: null,
    resolution: null
  };
  const budgetPhase = repairBudgetPhaseForRejection(workflow, phase, targetId);
  const repairBudget = budgetPhase ? consumeRepairAttempt(workflow, budgetPhase, {
    targetPhase: targetId,
    actor: structuredClone(session.actor),
    at: timestamp,
    changeRequestId: changeRequest.id
  }) : null;
  for (let index = targetIndex; index < workflow.phaseOrder.length; index += 1) {
    const affected = workflow.phases[workflow.phaseOrder[index]];
    affected.approvals.forEach((approval) => { if (!approval.invalidatedAt) approval.invalidatedAt = timestamp; });
    affected.status = index === targetIndex ? 'in_progress' : 'not_started'; affected.submittedAt = null; affected.approvedAt = null; affected.approvedBy = null;
    if (index === targetIndex) { affected.rejectedAt = timestamp; affected.rejectedBy = key; affected.rejectionReason = changeRequest.comment; }
    await updateArtifactMetadata(root, config, workflow, affected);
  }
  workflow.currentPhase = targetId; workflow.status = 'in_progress';
  await ensureWorkIntervalBaseline(root, config, workflow, {
    phaseId: targetId,
    itemDirectory: workDir(root, config, workflow.workItem.id),
    itemRelative: workDirRelative(config, workflow.workItem.id)
  });
  const packet = workflow.lineage?.submissions?.findLast?.((entry) =>
    entry.phase === phase.id && entry.generation === phase.generation
  ) ?? [...(workflow.lineage?.submissions ?? [])].reverse().find((entry) =>
    entry.phase === phase.id && entry.generation === phase.generation
  );
  changeRequest.reviewPacketSha256 = packet?.packetSha256 ?? null;
  workflow.changeRequests.push(changeRequest);
  const decision = {
    decision: 'rejected',
    phase: phase.id,
    target: targetId,
    reason: changeRequest.comment,
    changeRequestId: changeRequest.id,
    clauseIds: requestedClauses,
    at: timestamp,
    actor: session.actor,
    agent: session.agent,
    authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance,
    channel,
    generation: phase.generation,
    artifactSha256: (phase.artifacts ?? []).map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 ?? null })),
    reviewPacketSha256: packet?.packetSha256 ?? null,
    ...(phase.artifactSet ? { artifactSet: phase.artifactSet.setId, bundleSha256: phase.artifactSet.bundleSha256 } : {}),
    ...(requestedMembers.length ? { members: requestedMembers } : {}),
    ...(repairBudget ? { repairBudget: { consumed: repairBudget.attempts.length, maximum: repairBudget.maximum } } : {}),
    ...(actionContext ? { actionContext } : {})
  };
  phase.approvals.push(decision); await writeDecision(root, config, workflow, phase, decision);
  // The promise the next generation has to keep `[SPK:REQ-111]`. Recorded on the *target* phase,
  // which is the one that will regenerate — rejecting `verification` back to `specification` means
  // the specification is what gets reopened.
  if (requestedMembers.length) {
    workflow.phases[targetId].surgicalReopen = {
      changeRequestId: changeRequest.id,
      members: requestedMembers,
      requestedAt: timestamp,
      requestedBy: structuredClone(session.actor),
      reason: changeRequest.comment
    };
  }
  workflow.history.push({ at: timestamp, actor: key, agent: session.agent, event: 'phase_rejected', phase: phase.id, detail: `${changeRequest.id} returned to ${targetId}: ${changeRequest.comment}` });
  await saveWorkflow(root, config, workflow);
  return {
    ...workflow.phases[targetId],
    changeRequest,
    ...(repairBudget ? { repairBudget } : {}),
    contextBoundary: contextBoundaryHandoff(workflow.resolution.contextPolicy, phase.id, {
      event: 'rejection',
      nextPhase: targetId
    })
  };
}

function intentAmendmentSummary(workflow, proposalId) {
  return (workflow.intentAmendments ?? []).find((entry) => entry.id === proposalId) ?? null;
}

function intentAmendmentPath(root, config, workflow, relative, label) {
  const itemRoot = path.resolve(workDir(root, config, workflow.workItem.id));
  const target = path.resolve(root, relative ?? '');
  if (target === itemRoot || !target.startsWith(`${itemRoot}${path.sep}`)) {
    throw new SingularityFlowError(`${label} must remain inside Story '${workflow.workItem.id}'.`, {
      code: 'INTENT_AMENDMENT_INVALID'
    });
  }
  return target;
}

/** An approved amendment that this checkout has not yet acknowledged. */
export function pendingIntentAmendmentAcknowledgement(workflow) {
  return [...(workflow.intentAmendments ?? [])]
    .reverse()
    .find((entry) => entry.status === 'approved' && !entry.acknowledgedAt) ?? null;
}

async function persistIntentAmendmentRecord(root, config, workflow, summary, record) {
  const file = intentAmendmentPath(root, config, workflow, summary.recordPath, 'Intent-amendment record');
  await writeJson(file, record);
}

/**
 * Record the authority decision and, once its threshold is reached, install the approved intent.
 *
 * This is deliberately not `rejectPhase`: code rework and corrected intent have different
 * authority, different evidence consequences, and different next actions. The specification gains
 * a new approved generation; downstream phases are replayed through the ordinary sequence while
 * their existing evidence is retained and labelled affected or preserved.
 */
export async function decideIntentAmendment(root, config, workflow, proposal, {
  decision,
  reason = null,
  channel = 'terminal',
  actionContext = null
} = {}) {
  if (!['approve', 'reject'].includes(decision)) {
    throw new SingularityFlowError("Intent-amendment decision must be 'approve' or 'reject'.", {
      code: 'INTENT_AMENDMENT_DECISION_INVALID'
    });
  }
  const summary = intentAmendmentSummary(workflow, proposal?.id);
  if (!summary || summary.status !== 'proposed' || proposal?.status !== 'proposed') {
    throw new SingularityFlowError(`Intent amendment '${proposal?.id ?? 'unknown'}' is not awaiting a decision.`, {
      code: 'INTENT_AMENDMENT_NOT_PENDING'
    });
  }
  if (summary.proposalSha256 !== proposal.proposalSha256) {
    throw new SingularityFlowError(`Intent amendment '${proposal.id}' no longer matches its workflow binding.`, {
      code: 'INTENT_AMENDMENT_INVALID'
    });
  }
  const specification = workflow.phases.specification;
  if (!specification) {
    throw new SingularityFlowError(`Work type '${workflow.workItem.workType}' has no specification phase to amend.`, {
      code: 'INTENT_AMENDMENT_UNSUPPORTED'
    });
  }
  const session = await loadSession(root);
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    specification.approvalPolicy,
    session.actor
  );
  const key = actorKey(session.actor);
  const decisions = [...(proposal.decisions ?? [])];
  if (decisions.some((entry) => actorKey(entry.actor) === key)) {
    throw new SingularityFlowError(`${key} already decided intent amendment ${proposal.id}; decisions require distinct identities.`);
  }
  const selfApproval = actorKey(proposal.proposedBy ?? {}) === key;
  if (selfApproval && specification.approvalPolicy.allowSelfApproval === false) {
    throw new SingularityFlowError(
      `Specification policy prohibits the proposer from approving intent amendment '${proposal.id}'. Ask another authorized Git identity.`
    );
  }
  const at = nowIso();
  const recorded = {
    decision: decision === 'approve' ? 'approved' : 'rejected',
    at,
    actor: structuredClone(session.actor),
    agent: session.agent ?? null,
    authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance,
    channel,
    reason: reason?.trim() || null,
    selfApproval,
    ...(actionContext ? { actionContext } : {})
  };
  decisions.push(recorded);
  proposal.decisions = decisions;

  if (decision === 'reject') {
    proposal.status = 'rejected';
    proposal.decidedAt = at;
    proposal.decision = recorded;
    Object.assign(summary, { status: 'rejected', decidedAt: at, decision: recorded });
    workflow.history.push({
      at, actor: key, agent: session.agent, event: 'intent_amendment_rejected',
      phase: 'specification', detail: `${proposal.id}: ${recorded.reason ?? 'rejected by specification authority'}`
    });
    await persistIntentAmendmentRecord(root, config, workflow, summary, proposal);
    return { proposal, reached: true, applied: false, affectedPhases: [], preservedEvidence: [] };
  }

  const approvals = decisions.filter((entry) => entry.decision === 'approved');
  const minimum = specification.approvalPolicy.minimum ?? 1;
  if (approvals.length < minimum) {
    proposal.status = 'proposed';
    proposal.approvals = { reached: approvals.length, required: minimum };
    Object.assign(summary, { approvals: proposal.approvals });
    await persistIntentAmendmentRecord(root, config, workflow, summary, proposal);
    return { proposal, reached: false, applied: false, affectedPhases: [], preservedEvidence: [] };
  }

  const specificationPath = requiredRepoPath(config, workflow, specification);
  if (specificationPath !== proposal.specification?.artifact) {
    throw new SingularityFlowError(`Intent amendment '${proposal.id}' targets a different specification artifact.`, {
      code: 'INTENT_AMENDMENT_INVALID'
    });
  }
  const specificationFile = path.join(root, specificationPath);
  const current = await snapshot(specificationFile);
  if (!current.exists || current.sha256 !== proposal.specification.beforeSha256) {
    throw new SingularityFlowError(
      `Specification changed after intent amendment '${proposal.id}' was proposed. Create a new proposal against the current generation.`,
      { code: 'INTENT_AMENDMENT_STALE' }
    );
  }
  const proposedFile = intentAmendmentPath(root, config, workflow,
    proposal.specification.proposedPath, 'Proposed specification');
  const proposedText = await readFile(proposedFile, 'utf8');
  const proposedSnapshot = await snapshot(proposedFile);
  if (proposedSnapshot.sha256 !== proposal.specification.proposedSha256) {
    throw new SingularityFlowError(`Intent amendment '${proposal.id}' proposed bytes changed after review.`, {
      code: 'INTENT_AMENDMENT_STALE'
    });
  }

  await writeText(specificationFile, proposedText);
  const priorGeneration = Number(specification.generation ?? 0);
  specification.approvals.forEach((approval) => {
    if (!approval.invalidatedAt) approval.invalidatedAt = at;
  });
  specification.generation = priorGeneration + 1;
  specification.status = 'approved';
  specification.submittedAt = at;
  specification.approvedAt = at;
  specification.approvedBy = key;
  specification.generatedAt = at;
  specification.generatedBy = structuredClone(proposal.proposedBy ?? session.actor);
  const amendmentApproval = {
    ...recorded,
    decision: 'approved',
    phase: specification.id,
    generation: specification.generation,
    intentAmendmentId: proposal.id,
    changedClauses: [...(proposal.diff?.changed ?? [])],
    artifactSha256: [{ path: specificationPath, sha256: proposedSnapshot.sha256 }]
  };
  specification.approvals.push(amendmentApproval);
  await updateArtifactMetadata(root, config, workflow, specification);
  await registerApprovedSnapshot(root, config, workflow, specification);

  // An approved intent amendment creates a new specification generation without travelling
  // through the ordinary publish -> submit path. It must nevertheless mint the same downstream
  // projections as a normally published generation; otherwise the first replayed phase sees an
  // approved producer with no generation-bound brief and cannot prepare its inputs.
  //
  // Bind the deterministic records to the authority decision itself. The proposed artifact bytes
  // were what the authority reviewed, while `agentBriefSource` names the kernel-managed bytes after
  // their metadata block was refreshed. Keeping both bindings avoids inventing a synthetic submit
  // ceremony and lets downstream verification distinguish this exceptional, reviewed transition
  // from an unreviewed missing submission packet.
  const agentBriefs = await createAgentBriefs(root, workflow, specification, {
    itemDirectory: workDir(root, config, workflow.workItem.id),
    itemRelative: workDirRelative(config, workflow.workItem.id)
  });
  if (agentBriefs.length) {
    specification.agentBriefs = [
      ...(specification.agentBriefs ?? []).filter((entry) => entry.generation !== specification.generation),
      ...agentBriefs
    ].sort((left, right) => left.generation - right.generation || left.consumerPhase.localeCompare(right.consumerPhase));
    const approvedSource = artifactFor(specification, specificationPath);
    amendmentApproval.agentBriefSource = approvedSource ? {
      path: approvedSource.path,
      sha256: approvedSource.sha256,
      size: approvedSource.size
    } : null;
    amendmentApproval.agentBriefs = agentBriefs.map((brief) => ({
      consumerPhase: brief.consumerPhase,
      status: brief.status,
      path: brief.path,
      renderedPath: brief.renderedPath,
      sourceSha256: brief.sourceSha256,
      sourceBytes: brief.sourceBytes ?? null,
      renderedSha256: brief.renderedSha256,
      integritySha256: brief.integritySha256
    }));
  }
  await writeDecision(root, config, workflow, specification, amendmentApproval);

  const specificationIndex = workflow.phaseOrder.indexOf(specification.id);
  const nextIndex = specificationIndex + 1;
  if (specificationIndex < 0 || nextIndex >= workflow.phaseOrder.length) {
    throw new SingularityFlowError('An intent amendment requires a downstream phase to revalidate.', {
      code: 'INTENT_AMENDMENT_UNSUPPORTED'
    });
  }
  const changedClauses = [...(proposal.diff?.changed ?? [])];
  const evidencePaths = new Set([
    ...(proposal.radius?.artifacts ?? []),
    ...(proposal.radius?.tests ?? [])
  ].map(posix));
  const affectedPhases = [];
  const preservedEvidence = [];
  for (let index = nextIndex; index < workflow.phaseOrder.length; index += 1) {
    const phase = workflow.phases[workflow.phaseOrder[index]];
    let directlyAffected = phase.id === 'convergence'
      || (phase.id === 'implementation' && Number(proposal.radius?.totals?.affected ?? 0) > 0);
    for (const artifact of phase.artifacts ?? []) {
      let affected = evidencePaths.has(posix(artifact.path));
      if (!affected) {
        const artifactFile = path.join(root, artifact.path);
        if (existsSync(artifactFile)) {
          const text = await readFile(artifactFile, 'utf8').catch(() => '');
          affected = changedClauses.some((clauseId) => text.includes(clauseId));
        }
      }
      artifact.intentAmendment = {
        id: proposal.id,
        state: affected ? 'affected-revalidation-required' : 'preserved-unaffected',
        fromSpecificationGeneration: priorGeneration,
        toSpecificationGeneration: specification.generation
      };
      if (affected) directlyAffected = true;
      else preservedEvidence.push(artifact.path);
    }
    if (directlyAffected) affectedPhases.push(phase.id);
    phase.approvals.forEach((approval) => {
      if (!approval.invalidatedAt) approval.invalidatedAt = at;
    });
    phase.status = index === nextIndex ? 'in_progress' : 'not_started';
    phase.submittedAt = null;
    phase.approvedAt = null;
    phase.approvedBy = null;
    phase.rejectedAt = at;
    phase.rejectedBy = key;
    phase.rejectionReason = `Revalidate after approved intent amendment ${proposal.id}.`;
    phase.intentAmendmentRevalidation = {
      id: proposal.id,
      state: directlyAffected ? 'affected' : 'evidence-preserved',
      changedClauses,
      acknowledgedAt: null,
      revalidatedAt: null
    };
    await updateArtifactMetadata(root, config, workflow, phase);
  }
  workflow.currentPhase = workflow.phaseOrder[nextIndex];
  workflow.status = 'in_progress';

  proposal.status = 'approved';
  proposal.decidedAt = at;
  proposal.decision = recorded;
  proposal.application = {
    fromSpecificationGeneration: priorGeneration,
    toSpecificationGeneration: specification.generation,
    affectedPhases,
    preservedEvidence: [...new Set(preservedEvidence)].sort(),
    acknowledgementRequired: true
  };
  Object.assign(summary, {
    status: 'approved', decidedAt: at, decision: recorded,
    changedClauses, affectedPhases,
    preservedEvidence: proposal.application.preservedEvidence,
    acknowledgementRequired: true,
    acknowledgedAt: null,
    revalidatedPhases: []
  });
  workflow.history.push({
    at, actor: key, agent: session.agent, event: 'intent_amendment_approved', phase: 'specification',
    detail: `${proposal.id} created specification generation ${specification.generation}; `
      + `${affectedPhases.length} phase(s) affected and ${proposal.application.preservedEvidence.length} evidence item(s) preserved`
  });
  await persistIntentAmendmentRecord(root, config, workflow, summary, proposal);
  return {
    proposal,
    reached: true,
    applied: true,
    affectedPhases,
    preservedEvidence: proposal.application.preservedEvidence
  };
}

/** Record the human beat required before an amended Story can be submitted again. */
export async function acknowledgeIntentAmendment(root, config, workflow, proposalId = null) {
  const summary = proposalId
    ? intentAmendmentSummary(workflow, proposalId)
    : pendingIntentAmendmentAcknowledgement(workflow);
  if (!summary || summary.status !== 'approved') {
    throw new SingularityFlowError('There is no approved intent amendment awaiting acknowledgement.', {
      code: 'INTENT_AMENDMENT_ACKNOWLEDGEMENT_UNNEEDED'
    });
  }
  if (summary.acknowledgedAt) return { ...summary, acknowledged: false };
  const session = await loadSession(root);
  const at = nowIso();
  summary.acknowledgedAt = at;
  summary.acknowledgedBy = structuredClone(session.actor);
  summary.acknowledgementRequired = false;
  for (const phase of Object.values(workflow.phases ?? {})) {
    if (phase.intentAmendmentRevalidation?.id === summary.id) {
      phase.intentAmendmentRevalidation.acknowledgedAt = at;
    }
  }
  const record = await readJson(intentAmendmentPath(root, config, workflow, summary.recordPath,
    'Intent-amendment record'));
  record.acknowledgedAt = at;
  record.acknowledgedBy = structuredClone(session.actor);
  await persistIntentAmendmentRecord(root, config, workflow, summary, record);
  workflow.history.push({
    at, actor: actorKey(session.actor), agent: session.agent, event: 'intent_amendment_acknowledged',
    phase: workflow.currentPhase, detail: `${summary.id} acknowledged before downstream revalidation`
  });
  return { ...summary, acknowledged: true };
}

async function markIntentAmendmentRevalidated(root, config, workflow, phase, at, actor) {
  const id = phase.intentAmendmentRevalidation?.id;
  if (!id) return;
  const summary = intentAmendmentSummary(workflow, id);
  if (!summary) return;
  phase.intentAmendmentRevalidation.revalidatedAt = at;
  phase.intentAmendmentRevalidation.revalidatedBy = actor;
  summary.revalidatedPhases = [...new Set([...(summary.revalidatedPhases ?? []), phase.id])];
  const required = workflow.phaseOrder.slice(workflow.phaseOrder.indexOf('specification') + 1);
  if (required.every((phaseId) => summary.revalidatedPhases.includes(phaseId))) {
    summary.status = 'revalidated';
    summary.revalidatedAt = at;
  }
  const record = await readJson(intentAmendmentPath(root, config, workflow, summary.recordPath,
    'Intent-amendment record'));
  record.revalidatedPhases = summary.revalidatedPhases;
  if (summary.revalidatedAt) {
    record.status = 'revalidated';
    record.revalidatedAt = summary.revalidatedAt;
  }
  await persistIntentAmendmentRecord(root, config, workflow, summary, record);
}

export async function reopenWorkflow(root, config, workflow, { target, reason, channel = 'terminal', actionContext = null } = {}) {
  await assertNoPendingPublication(root, config, workflow, 'reopen completed work');
  if (workflow.status !== 'complete' || workflow.currentPhase != null) {
    throw new SingularityFlowError(`Story '${workflow.workItem.id}' is not complete; use reject while a phase is awaiting approval.`);
  }
  const completionPhase = workflow.phases[workflow.phaseOrder.at(-1)];
  if (completionPhase.approvalPolicy.changeRequests?.reopenCompleted === false) {
    throw new SingularityFlowError(`Phase '${completionPhase.id}' policy does not allow completed work to be reopened.`);
  }
  const targetId = target ?? completionPhase.id;
  const allowed = completionPhase.approvalPolicy.rejectTo ?? [completionPhase.id];
  if (!allowed.includes(targetId)) {
    throw new SingularityFlowError(`Completed Story '${workflow.workItem.id}' cannot be reopened to '${targetId}'. Allowed: ${allowed.join(', ')}.`);
  }
  const targetIndex = workflow.phaseOrder.indexOf(targetId);
  if (targetIndex < 0) throw new SingularityFlowError(`Unknown reopen target '${targetId}'.`);
  if (completionPhase.approvalPolicy.changeRequests?.commentRequired !== false && !reason?.trim()) {
    throw new SingularityFlowError('A change-request comment is required to reopen completed work.');
  }
  const session = await loadSession(root);
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    completionPhase.approvalPolicy,
    session.actor
  );
  const timestamp = nowIso();
  const key = actorKey(session.actor);
  workflow.changeRequests ??= [];
  const changeRequest = {
    schemaVersion: 1,
    id: `CR-${String(workflow.changeRequests.length + 1).padStart(3, '0')}`,
    status: 'open',
    sourcePhase: completionPhase.id,
    sourceGeneration: completionPhase.generation,
    targetPhase: targetId,
    comment: reason?.trim() || 'Completed work reopened.',
    requestedAt: timestamp,
    requestedBy: session.actor,
    agent: session.agent,
    channel,
    authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance,
    sourceArtifactSha256: (completionPhase.artifacts ?? []).map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 ?? null })),
    reviewPacketSha256: null,
    resolution: null
  };
  for (let index = targetIndex; index < workflow.phaseOrder.length; index += 1) {
    const affected = workflow.phases[workflow.phaseOrder[index]];
    affected.approvals.forEach((approval) => { if (!approval.invalidatedAt) approval.invalidatedAt = timestamp; });
    affected.status = index === targetIndex ? 'in_progress' : 'not_started';
    affected.submittedAt = null; affected.approvedAt = null; affected.approvedBy = null;
    if (index === targetIndex) {
      affected.rejectedAt = timestamp; affected.rejectedBy = key; affected.rejectionReason = changeRequest.comment;
    }
    await updateArtifactMetadata(root, config, workflow, affected);
  }
  workflow.currentPhase = targetId;
  workflow.status = 'in_progress';
  // A completed Story created before code-task routing existed is upgraded when a human explicitly
  // reopens its implementation. Existing in-flight legacy/non-code workflows remain untouched;
  // the reopened generation receives the current delivery contract instead of repeating the
  // artifact-only outcome that caused the change request.
  const reopenedPhase = workflow.phases[targetId];
  if (reopenedPhase.requiredArtifact?.kind === 'implementation-summary'
      && (reopenedPhase.writeScope ?? 'artifact-only') === 'source-and-artifact') {
    reopenedPhase.generationPolicy ??= { requirement: 'required', defaultProducer: 'governed-agent', allowedProducers: ['governed-agent', 'human'] };
    reopenedPhase.generationPolicy.task = 'code';
  }
  await ensureWorkIntervalBaseline(root, config, workflow, {
    phaseId: targetId,
    itemDirectory: workDir(root, config, workflow.workItem.id),
    itemRelative: workDirRelative(config, workflow.workItem.id)
  });
  await invalidateImpactReceipt(root, config, workflow, {
    reason: changeRequest.comment,
    cause: 'workflow-reopened',
    actor: session.actor,
    agent: session.agent
  });
  workflow.changeRequests.push(changeRequest);
  const decision = {
    decision: 'reopened', phase: completionPhase.id, target: targetId,
    reason: changeRequest.comment, changeRequestId: changeRequest.id, at: timestamp,
    actor: session.actor, agent: session.agent, authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance, channel,
    generation: completionPhase.generation,
    artifactSha256: changeRequest.sourceArtifactSha256,
    ...(actionContext ? { actionContext } : {})
  };
  completionPhase.approvals.push(decision);
  await writeDecision(root, config, workflow, completionPhase, decision);
  workflow.history.push({
    at: timestamp, actor: key, agent: session.agent, event: 'workflow_reopened', phase: completionPhase.id,
    detail: `${changeRequest.id} returned completed work to ${targetId}: ${changeRequest.comment}`
  });
  await saveWorkflow(root, config, workflow);
  return { phase: workflow.phases[targetId], changeRequest, decision };
}

/**
 * Select a recorded design candidate and reopen the capture phase without
 * silently changing the approved source set. The caller publishes this mutation
 * through commitAndPublish; the next capture generation consumes the selection
 * and must be approved before downstream phases can proceed again.
 */
export async function promoteDesignSource(root, config, workflow, {
  candidateRecordId, reason = null, actor = null, agent = null, channel = 'terminal'
} = {}) {
  const configured = workflow.resolution?.designSources;
  if (!configured) throw new SingularityFlowError('This Story has no governed design-source policy.', { code: 'DESIGN_SOURCE_NOT_CONFIGURED' });
  const binding = approvedDesignSourceBinding(workflow);
  if (!binding) throw new SingularityFlowError('No approved design-source set exists to replace.', { code: 'DESIGN_SOURCE_APPROVAL_MISSING' });
  const evidence = await verifyMcpEvidence(root, workflow, { itemDirectory: workDir(root, config, workflow.workItem.id) });
  if (evidence.errors.length) throw new SingularityFlowError(`Design-source evidence is not valid:\n- ${evidence.errors.join('\n- ')}`, { code: 'DESIGN_SOURCE_EVIDENCE_INVALID' });
  const candidate = classifyDesignSourceCandidates(evidence.records, binding)
    .find((entry) => entry.candidateRecordId === candidateRecordId);
  if (!candidate) throw new SingularityFlowError(`Design-source candidate '${candidateRecordId}' is not available against the approved set.`, { code: 'DESIGN_SOURCE_CANDIDATE_UNKNOWN' });
  const targetIndex = workflow.phaseOrder.indexOf(configured.capturePhase);
  if (targetIndex < 0) throw new SingularityFlowError(`Pinned design-source capture phase '${configured.capturePhase}' is missing.`);
  const timestamp = nowIso();
  for (let index = targetIndex; index < workflow.phaseOrder.length; index += 1) {
    const affected = workflow.phases[workflow.phaseOrder[index]];
    for (const approval of affected.approvals ?? []) if (!approval.invalidatedAt) approval.invalidatedAt = timestamp;
    affected.status = index === targetIndex ? 'in_progress' : 'not_started';
    affected.submittedAt = null; affected.approvedAt = null; affected.approvedBy = null;
    await updateArtifactMetadata(root, config, workflow, affected);
  }
  const capture = workflow.phases[configured.capturePhase];
  capture.designSourceSelection = { ...(capture.designSourceSelection ?? {}), [candidate.fileKey]: candidate.candidateRecordId };
  workflow.currentPhase = configured.capturePhase;
  workflow.status = 'in_progress';
  const record = {
    schemaVersion: 1, candidateRecordId: candidate.candidateRecordId, fileKey: candidate.fileKey,
    approvedRecordId: candidate.approvedRecordId, approvedVersion: candidate.approvedVersion,
    candidateVersion: candidate.candidateVersion, classification: candidate.classification,
    reason: reason?.trim() || 'Promote recorded design-source candidate.', promotedAt: timestamp,
    promotedBy: actor, agent, channel
  };
  workflow.designSourcePromotions ??= [];
  workflow.designSourcePromotions.push(record);
  workflow.history.push({
    at: timestamp, actor: actor ? actorKey(actor) : 'unknown', agent,
    event: 'design_source_promoted', phase: configured.capturePhase,
    detail: `${candidate.fileKey}: ${candidate.approvedVersion} -> ${candidate.candidateVersion} (${candidate.candidateRecordId})`
  });
  return { candidate, capturePhase: configured.capturePhase, invalidatedPhases: workflow.phaseOrder.slice(targetIndex), record };
}

/**
 * End a Story without claiming it was successfully completed.
 *
 * Cancellation is a terminal, audited lifecycle decision. It deliberately keeps the
 * Story directory, artifacts, approvals, and branch intact so the archived record
 * remains reconstructable from Git.
 */
export async function cancelWorkflow(root, config, workflow, { reason, channel = 'terminal', actionContext = null } = {}) {
  await assertNoPendingPublication(root, config, workflow, 'cancel work');
  if (workflow.status === 'cancelled') {
    throw new SingularityFlowError(`Story '${workflow.workItem.id}' is already cancelled and archived.`);
  }
  if (workflow.status === 'complete' || workflow.currentPhase == null) {
    throw new SingularityFlowError(`Story '${workflow.workItem.id}' is complete; use reopen when post-completion changes are required.`);
  }
  const comment = String(reason ?? '').trim();
  if (!comment) throw new SingularityFlowError('A cancellation reason is required.');
  const phase = currentPhase(workflow);
  if (!phase) throw new SingularityFlowError(`Story '${workflow.workItem.id}' has no active phase to cancel.`);
  const session = await loadSession(root);
  const timestamp = nowIso();
  const record = {
    schemaVersion: 1,
    status: 'cancelled',
    phase: phase.id,
    generation: phase.generation,
    reason: comment,
    cancelledAt: timestamp,
    cancelledBy: session.actor,
    agent: session.agent ?? null,
    channel,
    ...(actionContext ? { actionContext } : {})
  };
  phase.status = 'cancelled';
  phase.cancelledAt = timestamp;
  phase.cancelledBy = session.actor;
  phase.cancellationReason = comment;
  workflow.status = 'cancelled';
  workflow.currentPhase = null;
  workflow.cancellation = record;
  workflow.history.push({
    at: timestamp,
    actor: actorKey(session.actor),
    agent: session.agent,
    event: 'work_cancelled',
    phase: phase.id,
    detail: comment
  });
  await updateArtifactMetadata(root, config, workflow, phase);
  await saveWorkflow(root, config, workflow);
  return { phase, cancellation: record };
}

export async function commitAndPublish(root, config, workflow, event, message, extraPaths = [], {
  beforeStateWrite = null,
  eventFromResult = null,
  transactionId = null,
  rollbackWorkflow = null,
  recoveryPreimage = null
} = {}) {
  if (await storyPublicationPending(root, config, workflow.workItem.id)) await assertNoPendingPublication(root, config, workflow, 'create another lifecycle commit');
  const ledgerConfig = normalizeLedgerConfig(workflow.resolution?.ledger ?? config.ledger ?? {});
  const requestedPhaseId = event?.phaseId ?? workflow.currentPhase ?? null;
  const requestedPhase = requestedPhaseId ? workflow.phases?.[requestedPhaseId] : null;
  const decision = [...(requestedPhase?.approvals ?? [])].reverse().find((item) => !item.invalidatedAt) ?? null;
  const envelope = lifecycleEvent({
    ...event,
    subject: { kind: 'story', id: workflow.workItem.id, branch: workflowPublicationBranch(root, workflow) },
    phaseId: requestedPhaseId,
    generation: event?.generation ?? requestedPhase?.generation ?? null,
    actor: event?.actor ?? decision?.actor ?? identity(root),
    agent: event?.agent ?? decision?.agent ?? requestedPhase?.generatedAgent ?? null,
    authorityGroup: event?.authorityGroup ?? decision?.authorityGroup ?? null,
    payload: { ...(event?.payload ?? {}), decision: decision?.decision ?? null, reviewPacketSha256: decision?.reviewPacketSha256 ?? null }
  });
  let ledgerIntent = null;
  if (ledgerConfig.enabled) {
    ledgerIntent = createLedgerIntent({
      eventId: envelope.eventId,
      eventType: envelope.type,
      capabilityId: workflow.resolution?.capability?.id ?? `story-${workflow.workItem.id}`,
      subject: {
        workId: workflow.workItem.id,
        workType: workflow.workItem.workType,
        phase: envelope.phaseId,
        generation: envelope.generation,
        branch: workflowPublicationBranch(root, workflow)
      },
      actor: envelope.actor,
      agent: envelope.agent,
      authorityGroup: envelope.authorityGroup,
      identityAssurance: decision?.identityAssurance ?? null,
      payload: {
        lifecycleEventId: envelope.eventId,
        lifecyclePayload: envelope.payload,
        configPath: WORKFLOW_PATH,
        configSha256: workflow.resolution?.configSha256 ?? null,
        templateSha256: envelope.phaseId ? workflow.resolution?.templates?.[envelope.phaseId]?.sha256 ?? null : null,
        capabilityMapSha256: workflow.resolution?.capability?.map?.sha256 ?? null,
        capabilityPolicy: workflow.resolution?.capability?.policy ?? null
      }
    });
  }
  const targetBranch = workflowPublicationBranch(root, workflow);
  const priorWorkflow = rollbackWorkflow ?? structuredClone(workflow);
  // The whole work directory, not just `workflow.json`.
  //
  // `state.write` is not one write: the approval path rewrites the artifact's metadata block in
  // place, registers an approved snapshot, and writes both `approvals/<phase>.json` and a timestamped
  // decision file — all before `saveWorkflow`. Restoring only the aggregate left an artifact carrying
  // post-approval metadata (so the next command reported "Artifact changed after registration" and
  // blamed the operator) and a complete approved decision on disk for an approval that was undone —
  // which the next successful governed commit would then sweep into signed, pushed, attested history.
  const workDirectory = workDirRelative(config, workflow.workItem.id);
  const result = await publishLifecycleChange(root, {
    subject: envelope.subject,
    expectedRevision: workflow[Symbol.for('singularity-flow.state-revision')] ?? null,
    allowedPaths: [workDirRelative(config, workflow.workItem.id), ...extraPaths],
    event: envelope,
    commit: { message },
    state: {
      write: async (publicationEvent, transactionContext) => {
        // Mutations which create or advance governed lifecycle state must run
        // after the publication unit has acquired the subject lock and opened
        // its recovery journal. Callers may prepare an in-memory decision before
        // this point, but may not persist governed files outside this callback.
        const transitionResult = beforeStateWrite
          ? await beforeStateWrite(publicationEvent, transactionContext)
          : undefined;
        if (eventFromResult) {
          const derived = await eventFromResult(transitionResult, workflow, publicationEvent);
          if (derived) {
            const finalized = lifecycleEvent({
              ...publicationEvent,
              ...derived,
              subject: publicationEvent.subject,
              payload: { ...(publicationEvent.payload ?? {}), ...(derived.payload ?? {}) }
            });
            Object.assign(publicationEvent, finalized, {
              eventId: publicationEvent.eventId,
              createdAt: publicationEvent.createdAt
            });
            if (ledgerIntent) {
              ledgerIntent.eventType = publicationEvent.type;
              ledgerIntent.subject.phase = publicationEvent.phaseId;
              ledgerIntent.subject.generation = publicationEvent.generation;
              ledgerIntent.actor = {
                name: publicationEvent.actor?.name ?? null,
                email: publicationEvent.actor?.email ?? null,
                githubLogin: publicationEvent.actor?.login ?? publicationEvent.actor?.githubLogin ?? null,
                identityAssurance: derived.identityAssurance
                  ?? ledgerIntent.actor?.identityAssurance
                  ?? 'unavailable'
              };
              ledgerIntent.agent = publicationEvent.agent;
              ledgerIntent.authorityGroup = publicationEvent.authorityGroup;
              ledgerIntent.payload = {
                ...(ledgerIntent.payload ?? {}),
                lifecyclePayload: publicationEvent.payload,
                lifecycleEvent: publicationEvent
              };
            }
          }
        }
        // Design-source selection is lifecycle authority, not an incidental file
        // write. Build and bind it only after the publication unit has acquired
        // the subject lock, checked the revision, and opened its journal.
        if (event?.type === 'artifact-generated'
          && workflow.resolution?.designSources?.capturePhase === requestedPhase?.id) {
          await buildDesignSourceSet(root, workflow, {
            itemDirectory: workDir(root, config, workflow.workItem.id),
            selectionByFileKey: requestedPhase.designSourceSelection ?? {}
          });
          await updateArtifactMetadata(root, config, workflow, requestedPhase);
          // The source set is created after publishGeneration has registered the
          // artifact. Its managed metadata therefore changes once more here;
          // refresh that registration inside the same publication transaction so
          // submit does not mistake Flow's own metadata update for user tampering.
          await registerArtifact(root, workflow, path.join(
            workDirRelative(config, workflow.workItem.id),
            requestedPhase.requiredArtifact.path
          ), { phaseId: requestedPhase.id, kind: requestedPhase.requiredArtifact.kind });
          const designValidation = await validatePhase(root, config, workflow, requestedPhase);
          if (designValidation.length) {
            throw new SingularityFlowError(`Phase ${requestedPhase.id} design-source binding is not publishable:\n- ${designValidation.join('\n- ')}`);
          }
        }
        if (event?.type === 'phase-approved') {
          const binding = workflow.resolution?.designSources?.capturePhase === requestedPhase?.id
            ? [...(requestedPhase.designSourceSets ?? [])]
              .reverse().find((entry) => entry.generation === requestedPhase.generation) ?? null
            : null;
          if (workflow.resolution?.designSources?.capturePhase === requestedPhase?.id
            && workflow.resolution.designSources.requireApprovedSet && !binding) {
            throw new SingularityFlowError(
              `Phase '${requestedPhase.id}' cannot be approved without its generation ${requestedPhase.generation} design-source set.`
            );
          }
          const approval = [...(requestedPhase.approvals ?? [])].reverse()
            .find((item) => !item.invalidatedAt && item.decision === 'approved');
          if (approval) {
            if (binding) approval.designSourceSet = binding;
            if (requestedPhase.status === 'approved') {
              await updateArtifactMetadata(root, config, workflow, requestedPhase);
              // This hash represents the final approved artifact, including its
              // managed approval metadata. Do not rewrite it after this point.
              await registerApprovedSnapshot(root, config, workflow, requestedPhase);
              // The specification index was first created at publication, before approval metadata
              // was rendered. Rebuild it against the exact final approved bytes so downstream
              // clause context can verify source, index and workflow anchor before injection.
              await refreshPhaseSpecificationIndex(root, config, workflow, requestedPhase);
            }
            await writeDecision(root, config, workflow, requestedPhase, approval);
            // The advancing phase's interval baseline is a durable write like the three above, and
            // it belongs here for the same reason. `approvePhase` used to write it before the unit
            // opened, which put the baseline file inside the snapshot the rollback restores — so a
            // failed approval left the file on disk with a workflow.json that no longer referenced
            // it. `currentPhase` has already advanced in memory by this point, and the helper is a
            // no-op for a phase that does not use intervals or already has an open one.
            if (requestedPhase.status === 'approved') {
              await ensureWorkIntervalBaseline(root, config, workflow, {
                phaseId: workflow.currentPhase,
                itemDirectory: workDir(root, config, workflow.workItem.id),
                itemRelative: workDirRelative(config, workflow.workItem.id)
              });
            }
          }
        }
        recordPublicationProjection(workflow, publicationEvent, ledgerIntent);
        await saveWorkflow(root, config, workflow);
        return { event: publicationEvent, transitionResult };
      },
      // Captured before the projection mutates it in place, so a publication that fails after the
      // write leaves no record of an event that never happened — and covering every file the write
      // touches, not only the aggregate.
      // The captured bytes are the aggregate too, so restoring them is the whole undo — writing
      // `priorWorkflow` on top would re-serialise a file that is already correct.
      rollback: (preimage, recoveryOptions = {}) => restorePublicationPreimage(root, preimage, {
        subject: envelope.subject,
        ...recoveryOptions
      }),
      validate: async () => {
        const validation = await validateWorkflow(root, config, workflow);
        if (!validation.valid) {
          throw new SingularityFlowError(`Story state is invalid before publication: ${validation.errors.join(' ')}`);
        }
      }
    },
    publication: { mode: workflowPublicationMode(config, workflow), remote: config.git?.remote ?? 'origin', branch: targetBranch },
    pendingRecord: () => ({ workId: workflow.workItem.id }),
    ledger: { config: ledgerConfig, intent: ledgerIntent, intentDirectory: workDirRelative(config, workflow.workItem.id) },
    recoveryPreimage,
    transactionId
  });
  if (workflow[Symbol.for('singularity-flow.state-revision')]) {
    workflow[Symbol.for('singularity-flow.state-revision')].head = result.sha;
  }
  if (result.pushed) await clearPendingPublication(root, {
    kind: 'story', id: workflow.workItem.id,
    legacyPath: legacyPendingPublicationPath(root, config, workflow.workItem.id)
  });
  const notifications = await deliverLifecycleNotifications({
    channels: workflow.resolution?.collaboration?.notifications ?? config.collaboration?.notifications ?? [],
    event: result.event
  });
  warnNotificationFailures(notifications);
  return { ...result, notifications };
}

export async function syncPublication(root, config, workflow) {
  const pending = await readPendingPublication(root, {
    kind: 'story', id: workflow.workItem.id,
    legacyPath: legacyPendingPublicationPath(root, config, workflow.workItem.id)
  });
  if (pending?.record?.recoveryStage === 'interrupted-before-branch-ref-advanced') {
    const liveOwner = livePreparedPublicationOwner(pending, root);
    if (liveOwner) {
      throw new SingularityFlowError(
        `Story '${workflow.workItem.id}' has an active governed publication command (PID ${liveOwner.pid}`
        + `${liveOwner.createdAt ? `, started ${liveOwner.createdAt}` : ''}). `
        + 'Return to that terminal and complete or interrupt the command; do not start another mutation. '
        + 'After interrupting it, run singularity-flow sync again.'
      );
    }
    const recovery = await recoverPreparedPublication(root, pending);
    if (recovery) {
      return {
        pushed: head(root),
        remote: pending.record.remote,
        branch: pending.record.branch,
        recoveredPrepared: true,
        restoredPrepared: recovery.restored,
        rescuePath: recovery.rescuePath,
        capabilityPublished: [],
        ledger: await reconcileLedger(root, workflow.resolution?.ledger ?? config.ledger ?? {}, { workId: workflow.workItem.id })
      };
    }
    throw new SingularityFlowError(
      `Story '${workflow.workItem.id}' was interrupted before its governed commit completed. `
      + 'Inspect the working tree, run singularity-flow doctor, and repair or discard the partial local state before retrying.'
    );
  }
  const record = pending?.record ?? { remote: config.git?.remote ?? 'origin', branch: workflowPublicationBranch(root, workflow) };
  if (record.recoveryStage === 'publication-recovery-diverged') {
    throw new SingularityFlowError(
      `Story '${workflow.workItem.id}' recovery diverged and was stopped safely. ${record.error} `
      + 'Run singularity-flow doctor for the exact journal/branch diagnosis; no commit was pushed.',
      { code: 'PUBLICATION_RECOVERY_DIVERGED', details: record }
    );
  }
  const capabilityOnly = pending?.record?.recoveryStage === 'capability-publication-pending';
  if (!capabilityOnly) {
    const result = record.commit
      ? pushCommitToBranch(root, record.remote, record.commit, record.branch)
      : pushBranch(root, record.remote, record.branch);
    if (result.status !== 0) throw new SingularityFlowError(`Push still fails: ${(result.stderr || result.stdout).trim()}`);
  }
  const capability = publishCapabilityRepositories(record.capabilityPublications ?? []);
  if (capability.pending.length) {
    await writePendingPublication(root, {
      kind: 'story', id: workflow.workItem.id,
      record: {
        ...record,
        recoveryStage: 'capability-publication-pending',
        capabilityPublications: capability.pending,
        error: capability.error
      }
    });
    throw new SingularityFlowError(
      `Capability Story publication still fails for '${capability.pending[0].repository}': ${capability.error}`
    );
  }
  await clearPendingPublication(root, {
    kind: 'story', id: workflow.workItem.id,
    legacyPath: legacyPendingPublicationPath(root, config, workflow.workItem.id)
  });
  const ledger = await reconcileLedger(root, workflow.resolution?.ledger ?? config.ledger ?? {}, { workId: workflow.workItem.id });
  return {
    pushed: record.commit ?? head(root), remote: record.remote, branch: record.branch,
    capabilityPublished: capability.published, ledger
  };
}

/**
 * `offline` is a read-path concession, and it defaults to off so every existing caller is unchanged.
 *
 * Validation consults the capability ledger, and `ledgerStatus` fetches the state branch plus one
 * pin per recorded entry — each inside a temporary worktree. Measured on a real repository that was
 * 42 of 47 `git fetch` calls and 33 s of a 48 s `snapshot --json`, for a validation whose answer the
 * read model only renders. A publication transaction and the governance gate still validate against
 * the remote; only a surface that is merely *describing* state opts out, and it says so through the
 * same ledger fields every other offline reader uses.
 */
export async function validateWorkflow(root, config, workflow, { strict = false, offline = false } = {}) {
  const errors = [], warnings = []; if (!workflowBranchAllowed(workflow, branch(root))) errors.push(`Current branch ${branch(root)} is not registered for Story ${workflow.workItem.id}.`);
  if (workflow.resolution?.configurationSource) {
    try {
      const currentSource = await readConfigurationSource(root, { verify: true });
      const pinned = workflow.resolution.configurationSource;
      if (!currentSource || currentSource.commit !== pinned.commit
        || currentSource.repository !== pinned.repository) {
        errors.push('Configuration provenance differs from the immutable Story snapshot.');
      } else if (pinned.filesSha256 && currentSource.filesSha256 !== pinned.filesSha256) {
        // Only `commit` and `repository` used to be pinned, so the asset hash map could be rewritten
        // wholesale — change `approval.minimum`, repaste its hash — and both the self-check and this
        // comparison passed while the record still attested to the approved commit.
        errors.push('Configuration asset set differs from the immutable Story snapshot.');
      }
    } catch (error) {
      errors.push(`Configuration provenance: ${error.message}`);
    }
  }
  if (workflow.resolution?.workType !== workflow.workItem.workType) errors.push('Work type differs from the immutable profile snapshot.');
  const resolvedOrder = workflow.resolution?.phases?.map((phase) => phase.id);
  if (resolvedOrder?.length && JSON.stringify(resolvedOrder) !== JSON.stringify(workflow.phaseOrder)) errors.push('Phase order differs from the immutable profile snapshot.');
  if (config.workTypes?.[workflow.workItem.workType]) {
    const expectedGates = resolveWorkType(config, workflow.workItem.workType).sequenceGates;
    const pinnedGates = normalizeSequenceGates(workflow.resolution?.sequenceGates ?? {});
    if (JSON.stringify(pinnedGates) !== JSON.stringify(expectedGates)) errors.push('Sequence gate policy differs from the immutable work-type configuration snapshot.');
    const expectedSession = normalizeSessionPolicy(config.session ?? {});
    const pinnedSession = normalizeSessionPolicy(workflow.resolution?.session ?? {});
    if (JSON.stringify(pinnedSession) !== JSON.stringify(expectedSession)) errors.push('Session governed-agent policy differs from the immutable configuration snapshot.');
    const expectedContextPolicy = normalizeContextPolicy(config.contextPolicy ?? {}, { phaseIds: Object.keys(config.phases ?? {}) });
    const pinnedContextPolicy = normalizeContextPolicy(workflow.resolution?.contextPolicy ?? {});
    if (JSON.stringify(pinnedContextPolicy) !== JSON.stringify(expectedContextPolicy)) errors.push('Copilot context-boundary policy differs from the immutable configuration snapshot.');
    const expectedTokenEconomy = normalizeTokenEconomy(config.tokenEconomy ?? {});
    const pinnedTokenEconomy = normalizeTokenEconomy(workflow.resolution?.tokenEconomy ?? {});
    if (JSON.stringify(pinnedTokenEconomy) !== JSON.stringify(expectedTokenEconomy)) errors.push('Token-economy policy differs from the immutable configuration snapshot.');
  }
  let activeCount = 0;
  for (const phaseId of workflow.phaseOrder) {
    const phase = workflow.phases[phaseId]; if (!phase) { errors.push(`Missing phase ${phaseId}.`); continue; }
    if (['in_progress', 'awaiting_approval'].includes(phase.status)) activeCount += 1;
    if (phase.status === 'approved' && !(await exists(path.join(root, requiredRepoPath(config, workflow, phase))))) errors.push(`Approved artifact missing: ${requiredRepoPath(config, workflow, phase)}`);
  }
  if (workflow.status === 'complete') { if (workflow.currentPhase !== null) errors.push('Complete workflow must have currentPhase null.'); if (activeCount) errors.push('Complete workflow cannot have an active phase.'); }
  else if (workflow.status === 'cancelled') {
    if (workflow.currentPhase !== null) errors.push('Cancelled workflow must have currentPhase null.');
    if (activeCount) errors.push('Cancelled workflow cannot have an active phase.');
    if (!workflow.cancellation?.reason?.trim()) errors.push('Cancelled workflow must record a cancellation reason.');
    if (!workflow.cancellation?.cancelledAt || !workflow.cancellation?.cancelledBy) errors.push('Cancelled workflow must record when and by whom it was cancelled.');
    if (!workflow.cancellation?.phase || workflow.phases[workflow.cancellation.phase]?.status !== 'cancelled') errors.push('Cancelled workflow must identify its cancelled phase.');
  } else { if (!workflow.currentPhase) errors.push('In-progress workflow must have a current phase.'); if (activeCount !== 1) errors.push(`In-progress workflow must have exactly one active phase; found ${activeCount}.`); }
  const active = currentPhase(workflow); if (strict && active && active.status === 'awaiting_approval') errors.push(...await validatePhase(root, config, workflow, active));
  // Validation reports; it does not migrate. The enforcement paths that gate a mutation still do.
  if (await storyPublicationPending(root, config, workflow.workItem.id, { migrate: false })) errors.push('Publication is pending; run singularity-flow sync.');
  const ledgerConfig = normalizeLedgerConfig(workflow.resolution?.ledger ?? config.ledger ?? {});
  if (ledgerConfig.enabled) {
    try {
      const ledger = await ledgerStatus(root, ledgerConfig, { offline });
      const messages = [];
      if (!ledger.initialized) messages.push(`Capability ledger branch '${ledgerConfig.branch}' is not initialized.`);
      if (ledger.verification && !ledger.verification.valid) messages.push(...ledger.verification.errors.map((message) => `Capability ledger: ${message}`));
      if (ledger.pending?.length) messages.push(`${ledger.pending.length} durable ledger intent(s) are pending reconciliation.`);
      if (ledgerConfig.enforcement === 'required' || ledgerConfig.behind === 'block') errors.push(...messages);
      else warnings.push(...messages);
    } catch (error) {
      const message = `Capability ledger could not be verified: ${error.message}`;
      if (ledgerConfig.enforcement === 'required' || ledgerConfig.behind === 'block') errors.push(message);
      else warnings.push(message);
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}
