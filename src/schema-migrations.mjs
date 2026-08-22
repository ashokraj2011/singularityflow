/**
 * Pure, in-memory schema migration for durable records.
 *
 * Stored bytes are never rewritten here. Readers receive a current-shape clone together with the
 * version that was actually stored and the steps used to reach the current version. Migration
 * functions in this module deliberately have no access to I/O, clocks, Git, or model runners.
 */
import { SingularityFlowError } from './util.mjs';

function plainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return structuredClone(value);
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stable(value));
}

function migration(from, to, migrate) {
  return Object.freeze({ from, to, migrate });
}

function identity(next) {
  return (record) => ({ ...record, schemaVersion: next });
}

function astResultV1ToV2(source) {
  const facts = (source.facts ?? []).map((fact) => ({
    ...fact,
    ...(fact.kind === 'file' || fact.kind === 'symbol' || fact.kind === 'import' || fact.kind === 'relationship'
      ? { assurance: fact.assurance ?? 'text', generated: fact.generated === true }
      : {})
  }));
  const count = facts.length;
  return {
    ...source,
    schemaVersion: 2,
    coverage: {
      selected: source.coverage?.selected ?? 0,
      processed: source.coverage?.processed ?? 0,
      skipped: source.coverage?.skipped ?? 0,
      bytes: source.coverage?.bytes ?? 0,
      facts: count,
      factsExamined: source.coverage?.factsExamined ?? source.coverage?.facts ?? count,
      factsMatched: source.coverage?.factsMatched ?? source.coverage?.facts ?? count,
      factsReturned: source.coverage?.factsReturned ?? count,
      byLanguage: clone(source.coverage?.byLanguage ?? {})
    },
    facts
  };
}

function astResultV2ToV3(source) {
  const facts = (source.facts ?? []).map((fact) => {
    if (fact.id != null) {
      return { ...clone(fact), extractors: clone(fact.extractors ?? []) };
    }
    if (fact.kind == null) return clone(fact);
    const assurance = fact.assurance ?? 'text';
    return {
      ...clone(fact),
      extractor: clone(fact.extractor ?? {
        id: 'legacy-unknown', version: '0', assurance
      })
    };
  });
  const extractors = [...new Map(facts
    .map((fact) => fact.extractor)
    .filter(Boolean)
    .map((extractor) => [stableJson(extractor), extractor])).values()];
  const migrated = {
    ...source,
    schemaVersion: 3,
    facts,
    nextCursor: source.nextCursor ?? null,
    page: clone(source.page ?? {
      offset: 0,
      returned: facts.length,
      // v2 had no continuation cursor. Only the returned facts remain readable after migration;
      // a larger pre-filter count here would advertise a continuation that cannot exist.
      available: facts.length,
      hasMore: false,
      maxFacts: Math.max(1, facts.length),
      maxOutputBytes: Math.max(16 * 1024, Buffer.byteLength(JSON.stringify(source))),
      outputBytes: 0
    }),
    provenance: {
      ...clone(source.provenance ?? {}),
      extractors: clone(source.provenance?.extractors ?? extractors)
    }
  };
  if (!source.page) {
    migrated.page.outputBytes = Buffer.byteLength(JSON.stringify(migrated));
    migrated.page.maxOutputBytes = Math.max(migrated.page.maxOutputBytes, migrated.page.outputBytes);
  }
  return migrated;
}

function astResultV3ToV4(source) {
  return {
    ...source,
    schemaVersion: 4,
    evidenceClass: source.evidenceClass ?? 'preview',
    provenance: {
      ...clone(source.provenance ?? {}),
      evidence: clone(source.provenance?.evidence ?? null)
    }
  };
}

function astGateReceiptV1ToV2(source) {
  return {
    ...source,
    schemaVersion: 2,
    engine: clone(source.engine ?? { id: 'legacy-unknown', version: 0 }),
    extractors: clone(source.extractors ?? []),
    predicates: (source.predicates ?? []).map((predicate) => ({
      ...clone(predicate), extractors: clone(predicate.extractors ?? [])
    }))
  };
}

function astGateReceiptV2ToV3(source) {
  return {
    ...source,
    schemaVersion: 3,
    derivation: clone(source.derivation ?? {
      replayability: 'legacy-unreplayable',
      reason: 'artifact and exact-input derivation were not recorded'
    }),
    predicates: (source.predicates ?? []).map((predicate) => ({
      ...clone(predicate),
      factSetSha256: predicate.factSetSha256 ?? null,
      derivationSha256: predicate.derivationSha256 ?? null
    }))
  };
}

function astResumeJobV1ToV2(source) {
  // v1 retained only a cursor and repository-wide fingerprint, so it cannot safely be upgraded to
  // v2's exact candidate set and accumulated pages. Preserve enough identity to produce an
  // intentional stale-handle remedy rather than misreading it as a v2 job.
  return { ...source, schemaVersion: 2, legacyV1: true };
}

function legacyStoryPhase(phase, id, index) {
  const requiredArtifact = clone(phase?.requiredArtifact ?? phase?.artifact ?? null);
  return {
    ...(phase ?? {}),
    id,
    label: phase?.label ?? id,
    order: Number.isInteger(phase?.order) ? phase.order : index,
    defaultAgent: phase?.defaultAgent ?? null,
    approvalPolicy: clone(phase?.approvalPolicy ?? { mode: 'required', authorities: ['delivery-approvers'], minimum: 1, rejectTo: [id] }),
    generationPolicy: clone(phase?.generationPolicy ?? { requirement: requiredArtifact ? 'required' : 'optional', producer: 'agent' }),
    requiredArtifact,
    mcp: clone(phase?.mcp ?? { requiredServers: [], requireSmoke: false, evidence: [] }),
    sourceBoundary: clone(phase?.sourceBoundary ?? { mode: 'phase-default', allowed: [] }),
    inputs: clone(phase?.inputs ?? []),
    remoteOutputs: clone(phase?.remoteOutputs ?? []),
    writeScope: phase?.writeScope ?? 'source-and-artifact',
    comparison: clone(phase?.comparison ?? {}),
    generation: Number.isInteger(phase?.generation) ? phase.generation : (phase?.artifacts?.length ? 1 : 0),
    usage: clone(phase?.usage ?? []),
    telemetry: clone(phase?.telemetry ?? []),
    approvals: clone(phase?.approvals ?? [])
  };
}

