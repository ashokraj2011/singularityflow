import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { SingularityFlowError, invariant, run } from './util.mjs';

function git(args, options = {}) {
  // stdout is the data channel: `--json` callers parse this process's stdout, so a child git's
  // progress chatter ("[main abc1234] message", "branch 'main' set up to track...") must never
  // land there. Inherited git output is routed to the parent's stderr (fd 2) instead, which keeps
  // it visible in a terminal while leaving stdout pure for machine-readable output.
  if (options.stdio === 'inherit') return run('git', args, { ...options, stdio: ['inherit', 2, 'inherit'] });
  return run('git', args, options);
}

export function repoRoot(cwd = process.cwd()) {
  const result = git(['rev-parse', '--show-toplevel'], { cwd, allowFailure: true });
  if (result.status !== 0) throw new SingularityFlowError('Run Singularity Flow from inside a Git repository.');
  return path.resolve(result.stdout.trim());
}

export function branch(root) {
  const value = git(['branch', '--show-current'], { cwd: root }).stdout.trim();
  invariant(value, 'Detached HEAD is not supported.');
  return value;
}

/** Resolve the application branch without contacting the remote. */
export function defaultBranchName(root, config = {}, remote = null) {
  const configured = String(
    config?.defaultBaseBranch ?? config?.definition?.defaultBaseBranch ?? ''
  ).trim();
  if (configured) return configured;
  const remoteName = remote
    ?? config?.git?.remote
    ?? config?.definition?.git?.remote
    ?? 'origin';
  const symbolic = git(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remoteName}/HEAD`], {
    cwd: root,
    allowFailure: true
  }).stdout.trim();
  const prefix = `${remoteName}/`;
  return (symbolic.startsWith(prefix) ? symbolic.slice(prefix.length) : symbolic) || 'main';
}

/** Refuse an operation before it writes or commits on the application branch. */
export function assertNotDefaultBranch(root, config = {}, action = 'This operation') {
  const current = branch(root);
  const applicationBranch = defaultBranchName(root, config);
  if (current === applicationBranch) {
    throw new SingularityFlowError(
      `${action} cannot run on protected application branch '${applicationBranch}'. `
      + 'Switch to a governed Story, Epic, or configuration review branch first.'
    );
  }
  return current;
}

export function head(root) {
  return git(['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
}

export function gitDir(root) {
  const value = git(['rev-parse', '--absolute-git-dir'], { cwd: root }).stdout.trim();
  invariant(value, 'Unable to resolve the repository Git directory.');
  return path.resolve(value);
}

export function identity(root, { offline = false } = {}) {
  if (process.env.NODE_ENV === 'test' && process.env.SINGULARITY_FLOW_TEST_IDENTITY) {
    return { name: process.env.SINGULARITY_FLOW_TEST_IDENTITY, email: `${process.env.SINGULARITY_FLOW_TEST_IDENTITY.toLowerCase().replace(/\s+/g, '.')}@example.com`, login: null };
  }
  const name = git(['config', '--get', 'user.name'], { cwd: root, allowFailure: true }).stdout.trim();
  const email = git(['config', '--get', 'user.email'], { cwd: root, allowFailure: true }).stdout.trim();
  const github = offline
    ? { status: 1, stdout: '' }
    : run('gh', ['api', 'user', '--jq', '{login: .login, name: .name}'], { cwd: root, allowFailure: true });
  let account = {};
  if (github.status === 0) { try { account = JSON.parse(github.stdout); } catch { account = {}; } }
  return {
    name: account.name || name || process.env.USER || process.env.USERNAME || 'unknown-user',
    email: email || null,
    login: account.login || null
  };
}

export function validBranch(root, name) {
  if (git(['check-ref-format', '--branch', name], { cwd: root, allowFailure: true }).status !== 0) {
    throw new SingularityFlowError(`Invalid Git branch name: ${name}`);
  }
}

export function refExists(root, ref) {
  return git(['show-ref', '--verify', '--quiet', ref], { cwd: root, allowFailure: true }).status === 0;
}

export function hasRemote(root, remote = 'origin') {
  return git(['remote', 'get-url', remote], { cwd: root, allowFailure: true }).status === 0;
}

export function changes(root) {
  return git(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root }).stdout;
}

export function assertClean(root) {
  if (changes(root).trim()) throw new SingularityFlowError('Working tree is not clean. Commit or stash changes, or pass --allow-dirty deliberately.');
}

export function fetchRemote(root, remote = 'origin') {
  if (!hasRemote(root, remote)) return;
  // Managed workspaces used to be cloned with --single-branch, leaving the configured fetch
  // refspec pinned to main. A normal `git fetch origin` then never discovered Epic and Story
  // branches created by another machine, so the desktop could create a conflicting local branch
  // and only discover the collision when push was rejected. Broaden the named remote once and
  // fetch its branch namespace. Persisting the refspec is important: Git will not recognize a
  // fetched ref as a valid upstream if that ref is outside remote.<name>.fetch.
  const trackingProbe = `refs/remotes/${remote}/singularity-flow-probe`;
  if (git(['check-ref-format', trackingProbe], { cwd: root, allowFailure: true }).status !== 0) {
    throw new SingularityFlowError(`Git remote '${remote}' cannot be used as a remote-tracking namespace.`);
  }
  git(['remote', 'set-branches', remote, '*'], { cwd: root });
  git(['fetch', '--prune', remote], { cwd: root, stdio: 'inherit' });
}

export function fetchOrigin(root) { return fetchRemote(root, 'origin'); }

export function hasUpstream(root) {
  return git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: root, allowFailure: true }).status === 0;
}

export function pullFastForward(root) {
  if (hasUpstream(root)) git(['pull', '--ff-only'], { cwd: root, stdio: 'inherit' });
}

function configureUpstream(root, name, remote) {
  // `git branch --set-upstream-to origin/name` refuses a perfectly valid remote-tracking ref
  // when the clone's original fetch refspec was --single-branch. Record the standard upstream
  // pair directly so existing managed clones can be repaired without rewriting unrelated config.
  git(['config', '--local', `branch.${name}.remote`, remote], { cwd: root });
  git(['config', '--local', `branch.${name}.merge`, `refs/heads/${name}`], { cwd: root });
}

export function checkout(root, name, {
  base = 'main',
  fetch = false,
  existingOnly = false,
  remote = 'origin',
  preferRemoteBase = fetch
} = {}) {
  validBranch(root, name);
  if (fetch) fetchRemote(root, remote);
  if (branch(root) === name) {
    if (fetch && refExists(root, `refs/remotes/${remote}/${name}`)) {
      if (!hasUpstream(root)) {
        configureUpstream(root, name, remote);
      }
      pullFastForward(root);
    }
    return 'already-current';
  }
  if (refExists(root, `refs/heads/${name}`)) {
    git(['switch', name], { cwd: root, stdio: 'inherit' });
    if (fetch && refExists(root, `refs/remotes/${remote}/${name}`)) {
      if (!hasUpstream(root)) {
        configureUpstream(root, name, remote);
      }
      pullFastForward(root);
    }
    return 'checked-out-local';
  }
  if (refExists(root, `refs/remotes/${remote}/${name}`)) {
    git(['switch', '--no-track', '-c', name, `${remote}/${name}`], { cwd: root, stdio: 'inherit' });
    configureUpstream(root, name, remote);
    return 'tracked-remote';
  }
  if (existingOnly) throw new SingularityFlowError(`Branch ${name} does not exist locally or on ${remote}.`);
  // A fetched start must fork from the ref that was just refreshed. Preferring a stale local
  // `main` here silently excluded configuration and world-model commits already merged upstream.
  // Callers that deliberately work offline retain the historical local-first behavior.
  const remoteBase = refExists(root, `refs/remotes/${remote}/${base}`) ? `${remote}/${base}` : null;
  const localBase = refExists(root, `refs/heads/${base}`) ? base : null;
  const baseRef = preferRemoteBase
    ? remoteBase ?? localBase ?? 'HEAD'
    : localBase ?? remoteBase ?? 'HEAD';
  git(['switch', '-c', name, baseRef], { cwd: root, stdio: 'inherit' });
  return `created-from-${baseRef}`;
}

export function refHead(root, ref) {
  const result = git(['rev-parse', '--verify', ref], { cwd: root, allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function fastForwardTo(root, ref) {
  git(['merge', '--ff-only', ref], { cwd: root, stdio: 'inherit' });
  return head(root);
}

export function remoteBranches(root, remote = 'origin') {
  if (!hasRemote(root, remote)) return [];
  const prefix = `refs/remotes/${remote}/`;
  return git(['for-each-ref', '--format=%(refname)', prefix], { cwd: root }).stdout
    .split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    .map((ref) => ref.slice(prefix.length)).filter((name) => name && name !== 'HEAD');
}

/**
 * Local branch names, excluding the one checked out.
 *
 * An Epic whose branch exists only locally — because its push failed, or the remote is not
 * reachable — is otherwise invisible from every other branch: not in the working tree, not on the
 * remote, and so absent from the Epic list while `initiative start` still refuses to create it.
 */
export function localBranches(root) {
  const prefix = 'refs/heads/';
  const current = branch(root);
  return git(['for-each-ref', '--format=%(refname)', prefix], { cwd: root }).stdout
    .split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    .map((ref) => ref.slice(prefix.length)).filter((name) => name && name !== current);
}

export function fileAtRef(root, ref, file) {
  const result = git(['show', `${ref}:${file}`], { cwd: root, allowFailure: true });
  return result.status === 0 ? result.stdout : null;
}

function nullList(value) {
  return value.split('\0').filter(Boolean);
}

export function changedFiles(root) {
  const unstaged = nullList(git(['diff', '--name-only', '-z', 'HEAD'], { cwd: root }).stdout);
  const staged = nullList(git(['diff', '--name-only', '-z', '--cached', 'HEAD'], { cwd: root }).stdout);
  const untracked = nullList(git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root }).stdout);
  return [...new Set([...unstaged, ...staged, ...untracked])].sort();
}

export function add(root, paths) {
  if (paths.length) git(['add', '-A', '--', ...paths], { cwd: root });
}

/**
 * Commit, optionally restricted to the paths the caller actually staged.
 *
 * Without `paths` this is `git commit -m`, which commits the whole index — everything the caller
 * staged *and* everything the person at the keyboard had staged before running the command. Callers
 * throughout this codebase `add()` a precise set and then commit, and read as though the commit were
 * bounded by that set; it never was. A developer with `git add src/payments/refund.ts` outstanding
 * got that file inside the governed approval commit, which is then pushed, pinned by the ledger and
 * attested to by the gate. In a product whose whole claim is that the record is exact, the record
 * quietly described a commit nobody reviewed.
 *
 * `--only` commits the given paths from the working tree and ignores the rest of the index, which is
 * the semantic every caller here already assumed. It is the same idiom the world-model publisher has
 * always used.
 */
export function commit(root, message, paths = null) {
  const scope = paths?.length ? ['--only', '--', ...paths] : [];
  git(['commit', '-m', message, ...scope], { cwd: root, stdio: 'inherit' });
  return head(root);
}

/**
 * Create a governed commit without borrowing the contributor's Git index.
 *
 * The lifecycle engine writes governed files into the worktree, but a contributor may already
 * have unrelated work staged. A normal `git add` mutates that index even when `git commit --only`
 * keeps those files out of the resulting commit. This plumbing transaction builds the commit from
 * a temporary index, advances the branch with compare-and-swap semantics, and then refreshes only
 * the governed entries in the real index. Existing staged content is therefore neither committed
 * nor rewritten.
 *
 * Arbitrary repository commit hooks are intentionally not run: lifecycle publication has already
 * executed its deterministic validators before entering this function. Callers that require signed
 * commits can request `commitSpec.sign`; `git commit-tree` then uses the configured signing key.
 */
export async function commitIsolated(root, message, paths, {
  expectedHead = head(root),
  sign = false,
  signingKey = null,
  fault = null
} = {}) {
  const scope = [...new Set((paths ?? []).filter(Boolean))];
  if (!scope.length) throw new SingularityFlowError('Governed publication requires at least one allowed path.');

  const stagedOverlap = git(['diff', '--cached', '--name-only', '-z', expectedHead, '--', ...scope], { cwd: root }).stdout
    .split('\0').filter(Boolean);
  if (stagedOverlap.length) {
    throw new SingularityFlowError(
      `Governed publication cannot replace already staged governed path(s): ${stagedOverlap.join(', ')}. `
      + 'Commit or unstage those paths, then retry.'
    );
  }

  const temporaryRoot = path.join(gitDir(root), 'singularity-flow', 'temporary-indexes');
  await mkdir(temporaryRoot, { recursive: true });
  const scratch = await mkdtemp(path.join(temporaryRoot, 'publication-'));
  const indexPath = path.join(scratch, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  let refAdvanced = false;
  let sourceCommit = null;
  try {
    git(['read-tree', expectedHead], { cwd: root, env });
    if (fault) await fault('before-staging', { expectedHead, paths: scope });
    git(['add', '-A', '--', ...scope], { cwd: root, env });
    if (fault) await fault('after-staging', { expectedHead, paths: scope });

    const tree = git(['write-tree'], { cwd: root, env }).stdout.trim();
    const priorTree = git(['rev-parse', `${expectedHead}^{tree}`], { cwd: root }).stdout.trim();
    if (tree === priorTree) throw new SingularityFlowError('No governed changes are ready to commit.');

    const signing = sign ? [signingKey ? `-S${signingKey}` : '-S'] : [];
    sourceCommit = git(
      ['commit-tree', tree, '-p', expectedHead, ...signing, '-m', message],
      { cwd: root, env }
    ).stdout.trim();
    if (fault) await fault('after-commit-object', { expectedHead, sourceCommit, tree });

    const ref = git(['symbolic-ref', '-q', 'HEAD'], { cwd: root }).stdout.trim();
    const update = git(['update-ref', ref, sourceCommit, expectedHead], { cwd: root, allowFailure: true });
    if (update.status !== 0) {
      throw new SingularityFlowError(
        `Governed publication lost its branch-head race: ${(update.stderr || update.stdout).trim() || 'compare-and-swap failed'}. `
        + 'Reload the lifecycle state and retry.'
      );
    }
    refAdvanced = true;

    // The real index still describes the old HEAD. Refresh only governed entries so they do not
    // appear as synthetic staged reversions; unrelated staged entries remain byte-for-byte intact.
    git(['reset', '-q', sourceCommit, '--', ...scope], { cwd: root });
    if (fault) await fault('after-ref-update', { expectedHead, sourceCommit, tree });
    return sourceCommit;
  } catch (error) {
    // Before update-ref succeeds, every object/index artefact is unreachable scratch data. Once the
    // ref advances, the commit is durable and must be recovered/published rather than rolled back.
    error.publicationRefAdvanced = refAdvanced;
    error.publicationCommit = refAdvanced ? sourceCommit : null;
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function pushBranch(root, remote = 'origin', branchName = branch(root)) {
  // Capture stderr so desktop and recovery records contain Git's real rejection reason. Callers
  // already surface their own success result, while an inherited child left error="" and reduced
  // every failure to the unhelpful generic "fix remote access" message.
  return git(['push', '-u', remote, `HEAD:${branchName}`], { cwd: root, allowFailure: true });
}

export function remoteContains(root, sha, remote = 'origin', branchName = branch(root)) {
  if (!sha || !refExists(root, `refs/remotes/${remote}/${branchName}`)) return false;
  return git(['merge-base', '--is-ancestor', sha, `refs/remotes/${remote}/${branchName}`], { cwd: root, allowFailure: true }).status === 0;
}
