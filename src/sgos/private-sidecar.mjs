/** SGOS compatibility boundary over the product-neutral hardened private sidecar store. */
import {
  listPrivateSidecar as listCorePrivateSidecar,
  readPrivateSidecar as readCorePrivateSidecar,
  safePrivateSidecarDirectory as safeCorePrivateSidecarDirectory,
  writeImmutablePrivateSidecar as writeCoreImmutablePrivateSidecar,
  writeMutablePrivateSidecar as writeCoreMutablePrivateSidecar
} from '../private-sidecar.mjs';
import { SingularityFlowError } from '../util.mjs';

function translate(error) {
  const code = {
    PRIVATE_SIDECAR_PATH_UNSAFE: 'SGOS_SIDECAR_PATH_UNSAFE',
    PRIVATE_RECORD_SIZE_LIMIT: 'SGOS_RECORD_SIZE_LIMIT',
    PRIVATE_SIDECAR_RECORD_CONFLICT: 'SGOS_SIDECAR_RECORD_CONFLICT'
  }[error?.code];
  if (!code) throw error;
  throw new SingularityFlowError(error.message, {
    code, details: error.details ?? null, cause: error
  });
}

async function call(operation) {
  try { return await operation(); } catch (error) { return translate(error); }
}

export async function safePrivateSidecarDirectory(root, directory, options) {
  return call(() => safeCorePrivateSidecarDirectory(root, directory, options));
}

export async function readPrivateSidecar(root, target, options) {
  return call(() => readCorePrivateSidecar(root, target, options));
}

export async function writeMutablePrivateSidecar(root, target, bytes, options) {
  return call(() => writeCoreMutablePrivateSidecar(root, target, bytes, options));
}

export async function writeImmutablePrivateSidecar(root, target, bytes, options) {
  return call(() => writeCoreImmutablePrivateSidecar(root, target, bytes, options));
}

export async function listPrivateSidecar(root, directory, options) {
  return call(() => listCorePrivateSidecar(root, directory, options));
}
