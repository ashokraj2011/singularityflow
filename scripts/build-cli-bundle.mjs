#!/usr/bin/env node
/**
 * Build the bundled CLI that installed copies run (`bundle/`). `[perf]`
 *
 * A Story command loaded about 480 module files (9 MB of source, 79 of them from zod). macOS opens
 * them in a few milliseconds; on a Windows laptop with antivirus or OneDrive in the path, the same
 * `status` spent about 6 seconds just loading modules. The bundle is one file per entry, so a command
 * opens a handful of files instead.
 *
 * `bundle/` sits beside `src/` at the package root, so every path the code works out from its own
 * file (`PACKAGE_ROOT`, `../plugin`, `../templates`, `../bin`) means the same from either place,
 * and `src/` keeps shipping for what runs as its own file: workers loaded by path, AST adapters,
 * hashed sources. There is no code splitting: esbuild would turn every lazy import into its own
 * chunk (561 files), and a single file keeps lazily imported modules lazy anyway.
 *
 * The bundle is only ever run in a stamped build whose `src/build-info.mjs` still has the bytes it
 * was built with (see `src/bundled-cli.mjs`), so a checkout that edits `src/` never runs stale code.
 *
 *   node scripts/build-cli-bundle.mjs [--outdir DIR]
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI_BUNDLE_FORMAT = 1;
// Entry names are the basenames the code resolves next to itself (history-index.mjs and the
// configuration read/sync clients start these workers from their own directory).
export const CLI_BUNDLE_ENTRIES = Object.freeze({
  cli: 'src/cli-bundle-entry.mjs',
  'copilot-hook-runtime': 'src/copilot-hook-runtime.mjs',
  'history-index-worker': 'src/history-index-worker.mjs',
  'configuration-read-worker': 'src/configuration-read-worker.mjs',
  'read-worker': 'src/read-worker.mjs',
  'configuration-proposal-sync-worker': 'src/configuration-proposal-sync-worker.mjs'
});
// Rarely used, large, or needing their own files: loaded from node_modules as before.
const EXTERNAL = ['typescript', 'pyright', 'sql.js', 'sql.js/*', '@agentclientprotocol/sdk', '@agentclientprotocol/sdk/*'];

/** Keep the install stamp live: the bundle imports `src/build-info.mjs` and `src/version.mjs`. */
const liveStamp = (root) => ({
  name: 'live-build-stamp',
  setup(build) {
    build.onResolve({ filter: /(?:^|\/)(?:build-info|version)\.mjs$/ }, (args) => {
      if (!args.importer.startsWith(path.join(root, 'src'))) return null;
      const target = path.resolve(path.dirname(args.importer), args.path);
      if (![path.join(root, 'src', 'build-info.mjs'), path.join(root, 'src', 'version.mjs')].includes(target)) return null;
      return { path: `../src/${path.basename(target)}`, external: true };
    });
  }
});

function sha256(file) {
  return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
}

/**
 * `root` is the package the bundle is built from and for; `esbuildRoot` only supplies the build
 * tool. The VS Code package builds its staged CLI this way: the inputs are the staged sources and
 * their lock-installed production closure, which has no esbuild of its own.
 */
export async function buildCliBundle({ root = ROOT, outdir = path.join(root, 'bundle'), esbuildRoot = root } = {}) {
  const { build } = await import(pathToFileURL(path.join(esbuildRoot, 'node_modules', 'esbuild', 'lib', 'main.js')).href);
  const staging = `${outdir}.building-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  // A failed build must not leave its partial output behind: inside a VSIX stage it would ship.
  const result = await build({
    absWorkingDir: root,
    entryPoints: CLI_BUNDLE_ENTRIES,
    outdir: staging,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outExtension: { '.js': '.mjs' },
    minifyWhitespace: true,
    legalComments: 'none',
    external: EXTERNAL,
    plugins: [liveStamp(root)],
    // Bundled CommonJS packages (yaml's Node build) call require(); an ES module has none of its own.
    banner: { js: 'import { createRequire as __sflowCreateRequire } from "node:module"; const require = __sflowCreateRequire(import.meta.url);' },
    metafile: true,
    logLevel: 'error'
  }).catch((error) => {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  });
  const { BUILD_INFO } = await import(`${pathToFileURL(path.join(root, 'src', 'build-info.mjs')).href}?bundle=${Date.now()}`);
  const outputs = Object.entries(result.metafile.outputs).map(([file, output]) => ({
    file: path.basename(file), bytes: output.bytes, modules: Object.keys(output.inputs).length
  }));
  const manifest = {
    format: CLI_BUNDLE_FORMAT,
    // Which build this bundle belongs to: it runs only while src/build-info.mjs has these bytes.
    buildInfoSha256: sha256(path.join(root, 'src', 'build-info.mjs')),
    stamped: Boolean(BUILD_INFO?.commit || BUILD_INFO?.sourceSha256),
    entries: Object.keys(CLI_BUNDLE_ENTRIES).map((name) => `${name}.mjs`),
    outputs
  };
  writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(staging, 'package.json'), '{ "type": "module" }\n');
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(path.dirname(outdir), { recursive: true });
  renameSync(staging, outdir);
  return { outdir, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--outdir');
  const outdir = index > 0 ? path.resolve(process.argv[index + 1]) : undefined;
  const { outdir: written, manifest } = await buildCliBundle({ outdir });
  const total = manifest.outputs.reduce((sum, output) => sum + output.bytes, 0);
  console.log(`Built ${path.relative(process.cwd(), written) || written}: ${manifest.outputs.length} files, ${total} bytes, ${manifest.stamped ? 'stamped' : 'unstamped (development: not used unless forced)'}.`);
}
