/**
 * Whether a mutation in this repository must first check the build its approved configuration
 * requires.
 *
 * Cheap, because it runs before every mutation: one lstat for the materialized requirement file,
 * and one small machine-local record of the last verdict per repository. A repository without the
 * file never pays for more. The approved read and any install load only when this returns a build.
 */
import { lstat, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BUILD_INFO, versionLine } from './build-info.mjs';
import { PRODUCT_ALIGNMENT_EXEMPT_COMMANDS } from './product-alignment-gate.mjs';

export const PRODUCT_UPDATE_SWITCH = 'SINGULARITY_FLOW_PRODUCT_UPDATE';
export const PRODUCT_REQUIREMENT_CHECKS = 'requirement-checks.json';
/** How long a verdict stands before the approved requirement is read again. */
export const REQUIREMENT_VERDICT_TTL_MS = Object.freeze({
  satisfied: 24 * 60 * 60 * 1000,
  none: 24 * 60 * 60 * 1000,
  development: 24 * 60 * 60 * 1000,
  unknown: 24 * 60 * 60 * 1000,
  unavailable: 60 * 60 * 1000,
  failed: 60 * 60 * 1000
});

export function requirementChecksFile(homeDirectory = os.homedir()) {
  return path.join(homeDirectory, '.singularity-flow', 'installations', PRODUCT_REQUIREMENT_CHECKS);
}

export function productUpdateDisabled(environment = process.env) {
  return ['off', '0', 'false', 'no'].includes(String(environment?.[PRODUCT_UPDATE_SWITCH] ?? '').trim().toLowerCase());
}

/** The running build line when the requirement must be checked now, or null. Never throws. */
export async function productRequirementDue({
  root,
  command,
  classification,
  homeDirectory = os.homedir(),
  environment = process.env,
  info = BUILD_INFO,
  now = Date.now()
} = {}) {
  try {
    if (!root || classification !== 'mutation' || PRODUCT_ALIGNMENT_EXEMPT_COMMANDS.has(command)) return null;
    if (productUpdateDisabled(environment)) return null;
    if (!info?.commit && !info?.sourceSha256) return null;
    if (!(await lstat(path.join(root, 'singularity', 'product.yml')).catch(() => null))?.isFile()) return null;
    const running = versionLine(info);
    const key = await realpath(root).catch(() => path.resolve(root));
    let entry = null;
    try { entry = JSON.parse(await readFile(requirementChecksFile(homeDirectory), 'utf8'))?.repositories?.[key] ?? null; }
    catch { entry = null; }
    const ttl = REQUIREMENT_VERDICT_TTL_MS[entry?.verdict];
    if (entry?.build === running && ttl && now - Date.parse(entry.checkedAt ?? '') < ttl) return null;
    return running;
  } catch {
    return null;
  }
}
