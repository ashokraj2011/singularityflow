/** TRP intake planning is read-only. Display defaults are never execution consent. */
import { trpDigest, sealTrpRecord, TRP_RISK_CATEGORIES } from './test-recovery-policy.mjs';
import { SingularityFlowError } from './util.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { isTestQualityCommand } from './delivery-evidence.mjs';
import { normalizeTestSelectionPath } from './test-selection-policy.mjs';
import path from 'node:path';
import { normalizeDocumentObligations } from './trp-document-policy.mjs';
import { baselineDeferralAllowed, baselineObservationPending } from './intake-baseline.mjs';

const MODES = ['changed-and-affected', 'all-configured'];
const fail = (message, code = 'TRP_POLICY_INVALID') => { throw new SingularityFlowError(message, { code }); };
const requiredNonTestPurposes = definition => {
  const policies = [definition?.repositoryReadiness, definition?.initialization?.proof?.preStory].filter(Boolean);
  return [['dependencyHydration', 'dependency'], ['build', 'build'], ['applicationStart', 'start']]
    .filter(([key]) => policies.some(policy => policy[key] === 'required')).map(([, purpose]) => purpose);
};

/** Independent approved identities, never an inventory inferred from a test report. */
function normalizeCaseInventory(value) {
  if (!Array.isArray(value) || !value.length || value.length > 64) fail('testRecovery.caseInventory needs 1–64 phase/command entries.');
  const entries = new Set();
  let total = 0;
  const ordinary = (text, max) => typeof text === 'string' && text.trim().length > 0
    && text === text.trim() && text.length <= max && !/[\x00-\x1f\x7f]/u.test(text);
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).some(key => !['phaseId', 'commandId', 'adapter', 'runtime', 'baselineMutableRoots', 'dependencyScope', 'tests'].includes(key))
        || !ordinary(entry.phaseId, 128) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.phaseId)
        || entry.phaseId.includes('..') || !ordinary(entry.commandId, 256)
        || !Array.isArray(entry.tests) || !entry.tests.length || (total += entry.tests.length) > 10_000) {
      fail('Invalid or oversized testRecovery.caseInventory entry.');
    }
    const adapter = entry.adapter ?? 'node-test-junit-v1';
    if (!['node-test-junit-v1', 'pytest-junit-v1', 'maven-surefire-junit-v1'].includes(adapter)) fail('Unsupported approved testcase adapter.');
    const node = adapter === 'node-test-junit-v1';
    if (entry.dependencyScope !== (node ? 'repository-and-node-builtins-only' : 'repository-and-declared-runtime-only')) fail('Approved testcase dependency scope does not match its runner.');
    let runtime;
    if (node) {
      if (entry.runtime !== undefined) fail('Native Node inventory uses the current qualified Node runtime, not a declared external runtime.');
    } else {
      runtime = entry.runtime;
      if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)
          || Object.keys(runtime).some(key => !['executableSha256', 'dependencyRoots'].includes(key))
          || !/^sha256:[a-f0-9]{64}$/u.test(runtime.executableSha256 ?? '')
          || !Array.isArray(runtime.dependencyRoots) || !runtime.dependencyRoots.length || runtime.dependencyRoots.length > 8
          || new Set(runtime.dependencyRoots).size !== runtime.dependencyRoots.length
          || runtime.dependencyRoots.some(root => !ordinary(root, 4096) || !path.isAbsolute(root) || path.normalize(root) !== root || root === path.parse(root).root)) {
        fail('Declared runtimes need an exact executable SHA-256 and 1–8 canonical, non-root absolute dependency roots.');
      }
      runtime = { executableSha256: runtime.executableSha256, dependencyRoots: [...runtime.dependencyRoots] };
    }
    const pair = JSON.stringify([entry.phaseId, entry.commandId]);
    if (entries.has(pair)) fail('Duplicate testRecovery.caseInventory phase/command.');
    entries.add(pair);
    const ids = new Set(); const identities = new Set(); const files = new Set();
    const tests = entry.tests.map(test => {
      if (!test || typeof test !== 'object' || Array.isArray(test)
          || Object.keys(test).some(key => !['id', 'path', 'name', 'className'].includes(key))
          || !ordinary(test.id, 256) || !ordinary(test.name, 4096) || !ordinary(test.path, 1024)
          || (!node && !ordinary(test.className, 4096)) || (node && test.className !== undefined)) {
        fail('Each approved test needs an exact ID, repository-relative path and native report name.');
      }
      let normalized;
      try { normalized = normalizeTestSelectionPath(test.path); } catch { fail('Approved test paths must be safe repository-relative paths.'); }
      if (normalized !== test.path || test.path.includes('\\')) fail('Approved test paths must use canonical forward slashes.');
      const identity = JSON.stringify([node ? test.path : test.className, test.name]);
      if (ids.has(test.id) || identities.has(identity)) fail('Approved test IDs and file/name pairs must be unique per command.');
      ids.add(test.id); identities.add(identity); files.add(test.path);
      return { id: test.id, path: test.path, name: test.name, ...(!node ? { className: test.className } : {}) };
    });
    if (files.size > 256) fail('Approved test inventory exceeds 256 files per command.');
    let baselineMutableRoots;
    if (entry.baselineMutableRoots !== undefined) {
      const roots = entry.baselineMutableRoots;
      if (!Array.isArray(roots) || !roots.length || roots.length > 16 || new Set(roots).size !== roots.length) fail('Baseline mutable source roots need 1–16 distinct repository directories.');
      baselineMutableRoots = roots.map(root => {
        let normalized;
        try { normalized = normalizeTestSelectionPath(root); } catch { fail('Baseline mutable roots must be canonical repository directories.'); }
        if (!ordinary(root, 1024) || root !== normalized || root.includes('\\') || root === '.'
          || /(?:^|\/)(?:\.git|singularity|node_modules|vendor|target|build|dist|tests?|fixtures?|config|configuration|\.venv|venv)(?:\/|$)/iu.test(root)
          || /\.[a-z0-9]+$/iu.test(root)
          || tests.some(test => test.path === root || test.path.startsWith(`${root}/`))) fail('Baseline mutable roots must exclude approved tests, fixtures, dependency, configuration and framework paths.');
        return root;
      });
      if (baselineMutableRoots.some((root, index) => baselineMutableRoots.some((other, otherIndex) => index !== otherIndex && root.startsWith(`${other}/`)))) fail('Baseline mutable source roots must not overlap.');
    }
    return { phaseId: entry.phaseId, commandId: entry.commandId, ...(entry.adapter ? { adapter } : {}),
      ...(runtime ? { runtime } : {}), ...(baselineMutableRoots ? { baselineMutableRoots } : {}), dependencyScope: entry.dependencyScope, tests };
  });
}

