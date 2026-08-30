/** Typed governed Device ABI with a safe, read-only filesystem profile. */
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from '../git.mjs';
import { canonicalJson } from '../records.mjs';
import { SingularityFlowError, nowIso } from '../util.mjs';
import { sha256 } from './contracts.mjs';
import { readPrivateSidecar, writeImmutablePrivateSidecar } from './private-sidecar.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9-]{1,63}$/;
const MAX_RAW_BYTES = 64 * 1024 * 1024;
const MAX_DEVICE_RECORD_BYTES = 64 * 1024 * 1024;
const DEVICE_RECORD_FORMAT = 'sflow.sgos.device-private';
const DEVICE_RECORD_VERSION = 1;

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, label, code = 'SGOS_DEVICE_CONTRACT_INVALID') {
  if (!plain(value)) fail(`${label} must be an object.`, code);
  const accepted = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !accepted.has(key));
  if (unexpected.length) fail(`${label} contains unsupported field(s): ${unexpected.join(', ')}.`, code, { unexpected });
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function seal(kind, hashField, value) {
  // These records live only in the private Git-common device ledger. They are deliberately not
  // migration-registry records, so use an explicit private format/version rather than pretending
  // that a hard-coded schemaVersion participates in the durable schema registry.
  const core = {
    deviceRecordFormat: DEVICE_RECORD_FORMAT,
    deviceRecordVersion: DEVICE_RECORD_VERSION,
    kind,
    ...structuredClone(value)
  };
  delete core[hashField];
  return freezeDeep({ ...core, [hashField]: sha256(core) });
}

function bytesSha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function createDeviceManifest(value) {
  exactKeys(value, [
    'id', 'version', 'publisher', 'operations', 'effects', 'scopeModel', 'idempotency',
    'recovery', 'assurance', 'tests'
  ], 'Device manifest', 'SGOS_DEVICE_MANIFEST_INVALID');
  if (!ID.test(String(value.id ?? '')) || typeof value.version !== 'string' || !value.version) {
    fail('Device manifest has an invalid ID or version.', 'SGOS_DEVICE_MANIFEST_INVALID');
  }
  if (typeof value.publisher !== 'string' || !value.publisher || !Array.isArray(value.operations)
      || value.operations.some((entry) => typeof entry !== 'string' || !entry)
      || new Set(value.operations).size !== value.operations.length) {
    fail('Device manifest publisher and operations are invalid.', 'SGOS_DEVICE_MANIFEST_INVALID');
  }
  for (const field of ['effects', 'scopeModel', 'idempotency', 'recovery', 'assurance', 'tests']) {
    if (!plain(value[field])) fail(`Device manifest ${field} must be an object.`, 'SGOS_DEVICE_MANIFEST_INVALID');
  }
  if (!HASH.test(String(value.tests.conformanceReceiptSha256 ?? ''))) {
    fail('Device manifest requires a conformance receipt.', 'SGOS_DEVICE_MANIFEST_INVALID');
  }
  return seal('device-manifest', 'manifestSha256', value);
}

export function validateDeviceManifest(value) {
  if (value?.kind !== 'device-manifest' || !HASH.test(String(value.manifestSha256 ?? ''))) {
    fail('Device manifest is invalid.', 'SGOS_DEVICE_MANIFEST_INVALID');
  }
  const core = structuredClone(value);
  delete core.deviceRecordFormat;
  delete core.deviceRecordVersion;
  delete core.kind;
  delete core.manifestSha256;
  const rebuilt = createDeviceManifest(core);
  if (canonicalJson(rebuilt) !== canonicalJson(value)) {
    fail('Device manifest failed its exact content hash.', 'SGOS_DEVICE_MANIFEST_MISMATCH');
  }
  return freezeDeep(structuredClone(value));
}

export function createToolIntent(value) {
  exactKeys(value, [
    'processId', 'taskInstanceId', 'attemptId', 'deviceManifestSha256', 'operation',
    'argumentsSha256', 'scopeSha256', 'expectedEffect', 'authorizationSha256',
    'idempotencyKey', 'createdAt'
  ], 'Tool Intent', 'SGOS_TOOL_INTENT_INVALID');
  for (const field of ['processId', 'taskInstanceId', 'attemptId', 'operation', 'expectedEffect', 'createdAt']) {
    if (typeof value[field] !== 'string' || !value[field]) fail(`Tool Intent ${field} is required.`, 'SGOS_TOOL_INTENT_INVALID');
  }
  for (const field of [
    'deviceManifestSha256', 'argumentsSha256', 'scopeSha256', 'authorizationSha256', 'idempotencyKey'
  ]) if (!HASH.test(String(value[field] ?? ''))) fail(`Tool Intent ${field} must be an exact digest.`, 'SGOS_TOOL_INTENT_INVALID');
  return seal('tool-intent', 'intentSha256', value);
}

