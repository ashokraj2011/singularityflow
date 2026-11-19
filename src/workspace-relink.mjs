/**
 * `workspace repair`'s links (SPEC-SCF stage 5, SCF:REQ-022, D2): a workspace folder that was moved or renamed, and a
 * Story checkout whose folder was deleted.
 *
 * Git keeps a linked worktree's two links as absolute paths: the clone's `.git/worktrees/<name>/gitdir` names the
 * checkout's folder, and the checkout's `.git` file names that entry. Moving a workspace breaks both (WS-4); deleting a
 * checkout's folder leaves an entry that names nothing (WS-3). Every route then ended in "the folder no longer exists".
 *
 * The plan is read from those files, the workspace registry and Git's own worktree list. Nothing changes until the
 * person confirms the plan the preview showed (`--confirm <plan>`). Per clone of the workspace, or the one clone given
 * when it is in no workspace:
 * - each checkout that moved with it is re-linked (`git worktree repair <its folder now>`);
 * - each entry whose folder is gone is forgotten (`git worktree remove`), and a Story's managed checkout is made again
 *   from the Story's branch. SFlow's own saved records for that checkout (`<entry>/singularity-flow`: unpublished
 *   commits' records, answers, drafts) move to the new checkout, or are kept under the clone's Git folder;
 * - nothing is forgotten that would lose work: a commit only that checkout held, or files it had added to its index.
 *   The plan names each one and the command that saves it, and repair waits until it is saved.
 * Then the workspace is saved at its folder now, under one registration per ID, and the active selection moves with it.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, rename, rmdir } from 'node:fs/promises';
import path from 'node:path';

import { executeGitQuery } from './git-query.mjs';
import { addBranchWorktree, forgetMissingWorktree, repairWorktreeLinks } from './git.mjs';
import { readWorkspace, readWorkspaceRegistry, WORKSPACE_FILE, workspaceRepositoryPath, workspaceUseCommands } from './workspace-manifest.mjs';
import { samePlatformPath, SingularityFlowError } from './util.mjs';
import { assertConfirmation } from './text-lines.mjs';

/** SFlow's saved records for one worktree live here, under its Git folder (factory-reset.mjs LOCAL_RUNTIME_ROOT). */
const RUNTIME = 'singularity-flow';
/** Where a forgotten checkout's saved records are kept, under the clone's own Git folder. */
const KEPT_RECORDS = path.join(RUNTIME, 'repaired-checkouts');
/** `git worktree repair` mends a clone and its worktrees that moved together from Git 2.31 (git/git cf76baea). */
const BOTH_MOVED_GIT = [2, 31];

const exists = (file) => lstat(file).then(() => true, () => false);
const canonical = (file) => realpath(file).catch(() => path.resolve(file));
const quote = (value) => JSON.stringify(String(value));

/** A small text file, or null. */
async function text(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 64 * 1024) return null;
    return (await readFile(file, 'utf8')).trim();
  } catch { return null; }
}

/** The Git entry a worktree's `.git` file names, or null when it has no `.git` file. */
async function gitFilePointer(folder) {
  const pointer = /^gitdir:[ \t]*(.+)$/mu.exec(await text(path.join(folder, '.git')) ?? '')?.[1]?.trim();
  return pointer ? path.resolve(folder, pointer) : null;
}

