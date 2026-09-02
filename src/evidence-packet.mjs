/**
 * Token-aware, deterministic Evidence Packets.
 *
 * Packets guide an agent; they are never gate evidence. Source material is explicitly untrusted,
 * initial code retrieval stops at signatures, and every deeper read crosses a sealed handle.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { readAgentBrief } from './agent-briefs.mjs';
import { astQuery } from './ast-intelligence.mjs';
import { changeFlightPlanSha256, readChangeFlightPlan } from './change-flight-plan.mjs';
import { readContextExpansionHandle, issueContextExpansionHandle } from './context-handles.mjs';
import { findHistoricalAnalogues } from './context-history.mjs';
import { compileContextManifest } from './context-manifest.mjs';
import {
  recordContextExpansionRequest, recordContextPacketTelemetry
} from './context-packet-telemetry.mjs';
import { rankContextCandidates, selectContextCandidates } from './context-ranking.mjs';
import { head } from './git.mjs';
import { readKnowledge } from './knowledge.mjs';
import { projectKnowledge } from './knowledge-projection.mjs';
import { readRawObservation } from './observation-compiler.mjs';
import { recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { operationContext } from './operation-context.mjs';
import {
  normalizeTokenEconomy, selectedTokenEconomyProfile, tokenEconomyDigest
} from './token-economy.mjs';
import { withWorldModelSourceScope, worldModelSourceScope } from './source-scope.mjs';
import {
  loadConfig, loadStoryAggregate, storyWelEnrollmentStatus
} from './state-stores.mjs';
import { run, secureRepositoryPath, SingularityFlowError } from './util.mjs';
import { inspectWorkflowGrounding, resolveInspectedGrounding } from './worldmodel.mjs';

export const EVIDENCE_PACKET_SLICES = Object.freeze([
  'brief', 'impact', 'world-model', 'ast', 'evidence', 'history', 'knowledge', 'observation'
]);
export const EVIDENCE_PACKET_COMPILER_VERSION = 3;
export const EVIDENCE_PACKET_KNOWLEDGE_LIMITS = Object.freeze({
  maxEntries: 6,
  maxBytes: 4096,
  maxOmissionDetails: 8,
  maxProvenanceReferences: 2
});
export const EVIDENCE_PACKET_KNOWLEDGE_MINIMUM_OUTPUT_BYTES = 8 * 1024;

const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_CANDIDATES = 120;

function knowledgeLimits(maximumOutputBytes) {
  const maxBytes = Math.min(
    EVIDENCE_PACKET_KNOWLEDGE_LIMITS.maxBytes,
    Math.max(512, Math.floor(maximumOutputBytes / 8))
  );
  return Object.freeze({
    maxEntries: Math.min(
      EVIDENCE_PACKET_KNOWLEDGE_LIMITS.maxEntries,
      Math.max(1, Math.floor(maxBytes / 512))
    ),
    maxBytes,
    maxOmissionDetails: EVIDENCE_PACKET_KNOWLEDGE_LIMITS.maxOmissionDetails,
    maxProvenanceReferences: EVIDENCE_PACKET_KNOWLEDGE_LIMITS.maxProvenanceReferences
  });
}

function originRepositoryName(root) {
  const origin = run('git', ['config', '--get', 'remote.origin.url'], {
    cwd: root, allowFailure: true
  }).stdout.trim();
  return origin.split(/[/:]/).at(-1)?.replace(/\.git$/, '') || null;
}

function scalarIdentity(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value.id ?? value.name ?? null;
}

function knowledgeRecallContext(root, workflow, plan, findings) {
  const resolution = workflow?.resolution ?? {};
  const targetPath = plan?.target?.kind === 'path' ? plan.target.reference : null;
  const findingPaths = findings
    .filter((finding) => ['code-file', 'test-file', 'configuration', 'build-configuration'].includes(finding.kind))
    .map((finding) => finding.subject);
  return {
    capabilities: unique([resolution.capability?.id]),
    repositories: unique([
      originRepositoryName(root), path.basename(root), ...Object.keys(resolution.repositories ?? {})
    ]),
    paths: unique([targetPath, ...findingPaths]),
    environments: unique([scalarIdentity(resolution.environment)])
  };
}

function contentFreeKnowledge(projection) {
  if (!projection) return null;
  const { payload: _payload, ...guidance } = projection.guidance ?? {};
  return {
    schemaVersion: projection.schemaVersion,
    resultType: projection.resultType,
    recallEngine: projection.recallEngine,
    status: projection.status,
    authority: projection.authority,
    limits: structuredClone(projection.limits),
    selected: structuredClone(projection.selected),
    omitted: structuredClone(projection.omitted),
    omissions: structuredClone(projection.omissions),
    guidance,
    manifestSha256: projection.manifestSha256
  };
}

async function compileKnowledge(root, workflow, plan, findings, limits) {
  const projected = projectKnowledge(await readKnowledge(root), {
    context: knowledgeRecallContext(root, workflow, plan, findings),
    limits
  });
  return {
    ...projected,
    status: projected.omissions.total ? 'partial' : 'complete',
    authority: 'untrusted-guidance-only'
  };
}

function observedWelEnrollment(root, definition, workflow) {
  if (!workflow || workflow.resolution?.wel?.mode !== 'observe') return false;
  try {
    const enrollment = storyWelEnrollmentStatus(root, definition, workflow.workItem.id);
    return enrollment.classification === 'enrolled' && enrollment.mode === 'observe';
  } catch {
    return false;
  }
}

function unavailableKnowledge(limits) {
  const projection = {
    schemaVersion: 1,
    resultType: 'bounded-knowledge-projection',
    recallEngine: 'knowledge.recallKnowledge',
    status: 'unavailable',
    authority: 'untrusted-guidance-only',
    limits,
    selected: [],
    omitted: [],
    omissions: { total: 0, byReason: {}, detail: null, omittedSetSha256: null },
    guidance: {
      trust: 'untrusted-data', representation: 'unavailable', entries: 0, bytes: 0
    }
  };
  return { ...projection, manifestSha256: recordSha256(projection) };
}

function boundedText(value, maximumBytes) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text) <= maximumBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle)) <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

function packetBudget(value) {
  const budget = Number(value ?? DEFAULT_MAX_OUTPUT_BYTES);
  if (!Number.isInteger(budget) || budget < 4096 || budget > MAX_OUTPUT_BYTES) {
    throw new SingularityFlowError('Evidence Packet output budget must be an integer from 4096 through 131072 bytes.', {
      code: 'EPC_CONTEXT_BUDGET_INVALID', details: { nextAction: 'Request a packet with --max-output-bytes between 4096 and 131072.' }
    });
  }
  return budget;
}

function unique(values) { return [...new Set(values.filter(Boolean).map(String))].sort(); }
function requested(slices, name) { return slices.includes(name); }

function acceptedFinding(plan, findingIds) {
  const selected = findingIds?.length ? new Set(findingIds.map(String)) : null;
  return (plan?.findings ?? []).filter((finding) =>
    finding.disposition !== 'excluded' && (!selected || selected.has(finding.findingId))
  );
}

function candidateForFinding(finding, directTarget) {
  const direct = Boolean(directTarget && finding.subject === directTarget.reference);
  const requirement = finding.kind === 'requirement-clause';
  const architecture = /architecture|contract|boundary|ownership/.test(finding.kind);
  const test = finding.kind === 'test-file';
  const structuralNeighbor = finding.kind === 'code-relationship' || finding.kind === 'import';
  const reason = direct ? 'flight-plan.direct-target'
    : requirement ? 'requirement.bound-to-impact'
      : architecture ? 'architecture.boundary'
        : test ? 'test.verifies-clause'
          : structuralNeighbor ? 'ast.direct-neighbor'
          : finding.classification === 'proven' ? 'flight-plan.proven-impact'
            : 'flight-plan.inferred-impact';
  return {
    kind: `${finding.kind}-reference`,
    subject: finding.subject,
    classification: finding.classification,
    representation: 'L0-reference',
    content: [
      `${finding.kind}: ${finding.subject}`,
      finding.relationship ? `Relationship: ${finding.relationship}` : null,
      finding.explanation || null
    ].filter(Boolean).join('\n'),
    relationship: finding.relationship,
    reason: { code: reason, findingIds: [finding.findingId] },
    source: {
      type: finding.source?.type ?? 'flight-plan',
      reference: finding.source?.reference ?? finding.subject,
      sha256: finding.source?.sha256 ?? null,
      derivationKey: finding.source?.derivationKey ?? null
    },
    expansion: requirement && finding.source?.reference
      ? { kind: 'requirement-reference', path: finding.source.reference }
      : test ? { kind: 'repository-record', path: finding.subject }
        : { kind: 'supporting-evidence', findingId: finding.findingId },
    sourceMaterial: false,
    mandatory: requirement,
    cacheClass: requirement ? 'session-stable' : 'variable'
  };
}

function symbolCandidate(finding, fact, directTarget) {
  const subject = fact.qualifiedName ?? fact.name ?? finding.subject;
  const direct = directTarget?.kind === 'symbol'
    && [subject, fact.name, fact.id].includes(directTarget.reference);
  return {
    kind: 'symbol-signature',
    subject,
    classification: finding.classification,
    representation: 'L1-signature',
    content: String(fact.signature ?? `${fact.declarationKind ?? 'symbol'} ${fact.name ?? subject}`),
    relationship: finding.relationship,
    reason: {
      code: direct ? 'flight-plan.direct-target'
        : finding.classification === 'proven' ? 'flight-plan.proven-impact' : 'flight-plan.inferred-impact',
      findingIds: [finding.findingId]
    },
    source: {
      type: 'git-symbol',
      reference: `${fact.path}#${fact.id ?? subject}`,
      sha256: fact.extractor ? recordSha256({ fact, extractor: fact.extractor }) : recordSha256(fact),
      derivationKey: finding.source?.derivationKey ?? null
    },
    expansion: {
      kind: 'symbol-body', path: fact.path, span: fact.span ?? { startLine: fact.line, endLine: fact.line },
      symbol: subject
    },
    sourceMaterial: true
  };
}

async function astCandidates(root, findings, directTarget, unavailable) {
  const symbols = findings.filter((finding) => finding.kind === 'code-symbol').slice(0, 24);
  const paths = unique(findings
    .filter((finding) => ['code-file', 'test-file', 'configuration', 'build-configuration'].includes(finding.kind))
    .map((finding) => finding.subject)).slice(0, 60);
  const candidates = [];
  if (!symbols.length && directTarget?.kind === 'symbol') {
    symbols.push({
      findingId: `target-${recordSha256(directTarget).slice(0, 20)}`,
      kind: 'code-symbol', subject: directTarget.reference, classification: 'unknown',
      relationship: 'selected-target', source: { type: 'human-target' }
    });
  }
  for (const finding of symbols) {
    try {
      const result = await astQuery(root, {
        predicate: 'symbol', value: finding.subject,
        ...(paths.length ? { paths } : { all: true }),
        'max-files': 80, 'max-facts': 40, 'max-output-bytes': 64 * 1024
      });
      const facts = (result.facts ?? []).filter((fact) => fact.kind === 'symbol');
      if (!facts.length) {
        unavailable.push({
          code: 'EPC_AST_UNAVAILABLE', subject: finding.subject,
          reason: 'No structural signature matched this accepted symbol; its L0 Flight Plan reference remains available.',
          nextAction: 'Request a refreshed packet after AST support is available.'
        });
      }
      candidates.push(...facts.map((fact) => symbolCandidate(finding, fact, directTarget)));
    } catch (error) {
      unavailable.push({
        code: 'EPC_AST_UNAVAILABLE', subject: finding.subject,
        reason: error.code ?? error.message,
        nextAction: 'Use the retained path and Flight Plan references, or enable AST and request a refreshed packet.'
      });
    }
  }
  return candidates;
}

async function briefCandidates(root, definition, workflow) {
  const phaseId = workflow?.currentPhase;
  if (!phaseId) return [];
  const candidates = [];
  for (const producerId of workflow.phaseOrder ?? Object.keys(workflow.phases ?? {})) {
    const producer = workflow.phases?.[producerId];
    const consumer = workflow.phases?.[phaseId];
    const declaration = consumer?.inputs?.find((input) => input.phase === producerId
      && input.projection === 'approved-summary');
    if (!producer || !consumer || !declaration) continue;
    for (const brief of workflow.phases?.[producerId]?.agentBriefs ?? []) {
      if (brief.consumerPhase !== phaseId || brief.status !== 'ready' || !brief.renderedPath) continue;
      try {
        const verified = await readAgentBrief(root, workflow, producer, consumer, declaration, {
          itemRelative: `${definition.workItemRoot ?? 'singularity/work-items'}/${workflow.workItem.id}`
        });
        if (verified.status !== 'ready') continue;
        const content = boundedText(verified.content, 4096);
        candidates.push({
          kind: 'approved-agent-brief', subject: `${producerId}->${phaseId}`,
          classification: 'proven', representation: 'approved-summary', content,
          relationship: 'phase-input', reason: { code: 'phase.required-context', findingIds: [] },
          source: {
            type: 'governed-agent-brief', reference: verified.record.rendered.path,
            sha256: verified.record.rendered.sha256
          },
          expansion: { kind: 'repository-record', path: verified.record.rendered.path },
          sourceMaterial: true, mandatory: true, cacheClass: 'session-stable'
        });
      } catch { /* The unavailable entry is added by the caller from the absence of candidates. */ }
    }
  }
  return candidates;
}

