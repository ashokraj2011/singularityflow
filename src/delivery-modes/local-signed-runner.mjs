/**
 * Developer-local signed runner.
 *
 * This is deliberately below enterprise assurance. It executes only an argv-form, model-free
 * quality command already present in approved workflow configuration, in a separate process, and
 * signs a content-free observation with a machine-local key. The resulting receipt is useful for
 * tamper detection and replay, but never proves reviewer or infrastructure independence.
 */
import {
  createHash, createPrivateKey, createPublicKey, randomBytes,
  sign as signBytes, timingSafeEqual, verify as verifyBytes
} from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import { normalizeExternalCommand } from '../external-command-policy.mjs';
import { head } from '../git.mjs';
import { runQualityCommand } from '../quality-command-runner.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import {
  createLocalAuthorityTransportSigner, loadLocalAuthorityTransportSigner
} from '../sgos/authority-transport.mjs';
import {
  ensureSecureRepositoryDirectory, run, secureRepositoryPath, SingularityFlowError,
  writeAtomicExclusive
} from '../util.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const GIT_OBJECT = /^[a-f0-9]{40,64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SIGNER_ID = /^[a-z0-9][a-z0-9._:-]{1,127}$/;
const PLAN_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'workId', 'phaseId', 'commandId', 'signerId',
  'proofSubjectSha256', 'candidateSha256', 'repositoryHead', 'repositoryTree',
  'command', 'commandSha256', 'signerKeySha256', 'planSha256'
]);
const RECEIPT_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'providerId', 'assurance', 'authority', 'gateEligible',
  'consumedByLifecycle', 'proofSubjectSha256', 'candidateSha256', 'repositorySha256',
  'workIdSha256', 'phaseIdSha256', 'commandIdSha256', 'commandSha256',
  'environmentSha256', 'resultSha256', 'stdoutSha256', 'stderrSha256',
  'stdoutBytes', 'stderrBytes', 'stdoutTruncated', 'stderrTruncated', 'outcome',
  'exitCode', 'workingTreeStatusChanged', 'startedAt', 'completedAt', 'nonceSha256',
  'signature', 'attestationSha256'
]);
const SIGNATURE_FIELDS = Object.freeze([
  'algorithm', 'keyId', 'keySha256', 'payloadSha256', 'value'
]);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const CAPTURE_BYTES = 256 * 1024;
const CHILD_GRACE_MS = 15_000;

function fail(message, code = 'GDP_LOCAL_RUNNER_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}
function sha(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? Buffer.from(value) : typeof value === 'string' ? value : canonicalJson(value);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function exactKeys(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...fields].sort())) {
    fail(`${label} has an invalid field set.`);
  }
}
function digest(value, label) {
  if (!DIGEST.test(String(value ?? ''))) fail(`${label} must be a sha256 digest.`);
  return String(value);
}
function identifier(value, label) {
  const result = String(value ?? '');
  if (!ID.test(result)) fail(`${label} is invalid.`);
  return result;
}
function workIdentifier(value) {
  const result = String(value ?? '');
  if (!WORK_ID.test(result)) fail('workId is invalid.');
  return result;
}
function signerIdentifier(value) {
  const result = String(value ?? '');
  if (!SIGNER_ID.test(result)) fail('signerId must be a lower-case portable identifier.');
  return result;
}
function gitObject(value, label) {
  const result = String(value ?? '');
  if (!GIT_OBJECT.test(result)) fail(`${label} is not a Git object ID.`);
  return result;
}
function instant(value, label) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(`${label} must be canonical ISO-8601.`);
  }
  return value;
}
function repositoryTree(root) {
  const result = run('git', ['rev-parse', '--verify', 'HEAD^{tree}'], {
    cwd: root, allowFailure: true
  });
  if (result.status !== 0) fail('Local runner could not resolve the current Git tree.',
    'GDP_LOCAL_RUNNER_REPOSITORY_UNAVAILABLE');
  return gitObject(result.stdout.trim(), 'repositoryTree');
}
function repositoryStatus(root) {
  const result = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root, allowFailure: true
  });
  if (result.status !== 0) fail('Local runner could not inspect the working tree.',
    'GDP_LOCAL_RUNNER_REPOSITORY_UNAVAILABLE');
  return sha(result.stdout);
}

