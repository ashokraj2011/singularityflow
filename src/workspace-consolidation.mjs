/**
 * One clone per workspace repository: `workspace consolidate`.
 *
 * Seen on a Mac (2026-10-18): a workspace held two clones of one repository, its declared
 * `repos/myc` and a branch download `repos/main--<hash>/myc` that owned the Story worktrees. A
 * session attached through the declared clone checked one Story out there again, and the two
 * copies drifted 21 commits apart. The Story index (story-index.mjs) now stops a second copy; this
 * moves the Story checkouts a branch download owns onto the declared clone, so each workspace
 * repository is one clone again.
 *
 * The preview only reads. It names the canonical clone (the one the workspace manifest declares),
 * every Story checkout that would move, and why any other cannot: local changes, untracked files,
 * commits that are not on its remote branch, a live lease or a bound Copilot turn, an operation in
 * progress, another copy of the same Story, an unfinished start or publication recorded in the old
 * clone. Applying takes the preview's plan ID and repeats every check under the clones' leases.
 *
 * A move changes no file in the checkout and deletes nothing. The Story branch's commit is fetched
 * into the canonical clone and given its branch there; the checkout's Git administration (index,
 * HEAD, reflog and its private Singularity Flow state) is renamed from the old clone's
 * `.git/worktrees` into the canonical clone's, and the checkout's `.git` file is pointed at it. Git
 * must then report the checkout clean, on its branch, at its commit and listed by the canonical
 * clone, or the move is put back. The Story's machine-local documents are copied, not moved. The
 * old clone keeps its objects, branches and records; once it owns no checkout its branch-download
 * pointer is set aside (renamed, never deleted), so `workspace cleanup` can retire the clone after
 * its own preview.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withRegistryFileLease } from './file-lease.mjs';
import {
  changes, checkedOutBranch, commitPresent, fetchRemote, head, isAncestor, localRefHeads, refCommit,
  resetGitProcessCaches, setLocalBranch
} from './git.mjs';
import { configuredRemoteIdentity } from './git-remote-diagnostics.mjs';
import { gitStorageUnavailable } from './git-storage-availability.mjs';
import { checkoutGitFacts, indexedCheckoutAt, recordStoryCheckout, storyInCheckout } from './story-index.mjs';
import { boundTurnStories } from './story-routing.mjs';
import { withCheckoutLifecycleLease, worktreeInventory } from './story-worktree.mjs';
import {
  activeSubjectLocks, currentSubjectLockOwner, withRepositoryMutationLease, withRepositoryResetBarrier
} from './subject-lock.mjs';
import { samePlatformPath, SingularityFlowError, writeAtomic } from './util.mjs';
import { preparedWorkspaceBranch, workspaceBranchMember, workspaceBranchPointer } from './workspace-branch-locations.mjs';
import { readWorkspace, workspaceRepositoryPath } from './workspace-manifest.mjs';

const PLAN = /^wcp-[a-f0-9]{32}$/u;
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply'];
const DOCUMENT_FILE_LIMIT = 2_000;
const LEASE_TIMEOUT_MS = 60_000;

/** Why a checkout does not move, in the words the preview prints. */
const REASONS = Object.freeze({
  'canonical-missing': 'the declared clone is not a Git clone on this computer',
  'canonical-unreadable': 'the declared clone\'s Git files are not readable here (cloud placeholders)',
  'canonical-remote-differs': 'the declared clone\'s origin is not the workspace\'s remote',
  'clone-folder': 'the Story is checked out in the clone\'s own folder, not a Story worktree',
  'missing-checkout': 'Git lists a worktree whose folder is gone',
  'detached-head': 'the worktree is on no branch',
  'not-a-story-checkout': 'the worktree holds no Story',
  unavailable: 'its files are cloud placeholders that are not on this computer',
  'locked-worktree': 'Git has the worktree locked',
  submodules: 'it has initialized submodules',
  'worktree-config': 'it has its own worktree configuration',
  'sparse-checkout': 'it uses a sparse checkout',
  'operation-in-progress': 'a merge, rebase, cherry-pick, revert or bisect is in progress',
  'local-changes': 'it has local changes',
  'untracked-files': 'it has untracked files',
  'unpublished-branch': 'its branch has never been pushed',
  'unpushed-commits': 'its branch has commits that are not on the remote',
  'live-lease': 'a Singularity Flow operation or Copilot turn holds it',
  'unfinished-records': 'the old clone records an unfinished start or publication for it',
  'checked-out-in-canonical': 'the declared clone already has this Story branch checked out',
  'checked-out-twice': 'this Story branch is checked out in more than one clone',
  'canonical-branch-differs': 'the declared clone\'s copy of the branch has commits this checkout lacks',
  'object-format-differs': 'the two clones use different Git object formats',
  'local-documents-differ': 'its machine-local documents differ from the declared clone\'s'
});

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const present = (file) => lstat(file).then(() => true, () => false);
const canonical = (file) => realpath(file).catch(() => path.resolve(file));

