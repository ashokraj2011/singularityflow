/**
 * One value that changes whenever the running engine does. `[perf]`
 *
 * Machine-local receipts minted by one build must not steer another. A stamped package already
 * names its commit or source digest. A development checkout carries no stamp, and its version has
 * stayed the same across hundreds of changed lines, so the modules that decide Story intake and
 * start are identified by size and modification time as well. Nothing here reads file content or
 * records a path.
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { versionLine } from './build-info.mjs';

const DECIDING_MODULES = Object.freeze([
  'cli.mjs', 'capability-start.mjs', 'configuration-branch.mjs', 'story-intake-receipt.mjs',
  'story-intake-verification.mjs', 'build-info.mjs', 'version.mjs'
]);

let memoized = null;

export function runningBuildIdentity() {
  if (memoized) return memoized;
  const hash = createHash('sha256').update(versionLine());
  for (const name of DECIDING_MODULES) {
    try {
      const entry = statSync(fileURLToPath(new URL(`./${name}`, import.meta.url)));
      hash.update(`\0${name}:${entry.size}:${entry.mtimeMs}`);
    } catch {
      hash.update(`\0${name}:absent`);
    }
  }
  memoized = `sha256:${hash.digest('hex')}`;
  return memoized;
}
