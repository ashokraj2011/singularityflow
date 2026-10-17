/** Installation-only bytecode preparation: definitions, never command handlers or worker programs. */
import { readFile } from 'node:fs/promises';
import { bundledCliUrl } from './bundled-cli.mjs';

export async function prewarmRuntime(root, env = process.env) {
  const compiler = await import('node:module');
  const cache = compiler.enableCompileCache?.();
  const entry = bundledCliUrl(root, env);
  if (!entry || !compiler.getCompileCacheDir?.()) return { prepared: false, reason: 'cache-or-bundle-unavailable' };
  const manifest = JSON.parse(await readFile(new URL('./manifest.json', entry), 'utf8'));
  if (manifest.format !== 2) return { prepared: false, reason: 'legacy-bundle' };
  const safe = new Set(['cold-core.mjs', 'cold-hooks.mjs', 'cold-hook-context.mjs', 'cold-light.mjs', 'cold-status.mjs',
    'cold-session.mjs', 'cold-intake.mjs', 'cold-maintenance.mjs', 'cold-catalogs.mjs', 'cold-phases.mjs']);
  const prepared = [];
  for (const output of manifest.outputs) {
    if (!safe.has(output.file)) continue;
    await import(new URL(output.file, entry).href);
    prepared.push(output.file);
  }
  compiler.flushCompileCache?.();
  return { prepared: true, files: prepared, runtime: process.version,
    // A different Node version/path/source simply misses the V8 cache and compiles normally.
    runtimeCache: cache?.status ?? null, modelsInvoked: 0, commandsExecuted: 0 };
}
