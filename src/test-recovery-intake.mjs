/** TRP intake planning is read-only. Display defaults are never execution consent. */
import { trpDigest, sealTrpRecord, TRP_RISK_CATEGORIES } from './test-recovery-policy.mjs';
import { SingularityFlowError } from './util.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { isTestQualityCommand } from './delivery-evidence.mjs';

const MODES = ['changed-and-affected', 'all-configured'];
const fail = (message, code = 'TRP_POLICY_INVALID') => { throw new SingularityFlowError(message, { code }); };

export function normalizeTestRecoveryPolicy(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('testRecovery must be an object.');
  const allowed = new Set(['enabled', 'riskAuthorities', 'enabledRiskCategories', 'maxRiskDays',
    'maxDistinctAutomaticAttempts', 'allowEvidenceReuse', 'maxEvidenceAgeSeconds']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`Unknown testRecovery field '${key}'.`);
  if (typeof value.enabled !== 'boolean') fail('testRecovery.enabled must be explicitly true or false.');
  const list = (key, fallback) => {
    const result = value[key] ?? fallback;
    if (!Array.isArray(result) || result.length > 32 || new Set(result).size !== result.length
      || result.some(item => typeof item !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(item))) fail(`Invalid testRecovery.${key}.`);
    return [...result];
  };
  const integer = (key, fallback, minimum, maximum) => {
    const n = value[key] ?? fallback;
    if (!Number.isSafeInteger(n) || n < minimum || n > maximum) fail(`Invalid testRecovery.${key}.`);
    return n;
  };
  const categories = list('enabledRiskCategories', []);
  if (categories.some(category => !TRP_RISK_CATEGORIES.includes(category))) fail('Unsupported testRecovery risk category.');
  if (categories.length) fail('Risk activation is not available in the repair/selection pilot. Keep enabledRiskCategories empty; no lifecycle gate waiver is enabled.', 'TRP_RISK_ADAPTER_UNAVAILABLE');
  const authorities = list('riskAuthorities', []);
  if (categories.length && !authorities.length) fail('Enabled risks require explicit testRecovery.riskAuthorities.');
  if (value.allowEvidenceReuse != null && typeof value.allowEvidenceReuse !== 'boolean') fail('testRecovery.allowEvidenceReuse must be boolean.');
  if (value.allowEvidenceReuse === true) fail('Cross-gate evidence reuse is not enabled in the repair/selection pilot. Each required run remains explicit.', 'TRP_EVIDENCE_REUSE_UNAVAILABLE');
  return {
    enabled: value.enabled, riskAuthorities: authorities, enabledRiskCategories: categories,
    maxRiskDays: integer('maxRiskDays', 30, 1, 30),
    maxDistinctAutomaticAttempts: integer('maxDistinctAutomaticAttempts', 3, 0, 3),
    allowEvidenceReuse: value.allowEvidenceReuse ?? false,
    maxEvidenceAgeSeconds: integer('maxEvidenceAgeSeconds', 86400, 1, 2592000)
  };
}

export function testRecoveryChoices(options = {}) {
  return {
    baselineDisposition: options['test-baseline-disposition'] ?? 'fix',
    executionMode: options['test-execution-mode'] ?? 'changed-and-affected',
    baselineScope: options['test-baseline-scope'] ?? 'reuse'
  };
}