async function worldModelCandidates(root, workflow, unavailable) {
  if (!workflow?.currentPhase) return [];
  try {
    const inspected = await inspectWorkflowGrounding(root, workflow, workflow.currentPhase, { refreshRemote: false });
    if (!inspected.availability?.ready) throw Object.assign(new Error(inspected.reason ?? 'World model is unavailable.'), { code: 'EPC_WORLD_MODEL_UNAVAILABLE' });
    const resolved = await resolveInspectedGrounding(root, inspected, workflow.currentPhase);
    const candidates = [];
    for (const selection of resolved.selected.slice(0, 12)) {
      const content = boundedText(
        selection.body ?? await readFile(selection.absolute, 'utf8'), 2048
      );
      candidates.push({
        kind: 'world-model-context', subject: selection.relative,
        classification: 'proven', representation: 'bounded-source', content,
        relationship: selection.reason ?? 'capability-context',
        reason: { code: 'general.capability-context', findingIds: [] },
        source: { type: 'world-model', reference: selection.relative, sha256: selection.sha256 },
        expansion: null, sourceMaterial: true
      });
    }
    return candidates;
  } catch (error) {
    unavailable.push({
      code: 'EPC_WORLD_MODEL_UNAVAILABLE', subject: 'world-model', reason: error.code ?? error.message,
      nextAction: 'Continue with Flight Plan and path evidence, or restore the world-model view and refresh.'
    });
    return [];
  }
}

