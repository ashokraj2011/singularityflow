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
 * Publication of the ref (one atomic push with the Story branch, the ledger and its pin) is M3. Loaded only for a
 * state-ref Story, so today's layout never loads it.
 */
import { constants as fsConstants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { appendFile, lstat, mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { SingularityFlowError, run } from './util.mjs';
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

function gitOut(cwd, args, label, options) {
  const result = git(cwd, args, options);
  if (result.status !== 0) {
    throw new SingularityFlowError(`${label} failed: ${String(result.stderr || result.stdout || '').trim() || `git exited ${result.status}`}. Nothing else was changed.`, {
      code: 'STORY_STATE_GIT_FAILED', details: { args, status: result.status }
    });
  }
  return String(result.stdout ?? '').trim();
}

/** The state checkout's folder in a Story checkout. */
export function stateCheckoutPath(root) { return path.join(root, STATE_CHECKOUT); }

function commonDirectory(root) {
  return path.resolve(root, gitOut(root, ['rev-parse', '--git-common-dir'], 'Reading the clone\'s Git folder'));
}

function refOptions(definition) { return { pinTransport: definition?.ledger?.pinTransport === 'branches' ? 'branches' : 'refs' }; }

/** The Story's state ref, as its definition or workflow pins it [REQ-002]. */
export function storyStateRef(id, definition = null) { return stateRefName(id, refOptions(definition)); }

/** The commit a local ref names, or null. */
export function refTip(root, ref) {
  const result = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return result.status === 0 ? String(result.stdout).trim() : null;
}

const isAncestor = (root, older, newer) => git(root, ['merge-base', '--is-ancestor', older, newer]).status === 0;

/**
 * The exclude line, once, in the clone's common `info/exclude` (shared by every worktree; the team's .gitignore is never
 * edited) [REQ-006]. Written before the checkout exists, so it never shows in `git status`.
 */
export async function excludeStateCheckout(root) {
  const file = path.join(commonDirectory(root), 'info', 'exclude');
  const info = await lstat(file).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (info && (info.isSymbolicLink() || !info.isFile())) {
    throw new SingularityFlowError(`${file} is not a regular file, so SFlow cannot keep ${STATE_CHECKOUT}/ out of Git. Nothing was changed.`, {
      code: 'STORY_STATE_EXCLUDE_UNSAFE', details: { file }
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

const real = (value) => { try { return realpathSync(value); } catch { return path.resolve(value); } };
// A folder that may be gone: its parent's real path and its own name.
const place = (value) => path.join(real(path.dirname(path.resolve(value))), path.basename(value));

/** Whether `folder` is a healthy linked worktree of the clone at `root`. */
function healthyCheckout(root, folder) {
  if (!existsSync(path.join(folder, '.git'))) return false;
  const top = git(folder, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return false;
  const common = git(folder, ['rev-parse', '--git-common-dir']);
  if (common.status !== 0) return false;
  try {
    return real(String(top.stdout).trim()) === real(folder)
      && real(path.resolve(folder, String(common.stdout).trim())) === real(commonDirectory(root));
  } catch { return false; }
}

/** Uncommitted changes in the state checkout, as porcelain lines; [] when it is clean or absent. */
export function stateCheckoutChanges(root) {
  const folder = stateCheckoutPath(root);
  if (!existsSync(path.join(folder, '.git'))) return [];
  const status = git(folder, ['status', '--porcelain=v1', '--untracked-files=all']);
  return status.status === 0 ? String(status.stdout).split('\n').filter(Boolean) : [];
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
          nextAction: { executable: 'singularity-flow', argv: ['recover'], label: 'Finish or undo the command that wrote them' } }
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
  const folder = stateCheckoutPath(root);
  const ref = storyStateRef(id, definition);
  const parent = gitOut(folder, ['rev-parse', 'HEAD'], 'Reading the state checkout');
  const tip = refTip(root, ref);
  const lease = expected === undefined ? parent : expected;
  if (tip !== lease || parent !== lease) {
    throw new SingularityFlowError(`${ref} moved while SFlow was writing Story '${id}' records (expected ${String(lease).slice(0, 12)}, found ${String(tip).slice(0, 12)}). Nothing was committed.`, {
      code: 'STORY_STATE_REF_MOVED', details: { ref, expected: lease, found: tip, head: parent }
    });
  }
  gitOut(folder, ['add', '--all', '--', '.'], 'Staging the Story\'s records');
  if (git(folder, ['diff', '--cached', '--quiet']).status === 0) return { committed: false, ref, commit: parent };
  const tree = gitOut(folder, ['write-tree'], 'Writing the state tree');
  const commit = gitOut(folder, ['commit-tree', tree, '-p', parent, '-m', message], 'Writing the state commit');
  const moved = git(root, ['update-ref', '-m', message, ref, commit, parent]);
  if (moved.status !== 0) {
    throw new SingularityFlowError(`${ref} moved while SFlow was writing Story '${id}' records. Nothing was committed; the records stay in ${STATE_CHECKOUT}/.`, {
      code: 'STORY_STATE_REF_MOVED', details: { ref, expected: parent, found: refTip(root, ref) }
    });
  }
  gitOut(folder, ['update-ref', '--no-deref', '-m', message, 'HEAD', commit, parent], 'Moving the state checkout');
  return { committed: true, ref, commit, parent, tree };
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
        nextAction: { executable: 'singularity-flow', argv: ['recover'], label: 'Finish or undo the command that wrote them' } }
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

/**
 * The lifecycle authority of a state-ref Story [REQ-002, 006; M2]: a transition writes its records in the state
 * checkout and commits everything there on the state ref, under the ref's expected value. Nothing is committed on the
 * Story branch, so an approval or a decision starts no CI. A refused transition puts the state checkout back as it was
 * when the transition began (drafts written before it included), through the transition's own rollback. Publication
 * of the ref, with the Story branch, the ledger and the pin in one atomic push, is M3 [REQ-005]: until then the result
 * says `pushed: false`.
 */
export function storyStateAuthority(root, id, { definition = null } = {}) {
  const ref = storyStateRef(id, definition);
  return Object.freeze({
    descriptor: Object.freeze({ id: 'story-state-ref', qualification: 'local-only', ref }),
    async publish(transition) {
      const { event, commit: commitSpec, state = null, beforeCommit = null, afterOwnedWrites = null, fault = null } = transition;
      if (!commitSpec?.message) throw new SingularityFlowError('A state commit needs a message.');
      await ensureStateCheckout(root, id, { definition });
      const expected = refTip(root, ref);
      const { capturePublicationPreimage } = await import('./publication-recovery.mjs');
      const preimage = await capturePublicationPreimage(root, [STATE_CHECKOUT]);
      let envelope = event;
      try {
        if (state?.write) {
          const written = await state.write(envelope, { transactionId: transition.transactionId ?? null, expectedHead: expected, branch: ref });
          if (written?.event) envelope = written.event;
        }
        if (fault) await fault('after-state-write', { envelope });
        if (state?.validate) await state.validate(envelope);
        if (beforeCommit) await beforeCommit(envelope);
        if (afterOwnedWrites) await afterOwnedWrites(envelope, { ledgerIntentPath: null });
        const committed = commitStoryState(root, id, commitSpec.message, { definition, expected });
        return { sha: committed.commit, pushed: false, replayed: false, event: envelope, ledger: null,
          state: { ref, commit: committed.commit, parent: expected, committed: committed.committed, published: false } };
      } catch (error) {
        if (state?.rollback) await state.rollback(preimage);
        throw error;
      }
    },
    async pending() { return null; }
  });
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
    const tracked = git(root, ['cat-file', '-e', `HEAD:${relative}`]).status === 0;
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
 * At a command's start, in a checkout that has a state checkout [REQ-006]: when the checkout is on a Story branch whose
 * records are on a local state ref, the state checkout is made right for that Story (repaired, made again, or moved
 * to its ref when clean), and the Story's layout and pinned configuration are remembered for the command. A checkout
 * on any other branch reads its own configuration, as today. It never refuses unless `required`: a command that needs
 * the records says so itself.
 */
export async function adoptStateCheckout(root, { required = false } = {}) {
  const current = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const id = current.status === 0 ? String(current.stdout).trim() : '';
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
  const shown = git(root, ['show', `${tip}:workflow.json`]);
  if (shown.status !== 0) return null;
  let workflow;
  try { workflow = JSON.parse(shown.stdout); } catch { return null; }
  if (workflow?.workItem?.id !== reference) return null;
  rememberStoryLayout(root, reference, 'state-ref');
  const canonicalBranch = String(workflow.lineage?.canonicalBranch ?? workflow.workItem.branch ?? reference);
  return { ref, commit: tip, fetched, subject: { kind: 'story', id: reference, canonicalBranch, branches: [canonicalBranch],
    aliases: [reference], state: workflow, source: 'state-ref', location: { source: 'state-ref', ref, commit: tip } } };
}

/** The state commit that finished a state-ref Story's start (it holds workflow.json), or null [SSB M2]. */
export function stateStartCompleted(root, { ref }) {
  const tip = refTip(root, ref);
  return tip && git(root, ['cat-file', '-e', `${tip}:workflow.json`]).status === 0 ? tip : null;
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
 * Open a NEW Story's records at its start [REQ-002, 003, 006]: the exclude line, the state ref and the checkout, in
 * that order. Its layout is remembered for this process.
 */
export async function openStoryState(root, id, { definition = null } = {}) {
  await excludeStateCheckout(root);
  const created = createStateRef(root, id, { definition });
  const checkout = await ensureStateCheckout(root, id, { definition });
  return { ref: created.ref, commit: created.commit, checkout: checkout.path };
}
