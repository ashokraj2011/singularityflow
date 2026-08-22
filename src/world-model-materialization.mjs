import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  normalizeWorldModelManifest,
  resolveWorldModelSource,
  validateWorldModelDirectory,
  worldModelFreshness,
  worldModelSelectionEntry,
  worldModelSourceSnapshot
} from './grounding.mjs';
import { selectionId } from './world-model-selection.mjs';
import { worldModelStalenessDecision } from './world-model-policy.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { SingularityFlowError, snapshot, writeJson } from './util.mjs';

export const MATERIALIZATION_MODES = Object.freeze(['on-demand', 'explicit', 'disabled']);
export const MATERIALIZATION_DEPTHS = Object.freeze(['light', 'phase']);
export const MATERIALIZATION_CONFIRMATIONS = Object.freeze(['prompt', 'automatic']);

export function materializationPolicy(definition = {}) {
  const configured = definition.worldModel?.materialization ?? {};
  const mode = configured.mode ?? 'explicit';
  const publish = configured.publish ?? 'governed';
  const lookahead = configured.lookahead ?? 'none';
  const depth = configured.depth ?? 'phase';
  const confirmation = configured.confirmation ?? 'prompt';
  if (!MATERIALIZATION_MODES.includes(mode)) throw new SingularityFlowError(`worldModel.materialization.mode must be ${MATERIALIZATION_MODES.join(', ')}.`);
  if (!['governed', 'local'].includes(publish)) throw new SingularityFlowError("worldModel.materialization.publish must be 'governed' or 'local'.");
  if (!['none', 'next-phase'].includes(lookahead)) throw new SingularityFlowError("worldModel.materialization.lookahead must be 'none' or 'next-phase'.");
  if (!MATERIALIZATION_DEPTHS.includes(depth)) throw new SingularityFlowError(`worldModel.materialization.depth must be ${MATERIALIZATION_DEPTHS.join(' or ')}.`);
  if (!MATERIALIZATION_CONFIRMATIONS.includes(confirmation)) throw new SingularityFlowError(`worldModel.materialization.confirmation must be ${MATERIALIZATION_CONFIRMATIONS.join(' or ')}.`);
  // A phase-depth ensure may invoke the configured model provider. Automatic materialization is
  // intentionally limited to the deterministic light builder, which uses zero model tokens.
  if (confirmation === 'automatic' && depth !== 'light') {
    throw new SingularityFlowError("worldModel.materialization.confirmation 'automatic' requires depth 'light'; model-driven phase materialization must be confirmed.");
  }
  return { mode, publish, lookahead, depth, confirmation };
}

/** Resolve an immutable work-item snapshot before falling back to the live repository policy. */
export function effectiveMaterializationPolicy(config = {}, workflow = null) {
  const pinned = workflow?.resolution?.worldModelMaterialization;
  return pinned
    ? materializationPolicy({ worldModel: { materialization: pinned } })
    : materializationPolicy(config.definition ?? config);
}

/**
 * Whether a model came from the deterministic light builder rather than a model-driven synthesis.
 *
 * `2.1-light` is what `buildLight` stamps; `2.0` is what synthesis stamps. The suffix is the test
 * rather than an exact match so a later light revision does not silently start reading as full.
 */
export function isMinimalModel(manifest) {
  return /-light$/.test(String(manifest?.builder_version ?? ''));
}

export function groundingEnsureCommand(plan) {
  if (plan.phase) {
    const task = plan.taskGuide?.required ? ` --task ${JSON.stringify(plan.taskGuide.task)}` : '';
    return `singularity-flow wm ensure --phase ${plan.phase}${task}`;
  }
  const selection = plan.selections.find((item) => item.kind === 'view');
  return selection
    ? `singularity-flow wm ensure --view ${selection.view} --tier ${selection.tier}`
    : `singularity-flow wm ensure --depth ${plan.depth ?? 'standard'}`;
}