export function resolveLocalRunnerCommand(definition, phaseId, commandId) {
  const phase = definition?.phases?.[phaseId];
  if (!phase) fail(`Unknown configured phase '${phaseId}'.`, 'GDP_LOCAL_RUNNER_PHASE_UNKNOWN');
  const matches = (phase.qualityCommands ?? []).map((value, index) => ({
    value: normalizeExternalCommand(value, index), index
  })).filter(({ value }) => value.id === commandId);
  if (matches.length !== 1) {
    fail(matches.length
      ? `Phase '${phaseId}' repeats quality command '${commandId}'.`
      : `Phase '${phaseId}' has no quality command '${commandId}'.`,
    'GDP_LOCAL_RUNNER_COMMAND_UNAVAILABLE');
  }
  const command = matches[0].value;
  if (!command.argv?.length || command.command) {
    fail(`Quality command '${commandId}' must use shell-free argv form.`,
      'GDP_LOCAL_RUNNER_COMMAND_UNSAFE');
  }
  if (command.modelPolicy !== 'never') {
    fail(`Quality command '${commandId}' must declare modelPolicy: never.`,
      'GDP_LOCAL_RUNNER_COMMAND_UNSAFE');
  }
  return Object.freeze({
    ...command,
    workingDirectory: command.workingDirectory ?? '.',
    timeoutMs: command.timeoutMs ?? DEFAULT_TIMEOUT_MS
  });
}

function commandIdentity(command) {
  return sha({
    id: command.id, argv: command.argv, modelPolicy: command.modelPolicy,
    requirement: command.requirement, kind: command.kind ?? null,
    workingDirectory: command.workingDirectory, timeoutMs: command.timeoutMs,
    affectedRoots: command.affectedRoots ?? [], result: command.result ?? null
  });
}

export async function createLocalRunnerSigner(root, signerId) {
  return createLocalAuthorityTransportSigner(root, signerIdentifier(signerId));
}

export async function localRunnerSignerStatus(root, signerId) {
  const signer = await loadLocalAuthorityTransportSigner(root, signerIdentifier(signerId));
  return Object.freeze({
    schemaVersion: 1, kind: 'gdp-local-runner-status', status: 'ready',
    providerId: 'local-signed-runner', assurance: 'developer-local-signed',
    authority: 'developer-local', gateEligible: false, signerId: signer.keyId,
    signerKeySha256: signer.publicKeySha256,
    limitations: [
      'SAME_USER_IS_NOT_AN_INDEPENDENT_WITNESS',
      'NOT_ENTERPRISE_PROVIDER_AUTHORITY',
      'NOT_CONSUMED_BY_LIFECYCLE_GATES'
    ]
  });
}

export async function buildLocalRunnerPlan(root, definition, {
  workId, phaseId, commandId, signerId, proofSubjectSha256, candidateSha256
} = {}) {
  const normalizedPhaseId = identifier(phaseId, 'phaseId');
  const normalizedCommandId = identifier(commandId, 'commandId');
  const command = resolveLocalRunnerCommand(definition, normalizedPhaseId, normalizedCommandId);
  const signer = await loadLocalAuthorityTransportSigner(
    root, signerIdentifier(signerId)
  );
  const core = {
    schemaVersion: 1, // schema-transient: reviewed execution plan; never durably stored by SFlow
    kind: 'gdp-local-runner-plan', workId: workIdentifier(workId),
    phaseId: normalizedPhaseId, commandId: normalizedCommandId, signerId: signer.keyId,
    proofSubjectSha256: digest(proofSubjectSha256, 'proofSubjectSha256'),
    candidateSha256: digest(candidateSha256, 'candidateSha256'),
    repositoryHead: gitObject(head(root), 'repositoryHead'), repositoryTree: repositoryTree(root),
    command: structuredClone(command), commandSha256: commandIdentity(command),
    signerKeySha256: signer.publicKeySha256
  };
  return Object.freeze({ ...core, planSha256: sha(core) });
}

