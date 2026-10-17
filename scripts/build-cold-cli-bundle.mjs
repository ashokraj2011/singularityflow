/** Coarse ESM chunks: preserve one instance of every engine module and defer unrelated domains. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FAMILIES = Object.freeze([
  ['core', ['cli-bundle-entry.mjs', 'command-loaders.mjs', 'deferred-index-refresh.mjs']],
  ['hooks', ['copilot-hook-runtime.mjs', 'copilot-repository-boundary.mjs', 'copilot-mutation-guard.mjs']],
  // Both small worker-helper closures depend only on core. Sharing this slot keeps catalogs and
  // general reads separate without increasing the deployment's fixed file count. Entry programs
  // themselves remain private; importing helper definitions never starts a worker.
  ['worker-protocol', ['read-worker.mjs', 'history-index-worker.mjs', 'configuration-read-worker.mjs',
    'configuration-proposal-sync-worker.mjs']],
  ['light', ['commands/about.mjs', 'commands/pause.mjs', 'commands/workspace.mjs', 'commands/capability.mjs',
    'commands/intake-entry.mjs', 'commands/snapshot.mjs', 'commands/phase.mjs', 'agent-output.mjs', 'agent-catalog-presentation.mjs',
    'commands/logs.mjs', 'commands/help.mjs', 'commands/explain.mjs']],
  // Claim catalog definitions before authoring closures. Leaving these dynamic roots unassigned
  // put every list/show in compatibility, importing the entire administration/model dispatcher.
  // Keep the broad reads slot too: making Home/Inbox fall into compatibility would shift the cost.
  ['catalogs', ['commands/agents.mjs', 'commands/workflow.mjs', 'commands/workflow-list.mjs',
    'commands/skill.mjs', 'commands/skill-master.mjs', 'commands/instruction.mjs', 'asset-catalog.mjs',
    'configuration-drafts.mjs', 'logging.mjs', 'harness-events.mjs']],
  ['hook-context', ['commands/shared/session-repository-authority.mjs', 'agent-hooks.mjs',
    'accepted-story-execution.mjs', 'delivery-evidence.mjs', 'worktree-fingerprint.mjs']],
  ['status', ['read-worker-service.mjs', 'commands/status.mjs', 'commands/nextsteps.mjs', 'commands/progress.mjs']],
  ['session', ['commands/session-entry.mjs', 'commands/session-open.mjs', 'commands/session-open-local.mjs',
    'commands/session.mjs', 'session-agent-entry.mjs', 'session-read-service.mjs']],
  ['intake', ['commands/start.mjs', 'commands/workspace-branches.mjs', 'commands/intake-entry.mjs',
    'commands/story-entry.mjs', 'story-worktree-preparation.mjs',
    'local-work-journal.mjs', 'history-index.mjs']],
  ['maintenance', ['first-run-pass.mjs', 'product-requirement.mjs', 'configuration-review-pass.mjs']],
  ['reads', ['commands/phase-show.mjs', 'commands/report.mjs', 'commands/inbox.mjs', 'commands/home.mjs', 'editor.mjs']],
  ['phases', ['commands/phase.mjs', 'commands/prepare.mjs', 'commands/inputs.mjs', 'commands/review-source.mjs',
    'commands/submit.mjs', 'commands/approve.mjs', 'commands/nextsteps-deferred.mjs']],
  ['models', ['commands/wm.mjs', 'commands/comprehension.mjs']]
]);

/** Assign complete static closures in priority order: a family never statically depends on a later one.
 * This avoids artificial chunk cycles, duplicate AsyncLocalStorage contexts and duplicate error classes.
 * Dynamic dependencies stay lazy. Everything not needed by these roots is compatibility/admin work.
 */
export function coarseChunkAssignment(root, { getModuleIds, getModuleInfo }, entries = {}) {
  const owners = new Map();
  // Rollup/plugin IDs use forward slashes on Windows too; native path.join does not.
  const canonical = id => id.replaceAll('\\', '/');
  const moduleIds = [...getModuleIds()];
  const byPath = new Map(moduleIds.map(id => [canonical(id), id]));
  const privateEntries = new Set(Object.values(entries).map(entry => canonical(path.join(root, entry))));
  const visited = new Set();
  const visit = (id, family) => {
    id = byPath.get(canonical(id)) ?? id;
    if (visited.has(id)) return;
    const info = getModuleInfo(id);
    if (!info || info.isExternal) return;
    visited.add(id);
    // Worker entry programs have top-level listeners. Never merge their programs into a chunk
    // another entry can import, even if all of their pure dependencies are shared.
    if (!privateEntries.has(canonical(id))) owners.set(id, family);
    for (const dependency of info.importedIds) visit(dependency, family);
  };
  for (const [family, entries] of FAMILIES) {
    for (const entry of entries) visit(path.join(root, 'src', entry), family);
  }
  for (const id of moduleIds) visit(id, 'compatibility');
  return owners;
}