function historyCandidates(analogues) {
  return analogues.map((analogue) => ({
    kind: 'historical-analogue', subject: analogue.workId,
    classification: 'inferred', representation: 'exact-overlap',
    content: JSON.stringify({ status: analogue.status, relationships: analogue.relationships }),
    relationship: 'exact-governed-overlap',
    reason: { code: 'historical-analogue', findingIds: [] },
    source: { type: 'governed-history', reference: analogue.references[0]?.reference ?? null },
    expansion: { kind: 'history-receipt', path: analogue.references[0]?.reference }, sourceMaterial: false
  }));
}

function observationCandidates(observation) {
  if (!observation) return [];
  const content = JSON.stringify({
    kind: observation.kind, status: observation.status, summary: observation.summary,
    included: observation.included, omitted: observation.omitted, parsing: observation.parsing
  });
  return [{
    kind: `${observation.kind}-summary`, subject: observation.observationId,
    classification: 'proven', representation: 'deterministic-summary', content,
    relationship: 'current-observation', reason: { code: 'human-requested-expansion', findingIds: [] },
    source: { type: 'observation-summary', reference: observation.observationId, sha256: observation.source?.sha256 },
    expansion: observation.source?.sha256
      ? { kind: 'observation-raw', rawSha256: observation.source.sha256 } : null,
    sourceMaterial: true
  }];
}

function governedEvidenceCandidates(workflow) {
  if (!workflow) return [];
  const submissions = (workflow.lineage?.submissions ?? []).slice(-20).map((entry) => ({
    kind: 'governed-submission-reference',
    subject: `${entry.phase}:generation-${entry.generation}`,
    classification: 'proven', representation: 'evidence-reference',
    content: JSON.stringify({
      phase: entry.phase, generation: entry.generation, packetSha256: entry.packetSha256,
      sourceCommit: entry.sourceCommit ?? null
    }),
    relationship: 'current-work-evidence',
    reason: { code: 'phase.required-context', findingIds: [] },
    source: { type: 'governed-submission', reference: entry.path, sha256: entry.packetSha256 },
    expansion: entry.path ? { kind: 'repository-record', path: entry.path } : null,
    sourceMaterial: false, mandatory: true, cacheClass: 'session-stable'
  }));
  const approvals = Object.values(workflow.phases ?? {}).flatMap((phase) =>
    (phase.approvals ?? []).filter((entry) => !entry.invalidatedAt).map((entry) => ({
      kind: 'governed-approval-reference',
      subject: `${phase.id}:generation-${entry.generation ?? phase.generation}`,
      classification: 'proven', representation: 'evidence-reference',
      content: JSON.stringify({
        phase: phase.id, generation: entry.generation ?? phase.generation,
        decision: entry.decision, authorityGroup: entry.authorityGroup ?? null
      }),
      relationship: 'current-work-approval',
      reason: { code: 'phase.required-context', findingIds: [] },
      source: { type: 'governed-approval', reference: workflow.workItem.id, sha256: recordSha256(entry) },
      expansion: null, sourceMaterial: false, mandatory: true, cacheClass: 'session-stable'
    }))
  );
  return [...submissions, ...approvals];
}

