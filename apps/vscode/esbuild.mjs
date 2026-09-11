/**
 * The extension ships as one CommonJS bundle because that is what a VS Code extension host loads.
 * The .cjs extension is deliberate: this package is "type": "module" so the TypeScript sources run
 * under `node --experimental-strip-types` in tests, and .cjs states the bundle's format outright
 * instead of depending on which package.json wins at load time.
 *
 * `vscode` is external: it is injected by the host and has no npm package to bundle.
 */
import { build, context } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vscodeBuildIdentity } from '../../scripts/reproducible-build.mjs';

/**
 * A stamp identifying this build, injected at compile time.
 *
 * The extension's version never changes between reinstalls during development, so VS Code, the
 * person reloading, and whoever is helping them have no way to tell two builds apart — which turns
 * "did the fix land?" into guesswork on both sides. The commit and source timestamp answer it.
 * SOURCE_DATE_EPOCH is the explicit reproducible-build authority; otherwise the exact HEAD commit
 * timestamp keeps clean builds byte-identical across release hosts. Dirty builds retain `+local`.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD = vscodeBuildIdentity(root).stamp;
const isolatedTestOutdir = process.env.SINGULARITY_FLOW_VSCODE_TEST_OUTDIR;
if (isolatedTestOutdir && process.env.NODE_ENV !== 'test') {
  throw new Error('SINGULARITY_FLOW_VSCODE_TEST_OUTDIR is available only to isolated tests.');
}

/**
 * Core resolves its installed assets from ESM `import.meta.url`. The extension is CommonJS and
 * stages that same package beneath `<extension>/cli`, so replace only that host boundary with a
 * resolver based on the bundle's real `__dirname`. In a development host there is no staged CLI;
 * the repository root is two levels above the extension directory.
 */
const packageRootPlugin = {
  name: 'singularity-flow-package-root',
  setup(buildContext) {
    buildContext.onResolve({ filter: /package-root\.mjs$/ }, () => ({
      path: 'package-root', namespace: 'singularity-flow'
    }));
    buildContext.onLoad({ filter: /^package-root$/, namespace: 'singularity-flow' }, () => ({
      loader: 'js',
      contents: `
        import { existsSync } from 'node:fs';
        import path from 'node:path';
        const extensionRoot = path.resolve(__dirname, '..');
        const stagedCliRoot = path.join(extensionRoot, 'cli');
        export const PACKAGE_ROOT = existsSync(path.join(stagedCliRoot, 'package.json'))
          ? stagedCliRoot
          : path.resolve(extensionRoot, '..', '..');
      `
    }));
  }
};

const options = {
  entryPoints: {
    extension: 'src/extension.ts',
    'gateway-context-runtime': 'src/gateway-context-runtime.ts',
    'gateway-runtime': 'src/gateway-runtime.ts',
    'gateway-status-worker': 'src/gateway-status-worker.ts',
    'help-runtime': 'src/help-runtime.ts',
    'lazy-panels-runtime': 'src/lazy-panels-runtime.ts',
    'support-runtime': 'src/support-runtime.ts',
    'world-model-build': 'src/world-model-build.ts'
  },
  bundle: true,
  outdir: isolatedTestOutdir ? path.resolve(isolatedTestOutdir) : 'dist',
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode'],
  define: { __SFLOW_BUILD__: JSON.stringify(BUILD) },
  plugins: [packageRootPlugin],
  sourcemap: true,
  logLevel: 'info'
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