export function validateLocalRunnerPlan(value) {
  exactKeys(value, PLAN_FIELDS, 'local runner plan');
  if (value.schemaVersion !== 1 || value.kind !== 'gdp-local-runner-plan') { // schema-transient: caller-supplied execution plan
    fail('Local runner plan schema is not current.');
  }
  const command = normalizeExternalCommand(value.command);
  if (!command.argv?.length || command.command || command.modelPolicy !== 'never'
      || command.id !== value.commandId) {
    fail('Local runner plan command is not a shell-free configured model-free command.',
      'GDP_LOCAL_RUNNER_PLAN_TAMPERED');
  }
  const normalizedCommand = {
    ...command, workingDirectory: command.workingDirectory ?? '.',
    timeoutMs: command.timeoutMs ?? DEFAULT_TIMEOUT_MS
  };
  const normalized = {
    schemaVersion: 1, kind: value.kind,
    workId: workIdentifier(value.workId), phaseId: identifier(value.phaseId, 'phaseId'),
    commandId: identifier(value.commandId, 'commandId'), signerId: signerIdentifier(value.signerId),
    proofSubjectSha256: digest(value.proofSubjectSha256, 'proofSubjectSha256'),
    candidateSha256: digest(value.candidateSha256, 'candidateSha256'),
    repositoryHead: gitObject(value.repositoryHead, 'repositoryHead'),
    repositoryTree: gitObject(value.repositoryTree, 'repositoryTree'),
    command: normalizedCommand,
    commandSha256: digest(value.commandSha256, 'commandSha256'),
    signerKeySha256: digest(value.signerKeySha256, 'signerKeySha256')
  };
  if (normalized.commandSha256 !== commandIdentity(normalizedCommand)
      || value.planSha256 !== sha(normalized)) fail('Local runner plan digest is invalid.',
    'GDP_LOCAL_RUNNER_PLAN_TAMPERED');
  return Object.freeze({ ...normalized, planSha256: value.planSha256 });
}

export async function assertLocalRunnerPlanCurrent(root, definition, value) {
  const plan = validateLocalRunnerPlan(value);
  const command = resolveLocalRunnerCommand(definition, plan.phaseId, plan.commandId);
  const signer = await loadLocalAuthorityTransportSigner(root, plan.signerId);
  const changes = [];
  if (head(root) !== plan.repositoryHead) changes.push('repository HEAD');
  if (repositoryTree(root) !== plan.repositoryTree) changes.push('repository tree');
  if (commandIdentity(command) !== plan.commandSha256) changes.push('approved command');
  if (canonicalJson(command) !== canonicalJson(plan.command)) changes.push('reviewed command');
  if (signer.publicKeySha256 !== plan.signerKeySha256) changes.push('signing key');
  if (changes.length) fail(
    `Local runner plan is stale because ${changes.join(', ')} changed. Create and review a new plan.`,
    'GDP_LOCAL_RUNNER_PLAN_STALE', { changes }
  );
  return Object.freeze({ plan, command, signer });
}

function signedPayload(core) { return canonicalJson(core); }

function signAttestation(core, signer) {
  const key = createPrivateKey(signer.privateKeyPem);
  const payload = signedPayload(core);
  const signatureBytes = signBytes(null, Buffer.from(payload), key);
  const signature = {
    algorithm: 'ed25519', keyId: signer.keyId, keySha256: signer.publicKeySha256,
    payloadSha256: sha(payload), value: signatureBytes.toString('base64')
  };
  const sealed = { ...core, signature };
  return Object.freeze({ ...sealed, attestationSha256: sha(sealed) });
}

