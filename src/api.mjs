import { repoRoot } from './git.mjs';
import { createFaultRepairApi } from './fault-repair.mjs';

/**
 * Stable in-process surface for integrations that should not scrape CLI output.
 * The returned methods call the same validation and policy boundary as the CLI.
 */
export function createSflow({ root = repoRoot(), faultRepairPolicy = {} } = {}) {
  return createFaultRepairApi(root, { policy: faultRepairPolicy });
}

export { createFaultRepairApi } from './fault-repair.mjs';