export function previewTestRecoveryIntake({ definition, workId, workType, repositories = [],
  repositoryReadiness, choices = {}, phaseDefinitions = null } = {}) {
  const policy = normalizeTestRecoveryPolicy(definition?.testRecovery);
  const phases = phaseDefinitions ?? (definition?.workTypes?.[workType]?.phases ?? [])
    .map(id => ({ id, ...definition.phases?.[id] }));
  const codeBearing = phases.some(phase => phaseRequiresCodeDelivery(phase)
    || phase.qualityCommands?.some(isTestQualityCommand));
  if (!policy?.enabled || !codeBearing) return { schemaVersion: 1, enabled: false };
  const selected = { baselineDisposition: 'fix', executionMode: 'changed-and-affected', baselineScope: 'reuse', ...choices };
  const blockers = [];
  if (selected.executionMode === 'changed-and-affected' && phases.some(phase =>
    !phaseRequiresCodeDelivery(phase) && phase.qualityCommands?.some(isTestQualityCommand))) {
    blockers.push('This workflow has test commands outside code-delivery phases. The pilot cannot enforce affected selection there; choose all configured tests or use a supported workflow.');
  }
  if (phases.some(phase => phase.qualityCommands?.some(command => isTestQualityCommand(command)
    && (!command || typeof command !== 'object' || Array.isArray(command) || command.kind !== 'test')))) {
    blockers.push('Test policy requires structured test commands. Review legacy test commands in approved configuration before starting; their execution scope cannot be enforced by this pilot.');
  }
  if (selected.baselineDisposition !== 'fix') blockers.push('Known-failure acceptance is unavailable in this repair/selection pilot; no gate waiver was created.');
  if (!MODES.includes(selected.executionMode)) blockers.push('Select changed-and-affected or all-configured tests.');
  if (selected.baselineScope !== 'reuse') blockers.push('Acquire a reviewed baseline with precheck --run first; intake does not execute tests.');
  const rows = repositories.map(repo => {
    const repositoryId = repo.id ?? repo.repository;
    const receipt = repositoryReadiness?.repositories?.[repositoryId];
    const valid = receipt?.sourceCommit === repo.baseCommit;
    const tools = valid ? receipt?.structuredTestContract?.commands ?? [] : [];
    return {
      repository: repositoryId, baseCommit: repo.baseCommit,
      baselineStatus: valid ? receipt.status : 'unknown',
      baselineDigest: valid ? receipt.baselineSha256 ?? receipt.receiptSha256 ?? null : null,
      baselineScope: valid ? receipt.scope : 'unknown',
      failures: (valid ? receipt.testObservations ?? [] : []).flatMap(observation =>
        (observation.failingCases ?? []).map(test => ({ id: test.fullName ?? test.name ?? 'unknown', suite: test.className ?? test.suite ?? observation.commandId }))),
      tools: tools.map(tool => ({ id: tool.id, runner: tool.launcher, cwd: tool.workingDirectory,
        adapter: tool.adapter, reportPath: tool.reportPath, source: 'exact-base-readiness' })),
      requestedScope: selected.executionMode, effectiveScope: 'planned at the candidate boundary',
      unknowns: valid && receipt.status === 'pass' ? [] : ['Feature coding requires baseline repair or a separately authorized decision.'],
      commands: [], selectedTests: [], exclusions: [], reasons: []
    };
  });
  if (!rows.length || rows.some(row => !row.repository || !/^[a-f0-9]{40,64}$/u.test(row.baseCommit ?? ''))) blockers.push('Every required repository needs its exact selected base.');
  const phaseContract = phases.map(phase => ({ id: phase.id,
    requiresCodeDelivery: phaseRequiresCodeDelivery(phase),
    qualityCommands: phase.qualityCommands ?? [], sourceBoundary: phase.sourceBoundary ?? null }));
  const policyAuthoritySha256 = trpDigest({ policy, authorities: definition.approvalAuthorities ?? {} });
  const core = { schemaVersion: 1, workId, workType, policy, policyAuthoritySha256, choices: selected,
    repositories: rows.map(row => ({ repository: row.repository, baseCommit: row.baseCommit,
      baselineStatus: row.baselineStatus, baselineDigest: row.baselineDigest, tools: row.tools })),
    phaseContractSha256: trpDigest(phaseContract) };
  return {
    schemaVersion: 1, enabled: true, supportedBaselineDispositions: ['fix'],
    supportedExecutionModes: MODES, supportedBaselineScopes: ['reuse'],
    acceptKnownFailuresEligible: false, ready: !blockers.length, planDigest: trpDigest(core),
    choices: selected, policy, policyAuthoritySha256, repositories: rows, blockers,
    unavailableReasons: { 'accept-known-failures': 'Not enabled in this pilot: downstream risk adapters are not qualified. Local precheck acknowledgement is not a waiver.' },
    maturity: 'repair-selection-pilot',
    summary: 'Repair/selection pilot: record a bounded repair agreement. This does not run tests, waive a gate, or accept a risk.',
    route: rows.some(row => row.baselineStatus !== 'pass') ? 'readiness-repair' : 'feature-coding',
    mandatoryChecks: ['Source and evidence integrity', 'Normal phase approvals'],
    legalActions: []
  };
}

