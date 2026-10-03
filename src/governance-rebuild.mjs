/**
 * Rebuild SFlow governance: the one operation a repository owner runs to move onto the current
 * governance model [E2G §11, D10].
 *
 * The preview changes nothing. It exports the approved configuration into a scratch directory,
 * replaces every framework-owned item with the current package while keeping each repository-owned
 * item byte-identical (the safe-reinitialization merge), recompiles every workflow under the
 * current obligation rules, and lists every Story the rebuild will archive. Its plan digest binds
 * all of that, so the confirmation can prove nothing moved between preview and activation.
 *
 * D10: every framework workflow must compile. A repository workflow that does not is never edited
 * or deleted; it stays byte-identical and unstartable, and activation proceeds only when the
 * confirmation names it (`--accept-inactive`), never under `--strict`.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

import { assertWorkTypeStartable, loadDefinition, resolveWorkType } from './config.mjs';
import {
  changedPaths, checkedOutBranch, committedFileDigests, exportCommitPaths, localBranches, refCommit, remoteBranches, topLevelEntries
} from './git.mjs';
import { buildRepositorySubjectIndex, buildRepositorySubjectIndexFromRefs } from './repository-subject-index.mjs';
import { isStoryDiscoveryBranch } from './session-remote-url-discovery.mjs';
import { SingularityFlowError } from './util.mjs';
import { VERSION } from './version.mjs';
import { refreshPackagedConfiguration } from './workspace-configuration-refresh.mjs';

export const GOVERNANCE_REBUILD_PLAN_VERSION = 'governance-rebuild-plan/v1';
const PLAN_PREFIX = 'grb-';
const CONFIGURATION_PATHS = Object.freeze(['singularity', '.github']);
const BASELINE_PATH = 'singularity/.product/configuration-baseline.yml';
const AUTHORITY_BRANCH = 'sflow/config';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Canonical JSON: sorted keys, so a digest describes content rather than key order. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Where the approved configuration lives: the configuration authority branch when this repository
 * has one, otherwise the committed checkout. Uncommitted governance edits are refused rather than
 * silently rebuilt over.
 */
export function governanceConfigurationSource(root, { remote = 'origin' } = {}) {
  const authorityRef = `refs/remotes/${remote}/${AUTHORITY_BRANCH}`;
  const authority = refCommit(root, authorityRef);
  if (authority) return { mode: 'authority', ref: authorityRef, commit: authority, dirty: [] };
  return { mode: 'working-tree', ref: 'HEAD', commit: refCommit(root, 'HEAD'), dirty: changedPaths(root, CONFIGURATION_PATHS) };
}

