import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { head } from './git.mjs';
import { authoredReferencePreview, resolveReference } from './harness-imports.mjs';
import { exists, mapLimit, posix, run, SingularityFlowError, snapshot } from './util.mjs';
import { sourcePathIncluded, worldModelSourceScope } from './source-scope.mjs';
import { withoutConfiguredFilters } from './worktree-fingerprint.mjs';
import { readRecord } from './schema-migrations.mjs';
import {
  budgetFor, corePath, proseBytes, resolveGroundingPlan, resolveViews, selectionId, tierForCore,
  tierForView, viewPath
} from './world-model-selection.mjs';
import { worldModelStalenessDecision } from './world-model-policy.mjs';
import { runRemoteGit } from './git-execution.mjs';
import { loadPortfolio } from './initiative-config.mjs';

const GROUNDING_MODES = new Set(['off', 'warn', 'enforce']);

// Open file descriptors while hashing a tree. Enough to keep the disk busy, few enough not to
// exhaust the descriptor table on a large repository.
const SNAPSHOT_CONCURRENCY = 16;
export const WORLD_MODEL_SOURCE_FINGERPRINT_ALGORITHM = 'sflow-source-git-v2';

async function withInitiativeRoot(root, definition = {}) {
  if (definition.initiativeRoot) return definition;
  const portfolio = await loadPortfolio(root, { required: false }).catch(() => null);
  return portfolio?.initiativeRoot ? { ...definition, initiativeRoot: portfolio.initiativeRoot } : definition;
}

export function groundingMode(definition, workflow = null) {
  const mode = workflow ? workflow.resolution?.worldModelGrounding ?? 'off' : definition.worldModel?.grounding ?? 'off';
  if (!GROUNDING_MODES.has(mode)) throw new SingularityFlowError(`worldModel.grounding must be off, warn, or enforce; got '${mode}'.`);
  return mode;
}

// Where this tool keeps its own material. Nothing under here is application source, so nothing
// under here may move the source-tree hash.
const GOVERNANCE_ROOT = 'singularity';

/**
 * Governance material this tool writes and owns, which must not count as application source.
 *
 * The source-tree hash answers exactly one question: has the code the world model describes
 * changed? Counting governance state meant the answer was always yes. Starting an Epic alone
 * commits initiative state *and* materializes the artifact templates and governed-agent prompts, so a
 * model built minutes earlier was reported stale before a single line of the application had been
 * touched — the signal was permanently on and told you nothing. On the rule-engine repository it
 * was 48 of 70 files for work-item and initiative state, and 22 more for templates.
 *
 * The whole governance directory is excluded rather than a list of subdirectories, because every
 * file this tool adds there is its own. What the model was built *from* is tracked separately
 * where it belongs: `builder_prompt_sha256` covers the builder prompt, and the required views are
 * validated against the manifest on every load.
 */
function excludedSourcePath(file, definition = {}) {
  const roots = [
    GOVERNANCE_ROOT,
    definition.worldModel?.outputDir ?? definition.outputDir ?? 'singularity/world-model',
    definition.workItemRoot ?? 'singularity/work-items',
    definition.initiativeRoot ?? 'singularity/initiatives',
    definition.templatesRoot ?? 'singularity/templates',
    definition.agentPromptsRoot ?? '.github/agents'
  ].map((value) => posix(String(value)).replace(/\/$/, '')).filter(Boolean);
  return roots.some((root) => file === root || file.startsWith(`${root}/`))
    || file.startsWith('.git/') || file.startsWith('node_modules/');
}

function splitNull(value) {
  return String(value ?? '').split('\0').filter(Boolean);
}

function sourcePathspec(definition = {}) {
  const scope = worldModelSourceScope(definition);
  return scope.all ? [] : ['--', ...scope.paths];
}

function indexManifest(root, definition = {}) {
  const pathspec = sourcePathspec(definition);
  const stages = splitNull(run('git', ['ls-files', '--stage', '-z', ...pathspec], { cwd: root }).stdout);
  const flags = new Map(splitNull(run('git', ['ls-files', '-v', '-z', ...pathspec], { cwd: root }).stdout)
    .map((entry) => [posix(entry.slice(2)), entry[0]]));
  const entries = [];
  for (const entry of stages) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [mode, objectId, stage] = entry.slice(0, tab).split(' ');
    const relative = posix(entry.slice(tab + 1));
    const tag = flags.get(relative) ?? 'H';
    entries.push({
      path: relative,
      mode,
      objectId,
      stage: Number(stage),
      assumeUnchanged: /^[a-z]$/.test(tag),
      skipWorktree: tag.toUpperCase() === 'S'
    });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path) || left.stage - right.stage);
}

function objectSizes(root, objectIds) {
  const unique = [...new Set(objectIds.filter(Boolean))];
  if (!unique.length) return new Map();
  const result = run('git', ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
    cwd: root,
    input: `${unique.join('\n')}\n`,
    allowFailure: true
  });
  const sizes = new Map();
  if (result.status !== 0) return sizes;
  for (const row of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const [objectId, type, size] = row.split(' ');
    if (objectId && type !== 'missing') sizes.set(objectId, type === 'blob' ? Number(size) : 0);
  }
  return sizes;
}

async function visibleRecord(root, relative, indexed = null, { compareToIndex = true } = {}) {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) {
    if (indexed?.skipWorktree) {
      return {
        path: relative, status: 'present', materialization: 'sparse-absent', mode: indexed.mode,
        objectId: `git:${indexed.objectId}`, sha256: null
      };
    }
    return { path: relative, status: 'deleted', materialization: 'absent', mode: indexed?.mode ?? null, objectId: null, size: 0, sha256: null };
  }
  if (indexed && compareToIndex) {
    const stat = await lstat(absolute);
    if (stat.isFile()) {
      const object = run('git', ['hash-object', '--no-filters', '--', relative], {
        cwd: root, allowFailure: true
      });
      const mode = (stat.mode & 0o111) ? '100755' : '100644';
      if (object.status === 0 && object.stdout.trim() === indexed.objectId && mode === indexed.mode) {
        return {
          path: relative, status: 'present', materialization: 'index', mode: indexed.mode,
          objectId: `git:${indexed.objectId}`, sha256: null
        };
      }
    }
  }
  const info = await snapshot(absolute);
  if (!info.sha256) return null;
  return {
    path: relative,
    status: 'present',
    materialization: indexed ? 'worktree' : 'untracked',
    mode: indexed?.mode ?? null,
    objectId: `sha256:${info.sha256}`,
    size: info.size,
    sha256: info.sha256
  };
}

/**
 * Describe a Git worktree without reading every tracked file.
 *
 * The index already content-addresses every clean or staged path. Only paths whose visible bytes
 * differ from the index, untracked paths, and explicitly hidden index paths are read. A sparse
 * checkout's SKIP_WORKTREE entries remain present through their index object instead of being
 * misreported as deletions.
 */
