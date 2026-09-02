/** Deterministic AUT v2 machine-actionable repair classification. */
import { globToRegExp } from '../inject.mjs';
import { TEST_RESULT_ADAPTERS } from '../external-command-policy.mjs';

const SAFE_AUTOMATIC_CODE = 'AUTO_CANDIDATE_VERIFICATION_FAILED';
const HASH = /^sha256:[a-f0-9]{64}$/;
const STRUCTURED_TEST_ADAPTERS = new Set(TEST_RESULT_ADAPTERS);

function within(pathname, roots) {
  const candidate = String(pathname ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  return roots.some((value) => {
    const root = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
    return root.includes('*') ? globToRegExp(root).test(candidate)
      : candidate === root || candidate.startsWith(`${root}/`);
  });
}

function result(eligibility, reasonCode, scope = [], requiredEvidence = []) {
  return Object.freeze({
    eligibility,
    machineActionable: eligibility === 'auto-eligible',
    reasonCode,
    scope: Object.freeze([...new Set(scope)].sort()),
    requiredEvidence: Object.freeze([...new Set(requiredEvidence)].sort())
  });
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function normalizedMachineEvidence(candidateVerification) {
  const machineEvidence = candidateVerification.repairEvidence;
  const failedCommands = candidateVerification.commands.filter((command) => command.status !== 0);
  if (!Array.isArray(machineEvidence) || machineEvidence.length !== failedCommands.length) return null;
  const byId = new Map(failedCommands.map((command) => [command.id, command]));
  const seen = new Set();
  const normalized = [];
  for (const evidence of machineEvidence) {
    if (!exactKeys(evidence, [
      'kind', 'source', 'commandId', 'commandArgvSha256', 'adapter', 'resultSha256',
      'resultBytes', 'tests', 'repairScope'
    ]) || evidence.kind !== 'structured-test-failure'
        || evidence.source !== 'registered-verifier'
        || seen.has(evidence.commandId)
        || !STRUCTURED_TEST_ADAPTERS.has(evidence.adapter)
        || !HASH.test(String(evidence.commandArgvSha256 ?? ''))
        || !HASH.test(String(evidence.resultSha256 ?? ''))
        || !Number.isSafeInteger(evidence.resultBytes) || evidence.resultBytes < 1
        || !Array.isArray(evidence.repairScope) || evidence.repairScope.length !== 1) return null;
    const command = byId.get(evidence.commandId);
    if (!command || command.argvSha256 !== evidence.commandArgvSha256
        || command.timedOut || command.overflow || command.signal != null) return null;
    const tests = evidence.tests;
    if (!exactKeys(tests, ['discovered', 'passed', 'failed', 'skipped'])) return null;
    const counts = ['discovered', 'passed', 'failed', 'skipped'].map((field) => tests[field]);
    if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)
        || tests.discovered !== tests.passed + tests.failed + tests.skipped
        || tests.discovered < 1 || tests.failed < 1
        || evidence.repairScope.some((pathname) => typeof pathname !== 'string' || !pathname)) {
      return null;
    }
    seen.add(evidence.commandId);
    normalized.push(structuredClone(evidence));
  }
  return normalized.sort((left, right) => left.commandId.localeCompare(right.commandId));
}

function evidenceText(evidence, verificationReceiptSha256) {
  // Fixed property order produces a deterministic, closed evidence string that can pass through
  // the existing immutable Refusal and Repair Plan string contracts without turning error prose
  // into authority.
  return JSON.stringify({
    kind: evidence.kind,
    source: evidence.source,
    commandId: evidence.commandId,
    commandArgvSha256: evidence.commandArgvSha256,
    adapter: evidence.adapter,
    resultSha256: evidence.resultSha256,
    resultBytes: evidence.resultBytes,
    tests: {
      discovered: evidence.tests.discovered,
      passed: evidence.tests.passed,
      failed: evidence.tests.failed,
      skipped: evidence.tests.skipped
    },
    repairScope: [...new Set(evidence.repairScope)].sort(),
    verificationReceiptSha256
  });
}