export function createToolResult(value) {
  exactKeys(value, [
    'intentSha256', 'status', 'rawResultRef', 'rawResultSha256', 'observation', 'effect',
    'assurance', 'observedAt', 'verification'
  ], 'Tool Result', 'SGOS_TOOL_RESULT_INVALID');
  if (!HASH.test(String(value.intentSha256 ?? '')) || !HASH.test(String(value.rawResultSha256 ?? ''))) {
    fail('Tool Result must bind an exact Intent and raw result.', 'SGOS_TOOL_RESULT_INVALID');
  }
  if (!['observed', 'uncertain', 'failed'].includes(value.status)
      || typeof value.rawResultRef !== 'string' || !value.rawResultRef.startsWith('sfref:')
      || typeof value.assurance !== 'string' || !value.assurance
      || typeof value.observedAt !== 'string') {
    fail('Tool Result has an invalid status, evidence reference, assurance, or time.', 'SGOS_TOOL_RESULT_INVALID');
  }
  for (const field of ['observation', 'effect', 'verification']) {
    if (!plain(value[field])) fail(`Tool Result ${field} must be an object.`, 'SGOS_TOOL_RESULT_INVALID');
  }
  return seal('tool-result', 'resultSha256', value);
}

function deviceRoot(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'sgos', 'devices');
}

function intentPath(root, intentSha256) {
  return path.join(deviceRoot(root), 'intents', `${intentSha256.slice('sha256:'.length)}.json`);
}

function resultPath(root, resultSha256) {
  return path.join(deviceRoot(root), 'results', `${resultSha256.slice('sha256:'.length)}.json`);
}

function resultByIntentPath(root, intentSha256) {
  return path.join(deviceRoot(root), 'results-by-intent',
    `${intentSha256.slice('sha256:'.length)}.json`);
}

function rawPath(root, intentSha256) {
  return path.join(deviceRoot(root), 'raw', `${intentSha256.slice('sha256:'.length)}.bin`);
}

function revocationPath(root, manifestSha256) {
  return path.join(deviceRoot(root), 'revocations', `${manifestSha256.slice('sha256:'.length)}.json`);
}

async function immutableWrite(root, target, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(canonicalJson(value));
  try {
    await writeImmutablePrivateSidecar(root, target, bytes, {
      maximumBytes: MAX_DEVICE_RECORD_BYTES
    });
  } catch (error) {
    if (error?.code === 'SGOS_SIDECAR_RECORD_CONFLICT') {
      fail('Device immutable record conflicts with existing bytes.', 'SGOS_DEVICE_RECORD_CONFLICT');
    }
    throw error;
  }
}

function normalizeDeviceRequest(request) {
  exactKeys(request, [
    'deviceId', 'processId', 'taskInstanceId', 'attemptId', 'operation', 'arguments',
    'scope', 'authorizationSha256', 'createdAt'
  ], 'Device request', 'SGOS_DEVICE_REQUEST_INVALID');
  const value = structuredClone(request);
  for (const field of ['deviceId', 'processId', 'taskInstanceId', 'attemptId', 'operation']) {
    if (typeof value[field] !== 'string' || !value[field]) {
      fail(`Device request ${field} is required.`, 'SGOS_DEVICE_REQUEST_INVALID');
    }
  }
  if (!plain(value.arguments) || !Array.isArray(value.scope)
      || value.scope.some((entry) => typeof entry !== 'string' || !entry)) {
    fail('Device request arguments and scope are invalid.', 'SGOS_DEVICE_REQUEST_INVALID');
  }
  if (!HASH.test(String(value.authorizationSha256 ?? ''))) {
    fail('Device request requires exact authorization.', 'SGOS_DEVICE_AUTHORIZATION_REQUIRED');
  }
  if (value.createdAt != null && typeof value.createdAt !== 'string') {
    fail('Device request createdAt must be a timestamp string.', 'SGOS_DEVICE_REQUEST_INVALID');
  }
  if (value.createdAt != null && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value.createdAt)
      || !Number.isFinite(Date.parse(value.createdAt)))) {
    fail('Device request createdAt must be a valid UTC timestamp.', 'SGOS_DEVICE_REQUEST_INVALID');
  }
  value.scope.forEach((entry, index) => canonicalRepositoryPath(entry, `Device request scope[${index}]`));
  return freezeDeep(value);
}

