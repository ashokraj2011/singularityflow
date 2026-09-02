/**
 * Pure, in-memory schema migration for durable records.
 *
 * Stored bytes are never rewritten here. Readers receive a current-shape clone together with the
 * version that was actually stored and the steps used to reach the current version. Migration
 * functions in this module deliberately have no access to I/O, clocks, Git, or model runners.
 */
import { recordSha256 } from './records.mjs';
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

function autoFlightCheckpointSha256V1(source) {
  return `sha256:${recordSha256({
    flightId: source.flightId,
    planSha256: source.planSha256,
    status: source.status,
    workId: source.story?.workId,
    phase: source.story?.phase,
    position: source.position,
    counters: source.counters,
    checkpointSequence: source.checkpointSequence,
    stopReason: source.stopReason,
    stopRequested: source.stopRequested ?? null
  })}`;
}

function autoFlightCheckpointSha256(source) {
  return `sha256:${recordSha256({
    flightId: source.flightId,
    planSha256: source.planSha256,
    status: source.status,
    workId: source.story?.workId,
    phase: source.story?.phase,
    position: source.position,
    counters: source.counters,
    checkpointSequence: source.checkpointSequence,
    stopReason: source.stopReason,
    stopRequested: source.stopRequested ?? null,
    candidate: source.candidate ?? null,
    worldModelReference: source.worldModelReference ?? null,
    comprehensionReference: source.comprehensionReference ?? null,
    phaseContracts: source.phaseContracts ?? {},
    boundaryCheckpoints: source.boundaryCheckpoints ?? [],
    boundaryCheckpoint: source.boundaryCheckpoint ?? null
  })}`;
}

function autoFlightRecordSha256(source) {
  const record = clone(source);
  delete record.recordSha256;
  return recordSha256(record);
}

function autoFlightStateV1ToV2(source) {
  // A migration must not turn altered legacy bytes into a newly valid v2 record. Verify both
  // independent v1 seals before changing the schema stamp, then reseal the current representation.
  if (source.checkpointSha256 !== autoFlightCheckpointSha256V1(source)
      || source.recordSha256 !== autoFlightRecordSha256(source)) {
    throw new SingularityFlowError(
      'Auto flight state v1 failed its integrity check and cannot be migrated.',
      { code: 'SCHEMA_MIGRATION_SOURCE_CORRUPT', details: { family: 'auto-flight-state', storedVersion: 1 } }
    );
  }
  const migrated = {
    ...clone(source),
    schemaVersion: 2,
    candidate: null,
    worldModelReference: null,
    comprehensionReference: null,
    phaseContracts: {},
    boundaryCheckpoints: [],
    boundaryCheckpoint: null,
    lastSuccessfulStoryRevision: source.story?.revision ?? null
  };
  migrated.checkpointSha256 = autoFlightCheckpointSha256(migrated);
  migrated.recordSha256 = autoFlightRecordSha256(migrated);
  return migrated;
}

const AUTO_P1_HASH = /^sha256:[a-f0-9]{64}$/;
const AUTO_P1_BUDGET_FIELDS = new Set([
  'modelInvocations', 'repairAttempts', 'maximumRepairAttempts', 'routeChanges', 'tokens',
  'toolOutputTokens', 'contextExpansions', 'fullContextFallbacks'
]);

function autoP1Counter(value, fallback = null) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function autoP1Hash(value) {
  return AUTO_P1_HASH.test(String(value ?? '')) ? value : null;
}

function autoP1Strings(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim()))];
}

function autoP1Reseal(source, changes, hashField) {
  const migrated = { ...clone(source), ...clone(changes), schemaVersion: 2 };
  delete migrated[hashField];
  migrated[hashField] = `sha256:${recordSha256(migrated)}`;
  return migrated;
}

function autoPhaseRunV1ToV2(source) {
  const publishedGenerations = (Array.isArray(source.publishedGenerations)
    ? source.publishedGenerations : []).map((entry) => ({
    generation: autoP1Counter(entry?.generation),
    candidateSha256: autoP1Hash(entry?.candidateSha256),
    publicationReceiptSha256: autoP1Hash(entry?.publicationReceiptSha256)
  }));
  return autoP1Reseal(source, { publishedGenerations }, 'recordSha256');
}

function autoAttemptResultV1ToV2(result) {
  if (result == null) return null;
  if (result.status === 'authored') return {
    status: 'authored', invocationId: typeof result.invocationId === 'string' && result.invocationId
      ? result.invocationId : null
  };
  if (result.status === 'refused') return {
    status: 'refused', refusalId: result.refusalId, refusalSha256: result.refusalSha256
  };
  if (result.status === 'published') return {
    status: 'published', generation: autoP1Counter(result.generation)
  };
  if (result.status === 'completed') return { status: 'completed' };
  if (result.status === 'failed') return {
    status: 'failed', code: String(result.code ?? 'LEGACY_ATTEMPT_FAILED'),
    message: String(result.message ?? 'Legacy attempt failed.')
  };
  throw new SingularityFlowError('Auto attempt v1 has an unrecognized result discriminator.', {
    code: 'SCHEMA_MIGRATION_SOURCE_CORRUPT', details: { family: 'auto-attempt', status: result.status ?? null }
  });
}

function autoAttemptV1ToV2(source) {
  const budgetImpact = Object.fromEntries(Object.entries(plainObject(source.budgetImpact)
    ? source.budgetImpact : {}).filter(([field, value]) => (
    AUTO_P1_BUDGET_FIELDS.has(field) && autoP1Counter(value) != null
  )));
  return autoP1Reseal(source, {
    budgetImpact, result: autoAttemptResultV1ToV2(source.result)
  }, 'recordSha256');
}

function autoRefusalV1ToV2(source) {
  const candidateSha256 = autoP1Hash(source.subject?.candidateSha256)
    ?? autoP1Hash(source.preserved?.candidateSha256);
  const verificationReceiptSha256 = autoP1Hash(source.subject?.verificationReceiptSha256)
    ?? autoP1Hash(source.preserved?.verificationReceiptSha256);
  const paths = autoP1Strings(source.preserved?.paths);
  const missing = (Array.isArray(source.missing) ? source.missing : []).map((entry) => {
    if (typeof entry === 'string' && entry.trim()) return { evidence: entry.trim() };
    const result = {};
    if (typeof entry?.requirement === 'string' && entry.requirement.trim()) result.requirement = entry.requirement.trim();
    if (typeof entry?.evidence === 'string' && entry.evidence.trim()) result.evidence = entry.evidence.trim();
    return result;
  }).filter((entry) => Object.keys(entry).length);
  const eligibility = ['auto-eligible', 'ask-only', 'manual-only', 'ineligible']
    .includes(source.repair?.eligibility) ? source.repair.eligibility : 'ineligible';
  return autoP1Reseal(source, {
    subject: { candidateSha256, verificationReceiptSha256 },
    missing: missing.length ? missing : [{ evidence: String(source.code ?? 'legacy refusal') }],
    preserved: {
      candidateSha256,
      verificationReceiptSha256,
      changedPaths: autoP1Counter(source.preserved?.changedPaths, paths.length),
      paths,
      workingArea: source.preserved?.workingArea !== false
    },
    repair: {
      eligibility, operation: 'auto.repair', scope: autoP1Strings(source.repair?.scope),
      maximumAttempts: ['manual-only', 'ineligible'].includes(eligibility)
        ? 0 : source.repair?.maximumAttempts === 0 ? 0 : 1
    },
    primaryNextAction: {
      operation: ['auto.repair', 'auto.takeover', 'auto.respond', 'auto.resume', 'auto.halt']
        .includes(source.primaryNextAction?.operation)
        ? source.primaryNextAction.operation : eligibility === 'ineligible' ? 'auto.takeover' : 'auto.repair',
      label: String(source.primaryNextAction?.label ?? 'Review the preserved refusal')
    }
  }, 'refusalSha256');
}

