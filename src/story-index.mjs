/**
 * The machine's Story index: which checkout holds each workspace Story, in which workspace.
 *
 * One file beside `workspaces.json` and `active-workspace.json` answers "where is hex-2018?" for
 * every registered workspace, so a command can run in the Story's own checkout wherever it was
 * started from, and nothing opens a second copy of a Story in another clone or workspace. Git's
 * own worktree list cannot see across clones, so without this a Story could be started in one
 * clone and later checked out again in another.
 *
 * The index is a lookup and a cache, never authority. Every read checks an entry against the
 * checkout itself: the folder exists, it is on the recorded branch, it shares the recorded Git
 * common directory and remote, and its workflow.json names this Story. An entry that fails is
 * dropped; its phase and status are refreshed from the workflow.json that passes. Only the
 * filesystem is read for that check (no Git process), and a cloud placeholder file in a synced
 * folder makes an entry "unavailable" instead of a read that waits for a download. No gate reads
 * the phase recorded here; it is for display and lookup.
 *
 * Identity is the repository (its normalized remote URL) plus the Work ID, across every workspace:
 * one Story has one checkout on this machine. Each entry records the workspace that holds it.
 * Checkouts outside every registered workspace are not indexed.
 */
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cloudSyncedFolder } from './git-storage-availability.mjs';
import { withRegistryFileLease } from './file-lease.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { nowIso, samePlatformPath, SingularityFlowError, writeAtomic } from './util.mjs';
import { DEFAULT_WORK_ITEM_ROOT, workItemRootFromDefinitionText } from './work-item-location.mjs';
import { readWorkspace, readWorkspaceRegistry, workspaceRepositoryPath } from './workspace-manifest.mjs';

export const STORY_INDEX_FILE = 'story-index.json';
const FAMILY = 'story-index';
const LOCK_TIMEOUT_MS = 10_000;
const SMALL_FILE_LIMIT = 64 * 1024;
const WORKFLOW_FILE_LIMIT = 16 * 1024 * 1024;
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

// The registry's location rule (workspace-context.mjs), here so the index stays out of its Git graph.
function workspaceRegistryFile(env = process.env, home = os.homedir()) {
  return path.resolve(env.SINGULARITY_FLOW_WORKSPACE_REGISTRY || path.join(home, '.singularity-flow', 'workspaces.json'));
}

/** Beside the workspace registry, wherever that is redirected. */
export function storyIndexFile(env = process.env, home = os.homedir()) {
  return path.resolve(env.SINGULARITY_FLOW_STORY_INDEX
    || path.join(path.dirname(workspaceRegistryFile(env, home)), STORY_INDEX_FILE));
}

function unavailable(file) {
  return new SingularityFlowError(`${file} is a cloud placeholder whose contents are not on this computer.`,
    { code: 'STORY_INDEX_CHECKOUT_UNAVAILABLE', details: { file } });
}

/**
 * A small file's text, or null when it does not exist. In a synced folder a placeholder (a size
 * but no allocated blocks) is refused before it is opened: opening one starts a download that a
 * read cannot time out.
 */
async function readSmall(file, { synced = false, limit = SMALL_FILE_LIMIT } = {}) {
  let info;
  try { info = await lstat(file); } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return null;
    throw error;
  }
  if (!info.isFile() || info.size > limit) return null;
  if (synced && info.size > 0 && info.blocks === 0) throw unavailable(file);
  return readFile(file, 'utf8');
}

const canonical = (file) => realpath(file).catch(() => path.resolve(file));

/**
 * Git's facts about a checkout from its files alone: its Git directory, the shared common
 * directory and the checked-out branch. Null when the folder is not a Git checkout.
 */
export async function checkoutGitFacts(checkout) {
  const root = path.resolve(checkout);
  const synced = cloudSyncedFolder(root) != null;
  let marker;
  try { marker = await lstat(path.join(root, '.git')); } catch { return null; }
  let gitDir;
  if (marker.isDirectory()) gitDir = path.join(root, '.git');
  else if (marker.isFile()) {
    const pointer = /^gitdir:[ \t]*(.+?)[ \t]*$/mu.exec(await readSmall(path.join(root, '.git'), { synced }) ?? '')?.[1];
    if (!pointer) return null;
    gitDir = path.resolve(root, pointer);
  } else return null;
  const common = (await readSmall(path.join(gitDir, 'commondir'), { synced }))?.trim();
  const commonDir = await canonical(common ? path.resolve(gitDir, common) : gitDir);
  const head = (await readSmall(path.join(gitDir, 'HEAD'), { synced }))?.trim() ?? '';
  const branch = head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : null;
  return { checkoutPath: await canonical(root), gitDir, commonDir, branch, synced };
}

