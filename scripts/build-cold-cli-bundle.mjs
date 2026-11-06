/** Coarse ESM chunks: preserve one instance of every engine module and defer unrelated domains. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Read from `src/` at run time instead of being bundled: the install stamp, the XPL2 observed-write
 * recorder and SF Guard's attribution recorder (node: imports only), which the hooks load only around
 * edits and in repositories with SF Guard on. Keeping them out of the hook chunks keeps their byte
 * ceilings for the decisions every tool call makes.
 */
export const LIVE_SOURCE_FILES = Object.freeze(['build-info.mjs', 'version.mjs', 'comprehension/xpl2/observed-write-recorder.mjs',
  'comprehension/xpl2/sf-guard-recorder.mjs']);
const LIVE_SOURCE = /\/(?:build-info|version|observed-write-recorder|sf-guard-recorder)\.mjs$/u;

const FAMILIES = Object.freeze([
  // cli-entry.mjs imports the pause check and the Story creation context lazily; claimed here, they
  // stay in the startup chunk instead of moving a --for-agent read into another family.
  ['core', ['cli-bundle-entry.mjs', 'command-loaders.mjs', 'deferred-index-refresh.mjs', 'build-stamp-reader.mjs',
    'commands/skill-request.mjs', 'commands/instruction-request.mjs', 'copilot-mode.mjs', 'creation-context.mjs']],
  ['status', ['commands/status.mjs', 'commands/progress.mjs', 'commands/report.mjs',
    'command-observability.mjs', 'logging.mjs', 'accounting-projection.mjs', 'read-worker-service.mjs']],
  ['hooks', ['copilot-hook-runtime.mjs', 'copilot-repository-boundary.mjs', 'copilot-mutation-guard.mjs',
    // Unclaimed, a denied edit's failure note (copilot-repository-boundary.mjs) loads the compatibility chunk.
    'copilot-environment-files-guard.mjs', 'copilot-search-exposure.mjs', 'local-config-policy.mjs', 'copilot-review-completion.mjs']],
  // Small worker/presentation helper closures share a slot without increasing deployment files.
  // Claim output before policy reads: otherwise even status pays to load the policy chunk when
  // rendering --for-agent. Entry programs remain private; helper imports never start a worker.
  ['worker-protocol', ['read-worker.mjs', 'history-index-worker.mjs', 'configuration-read-worker.mjs',
    'configuration-proposal-sync-worker.mjs', 'agent-output.mjs', 'agent-catalog-presentation.mjs',
    'agent-packet-presentation.mjs']],
  // Claim strict next-step reads before broad catalog/review families. Sharing their slot with
  // phase review caused every nextsteps call to load document, receipt and lifecycle writers.
  ['narrow-reads', ['commands/nextsteps.mjs', 'commands/status-details.mjs', 'commands/session-current.mjs',
    'accepted-story-execution.mjs', 'story-workflow-read.mjs',
    'commands/review-source.mjs', 'source-review-agent-context.mjs', 'story-publication-pending.mjs']],
  ['light', ['commands/about.mjs', 'commands/pause.mjs', 'commands/workspace.mjs', 'commands/capability.mjs',
    // Optional exact context/provenance reads must not fall through to compatibility. Keep their
    // dynamic ownership out of every hook/output helper's static closure and its existing ceiling.
    'workspace-membership.mjs', 'workspace-manifest.mjs', 'story-tree-read.mjs', 'decision-list-facts.mjs',
    'commands/intake-entry.mjs', 'commands/snapshot.mjs', 'commands/phase.mjs', 'phase-entry.mjs', 'agent-output.mjs', 'agent-catalog-presentation.mjs',
    'commands/logs.mjs', 'commands/help.mjs', 'commands/explain.mjs',
    // A command naming a Story finds its checkout here; that must not load the compatibility handler.
    'story-routing.mjs', 'story-index.mjs', 'commands/workspace-stories.mjs',
    // Every --for-agent result is kept (cli-entry.mjs imports the keeper lazily, e5dd29cfa). Unclaimed, it
    // fell into compatibility, so each --for-agent read, phase entry and nextsteps among them, loaded it and models.
    'agent-result-keeper.mjs']],
  // Claim catalog definitions before authoring closures. Leaving these dynamic roots unassigned
  // put every list/show in compatibility, importing the entire administration/model dispatcher.
  // Keep the broad reads slot too: making Home/Inbox fall into compatibility would shift the cost.
  ['catalogs', ['commands/agents.mjs', 'commands/workflow.mjs', 'commands/workflow-list.mjs', 'workflow-archive.mjs',
    'accounting-projection.mjs',
    'commands/skill.mjs', 'commands/skill-master.mjs', 'commands/instruction.mjs', 'asset-catalog.mjs',
    'configuration-drafts.mjs', 'logging.mjs', 'harness-events.mjs']],
  // Preserve existing read-family ownership before claiming the focused mutation closure.
  // One additional coarse file avoids loading the legacy generation/model engine on first writes.
  // The ordinary product requirement verdict must not import the entire phase/installer family.
  // Its actual installer dependencies are lazy; share this existing bounded local-gate slot.
  ['publication', ['commands/git-policy.mjs', 'story-publication-store.mjs', 'story-publication-service.mjs', 'product-requirement.mjs',
    'publication-unit-of-work.mjs']],
  ['hook-context', ['commands/phase-show.mjs', 'commands/shared/session-repository-authority.mjs', 'agent-hooks.mjs',
    'accepted-story-execution.mjs', 'delivery-evidence.mjs', 'worktree-fingerprint.mjs']],
  // The test-module walk's other-ecosystem build files and the node --test fallback's runner check load
  // only where a gate maps a changed path to its command, which already loads every static import of this
  // slot; claimed here they stay outside every ceilinged closure instead of falling into compatibility.
  ['session', ['commands/session-entry.mjs', 'commands/session-open.mjs', 'commands/session-open-local.mjs',
    'commands/session.mjs', 'session-agent-entry.mjs', 'session-read-service.mjs', 'test-module-markers.mjs']],
  ['intake', ['commands/start.mjs', 'commands/workspace-branches.mjs', 'commands/intake-entry.mjs',
    'commands/story-entry.mjs', 'story-worktree-preparation.mjs',
    'local-work-journal.mjs', 'history-index.mjs']],
  ['reads', ['commands/inbox.mjs', 'commands/home.mjs', 'editor.mjs']],
  ['phases', ['phase-entry-authoring.mjs', 'phase-prompt-composer.mjs', 'document-runtime.mjs',
    'copilot-story-follow.mjs',
    'evidence-consistency-read.mjs', 'scope/authoring.mjs', 'owed-decisions.mjs',
    'phase-repair-journal.mjs', 'phase-appeals.mjs', 'phase-quality-risk.mjs', 'source-review-lifecycle.mjs',
    'workflow-task-store.mjs', 'workflow-task.mjs',
    'verification/witness-decisions.mjs', 'evidence/terminal.mjs', 'evidence/graph.mjs',
    'evidence/evaluate.mjs', 'verification/contracts.mjs',
    'first-run-pass.mjs', 'configuration-review-pass.mjs',
    'commands/phase.mjs', 'commands/prepare.mjs', 'commands/inputs.mjs', 'commands/review-source.mjs',
    'commands/submit.mjs', 'commands/approve.mjs', 'commands/nextsteps-deferred.mjs',
    // What the plan already answered, imported only when a convergence step reads its inputs. Unclaimed,
    // every prepare, submit and approval of that step loaded compatibility and models.
    'plan-accounts.mjs',
    // The one pending list that nextsteps and readiness count from, and the approval check it
    // previews. Unclaimed, they fell into compatibility, so nextsteps on an open step loaded it and models.
    'decision-list-reads.mjs', 'decision-list.mjs', 'approval-check.mjs', 'visual-profile-decisions.mjs', 'commands/decision-plan-amendment.mjs', 'commands/decision-obligation-risk.mjs', 'commands/decision-story-records.mjs',
    // A gate's test run environment and toolchain record, loaded by publication and submission; test command
    // pins and narrowed runs, read at every gate run, receipt replay and decision list [TCE:REQ-010, REQ-020, REQ-030].
    'test-run-environment.mjs', 'test-toolchain.mjs', 'project-node-version.mjs', 'test-command-pins.mjs', 'test-narrowing.mjs', 'test-collection-limits.mjs', 'test-runners.mjs',
    // The test plan in words and its early checks, loaded by `tests plan` and at a code step's entry.
    'test-plan.mjs',
    // Test setup as one change: the decision list and `story adjudications` read it.
    'test-support-files.mjs',
    // Loaded by the same gates when a Story runs only its new and changed tests [TCE:REQ-093].
    'verification/test-scope-selection.mjs',
    // The same command once on a Story's base commit, loaded only by `tests base`.
    'verification/base-run.mjs',
    // An APM project's lock and workflow.yml `apm` block, read by agent discovery in any command once a
    // repository has apm.lock.yaml [APM A3]; unclaimed, every such command loaded compatibility and models.
    'apm-lock.mjs', 'apm-configuration.mjs',
    // SDA M2, imported only dynamically: the read index's refresh and replay (Story list, intake catalog,
    // `index`), a refusing gate's finding identities, and Epic/Initiative identity records. Unclaimed,
    // each fell into compatibility, so phase entry and the listings loaded it and models.
    'projection-refresh.mjs', 'index-refresh-launcher.mjs', 'commands/read-index.mjs', 'finding-identity.mjs',
    'subject-identity-records.mjs',
    // SDA M3: a configuration edit's exact-object projection, loaded only when a proposal is built,
    // and the lease review command a busy refusal names.
    'configuration-projection.mjs', 'commands/lock.mjs',
    // The specification library (SPEC-SPA v1.3), imported only dynamically by `spec author`. Unclaimed,
    // every `spec author status` loaded compatibility and models. A Story's slice and its usage records
    // (S2) are imported only by start --spec, spec attach, approval and coverage.
    // A split (S5) is imported only by spec split and coverage.
    'commands/spec-entry.mjs', 'commands/spec-author.mjs', 'commands/spec-attach.mjs', 'spec-library/slice.mjs', 'spec-library/usage.mjs',
    'commands/spec-split.mjs', 'spec-library/split.mjs', 'spec-library/allocation.mjs',
    // Spec Studio, imported only dynamically too: status reads the sharing basis and issues the proposal file,
    // each autosave reads its file through sources, and list reads the shared drafts and each revision's
    // SF Guard standing. Unclaimed, each loaded compatibility and models.
    'commands/spec-studio.mjs', 'spec-library/shared-drafts.mjs', 'spec-library/shared-basis.mjs',
    'spec-library/sources.mjs', 'spec-library/share-check.mjs', 'spec-library/presence.mjs',
    'presence/repository-steps.mjs', 'presence/repository-seals.mjs', 'workflow-build/store.mjs',
    // Upload and source admission, loaded only when a document or source is added or read.
    'document-admission.mjs']],
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
          if (!importer || !LIVE_SOURCE.test(source)) return null;
          const target = path.resolve(path.dirname(importer), source);
          const live = LIVE_SOURCE_FILES.map(file => path.join(root, 'src', file)).find(file => file === target);
          return live ? { id: `../src/${path.relative(path.join(root, 'src'), live).split(path.sep).join('/')}`, external: true } : null;
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
      if (output.length > 21) throw new Error(`Cold bundle produced ${output.length} files; maximum is 21.`);
      // Rollup owns identity/chunking. Like the VS Code build, esbuild also compacts syntax for
      // the Node 20 target, compacting local identifiers while preserving function/class names.
      // It never re-bundles or duplicates modules.
      const transformed = await transform(chunk.code, { format: 'esm', platform: 'node', target: 'node20',
        minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: true, keepNames: true, legalComments: 'none' });
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
