import { nextPhaseGeneration } from './phase-generation.mjs';
import { createHash } from 'node:crypto';
import { readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { exactEnvironmentDeclarationAtRef } from './git.mjs';
import { authoredReferencePreview, resolveReference } from './harness-imports.mjs';
import {
  exists, gitHeadIsUnborn, gitReadOutput, mapLimit, posix, run, secureRepositoryPath, SingularityFlowError, snapshot
} from './util.mjs';
import { sourcePathIncluded, worldModelSourceScope } from './source-scope.mjs';
import { withoutConfiguredFilters } from './worktree-fingerprint.mjs';
import { readRecord } from './schema-migrations.mjs';
import { selectionId } from './world-model-selection.mjs';
import { effectiveGroundingMode, registeredWorldModelOn, worldModelStalenessDecision } from './world-model-policy.mjs';
import { loadPortfolio } from './initiative-config.mjs';
import { assertNoHiddenWorktreeChanges } from './worktree-fingerprint.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { loadEnvironmentDeclaration, matchEnvironmentLocalPath } from './environment-declaration.mjs';
import { projectRegisteredView, VIEW_BRIEF_RENDERER, viewProjectionDigest } from './knowledge/view-brief.mjs';

let storyGroundingVerificationRuntimePromise = null;
let promptGenerationVerificationRuntimePromise = null;

async function storyGroundingVerificationRuntime() {
  const runtimeUrl = pathToFileURL(path.join(
    PACKAGE_ROOT, 'src', 'world-model', 'history', 'story-grounding-activation.mjs'
  )).href;
  storyGroundingVerificationRuntimePromise ??= import(runtimeUrl);
  return storyGroundingVerificationRuntimePromise;
}

async function promptGenerationVerificationRuntime() {
  // Read-only gateway workers need the verifier only for a Story that actually carries a
  // persisted-history receipt. A computed packaged URL keeps prompt composition and its provider
  // dependency graph out of every ordinary status/availability bundle.
  const runtimeUrl = pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'inject.mjs')).href;
  promptGenerationVerificationRuntimePromise ??= import(runtimeUrl);
  return promptGenerationVerificationRuntimePromise;
}

// Open file descriptors while hashing a tree. Enough to keep the disk busy, few enough not to
// exhaust the descriptor table on a large repository.
const SNAPSHOT_CONCURRENCY = 16;
export const WORLD_MODEL_SOURCE_FINGERPRINT_ALGORITHM = 'sflow-source-git-v2';

async function withInitiativeRoot(root, definition = {}) {
  if (definition.initiativeRoot) return definition;
  const portfolio = await loadPortfolio(root, { required: false }).catch(() => null);
  return portfolio?.initiativeRoot ? { ...definition, initiativeRoot: portfolio.initiativeRoot } : definition;
}

