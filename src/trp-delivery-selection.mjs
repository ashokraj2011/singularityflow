/** Resolve a pinned TRP delivery cohort without executing repository commands. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applicationPathContext, isApplicationChangeEntry } from './application-paths.mjs';
import { isExecutableTestSourcePath, normalizeRequiredTestCommand } from './code-delivery-tests.mjs';
import { isTestQualityCommand } from './delivery-evidence.mjs';
import { planTestSelection, normalizeTestSelectionPath } from './test-selection-policy.mjs';
import { sealTrpRecord, trpDigest, validateTrpRecord } from './test-recovery-policy.mjs';
import { appendTrpRecord, loadTrpAuthorityVerifier, readTrpRecord } from './test-recovery-store.mjs';
import { exactRemoteBranchObservationAsync, governedCommitIdentity } from './git.mjs';
import { runRemoteGitAsync } from './git-execution.mjs';
import { withoutGitProcessOverrides } from './git-enterprise-environment.mjs';
import { executeGitQuery } from './git-query.mjs';
import { redactDiagnosticText } from './git-remote-diagnostics.mjs';
import { processResultSucceeded } from './process-result.mjs';
import { nowIso, secureRepositoryPath, SingularityFlowError } from './util.mjs';

const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const covers = (root, file) => root === '.' || file === root || file.startsWith(`${root}/`);
const DEPENDENCY_FILE = /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|pyproject\.toml|poetry\.lock|uv\.lock|requirements[^/]*\.txt|go\.(?:mod|sum)|Cargo\.(?:toml|lock)|Pipfile(?:\.lock)?)$/iu;

function error(code, message, details = {}) { return new SingularityFlowError(message, { code, details }); }
function displayArgv(argv) {
  let secretNext = false;
  return argv.map((value) => {
    if (secretNext) { secretNext = false; return '[REDACTED]'; }
    secretNext = /^--?(?:password|passwd|token|secret|credential|authorization|cookie|api[-_]?key|access[-_]?key)$/iu.test(value);
    return redactDiagnosticText(String(value));
  });
}

/** Generic status and JSON output must not expose sensitive command arguments. */
export function trpSelectionPublicPreview(preview) {
  if (!preview) return null;
  const result = structuredClone(preview);
  for (const entry of [...(result.commands ?? []), ...(result.manifest?.commandSelections ?? [])]) {
    if (Array.isArray(entry.argv)) entry.argv = displayArgv(entry.argv);
    if (entry.env) entry.env = Object.fromEntries(Object.keys(entry.env).map((key) => [key, '[REDACTED]']));
  }
  return result;
}
function relativeWorkDirectory(config, workflow) {
  return normalizeTestSelectionPath(path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id));
}
async function contentBinding(root, relative) {
  const safe = await secureRepositoryPath(root, normalizeTestSelectionPath(relative), { label: 'TRP selection input', type: 'file' });
  if (!safe.exists) return { path: relative, exists: false, sha256: null };
  if (safe.entry.size > 16 * 1024 * 1024) throw error('TRP_TEST_SELECTION_INPUT_BOUND', `Selection input '${relative}' exceeds its bounded file size.`);
  const bytes = await readFile(safe.absolute);
  return { path: relative, exists: true, sha256: sha(bytes) };
}

