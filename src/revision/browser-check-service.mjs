/**
 * Public BRL surface orchestration.
 *
 * The contract/store kernels intentionally expose no arbitrary executor. This service therefore
 * resolves only the selected active Story and retained REV head, projects legacy Playwright
 * registrations as an explicit contract gap, and refuses every run before effects. It is the
 * narrow place where a future independently approved runner may be connected without widening the
 * browser contracts or accepting caller-supplied commands.
 */
import { normalizeExternalCommand } from '../external-command-policy.mjs';
import { recordSha256 } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';
import { sgosRevisionCandidateReference } from './candidate-adapter.mjs';
import { APPROVED_RUNNER_PROVIDER } from './approved-runner-contract.mjs';
import { readLatestRevisionBrowserRunReceipt } from './browser-run-store.mjs';
import { inspectInteractiveRevision } from './interactive-service.mjs';
import { loadActiveRevisionStory } from './product-context.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/u;
const RUN_ID = /^BRL-[a-f0-9]{12}$/u;

function fail(code, message) { throw new SingularityFlowError(message, { code }); }
function hash(value) { return `sha256:${recordSha256(value)}`; }

export const revisionBrowserCheckCapabilities = Object.freeze({
  schemaVersion: 1,
  kind: 'revision-browser-check-capabilities',
  activationProfile: 'contracts-and-read-surfaces-only',
  foundations: Object.freeze({
    closedCheckContract: 'available',
    retainedCandidateVerification: 'available',
    boundedEffectsBridge: 'available-not-browser-execution',
    immutableReceiptStore: 'available-local-private',
    assertionProjection: 'available-observation-only',
    deterministicVisualComparison: 'unavailable',
    approvedRunnerProviderContract: 'available-fail-closed',
    candidateUnderTestAttestation: 'available-requires-sgos-cab-trust',
    authenticatedRunnerReceiptStore: 'available-requires-sgos-cab-trust',
    secureArtifactAdmission: 'available-non-rendering'
  }),
  approvedRunnerBoundary: Object.freeze({
    providerId: APPROVED_RUNNER_PROVIDER.id,
    providerProtocol: APPROVED_RUNNER_PROVIDER.protocol,
    apiVersion: APPROVED_RUNNER_PROVIDER.apiVersion,
    authoritySource: 'sgos-cab-approved-configuration',
    activationStatus: 'disabled-pending-authority-revalidation-and-adapter-wiring',
    executionEnabled: false,
    testingVerificationEstablished: false,
    publicationEligibilityEstablished: false
  }),
  unavailable: Object.freeze({
    executor: 'REV_CODE_CHECK_EXECUTOR_UNAVAILABLE',
    approvedRunnerProvider: 'REV_RUNNER_PROVIDER_UNAVAILABLE',
    approvedRunnerTrust: 'REV_RUNNER_AUTHORITY_UNAVAILABLE',
    candidateUnderTestProvenance: 'BRL_CANDIDATE_UNDER_TEST_UNAVAILABLE',
    visualComparator: 'BRL_VISUAL_COMPARATOR_UNAVAILABLE',
    governedBaselineStore: 'BRL_BASELINE_STORE_UNAVAILABLE',
    isolatedSandbox: 'BRL_SANDBOX_UNAVAILABLE',
    authenticatedReceiptAuthority: 'BRL_RECEIPT_AUTHORITY_UNAVAILABLE',
    testingVerification: 'BRL_TESTING_AUTHORITY_UNAVAILABLE',
    publication: 'BRL_PUBLICATION_AUTHORITY_UNAVAILABLE',
    cancellation: 'BRL_CANCEL_NOT_PUBLIC',
    retry: 'BRL_RETRY_NOT_PUBLIC',
    recovery: 'BRL_RECOVERY_NOT_PUBLIC'
  }),
  actions: Object.freeze({
    capabilities: 'available-read',
    plan: 'available-read-fail-closed',
    status: 'available-read',
    result: 'available-read',
    run: 'unavailable-no-approved-runner',
    cancel: 'not-public',
    retry: 'not-public',
    recover: 'not-public'
  }),
  publicationEligibilityEstablished: false,
  testingVerificationStatus: 'not-established-by-browser-check-surface'
});