function autoRepairPlanV1ToV2(source) {
  return autoP1Reseal(source, {
    readScope: autoP1Strings(source.readScope), writeScope: autoP1Strings(source.writeScope),
    forbiddenChanges: autoP1Strings(source.forbiddenChanges),
    requiredEvidence: autoP1Strings(source.requiredEvidence),
    budget: {
      maximumAttempts: 1,
      remainingModelInvocations: autoP1Counter(source.budget?.remainingModelInvocations, 0)
    }
  }, 'repairPlanSha256');
}

function autoHumanRequestOptionV1ToV2(option) {
  if (typeof option === 'string') return option;
  const migrated = { id: String(option?.id ?? '') };
  for (const field of ['label', 'description']) {
    if (typeof option?.[field] === 'string' && option[field].trim()) migrated[field] = option[field].trim();
  }
  const consequences = autoP1Strings(option?.consequences);
  if (consequences.length) migrated.consequences = consequences;
  return migrated;
}

function autoHumanRequestV1ToV2(source) {
  const type = source.requestType;
  const detail = type === 'credential'
    ? { provider: String(source.detail?.provider ?? 'approved-broker') }
    : type === 'architecture-choice'
      ? { reason: String(source.detail?.reason ?? source.detail?.question ?? 'Architecture choice required.') }
      : {
          question: String(source.detail?.question ?? 'Clarification required.'),
          ...(source.detail?.whyStopped ? { whyStopped: String(source.detail.whyStopped) } : {})
        };
  return autoP1Reseal(source, {
    detail,
    options: (Array.isArray(source.options) ? source.options : []).map(autoHumanRequestOptionV1ToV2)
  }, 'requestSha256');
}

function autoEconomicsWorldModelV1ToV2(reference) {
  const required = [
    'protocol', 'path', 'workId', 'phase', 'generation', 'agent', 'worldModelCommit',
    'manifestSha256', 'renderedSha256', 'modelSourceTreeSha256',
    'composedSourceTreeSha256', 'fresh'
  ];
  if (!plainObject(reference) || required.some((field) => !Object.hasOwn(reference, field))) return null;
  return Object.fromEntries(required.map((field) => [field, clone(reference[field])]));
}

function autoEconomicsComprehensionV1ToV2(reference) {
  const required = ['protocol', 'packetSha256', 'subjectSha256', 'status'];
  if (!plainObject(reference) || required.some((field) => !Object.hasOwn(reference, field))) return null;
  return Object.fromEntries(required.map((field) => [field, clone(reference[field])]));
}

function autoTokenEconomicsV1ToV2(source) {
  const verification = ['pending', 'passed', 'failed'].includes(source.quality?.verification)
    ? source.quality.verification
    : ['pending', 'passed', 'failed'].includes(source.quality?.status)
      ? source.quality.status : 'pending';
  const repairAttempts = Math.min(1, autoP1Counter(source.quality?.repairAttempts, 0));
  const firstPass = typeof source.quality?.firstPass === 'boolean'
    ? source.quality.firstPass : repairAttempts === 0;
  const classification = verification === 'passed'
    ? firstPass && repairAttempts === 0 ? 'verified-first-pass' : 'verified-after-one-repair'
    : verification === 'failed' ? 'verification-failed'
      : firstPass && repairAttempts === 0
        ? 'first-pass-pending-verification' : 'repair-pending-verification';
  const amount = Number.isFinite(source.cost?.amount) && source.cost.amount >= 0
    ? source.cost.amount : null;
  return autoP1Reseal(source, {
    input: {
      promptBytes: autoP1Counter(source.input?.promptBytes),
      estimatedTokens: autoP1Counter(source.input?.estimatedTokens,
        autoP1Counter(source.input?.tokens)),
      providerTokens: autoP1Counter(source.input?.providerTokens),
      cachedTokens: autoP1Counter(source.input?.cachedTokens)
    },
    output: {
      estimatedTokens: autoP1Counter(source.output?.estimatedTokens,
        autoP1Counter(source.output?.tokens)),
      providerTokens: autoP1Counter(source.output?.providerTokens)
    },
    cost: { amount, currency: 'USD', assurance: amount == null ? 'unavailable' : 'provider-reported' },
    quality: {
      verification, firstPass, repairAttempts,
      reviewReturned: source.quality?.reviewReturned === true,
      missingContextIncident: source.quality?.missingContextIncident === true
    },
    classification,
    worldModelReference: autoEconomicsWorldModelV1ToV2(source.worldModelReference),
    comprehensionReference: autoEconomicsComprehensionV1ToV2(source.comprehensionReference)
  }, 'receiptSha256');
}

function autoFlightReportV1ToV2(source) {
  const historical = clone(source);
  const storedSha256 = historical.reportSha256;
  delete historical.reportSha256;
  if (storedSha256 !== `sha256:${recordSha256(historical)}`) {
    throw new SingularityFlowError(
      'Auto flight report v1 failed its historical integrity check and cannot be migrated.', {
        code: 'SCHEMA_MIGRATION_SOURCE_CORRUPT',
        details: { family: 'auto-flight-report', storedVersion: 1 }
      }
    );
  }
  return autoP1Reseal(source, {
    lineage: {
      'auto-phase-run': [], 'auto-attempt': [], 'auto-refusal': [],
      'auto-repair-plan': [], 'auto-human-request': [],
      'auto-token-economics-receipt': [], 'auto-execution-unit-switch': []
    },
    approvalSource: 'flight-checkpoint'
  }, 'reportSha256');
}

function autoExecutionUnitSwitchV1ToV2(source) {
  return autoP1Reseal(source, {}, 'switchPlanSha256');
}

function specificationClaimMapV1ToV2(source) {
  if (source.kind !== 'planned' || !plainObject(source.claims)) {
    return { ...source, schemaVersion: 2 };
  }
  return {
    ...source,
    schemaVersion: 2,
    claims: Object.fromEntries(Object.entries(source.claims).map(([id, claim]) => {
      const tests = Array.isArray(claim?.tests) ? claim.tests : [];
      return [id, {
        ...clone(claim),
        testDisposition: tests.length ? 'applicable' : 'unspecified',
        testReason: null
      }];
    }))
  };
}

function activeWorkspaceV1ToV2(source) {
  const repositoryPath = source.repositoryPath ?? null;
  return {
    ...source,
    schemaVersion: 2,
    canonicalRepositoryPath: source.canonicalRepositoryPath ?? repositoryPath,
    checkoutPath: source.checkoutPath ?? repositoryPath,
    head: source.head ?? null,
    selectionSource: source.selectionSource ?? 'workspace',
    selectionStatus: source.selectionStatus ?? 'ready',
    selectionError: source.selectionError ?? null
  };
}

function promptAuditSettingsV1ToV2(source) {
  return {
    ...source,
    schemaVersion: 2,
    retentionDays: Number.isInteger(source.retentionDays) ? source.retentionDays : 30,
    lastPrunedAt: source.lastPrunedAt ?? null,
    headMac: source.headMac ?? null,
    tailMac: source.tailMac ?? null,
    logBytes: Number.isInteger(source.logBytes) ? source.logBytes : null,
    logMtimeMs: Number.isFinite(source.logMtimeMs) ? source.logMtimeMs : null,
    maximumBytes: Number.isInteger(source.maximumBytes) ? source.maximumBytes : 67108864
  };
}