function mandatoryGovernanceCandidate(definition, workflow, phaseId) {
  if (!workflow) return null;
  const phase = workflow.phases?.[phaseId] ?? null;
  const policy = {
    workId: workflow.workItem.id,
    workType: workflow.workItem.workType,
    phase: phaseId,
    configurationSha256: workflow.resolution?.configSha256 ?? null,
    constitution: workflow.resolution?.constitutionPin ?? workflow.resolution?.constitution ?? null,
    approval: phase?.approvalPolicy ?? null,
    generation: phase?.generationPolicy ?? null,
    sourceBoundary: phase?.sourceBoundary ?? null,
    requiredChecks: phase?.qualityCommands ?? [],
    sequenceGates: workflow.resolution?.sequenceGates ?? null
  };
  return {
    kind: 'governance-policy-binding',
    subject: `${workflow.workItem.id}:${phaseId ?? 'complete'}`,
    classification: 'proven', representation: 'policy-binding',
    content: JSON.stringify(policy), relationship: 'applicable-governance',
    reason: { code: 'governance.mandatory', findingIds: [] },
    source: {
      type: 'pinned-work-resolution',
      reference: `${definition.workItemRoot ?? 'singularity/work-items'}/${workflow.workItem.id}/workflow.json`,
      sha256: recordSha256(policy)
    },
    expansion: null, sourceMaterial: false, mandatory: true, cacheClass: 'session-stable'
  };
}

function lifecycleOutcome(workflow, phaseId) {
  if (!workflow) return null;
  const phase = workflow.phases?.[phaseId] ?? null;
  const checks = phase?.checks ?? [];
  const failed = checks.filter((check) => ['failed', 'blocked'].includes(check.status)).length;
  const passed = checks.filter((check) => check.status === 'passed').length;
  const verification = failed ? 'failed'
    : checks.length && passed === checks.length ? 'passed'
      : checks.length ? 'partial'
        : phase?.status === 'approved' ? 'passed' : 'not-run';
  return {
    completed: workflow.status === 'complete' || phase?.status === 'approved',
    verification,
    gates: { passed, failed },
    agentRetries: (workflow.history ?? []).filter((entry) => entry.event === 'phase_rejected'
      && (!phaseId || entry.phase === phaseId)).length,
    contextExpansions: 0,
    missingContextIncidents: null,
    unexaminedChanges: null,
    durationMs: null
  };
}

async function acceptedPlan(root, workflow, flightPlanId) {
  const binding = workflow?.changeFlightPlan;
  if (!binding?.acceptedPath || binding.planId !== flightPlanId) {
    throw new SingularityFlowError(`Accepted Change Flight Plan '${flightPlanId}' was not found for this work item.`, {
      code: 'EPC_FLIGHT_PLAN_NOT_FOUND', details: { nextAction: 'Start or attach the governed work created from that Flight Plan.' }
    });
  }
  const resolved = await secureRepositoryPath(root, binding.acceptedPath, {
    label: 'Accepted Change Flight Plan', mustExist: true, type: 'file'
  });
  const plan = readRecord('change-flight-plan', await readFile(resolved.absolute)).record;
  if (plan.planId !== flightPlanId || changeFlightPlanSha256(plan) !== binding.acceptedPlanSha256) {
    throw new SingularityFlowError('The accepted Change Flight Plan does not match its governed workflow binding.', {
      code: 'EPC_FLIGHT_PLAN_STALE', details: { nextAction: 'Recover the governed Flight Plan binding before requesting context.' }
    });
  }
  return plan;
}

async function resolveBinding(root, { workId, flightPlanId }) {
  const definition = await loadConfig(root);
  let workflow = null;
  let plan = null;
  let bindingMode = 'current-work';
  if (workId) workflow = await loadStoryAggregate(root, definition, workId);
  if (flightPlanId && workflow) {
    plan = await acceptedPlan(root, workflow, flightPlanId);
    bindingMode = 'accepted-flight-plan';
  } else if (flightPlanId) {
    try { plan = await readChangeFlightPlan(root, flightPlanId); }
    catch (error) {
      throw new SingularityFlowError(`Change Flight Plan '${flightPlanId}' is unavailable.`, {
        code: 'EPC_FLIGHT_PLAN_NOT_FOUND', details: { nextAction: 'Refresh the preview or attach its governed work item.' }, cause: error
      });
    }
    bindingMode = 'preview';
  } else if (workflow?.changeFlightPlan?.planId) {
    plan = await acceptedPlan(root, workflow, workflow.changeFlightPlan.planId);
    bindingMode = 'accepted-flight-plan';
  }
  return { definition, workflow, plan, bindingMode };
}

function publicItem(candidate) {
  const { expansion: _expansion, sourceMaterial, ...item } = candidate;
  return {
    ...item,
    estimatedTokens: Math.ceil(item.bytes / 4),
    material: sourceMaterial ? 'untrusted-source' : 'governed-guidance',
    instructions: sourceMaterial ? 'not-authoritative' : 'guidance-only'
  };
}