/** The nearest folder at or above `start` that holds a workspace.json, or null. Files only. */
export async function enclosingWorkspaceFolder(start) {
  let current = path.resolve(start);
  for (;;) {
    if ((await lstat(path.join(current, WORKSPACE_FILE)).catch(() => null))?.isFile()) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The workspace ID a folder's workspace.json declares, or null. */
async function workspaceIdAt(folder) {
  try { return (await readWorkspace(folder)).id; } catch { return null; }
}

/**
 * The repair route for a workspace that is not where it was saved (SCF:REQ-022: a command run in a moved workspace gives
 * that one route). `cwd`, when it is inside a folder holding the same workspace, names its new folder.
 */
export async function movedWorkspaceRoute({ workspacePath, workspaceId = null, cwd = null }) {
  const here = cwd ? await enclosingWorkspaceFolder(cwd) : null;
  const moved = Boolean(workspacePath) && !existsSync(path.join(workspacePath, WORKSPACE_FILE));
  if (moved && here && (!workspaceId || await workspaceIdAt(here) === workspaceId)) {
    return { moved: true, folder: here, command: `singularity-flow workspace repair ${quote(here)}` };
  }
  if (moved) return { moved: true, folder: null, command: 'singularity-flow workspace repair <ITS-NEW-FOLDER>' };
  return { moved: false, folder: workspacePath, command: `singularity-flow workspace repair ${quote(workspacePath)}` };
}

/** Whether a saved workspace's folder no longer holds its workspace.json (moved, renamed or deleted). */
async function workspaceFolderGone(entry) {
  return !(await lstat(path.join(entry.path, WORKSPACE_FILE)).catch(() => null))?.isFile();
}

/**
 * The refusal for a workspace reference that names no saved workspace or several (workspace-context.mjs
 * resolveWorkspaceReference): a folder that holds a workspace but is not saved (moved here, or new), the same ID saved
 * twice with one folder gone (a move), copies that share an ID, or a name several share. Each names its one route.
 */
export async function workspaceReferenceRefusal(entries, matches, byId, { requested, requestedPath }) {
  if (!matches.length) {
    const manifest = requestedPath ? await readWorkspace(requestedPath).catch(() => null) : null;
    if (!manifest) {
      return new SingularityFlowError(`Workspace '${requested}' is not saved. Run 'singularity-flow workspace list'.`, {
        code: 'WORKSPACE_NOT_FOUND', details: { nextAction: { command: 'singularity-flow workspace list', label: 'See the saved workspaces' } } });
    }
    const moved = (await Promise.all(entries.filter((entry) => entry.id === manifest.id).map(workspaceFolderGone))).some(Boolean);
    return new SingularityFlowError(moved
      ? `Workspace '${manifest.id}' is not saved at ${requestedPath}: it moved here from a folder that is gone. workspace repair saves it here and re-links its Story checkouts.`
      : `The workspace at ${requestedPath} is not saved on this computer yet. Open it to save it.`,
    { code: moved ? 'WORKSPACE_MOVED' : 'WORKSPACE_NOT_SAVED', details: { workspaceId: manifest.id, workspacePath: requestedPath,
      nextAction: { command: `singularity-flow workspace ${moved ? 'repair' : 'open'} ${quote(requestedPath)}`,
        label: moved ? 'Preview the repair of the moved workspace' : 'Save this workspace' } } });
  }
  const candidates = byId.length ? byId : matches;
  const gone = await Promise.all(candidates.map(workspaceFolderGone));
  if (byId.length && gone.some(Boolean)) {
    // The same workspace saved twice, one folder gone: it moved, and its new folder was opened. Repair joins the two.
    const present = candidates.filter((entry, index) => !gone[index]);
    return new SingularityFlowError(`Workspace '${byId[0].id}' is saved twice, and the folder ${candidates.find((entry, index) => gone[index]).path} is gone: `
      + 'it moved. workspace repair keeps the one registration and re-links its Story checkouts.', {
      code: 'WORKSPACE_MOVED', details: { workspaceId: byId[0].id, registrations: byId.map((entry) => entry.path),
        nextAction: { command: present.length === 1 ? `singularity-flow workspace repair ${quote(present[0].path)}`
          : 'singularity-flow workspace repair <ITS-NEW-FOLDER>', label: 'Preview the repair of the moved workspace' } }
    });
  }
  const choices = matches.map((entry) => `${entry.id} (${entry.path})`).join(', ');
  return new SingularityFlowError(byId.length
    ? `Workspace ID '${byId[0].id}' is saved at ${byId.length} folders, as a copied workspace keeps its ID: ${choices}. Name the folder.`
    : `Workspace '${requested}' names ${matches.length} saved workspaces: ${choices}. Name one by its ID or folder.`, {
    code: 'WORKSPACE_REFERENCE_AMBIGUOUS', details: { candidates: matches.map((entry) => ({ id: entry.id, path: entry.path })),
      nextAction: { command: `singularity-flow workspace use ${quote(matches[0].path)}`, label: `Use ${matches[0].path}` } }
  });
}

/**
 * The refusal when the active workspace's folder is gone (cli-entry.mjs): it was moved or renamed, and workspace repair,
 * run in its new folder, is the one route (SCF:REQ-022). Null when the folder is still there.
 */
export async function activeWorkspaceMovedRefusal(context, cwd) {
  const route = await movedWorkspaceRoute({ workspacePath: context.workspacePath, workspaceId: context.workspaceId, cwd });
  if (!route.moved) return null;
  return new SingularityFlowError(`Active workspace '${context.workspaceName ?? context.workspaceId}' is no longer at ${context.workspacePath}: `
    + 'it was moved or renamed. workspace repair, run in its new folder, saves it there and re-links its Story checkouts.', {
    code: 'ACTIVE_WORKSPACE_MOVED',
    details: { workspaceId: context.workspaceId, workspacePath: context.workspacePath, newFolder: route.folder,
      // Another workspace this machine knows, as a whole command [audit 2026-11-19, entry 13].
      nextAction: route.command, recoveryCommands: await workspaceUseCommands(
        (await import('./workspace-context.mjs')).workspaceRegistryFile(), { except: context.workspaceId }) }
  });
}

/** The clones a workspace holds: its manifest's, then any other clone under `repos/` (branch checkouts). */
async function workspaceClones(workspace) {
  const clones = new Map();
  const add = async (folder, repositoryId) => {
    if (!(await lstat(path.join(folder, '.git')).catch(() => null))?.isDirectory()) return;
    const key = await canonical(folder);
    if (!clones.has(key)) clones.set(key, { path: key, repositoryId });
  };
  for (const [id, repository] of Object.entries(workspace.repositories ?? {})) {
    await add(workspaceRepositoryPath(workspace, repository), id);
  }
  const repos = path.join(workspace.path, 'repos');
  for (const folder of await readdir(repos, { withFileTypes: true }).catch(() => [])) {
    if (!folder.isDirectory()) continue;
    for (const member of await readdir(path.join(repos, folder.name), { withFileTypes: true }).catch(() => [])) {
      if (member.isDirectory() && Object.hasOwn(workspace.repositories ?? {}, member.name)) {
        await add(path.join(repos, folder.name, member.name), member.name);
      }
    }
  }
  return [...clones.values()];
}

/** Folders that hold a `.git` file under `root`, at most `depth` levels down: where a managed checkout can be now. */
async function checkoutFolders(root, depth = 3) {
  const found = [];
  const walk = async (folder, level) => {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(folder, entry.name);
      const marker = await lstat(path.join(candidate, '.git')).catch(() => null);
      if (marker?.isFile()) found.push(candidate);
      else if (!marker && level < depth) await walk(candidate, level + 1);
    }
  };
  await walk(root, 1);
  return found;
}

/** Each entry Git keeps for the clone's linked worktrees, read from `.git/worktrees`. */
async function worktreeEntries(clone) {
  const administration = path.join(clone, '.git', 'worktrees');
  const entries = [];
  for (const name of (await readdir(administration).catch(() => [])).sort()) {
    const entry = path.join(administration, name);
    const recorded = await text(path.join(entry, 'gitdir'));
    if (!recorded) continue;
    const head = await text(path.join(entry, 'HEAD')) ?? '';
    entries.push({
      name, entry, checkout: path.dirname(path.resolve(entry, recorded)),
      branch: head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : null,
      commit: /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(head) ? head : null,
      locked: await exists(path.join(entry, 'locked'))
    });
  }
  return entries;
}

/** Whether a folder's `.git` file names exactly this entry. */
async function linksBack(folder, entry) {
  const pointer = await gitFilePointer(folder);
  return Boolean(pointer) && samePlatformPath(await canonical(pointer), await canonical(entry));
}

/** The names of a worktree entry's saved SFlow records (`<entry>/singularity-flow`), empty when it holds none. */
async function savedRecords(entry) {
  return (await readdir(path.join(entry, RUNTIME)).catch(() => [])).sort();
}

const gitVersionAtLeast = (version, [major, minor]) => Boolean(version)
  && (version[0] > major || (version[0] === major && version[1] >= minor));

function query(cwd, id, params) {
  try { return { value: executeGitQuery(cwd, id, params) }; } catch { return null; }
}

/** The Story whose managed checkout a deleted entry was, from its branch, or null when the branch holds no Story. */
async function deletedStory(clone, entry, indexEntries) {
  const indexed = indexEntries.find((item) => samePlatformPath(item.checkoutPath, entry.checkout));
  const branch = entry.branch ?? indexed?.branch ?? null;
  if (!branch || /^sflow-start-[0-9a-f]{16}$/u.test(branch)) return null;
  if (query(clone, 'repository.local-branch-exists', { branch })?.value !== true) return null;
  const { durableStoryWorkflowOnBranch } = await import('./story-worktree.mjs');
  for (const id of [...new Set([indexed?.workId, branch].filter(Boolean))]) {
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(id) && durableStoryWorkflowOnBranch(clone, id, branch)) return { workId: id, branch };
  }
  return null;
}