export function normalizeTestRecoveryPolicy(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('testRecovery must be an object.');
  const allowed = new Set(['enabled', 'riskAuthorities', 'enabledRiskCategories', 'maxRiskDays',
    'maxDistinctAutomaticAttempts', 'allowEvidenceReuse', 'maxEvidenceAgeSeconds', 'caseInventory', 'documentObligations']);
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
  const authorities = list('riskAuthorities', []);
  if (categories.length && !authorities.length) fail('Enabled risks require explicit testRecovery.riskAuthorities.');
  if (value.allowEvidenceReuse != null && typeof value.allowEvidenceReuse !== 'boolean') fail('testRecovery.allowEvidenceReuse must be boolean.');
  const caseInventory = value.caseInventory === undefined ? undefined : normalizeCaseInventory(value.caseInventory);
  const documentObligations = value.documentObligations === undefined ? undefined : normalizeDocumentObligations(value.documentObligations);
  if (categories.includes('nonessential-document') && !documentObligations?.length) fail('Nonessential-document review requires explicitly declared supplemental document obligations.');
  if (categories.some(category => ['new-test-failure', 'known-test-failure', 'reduced-coverage'].includes(category)) && (!caseInventory || value.allowEvidenceReuse !== true)) {
    fail('Failed-test review requires an independently approved caseInventory and explicit allowEvidenceReuse: true. Observations remain failed; each transition needs its own review.', 'TRP_RISK_ADAPTER_UNAVAILABLE');
  }
  if (value.allowEvidenceReuse === true && !categories.some(category => ['new-test-failure', 'known-test-failure', 'reduced-coverage'].includes(category))) fail('Evidence reuse is supported only for explicitly enabled, independently inventoried failed-test or reduced-coverage review.', 'TRP_EVIDENCE_REUSE_UNAVAILABLE');
  return {
    enabled: value.enabled, riskAuthorities: authorities, enabledRiskCategories: categories,
    maxRiskDays: integer('maxRiskDays', 30, 1, 30),
    maxDistinctAutomaticAttempts: integer('maxDistinctAutomaticAttempts', 3, 0, 3),
    allowEvidenceReuse: value.allowEvidenceReuse ?? false,
    maxEvidenceAgeSeconds: integer('maxEvidenceAgeSeconds', 86400, 1, 2592000),
    ...(caseInventory ? { caseInventory } : {}), ...(documentObligations ? { documentObligations } : {})
  };
}