function refused(item, reason, detail = null) {
  return { ...item, reason, message: `${REASONS[reason]}${detail ? ` (${detail})` : ''}` };
}

function failure(message, code, details) { return new SingularityFlowError(message, { code, details }); }

/** The workspace's branch downloads of one repository, read from their ownership receipts. */
async function branchClones(workspace, repositoryId) {
  const folders = await readdir(path.join(workspace.path, 'repos'), { withFileTypes: true }).catch(() => []);
  if (folders.length > 10_000) throw failure('The workspace has too many repository folders to read.', 'CHECKOUT_INVENTORY_LIMIT');
  const clones = [];
  for (const folder of folders.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())) {
    const member = await workspaceBranchMember(path.join(workspace.path, 'repos', folder.name, repositoryId, '.git'), workspace)
      .catch(() => null);
    if (member?.repositoryId !== repositoryId) continue;
    const selected = await preparedWorkspaceBranch(workspace, repositoryId, member.record.branch).catch(() => null);
    clones.push({ path: member.repositoryPath, commonDir: path.join(member.repositoryPath, '.git'), branch: member.record.branch,
      pointer: selected && samePlatformPath(selected.repositoryPath, member.repositoryPath)
        ? workspaceBranchPointer(workspace.path, repositoryId, member.record.branch) : null });
  }
  return clones.sort((left, right) => left.path.localeCompare(right.path));
}

/** The clone the workspace manifest declares, when it can receive Story checkouts. */
async function canonicalClone(workspace, repository) {
  const clone = workspaceRepositoryPath(workspace, repository);
  const info = await lstat(path.join(clone, '.git')).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) return { path: clone, reason: 'canonical-missing' };
  if (gitStorageUnavailable(clone)) return { path: clone, reason: 'canonical-unreadable' };
  let url = null;
  try { url = configuredRemoteIdentity(clone, 'origin', { direction: 'fetch' }).url; } catch { /* reported below */ }
  if (url !== repository.url) return { path: clone, reason: 'canonical-remote-differs' };
  const root = await canonical(clone);
  return { path: root, commonDir: await canonical(path.join(root, '.git')), objectFormatLength: head(root)?.length ?? null,
    branches: new Map(worktreeInventory(root).filter((entry) => entry.branch).map((entry) => [entry.branch, entry.path])) };
}

/** Locks other than this process's own, in the checkout's Git directory and its clone's. */
async function foreignLocks(checkout) {
  const locks = await activeSubjectLocks(checkout).catch(() => [{ owner: null }]);
  return locks.filter((lock) => !lock.owner?.subject
    || currentSubjectLockOwner(checkout, lock.owner.subject)?.lockToken !== lock.owner.lockToken);
}

