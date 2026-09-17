/**
 * Inert REV Code-check execution core. The only executable is an injected adapter supplied by a
 * caller; this module never spawns a process, writes a Story path, or creates a proof receipt.
 * Even a successful adapter observation is NOT publication or Testing evidence. A production
 * adapter needs independently verified candidate-tree isolation, process-tree quiescence, exact
 * test-body/adapter bindings, and a durable verified receipt store before activation is possible.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';
import { planRevisionCodeChecks } from './code-check-plan.mjs';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

function fail(code, message) { throw new SingularityFlowError(message, { code }); }
function bytesHash(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/**
 * Rebuild the exact plan from a verified retained Candidate and the supplied phase definition.
 * A digest on an arbitrary plan is not authority to run commands. The phase definition must be
 * loaded from the approved workflow by the caller; this core cannot establish that provenance.
 */
export async function verifyRevisionCodeCheckRunPlan({
  root, candidateReference, phase, proofProfileSha256, environmentSha256, plan
} = {}) {
  const expected = await planRevisionCodeChecks({
    root, candidateReference, phase, proofProfileSha256, environmentSha256
  });
  if (!plan || canonicalJson(plan) !== canonicalJson(expected)) {
    fail('REV_CODE_CHECK_PLAN_STALE',
      'Code check plan differs from the exact verified Candidate and registered phase commands.');
  }
  return expected;
}

/**
 * Exercise a caller-owned isolated executor for integration development. This cannot produce a
 * qualifying receipt: injected callbacks, exit codes and stdout cannot independently prove what
 * candidate was tested or that external/process-tree effects have quiesced. Raw output is not
 * returned. No callback is invoked until plan and Candidate verification pass.
 */
export async function probeRevisionCodeChecks({
  root, candidateReference, phase, proofProfileSha256, environmentSha256, plan,
  executeIsolatedCheck
} = {}) {
  const verified = await verifyRevisionCodeCheckRunPlan({
    root, candidateReference, phase, proofProfileSha256, environmentSha256, plan
  });
  if (verified.status !== 'review-required' || !verified.checks.length) {
    return {
      schemaVersion: 1, kind: 'revision-code-check-probe',
      status: 'unavailable', reason: 'NO_REGISTERED_CHECKS',
      candidateId: verified.candidateId, planSha256: verified.planSha256,
      observations: [], receiptSha256: null,
      publicationEligibilityEstablished: false,
      testingVerificationStatus: 'not-established-by-code-probe'
    };
  }
  if (typeof executeIsolatedCheck !== 'function') {
    fail('REV_CODE_CHECK_EXECUTOR_UNAVAILABLE',
      'No verified isolated Code-check executor is installed; checks were not run.');
  }
  const observations = [];
  for (const check of verified.checks) {
    const controller = new AbortController();
    const timeoutMs = check.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new SingularityFlowError(
          `Code check '${check.id}' exceeded its deadline; process effects remain unverified.`,
          { code: 'REV_CODE_CHECK_TIMEOUT_UNVERIFIED' }
        ));
      }, timeoutMs);
    });
    const request = Object.freeze({
      schemaVersion: 1, kind: 'revision-code-check-probe-request',
      candidateId: verified.candidateId,
      candidateRefSha256: verified.candidateRefSha256,
      candidateTree: verified.candidateTree,
      phaseId: verified.phaseId,
      phaseGeneration: verified.phaseGeneration,
      planSha256: verified.planSha256,
      checkId: check.id,
      checkDefinitionSha256: check.definitionSha256,
      argv: Object.freeze([...check.argv]),
      workingDirectory: check.workingDirectory,
      affectedRoots: Object.freeze([...check.affectedRoots]),
      result: check.result ? Object.freeze({ ...check.result }) : null,
      timeoutMs
    });
    let observed;
    try {
      observed = await Promise.race([
        Promise.resolve().then(() => executeIsolatedCheck(request, controller.signal)), timeout
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (!observed || typeof observed !== 'object' || Array.isArray(observed)
        || !Number.isSafeInteger(observed.exitCode) || observed.exitCode < 0
        || typeof observed.stdout !== 'string' || typeof observed.stderr !== 'string') {
      fail('REV_CODE_CHECK_OBSERVATION_INVALID',
        'The injected executor returned no bounded Code-check observation.');
    }
    const stdout = Buffer.from(observed.stdout, 'utf8');
    const stderr = Buffer.from(observed.stderr, 'utf8');
    if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
      fail('REV_CODE_CHECK_OUTPUT_OVERFLOW',
        'Code-check output exceeds the private observation bound; no receipt was created.');
    }
    observations.push({
      checkId: check.id, observedExitCode: observed.exitCode,
      stdoutSha256: bytesHash(stdout), stderrSha256: bytesHash(stderr),
      outputBytes: stdout.length + stderr.length,
      status: 'observed-unverified', receiptSha256: null
    });
  }
  return {
    schemaVersion: 1, kind: 'revision-code-check-probe',
    status: 'unavailable', reason: 'ISOLATION_AND_RECEIPT_PROVENANCE_UNVERIFIED',
    candidateId: verified.candidateId, planSha256: verified.planSha256,
    observations, receiptSha256: null,
    publicationEligibilityEstablished: false,
    testingVerificationStatus: 'not-established-by-code-probe'
  };
}
