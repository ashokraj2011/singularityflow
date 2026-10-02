/** Pure TRP selection and readiness-repair planning. This module never executes a runner. */
import path from 'node:path';
import { recordSha256 } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

const sha = (value) => `sha256:${recordSha256(value)}`;
const sorted = (values) => [...new Set(values)].sort();
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const BASELINE_BINDINGS = [
  'repositoryId', 'baseCommit', 'baseTree', 'sourceManifestSha256',
  'commandInventorySha256', 'dependencyManifestSha256', 'environmentSha256',
  'runnerSha256', 'adapterSha256'
];

function refuse(message, code = 'TEST_SELECTION_INVALID') {
  throw new SingularityFlowError(message, { code });
}

/** Normalize repository-relative paths independently of the machine running the preview. */
export function normalizeTestSelectionPath(value, { allowRoot = false } = {}) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/u.test(value)) {
    refuse('Test-selection paths must be nonempty repository-relative paths.');
  }
  const candidate = value.replaceAll('\\', '/');
  if (/^(?:\/|[a-z]:)/iu.test(candidate) || candidate.split('/').includes('..')) {
    refuse(`Test-selection path '${value}' is outside the repository.`);
  }
  const normalized = path.posix.normalize(candidate).replace(/^\.\//u, '').replace(/\/$/u, '');
  if (!normalized || (normalized === '.' && !allowRoot)) refuse(`Invalid test-selection path '${value}'.`);
  return normalized || '.';
}

function covers(root, value) { return root === '.' || value === root || value.startsWith(`${root}/`); }
function launcher(value) { return path.posix.basename(String(value).replaceAll('\\', '/')).replace(/\.(?:exe|cmd|bat)$/iu, '').toLowerCase(); }

/** Only direct, understood runners prove selector forwarding; an npm script is not such proof. */
export function testSelectorCapabilities(command) {
  const argv = command?.argv;
  if (!Array.isArray(argv) || !argv.length || argv.some((entry) => typeof entry !== 'string' || entry.includes('\0'))) {
    return { adapter: 'unsupported', fileSelection: false, caseSelection: false, reason: 'invalid-command' };
  }
  const executable = launcher(argv[0]);
  if (executable === 'node' && argv.includes('--test')) {
    return { adapter: 'node-test-files', fileSelection: true, caseSelection: false, start: 1 };
  }
  if (executable === 'pytest' || executable === 'py.test') {
    return { adapter: 'module-suite', fileSelection: false, caseSelection: false, reason: 'pytest-collection-inputs-unbound' };
  }
  const module = argv.indexOf('-m');
  if (/^(?:python\d*(?:\.\d+)*|py)$/u.test(executable) && module > 0 && argv[module + 1] === 'pytest'
      && argv.slice(1, module).every((entry) => ['-B', '-3', '-I', '-s', '-E', '-u'].includes(entry))) {
    // PYTEST_ADDOPTS and configuration addopts can prepend additional positional test roots.
    // An explicit file argument is therefore not proof of a bounded cohort in this pilot.
    return { adapter: 'module-suite', fileSelection: false, caseSelection: false, reason: 'pytest-collection-inputs-unbound' };
  }
  if (executable === 'jest') return { adapter: 'jest-files', fileSelection: true, caseSelection: false, start: 1 };
  return { adapter: 'module-suite', fileSelection: false, caseSelection: false, reason: 'precise-selector-unavailable' };
}

const SELECTOR_OPTIONS = {
  'node-test-files': {
    flags: ['--test', '--experimental-test-coverage', '--no-warnings', '--enable-source-maps', '--test-force-exit'],
    values: ['--test-reporter', '--test-reporter-destination', '--test-concurrency', '--test-timeout']
  },
  'jest-files': {
    flags: ['--json', '--ci', '--runInBand', '--silent', '--coverage', '--runTestsByPath', '--watch=false', '--watchAll=false'],
    values: ['--outputFile', '--config', '--reporters', '--maxWorkers', '--testTimeout', '--coverageDirectory']
  }
};