/**
 * The repair plan for `folder`: a workspace folder, or a clone in no workspace. Read-only. `planId` names exactly this
 * plan; confirming it applies it, and any change in between makes the confirmation refuse.
 */
export async function planWorkspaceRelink(folder, { registryFile, selectionFile = null, env = process.env } = {}) {
  const requested = path.resolve(String(folder ?? ''));
  if (!(await lstat(requested).catch(() => null))?.isDirectory()) {
    const route = await movedWorkspaceRoute({ workspacePath: requested, cwd: process.cwd() });
    throw new SingularityFlowError(`There is no folder at ${requested}, so it cannot be repaired. If the workspace moved, repair it in its new folder.`, {
      code: 'WORKSPACE_REPAIR_FOLDER_MISSING',
      details: { folder: requested, nextAction: { command: route.command, label: 'Repair the workspace in the folder it is in now' } }
    });
  }
  const target = await canonical(requested);
  const workspaceFile = (await lstat(path.join(target, WORKSPACE_FILE)).catch(() => null))?.isFile();
  const cloneFolder = (await lstat(path.join(target, '.git')).catch(() => null))?.isDirectory();
  if (!workspaceFile && !cloneFolder) {
    throw new SingularityFlowError(`${target} holds neither a workspace (workspace.json) nor a Git clone, so there is nothing to repair there.`, {
      code: 'WORKSPACE_REPAIR_FOLDER_UNKNOWN',
      details: { folder: target, nextAction: { command: 'singularity-flow workspace list', label: 'Find the workspace folder to repair' } }
    });
  }
  const workspace = workspaceFile ? await readWorkspace(target) : null;
  const plan = {
    schemaVersion: 1, mode: workspace ? 'workspace' : 'clone', folder: target,
    workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
    registration: null, selection: null, clones: [], refusals: [], gitVersion: null
  };

  // Registration: one entry per workspace ID, at the folder it is in now.
  let indexEntries = [];
  try {
    const { readStoryIndex } = await import('./story-index.mjs');
    indexEntries = (await readStoryIndex({ env })).entries;
  } catch { /* The index is a lookup; a damaged one only loses the index's hint about a deleted checkout's Story. */ }
  if (workspace) {
    const entries = await readWorkspaceRegistry(registryFile);
    const here = entries.find((entry) => samePlatformPath(entry.path, target));
    const gone = entries.filter((entry) => entry.id === workspace.id && !samePlatformPath(entry.path, target)
      && !existsSync(path.join(entry.path, WORKSPACE_FILE))).map((entry) => entry.path);
    plan.registration = { saved: Boolean(here), save: !here, forget: gone, movedFrom: gone[0] ?? null };
    if (selectionFile) {
      let selected = null;
      try { selected = JSON.parse(await readFile(selectionFile, 'utf8')); } catch { /* none */ }
      if (selected?.workspacePath && gone.some((entry) => samePlatformPath(entry, selected.workspacePath))) {
        plan.selection = { from: selected.workspacePath, to: target, repositoryId: selected.repositoryId ?? null,
          storyId: selected.storyId ?? null, checkoutPath: selected.checkoutPath ?? selected.repositoryPath ?? null };
      }
    }
  }

  const clones = workspace ? await workspaceClones({ ...workspace, path: target }) : [{ path: target, repositoryId: null }];
  // Where a moved checkout can be now: the workspace's Story checkout folder, or beside a clone in no workspace.
  const places = workspace ? [path.join(target, '.singularity-flow', 'story-worktrees')]
    : [`${target}.stories`, path.join(path.dirname(target), '.singularity-flow', 'story-worktrees')];
  const folders = [];
  for (const place of places) folders.push(...await checkoutFolders(place));
  const version = query(target, 'git.version')?.value ?? null;
  plan.gitVersion = version ? version.join('.') : null;

  for (const clone of clones) {
    const item = { path: clone.path, repositoryId: clone.repositoryId, relink: [], forget: [], recreate: [] };
    const listed = query(clone.path, 'repository.worktrees')?.value ?? [];
    const relativeClone = workspace ? path.relative(target, clone.path) : null;
    for (const entry of await worktreeEntries(clone.path)) {
      const present = (await lstat(entry.checkout).catch(() => null))?.isDirectory();
      if (present && await linksBack(entry.checkout, entry.entry)) continue;
      if (present) {
        // The checkout stayed but its clone moved: Git mends that from the clone (Git 2.29 and later).
        const pointer = await gitFilePointer(entry.checkout);
        if (pointer && path.basename(pointer) === entry.name && !existsSync(pointer)) {
          item.relink.push({ name: entry.name, from: entry.checkout, to: entry.checkout, branch: entry.branch, bothMoved: false });
        }
        continue;
      }
      // The checkout's folder is not where Git recorded it. Moved with its workspace: same place under the new folder.
      let movedTo = null;
      for (const candidate of folders) {
        const pointer = await gitFilePointer(candidate);
        if (!pointer || path.basename(pointer) !== entry.name || path.basename(candidate) !== path.basename(entry.checkout)) continue;
        const relativeCheckout = path.relative(target, candidate);
        const oldRoot = workspace && entry.checkout.endsWith(`${path.sep}${relativeCheckout}`)
          ? entry.checkout.slice(0, -relativeCheckout.length - 1) : null;
        const pointerClone = path.dirname(path.dirname(path.dirname(pointer)));
        const sameClone = samePlatformPath(await canonical(pointerClone), clone.path)
          || (oldRoot !== null && samePlatformPath(pointerClone, path.join(oldRoot, relativeClone)));
        if (sameClone) { movedTo = candidate; break; }
      }
      if (movedTo) {
        item.relink.push({ name: entry.name, from: entry.checkout, to: movedTo, branch: entry.branch,
          bothMoved: !existsSync(path.dirname(path.dirname(path.dirname(await gitFilePointer(movedTo))))) });
        continue;
      }
      // Gone: deleted, or on a drive that is not here. Forget it only when that loses no work.
      const records = await savedRecords(entry.entry);
      const forget = { name: entry.name, checkout: entry.checkout, entry: entry.entry, branch: entry.branch,
        commit: entry.commit, savedRecords: records };
      if (entry.locked) {
        plan.refusals.push({ code: 'WORKSPACE_REPAIR_CHECKOUT_LOCKED', checkout: entry.checkout, clone: clone.path,
          message: `Git keeps ${entry.checkout} locked (git worktree lock), so its entry is left alone. If the folder is gone for good, unlock it, then repair again.`,
          command: `git -C ${quote(clone.path)} worktree unlock ${quote(entry.checkout)}` });
        continue;
      }
      if (entry.commit && query(clone.path, 'repository.ref-holds', { commit: entry.commit })?.value !== true) {
        const keep = `rescue-${entry.name.replace(/[^A-Za-z0-9._-]/gu, '').replace(/^[.-]+/u, '')}`.slice(0, 60);
        plan.refusals.push({ code: 'WORKSPACE_REPAIR_WOULD_LOSE_COMMIT', checkout: entry.checkout, clone: clone.path,
          message: `The deleted checkout ${entry.checkout} was on commit ${entry.commit.slice(0, 12)}, which no branch holds. Forgetting it would lose that commit. Give it a branch, then repair again.`,
          command: `git -C ${quote(clone.path)} branch ${keep} ${entry.commit}` });
        continue;
      }
      const staged = query(clone.path, 'worktree.staged-paths', { gitDir: entry.entry });
      if (!staged || staged.value.length) {
        const patch = path.join(path.dirname(clone.path), `${entry.branch ?? entry.name}-staged.patch`);
        plan.refusals.push({ code: 'WORKSPACE_REPAIR_WOULD_LOSE_STAGED', checkout: entry.checkout, clone: clone.path,
          files: staged ? [...staged.value] : null,
          message: staged
            ? `The deleted checkout ${entry.checkout} had added ${staged.value.length} file(s) to its index (${staged.value.slice(0, 5).join(', ')}). Forgetting it would lose them. Save them to a patch, clear that index, then repair again.`
            : `What the deleted checkout ${entry.checkout} had added to its index could not be read, so it is left alone. Save it to a patch, clear that index, then repair again.`,
          command: `git --git-dir ${quote(entry.entry)} diff --cached --binary > ${quote(patch)} && git --git-dir ${quote(entry.entry)} read-tree HEAD` });
        continue;
      }
      const story = path.dirname(entry.checkout).split(path.sep).includes('story-worktrees')
        || path.dirname(entry.checkout).endsWith('.stories')
        ? await deletedStory(clone.path, entry, indexEntries) : null;
      const elsewhere = story && listed.find((worktree) => worktree.branch === story.branch && !samePlatformPath(worktree.path, entry.checkout));
      if (story && !elsewhere) {
        const { storyWorktreeLocations } = await import('./story-worktree.mjs');
        const context = workspace && clone.repositoryId ? { workspacePath: target, repositoryId: clone.repositoryId } : null;
        const at = (await storyWorktreeLocations(clone.path, story.workId, { context })).compact;
        if (await exists(at)) {
          plan.refusals.push({ code: 'WORKSPACE_REPAIR_TARGET_EXISTS', checkout: at, clone: clone.path,
            message: `Story ${story.workId}'s checkout would be made again at ${at}, but something is already there. Move it aside, then repair again.`,
            command: `mv ${quote(at)} ${quote(`${at}.moved-aside`)}` });
          continue;
        }
        item.recreate.push({ ...forget, workId: story.workId, branch: story.branch, at });
      } else {
        item.forget.push({ ...forget, ...(elsewhere ? { branchCheckedOutAt: elsewhere.path } : {}) });
      }
    }
    if (item.relink.length || item.forget.length || item.recreate.length) plan.clones.push(item);
  }
  if (plan.clones.some((clone) => clone.relink.some((entry) => entry.bothMoved)) && !gitVersionAtLeast(version, BOTH_MOVED_GIT)) {
    plan.refusals.push({ code: 'WORKSPACE_REPAIR_GIT_TOO_OLD', clone: target,
      message: `Re-linking checkouts that moved together with their clone needs Git 2.31 or later; this computer has ${plan.gitVersion ?? 'an unknown version'}. Update Git, then repair again.`,
      command: 'git --version' });
  }
  plan.changes = plan.clones.reduce((sum, clone) => sum + clone.relink.length + clone.forget.length + clone.recreate.length, 0)
    + (plan.registration?.save || plan.registration?.forget.length ? 1 : 0) + (plan.selection ? 1 : 0);
  plan.planId = `wsr-${createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 32)}`;
  return plan;
}