/** The `[remote "origin"]` URL in a common directory's config file, read without Git. */
async function originUrl(commonDir, synced) {
  const text = await readSmall(path.join(commonDir, 'config'), { synced, limit: 1024 * 1024 }).catch(() => null);
  if (!text) return null;
  let inOrigin = false;
  for (const line of text.split(/\r?\n/u)) {
    const section = /^\s*\[\s*([^\]]+?)\s*\]/u.exec(line);
    if (section) { inOrigin = /^remote\s+"origin"$/u.test(section[1]); continue; }
    const value = inOrigin ? /^\s*url\s*=\s*(.+?)\s*$/u.exec(line)?.[1] : null;
    if (value) return value.replace(/^"(.*)"$/u, '$1');
  }
  return null;
}

/** The comparison key of a repository: its normalized remote, else its own Git storage. */
export async function repositoryKey(url, commonDir) {
  return (url ? await remoteKey(url) : null) ?? `gitdir:${commonDir}`;
}

// Lazy: the identity rules belong to the catalog reads' bundle chunk, which this module must not take.
async function remoteKey(url) {
  return (await import('./git-repository-identity.mjs')).resolvedGitRepositoryComparisonKey(url);
}

async function workItemRoot(checkout, synced) {
  try {
    const text = await readSmall(path.join(checkout, 'singularity', 'workflow.yml'), { synced, limit: WORKFLOW_FILE_LIMIT });
    return text == null ? DEFAULT_WORK_ITEM_ROOT : workItemRootFromDefinitionText(text);
  } catch (error) {
    if (error?.code === 'STORY_INDEX_CHECKOUT_UNAVAILABLE') throw error;
    return DEFAULT_WORK_ITEM_ROOT;
  }
}

const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * The Story record at `relative`, when it can name `branch`. A merged repository carries every
 * finished Story's workflow.json, so the text is checked for the branch before it is parsed.
 */
async function workflowAt(checkout, relative, synced, branch = null) {
  const text = await readSmall(path.join(checkout, ...relative.split('/')), { synced, limit: WORKFLOW_FILE_LIMIT });
  if (text == null) return null;
  if (branch && !new RegExp(`"(?:branch|canonicalBranch|name)"\\s*:\\s*"${escaped(branch)}"`, 'u').test(text)) return null;
  try { return readRecord('story-workflow', Buffer.from(text)).record; } catch { return null; }
}

const storyBranches = (state) => [state?.workItem?.branch, state?.lineage?.canonicalBranch,
  ...(state?.lineage?.childBranches ?? []).map((entry) => entry?.name)].filter(Boolean);

/**
 * The Story checked out in `checkout`: the workflow.json whose recorded branch is the current one.
 * The branch need not equal the Work ID (a naming pattern or `--ref`), so the Work ID-named
 * directory is tried first and the work-item directories are read only when that misses.
 */
export async function storyInCheckout(checkout, { facts = null, workId = null, workflowPath = null } = {}) {
  const git = facts ?? await checkoutGitFacts(checkout);
  if (!git?.branch) return null;
  // A recorded entry names its workflow.json; the configured root is read only when it moved.
  const known = workId && workflowPath?.endsWith(`/${workId}/workflow.json`)
    ? workflowPath.slice(0, -`/${workId}/workflow.json`.length) : null;
  const root = known ?? await workItemRoot(git.checkoutPath, git.synced);
  const read = async (id) => {
    if (!WORK_ID.test(id)) return null;
    const relative = `${root}/${id}/workflow.json`;
    const state = await workflowAt(git.checkoutPath, relative, git.synced, git.branch);
    return state?.workItem?.id === id && storyBranches(state).includes(git.branch) ? { state, relative } : null;
  };
  let found = workId ? await read(workId) : await read(git.branch);
  if (!found && !workId) {
    const entries = await readdir(path.join(git.checkoutPath, ...root.split('/')), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === git.branch) continue;
      found = await read(entry.name);
      if (found) break;
    }
  }
  if (!found) return null;
  const { state, relative } = found;
  return {
    workId: state.workItem.id,
    title: typeof state.workItem.title === 'string' ? state.workItem.title.slice(0, 200) : null,
    branch: git.branch,
    workflowPath: relative,
    phase: state.currentPhase ?? null,
    phaseStatus: state.phases?.[state.currentPhase]?.status ?? null,
    storyStatus: state.status ?? null,
    aliases: [...new Set([state.workItem.id, ...storyBranches(state),
      state.lineage?.jiraIssueId, state.lineage?.initialJiraKey, state.lineage?.currentJiraKey].filter(Boolean))]
  };
}

