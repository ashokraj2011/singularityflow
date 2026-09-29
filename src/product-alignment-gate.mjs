/**
 * Whether this build still owes the machine its one first-run pass: aligning the product surfaces
 * and repairing machine-local state.
 *
 * Checked before every mutation command, so it must stay cheap: no Git, no subprocess, and none of
 * the installer modules. It answers from one small file and the running build's own stamp. The
 * pass itself, with its full validation, loads only when this returns a build.
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BUILD_INFO, versionLine } from './build-info.mjs';

export const PRODUCT_ALIGNMENT_SWITCH = 'SINGULARITY_FLOW_PRODUCT_ALIGNMENT';

/** Commands that own the product surfaces themselves, or that alignment runs. */
export const PRODUCT_ALIGNMENT_EXEMPT_COMMANDS = Object.freeze(new Set([
  'product', 'plugin', 'reinstall', 'fresh-install', 'factory-reset', 'reset-all', 'local-reset'
]));

export function productAlignmentDisabled(environment = process.env) {
  return ['off', '0', 'false', 'no'].includes(String(environment?.[PRODUCT_ALIGNMENT_SWITCH] ?? '').trim().toLowerCase());
}

/** The running build line when a pass is due, or null. Never throws. */
export async function firstRunPassDue({
  command,
  classification,
  homeDirectory = os.homedir(),
  environment = process.env,
  info = BUILD_INFO
} = {}) {
  try {
    if (classification !== 'mutation' || PRODUCT_ALIGNMENT_EXEMPT_COMMANDS.has(command)) return null;
    if (productAlignmentDisabled(environment)) return null;
    // A development checkout cannot be told apart from another one, and never replaces anything.
    if (!info?.commit && !info?.sourceSha256) return null;
    const running = versionLine(info);
    const installations = path.join(homeDirectory, '.singularity-flow', 'installations');
    try {
      const recorded = JSON.parse(await readFile(path.join(installations, 'alignment-current.json'), 'utf8'));
      if (recorded?.builds && Object.hasOwn(recorded.builds, running)) return null;
    } catch { /* No pass recorded yet. */ }
    return running;
  } catch {
    return null;
  }
}
