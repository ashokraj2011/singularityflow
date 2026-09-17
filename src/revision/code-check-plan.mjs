/** Read-only, candidate-bound planning for registered Code-phase checks. */
import { recordSha256 } from '../records.mjs';
import { normalizeExternalCommand } from '../external-command-policy.mjs';
import { SingularityFlowError } from '../util.mjs';
import { verifySgosRevisionCandidateReference } from './candidate-adapter.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const CANDIDATE_ID = /^CAN-[A-Za-z0-9._:-]{6,127}$/;
const KINDS = new Set(['test', 'compile', 'lint']);

function refuse(message) {
  throw new SingularityFlowError(message, { code: 'REV_CODE_CHECK_PLAN_INVALID' });
}

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value !== '..' && !value.startsWith('/') && !value.includes('\\')
    && !value.split('/').some((part) => part === '..' || part === '')
    && !value.split('/').some((part) => part.toLowerCase() === '.git' || part.includes(':'))
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizedCheck(command, index) {
  let registered;
  try { registered = normalizeExternalCommand(command, index); }
  catch { refuse('Code check is not a valid approved quality-command definition.'); }
  if (!command || !ID.test(String(registered.id ?? '')) || !KINDS.has(registered.kind)
      || registered.command !== null || registered.modelPolicy !== 'never'
      || !Array.isArray(registered.argv) || !registered.argv.length || registered.argv.length > 64
      || registered.argv.some((arg) => typeof arg !== 'string' || !arg || arg.length > 2048
        || /[\u0000-\u001f\u007f]/.test(arg))
      || !safePath(registered.workingDirectory)
      || !Array.isArray(registered.affectedRoots) || !registered.affectedRoots.length
      || registered.affectedRoots.length > 64 || registered.affectedRoots.some((root) => !safePath(root))) {
    refuse('Code check must be a model-free, argv-form registered command with bounded repository paths.');
  }
  const result = registered.result ?? null;
  if (result !== null && (typeof result.adapter !== 'string' || !result.adapter
      || !safePath(result.path))) {
    refuse('Code check result adapter and output path must be explicit and repository-relative.');
  }
  if (registered.kind === 'test' && result === null) {
    refuse('A registered test check needs a structured result adapter.');
  }
  if (registered.timeoutMs != null && (!Number.isSafeInteger(registered.timeoutMs)
      || registered.timeoutMs < 1 || registered.timeoutMs > 2 * 60 * 60 * 1000)) {
    refuse('Code check timeout is outside the installed bound.');
  }
  const definition = {
    id: registered.id,
    kind: registered.kind === 'compile' ? 'build'
      : result?.adapter === 'playwright-json' ? 'browser' : registered.kind,
    registeredKind: registered.kind,
    argv: [...registered.argv],
    workingDirectory: registered.workingDirectory,
    affectedRoots: [...registered.affectedRoots].sort(),
    result: result ? { ...result } : null,
    timeoutMs: registered.timeoutMs ?? null
  };
  return {
    ...definition,
    definitionSha256: `sha256:${recordSha256(definition)}`
  };
}

/**
 * This function never infers a command from package files or executes one. A separate reviewed
 * revision.checks.run boundary must consume the exact plan and produce candidate-bound receipts.
 */
export async function planRevisionCodeChecks({
  root, candidateReference, phase, proofProfileSha256, environmentSha256
} = {}) {
  if (typeof root !== 'string' || !candidateReference
      || candidateReference.family !== 'sgos-candidate'
      || !CANDIDATE_ID.test(String(candidateReference.candidateId ?? ''))
      || !HASH.test(String(candidateReference.candidateSha256 ?? ''))
      || !OID.test(String(candidateReference.repository?.candidateTree ?? ''))
      || typeof phase?.id !== 'string' || !phase.id
      || !Number.isSafeInteger(phase.generation) || phase.generation < 0
      || !HASH.test(String(proofProfileSha256 ?? ''))
      || !HASH.test(String(environmentSha256 ?? ''))) {
    refuse('An exact frozen Code candidate, phase, proof profile, and environment are required.');
  }
  if (!await verifySgosRevisionCandidateReference(root, candidateReference)) {
    refuse('Code check plan requires an independently verified retained Candidate.');
  }
  const configured = phase.qualityCommands ?? [];
  if (!Array.isArray(configured) || configured.length > 32) {
    refuse('Registered Code check list exceeds its bounded catalog.');
  }
  const checks = configured.map(normalizedCheck);
  if (new Set(checks.map((check) => check.id)).size !== checks.length) {
    refuse('Registered Code check identifiers must be unique.');
  }
  const core = {
    schemaVersion: 1, kind: 'revision-code-check-plan',
    candidateId: candidateReference.candidateId,
    candidateSha256: candidateReference.candidateSha256,
    candidateRefSha256: `sha256:${recordSha256(candidateReference)}`,
    candidateTree: candidateReference.repository.candidateTree,
    phaseId: phase.id, phaseGeneration: phase.generation,
    proofProfileSha256, environmentSha256,
    checks,
    status: checks.length ? 'review-required' : 'unavailable',
    reason: checks.length ? null : 'no-registered-code-check'
  };
  return { ...core, planSha256: `sha256:${recordSha256(core)}` };
}