/** Records in the old clone that its next command would need: an unfinished start or publication. */
async function unfinishedRecords(commonDir, workId) {
  const runtime = path.join(commonDir, 'singularity-flow');
  const candidates = [path.join(runtime, 'story-start', `${workId}.json`),
    path.join(runtime, 'pending-publication', `story--${workId}.json`), path.join(runtime, 'publication-journal', `story--${workId}.json`)];
  const found = [];
  for (const file of candidates) if (await present(file)) found.push(path.relative(commonDir, file));
  return found;
}

/** Every file below `directory`, relative to it, bounded. */
async function filesBelow(directory, relative = '', found = []) {
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true }).catch(() => [])) {
    if (found.length > DOCUMENT_FILE_LIMIT) break;
    const name = path.join(relative, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) await filesBelow(directory, name, found);
    else if (entry.isFile()) found.push(name);
  }
  return found;
}

/**
 * The Story's machine-local documents to copy into the canonical clone's store: source and target
 * of each missing file, or the files whose bytes differ there.
 */
async function documentCopies(fromCommonDir, toCommonDir, workId) {
  const target = path.join(toCommonDir, 'singularity-flow-documents', workId);
  const copies = [];
  const conflicts = [];
  for (const source of [path.join(fromCommonDir, 'singularity-flow-documents', workId),
    path.join(fromCommonDir, 'singularity-flow', 'local-documents', workId)]) {
    for (const relative of await filesBelow(source)) {
      const destination = path.join(target, relative);
      const existing = await readFile(destination).catch(() => null);
      if (!existing) copies.push({ source: path.join(source, relative), destination });
      else if (!existing.equals(await readFile(path.join(source, relative)))) conflicts.push(relative);
    }
  }
  return { copies, conflicts };
}

/** One linked worktree of a branch download: what moving it would take, or why it stays. */
async function inspectWorktree(worktree, clone, target, { env }) {
  const item = { workId: null, branch: worktree.branch ?? null, checkoutPath: worktree.path, clone: clone.path };
  if (!await present(worktree.path)) return refused(item, 'missing-checkout');
  if (!worktree.branch) return refused(item, 'detached-head');
  let facts;
  try { facts = await checkoutGitFacts(worktree.path); } catch { return refused(item, 'unavailable'); }
  if (!facts) return refused(item, 'missing-checkout');
  const story = await storyInCheckout(worktree.path, { facts }).catch(() => null);
  const secondary = story ? null : await indexedCheckoutAt(worktree.path, { env }).catch(() => null);
  const workId = story?.workId ?? secondary?.workId ?? null;
  if (!workId) return refused(item, 'not-a-story-checkout');
  const named = { ...item, workId, role: story ? 'story' : 'secondary', lifecycle: secondary?.lifecycle?.checkoutPath ?? null };
  if (gitStorageUnavailable(worktree.path)) return refused(named, 'unavailable');
  for (const [reason, names] of [['locked-worktree', ['locked']], ['submodules', ['modules']],
    ['worktree-config', ['config.worktree']], ['sparse-checkout', [path.join('info', 'sparse-checkout')]],
    ['operation-in-progress', IN_PROGRESS]]) {
    for (const name of names) if (await present(path.join(facts.gitDir, name))) return refused(named, reason);
  }
  const status = changes(worktree.path).split('\n').filter(Boolean);
  const tracked = status.filter((line) => !line.startsWith('??'));
  if (tracked.length) return refused(named, 'local-changes', `${tracked.length} path${tracked.length === 1 ? '' : 's'}`);
  if (status.length) return refused(named, 'untracked-files', `${status.length} path${status.length === 1 ? '' : 's'}`);
  const tip = worktree.head;
  const upstream = localRefHeads(clone.path, [`refs/remotes/origin/${worktree.branch}`]).get(`refs/remotes/origin/${worktree.branch}`);
  if (!upstream) return refused(named, 'unpublished-branch');
  if (upstream !== tip && !isAncestor(clone.path, tip, upstream)) return refused(named, 'unpushed-commits');
  if ((await foreignLocks(worktree.path)).length) return refused(named, 'live-lease');
  if ((await boundTurnStories(worktree.path)).length) return refused(named, 'live-lease', 'a Copilot turn is bound to it');
  const records = await unfinishedRecords(clone.commonDir, workId);
  if (records.length) return refused(named, 'unfinished-records', records.join(', '));
  if (target.objectFormatLength && tip.length !== target.objectFormatLength) return refused(named, 'object-format-differs');
  const elsewhere = target.branches.get(worktree.branch);
  if (elsewhere) return refused({ ...named, otherCheckoutPath: elsewhere }, 'checked-out-in-canonical', elsewhere);
  const existing = localRefHeads(target.path, [`refs/heads/${worktree.branch}`]).get(`refs/heads/${worktree.branch}`) ?? null;
  if (existing && existing !== tip && !(commitPresent(clone.path, existing) && isAncestor(clone.path, existing, tip))) {
    return refused(named, 'canonical-branch-differs');
  }
  const documents = await documentCopies(clone.commonDir, target.commonDir, workId);
  if (documents.conflicts.length) return refused(named, 'local-documents-differ', documents.conflicts.slice(0, 3).join(', '));
  return { ...named, move: true, commit: tip, canonicalBranchCommit: existing, documents: documents.copies.length,
    gitDir: facts.gitDir };
}