function storyWorkflowV1ToV2(source) {
  const phaseOrder = Array.isArray(source.phaseOrder) ? [...source.phaseOrder] : Object.keys(source.phases ?? {});
  const phases = Object.fromEntries(phaseOrder.map((id, index) => [id, legacyStoryPhase(source.phases?.[id], id, index)]));
  const workType = source.workItem?.workType ?? 'legacy-standard';
  const resolvedPhases = phaseOrder.map((id) => {
    const phase = phases[id];
    return {
      id,
      label: phase.label,
      artifact: clone(phase.requiredArtifact),
      template: phase.template ?? null,
      defaultAgent: phase.defaultAgent,
      approval: clone(phase.approvalPolicy),
      generation: clone(phase.generationPolicy),
      mcp: clone(phase.mcp),
      sourceBoundary: clone(phase.sourceBoundary),
      inputs: clone(phase.inputs),
      writeScope: phase.writeScope,
      comparison: clone(phase.comparison)
    };
  });
  const createdAt = source.workItem?.createdAt ?? source.history?.[0]?.at ?? null;
  return {
    ...source,
    schemaVersion: 2,
    workItem: {
      ...(source.workItem ?? {}), workType,
      workTypeLabel: source.workItem?.workTypeLabel ?? 'Legacy workflow'
    },
    lineage: clone(source.lineage ?? {
      schemaVersion: 1,
      canonicalBranch: source.workItem?.branch ?? source.workItem?.id ?? null,
      parentStoryId: source.workItem?.id ?? null,
      epicId: null,
      planId: null,
      jiraIssueId: null,
      initialJiraKey: null,
      currentJiraKey: null,
      branchCompletionPolicy: 'pr',
      requiredChecks: [],
      childBranches: []
    }),
    resolution: {
      ...(source.resolution ?? {}),
      workType,
      workTypeLabel: source.workItem?.workTypeLabel ?? 'Legacy workflow',
      configSha256: source.resolution?.configSha256 ?? null,
      sourceSha256: source.resolution?.sourceSha256 ?? null,
      templates: clone(source.resolution?.templates ?? {}),
      phases: clone(source.resolution?.phases ?? resolvedPhases),
      sequenceGates: clone(source.resolution?.sequenceGates ?? { default: 'hard' }),
      session: clone(source.resolution?.session ?? { workItemSelection: 'off', requireBeforeTools: false }),
      contextPolicy: clone(source.resolution?.contextPolicy ?? { onApproval: 'keep', onRejection: 'keep', phaseOverrides: {} })
    },
    phases,
    usage: clone(source.usage ?? {
      mode: 'exact-or-unavailable', totalTokens: 0, records: 0, exactRecords: 0,
      unavailableRecords: 0, byPhase: {}, byAgent: {}, byWorkType: {}, byWorkItem: {}
    }),
    telemetry: clone(source.telemetry ?? { schemaVersion: 1, mode: 'work-item-sanitized' }),
    documents: clone(source.documents ?? { count: 0, updatedAt: null }),
    collaboration: clone(source.collaboration ?? { assignments: {}, notifications: [] }),
    sequenceOverrides: clone(source.sequenceOverrides ?? []),
    changeRequests: clone(source.changeRequests ?? []),
    history: clone(source.history ?? (createdAt ? [{ at: createdAt, event: 'work_started', phase: source.currentPhase ?? null }] : []))
  };
}

function actionPlanV1ToV2(source) {
  const worktreeHash = source.revision?.worktreeHash ?? null;
  return {
    ...source,
    schemaVersion: 2,
    subject: clone(source.subject ?? (source.workId
      ? { kind: 'story', id: source.workId }
      : { kind: 'repository', id: null })),
    revision: {
      ...(source.revision ?? {}),
      workingTree: source.revision?.workingTree ?? {
        schemaVersion: 1,
        sha256: worktreeHash,
        legacyStatusOnly: true,
        headTree: null,
        indexTree: null,
        workingTree: null
      }
    },
    actions: (source.actions ?? []).map((action) => ({
      ...action,
      confirmation: action.confirmation?.required
        ? { ...action.confirmation, mode: action.confirmation.mode ?? 'one-time-authorization' }
        : { ...(action.confirmation ?? {}), required: false, mode: 'none' }
    }))
  };
}

function mcpEvidenceV1ToV2(source) {
  return {
    ...source,
    schemaVersion: 2,
    kind: source.kind ?? 'tool-call',
    targetGeneration: source.targetGeneration ?? source.generation ?? null
  };
}

function mcpEvidenceV2ToV3(source) {
  return {
    ...source,
    schemaVersion: 3,
    captureSource: source.captureSource ?? 'legacy-agent-supplied'
  };
}

function documentManifestV1ToV2(source) {
  return { ...source, schemaVersion: 2, packages: clone(source.packages ?? []) };
}