function browserRegistrations(phase) {
  const commands = phase?.qualityCommands ?? [];
  if (!Array.isArray(commands)) {
    fail('BRL_CHECK_CONTRACT_REQUIRED', 'The active phase has no bounded registered quality-command inventory.');
  }
  const rows = [];
  for (const [index, raw] of commands.entries()) {
    const command = normalizeExternalCommand(raw, index);
    if (command.modelPolicy !== 'never' || command.command !== null || !command.argv?.length
        || command.result?.adapter !== 'playwright-json') continue;
    const definition = {
      id: command.id,
      argv: command.argv,
      workingDirectory: command.workingDirectory ?? null,
      affectedRoots: command.affectedRoots ?? [],
      result: command.result,
      timeoutMs: command.timeoutMs
    };
    rows.push(Object.freeze({
      id: command.id,
      legacyDefinitionSha256: hash(definition),
      registeredAdapter: command.result.adapter,
      brlContractStatus: 'unavailable',
      reasonCode: 'BRL_CHECK_CONTRACT_REQUIRED'
    }));
  }
  return Object.freeze(rows);
}

async function selectedBrowserContext(root) {
  const active = await loadActiveRevisionStory(root);
  const inspected = await inspectInteractiveRevision(root);
  if (inspected.status?.state !== 'open' || inspected.status?.prechecked !== true
      || inspected.state?.status !== 'prechecked' || inspected.freshness?.status !== 'current'
      || !inspected.status?.head?.candidateId
      || inspected.status.head.candidateId !== inspected.state.resultCandidateId
      || inspected.precheck?.candidateId !== inspected.status.head.candidateId
      || inspected.precheck?.configSha256 == null
      || inspected.precheck?.proofProfileSha256 == null) {
    fail('REV_BROWSER_CANDIDATE_UNAVAILABLE',
      'Browser checks require the exact current retained and freshly prechecked REV loop head.');
  }
  const candidateReference = await sgosRevisionCandidateReference(
    root, inspected.status.head.candidateId
  );
  return { active, inspected, candidateReference };
}

/** Read-only exact plan. Current approved configuration has no complete BRL command contract. */
export async function planPublicRevisionBrowserChecks(root) {
  const { active, inspected, candidateReference } = await selectedBrowserContext(root);
  const registrations = browserRegistrations(active.phase);
  const core = {
    schemaVersion: 1,
    kind: 'revision-browser-check-plan',
    subject: { ...active.subject },
    loopId: inspected.state.loopId,
    intervalId: inspected.interval?.intervalId ?? inspected.status.headIntervalId ?? null,
    candidate: {
      id: candidateReference.candidateId,
      sha256: candidateReference.candidateSha256,
      referenceSha256: hash(candidateReference),
      tree: candidateReference.repository.candidateTree
    },
    configSha256: inspected.precheck.configSha256,
    proofProfileSha256: inspected.precheck.proofProfileSha256,
    registeredBrowserChecks: registrations,
    status: 'unavailable',
    reasonCode: 'BRL_CHECK_CONTRACT_REQUIRED',
    reason: registrations.length
      ? 'Registered Playwright commands lack the complete sealed BRL check, environment, artifact, and runner contract.'
      : 'The active phase has no complete sealed BRL browser-check contract.',
    executionAvailable: false,
    processStarted: false,
    runId: null,
    receiptSha256: null,
    criterionSatisfactionEstablished: false,
    testingVerificationStatus: 'not-established-by-browser-check-plan',
    publicationEligibilityEstablished: false
  };
  return Object.freeze({ ...core, planSha256: hash(core) });
}

function runId(value, { optional = false } = {}) {
  if (optional && value == null) return null;
  if (!RUN_ID.test(String(value ?? ''))) {
    fail('REV_BROWSER_RUN_ID_INVALID', 'Browser-check run ID must use BRL- followed by 12 lowercase hexadecimal characters.');
  }
  return value;
}

function receiptSubject(receipt) {
  return Object.freeze({
    workId: receipt.runKey.workId,
    phaseId: receipt.runKey.phaseId,
    phaseGeneration: receipt.runKey.phaseGeneration
  });
}

