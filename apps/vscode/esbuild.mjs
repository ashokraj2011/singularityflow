/**
 * The extension ships as one CommonJS bundle because that is what a VS Code extension host loads.
 * The .cjs extension is deliberate: this package is "type": "module" so the TypeScript sources run
 * under `node --experimental-strip-types` in tests, and .cjs states the bundle's format outright
 * instead of depending on which package.json wins at load time.
 *
 * `vscode` is external: it is injected by the host and has no npm package to bundle.
 */
import { build, context } from 'esbuild';

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.cjs',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info'
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