/** Read the workspace and plan its consolidation; nothing is changed. */
export async function planWorkspaceConsolidation(workspacePath, { repositoryIds = [], env = process.env } = {}) {
  const workspace = await readWorkspace(await canonical(workspacePath));
  const unknown = repositoryIds.filter((id) => !Object.hasOwn(workspace.repositories, id));
  if (unknown.length) throw failure(`Repository '${unknown[0]}' is not part of workspace '${workspace.name ?? workspace.id}'.`,
    'WORKSPACE_CONSOLIDATE_REPOSITORY_UNKNOWN', { repositoryIds: unknown });
  const repositories = [];
  for (const [repositoryId, repository] of Object.entries(workspace.repositories).sort(([left], [right]) => left.localeCompare(right))) {
    if (repositoryIds.length && !repositoryIds.includes(repositoryId)) continue;
    const clones = await branchClones(workspace, repositoryId);
    const entry = { repositoryId, canonical: null, clones: [], moves: [], pointers: [], refused: [] };
    repositories.push(entry);
    if (!clones.length) continue;
    const target = await canonicalClone(workspace, repository);
    entry.canonical = { path: target.path, ...(target.commonDir ? { commonDir: target.commonDir } : {}) };
    if (target.reason) {
      entry.refused.push(refused({ workId: null, branch: null, checkoutPath: target.path, clone: target.path }, target.reason));
      continue;
    }
    for (const clone of clones) {
      const items = [];
      for (const worktree of worktreeInventory(clone.path)) {
        if (samePlatformPath(await canonical(worktree.path), clone.path)) {
          const story = worktree.branch ? await storyInCheckout(clone.path).catch(() => null) : null;
          if (story) items.push(refused({ workId: story.workId, branch: worktree.branch, checkoutPath: clone.path, clone: clone.path }, 'clone-folder'));
          continue;
        }
        items.push(await inspectWorktree(worktree, clone, target, { env }));
      }
      entry.clones.push({ path: clone.path, branch: clone.branch, pointer: clone.pointer, items });
    }
    // A Story branch checked out in two downloads moves from neither: which copy is current is the person's call.
    const byBranch = new Map();
    for (const item of entry.clones.flatMap((clone) => clone.items).filter((value) => value.workId && value.branch)) {
      byBranch.set(item.branch, [...(byBranch.get(item.branch) ?? []), item]);
    }
    for (const clone of entry.clones) {
      clone.items = clone.items.map((item) => {
        const copies = byBranch.get(item.branch) ?? [];
        if (copies.length < 2) return item;
        const { move, commit, canonicalBranchCommit, documents, gitDir, ...rest } = item;
        return refused({ ...rest, otherCheckoutPaths: copies.map((copy) => copy.checkoutPath) },
          'checked-out-twice', copies.map((copy) => copy.checkoutPath).join(', '));
      });
      for (const item of clone.items) {
        if (item.move) {
          const { move, ...planned } = item;
          entry.moves.push({ ...planned, to: target.path });
        } else entry.refused.push(item);
      }
      // A download that will own no checkout no longer serves its branch; the clone itself stays.
      if (clone.pointer && clone.items.every((item) => item.move)) entry.pointers.push({ clone: clone.path, branch: clone.branch, pointer: clone.pointer });
    }
  }
  const moves = repositories.flatMap((entry) => entry.moves);
  const pointers = repositories.flatMap((entry) => entry.pointers);
  const refusals = repositories.flatMap((entry) => entry.refused);
  const facts = {
    workspaceId: workspace.id, workspacePath: workspace.path,
    repositories: repositories.map((entry) => ({ repositoryId: entry.repositoryId, canonical: entry.canonical,
      moves: entry.moves.map((move) => [move.workId, move.branch, move.checkoutPath, move.clone, move.commit, move.canonicalBranchCommit,
        move.documents]),
      pointers: entry.pointers.map((item) => item.pointer),
      refused: entry.refused.map((item) => [item.checkoutPath, item.reason]) }))
  };
  const actionable = moves.length + pointers.length > 0;
  const status = !actionable ? refusals.length ? 'blocked' : 'current' : refusals.length ? 'partial' : 'ready';
  const planId = actionable ? `wcp-${digest(facts).slice(0, 32)}` : null;
  return {
    schemaVersion: 1, resultType: 'workspace-consolidation', // schema-transient: command response, never stored
    workspace: { id: workspace.id, name: workspace.name ?? workspace.id, path: workspace.path },
    status, planId, applied: false, effects: 'preview-only',
    repositories: repositories.map(({ clones, ...entry }) => ({ ...entry,
      clones: clones.map((clone) => ({ path: clone.path, branch: clone.branch, selected: Boolean(clone.pointer),
        storyCheckouts: clone.items.filter((item) => item.workId).length })) })),
    nextAction: planId ? consolidateCommand(workspace.path, repositoryIds, planId) : null
  };
}