function knowledgeRecordV1ToV2(source) {
  const legacyClaim = {
    schemaVersion: 1,
    type: source.type,
    title: source.title,
    detail: source.detail ?? null,
    status: source.status ?? null,
    tags: clone(source.tags ?? []),
    provenance: clone(source.provenance ?? null),
    supersedes: source.supersedes ?? null
  };
  const type = source.type === 'learning' || source.type === 'result' ? 'insight' : source.type;
  return {
    schemaVersion: 2,
    type,
    text: [source.title, source.detail].filter(Boolean).join(' — '),
    provenance: [],
    scope: {},
    status: source.status === 'resolved' ? 'resolved'
      : source.status === 'superseded' ? 'superseded' : 'active',
    validFrom: source.recordedAt ?? null,
    validUntil: null,
    createdBy: source.actor ?? null,
    supersedes: source.supersedes ?? null,
    id: null,
    createdAt: source.recordedAt ?? null,
    // v1 did not bind a reusable claim to approved artifact provenance or an explicit scope.
    // Keeping it visible but ineligible for deterministic recall is the only non-invented upgrade.
    legacyUnverified: true,
    legacy: { claim: legacyClaim, recordedAt: source.recordedAt ?? null, actor: source.actor ?? null }
  };
}

function phaseApprovalV1ToV2(source) {
  const legacySnapshot = clone(source);
  delete legacySnapshot.schemaVersion;
  return {
    schemaVersion: 2,
    phase: source.phase ?? null,
    decisions: clone(source.decisions ?? [{
      decision: 'approved',
      at: source.approvedAt ?? null,
      actor: source.approvedBy ?? null,
      provenance: clone(source.provenance ?? null),
      legacySnapshot
    }])
  };
}

function promptInjectionV1ToV2(source) {
  // Absence is meaningful: the v1 verifier used requiredViews because exact tier identities did
  // not yet exist. Null preserves that compatibility branch without inventing selections.
  return { ...source, schemaVersion: 2, requiredSelections: clone(source.requiredSelections ?? null) };
}

function promptInjectionV2ToV3(source) {
  const structuralContext = source.structuralContext == null ? null : {
    ...clone(source.structuralContext),
    derivation: clone(source.structuralContext.derivation ?? {
      replayability: 'legacy-unreplayable',
      reason: 'artifact and exact-input derivation were not recorded'
    })
  };
  return { ...source, schemaVersion: 3, structuralContext };
}

function agentContextAuditV1ToV2(source) {
  return {
    ...source,
    schemaVersion: 2,
    nativeCopilotAgent: source.nativeCopilotAgent ?? source.persona ?? null
  };
}

function dxCommandTimingV1ToV2(source) {
  const stages = Array.isArray(source.stages)
    ? Object.fromEntries(source.stages.map((stage) => [stage.name, stage.durationMs]))
    : clone(source.stages ?? {});
  return {
    ...source,
    schemaVersion: 2,
    event: source.event ?? 'dx.command-timing',
    commandClass: source.commandClass ?? 'unknown',
    startedAt: source.startedAt ?? source.recordedAt ?? null,
    stages,
    outcome: source.outcome ?? 'success',
    fallback: source.fallback ?? 'none'
  };
}

function vscodeResetMarkerV1ToV2(source) {
  return {
    ...source,
    schemaVersion: 2,
    mode: source.mode ?? 'delete-workspaces',
    reset: clone(source.reset ?? ['credentials', 'onboarding', 'extension-global-state'])
  };
}

function family({
  id, currentVersion, minimumReadableVersion = 1, steps = [], paths = [], immutable = false,
  unversionedAs = null, migrationPolicy = 'migrate-on-read'
}) {
  return Object.freeze({
    id,
    currentVersion,
    minimumReadableVersion,
    maximumReadableVersion: currentVersion,
    steps: Object.freeze(steps),
    paths: Object.freeze(paths),
    immutable,
    unversionedAs,
    migrationPolicy,
    model: 'never'
  });
}

