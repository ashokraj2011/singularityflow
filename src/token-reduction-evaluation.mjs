/** Deterministic, content-free evaluation for TKR benchmark observations. */
import { recordSha256 } from './records.mjs';
import { SingularityFlowError } from './util.mjs';
import { deepFreeze } from './world-model/canonicalize.mjs';

export const TKR_BENCHMARK_DEFAULTS = Object.freeze({
  minimumScenarios: 10,
  minimumPairedTrialsPerScenario: 3,
  targetInputReductionPercent: 30,
  maximumQualityDegradationPercent: 0
});

const STRATEGIES = new Set(['baseline', 'treatment']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'unknown']);
const USAGE_KINDS = new Set(['request', 'aggregate']);
const USAGE_OVERLAP = new Set(['exclusive-requests', 'explicit-parent-aggregate']);
const INPUT_TOKEN_SEMANTICS = new Set([
  'total-including-cached', 'total-excluding-cached', 'unknown'
]);
const CACHED_INPUT_SEMANTICS = new Set([
  'subset-of-input', 'additional-to-input', 'unknown'
]);
const TOTAL_SEMANTICS = new Set(['reported-total', 'unknown']);
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function fail(message, code = 'TKR_CONTRACT_UNSUPPORTED', details = {}) {
  throw new SingularityFlowError(message, { code, details });
}

function closedObject(value, label, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(`${label} contains unknown field '${unknown[0]}'.`, 'TKR_CONTRACT_UNSUPPORTED');
  return value;
}

function positiveInteger(value, label, fallback) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) fail(`${label} must be a positive integer.`);
  return selected;
}

function percent(value, label, fallback) {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected < 0 || selected > 100) {
    fail(`${label} must be a number from 0 through 100.`);
  }
  return selected;
}