async function addExpansionHandles(root, items, binding, packetId, budget) {
  const output = [];
  for (const candidate of items) {
    const item = publicItem(candidate);
    if (candidate.expansion?.kind === 'existing-handle') {
      item.expandHandle = candidate.expansion.handle;
    } else if (candidate.expansion) {
      item.expandHandle = await issueContextExpansionHandle(root, {
        packetId, workId: binding.workId, flightPlanId: binding.flightPlanId,
        sourceRevision: binding.sourceRevision, lifecycleRevision: binding.lifecycleRevision,
        itemId: candidate.itemId, expansionKind: candidate.expansion.kind,
        maximumOutputBytes: budget,
        source: Object.fromEntries(Object.entries(candidate.expansion).filter(([key]) => key !== 'kind'))
      });
    }
    output.push(item);
  }
  return output;
}

function compactOmission(omissions, handle = null) {
  if (!omissions.length) return [];
  const reasons = Object.fromEntries([...new Set(omissions.map((item) => item.reason.code))].sort()
    .map((reason) => [reason, omissions.filter((item) => item.reason.code === reason).length]));
  const omissionClasses = Object.fromEntries([...new Set(omissions.map((item) => item.omissionReason ?? 'budget'))].sort()
    .map((reason) => [reason, omissions.filter((item) => (item.omissionReason ?? 'budget') === reason).length]));
  return [{
    kind: 'omission-group', reason: Object.keys(omissionClasses).length === 1 ? Object.keys(omissionClasses)[0] : 'bounded',
    count: omissions.length, reasonClasses: reasons, omissionClasses,
    subjectsSha256: recordSha256(omissions.map((item) => item.subject).sort()),
    ...(handle ? { expandHandle: handle } : {})
  }];
}

function packetIdentity(binding, items, omissions, manifest) {
  return {
    compilerVersion: EVIDENCE_PACKET_COMPILER_VERSION,
    binding: {
      mode: binding.mode, workId: binding.workId, flightPlanId: binding.flightPlanId,
      sourceRevision: binding.sourceRevision, lifecycleRevision: binding.lifecycleRevision,
      intentSha256: binding.intentSha256, workType: binding.workType,
      intervalId: binding.intervalId, operationId: binding.operationId,
      tokenEconomyMode: binding.tokenEconomyMode,
      tokenEconomyProfile: binding.tokenEconomyProfile,
      tokenEconomyConfigurationDigest: binding.tokenEconomyConfigurationDigest
    },
    items: items.map((item) => ({ itemId: item.itemId, source: item.source, bytes: item.bytes })),
    omissions: omissions.map((item) => item.itemId), cacheKey: manifest.cacheKey,
    ...(manifest.knowledge?.manifestSha256
      ? { knowledgeManifestSha256: manifest.knowledge.manifestSha256 }
      : {})
  };
}

function finalPacket(packet) {
  const unsigned = { ...packet, integrity: null };
  return { ...packet, integrity: { sha256: recordSha256(unsigned) } };
}