export function testRecoveryChoices(options = {}) {
  const baselineRecords = options['test-baseline-record'];
  return {
    baselineDisposition: options['test-baseline-disposition'] ?? 'fix',
    executionMode: options['test-execution-mode'] ?? 'changed-and-affected',
    baselineScope: options['test-baseline-scope'] ?? 'reuse',
    ...(baselineRecords !== undefined ? { baselineRecords: Array.isArray(baselineRecords) ? baselineRecords : [baselineRecords] } : {}),
    ...(options['test-baseline-reason'] !== undefined ? { reason: options['test-baseline-reason'] } : {}),
    ...(options['test-baseline-owner'] !== undefined ? { followUpOwner: options['test-baseline-owner'] } : {}),
    ...(options['test-baseline-remediation'] !== undefined ? { remediationRef: options['test-baseline-remediation'] } : {}),
    ...(options['test-baseline-expires-at'] !== undefined ? { expiresAt: options['test-baseline-expires-at'] } : {})
  };
}

/** Local authentication is deliberately outside the serializable preview contract. */
export async function prepareTestRecoveryIntake(root, args = {}) {
  const refs = args.choices?.baselineRecords ?? [];
  const baselineEvidence = [];
  const evidenceErrors = [];
  const nonTestReadiness = [];
  const requiredPurposes = args.choices?.baselineDisposition === 'accept-known-failures'
    ? requiredNonTestPurposes(args.definition) : [];
  if (requiredPurposes.length) {
    const { buildRepositoryReadinessPlan, inspectRepositoryReadinessReceipt, loadRepositoryTestBaseline } = await import('./initialization/runtime-readiness.mjs');
    const scope = requiredPurposes.some(purpose => purpose !== 'dependency') ? 'full' : 'dependency-test';
    for (const repository of args.repositories ?? []) {
      const repositoryId = repository.id ?? repository.repository;
      try {
        if (args.repositories.length !== 1) throw new Error('An exact local readiness boundary is required.');
        let evidenceRoot = root;
        if (args.isolatedWorktree === true) {
          const { preparedStoryWorktreePath } = await import('./story-worktree.mjs');
          evidenceRoot = await preparedStoryWorktreePath(root, args.workId, { baseCommit: repository.baseCommit });
          if (!evidenceRoot) throw new Error('The reviewed managed checkout does not exist.');
        }
        const inspected = await inspectRepositoryReadinessReceipt(evidenceRoot, {
          commit: repository.baseCommit, scope, recompute: true
        });
        // A newer failed readiness baseline supersedes an older passing receipt at the same
        // commit. Never resurrect the old non-test pass if that failed baseline is incompatible.
        const loaded = await loadRepositoryTestBaseline(evidenceRoot, { commit: repository.baseCommit, scope });
        let evidence = !loaded && inspected.status === 'pass' ? inspected.receipt : null;
        let baselineSha256 = null;
        if (!evidence) {
          // A genuine failed readiness run may still prove its independent dependency,
          // build and start checks. Never require the tests to pass merely to review them.
          if (loaded) {
            const baseline = loaded.baseline;
            const currentPlan = await buildRepositoryReadinessPlan(evidenceRoot, { scope });
            const nonTests = currentPlan.commands.filter(command => command.purpose !== 'test');
            if (currentPlan.status === 'ready' && baseline.status === 'failing-tests' && baseline.sourceTrackedOnly === true
              && baseline.sourceCommit === repository.baseCommit && currentPlan.sourceCommit === repository.baseCommit
              && baseline.planId === currentPlan.planId && baseline.sourceManifestSha256 === currentPlan.sourceManifestSha256
              && baseline.repositoryFingerprint === currentPlan.repositoryFingerprint
              && baseline.commandResults.every(result => result.purpose === 'test' || result.status === 'pass')
              && nonTests.every(command => baseline.commandResults.filter(result => result.id === command.id
                && result.purpose === command.purpose && result.status === 'pass').length === 1)) {
              evidence = baseline; baselineSha256 = baseline.baselineSha256;
            }
          }
        }
        const passed = new Set((evidence?.commandResults ?? []).filter(result => result.status === 'pass').map(result => result.purpose));
        if (!evidence || evidence.sourceCommit !== repository.baseCommit
          || requiredPurposes.some(purpose => !passed.has(purpose))) throw new Error('No current native readiness evidence proves every required non-test prerequisite passed.');
        nonTestReadiness.push({ repositoryId, sourceCommit: repository.baseCommit, scope,
          receiptSha256: evidence.receiptSha256 ?? null, baselineSha256, purposes: requiredPurposes });
      } catch (error) {
        evidenceErrors.push(`Repository ${repositoryId}: known-failure acceptance cannot replace required ${requiredPurposes.join(', ')} readiness. ${error.message}`);
      }
    }
  }
  if (refs.length) {
    if (!Array.isArray(refs) || refs.length > 64 || new Set(refs).size !== refs.length
      || refs.some(ref => !/^sha256:[a-f0-9]{64}$/u.test(ref))) fail('Select distinct exact baseline record digests.', 'TRP_INTAKE_BASELINE_INVALID');
    const { inspectTrpIntakeBaseline } = await import('./test-recovery-runtime.mjs');
    for (const recordSha256 of refs) {
      const repository = args.repositories?.length === 1 ? args.repositories[0] : null;
      if (!repository) { evidenceErrors.push('Baseline intake currently requires one exact repository.'); continue; }
      try {
        let evidenceRoot = root;
        if (args.isolatedWorktree === true) {
          const { preparedStoryWorktreePath } = await import('./story-worktree.mjs');
          evidenceRoot = await preparedStoryWorktreePath(root, args.workId, { baseCommit: repository.baseCommit });
          if (!evidenceRoot) throw new Error('Capture the baseline with --isolated-worktree first. Launch-checkout evidence cannot stand in for a native run in the Story checkout.');
        }
        const inspected = await inspectTrpIntakeBaseline(evidenceRoot, { recordSha256, workId: args.workId,
          repositoryId: repository.id ?? repository.repository, baseCommit: repository.baseCommit,
          definition: args.definition, workType: args.workType });
        if (inspected?.authenticated !== true || inspected.record?.recordSha256 !== recordSha256) throw new Error('Baseline host provenance is unavailable.');
        baselineEvidence.push(inspected.record);
      } catch (error) { evidenceErrors.push(`Baseline ${recordSha256}: ${error.message}`); }
    }
  }
  return previewTestRecoveryIntake({ ...args, baselineEvidence, evidenceErrors, nonTestReadiness });
}