/** The command that applies `plan` as previewed. */
export function workspaceRelinkConfirmCommand(plan) {
  return `singularity-flow workspace repair ${quote(plan.folder)} --confirm ${plan.planId}`;
}

/** Move a forgotten entry's saved SFlow records under the clone's Git folder, so nothing in them is lost. */
async function keepSavedRecords(clone, item) {
  if (!item.savedRecords.length) return null;
  const kept = path.join(clone, '.git', KEPT_RECORDS, `${item.name}-${new Date().toISOString().replace(/[:.]/gu, '-')}`);
  await mkdir(path.dirname(kept), { recursive: true });
  await rename(path.join(item.entry, RUNTIME), kept);
  return kept;
}

function failed(message, code, details) {
  return new SingularityFlowError(message, { code, details });
}

/**
 * Apply the plan the person confirmed: preview again, refuse a plan that changed or would lose work, then re-link,
 * forget and make checkouts again per clone under its checkout lease, save the registration and move the selection.
 */
export async function applyWorkspaceRelink(folder, { confirm, registryFile, selectionFile = null, env = process.env } = {}) {
  const plan = await planWorkspaceRelink(folder, { registryFile, selectionFile, env });
  // A copied plan ID goes through the one confirmation check: a copying slip is told apart from a changed workspace.
  assertConfirmation(confirm, plan.planId, { code: 'WORKSPACE_REPAIR_PLAN_CHANGED',
    message: 'The workspace changed since that repair was previewed, so nothing was changed. Preview it again; the new plan carries its own confirmation.',
    details: { planId: plan.planId, nextAction: { command: `singularity-flow workspace repair ${quote(plan.folder)}`, label: 'Preview the repair again' } },
    fail: (message, code, details) => { throw failed(message, code, details); } });
  if (plan.refusals.length) {
    const [first] = plan.refusals;
    throw failed(`${first.message}${plan.refusals.length > 1 ? ` (${plan.refusals.length - 1} more in the preview.)` : ''} Nothing was changed.`,
      first.code, { refusals: plan.refusals, nextAction: { command: first.command, label: 'Save that work first' } });
  }
  const { withCheckoutLifecycleLease } = await import('./story-worktree.mjs');
  const done = { relinked: [], forgotten: [], recreated: [], keptRecords: [] };
  for (const clone of plan.clones) {
    await withCheckoutLifecycleLease(clone.path, async () => {
      if (clone.relink.length) {
        const repaired = repairWorktreeLinks(clone.path, clone.relink.map((entry) => entry.to));
        const broken = [];
        for (const entry of clone.relink) {
          if (await linksBack(entry.to, path.join(clone.path, '.git', 'worktrees', entry.name))) done.relinked.push(entry);
          else broken.push(entry.to);
        }
        if (broken.length) {
          throw failed(`Git could not re-link ${broken.join(', ')} to ${clone.path}: ${String(repaired.stderr || repaired.stdout).trim() || 'no reason given'}.`,
            'WORKSPACE_REPAIR_RELINK_FAILED', { clone: clone.path, broken,
              nextAction: { command: `git -C ${quote(clone.path)} worktree repair ${broken.map(quote).join(' ')}`, label: 'Re-link them with Git directly' } });
        }
      }
      for (const entry of [...clone.forget, ...clone.recreate]) {
        if (existsSync(entry.checkout)) {
          throw failed(`${entry.checkout} is back, so its entry was not forgotten. Preview the repair again.`, 'WORKSPACE_REPAIR_PLAN_CHANGED',
            { nextAction: { command: `singularity-flow workspace repair ${quote(plan.folder)}`, label: 'Preview the repair again' } });
        }
        const kept = await keepSavedRecords(clone.path, entry);
        const removed = forgetMissingWorktree(clone.path, entry.checkout);
        if (removed.status !== 0) {
          throw failed(`Git did not forget ${entry.checkout}: ${String(removed.stderr || removed.stdout).trim()}.${kept ? ` Its saved records are kept at ${kept}.` : ''}`,
            'WORKSPACE_REPAIR_FORGET_FAILED', { clone: clone.path, checkout: entry.checkout, keptRecords: kept,
              nextAction: { command: `git -C ${quote(clone.path)} worktree list`, label: 'See what Git lists for this clone' } });
        }
        if (!entry.workId) {
          done.forgotten.push({ ...entry, keptRecords: kept });
          if (kept) done.keptRecords.push(kept);
          continue;
        }
        await mkdir(path.dirname(entry.at), { recursive: true });
        const added = addBranchWorktree(clone.path, entry.at, entry.branch);
        if (added.status !== 0) {
          throw failed(`Git could not make Story ${entry.workId}'s checkout again at ${entry.at}: ${String(added.stderr || added.stdout).trim()}. `
            + `Its branch ${entry.branch} is unchanged${kept ? `, and its saved records are kept at ${kept}` : ''}.`, 'WORKSPACE_REPAIR_RECREATE_FAILED',
          { clone: clone.path, workId: entry.workId, keptRecords: kept,
            nextAction: { command: `singularity-flow session open ${entry.workId}`, label: `Open Story ${entry.workId} from its branch` } });
        }
        let moved = null;
        const pointer = await gitFilePointer(entry.at);
        if (kept && pointer && !existsSync(path.join(pointer, RUNTIME))) {
          await rename(kept, path.join(pointer, RUNTIME));
          moved = path.join(pointer, RUNTIME);
          await rmdir(path.dirname(kept)).catch(() => {});
        } else if (kept) done.keptRecords.push(kept);
        done.recreated.push({ ...entry, savedRecordsAt: moved ?? kept });
      }
    });
  }
  if (plan.registration && (plan.registration.save || plan.registration.forget.length)) {
    const { forgetWorkspace, rememberWorkspace } = await import('./workspace.mjs');
    // Saved where it is now, then the registrations whose folder is gone are forgotten: one entry per workspace ID.
    if (plan.registration.save) await rememberWorkspace(registryFile, await readWorkspace(plan.folder));
    for (const gone of plan.registration.forget) await forgetWorkspace(registryFile, gone);
  }
  let selection = null;
  if (plan.selection && selectionFile) selection = await moveSelection(plan, done, { registryFile, selectionFile });
  const indexed = [];
  const { recordStoryCheckout } = await import('./story-index.mjs');
  for (const checkout of [...done.relinked.map((entry) => entry.to), ...done.recreated.map((entry) => entry.at)]) {
    const recorded = await recordStoryCheckout(checkout, { env, source: 'workspace-repair' }).catch(() => null);
    if (recorded?.recorded) indexed.push(recorded.entry.workId);
  }
  return { plan, ...done, selection, indexed };
}