const families = [
  family({
    id: 'session-registry', currentVersion: 2,
    steps: [migration(1, 2, identity(2))],
    paths: [/^\$git\/session\.json$/], unversionedAs: 1
  }),
  family({ id: 'copilot-session', currentVersion: 1, paths: [/^\$git\/copilot-session\.json$/] }),
  family({ id: 'copilot-turn-intent', currentVersion: 1, paths: [/^\$git\/copilot-turn-[^/]+\.json$/] }),
  family({
    id: 'story-workflow', currentVersion: 2,
    steps: [migration(1, 2, storyWorkflowV1ToV2)],
    paths: [/^(?:singularity|\.sdlc)\/work-items\/[^/]+\/workflow\.json$/], unversionedAs: 1
  }),
  family({
    id: 'action-plan', currentVersion: 2,
    steps: [migration(1, 2, actionPlanV1ToV2)],
    paths: [/^\$git\/action-plans\/[^/]+\.json$/]
  }),
  family({ id: 'action-authorization', currentVersion: 1, paths: [/^\$git\/action-authorizations\/[^/]+\.json$/] }),
  family({ id: 'action-result', currentVersion: 1, paths: [/^\$git\/action-results\/[^/]+\.json$/] }),
  family({ id: 'selection-receipt', currentVersion: 1, paths: [/^\$git\/choices\/[^/]+\.json$/] }),
  family({ id: 'artifact-set', currentVersion: 1 }),
  family({ id: 'artifact-sidecar', currentVersion: 1, paths: [/^singularity\/work-items\/[^/]+\/context\/sidecars\/[^/]+\.json$/], immutable: true }),
  family({ id: 'assisted-quality', currentVersion: 1, paths: [/^singularity\/work-items\/[^/]+\/context\/spec-quality\/[^/]+\.json$/], immutable: true }),
  family({ id: 'assisted-convergence', currentVersion: 1, paths: [/^singularity\/work-items\/[^/]+\/context\/convergence\/candidates-[^/]+\.json$/], immutable: true }),
  family({ id: 'clarification-record', currentVersion: 1, paths: [/^singularity\/work-items\/[^/]+\/context\/clarifications-[^/]+-gen\d+\.json$/] }),
  family({ id: 'phase-input-record', currentVersion: 1, paths: [/^singularity\/work-items\/[^/]+\/context\/inputs-[^/]+-gen\d+\.json$/] }),
  family({ id: 'agent-brief-record', currentVersion: 1, paths: [/^singularity\/work-items\/[^/]+\/context\/briefs\/[^/]+-gen\d+-for-[^/]+\.json$/], immutable: true }),
  family({ id: 'design-source-set', currentVersion: 1, paths: [/^singularity\/work-items\/[^/]+\/context\/design-sources\/[^/]+-gen\d+\.json$/], immutable: true }),
  family({ id: 'design-source-provenance', currentVersion: 1, paths: [/^singularity\/work-items\/[^/]+\/context\/design-sources-[^/]+-gen\d+\.json$/], immutable: true }),
  family({ id: 'work-interval-baseline', currentVersion: 1, paths: [/^singularity\/work-items\/[^/]+\/context\/work-intervals\/[^/]+-gen\d+-baseline\.json$/] }),
  family({ id: 'work-interval-state', currentVersion: 1 }),
  family({
    id: 'work-reconciliation', currentVersion: 1,
    paths: [/^singularity\/work-items\/[^/]+\/context\/work-intervals\/reconciliations\/[^/]+\.json$/, /^\$git\/reconciliations\/[^/]+\/[^/]+\.json$/]
  }),
  family({ id: 'work-checkpoint', currentVersion: 1, paths: [/^\$git\/checkpoints\/[^/]+\/[^/]+\.json$/], immutable: true }),
  family({ id: 'work-rail-escalation-plan', currentVersion: 1 }),
  family({ id: 'intent-amendment-proposal', currentVersion: 1, paths: [/^singularity\/work-items\/[^/]+\/context\/intent-amendments\/[^/]+\.json$/], immutable: true }),
  family({ id: 'composition-cache-entry', currentVersion: 1, paths: [/^\$git\/composition-cache\/[^/]+\/metadata\.json$/] }),
  family({ id: 'design-inventory-digest', currentVersion: 1, paths: [/^singularity\/work-items\/[^/]+\/context\/design-inventory\/[^/]+\/digest\.json$/], immutable: true }),
  family({ id: 'evidence-detachment-decision', currentVersion: 1, paths: [/^singularity\/(?:work-items|initiatives)\/[^/]+\/(?:evidence|sources)\/detachments\/[^/]+\.json$/], immutable: true }),
  family({ id: 'document-package-manifest', currentVersion: 1, paths: [/^singularity\/work-items\/[^/]+\/inputs\/packages\/[^/]+\/manifest\.json$/], immutable: true }),
  family({ id: 'epic-completion-decision', currentVersion: 1, paths: [/^singularity\/initiatives\/[^/]+\/delivery\/records\/[^/]+\.json$/], immutable: true }),
  family({ id: 'github-review-evidence', currentVersion: 1, immutable: true }),
  family({ id: 'governed-reference', currentVersion: 1, paths: [/^singularity\/(?:work-items|initiatives)\/[^/]+\/context\/references\/[a-f0-9]{64}\.json$/], immutable: true }),
  family({ id: 'impact-measurement-state', currentVersion: 1 }),
  family({ id: 'impact-plan', currentVersion: 1, immutable: true }),
  family({ id: 'impact-invalidation', currentVersion: 1, immutable: true }),
  family({ id: 'impact-exposure', currentVersion: 1, immutable: true }),
  family({ id: 'impact-receipt', currentVersion: 1, immutable: true }),
  family({ id: 'initiative-context', currentVersion: 1, paths: [/^singularity\/initiatives\/[^/]+\/context\/prompt-context-[^/]+-gen\d+\.json$/], immutable: true }),
  family({ id: 'initiative-contract', currentVersion: 1, paths: [/^singularity\/initiatives\/[^/]+\/contracts\/[^/]+\/[^/]+\/manifest\.json$/], immutable: true }),
  family({ id: 'jira-lineage-property', currentVersion: 1 }),
  family({ id: 'jira-initiative-plan', currentVersion: 1, immutable: true }),
  family({ id: 'jira-initiative-application', currentVersion: 1, immutable: true }),
  family({ id: 'jira-drift-observation', currentVersion: 1, immutable: true }),
  family({ id: 'ledger-deployment-report', currentVersion: 1, immutable: true }),
  family({ id: 'local-identity-reservation', currentVersion: 1, paths: [/^singularity\/identity-reservations\/[^/]+\.json$/], immutable: true }),
  family({ id: 'mcp-host-receipt', currentVersion: 1, paths: [/^\$git\/mcp\/(?:cache|receipts)\/[^/]+\.json$/] }),
  family({ id: 'model-invocation-audit', currentVersion: 1, paths: [/^\$git\/model-invocations\/[^/]+\.json$/] }),
  family({ id: 'planning-session', currentVersion: 1, paths: [/^\$git\/planning\/[^/]+\/manifest\.json$/] }),
  family({ id: 'specification-index', currentVersion: 1, paths: [/^singularity\/work-items\/[^/]+\/context\/spec-indexes\/[^/]+\.json$/], immutable: true }),
  family({ id: 'specification-claim-map', currentVersion: 1, paths: [/^singularity\/work-items\/[^/]+\/context\/claims\/[^/]+\.json$/], immutable: true }),
  family({ id: 'specification-acceptance', currentVersion: 1, paths: [/^singularity\/work-items\/[^/]+\/context\/acceptance\/[^/]+\.json$/], immutable: true }),
  family({ id: 'story-submission-packet', currentVersion: 1, paths: [/^singularity\/work-items\/[^/]+\/submissions\/[^/]+\/[^/]+\.json$/], immutable: true }),
  family({
    id: 'return-locator', currentVersion: 1,
    paths: [/^singularity\/work-items\/[^/]+\/context\/return-locator\.json$/], immutable: true
  }),
  family({ id: 'story-finalization-packet', currentVersion: 1, paths: [/^singularity\/work-items\/[^/]+\/finalizations\/[^/]+\.json$/], immutable: true }),
  family({ id: 'subject-lock-owner', currentVersion: 1, paths: [/^\$git\/locks\/[^/]+\/owner\.json$/] }),
  family({ id: 'visual-comparison', currentVersion: 1, unversionedAs: 1, paths: [/^singularity\/work-items\/[^/]+\/artifacts\/visual-verification\/evidence\/.+\.json$/], immutable: true }),
  family({ id: 'workspace-bootstrap-owner', currentVersion: 1 }),
  family({ id: 'worldmodel-worktree-owner', currentVersion: 1 }),
  family({ id: 'worldmodel-prompt-composition', currentVersion: 1 }),
  family({ id: 'worldmodel-light-model', currentVersion: 1 }),
  family({ id: 'worldmodel-light-index', currentVersion: 1 }),
  family({ id: 'worldmodel-path-index', currentVersion: 1 }),
  family({ id: 'mcp-authorization', currentVersion: 1 }),
  family({ id: 'work-item-telemetry', currentVersion: 1 }),
  family({ id: 'artifact-authorship', currentVersion: 1 }),
  family({
    id: 'prompt-injection', currentVersion: 3,
    steps: [migration(1, 2, promptInjectionV1ToV2), migration(2, 3, promptInjectionV2ToV3)],
    paths: [/^singularity\/work-items\/[^/]+\/context\/(?!(?:agents-|remote-output-))[^/]+-gen\d+\.json$/]
  }),
  family({
    id: 'agent-context-audit', currentVersion: 2,
    steps: [migration(1, 2, agentContextAuditV1ToV2)],
    paths: [/^singularity\/work-items\/[^/]+\/context\/agents-[^/]+-gen\d+\.json$/], immutable: true
  }),
  family({
    id: 'remote-agent-output', currentVersion: 1,
    paths: [/^singularity\/work-items\/[^/]+\/context\/remote-output-[^/]+\.json$/]
  }),
  family({
    id: 'mcp-evidence', currentVersion: 3,
    steps: [migration(1, 2, mcpEvidenceV1ToV2), migration(2, 3, mcpEvidenceV2ToV3)],
    paths: [/^singularity\/work-items\/[^/]+\/context\/mcp\/(?:records\/)?[^/]+\.json$/]
  }),
  family({
    id: 'pending-publication', currentVersion: 2, minimumReadableVersion: 2,
    paths: [/^\$git\/pending-publication\/[^/]+\.json$/, /\/publication-pending\.json$/], unversionedAs: 2
  }),
  family({ id: 'publication-journal', currentVersion: 1, paths: [/^\$git\/publication-journal\/[^/]+\.json$/] }),
  family({ id: 'telemetry-cursor', currentVersion: 1, paths: [/^\$git\/telemetry-cursors\.json$/] }),
  family({ id: 'telemetry-preference', currentVersion: 1 }),
  family({ id: 'telemetry-launch', currentVersion: 1, paths: [/^\$git\/telemetry\/launches\/tel_[^/]+\.json$/] }),
  family({
    id: 'phase-telemetry', currentVersion: 1,
    paths: [/^singularity\/work-items\/[^/]+\/telemetry\/[^/]+-gen\d+\.json$/], immutable: true
  }),
  family({
    id: 'knowledge-record', currentVersion: 2,
    steps: [migration(1, 2, knowledgeRecordV1ToV2)],
    paths: [/^singularity\/knowledge\/records\/[a-f0-9]{64}\.json$/], immutable: true
  }),
  family({
    id: 'initiative-state', currentVersion: 1,
    paths: [/^singularity\/initiatives\/[^/]+\/state\.json$/], unversionedAs: 1
  }),
  family({ id: 'initiative-materialization-journal', currentVersion: 1, paths: [/^singularity\/initiatives\/[^/]+\/context\/materialization-journal\.json$/] }),
  family({ id: 'initiative-evidence-record', currentVersion: 1, paths: [/^singularity\/initiatives\/[^/]+\/evidence\/records\/[a-f0-9]{64}\.json$/], immutable: true }),
  family({ id: 'initiative-approval-record', currentVersion: 1, paths: [/^singularity\/initiatives\/[^/]+\/approvals\/records\/[a-f0-9]{64}\.json$/], immutable: true }),
  family({ id: 'initiative-invalidation-record', currentVersion: 1, paths: [/^singularity\/initiatives\/[^/]+\/invalidations\/records\/[a-f0-9]{64}\.json$/], immutable: true }),
  family({ id: 'initiative-approval-summary', currentVersion: 1, paths: [/^singularity\/initiatives\/[^/]+\/approvals\/SUMMARY\.json$/] }),
  family({ id: 'story-lineage', currentVersion: 1 }),
  family({ id: 'configuration-source', currentVersion: 1, paths: [/^singularity\/configuration-source\.json$/], immutable: true }),
  family({ id: 'impact-evidence', currentVersion: 1, paths: [/^singularity\/work-items\/[^/]+\/impact\/evidence\/[^/]+\.json$/], immutable: true }),
  family({ id: 'jira-write-receipt', currentVersion: 1, immutable: true }),
  family({ id: 'mcp-observation-receipt', currentVersion: 1, immutable: true }),
  family({
    id: 'phase-approval', currentVersion: 2,
    steps: [migration(1, 2, phaseApprovalV1ToV2)],
    paths: [/^singularity\/work-items\/[^/]+\/approvals\/[^/]+\.json$/], immutable: true
  }),
  family({
    id: 'document-manifest', currentVersion: 2,
    steps: [migration(1, 2, documentManifestV1ToV2)],
    paths: [/^singularity\/work-items\/[^/]+\/documents\.json$/]
  }),
  family({ id: 'goal-state', currentVersion: 1, paths: [/^\$workspace\/\.singularity-flow\/goals\.json$/] }),
  family({
    id: 'governed-goal-contract', currentVersion: 1,
    paths: [/^singularity\/goals\/GEX-[0-9A-HJKMNP-TV-Z]{26}\/contract\.json$/]
  }),
  family({
    id: 'governed-goal-state', currentVersion: 1,
    paths: [/^singularity\/goals\/GEX-[0-9A-HJKMNP-TV-Z]{26}\/state\.json$/]
  }),
  family({
    id: 'governed-goal-plan', currentVersion: 1, immutable: true,
    paths: [/^singularity\/goals\/GEX-[0-9A-HJKMNP-TV-Z]{26}\/plans\/generation-\d+\.json$/]
  }),
  family({
    id: 'governed-goal-record', currentVersion: 1, immutable: true,
    paths: [
      /^singularity\/goals\/GEX-[0-9A-HJKMNP-TV-Z]{26}\/(?:records|runs|evidence|approvals|invalidations|faults)\/.+\.json$/
    ]
  }),
  family({ id: 'transport-intent', currentVersion: 1, paths: [/^\$local\/transport-outbox\/intents\/[^/]+\.json$/] }),
  family({ id: 'workspace-bootstrap', currentVersion: 1, paths: [/^\$local\/workspace-bootstrap\/sessions\/[^/]+\.json$/] }),
  family({ id: 'workspace-bootstrap-index', currentVersion: 1, paths: [/^\$local\/workspace-bootstrap\/index\.json$/] }),
  family({ id: 'prompt-audit-settings', currentVersion: 1, paths: [/^(?:\$git|\$workspace)\/prompt-audit\/settings\.json$/] }),
  family({ id: 'prompt-audit-record', currentVersion: 1, paths: [/^(?:\$git|\$workspace)\/prompt-audit\/prompts\.jsonl$/], immutable: true }),
  family({
    id: 'dx-command-timing', currentVersion: 2,
    steps: [migration(1, 2, dxCommandTimingV1ToV2)],
    paths: [/^\$git\/(?:dx\/timings(?:-[^/]+)?|performance\/commands)\.jsonl$/]
  }),
  family({
    id: 'vscode-reset-marker', currentVersion: 2,
    steps: [migration(1, 2, vscodeResetMarkerV1ToV2)],
    paths: [/^\$local\/vscode-fresh-reset-pending\.json$/]
  }),
  family({ id: 'constitution-record', currentVersion: 1, immutable: true }),
  family({ id: 'convergence-record', currentVersion: 1, immutable: true }),
  family({ id: 'fault-envelope', currentVersion: 1, paths: [/^\$git\/fault-repair\/faults\/[^/]+\.json$/], immutable: true }),
  family({ id: 'fault-occurrence-group', currentVersion: 1, paths: [/^\$git\/fault-repair\/occurrences\/[^/]+\.json$/] }),
  family({ id: 'fault-diagnosis', currentVersion: 1, paths: [/^\$git\/fault-repair\/diagnoses\/[^/]+\/[^/]+\.json$/], immutable: true }),
  family({ id: 'repair-state', currentVersion: 1, paths: [/^\$git\/fault-repair\/repairs\/[^/]+\/state\.json$/] }),
  family({ id: 'repair-plan', currentVersion: 1, paths: [/^\$git\/fault-repair\/repairs\/[^/]+\/plan\.json$/], immutable: true }),
  family({ id: 'repair-receipt', currentVersion: 1, paths: [/^\$git\/fault-repair\/repairs\/[^/]+\/receipts\/[^/]+\.json$/], immutable: true }),
  family({ id: 'repair-event', currentVersion: 1, paths: [/^\$git\/fault-repair\/repairs\/[^/]+\/events\/[^/]+\.json$/], immutable: true }),
  family({ id: 'repair-attempt', currentVersion: 1, paths: [/^\$git\/fault-repair\/repairs\/[^/]+\/attempts\/[^/]+\.json$/], immutable: true }),
  family({
    id: 'local-work-journal', currentVersion: 1,
    paths: [/^\$local\/work-journal\/settings\.json$/, /^\$local\/work-journal\/events\/.+\.jsonl$/]
  }),
  family({ id: 'workspace-registry', currentVersion: 1, paths: [/^\$local\/workspaces\.json$/] }),
  family({ id: 'active-workspace', currentVersion: 1, paths: [/^\$local\/active-workspace\.json$/] }),
  family({ id: 'ast-preference', currentVersion: 1, paths: [/^\$local\/ast-preference\.json$/] }),
  family({
    id: 'change-flight-plan', currentVersion: 1,
    paths: [
      /^\$git\/change-flight-plans\/plans\/cfp-[a-f0-9]+\.json$/,
      /^singularity\/work-items\/[^/]+\/context\/change-flight-plan\/accepted-plan\.json$/
    ],
    immutable: true
  }),
  family({
    id: 'change-flight-plan-start', currentVersion: 1,
    paths: [/^\$git\/change-flight-plans\/starts\/cfp-[a-f0-9]+\.json$/]
  }),
  family({ id: 'change-flight-plan-context', currentVersion: 1 }),
  family({ id: 'change-flight-plan-verification', currentVersion: 1 }),
  family({ id: 'change-flight-plan-delta', currentVersion: 1 }),
  family({ id: 'change-flight-plan-receipt', currentVersion: 1 }),
  family({
    id: 'ast-resume-job', currentVersion: 2,
    steps: [migration(1, 2, astResumeJobV1ToV2)],
    paths: [/^\$git\/ast\/v[12]\/jobs\/[^/]+\.json$/]
  }),
  family({
    id: 'ast-result', currentVersion: 4,
    steps: [
      migration(1, 2, astResultV1ToV2), migration(2, 3, astResultV2ToV3),
      migration(3, 4, astResultV3ToV4)
    ],
    // v2 cone manifests are a distinct durable family. Keeping this path on legacy snapshots
    // prevents the first-match path registry from interpreting a v2 manifest as an AST result.
    paths: [/^\$git\/ast\/v1\/snapshots\/[^/]+\.json$/]
  }),
  family({ id: 'ast-cache-blob', currentVersion: 1, paths: [/^\$git\/ast\/v2\/blobs\/[a-f0-9]{64}\.json$/] }),
  family({ id: 'ast-syntax-skeleton', currentVersion: 1, paths: [/^\$git\/ast\/v2\/syntax\/[a-f0-9]{64}\.json$/] }),
  family({ id: 'ast-semantic-overlay', currentVersion: 1, paths: [/^\$git\/ast\/v2\/semantic\/[a-f0-9]{64}\.json$/] }),
  family({ id: 'ast-language-catalog', currentVersion: 1 }),
  family({ id: 'ast-project-binding', currentVersion: 1 }),
  family({ id: 'ast-derivation-key', currentVersion: 1 }),
  family({ id: 'ast-adapter-manifest', currentVersion: 1, paths: [/^\$local\/ast-packs\/installed\/[^/]+\/manifest\.json$/] }),
  family({ id: 'ast-pack-registry', currentVersion: 1, paths: [/^\$local\/ast-packs\/registry\.json$/] }),
  family({ id: 'ast-semantic-warm-plan', currentVersion: 1 }),
  family({ id: 'ast-semantic-binding', currentVersion: 1, paths: [/^\$git\/ast\/v2\/projects\/[a-f0-9]{64}\.json$/] }),
  family({ id: 'ast-cone-manifest', currentVersion: 1, paths: [/^\$git\/ast\/v2\/manifests\/[a-f0-9]{64}\.json$/] }),
  family({
    id: 'ast-derivation-manifest', currentVersion: 1,
    paths: [/^singularity\/work-items\/[^/]+\/context\/ast\/derivations\/[a-f0-9]{64}\.json$/],
    immutable: true
  }),
  family({
    id: 'ast-gate-receipt', currentVersion: 3,
    steps: [migration(1, 2, astGateReceiptV1ToV2), migration(2, 3, astGateReceiptV2ToV3)],
    paths: [/^singularity\/work-items\/[^/]+\/context\/ast\/[^/]+\.json$/], immutable: true
  }),
  family({ id: 'organisation-cache', currentVersion: 1, paths: [/^\$local\/organisation-cache\/[^/]+\.json$/] }),
  family({ id: 'capability-lead-registry', currentVersion: 1, paths: [/^\$local\/leads\.json$/] }),
  family({ id: 'reinstall-plan', currentVersion: 1, paths: [/^\$temp\/singularity-flow-reinstall-plans\/.+\/reinstall-plan\.json$/] }),
  family({ id: 'story-stack', currentVersion: 1, paths: [/^\$state\/orchestration\/stacks\/[^/]+\.json$/], immutable: true }),
  family({ id: 'workspace-impact-report', currentVersion: 1, paths: [/^\$workspace\/.+\/impact\/[^/]+\/report\.json$/] }),
  family({ id: 'worldmodel-checkpoint', currentVersion: 1, paths: [/^singularity\/world-model\/.+\/\.checkpoints\/.+\/state\.json$/] }),
  family({ id: 'worldmodel-recovery', currentVersion: 1, paths: [/^\$git\/world-model-recovery\/[^/]+\.json$/] }),
  family({
    id: 'ledger-intent', currentVersion: 1,
    paths: [/^singularity\/(?:work-items|initiatives)\/[^/]+\/context\/ledger-intents\/[^/]+\.json$/],
    unversionedAs: 1, immutable: true
  }),
  family({
    id: 'ledger-entry', currentVersion: 1,
    paths: [/^singularity\/ledger\/.+\.json$/, /^\$state\/ledger\/.+\.json$/],
    immutable: true, migrationPolicy: 'frozen-identity'
  }),
  family({ id: 'ledger-archive-manifest', currentVersion: 1, immutable: true })
];