export function verifyLocalRunnerAttestation(value, {
  trustedPublicKeyPem, expectedKeyId = null
} = {}) {
  exactKeys(value, RECEIPT_FIELDS, 'local runner attestation');
  const readable = readRecord('local-runner-attestation', value);
  if (readable.migratedThrough.length || value.kind !== 'local-runner-attestation') {
    fail('Local runner attestation schema is not current.');
  }
  if (value.providerId !== 'local-signed-runner'
      || value.assurance !== 'developer-local-signed'
      || value.authority !== 'developer-local'
      || value.gateEligible !== false || value.consumedByLifecycle !== false) {
    fail('Local runner assurance boundary is invalid.');
  }
  [
    'proofSubjectSha256', 'candidateSha256', 'repositorySha256', 'workIdSha256',
    'phaseIdSha256', 'commandIdSha256', 'commandSha256', 'environmentSha256',
    'resultSha256', 'stdoutSha256', 'stderrSha256', 'nonceSha256'
  ].forEach((field) => digest(value[field], field));
  if (!['passed', 'failed', 'timed-out', 'unavailable'].includes(value.outcome)) {
    fail('Local runner outcome is invalid.');
  }
  if (!(value.exitCode === null || Number.isSafeInteger(value.exitCode))) fail('exitCode is invalid.');
  if (![value.stdoutBytes, value.stderrBytes].every((entry) => Number.isSafeInteger(entry) && entry >= 0)
      || ![value.stdoutTruncated, value.stderrTruncated, value.workingTreeStatusChanged]
        .every((entry) => typeof entry === 'boolean')) fail('Local runner result metadata is invalid.');
  instant(value.startedAt, 'startedAt'); instant(value.completedAt, 'completedAt');
  if (new Date(value.completedAt) < new Date(value.startedAt)) fail('completedAt precedes startedAt.');
  exactKeys(value.signature, SIGNATURE_FIELDS, 'local runner signature');
  if (value.signature.algorithm !== 'ed25519'
      || (expectedKeyId !== null && value.signature.keyId !== expectedKeyId)) {
    fail('Local runner signer is not trusted.', 'GDP_LOCAL_RUNNER_UNTRUSTED');
  }
  identifier(value.signature.keyId, 'signature.keyId');
  digest(value.signature.keySha256, 'signature.keySha256');
  digest(value.signature.payloadSha256, 'signature.payloadSha256');
  const canonicalSignature = Buffer.from(String(value.signature.value ?? ''), 'base64');
  if (!canonicalSignature.length
      || canonicalSignature.toString('base64') !== value.signature.value) {
    fail('Local runner signature bytes are invalid.', 'GDP_LOCAL_RUNNER_TAMPERED');
  }
  const trusted = createPublicKey(trustedPublicKeyPem);
  if (trusted.asymmetricKeyType !== 'ed25519') fail('Trusted local runner key must be Ed25519.',
    'GDP_LOCAL_RUNNER_UNTRUSTED');
  const trustedDigest = sha(trusted.export({ type: 'spki', format: 'der' }));
  if (!timingSafeEqual(Buffer.from(value.signature.keySha256), Buffer.from(trustedDigest))) {
    fail('Local runner signing key digest is not trusted.', 'GDP_LOCAL_RUNNER_UNTRUSTED');
  }
  const sealed = structuredClone(value); delete sealed.attestationSha256;
  if (value.attestationSha256 !== sha(sealed)) fail('Local runner attestation self hash is invalid.',
    'GDP_LOCAL_RUNNER_TAMPERED');
  const core = structuredClone(sealed); delete core.signature;
  const payload = signedPayload(core);
  const signatureBytes = canonicalSignature;
  if (value.signature.payloadSha256 !== sha(payload)
      || !verifyBytes(null, Buffer.from(payload), trusted, signatureBytes)) {
    fail('Local runner signature is invalid.', 'GDP_LOCAL_RUNNER_TAMPERED');
  }
  return Object.freeze(structuredClone(value));
}