function assertRequestMatchesIntent(request, intent, manifest) {
  const expected = {
    processId: request.processId,
    taskInstanceId: request.taskInstanceId,
    attemptId: request.attemptId,
    deviceManifestSha256: manifest.manifestSha256,
    operation: request.operation,
    argumentsSha256: sha256(request.arguments),
    scopeSha256: sha256(request.scope),
    authorizationSha256: request.authorizationSha256
  };
  for (const [field, value] of Object.entries(expected)) {
    if (intent[field] !== value) {
      fail(`Device request no longer matches durable Tool Intent field '${field}'.`,
        'SGOS_TOOL_INTENT_REQUEST_MISMATCH', { field });
    }
  }
}

async function readResultForIntent(root, intentSha256) {
  try {
    const result = JSON.parse((await readPrivateSidecar(
      root, resultByIntentPath(root, intentSha256), {
        maximumBytes: MAX_DEVICE_RECORD_BYTES
      }
    )).toString('utf8'));
    if (result?.intentSha256 !== intentSha256) {
      fail('Tool Result does not bind its deterministic Intent path.', 'SGOS_TOOL_RESULT_INVALID');
    }
    const core = structuredClone(result);
    delete core.deviceRecordFormat; delete core.deviceRecordVersion;
    delete core.kind; delete core.resultSha256;
    const verified = createToolResult(core);
    if (verified.resultSha256 !== result.resultSha256
        || canonicalJson(verified) !== canonicalJson(result)) {
      fail('Tool Result failed its exact content hash.', 'SGOS_TOOL_RESULT_INVALID');
    }
    let canonicalResult;
    try {
      canonicalResult = (await readPrivateSidecar(root, resultPath(root, result.resultSha256), {
        maximumBytes: MAX_DEVICE_RECORD_BYTES
      })).toString('utf8');
    }
    catch (error) {
      fail('Tool Result immutable record is missing.', 'SGOS_TOOL_RESULT_INVALID', {
        causeCode: error?.code ?? null
      });
    }
    if (canonicalJson(result) !== canonicalResult) {
      fail('Tool Result index does not match its immutable result record.', 'SGOS_TOOL_RESULT_INVALID');
    }
    if (result.rawResultRef !== `sfref:v1:device-raw:${intentSha256.slice('sha256:'.length)}`) {
      fail('Tool Result raw reference does not bind its Intent.', 'SGOS_TOOL_RESULT_INVALID');
    }
    let raw;
    try {
      raw = await readPrivateSidecar(root, rawPath(root, intentSha256), {
        maximumBytes: MAX_RAW_BYTES
      });
    } catch (error) {
      fail('Tool Result raw evidence is missing.', 'SGOS_TOOL_RESULT_INVALID', {
        causeCode: error?.code ?? null
      });
    }
    if (raw.length > MAX_RAW_BYTES || bytesSha256(raw) !== result.rawResultSha256) {
      fail('Tool Result raw evidence is missing or changed.', 'SGOS_TOOL_RESULT_INVALID');
    }
    return freezeDeep(result);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

const FILESYSTEM_READ_MANIFEST = createDeviceManifest({
  id: 'filesystem-read', version: '1.0.0', publisher: 'singularity-flow',
  operations: ['read-file', 'stat'], effects: { class: 'read-only' },
  scopeModel: { kind: 'repository-path-allowlist' },
  idempotency: { readFile: true, stat: true },
  recovery: { uncertainRead: 'repeat-with-same-arguments' },
  assurance: { result: 'host-observed' },
  tests: { conformanceReceiptSha256: sha256('sgos-filesystem-read-device-v1') }
});

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalRepositoryPath(value, label = 'Filesystem Device path') {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\0')
      || value.includes('\\') || value.startsWith('/') || value.endsWith('/')
      || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail(`${label} must be a canonical repository-relative path.`, 'SGOS_DEVICE_SCOPE_ESCAPE');
  }
  return value;
}

async function secureReadPath(root, relative, scope) {
  const normalized = canonicalRepositoryPath(relative);
  if (!Array.isArray(scope) || !scope.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
    fail(`Filesystem Device path '${normalized}' is outside the declared scope.`, 'SGOS_DEVICE_SCOPE_ESCAPE');
  }
  const resolvedRoot = await realpath(root);
  const lexical = path.join(resolvedRoot, ...normalized.split('/'));
  let component = resolvedRoot;
  for (const part of normalized.split('/')) {
    component = path.join(component, part);
    const info = await lstat(component);
    if (info.isSymbolicLink()) {
      fail('Filesystem Device scope cannot traverse symbolic links.', 'SGOS_DEVICE_SCOPE_ESCAPE');
    }
  }
  const resolved = await realpath(lexical);
  // Being inside the repository is not enough: a scoped link could redirect `docs/input` to an
  // unrelated in-repository secret. Exact lexical equality proves the allowed path itself was
  // opened, and the post-open check below closes an intermediate-component swap window.
  if (!inside(resolvedRoot, resolved) || resolved !== lexical) {
    fail('Filesystem Device path escapes its declared scope through a link.', 'SGOS_DEVICE_SCOPE_ESCAPE');
  }
  return { normalized, resolved, resolvedRoot, lexical };
}

function filesystemReadDevice(root) {
  return Object.freeze({
    descriptor: () => FILESYSTEM_READ_MANIFEST,
    async doctor() {
      return seal('device-attestation', 'attestationSha256', {
        deviceManifestSha256: FILESYSTEM_READ_MANIFEST.manifestSha256,
        status: 'ready', observedAt: nowIso(), assurance: 'host-observed'
      });
    },
    async plan(request) {
      if (!FILESYSTEM_READ_MANIFEST.operations.includes(request.operation)) {
        fail(`Filesystem Device operation '${request.operation}' is not installed.`, 'SGOS_DEVICE_OPERATION_UNKNOWN');
      }
      const authorizationSha256 = request.authorizationSha256;
      if (!HASH.test(String(authorizationSha256 ?? ''))) fail('Device request requires exact authorization.', 'SGOS_DEVICE_AUTHORIZATION_REQUIRED');
      return createToolIntent({
        processId: request.processId,
        taskInstanceId: request.taskInstanceId,
        attemptId: request.attemptId,
        deviceManifestSha256: FILESYSTEM_READ_MANIFEST.manifestSha256,
        operation: request.operation,
        argumentsSha256: sha256(request.arguments),
        scopeSha256: sha256(request.scope),
        expectedEffect: 'read-only-observation',
        authorizationSha256,
        idempotencyKey: sha256({
          device: FILESYSTEM_READ_MANIFEST.manifestSha256,
          operation: request.operation,
          arguments: request.arguments,
          scope: request.scope,
          authorizationSha256
        }),
        createdAt: request.createdAt ?? nowIso()
      });
    },
    async execute(intent, request, signal) {
      if (signal?.aborted) {
        fail('Filesystem Device invocation was cancelled.', 'SGOS_DEVICE_CANCELLED');
      }
      const secured = await secureReadPath(root, request.arguments.path, request.scope);
      let handle;
      try {
        handle = await open(secured.resolved,
          fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        // Re-resolve after opening. The descriptor pins the object while this check catches a path
        // swapped between the first realpath and open on ordinary hosts.
        const afterOpen = await realpath(path.join(root, secured.normalized));
        if (afterOpen !== secured.resolved || afterOpen !== secured.lexical
            || !inside(secured.resolvedRoot, afterOpen)) {
          fail('Filesystem Device path changed while it was being opened.', 'SGOS_DEVICE_SCOPE_ESCAPE');
        }
        const stats = await handle.stat();
        const pathStats = await lstat(secured.lexical);
        // `realpath(path)` alone cannot prove what an already-open descriptor references: an
        // attacker could swap a component out and back around open(). Device/inode equality binds
        // the descriptor we will read to the exact non-link object currently at the approved path.
        if (pathStats.isSymbolicLink() || pathStats.dev !== stats.dev || pathStats.ino !== stats.ino) {
          fail('Filesystem Device descriptor does not match the approved repository path.',
            'SGOS_DEVICE_SCOPE_ESCAPE');
        }
        if (intent.operation === 'stat') {
          return Buffer.from(canonicalJson({
            path: secured.normalized, type: stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other',
            size: stats.size, mode: stats.mode & 0o777
          }));
        }
        if (!stats.isFile()) {
          fail('Filesystem Device read-file accepts regular files only.', 'SGOS_DEVICE_SCOPE_ESCAPE');
        }
        if (stats.size > MAX_RAW_BYTES) {
          fail('Filesystem Device raw result exceeds its byte ceiling.', 'SGOS_DEVICE_RESULT_LIMIT');
        }
        const bytes = await handle.readFile();
        if (bytes.length > MAX_RAW_BYTES) fail('Filesystem Device raw result exceeds its byte ceiling.', 'SGOS_DEVICE_RESULT_LIMIT');
        return bytes;
      } finally {
        await handle?.close();
      }
    },
    async normalize(intent, raw) {
      return {
        observation: intent.operation === 'stat'
          ? JSON.parse(raw.toString('utf8'))
          : { bytes: raw.length, contentSha256: bytesSha256(raw) },
        effect: { class: 'none', changed: false },
        assurance: 'host-observed'
      };
    },
    async verify(intent, normalized, rawSha256) {
      return {
        status: normalized.effect.changed === false && HASH.test(rawSha256) ? 'passed' : 'failed',
        checksSha256: sha256({ intentSha256: intent.intentSha256, normalized, rawSha256 })
      };
    },
    async recover(intent, request, signal) {
      return this.execute(intent, request, signal);
    }
  });
}

async function assertNotRevoked(root, manifest) {
  try {
    const record = JSON.parse((await readPrivateSidecar(
      root, revocationPath(root, manifest.manifestSha256), {
        maximumBytes: MAX_DEVICE_RECORD_BYTES
      }
    )).toString('utf8'));
    const core = structuredClone(record);
    delete core.revocationSha256;
    if (record.deviceRecordFormat !== DEVICE_RECORD_FORMAT
        || record.deviceRecordVersion !== DEVICE_RECORD_VERSION
        || record.kind !== 'device-revocation'
        || record.manifestSha256 !== manifest.manifestSha256
        || !HASH.test(String(record.revocationSha256 ?? ''))
        || sha256(core) !== record.revocationSha256) {
      fail('Device revocation record is corrupt.', 'SGOS_DEVICE_RECORD_CORRUPT');
    }
    fail(`Device '${manifest.id}' is revoked.`, 'SGOS_DEVICE_REVOKED', {
      revocationSha256: record.revocationSha256
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function installedDeviceManifests() {
  return Object.freeze([FILESYSTEM_READ_MANIFEST]);
}

export async function doctorSgosDevice(root, deviceId) {
  const device = deviceId === FILESYSTEM_READ_MANIFEST.id ? filesystemReadDevice(root) : null;
  if (!device) fail(`Device '${deviceId}' is not installed.`, 'SGOS_DEVICE_NOT_INSTALLED');
  await assertNotRevoked(root, device.descriptor());
  return device.doctor({ root });
}

export async function invokeSgosDevice(root, request, { signal = null, recover = false } = {}) {
  const normalizedRequest = normalizeDeviceRequest(request);
  const device = normalizedRequest.deviceId === FILESYSTEM_READ_MANIFEST.id ? filesystemReadDevice(root) : null;
  if (!device) fail(`Device '${normalizedRequest.deviceId}' is not installed.`, 'SGOS_DEVICE_NOT_INSTALLED');
  const manifest = validateDeviceManifest(device.descriptor());
  await assertNotRevoked(root, manifest);
  const intent = await device.plan(normalizedRequest, { root });
  assertRequestMatchesIntent(normalizedRequest, intent, manifest);
  // Tool Intent is durable before the device can observe or affect anything.
  await immutableWrite(root, intentPath(root, intent.intentSha256), intent);
  const existing = await readResultForIntent(root, intent.intentSha256);
  if (existing) return Object.freeze({ manifest, intent, result: existing, recovered: true });
  let raw;
  try {
    raw = recover
      ? await device.recover(intent, normalizedRequest, signal)
      : await device.execute(intent, normalizedRequest, signal);
  } catch (error) {
    const failure = error instanceof Error ? error : new SingularityFlowError(
      'Device invocation failed without a typed error.', { code: 'SGOS_DEVICE_FAILED' });
    try { failure.toolIntentSha256 = intent.intentSha256; } catch { /* error may be frozen */ }
    if (manifest.effects.class !== 'read-only') {
      try { failure.uncertainEffect = true; } catch { /* error may be frozen */ }
    }
    throw failure;
  }
  // Close the check/use window: a revocation recorded while a bounded read was in flight prevents
  // that observation from becoming an authoritative Tool Result.
  await assertNotRevoked(root, manifest);
  if (!Buffer.isBuffer(raw)) raw = Buffer.from(canonicalJson(raw));
  if (raw.length > MAX_RAW_BYTES) fail('Device raw result exceeds its byte ceiling.', 'SGOS_DEVICE_RESULT_LIMIT');
  const rawResultSha256 = bytesSha256(raw);
  await immutableWrite(root, rawPath(root, intent.intentSha256), raw);
  const normalized = await device.normalize(intent, raw);
  const verification = await device.verify(intent, normalized, rawResultSha256);
  const result = createToolResult({
    intentSha256: intent.intentSha256,
    status: verification.status === 'passed' ? 'observed' : 'uncertain',
    rawResultRef: `sfref:v1:device-raw:${intent.intentSha256.slice('sha256:'.length)}`,
    rawResultSha256,
    observation: normalized.observation,
    effect: normalized.effect,
    assurance: normalized.assurance,
    observedAt: nowIso(),
    verification
  });
  await immutableWrite(root, resultPath(root, result.resultSha256), result);
  await immutableWrite(root, resultByIntentPath(root, intent.intentSha256), result);
  return Object.freeze({ manifest, intent, result });
}

export async function recoverSgosToolIntent(root, intentSha256, request, { signal = null } = {}) {
  const intent = await readSgosToolIntent(root, intentSha256);
  const normalizedRequest = normalizeDeviceRequest(request);
  const manifest = installedDeviceManifests()
    .find((entry) => entry.manifestSha256 === intent.deviceManifestSha256);
  if (!manifest || manifest.id !== normalizedRequest.deviceId) {
    fail('Durable Tool Intent refers to an unavailable Device manifest.',
      'SGOS_DEVICE_NOT_INSTALLED', { deviceManifestSha256: intent.deviceManifestSha256 });
  }
  assertRequestMatchesIntent(normalizedRequest, intent, manifest);
  const existing = await readResultForIntent(root, intentSha256);
  if (existing) return Object.freeze({ manifest, intent, result: existing, recovered: true });
  // The Device recomputes the same deterministic Intent from the exact request. A mismatch is
  // refused by invokeSgosDevice before any recovery observation can occur.
  return invokeSgosDevice(root, {
    ...normalizedRequest,
    createdAt: intent.createdAt
  }, { signal, recover: true });
}

export async function readSgosToolResult(root, intentSha256) {
  if (!HASH.test(String(intentSha256 ?? ''))) {
    fail('Tool Intent SHA is invalid.', 'SGOS_TOOL_INTENT_INVALID');
  }
  const result = await readResultForIntent(root, intentSha256);
  if (!result) fail('Tool Result was not found.', 'SGOS_TOOL_RESULT_NOT_FOUND', { intentSha256 });
  return result;
}

export async function revokeSgosDevice(root, manifestSha256, {
  reason, confirmationSha256, revokedAt = nowIso()
} = {}) {
  const manifest = installedDeviceManifests().find((entry) => entry.manifestSha256 === manifestSha256);
  if (!manifest) fail('Only an exact installed Device manifest can be revoked.', 'SGOS_DEVICE_NOT_INSTALLED');
  if (typeof reason !== 'string' || !reason.trim()) fail('Device revocation requires a reason.', 'SGOS_DEVICE_REVOCATION_INVALID');
  const normalizedReason = reason.trim();
  const planSha256 = sha256({ kind: 'device-revocation-plan', manifestSha256, reason: normalizedReason });
  if (confirmationSha256 !== planSha256) {
    return Object.freeze({
      revoked: false, manifestSha256, reason: normalizedReason, confirmationSha256: planSha256
    });
  }
  const record = seal('device-revocation', 'revocationSha256', {
    manifestSha256, reason: normalizedReason, revokedAt
  });
  await immutableWrite(root, revocationPath(root, manifestSha256), record);
  return Object.freeze({ revoked: true, record });
}

export async function readSgosToolIntent(root, intentSha256) {
  if (!HASH.test(String(intentSha256 ?? ''))) fail('Tool Intent SHA is invalid.', 'SGOS_TOOL_INTENT_INVALID');
  const record = JSON.parse((await readPrivateSidecar(root, intentPath(root, intentSha256), {
    maximumBytes: MAX_DEVICE_RECORD_BYTES
  })).toString('utf8'));
  if (record.intentSha256 !== intentSha256) fail('Tool Intent path and content disagree.', 'SGOS_TOOL_INTENT_INVALID');
  const core = structuredClone(record);
  delete core.deviceRecordFormat; delete core.deviceRecordVersion;
  delete core.kind; delete core.intentSha256;
  if (createToolIntent(core).intentSha256 !== intentSha256) fail('Tool Intent failed its content hash.', 'SGOS_TOOL_INTENT_INVALID');
  return freezeDeep(record);
}