/** Compile a bounded, no-model Evidence Packet. */
export async function compileEvidencePacket(root, request = {}) {
  const { definition, workflow, plan, bindingMode } = await resolveBinding(root, request);
  const tokenEconomy = normalizeTokenEconomy(workflow?.resolution?.tokenEconomy ?? definition.tokenEconomy ?? {});
  const selectedProfile = selectedTokenEconomyProfile(tokenEconomy, request.profile ?? null);
  const profileBudget = ['assist', 'enforce'].includes(tokenEconomy.mode)
    ? Math.min(MAX_OUTPUT_BYTES, selectedProfile.maximumEstimatedPromptTokens * 4) : null;
  const maximumOutputBytes = packetBudget(request.maxOutputBytes ?? profileBudget);
  const sourceRevision = head(root);
  if (!sourceRevision) throw new SingularityFlowError('Repository source revision is unavailable.', {
    code: 'EPC_SOURCE_UNAVAILABLE', details: { nextAction: 'Commit or restore a readable repository revision, then refresh context.' }
  });
  const phase = request.phase ?? workflow?.currentPhase ?? null;
  const generation = phase ? workflow?.phases?.[phase]?.generation ?? null : null;
  const welKnowledgeEnabled = observedWelEnrollment(root, definition, workflow);
  let slices = unique(request.requestedSlices?.length ? request.requestedSlices : (
    request.slice ? [request.slice] : plan ? ['brief', 'impact', 'ast', 'evidence'] : ['brief', 'world-model', 'ast', 'evidence']
  ));
  if (welKnowledgeEnabled) slices = unique([...slices, 'knowledge']);
  const invalidSlices = slices.filter((slice) => !EVIDENCE_PACKET_SLICES.includes(slice));
  if (invalidSlices.length) throw new SingularityFlowError(`Unsupported Evidence Packet slice(s): ${invalidSlices.join(', ')}.`, {
    code: 'EPC_CONTEXT_BUDGET_INVALID'
  });
  const directTarget = plan?.target ?? request.target ?? null;
  const findings = acceptedFinding(plan, request.findingIds);
  const unavailable = [];
  const candidates = [];
  const mandatoryGovernance = mandatoryGovernanceCandidate(definition, workflow, phase);
  if (mandatoryGovernance) candidates.push(mandatoryGovernance);
  if (!plan && workflow) {
    candidates.push({
      kind: 'current-work-context', subject: workflow.workItem.id,
      classification: 'proven', representation: 'L0-work-identity',
      content: `${workflow.workItem.id} is ${workflow.status} in ${phase ?? 'complete'}.`,
      relationship: 'current-phase', reason: { code: 'phase.required-context', findingIds: [] },
      source: { type: 'governed-workflow', reference: `${definition.workItemRoot ?? 'singularity/work-items'}/${workflow.workItem.id}/workflow.json` },
      sourceMaterial: false, mandatory: true, cacheClass: 'session-stable'
    });
    if (requested(slices, 'impact')) unavailable.push({
      code: 'EPC_FLIGHT_PLAN_NOT_FOUND', subject: 'impact',
      reason: 'This governed work item has no accepted Change Flight Plan; current-work context is used instead.',
      nextAction: 'Continue with current phase context or start work from a Change Flight Plan.'
    });
  }
  if (requested(slices, 'impact') || requested(slices, 'evidence')) {
    candidates.push(...findings.map((finding) => candidateForFinding(finding, directTarget)));
  }
  if (requested(slices, 'evidence')) candidates.push(...governedEvidenceCandidates(workflow));
  if (requested(slices, 'ast')) candidates.push(...await astCandidates(root, findings, directTarget, unavailable));
  if (requested(slices, 'brief') && workflow) {
    const briefs = await briefCandidates(root, definition, workflow);
    candidates.push(...briefs);
    if (!briefs.length) unavailable.push({
      code: 'EPC_SOURCE_UNAVAILABLE', subject: 'approved-agent-briefs', reason: 'No approved brief is available for the current phase.',
      nextAction: 'Continue with governed Flight Plan context or prepare the phase brief.'
    });
  }
  if (requested(slices, 'world-model') && workflow) {
    candidates.push(...await worldModelCandidates(root, workflow, unavailable));
  }
  let analogues = [];
  if (requested(slices, 'history')) {
    try {
      analogues = await findHistoricalAnalogues(root, definition, {
        workId: workflow?.workItem?.id ?? null, flightPlan: plan
      });
      candidates.push(...historyCandidates(analogues));
      if (!analogues.length) unavailable.push({
        code: 'EPC_HISTORY_UNAVAILABLE', subject: 'history', reason: 'No authorized completed work has an exact governed overlap.',
        nextAction: 'Continue without historical guidance.'
      });
    } catch (error) {
      unavailable.push({
        code: 'EPC_HISTORY_UNAVAILABLE', subject: 'history', reason: error.code ?? error.message,
        nextAction: 'Continue without historical guidance.'
      });
    }
  }
  if (requested(slices, 'observation')) {
    candidates.push(...observationCandidates(request.observation));
    if (!request.observation) unavailable.push({
      code: 'EPC_SOURCE_UNAVAILABLE', subject: 'observation', reason: 'No typed observation was supplied.',
      nextAction: 'Compile a configured operation result, then request the observation slice.'
    });
  }

  const boundedKnowledge = knowledgeLimits(maximumOutputBytes);
  let knowledge = null;
  if (requested(slices, 'knowledge')) {
    if (!welKnowledgeEnabled) {
      unavailable.push({
        code: 'EPC_KNOWLEDGE_NOT_ENROLLED', subject: 'knowledge',
        reason: 'The Story creation anchor is not enrolled in WEL observe mode.',
        nextAction: 'Continue without knowledge guidance; existing Story authority is unchanged.'
      });
    } else if (maximumOutputBytes < EVIDENCE_PACKET_KNOWLEDGE_MINIMUM_OUTPUT_BYTES) {
      throw new SingularityFlowError(
        `The Evidence Packet output budget is too small for bounded knowledge guidance and its provenance; request at least ${EVIDENCE_PACKET_KNOWLEDGE_MINIMUM_OUTPUT_BYTES} bytes.`,
        {
          code: 'EPC_KNOWLEDGE_OUTPUT_BUDGET',
          details: {
            configuredLimitBytes: maximumOutputBytes,
            minimumKnowledgePacketBytes: EVIDENCE_PACKET_KNOWLEDGE_MINIMUM_OUTPUT_BYTES,
            nextAction: `Request the packet again with --max-output-bytes ${EVIDENCE_PACKET_KNOWLEDGE_MINIMUM_OUTPUT_BYTES} or greater.`
          }
        }
      );
    } else {
      try {
        knowledge = await compileKnowledge(root, workflow, plan, findings, boundedKnowledge);
      } catch {
        knowledge = unavailableKnowledge(boundedKnowledge);
        unavailable.push({
          code: 'EPC_KNOWLEDGE_UNAVAILABLE', subject: 'knowledge',
          reason: 'The existing knowledge store could not be read and verified for bounded recall.',
          nextAction: 'Continue without knowledge guidance, or repair the knowledge record and request a fresh packet.'
        });
      }
    }
  }
  const knowledgeProvenance = contentFreeKnowledge(knowledge);

  const scopedDefinition = workflow ? withWorldModelSourceScope(
    definition,
    workflow.resolution?.worldModelSourceScope ?? workflow.resolution?.capability?.sourceScope ?? null
  ) : definition;
  const sourceScope = workflow ? worldModelSourceScope(scopedDefinition) : null;
  const lifecycleRevision = workflow ? recordSha256(workflow) : null;
  const intent = plan?.intent ?? request.intent ?? null;
  const manifest = compileContextManifest({
    definition: workflow?.resolution ?? definition,
    constitution: workflow?.resolution?.constitutionPin ?? workflow?.resolution?.constitution ?? null,
    capabilitySkeleton: sourceScope,
    flightPlan: plan,
    knowledge: knowledgeProvenance,
    observation: request.observation ? {
      observationId: request.observation.observationId, source: request.observation.source,
      status: request.observation.status
    } : null
  });
  const binding = {
    mode: bindingMode,
    workId: workflow?.workItem?.id ?? null,
    flightPlanId: plan?.planId ?? null,
    phase, generation, sourceRevision,
    configurationSha256: recordSha256(workflow?.resolution ?? definition),
    worldModelSha256: recordSha256(sourceScope),
    intentSha256: intent?.digest ?? (intent ? recordSha256(intent) : null),
    lifecycleRevision,
    workType: workflow?.workItem?.workType ?? null,
    intervalId: workflow?.workIntervals?.current?.intervalId ?? null,
    operationId: request.operationId ?? operationContext()?.operation?.id ?? null,
    tokenEconomyMode: tokenEconomy.mode,
    tokenEconomyProfile: selectedProfile.id,
    tokenEconomyConfigurationDigest: tokenEconomyDigest(tokenEconomy)
  };
  const ranked = rankContextCandidates(candidates);
  const mandatory = ranked.filter((entry) => entry.mandatory);
  const optional = ranked.filter((entry) => !entry.mandatory);
  const capped = [...mandatory, ...optional.slice(0, Math.max(0, MAX_CANDIDATES - mandatory.length))];
  const overflow = optional.slice(Math.max(0, MAX_CANDIDATES - mandatory.length))
    .map((entry) => ({ ...entry, omissionReason: 'candidate-bound' }));
  const selection = selectContextCandidates(capped, Math.max(512, Math.floor(maximumOutputBytes * 0.42)));
  let selected = [...selection.items];
  const omitted = [...selection.omissions, ...overflow];
  let packetId = `ctx-${recordSha256(packetIdentity(binding, selected, omitted, manifest)).slice(0, 20)}`;
  let items = await addExpansionHandles(root, selected, binding, packetId, maximumOutputBytes);
  let omissionHandle = null;
  if (omitted.length) {
    omissionHandle = await issueContextExpansionHandle(root, {
      packetId, workId: binding.workId, flightPlanId: binding.flightPlanId,
      sourceRevision, lifecycleRevision, itemId: 'omission-group', expansionKind: 'omission-page',
      maximumOutputBytes,
      source: { entries: omitted.map((entry) => publicItem(entry)) }
    });
  }
  const makePacket = () => {
    const includedContentBytes = items.reduce((total, item) => total + item.bytes, 0)
      + Number(knowledge?.guidance?.bytes ?? 0);
    const omissions = compactOmission(omitted, omissionHandle);
    const status = omissions.length ? 'partial'
      : unavailable.length && !items.length ? 'unavailable'
        : unavailable.length ? 'degraded' : 'complete';
    return {
      schemaVersion: currentSchemaVersion('evidence-packet'),
      kind: 'evidence-packet', packetId, compilerVersion: EVIDENCE_PACKET_COMPILER_VERSION,
      status, guidanceOnly: true, modelInvoked: false,
      binding: Object.fromEntries(Object.entries(binding).filter(([key]) => key !== 'lifecycleRevision')),
      correlation: {
        workspaceId: `sha256:${recordSha256({ root })}`,
        storyId: binding.workId,
        workType: binding.workType,
        phase: binding.phase,
        generation: binding.generation,
        intervalId: binding.intervalId,
        goalId: null,
        flightPlanId: binding.flightPlanId,
        operationId: binding.operationId,
        packetId,
        launchId: request.launchId ?? null,
        sessionId: request.sessionId ?? null
      },
      tokenEconomy: {
        enabled: tokenEconomy.enabled, mode: tokenEconomy.mode,
        profile: selectedProfile.id,
        selectionReason: request.profile ? 'explicit-approved-profile' : 'pinned-default',
        configurationDigest: binding.tokenEconomyConfigurationDigest
      },
      outcome: lifecycleOutcome(workflow, phase),
      requestedSlices: slices,
      budget: {
        maximumOutputBytes, includedContentBytes, profile: selectedProfile.id,
        maximumEstimatedPromptTokens: selectedProfile.maximumEstimatedPromptTokens,
        reservedOutputTokens: selectedProfile.reservedOutputTokens,
        estimatedInputTokens: Math.ceil(includedContentBytes / 4),
        estimationMethod: 'utf8-bytes-divided-by-four', exact: false
      },
      items, omissions, unavailable,
      knowledge,
      expansion: [
        ...(omissionHandle ? [{ kind: 'omission-group', handle: omissionHandle }] : []),
        ...items.filter((item) => item.expandHandle).map((item) => ({
          kind: item.kind, itemId: item.itemId, handle: item.expandHandle
        }))
      ],
      contextManifest: manifest,
      observation: request.observation ? {
        observationId: request.observation.observationId,
        rawBytes: request.observation.rawBytes, includedBytes: request.observation.includedBytes,
        compressionRatio: request.observation.compressionRatio
      } : null,
      integrity: null
    };
  };
  let packet = finalPacket(makePacket());
  while (Buffer.byteLength(JSON.stringify(packet)) > maximumOutputBytes && items.length) {
    const removableIndex = selected.findLastIndex((candidate) => !candidate.mandatory);
    if (removableIndex < 0) break;
    const [removed] = selected.splice(removableIndex, 1);
    omitted.unshift({ ...removed, omissionReason: 'budget' });
    packetId = `ctx-${recordSha256(packetIdentity(binding, selected, omitted, manifest)).slice(0, 20)}`;
    items = await addExpansionHandles(root, selected, binding, packetId, maximumOutputBytes);
    omissionHandle = await issueContextExpansionHandle(root, {
      packetId, workId: binding.workId, flightPlanId: binding.flightPlanId,
      sourceRevision, lifecycleRevision, itemId: 'omission-group', expansionKind: 'omission-page',
      maximumOutputBytes,
      source: { entries: omitted.map((entry) => publicItem(entry)) }
    });
    packet = finalPacket(makePacket());
  }
  if (Buffer.byteLength(JSON.stringify(packet)) > maximumOutputBytes) {
    packet.unavailable = packet.unavailable.slice(0, 3);
    packet.expansion = omissionHandle ? [{ kind: 'omission-group', handle: omissionHandle }] : [];
    packet = finalPacket(packet);
  }
  if (Buffer.byteLength(JSON.stringify(packet)) > maximumOutputBytes) {
    const requiredBytes = Buffer.byteLength(JSON.stringify(packet));
    if (knowledge) {
      throw new SingularityFlowError(
        'Bounded knowledge guidance and provenance cannot fit without evicting mandatory governance context.',
        {
          code: 'EPC_KNOWLEDGE_OUTPUT_BUDGET',
          details: {
            requiredBytes,
            configuredLimitBytes: maximumOutputBytes,
            knowledgeLimits: boundedKnowledge,
            nextAction: `Request a packet with --max-output-bytes ${Math.min(MAX_OUTPUT_BYTES, Math.max(requiredBytes, EVIDENCE_PACKET_KNOWLEDGE_MINIMUM_OUTPUT_BYTES))}, or narrow the knowledge store scope.`
          }
        }
      );
    }
    throw new SingularityFlowError('Mandatory Evidence Packet metadata cannot fit the requested output budget.', {
      code: 'TKN_MANDATORY_CONTEXT_OVERFLOW', details: {
        requiredBytes, configuredLimitBytes: maximumOutputBytes,
        unsafeReason: 'Applicable governance context cannot be truncated or budget-evicted.',
        nextAction: 'Select an approved larger token-economy profile, narrow the operation, or split the work.'
      }
    });
  }
  await recordContextPacketTelemetry(root, packet, { providerTelemetry: request.providerTelemetry ?? null });
  return packet;
}