function different(stale, label, observed, current) {
  if (observed !== current) stale.push(label);
}

/**
 * Compare only bindings the active REV projection can independently expose. Failure to resolve a
 * current Story never hides an already validated immutable receipt: it makes current authority
 * unavailable instead. This is deliberately not the sealed core comparison, because no complete
 * current BRL run key can be reconstructed from legacy workflow configuration.
 */
async function currentReceiptBinding(root, receipt) {
  try {
    const active = await loadActiveRevisionStory(root);
    const inspected = await inspectInteractiveRevision(root);
    const runKey = receipt.runKey;
    const stale = [];
    different(stale, 'subject', runKey.workId, active.subject.workId);
    different(stale, 'phase', runKey.phaseId, active.subject.phaseId);
    different(stale, 'phase-generation', runKey.phaseGeneration,
      active.subject.phaseGeneration);
    different(stale, 'loop', runKey.loopId, inspected.state?.loopId ?? null);
    different(stale, 'interval', runKey.intervalId,
      inspected.interval?.intervalId ?? inspected.status?.headIntervalId ?? null);
    different(stale, 'candidate', runKey.candidateId,
      inspected.status?.head?.candidateId ?? null);
    different(stale, 'configuration', runKey.configSha256,
      inspected.precheck?.configSha256 ?? null);
    different(stale, 'workflow', runKey.workflowSha256,
      inspected.precheck?.workflowSha256 ?? null);
    different(stale, 'proof-profile', runKey.proofProfileSha256,
      inspected.precheck?.proofProfileSha256 ?? null);
    if (inspected.freshness?.status !== 'current') stale.push('selected-head-freshness');

    const headCandidateId = inspected.status?.head?.candidateId;
    if (headCandidateId) {
      try {
        const reference = await sgosRevisionCandidateReference(root, headCandidateId);
        different(stale, 'candidate', runKey.candidateSha256, reference.candidateSha256);
        different(stale, 'candidate', runKey.candidateRefSha256, hash(reference));
        different(stale, 'candidate-tree', runKey.candidateTree,
          reference.repository.candidateTree);
      } catch {
        stale.push('candidate-reference');
      }
    }
    const staleBindings = Object.freeze([...new Set(stale)]);
    return Object.freeze({
      currentBindingStatus: staleBindings.length ? 'stale' : 'current',
      currentBindingReasonCode: null,
      staleBindings
    });
  } catch (error) {
    return Object.freeze({
      currentBindingStatus: 'unavailable',
      currentBindingReasonCode: error?.code ?? 'REV_BROWSER_CURRENT_BINDING_UNAVAILABLE',
      staleBindings: Object.freeze([])
    });
  }
}

function absentStatus(active, inspected, selected) {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'revision-browser-check-status',
    subject: { ...active.subject },
    loopId: inspected.state.loopId,
    intervalId: inspected.interval?.intervalId ?? inspected.status.headIntervalId ?? null,
    runId: selected,
    state: 'absent',
    reasonCode: selected ? 'BRL_RUN_NOT_FOUND' : 'BRL_NO_CURRENT_RUN',
    effects: 'none',
    cleanupStatus: 'not-started',
    processQuiescence: 'not-started',
    receiptSha256: null,
    runKeySha256: null,
    currentBindingStatus: 'current',
    currentBindingReasonCode: null,
    staleBindings: Object.freeze([]),
    legalNextAction: 'revision.checks.plan',
    assertionWitnessStatus: 'not-established',
    criterionSatisfactionEstablished: false,
    testingVerificationStatus: 'not-established-by-browser-check-status',
    publicationEligibilityEstablished: false
  });
}