for (const entry of families) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id)) throw new Error(`Invalid schema migration family '${entry.id}'.`);
  if (!Number.isInteger(entry.currentVersion) || entry.currentVersion < 1) throw new Error(`Invalid current version for '${entry.id}'.`);
  if (!Number.isInteger(entry.minimumReadableVersion) || entry.minimumReadableVersion < 1
      || entry.minimumReadableVersion > entry.currentVersion) throw new Error(`Invalid read range for '${entry.id}'.`);
  if (entry.unversionedAs != null
      && (!Number.isInteger(entry.unversionedAs)
        || entry.unversionedAs < entry.minimumReadableVersion
        || entry.unversionedAs > entry.currentVersion)) {
    throw new Error(`Invalid unversioned compatibility version for '${entry.id}'.`);
  }
  if (!['migrate-on-read', 'frozen-identity'].includes(entry.migrationPolicy)) {
    throw new Error(`Invalid migration policy for '${entry.id}'.`);
  }
  if (entry.migrationPolicy === 'frozen-identity'
      && (entry.currentVersion !== 1 || entry.minimumReadableVersion !== 1 || entry.steps.length)) {
    throw new Error(`Frozen-identity family '${entry.id}' cannot declare a schema migration.`);
  }
  const bySource = new Map(entry.steps.map((step) => [step.from, step]));
  for (let version = entry.minimumReadableVersion; version < entry.currentVersion; version += 1) {
    const step = bySource.get(version);
    if (!step || step.to !== version + 1 || typeof step.migrate !== 'function') {
      throw new Error(`Schema family '${entry.id}' has no contiguous v${version}→v${version + 1} migration.`);
    }
  }
}