function gitTextAt(root, revision, relative, maximumBytes) {
  const result = run('git', ['show', `${revision}:${relative}`], {
    cwd: root, allowFailure: true, maxBuffer: Math.min(8 * 1024 * 1024, Math.max(maximumBytes * 4, maximumBytes))
  });
  if (result.status !== 0) throw new SingularityFlowError('The bound source is unavailable at the sealed revision.', {
    code: 'EPC_SOURCE_UNAVAILABLE', details: { nextAction: 'Request a refreshed context packet.' }
  });
  return result.stdout;
}

function symbolBody(source, span, maximumBytes) {
  const rows = String(source).replace(/\r\n?/g, '\n').split('\n');
  const start = Math.max(0, Number(span?.startLine ?? 1) - 1);
  let end = Math.min(rows.length, Math.max(start + 1, Number(span?.endLine ?? span?.startLine ?? 1)));
  let braces = 0;
  let opened = false;
  for (let index = start; index < rows.length && index < start + 1000; index += 1) {
    for (const character of rows[index]) {
      if (character === '{') { braces += 1; opened = true; }
      if (character === '}') braces -= 1;
    }
    end = index + 1;
    if (opened && braces <= 0) break;
    if (!opened && index >= start + 40) break;
  }
  return boundedText(rows.slice(start, end).join('\n'), maximumBytes);
}