function normalizedTask(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function candidateTaskGuide(plan, manifest) {
  if (!plan.taskGuide?.required) return { required: false, task: null, status: 'not-requested', id: null, path: null };
  const entry = (manifest?.task_guides ?? []).find((guide) => normalizedTask(guide.task) === normalizedTask(plan.taskGuide.task));
  return {
    required: true,
    task: plan.taskGuide.task,
    status: entry?.path ? 'ready' : 'missing',
    id: entry?.id ?? null,
    path: entry?.path ?? null
  };
}

async function inspectCandidate(root, config, plan, candidate, sourceState) {
  if (!existsSync(path.join(candidate.directory, 'manifest.json'))) {
    return { ...candidate, ready: false, fresh: false, error: 'manifest.json is absent', selections: [], taskGuide: candidateTaskGuide(plan, null) };
  }
  let normalized = null;
  try {
    const raw = JSON.parse(await readFile(path.join(candidate.directory, 'manifest.json'), 'utf8'));
    normalized = normalizeWorldModelManifest(raw);
    // Validate the manifest-controlled snapshot independently of this phase's selections. A model
    // may be incomplete for the requested phase and still be a safe progressive-generation base;
    // undeclared, missing, or tampered files must never be carried into the next generation.
    await validateWorldModelDirectory(candidate.directory, {
      integrity: 'full',
      sourceLabel: candidate.source
    });
    const allowLegacyFallback = normalized.source_schema_version !== '3.0';
    const selections = plan.selections.map((selection) => {
      const entry = worldModelSelectionEntry(normalized, selection, { allowLegacyFallback });
      return { ...selection, id: selectionId(selection), status: entry?.status ?? 'missing', path: entry?.path ?? null };
    });
    const missing = selections.filter((entry) => entry.status !== 'ready' || !entry.path);
    const taskGuide = candidateTaskGuide(plan, normalized);
    const freshness = await worldModelFreshness(root, config.definition ?? config, normalized);
    if (!missing.length && taskGuide.status !== 'missing') {
      const validated = await validateWorldModelDirectory(candidate.directory, {
        requiredSelections: plan.selections,
        requireEvidence: plan.includeEvidence,
        expectedTask: plan.taskGuide?.required ? plan.taskGuide.task : null,
        integrity: 'selected',
        sourceLabel: candidate.source,
        allowLegacyFallback
      });
      return { ...candidate, complete: true, ready: freshness.fresh, fresh: freshness.fresh, integrityValid: true, selections, taskGuide, manifest: validated.normalizedManifest, sourceTreeSha256: freshness.built, error: freshness.fresh ? null : `source snapshot differs (${freshness.built} != ${sourceState.sha256})` };
    }
    const absent = [
      ...missing.map((entry) => entry.id),
      ...(taskGuide.status === 'missing' ? [`task guide for ${JSON.stringify(taskGuide.task)}`] : [])
    ];
    return { ...candidate, complete: false, ready: false, fresh: freshness.fresh, integrityValid: true, selections, taskGuide, manifest: normalized, sourceTreeSha256: freshness.built, error: `missing ${absent.join(', ')}` };
  } catch (error) {
    return { ...candidate, ready: false, fresh: false, integrityValid: false, selections: [], taskGuide: candidateTaskGuide(plan, normalized), manifest: normalized, sourceTreeSha256: normalized?.source_tree_sha256 ?? null, error: error.message };
  }
}

/** Fast, read-only availability. It never invokes a model, writes a file, or publishes. */
export async function inspectGroundingAvailability(root, config, plan, { refreshRemote = true } = {}) {
  const sourceState = await worldModelSourceSnapshot(root, config.definition ?? config);
  const governed = await resolveWorldModelSource(root, config, { refreshRemote });
  const policy = config.materialization ?? materializationPolicy(config.definition ?? config);
  const stalenessPolicy = config.staleness ?? config.definition?.worldModel?.staleness ?? 'warn';
  const worktree = { directory: path.join(root, config.outputDir), source: 'worktree', branch: null };
  const candidates = [];
  if (governed.source === 'state-branch') candidates.push(await inspectCandidate(root, config, plan, governed, sourceState));
  if (!candidates.some((item) => path.resolve(item.directory) === path.resolve(worktree.directory))) {
    candidates.push(await inspectCandidate(root, config, plan, worktree, sourceState));
  }
  const usable = (item) => item?.complete === true
    && !worldModelStalenessDecision(stalenessPolicy, item.fresh).blocks;
  const governedReady = candidates.find((item) => item.source === 'state-branch' && usable(item)) ?? null;
  const worktreeReady = candidates.find((item) => item.source === 'worktree' && usable(item)) ?? null;
  const legacyWorktreeReady = worktreeReady?.manifest?.source_schema_version !== '3.0'
    ? worktreeReady
    : null;
  // A locally complete model is not a governed model. When publication is required, exposing it as
  // selected would let a read path bypass the state-branch transaction and produce an unshareable
  // prompt. Keep a new v3 model visible as a conflict and point the caller at the explicit ensure
  // command. Legacy v1/v2 repositories remain readable during the compatibility window: they
  // predate governed materialization and therefore cannot carry its publication receipt.
  const selected = governedReady ?? (policy.publish === 'local' ? worktreeReady : legacyWorktreeReady);
  // A governed model that is incomplete for this phase is still the correct base for progressive
  // generation when it describes the exact same source tree. Without carrying this forward a fresh
  // clone generates the missing view against an empty worktree, then replaces the state-branch
  // snapshot and silently drops views generated by earlier contributors.
  const sameSource = (candidate) => candidate?.integrityValid
    && candidate?.manifest?.source_schema_version === '3.0'
    && candidate.sourceTreeSha256 === sourceState.sha256;
  const extensionCandidate = !governed.diverged && (candidates.find((item) => item.source === 'state-branch' && sameSource(item))
    ?? candidates.find((item) => item.source === 'worktree' && sameSource(item))
    ?? null);
  const extensionBase = extensionCandidate ? {
    directory: extensionCandidate.directory,
    source: extensionCandidate.source,
    branch: extensionCandidate.branch ?? null,
    ref: extensionCandidate.ref ?? null,
    commit: extensionCandidate.commit ?? null,
    treeSha: extensionCandidate.treeSha ?? null,
    sourceTreeSha256: extensionCandidate.sourceTreeSha256
  } : null;
  const conflicts = governed.diverged
    ? [{
        code: 'world_model.state_diverged',
        source: 'state-branch',
        message: `Local and remote state branch '${governed.branch}' have diverged; synchronize the state branch before materializing more grounding.`
      }]
    : policy.publish === 'governed' && worktreeReady && !legacyWorktreeReady && !governedReady
      ? [{
        code: 'world_model.local_only',
        source: 'worktree',
        message: 'The required model exists only in the worktree and has not been published to the governed state branch.'
      }]
      : [];
  const statuses = plan.selections.map((selection) => {
    const id = selectionId(selection);
    const available = selected?.selections.find((item) => item.id === id)
      ?? candidates.map((candidate) => candidate.selections.find((item) => item.id === id)).find(Boolean);
    const stale = (selected && !selected.fresh && available?.status === 'ready')
      || (!selected && candidates.some((candidate) => candidate.selections.some((item) => item.id === id && item.status === 'ready') && !candidate.fresh));
    return {
      ...selection,
      id,
      status: stale ? 'stale' : selected && available?.status === 'ready' ? 'ready' : available?.status ?? 'missing',
      path: available?.path ?? null
    };
  });
  const missing = statuses.filter((entry) => !['ready', 'stale'].includes(entry.status));
  const readySelections = statuses.filter((entry) => ['ready', 'stale'].includes(entry.status));
  const stale = statuses.filter((entry) => entry.status === 'stale');
  const taskGuide = plan.taskGuide?.required
    ? candidates.filter((candidate) => candidate.integrityValid).map((candidate) => candidate.taskGuide).find((entry) => entry?.status === 'ready')
      ?? { required: true, task: plan.taskGuide.task, status: 'missing', id: null, path: null }
    : { required: false, task: null, status: 'not-requested', id: null, path: null };
  const staleness = worldModelStalenessDecision(
    stalenessPolicy,
    selected ? selected.fresh : stale.length === 0,
    'The repository world model is stale for the current source tree.'
  );
  const ready = Boolean(selected) && missing.length === 0 && conflicts.length === 0 && !staleness.blocks;
  return {
    schemaVersion: 1,
    status: ready ? (stale.length ? 'stale' : 'ready') : conflicts.length ? 'conflict' : stale.length ? 'stale' : 'missing',
    source: selected?.source ?? null,
    sourceAuthority: selected?.authority ?? governed.authority ?? null,
    sourceRefresh: selected?.refresh ?? governed.refresh ?? null,
    sourceDiverged: selected?.diverged ?? governed.diverged ?? false,
    stateBranch: governed.branch ?? null,
    resolvedRef: selected?.ref ?? governed.ref ?? null,
    commit: selected?.commit ?? governed.commit ?? null,
    treeSha: selected?.treeSha ?? governed.treeSha ?? null,
    refreshStatus: selected?.refresh ?? governed.refresh ?? null,
    authority: selected?.authority ?? governed.authority ?? null,
    ready,
    sourceTreeSha256: sourceState.sha256,
    selected,
    extensionBase,
    candidates,
    selections: statuses,
    readySelections,
    missingSelections: missing,
    missing,
    stale,
    taskGuide,
    staleness,
    conflicts,
    generationRequired: !ready,
    action: !ready ? {
      command: groundingEnsureCommand(plan),
      reason: conflicts.length
        ? conflicts[0].message
        : missing.length
          ? `missing ${missing.map((entry) => entry.id).join(', ')}`
          : taskGuide.status === 'missing'
            ? `missing explicit task guide for ${JSON.stringify(taskGuide.task)}`
          : staleness.blocks
            ? staleness.message
          : 'no fresh published model satisfies the plan'
    } : null
  };
}

/**
 * The only boundary allowed to turn an expected missing selection into generation.
 * `authorized` is deliberately explicit: read-only consumers and noninteractive hosts cannot make
 * an implicit provider call merely because policy says on-demand.
 */
export async function ensureGrounding(root, config, plan, {
  authorized = false,
  materialize = null,
  materializeMinimal = null,
  // The availability probe, injectable so the fall-forward can be driven without a model provider
  // and a fully built world model. Production callers never pass it.
  inspect = inspectGroundingAvailability,
  upgradeMinimal = true
} = {}) {
  let availability = await inspect(root, config, plan);

  /**
   * A fallback model is good enough to compose against, and not good enough to stop trying.
   *
   * Composition must never block on grounding quality — that is the whole point of falling forward.
   * But `ready` alone made the fall-forward a one-way door: once a light model was published it
   * satisfied every later probe, so an authorized `wm ensure` short-circuited to `reuse` and the
   * full build was never attempted again. One transient provider failure would have downgraded a
   * repository's grounding permanently, while the failure message promised a retry that could not
   * happen.
   *
   * So a caller that *can* build (authorized, with a materializer) treats a minimal model as work
   * still to do. Every read-only caller keeps reusing it and keeps working.
   */
  const canBuild = authorized && typeof materialize === 'function';
  const minimalOnly = availability.ready && isMinimalModel(availability.selected?.manifest);
  if (availability.ready && !(canBuild && minimalOnly && upgradeMinimal)) {
    return { mode: 'reuse', availability, located: availability.selected, degraded: minimalOnly ? { reason: 'the available world model is a light fallback' } : null };
  }
  const policy = config.materialization ?? materializationPolicy(config.definition ?? config);
  if (policy.mode === 'disabled') {
    throw new SingularityFlowError(`Repository grounding is unavailable and materialization is disabled. ${availability.action?.reason ?? `Missing: ${availability.missing.map((entry) => entry.id).join(', ')}`}.`);
  }
  if (!authorized || typeof materialize !== 'function') {
    throw new SingularityFlowError(`Repository grounding is not ready. Run: ${availability.action.command}`, {
      code: 'world_model.materialization_required',
      data: { availability, command: availability.action.command }
    });
  }
  return withSubjectLock(root, {
    kind: 'repository-world-model',
    // The exact source snapshot is the materialization task identity. Different phase callers that
    // need the same source serialize here and re-check under the lock instead of spending twice.
    id: availability.sourceTreeSha256
  }, async () => {
    availability = await inspect(root, config, plan);
    // Same rule under the lock: another process finishing a *full* build is a reason to stop, one
    // finishing a light fallback is not.
    if (availability.ready && !isMinimalModel(availability.selected?.manifest)) {
      return { mode: 'reuse-after-lock', availability, located: availability.selected, degraded: null };
    }

    /**
     * A world-model build that fails must not stop the work.
     *
     * The full build is a long model-driven job with several ways to fail that say nothing about
     * the repository: a provider timeout, a worker that misfiles its packet, a synthesis that
     * writes an invalid manifest. On a real run one stray file cost six minutes and left a phase
     * unable to compose its prompt at all. Grounding is a quality signal, and the deterministic
     * light model — the fallback `wm.build` has always declared and nothing has ever executed — is
     * a real, structurally complete model built with no tokens in about a second.
     *
     * So: fall forward on the first failure, and say so everywhere. `degraded` travels with the
     * result, the light manifest already stamps `builder_version: 2.1-light`, and the reason is
     * kept verbatim. Never blocking is only defensible if nobody can mistake this for a full model.
     */
    let degraded = null;
    try {
      await materialize({ availability, policy });
    } catch (error) {
      // Generation and validation have already succeeded once this marker is present. Re-running a
      // different builder would overwrite a valid governed selection and hide the transport fault.
      if (error?.code === 'world_model.publication_recovery_required') throw error;
      if (typeof materializeMinimal !== 'function') throw error;
      degraded = { reason: error.message, code: error.code ?? null };
      console.warn(
        `Warning: the full world-model build failed (${error.message}). `
        + 'Falling back to the deterministic light model so work can continue; semantic analysis was not performed.'
      );
      await materializeMinimal({ availability, policy, error });
    }

    availability = await inspect(root, config, plan);
    if (!availability.ready) throw new SingularityFlowError(`World-model materialization completed without satisfying the grounding plan. Run ${availability.action?.command ?? 'singularity-flow wm availability --json'} for details.`);
    if (policy.publish === 'governed' && availability.selected?.source !== 'state-branch') {
      throw new SingularityFlowError('World-model materialization was not published to the governed state branch; prompt composition is blocked.');
    }
    return {
      mode: degraded ? 'materialized-degraded' : 'materialized',
      availability,
      located: availability.selected,
      degraded
    };
  });
}

/**
 * Explicit mutation-facing name for hosts that have already obtained user authorization.
 * Read-only consumers must call `inspectGroundingAvailability` instead.
 */
export async function materializeSelections(root, config, plan, materialize, materializeMinimal = null, options = {}) {
  return ensureGrounding(root, config, plan, {
    authorized: true, materialize, materializeMinimal, ...options
  });
}

async function tierRecord(directory, entry) {
  if (!entry?.path || entry.status !== 'ready') return { ...entry, status: 'missing', path: entry?.path ?? null, bytes: 0, sha256: null };
  const info = await snapshot(path.join(directory, entry.path));
  return info.exists && info.sha256
    ? { ...entry, status: 'ready', path: entry.path, bytes: info.size, sha256: info.sha256 }
    : { ...entry, status: 'missing', path: entry.path, bytes: 0, sha256: null };
}

function truncateUtf8(value, maxBytes) {
  let output = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}

async function deriveBrief(directory, fullEntry, relative, label) {
  if (!fullEntry?.path || fullEntry.status !== 'ready') return { status: 'missing', path: relative, bytes: 0, sha256: null };
  const source = await readFile(path.join(directory, fullEntry.path), 'utf8');
  const prefix = `# ${label} — deterministic brief\n\n> CLI-derived from \`${fullEntry.path}\`; no additional model invocation.\n\n`;
  const body = truncateUtf8(source, Math.max(0, 8_000 - Buffer.byteLength(prefix, 'utf8')));
  await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
  await writeFile(path.join(directory, relative), `${prefix}${body}`);
  return { status: 'ready', path: relative };
}

export async function writeV3Manifest(directory, rawManifest, { materialization = null } = {}) {
  const normalized = normalizeWorldModelManifest(rawManifest);
  const requested = new Set((materialization?.selections ?? []).map((entry) => typeof entry === 'string' ? entry : selectionId(entry)));
  if (normalized.core?.tiers?.brief?.status !== 'ready') {
    normalized.core.tiers.brief = await deriveBrief(directory, normalized.core?.tiers?.full, 'core/summary.brief.md', 'Repository core');
  }
  for (const [view, entry] of Object.entries(normalized.views ?? {})) {
    if (requested.has(`${view}/brief`) && entry.tiers?.brief?.status !== 'ready') {
      entry.tiers.brief = await deriveBrief(directory, entry.tiers?.full, `views/${view}.brief.md`, view);
    }
  }
  const pathIndex = normalized.path_index?.path
    ? normalized.path_index
    : { path: 'path-index.json' };
  if (!existsSync(path.join(directory, pathIndex.path))) {
    await writeJson(path.join(directory, pathIndex.path), {
      schemaVersion: currentSchemaVersion('worldmodel-path-index'),
      generatedBy: 'singularity-flow',
      note: 'CLI-owned fallback index; generated artifacts remain authoritative in manifest.json.',
      entries: []
    });
  }
  const core = { ...normalized.core, tiers: {} };
  for (const tier of ['brief', 'full']) core.tiers[tier] = await tierRecord(directory, normalized.core?.tiers?.[tier]);
  core.brief = core.tiers.brief?.path ?? null;
  core.summary = core.tiers.full?.path ?? null;
  const views = {};
  for (const [view, entry] of Object.entries(normalized.views ?? {})) {
    views[view] = { ...entry, tiers: {} };
    for (const tier of ['brief', 'full']) views[view].tiers[tier] = await tierRecord(directory, entry.tiers?.[tier]);
    // Keep aliases for one compatibility release while all readers move to exact tier entries.
    views[view].brief_path = views[view].tiers.brief?.path ?? null;
    views[view].path = views[view].tiers.full?.path ?? null;
    views[view].generated = Object.values(views[view].tiers).some((tier) => tier?.status === 'ready');
  }
  const materializationRecord = materialization ? {
    id: materialization.id ?? `${normalized.source_tree_sha256 ?? rawManifest.source_tree_sha256}:${(materialization.selections ?? []).map((entry) => typeof entry === 'string' ? entry : selectionId(entry)).sort().join(',')}`,
    generated_at: materialization.generated_at ?? materialization.generatedAt ?? new Date().toISOString(),
    source_tree_sha256: materialization.source_tree_sha256 ?? materialization.sourceTreeSha256 ?? normalized.source_tree_sha256 ?? rawManifest.source_tree_sha256,
    provider: materialization.provider ?? null,
    requested: (materialization.requested ?? materialization.selections ?? []).map((entry) => typeof entry === 'string' ? entry : selectionId(entry)).sort(),
    produced: (materialization.produced ?? materialization.selections ?? []).map((entry) => typeof entry === 'string' ? entry : selectionId(entry)).sort(),
    reused: (materialization.reused ?? []).map((entry) => typeof entry === 'string' ? entry : selectionId(entry)).sort()
  } : null;
  const manifest = {
    ...rawManifest,
    schema_version: '3.0',
    core,
    views,
    path_index: pathIndex,
    materializations: [...(normalized.materializations ?? []), ...(materializationRecord ? [materializationRecord] : [])]
  };
  delete manifest.source_schema_version;
  await writeJson(path.join(directory, 'manifest.json'), manifest);
  return manifest;
}

async function readySelectionIsValid(directory, entry) {
  if (!entry?.path || entry.status !== 'ready') return false;
  const actual = await snapshot(path.join(directory, entry.path));
  if (!actual.exists || !actual.sha256) return false;
  return (!entry.sha256 || entry.sha256 === actual.sha256)
    && (entry.bytes == null || entry.bytes === actual.size);
}

async function mergeReferencedArtifacts({ fragmentDirectory, targetDirectory, existingEntries = [], fragmentEntries = [] }) {
  const merged = new Map(existingEntries.map((entry) => [entry.id, structuredClone(entry)]));
  for (const entry of fragmentEntries) {
    if (!entry?.id || !entry?.path) continue;
    const prior = merged.get(entry.id);
    await mkdir(path.dirname(path.join(targetDirectory, entry.path)), { recursive: true });
    await cp(path.join(fragmentDirectory, entry.path), path.join(targetDirectory, entry.path), { force: true });
    merged.set(entry.id, structuredClone(entry));
    if (prior?.path && prior.path !== entry.path) {
      await rm(path.join(targetDirectory, prior.path), { force: true });
    }
  }
  return [...merged.values()];
}

/** Merge a same-source fragment without rewriting unrelated ready artifacts. */
export async function mergeWorldModelSnapshot({ existingDirectory = null, fragmentDirectory, targetDirectory, plan, sourceTreeSha256, materialization }) {
  await rm(targetDirectory, { recursive: true, force: true });
  await mkdir(targetDirectory, { recursive: true });
  let existing = null;
  if (existingDirectory && existsSync(path.join(existingDirectory, 'manifest.json'))) {
    const raw = JSON.parse(await readFile(path.join(existingDirectory, 'manifest.json'), 'utf8'));
    if (raw.source_tree_sha256 === sourceTreeSha256) {
      existing = normalizeWorldModelManifest(raw);
      await cp(existingDirectory, targetDirectory, { recursive: true, force: false });
    }
  }
  const fragmentRaw = JSON.parse(await readFile(path.join(fragmentDirectory, 'manifest.json'), 'utf8'));
  const fragment = normalizeWorldModelManifest(fragmentRaw);
  if (!existing) {
    await rm(targetDirectory, { recursive: true, force: true });
    await cp(fragmentDirectory, targetDirectory, { recursive: true, force: false });
    const selected = new Set(plan.selections.map(selectionId));
    const filtered = structuredClone(fragmentRaw);
    const normalizedFiltered = normalizeWorldModelManifest(filtered);
    // Core is the shared bootstrap contract. A new model always retains both deterministic core
    // tiers even when the immediate consumer asks for only one. View tiers remain progressive,
    // but deleting core/full here made ordinary builder output invalid for the next deep phase and
    // needlessly forced another provider call.
    for (const [view, viewEntry] of Object.entries(normalizedFiltered.views ?? {})) {
      for (const tier of ['brief', 'full']) {
        const entry = viewEntry.tiers?.[tier];
        if (!selected.has(`${view}/${tier}`) && entry?.path) {
          await rm(path.join(targetDirectory, entry.path), { force: true });
          viewEntry.tiers[tier] = { status: 'missing', path: entry.path };
        }
      }
    }
    normalizedFiltered.materializations = [...(fragment.materializations ?? [])];
    return writeV3Manifest(targetDirectory, normalizedFiltered, { materialization });
  }
  const merged = structuredClone(existing);
  Object.assign(merged, fragmentRaw, { schema_version: '3.0', source_tree_sha256: sourceTreeSha256 });
  merged.core = existing.core;
  merged.views = structuredClone(existing.views ?? {});
  const reused = [];
  for (const selection of plan.selections) {
    const prior = worldModelSelectionEntry(existing, selection);
    if (await readySelectionIsValid(existingDirectory, prior)) {
      reused.push(selectionId(selection));
      continue;
    }
    const from = worldModelSelectionEntry(fragment, selection);
    if (from.status !== 'ready' || !from.path) continue;
    await mkdir(path.dirname(path.join(targetDirectory, from.path)), { recursive: true });
    await cp(path.join(fragmentDirectory, from.path), path.join(targetDirectory, from.path), { force: true });
    if (selection.kind === 'core') merged.core.tiers[selection.tier] = from;
    else {
      merged.views[selection.view] ??= { tiers: { brief: { status: 'missing' }, full: { status: 'missing' } } };
      merged.views[selection.view].tiers[selection.tier] = from;
    }
  }
  for (const relative of [fragment.path_index?.path, fragment.evidence?.path].filter(Boolean)) {
    await mkdir(path.dirname(path.join(targetDirectory, relative)), { recursive: true });
    await cp(path.join(fragmentDirectory, relative), path.join(targetDirectory, relative), { force: true });
  }
  // The deterministic light builder and provider-backed builder may use different names for these
  // CLI-owned indexes. Replacing the manifest pointer without deleting the superseded file leaves
  // valid bytes that are no longer declared, causing full integrity validation to reject the union.
  // Only these explicit singleton records are replaced; unrelated retained view/domain evidence is
  // never swept from a progressive snapshot.
  for (const [prior, replacement] of [
    [existing.path_index?.path, fragment.path_index?.path],
    [existing.evidence?.path, fragment.evidence?.path]
  ]) {
    if (prior && replacement && prior !== replacement) {
      await rm(path.join(targetDirectory, prior), { force: true });
    }
  }
  merged.path_index = fragment.path_index ?? existing.path_index;
  merged.evidence = fragment.evidence ?? existing.evidence;
  // Domains and task guides are first-class manifest-controlled artifacts, not metadata-only
  // records. Copy every fragment-owned file before publishing the union. Merely merging the arrays
  // leaves the manifest pointing at files that exist only in the provider's temporary directory.
  merged.domains = await mergeReferencedArtifacts({
    fragmentDirectory,
    targetDirectory,
    existingEntries: existing.domains,
    fragmentEntries: fragment.domains
  });
  merged.task_guides = await mergeReferencedArtifacts({
    fragmentDirectory,
    targetDirectory,
    existingEntries: existing.task_guides,
    fragmentEntries: fragment.task_guides
  });
  merged.materializations = [
    ...(existing.materializations ?? []),
    ...(fragment.materializations ?? [])
  ];
  if (!materialization && reused.length && merged.materializations.length) {
    const last = merged.materializations.at(-1);
    last.reused = [...new Set([...(last.reused ?? []), ...reused])].sort();
  }
  return writeV3Manifest(targetDirectory, merged, {
    materialization: materialization ? { ...materialization, reused: [...new Set([...(materialization.reused ?? []), ...reused])] } : null
  });
}