async function gitSourceRecords(root, { definition = {}, excludeGovernance = true } = {}) {
  const pathspec = sourcePathspec(definition);
  const index = indexManifest(root, definition);
  const stageZero = new Map(index.filter((entry) => entry.stage === 0).map((entry) => [entry.path, entry]));
  const conflicted = new Set(index.filter((entry) => entry.stage !== 0).map((entry) => entry.path));
  const changed = new Set([
    ...splitNull(run('git', withoutConfiguredFilters(root, [
      'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', ...pathspec
    ]), { cwd: root }).stdout),
    ...conflicted
  ].map(posix));
  // Paths reported by diff are already known not to match the index. Do not launch one
  // `git hash-object` process per dirty file merely to prove the same fact again.
  const knownChanged = new Set(changed);
  const untracked = splitNull(run('git', [
    'ls-files', '--others', '--exclude-standard', '-z', ...pathspec
  ], { cwd: root }).stdout).map(posix);
  // Assume-unchanged and skip-worktree suppress ordinary diff discovery. Inspect only those rare
  // paths; in a sparse checkout an absent skip-worktree path is represented by its index object.
  for (const entry of stageZero.values()) {
    if (entry.assumeUnchanged || entry.skipWorktree) changed.add(entry.path);
  }
  const include = (file) => (!excludeGovernance || !excludedSourcePath(file, definition))
    && sourcePathIncluded(file, definition);
  const indexed = [...stageZero.values()].filter((entry) => include(entry.path));
  // Asking cat-file for a missing promisor object can lazily download it. Sparse-absent paths stay
  // represented by their index identity with size 0; materializing bytes is a workspace decision,
  // never a side effect of a world-model status/fingerprint read.
  const sizes = objectSizes(root, indexed.filter((entry) => !entry.skipWorktree).map((entry) => entry.objectId));
  const records = [];
  const visible = new Set([...changed, ...untracked].filter(include));
  for (const entry of indexed) {
    if (visible.has(entry.path)) continue;
    records.push({
      path: entry.path,
      status: 'present',
      materialization: entry.skipWorktree ? 'index' : 'index',
      mode: entry.mode,
      objectId: `git:${entry.objectId}`,
      size: sizes.get(entry.objectId) ?? 0,
      sha256: null
    });
  }
  const scanned = await mapLimit([...visible].sort(), SNAPSHOT_CONCURRENCY, async (file) => (
    visibleRecord(root, file, stageZero.get(file) ?? null, {
      compareToIndex: !knownChanged.has(file)
    })
  ));
  records.push(...scanned.filter(Boolean));
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

export async function worldModelSourceSnapshot(root, definition = {}) {
  const effectiveDefinition = await withInitiativeRoot(root, definition);
  const records = await gitSourceRecords(root, { definition: effectiveDefinition, excludeGovernance: true });
  const scope = worldModelSourceScope(effectiveDefinition);
  const hash = createHash('sha256');
  hash.update(WORLD_MODEL_SOURCE_FINGERPRINT_ALGORITHM).update('\0');
  hash.update(JSON.stringify({ sourceRoots: scope.sourceRoots, sharedRoots: scope.sharedRoots })).update('\0');
  for (const entry of records) {
    hash.update(entry.path).update('\0').update(entry.status).update('\0')
      .update(entry.mode ?? '').update('\0').update(entry.objectId ?? '').update('\0');
  }
  return {
    algorithm: WORLD_MODEL_SOURCE_FINGERPRINT_ALGORITHM,
    scope: { sourceRoots: [...scope.sourceRoots], sharedRoots: [...scope.sharedRoots], all: scope.all },
    sha256: `sha256:${hash.digest('hex')}`,
    files: records
  };
}

function sourcePathsChangedSince(root, definition, ref) {
  if (!/^[0-9a-f]{40}$/i.test(ref ?? '')) return null;
  const pathspec = sourcePathspec(definition);
  const changedBetweenCommits = run('git', withoutConfiguredFilters(root, [
    'diff', '--no-textconv', '--name-only', '-z', ref, 'HEAD', ...pathspec
  ]), { cwd: root, allowFailure: true });
  if (changedBetweenCommits.status !== 0) return null;
  const worktree = run('git', withoutConfiguredFilters(root, [
    'diff', '--no-textconv', '--name-only', '-z', 'HEAD', ...pathspec
  ]), { cwd: root, allowFailure: true });
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '-z', ...pathspec], {
    cwd: root, allowFailure: true
  });
  if (worktree.status !== 0 || untracked.status !== 0) return null;
  return [...new Set([
    ...changedBetweenCommits.stdout.split('\0').filter(Boolean),
    ...splitNull(worktree.stdout),
    ...splitNull(untracked.stdout)
  ])].map(posix).filter((file) => !excludedSourcePath(file, definition) && sourcePathIncluded(file, definition)).sort();
}

export async function repositoryContentSnapshot(root, definition = {}) {
  const scanned = await gitSourceRecords(root, { definition, excludeGovernance: false });
  const records = new Map();
  for (const entry of scanned) {
    if (entry.path.startsWith('.git/') || entry.path.startsWith('node_modules/')) continue;
    records.set(entry.path, `${entry.status}:${entry.mode ?? ''}:${entry.objectId ?? ''}:${entry.size ?? 0}`);
  }
  return records;
}

export function changedSnapshotPaths(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort();
}

export function safeModelPath(directory, relative, label = 'World-model path') {
  if (typeof relative !== 'string' || !relative.trim() || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    throw new SingularityFlowError(`${label} must stay inside the world-model directory.`);
  }
  const root = path.resolve(directory);
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new SingularityFlowError(`${label} escapes the world-model directory.`);
  return absolute;
}

async function modelFiles(directory, prefix = '') {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    // CLI-owned discovery checkpoints live beside the model so an interrupted build can resume.
    // They are intermediate state, not manifest-declared world-model content.
    if (!prefix && entry.name === '.checkpoints') continue;
    if (entry.isDirectory()) output.push(...await modelFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) output.push(posix(relative));
    else throw new SingularityFlowError(`World-model output contains an unsupported filesystem entry: ${relative}`);
  }
  return output.sort();
}

async function requireModelFile(directory, relative, label, { json = false, jsonl = false } = {}) {
  const absolute = safeModelPath(directory, relative, label);
  const entry = await lstat(absolute).catch(() => null);
  if (!entry?.isFile() || entry.isSymbolicLink()) throw new SingularityFlowError(`${label} must be a regular file: ${relative}`);
  const resolvedRoot = await realpath(directory);
  const resolved = await realpath(absolute);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new SingularityFlowError(`${label} resolves outside the world-model directory: ${relative}`);
  const info = await snapshot(absolute);
  if (!info.exists || !info.sha256 || info.size < 1) throw new SingularityFlowError(`${label} is missing or empty: ${relative}`);
  const text = await readFile(absolute, 'utf8');
  if (json) {
    try { JSON.parse(text); } catch (error) { throw new SingularityFlowError(`${label} is invalid JSON: ${error.message}`); }
  }
  if (jsonl) {
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) throw new SingularityFlowError(`${label} must contain at least one JSON record: ${relative}`);
    for (const [index, line] of lines.entries()) {
      try { JSON.parse(line); } catch (error) { throw new SingularityFlowError(`${label} line ${index + 1} is invalid JSON: ${error.message}`); }
    }
  }
  return { path: posix(relative), absolute, ...info };
}

function missingTier(pathValue = null) {
  return { status: 'missing', path: pathValue, bytes: 0, sha256: null };
}

function legacyTier(pathValue, metadata = {}) {
  return pathValue
    ? { status: 'ready', path: pathValue, bytes: metadata.bytes ?? null, sha256: metadata.sha256 ?? null }
    : missingTier();
}

/**
 * Normalize all supported on-disk manifests into the tier-aware v3 read model.
 *
 * Reading never rewrites a legacy manifest. Its source schema is retained so callers can apply
 * compatibility fallback only to historical artifacts, not to newly generated v3 snapshots.
 */