function consolidateCommand(workspacePath, repositoryIds, planId) {
  const quoted = /^[A-Za-z0-9_./:@-]+$/u.test(workspacePath) ? workspacePath : JSON.stringify(workspacePath);
  return ['singularity-flow workspace consolidate', quoted, ...repositoryIds.map((id) => `--repository ${id}`),
    ...(planId ? [`--confirm-plan ${planId}`] : [])].join(' ');
}

/** Copy the Story's machine-local documents; a file already there is left as it is. */
async function copyDocuments(fromCommonDir, toCommonDir, workId) {
  const { copies, conflicts } = await documentCopies(fromCommonDir, toCommonDir, workId);
  if (conflicts.length) throw failure(`Story ${workId}'s machine-local documents changed after the plan was made.`, 'WORKSPACE_CONSOLIDATE_PLAN_STALE');
  for (const { source, destination } of copies) {
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  }
  return copies.length;
}

/**
 * Move one Story worktree's Git administration from its branch download into the canonical clone.
 * Its folder and files stay where they are; on any failure the move is put back.
 */
async function moveCheckout(move, target) {
  await fetchRemote(target.path, 'origin', { branches: [move.branch], respectPartialClone: true });
  if (!commitPresent(target.path, move.commit)) throw failure(
    `Story ${move.workId}'s commit ${move.commit.slice(0, 12)} is not on the remote any more, so its checkout was not moved.`,
    'WORKSPACE_CONSOLIDATE_COMMIT_UNAVAILABLE', { checkoutPath: move.checkoutPath, commit: move.commit });
  const documents = await copyDocuments(path.join(move.clone, '.git'), target.commonDir, move.workId);
  setLocalBranch(target.path, move.branch, move.commit, move.canonicalBranchCommit);
  const from = move.gitDir;
  const parent = path.join(target.commonDir, 'worktrees');
  await mkdir(parent, { recursive: true });
  const taken = new Set(await readdir(parent).catch(() => []));
  let name = path.basename(from);
  for (let suffix = 1; taken.has(name); suffix += 1) name = `${path.basename(from)}${suffix}`;
  const to = path.join(parent, name);
  const dotGit = path.join(move.checkoutPath, '.git');
  const before = { dotGit: await readFile(dotGit, 'utf8'), gitdir: await readFile(path.join(from, 'gitdir'), 'utf8'),
    commondir: await readFile(path.join(from, 'commondir'), 'utf8').catch(() => null) };
  let renamed = false;
  try {
    await rename(from, to);
    renamed = true;
    // Git writes these relative (`../..`) or absolute; an absolute one names the old clone.
    if (before.commondir != null && path.isAbsolute(before.commondir.trim())) await writeFile(path.join(to, 'commondir'), '../..\n');
    if (!path.isAbsolute(before.gitdir.trim())) await writeFile(path.join(to, 'gitdir'), `${dotGit}\n`);
    await writeAtomic(dotGit, `gitdir: ${to}\n`);
    resetGitProcessCaches();
    const facts = await checkoutGitFacts(move.checkoutPath);
    if (!samePlatformPath(facts?.commonDir, target.commonDir)) throw new Error('the checkout still names another Git directory');
    if (checkedOutBranch(move.checkoutPath) !== move.branch) throw new Error(`Git does not see it on ${move.branch}`);
    if (refCommit(move.checkoutPath, 'HEAD') !== move.commit) throw new Error(`Git does not see it at ${move.commit.slice(0, 12)}`);
    if (changes(move.checkoutPath).trim()) throw new Error('Git reports changes in it');
    if (!worktreeInventory(target.path).some((entry) => samePlatformPath(entry.path, move.checkoutPath))) {
      throw new Error('the declared clone does not list it');
    }
  } catch (error) {
    await writeAtomic(dotGit, before.dotGit).catch(() => {});
    if (renamed) {
      await rename(to, from).catch(() => {});
      await writeFile(path.join(from, 'gitdir'), before.gitdir).catch(() => {});
      if (before.commondir != null) await writeFile(path.join(from, 'commondir'), before.commondir).catch(() => {});
    }
    try { setLocalBranch(target.path, move.branch, move.canonicalBranchCommit, move.commit); } catch { /* reported below */ }
    resetGitProcessCaches();
    throw failure(`Story ${move.workId}'s checkout ${move.checkoutPath} was not moved: ${error.message}. It was put back in ${move.clone}.`,
      'WORKSPACE_CONSOLIDATE_MOVE_FAILED', { checkoutPath: move.checkoutPath, clone: move.clone, cause: error.code ?? null });
  }
  return { workId: move.workId, role: move.role, branch: move.branch, checkoutPath: move.checkoutPath, from: move.clone,
    to: target.path, commit: move.commit, documentsCopied: documents };
}