function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string.`);
  return value.trim();
}

function exactNonempty(value, label) {
  const selected = nonempty(value, label);
  if (selected !== value) fail(
    `${label} must not contain leading or trailing whitespace.`,
    'TKR_CONTRACT_UNSUPPORTED', { received: value }
  );
  return selected;
}

function oneOf(value, allowed, label) {
  const selected = nonempty(value, label);
  if (!allowed.has(selected)) fail(`${label} is unsupported.`, 'TKR_CONTRACT_UNSUPPORTED', {
    received: selected, allowed: [...allowed]
  });
  return selected;
}

function exactOneOf(value, allowed, label) {
  const selected = exactNonempty(value, label);
  if (!allowed.has(selected)) fail(`${label} is unsupported.`, 'TKR_CONTRACT_UNSUPPORTED', {
    received: selected, allowed: [...allowed]
  });
  return selected;
}

/**
 * Close and self-bind the provider's usage mapping before any arithmetic is attempted. The mapping
 * says whether observations are exclusive or form an explicit inclusive aggregate graph, and how
 * cached input relates to the provider's reported input total.
 */
export function normalizeTkrProviderUsageAccounting(value) {
  const source = closedObject(value, 'TKR provider usage accounting', [
    'kind', 'version', 'mappingId', 'overlap', 'inputTokens', 'cachedInputTokens',
    'outputTokens', 'providerCost', 'contractSha256'
  ]);
  if (source.kind !== 'tkr/provider-usage-accounting' || source.version !== 1) {
    fail('TKR provider usage accounting kind/version is unsupported.',
      'TKR_CONTRACT_UNSUPPORTED');
  }
  const core = {
    kind: source.kind,
    version: source.version,
    mappingId: exactNonempty(
      source.mappingId, 'TKR provider usage accounting.mappingId'
    ),
    overlap: exactOneOf(
      source.overlap, USAGE_OVERLAP, 'TKR provider usage accounting.overlap'
    ),
    inputTokens: exactOneOf(
      source.inputTokens, INPUT_TOKEN_SEMANTICS,
      'TKR provider usage accounting.inputTokens'
    ),
    cachedInputTokens: exactOneOf(
      source.cachedInputTokens, CACHED_INPUT_SEMANTICS,
      'TKR provider usage accounting.cachedInputTokens'
    ),
    outputTokens: exactOneOf(
      source.outputTokens, TOTAL_SEMANTICS, 'TKR provider usage accounting.outputTokens'
    ),
    providerCost: exactOneOf(
      source.providerCost, TOTAL_SEMANTICS, 'TKR provider usage accounting.providerCost'
    )
  };
  const compatibleInputSemantics = (
    core.inputTokens === 'total-including-cached'
      && core.cachedInputTokens === 'subset-of-input'
  ) || (
    core.inputTokens === 'total-excluding-cached'
      && core.cachedInputTokens === 'additional-to-input'
  ) || (
    core.inputTokens === 'unknown' && core.cachedInputTokens === 'unknown'
  );
  if (!compatibleInputSemantics) fail(
    'TKR provider usage accounting gives contradictory input/cached-input semantics.',
    'TKR_CONTRACT_UNSUPPORTED', {
      inputTokens: core.inputTokens, cachedInputTokens: core.cachedInputTokens
    }
  );
  const expected = `sha256:${recordSha256(core)}`;
  if (!SHA256.test(source.contractSha256 ?? '') || source.contractSha256 !== expected) fail(
    'TKR provider usage accounting failed its exact content-integrity check.',
    'TKR_CONTRACT_UNSUPPORTED', { expected, received: source.contractSha256 ?? null }
  );
  return Object.freeze({ ...core, contractSha256: expected });
}

function normalizeDeclaredCohort(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('TKR benchmark profile.declaredCohort must be a non-empty array.',
      'TKR_COVERAGE_UNPROVEN');
  }
  const scenarioIds = new Set();
  return Object.freeze(value.map((entry, index) => {
    const label = `TKR benchmark profile.declaredCohort[${index}]`;
    const source = closedObject(entry, label, ['scenarioId', 'trials']);
    const scenarioId = nonempty(source.scenarioId, `${label}.scenarioId`);
    if (scenarioIds.has(scenarioId)) {
      fail(`TKR benchmark profile repeats scenario '${scenarioId}'.`,
        'TKR_COVERAGE_UNPROVEN', { scenarioId });
    }
    scenarioIds.add(scenarioId);
    if (!Array.isArray(source.trials) || source.trials.length === 0) {
      fail(`${label}.trials must be a non-empty array.`, 'TKR_COVERAGE_UNPROVEN');
    }
    const trials = source.trials.map((trial, trialIndex) => positiveInteger(
      trial, `${label}.trials[${trialIndex}]`
    ));
    if (new Set(trials).size !== trials.length) {
      fail(`${label}.trials contains a duplicate trial.`, 'TKR_COVERAGE_UNPROVEN', {
        scenarioId
      });
    }
    return Object.freeze({ scenarioId, trials: Object.freeze(trials) });
  }));
}

/**
 * Close the benchmark policy before observations are interpreted. This is deliberately a
 * transient evaluator input: persistence belongs to the existing governed test/evidence owner.
 */
export function normalizeTkrBenchmarkProfile(value = {}) {
  const source = closedObject(value, 'TKR benchmark profile', [
    'schemaVersion', 'kind', 'profileId', 'sourceRevision', 'repositoryVectorSha256',
    'taskDefinitionSha256', 'verificationDefinitionSha256', 'workflowPolicySha256',
    'baselineComposerSha256', 'treatmentComposerSha256', 'adapterId', 'adapterVersion',
    'provider', 'model', 'settingsSha256', 'tokenizerSha256', 'toolDefinitionsSha256',
    'cacheCondition', 'usageAccounting', 'declaredCohort', 'minimumScenarios',
    'minimumPairedTrialsPerScenario',
    'targetInputReductionPercent', 'maximumQualityDegradationPercent', 'includeFailedAttempts'
  ]);
  if ((source.schemaVersion ?? 1) !== 1 || (source.kind ?? 'tkr/benchmark-profile') !== 'tkr/benchmark-profile') {
    fail('TKR benchmark profile kind/version is unsupported.', 'TKR_CONTRACT_UNSUPPORTED');
  }
  const hashes = {};
  for (const field of [
    'repositoryVectorSha256', 'taskDefinitionSha256', 'verificationDefinitionSha256',
    'workflowPolicySha256', 'baselineComposerSha256', 'treatmentComposerSha256',
    'settingsSha256', 'tokenizerSha256', 'toolDefinitionsSha256'
  ]) {
    const candidate = nonempty(source[field], `TKR benchmark profile.${field}`);
    if (!/^sha256:[a-f0-9]{64}$/.test(candidate)) fail(`TKR benchmark profile.${field} must be a sha256 digest.`);
    hashes[field] = candidate;
  }
  const profile = {
    schemaVersion: 1,
    kind: 'tkr/benchmark-profile',
    profileId: nonempty(source.profileId, 'TKR benchmark profile.profileId'),
    sourceRevision: nonempty(source.sourceRevision, 'TKR benchmark profile.sourceRevision'),
    ...hashes,
    adapterId: nonempty(source.adapterId, 'TKR benchmark profile.adapterId'),
    adapterVersion: nonempty(source.adapterVersion, 'TKR benchmark profile.adapterVersion'),
    provider: nonempty(source.provider, 'TKR benchmark profile.provider'),
    model: nonempty(source.model, 'TKR benchmark profile.model'),
    cacheCondition: nonempty(source.cacheCondition, 'TKR benchmark profile.cacheCondition'),
    usageAccounting: normalizeTkrProviderUsageAccounting(source.usageAccounting),
    declaredCohort: normalizeDeclaredCohort(source.declaredCohort),
    minimumScenarios: positiveInteger(
      source.minimumScenarios, 'TKR benchmark profile.minimumScenarios',
      TKR_BENCHMARK_DEFAULTS.minimumScenarios
    ),
    minimumPairedTrialsPerScenario: positiveInteger(
      source.minimumPairedTrialsPerScenario,
      'TKR benchmark profile.minimumPairedTrialsPerScenario',
      TKR_BENCHMARK_DEFAULTS.minimumPairedTrialsPerScenario
    ),
    targetInputReductionPercent: percent(
      source.targetInputReductionPercent,
      'TKR benchmark profile.targetInputReductionPercent',
      TKR_BENCHMARK_DEFAULTS.targetInputReductionPercent
    ),
    maximumQualityDegradationPercent: percent(
      source.maximumQualityDegradationPercent,
      'TKR benchmark profile.maximumQualityDegradationPercent',
      TKR_BENCHMARK_DEFAULTS.maximumQualityDegradationPercent
    ),
    includeFailedAttempts: source.includeFailedAttempts ?? true
  };
  if (typeof profile.includeFailedAttempts !== 'boolean') {
    fail('TKR benchmark profile.includeFailedAttempts must be true or false.');
  }
  if (!profile.includeFailedAttempts) {
    fail('TKR benchmarks must include failed, cancelled, and unknown attempts.', 'TKR_COVERAGE_UNPROVEN');
  }
  return Object.freeze(profile);
}

function normalizeObservation(value, index) {
  const source = closedObject(value, `TKR observation ${index + 1}`, [
    'scenarioId', 'trial', 'strategy', 'storyId', 'phase', 'operationId', 'attemptId',
    'providerRequestId', 'usageId', 'usageKind', 'parentUsageId', 'includedUsageIds',
    'snapshotIndex', 'terminal', 'status', 'inputTokens', 'outputTokens',
    'cachedInputTokens', 'providerCost', 'coverageComplete', 'requiredCoveragePassed',
    'protectedContentPreserved', 'staleDispatchPrevented', 'authorizedContinuation',
    'firstPassPassed', 'finalAccepted', 'repairCount', 'latencyMs'
  ]);
  const label = `TKR observation ${index + 1}`;
  const strategy = nonempty(source.strategy, `TKR observation ${index + 1}.strategy`);
  if (!STRATEGIES.has(strategy)) fail(`TKR observation ${index + 1}.strategy is invalid.`);
  const status = nonempty(source.status, `TKR observation ${index + 1}.status`);
  const terminal = Object.hasOwn(source, 'terminal') ? source.terminal : false;
  if (typeof terminal !== 'boolean') {
    fail(`${label}.terminal must be boolean when supplied.`);
  }
  if (!TERMINAL.has(status) && terminal) {
    fail(`TKR observation ${index + 1} has an unsupported terminal status.`);
  }
  const nullableMeasurement = (field) => {
    const candidate = source[field];
    if (candidate == null) return null;
    if (!Number.isFinite(candidate) || candidate < 0) fail(`TKR observation ${index + 1}.${field} is invalid.`);
    return candidate;
  };
  const nullableIntegerCounter = (field) => {
    const candidate = source[field];
    if (candidate == null) return null;
    if (!Number.isSafeInteger(candidate) || candidate < 0) {
      fail(`${label}.${field} must be a non-negative safe integer or null.`);
    }
    return candidate;
  };
  const snapshotIndex = Object.hasOwn(source, 'snapshotIndex') ? source.snapshotIndex : 0;
  if (!Number.isSafeInteger(snapshotIndex) || snapshotIndex < 0) {
    fail(`${label}.snapshotIndex must be a non-negative safe integer when supplied.`);
  }
  const booleanOrNull = (field) => {
    const candidate = source[field];
    if (candidate == null) return null;
    if (typeof candidate !== 'boolean') fail(`TKR observation ${index + 1}.${field} must be boolean or null.`);
    return candidate;
  };
  const usageId = nonempty(source.usageId, `TKR observation ${index + 1}.usageId`);
  const usageKind = oneOf(
    source.usageKind, USAGE_KINDS, `TKR observation ${index + 1}.usageKind`
  );
  const parentUsageId = source.parentUsageId == null ? null
    : nonempty(source.parentUsageId, `TKR observation ${index + 1}.parentUsageId`);
  if (!Array.isArray(source.includedUsageIds)) fail(
    `TKR observation ${index + 1}.includedUsageIds must be an array.`
  );
  const includedUsageIds = source.includedUsageIds.map((entry, includedIndex) => nonempty(
    entry, `TKR observation ${index + 1}.includedUsageIds[${includedIndex}]`
  ));
  if (new Set(includedUsageIds).size !== includedUsageIds.length) fail(
    `TKR observation ${index + 1}.includedUsageIds contains a duplicate.`,
    'TKR_COVERAGE_UNPROVEN', { usageId }
  );
  if (parentUsageId === usageId || includedUsageIds.includes(usageId)) fail(
    `TKR observation ${index + 1} gives usage '${usageId}' a self-reference.`,
    'TKR_COVERAGE_UNPROVEN', { usageId }
  );
  if (usageKind === 'request' && includedUsageIds.length) fail(
    `TKR request usage '${usageId}' cannot include other usage observations.`,
    'TKR_COVERAGE_UNPROVEN', { usageId }
  );
  if (usageKind === 'aggregate' && includedUsageIds.length === 0) fail(
    `TKR aggregate usage '${usageId}' must name its included observations.`,
    'TKR_COVERAGE_UNPROVEN', { usageId }
  );
  return Object.freeze({
    scenarioId: nonempty(source.scenarioId, `TKR observation ${index + 1}.scenarioId`),
    trial: positiveInteger(source.trial, `TKR observation ${index + 1}.trial`),
    strategy,
    storyId: nonempty(source.storyId, `TKR observation ${index + 1}.storyId`),
    phase: nonempty(source.phase, `TKR observation ${index + 1}.phase`),
    operationId: nonempty(source.operationId, `TKR observation ${index + 1}.operationId`),
    attemptId: nonempty(source.attemptId, `TKR observation ${index + 1}.attemptId`),
    providerRequestId: source.providerRequestId == null ? null
      : nonempty(source.providerRequestId, `TKR observation ${index + 1}.providerRequestId`),
    usageId,
    usageKind,
    parentUsageId,
    includedUsageIds: Object.freeze(includedUsageIds),
    snapshotIndex,
    terminal,
    status,
    inputTokens: nullableIntegerCounter('inputTokens'),
    outputTokens: nullableIntegerCounter('outputTokens'),
    cachedInputTokens: nullableIntegerCounter('cachedInputTokens'),
    providerCost: nullableMeasurement('providerCost'),
    coverageComplete: booleanOrNull('coverageComplete'),
    requiredCoveragePassed: booleanOrNull('requiredCoveragePassed'),
    protectedContentPreserved: booleanOrNull('protectedContentPreserved'),
    staleDispatchPrevented: booleanOrNull('staleDispatchPrevented'),
    authorizedContinuation: booleanOrNull('authorizedContinuation'),
    firstPassPassed: booleanOrNull('firstPassPassed'),
    finalAccepted: booleanOrNull('finalAccepted'),
    repairCount: nullableIntegerCounter('repairCount'),
    latencyMs: nullableMeasurement('latencyMs')
  });
}

function requestIdentity(observation) {
  return observation.providerRequestId
    ? `provider:${observation.providerRequestId}`
    : `attempt:${observation.operationId}:${observation.attemptId}`;
}

function attemptIdentity(observation) {
  return JSON.stringify([
    observation.storyId, observation.phase, observation.operationId, observation.attemptId
  ]);
}

const CUMULATIVE_USAGE_FIELDS = Object.freeze([
  'inputTokens', 'outputTokens', 'cachedInputTokens', 'providerCost', 'repairCount',
  'latencyMs'
]);
const SNAPSHOT_FACT_FIELDS = Object.freeze([
  'coverageComplete', 'requiredCoveragePassed', 'protectedContentPreserved',
  'staleDispatchPrevented', 'authorizedContinuation', 'firstPassPassed',
  'finalAccepted'
]);

/** Select one terminal/cumulative observation for each actual request. */
export function deduplicateTkrUsage(observations = []) {
  if (!Array.isArray(observations)) fail('TKR observations must be an array.');
  const attempts = new Map();
  for (const observation of observations.map(normalizeObservation)) {
    const key = attemptIdentity(observation);
    const attempt = attempts.get(key) ?? {
      subject: observation,
      providerRequestId: null,
      snapshots: new Map()
    };
    const existing = attempt.subject;
    if ([
      'scenarioId', 'trial', 'strategy', 'storyId', 'phase', 'operationId', 'attemptId',
      'usageId', 'usageKind', 'parentUsageId'
    ].some((field) => existing[field] !== observation[field])) {
      fail(`TKR request identity '${key}' is reused for a different benchmark subject.`,
        'TKR_COVERAGE_UNPROVEN', { requestIdentity: key });
    }
    if (existing && JSON.stringify(existing.includedUsageIds)
        !== JSON.stringify(observation.includedUsageIds)) fail(
      `TKR request identity '${key}' changed its aggregate membership between snapshots.`,
      'TKR_COVERAGE_UNPROVEN', { requestIdentity: key }
    );
    if (observation.providerRequestId !== null) {
      if (attempt.providerRequestId !== null
          && attempt.providerRequestId !== observation.providerRequestId) fail(
        `TKR attempt '${key}' changed provider request identity between snapshots.`,
        'TKR_COVERAGE_UNPROVEN', {
          requestIdentity: key,
          providerRequestIds: [attempt.providerRequestId, observation.providerRequestId].sort()
        }
      );
      attempt.providerRequestId = observation.providerRequestId;
    }
    const sameIndex = attempt.snapshots.get(observation.snapshotIndex);
    if (sameIndex && recordSha256(sameIndex) !== recordSha256(observation)) fail(
      `TKR attempt '${key}' has conflicting cumulative snapshots at index ${observation.snapshotIndex}.`,
      'TKR_COVERAGE_UNPROVEN', {
        requestIdentity: key, snapshotIndex: observation.snapshotIndex
      }
    );
    attempt.snapshots.set(observation.snapshotIndex, observation);
    attempts.set(key, attempt);
  }

  const providerOwners = new Map();
  const selected = [];
  for (const [key, attempt] of attempts) {
    if (attempt.providerRequestId !== null) {
      const priorOwner = providerOwners.get(attempt.providerRequestId);
      if (priorOwner && priorOwner !== key) fail(
        `TKR provider request '${attempt.providerRequestId}' maps to multiple attempts.`,
        'TKR_COVERAGE_UNPROVEN', {
          providerRequestId: attempt.providerRequestId,
          requestIdentities: [priorOwner, key].sort()
        }
      );
      providerOwners.set(attempt.providerRequestId, key);
    }
    const snapshots = [...attempt.snapshots.values()].sort((left, right) => (
      left.snapshotIndex - right.snapshotIndex
    ));
    for (let index = 1; index < snapshots.length; index += 1) {
      const prior = snapshots[index - 1];
      const current = snapshots[index];
      if (prior.terminal && !current.terminal) fail(
        `TKR attempt '${key}' reverts from terminal to non-terminal usage.`,
        'TKR_COVERAGE_UNPROVEN', { requestIdentity: key, snapshotIndex: current.snapshotIndex }
      );
      if (prior.terminal && current.terminal && prior.status !== current.status) fail(
        `TKR attempt '${key}' changes terminal status between cumulative snapshots.`,
        'TKR_COVERAGE_UNPROVEN', { requestIdentity: key, snapshotIndex: current.snapshotIndex }
      );
      for (const field of CUMULATIVE_USAGE_FIELDS) {
        if (Number.isFinite(prior[field]) && Number.isFinite(current[field])
            && current[field] < prior[field]) fail(
          `TKR attempt '${key}' decreases cumulative ${field} between snapshots.`,
          'TKR_COVERAGE_UNPROVEN', {
            requestIdentity: key, field, prior: prior[field], current: current[field]
          }
        );
      }
      for (const field of SNAPSHOT_FACT_FIELDS) {
        if (prior[field] != null && current[field] != null
            && prior[field] !== current[field]) fail(
          `TKR attempt '${key}' changes observed ${field} between cumulative snapshots.`,
          'TKR_COVERAGE_UNPROVEN', {
            requestIdentity: key, field, prior: prior[field], current: current[field]
          }
        );
      }
    }
    const latest = snapshots.at(-1);
    if (attempt.providerRequestId !== null && latest.providerRequestId === null) fail(
      `TKR attempt '${key}' drops its provider request identity in a later snapshot.`,
      'TKR_COVERAGE_UNPROVEN', { requestIdentity: key }
    );
    selected.push(latest);
  }
  return Object.freeze(selected.sort((left, right) => (
    left.scenarioId.localeCompare(right.scenarioId)
      || left.trial - right.trial
      || left.strategy.localeCompare(right.strategy)
      || requestIdentity(left).localeCompare(requestIdentity(right))
  )));
}

function usageAccountingGraph(requests, mapping) {
  const byUsageId = new Map();
  for (const request of requests) {
    const prior = byUsageId.get(request.usageId);
    if (prior) fail(`TKR usage ID '${request.usageId}' identifies multiple requests.`,
      'TKR_COVERAGE_UNPROVEN', {
        usageId: request.usageId,
        requests: [requestIdentity(prior), requestIdentity(request)]
      });
    byUsageId.set(request.usageId, request);
  }

  if (mapping.overlap === 'exclusive-requests') {
    const linked = requests.find((request) => request.usageKind !== 'request'
      || request.parentUsageId !== null || request.includedUsageIds.length !== 0);
    if (linked) fail(
      'TKR usage mapping declares exclusive requests but an observation declares overlap.',
      'TKR_COVERAGE_UNPROVEN', { usageId: linked.usageId }
    );
    return Object.freeze({
      accounted: Object.freeze([...requests]), aggregateRequests: 0,
      coveredRequests: 0, maximumDepth: requests.length ? 1 : 0
    });
  }

  const includedBy = new Map();
  for (const aggregate of requests.filter((request) => request.usageKind === 'aggregate')) {
    for (const childId of aggregate.includedUsageIds) {
      const child = byUsageId.get(childId);
      if (!child) fail(`TKR aggregate usage '${aggregate.usageId}' references missing child '${childId}'.`,
        'TKR_COVERAGE_UNPROVEN', { usageId: aggregate.usageId, missingUsageId: childId });
      const priorParent = includedBy.get(childId);
      if (priorParent && priorParent !== aggregate.usageId) fail(
        `TKR usage '${childId}' is included by multiple aggregates.`,
        'TKR_COVERAGE_UNPROVEN', {
          usageId: childId, aggregateUsageIds: [priorParent, aggregate.usageId].sort()
        }
      );
      includedBy.set(childId, aggregate.usageId);
      if (child.parentUsageId !== aggregate.usageId) fail(
        `TKR aggregate '${aggregate.usageId}' and child '${childId}' do not agree on parent linkage.`,
        'TKR_COVERAGE_UNPROVEN', {
          aggregateUsageId: aggregate.usageId, childUsageId: childId,
          childParentUsageId: child.parentUsageId
        }
      );
      for (const field of ['scenarioId', 'trial', 'strategy', 'storyId', 'phase']) {
        if (aggregate[field] !== child[field]) fail(
          `TKR aggregate '${aggregate.usageId}' crosses benchmark ${field}.`,
          'TKR_COVERAGE_UNPROVEN', {
            aggregateUsageId: aggregate.usageId, childUsageId: childId, field
          }
        );
      }
    }
  }
  for (const request of requests) {
    if (request.parentUsageId === null) continue;
    const parent = byUsageId.get(request.parentUsageId);
    if (!parent || parent.usageKind !== 'aggregate'
        || !parent.includedUsageIds.includes(request.usageId)) fail(
      `TKR usage '${request.usageId}' has an unavailable or non-reciprocal parent aggregate.`,
      'TKR_COVERAGE_UNPROVEN', {
        usageId: request.usageId, parentUsageId: request.parentUsageId
      }
    );
  }

  const visiting = new Set();
  const visited = new Set();
  let maximumDepth = 0;
  const visit = (request, depth) => {
    if (visiting.has(request.usageId)) fail(
      `TKR usage accounting graph contains a cycle at '${request.usageId}'.`,
      'TKR_COVERAGE_UNPROVEN', { usageId: request.usageId }
    );
    if (visited.has(request.usageId)) return;
    visiting.add(request.usageId);
    maximumDepth = Math.max(maximumDepth, depth);
    for (const childId of request.includedUsageIds) visit(byUsageId.get(childId), depth + 1);
    visiting.delete(request.usageId);
    visited.add(request.usageId);
  };
  const accounted = requests.filter((request) => request.parentUsageId === null);
  for (const request of accounted) visit(request, 1);
  // A malformed all-cycle graph has no root. Visit remaining nodes solely to surface the exact
  // cycle instead of treating it as an empty accounting set.
  for (const request of requests) if (!visited.has(request.usageId)) visit(request, 1);
  if (requests.length && !accounted.length) fail(
    'TKR usage accounting graph has no non-overlapping root.', 'TKR_COVERAGE_UNPROVEN'
  );
  return Object.freeze({
    accounted: Object.freeze(accounted),
    aggregateRequests: requests.filter((request) => request.usageKind === 'aggregate').length,
    coveredRequests: requests.length - accounted.length,
    maximumDepth
  });
}

function sumKnown(records, field) {
  return records.length && records.every((record) => Number.isFinite(record[field]))
    ? records.reduce((total, record) => total + record[field], 0)
    : null;
}

function effectiveInputTokens(record, mapping) {
  if (mapping.inputTokens === 'unknown' || !Number.isFinite(record.inputTokens)) return null;
  if (mapping.inputTokens === 'total-including-cached') return record.inputTokens;
  return Number.isFinite(record.cachedInputTokens)
    ? record.inputTokens + record.cachedInputTokens : null;
}

function sumMapped(records, valueFor) {
  if (!records.length) return null;
  const values = records.map(valueFor);
  return values.every(Number.isFinite) ? values.reduce((total, value) => total + value, 0) : null;
}

function rate(records, field) {
  return records.length && records.every((record) => typeof record[field] === 'boolean')
    ? records.filter((record) => record[field]).length / records.length * 100
    : null;
}

function pairIdentity(scenarioId, trial) {
  return JSON.stringify([scenarioId, trial]);
}

function runIdentity(scenarioId, trial, strategy) {
  return JSON.stringify([scenarioId, trial, strategy]);
}

function runOutcomes(requests) {
  const grouped = new Map();
  for (const request of requests) {
    const key = runIdentity(request.scenarioId, request.trial, request.strategy);
    const entries = grouped.get(key) ?? [];
    entries.push(request);
    grouped.set(key, entries);
  }
  return [...grouped.entries()].map(([key, entries]) => {
    const boolean = (field) => {
      const values = [...new Set(entries.map((entry) => entry[field]).filter((value) => value != null))];
      if (values.length > 1) {
        fail(`TKR benchmark run '${key}' has conflicting ${field} observations.`,
          'TKR_COVERAGE_UNPROVEN', { run: key, field });
      }
      return values[0] ?? null;
    };
    return Object.freeze({
      key,
      pairKey: pairIdentity(entries[0].scenarioId, entries[0].trial),
      scenarioId: entries[0].scenarioId,
      trial: entries[0].trial,
      strategy: entries[0].strategy,
      requestCount: entries.length,
      firstPassPassed: boolean('firstPassPassed'),
      finalAccepted: boolean('finalAccepted'),
      repairCount: sumKnown(entries, 'repairCount')
    });
  }).sort((left, right) => left.key.localeCompare(right.key));
}

function qualityFor(runs) {
  return {
    runs: runs.length,
    firstPassMeasuredRuns: runs.filter((record) => (
      typeof record.firstPassPassed === 'boolean'
    )).length,
    firstPassPercent: rate(runs, 'firstPassPassed'),
    finalAcceptanceMeasuredRuns: runs.filter((record) => (
      typeof record.finalAccepted === 'boolean'
    )).length,
    finalAcceptancePercent: rate(runs, 'finalAccepted'),
    repairCount: sumKnown(runs, 'repairCount'),
    repairCountUnknownRuns: runs.filter((record) => !Number.isFinite(record.repairCount)).length
  };
}

function summarizeObservations(records) {
  const status = {
    completed: 0, failed: 0, cancelled: 0, unknown: 0, nonTerminal: 0
  };
  for (const record of records) {
    if (!record.terminal) status.nonTerminal += 1;
    else status[record.status] += 1;
  }
  return {
    requests: records.length,
    status,
    repairCount: sumKnown(records, 'repairCount'),
    repairCountUnknownRequests: records.filter((record) => (
      !Number.isFinite(record.repairCount)
    )).length,
    unknownInputTokenRequests: records.filter((record) => (
      !Number.isFinite(record.inputTokens)
    )).length,
    unknownOutputTokenRequests: records.filter((record) => (
      !Number.isFinite(record.outputTokens)
    )).length,
    unknownProviderCostRequests: records.filter((record) => (
      !Number.isFinite(record.providerCost)
    )).length,
    firstPassUnknownRequests: records.filter((record) => (
      typeof record.firstPassPassed !== 'boolean'
    )).length,
    finalAcceptanceUnknownRequests: records.filter((record) => (
      typeof record.finalAccepted !== 'boolean'
    )).length
  };
}

function accountingFor(records, mapping) {
  const baseline = records.filter((record) => record.strategy === 'baseline');
  const treatment = records.filter((record) => record.strategy === 'treatment');
  const inputTokens = (entries) => sumMapped(entries, (record) => (
    effectiveInputTokens(record, mapping)
  ));
  const outputTokens = (entries) => mapping.outputTokens === 'reported-total'
    ? sumKnown(entries, 'outputTokens') : null;
  const providerCost = (entries) => mapping.providerCost === 'reported-total'
    ? sumKnown(entries, 'providerCost') : null;
  return {
    inputTokens: {
      baseline: inputTokens(baseline),
      treatment: inputTokens(treatment)
    },
    reportedInputTokens: {
      baseline: sumKnown(baseline, 'inputTokens'),
      treatment: sumKnown(treatment, 'inputTokens')
    },
    cachedInputTokens: {
      relationship: mapping.cachedInputTokens,
      baseline: sumKnown(baseline, 'cachedInputTokens'),
      treatment: sumKnown(treatment, 'cachedInputTokens')
    },
    outputTokens: {
      baseline: outputTokens(baseline),
      treatment: outputTokens(treatment)
    },
    providerCost: {
      baseline: providerCost(baseline),
      treatment: providerCost(treatment)
    }
  };
}

/**
 * Evaluate a closed paired cohort. No missing usage or quality value is converted to zero, and no
 * narrower packet saving is presented as complete-Story savings.
 */
export function evaluateTkrBenchmark(profileValue, observations = []) {
  const profile = normalizeTkrBenchmarkProfile(profileValue);
  const requests = deduplicateTkrUsage(observations);
  const usageGraph = usageAccountingGraph(requests, profile.usageAccounting);
  const runs = runOutcomes(requests);
  const declaredPairs = profile.declaredCohort.flatMap(({ scenarioId, trials }) => (
    trials.map((trial) => ({ scenarioId, trial, pairKey: pairIdentity(scenarioId, trial) }))
  ));
  const declaredPairKeys = new Set(declaredPairs.map((entry) => entry.pairKey));
  const unexpectedRuns = runs.filter((run) => !declaredPairKeys.has(run.pairKey));
  if (unexpectedRuns.length) {
    fail('TKR observations contain a run outside the preregistered cohort.',
      'TKR_COVERAGE_UNPROVEN', {
        unexpectedRuns: unexpectedRuns.map(({ scenarioId, trial, strategy }) => ({
          scenarioId, trial, strategy
        }))
      });
  }
  const strategiesByPair = new Map();
  for (const run of runs) {
    const strategies = strategiesByPair.get(run.pairKey) ?? new Set();
    strategies.add(run.strategy);
    strategiesByPair.set(run.pairKey, strategies);
  }
  const pairings = declaredPairs.map(({ scenarioId, trial, pairKey }) => {
    const present = strategiesByPair.get(pairKey) ?? new Set();
    const presentStrategies = [...STRATEGIES].filter((strategy) => present.has(strategy));
    const missingStrategies = [...STRATEGIES].filter((strategy) => !present.has(strategy));
    return { scenarioId, trial, pairKey, presentStrategies, missingStrategies };
  });
  const completePairKeys = new Set(pairings.filter((entry) => (
    entry.missingStrategies.length === 0
  )).map((entry) => entry.pairKey));
  const matchedRuns = runs.filter((record) => completePairKeys.has(record.pairKey));
  const unmatchedRuns = runs.filter((record) => !completePairKeys.has(record.pairKey));
  const matchedRequests = requests.filter((record) => (
    completePairKeys.has(pairIdentity(record.scenarioId, record.trial))
  ));
  const unmatchedRequests = requests.filter((record) => (
    !completePairKeys.has(pairIdentity(record.scenarioId, record.trial))
  ));
  const matchedAccountedRequests = usageGraph.accounted.filter((record) => (
    completePairKeys.has(pairIdentity(record.scenarioId, record.trial))
  ));
  const unmatchedAccountedRequests = usageGraph.accounted.filter((record) => (
    !completePairKeys.has(pairIdentity(record.scenarioId, record.trial))
  ));
  const scenarioIds = profile.declaredCohort.map((entry) => entry.scenarioId);
  const trialsByScenario = Object.fromEntries(profile.declaredCohort.map((entry) => [
    entry.scenarioId,
    entry.trials.filter((trial) => completePairKeys.has(pairIdentity(entry.scenarioId, trial))).length
  ]));
  const declaredCohortMeetsMinimum = profile.declaredCohort.length >= profile.minimumScenarios
    && profile.declaredCohort.every((entry) => (
      entry.trials.length >= profile.minimumPairedTrialsPerScenario
    ));
  const pairingComplete = pairings.every((entry) => entry.missingStrategies.length === 0);
  const cohortComplete = declaredCohortMeetsMinimum && pairingComplete;
  const accountingObservable = matchedRequests.length > 0
    && matchedAccountedRequests.length > 0
    && matchedRequests.every((record) => record.terminal && record.coverageComplete === true)
    && matchedAccountedRequests.every((record) => (
      Number.isFinite(effectiveInputTokens(record, profile.usageAccounting))
    ));
  const observable = cohortComplete && accountingObservable;
  const correctnessFields = [
    'requiredCoveragePassed', 'protectedContentPreserved',
    'staleDispatchPrevented', 'authorizedContinuation'
  ];
  const correctnessEvidenceComplete = matchedRequests.length > 0
    && matchedRequests.every((record) => correctnessFields
      .every((field) => typeof record[field] === 'boolean'));
  const correctnessComplete = cohortComplete && correctnessEvidenceComplete;
  const correctnessPassed = correctnessComplete && matchedRequests.every((record) => correctnessFields
    .every((field) => record[field] === true));
  const baselineRuns = matchedRuns.filter((record) => record.strategy === 'baseline');
  const treatmentRuns = matchedRuns.filter((record) => record.strategy === 'treatment');
  const completeStoryAccounting = accountingFor(usageGraph.accounted, profile.usageAccounting);
  const cohortAccounting = accountingFor(matchedAccountedRequests, profile.usageAccounting);
  const unmatchedAccounting = accountingFor(
    unmatchedAccountedRequests, profile.usageAccounting
  );
  const baselineInputTokens = cohortAccounting.inputTokens.baseline;
  const treatmentInputTokens = cohortAccounting.inputTokens.treatment;
  const matchedSubsetReductionPercent = baselineInputTokens != null
    && treatmentInputTokens != null && baselineInputTokens > 0
    ? (1 - treatmentInputTokens / baselineInputTokens) * 100 : null;
  const reductionPercent = cohortComplete && accountingObservable
    ? matchedSubsetReductionPercent : null;
  const quality = {
    weighting: 'one-vote-per-declared-scenario-trial-run',
    baseline: qualityFor(baselineRuns),
    treatment: qualityFor(treatmentRuns)
  };
  const qualityMeasured = cohortComplete && [quality.baseline, quality.treatment].every((entry) => (
    Number.isFinite(entry.firstPassPercent) && Number.isFinite(entry.finalAcceptancePercent)
  ));
  const qualityHeld = qualityMeasured && correctnessPassed
    && quality.treatment.firstPassPercent + profile.maximumQualityDegradationPercent
      >= quality.baseline.firstPassPercent
    && quality.treatment.finalAcceptancePercent + profile.maximumQualityDegradationPercent
      >= quality.baseline.finalAcceptancePercent;
  const measurementEligible = cohortComplete && observable && correctnessComplete && qualityMeasured;
  const targetMet = measurementEligible && Number.isFinite(reductionPercent)
    && reductionPercent >= profile.targetInputReductionPercent;
  const diagnosticTargetAndQualityHeld = measurementEligible && targetMet && qualityHeld;
  // This evaluator is deliberately code-local. Its caller-supplied observations are useful for
  // deterministic arithmetic and quality diagnostics, but they are not receipts from the
  // existing governed test/evidence, adapter-delivery, or independent-review owners. Until that
  // M4 boundary exists, accepting a release or savings claim here would let a synthetic fixture
  // impersonate empirical evidence.
  const benchmarkEligible = false;
  const candidateClaimEligible = false;
  const claimAllowed = false;
  const claimBoundary = 'code-local-diagnostic-only';
  const reasons = [
    ...(!declaredCohortMeetsMinimum ? ['declared cohort is below the minimum size'] : []),
    ...(!pairingComplete ? ['declared cohort contains unmatched baseline or treatment runs'] : []),
    ...(!cohortComplete ? ['paired cohort is incomplete'] : []),
    ...(!observable ? ['complete-Story provider input-token coverage is incomplete'] : []),
    ...(!correctnessComplete ? ['correctness evidence is incomplete'] : []),
    ...(!qualityMeasured ? ['quality outcomes are unmeasured'] : []),
    ...(measurementEligible && !targetMet ? ['input-token reduction target was not met'] : []),
    ...(measurementEligible && !qualityHeld ? ['quality gate did not hold'] : []),
    'durable empirical release qualification is unavailable in the code-local preview'
  ];
  const result = {
    schemaVersion: 1,
    kind: 'tkr/benchmark-evaluation',
    profileSha256: `sha256:${recordSha256(profile)}`,
    scenarios: scenarioIds.length,
    runs: runs.length,
    matchedRuns: matchedRuns.length,
    unmatchedRuns: unmatchedRuns.length,
    trialsByScenario,
    observedRequests: requests.length,
    accountedRequests: usageGraph.accounted.length,
    aggregateRequests: usageGraph.aggregateRequests,
    aggregateCoveredRequests: usageGraph.coveredRequests,
    matchedRequests: matchedRequests.length,
    unmatchedRequests: unmatchedRequests.length,
    pairing: {
      declaredPairs: declaredPairs.length,
      matchedPairs: completePairKeys.size,
      gaps: pairings.filter((entry) => entry.missingStrategies.length > 0)
        .map(({ scenarioId, trial, presentStrategies, missingStrategies }) => ({
          scenarioId, trial, presentStrategies, missingStrategies
        }))
    },
    accounting: {
      scope: 'fully-paired-declared-cohort',
      providerUsageMapping: {
        contractSha256: profile.usageAccounting.contractSha256,
        overlap: profile.usageAccounting.overlap,
        inputTokens: profile.usageAccounting.inputTokens,
        cachedInputTokens: profile.usageAccounting.cachedInputTokens,
        outputTokens: profile.usageAccounting.outputTokens,
        providerCost: profile.usageAccounting.providerCost
      },
      overlapGraph: {
        observedRequests: requests.length,
        accountedRequests: usageGraph.accounted.length,
        aggregateRequests: usageGraph.aggregateRequests,
        coveredRequests: usageGraph.coveredRequests,
        maximumDepth: usageGraph.maximumDepth
      },
      baselineInputTokens,
      treatmentInputTokens,
      reductionPercent,
      matchedSubsetReductionPercent,
      outputTokens: cohortAccounting.outputTokens,
      providerCost: cohortAccounting.providerCost,
      completeStoryObserved: completeStoryAccounting,
      unmatchedObserved: unmatchedAccounting
    },
    quality,
    outcomes: {
      completeStoryObserved: summarizeObservations(requests),
      matchedCohort: summarizeObservations(matchedRequests),
      unmatchedObserved: summarizeObservations(unmatchedRequests)
    },
    coverage: {
      declaredCohortMeetsMinimum, pairingComplete, cohortComplete, observable,
      correctnessComplete
    },
    benchmarkEligible,
    measurementEligible,
    targetMet,
    qualityHeld,
    diagnosticTargetAndQualityHeld,
    candidateClaimEligible,
    claimBoundary,
    claimAllowed,
    reasons
  };
  return deepFreeze({ ...result, evaluationSha256: `sha256:${recordSha256(result)}` });
}