/** The grounding mode in effect (see effectiveGroundingMode); never read resolution.worldModelGrounding directly. */
export function groundingMode(definition, workflow = null) {
  return effectiveGroundingMode(definition, workflow);
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

/** Agent sources in an accepted Story are logical identities, not checkout filenames. */
export async function resolveWorldModelAgentPrompt(root, config) {
  const source = config.agentPrompt;
  if (!source) return null;
  const execution = config.executionContext;
  const agent = execution?.agent ?? Object.values(config.definition?.agents ?? {})
    .find((candidate) => candidate.source === source);
  const saved = execution?.mode === 'workflow-snapshot';
  if (saved || source.startsWith('agent:')) {
    // The loader has already verified and retained the Story closure. Never substitute a live
    // agent, or reopen its materialized blob, after that operation boundary.
    if (!saved || !agent || source !== `agent:${execution.agentId}`
        || agent.source !== source || agent.id !== execution.agentId
        || typeof agent.text !== 'string'
        || execution.identity?.agentBlobSha256 !== `sha256:${agent.sha256}`) {
      throw new SingularityFlowError(`Saved governed-agent prompt is unavailable: ${source}`, {
        code: 'WFA_DEPENDENCY_UNAVAILABLE'
      });
    }
    return {
      relative: source, logicalId: source, absolute: null, body: agent.text,
      sha256: agent.sha256, size: Buffer.byteLength(agent.text),
      level: 0, reason: 'active agent prompt', source: 'workflow-snapshot'
    };
  }
  // Live repository and packaged agents also carry the exact bytes observed by their loader.
  // Keeping those bytes avoids a second read that could render different content after hashing.
  const absolute = agent?.file ?? path.resolve(root, source);
  let body = agent?.text;
  if (typeof body !== 'string') {
    try { body = await readFile(absolute, 'utf8'); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      throw new SingularityFlowError(`Active governed-agent prompt is missing: ${source}`);
    }
  }
  const sha256 = createHash('sha256').update(body).digest('hex');
  if (agent?.sha256 && sha256 !== agent.sha256) {
    throw new SingularityFlowError(`Active governed-agent prompt changed: ${source}`, {
      code: 'WORLD_MODEL_GROUNDING_INTEGRITY_FAILED'
    });
  }
  return {
    relative: source, absolute, body, sha256, size: Buffer.byteLength(body),
    level: 0, reason: 'active agent prompt', source: agent?.scope ?? 'repository'
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

// Grounding problems are guidance about the prompt's World-Model context, never lifecycle errors.
function groundingWarnings(messages) {
  return { errors: [], warnings: messages };
}

const GROUNDING_FILE_CATEGORIES = new Set([
  'required', 'rule', 'capability', 'reference', 'supporting-evidence',
  'design-source-provenance', 'design-inventory'
]);
const GROUNDING_AVAILABILITY_STATUSES = new Set([
  'available', 'unavailable', 'legacy-unverified'
]);
const SOURCE_COMPARISON_STATUSES = new Set([
  'fresh', 'stale', 'unavailable', 'historical-unproven'
]);

function stableGroundingReasonCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_.-]{0,95}$/.test(value);
}

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

/**
 * Verify the exact-history grounding contract at the lifecycle gate.
 *
 * Persisted Story grounding deliberately does not have a live projection manifest beneath
 * `worldModel.outputDir`: its authoritative objects live at the Story-pinned state cut and its
 * prompt block is materialized as a content-addressed packet pair in the work item. Reusing the
 * legacy projection checks would therefore reject valid packets for having no manifest and for
 * living outside the projection root. This verifier substitutes only those incompatible checks:
 * the ordinary prompt receipt/snapshot verifier still proves exact bytes and packet identity, and
 * the history owner re-proves today's repository, state-ref, and ancestor authority before the
 * receipt is reported as verified. A failure is a warning: the World Model never gates the phase.
 */
async function verifyPersistedStoryGrounding(
  root, definition, workflow, phase, record, relative, generation, agent, authorityOptions = {}
) {
  const generationPhase = nextPhaseGeneration(phase) === Number(generation)
    ? phase
    : { ...phase, generation: Number(generation) - 1, generationHighWatermark: 0 };
  const workDir = path.join(
    root, definition.workItemRoot ?? 'singularity/work-items', workflow.workItem.id
  );
  const { readPromptGeneration } = await promptGenerationVerificationRuntime();
  const verified = await readPromptGeneration(root, workflow, generationPhase, {
    workDir,
    agent: agent ?? record.agent
  });
  if (!verified || verified.file !== relative || verified.record.persistedGrounding == null) {
    throw new SingularityFlowError(
      `Persisted Story grounding receipt is not the exact recorded generation: ${relative}.`,
      { code: 'WORLD_MODEL_GROUNDING_INTEGRITY_FAILED' }
    );
  }

  const {
    assertPinnedStoryWorldModelGroundingReplay,
    assertPinnedStoryWorldModelHistoryAuthority,
    resolvePinnedStoryWorldModelGrounding
  } = await storyGroundingVerificationRuntime();
  const proofOptions = { definition, workflow };
  for (const key of [
    'resolveRepositoryAuthority', 'resolveCurrentAuthority', 'admitHistoryCut'
  ]) {
    if (typeof authorityOptions[key] === 'function') proofOptions[key] = authorityOptions[key];
  }
  const pin = await assertPinnedStoryWorldModelHistoryAuthority(root, proofOptions);
  const plans = pin.phasePlans.filter((entry) => (
    entry.phase === phase.id && entry.agent === verified.record.agent
  ));
  if (plans.length !== 1) {
    throw new SingularityFlowError(
      `Persisted Story grounding has no unique pinned plan for ${phase.id}/${verified.record.agent}.`,
      { code: 'WORLD_MODEL_GROUNDING_INTEGRITY_FAILED' }
    );
  }
  const views = new Map(pin.views.map((entry) => [entry.viewKey, entry]));
  const expectedViews = plans[0].orderedViewKeys;
  const recordedSelections = (verified.record.requiredSelections ?? []).map((entry) => ({
    kind: entry?.kind, view: entry?.view, tier: entry?.tier
  }));
  const expectedSelections = expectedViews.map((viewKey) => ({
    kind: 'view', view: viewKey, tier: views.get(viewKey)?.variant
  }));
  if (JSON.stringify(verified.record.requiredViews ?? []) !== JSON.stringify(expectedViews)
      || JSON.stringify(recordedSelections) !== JSON.stringify(expectedSelections)
      || verified.record.worldModelCommit
        !== verified.record.persistedGrounding.authority.authorityCommit
      || verified.record.manifestSha256 !== null
      || verified.record.modelSourceTreeSha256 !== null) {
    throw new SingularityFlowError(
      `Persisted Story grounding envelope differs from its pinned phase plan: ${relative}.`,
      { code: 'WORLD_MODEL_GROUNDING_INTEGRITY_FAILED' }
    );
  }
  // Receipt, packet, payload, and prompt hashes can prove only that the recorded bytes agree with
  // one another. Re-resolve the immutable Story cut and replay the registered model/view closure
  // before calling the receipt verified, so a coordinated replacement of every local byte cannot
  // pass off prose that was never rendered by the pinned WMP owners.
  const replay = await resolvePinnedStoryWorldModelGrounding(root, {
    ...proofOptions,
    phase: generationPhase,
    agent: verified.record.agent
  });
  if (replay.status !== 'composed' || replay.authorityProven !== true) {
    throw new SingularityFlowError(
      `Persisted Story grounding could not be replayed from its pinned closure: ${relative}.`,
      { code: 'WMP_GROUNDING_REPLAY_MISMATCH' }
    );
  }
  assertPinnedStoryWorldModelGroundingReplay(replay, {
    receipt: verified.record.persistedGrounding,
    promptText: verified.text
  });
  return { record: verified.record, pin };
}

export async function verifyGroundingRecord(root, definition, workflow, phase, {
  generation = nextPhaseGeneration(phase),
  // A generation a later one of the same phase replaced. What it was composed from is still
  // verified byte for byte, but a document detached after it, or the stale mark that detach left,
  // does not fail it: that work is history, and the phase was redone without the document.
  superseded = false,
  agent = null,
  resolveRepositoryAuthority = null,
  resolveCurrentAuthority = null,
  admitHistoryCut = null
} = {}) {
  const configuredMode = groundingMode(definition, workflow);
  // An active Story pin is consumed by the composer even when projection grounding is off, so its
  // receipt is still checked and reported. Like every grounding finding, the result only warns.
  // With the registered World Model off, the pin is not consumed and nothing is checked.
  const mode = configuredMode === 'off' && registeredWorldModelOn(definition)
      && workflow.resolution?.worldModelHistoryPin?.status === 'active'
    ? 'warn'
    : configuredMode;
  if (mode === 'off') return { mode, errors: [], warnings: [], passes: [], record: null, path: null };
  const relative = groundingRecordRelative(definition, workflow, phase, generation);
  const absolute = path.join(root, relative);
  if (!(await exists(absolute))) {
    const severity = groundingWarnings([`grounding composition is missing for ${phase.id} generation ${generation}; run singularity-flow wm compose --phase ${phase.id}`]);
    return { mode, ...severity, passes: [], record: null, path: relative };
  }
  let record;
  try { record = readRecord('prompt-injection', await readFile(absolute)).record; }
  catch (error) {
    const severity = groundingWarnings([String(error?.code ?? '').startsWith('SCHEMA_')
      ? `grounding composition record is not a valid receipt for ${phase.id} generation ${generation}: ${error.message}`
      : `grounding composition is invalid JSON for ${phase.id} generation ${generation}: ${error.message}`]);
    return { mode, ...severity, passes: [], record: null, path: relative };
  }
  const problems = [];
  const stalenessProblems = [];
  const availabilityWarnings = [];
  const historyNotes = [];
  const persistedGrounding = record.persistedGrounding != null;
  const suppliedHistoryPin = workflow.resolution?.worldModelHistoryPin ?? null;
  let activeHistoryPlan = null;
  let activeHistoryPinValid = false;
  if (suppliedHistoryPin?.status === 'active') {
    try {
      const { validateStoryWorldModelHistoryPin } = await storyGroundingVerificationRuntime();
      const pin = validateStoryWorldModelHistoryPin(suppliedHistoryPin);
      const selectedAgent = agent ?? record.agent;
      const plans = pin.phasePlans.filter((entry) => (
        entry.phase === phase.id && entry.agent === selectedAgent
      ));
      if (plans.length > 1) {
        throw new SingularityFlowError(
          `Persisted Story grounding has multiple plans for ${phase.id}/${selectedAgent}.`,
          { code: 'WORLD_MODEL_GROUNDING_INTEGRITY_FAILED' }
        );
      }
      activeHistoryPinValid = true;
      activeHistoryPlan = plans[0] ?? null;
      if (activeHistoryPlan && !persistedGrounding) {
        problems.push(
          `active Story World-Model history plan requires a persisted grounding receipt for ${phase.id}/${selectedAgent}`
        );
      }
    } catch (error) {
      problems.push(`active Story World-Model history pin is invalid: ${error.message}`);
    }
  }
  let persistedGroundingVerified = false;
  if (persistedGrounding) {
    try {
      const verified = await verifyPersistedStoryGrounding(
        root, definition, workflow, phase, record, relative, generation, agent, {
          resolveRepositoryAuthority, resolveCurrentAuthority, admitHistoryCut
        }
      );
      // Continue every compatible generic check against the same receipt bytes whose prompt and
      // packet pair were just verified, rather than the earlier untrusted JSON read.
      record = verified.record;
      persistedGroundingVerified = true;
    } catch (error) {
      problems.push(
        `persisted Story grounding verification failed: ${error.message}`
      );
    }
  }
  const groundingAvailability = record.groundingAvailability ?? {
    status: 'legacy-unverified', reasonCode: null
  };
  const groundingStatus = groundingAvailability?.status;
  const groundingUnavailable = groundingStatus === 'unavailable';
  if (activeHistoryPinValid && !activeHistoryPlan
      && (!groundingUnavailable
        || groundingAvailability.reasonCode !== 'WMP_VIEW_SELECTION_UNAVAILABLE')) {
    problems.push(
      `active Story has no persisted grounding plan for ${phase.id}/${agent ?? record.agent}; `
      + 'the generation must retain the explicit no-grounding result'
    );
  }
  const sourceComparison = record.sourceComparison ?? {
    status: 'historical-unproven', reasonCode: null
  };
  const sourceComparisonStatus = sourceComparison?.status;
  const sourceUnavailable = sourceComparisonStatus === 'unavailable';
  if (!GROUNDING_AVAILABILITY_STATUSES.has(groundingStatus)) {
    problems.push(`grounding composition has an invalid availability status: ${relative}`);
  } else if (groundingUnavailable) {
    if (!stableGroundingReasonCode(groundingAvailability.reasonCode)) {
      problems.push(`grounding composition has no stable unavailability reason code: ${relative}`);
    } else {
      // A valid unavailable receipt proves that no World-Model bytes were consumed. Availability
      // is a quality signal, not lifecycle authority—even when `grounding: enforce` asks us to
      // fail closed on hashes, paths, and provenance for context that *was* consumed.
      availabilityWarnings.push(
        `repository world-model grounding was unavailable when this prompt was composed (${groundingAvailability.reasonCode})`
      );
    }
  } else if (groundingAvailability.reasonCode != null) {
    problems.push(`grounding composition has an unexpected availability reason code: ${relative}`);
  }
  if (!SOURCE_COMPARISON_STATUSES.has(sourceComparisonStatus)) {
    problems.push(`grounding composition has an invalid source-comparison status: ${relative}`);
  } else if (['stale', 'unavailable'].includes(sourceComparisonStatus)) {
    if (!stableGroundingReasonCode(sourceComparison.reasonCode)) {
      problems.push(`grounding composition has no stable source-comparison reason code: ${relative}`);
    }
  } else if (sourceComparison.reasonCode != null) {
    problems.push(`grounding composition has an unexpected source-comparison reason code: ${relative}`);
  }
  if (record.workId !== workflow.workItem.id || record.phase !== phase.id || record.generation !== generation) problems.push(`grounding composition identity mismatch: ${relative}`);
  const acceptedAgents = workflow.resolution?.agents ?? definition.agents ?? {};
  if (!record.agent) problems.push(`grounding composition has no agent: ${relative}`);
  else if (!acceptedAgents[record.agent]) problems.push(`grounding composition uses unknown agent '${record.agent}': ${relative}`);
  if (agent && record.agent !== agent) problems.push(`grounding composition agent '${record.agent}' differs from active agent '${agent}'`);
  if (!groundingUnavailable && !persistedGrounding) {
    if (!/^[0-9a-f]{40}$/.test(record.worldModelCommit ?? '')) problems.push(`grounding composition has no committed world-model revision: ${relative}`);
    if (!/^[0-9a-f]{64}$/.test(record.manifestSha256 ?? '')) problems.push(`grounding composition has invalid manifestSha256: ${relative}`);
    if (!/^sha256:[0-9a-f]{64}$/.test(record.modelSourceTreeSha256 ?? '')) {
      problems.push(`grounding composition has invalid modelSourceTreeSha256: ${relative}`);
    }
    if (record.composedSourceTreeSha256 == null) {
      if (!sourceUnavailable) {
        problems.push(`grounding composition has invalid composedSourceTreeSha256: ${relative}`);
      }
    } else if (!/^sha256:[0-9a-f]{64}$/.test(record.composedSourceTreeSha256)) {
      problems.push(`grounding composition has invalid composedSourceTreeSha256: ${relative}`);
    }
    if (sourceUnavailable) {
      if (record.composedSourceTreeSha256 != null) {
        problems.push(`grounding composition marked source comparison unavailable but records a current source hash: ${relative}`);
      }
      stalenessProblems.push(
        `grounding composition source comparison was unavailable (${sourceComparison.reasonCode}): ${relative}`
      );
    } else if (sourceComparisonStatus === 'stale' || record.fresh !== true) {
      stalenessProblems.push(`grounding composition was created from a stale world model: ${relative}`);
    }
    // Composition is allowed to consume verified historical context under warn/ignore. A source
    // change honestly recorded as stale is not a corrupt model or prompt; the independent pinned
    // staleness policy below owns that decision. Still reject a contradictory freshness claim,
    // and verify the manifest, model files and prompt against their immutable bytes as usual.
    const declaredStale = sourceComparisonStatus === 'stale' && record.fresh === false;
    if ((sourceComparisonStatus === 'fresh' && record.fresh !== true)
        || (sourceComparisonStatus === 'stale' && record.fresh !== false)) {
      problems.push(`grounding composition has inconsistent source freshness: ${relative}`);
    }
    if (record.modelSourceTreeSha256 && record.composedSourceTreeSha256
        && record.modelSourceTreeSha256 !== record.composedSourceTreeSha256 && !declaredStale) {
      problems.push(`grounding composition source hash does not match its world model: ${relative}`);
    }
    if (record.stale === true && !superseded) stalenessProblems.push(`grounding composition is stale: ${relative}`);
    if (!Array.isArray(record.files) || !record.files.length) problems.push(`grounding composition contains no world-model files: ${relative}`);
  } else if (!groundingUnavailable && !Array.isArray(record.files)) {
    problems.push(`grounding composition has invalid file evidence: ${relative}`);
  }
  if (!/^[0-9a-f]{64}$/.test(record.renderedSha256 ?? '')) problems.push(`grounding composition has invalid renderedSha256: ${relative}`);
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
  // The receipt decides how grounding is verified. Every registered composition records this exact
  // tier marker. A generation that consumed the retired legacy-v3 World Model cannot be verified
  // any more; it is reported (an error only under enforce), never reinterpreted.
  const recordedV4Selections = (record.requiredSelections ?? []).filter((entry) => (
    entry?.kind === 'view' && entry?.tier === 'registered-v4'
  ));
  const registeredV4 = recordedV4Selections.length > 0;
  const requiredSelections = recordedV4Selections;
  const requiredViews = [...new Set(recordedV4Selections.map((entry) => entry.view))].sort();
  const retiredFormatReceipt = !groundingUnavailable && !persistedGrounding && !registeredV4;
  if (persistedGrounding) {
    // Exact persisted view order and variants are verified against the Story pin above. Their
    // content-addressed View Keys are intentionally not legacy projection IDs or manifest paths.
  } else if (registeredV4) {
    const identities = recordedV4Selections.map((entry) => `${entry.view}@${entry.version ?? 'missing'}`);
    if (recordedV4Selections.some((entry) => (
      typeof entry.view !== 'string' || !entry.view
      || !Number.isSafeInteger(entry.version) || entry.version < 1
    ))) problems.push(`grounding composition contains an invalid registered-v4 selection for ${phase.id}`);
    if (new Set(identities).size !== identities.length) {
      problems.push(`grounding composition repeats a registered-v4 selection for ${phase.id}`);
    }
    for (const view of requiredViews) {
      if (!(record.requiredViews ?? []).includes(view)) {
        problems.push(`grounding composition requiredViews omits recorded registered-v4 view '${view}' for ${phase.id}`);
      }
    }
  } else if (retiredFormatReceipt) {
    problems.push(`${phase.id} generation ${generation} was composed from the retired legacy-v3 World Model and can no longer be verified; recompose the phase on registered-v4`);
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
  const persistedGroundingPaths = new Set(
    (record.persistedGrounding?.files ?? []).map((entry) => safeGroundingPath(entry.path))
      .filter(Boolean)
  );
  if (groundingUnavailable && (record.files ?? []).some((file) => ['required', 'rule'].includes(file.category))) {
    problems.push(`grounding composition marked unavailable but contains repository world-model files: ${relative}`);
  }
  for (const file of record.files ?? []) {
    const recordedPath = currentGroundingPath(definition, workflow, file);
    const persistedGroundingFile = persistedGrounding && recordedPath != null
      && persistedGroundingPaths.has(recordedPath);
    const identity = `${file.category ?? 'unknown'}:${recordedPath ?? file.path}`;
    if (seen.has(identity)) problems.push(`grounding composition repeats ${file.path}`);
    seen.add(identity);
    if (!recordedPath) problems.push(`grounding composition has an unsafe or empty path: ${file.path}`);
    const validFileDigest = persistedGroundingFile
      ? /^sha256:[0-9a-f]{64}$/.test(file.sha256 ?? '')
      : /^[0-9a-f]{64}$/.test(file.sha256 ?? '');
    if (!validFileDigest) problems.push(`grounding composition has invalid hash for ${file.path}`);
    if (!GROUNDING_FILE_CATEGORIES.has(file.category)) problems.push(`grounding composition has invalid category for ${file.path}`);
    if (!Number.isInteger(file.bytes) || file.bytes < 0 || !Number.isInteger(file.injectedBytes) || file.injectedBytes < 0) problems.push(`grounding composition has invalid byte accounting for ${file.path}`);
    // A registered view read into the repository brief records what was read from it instead of a verbatim copy.
    const readIntoBrief = file.category === 'required' && file.renderer?.id === VIEW_BRIEF_RENDERER.id;
    if (file.category === 'required' && (file.truncated || (!readIntoBrief && file.injectedBytes !== file.bytes))) problems.push(`required grounding was truncated for ${file.path}`);
    if (['required', 'rule'].includes(file.category)) {
      if (!persistedGroundingFile
          && (!recordedPath || !withinGroundingRoot(recordedPath, modelRoot))) {
        problems.push(`grounding composition references a file outside the repository world model: ${file.path}`);
      }
      if (file.injectedBytes > file.bytes) problems.push(`grounding composition has invalid byte accounting for ${file.path}`);
    }
    if (!persistedGroundingFile && ['required', 'rule'].includes(file.category)
        && record.worldModelCommit && recordedPath && file.sha256) {
      const content = run('git', ['show', `${record.worldModelCommit}:${recordedPath}`], { cwd: root, allowFailure: true });
      if (content.status !== 0) problems.push(`world-model commit ${record.worldModelCommit.slice(0, 8)} does not contain ${file.path}`);
      else if (createHash('sha256').update(content.stdout).digest('hex') !== file.sha256) problems.push(`world-model commit hash differs for ${file.path}`);
      else if (readIntoBrief && file.renderer.version === VIEW_BRIEF_RENDERER.version) {
        const digest = viewProjectionDigest(projectRegisteredView(content.stdout));
        if (digest.sha256 !== file.projectionSha256 || digest.bytes !== file.projectionBytes) {
          problems.push(`repository brief read of ${file.path} differs from its committed view`);
        }
      }
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
      const sameBytes = catalogEntry && catalogEntry.path === recordedPath && catalogEntry.sha256 === file.sha256 && catalogEntry.size === file.bytes;
      if (superseded && sameBytes && catalogEntry.status === 'detached') {
        historyNotes.push(`${phase.id} generation ${generation} was composed from ${file.evidenceId ?? file.path}, detached since; a later generation replaced it`);
      } else if (!sameBytes || ![undefined, null, 'active', 'pinned'].includes(catalogEntry.status)) {
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
          const projectedResolved = await resolveReference(root, handle, {
            maxBytes: referencePolicy.previewTextBytes,
            totalEnvelopeBytes: referencePolicy.totalEnvelopeBytes,
            authoredMarkdown: true
          });
          // Historical receipts may have recorded the bounded raw preview or the old
          // bound-then-project representation. New receipts use project-then-bound so an oversized
          // managed input envelope cannot survive a truncated closing marker.
          const resolved = [projectedResolved, authoredResolved, rawResolved]
            .find((candidate) => file.previewSha256 === candidate.preview.sha256)
            ?? projectedResolved;
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
  if (!persistedGrounding && record.worldModelCommit && record.manifestSha256) {
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
    const committedRegisteredV4 = committedManifest.format === 'wmb-v4';
    const outputDir = definition.worldModel?.outputDir ?? 'singularity/world-model';
    if (committedRegisteredV4 && committedManifest.sourceManifestSha256 !== record.modelSourceTreeSha256) {
      problems.push('world-model source hash differs from the composition record');
    }
    if (committedRegisteredV4) {
      if (!registeredV4) problems.push('registered WMB v4 manifest was composed with a legacy grounding receipt');
      for (const selection of requiredSelections) {
        const entry = (committedManifest.views ?? []).find((candidate) => (
          candidate.viewId === selection.view && candidate.status === 'available'
        ));
        const expected = entry?.path ? posix(path.join(outputDir, entry.path)) : null;
        if (!expected || !(record.files ?? []).some((file) => file.path === expected)) {
          problems.push(`grounding composition has no committed content for required selection '${selectionId(selection)}'`);
        }
      }
    }
  }
  const severity = groundingWarnings(problems);
  const staleness = worldModelStalenessDecision(
    workflow.resolution?.worldModelStaleness ?? definition.worldModel?.staleness ?? 'warn',
    stalenessProblems.length === 0,
    stalenessProblems.join('; ')
  );
  const errors = severity.errors;
  const warnings = [
    ...availabilityWarnings,
    ...historyNotes,
    ...severity.warnings,
    ...(staleness.warns ? stalenessProblems : [])
  ];
  const passes = errors.length || warnings.length
    ? []
    : [
        `grounding composition: ${phase.id} generation ${generation} (${(record.files ?? []).length} files)`,
        ...(persistedGroundingVerified
          ? [`persisted Story grounding authority: ${record.persistedGrounding.groundingSha256}`]
          : [])
      ];
  return {
    mode, errors, warnings, staleness,
    passes,
    record, path: relative
  };
}
