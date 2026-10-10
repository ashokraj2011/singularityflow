import { nextPhaseGeneration } from './phase-generation.mjs';
import { createHash } from 'node:crypto';
import { readlink } from 'node:fs/promises';
import path from 'node:path';
import { exactEnvironmentDeclarationAtRef } from './git.mjs';
import {
  gitHeadIsUnborn, gitReadOutput, mapLimit, posix, run, secureRepositoryPath, SingularityFlowError, snapshot
} from './util.mjs';
import { sourcePathIncluded, worldModelSourceScope } from './source-scope.mjs';
import { withoutConfiguredFilters } from './worktree-fingerprint.mjs';
import { loadPortfolio } from './initiative-config.mjs';
import { assertNoHiddenWorktreeChanges } from './worktree-fingerprint.mjs';
import { loadEnvironmentDeclaration, matchEnvironmentLocalPath } from './environment-declaration.mjs';

// Open file descriptors while hashing a tree. Enough to keep the disk busy, few enough not to
// exhaust the descriptor table on a large repository.
const SNAPSHOT_CONCURRENCY = 16;
export const WORLD_MODEL_SOURCE_FINGERPRINT_ALGORITHM = 'sflow-source-git-v2';

async function withInitiativeRoot(root, definition = {}) {
  if (definition.initiativeRoot) return definition;
  const portfolio = await loadPortfolio(root, { required: false }).catch(() => null);
  return portfolio?.initiativeRoot ? { ...definition, initiativeRoot: portfolio.initiativeRoot } : definition;
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
  const secured = await secureRepositoryPath(root, relative, {
    label: 'World-model source path',
    allowFinalSymlink: true
  });
  const absolute = secured.absolute;
  if (!secured.exists) {
    if (indexed?.skipWorktree) {
      return {
        path: relative, status: 'present', materialization: 'sparse-absent', mode: indexed.mode,
        objectId: `git:${indexed.objectId}`, sha256: null
      };
    }
    return { path: relative, status: 'deleted', materialization: 'absent', mode: indexed?.mode ?? null, objectId: null, size: 0, sha256: null };
  }
  if (indexed?.mode === '160000') {
    throw new SingularityFlowError(
      `World-model source contains a changed or dirty Git submodule at ${relative}. Commit and `
        + 'stage the submodule pointer with a clean nested worktree before generating the model.',
      { code: 'WORLD_MODEL_GITLINK_DIRTY', details: { path: relative } }
    );
  }
  if (indexed && compareToIndex) {
    const stat = secured.entry;
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
  if (secured.entry?.isSymbolicLink()) {
    const target = Buffer.from(await readlink(absolute));
    return {
      path: relative,
      status: 'present',
      materialization: indexed ? 'worktree' : 'untracked',
      mode: '120000',
      objectId: `sha256:${createHash('sha256').update(target).digest('hex')}`,
      size: target.length,
      sha256: createHash('sha256').update(target).digest('hex')
    };
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

function environmentSourcePolicies(...declarations) {
  const byDigest = new Map();
  for (const declaration of declarations.flat().filter(Boolean)) {
    byDigest.set(declaration.declarationSha256, declaration);
  }
  return [...byDigest.values()];
}

function matchesEnvironmentSourcePolicy(declarations, file) {
  return declarations.some((declaration) => Boolean(matchEnvironmentLocalPath(declaration, file)));
}

async function currentEnvironmentSourcePolicies(root) {
  const current = await loadEnvironmentDeclaration(root, { optional: true });
  const committed = exactEnvironmentDeclarationAtRef(root, 'HEAD');
  return environmentSourcePolicies(current, committed);
}

/**
 * Describe a Git worktree without reading every tracked file.
 *
 * The index already content-addresses every clean or staged path. Only paths whose visible bytes
 * differ from the index, untracked paths, and explicitly hidden index paths are read. A sparse
 * checkout's SKIP_WORKTREE entries remain present through their index object instead of being
 * misreported as deletions.
 */
async function gitSourceRecords(root, {
  definition = {}, excludeGovernance = true, environmentDeclarations = []
} = {}) {
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
    && sourcePathIncluded(file, definition)
    && !matchesEnvironmentSourcePolicy(environmentDeclarations, file);
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
  assertNoHiddenWorktreeChanges(root, 'World-model source capture');
  const effectiveDefinition = await withInitiativeRoot(root, definition);
  // The names-only declaration is approved configuration (or the request-local immutable
  // configuration overlay). Invalid policy must fail closed: silently ignoring it could admit a
  // historically tracked environment-local file into legacy-v3 grounding.
  const environmentDeclarations = await currentEnvironmentSourcePolicies(root);
  const records = await gitSourceRecords(root, {
    definition: effectiveDefinition,
    excludeGovernance: true,
    environmentDeclarations
  });
  const scope = worldModelSourceScope(effectiveDefinition);
  const hash = createHash('sha256');
  hash.update(WORLD_MODEL_SOURCE_FINGERPRINT_ALGORITHM).update('\0');
  hash.update(JSON.stringify({ sourceRoots: scope.sourceRoots, sharedRoots: scope.sharedRoots,
    ...(effectiveDefinition.worldModel?.sourceHashExcludedRoots != null
      || effectiveDefinition.worldModel?.testConfigurationPaths != null
      ? { sourceHashExcludedRoots: scope.sourceHashExcludedRoots,
        testConfigurationPaths: scope.testConfigurationPaths } : {}) })).update('\0');
  for (const entry of records) {
    hash.update(entry.path).update('\0').update(entry.status).update('\0')
      .update(entry.mode ?? '').update('\0').update(entry.objectId ?? '').update('\0');
  }
  return {
    algorithm: WORLD_MODEL_SOURCE_FINGERPRINT_ALGORITHM,
    scope: { sourceRoots: [...scope.sourceRoots], sharedRoots: [...scope.sharedRoots], all: scope.all,
      ...(effectiveDefinition.worldModel?.sourceHashExcludedRoots != null
        || effectiveDefinition.worldModel?.testConfigurationPaths != null
        ? { sourceHashExcludedRoots: [...scope.sourceHashExcludedRoots],
          testConfigurationPaths: [...scope.testConfigurationPaths] } : {}) },
    sha256: `sha256:${hash.digest('hex')}`,
    files: records
  };
}

/**
 * The last commit that touched the world model, null when none has, or a refusal when Git failed.
 *
 * Null means "not committed", which withholds grounding; a failed read used to answer the same.
 */
export function worldModelCommit(root, outputDir) {
  return gitReadOutput(run('git', ['log', '-1', '--format=%H', '--', outputDir], { cwd: root, allowFailure: true }),
    `World model '${outputDir}' commit`, { absentWhen: () => gitHeadIsUnborn(root) })?.trim() || null;
}

export function groundingRecordRelative(definition, workflow, phase, generation = nextPhaseGeneration(phase)) {
  return posix(path.join(definition.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'context', `${phase.id}-gen${generation}.json`));
}