export function normalizeWorldModelManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new SingularityFlowError('World-model manifest must be a JSON object.');
  }
  if (!['1.0', '2.0', '3.0'].includes(manifest.schema_version)) {
    throw new SingularityFlowError("World-model manifest schema_version must be '1.0', '2.0', or '3.0'.");
  }
  const sourceSchemaVersion = manifest.schema_version;
  if (sourceSchemaVersion === '3.0') {
    return { ...structuredClone(manifest), source_schema_version: sourceSchemaVersion };
  }
  const normalized = structuredClone(manifest);
  normalized.schema_version = '3.0';
  normalized.source_schema_version = sourceSchemaVersion;
  const oldCore = manifest.core ?? {};
  const modelPath = typeof oldCore.model === 'string' ? oldCore.model : oldCore.model?.path;
  normalized.core = {
    ...oldCore,
    tiers: {
      brief: legacyTier(oldCore.brief, oldCore.bytes?.brief ? { bytes: oldCore.bytes.brief } : {}),
      full: legacyTier(oldCore.summary ?? 'core/summary.md', oldCore.bytes?.summary ? { bytes: oldCore.bytes.summary } : {})
    },
    model: { ...(typeof oldCore.model === 'object' ? oldCore.model : {}), path: modelPath ?? 'core/model.json' }
  };
  normalized.views = Object.fromEntries(Object.entries(manifest.views ?? {}).map(([view, entry = {}]) => {
    const missing = entry.generated === false;
    return [view, {
      ...entry,
      tiers: {
        brief: missing ? missingTier(entry.brief_path ?? null) : legacyTier(entry.brief_path, { bytes: entry.bytes?.brief, sha256: entry.sha256?.brief }),
        full: missing ? missingTier(entry.path ?? null) : legacyTier(entry.path, { bytes: entry.bytes?.full, sha256: entry.sha256?.full })
      }
    }];
  }));
  normalized.materializations ??= [];
  return normalized;
}

export function worldModelSelectionEntry(manifest, selection, { allowLegacyFallback = false } = {}) {
  const normalized = manifest?.source_schema_version ? manifest : normalizeWorldModelManifest(manifest);
  if (selection.kind === 'core') {
    const exact = normalized.core?.tiers?.[selection.tier];
    if (exact?.status === 'ready') return exact;
    if (allowLegacyFallback && selection.tier === 'brief' && normalized.source_schema_version !== '3.0') return normalized.core?.tiers?.full;
    return exact ?? missingTier();
  }
  if (selection.kind === 'view') {
    const exact = normalized.views?.[selection.view]?.tiers?.[selection.tier];
    if (exact?.status === 'ready') return exact;
    if (allowLegacyFallback && selection.tier === 'brief' && normalized.source_schema_version !== '3.0') return normalized.views?.[selection.view]?.tiers?.full;
    return exact ?? missingTier();
  }
  return missingTier();
}

export async function validateWorldModelDirectory(directory, {
  expectedCommit = null, expectedTask = null, requiredSelections = [], requiredViews = [],
  requireEvidence = true, allowIncompleteMetadata = false, integrity = 'full', sourceLabel = 'world-model'
} = {}) {
  const manifestFile = path.join(directory, 'manifest.json');
  if (!(await exists(manifestFile))) throw new SingularityFlowError('World-model builder did not create manifest.json.');
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestFile, 'utf8')); }
  catch (error) { throw new SingularityFlowError(`World-model manifest is invalid JSON: ${error.message}`); }
  const normalizedManifest = normalizeWorldModelManifest(manifest);
  const modern = ['2.0', '3.0'].includes(manifest.schema_version);
  if (modern && !allowIncompleteMetadata) {
    for (const field of ['generated_at', 'generated_date', 'builder_version', 'builder_prompt_sha256', 'analysis_depth', 'repository_branch', 'working_tree_clean']) {
      if (manifest[field] === undefined || manifest[field] === null || manifest[field] === '') throw new SingularityFlowError(`World-model manifest is missing required metadata '${field}'.`);
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(String(manifest.generated_at))) throw new SingularityFlowError('World-model manifest generated_at must be an ISO 8601 UTC timestamp.');
    if (typeof manifest.working_tree_clean !== 'boolean') throw new SingularityFlowError('World-model manifest working_tree_clean must be a boolean.');
  }
  const repositoryCommit = manifest.repository_commit ?? manifest.repository?.commit;
  if (!/^[0-9a-f]{40}$/i.test(repositoryCommit ?? '')) throw new SingularityFlowError('World-model manifest requires a full repository_commit SHA.');
  if (expectedCommit && repositoryCommit !== expectedCommit) throw new SingularityFlowError(`World-model manifest inspected ${repositoryCommit}, expected ${expectedCommit}.`);
  if (manifest.source_tree_sha256 != null && !/^sha256:[0-9a-f]{64}$/.test(manifest.source_tree_sha256)) throw new SingularityFlowError('World-model manifest source_tree_sha256 is invalid.');

  const registered = new Set();
  const register = async (relative, label, options) => {
    const record = await requireModelFile(directory, relative, label, options);
    if (registered.has(record.path)) throw new SingularityFlowError(`World-model manifest declares the same file more than once: ${record.path}`);
    registered.add(record.path);
    return record;
  };
  const coreModel = normalizedManifest.core?.model?.path ?? 'core/model.json';
  for (const [tier, entry] of Object.entries(normalizedManifest.core?.tiers ?? {})) {
    if (entry?.status === 'ready' && (integrity === 'full' || requiredSelections.some((selection) => selection.kind === 'core' && selection.tier === tier))) {
      const record = await register(entry.path, `World-model core ${tier}`);
      if (manifest.schema_version === '3.0' && entry.bytes != null && entry.bytes !== record.size) throw new SingularityFlowError(`World-model core/${tier} byte count differs from manifest.json.`);
      if (manifest.schema_version === '3.0' && entry.sha256 && entry.sha256 !== record.sha256) throw new SingularityFlowError(`World-model core/${tier} hash differs from manifest.json.`);
    }
  }
  if (integrity === 'full') await register(coreModel, 'World-model core model', { json: true });
  if (modern && !manifest.path_index?.path) throw new SingularityFlowError('World-model manifest requires path_index.path.');
  if (integrity === 'full' && manifest.path_index?.path) await register(manifest.path_index.path, 'World-model path index', { json: true });

  if (!manifest.views || typeof manifest.views !== 'object' || Array.isArray(manifest.views)) throw new SingularityFlowError('World-model manifest views must be an object.');
  if (manifest.domains != null && !Array.isArray(manifest.domains)) throw new SingularityFlowError('World-model manifest domains must be an array.');
  if (manifest.task_guides != null && !Array.isArray(manifest.task_guides)) throw new SingularityFlowError('World-model manifest task_guides must be an array.');
  for (const [view, entry] of Object.entries(normalizedManifest.views ?? {})) {
    for (const [tier, artifact] of Object.entries(entry.tiers ?? {})) {
      const selected = requiredSelections.some((selection) => selection.kind === 'view' && selection.view === view && selection.tier === tier);
      if (artifact?.status !== 'ready' || (integrity !== 'full' && !selected)) continue;
      const label = manifest.schema_version === '3.0'
        ? `World-model selection '${view}/${tier}'`
        : `World-model view '${view}'`;
      const record = await register(artifact.path, label);
      if (manifest.schema_version === '3.0' && artifact.bytes != null && artifact.bytes !== record.size) throw new SingularityFlowError(`World-model selection '${view}/${tier}' byte count differs from manifest.json.`);
      if (manifest.schema_version === '3.0' && artifact.sha256 && artifact.sha256 !== record.sha256) throw new SingularityFlowError(`World-model selection '${view}/${tier}' hash differs from manifest.json.`);
    }
  }
  const adaptedSelections = requiredSelections.length
    ? requiredSelections
    : requiredViews.map((view) => ({ kind: 'view', view, tier: 'full', required: true, legacyAdapter: true }));
  const allowLegacyFallback = normalizedManifest.source_schema_version !== '3.0';
  for (const selection of adaptedSelections) {
    const entry = worldModelSelectionEntry(normalizedManifest, selection, { allowLegacyFallback });
    if (entry?.status !== 'ready' || !entry.path) {
      throw new SingularityFlowError(`Required world-model selection '${selectionId(selection)}' is missing from the ${sourceLabel}.`);
    }
    if (!registered.has(posix(entry.path))) {
      const label = selection.kind === 'view'
        ? `World-model view '${selection.view}'`
        : `Required world-model selection '${selectionId(selection)}'`;
      await register(entry.path, label);
    }
  }
  for (const domain of integrity === 'full' ? manifest.domains ?? [] : []) {
    if (!domain?.id || !domain?.path) throw new SingularityFlowError('Every world-model domain requires id and path.');
    await register(domain.path, `World-model domain '${domain.id}'`);
  }
  for (const guide of integrity === 'full' ? manifest.task_guides ?? [] : []) {
    if (!guide?.id || !guide?.path || !guide?.task) throw new SingularityFlowError('Every world-model task guide requires id, path, and exact task text.');
    await register(guide.path, `World-model task guide '${guide.id}'`);
  }
  if (expectedTask && !(manifest.task_guides ?? []).some((guide) => normalizeTask(guide.task) === normalizeTask(expectedTask))) throw new SingularityFlowError(`World-model builder did not create a task guide for '${expectedTask}'.`);
  if (requireEvidence) {
    if (!manifest.evidence?.path) throw new SingularityFlowError('World-model manifest requires evidence.path.');
    await register(manifest.evidence.path, 'World-model evidence ledger', { jsonl: true });
  } else if (integrity === 'full' && manifest.evidence?.path) await register(manifest.evidence.path, 'World-model evidence ledger', { jsonl: true });

  const actual = (await modelFiles(directory)).filter((file) => file !== 'manifest.json');
  const undeclared = integrity === 'full' ? actual.filter((file) => !registered.has(file)) : [];
  if (undeclared.length) {
    throw new SingularityFlowError(`World-model directory contains files not declared by manifest.json: ${undeclared.join(', ')}`);
  }

  // Size is an operational signal, not an integrity condition. Record and print precise warnings,
  // but never reject an otherwise valid model: budgets must not block generation or publication.
  // Fenced content counts and the independent total ceiling prevents a fence from hiding a runaway
  // document.
  const warnings = [];
  for (const relative of actual.filter((file) => file.endsWith('.md'))) {
    const budget = budgetFor(relative);
    if (!budget) continue;
    const content = await readFile(safeModelPath(directory, relative, 'World-model document'), 'utf8');
    const prose = proseBytes(content);
    const total = Buffer.byteLength(content, 'utf8');
    const exceeded = [];
    if (prose > budget.bytes) exceeded.push(`${prose} authored bytes, advisory budget ${budget.bytes}`);
    if (total > budget.totalBytes) exceeded.push(`${total} total bytes, advisory ceiling ${budget.totalBytes}`);
    if (exceeded.length) warnings.push(`World-model budget warning: ${relative} (${exceeded.join('; ')}).`);
  }
  for (const warning of warnings) console.warn(`Warning: ${warning} Consider moving detail into a domain file or evidence ledger.`);
  return { manifest, normalizedManifest, repositoryCommit, registered: [...registered].sort(), warnings };
}

