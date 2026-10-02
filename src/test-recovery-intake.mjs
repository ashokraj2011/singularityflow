/** TRP intake planning is read-only. Display defaults are never execution consent. */
import { trpDigest, sealTrpRecord, TRP_RISK_CATEGORIES } from './test-recovery-policy.mjs';
import { SingularityFlowError } from './util.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { isTestQualityCommand } from './delivery-evidence.mjs';
import { normalizeTestSelectionPath } from './test-selection-policy.mjs';

const MODES = ['changed-and-affected', 'all-configured'];
const fail = (message, code = 'TRP_POLICY_INVALID') => { throw new SingularityFlowError(message, { code }); };

/** Independent approved identities, never an inventory inferred from a test report. */
function normalizeCaseInventory(value) {
  if (!Array.isArray(value) || !value.length || value.length > 64) fail('testRecovery.caseInventory needs 1–64 phase/command entries.');
  const entries = new Set();
  let total = 0;
  const ordinary = (text, max) => typeof text === 'string' && text.trim().length > 0
    && text === text.trim() && text.length <= max && !/[\x00-\x1f\x7f]/u.test(text);
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).some(key => !['phaseId', 'commandId', 'dependencyScope', 'tests'].includes(key))
        || entry.dependencyScope !== 'repository-and-node-builtins-only'
        || !ordinary(entry.phaseId, 128) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.phaseId)
        || entry.phaseId.includes('..') || !ordinary(entry.commandId, 256)
        || !Array.isArray(entry.tests) || !entry.tests.length || (total += entry.tests.length) > 10_000) {
      fail('Invalid or oversized testRecovery.caseInventory entry.');
    }
    const pair = JSON.stringify([entry.phaseId, entry.commandId]);
    if (entries.has(pair)) fail('Duplicate testRecovery.caseInventory phase/command.');
    entries.add(pair);
    const ids = new Set(); const identities = new Set(); const files = new Set();
    const tests = entry.tests.map(test => {
      if (!test || typeof test !== 'object' || Array.isArray(test)
          || Object.keys(test).some(key => !['id', 'path', 'name'].includes(key))
          || !ordinary(test.id, 256) || !ordinary(test.name, 4096) || !ordinary(test.path, 1024)) {
        fail('Each approved test needs an exact ID, repository-relative path and native report name.');
      }
      let normalized;
      try { normalized = normalizeTestSelectionPath(test.path); } catch { fail('Approved test paths must be safe repository-relative paths.'); }
      if (normalized !== test.path || test.path.includes('\\')) fail('Approved test paths must use canonical forward slashes.');
      const identity = JSON.stringify([test.path, test.name]);
      if (ids.has(test.id) || identities.has(identity)) fail('Approved test IDs and file/name pairs must be unique per command.');
      ids.add(test.id); identities.add(identity); files.add(test.path);
      return { id: test.id, path: test.path, name: test.name };
    });
    if (files.size > 256) fail('Approved test inventory exceeds 256 files per command.');
    return { phaseId: entry.phaseId, commandId: entry.commandId, dependencyScope: entry.dependencyScope, tests };
  });
}

