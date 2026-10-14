/**
 * Which CLI to run: the bundle beside `src/` (scripts/build-cli-bundle.mjs) or the sources.
 *
 * The bundle runs only in the build it was made for: its manifest must say the build was stamped and
 * name the exact bytes of `src/build-info.mjs` it was built with. A development checkout (unstamped,
 * or restored after packing) therefore always runs `src/`, so an edit can never be hidden behind a
 * stale bundle. `SINGULARITY_FLOW_BUNDLE=off` forces the sources; `SINGULARITY_FLOW_BUNDLE_DIR`
 * names a bundle to run regardless, for tests and measurements.
 *
 * Node built-ins only, and nothing else imported: every command pays for this check.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The bundled CLI module URL to import, or null to run from `src/`. */
export function bundledCliUrl(packageRoot, env = process.env) {
  if (String(env.SINGULARITY_FLOW_BUNDLE ?? '').toLowerCase() === 'off') return null;
  const forced = String(env.SINGULARITY_FLOW_BUNDLE_DIR ?? '').trim();
  const directory = forced ? path.resolve(forced) : path.join(packageRoot, 'bundle');
  try {
    const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    if (manifest?.format !== 1 || !Array.isArray(manifest.entries) || !manifest.entries.includes('cli.mjs')) return null;
    if (!forced) {
      if (manifest.stamped !== true) return null;
      const buildInfo = readFileSync(path.join(packageRoot, 'src', 'build-info.mjs'));
      if (manifest.buildInfoSha256 !== `sha256:${createHash('sha256').update(buildInfo).digest('hex')}`) return null;
    }
    return pathToFileURL(path.join(directory, 'cli.mjs')).href;
  } catch {
    return null;
  }
}