export async function worldModelFreshness(root, config, manifest) {
  const source = await worldModelSourceSnapshot(root, config);
  const recorded = manifest.source_tree_sha256 ?? null;
  if (recorded) return { built: recorded, current: source.sha256, fresh: recorded === source.sha256, source };
  const built = manifest.repository_commit ?? manifest.repository?.commit ?? null;
  return { built, current: head(root), fresh: built === head(root), source, legacy: true };
}

function normalizeTask(value) { return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' '); }

/**
 * Where this repository's world model actually is.
 *
 * A model may live on the orphan state branch, in the working tree, or in both. The state branch
 * wins: it is the governed copy, written deliberately and never rewritten by a rebase of the code,
 * whereas a working tree holds whatever the last local build left behind. Reading whichever was
 * checked out is how two people on the same commit ground a phase differently.
 *
 * The branch copy is materialized into a temporary directory so every reader downstream keeps
 * taking a plain directory and none of them has to learn about Git. It is cached by tree hash, so
 * repeated reads of an unchanged model cost one `rev-parse`.
 */
export async function resolveWorldModelSource(root, config, {
  stateBranch = null,
  refreshRemote = true
} = {}) {
  const worktree = path.join(root, config.outputDir);
  const branch = stateBranch ?? config.stateBranch ?? config.ledger?.branch ?? null;
  if (!branch) return {
    directory: worktree, source: 'worktree', branch: null, ref: null,
    commit: worldModelCommit(root, config.outputDir), treeSha: null,
    authority: existsSync(path.join(worktree, 'manifest.json')) ? 'local-only' : 'absent',
    refresh: 'not-configured'
  };

  const remote = config.remote ?? config.definition?.git?.remote ?? 'origin';
  const stateFetchTimeoutMs = config.stateFetchTimeoutMs
    ?? config.definition?.worldModel?.stateFetchTimeoutMs
    ?? 10_000;
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const localRef = `refs/heads/${branch}`;
  const remoteConfigured = run('git', ['remote', 'get-url', remote], { cwd: root, allowFailure: true }).status === 0;
  let refresh = remoteConfigured ? (refreshRemote ? 'refreshed' : 'cached') : 'no-remote';
  let fetchSucceeded = false;
  if (remoteConfigured && refreshRemote) {
    const fetched = runRemoteGit(['fetch', '--no-tags', remote, `+refs/heads/${branch}:${remoteRef}`], {
      cwd: root, operation: 'remote-configuration', timeoutMs: stateFetchTimeoutMs
    });
    const missingRemoteRef = fetched.status !== 0
      && /couldn.t find remote ref|remote ref does not exist/i.test(`${fetched.stderr}\n${fetched.stdout}`);
    // A repository that has never published a state branch is reachable but absent, not offline.
    // Treating the ordinary first-run case as an offline cache made diagnostics claim a network
    // problem and could retain a stale remote-tracking ref after the server branch was removed.
    fetchSucceeded = fetched.status === 0 || missingRemoteRef;
    if (missingRemoteRef) {
      refresh = 'remote-absent';
      run('git', ['update-ref', '-d', remoteRef], { cwd: root, allowFailure: true });
    } else if (!fetchSucceeded) {
      refresh = fetched.error?.code === 'ETIMEDOUT' ? 'timeout-cached' : 'offline-cached';
    }
  }

  // `rev-parse <ref>:<dir>` names the tree; absent from both refs means the branch has no model,
  // which is the ordinary state of a repository whose model has only ever been built locally.
  //
  // The remote ref is tried first, and it is not redundant: a fresh clone has fetched the state
  // branch without creating a local branch for it, so naming the branch plainly finds nothing on
  // exactly the machines that have never published. Same precedence the ledger itself resolves by.
  const treeOn = (ref) => {
    const found = run('git', ['rev-parse', `${ref}:${config.outputDir}`], { cwd: root, allowFailure: true });
    return found.status === 0 ? found.stdout.trim() : null;
  };
  const remoteTree = treeOn(remoteRef);
  const localTree = treeOn(localRef);
  const selectedRef = remoteTree ? remoteRef : localTree ? localRef : null;
  const treeSha = selectedRef ? treeOn(selectedRef) : null;
  const commitOn = (ref) => {
    const found = run('git', ['rev-parse', ref], { cwd: root, allowFailure: true });
    return found.status === 0 ? found.stdout.trim() : null;
  };
  const remoteCommit = remoteTree ? commitOn(remoteRef) : null;
  const localCommit = localTree ? commitOn(localRef) : null;
  const isAncestor = (ancestor, descendant) => Boolean(ancestor && descendant)
    && run('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: root, allowFailure: true }).status === 0;
  const localAhead = Boolean(remoteCommit && localCommit && remoteCommit !== localCommit && isAncestor(remoteCommit, localCommit));
  const remoteAhead = Boolean(remoteCommit && localCommit && remoteCommit !== localCommit && isAncestor(localCommit, remoteCommit));
  const diverged = Boolean(remoteCommit && localCommit && remoteCommit !== localCommit && !localAhead && !remoteAhead);
  let authority;
  if (diverged) authority = 'diverged';
  else if (remoteConfigured && !fetchSucceeded) authority = selectedRef ? 'offline-unverified' : 'absent';
  else if (remoteTree && localAhead) authority = 'unpublished-local-state';
  else if (remoteTree) authority = 'remote-governed';
  else if (localTree) authority = remoteConfigured ? 'unpublished-local-state' : 'local-only';
  else authority = 'absent';
  if (!treeSha) return {
    directory: worktree, source: 'worktree', branch, ref: null,
    commit: worldModelCommit(root, config.outputDir), treeSha: null, authority,
    refresh: remoteConfigured && ['offline-cached', 'timeout-cached'].includes(refresh)
      ? 'offline-no-state-copy'
      : refresh,
    diverged, stateFetchTimeoutMs
  };
  const commit = run('git', ['rev-parse', selectedRef], { cwd: root }).stdout.trim();

  // The full tree identity avoids prefix collisions. Extraction is staged, fully validated, and
  // atomically renamed so an interrupted or concurrent reader can never bless a partial cache just
  // because manifest.json happened to arrive first.
  const cached = path.join(os.tmpdir(), `singularity-flow-world-model-${treeSha}`);
  // Cache validation is deliberately Git-structural rather than schema-semantic. Historical state
  // projections can still be read and diagnosed by the normal candidate validator, while a
  // partial extraction can never be mistaken for the complete immutable tree.
  const validateExtractedTree = (directory) => {
    const expected = run('git', ['ls-tree', '-r', treeSha], { cwd: root }).stdout
      .split('\n').filter(Boolean).map((line) => {
        const match = line.match(/^\d+\s+blob\s+([0-9a-f]+)\t(.+)$/);
        return match ? { sha: match[1], file: match[2] } : null;
      }).filter(Boolean);
    const actualFiles = [];
    const visit = (relative = '') => {
      const directoryPath = path.join(directory, relative);
      for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) visit(child);
        else if (entry.isFile()) actualFiles.push(child);
      }
    };
    visit();
    actualFiles.sort();
    const expectedFiles = expected.map((entry) => entry.file).sort();
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
      throw new SingularityFlowError(`Governed world-model cache ${treeSha} is incomplete.`);
    }
    for (const entry of expected) {
      const hashed = run('git', ['hash-object', path.join(directory, entry.file)], { cwd: root }).stdout.trim();
      if (hashed !== entry.sha) {
        throw new SingularityFlowError(`Governed world-model cache ${treeSha} has invalid bytes for ${entry.file}.`);
      }
    }
  };
  const validateCache = () => validateExtractedTree(cached);
  let cacheReady = false;
  if (existsSync(cached)) {
    try { await validateCache(); cacheReady = true; }
    catch { await rm(cached, { recursive: true, force: true }); }
  }
  if (!cacheReady) {
    const staging = await mkdtemp(path.join(os.tmpdir(), `singularity-flow-world-model-${treeSha}-incoming-`));
    // Extracted rather than checked out: a checkout would move the working tree out from under
    // whoever is using it, to read something they did not ask to switch to.
    //
    // Two spawns rather than a shell pipeline. This was `bash -c 'git archive … | tar -x'`, and the
    // failure is silent by design — it falls back to the working tree. On a machine with no bash on
    // PATH that fallback fired every single time, so "the state branch wins" quietly stopped being
    // true: two people on the same commit ground a phase from different bytes and nothing said so.
    // `git archive -o` writes the file itself and `tar -xf` reads it, so no shell is involved and
    // Windows works the same as everywhere else.
    const archive = path.join(staging, '.singularity-world-model.tar');
    const written = run('git', ['archive', '--format=tar', '--output', archive, treeSha], { cwd: root, allowFailure: true });
    const extracted = written.status === 0
      ? run('tar', ['-xf', archive, '-C', staging], { cwd: root, allowFailure: true })
      : written;
    await rm(archive, { force: true });
    if (extracted.status !== 0) {
      await rm(staging, { recursive: true, force: true });
      throw new SingularityFlowError(
        `Could not materialize governed world model ${selectedRef}:${config.outputDir}; `
        + 'the working-tree copy was not used because that would change grounding authority silently.',
        { code: 'world_model.state_extraction_failed', details: { branch, ref: selectedRef, treeSha } }
      );
    }
    try {
      validateExtractedTree(staging);
      try { await rename(staging, cached); }
      catch (error) {
        // Another process may have completed the identical extraction first. Its directory wins
        // only after the same full validation.
        if (!existsSync(cached)) throw error;
        await rm(staging, { recursive: true, force: true });
        await validateCache();
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
  return {
    directory: cached, source: 'state-branch', branch, ref: selectedRef, commit, treeSha,
    authority, refresh, diverged, stateFetchTimeoutMs
  };
}

export async function resolveWorldModelContext(root, config, phase, {
  task = null, evidence = false, includeAgentPrompt = false, plan: suppliedPlan = null,
  located: suppliedLocated = null
} = {}) {
  const phaseConfig = config.phases?.[phase];
  if (!phaseConfig) throw new SingularityFlowError(`Unknown world-model phase: ${phase}`);
  const plan = suppliedPlan ?? resolveGroundingPlan({
    phase,
    phaseViews: phaseConfig.declaredViews ?? phaseConfig.views ?? [],
    agentViews: phaseConfig.agentViews ?? [],
    agentViewMode: phaseConfig.agentViewMode ?? config.agentViewMode ?? 'fallback',
    depth: phaseConfig.depth ?? 'standard',
    evidence: evidence || phaseConfig.evidence,
    task,
    context: config.context
  });
  // The state branch wins where it has a model; the working tree answers otherwise.
  const located = suppliedLocated ?? await resolveWorldModelSource(root, config);
  const directory = located.directory;
  const { manifest, normalizedManifest } = await validateWorldModelDirectory(directory, {
    requiredSelections: plan.selections,
    expectedTask: plan.taskGuide.required ? plan.taskGuide.task : null,
    requireEvidence: plan.includeEvidence,
    sourceLabel: located.source === 'state-branch' ? `governed state-branch model${located.branch ? ` '${located.branch}'` : ''}` : 'working-tree model'
  });
  const freshness = await worldModelFreshness(root, config, manifest);
  const selected = [];
  const add = async (relative, level, reason, required = true) => {
    if (!relative) {
      if (required) throw new SingularityFlowError(`Required world-model context is not declared: ${reason}.`);
      return;
    }
    const absolute = safeModelPath(directory, relative, `World-model context '${reason}'`);
    const info = await snapshot(absolute);
    if (!info.exists || !info.sha256 || info.size < 1) {
      if (required) throw new SingularityFlowError(`Required world-model context is missing: ${relative} (${reason}).`);
      return;
    }
    const relativePath = posix(relative);
    if (!selected.some((item) => item.relative === relativePath)) selected.push({ relative: relativePath, absolute, level, reason, ...info });
  };
  // The core and each view are read at the tier the phase's declared depth asks for. Every model is
  // required to produce a brief of both (see the v2 checks above) and, until this, nothing ever read
  // one: the full text was taken unconditionally and `depth` changed only the builder's prompt.
  const legacyFallback = normalizedManifest.source_schema_version !== '3.0';
  const plannedCore = worldModelSelectionEntry(normalizedManifest, plan.core, {
    allowLegacyFallback: legacyFallback
  });
  await add(plannedCore.path, 0, `shared repository core (${plan.core.tier})`);
  const knownCorePaths = new Set(['brief', 'full']
    .map((tier) => worldModelSelectionEntry(normalizedManifest, { kind: 'core', tier }, {
      allowLegacyFallback: legacyFallback
    })?.path)
    .filter(Boolean));
  // Custom always-on files remain supported, but core tiers are owned by the plan. Otherwise a
  // literal `core/summary.md` here silently defeats a brief plan and restores the full token cost.
  for (const relative of config.context?.always ?? []) {
    if (!knownCorePaths.has(relative)) await add(relative, 0, 'shared repository context');
  }
  if (includeAgentPrompt && config.agentPrompt) {
    const info = await snapshot(path.join(root, config.agentPrompt));
    if (!info.exists) throw new SingularityFlowError(`Active governed-agent prompt is missing: ${config.agentPrompt}`);
  }
  for (const selection of plan.views) {
    const entry = worldModelSelectionEntry(normalizedManifest, selection, {
      allowLegacyFallback: legacyFallback
    });
    await add(entry.path, 1, `${phase} view: ${selection.view} (${selection.tier}; ${selection.origin})`);
  }
  if (plan.includeDomains !== 'none') {
    for (const domain of manifest.domains ?? []) {
      if (plan.includeDomains === 'all' || (domain.relevant_views ?? []).some((view) => plan.views.some((selection) => selection.view === view))) await add(domain.path, 2, `domain: ${domain.id}`);
    }
  }
  if (plan.taskGuide.required) {
    const normalized = normalizeTask(plan.taskGuide.task);
    const exact = (manifest.task_guides ?? []).find((guide) => normalizeTask(guide.task) === normalized);
    if (!exact) throw new SingularityFlowError(`World model has no task guide for '${plan.taskGuide.task}'. Materialize it with the same --task value.`);
    await add(exact.path, 2, `task guide: ${exact.id}`);
  }
  if (plan.includeEvidence) await add(manifest.evidence?.path, 3, 'evidence ledger');
  return { manifest, normalizedManifest, freshness, selected, directory, plan, located };
}

// Why the repository world model needs (re)building, or null when it is present, committed, and
// current. Read-only — callers decide whether to build, prompt, or ignore.
export async function worldModelRebuildReason(root, config) {
  const outputDir = config.worldModel?.outputDir ?? 'singularity/world-model';
  const manifestPath = path.join(root, outputDir, 'manifest.json');
  if (!existsSync(manifestPath)) return 'The governed repository world model has not been built.';
  try {
    const effectiveConfig = await withInitiativeRoot(root, config);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const currentSource = await worldModelSourceSnapshot(root, effectiveConfig);
    if (!worldModelCommit(root, outputDir)) return 'The repository world model is not committed.';
    if (!manifest.source_tree_sha256 || manifest.source_tree_sha256 !== currentSource.sha256) {
      const changedSources = sourcePathsChangedSince(root, effectiveConfig, manifest.repository_commit ?? manifest.repository?.commit);
      if (changedSources?.length === 0) return null;
      if (changedSources?.length) {
        const visible = changedSources.slice(0, 6).join(', ');
        const suffix = changedSources.length > 6 ? ` and ${changedSources.length - 6} more` : '';
        return `The repository world model is stale for source changes: ${visible}${suffix}.`;
      }
      return 'The repository world model is stale for the current source tree.';
    }
    return null;
  } catch (error) {
    return `The repository world model is invalid: ${error.message}`;
  }
}

export function worldModelCommit(root, outputDir) {
  return run('git', ['log', '-1', '--format=%H', '--', outputDir], { cwd: root, allowFailure: true }).stdout.trim() || null;
}

export function groundingRecordRelative(definition, workflow, phase, generation = phase.generation + 1) {
  return posix(path.join(definition.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'context', `${phase.id}-gen${generation}.json`));
}

function severityResult(mode, messages) {
  return mode === 'enforce' ? { errors: messages, warnings: [] } : { errors: [], warnings: messages };
}

const GROUNDING_FILE_CATEGORIES = new Set([
  'required', 'rule', 'capability', 'reference', 'supporting-evidence',
  'design-source-provenance', 'design-inventory'
]);

function safeGroundingPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = posix(value.trim());
  if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) return null;
  return normalized.replace(/^\.\//, '');
}

function withinGroundingRoot(value, root) {
  const normalizedRoot = posix(root).replace(/\/$/, '');
  return value === normalizedRoot || value.startsWith(`${normalizedRoot}/`);
}

function recordedReferenceHandle(file, record) {
  if (file.handle) return file.handle;
  const byHash = (record.references ?? []).find((reference) =>
    reference.path === file.path
    || reference.rawSha256 === file.sha256
    || reference.previewSha256 === file.previewSha256
  );
  if (byHash?.handle) return byHash.handle;
  const reason = String(file.reason ?? '');
  const marker = reason.indexOf('sfref:v1:');
  return marker >= 0 ? reason.slice(marker).trim() : null;
}

function approvedReferenceHandles(workflow, activePhase) {
  const order = workflow.phaseOrder ?? Object.keys(workflow.phases ?? {});
  const activeIndex = order.indexOf(activePhase);
  const earlierApproved = new Set(order.slice(0, Math.max(0, activeIndex))
    .filter((phaseId) => workflow.phases?.[phaseId]?.status === 'approved'));
  return new Set((workflow.lineage?.submissions ?? [])
    .filter((submission) => earlierApproved.has(submission.phase))
    .flatMap((submission) => submission.projection?.references ?? [])
    .map((reference) => reference?.handle)
    .filter(Boolean));
}

function currentGroundingPath(definition, workflow, file) {
  const relative = safeGroundingPath(file.path);
  if (!relative) return null;
  // Versions before category-aware recording stored design-source paths relative
  // to the work item. Accept that precise legacy shape while new records always
  // carry repository-relative paths.
  if (['design-source-provenance', 'design-inventory'].includes(file.category)
      && relative.startsWith('context/')) {
    return posix(path.join(definition.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, relative));
  }
  return relative;
}

export async function verifyGroundingRecord(root, definition, workflow, phase, { generation = phase.generation + 1, agent = null } = {}) {
  const mode = groundingMode(definition, workflow);
  if (mode === 'off') return { mode, errors: [], warnings: [], passes: [], record: null, path: null };
  const relative = groundingRecordRelative(definition, workflow, phase, generation);
  const absolute = path.join(root, relative);
  if (!(await exists(absolute))) {
    const severity = severityResult(mode, [`grounding composition is missing for ${phase.id} generation ${generation}; run singularity-flow wm compose --phase ${phase.id}`]);
    return { mode, ...severity, passes: [], record: null, path: relative };
  }
  let record;
  try { record = readRecord('prompt-injection', await readFile(absolute)).record; }
  catch (error) {
    if (String(error?.code ?? '').startsWith('SCHEMA_')) throw error;
    const severity = severityResult(mode, [`grounding composition is invalid JSON for ${phase.id} generation ${generation}: ${error.message}`]);
    return { mode, ...severity, passes: [], record: null, path: relative };
  }
  const problems = [];
  const stalenessProblems = [];
  if (record.workId !== workflow.workItem.id || record.phase !== phase.id || record.generation !== generation) problems.push(`grounding composition identity mismatch: ${relative}`);
  if (!record.agent) problems.push(`grounding composition has no agent: ${relative}`);
  else if (!definition.agents?.[record.agent]) problems.push(`grounding composition uses unknown agent '${record.agent}': ${relative}`);
  if (agent && record.agent !== agent) problems.push(`grounding composition agent '${record.agent}' differs from active agent '${agent}'`);
  if (!/^[0-9a-f]{40}$/.test(record.worldModelCommit ?? '')) problems.push(`grounding composition has no committed world-model revision: ${relative}`);
  for (const field of ['manifestSha256', 'renderedSha256']) if (!/^[0-9a-f]{64}$/.test(record[field] ?? '')) problems.push(`grounding composition has invalid ${field}: ${relative}`);
  for (const field of ['modelSourceTreeSha256', 'composedSourceTreeSha256']) if (!/^sha256:[0-9a-f]{64}$/.test(record[field] ?? '')) problems.push(`grounding composition has invalid ${field}: ${relative}`);
  if (record.fresh !== true) stalenessProblems.push(`grounding composition was created from a stale world model: ${relative}`);
  if (record.modelSourceTreeSha256 && record.composedSourceTreeSha256 && record.modelSourceTreeSha256 !== record.composedSourceTreeSha256) problems.push(`grounding composition source hash does not match its world model: ${relative}`);
  if (record.stale === true) stalenessProblems.push(`grounding composition is stale: ${relative}`);
  if (!Array.isArray(record.files) || !record.files.length) problems.push(`grounding composition contains no world-model files: ${relative}`);
  if (!record.promptPath) problems.push(`grounding composition has no committed prompt snapshot: ${relative}`);
  else {
    const promptRelative = posix(record.promptPath);
    const expectedRoot = `${posix(path.join(definition.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'context', 'prompts'))}/`;
    if (!promptRelative.startsWith(expectedRoot)) problems.push(`grounding prompt snapshot escapes the work-item context: ${promptRelative}`);
    else {
      const info = await snapshot(path.join(root, promptRelative));
      if (!info.exists || info.sha256 !== record.renderedSha256) problems.push(`grounding prompt snapshot hash differs: ${promptRelative}`);
    }
  }
  if (record.workSource) {
    const expectedSourcePath = posix(path.join(
      definition.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'source.json'
    ));
    const sourceInfo = await snapshot(path.join(root, expectedSourcePath));
    if (record.workSource.path !== expectedSourcePath
        || !sourceInfo.exists
        || record.workSource.sha256 !== sourceInfo.sha256
        || record.workSource.bytes !== sourceInfo.size) {
      problems.push(`grounding composition is not bound to the current pinned Story source: ${expectedSourcePath}`);
    }
    if (workflow.resolution?.sourceSha256
        && record.workSource.sha256 !== workflow.resolution.sourceSha256) {
      problems.push(`grounding composition Story source differs from the immutable workflow source hash: ${expectedSourcePath}`);
    }
  }
  // Resolved with the same rule the composer used, from the same module. When these two disagreed
  // the verifier reported views as "omitted" that composition had correctly decided not to include.
  const plan = resolveGroundingPlan({
    phase: phase.id,
    phaseViews: phase.worldModel?.views ?? [],
    agentViews: definition.agents?.[agent ?? record.agent]?.worldModelViews ?? [],
    agentViewMode: definition.worldModel?.agentViews ?? 'fallback',
    depth: phase.worldModel?.depth ?? 'standard',
    evidence: phase.worldModel?.evidence ?? false,
    context: definition.worldModel?.context ?? {}
  });
  const requiredViews = plan.views.map((entry) => entry.view);
  if (Array.isArray(record.requiredSelections)) {
    const recorded = new Set(record.requiredSelections.map(selectionId));
    for (const selection of plan.selections) {
      const id = selectionId(selection);
      if (!recorded.has(id)) problems.push(`grounding composition omitted required selection '${id}' for ${phase.id}`);
    }
  } else {
    // Historical v1 receipts predate exact tier identities. Preserve their verification contract.
    for (const view of requiredViews) if (!(record.requiredViews ?? []).includes(view)) problems.push(`grounding composition omitted required view '${view}' for ${phase.id}`);
  }
  const modelRoot = posix(definition.worldModel?.outputDir ?? 'singularity/world-model').replace(/\/$/, '');
  const workItemRoot = posix(path.join(definition.workItemRoot ?? 'singularity/work-items', workflow.workItem.id));
  const capabilityRoot = posix(path.join(workItemRoot, 'context', 'capability-world-model'));
  const evidenceRoot = posix(path.join(workItemRoot, 'inputs'));
  const contextRoot = posix(path.join(workItemRoot, 'context'));
  const approvedHandles = approvedReferenceHandles(workflow, phase.id);
  let documents = null;
  const documentsPath = path.join(root, workItemRoot, 'documents.json');
  if (await exists(documentsPath)) {
    try { documents = JSON.parse(await readFile(documentsPath, 'utf8')); }
    catch (error) { problems.push(`supporting-evidence catalog is invalid JSON: ${error.message}`); }
  }
  const referencePolicy = workflow.resolution?.harnessImports ?? definition.harnessImports ?? {};
  const seen = new Set();
  for (const file of record.files ?? []) {
    const recordedPath = currentGroundingPath(definition, workflow, file);
    const identity = `${file.category ?? 'unknown'}:${recordedPath ?? file.path}`;
    if (seen.has(identity)) problems.push(`grounding composition repeats ${file.path}`);
    seen.add(identity);
    if (!recordedPath) problems.push(`grounding composition has an unsafe or empty path: ${file.path}`);
    if (!/^[0-9a-f]{64}$/.test(file.sha256 ?? '')) problems.push(`grounding composition has invalid hash for ${file.path}`);
    if (!GROUNDING_FILE_CATEGORIES.has(file.category)) problems.push(`grounding composition has invalid category for ${file.path}`);
    if (!Number.isInteger(file.bytes) || file.bytes < 0 || !Number.isInteger(file.injectedBytes) || file.injectedBytes < 0) problems.push(`grounding composition has invalid byte accounting for ${file.path}`);
    if (file.category === 'required' && (file.truncated || file.injectedBytes !== file.bytes)) problems.push(`required grounding was truncated for ${file.path}`);
    if (['required', 'rule'].includes(file.category)) {
      if (!recordedPath || !withinGroundingRoot(recordedPath, modelRoot)) problems.push(`grounding composition references a file outside the repository world model: ${file.path}`);
      if (file.injectedBytes > file.bytes) problems.push(`grounding composition has invalid byte accounting for ${file.path}`);
    }
    if (['required', 'rule'].includes(file.category) && record.worldModelCommit && recordedPath && file.sha256) {
      const content = run('git', ['show', `${record.worldModelCommit}:${recordedPath}`], { cwd: root, allowFailure: true });
      if (content.status !== 0) problems.push(`world-model commit ${record.worldModelCommit.slice(0, 8)} does not contain ${file.path}`);
      else if (createHash('sha256').update(content.stdout).digest('hex') !== file.sha256) problems.push(`world-model commit hash differs for ${file.path}`);
    }
    if (file.category === 'capability') {
      if (!recordedPath || !withinGroundingRoot(recordedPath, capabilityRoot)) problems.push(`capability grounding escapes the work-item context: ${file.path}`);
      if (file.injectedBytes > file.bytes) problems.push(`grounding composition has invalid byte accounting for ${file.path}`);
      if (recordedPath && file.sha256) {
        const current = await snapshot(path.join(root, recordedPath));
        if (!current.exists || current.sha256 !== file.sha256 || current.size !== file.bytes) problems.push(`capability world-model snapshot differs for ${file.path}`);
      }
    }
    if (file.category === 'supporting-evidence') {
      if (!recordedPath || !withinGroundingRoot(recordedPath, evidenceRoot)) problems.push(`supporting evidence escapes the work-item inputs: ${file.path}`);
      if (file.injectedBytes > file.bytes) problems.push(`grounding composition has invalid byte accounting for ${file.path}`);
      const descriptor = (record.supportingEvidence ?? []).find((entry) => entry.id === file.evidenceId || entry.path === recordedPath);
      if (!descriptor || descriptor.path !== recordedPath || descriptor.sha256 !== file.sha256 || descriptor.bytes !== file.bytes
          || descriptor.injectedBytes !== file.injectedBytes || Boolean(descriptor.truncated) !== Boolean(file.truncated)) {
        problems.push(`supporting-evidence metadata differs for ${file.path}`);
      }
      const catalogEntry = documents?.documents?.find((entry) => entry.id === file.evidenceId || entry.path === recordedPath);
      if (!catalogEntry || ![undefined, null, 'active', 'pinned'].includes(catalogEntry.status)
          || catalogEntry.path !== recordedPath || catalogEntry.sha256 !== file.sha256 || catalogEntry.size !== file.bytes) {
        problems.push(`supporting evidence is detached, missing, or differs from documents.json: ${file.path}`);
      }
      if (recordedPath && file.sha256) {
        const current = await snapshot(path.join(root, recordedPath));
        if (!current.exists || current.sha256 !== file.sha256 || current.size !== file.bytes) problems.push(`supporting-evidence snapshot differs for ${file.path}`);
      }
    }
    if (file.category === 'reference') {
      const handle = recordedReferenceHandle(file, record);
      if (!handle) problems.push(`grounding reference has no governed handle for ${file.path}`);
      else {
        if (approvedHandles.size && !approvedHandles.has(handle)) problems.push(`grounding reference is not an approved earlier-phase input: ${handle}`);
        try {
          const rawResolved = await resolveReference(root, handle, {
            maxBytes: referencePolicy.previewTextBytes,
            totalEnvelopeBytes: referencePolicy.totalEnvelopeBytes
          });
          const authoredResolved = authoredReferencePreview(rawResolved);
          // Historical prompt receipts recorded the complete published preview. New receipts use
          // the authored-only projection. Both are reproducible from the same immutable handle;
          // select by the recorded preview identity so an upgrade does not invalidate history.
          const resolved = file.previewSha256 === authoredResolved.preview.sha256
            ? authoredResolved : rawResolved;
          if (resolved.reference.artifact.path !== recordedPath
              || resolved.source.rawSha256 !== file.sha256 || resolved.source.rawBytes !== file.bytes
              || (file.previewSha256 && resolved.preview.sha256 !== file.previewSha256)
              || (file.previewBytes != null && resolved.preview.bytes !== file.previewBytes)
              || resolved.preview.bytes !== file.injectedBytes
              || Boolean(resolved.truncated) !== Boolean(file.truncated)
              || (file.renderer && JSON.stringify(resolved.renderer) !== JSON.stringify(file.renderer))) {
            problems.push(`grounding reference preview differs for ${file.path}`);
          }
        } catch (error) { problems.push(`grounding reference cannot be reproduced for ${file.path}: ${error.message}`); }
      }
    }
    if (['design-source-provenance', 'design-inventory'].includes(file.category)) {
      if (!recordedPath || !withinGroundingRoot(recordedPath, contextRoot)) problems.push(`design-source grounding escapes the work-item context: ${file.path}`);
      if (recordedPath && file.sha256) {
        const current = await snapshot(path.join(root, recordedPath));
        if (!current.exists || current.sha256 !== file.sha256 || current.size !== file.bytes) problems.push(`design-source snapshot differs for ${file.path}`);
      }
      if (file.category === 'design-source-provenance' && recordedPath) {
        try {
          const provenance = JSON.parse(await readFile(path.join(root, recordedPath), 'utf8'));
          if (provenance.workId !== workflow.workItem.id || provenance.phase !== phase.id || provenance.generation !== generation) {
            problems.push(`design-source provenance identity differs for ${file.path}`);
          }
        } catch (error) { problems.push(`design-source provenance is invalid JSON for ${file.path}: ${error.message}`); }
      }
    }
  }
  let committedManifest = null;
  if (record.worldModelCommit && record.manifestSha256) {
    const manifestPath = posix(path.join(definition.worldModel?.outputDir ?? 'singularity/world-model', 'manifest.json'));
    const content = run('git', ['show', `${record.worldModelCommit}:${manifestPath}`], { cwd: root, allowFailure: true });
    if (content.status !== 0) problems.push(`world-model commit ${record.worldModelCommit.slice(0, 8)} does not contain manifest.json`);
    else {
      if (createHash('sha256').update(content.stdout).digest('hex') !== record.manifestSha256) problems.push('world-model manifest hash differs from the composition record');
      try { committedManifest = JSON.parse(content.stdout); }
      catch { problems.push('committed world-model manifest is invalid JSON'); }
    }
  }
  if (committedManifest) {
    if (committedManifest.source_tree_sha256 !== record.modelSourceTreeSha256) problems.push('world-model source hash differs from the composition record');
    const outputDir = definition.worldModel?.outputDir ?? 'singularity/world-model';
    const normalizedCommitted = normalizeWorldModelManifest(committedManifest);
    const exactReceipt = Array.isArray(record.requiredSelections);
    if (exactReceipt) {
      const allowLegacyFallback = normalizedCommitted.source_schema_version !== '3.0';
      for (const selection of plan.selections) {
        const entry = worldModelSelectionEntry(normalizedCommitted, selection, { allowLegacyFallback });
        const expected = entry?.path ? posix(path.join(outputDir, entry.path)) : null;
        if (entry?.status !== 'ready' || !expected || !(record.files ?? []).some((file) => file.path === expected)) {
          problems.push(`grounding composition has no committed content for required selection '${selectionId(selection)}'`);
        }
      }
    } else {
      // Historical receipts predate tier identities. Preserve the old either-tier verification
      // contract instead of retroactively rejecting already published generations.
      for (const view of requiredViews) {
        const entry = committedManifest.views?.[view];
        const candidates = [entry?.path, entry?.brief_path]
          .filter(Boolean)
          .map((relative) => posix(path.join(outputDir, relative)));
        if (!candidates.length || !(record.files ?? []).some((file) => candidates.includes(file.path))) problems.push(`grounding composition has no committed content for required view '${view}'`);
      }
    }
    const plannedCore = worldModelSelectionEntry(normalizedCommitted, plan.core, {
      allowLegacyFallback: normalizedCommitted.source_schema_version !== '3.0'
    });
    const requiredContextPaths = exactReceipt ? [] : [committedManifest.core?.summary];
    if (exactReceipt && plannedCore?.status === 'ready') requiredContextPaths.push(plannedCore.path);
    if (record.task) {
      const guide = (committedManifest.task_guides ?? []).find((entry) => normalizeTask(entry.task) === normalizeTask(record.task));
      if (!guide) problems.push(`committed world model has no exact task guide for '${record.task}'`);
      else requiredContextPaths.push(guide.path);
    }
    if (phase.worldModel?.evidence) requiredContextPaths.push(committedManifest.evidence?.path);
    for (const contextPath of requiredContextPaths.filter(Boolean)) {
      const recordedPath = posix(path.join(definition.worldModel?.outputDir ?? 'singularity/world-model', contextPath));
      if (!(record.files ?? []).some((file) => file.path === recordedPath)) problems.push(`grounding composition omitted required context '${contextPath}'`);
    }
  }
  const severity = severityResult(mode, problems);
  const staleness = worldModelStalenessDecision(
    workflow.resolution?.worldModelStaleness ?? definition.worldModel?.staleness ?? 'warn',
    stalenessProblems.length === 0,
    stalenessProblems.join('; ')
  );
  const errors = [...severity.errors, ...(staleness.blocks ? stalenessProblems : [])];
  const warnings = [...severity.warnings, ...(staleness.warns ? stalenessProblems : [])];
  return {
    mode, errors, warnings, staleness,
    passes: errors.length || warnings.length ? [] : [`grounding composition: ${phase.id} generation ${generation} (${record.files.length} files)`],
    record, path: relative
  };
}