export async function loadTrpDeliveryAgreement(root, config, workflow) {
  if (!workflow.testRecovery) {
    if (workflow.resolution?.testRecovery?.enabled === true) throw error('TRP_AGREEMENT_REQUIRED', 'This Story requires its pinned Test and Recovery Agreement before test execution.');
    return null;
  }
  const relative = normalizeTestSelectionPath(workflow.testRecovery.agreementPath);
  const expected = `${relativeWorkDirectory(config, workflow)}/context/test-recovery/agreements/`;
  if (!relative.startsWith(expected) || !relative.endsWith('.json')) throw error('TRP_AGREEMENT_INVALID', 'The pinned agreement path is outside this Story agreement directory.');
  const safe = await secureRepositoryPath(root, relative, { label: 'Pinned Test and Recovery Agreement', mustExist: true, type: 'file' });
  if (safe.entry.size > 1024 * 1024) throw error('TRP_AGREEMENT_INVALID', 'The pinned agreement exceeds its bounded size.');
  const agreement = JSON.parse(await readFile(safe.absolute, 'utf8'));
  validateTrpRecord(agreement, { kind: 'story-test-recovery-agreement' });
  if (agreement.recordSha256 !== workflow.testRecovery.agreementSha256 || agreement.subject.workId !== workflow.workItem.id) {
    throw error('TRP_AGREEMENT_INVALID', 'The agreement does not match this Story and its pinned digest.');
  }
  return agreement;
}

function repositoryAgreement(agreement, workflow, repositoryId) {
  const identity = repositoryId ?? workflow.testRecovery.repositoryId;
  if (identity) {
    const found = agreement.repositories.find((entry) => entry.repositoryId === identity);
    if (!found) throw error('TRP_REPOSITORY_REQUIRED', 'The selected repository is not in the pinned agreement.');
    return found;
  }
  const candidates = agreement.repositories.filter((entry) => entry.codeBearing && entry.required);
  if (candidates.length !== 1) throw error('TRP_REPOSITORY_REQUIRED', 'Bind the local repository identity before selecting tests for a multi-repository Story.');
  return candidates[0];
}

export function trpSelectionAuthorityContext(workflow, phase, agreement) {
  const pinned = workflow.resolution?.testRecovery;
  if (!pinned?.enabled) throw error('TRP_AUTHORITY_REQUIRED', 'Scope confirmation requires explicitly enabled pinned test policy.');
  const pinnedPhase = workflow.resolution.phases?.find((entry) => entry.id === phase.id);
  const phaseApproval = pinnedPhase?.approvalPolicy ?? pinnedPhase?.approval;
  const authorities = pinned.riskAuthorities?.length ? pinned.riskAuthorities
    : phaseApproval?.requiredAuthorities?.length ? phaseApproval.requiredAuthorities : phaseApproval?.authorities ?? [];
  if (!pinned.riskAuthorities?.length && (phaseApproval?.minimum !== 1
    || (phaseApproval.requiredAuthorities?.length ?? 0) > 1)) throw error('TRP_AUTHORITY_REQUIRED',
    'This scope-confirmation pilot requires an explicit single-reviewer delegation; it cannot reduce the pinned approval quorum.');
  if (!authorities.length || !workflow.resolution.approvalAuthorities) throw error('TRP_AUTHORITY_REQUIRED', 'No pinned approval authority is delegated to review test scope.');
  return {
    policy: { enabled: true, authoritySha256: agreement.policyAuthoritySha256,
      enabledRiskCategories: pinned.enabledRiskCategories ?? [], maxRiskDays: pinned.maxRiskDays ?? 30,
      allowEvidenceReuse: pinned.allowEvidenceReuse ?? false, maxEvidenceAgeSeconds: pinned.maxEvidenceAgeSeconds ?? 86400,
      requiredApproval: true },
    pinnedAuthorities: workflow.resolution.approvalAuthorities,
    delegation: { minimumAssurance: 'configured-local-review', minimum: 1, authorities,
      categories: pinned.enabledRiskCategories ?? [], transitions: [] }
  };
}

