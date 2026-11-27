/**
 * A state-ref Story's records: its state ref and the state checkout [SSB:REQ-002, 003, 006, 007; milestone M2].
 *
 * Under `story.storage: state-ref` a Story's branch holds code and documents only. Everything else SFlow keeps for the
 * Story is on one ref of its own, `refs/singularity/state/<ID>` (or the branch `sflow/state/<ID>` where the ledger pins
 * as branches). It has no application history and is never merged.
 *
 * SFlow keeps that ref checked out at `.sflow-state/`, a linked worktree of the same clone inside the Story's
 * checkout (spec §11.2, probe 4):
 * - its line in the clone's common `info/exclude` is written before the checkout is made, so `git status`,
 *   `git add -A` and the code step never see it;
 * - it stays on a detached HEAD, and every state commit moves the ref at once, under its expected value
 *   (`git update-ref <ref> <new> <old>`), so nothing lives only on the detached HEAD;
 * - a missing or damaged checkout is made again from the ref; only work never committed to the ref is lost;
 * - a fetch lands in a tracking ref of its own, so it never overwrites local state commits not published yet.
 *
 * Publication of the ref (one atomic push with the Story branch, the ledger and its pin) is story-state-publication.mjs
 * (SSB M3). Loaded only for a state-ref Story, so today's layout never loads it.
 */