/**
 * This classifier consumes only typed observations. It intentionally recognizes one narrow case:
 * registered deterministic Candidate verification completed, changed no Candidate bytes, and one
 * or more commands returned non-zero. Error prose is never used as authority.
 */
export function classifyAutoRepairEligibility({
  state,
  attempt,
  gate,
  code,
  candidateVerification,
  changedPaths = [],
  repairScope = [],
  protectedPaths = [],
  repairOperationAvailable = false
} = {}) {
  if (!state || !attempt) return result('ineligible', 'authority-unavailable');
  if (attempt.attemptKind === 'repair') return result('ineligible', 'second-failure');
  if (!['initial', 'resume'].includes(attempt.attemptKind)) {
    return result('manual-only', 'attempt-kind-requires-review');
  }
  if (gate !== 'generation-publication' || code !== SAFE_AUTOMATIC_CODE) {
    return result('ask-only', 'failure-class-requires-review');
  }
  if (!repairOperationAvailable) return result('manual-only', 'repair-operation-unavailable');
  if (state.status !== 'running' || state.stopRequested != null) {
    return result('manual-only', 'flight-not-runnable');
  }
  if (!candidateVerification
      || candidateVerification.status !== 'failed'
      || candidateVerification.candidateTreeUnchanged !== true
      || !Array.isArray(candidateVerification.commands)
      || !candidateVerification.commands.length) {
    return result('manual-only', 'verification-not-safe');
  }
  if (candidateVerification.candidateSha256 !== state.candidate?.candidateSha256
      || candidateVerification.bindingSha256 !== state.candidate?.bindingSha256
      || candidateVerification.verificationReceiptSha256
        !== state.candidate?.verificationReceiptSha256
      || attempt.candidateSha256 !== state.candidate?.candidateSha256) {
    return result('manual-only', 'verification-authority-mismatch');
  }
  const unsafeCommand = candidateVerification.commands.some((command) => (
    command.timedOut === true || command.overflow === true || command.signal != null
      || !Number.isInteger(command.status)
  ));
  const deterministicFailure = candidateVerification.commands.some((command) => (
    command.status !== 0 && command.timedOut === false
      && command.overflow === false && command.signal == null
  ));
  if (unsafeCommand || !deterministicFailure) {
    return result('manual-only', unsafeCommand
      ? 'verification-operation-unsafe' : 'verification-failure-unproven');
  }
  const evidence = normalizedMachineEvidence(candidateVerification);
  if (!evidence) return result('ask-only', 'verification-failure-untyped');
  const evidenceScope = [...new Set(evidence.flatMap((entry) => entry.repairScope))].sort();
  const requestedScope = [...new Set(repairScope)].sort();
  if (JSON.stringify(evidenceScope) !== JSON.stringify(requestedScope)
      || evidenceScope.some((pathname) => !changedPaths.includes(pathname))) {
    return result('manual-only', 'repair-scope-not-evidence-bound');
  }
  const planScope = [...new Set(state.scopePrediction ?? [])];
  if (!planScope.length || !repairScope.length
      || [...changedPaths, ...repairScope].some((pathname) => !within(pathname, planScope))) {
    return result('manual-only', 'repair-scope-not-ratified');
  }
  if ([...changedPaths, ...repairScope].some((pathname) => within(pathname, protectedPaths))) {
    return result('ineligible', 'protected-path');
  }
  if (Number(state.execution?.repair?.maximumAttempts ?? 0) < 1
      || Number(state.counters?.modelInvocations ?? 0)
        >= Number(state.execution?.ceilings?.maximumModelInvocations ?? 0)
      || Number(state.counters?.authoringAttempts?.[state.story?.phase] ?? 0)
        >= Number(state.execution?.ceilings?.maximumAuthoringAttemptsPerPhase ?? 0)) {
    return result('ineligible', 'repair-budget-exhausted');
  }
  return result('auto-eligible', 'structured-test-failure', evidenceScope,
    evidence.map((entry) => evidenceText(
      entry, candidateVerification.verificationReceiptSha256
    )));
}