export const schemaMigrationRegistry = Object.freeze(Object.fromEntries(families.map((entry) => [entry.id, entry])));
export const SCHEMA_MIGRATIONS = schemaMigrationRegistry;

export function schemaFamily(familyId) {
  const entry = schemaMigrationRegistry[familyId];
  if (!entry) {
    throw new SingularityFlowError(`Unknown durable record family '${familyId}'.`, {
      code: 'SCHEMA_FAMILY_UNKNOWN', details: { family: familyId }
    });
  }
  return entry;
}

export function currentSchemaVersion(familyId) {
  return schemaFamily(familyId).currentVersion;
}

export function stampCurrentRecord(familyId, value = {}) {
  if (!plainObject(value)) throw new SingularityFlowError(`Durable record '${familyId}' must be an object.`, { code: 'SCHEMA_RECORD_INVALID' });
  return { ...clone(value), schemaVersion: currentSchemaVersion(familyId) };
}

function parsedRecord(rawBytes) {
  if (plainObject(rawBytes)) return clone(rawBytes);
  let text;
  if (typeof rawBytes === 'string') text = rawBytes;
  else if (Buffer.isBuffer(rawBytes) || rawBytes instanceof Uint8Array) text = Buffer.from(rawBytes).toString('utf8');
  else throw new SingularityFlowError('Durable record bytes must be UTF-8 JSON.', { code: 'SCHEMA_RECORD_INVALID' });
  try {
    const parsed = JSON.parse(text);
    if (!plainObject(parsed)) throw new Error('top-level value is not an object');
    return parsed;
  } catch (error) {
    throw new SingularityFlowError(`Durable record is not valid JSON: ${error.message}`, {
      code: 'SCHEMA_RECORD_INVALID', cause: error
    });
  }
}

