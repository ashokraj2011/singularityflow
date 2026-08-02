/**
 * The extension ships as one CommonJS bundle because that is what a VS Code extension host loads.
 * The .cjs extension is deliberate: this package is "type": "module" so the TypeScript sources run
 * under `node --experimental-strip-types` in tests, and .cjs states the bundle's format outright
 * instead of depending on which package.json wins at load time.
 *
 * `vscode` is external: it is injected by the host and has no npm package to bundle.
 */
import { build, context } from 'esbuild';
import { execSync } from 'node:child_process';

/**
 * A stamp identifying this build, injected at compile time.
 *
 * The extension's version never changes between reinstalls during development, so VS Code, the
 * person reloading, and whoever is helping them have no way to tell two builds apart — which turns
 * "did the fix land?" into guesswork on both sides. The commit and the build time answer it.
 */
const describe = (command, fallback) => {
  try { return execSync(command, { encoding: 'utf8' }).trim(); } catch { return fallback; }
};
const BUILD = `${describe('git rev-parse --short HEAD', 'unknown')}${
  describe('git status --porcelain', '') ? '+local' : ''} ${new Date().toISOString().slice(0, 16)}Z`;

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.cjs',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode'],
  define: { __SFLOW_BUILD__: JSON.stringify(BUILD) },
  sourcemap: true,
  logLevel: 'info'
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