export function normalizeTestRecoveryPolicy(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('testRecovery must be an object.');
  const allowed = new Set(['enabled', 'riskAuthorities', 'enabledRiskCategories', 'maxRiskDays',
    'maxDistinctAutomaticAttempts', 'allowEvidenceReuse', 'maxEvidenceAgeSeconds', 'caseInventory']);
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
  if (categories.some(category => !['validation-unavailable', 'new-test-failure'].includes(category))) fail('Only exact native runner-unavailable and independently inventoried native Node failure review are supported. Known failures, reduced coverage and document exceptions still need qualified adapters.', 'TRP_RISK_ADAPTER_UNAVAILABLE');
  const authorities = list('riskAuthorities', []);
  if (categories.length && !authorities.length) fail('Enabled risks require explicit testRecovery.riskAuthorities.');
  if (value.allowEvidenceReuse != null && typeof value.allowEvidenceReuse !== 'boolean') fail('testRecovery.allowEvidenceReuse must be boolean.');
  const caseInventory = value.caseInventory === undefined ? undefined : normalizeCaseInventory(value.caseInventory);
  if (categories.includes('new-test-failure') && (!caseInventory || value.allowEvidenceReuse !== true)) {
    fail('Failed-test review requires an independently approved caseInventory and explicit allowEvidenceReuse: true. Observations remain failed; each transition needs its own review.', 'TRP_RISK_ADAPTER_UNAVAILABLE');
  }
  if (value.allowEvidenceReuse === true && !categories.includes('new-test-failure')) fail('Evidence reuse is supported only for explicitly enabled, independently inventoried native Node failure review.', 'TRP_EVIDENCE_REUSE_UNAVAILABLE');
  return {
    enabled: value.enabled, riskAuthorities: authorities, enabledRiskCategories: categories,
    maxRiskDays: integer('maxRiskDays', 30, 1, 30),
    maxDistinctAutomaticAttempts: integer('maxDistinctAutomaticAttempts', 3, 0, 3),
    allowEvidenceReuse: value.allowEvidenceReuse ?? false,
    maxEvidenceAgeSeconds: integer('maxEvidenceAgeSeconds', 86400, 1, 2592000),
    ...(caseInventory ? { caseInventory } : {})
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
  const riskObligations = [];
  if (policy.enabledRiskCategories.length) {
    if (rows.length !== 1) blockers.push('Test-risk review currently requires one code-bearing repository.');
    for (const phase of phases) {
      const commands = (phase.qualityCommands ?? []).filter(isTestQualityCommand);
      if (!phaseRequiresCodeDelivery(phase)) {
        if (commands.length) blockers.push(`Phase '${phase.id}' runs tests outside the qualified code-delivery risk adapter.`);
        continue;
      }
      if (commands.length !== 1 || commands[0]?.kind !== 'test' || typeof commands[0]?.id !== 'string'
          || !commands[0].id.trim() || /[\x00-\x1f\x7f]/u.test(commands[0].id)) {
        blockers.push(`Phase '${phase.id}' needs exactly one explicitly named structured test command for test-risk review.`);
        continue;
      }
      const commandId = commands[0].id;
      if (policy.enabledRiskCategories.includes('new-test-failure')) {
        const command = commands[0];
        const inventory = policy.caseInventory.find(entry => entry.phaseId === phase.id && entry.commandId === commandId);
        if (!inventory) blockers.push(`Phase '${phase.id}' needs an independently approved case inventory for '${commandId}'.`);
        if (!Array.isArray(command.argv) || command.argv[1] !== '--test' || command.argv[2] !== '--test-reporter=junit'
            || command.argv.length < 4 || command.result?.adapter !== 'junit-xml') {
          blockers.push(`Phase '${phase.id}' needs direct native Node --test --test-reporter=junit with explicit files for failed-test review.`);
        }
        if (selected.executionMode === 'all-configured') blockers.push('Failed-test review currently requires changed-and-affected selection with independently proven coverage. All-configured mode needs a qualified baseline coverage record; it cannot be inferred from a passing readiness summary.');
      }
      const existing = riskObligations.find(entry => entry.id === commandId);
      if (existing) existing.phaseIds.push(phase.id);
      else riskObligations.push({ id: commandId, kind: 'test', nonWaivable: false,
        phaseIds: [phase.id], transitions: ['publish', 'submit', 'approve', 'downstream', 'replay'] });
    }
  }
  const policyAuthoritySha256 = trpDigest({ policy, authorities: definition.approvalAuthorities ?? {} });
  const core = { schemaVersion: 1, workId, workType, policy, policyAuthoritySha256, choices: selected,
    repositories: rows.map(row => ({ repository: row.repository, baseCommit: row.baseCommit,
      baselineStatus: row.baselineStatus, baselineDigest: row.baselineDigest, tools: row.tools })),
    phaseContractSha256: trpDigest(phaseContract) };
  return {
    schemaVersion: 1, enabled: true, supportedBaselineDispositions: ['fix'],
    supportedExecutionModes: MODES, supportedBaselineScopes: ['reuse'],
    acceptKnownFailuresEligible: false, ready: !blockers.length, planDigest: trpDigest(core),
    choices: selected, policy, policyAuthoritySha256, repositories: rows, blockers, riskObligations,
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
      mandatoryObligations: preview.policy.enabledRiskCategories.length ? preview.riskObligations
        : (repo.tools.length ? repo.tools : [{ id: 'repository-tests' }]).map(tool => ({
        id: tool.id.replace(/^[^A-Za-z0-9]+/u, '') || 'repository-tests', kind: 'test', nonWaivable: false,
        transitions: ['publish', 'submit', 'approve', 'replay']
      }))
    }))
  });
}