/** Replace existing positional selectors, preserving only understood runner options. */
export function selectTestCommandFiles(command, files) {
  const capability = testSelectorCapabilities(command);
  if (!capability.fileSelection || !files.length) return null;
  const options = SELECTOR_OPTIONS[capability.adapter];
  const argv = command.argv.slice(0, capability.start);
  for (let index = capability.start; index < command.argv.length; index += 1) {
    const argument = command.argv[index];
    if (argument === '--') break;
    if (!argument.startsWith('-')) continue;
    if (options.flags.includes(argument)) { argv.push(argument); continue; }
    const name = argument.split('=')[0];
    if (!options.values.includes(name)) return null;
    argv.push(argument);
    if (!argument.includes('=')) {
      const value = command.argv[++index];
      if (value == null || value.startsWith('-')) return null;
      argv.push(value);
    }
  }
  const cwd = normalizeTestSelectionPath(command.workingDirectory ?? '.', { allowRoot: true });
  const selectors = sorted(files.map((file) => {
    const relative = normalizeTestSelectionPath(file);
    if (!covers(cwd, relative)) refuse(`Selected test '${relative}' lies outside command '${command.id}' working directory.`);
    const local = path.posix.relative(cwd, relative);
    // Globs and pytest's node-id delimiter have framework semantics even in structured argv.
    if (!local || /[*?\[\]{}]/u.test(local) || local.includes('::')) refuse(`Test path '${relative}' cannot be selected literally.`);
    return `./${local}`;
  }));
  if (capability.adapter === 'jest-files' && !argv.includes('--runTestsByPath')) argv.push('--runTestsByPath');
  argv.push('--', ...selectors);
  return { ...structuredClone(command), argv, selectionAdapter: capability.adapter };
}