export function previewTestRecoveryIntake({ definition, workId, workType, repositories = [],
  repositoryReadiness, choices = {}, phaseDefinitions = null, baselineEvidence = [], evidenceErrors = [], isolatedWorktree = false,
  nonTestReadiness = [] } = {}) {
  const policy = normalizeTestRecoveryPolicy(definition?.testRecovery);
  const phases = phaseDefinitions ?? (definition?.workTypes?.[workType]?.phases ?? [])
    .map(id => ({ id, ...definition.phases?.[id] }));
  const codeBearing = phases.some(phase => phaseRequiresCodeDelivery(phase)
    || phase.qualityCommands?.some(isTestQualityCommand));
  if (!policy?.enabled || (!codeBearing && !policy.documentObligations?.length)) return { schemaVersion: 1, enabled: false };
  const selected = { baselineDisposition: 'fix', executionMode: 'changed-and-affected', baselineScope: 'reuse', ...choices };
  const blockers = [...evidenceErrors];
  if (selected.executionMode === 'changed-and-affected' && phases.some(phase =>
    !phaseRequiresCodeDelivery(phase) && phase.qualityCommands?.some(isTestQualityCommand))) {
    blockers.push('This workflow has test commands outside code-delivery phases. The pilot cannot enforce affected selection there; choose all configured tests or use a supported workflow.');
  }
  if (phases.some(phase => phase.qualityCommands?.some(command => isTestQualityCommand(command)
    && (!command || typeof command !== 'object' || Array.isArray(command) || command.kind !== 'test')))) {
    blockers.push('Test policy requires structured test commands. Review legacy test commands in approved configuration before starting; their execution scope cannot be enforced by this pilot.');
  }
  if (!['fix', 'accept-known-failures'].includes(selected.baselineDisposition)) blockers.push('Select fix or accept-known-failures.');
  const accepting = selected.baselineDisposition === 'accept-known-failures';
  const requiredPurposes = accepting ? requiredNonTestPurposes(definition) : [];
  if (requiredPurposes.length && repositories.some(repository => !nonTestReadiness.some(receipt =>
    receipt.repositoryId === (repository.id ?? repository.repository) && receipt.sourceCommit === repository.baseCommit
      && requiredPurposes.every(purpose => receipt.purposes.includes(purpose))))) {
    blockers.push(`Known-failure acceptance requires current authenticated ${requiredPurposes.join(', ')} readiness; test risk cannot waive these prerequisites.`);
  }
  if (!accepting && (selected.baselineRecords?.length || ['reason', 'followUpOwner', 'remediationRef', 'expiresAt'].some(key => selected[key] !== undefined))) blockers.push('Baseline acceptance references and terms apply only to the explicit accept-known-failures disposition.');
  if (accepting && !policy.enabledRiskCategories.includes('known-test-failure')) blockers.push('The approved policy does not delegate known-test-failure acceptance.');
  if (accepting && ((selected.reason ?? '').trim().length < 15 || !(selected.followUpOwner ?? '').trim()
    || !(selected.remediationRef ?? '').trim())) blockers.push('Known-failure acceptance requires a substantive reason, follow-up owner and remediation reference.');
  if (accepting && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(selected.expiresAt ?? '')
    || !Number.isFinite(Date.parse(selected.expiresAt)) || Date.parse(selected.expiresAt) <= Date.now())) blockers.push('Choose a future UTC expiry for the reviewed baseline risk.');
  if (!MODES.includes(selected.executionMode)) blockers.push('Select changed-and-affected or all-configured tests.');
  if (selected.baselineScope !== 'reuse') blockers.push('Acquire a reviewed baseline with precheck --run first; intake does not execute tests.');
  const rows = repositories.map(repo => {
    const repositoryId = repo.id ?? repo.repository;
    const receipt = repositoryReadiness?.repositories?.[repositoryId];
    const valid = receipt?.sourceCommit === repo.baseCommit;
    const exactReceipt = valid ? receipt : null;
    const testConfigurationPending = !accepting && baselineObservationPending(exactReceipt)
      && baselineDeferralAllowed(definition, 'reuse', exactReceipt);
    const tools = valid ? receipt?.structuredTestContract?.commands ?? [] : [];
    const baselines = baselineEvidence.filter(record => record.subject.workId === workId
      && record.subject.repositoryId === repositoryId && record.preFeatureBase === repo.baseCommit);
    return {
      repository: repositoryId, baseCommit: repo.baseCommit,
      baselineStatus: valid ? receipt.status : 'unknown',
      testConfigurationPending,
      baselineDigest: valid ? receipt.baselineSha256 ?? receipt.receiptSha256 ?? null : null,
      baselineScope: valid ? receipt.scope : 'unknown',
      failures: (valid ? receipt.testObservations ?? [] : []).flatMap(observation =>
        (observation.failingCases ?? []).map(test => ({ id: test.fullName ?? test.name ?? 'unknown', suite: test.className ?? test.suite ?? observation.commandId }))),
      tools: tools.map(tool => ({ id: tool.id, runner: tool.launcher, cwd: tool.workingDirectory,
        adapter: tool.adapter, reportPath: tool.reportPath, source: 'exact-base-readiness' })),
      requestedScope: selected.executionMode, effectiveScope: 'planned at the candidate boundary',
      unknowns: testConfigurationPending ? ['Test configuration pending. Continue authoring; supply the command before required test execution. No baseline pass is claimed.']
        : valid && receipt.status === 'pass' ? [] : ['Feature coding requires baseline repair or a separately authorized decision.'],
      commands: [], selectedTests: [], exclusions: [], reasons: [],
      ...(baselines.length ? { baselineRecords: baselines } : {})
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
      for (const document of policy.documentObligations ?? []) if (document.phaseId === phase.id) {
        if (riskObligations.some(item => item.id === document.id && item.kind !== 'document')) blockers.push(`Document '${document.id}' conflicts with a test command obligation.`);
        const existing = riskObligations.find(item => item.id === document.id && item.kind === 'document');
        if (existing) existing.phaseIds.push(phase.id);
        else riskObligations.push({ id: document.id, kind: 'document', nonWaivable: false, phaseIds: [phase.id],
          transitions: ['publish', 'submit', 'approve', 'downstream', 'replay'] });
      }
      if (!policy.enabledRiskCategories.some(category => category !== 'nonessential-document')) continue;
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
      if (riskObligations.some(item => item.id === commandId && item.kind !== 'test')) blockers.push(`Test '${commandId}' conflicts with a document obligation.`);
      if (policy.enabledRiskCategories.some(category => ['new-test-failure', 'known-test-failure', 'reduced-coverage'].includes(category))) {
        const command = commands[0];
        const inventory = policy.caseInventory.find(entry => entry.phaseId === phase.id && entry.commandId === commandId);
        if (!inventory) blockers.push(`Phase '${phase.id}' needs an independently approved case inventory for '${commandId}'.`);
        if ((!inventory?.adapter || inventory.adapter === 'node-test-junit-v1')
          && (!Array.isArray(command.argv) || command.argv[1] !== '--test' || command.argv[2] !== '--test-reporter=junit'
            || command.argv.length < 4 || command.result?.adapter !== 'junit-xml')) {
          blockers.push(`Phase '${phase.id}' needs direct native Node --test --test-reporter=junit with explicit files for failed-test review.`);
        }
        if (selected.executionMode === 'all-configured' && !accepting && !policy.enabledRiskCategories.includes('reduced-coverage')) blockers.push('Failed-test review in all-configured mode needs a qualified baseline coverage record or a separately enabled reduced-coverage review; coverage cannot be inferred from a passing readiness summary.');
        if (accepting) {
          const matches = baselineEvidence.filter(record => record.subject.workId === workId && record.subject.phaseId === phase.id
            && record.obligationId === commandId && record.identityCompleteness === 'complete' && record.inventoryComplete
            && record.observedOutcome === 'failed' && record.counts.failed > 0 && !record.counts.skipped && !record.counts.notRun);
          if (matches.length !== 1) blockers.push(`Phase '${phase.id}' needs one authenticated complete failing baseline for '${commandId}'.`);
          else if (Date.parse(selected.expiresAt) > Date.parse(matches[0].createdAt) + policy.maxRiskDays * 86400000) blockers.push(`Baseline expiry exceeds the approved ${policy.maxRiskDays}-day maximum.`);
        }
      }
      const existing = riskObligations.find(entry => entry.id === commandId);
      if (existing) existing.phaseIds.push(phase.id);
      else riskObligations.push({ id: commandId, kind: 'test', nonWaivable: false,
        phaseIds: [phase.id], transitions: [...(accepting ? ['generation-admission'] : []), 'publish', 'submit', 'approve', 'downstream', 'replay'] });
    }
  }
  if ((policy.documentObligations ?? []).some(document => !phases.some(phase => phase.id === document.phaseId))) blockers.push('A supplemental document obligation names a phase outside this workflow.');
  if (accepting && baselineEvidence.some(record => !rows.some(row => row.repository === record.subject.repositoryId && row.baseCommit === record.preFeatureBase)
    || !riskObligations.some(obligation => obligation.kind === 'test' && obligation.id === record.obligationId && obligation.phaseIds.includes(record.subject.phaseId)))) blockers.push('Every baseline reference must match an exact required repository, phase and test obligation in this intake.');
  const policyAuthoritySha256 = trpDigest({ policy, authorities: definition.approvalAuthorities ?? {} });
  const core = { schemaVersion: 1, workId, workType, policy, policyAuthoritySha256, choices: selected,
    repositories: rows.map(row => ({ repository: row.repository, baseCommit: row.baseCommit,
      baselineStatus: row.baselineStatus, baselineDigest: row.baselineDigest, tools: row.tools,
      testConfigurationPending: row.testConfigurationPending,
      baselineRecordRefs: (row.baselineRecords ?? []).map(record => record.recordSha256) })),
    phaseContractSha256: trpDigest(phaseContract) };
  if (requiredPurposes.length) core.nonTestReadiness = nonTestReadiness;
  return {
    schemaVersion: 1, enabled: true, supportedBaselineDispositions: policy.enabledRiskCategories.includes('known-test-failure') ? ['fix', 'accept-known-failures'] : ['fix'],
    supportedExecutionModes: MODES, supportedBaselineScopes: ['reuse'],
    acceptKnownFailuresEligible: accepting && !blockers.length, ready: !blockers.length, planDigest: trpDigest(core),
    choices: selected, policy, policyAuthoritySha256, repositories: rows, blockers, riskObligations,
    ...(requiredPurposes.length ? { nonTestReadiness } : {}),
    unavailableReasons: { 'accept-known-failures': accepting && !blockers.length ? null : 'Requires explicitly delegated known-failure policy and authenticated exact baseline records. Local precheck acknowledgement is not authority.' },
    maturity: 'repair-selection-pilot',
    summary: 'Repair/selection pilot: record a bounded repair agreement. This does not run tests, waive a gate, or accept a risk.',
    route: accepting ? 'baseline-risk-publication' : rows.some(row => row.baselineStatus !== 'pass' && !row.testConfigurationPending) ? 'readiness-repair' : 'feature-coding',
    mandatoryChecks: ['Source and evidence integrity', 'Normal phase approvals'],
    legalActions: policy.enabledRiskCategories.includes('known-test-failure') && rows.length === 1
      ? phases.filter(phase => phaseRequiresCodeDelivery(phase) && phase.qualityCommands?.some(isTestQualityCommand)).map(phase => ({
        id: `inspect-baseline-${phase.id}`, label: `Inspect the exact pre-feature baseline command for ${phase.id}`,
        command: 'story', args: ['test-policy', 'baseline', workId, '--phase', phase.id,
          '--repository', rows[0].repository, '--base', rows[0].baseCommit, '--work-type', workType,
          ...(isolatedWorktree ? ['--isolated-worktree'] : []), '--json'],
        executed: false, requiresSeparateExecutionConfirmation: true
      })) : []
  };
}