async function confirmationFor(root, config, workflow, agreement, preview, phase, generation, validationEpoch) {
  // A fresh review of the same plan supersedes its earlier local receipt. Keep the historical
  // entry, but never let an unavailable old proof hide the replacement or revive an older grant.
  const entry = (workflow.testRecovery.selectionConfirmations ?? []).findLast((entry) => entry?.planDigest === preview.planDigest
    && entry.phaseId === phase.id && Number(entry.generation) === generation
    && Number(entry.validationEpoch) === validationEpoch);
  if (!entry?.selection || !entry.authorityReceipt) return null;
  try {
    const workRoot = path.join(root, relativeWorkDirectory(config, workflow));
    const selection = await readTrpRecord(workRoot, entry.selection);
    const receipt = await readTrpRecord(workRoot, entry.authorityReceipt);
    if (selection.confirmationSha256 !== preview.planDigest || selection.agreementSha256 !== agreement.recordSha256
      || selection.subject.workId !== workflow.workItem.id
      || selection.subject.repositoryId !== preview.manifest.repositoryId
      || selection.subject.phaseId !== phase.id || selection.subject.generation !== generation
      || selection.subject.validationEpoch !== validationEpoch) return null;
    if (selection.candidateDeltaSha256 !== trpDigest(preview.manifest.candidateDelta)
      || selection.commandInventorySha256 !== preview.manifest.bindings.commandInventorySha256
      || selection.commandSha256 !== trpDigest(preview.commands.map(({ selectionAdapter, ...entry }) => entry))
      || selection.selectorSha256 !== trpDigest(preview.manifest.commandSelections.map((entry) => ({ id: entry.commandId, argv: entry.argv, adapter: entry.selectionAdapter })))
      || selection.fullSuiteEquivalent !== preview.manifest.fullSuiteEquivalent
      || JSON.stringify(selection.selectedSuites) !== JSON.stringify(preview.commands.map((entry) => entry.id))) return null;
    const selectionRelative = `${relativeWorkDirectory(config, workflow)}/context/test-recovery/selections/${selection.id}.json`;
    const committed = await runRemoteGitAsync(['log', '-1', '--format=%H', '--', selectionRelative], {
      cwd: root, operation: 'local-read', allowFailure: true, timeoutMs: 30000, maxBuffer: 1024,
      env: { ...withoutGitProcessOverrides(process.env), GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' }
    });
    if (!processResultSucceeded(committed) || !/^[a-f0-9]{40,64}$/u.test(committed.stdout.trim())) return null;
    const authority = trpSelectionAuthorityContext(workflow, phase, agreement);
    const { storyPublicationPending, workflowPublicationBranch } = await import('./state.mjs');
    if (await storyPublicationPending(root, config, workflow.workItem.id, { migrate: false })) return null;
    const localOnly = config.git?.publish === 'off' && workflow.resolution?.capability?.policy?.gitPublication !== 'required';
    let acknowledged = null;
    if (!localOnly) {
      const observed = await exactRemoteBranchObservationAsync(root, config.git?.remote ?? 'origin', workflowPublicationBranch(root, workflow));
      acknowledged = observed?.sha ?? observed?.commit ?? null;
    }
    const verifyAuthority = await loadTrpAuthorityVerifier({ root, workRoot, ...authority,
      localCommit: committed.stdout.trim(), remoteAcknowledgedCommit: acknowledged, localOnly, records: [selection, receipt] });
    const authorityReceipt = verifyAuthority(selection, { policy: authority.policy });
    if (!authorityReceipt || authorityReceipt.revokedAt) return null;
    return { planDigest: preview.planDigest, selection, receipt };
  } catch { return null; }
}

/** Keep CLI previews and execution callers on exactly the same normalized command contract. */
export function normalizeTrpDeliveryCommands(workflow, phase, commands) {
  const configured = (phase.qualityCommands ?? []).filter((entry) => entry?.kind === 'test')
    .map((entry, index) => normalizeRequiredTestCommand(entry, index));
  return commands.map((entry, index) => {
    if (entry?.kind !== 'test') return entry;
    const command = normalizeRequiredTestCommand(entry, index);
    if (redactDiagnosticText(command.id) !== command.id
      || /--?(?:password|passwd|token|secret|credential|authorization|cookie|api[-_]?key|access[-_]?key)\s+\S+/iu.test(command.id)) {
      throw error('TRP_TEST_COMMAND_ID_REQUIRED', 'Test commands containing sensitive arguments require an explicit credential-free command ID.');
    }
    return { ...command,
      provenance: configured.some((value) => value.id === command.id && value.workingDirectory === command.workingDirectory
        && JSON.stringify(value.argv) === JSON.stringify(command.argv)) ? 'configured' : 'inferred',
      result: { ...command.result,
        minimumDiscovered: Math.max(command.result.minimumDiscovered, workflow.resolution?.codeDelivery?.tests?.minimumDiscovered ?? 1),
        minimumPassed: Math.max(command.result.minimumPassed, workflow.resolution?.codeDelivery?.tests?.minimumPassed ?? 1) }
    };
  });
}

/**
 * `previewOnly` never writes. Execution callers use `persist:true` before starting quality checks.
 * Exact expansion consent comes from the Story's governed confirmation transaction; the optional
 * confirmation argument is for that transaction's already-authorized final revalidation.
 */
export async function resolveTrpDeliverySelection(root, config, workflow, phase, deliveryEvidence, commands, {
  confirmation = null, repositoryId = null, previewOnly = false, persist = false, createdAt = nowIso()
} = {}) {
  const agreement = await loadTrpDeliveryAgreement(root, config, workflow);
  if (!agreement) return { commands, preview: null, selection: null, reference: null };
  // NODE_OPTIONS can preload additional tests before a selected file is loaded, including for
  // Node-based wrapper runners. This pilot does not bind or authorize inherited launch hooks.
  if (Object.entries(process.env).some(([key, value]) => key.toUpperCase() === 'NODE_OPTIONS' && value?.trim())) {
    throw error('TRP_TEST_RUNNER_ENVIRONMENT_UNQUALIFIED',
      'Inherited NODE_OPTIONS is not qualified for TRP test execution. Remove it from this command environment, then review a fresh selection plan; no tests were executed.');
  }
  // Publication callers pass only structured tests, while submission also executes ordinary
  // quality commands. Inspect both declarations and resolved commands so a legacy test runner
  // cannot remain outside the sealed cohort and run its full suite later at submission.
  if ([...(phase.qualityCommands ?? []), ...commands].some((entry) => isTestQualityCommand(entry)
    && (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.kind !== 'test'))) {
    throw error('TRP_TEST_COMMAND_CONTRACT_REQUIRED',
      'TRP requires every recognized test runner to declare kind: test with structured argv, affected roots, and a result adapter before any tests execute.');
  }
  commands = normalizeTrpDeliveryCommands(workflow, phase, commands);
  const tests = commands.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) && entry.kind === 'test');
  if (!tests.length) return { commands, preview: null, selection: null, reference: null };
  const repository = repositoryAgreement(agreement, workflow, repositoryId);
  if (repository.execution.mode === 'not-applicable') throw error('TRP_TEST_OBLIGATION_MISMATCH', 'This phase has test commands but the pinned agreement declares testing not applicable.');
  if (!deliveryEvidence) throw error('TRP_TEST_SELECTION_EVIDENCE_REQUIRED', 'An approved candidate delta is required before selecting delivery tests.');
  const generation = Number(deliveryEvidence.generation ?? Number(phase.generation ?? 0) + 1);
  const validationEpoch = Number(workflow.testRecovery.validationEpoch ?? 1);
  const baseCommit = deliveryEvidence.baselineCommit ?? deliveryEvidence.changeSet?.base?.commit;
  if (!/^[a-f0-9]{40,64}$/u.test(baseCommit ?? '')) throw error('TRP_TEST_SELECTION_BASE_REQUIRED', 'The delivery selection requires an exact pre-feature base commit.');
  const tree = governedCommitIdentity(root, baseCommit)?.tree;
  if (!/^[a-f0-9]{40,64}$/u.test(tree ?? '')) throw error('TRP_TEST_SELECTION_BASE_REQUIRED', 'The pre-feature base tree is not available locally.');
  const pathContext = applicationPathContext(config, workflow);
  const entries = (deliveryEvidence.changeSet?.entries ?? []).filter((entry) => isApplicationChangeEntry(entry, pathContext));
  const candidatePaths = [...new Set([
    ...entries.flatMap((entry) => [entry.oldPath, entry.newPath].filter(Boolean)),
    ...(deliveryEvidence.sourcePaths ?? []), ...(deliveryEvidence.testPaths ?? []),
    ...(deliveryEvidence.supportingTestPaths ?? [])
  ].map((entry) => normalizeTestSelectionPath(entry)))].sort();
  const sources = await Promise.all(candidatePaths.map((relative) => contentBinding(root, relative)));
  const listed = executeGitQuery(root, 'repository.tracked-paths');
  const dependencyPaths = [...new Set([...listed.filter((entry) => DEPENDENCY_FILE.test(entry)),
    ...candidatePaths.filter((entry) => DEPENDENCY_FILE.test(entry))])].sort();
  const dependencies = await Promise.all(dependencyPaths.map((relative) => contentBinding(root, relative)));
  const inventory = [];
  for (const candidate of deliveryEvidence.testPaths ?? []) {
    const relative = normalizeTestSelectionPath(candidate);
    if (!await isExecutableTestSourcePath(root, relative)) throw error('TRP_TEST_SELECTION_TEST_UNAVAILABLE', `Selected executable test source '${relative}' is missing or unsafe.`);
    const source = sources.find((entry) => entry.path === relative) ?? await contentBinding(root, relative);
    for (const command of tests) {
      const cwd = normalizeTestSelectionPath(command.workingDirectory ?? '.', { allowRoot: true });
      const roots = (command.affectedRoots ?? [cwd]).map((entry) => normalizeTestSelectionPath(entry, { allowRoot: true }));
      if (!covers(cwd, relative) || !roots.some((entry) => covers(entry, relative))) continue;
      inventory.push({ id: `file:${command.id}:${relative}`, path: relative, commandId: command.id,
        moduleRoot: cwd, sourcePaths: [], requirementIds: [], semanticsSha256: source.sha256 });
    }
  }
  const delta = entries.length ? entries.map((entry) => ({ status: entry.status, path: entry.newPath ?? entry.oldPath,
    ...(entry.oldPath ? { oldPath: entry.oldPath } : {}) })) : candidatePaths.map((relative) => ({ status: 'modified', path: relative }));
  const planInput = {
    agreement, repositoryId: repository.repositoryId, commands: tests, testInventory: inventory,
    inventoryComplete: false,
    candidate: { baseCommit, baseTree: tree, sourceManifestSha256: trpDigest(sources),
      generation, validationEpoch, delta },
    bindings: {
      dependencyManifestSha256: trpDigest(dependencies),
      environmentSha256: trpDigest({ host: os.hostname(), platform: process.platform, arch: process.arch,
        runtime: process.version, executable: process.execPath }),
      runnerSha256: trpDigest(tests.map((entry) => ({ id: entry.id, argv: entry.argv, cwd: entry.workingDirectory }))),
      adapterSha256: trpDigest(tests.map((entry) => ({ id: entry.id, result: entry.result })))
    }
  };
  let preview = planTestSelection(planInput);
  const verified = await confirmationFor(root, config, workflow, agreement, preview, phase, generation, validationEpoch);
  // The explicit argument builds the review card only. It can never enable execution or persistence.
  const accepted = verified?.planDigest ?? (previewOnly && confirmation === preview.planDigest ? confirmation : null);
  if (accepted) preview = planTestSelection({ ...planInput, confirmation: accepted });
  preview = { ...preview, inventoryAssurance: 'test-source-files-only', inventoryComplete: false,
    environmentQualification: 'local-plan-binding-not-execution-evidence', phaseId: phase.id, generation, validationEpoch,
    inventoryBasis: 'pinned-phase-and-resolved-module-command-inventory' };
  if (!preview.ready && !previewOnly) {
    const confirmationBlocked = preview.blockers.some((entry) => ['TEST_SELECTION_CONFIRMATION_REQUIRED', 'TEST_SELECTION_CONFIRMATION_STALE'].includes(entry.code));
    throw error(confirmationBlocked ? 'TRP_TEST_SELECTION_CONFIRMATION_REQUIRED' : 'TRP_TEST_SELECTION_BLOCKED',
      confirmationBlocked ? 'Review and confirm the exact test-selection expansion before executing this generation.' : 'The requested test cohort cannot be executed under the pinned agreement.',
      { workId: workflow.workItem.id, phase: phase.id, preview: trpSelectionPublicPreview(preview), planDigest: preview.planDigest });
  }
  // This pilot enumerates executable files, not runner testcase identities. Record suite scope and
  // the exact selector contract without manufacturing a complete testcase inventory.
  const selection = verified?.selection ?? sealTrpRecord({
    schemaVersion: 1, kind: 'test-selection-manifest', id: `selection-${preview.planDigest.slice(7, 31)}-${trpDigest(createdAt).slice(7, 19)}`,
    subject: { workId: workflow.workItem.id, repositoryId: repository.repositoryId, phaseId: phase.id, generation, validationEpoch },
    createdAt, issuer: { principal: 'trp-selection-planner', channel: 'trp/1.0' },
    provenance: { authorityRef: agreement.provenance.authorityRef, evidenceRefs: [workflow.testRecovery.agreementPath] },
    agreementSha256: agreement.recordSha256,
    requestedMode: repository.execution.mode,
    effectiveMode: preview.manifest.effectiveMode === 'all' ? 'all-configured' : preview.manifest.effectiveMode,
    candidateDeltaSha256: trpDigest(preview.manifest.candidateDelta),
    commandInventorySha256: preview.manifest.bindings.commandInventorySha256,
    commandSha256: trpDigest(preview.commands.map(({ selectionAdapter, ...entry }) => entry)),
    selectorSha256: trpDigest(preview.manifest.commandSelections.map((entry) => ({ id: entry.commandId, argv: entry.argv, adapter: entry.selectionAdapter }))),
    selectedTestIds: [], selectedSuites: preview.commands.map((entry) => entry.id), inventoryTestIds: [],
    reasons: [...preview.manifest.selectedTests.flatMap((entry) => entry.reasons.map((reason) => ({ target: entry.path, reason }))),
      ...preview.commands.map((entry) => ({ target: `command:${entry.id}`,
        reason: `Execute ${JSON.stringify(displayArgv(entry.argv)).slice(0, 1600)} in ${entry.workingDirectory ?? '.'}` }))],
    expansion: preview.manifest.fullSuiteEquivalent ? 'full-suite' : preview.manifest.expansions.length ? 'module' : 'none',
    fullSuiteEquivalent: preview.manifest.fullSuiteEquivalent, confirmationSha256: accepted,
    exclusions: [], uncoveredAreas: ['test-case-inventory-not-enumerated', ...preview.manifest.uncovered.map((entry) => entry.path ?? entry.testId ?? entry.requirementId)],
    impactComplete: preview.manifest.uncovered.length === 0
  });
  let reference = null;
  if (persist && preview.ready && !previewOnly) {
    const stored = await appendTrpRecord(path.join(root, relativeWorkDirectory(config, workflow)), selection);
    reference = { path: path.posix.join(relativeWorkDirectory(config, workflow), stored.relativePath.split(path.sep).join('/')),
      recordSha256: selection.recordSha256, planDigest: preview.planDigest };
  }
  return { commands: [...commands.filter((entry) => !tests.includes(entry)), ...preview.commands], preview, selection, reference,
    authorityVerified: Boolean(verified) };
}