/** Set a branch-download pointer aside, recoverably, under the lease that writes it. */
async function retirePointer(item) {
  return withRegistryFileLease(item.pointer, async () => {
    const retired = `${item.pointer}.retired-${randomUUID()}`;
    await rename(item.pointer, retired);
    return { clone: item.clone, branch: item.branch, pointer: item.pointer, retiredTo: retired };
  }, { timeoutMs: LEASE_TIMEOUT_MS });
}

/** Hold, in a fixed order: each clone's lifecycle lease, then the canonical clones' mutation leases and the old clones' reset barriers. */
function withConsolidationLeases(canonicalClones, oldClones, action) {
  const all = [...new Set([...canonicalClones, ...oldClones])].sort();
  const lifecycle = (index) => index >= all.length ? fences(0) : withCheckoutLifecycleLease(all[index], () => lifecycle(index + 1));
  const ordered = [...canonicalClones.map((root) => ['canonical', root]), ...oldClones.map((root) => ['old', root])];
  // An old clone's barrier refuses every new Singularity Flow mutation in it, so none can start in a checkout mid-move.
  const fences = (index) => index >= ordered.length ? action()
    : ordered[index][0] === 'canonical' ? withRepositoryMutationLease(ordered[index][1], 'workspace.consolidate', () => fences(index + 1))
      : withRepositoryResetBarrier(ordered[index][1], () => fences(index + 1));
  return lifecycle(0);
}