/** Export the configuration paths of one commit into a fresh directory, never touching the checkout. */
async function exportConfiguration(root, commit) {
  const entries = topLevelEntries(root, commit);
  const present = CONFIGURATION_PATHS.filter((entry) => entries.has(entry));
  if (!present.includes('singularity')) {
    throw new SingularityFlowError(`Commit ${commit.slice(0, 12)} has no singularity/ configuration to rebuild.`, {
      code: 'GOVERNANCE_REBUILD_NOT_GOVERNED'
    });
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-governance-rebuild-'));
  try {
    await exportCommitPaths(root, commit, present, directory);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, present };
}

async function fileDigest(file) {
  try {
    return sha256(await readFile(file));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** Which workflows the repository owns, as the upgraded ownership baseline records it. */
async function workflowOwnership(directory) {
  try {
    const baseline = YAML.parse(await readFile(path.join(directory, BASELINE_PATH), 'utf8')) ?? {};
    return baseline.ownership?.workflow?.workTypes ?? {};
  } catch {
    return {};
  }
}

/**
 * Recompile every workflow of the rebuilt configuration under the current rules. Never throws for
 * one failing workflow: each carries its findings and the action that resolves them.
 */
async function compileDefinitions(directory) {
  let definition;
  try {
    definition = await loadDefinition(directory);
  } catch (error) {
    return {
      definition: null,
      loadError: { code: error.code ?? 'GOVERNANCE_REBUILD_DEFINITION_INVALID', message: error.message },
      workflows: []
    };
  }
  const ownership = await workflowOwnership(directory);
  const workflows = Object.keys(definition.workTypes ?? {}).sort().map((id) => {
    const owner = ownership[id] === 'repository' ? 'repository' : 'framework';
    try {
      assertWorkTypeStartable(resolveWorkType(definition, id));
      return { id, owner, status: 'ready', findings: [] };
    } catch (error) {
      const findings = error.details?.findings?.length
        ? error.details.findings.map(({ code, message, resolvingAction }) => ({ code, message, resolvingAction: resolvingAction ?? null }))
        : [{ code: error.code ?? 'WORKFLOW_INVALID', message: error.message, resolvingAction: null }];
      return { id, owner, status: 'failing', findings };
    }
  });
  return { definition, loadError: null, workflows };
}

/**
 * Every Story this repository knows, on its checkout, local branches and remote-tracking branches,
 * with the branch tips the rebuild binds. Remote branches are read as they were last fetched.
 */
export async function governanceStoryInventory(root, definition, { remote = 'origin' } = {}) {
  // The checked-out branch is not among the other local branches; it is read from its tip as well.
  const current = checkedOutBranch(root);
  const head = refCommit(root, 'HEAD');
  const locals = [...new Set([...localBranches(root), ...(current ? [current] : [])])];
  const refs = [
    ...remoteBranches(root, remote).filter(isStoryDiscoveryBranch).map((branch) => ({ branch, ref: `${remote}/${branch}` })),
    ...locals.filter(isStoryDiscoveryBranch).map((branch) => ({ branch, ref: branch }))
  ];
  const indexes = [
    await buildRepositorySubjectIndex(root, { definition }),
    await buildRepositorySubjectIndexFromRefs(root, { definition, refs, fresh: true })
  ];
  const stories = new Map();
  const unreadable = [];
  for (const index of indexes) {
    for (const entry of index.unreadable ?? []) unreadable.push({ path: entry.path ?? null, reason: entry.reason ?? 'unreadable' });
    for (const subject of index.list('story')) {
      const story = stories.get(subject.id) ?? { id: subject.id, statuses: new Set(), locations: new Map() };
      for (const location of subject.locations?.length ? subject.locations : [subject.location ?? {}]) {
        const status = location?.state?.status ?? subject.state?.status ?? 'unknown';
        story.statuses.add(status);
        // The checkout's own copy is bound to the commit it sits on.
        const worktree = !location?.ref;
        const key = worktree ? 'worktree' : location.ref;
        story.locations.set(key, worktree
          ? { ref: 'worktree', branch: current || null, commit: head, status }
          : { ref: location.ref, branch: location.branch ?? null, commit: location.commit ?? null, status });
      }
      stories.set(subject.id, story);
    }
  }
  return {
    stories: [...stories.values()].sort((left, right) => left.id.localeCompare(right.id)).map((story) => ({
      id: story.id,
      statuses: [...story.statuses].sort(),
      locations: [...story.locations.values()].sort((left, right) => String(left.ref).localeCompare(String(right.ref)))
    })),
    unreadable
  };
}

/** The confirmation token for a plan core: changes whenever anything the rebuild depends on moves. */
export function governanceRebuildPlanId(core) {
  return `${PLAN_PREFIX}${sha256(canonical(core)).slice(0, 24)}`;
}

/**
 * Preview the rebuild. Reads the repository and writes only a scratch directory it removes.
 */
export async function planGovernanceRebuild(root, { remote = 'origin' } = {}) {
  const source = governanceConfigurationSource(root, { remote });
  const head = refCommit(root, 'HEAD');
  const { directory, present } = await exportConfiguration(root, source.commit);
  try {
    const committed = committedFileDigests(root, source.commit, present);
    const refreshed = await refreshPackagedConfiguration(directory, { restorePackagedSeeds: true, dryRun: false });
    const replaced = [];
    for (const relative of [...(refreshed.files ?? [])].sort()) {
      const before = committed.get(relative) ?? null;
      const after = await fileDigest(path.join(directory, relative));
      if (before !== after) replaced.push({ path: relative, before, after });
    }
    const removed = [...(refreshed.removed ?? [])].sort();
    const kept = (refreshed.conflicts ?? []).map((entry) => entry.path).filter(Boolean).sort();
    const compiled = await compileDefinitions(directory);
    const inventory = await governanceStoryInventory(root, compiled.definition ?? {}, { remote });

    const blockers = [];
    if (source.dirty.length) {
      blockers.push({ code: 'GOVERNANCE_REBUILD_CONFIGURATION_DIRTY', message: `Commit or discard governance changes first: ${source.dirty.join(', ')}.` });
    }
    if (compiled.loadError) {
      blockers.push({ code: compiled.loadError.code, message: `The rebuilt configuration does not load: ${compiled.loadError.message}` });
    }
    for (const workflow of compiled.workflows.filter((entry) => entry.owner === 'framework' && entry.status === 'failing')) {
      blockers.push({ code: 'GOVERNANCE_REBUILD_FRAMEWORK_WORKFLOW_FAILING', message: `Packaged workflow '${workflow.id}' does not compile: ${workflow.findings[0]?.message ?? 'unknown finding'}` });
    }
    for (const entry of inventory.unreadable) {
      blockers.push({ code: 'GOVERNANCE_REBUILD_STORY_UNREADABLE', message: `Story state at ${entry.path ?? 'an unknown path'} cannot be read: ${entry.reason}` });
    }
    const inactive = compiled.workflows.filter((entry) => entry.owner === 'repository' && entry.status === 'failing').map((entry) => entry.id);

    const core = {
      schema: GOVERNANCE_REBUILD_PLAN_VERSION,
      engine: VERSION,
      head,
      configuration: { mode: source.mode, ref: source.ref, commit: source.commit },
      product: { version: refreshed.product?.version ?? null, packageContentDigest: refreshed.packageContentDigest ?? null },
      replaced,
      removed,
      workflows: compiled.workflows.map(({ id, owner, status }) => ({ id, owner, status })),
      stories: inventory.stories.map((story) => ({ id: story.id, locations: story.locations.map(({ ref, commit }) => ({ ref, commit })) }))
    };
    return Object.freeze({
      ...core,
      plan: governanceRebuildPlanId(core),
      kept,
      workflowFindings: compiled.workflows.filter((entry) => entry.status === 'failing'),
      storyDetails: inventory.stories,
      inactive,
      blockers,
      ready: blockers.length === 0
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