import { constants as fsConstants, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { appendFile, lstat, mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { SingularityFlowError, run } from './util.mjs';
import {
  checkoutChanges, checkoutPlace, indexEntries, sourceContains, sourceFileAt, sourceRevision, sourceTree
} from './source-inspection.mjs';
import {
  STATE_CHECKOUT, STATE_CONFIGURATION, STATE_REF_PREFIX, rememberStoryLayout, stateRefName, stateTrackingRefName
} from './story-paths.mjs';
import { rememberPinnedConfigurationRoot } from './configuration-read-scope.mjs';

export const STATE_CHECKOUT_EXCLUDE = `/${STATE_CHECKOUT}/`;
const EXCLUDE_COMMENT = `# Singularity Flow: a Story's state checkout (${STATE_CHECKOUT}), its own Git worktree; never commit it`;
// Variables that point Git at another repository, index or work tree. A hook or a test harness may set them; a state
// command must act on the clone it names and nothing else.
const SELECTORS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_NAMESPACE'];

function localEnvironment(env = process.env) {
  const clean = { ...env };
  for (const name of SELECTORS) delete clean[name];
  return clean;
}

function git(cwd, args, { input, env = process.env } = {}) {
  return run('git', args, { cwd, allowFailure: true, env: localEnvironment(env), ...(input === undefined ? {} : { input }) });
}

// Reads go through the source inspection facade (SDA-AC-001), in the same clean environment and never fetching.
const reading = () => ({ env: localEnvironment(), offline: true });

function gitOut(cwd, args, label, options) {
  const result = git(cwd, args, options);
  if (result.status !== 0) {
    throw new SingularityFlowError(`${label} failed: ${String(result.stderr || result.stdout || '').trim() || `git exited ${result.status}`}. Nothing else was changed.`, {
      code: 'STORY_STATE_GIT_FAILED', details: { args, status: result.status,
        nextAction: { owner: 'person', command: `git -C ${JSON.stringify(cwd)} status`, label: 'See what Git says there, then run the command again' } }
    });
  }
  return String(result.stdout ?? '').trim();
}

/** The state checkout's folder in a Story checkout. */
export function stateCheckoutPath(root) { return path.join(root, STATE_CHECKOUT); }

function commonDirectory(root) {
  const place = checkoutPlace(root, reading());
  if (place.status === 'present') return place.value.commonDir;
  return path.resolve(root, gitOut(root, ['rev-parse', '--git-common-dir'], 'Reading the clone\'s Git folder'));
}

function refOptions(definition) { return { pinTransport: definition?.ledger?.pinTransport === 'branches' ? 'branches' : 'refs' }; }

/** The Story's state ref, as its definition or workflow pins it [REQ-002]. */
export function storyStateRef(id, definition = null) { return stateRefName(id, refOptions(definition)); }

/** The commit a local ref names, or null. */
export function refTip(root, ref) {
  const resolved = sourceRevision(root, ref, reading());
  return resolved.status === 'present' ? resolved.value : null;
}

const isAncestor = (root, older, newer) => sourceContains(root, older, newer, reading()).value === true;

/**
 * The exclude line, once, in the clone's common `info/exclude` (shared by every worktree; the team's .gitignore is never
 * edited) [REQ-006]. Written before the checkout exists, so it never shows in `git status`.
 */
export async function excludeStateCheckout(root) {
  const file = path.join(commonDirectory(root), 'info', 'exclude');
  const info = await lstat(file).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (info && (info.isSymbolicLink() || !info.isFile())) {
    throw new SingularityFlowError(`${file} is not a regular file, so SFlow cannot keep ${STATE_CHECKOUT}/ out of Git. Nothing was changed.`, {
      code: 'STORY_STATE_EXCLUDE_UNSAFE', details: { file, nextAction: { owner: 'person',
        // A copy keeps its lines; it then replaces the link, so the file is a regular file with the same lines.
        command: `cp ${JSON.stringify(file)} ${JSON.stringify(`${file}.copy`)} && rm ${JSON.stringify(file)} && mv ${JSON.stringify(`${file}.copy`)} ${JSON.stringify(file)}`,
        label: 'Make it a regular file with the same lines, then run the command again' } }
    });
  }
  const text = info ? await readFile(file, 'utf8') : '';
  if (text.split(/\r?\n/u).includes(STATE_CHECKOUT_EXCLUDE)) return { file, added: false };
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${text && !text.endsWith('\n') ? '\n' : ''}${EXCLUDE_COMMENT}\n${STATE_CHECKOUT_EXCLUDE}\n`,
    { encoding: 'utf8', flag: fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0) });
  return { file, added: true };
}

/** Whether the clone already keeps the state checkout out of Git. Every command that uses it checks this. */
export function stateCheckoutExcluded(root) {
  try { return readFileSync(path.join(commonDirectory(root), 'info', 'exclude'), 'utf8').split(/\r?\n/u).includes(STATE_CHECKOUT_EXCLUDE); }
  catch { return false; }
}

function zeroId(root) {
  return '0'.repeat(gitOut(root, ['rev-parse', '--show-object-format'], 'Reading the object format') === 'sha256' ? 64 : 40);
}

/**
 * Create a new Story's state ref [REQ-002, 003]: one root commit with an empty tree, so the ref has no application
 * history. Create-only: a ref that is already there is never replaced.
 */
export function createStateRef(root, id, { definition = null, message = `[${id}][state] open the Story's records` } = {}) {
  const ref = storyStateRef(id, definition);
  const existing = refTip(root, ref);
  if (existing) {
    throw new SingularityFlowError(`Story '${id}' already has records on ${ref}, so a new Story cannot start with that ID. Nothing was changed.`, {
      code: 'STORY_STATE_REF_EXISTS', details: { ref, commit: existing, nextAction: { executable: 'singularity-flow', argv: ['resume', id], label: 'Open that Story' } }
    });
  }
  const tree = gitOut(root, ['hash-object', '-t', 'tree', '-w', '--stdin'], 'Writing the empty state tree', { input: '' });
  const commit = gitOut(root, ['commit-tree', tree, '-m', message], 'Writing the first state commit');
  const moved = git(root, ['update-ref', '-m', message, ref, commit, zeroId(root)]);
  if (moved.status !== 0) {
    throw new SingularityFlowError(`${ref} appeared while SFlow was creating it. Nothing was changed.`, {
      code: 'STORY_STATE_REF_EXISTS', details: { ref, nextAction: { executable: 'singularity-flow', argv: ['resume', id], label: 'Open that Story' } }
    });
  }
  return { ref, commit };
}

function listWorktrees(root) {
  const text = gitOut(root, ['worktree', 'list', '--porcelain'], 'Listing the clone\'s worktrees');
  return text.split(/\n\n+/u).map((block) => Object.fromEntries(block.split('\n').filter(Boolean).map((line) => {
    const at = line.indexOf(' ');
    return at < 0 ? [line, true] : [line.slice(0, at), line.slice(at + 1)];
  }))).filter((entry) => entry.worktree);
}

const real = (value) => { try { return realpathSync.native(value); } catch { return path.resolve(value); } };
// A folder that may be gone: its parent's real path and its own name.
const place = (value) => path.join(real(path.dirname(path.resolve(value))), path.basename(value));

/** Whether `folder` is a healthy linked worktree of the clone at `root`. */
function healthyCheckout(root, folder) {
  if (!existsSync(path.join(folder, '.git'))) return false;
  const place = checkoutPlace(folder, reading());
  if (place.status !== 'present') return false;
  try {
    return real(place.value.top) === real(folder) && real(place.value.commonDir) === real(commonDirectory(root));
  } catch { return false; }
}

/**
 * The way past records an unfinished command left in the state checkout: set them aside in its stash, which Git keeps
 * in the clone (so it outlives the checkout), then run the same command again. Nothing is deleted.
 */
function setAsideUnfinished(root) {
  const folder = stateCheckoutPath(root);
  return { owner: 'person', command: `git -C ${JSON.stringify(folder)} stash push --include-untracked -m "unfinished SFlow records"`,
    label: 'Set the unfinished records aside, then run the command again' };
}

/** Uncommitted changes in the state checkout, as porcelain lines; [] when it is clean or absent. */
export function stateCheckoutChanges(root) {
  const folder = stateCheckoutPath(root);
  if (!existsSync(path.join(folder, '.git'))) return [];
  const changes = checkoutChanges(folder, reading());
  return changes.status === 'present' ? changes.value : [];
}

/**
 * Make sure the Story's state checkout is there and on its ref [REQ-006]. It is made when missing, repaired when its
 * links broke (the checkout moved), set aside and made again when the folder is not the clone's worktree, and moved to
 * the ref's commit when it is clean and elsewhere (another Story's state, or a fetch moved the ref). A checkout with
 * uncommitted changes is never moved: those bytes are an unfinished command's, for its recovery.
 */
export async function ensureStateCheckout(root, id, { definition = null } = {}) {
  await excludeStateCheckout(root);
  const ref = storyStateRef(id, definition);
  const tip = refTip(root, ref);
  if (!tip) {
    throw new SingularityFlowError(`Story '${id}' has no records on ${ref} in this clone. Nothing was changed.`, {
      code: 'STORY_STATE_REF_MISSING', details: { ref, nextAction: { executable: 'singularity-flow', argv: ['resume', id, '--fetch'], label: 'Fetch the Story and its records' } }
    });
  }
  const folder = stateCheckoutPath(root);
  const repaired = [];
  let setAside = null;
  if (existsSync(folder) && !healthyCheckout(root, folder)) {
    if (existsSync(path.join(folder, '.git'))) {
      // The checkout moved, or its clone did: Git's two links point at the old place.
      git(root, ['worktree', 'repair', folder]);
      if (healthyCheckout(root, folder)) repaired.push('links');
    }
    if (!healthyCheckout(root, folder)) {
      // Not this clone's worktree: keep its bytes, out of the way, and make the checkout again.
      const aside = path.join(commonDirectory(root), 'singularity-flow', 'state-aside', `${id}-${Date.now()}`);
      await mkdir(path.dirname(aside), { recursive: true });
      await rename(folder, aside);
      setAside = aside;
      repaired.push('set-aside');
    }
  }
  let created = false;
  if (!existsSync(folder)) {
    // A folder deleted by hand or by `git clean -ffdx` is still registered; Git refuses to add it until it is pruned.
    const registered = listWorktrees(root).some((entry) => place(entry.worktree) === place(folder));
    if (registered) git(root, ['worktree', 'prune']);
    gitOut(root, ['worktree', 'add', '--detach', folder, tip], `Making the state checkout ${STATE_CHECKOUT}/`);
    created = true;
    if (registered || setAside) repaired.push('rebuilt');
  }
  const head = gitOut(folder, ['rev-parse', 'HEAD'], 'Reading the state checkout');
  let moved = false;
  if (head !== tip) {
    if (stateCheckoutChanges(root).length) {
      throw new SingularityFlowError(`The state checkout ${STATE_CHECKOUT}/ holds changes that are not on ${ref}, so SFlow did not move it. Nothing was changed.`, {
        code: 'STORY_STATE_CHECKOUT_CHANGED', details: { ref, head, tip, changes: stateCheckoutChanges(root),
          nextAction: setAsideUnfinished(root) }
      });
    }
    gitOut(folder, ['checkout', '--quiet', '--detach', tip], 'Moving the state checkout to its ref');
    moved = true;
  }
  rememberStoryLayout(root, id, 'state-ref');
  return { path: folder, ref, commit: tip, created, moved, repaired: [...new Set(repaired)], setAside };
}

/**
 * Commit everything in the state checkout and move the state ref to it, under its expected value [REQ-006 item 2].
 * Nothing to commit returns the ref's commit unchanged. The checkout's own HEAD moves last, so a refused move leaves
 * the ref and the checkout where they were, with the changes still in the checkout.
 */
export function commitStoryState(root, id, message, { definition = null, expected = undefined } = {}) {
  const prepared = prepareStoryStateCommit(root, id, message, { definition, expected });
  return prepared.committed ? advanceStoryState(root, id, prepared, message) : prepared;
}

/**
 * The first half of a state commit [SSB M3]: the records staged and their commit object made, on the ref's commit, with
 * no ref moved. So a publication can record the commit it is about to make the ref's before it does.
 */
export function prepareStoryStateCommit(root, id, message, { definition = null, expected = undefined } = {}) {
  const folder = stateCheckoutPath(root);
  const ref = storyStateRef(id, definition);
  const parent = gitOut(folder, ['rev-parse', 'HEAD'], 'Reading the state checkout');
  const tip = refTip(root, ref);
  const lease = expected === undefined ? parent : expected;
  if (tip !== lease || parent !== lease) {
    throw new SingularityFlowError(`${ref} moved while SFlow was writing Story '${id}' records (expected ${String(lease).slice(0, 12)}, found ${String(tip).slice(0, 12)}). Nothing was committed.`, {
      code: 'STORY_STATE_REF_MOVED', details: { ref, expected: lease, found: tip, head: parent,
        nextAction: { executable: 'singularity-flow', argv: ['resume', id], label: 'Open the Story again from its records' } }
    });
  }
  gitOut(folder, ['add', '--all', '--', '.'], 'Staging the Story\'s records');
  const tree = gitOut(folder, ['write-tree'], 'Writing the state tree');
  // The staged records are the ref's own when their tree is the parent's: nothing to commit.
  if (sourceTree(folder, parent, reading()).value === tree) return { committed: false, ref, commit: parent };
  const commit = gitOut(folder, ['commit-tree', tree, '-p', parent, '-m', message], 'Writing the state commit');
  return { committed: true, ref, commit, parent, tree };
}

/** The second half: the ref moves to the prepared commit under its parent, then the checkout's HEAD follows. */
export function advanceStoryState(root, id, prepared, message) {
  const { ref, commit, parent } = prepared;
  const moved = git(root, ['update-ref', '-m', message, ref, commit, parent]);
  if (moved.status !== 0) {
    throw new SingularityFlowError(`${ref} moved while SFlow was writing Story '${id}' records. Nothing was committed; the records stay in ${STATE_CHECKOUT}/.`, {
      code: 'STORY_STATE_REF_MOVED', details: { ref, expected: parent, found: refTip(root, ref), nextAction: setAsideUnfinished(root) }
    });
  }
  gitOut(stateCheckoutPath(root), ['update-ref', '--no-deref', '-m', message, 'HEAD', commit, parent], 'Moving the state checkout');
  return { ...prepared, committed: true };
}

/** Whether `older` is `newer` or one of its ancestors, in this clone; false when either is not here. */
export function stateContains(root, older, newer) { return Boolean(older && newer) && isAncestor(root, older, newer); }

/** The last state the remote is known to hold: its tracking ref, or null when this clone never fetched or pushed it. */
export function publishedStateTip(root, id, remote = 'origin') { return refTip(root, stateTrackingRefName(remote, id)); }

/** After a push landed: the tracking ref names what the remote now holds. */
export function recordStatePublished(root, id, remote, commit) {
  git(root, ['update-ref', '-m', `[${id}][state] published to ${remote}`, stateTrackingRefName(remote, id), commit]);
}

/**
 * Set a state-ref Story's unpublished local records aside [SSB M3]: the local commits stay on
 * `refs/singularity/state-aside/<ID>/<time>`, the local ref and the checkout move to what the remote holds (its tracking
 * ref), so the Story goes on from the published records. Refused while the checkout holds uncommitted records.
 */
export function setStoryStateAside(root, id, { definition = null, remote = 'origin' } = {}) {
  const ref = storyStateRef(id, definition);
  const local = refTip(root, ref);
  const published = publishedStateTip(root, id, remote);
  if (!published) return { setAside: false, reason: 'unpublished', ref, local };
  if (!local || local === published || isAncestor(root, local, published)) return { setAside: false, reason: 'nothing-local', ref, local, published };
  if (stateCheckoutChanges(root).length) {
    throw new SingularityFlowError(`The state checkout ${STATE_CHECKOUT}/ holds records not committed yet, so nothing was set aside. Nothing was changed.`, {
      code: 'STORY_STATE_CHECKOUT_CHANGED', details: { ref, nextAction: setAsideUnfinished(root) }
    });
  }
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z');
  const aside = `refs/singularity/state-aside/${id}/${stamp}`;
  gitOut(root, ['update-ref', '-m', `[${id}][state] set aside`, aside, local, zeroId(root)], 'Keeping the local records aside');
  gitOut(root, ['update-ref', '-m', `[${id}][state] set aside; now at ${remote}`, ref, published, local], 'Moving the state ref to the published records');
  const folder = stateCheckoutPath(root);
  if (existsSync(path.join(folder, '.git'))) gitOut(folder, ['checkout', '--quiet', '--detach', published], 'Moving the state checkout');
  return { setAside: true, ref, aside, local, published };
}

/** Put the state checkout back to its HEAD: what an unfinished state write left is removed [REQ-006]. */
export function restoreStateCheckout(root) {
  const folder = stateCheckoutPath(root);
  if (!existsSync(path.join(folder, '.git'))) return { restored: false };
  gitOut(folder, ['reset', '--quiet', '--hard', 'HEAD'], 'Restoring the state checkout');
  gitOut(folder, ['clean', '-fdq'], 'Removing unfinished records');
  return { restored: true };
}

/**
 * Remove a Story checkout's state checkout, before the Story checkout itself is removed (spec §11.2 item 5). Refused
 * while it holds records not committed to the state ref: removing it would lose them.
 */
export function removeStateCheckout(root, { id = null } = {}) {
  const folder = stateCheckoutPath(root);
  if (!existsSync(folder)) { git(root, ['worktree', 'prune']); return { removed: false }; }
  const changes = stateCheckoutChanges(root);
  if (changes.length) {
    throw new SingularityFlowError(`${STATE_CHECKOUT}/ in ${root} holds ${changes.length} record change(s) not saved on the Story's state ref, so the checkout was kept. Nothing was removed.`, {
      code: 'STORY_STATE_CHECKOUT_UNSAVED', details: { root, id, changes,
        nextAction: setAsideUnfinished(root) }
    });
  }
  gitOut(root, ['worktree', 'remove', folder], `Removing ${STATE_CHECKOUT}/`);
  return { removed: true };
}

/**
 * The Story whose state this checkout holds, from `.sflow-state/workflow.json`, or null. It needs no definition: the
 * folder's name is fixed. Remembers the layout, so every later path in this process resolves to the state checkout.
 */
export function detectStateCheckout(root) {
  const file = path.join(stateCheckoutPath(root), 'workflow.json');
  if (!existsSync(file)) return null;
  try {
    const id = JSON.parse(readFileSync(file, 'utf8'))?.workItem?.id;
    if (typeof id !== 'string' || !id) return null;
    rememberStoryLayout(root, id, 'state-ref');
    return { id, path: path.relative(root, file).split(path.sep).join('/') };
  } catch { return null; }
}

async function remoteTransport(root, remote) {
  const [{ configuredRemoteAuthority, frozenRemoteTransport }, { runRemoteGitAsync }] = await Promise.all([
    import('./git-remote-diagnostics.mjs'), import('./git-execution.mjs')
  ]);
  const authority = configuredRemoteAuthority(root, remote, { direction: 'fetch' });
  if (!authority?.url) {
    throw new SingularityFlowError(`Git remote '${remote}' has no fetch address, so the Story's records could not be fetched. Nothing was changed.`, {
      code: 'STORY_REMOTE_UNREACHABLE', details: { remote }
    });
  }
  return { frozen: frozenRemoteTransport(authority.url), runRemoteGitAsync };
}

/**
 * Fetch one Story's state ref into its tracking ref, then bring the local ref up to it when that loses nothing
 * [REQ-007; probe 1]. A clone or a plain fetch brings no `refs/singularity/*`, so the refspec is always named.
 * - no local ref: it is made from the fetched one;
 * - the local ref is behind: it fast-forwards;
 * - the local ref is ahead (state commits not published yet): it stays;
 * - the two diverged: it stays, and `diverged` says so.
 * A remote without the ref reports `present: false` and changes nothing.
 */
export async function fetchStoryState(root, id, { remote = 'origin', definition = null } = {}) {
  const ref = storyStateRef(id, definition);
  const tracking = stateTrackingRefName(remote, id);
  const { frozen, runRemoteGitAsync } = await remoteTransport(root, remote);
  const fetched = await runRemoteGitAsync(['fetch', '--no-tags', '--recurse-submodules=no', frozen.remote, `+${ref}:${tracking}`], {
    cwd: root, operation: 'remote-configuration', allowFailure: true, env: frozen.env
  });
  if (fetched.status !== 0) {
    if (/couldn't find remote ref|no matching remote head|not our ref/iu.test(String(fetched.stderr ?? ''))) {
      return { present: false, ref, tracking, local: refTip(root, ref), action: 'none' };
    }
    throw new SingularityFlowError(`Fetching Story '${id}' records from '${remote}' failed. Nothing was changed.`, {
      code: fetched.failure?.code ?? 'STORY_STATE_FETCH_FAILED', details: { ref, remote }
    });
  }
  const remoteTip = refTip(root, tracking);
  const local = refTip(root, ref);
  let action = 'none';
  if (!local) {
    gitOut(root, ['update-ref', '-m', `[${id}][state] fetched from ${remote}`, ref, remoteTip, zeroId(root)], 'Making the local state ref');
    action = 'created';
  } else if (local !== remoteTip) {
    if (isAncestor(root, local, remoteTip)) {
      gitOut(root, ['update-ref', '-m', `[${id}][state] fast-forward from ${remote}`, ref, remoteTip, local], 'Fast-forwarding the local state ref');
      action = 'fast-forwarded';
    } else action = isAncestor(root, remoteTip, local) ? 'kept-local-ahead' : 'diverged';
  }
  return { present: true, ref, tracking, remote: remoteTip, local: refTip(root, ref), action, diverged: action === 'diverged' };
}

const listedId = (ref, prefix) => ref.startsWith(prefix) ? ref.slice(prefix.length) : null;

/**
 * Every Story with records on a state ref [REQ-007]. With `remote`, one `git ls-remote` call; without, the local refs.
 * Each entry is { id, ref, commit }, sorted by ID.
 */
export async function listStoryStates(root, { remote = null, definition = null } = {}) {
  const branches = refOptions(definition).pinTransport === 'branches';
  const prefix = branches ? 'refs/heads/sflow/state/' : STATE_REF_PREFIX;
  let lines;
  if (remote) {
    const { frozen, runRemoteGitAsync } = await remoteTransport(root, remote);
    const listed = await runRemoteGitAsync(['ls-remote', frozen.remote, `${prefix}*`], {
      cwd: root, operation: 'remote-probe', allowFailure: true, env: frozen.env
    });
    if (listed.status !== 0) {
      throw new SingularityFlowError(`Listing the Stories' records on '${remote}' failed. Nothing was changed.`, {
        code: listed.failure?.code ?? 'STORY_STATE_LIST_FAILED', details: { remote }
      });
    }
    lines = String(listed.stdout ?? '').split('\n').filter(Boolean).map((line) => { const [commit, ref] = line.split('\t'); return { commit, ref }; });
  } else {
    lines = gitOut(root, ['for-each-ref', '--format=%(objectname) %(refname)', prefix], 'Listing the Stories\' records')
      .split('\n').filter(Boolean).map((line) => { const [commit, ref] = line.split(' '); return { commit, ref }; });
  }
  return lines.map(({ commit, ref }) => ({ id: listedId(ref, prefix), ref, commit }))
    .filter((entry) => entry.id && !entry.id.includes('/')).sort((a, b) => a.id.localeCompare(b.id));
}

/** The pinned configuration copy in a checkout's state checkout, when it has one at its usual paths [REQ-003]. */
export function statePinnedConfiguration(root) {
  const folder = path.join(stateCheckoutPath(root), STATE_CONFIGURATION);
  return existsSync(path.join(folder, 'singularity', 'workflow.yml')) ? folder : null;
}

/**
 * Move a just-materialized configuration pin from the code checkout into the state checkout, at its usual paths
 * [REQ-003], and read configuration from there from now on. A tracked file the pin replaced or removed is put back as
 * the Story branch has it: the code branch keeps its own files, and the Story's configuration is the pinned copy.
 */
export async function moveConfigurationIntoState(root, id, snapshot) {
  const target = path.join(stateCheckoutPath(root), STATE_CONFIGURATION);
  const moved = [];
  for (const relative of snapshot.paths ?? []) {
    const from = path.join(root, relative);
    const tracked = sourceFileAt(root, 'HEAD', relative, reading()).status === 'present';
    if (existsSync(from)) {
      const to = path.join(target, relative);
      await mkdir(path.dirname(to), { recursive: true });
      await rename(from, to);
      moved.push(`${STATE_CONFIGURATION}/${relative}`);
    }
    if (tracked) gitOut(root, ['checkout', '--quiet', 'HEAD', '--', relative], `Restoring ${relative} on the Story branch`);
  }
  rememberPinnedConfigurationRoot(root, target);
  rememberStoryLayout(root, id, 'state-ref');
  return { ...snapshot, paths: moved, stateConfigurationRoot: target };
}

/**
 * Whether this clone keeps a state-ref Story, from files only (no Git process): the checkout has `.sflow-state/`, or the
 * clone's exclude names it (SFlow writes that line before the first state checkout). cli-entry.mjs keeps a copy.
 */
export function keepsStateRefStories(root) {
  if (existsSync(stateCheckoutPath(root))) return true;
  try {
    let gitDirectory = path.join(root, '.git');
    if (lstatSync(gitDirectory).isFile()) {
      gitDirectory = path.resolve(root, readFileSync(gitDirectory, 'utf8').replace(/^gitdir:\s*/u, '').trim());
      const common = path.join(gitDirectory, 'commondir');
      if (existsSync(common)) gitDirectory = path.resolve(gitDirectory, readFileSync(common, 'utf8').trim());
    }
    return readFileSync(path.join(gitDirectory, 'info', 'exclude'), 'utf8').split(/\r?\n/u).includes(STATE_CHECKOUT_EXCLUDE);
  } catch { return false; }
}

/**
 * At a command's start, in a checkout that has a state checkout [REQ-006]: when the checkout is on a Story branch whose
 * records are on a local state ref, the state checkout is made right for that Story (repaired, made again, or moved
 * to its ref when clean), and the Story's layout and pinned configuration are remembered for the command. A checkout
 * on any other branch reads its own configuration, as today. It never refuses unless `required`: a command that needs
 * the records says so itself.
 */
export async function adoptStateCheckout(root, { required = false, id: known = null } = {}) {
  if (!required && !keepsStateRefStories(root)) return null;
  const current = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branchName = current.status === 0 ? String(current.stdout).trim() : '';
  // The Story is named by its Work ID; a branch named by a pattern is matched through the state checkout's workflow.
  let id = known ?? branchName;
  if (!known && branchName) {
    try {
      const recorded = JSON.parse(readFileSync(path.join(stateCheckoutPath(root), 'workflow.json'), 'utf8'));
      const names = [recorded?.workItem?.branch, recorded?.lineage?.canonicalBranch];
      if (recorded?.workItem?.id && names.includes(branchName)) id = recorded.workItem.id;
    } catch { /* no state checkout, or not readable: the branch's own name */ }
  }
  const branches = { ledger: { pinTransport: 'branches' } };
  const definition = id && refTip(root, storyStateRef(id)) ? null : id && refTip(root, storyStateRef(id, branches)) ? branches : undefined;
  if (definition === undefined) return null;
  try {
    const checkout = await ensureStateCheckout(root, id, { definition });
    const pinned = statePinnedConfiguration(root);
    if (pinned) rememberPinnedConfigurationRoot(root, pinned);
    return { id, ...checkout, configurationRoot: pinned };
  } catch (error) {
    if (required) throw error;
    return null;
  }
}

/**
 * Resume a state-ref Story [REQ-007]: with `fetch`, its state ref is fetched from `remote` into its tracking ref and the
 * local ref brought up to it when nothing local is lost. The Story is then read from its local state ref: null when
 * this clone has no records for it (a Story on today's layout, or none at all).
 */
export async function resumeStoryState(root, id, { remote = 'origin', fetch = false, definition = null } = {}) {
  const reference = String(id ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(reference)) return null;
  const fetched = fetch ? await fetchStoryState(root, reference, { remote, definition }) : null;
  const ref = storyStateRef(reference, definition);
  const tip = refTip(root, ref);
  if (!tip) return null;
  const shown = sourceFileAt(root, tip, 'workflow.json', reading());
  if (shown.status !== 'present') return null;
  let workflow;
  try { workflow = JSON.parse(shown.value); } catch { return null; }
  if (workflow?.workItem?.id !== reference) return null;
  rememberStoryLayout(root, reference, 'state-ref');
  const canonicalBranch = String(workflow.lineage?.canonicalBranch ?? workflow.workItem.branch ?? reference);
  return { ref, commit: tip, fetched, subject: { kind: 'story', id: reference, canonicalBranch, branches: [canonicalBranch],
    aliases: [reference], state: workflow, source: 'state-ref', location: { source: 'state-ref', ref, commit: tip } } };
}

/** The state commit that finished a state-ref Story's start (it holds workflow.json), or null [SSB M2]. */
export function stateStartCompleted(root, { ref }) {
  const tip = refTip(root, ref);
  return tip && sourceFileAt(root, tip, 'workflow.json', reading()).status === 'present' ? tip : null;
}

/**
 * Undo a state-ref Story's start that did not finish: its state checkout and its state ref go. Returns a failure text
 * when the ref holds a commit this start did not make (another clone's records), and then removes nothing.
 */
export function discardUnstartedStoryState(root, { ref, commit }) {
  const tip = refTip(root, ref);
  if (tip && tip !== commit && !stateStartCompleted(root, { ref }) && !isAncestor(root, commit, tip)) {
    return `${ref} holds a commit this start did not make`;
  }
  const folder = stateCheckoutPath(root);
  if (existsSync(folder)) git(root, ['worktree', 'remove', '--force', folder]);
  git(root, ['worktree', 'prune']);
  if (tip) {
    const removed = git(root, ['update-ref', '-d', ref, tip]);
    if (removed.status !== 0) return `${ref} could not be removed`;
  }
  rememberPinnedConfigurationRoot(root, null);
  const id = ref.split('/').at(-1);
  rememberStoryLayout(root, id, null);
  return null;
}

/**
 * The code never carries a Story's state checkout [SSB:REQ-006, spec §11.2 item 3]: staged or committed, `.sflow-state`
 * would put a pointer to SFlow's records (a gitlink) into the code branch and its pull request. Only a checkout that
 * has the folder is asked.
 */
export function assertNoStateCheckoutGitlink(root) {
  if (!existsSync(path.join(root, STATE_CHECKOUT))) return;
  const listed = indexEntries(root, STATE_CHECKOUT, reading());
  if (listed.status === 'present' && !listed.value.length) return;
  const command = `git rm -r --cached --quiet -- ${STATE_CHECKOUT}`;
  throw new SingularityFlowError(`The code step's changes include ${STATE_CHECKOUT}, SFlow's records for this Story. They never go in the code branch. Nothing was changed.`, {
    code: 'CODE_DELIVERY_STATE_CHECKOUT_STAGED', details: { path: STATE_CHECKOUT,
      owner: 'person', nextAction: { command, label: `Take ${STATE_CHECKOUT} out of the code, then run the command again` } }
  });
}

/**
 * Open a NEW Story's records at its start [REQ-002, 003, 006]: the exclude line, the state ref and the checkout, in
 * that order. Its layout is remembered for this process.
 */
export async function openStoryState(root, id, { definition = null } = {}) {
  await excludeStateCheckout(root);
  const created = createStateRef(root, id, { definition });
  const checkout = await ensureStateCheckout(root, id, { definition });
  return { ref: created.ref, commit: created.commit, checkout: checkout.path };
}