/** Apply the plan the preview issued: the same checks again, under the clones' leases, then the moves. */
export async function applyWorkspaceConsolidation(workspacePath, planId, { repositoryIds = [], env = process.env } = {}) {
  if (!PLAN.test(String(planId ?? ''))) throw failure('Use the exact plan ID the preview printed (wcp-…).', 'WORKSPACE_CONSOLIDATE_PLAN_INVALID');
  const root = await canonical(workspacePath);
  const stale = (observed) => failure(`The workspace changed after the plan was made, so nothing was moved. Preview again: `
    + `${consolidateCommand(root, repositoryIds)}.`, 'WORKSPACE_CONSOLIDATE_PLAN_STALE',
  { planId, observedPlanId: observed.planId, nextAction: consolidateCommand(root, repositoryIds) });
  return withRegistryFileLease(path.join(root, 'workspace.json'), async () => {
    const preview = await planWorkspaceConsolidation(root, { repositoryIds, env });
    if (preview.planId !== planId) throw stale(preview);
    const canonicalClones = preview.repositories.filter((entry) => entry.moves.length || entry.pointers.length)
      .map((entry) => entry.canonical.path);
    const oldClones = [...new Set(preview.repositories.flatMap((entry) => entry.moves.map((move) => move.clone)))];
    return withConsolidationLeases(canonicalClones, oldClones, async () => {
      const plan = await planWorkspaceConsolidation(root, { repositoryIds, env });
      if (plan.planId !== planId) throw stale(plan);
      const moved = [];
      const pointersRetired = [];
      try {
        for (const entry of plan.repositories) {
          for (const move of entry.moves) moved.push(await moveCheckout(move, entry.canonical));
          for (const item of entry.pointers) pointersRetired.push(await retirePointer(item));
        }
      } catch (error) {
        error.details = { ...(error.details ?? {}), moved, pointersRetired,
          preservation: 'Checkouts already moved stay in the declared clone; nothing was deleted.' };
        throw error;
      }
      // The Story index learns each checkout's new Git directory; a failed write never fails the command.
      const indexed = [];
      for (const checkout of new Set(moved.map((item) => item.role === 'secondary'
        ? plan.repositories.flatMap((entry) => entry.moves).find((move) => move.checkoutPath === item.checkoutPath)?.lifecycle
        : item.checkoutPath).filter(Boolean))) {
        indexed.push(await recordStoryCheckout(checkout, { env, source: 'workspace-consolidate' })
          .then((result) => result.recorded, () => false));
      }
      return { ...plan, applied: true, effects: moved.length ? 'story-checkouts-moved' : 'pointers-retired',
        moved, pointersRetired, storyIndex: { updated: indexed.filter(Boolean).length, failed: indexed.filter((value) => !value).length },
        nextAction: pointersRetired.length ? `singularity-flow workspace cleanup ${root} --json` : null };
    });
  }, { timeoutMs: LEASE_TIMEOUT_MS });
}