/** Runs inside the dedicated local-runner process. */
export async function executeLocalRunnerWorker(root, definition, value) {
  const { plan, command, signer } = await assertLocalRunnerPlanCurrent(root, definition, value);
  const secured = await secureRepositoryPath(root, command.workingDirectory, {
    label: 'Local runner working directory', mustExist: true, type: 'directory'
  });
  const before = repositoryStatus(root);
  const startedAt = new Date().toISOString();
  const result = await runQualityCommand(command.argv[0], command.argv.slice(1), {
    cwd: secured.absolute, timeoutMs: command.timeoutMs, captureBytes: CAPTURE_BYTES,
    shell: false, killTree: true
  });
  const completedAt = new Date().toISOString();
  const after = repositoryStatus(root);
  const outcome = result.timedOut ? 'timed-out'
    : result.error ? 'unavailable' : result.status === 0 ? 'passed' : 'failed';
  const stdoutSha256 = sha(result.stdout); const stderrSha256 = sha(result.stderr);
  const resultSha256 = sha({
    outcome, exitCode: Number.isSafeInteger(result.status) ? result.status : null,
    stdoutSha256, stderrSha256, stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes,
    stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated,
    workingTreeStatusChanged: before !== after
  });
  const core = {
    schemaVersion: currentSchemaVersion('local-runner-attestation'),
    kind: 'local-runner-attestation', providerId: 'local-signed-runner',
    assurance: 'developer-local-signed', authority: 'developer-local',
    gateEligible: false, consumedByLifecycle: false,
    proofSubjectSha256: plan.proofSubjectSha256, candidateSha256: plan.candidateSha256,
    repositorySha256: sha({ head: plan.repositoryHead, tree: plan.repositoryTree }),
    workIdSha256: sha(plan.workId), phaseIdSha256: sha(plan.phaseId),
    commandIdSha256: sha(plan.commandId), commandSha256: plan.commandSha256,
    environmentSha256: sha({ platform: process.platform, architecture: process.arch,
      nodeVersion: process.versions.node }),
    resultSha256, stdoutSha256, stderrSha256,
    stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes,
    stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated,
    outcome, exitCode: Number.isSafeInteger(result.status) ? result.status : null,
    workingTreeStatusChanged: before !== after, startedAt, completedAt,
    nonceSha256: sha(randomBytes(32))
  };
  return signAttestation(core, signer);
}

export async function runLocalRunnerProcess(root, definition, value) {
  const { plan, command, signer } = await assertLocalRunnerPlanCurrent(root, definition, value);
  const worker = fileURLToPath(new URL('../../bin/sflow-local-runner.mjs', import.meta.url));
  const child = await runQualityCommand(process.execPath, [worker], {
    cwd: root, input: canonicalJson({ root, plan }), shell: false, killTree: true,
    timeoutMs: command.timeoutMs + CHILD_GRACE_MS, captureBytes: 1024 * 1024
  });
  if (child.timedOut) fail('Local signed runner exceeded its operation deadline.',
    'GDP_LOCAL_RUNNER_TIMEOUT');
  if (child.status !== 0 || child.error) fail(
    'Local signed runner process failed before returning a signed receipt.',
    'GDP_LOCAL_RUNNER_PROCESS_FAILED', { exitCode: child.status }
  );
  let attestation;
  try { attestation = JSON.parse(child.stdout); } catch {
    fail('Local signed runner returned malformed output.', 'GDP_LOCAL_RUNNER_PROCESS_FAILED');
  }
  return verifyLocalRunnerAttestation(attestation, {
    trustedPublicKeyPem: signer.publicKeyPem, expectedKeyId: signer.keyId
  });
}

export async function publishLocalRunnerAttestation(root, workId, value) {
  const safeWorkId = workIdentifier(workId);
  digest(value?.attestationSha256, 'attestationSha256');
  const directory = path.posix.join(
    'singularity', 'work-items', safeWorkId, 'gdp', 'evidence', 'local-runner-attestation'
  );
  await ensureSecureRepositoryDirectory(root, directory, {
    label: 'Local runner evidence directory'
  });
  const relative = path.posix.join(directory, `${value.attestationSha256.slice(7)}.json`);
  const secured = await secureRepositoryPath(root, relative, {
    label: 'Local runner evidence output'
  });
  const bytes = canonicalJson(value);
  try {
    await writeAtomicExclusive(secured.absolute, bytes);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readFile(secured.absolute, 'utf8');
    if (existing !== bytes) fail('Local runner evidence path is occupied by different bytes.',
      'GDP_LOCAL_RUNNER_TAMPERED');
  }
  return Object.freeze({ path: relative, sha256: sha(bytes), bytes: Buffer.byteLength(bytes) });
}

export async function verifyLocalRunnerAttestationWithSigner(root, value, signerId) {
  const signer = await loadLocalAuthorityTransportSigner(
    root, signerIdentifier(signerId)
  );
  return verifyLocalRunnerAttestation(value, {
    trustedPublicKeyPem: signer.publicKeyPem, expectedKeyId: signer.keyId
  });
}

export const LOCAL_RUNNER_ATTESTATION_FIELDS = RECEIPT_FIELDS;
export const localRunnerRecordSha256 = recordSha256;