/**
 * Read stored bytes into the current in-memory shape. No write is performed or offered.
 */
export function readRecord(familyId, rawBytes) {
  const entry = schemaFamily(familyId);
  let record = parsedRecord(rawBytes);
  const storedVersion = Number.isInteger(record.schemaVersion) && record.schemaVersion > 0
    ? record.schemaVersion
    : entry.unversionedAs;
  if (storedVersion != null && record.schemaVersion == null) record = { ...record, schemaVersion: storedVersion };
  if (!Number.isInteger(storedVersion) || storedVersion < 1) {
    throw new SingularityFlowError(`Durable record '${familyId}' has no valid schemaVersion.`, {
      code: 'SCHEMA_VERSION_MISSING', details: { family: familyId, received: storedVersion ?? null }
    });
  }
  if (storedVersion > entry.maximumReadableVersion) {
    throw new SingularityFlowError(
      `Durable record '${familyId}' is stored at schema version ${storedVersion} (v${storedVersion}), above this build's readable range v${entry.minimumReadableVersion}–v${entry.maximumReadableVersion}; it was written by a newer sflow — upgrade to read it.`,
      { code: 'SCHEMA_VERSION_FUTURE', details: { family: familyId, storedVersion, readable: { minimum: entry.minimumReadableVersion, maximum: entry.maximumReadableVersion } } }
    );
  }
  if (storedVersion < entry.minimumReadableVersion) {
    throw new SingularityFlowError(
      `Durable record '${familyId}' is stored at schema version ${storedVersion} (v${storedVersion}), below this build's readable range v${entry.minimumReadableVersion}–v${entry.maximumReadableVersion}; use the archival reader for that release or a governed republication with recorded lineage.`,
      { code: 'SCHEMA_VERSION_ARCHIVED', details: { family: familyId, storedVersion, readable: { minimum: entry.minimumReadableVersion, maximum: entry.maximumReadableVersion } } }
    );
  }
  const migratedThrough = [];
  const steps = new Map(entry.steps.map((step) => [step.from, step]));
  for (let version = storedVersion; version < entry.currentVersion; version += 1) {
    const step = steps.get(version);
    if (!step) throw new Error(`Schema family '${familyId}' has no migration from v${version}.`);
    const before = clone(record);
    const first = step.migrate(freezeDeep(clone(before)));
    const second = step.migrate(freezeDeep(clone(before)));
    if (!plainObject(first) || !plainObject(second)) {
      throw new SingularityFlowError(`Schema migration '${familyId}' v${step.from}→v${step.to} did not return an object.`, { code: 'SCHEMA_MIGRATION_INVALID' });
    }
    if (stableJson(first) !== stableJson(second)) {
      throw new SingularityFlowError(`Schema migration '${familyId}' v${step.from}→v${step.to} is not deterministic.`, { code: 'SCHEMA_MIGRATION_NONDETERMINISTIC' });
    }
    if (first.schemaVersion !== step.to) {
      throw new SingularityFlowError(`Schema migration '${familyId}' v${step.from}→v${step.to} produced schemaVersion ${String(first.schemaVersion)}.`, { code: 'SCHEMA_MIGRATION_INVALID' });
    }
    record = clone(first);
    migratedThrough.push(Object.freeze({ from: step.from, to: step.to }));
  }
  return Object.freeze({ record, storedVersion, migratedThrough: Object.freeze(migratedThrough) });
}

export function familyForStoredPath(relativePath) {
  const normalized = String(relativePath ?? '').replaceAll('\\', '/');
  return families.find((entry) => entry.paths.some((pattern) => pattern.test(normalized))) ?? null;
}

export function migrationRegistrySnapshot() {
  return families.map(({ id, currentVersion, minimumReadableVersion, maximumReadableVersion, immutable, model, unversionedAs, migrationPolicy }) => ({
    id, currentVersion, minimumReadableVersion, maximumReadableVersion, immutable, model, unversionedAs, migrationPolicy
  }));
}