export function confirmTestRecoveryIntake(preview, confirmation, options = {}) {
  const provided = ['test-baseline-disposition', 'test-execution-mode', 'test-baseline-scope', 'test-policy-confirm']
    .some(key => Object.hasOwn(options, key));
  if (!preview.enabled) {
    if (provided) fail('This workflow does not enable Story test policy. No Story was created.', 'TRP_NOT_ENABLED');
    return null;
  }
  if (!preview.ready || confirmation !== preview.planDigest
    || !['test-baseline-disposition', 'test-execution-mode', 'test-baseline-scope'].every(key => Object.hasOwn(options, key))) {
    throw new SingularityFlowError('Review and explicitly confirm the exact Story test policy before starting. Nothing was accepted.', {
      code: 'TRP_INTAKE_CONFIRMATION_REQUIRED', details: { testRecovery: preview }
    });
  }
  return preview;
}

/** Only substitutes the baseline-test readiness finding; transport/configuration checks survive. */
export function applyTestRecoveryAdmission(readiness, preview) {
  if (!preview?.enabled || !preview.ready || preview.choices.baselineDisposition !== 'fix') return readiness;
  const checks = readiness.checks.map(check => check.code === 'STORY_REPOSITORY_READINESS_REQUIRED'
    ? { ...check, status: 'warning', code: 'TRP_READINESS_REPAIR_REQUIRED',
      message: 'The Story may record its repair agreement; feature coding remains blocked until readiness is resolved.' } : check);
  const blocking = checks.filter(check => check.status === 'block');
  const warnings = checks.filter(check => check.status === 'warning');
  return { ...readiness, checks, blockers: blocking, warnings, ready: !blocking.length,
    status: blocking.length ? 'blocked' : warnings.length ? 'ready-with-warnings' : 'ready' };
}

export function initialTestRecoveryAgreement(preview, { workId, principal, createdAt, phaseIds }) {
  if (!preview?.enabled) return null;
  const authoritySha256 = preview.policyAuthoritySha256;
  return sealTrpRecord({ schemaVersion: 1, kind: 'story-test-recovery-agreement', id: 'agreement-1',
    subject: { workId }, createdAt, issuer: { principal, channel: 'confirmed-story-intake' },
    provenance: { authorityRef: authoritySha256, evidenceRefs: [] }, revision: 1, parentRevision: null,
    policyAuthoritySha256: authoritySha256, confirmedPlanSha256: preview.planDigest,
    repair: { maxDistinctAutomaticAttempts: preview.policy.maxDistinctAutomaticAttempts },
    repositories: preview.repositories.map(repo => ({ repositoryId: repo.repository, required: true, codeBearing: true,
      baselineDisposition: 'fix', baselineScope: 'unknown', baselineRefs: [], riskDecisionRefs: [],
      execution: { mode: preview.choices.executionMode, moduleExpansion: 'confirm', fullSuiteExpansion: 'confirm', knownFailureHandling: 'observe' },
      mandatoryObligations: (repo.tools.length ? repo.tools : [{ id: 'repository-tests' }]).map(tool => ({
        id: tool.id.replace(/^[^A-Za-z0-9]+/u, '') || 'repository-tests', kind: 'test', nonWaivable: false,
        transitions: ['publish', 'submit', 'approve', 'replay']
      }))
    }))
  });
}