async function repositoryExpansion(root, record, source) {
  const relative = String(source.path ?? '');
  await secureRepositoryPath(root, relative, { label: 'Bound context expansion source', mustExist: true, type: 'file' });
  const text = gitTextAt(root, record.sourceRevision, relative, record.maximumOutputBytes);
  return boundedText(text, record.maximumOutputBytes);
}

/** Consume one machine-local sealed handle. The returned shape is transport-only. */
export async function expandEvidencePacketHandle(root, handle) {
  const record = await readContextExpansionHandle(root, handle);
  const source = record.source ?? {};
  let content;
  let representation;
  if (record.expansionKind === 'observation-raw') {
    content = boundedText((await readRawObservation(root, source.rawSha256)).toString('utf8'), record.maximumOutputBytes);
    representation = 'raw-observation';
  } else if (record.expansionKind === 'symbol-body') {
    const relative = String(source.path ?? '');
    await secureRepositoryPath(root, relative, { label: 'Bound symbol source', mustExist: true, type: 'file' });
    content = symbolBody(gitTextAt(root, record.sourceRevision, relative, record.maximumOutputBytes), source.span, record.maximumOutputBytes);
    representation = 'L3-symbol-body';
  } else if (['repository-record', 'history-receipt', 'requirement-reference'].includes(record.expansionKind)) {
    content = await repositoryExpansion(root, record, source);
    representation = record.expansionKind === 'requirement-reference'
      ? 'approved-document' : record.expansionKind;
  } else if (record.expansionKind === 'supporting-evidence') {
    const plan = record.workId
      ? await acceptedPlan(root,
        await loadStoryAggregate(root, await loadConfig(root), record.workId), record.flightPlanId)
      : await readChangeFlightPlan(root, record.flightPlanId);
    const finding = plan.findings.find((entry) => entry.findingId === source.findingId);
    if (!finding) throw new SingularityFlowError('The bound impact finding is unavailable.', {
      code: 'EPC_SOURCE_UNAVAILABLE', details: { nextAction: 'Request a refreshed context packet.' }
    });
    content = JSON.stringify(finding, null, 2);
    representation = 'flight-plan-finding';
  } else if (record.expansionKind === 'omission-page') {
    content = JSON.stringify((source.entries ?? []).map((entry) => ({
      ...entry, content: boundedText(entry.content, Math.max(256, Math.floor(record.maximumOutputBytes / Math.max(1, source.entries.length))))
    })), null, 2);
    content = boundedText(content, record.maximumOutputBytes);
    representation = 'bounded-omission-page';
  } else {
    throw new SingularityFlowError('Context expansion kind is not supported.', { code: 'EPC_EXPANSION_INVALID' });
  }
  const includedContentBytes = Buffer.byteLength(content);
  const estimatedInputTokens = Math.ceil(includedContentBytes / 4);
  await recordContextExpansionRequest(root, record.packetId, {
    handleKind: record.expansionKind,
    itemId: record.itemId,
    includedBytes: includedContentBytes,
    estimatedTokens: estimatedInputTokens
  });
  return {
    schemaVersion: 1, // schema-transient: sealed read result, never persisted
    kind: 'evidence-packet-expansion', packetId: record.packetId, itemId: record.itemId,
    representation, content,
    material: ['flight-plan-finding', 'bounded-omission-page'].includes(representation) ? 'governed-guidance' : 'untrusted-source',
    instructions: 'not-authoritative', guidanceOnly: true,
    accounting: {
      maximumOutputBytes: record.maximumOutputBytes,
      includedContentBytes,
      estimatedInputTokens,
      estimationMethod: 'utf8-bytes-divided-by-four', exact: false
    }
  };
}
