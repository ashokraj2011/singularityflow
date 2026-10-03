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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

import { assertWorkTypeStartable, loadDefinition, resolveWorkType } from './config.mjs';
import {
  changedPaths, checkedOutBranch, commitAddingPath, commitChangedPaths, commitIsolated, committedFileBytes, committedFileDigests,
  committedFileText, createRefsBundle, exportCommitPaths, gitCommonDir, localBranches, refCommit, refSnapshot, remoteBranches, topLevelEntries
} from './git.mjs';
import { GOVERNANCE_ARCHIVE_PATH, mergeGovernanceArchive, readGovernanceArchive } from './governance-archive.mjs';
import { readPendingPublication } from './publication-pending.mjs';
import { assertNoActiveSubjectLocks, withRepositoryResetBarrier } from './subject-lock.mjs';
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
      const story = stories.get(subject.id) ?? { id: subject.id, createdAt: null, statuses: new Set(), locations: new Map() };
      for (const location of subject.locations?.length ? subject.locations : [subject.location ?? {}]) {
        const status = location?.state?.status ?? subject.state?.status ?? 'unknown';
        story.statuses.add(status);
        story.createdAt ??= location?.state?.workItem?.createdAt ?? subject.state?.workItem?.createdAt ?? null;
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
      createdAt: story.createdAt,
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
 * Build the rebuilt configuration in a scratch directory and the plan describing it. The caller
 * owns the directory and removes it.
 */
async function buildGovernanceRebuild(root, { remote = 'origin' } = {}) {
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
    // A Story an earlier rebuild archived is not archived again.
    const archived = readGovernanceArchive(committedFileText(root, source.commit, GOVERNANCE_ARCHIVE_PATH));
    const alreadyArchived = new Set(archived.stories.map((story) => `${story.id}\u0000${story.createdAt ?? ''}`));
    const found = await governanceStoryInventory(root, compiled.definition ?? {}, { remote });
    const inventory = { ...found, stories: found.stories.filter((story) => !alreadyArchived.has(`${story.id}\u0000${story.createdAt ?? ''}`)) };

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
      stories: inventory.stories.map((story) => ({ id: story.id, createdAt: story.createdAt, locations: story.locations.map(({ ref, commit }) => ({ ref, commit })) }))
    };
    const plan = Object.freeze({
      ...core,
      plan: governanceRebuildPlanId(core),
      kept,
      workflowFindings: compiled.workflows.filter((entry) => entry.status === 'failing'),
      storyDetails: inventory.stories,
      inactive,
      blockers,
      ready: blockers.length === 0
    });
    return { plan, directory };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Preview the rebuild. Reads the repository and writes only a scratch directory it removes.
 */
export async function planGovernanceRebuild(root, options = {}) {
  const { plan, directory } = await buildGovernanceRebuild(root, options);
  await rm(directory, { recursive: true, force: true });
  return plan;
}

export const GOVERNANCE_RECEIPT_ROOT = 'singularity/governance/rebuilds';
export const GOVERNANCE_RECEIPT_VERSION = 'governance-rebuild-receipt/v1';
const BACKUP_VERSION = 'governance-backup/v1';

function refuse(code, message, details = null) {
  throw new SingularityFlowError(message, { code, exitCode: 2, ...(details ? { details } : {}) });
}

/** The full ref name of an inventory location, or null for the checkout's own copy. */
function fullRef(location, remote) {
  if (!location?.ref || location.ref === 'worktree') return null;
  if (location.ref.startsWith('refs/')) return location.ref;
  return location.ref.startsWith(`${remote}/`) ? `refs/remotes/${location.ref}` : `refs/heads/${location.ref}`;
}

/**
 * D10: every failing repository workflow must be named, and nothing else; `--strict` accepts none.
 */
function assertAcceptedInactive(plan, accepted, strict) {
  const named = [...new Set(accepted)].sort();
  if (strict && plan.inactive.length) {
    refuse('GOVERNANCE_REBUILD_STRICT_INACTIVE', `--strict refuses to leave failing workflows unstartable: ${plan.inactive.join(', ')}. Repair them and preview again.`);
  }
  const missing = plan.inactive.filter((id) => !named.includes(id));
  const extra = named.filter((id) => !plan.inactive.includes(id));
  if (missing.length || extra.length) {
    refuse('GOVERNANCE_REBUILD_INACTIVE_UNCONFIRMED', [
      missing.length ? `These repository workflows do not compile and will stay unstartable; name them with --accept-inactive: ${missing.join(', ')}.` : null,
      extra.length ? `These named workflows are not failing: ${extra.join(', ')}.` : null
    ].filter(Boolean).join(' '), { missing, extra });
  }
  return named;
}

/**
 * The repository-owned workflow nodes whose bytes differ between two commits: the rebuild promises
 * none, so any entry here breaks it.
 */
function changedRepositoryDefinitions(root, before, after) {
  const read = (commit, relative) => {
    try { return YAML.parse(committedFileText(root, commit, relative) ?? '') ?? {}; } catch { return {}; }
  };
  const previous = read(before, 'singularity/workflow.yml');
  const current = read(after, 'singularity/workflow.yml');
  const ownership = read(after, BASELINE_PATH).ownership?.workflow ?? {};
  const changed = [];
  for (const section of ['workTypes', 'phases', 'artifactSets', 'mcpServers']) {
    for (const [id, owner] of Object.entries(ownership[section] ?? {})) {
      if (owner !== 'repository') continue;
      if (canonical(previous[section]?.[id]) !== canonical(current[section]?.[id])) changed.push(`${section}.${id}`);
    }
  }
  return changed;
}

/** A durable, Git-private backup of every ref the rebuild could matter to, with a manifest. */
async function backUp(root, plan, { branch, remote, at }) {
  const directory = path.join(gitCommonDir(root), 'singularity-flow', 'governance-backups', plan.plan);
  await mkdir(directory, { recursive: true });
  const refs = [...new Set([
    `refs/heads/${branch}`,
    ...(plan.configuration.mode === 'authority' ? [plan.configuration.ref] : []),
    ...plan.storyDetails.flatMap((story) => story.locations.map((location) => fullRef(location, remote))).filter(Boolean)
  ])].sort();
  const bundle = path.join(directory, 'refs.bundle');
  createRefsBundle(root, bundle, refs);
  const bytes = await readFile(bundle);
  const manifest = {
    schema: BACKUP_VERSION, plan: plan.plan, createdAt: at, branch, head: plan.head,
    configuration: plan.configuration,
    refs: Object.fromEntries(refs.map((ref) => [ref, refCommit(root, ref)])),
    bundle: { file: 'refs.bundle', bytes: bytes.length, sha256: sha256(bytes) },
    restore: `git fetch <bundle> ${refs[0]}:<a new branch>`
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(directory, 'manifest.json'), manifestText);
  return { directory, manifest, manifestSha256: sha256(manifestText) };
}

/**
 * Activate a previewed rebuild: back up, write the rebuilt framework files and the archive registry
 * and receipt as one governed commit on the checked-out branch, and prove what it did not touch.
 * Only the plan the preview printed is accepted.
 */
export async function activateGovernanceRebuild(root, {
  confirmation, acceptInactive = [], strict = false, remote = 'origin', actor = null, now = () => new Date().toISOString()
} = {}) {
  if (!/^grb-[0-9a-f]{24}$/u.test(String(confirmation ?? ''))) {
    refuse('GOVERNANCE_REBUILD_CONFIRMATION_REQUIRED', 'Preview first with singularity-flow governance rebuild --dry-run, then confirm the exact plan with --confirm-plan grb-...');
  }
  return withRepositoryResetBarrier(root, async () => {
    await assertNoActiveSubjectLocks(root);
    const { plan, directory } = await buildGovernanceRebuild(root, { remote });
    try {
      if (plan.plan !== confirmation) {
        refuse('GOVERNANCE_REBUILD_PLAN_STALE', `Something the rebuild depends on changed since the preview; the plan is now ${plan.plan}. Preview again and review it before confirming.`, { expected: confirmation, current: plan.plan });
      }
      if (!plan.ready) {
        refuse('GOVERNANCE_REBUILD_BLOCKED', `The rebuild is blocked:\n- ${plan.blockers.map((entry) => `${entry.code}: ${entry.message}`).join('\n- ')}`);
      }
      if (plan.configuration.mode !== 'working-tree') {
        refuse('GOVERNANCE_REBUILD_AUTHORITY_UNSUPPORTED', `This repository's configuration lives on ${plan.configuration.ref}; activating a rebuild through a configuration proposal is not in this build.`);
      }
      const accepted = assertAcceptedInactive(plan, acceptInactive, strict);
      const branch = checkedOutBranch(root);
      if (!branch) refuse('GOVERNANCE_REBUILD_DETACHED_HEAD', 'Check out the branch the configuration lives on before rebuilding.');
      for (const story of plan.storyDetails) {
        if (await readPendingPublication(root, { kind: 'story', id: story.id, migrate: false })) {
          refuse('GOVERNANCE_REBUILD_PUBLICATION_PENDING', `Story ${story.id} has a publication still pending; finish or recover it before rebuilding.`);
        }
      }
      const before = refSnapshot(root);
      const at = now();
      const backup = await backUp(root, plan, { branch, remote, at });

      for (const entry of plan.replaced) {
        const bytes = await readFile(path.join(directory, entry.path));
        if (sha256(bytes) !== entry.after) refuse('GOVERNANCE_REBUILD_CANDIDATE_CHANGED', `The rebuilt ${entry.path} no longer matches the plan.`);
        await mkdir(path.dirname(path.join(root, entry.path)), { recursive: true });
        await writeFile(path.join(root, entry.path), bytes);
      }
      for (const relative of plan.removed) await rm(path.join(root, relative), { force: true });

      const existing = await readFile(path.join(root, GOVERNANCE_ARCHIVE_PATH), 'utf8').catch(() => null);
      const archive = mergeGovernanceArchive(readGovernanceArchive(existing), {
        plan: plan.plan, archivedAt: at, actor, stories: plan.storyDetails
      });
      await mkdir(path.dirname(path.join(root, GOVERNANCE_ARCHIVE_PATH)), { recursive: true });
      await writeFile(path.join(root, GOVERNANCE_ARCHIVE_PATH), `${JSON.stringify(archive, null, 2)}\n`);
      const receiptPath = `${GOVERNANCE_RECEIPT_ROOT}/${plan.plan}.json`;
      const receipt = {
        schema: GOVERNANCE_RECEIPT_VERSION, plan: plan.plan, rebuiltAt: at, actor, branch,
        configuration: plan.configuration, product: plan.product,
        replaced: plan.replaced, removed: plan.removed, kept: plan.kept,
        workflows: plan.workflows, inactive: accepted,
        archived: plan.storyDetails.map(({ id, createdAt, statuses, locations }) => ({ id, createdAt, statuses, locations: locations.map(({ ref, commit }) => ({ ref, commit })) })),
        backup: { path: path.relative(gitCommonDir(root), backup.directory), manifestSha256: backup.manifestSha256 }
      };
      await mkdir(path.join(root, GOVERNANCE_RECEIPT_ROOT), { recursive: true });
      await writeFile(path.join(root, receiptPath), `${JSON.stringify(receipt, null, 2)}\n`);

      const paths = [...plan.replaced.map((entry) => entry.path), ...plan.removed, GOVERNANCE_ARCHIVE_PATH, receiptPath];
      const commit = await commitIsolated(root, `[governance-rebuild] ${plan.plan}`, paths, { expectedHead: plan.head });

      // Assert what was promised instead of assuming it.
      const changed = commitChangedPaths(root, commit);
      const outside = changed.filter((relative) => !paths.includes(relative));
      const after = refSnapshot(root);
      const moved = [...new Set([...before.keys(), ...after.keys()])]
        .filter((ref) => before.get(ref) !== after.get(ref) && ref !== `refs/heads/${branch}`);
      const definitions = changedRepositoryDefinitions(root, plan.head, commit);
      const invariants = {
        onlyGovernanceFilesChanged: outside.length === 0,
        otherRefsUnchanged: moved.length === 0,
        repositoryDefinitionsKept: definitions.length === 0
      };
      if (outside.length || moved.length || definitions.length) {
        refuse('GOVERNANCE_REBUILD_INVARIANT_BROKEN', `The rebuild commit ${commit.slice(0, 12)} changed more than it should: ${[...outside, ...moved, ...definitions].join(', ')}. Restore it with singularity-flow governance restore --plan ${plan.plan}.`);
      }
      return Object.freeze({ plan, commit, branch, receiptPath, archived: receipt.archived.length, backup, invariants });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

/**
 * Undo a rebuild by restoring every file its commit changed to the bytes before it, as one new
 * governed commit. History is kept; nothing is reset. The backup bundle stays for anything else.
 */
export async function restoreGovernanceRebuild(root, { plan: planId, confirm = null } = {}) {
  if (!/^grb-[0-9a-f]{24}$/u.test(String(planId ?? ''))) refuse('GOVERNANCE_RESTORE_PLAN_REQUIRED', 'Name the rebuild to restore with --plan grb-...');
  const receiptPath = `${GOVERNANCE_RECEIPT_ROOT}/${planId}.json`;
  const commit = commitAddingPath(root, receiptPath);
  if (!commit) refuse('GOVERNANCE_RESTORE_UNKNOWN', `No rebuild ${planId} is in this branch's history.`);
  const parent = refCommit(root, `${commit}^`);
  const paths = commitChangedPaths(root, commit);
  const dirty = changedPaths(root, paths);
  const restores = paths.map((relative) => ({ path: relative, action: committedFileBytes(root, parent, relative) ? 'restore' : 'remove' }));
  const preview = Object.freeze({ plan: planId, commit, parent, restores, dirty });
  if (confirm == null) return { preview, restored: null };
  if (confirm !== planId) refuse('GOVERNANCE_RESTORE_CONFIRMATION_MISMATCH', `Confirm the restore with --confirm ${planId}.`);
  if (dirty.length) refuse('GOVERNANCE_RESTORE_DIRTY', `Commit or discard changes to these files first: ${dirty.join(', ')}.`);
  return withRepositoryResetBarrier(root, async () => {
    await assertNoActiveSubjectLocks(root);
    const head = refCommit(root, 'HEAD');
    for (const entry of restores) {
      const target = path.join(root, entry.path);
      if (entry.action === 'remove') await rm(target, { force: true });
      else {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, committedFileBytes(root, parent, entry.path));
      }
    }
    const restored = await commitIsolated(root, `[governance-restore] ${planId}`, paths, { expectedHead: head });
    return { preview, restored };
  });
}