export function confirmTestRecoveryIntake(preview, confirmation, options = {}) {
  if (!preview.enabled) {
    const riskOptions = ['test-baseline-disposition', 'test-baseline-scope', 'test-policy-confirm']
      .some(key => Object.hasOwn(options, key));
    if (riskOptions) fail('This workflow does not enable Story test policy. No Story was created.', 'TRP_NOT_ENABLED');
    if (Object.hasOwn(options, 'test-execution-mode') && !MODES.includes(options['test-execution-mode'])) {
      fail('Test execution mode must be changed-and-affected or all-configured.', 'TEST_POLICY_INVALID');
    }
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
  // Modern intake has no test baseline blocker to substitute. Its remaining repository
  // execution blocker is an explicit non-test prerequisite, never a test-risk exception.
  if (readiness?.repositoryExecution?.testing === 'advisory-at-intake') return readiness;
  if (!preview?.enabled || !preview.ready || !['fix', 'accept-known-failures'].includes(preview.choices.baselineDisposition)) return readiness;
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
      baselineDisposition: preview.choices.baselineDisposition, baselineScope: repo.baselineRecords?.length ? 'all-configured' : 'unknown',
      baselineRefs: (repo.baselineRecords ?? []).map(record => record.recordSha256), riskDecisionRefs: [],
      execution: { mode: preview.choices.executionMode, moduleExpansion: 'confirm', fullSuiteExpansion: 'confirm', knownFailureHandling: 'observe' },
      mandatoryObligations: preview.policy.enabledRiskCategories.length ? preview.riskObligations
        : (repo.tools.length ? repo.tools : [{ id: 'repository-tests' }]).map(tool => ({
        id: tool.id.replace(/^[^A-Za-z0-9]+/u, '') || 'repository-tests', kind: 'test', nonWaivable: false,
        transitions: ['publish', 'submit', 'approve', 'replay']
      }))
    }))
  });
}