function commandInventory(commands) {
  const seen = new Set();
  return commands.filter((command) => command?.kind === 'test').map((command) => {
    if (typeof command.id !== 'string' || !command.id || seen.has(command.id)) refuse('Test command IDs must be present and unique.');
    if (!Array.isArray(command.argv) || !command.argv.length || command.argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
      refuse(`Test command '${command.id}' has invalid argv.`);
    }
    seen.add(command.id);
    return {
      ...structuredClone(command),
      workingDirectory: normalizeTestSelectionPath(command.workingDirectory ?? '.', { allowRoot: true }),
      affectedRoots: sorted((command.affectedRoots ?? [command.workingDirectory ?? '.']).map((root) => normalizeTestSelectionPath(root, { allowRoot: true })))
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function inventoryEntries(entries, commands) {
  const ids = new Set();
  return entries.map((entry) => {
    if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) refuse('Test identities must be nonempty and unambiguous.');
    ids.add(entry.id);
    if (!commands.some((command) => command.id === entry.commandId)) refuse(`Test '${entry.id}' names an unknown command.`);
    return {
      id: entry.id, path: normalizeTestSelectionPath(entry.path), commandId: entry.commandId,
      moduleRoot: normalizeTestSelectionPath(entry.moduleRoot ?? '.', { allowRoot: true }),
      sourcePaths: sorted((entry.sourcePaths ?? []).map((value) => normalizeTestSelectionPath(value))),
      requirementIds: sorted(entry.requirementIds ?? []), semanticsSha256: entry.semanticsSha256 ?? null
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

/** Coverage is knowledge, not consent. Authentication must come from the caller's evidence verifier. */
export function assessTestBaselineCoverage({ baseline, bindings, selectedTests = [], inventoryComplete = false, selectedCommandIds = [] } = {}) {
  const mismatch = BASELINE_BINDINGS.filter((key) => !bindings?.[key] || baseline?.bindings?.[key] !== bindings[key]);
  const authenticated = baseline?.authenticated === true;
  const completeIdentities = baseline?.identitiesComplete === true;
  const observations = new Map();
  let ambiguous = false;
  for (const entry of baseline?.tests ?? []) {
    if (!entry.id || observations.has(entry.id)) ambiguous = true;
    observations.set(entry.id, entry);
  }
  const reasons = [
    ...(!baseline ? ['baseline-unavailable'] : []),
    ...(!authenticated ? ['baseline-not-authenticated'] : []),
    ...(!completeIdentities ? ['baseline-identities-incomplete'] : []),
    ...(ambiguous ? ['baseline-identities-ambiguous'] : []),
    ...mismatch.map((key) => `baseline-binding-mismatch:${key}`)
  ];
  const compatible = reasons.length === 0;
  const known = []; const unknown = [];
  for (const entry of selectedTests) {
    const observed = observations.get(entry.id);
    if (compatible && observed && ['passed', 'failed', 'skipped'].includes(observed.outcome)
        && DIGEST.test(entry.semanticsSha256 ?? '') && observed.semanticsSha256 === entry.semanticsSha256) known.push(entry.id);
    else unknown.push(entry.id);
  }
  const unknownCommands = inventoryComplete ? [] : sorted(selectedCommandIds);
  return {
    status: unknown.length || unknownCommands.length || !compatible ? (known.length ? 'partial' : 'unknown') : 'complete',
    knownTestIds: sorted(known), unknownTestIds: sorted(unknown), unknownCommandIds: unknownCommands,
    preexistingFailureClassificationComplete: compatible && inventoryComplete && unknown.length === 0,
    extensionRequired: unknown.length > 0 || unknownCommands.length > 0,
    extensionBaseCommit: bindings?.baseCommit ?? null, extensionBaseTree: bindings?.baseTree ?? null,
    reasons, baselineSha256: baseline?.baselineSha256 ?? null
  };
}

/**
 * Return an immutable-cohort preview. `confirmation` is an exact plan digest, never human identity
 * or risk authority. Callers enforce their governed decision channel before accepting it.
 */
export function planTestSelection({ agreement, repositoryId, commands = [], candidate = {}, testInventory = [],
  inventoryComplete = false, bindings = {}, baseline = null, confirmation = null, impact = {}, applicable = true } = {}) {
  const repository = agreement?.repositories?.find((entry) => entry.repositoryId === repositoryId);
  if (!repository) refuse(`No effective test agreement exists for repository '${repositoryId}'.`, 'TEST_POLICY_REQUIRED');
  const execution = { ...repository.execution };
  if (execution.mode === 'all-configured') execution.mode = 'all';
  if (execution.mode === 'not-applicable' && !applicable) execution.mode = 'changed-and-affected';
  if (!['all', 'changed-and-affected'].includes(execution?.mode)) refuse('Test scope must explicitly be all-configured or changed-and-affected.');
  for (const field of ['moduleExpansion', 'fullSuiteExpansion']) {
    if (!['allow', 'confirm', 'deny'].includes(execution[field])) refuse(`An explicit ${field} rule is required.`);
  }
  const configured = commandInventory(commands);
  const inventory = inventoryEntries(testInventory, configured);
  const delta = (candidate.delta ?? []).map((entry) => ({
    status: entry.status ?? 'modified', path: normalizeTestSelectionPath(entry.path ?? entry.newPath ?? entry.oldPath),
    ...(entry.oldPath ? { oldPath: normalizeTestSelectionPath(entry.oldPath) } : {})
  })).sort((left, right) => left.path.localeCompare(right.path) || left.status.localeCompare(right.status));
  const changed = sorted(delta.flatMap((entry) => [entry.path, ...(entry.oldPath ? [entry.oldPath] : [])]));
  const selected = new Map(); const modules = new Map(); const uncovered = []; const blockers = [];
  const add = (entry, reason) => selected.set(entry.id, { ...entry, reasons: sorted([...(selected.get(entry.id)?.reasons ?? []), reason]) });
  const expand = (commandId, reason) => modules.set(commandId, sorted([...(modules.get(commandId) ?? []), reason]));
  if (applicable && execution.mode === 'all') {
    for (const entry of inventory) add(entry, 'all-configured-tests');
    for (const command of configured) expand(command.id, 'all-configured-tests');
  } else if (applicable) {
    for (const changedPath of changed) {
      const changedTests = inventory.filter((entry) => entry.path === changedPath);
      const linked = inventory.filter((entry) => entry.sourcePaths.some((source) => covers(source, changedPath)));
      for (const entry of changedTests) add(entry, `changed-test:${changedPath}`);
      for (const entry of linked) add(entry, `affected-source:${changedPath}`);
      if (changedTests.length || linked.length) continue;
      if ((impact.unaffectedPaths ?? []).includes(changedPath) && impact.complete === true) continue;
      const owners = configured.filter((command) => command.affectedRoots.some((root) => covers(root, changedPath)));
      if (!owners.length) uncovered.push({ path: changedPath, reason: 'no-test-or-module-mapping' });
      for (const command of owners) {
        expand(command.id, `affected-module:${changedPath}`);
        for (const entry of inventory.filter((item) => item.commandId === command.id)) add(entry, `affected-module:${changedPath}`);
      }
    }
    for (const requirement of impact.requirementIds ?? []) {
      const linked = inventory.filter((entry) => entry.requirementIds.includes(requirement));
      if (!linked.length) uncovered.push({ requirementId: requirement, reason: 'requirement-test-mapping-unavailable' });
      linked.forEach((entry) => add(entry, `affected-requirement:${requirement}`));
    }
    for (const id of repository.knownFailureSentinelIds ?? []) {
      const entry = inventory.find((item) => item.id === id);
      if (!entry) uncovered.push({ testId: id, reason: 'known-failure-sentinel-unavailable' });
      else add(entry, 'known-failure-sentinel');
    }
  }
  const exclusions = (repository.exclusions ?? []).map((entry) => ({
    testId: entry.testId, decisionRef: entry.decisionRef ?? null, outcome: 'not-run-known-failure'
  }));
  // File selection cannot safely omit an individual case. Keep this unsupported capability visible.
  if (exclusions.length) blockers.push({ code: 'TEST_EXCLUSION_UNSUPPORTED', reason: 'No enabled selector supports authenticated exact case exclusions.' });
  if (uncovered.length) blockers.push({ code: 'TEST_IMPACT_UNCOVERED', reason: 'Changed paths or requirements have no verified test coverage.' });
  if (impact.complete === false && applicable) blockers.push({ code: 'TEST_IMPACT_INCOMPLETE', reason: 'Impact analysis is incomplete; review the uncovered scope.' });

  const planned = []; const expansions = [];
  for (const command of configured) {
    const entries = [...selected.values()].filter((entry) => entry.commandId === command.id);
    if (!entries.length && !modules.has(command.id)) continue;
    let resolved = execution.mode === 'all' || modules.has(command.id) ? null : selectTestCommandFiles(command, entries.map((entry) => entry.path));
    if (resolved) {
      // Selecting a file executes every case in that file, which belongs in the sealed cohort.
      const files = new Set(entries.map((entry) => entry.path));
      for (const entry of inventory.filter((item) => item.commandId === command.id && files.has(item.path))) add(entry, 'selected-file');
    } else {
      for (const entry of inventory.filter((item) => item.commandId === command.id)) add(entry, 'module-suite');
      resolved = { ...structuredClone(command), selectionAdapter: 'module-suite' };
      if (execution.mode !== 'all') expansions.push({
        commandId: command.id, roots: command.affectedRoots,
        reasons: modules.get(command.id) ?? ['precise-selector-unavailable']
      });
    }
    planned.push(resolved);
  }
  // A precise file selector can still execute the whole approved cohort. Only an independently
  // complete inventory proves that fact; matching every entry in a partial/file-only inventory
  // cannot manufacture full-suite knowledge. Whole configured-command expansion remains an
  // independent scope proof even when exact testcase identities are unavailable.
  const completeCohortSelected = inventoryComplete === true && inventory.length > 0
    && inventory.every((entry) => selected.has(entry.id));
  const allCommandsExpanded = expansions.length > 0 && configured.length > 0
    && configured.every((command) => planned.some((entry) => entry.id === command.id && entry.selectionAdapter === 'module-suite'));
  const fullSuiteEquivalent = applicable && execution.mode !== 'all'
    && (completeCohortSelected || allCommandsExpanded);
  const requiredConfirmation = [];
  if (fullSuiteEquivalent || expansions.length) {
    const rule = fullSuiteEquivalent ? execution.fullSuiteExpansion : execution.moduleExpansion;
    const category = fullSuiteEquivalent ? 'full-suite-expansion' : 'module-expansion';
    if (rule === 'deny') blockers.push({ code: 'TEST_EXPANSION_DENIED', reason: category });
    if (rule === 'confirm') requiredConfirmation.push(category);
  }
  if (applicable && planned.length === 0) blockers.push({ code: 'TEST_SELECTION_EMPTY', reason: 'An empty cohort cannot satisfy a test obligation.' });
  const selectedTests = [...selected.values()].sort((left, right) => left.id.localeCompare(right.id));
  const exactBindings = {
    ...structuredClone(bindings), repositoryId,
    baseCommit: candidate.baseCommit ?? bindings.baseCommit ?? null,
    baseTree: candidate.baseTree ?? bindings.baseTree ?? null,
    sourceManifestSha256: candidate.sourceManifestSha256 ?? bindings.sourceManifestSha256 ?? null,
    commandInventorySha256: sha(configured), testInventorySha256: sha(inventory),
    policySha256: agreement.recordSha256 ?? agreement.agreementSha256 ?? sha(agreement), generation: candidate.generation ?? null,
    validationEpoch: candidate.validationEpoch ?? null, candidateSha256: sha(candidate)
  };
  const baselineCoverage = assessTestBaselineCoverage({ baseline, bindings: {
    ...exactBindings,
    sourceManifestSha256: candidate.baseSourceManifestSha256 ?? bindings.baseSourceManifestSha256 ?? exactBindings.sourceManifestSha256
  }, selectedTests, inventoryComplete, selectedCommandIds: planned.map((command) => command.id) });
  const missingBindings = BASELINE_BINDINGS.filter((key) => {
    const value = exactBindings[key];
    if (key === 'repositoryId') return typeof value !== 'string' || !value;
    if (key === 'baseCommit' || key === 'baseTree') return !/^[a-f0-9]{40,64}$/u.test(value ?? '');
    return !DIGEST.test(value ?? '');
  });
  if (applicable && missingBindings.length) blockers.push({ code: 'TEST_SELECTION_BINDINGS_REQUIRED',
    reason: `Exact execution bindings are unavailable: ${missingBindings.join(', ')}.` });
  const manifest = {
    schemaVersion: 1, kind: 'test-selection-manifest', repositoryId,
    requestedMode: execution.mode, effectiveMode: !applicable ? 'not-applicable' : execution.mode === 'all' || fullSuiteEquivalent ? 'all' : 'changed-and-affected',
    scopeLabel: fullSuiteEquivalent ? 'This expansion runs the full configured suite' : execution.mode === 'all' ? 'All configured tests' : 'Changed and affected tests',
    bindings: exactBindings, candidateDelta: delta, selectedTests,
    commandSelections: planned.map((command) => ({
      commandId: command.id, argv: command.argv, workingDirectory: command.workingDirectory,
      selectionAdapter: command.selectionAdapter, affectedRoots: command.affectedRoots,
      result: command.result ?? null, commandSha256: sha(command)
    })),
    inventoryComplete, expansions, fullSuiteEquivalent, exclusions, uncovered,
    baselineCoverage, requiredConfirmation
  };
  const selectionSha256 = sha(manifest);
  if (requiredConfirmation.length && confirmation !== selectionSha256) blockers.push({
    code: confirmation ? 'TEST_SELECTION_CONFIRMATION_STALE' : 'TEST_SELECTION_CONFIRMATION_REQUIRED',
    reason: fullSuiteEquivalent ? 'Confirm the exact full configured suite expansion.' : 'Confirm the exact owning-module expansion.'
  });
  return {
    manifest: { ...manifest, selectionSha256 }, planDigest: selectionSha256, commands: planned,
    blockers, requiredConfirmation, ready: blockers.length === 0, observedOutcome: applicable ? 'not-run' : 'not-applicable'
  };
}

/** Validate cohort identity before comparing known failures. A lower failure count is not proof. */
export function compareSelectedTestObservations({ expectedTests = [], baselineTests = [], currentTests = [] } = {}) {
  const issues = []; const baseline = new Map(); const current = new Map();
  for (const [label, entries, target] of [['baseline', baselineTests, baseline], ['current', currentTests, current]]) {
    for (const entry of entries) {
      if (!entry.id || target.has(entry.id)) issues.push({ code: 'TEST_IDENTITY_AMBIGUOUS', source: label, testId: entry.id ?? null });
      target.set(entry.id, entry);
    }
  }
  const knownFailureIds = []; const newFailureIds = []; const repairedTestIds = [];
  for (const expected of expectedTests) {
    const previous = baseline.get(expected.id); const observed = current.get(expected.id);
    if (!observed) { issues.push({ code: 'TEST_EXPECTED_MISSING', testId: expected.id }); continue; }
    if (!DIGEST.test(expected.semanticsSha256 ?? '') || observed.semanticsSha256 !== expected.semanticsSha256
        || (previous && previous.semanticsSha256 !== expected.semanticsSha256)) {
      issues.push({ code: 'TEST_SEMANTICS_CHANGED_OR_UNKNOWN', testId: expected.id }); continue;
    }
    if (observed.outcome === 'skipped' && previous?.outcome !== 'skipped') issues.push({ code: 'TEST_NEW_SKIP', testId: expected.id });
    if (!['passed', 'failed', 'skipped'].includes(observed.outcome)) issues.push({ code: 'TEST_OUTCOME_UNAVAILABLE', testId: expected.id });
    if (observed.outcome === 'failed') {
      if (previous?.outcome === 'failed' && (!previous.causeSha256 || observed.causeSha256 === previous.causeSha256)) knownFailureIds.push(expected.id);
      else newFailureIds.push(expected.id);
    } else if (observed.outcome === 'passed' && previous?.outcome === 'failed') repairedTestIds.push(expected.id);
  }
  const expectedIds = new Set(expectedTests.map((entry) => entry.id));
  for (const entry of currentTests) if (!expectedIds.has(entry.id)) issues.push({ code: 'TEST_UNEXPECTED_OBSERVATION', testId: entry.id });
  return { comparable: issues.length === 0, issues, knownFailureIds: sorted(knownFailureIds), newFailureIds: sorted(newFailureIds), repairedTestIds: sorted(repairedTestIds) };
}

/** Admission establishes obligations only; the caller verifies decisions and transaction durability. */
export function evaluateReadinessRepairAdmission({ repositories = [], repairCheckpoints = [], dispositionAuthorizations = [] } = {}) {
  const obligations = []; const blockers = []; const featureBases = [];
  for (const repository of repositories) {
    if (repository.required === false || repository.testApplicable === false) continue;
    const checkpoint = repairCheckpoints.find((entry) => entry.repositoryId === repository.repositoryId);
    const original = repository.baseline;
    const originalIds = (original?.tests ?? []).map((entry) => ({ id: entry.id, semanticsSha256: entry.semanticsSha256 }));
    const dispositionValid = ['fix', 'accept-known-failures'].includes(repository.baselineDisposition);
    const baselinePassed = original?.authenticated === true && original?.outcome === 'passed'
      && original?.identitiesComplete === true && originalIds.length > 0
      && original.tests.every((entry) => entry.outcome === 'passed');
    const fixRequired = repository.baselineDisposition === 'fix' && !baselinePassed;
    const authorization = dispositionAuthorizations.find((entry) => entry.repositoryId === repository.repositoryId
      && entry.verified === true && entry.durable === true && entry.agreementSha256 === repository.agreementSha256
      && entry.baselineSha256 === original?.baselineSha256 && entry.permittedTransition === 'feature-coding');
    const comparison = checkpoint ? compareSelectedTestObservations({ expectedTests: originalIds, baselineTests: original?.tests, currentTests: checkpoint.tests }) : null;
    const checkpointValid = Boolean(checkpoint?.authenticated && checkpoint.committed === true && checkpoint.commit
      && original?.authenticated === true && original?.identitiesComplete === true && originalIds.length
      && checkpoint.originalBaselineSha256 === original?.baselineSha256 && checkpoint.originalBaseCommit === repository.originalBaseCommit
      && checkpoint.outcome === 'passed' && checkpoint.processExitCode === 0 && checkpoint.identitiesComplete === true
      && checkpoint.baselineSha256 && comparison?.comparable && checkpoint.tests.every((entry) => entry.outcome === 'passed'));
    if (fixRequired && !checkpointValid && !authorization) {
      obligations.push({ repositoryId: repository.repositoryId, baselineSha256: original?.baselineSha256 ?? null,
        issueIds: sorted(repository.baselineIssueIds ?? []), purpose: 'readiness-repair',
        sourceEditRequired: false, featureAcceptanceTagsRequired: false,
        allowedKinds: ['dependency-configuration', 'test-infrastructure', 'documents', 'tests'],
        reviewedProductRepairPaths: (repository.reviewedProductRepairPaths ?? []).map((entry) => normalizeTestSelectionPath(entry)) });
      blockers.push({ code: 'READINESS_REPAIR_REQUIRED', repositoryId: repository.repositoryId,
        reason: original?.outcome === 'failed' ? 'Resolve the listed baseline failures before feature coding.' : 'Acquire and resolve the unknown baseline before feature coding.' });
    }
    if (!dispositionValid) blockers.push({ code: 'TEST_BASELINE_DISPOSITION_REQUIRED', repositoryId: repository.repositoryId,
      reason: 'Select and confirm the repository baseline disposition.' });
    if (repository.baselineDisposition === 'accept-known-failures' && !baselinePassed && !authorization) blockers.push({
      code: 'TEST_BASELINE_AUTHORIZATION_REQUIRED', repositoryId: repository.repositoryId,
      reason: 'A durable verified decision for this repository and baseline is required before feature coding.'
    });
    featureBases.push({ repositoryId: repository.repositoryId, originalBaseCommit: repository.originalBaseCommit ?? null,
      originalBaselineSha256: original?.baselineSha256 ?? null,
      featureBaseCommit: checkpointValid ? checkpoint.commit : repository.originalBaseCommit ?? null,
      featureBaselineSha256: checkpointValid ? checkpoint.baselineSha256 : original?.baselineSha256 ?? null,
      repairCheckpointPreserved: checkpointValid });
  }
  return { mayRecordStory: true, mayStartFeature: blockers.length === 0,
    purpose: obligations.length ? 'readiness-repair' : 'feature', obligations, blockers, featureBases };
}