export async function buildColdCliBundle({ root, outdir, toolRoot, entries, external }) {
  root = await realpath(root);
  const require = createRequire(path.join(toolRoot, 'package.json'));
  const [{ rollup }, { default: commonjs }, { default: json }, { nodeResolve }, { transform }] = await Promise.all([
    'rollup', '@rollup/plugin-commonjs', '@rollup/plugin-json', '@rollup/plugin-node-resolve', 'esbuild'
  ].map(name => import(pathToFileURL(require.resolve(name)).href)));
  const staging = `${outdir}.building-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  let bundle;
  try {
    bundle = await rollup({
      input: Object.fromEntries(Object.entries(entries).map(([name, file]) => [name, path.join(root, file)])),
      external: id => id.startsWith('node:') || external.some(name => name.endsWith('/*')
        ? id.startsWith(name.slice(0, -1)) : id === name),
      plugins: [{
        name: 'live-engine-stamp',
        resolveId(source, importer) {
          if (!importer || !/\/(?:build-info|version)\.mjs$/u.test(source)) return null;
          const target = path.resolve(path.dirname(importer), source);
          if (![path.join(root, 'src/build-info.mjs'), path.join(root, 'src/version.mjs')].includes(target)) return null;
          return { id: `../src/${path.basename(target)}`, external: true };
        }
      }, nodeResolve({ preferBuiltins: true }), commonjs(), json({ compact: true })],
      // Existing source cycles are handled by the module compiler. New inter-family static cycles
      // are separately refused below; no cycle warning is converted into a permission decision.
      onwarn(warning, warn) { if (warning.code !== 'CIRCULAR_DEPENDENCY') warn(warning); }
    });
    let assignment;
    const { output } = await bundle.generate({ format: 'es', entryFileNames: '[name].mjs',
      chunkFileNames: 'cold-[name].mjs', compact: true, hoistTransitiveImports: false,
      onlyExplicitManualChunks: true,
      manualChunks(id, graph) {
        assignment ??= coarseChunkAssignment(root, graph, entries);
        return assignment.get(id);
      }
    });
    const outputs = [];
    await mkdir(staging, { recursive: true });
    for (const chunk of output) {
      if (chunk.type !== 'chunk' || !/^[a-zA-Z0-9_-]+\.mjs$/u.test(chunk.fileName)) throw new Error('Unsupported cold bundle output.');
      // No module-by-module deployment: the complete installed engine has a small fixed envelope.
      if (output.length > 20) throw new Error(`Cold bundle produced ${output.length} files; maximum is 20.`);
      // Rollup owns identity/chunking; esbuild only strips whitespace/comments and keeps the same
      // Node 20 syntax target as the monolithic builder. It never re-bundles or duplicates modules.
      const transformed = await transform(chunk.code, { format: 'esm', platform: 'node', target: 'node20',
        minifyWhitespace: true, legalComments: 'none' });
      const bytes = Buffer.from(transformed.code);
      await writeFile(path.join(staging, chunk.fileName), bytes);
      outputs.push({ file: chunk.fileName, bytes: bytes.length, modules: Object.keys(chunk.modules).length,
        imports: chunk.imports.filter(name => !name.startsWith('../src/') && !name.startsWith('node:')
          && output.some(item => item.fileName === name)),
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
    }
    // Refuse an accidental static family cycle rather than relying on delicate initialization order.
    const byName = new Map(outputs.map(item => [item.file, item]));
    const visited = new Set(), visiting = new Set();
    const visit = file => {
      if (visiting.has(file)) throw new Error(`Cold bundle static cycle at ${file}.`);
      if (visited.has(file)) return;
      visiting.add(file); for (const next of byName.get(file)?.imports ?? []) visit(next);
      visiting.delete(file); visited.add(file);
    };
    for (const item of outputs) visit(item.file);
    const stamp = await readFile(path.join(root, 'src/build-info.mjs'));
    const { BUILD_INFO } = await import(`${pathToFileURL(path.join(root, 'src/build-info.mjs')).href}?cold=${Date.now()}`);
    const manifest = { format: 2, layout: 'coarse-esm',
      buildInfoSha256: `sha256:${createHash('sha256').update(stamp).digest('hex')}`,
      stamped: Boolean(BUILD_INFO?.commit || BUILD_INFO?.sourceSha256),
      entries: Object.keys(entries).map(name => `${name}.mjs`), outputs };
    await writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(staging, 'package.json'), '{ "type": "module" }\n');
    await rm(outdir, { recursive: true, force: true });
    await mkdir(path.dirname(outdir), { recursive: true });
    await rename(staging, outdir);
    return { outdir, manifest };
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  finally { await bundle?.close(); }
}