function emptyIndex() {
  return { schemaVersion: currentSchemaVersion(FAMILY), kind: FAMILY, updatedAt: null, backfill: null, entries: [] };
}

/** The stored index, or an empty one. A damaged file is a cache miss: it is rebuilt, not trusted. */
export async function readStoryIndex({ env = process.env, file = storyIndexFile(env) } = {}) {
  let bytes;
  try { bytes = await readFile(file); } catch (error) {
    if (error?.code === 'ENOENT') return emptyIndex();
    throw error;
  }
  try {
    const record = readRecord(FAMILY, bytes).record;
    return { ...emptyIndex(), ...record, entries: Array.isArray(record.entries) ? record.entries.filter(validEntry) : [] };
  } catch { return emptyIndex(); }
}

function validEntry(entry) {
  return entry && typeof entry === 'object' && WORK_ID.test(entry.workId ?? '')
    && typeof entry.checkoutPath === 'string' && path.isAbsolute(entry.checkoutPath)
    && typeof entry.commonDir === 'string' && typeof entry.branch === 'string'
    && typeof entry.workflowPath === 'string' && typeof entry.repository?.key === 'string';
}

/** Change the index under its lock and publish it atomically; `change` returns false for no write. */
async function updateStoryIndex(change, { env = process.env, file = storyIndexFile(env) } = {}) {
  return withRegistryFileLease(file, async () => {
    const index = await readStoryIndex({ file });
    const result = await change(index);
    if (result === false) return index;
    index.updatedAt = nowIso();
    index.schemaVersion = currentSchemaVersion(FAMILY);
    await writeAtomic(file, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
    return index;
  }, { timeoutMs: LOCK_TIMEOUT_MS });
}

const sameEntry = (left, right) => left.workId === right.workId && left.repository.key === right.repository.key
  && samePlatformPath(left.checkoutPath, right.checkoutPath);

/**
 * Whether an entry still describes its checkout, read from that checkout's files.
 * `valid` carries refreshed phase and status; `stale` entries are dropped; `unavailable` ones
 * (cloud placeholders) are kept and reported, never read through.
 */
export async function verifyStoryEntry(entry) {
  try {
    const info = await lstat(entry.checkoutPath).catch(() => null);
    if (!info?.isDirectory()) return { status: 'stale', reason: 'the checkout folder is gone' };
    const facts = await checkoutGitFacts(entry.checkoutPath);
    if (!facts) return { status: 'stale', reason: 'the folder is no longer a Git checkout' };
    if (facts.branch !== entry.branch) {
      return { status: 'stale', reason: `the checkout is on ${facts.branch ?? 'a detached HEAD'}, not ${entry.branch}` };
    }
    if (!samePlatformPath(facts.commonDir, entry.commonDir)) return { status: 'stale', reason: 'the checkout belongs to another Git repository' };
    // In a synced folder, Git objects evicted to the cloud make the checkout unusable: it no longer
    // holds the Story's one place, and a fresh clone elsewhere may take it (lstat only, bounded).
    if (facts.synced) {
      const { locateGitDirectories, unreadableGitFiles } = await import('./git-storage-availability.mjs');
      const directories = locateGitDirectories(entry.checkoutPath);
      const unreadable = directories ? unreadableGitFiles(directories, { maxEntries: 2_000 }) : null;
      if (!directories || unreadable.placeholders.length || unreadable.special.length) throw unavailable(directories?.commonDirectory ?? entry.checkoutPath);
    }
    const url = await originUrl(facts.commonDir, facts.synced);
    if (url && await repositoryKey(url, facts.commonDir) !== entry.repository.key) {
      return { status: 'stale', reason: 'the checkout has another remote' };
    }
    const story = await storyInCheckout(entry.checkoutPath, { facts, workId: entry.workId, workflowPath: entry.workflowPath })
      ?? await storyInCheckout(entry.checkoutPath, { facts, workId: entry.workId });
    if (!story) return { status: 'stale', reason: `the checkout no longer holds ${entry.workId}` };
    return { status: 'valid', entry: { ...entry, checkoutPath: facts.checkoutPath, title: story.title ?? entry.title ?? null,
      workflowPath: story.workflowPath, phase: story.phase, phaseStatus: story.phaseStatus, storyStatus: story.storyStatus,
      aliases: story.aliases } };
  } catch (error) {
    if (error?.code === 'STORY_INDEX_CHECKOUT_UNAVAILABLE') {
      return { status: 'unavailable', reason: 'its files are cloud placeholders that are not on this computer', entry };
    }
    return { status: 'stale', reason: error.message };
  }
}

/** Drop stale entries and refresh verified ones, under the lock, against the latest file. */
async function applyVerification(results, options) {
  const stale = results.filter((result) => result.status === 'stale');
  const refreshed = results.filter((result) => result.status === 'valid' && changedDisplay(result.original, result.entry));
  if (!stale.length && !refreshed.length) return;
  await updateStoryIndex((index) => {
    index.entries = index.entries.filter((entry) => !stale.some((result) => sameEntry(entry, result.original)))
      .map((entry) => refreshed.find((result) => sameEntry(entry, result.original))?.entry ?? entry);
  }, options).catch(() => {});
}

const DISPLAY = ['phase', 'phaseStatus', 'storyStatus', 'title', 'workflowPath', 'checkoutPath'];
function changedDisplay(left, right) {
  return DISPLAY.some((key) => (left?.[key] ?? null) !== (right?.[key] ?? null))
    || JSON.stringify(left?.aliases ?? []) !== JSON.stringify(right?.aliases ?? []);
}

async function registeredWorkspaces(env) {
  return (await readWorkspaceRegistry(workspaceRegistryFile(env)).catch(() => [])).filter((entry) => !entry.archivedAt);
}

const workspaceStamp = (entry) => `${entry.id}\u0000${path.resolve(entry.path)}`;

/** Every registered workspace has been read for Stories that predate the index. */
function backfilled(index, workspaces) {
  const done = new Set(index.backfill?.workspaces ?? []);
  return workspaces.every((entry) => done.has(workspaceStamp(entry)));
}

/**
 * The clones that can hold a workspace repository's Story checkouts: the manifest's own clone and
 * the branch checkouts its pointers name. Read from the manifest and pointers only, never a crawl.
 */
async function workspaceClones(workspace) {
  const clones = [];
  const { readBranchRecord, workspaceBranchMember } = await import('./workspace-branch-locations.mjs');
  const pointers = path.join(workspace.path, '.singularity-flow', 'branch-checkouts');
  const folders = await readdir(pointers, { withFileTypes: true }).catch(() => []);
  for (const [repositoryId, repository] of Object.entries(workspace.repositories ?? {})) {
    const declared = workspaceRepositoryPath(workspace, repository);
    if (await lstat(path.join(declared, '.git')).catch(() => null)) clones.push({ repositoryId, repository, clone: declared });
    for (const folder of folders.filter((entry) => entry.isDirectory())) {
      const pointer = await readBranchRecord(path.join(pointers, folder.name, `${repositoryId}.json`), 'workspace-branch-pointer');
      if (!pointer || typeof pointer.retry !== 'string') continue;
      const clone = path.join(workspace.path, 'repos', `${folder.name}${pointer.retry}`, repositoryId);
      const member = await workspaceBranchMember(path.join(clone, '.git'), workspace).catch(() => null);
      if (member?.repositoryId === repositoryId) clones.push({ repositoryId, repository, clone: member.repositoryPath });
    }
  }
  return clones;
}

function workspaceSummary(workspace) {
  return { id: workspace.id, name: workspace.name ?? workspace.id, path: workspace.path };
}

async function entryFor(checkout, { workspace, repositoryId, repository, facts, story, source }) {
  return {
    workId: story.workId,
    title: story.title,
    repository: { key: await repositoryKey(repository.url, facts.commonDir), url: repository.url, id: repositoryId },
    workspace: workspaceSummary(workspace),
    checkoutPath: facts.checkoutPath,
    commonDir: facts.commonDir,
    branch: story.branch,
    workflowPath: story.workflowPath,
    phase: story.phase,
    phaseStatus: story.phaseStatus,
    storyStatus: story.storyStatus,
    aliases: story.aliases,
    recordedBy: source,
    updatedAt: nowIso()
  };
}

function upsert(index, entry) {
  const at = index.entries.findIndex((item) => sameEntry(item, entry));
  if (at >= 0) index.entries[at] = { ...index.entries[at], ...entry };
  else index.entries.push(entry);
}

/**
 * Read every registered workspace's clones for Story checkouts made before this index existed:
 * `git worktree list` per clone and each worktree's current branch. A clone whose Git files are
 * cloud placeholders is skipped and reported, never read through.
 */
export async function backfillStoryIndex({ env = process.env, force = false } = {}) {
  const workspaces = await registeredWorkspaces(env);
  const before = await readStoryIndex({ env });
  if (!force && backfilled(before, workspaces)) return { status: 'current', recorded: 0, skipped: [] };
  const { worktreeInventory } = await import('./story-worktree.mjs');
  const { locateGitDirectories, unreadableGitFiles } = await import('./git-storage-availability.mjs');
  const found = [];
  const skipped = [];
  for (const registered of workspaces) {
    let workspace;
    try { workspace = await readWorkspace(registered.path); } catch (error) {
      skipped.push({ workspace: registered.path, reason: error.message });
      continue;
    }
    for (const { repositoryId, repository, clone } of await workspaceClones(workspace)) {
      if (cloudSyncedFolder(clone) != null) {
        const directories = locateGitDirectories(clone);
        if (!directories || unreadableGitFiles(directories, { maxEntries: 5_000 }).placeholders.length) {
          skipped.push({ workspace: workspace.path, clone, reason: 'its Git files are cloud placeholders' });
          continue;
        }
      }
      let worktrees;
      try { worktrees = worktreeInventory(clone); } catch (error) {
        skipped.push({ workspace: workspace.path, clone, reason: error.message });
        continue;
      }
      for (const worktree of worktrees.filter((item) => item.branch)) {
        try {
          const facts = await checkoutGitFacts(worktree.path);
          if (!facts?.branch) continue;
          const url = await originUrl(facts.commonDir, facts.synced);
          if (url && await repositoryKey(url, facts.commonDir) !== await repositoryKey(repository.url, facts.commonDir)) continue;
          const story = await storyInCheckout(worktree.path, { facts });
          if (story) found.push(await entryFor(worktree.path, { workspace, repositoryId, repository, facts, story, source: 'backfill' }));
        } catch (error) {
          skipped.push({ workspace: workspace.path, clone: worktree.path, reason: error.message });
        }
      }
    }
  }
  await updateStoryIndex((index) => {
    for (const entry of found) upsert(index, entry);
    index.backfill = { at: nowIso(), workspaces: workspaces.map(workspaceStamp) };
  }, { env });
  return { status: 'backfilled', recorded: found.length, skipped };
}

/**
 * Record the Story checked out at `checkout`, when it is a member of a registered workspace.
 * Best-effort: a lifecycle command calls this after its commit, and a failure here never fails it.
 */
export async function recordStoryCheckout(checkout, { env = process.env, source = 'lifecycle' } = {}) {
  if (!checkout) return { recorded: false, reason: 'no-checkout' };
  if (!(await registeredWorkspaces(env)).length) return { recorded: false, reason: 'no-workspaces' };
  const facts = await checkoutGitFacts(checkout);
  if (!facts?.branch) return { recorded: false, reason: 'no-branch' };
  const story = await storyInCheckout(facts.checkoutPath, { facts });
  if (!story) return { recorded: false, reason: 'no-story' };
  const { findWorkspaceMembership } = await import('./workspace-membership.mjs');
  const member = await findWorkspaceMembership(facts.checkoutPath, { registryFile: workspaceRegistryFile(env) }).catch(() => null);
  if (!member?.workspace) return { recorded: false, reason: 'not-in-workspace' };
  const repository = member.workspace.repositories[member.repositoryId];
  const entry = await entryFor(facts.checkoutPath, { workspace: member.workspace, repositoryId: member.repositoryId,
    repository, facts, story, source });
  await updateStoryIndex((index) => upsert(index, entry), { env });
  return { recorded: true, entry };
}

/**
 * Verified checkouts of a Story, matched by Work ID (or a branch or alias it records). Stale entries
 * are dropped on the way. Stories made before the index existed are found by a bounded backfill the
 * first time a lookup misses.
 */
export async function lookupStoryCheckouts(reference, { env = process.env, repositoryKey: key = null, backfill = true } = {}) {
  const requested = String(reference ?? '').trim();
  if (!requested) return { valid: [], unavailable: [] };
  const matches = (entry) => (!key || entry.repository.key === key)
    && (entry.workId === requested || entry.branch === requested || (entry.aliases ?? []).includes(requested));
  let index = await readStoryIndex({ env });
  if (backfill && !index.entries.some(matches)) {
    const workspaces = await registeredWorkspaces(env);
    if (workspaces.length && !backfilled(index, workspaces)) {
      await backfillStoryIndex({ env }).catch(() => {});
      index = await readStoryIndex({ env });
    }
  }
  const results = [];
  for (const entry of index.entries.filter(matches)) results.push({ ...await verifyStoryEntry(entry), original: entry });
  await applyVerification(results, { env });
  return {
    valid: results.filter((result) => result.status === 'valid').map((result) => result.entry),
    unavailable: results.filter((result) => result.status === 'unavailable').map((result) => ({ ...result.entry, reason: result.reason }))
  };
}

/** Every indexed Story, verified, for the Story listing. */
export async function listStoryIndex({ env = process.env, rebuild = false } = {}) {
  const backfill = await backfillStoryIndex({ env, force: rebuild });
  const index = await readStoryIndex({ env });
  const results = [];
  for (const entry of index.entries) results.push({ ...await verifyStoryEntry(entry), original: entry });
  await applyVerification(results, { env });
  const entries = results.filter((result) => result.status !== 'stale')
    .map((result) => ({ ...result.entry, availability: result.status === 'valid' ? 'ready' : 'unavailable',
      ...(result.status === 'unavailable' ? { reason: result.reason } : {}) }))
    .sort((left, right) => left.workId.localeCompare(right.workId) || left.checkoutPath.localeCompare(right.checkoutPath));
  return { file: storyIndexFile(env), entries, dropped: results.filter((result) => result.status === 'stale')
    .map((result) => ({ workId: result.original.workId, checkoutPath: result.original.checkoutPath, reason: result.reason })),
  backfill };
}

/** The workspace and repository a checkout belongs to, or null outside every registered workspace. */
export async function checkoutMembership(checkout, { env = process.env } = {}) {
  if (!(await registeredWorkspaces(env)).length) return null;
  const facts = await checkoutGitFacts(checkout);
  if (!facts) return null;
  const { findWorkspaceMembership } = await import('./workspace-membership.mjs');
  const member = await findWorkspaceMembership(facts.checkoutPath, { registryFile: workspaceRegistryFile(env) }).catch(() => null);
  if (!member?.workspace) return null;
  const repository = member.workspace.repositories[member.repositoryId];
  return { facts, workspace: workspaceSummary(member.workspace), repositoryId: member.repositoryId,
    repositoryKey: await repositoryKey(repository.url, facts.commonDir) };
}

/**
 * The commands that go to a Story's checkout: `session open` (preceded by `workspace use` when the
 * Story lives in another workspace), with their Copilot, Shell and VS Code routes.
 */
export async function storyCheckoutRoutes(workId, entry, { sameWorkspace }) {
  const commands = [...(sameWorkspace ? [] : [`singularity-flow workspace use ${entry.workspace.id}`]),
    `singularity-flow session open ${workId}`];
  const { safeCommandGuidance } = await import('./safe-command-guidance.mjs');
  const guidance = commands.map((command) => safeCommandGuidance({ command }));
  const copilot = guidance.map((item, index) => item?.copilotCommand
    ? `${item.copilotCommand}${index === guidance.length - 1 ? ` ${workId}` : ''}` : null);
  const text = `Copilot: ${copilot.every(Boolean) ? copilot.join(', then ') : 'not available for this action'}; `
    + `Shell: ${commands.join(', then ')}; VS Code (model-free): not available for this action`;
  return { commands, text };
}

/** The refusal for a Story whose one checkout is somewhere else, with the commands to go there. */
export async function storyElsewhereError(workId, entry, { sameWorkspace, operation }) {
  const where = sameWorkspace
    ? `another clone of workspace '${entry.workspace.name}'`
    : `workspace '${entry.workspace.name}' (${entry.workspace.path})`;
  const routes = await storyCheckoutRoutes(workId, entry, { sameWorkspace });
  return new SingularityFlowError(
    `Story ${workId} already has its checkout in ${where}, at ${entry.checkoutPath}. One Story has one checkout on this computer, `
    + `so ${operation} did not create another. Nothing was changed. Go there instead. ${routes.text}.`,
    { code: 'STORY_CHECKOUT_ELSEWHERE', details: {
      workId, storyCheckout: { workId, checkoutPath: entry.checkoutPath, branch: entry.branch, workspace: entry.workspace, sameWorkspace },
      nextAction: routes.commands[0], recoveryCommands: routes.commands
    } });
}

/**
 * Before a path creates or checks out a Story checkout at `root`: the Story's verified checkout
 * in another clone (another workspace, or another clone of this one), if it has one. Within one
 * clone Git itself keeps one checkout per branch. Outside every registered workspace nothing is
 * enforced, because nothing there is indexed.
 */
export async function otherStoryCheckout(root, workId, { env = process.env } = {}) {
  const member = await checkoutMembership(root, { env }).catch(() => null);
  if (!member) return null;
  const { valid } = await lookupStoryCheckouts(workId, { env, repositoryKey: member.repositoryKey });
  const other = valid.find((entry) => entry.workId === workId && !samePlatformPath(entry.commonDir, member.facts.commonDir));
  return other ? { entry: other, member, sameWorkspace: other.workspace.id === member.workspace.id } : null;
}

/** Refuse the creation path when the Story's one checkout is in another clone. */
export async function assertSingleStoryCheckout(root, workId, { env = process.env, operation = 'this command' } = {}) {
  const other = await otherStoryCheckout(root, workId, { env });
  if (other) throw await storyElsewhereError(workId, other.entry, { sameWorkspace: other.sameWorkspace, operation });
}

/**
 * For `session attach` and `session open-local`: the Story's verified checkout when it is another
 * clone of the workspace being opened, to reuse instead of checking the branch out again, or a
 * refusal when it is in another workspace. Null when there is nothing to reuse: no indexed
 * checkout, one in `root`'s own clone (Git keeps that one), or no workspace in play.
 */
export async function storyCheckoutForOpen(reference, {
  root = null, workspaceId = null, repositoryUrl = null, operation = 'this command', env = process.env
} = {}) {
  const member = root ? await checkoutMembership(root, { env }).catch(() => null) : null;
  const workspace = member?.workspace.id ?? workspaceId;
  if (!workspace) return null;
  const key = member?.repositoryKey ?? (repositoryUrl ? await remoteKey(repositoryUrl) : null);
  const { valid } = await lookupStoryCheckouts(reference, { env, repositoryKey: key });
  if (!valid.length || member && valid.some((entry) => samePlatformPath(entry.commonDir, member.facts.commonDir))) return null;
  const here = valid.filter((entry) => entry.workspace.id === workspace);
  if (here.length > 1) throw new SingularityFlowError(
    `Story ${here[0].workId} has more than one checkout in this workspace (${here.map((entry) => entry.checkoutPath).join(', ')}). `
    + `${operation} did not choose one. Keep the copy you work in and remove the other with git worktree remove after checking it holds nothing you need.`,
    { code: 'STORY_CHECKOUT_AMBIGUOUS', details: { workId: here[0].workId,
      storyCheckout: { workId: here[0].workId, checkoutPaths: here.map((entry) => entry.checkoutPath) },
      nextAction: `singularity-flow workspace stories ${here[0].workId}` } });
  if (here.length === 1) return { entry: here[0] };
  throw await storyElsewhereError(valid[0].workId, valid[0], { sameWorkspace: false, operation });
}