function configurationSourceV1ToV2(source) {
  return {
    ...source,
    schemaVersion: 2,
    baseCommit: source.baseCommit ?? null,
    assets: source.assets ?? Object.fromEntries(Object.entries(source.files ?? {})
      .map(([relative, sha256]) => [relative, { sha256, object: null, mode: null }])),
    removed: source.removed ?? {},
    projectionSha256: source.projectionSha256 ?? null
  };
}

function promptAuditRecordV1ToV2(source) {
  return {
    ...source,
    schemaVersion: 2,
    integrity: source.integrity ?? null,
    handoffSha256: source.handoffSha256 ?? null,
    handoffBytes: Number.isInteger(source.handoffBytes) ? source.handoffBytes : null
  };
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

function pendingPublicationV2ToV3(source) {
  return { ...clone(source), schemaVersion: 3, candidate: source.candidate ?? null };
}

function publicationJournalV1ToV2(source) {
  return { ...clone(source), schemaVersion: 2, candidate: source.candidate ?? null };
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

function promptInjectionV3ToV4(source) {
  // Older receipts did not distinguish an intentionally advisory absence from an incomplete or
  // corrupted world-model receipt. A migration must not invent that authority decision. Keep the
  // historical verifier contract explicit so only newly authored v4 receipts can claim that
  // grounding was deliberately unavailable.
  return {
    ...source,
    schemaVersion: 4,
    groundingAvailability: {
      status: 'legacy-unverified',
      reasonCode: null
    }
  };
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

function dxCommandTimingV2ToV3(source) {
  return {
    ...source,
    schemaVersion: 3,
    counters: clone(source.counters ?? {})
  };
}

function dxCommandTimingV3ToV4(source) {
  return {
    ...source,
    schemaVersion: 4,
    // v1-v3 grouped several read and mutation subcommands under one top-level command. Retain the
    // uncertainty instead of guessing an operation from historical data.
    operationId: source.operationId ?? null
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

function contextPacketTelemetryV1ToV2(source) {
  return {
    ...source,
    schemaVersion: 2,
    flightPlanId: source.flightPlanId ?? null,
    generation: source.generation ?? null,
    sourceRevision: source.sourceRevision ?? null,
    estimationMethod: source.estimationMethod ?? 'utf8-bytes-divided-by-four',
    omissionClasses: clone(source.omissionClasses ?? {}),
    unavailableCodes: clone(source.unavailableCodes ?? []),
    // v1 counted expansion requests but did not measure their bytes. Unknown historical usage must
    // stay unknown; migrating it to zero would fabricate an exact observation.
    expandedBytes: source.expandedBytes ?? null,
    expandedEstimatedTokens: source.expandedEstimatedTokens ?? null,
    expansions: clone(source.expansions ?? []),
    contextManifestSha256: source.contextManifestSha256 ?? null
  };
}

function contextManifestV1ToV2(source) {
  const stablePrefix = clone(source.stablePrefix ?? []);
  const mutableTail = clone(source.mutableTail ?? []);
  const sessionStable = mutableTail.filter((entry) => entry.kind === 'flight-plan');
  const variable = mutableTail.filter((entry) => entry.kind !== 'flight-plan');
  return {
    ...source,
    schemaVersion: 2,
    stablePrefix,
    sessionStable,
    variable,
    mutableTail: [...sessionStable, ...variable],
    // Historical records did not carry enough information to reproduce the exact cache identity;
    // unknown remains unknown rather than fabricating a hash-shaped value.
    cacheKey: source.cacheKey ?? null,
    sessionCacheKey: source.sessionCacheKey ?? null,
    cacheManifestId: source.cacheManifestId ?? null
  };
}

function contextManifestV2ToV3(source) {
  return {
    ...source,
    schemaVersion: 3,
    // v2 had no knowledge-selection region. Preserve every historical entry and both cache keys;
    // an additive migration cannot infer a selection from the current knowledge store.
    knowledge: clone(source.knowledge ?? null)
  };
}

function evidencePacketV1ToV2(source) {
  return {
    ...source,
    schemaVersion: 2,
    compilerVersion: source.compilerVersion ?? 1,
    correlation: clone(source.correlation ?? {
      storyId: source.binding?.workId ?? null,
      workType: null,
      phase: source.binding?.phase ?? null,
      generation: source.binding?.generation ?? null,
      intervalId: null,
      goalId: null,
      flightPlanId: source.binding?.flightPlanId ?? null,
      operationId: null,
      packetId: source.packetId ?? null,
      launchId: null,
      sessionId: null
    }),
    tokenEconomy: clone(source.tokenEconomy ?? null),
    items: (source.items ?? []).map((item) => ({
      ...clone(item), mandatory: item.mandatory === true,
      cacheClass: item.cacheClass ?? 'variable',
      estimatedTokens: item.estimatedTokens ?? Math.ceil(Number(item.bytes ?? 0) / 4)
    }))
  };
}

function evidencePacketV2ToV3(source) {
  return {
    ...source,
    schemaVersion: 3,
    // The v2 integrity field remains the digest of the raw v2 bytes. Readers must verify that raw
    // stored projection before calling readRecord; migration never re-hashes or invents a slice.
    knowledge: clone(source.knowledge ?? null)
  };
}

function observationSummaryV1ToV2(source) {
  return {
    ...source,
    schemaVersion: 2,
    compiler: clone(source.compiler ?? { id: 'legacy-observation-compiler', version: null, profile: null }),
    correlation: clone(source.correlation ?? {
      workspaceId: null, storyId: null, workType: null, phase: null, generation: null,
      intervalId: null, goalId: null, flightPlanId: null, operationId: null,
      packetId: null, launchId: null, sessionId: null
    }),
    // v1 summaries did not prove whether their source bytes were redacted. Preserve that
    // uncertainty explicitly; migration must not manufacture a security claim.
    redaction: clone(source.redaction ?? {
      status: 'unavailable', applied: null, occurrences: null, facts: []
    })
  };
}

function modelInvocationAuditV1ToV2(source) {
  return {
    ...source,
    schemaVersion: 2,
    promptTransport: source.promptTransport ?? 'legacy-argv',
    promptEncoding: source.promptEncoding ?? 'utf-8'
  };
}

function modelInvocationAuditV2ToV3(source) {
  return {
    ...source,
    schemaVersion: 3,
    generationNonce: source.generationNonce ?? null,
    attestation: source.attestation ?? null
  };
}

function modelInvocationAuditV3ToV4(source) {
  return {
    ...source,
    schemaVersion: 4,
    // Historical attachment/argv receipts cannot prove an ACP negotiation. Preserve that absence
    // instead of manufacturing a protocol claim during migration.
    promptProtocolVersion: source.promptProtocolVersion ?? null
  };
}

function modelInvocationAuditV4ToV5(source) {
  return {
    ...source,
    schemaVersion: 5,
    // Historical receipts did not distinguish the requested selector from the model that actually
    // served the turn, and recorded only authorization rather than ACP tool outcomes.
    requestedModel: source.requestedModel ?? source.model ?? null,
    modelSelection: clone(source.modelSelection ?? null),
    toolObservation: clone(source.toolObservation ?? null)
  };
}

function observationSummaryV2ToV3(source) {
  const exitCode = source.source?.exitCode;
  const hasExitCode = Number.isInteger(exitCode);
  const status = hasExitCode ? (exitCode === 0 ? 'passed' : 'failed') : 'unknown';
  const legacyReportedStatus = source.status ?? null;
  return {
    ...source,
    schemaVersion: 3,
    status,
    compiler: {
      ...clone(source.compiler ?? {}),
      version: source.compiler?.version ?? null
    },
    summary: {
      ...clone(source.summary ?? {}),
      ...(Number.isInteger(source.summary?.errors) && !Number.isInteger(source.summary?.errorDiagnostics)
        ? { errorDiagnostics: source.summary.errors }
        : {})
    },
    outcome: {
      state: hasExitCode ? (exitCode === 0 ? 'succeeded' : 'failed') : 'unknown',
      authority: hasExitCode ? 'process-exit' : 'unavailable',
      exitCode: hasExitCode ? exitCode : null,
      signal: null,
      reason: hasExitCode ? (exitCode === 0 ? null : `exit-code:${exitCode}`) : 'execution-metadata-unavailable',
      contradiction: null,
      legacyReportedStatus,
      correction: legacyReportedStatus != null && legacyReportedStatus !== status
        ? 'v2-text-heuristic-discarded'
        : null
    }
  };
}

function contextPacketTelemetryV2ToV3(source) {
  return {
    ...source,
    schemaVersion: 3,
    correlation: clone(source.correlation ?? {
      workspaceId: null,
      storyId: source.workId ?? null,
      workType: null,
      phase: source.phase ?? null,
      generation: source.generation ?? null,
      intervalId: null,
      goalId: null,
      flightPlanId: source.flightPlanId ?? null,
      operationId: null,
      packetId: source.packetId ?? null,
      launchId: null,
      sessionId: null
    }),
    tokenEconomyMode: source.tokenEconomyMode ?? null,
    tokenEconomyProfile: source.tokenEconomyProfile ?? null,
    tokenEconomyConfigurationDigest: source.tokenEconomyConfigurationDigest ?? null,
    cacheManifestId: source.cacheManifestId ?? null,
    itemUsage: clone(source.itemUsage ?? []),
    outcome: clone(source.outcome ?? null)
  };
}

function contextPacketTelemetryV3ToV4(source) {
  return {
    ...source,
    schemaVersion: 4,
    knowledge: clone(source.knowledge ?? {
      schemaVersion: 1,
      resultType: 'bounded-knowledge-projection',
      recallEngine: null,
      status: 'unavailable',
      authority: 'unavailable',
      limits: null,
      selected: [],
      omitted: [],
      omissions: { total: 0, byReason: {}, detail: null, omittedSetSha256: null },
      guidance: null,
      manifestSha256: null
    })
  };
}

function codeDeliveryV1ToV2(source) {
  return {
    ...source,
    schemaVersion: 2,
    generationIntentId: source.generationIntentId ?? null,
    changeSet: clone(source.changeSet ?? {
      path: null,
      digest: null,
      sourcePaths: clone(source.sourcePaths ?? []),
      executableTestPaths: clone(source.testPaths ?? []),
      supportingTestPaths: []
    }),
    traceability: clone(source.traceability ?? source.acceptanceCriteria ?? {
      required: [], bound: [], missing: [], ambiguous: []
    }),
    testExecutions: clone(source.testExecutions ?? []),
    tree: clone(source.tree ?? {
      workingStateDigest: source.sourceTreeSha256 ?? null,
      generationCommit: null,
      generationTree: null
    }),
    status: source.status ?? (source.validation?.status === 'passed' ? 'ready' : 'pending-tests'),
    legacyV1: true
  };
}

function testExecutionV1ToV2(source) {
  return {
    ...source,
    schemaVersion: 2,
    // These fields did not exist in v1. A v1 record may contain unknown keys, but migration must
    // not reinterpret them as v2 authority merely because their names match the later contract.
    candidate: null,
    program: null,
    attempt: null,
    adapterIdentity: null,
    testcaseObservation: {
      status: 'unavailable',
      assurance: 'unavailable',
      profile: null,
      occurrences: [],
      rawReports: [],
      notice: 'legacy module receipt; testcase execution was not observed'
    }
  };
}

function storySubmissionPacketV1ToV2(source) {
  return {
    ...source,
    schemaVersion: 2,
    // v1 had no witnessed-review contract. Ignore same-named unknown input rather than allowing a
    // historical packet to acquire enrollment or reviewed mappings through migration.
    witnessReview: {
      enrollment: null,
      enrollmentClassification: 'legacy',
      enrollmentReason: 'story-submission-packet-v1',
      clauseMappings: [],
      testcaseObservations: []
    }
  };
}

function gvmProcessV2ToV3(source) {
  return {
    ...source,
    schemaVersion: 3,
    controlEventSha256: source.controlEventSha256 ?? null,
    recordIndexSha256: source.recordIndexSha256 ?? null
  };
}

function sgosRecordReservationPath(familyId) {
  const escaped = familyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^\\$git/sgos/processes/[^/]+/record-reservations/${escaped}--[a-f0-9]{64}\\.json$`
  );
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
  // SGOS trust/compiler/runtime contracts. Immutable families are content-addressed records; a
  // changed value is a new record rather than an in-place schema mutation.
  family({ id: 'intent-envelope', currentVersion: 1, immutable: true }),
  family({ id: 'intent-ir', currentVersion: 1, immutable: true }),
  family({ id: 'workflow-ir', currentVersion: 1, immutable: true }),
  family({ id: 'workflow-ratification', currentVersion: 1, immutable: true }),
  family({ id: 'policy-snapshot', currentVersion: 1, immutable: true }),
  // Approved policy inputs and the local, content-addressed amendment graph are deliberately
  // separate families.  The former are read only from the refreshed configuration authority;
  // the latter are receipts beneath the Git-common sidecar and never rewrite a live Process.
  family({
    id: 'sgos-policy-bundle', currentVersion: 1, immutable: true,
    paths: [/^singularity\/sgos\/policy\/(?:current|candidate)\.json$/]
  }),
  family({
    id: 'sgos-policy-approval', currentVersion: 1, immutable: true,
    paths: [/^singularity\/sgos\/policy\/approvals\/[a-f0-9]{64}\.json$/]
  }),
  family({
    id: 'sgos-policy-diff', currentVersion: 1, immutable: true,
    paths: [/^\$git\/sgos\/policy-runtime\/diffs\/[a-f0-9]{64}\.json$/]
  }),
  family({
    id: 'sgos-policy-impact', currentVersion: 1, immutable: true,
    paths: [/^\$git\/sgos\/policy-runtime\/impacts\/[a-f0-9]{64}\.json$/]
  }),
  family({
    id: 'sgos-policy-amendment-plan', currentVersion: 1, immutable: true,
    paths: [/^\$git\/sgos\/policy-runtime\/plans\/[a-f0-9]{64}\.json$/]
  }),
  family({
    id: 'sgos-policy-amendment-receipt', currentVersion: 1, immutable: true,
    paths: [/^\$git\/sgos\/policy-runtime\/amendments\/[a-f0-9]{64}\.json$/]
  }),
  family({
    id: 'sgos-policy-invalidation', currentVersion: 1, immutable: true,
    paths: [/^\$git\/sgos\/policy-runtime\/invalidations\/[^/]+\/[a-f0-9]{64}\.json$/]
  }),
  family({
    id: 'sgos-policy-runtime-state', currentVersion: 1,
    paths: [/^\$git\/sgos\/policy-runtime\/state\.json$/]
  }),
  // The runtime persists these records beneath the Git-common sidecar. Path classification is
  // exact so `doctor` includes SGOS in its migration census without treating staging files or
  // unrelated JSON as governed durable records.
  family({
    id: 'candidate-snapshot', currentVersion: 1, immutable: true,
    paths: [
      /^\$git\/sgos\/processes\/[^/]+\/candidate-snapshots\/[a-f0-9]{64}\.json$/,
      sgosRecordReservationPath('candidate-snapshot')
    ]
  }),
  family({
    id: 'resource-lease', currentVersion: 1, immutable: true,
    paths: [
      /^\$git\/sgos\/processes\/[^/]+\/resource-leases\/[a-f0-9]{64}\.json$/,
      sgosRecordReservationPath('resource-lease')
    ]
  }),
  family({
    id: 'join-receipt', currentVersion: 1, immutable: true,
    paths: [
      /^\$git\/sgos\/processes\/[^/]+\/join-receipts\/[a-f0-9]{64}\.json$/,
      sgosRecordReservationPath('join-receipt')
    ]
  }),
  family({
    id: 'fanout-expansion-receipt', currentVersion: 1, immutable: true,
    paths: [
      /^\$git\/sgos\/processes\/[^/]+\/fanout-expansions\/[a-f0-9]{64}\.json$/,
      sgosRecordReservationPath('fanout-expansion-receipt')
    ]
  }),
  family({
    id: 'sgos-replay-plan', currentVersion: 1, immutable: true,
    paths: [
      /^\$git\/sgos\/processes\/[^/]+\/replay-plans\/[a-f0-9]{64}\.json$/,
      sgosRecordReservationPath('sgos-replay-plan')
    ]
  }),
  family({
    // v1 did not bind the approved configuration authority. It is deliberately archived instead
    // of being synthesized during read: an immutable authority claim cannot be reconstructed.
    id: 'process-binding', currentVersion: 2, minimumReadableVersion: 2, immutable: true,
    paths: [
      /^\$git\/sgos\/processes\/[^/]+\/bindings\/[a-f0-9]{64}\.json$/,
      sgosRecordReservationPath('process-binding')
    ]
  }),
  family({
    id: 'gvm-program', currentVersion: 1, immutable: true,
    paths: [
      /^\$git\/sgos\/processes\/[^/]+\/programs\/[a-f0-9]{64}\.json$/,
      sgosRecordReservationPath('gvm-program')
    ]
  }),
  family({
    // v1 Process state did not carry the closed authority binding required by v2. Do not invent
    // that authority during read; preserve the old Process for archival. v3 adds a deterministic
    // null control head; the SGOS store establishes its first immutable control event while holding
    // the Process lock before republishing the migrated mutable state.
    id: 'gvm-process', currentVersion: 3, minimumReadableVersion: 2,
    steps: [migration(2, 3, gvmProcessV2ToV3)],
    paths: [/^\$git\/sgos\/processes\/[^/]+\/state\.json$/]
  }),
  family({
    id: 'sgos-record-index', currentVersion: 1, immutable: true,
    paths: [/^\$git\/sgos\/processes\/[^/]+\/record-indexes\/[a-f0-9]{64}\.json$/]
  }),
  family({
    id: 'sgos-control-event', currentVersion: 1, immutable: true,
    paths: [/^\$git\/sgos\/processes\/[^/]+\/control-events\/[a-f0-9]{64}\.json$/]
  }),
  family({
    id: 'sgos-control-successor', currentVersion: 1, immutable: true,
    paths: [/^\$git\/sgos\/processes\/[^/]+\/control-next\/[a-f0-9]{64}\.json$/]
  }),
  family({
    id: 'sgos-transition-intent', currentVersion: 1,
    paths: [/^\$git\/sgos\/processes\/[^/]+\/transition-intent\.json$/]
  }),
  family({
    id: 'gvm-task-attempt', currentVersion: 1, immutable: true,
    paths: [
      /^\$git\/sgos\/processes\/[^/]+\/attempts\/[a-f0-9]{64}\.json$/,
      sgosRecordReservationPath('gvm-task-attempt')
    ]
  }),
  family({
    // v1 receipts named only attemptId and cannot be upgraded safely without scanning mutable
    // Process context. Archive them fail-closed; v2 binds the exact terminal attempt hash.
    id: 'gvm-task-receipt', currentVersion: 2, minimumReadableVersion: 2, immutable: true,
    paths: [
      /^\$git\/sgos\/processes\/[^/]+\/receipts\/[a-f0-9]{64}\.json$/,
      sgosRecordReservationPath('gvm-task-receipt')
    ]
  }),
  family({
    id: 'gvm-checkpoint', currentVersion: 1, immutable: true,
    paths: [
      /^\$git\/sgos\/processes\/[^/]+\/checkpoints\/[a-f0-9]{64}\.json$/,
      sgosRecordReservationPath('gvm-checkpoint')
    ]
  }),
  family({
    // v1 Human Requests did not carry the exact configuration authority used for authorization.
    id: 'human-request', currentVersion: 2, minimumReadableVersion: 2, immutable: true,
    paths: [
      /^\$git\/sgos\/processes\/[^/]+\/human-requests\/[a-f0-9]{64}\.json$/,
      sgosRecordReservationPath('human-request')
    ]
  }),
  family({
    id: 'human-response', currentVersion: 1, immutable: true,
    paths: [
      /^\$git\/sgos\/processes\/[^/]+\/human-responses\/[a-f0-9]{64}\.json$/,
      sgosRecordReservationPath('human-response')
    ]
  }),
  family({
    id: 'agent-proposal', currentVersion: 1, immutable: true,
    paths: [
      /^\$git\/sgos\/processes\/[^/]+\/agent-proposals\/[a-f0-9]{64}\.json$/,
      sgosRecordReservationPath('agent-proposal')
    ]
  }),
  family({
    id: 'action-evidence', currentVersion: 1, immutable: true,
    paths: [
      /^\$git\/sgos\/processes\/[^/]+\/evidence\/[a-f0-9]{64}\.json$/,
      sgosRecordReservationPath('action-evidence')
    ]
  }),
  // Portable, content-addressed Process evidence. The bundle is intentionally path-neutral: it
  // can be copied to a fresh directory and verified without recreating the operational sidecar.
  family({ id: 'sgos-process-evidence-bundle', currentVersion: 1, immutable: true }),
  // Agentic evaluation records are portable immutable evidence. They are deliberately not assigned
  // repository paths: this release provides a pure compiler/validator and a content-free telemetry
  // projection, not an operational evaluation store.
  family({ id: 'sgos-evaluation-study', currentVersion: 1, immutable: true }),
  family({ id: 'sgos-evaluation-arm', currentVersion: 1, immutable: true }),
  family({ id: 'sgos-evaluation-result', currentVersion: 1, immutable: true }),
  family({
    // v2 optionally binds an active lease to the exact running-attempt hash. Pre-CAS recovery
    // fixtures may omit it, but an active Process is required to carry it by runtime validation.
    id: 'sgos-execution-lease', currentVersion: 2, minimumReadableVersion: 2,
    paths: [/^\$git\/sgos\/processes\/[^/]+\/execution-leases\/[^/]+\.json$/]
  }),
  family({ id: 'work-object', currentVersion: 1, immutable: true }),
  family({ id: 'adhoc-active-session', currentVersion: 1, paths: [/^\$git\/adhoc\/active\.json$/] }),
  family({
    id: 'adhoc-session', currentVersion: 1,
    paths: [/^\$git\/adhoc\/AHS-[^/]+\/session\.json$/]
  }),
  family({
    id: 'adhoc-baseline', currentVersion: 1,
    paths: [/^\$git\/adhoc\/AHS-[^/]+\/baseline\.json$/]
  }),
  family({
    id: 'adhoc-change-set', currentVersion: 1,
    paths: [
      /^\$git\/adhoc\/AHS-[^/]+\/landing-preview\.json$/,
      /^singularity\/adhoc-work\/[^/]+\/effect-set\.json$/
    ]
  }),
  family({
    id: 'adhoc-intent-candidate', currentVersion: 1,
    paths: [/^\$git\/adhoc\/AHS-[^/]+\/intent-candidate\.json$/]
  }),
  family({ id: 'adhoc-intent-confirmation', currentVersion: 1 }),
  family({
    id: 'adhoc-confirmed-intent', currentVersion: 1,
    paths: [
      /^\$git\/adhoc\/AHS-[^/]+\/confirmed-intent\.json$/,
      /^singularity\/adhoc-work\/[^/]+\/confirmed-intent\.json$/
    ]
  }),
  family({
    id: 'adhoc-change-disposition-map', currentVersion: 1,
    paths: [
      /^\$git\/adhoc\/AHS-[^/]+\/disposition-map\.json$/,
      /^singularity\/adhoc-work\/[^/]+\/disposition-map\.json$/
    ]
  }),
  family({
    id: 'adhoc-verification-plan', currentVersion: 1,
    paths: [
      /^\$git\/adhoc\/AHS-[^/]+\/verification-plan\.json$/,
      /^singularity\/adhoc-work\/[^/]+\/verification-plan\.json$/
    ]
  }),
  family({
    id: 'adhoc-verification-result', currentVersion: 1,
    paths: [
      /^\$git\/adhoc\/AHS-[^/]+\/verification-result\.json$/,
      /^singularity\/adhoc-work\/[^/]+\/verification-result\.json$/
    ]
  }),
  family({
    id: 'adhoc-landing-eligibility', currentVersion: 1,
    paths: [/^\$git\/adhoc\/AHS-[^/]+\/eligibility\.json$/]
  }),
  family({
    id: 'adhoc-landing-packet', currentVersion: 1,
    paths: [/^\$git\/adhoc\/AHS-[^/]+\/landing-packet\.json$/]
  }),
  family({
    id: 'adhoc-landing-decision', currentVersion: 1,
    paths: [/^singularity\/adhoc-work\/[^/]+\/decision\.json$/]
  }),
  family({
    id: 'reverse-converged-work', currentVersion: 1,
    paths: [/^singularity\/adhoc-work\/[^/]+\/work\.json$/]
  }),
  family({
    id: 'adhoc-landing-receipt', currentVersion: 1,
    paths: [
      /^\$git\/adhoc\/AHS-[^/]+\/landing-receipt\.json$/,
      /^singularity\/adhoc-work\/[^/]+\/landing-receipt\.json$/
    ]
  }),
  family({
    id: 'adhoc-promotion-checkpoint', currentVersion: 1,
    paths: [/^\$git\/adhoc\/AHS-[^/]+\/promotion-checkpoint\.json$/]
  }),
  family({ id: 'harness-event', currentVersion: 1, paths: [/^\$git\/harness-events\/[0-9a-f-]{36}\.json$/], immutable: true }),
  family({
    id: 'story-workflow', currentVersion: 3,
    steps: [migration(1, 2, storyWorkflowV1ToV2), migration(2, 3, identity(3))],
    paths: [/^(?:singularity|\.sdlc)\/work-items\/[^/]+\/workflow\.json$/], unversionedAs: 1
  }),
  family({
    id: 'action-plan', currentVersion: 2,
    steps: [migration(1, 2, actionPlanV1ToV2)],
    paths: [/^\$git\/action-plans\/[^/]+\.json$/]
  }),
  family({ id: 'action-authorization', currentVersion: 1, paths: [/^\$git\/action-authorizations\/[^/]+\.json$/] }),
  family({ id: 'action-result', currentVersion: 1, paths: [/^\$git\/action-results\/[^/]+\.json$/] }),
  // Recovery plans are transport-only, recomputed from current repository bytes, and never stored.
  // Registering the shape still gives every producer one current version without pretending it is
  // a durable record family with an on-disk path.
  family({ id: 'recovery-plan', currentVersion: 1 }),
  // Embedded in an open Story change request. It has no independent path, but every producer and
  // integrity verifier must still agree on its durable schema version.
  family({
    id: 'rework-forward-checkpoint', currentVersion: 2,
    steps: [migration(1, 2, identity(2))]
  }),
  // A read-only, recomputed transport shape shown before destructive confirmation.
  family({
    id: 'rework-roll-forward-plan', currentVersion: 2,
    steps: [migration(1, 2, identity(2))]
  }),
  family({
    id: 'rework-local-backup', currentVersion: 1,
    paths: [/^\$git\/rework-backups\/[^/]+\/[^/]+\/manifest\.json$/]
  }),
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
    id: 'generation-publication', currentVersion: 1,
    paths: [/^singularity\/work-items\/[^/]+\/context\/generation-publications\/[^/]+-gen\d+\.json$/],
    immutable: true
  }),
  family({
    id: 'generation-start', currentVersion: 1,
    paths: [/^singularity\/work-items\/[^/]+\/context\/generation-start\/[^/]+-gen\d+\.json$/]
  }),
  family({
    id: 'repository-change-set', currentVersion: 1,
    paths: [/^singularity\/work-items\/[^/]+\/context\/code-delivery\/[^/]+-gen\d+-changes\.json$/], immutable: true
  }),
  family({
    id: 'test-execution', currentVersion: 2,
    steps: [migration(1, 2, testExecutionV1ToV2)],
    paths: [/^singularity\/work-items\/[^/]+\/context\/code-delivery\/tests\/[^/]+\.json$/], immutable: true
  }),
  family({
    id: 'code-delivery', currentVersion: 2, minimumReadableVersion: 1,
    steps: [migration(1, 2, codeDeliveryV1ToV2)],
    paths: [/^singularity\/work-items\/[^/]+\/context\/code-delivery\/[^/]+-gen\d+\.json$/]
  }),
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
  family({
    id: 'model-invocation-audit', currentVersion: 5,
    steps: [
      migration(1, 2, modelInvocationAuditV1ToV2),
      migration(2, 3, modelInvocationAuditV2ToV3),
      migration(3, 4, modelInvocationAuditV3ToV4),
      migration(4, 5, modelInvocationAuditV4ToV5)
    ],
    paths: [/^\$git\/model-invocations\/[^/]+\.json$/]
  }),
  family({ id: 'planning-session', currentVersion: 1, paths: [/^\$git\/planning\/[^/]+\/manifest\.json$/] }),
  family({ id: 'specification-index', currentVersion: 1, paths: [/^singularity\/work-items\/[^/]+\/context\/spec-indexes\/[^/]+\.json$/], immutable: true }),
  family({
    id: 'specification-claim-map', currentVersion: 2,
    steps: [migration(1, 2, specificationClaimMapV1ToV2)],
    paths: [/^singularity\/work-items\/[^/]+\/context\/claims\/[^/]+\.json$/], immutable: true
  }),
  family({ id: 'specification-acceptance', currentVersion: 1, paths: [/^singularity\/work-items\/[^/]+\/context\/acceptance\/[^/]+\.json$/], immutable: true }),
  family({
    id: 'story-submission-packet', currentVersion: 2,
    steps: [migration(1, 2, storySubmissionPacketV1ToV2)],
    paths: [/^singularity\/work-items\/[^/]+\/submissions\/[^/]+\/[^/]+\.json$/], immutable: true
  }),
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
  // WMB v4 records are intentionally separate from the legacy worldmodel-* document families.
  // A v3 model-authored view is not a registered v4 fact projection and cannot enter these
  // readers through an implicit compatibility stamp.
  family({ id: 'world-model-build-request', currentVersion: 1, immutable: true }),
  family({ id: 'world-model-build-plan', currentVersion: 1, immutable: true }),
  family({ id: 'world-model-source-snapshot', currentVersion: 1, immutable: true, paths: [/^singularity\/world-model\/source\/source-snapshot\.json$/] }),
  family({ id: 'world-model-scope-manifest', currentVersion: 1, immutable: true, paths: [/^singularity\/world-model\/scope\/scope-manifest\.json$/] }),
  family({ id: 'world-model-runtime-observation-import', currentVersion: 1, immutable: true }),
  family({ id: 'world-model-runtime-observation', currentVersion: 1, immutable: true }),
  family({ id: 'world-model-human-confirmed-knowledge-import', currentVersion: 1, immutable: true }),
  family({ id: 'world-model-human-confirmed-knowledge', currentVersion: 1, immutable: true }),
  family({ id: 'world-model-view-contract', currentVersion: 1, immutable: true }),
  family({ id: 'world-model-extractor-manifest', currentVersion: 1, immutable: true }),
  family({ id: 'world-model-evidence-catalog', currentVersion: 1, immutable: true, paths: [/^singularity\/world-model\/catalogs\/evidence\.json$/] }),
  family({ id: 'world-model-derivation', currentVersion: 1, immutable: true }),
  family({ id: 'world-model-derivation-catalog', currentVersion: 1, immutable: true, paths: [/^singularity\/world-model\/catalogs\/derivations\.json$/] }),
  family({ id: 'world-model-fact-ledger', currentVersion: 1, immutable: true, paths: [/^singularity\/world-model\/catalogs\/facts\.json$/] }),
  family({ id: 'world-model-view-fact-ledger', currentVersion: 1, immutable: true, paths: [/^singularity\/world-model\/catalogs\/views\/.+\.facts\.json$/] }),
  family({ id: 'world-model-consumer-profile', currentVersion: 1, immutable: true }),
  family({ id: 'world-model-output-budget', currentVersion: 1, immutable: true }),
  family({ id: 'world-model-context-manifest', currentVersion: 1, immutable: true, paths: [/^singularity\/world-model\/contexts\/.+\.json$/] }),
  family({ id: 'world-model-composition-candidate', currentVersion: 1, immutable: true }),
  family({ id: 'world-model-view-validation-receipt', currentVersion: 1, immutable: true, paths: [/^singularity\/world-model\/receipts\/validation\/.+\.json$/] }),
  family({ id: 'world-model-view-execution', currentVersion: 1, immutable: true, paths: [/^singularity\/world-model\/receipts\/execution\/.+\.json$/] }),
  family({ id: 'world-model-view-cache-record', currentVersion: 1, paths: [/^\$git\/world-model-cache\/v4\/.+\/record\.json$/] }),
  family({ id: 'world-model-shared-cache-bundle', currentVersion: 1, immutable: true }),
  family({ id: 'world-model-query-index', currentVersion: 1, immutable: true }),
  family({
    id: 'world-model-publication-recovery', currentVersion: 1, immutable: true,
    paths: [/^\$git\/world-model-v4-recovery\/wmb4-[a-f0-9]{32}\.json$/]
  }),
  family({ id: 'world-model-staleness-receipt', currentVersion: 1, immutable: true }),
  family({ id: 'world-model-manifest', currentVersion: 1, immutable: true, paths: [/^singularity\/world-model\/manifest\.json$/] }),
  family({ id: 'world-model-usage-observation', currentVersion: 1, immutable: true, paths: [/^singularity\/world-model\/usage\/.+\.json$/] }),
  family({ id: 'world-model-refusal', currentVersion: 1, immutable: true, paths: [/^singularity\/world-model\/refusals\/.+\.json$/] }),
  family({ id: 'world-model-view-retry-receipt', currentVersion: 1, immutable: true, paths: [/^\$git\/world-model-cache\/v4\/objects\/(?:retry-receipts|retry-edges)\/.+\.json$/] }),
  family({ id: 'world-model-migration-receipt', currentVersion: 1, immutable: true, paths: [/^singularity\/world-model\/migrations\/.+\.json$/] }),
  family({ id: 'mcp-authorization', currentVersion: 1 }),
  family({ id: 'work-item-telemetry', currentVersion: 1 }),
  family({ id: 'artifact-authorship', currentVersion: 1 }),
  family({
    id: 'prompt-injection', currentVersion: 4,
    steps: [
      migration(1, 2, promptInjectionV1ToV2),
      migration(2, 3, promptInjectionV2ToV3),
      migration(3, 4, promptInjectionV3ToV4)
    ],
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
    id: 'pending-publication', currentVersion: 3, minimumReadableVersion: 2,
    steps: [migration(2, 3, pendingPublicationV2ToV3)],
    paths: [/^\$git\/pending-publication\/[^/]+\.json$/, /\/publication-pending\.json$/], unversionedAs: 2
  }),
  family({
    id: 'publication-journal', currentVersion: 2,
    steps: [migration(1, 2, publicationJournalV1ToV2)],
    paths: [/^\$git\/publication-journal\/[^/]+\.json$/]
  }),
  family({ id: 'story-start-journal', currentVersion: 1, paths: [/^\$git\/story-start\/[^/]+\.json$/] }),
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
  family({
    id: 'configuration-source', currentVersion: 2,
    steps: [migration(1, 2, configurationSourceV1ToV2)],
    paths: [/^singularity\/configuration-source\.json$/], immutable: true
  }),
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
  family({
    id: 'prompt-audit-settings', currentVersion: 2,
    steps: [migration(1, 2, promptAuditSettingsV1ToV2)],
    paths: [/^(?:\$git|\$workspace)\/prompt-audit\/settings\.json$/]
  }),
  family({
    id: 'prompt-audit-record', currentVersion: 2,
    steps: [migration(1, 2, promptAuditRecordV1ToV2)],
    paths: [/^(?:\$git|\$workspace)\/prompt-audit\/prompts\.jsonl$/], immutable: true
  }),
  family({
    id: 'dx-command-timing', currentVersion: 4,
    steps: [
      migration(1, 2, dxCommandTimingV1ToV2),
      migration(2, 3, dxCommandTimingV2ToV3),
      migration(3, 4, dxCommandTimingV3ToV4)
    ],
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
  family({
    id: 'help-metrics-settings', currentVersion: 1,
    paths: [/^(?:\$git|\$workspace)\/help-metrics\/settings\.json$/]
  }),
  family({
    id: 'help-metrics-event', currentVersion: 1,
    paths: [/^(?:\$git|\$workspace)\/help-metrics\/events\.jsonl$/], immutable: true
  }),
  family({
    id: 'active-workspace', currentVersion: 2,
    steps: [migration(1, 2, activeWorkspaceV1ToV2)],
    paths: [/^\$local\/active-workspace\.json$/]
  }),
  family({ id: 'ast-preference', currentVersion: 1, paths: [/^\$local\/ast-preference\.json$/] }),
  family({
    // v1 authorized execution from the Plan digest instead of the independently rendered packet.
    // That missing human-decision evidence cannot be invented by a migration, so v1 is archival.
    id: 'auto-plan', currentVersion: 2, minimumReadableVersion: 2,
    paths: [
      /^\$git\/auto-plans\/APL-[A-F0-9]{26}\.json$/,
      /^singularity\/work-items\/[^/]+\/context\/auto\/accepted-plan\.json$/
    ],
    immutable: true
  }),
  family({ id: 'auto-plan-validation', currentVersion: 1, immutable: true }),
  family({ id: 'auto-plan-packet', currentVersion: 1, immutable: true }),
  family({
    // v1 ratifications record Plan-digest confirmation and cannot prove packet-v1 review.
    id: 'auto-plan-ratification', currentVersion: 2, minimumReadableVersion: 2,
    paths: [/^singularity\/work-items\/[^/]+\/context\/auto\/ratification\.json$/],
    immutable: true
  }),
  family({
    // v1 authorizations have no packet/validation digest set. They remain archival alongside v1 Plans.
    id: 'auto-authorization', currentVersion: 2, minimumReadableVersion: 2,
    paths: [/^\$git\/auto-authorizations\/APL-[A-F0-9]{26}\.json$/]
  }),
  family({
    // v2 adds takeover/recovery statuses. Every v1 status keeps the same meaning on read.
    id: 'auto-flight-state', currentVersion: 2,
    steps: [migration(1, 2, autoFlightStateV1ToV2)],
    paths: [/^\$git\/auto-flights\/AFL-[A-F0-9]{26}\/state\.json$/]
  }),
  family({ id: 'auto-origin', currentVersion: 1 }),
  family({ id: 'auto-step-result', currentVersion: 1, immutable: true }),
  family({
    id: 'auto-phase-run', currentVersion: 2,
    steps: [migration(1, 2, autoPhaseRunV1ToV2)],
    paths: [/^\$git\/auto-flights\/AFL-[A-F0-9]{26}\/phase-runs\/APR-[A-F0-9]{26}\.json$/]
  }),
  family({
    id: 'auto-attempt', currentVersion: 2,
    steps: [migration(1, 2, autoAttemptV1ToV2)],
    paths: [/^\$git\/auto-flights\/AFL-[A-F0-9]{26}\/attempts\/AAT-[A-F0-9]{26}\.json$/]
  }),
  family({
    id: 'auto-refusal', currentVersion: 2,
    steps: [migration(1, 2, autoRefusalV1ToV2)],
    paths: [/^\$git\/auto-flights\/AFL-[A-F0-9]{26}\/refusals\/ARF-[A-F0-9]{26}\.json$/],
    immutable: true
  }),
  family({
    id: 'auto-repair-plan', currentVersion: 2,
    steps: [migration(1, 2, autoRepairPlanV1ToV2)],
    paths: [/^\$git\/auto-flights\/AFL-[A-F0-9]{26}\/repair-plans\/ARP-[A-F0-9]{26}\.json$/],
    immutable: true
  }),
  family({
    id: 'auto-human-request', currentVersion: 2,
    steps: [migration(1, 2, autoHumanRequestV1ToV2)],
    paths: [/^\$git\/auto-flights\/AFL-[A-F0-9]{26}\/human-requests\/AHR-[A-F0-9]{26}\.json$/]
  }),
  family({
    id: 'auto-token-economics-receipt', currentVersion: 2,
    steps: [migration(1, 2, autoTokenEconomicsV1ToV2)],
    paths: [/^\$git\/auto-flights\/AFL-[A-F0-9]{26}\/economics\/AAT-[A-F0-9]{26}\.json$/]
  }),
  family({
    id: 'auto-execution-unit-switch', currentVersion: 2,
    steps: [migration(1, 2, autoExecutionUnitSwitchV1ToV2)],
    paths: [/^\$git\/auto-flights\/AFL-[A-F0-9]{26}\/execution-unit-switches\/AUS-[A-F0-9]{26}\.json$/]
  }),
  family({
    id: 'auto-candidate-binding', currentVersion: 1,
    paths: [
      /^\$git\/auto-flights\/AFL-[A-F0-9]{26}\/candidates\/CAN-[A-F0-9]{26}\.json$/
    ],
    immutable: true
  }),
  family({
    id: 'auto-candidate-verification', currentVersion: 1,
    paths: [
      /^\$git\/auto-flights\/AFL-[A-F0-9]{26}\/candidates\/CAN-[A-F0-9]{26}\.verification\.json$/
    ],
    immutable: true
  }),
  family({
    id: 'auto-boundary-checkpoint', currentVersion: 1,
    paths: [
      /^singularity\/work-items\/[^/]+\/context\/auto\/checkpoints\/[0-9]{6}-(?:phase-boundary|human-boundary|publication-boundary|recovery|completion)-[a-f0-9]{12}\.json$/
    ],
    immutable: true
  }),
  family({
    id: 'auto-flight-report', currentVersion: 2,
    steps: [migration(1, 2, autoFlightReportV1ToV2)],
    paths: [/^\$git\/auto-flights\/AFL-[A-F0-9]{26}\/report\.json$/],
    immutable: true
  }),
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
    id: 'evidence-packet', currentVersion: 3,
    steps: [migration(1, 2, evidencePacketV1ToV2), migration(2, 3, evidencePacketV2ToV3)],
    paths: [/^singularity\/work-items\/[^/]+\/context\/evidence-packets\/ctx-[a-f0-9]{20}\.json$/],
    immutable: true
  }),
  family({
    id: 'context-manifest', currentVersion: 3,
    steps: [migration(1, 2, contextManifestV1ToV2), migration(2, 3, contextManifestV2ToV3)]
  }),
  family({
    id: 'context-expansion-handle', currentVersion: 1,
    paths: [/^\$git\/evidence-packets\/handles\/ctx_[a-f0-9]{32}_[a-f0-9]{32}\.json$/]
  }),
  family({
    id: 'observation-summary', currentVersion: 3,
    steps: [migration(1, 2, observationSummaryV1ToV2), migration(2, 3, observationSummaryV2ToV3)],
    paths: [/^\$git\/evidence-packets\/observations\/(?:v2\/)?summaries\/[a-f0-9]{64}\.json$/]
  }),
  family({
    id: 'context-packet-telemetry', currentVersion: 4,
    steps: [
      migration(1, 2, contextPacketTelemetryV1ToV2),
      migration(2, 3, contextPacketTelemetryV2ToV3),
      migration(3, 4, contextPacketTelemetryV3ToV4)
    ],
    paths: [/^\$git\/evidence-packets\/telemetry\/ctx-[a-f0-9]{20}\.json$/]
  }),
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
  family({ id: 'ast-story-start-warm', currentVersion: 1, paths: [/^\$git\/ast\/v2\/story-start\/[a-f0-9]{64}\.json$/] }),
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

export function familyForStoredPath(relativePath, { workItemRoot = null, initiativeRoot = null } = {}) {
  const normalized = String(relativePath ?? '').replaceAll('\\', '/');
  const aliases = [normalized];
  const appendAlias = (configuredRoot, canonicalRoot) => {
    const prefix = String(configuredRoot ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
    if (prefix && prefix !== canonicalRoot && (normalized === prefix || normalized.startsWith(`${prefix}/`))) {
      aliases.push(`${canonicalRoot}${normalized.slice(prefix.length)}`);
    }
  };
  appendAlias(workItemRoot, 'singularity/work-items');
  appendAlias(initiativeRoot, 'singularity/initiatives');
  return families.find((entry) => aliases.some((candidate) => entry.paths.some((pattern) => pattern.test(candidate)))) ?? null;
}

export function migrationRegistrySnapshot() {
  return families.map(({ id, currentVersion, minimumReadableVersion, maximumReadableVersion, immutable, model, unversionedAs, migrationPolicy }) => ({
    id, currentVersion, minimumReadableVersion, maximumReadableVersion, immutable, model, unversionedAs, migrationPolicy
  }));
}
