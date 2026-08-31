/** Hardened, bounded storage boundary for machine-local Auto records below the Git common dir. */
import {
  listPrivateSidecar, readPrivateSidecar, writeImmutablePrivateSidecar,
  writeMutablePrivateSidecar
} from '../sgos/private-sidecar.mjs';
import { SingularityFlowError } from '../util.mjs';

export const AUTO_PRIVATE_RECORD_LIMITS = Object.freeze({
  plan: 2 * 1024 * 1024,
  authorization: 256 * 1024,
  'flight-state': 8 * 1024 * 1024,
  'flight-report': 8 * 1024 * 1024
});

function maximumBytes(kind) {
  const maximum = AUTO_PRIVATE_RECORD_LIMITS[kind];
  if (!maximum) throw new SingularityFlowError(`Unknown Auto private record kind '${kind}'.`, {
    code: 'AUTO_PRIVATE_STORE_KIND_INVALID'
  });
  return maximum;
}

function translate(error, kind) {
  const code = {
    SGOS_SIDECAR_PATH_UNSAFE: 'AUTO_PRIVATE_STORE_UNSAFE',
    SGOS_RECORD_SIZE_LIMIT: 'AUTO_PRIVATE_STORE_SIZE_LIMIT',
    SGOS_SIDECAR_RECORD_CONFLICT: 'AUTO_PRIVATE_STORE_CONFLICT'
  }[error?.code];
  if (!code) throw error;
  throw new SingularityFlowError(`Auto ${kind} private storage refused an unsafe record: ${error.message}`, {
    code, details: { kind, ...(error.details ?? {}) }, cause: error
  });
}

export async function readAutoPrivateRecord(root, target, kind, { optional = false } = {}) {
  try {
    const bytes = await readPrivateSidecar(root, target, {
      maximumBytes: maximumBytes(kind), optional
    });
    return bytes == null ? null : bytes.toString('utf8');
  } catch (error) { return translate(error, kind); }
}

export async function writeAutoPrivateRecord(root, target, kind, value, {
  immutable = false
} = {}) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array ? value : Buffer.from(value);
  try {
    const writer = immutable ? writeImmutablePrivateSidecar : writeMutablePrivateSidecar;
    return await writer(root, target, bytes, { maximumBytes: maximumBytes(kind) });
  } catch (error) { return translate(error, kind); }
}

export async function listAutoPrivateRecords(root, directory) {
  try {
    return await listPrivateSidecar(root, directory, { optional: true });
  } catch (error) { return translate(error, 'flight-state'); }
}