/** The active selection, moved from the old folder to the new: the same repository, and its Story's checkout now. */
async function moveSelection(plan, done, { registryFile, selectionFile }) {
  const { activateWorkspaceContext, activateWorkspaceStoryContext, clearActiveWorkspaceContext } = await import('./workspace-context.mjs');
  const relinked = [...done.relinked.map((entry) => [entry.from, entry.to]), ...done.recreated.map((entry) => [entry.checkout, entry.at])];
  const from = plan.selection.checkoutPath;
  const checkout = relinked.find(([old]) => from && samePlatformPath(old, from))?.[1]
    ?? (from && plan.selection.from && from.startsWith(`${plan.selection.from}${path.sep}`)
      ? path.join(plan.folder, from.slice(plan.selection.from.length + 1)) : null);
  try {
    await activateWorkspaceContext(registryFile, selectionFile, plan.folder,
      { repositoryId: plan.selection.repositoryId ?? undefined, detectStory: false });
    if (plan.selection.storyId && checkout && existsSync(checkout)) {
      await activateWorkspaceStoryContext(selectionFile, registryFile, checkout, { storyId: plan.selection.storyId, selectionSource: 'workspace-repair' });
    }
    return { status: 'moved', workspacePath: plan.folder, storyId: plan.selection.storyId ?? null };
  } catch (error) {
    await clearActiveWorkspaceContext(selectionFile, plan.selection.from).catch(() => false);
    return { status: 'cleared', reason: error.message };
  }
}