/** Read a named immutable receipt before consulting mutable selected-head state. */
export async function inspectPublicRevisionBrowserCheckStatus(root, selectedRunId = null) {
  const selected = runId(selectedRunId, { optional: true });
  if (selected !== null) {
    const receipt = await readLatestRevisionBrowserRunReceipt(root, selected);
    if (receipt) {
      const binding = await currentReceiptBinding(root, receipt);
      return Object.freeze({
        schemaVersion: 1,
        kind: 'revision-browser-check-status',
        subject: receiptSubject(receipt),
        loopId: receipt.runKey.loopId,
        intervalId: receipt.runKey.intervalId,
        runId: selected,
        state: 'completed',
        verdict: receipt.status,
        reasonCode: receipt.reasonCode,
        effects: receipt.executionAssurance,
        cleanupStatus: 'verified-before-immutable-receipt',
        processQuiescence: 'not-established-by-browser-run',
        receiptSha256: receipt.receiptSha256,
        runKeySha256: receipt.runKey.runKeySha256,
        candidate: Object.freeze({
          id: receipt.runKey.candidateId,
          sha256: receipt.runKey.candidateSha256,
          referenceSha256: receipt.runKey.candidateRefSha256,
          tree: receipt.runKey.candidateTree
        }),
        ...binding,
        legalNextAction: 'revision.checks.result',
        assertionWitnessStatus: receipt.assertionWitnessStatus,
        criterionSatisfactionEstablished: false,
        testingVerificationStatus: 'not-established-by-browser-check-status',
        publicationEligibilityEstablished: false
      });
    }
  }
  const { active, inspected } = await selectedBrowserContext(root);
  return absentStatus(active, inspected, selected);
}

/**
 * Result names one exact immutable receipt. It remains readable after selected-head drift while
 * current binding, Testing, and publication authority stay explicitly separate and false.
 */
export async function inspectPublicRevisionBrowserCheckResult(root, selectedRunId) {
  const selected = runId(selectedRunId);
  const receipt = await readLatestRevisionBrowserRunReceipt(root, selected);
  if (receipt) {
    const binding = await currentReceiptBinding(root, receipt);
    return Object.freeze({
      schemaVersion: 1,
      kind: 'revision-browser-check-result',
      subject: receiptSubject(receipt),
      loopId: receipt.runKey.loopId,
      intervalId: receipt.runKey.intervalId,
      runId: selected,
      status: receipt.status,
      reasonCode: receipt.reasonCode,
      receipt,
      runState: Object.freeze({
        state: 'completed', reasonCode: receipt.reasonCode,
        receiptSha256: receipt.receiptSha256,
        runKeySha256: receipt.runKey.runKeySha256
      }),
      comparison: null,
      ...binding,
      assertionWitnessStatus: receipt.assertionWitnessStatus,
      criterionSatisfactionEstablished: false,
      testingVerificationStatus: 'not-established-by-browser-check-result',
      publicationEligibilityEstablished: false
    });
  }
  const status = await inspectPublicRevisionBrowserCheckStatus(root, selected);
  return Object.freeze({
    schemaVersion: 1,
    kind: 'revision-browser-check-result',
    subject: status.subject,
    loopId: status.loopId,
    intervalId: status.intervalId,
    runId: status.runId,
    status: 'unavailable',
    reasonCode: 'BRL_RUN_NOT_FOUND',
    receipt: null,
    comparison: null,
    staleBindings: [],
    assertionWitnessStatus: 'not-established',
    criterionSatisfactionEstablished: false,
    testingVerificationStatus: 'not-established-by-browser-check-result',
    publicationEligibilityEstablished: false
  });
}

/** Exact-confirm boundary. Re-plan first; this build always stops before effects. */
export async function confirmPublicRevisionBrowserCheckRun(root, { plan, confirmation } = {}) {
  if (!HASH.test(String(plan ?? '')) || !HASH.test(String(confirmation ?? ''))
      || plan !== confirmation) {
    fail('REV_BROWSER_CONFIRMATION_REQUIRED',
      'Browser-check run requires the same full SHA-256 digest in --plan and --confirm.');
  }
  const current = await planPublicRevisionBrowserChecks(root);
  if (current.planSha256 !== plan) {
    fail('REV_BROWSER_PLAN_STALE',
      'Browser-check plan differs from the current Story, retained Candidate, phase, or registered checks.');
  }
  if (current.status !== 'ready' || current.executionAvailable !== true) {
    fail(current.reasonCode ?? 'REV_CODE_CHECK_EXECUTOR_UNAVAILABLE',
      current.reason ?? 'No approved isolated browser-check executor is installed.');
  }
  fail('REV_CODE_CHECK_EXECUTOR_UNAVAILABLE',
    'No approved isolated browser-check executor is installed; no process or run record was created.');
}