/** The preview and the result, as a person reads them. */
export function renderWorkspaceRelink(result, { applied = false } = {}) {
  const plan = applied ? result.plan : result;
  const lines = [];
  const where = plan.workspace ? `Workspace ${plan.workspace.name} (${plan.workspace.id})` : `Clone ${plan.folder}`;
  if (plan.registration?.movedFrom) lines.push(`${where} moved: it was saved at ${plan.registration.movedFrom}, and is now at ${plan.folder}.`);
  else lines.push(`${where} at ${plan.folder}.`);
  if (!plan.changes && !plan.refusals.length) return [...lines, 'Its registration and Story checkouts are in order: nothing to repair.'];
  lines.push(applied ? 'Repaired:' : 'Repair plan (nothing has changed yet):');
  const say = (text) => lines.push(`  ${text}`);
  if (plan.registration?.save) say(`Save the workspace at ${plan.folder}${plan.registration.forget.length ? `, in place of ${plan.registration.forget.join(', ')}` : ''}.`);
  else if (plan.registration?.forget.length) say(`Forget the registration at ${plan.registration.forget.join(', ')}: its folder is gone.`);
  if (plan.selection) say(`Move the active selection to ${plan.folder}${plan.selection.storyId ? `, still on Story ${plan.selection.storyId}` : ''}.`);
  for (const clone of plan.clones) {
    for (const entry of clone.relink) say(`Re-link ${entry.branch ? `the checkout of ${entry.branch}` : 'a checkout'} at ${entry.to} to its clone ${clone.path}.`);
    for (const entry of clone.recreate) say(`Make Story ${entry.workId}'s checkout again at ${entry.at}, from branch ${entry.branch}: its folder ${entry.checkout} was deleted${entry.savedRecords.length ? '. SFlow\'s saved records for it move to the new checkout' : ''}.`);
    for (const entry of clone.forget) say(`Forget ${entry.checkout}: its folder is gone${entry.branch ? ` and branch ${entry.branch} keeps its commits` : ''}${entry.branchCheckedOutAt ? `, checked out at ${entry.branchCheckedOutAt}` : ''}${entry.savedRecords.length ? `. SFlow's saved records for it are kept under ${path.join(clone.path, '.git', KEPT_RECORDS)}` : ''}.`);
  }
  if (plan.refusals.length) {
    lines.push('Waiting on work that would be lost (nothing is repaired until each is saved):');
    for (const refusal of plan.refusals) { say(refusal.message); say(`  ${refusal.command}`); }
  }
  if (applied) {
    if (result.selection?.status === 'cleared') say(`The active selection could not move (${result.selection.reason}); select the workspace again with singularity-flow workspace use ${quote(plan.folder)}.`);
    for (const kept of result.keptRecords ?? []) say(`Saved records kept at ${kept}.`);
  }
  return lines;
}
