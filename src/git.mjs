import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// Synchronous, because `identity()` is synchronous and called from synchronous code throughout.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { SingularityFlowError, invariant, run } from './util.mjs';
import { runRemoteGit } from './git-execution.mjs';
import { scopedReadSync } from './read-scope.mjs';
import { scanEntries, secretRefusal } from './secrets.mjs';

function git(args, options = {}) {
  // stdout is the data channel: `--json` callers parse this process's stdout, so a child git's
  // progress chatter ("[main abc1234] message", "branch 'main' set up to track...") must never
  // land there. Inherited git output is routed to the parent's stderr (fd 2) instead, which keeps
  // it visible in a terminal while leaving stdout pure for machine-readable output.
  if (options.stdio === 'inherit') return run('git', args, { ...options, stdio: ['inherit', 2, 'inherit'] });
  return run('git', args, options);
}

/**
 * Where the repository is, and where its Git directory is — asked once per process.
 *
 * Neither can change while a process runs: a repository does not move out from under a command, and
 * if it did, every path already resolved would be wrong anyway. They were being recomputed
 * constantly — one `snapshot --json` spent 148 ms on 20 subprocesses re-answering these two
 * questions (15 × `--absolute-git-dir`, 5 × `--show-toplevel`).
 *
 * Deliberately NOT applied to `head()`: HEAD genuinely changes mid-process, because the write paths
 * read it before and after committing. Caching that would make a publication report the commit it
 * replaced.
 */
const repoRootCache = new Map();
const gitDirCache = new Map();
const gitCommonDirCache = new Map();

export function repoRoot(cwd = process.cwd()) {
  if (repoRootCache.has(cwd)) return repoRootCache.get(cwd);
  const result = git(['rev-parse', '--show-toplevel'], { cwd, allowFailure: true });
  // Only a success is cached: a failure is a thrown error, and a later call from a different cwd
  // inside a repository must still be able to succeed.
  if (result.status !== 0) throw new SingularityFlowError('Run Singularity Flow from inside a Git repository.');
  const resolved = path.resolve(result.stdout.trim());
  repoRootCache.set(cwd, resolved);
  return resolved;
}

/**
 * The checked-out branch, read once per read scope. `[UXH:REQ-120]`
 *
 * Measured at 9–11 calls per `snapshot --json`, unmemoized, while `repoRoot` and `gitDir` beside it
 * have had module-level caches for as long as they have existed. The asymmetry is not an oversight:
 * a repository root does not move under a running process and **a branch does** — `start`, `publish`
 * and `resume` all check one out mid-run, and a module-level memo here would hand them the branch
 * they left rather than the one they are on. That is a correctness bug, not a stale number.
 *
 * The read scope is what makes it safe. It is opened only by operations that declare themselves
 * read-only, so nothing that can switch a branch is ever inside one, and outside a scope this is
 * the plain Git call it always was.
 */
export function branch(root) {
  return scopedReadSync(`git.branch:${root}`, () => {
    const value = git(['branch', '--show-current'], { cwd: root }).stdout.trim();
    invariant(value, 'Detached HEAD is not supported.');
    return value;
  });
}

/** Branch names that are an application integration target in essentially every repository. */
export const RESERVED_APPLICATION_BRANCHES = Object.freeze(['main', 'master']);

function configuredDefaultBranch(config = {}) {
  return String(config?.defaultBaseBranch ?? config?.definition?.defaultBaseBranch ?? '').trim();
}

/** The remote's own default branch, or null when the clone does not record one. */
export function remoteDefaultBranchName(root, config = {}, remote = null) {
  const remoteName = remote
    ?? config?.git?.remote
    ?? config?.definition?.git?.remote
    ?? 'origin';
  const symbolic = git(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remoteName}/HEAD`], {
    cwd: root,
    allowFailure: true
  }).stdout.trim();
  const prefix = `${remoteName}/`;
  return (symbolic.startsWith(prefix) ? symbolic.slice(prefix.length) : symbolic) || null;
}

/** Resolve the branch work is cut from, without contacting the remote. */
export function defaultBranchName(root, config = {}, remote = null) {
  return configuredDefaultBranch(config) || remoteDefaultBranchName(root, config, remote) || 'main';
}

/**
 * Every branch that must never receive a governed commit directly.
 *
 * Deliberately a set rather than the single answer `defaultBranchName` gives. Those are different
 * questions: `defaultBaseBranch` says what work is *cut from*, which under gitflow is `develop` —
 * and `main` is still the protected one. Resolving only the configured value left `main` unguarded
 * in exactly the repositories most likely to protect it. `validateId` already reserved a set for
 * the same reason; this is the same vocabulary for the branch guard.
 */
export function protectedBranchNames(root, config = {}, remote = null) {
  return new Set([
    ...RESERVED_APPLICATION_BRANCHES,
    configuredDefaultBranch(config),
    remoteDefaultBranchName(root, config, remote)
  ].filter(Boolean));
}

/** Refuse an operation before it writes or commits on a protected application branch. */
export function assertNotDefaultBranch(root, config = {}, action = 'This operation') {
  const current = branch(root);
  if (protectedBranchNames(root, config).has(current)) {
    throw new SingularityFlowError(
      `${action} cannot run on protected application branch '${current}'. `
      + 'Switch to a governed Story, Epic, or configuration review branch first.'
    );
  }
  return current;
}

export function head(root) {
  return git(['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
}

export function gitDir(root) {
  if (gitDirCache.has(root)) return gitDirCache.get(root);
  const value = git(['rev-parse', '--absolute-git-dir'], { cwd: root }).stdout.trim();
  invariant(value, 'Unable to resolve the repository Git directory.');
  const resolved = path.resolve(value);
  gitDirCache.set(root, resolved);
  return resolved;
}

/**
 * Repository-wide Git storage shared by the main checkout and every linked worktree.
 *
 * `--absolute-git-dir` intentionally points at a worktree-private directory. Durable control-plane
 * records and mutation locks are repository concerns, so putting them there makes the same repair
 * disappear when a command is run from its isolated worktree. Resolve `--git-common-dir` and make
 * relative answers absolute against the caller's checkout.
 */
export function gitCommonDir(root) {
  if (gitCommonDirCache.has(root)) return gitCommonDirCache.get(root);
  const value = git(['rev-parse', '--git-common-dir'], { cwd: root }).stdout.trim();
  invariant(value, 'Unable to resolve the repository common Git directory.');
  const resolved = path.resolve(root, value);
  gitCommonDirCache.set(root, resolved);
  return resolved;
}

/**
 * How long a resolved GitHub account is reused from disk. `[perf]`
 *
 * `gh api user` is a ~460 ms network round trip, and a process memo cannot help the VS Code
 * extension: every refresh is a brand-new CLI process, so it paid the full cost on each of its 25
 * refresh triggers.
 *
 * Caching rather than going offline was the original choice, and the reasoning still holds: passing
 * `{ offline: true }` on its own would have made `identities.github` null — turning a slow but
 * truthful disclosure into a fast and wrong one, on a surface reviewers use to see who is acting.
 *
 * What that reasoning missed is that the two are not exclusive. A read path can consult the cache and
 * decline to *populate* it, which is fast and truthful together: warm, the login is real and free;
 * cold, the login is null and the record says the lookup was never attempted. The one case the cache
 * could never fix was the cold one, and that is precisely when a person is sitting in front of an
 * empty sidebar waiting — measured at 965 ms on this machine.
 */
const GITHUB_ACCOUNT_TTL_MS = 10 * 60 * 1000;

/**
 * How the GitHub login was arrived at, so a null never has to be guessed at.
 *
 * `unavailable` means the lookup ran and produced nothing: signed out, no `gh`, network refused.
 * `not-checked` means it was never attempted. Reporting the second as the first tells a reader their
 * account is signed out on the evidence of nobody having looked.
 */
export const GITHUB_LOOKUP = Object.freeze({
  RESOLVED: 'resolved',
  NOT_CHECKED: 'not-checked',
  UNAVAILABLE: 'unavailable'
});

function githubAccountCacheFile(root) {
  return path.join(root, '.git', 'singularity-flow', 'github-account.json');
}

/**
 * `gh api user`, reused from disk while fresh. Shaped like a `run()` result, plus how it was obtained.
 *
 * `cacheOnly` is the read-model contract: answer from the cache if it is fresh, and otherwise return
 * "not checked" rather than spawning. No read path may put a network round trip in front of a person.
 */
function cachedGithubAccount(root, { cacheOnly = false } = {}) {
  const file = githubAccountCacheFile(root);
  try {
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    if (Date.now() - cached.at < GITHUB_ACCOUNT_TTL_MS) return { status: 0, stdout: cached.stdout, lookup: GITHUB_LOOKUP.RESOLVED };
  } catch { /* No cache, unreadable, or unparseable is simply a miss. */ }
  if (cacheOnly) return { status: 1, stdout: '', lookup: GITHUB_LOOKUP.NOT_CHECKED };

  const result = run('gh', ['api', 'user', '--jq', '{login: .login, name: .name}'], { cwd: root, allowFailure: true });
  // Only a success is written. Caching a failure would make one offline moment look like a
  // signed-out account for the next ten minutes.
  if (result.status === 0) {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ at: Date.now(), stdout: result.stdout }));
    } catch { /* An unwritable .git is not a reason to fail a read. */ }
  }
  /**
   * A refusal to dial out is "not checked", not "unavailable" — `run()` reports the two apart, and
   * collapsing them here would put the wrong one in every disclosure downstream.
   */
  const lookup = result.status === 0
    ? GITHUB_LOOKUP.RESOLVED
    : (result.blocked ? GITHUB_LOOKUP.NOT_CHECKED : GITHUB_LOOKUP.UNAVAILABLE);
  return { ...result, lookup };
}

/** The repository's configured presentation name, without account or environment fallbacks. */
export function localGitDisplayName(root) {
  return git(['config', '--get', 'user.name'], { cwd: root, allowFailure: true }).stdout.trim() || null;
}

/**
 * The identity Git will put on a commit, without consulting GitHub or any other network service.
 *
 * Authoring a temporary configuration commit used to call `identity()`. Every temporary clone has
 * a different `.git` directory, so the GitHub-account cache could never hit and one capability
 * proposal paid for the same `gh api user` request twice. Commit authorship needs only the two Git
 * configuration values; account membership is resolved separately at approval boundaries.
 */
export function gitCommitIdentity(root) {
  if (process.env.NODE_ENV === 'test' && process.env.SINGULARITY_FLOW_TEST_IDENTITY) {
    return {
      name: process.env.SINGULARITY_FLOW_TEST_IDENTITY,
      email: `${process.env.SINGULARITY_FLOW_TEST_IDENTITY.toLowerCase().replace(/\s+/g, '.')}@example.com`,
      login: null,
      githubLookup: GITHUB_LOOKUP.NOT_CHECKED
    };
  }
  return {
    name: localGitDisplayName(root) || process.env.USER || process.env.USERNAME || 'Singularity Flow',
    email: git(['config', '--get', 'user.email'], { cwd: root, allowFailure: true }).stdout.trim() || null,
    login: null,
    githubLookup: GITHUB_LOOKUP.NOT_CHECKED
  };
}

export function identity(root, { offline = false } = {}) {
  if (process.env.NODE_ENV === 'test' && process.env.SINGULARITY_FLOW_TEST_IDENTITY) {
    return {
      name: process.env.SINGULARITY_FLOW_TEST_IDENTITY,
      email: `${process.env.SINGULARITY_FLOW_TEST_IDENTITY.toLowerCase().replace(/\s+/g, '.')}@example.com`,
      login: null,
      githubLookup: GITHUB_LOOKUP.NOT_CHECKED
    };
  }
  /**
   * Deliberately NOT memoized, though it is the obvious thing to do here.
   *
   * The local Git identity genuinely changes within a process, and the product depends on noticing:
   * `action-authorization` refuses to transfer a one-time authorization to a different local
   * identity, and a process memo makes that check answer with whoever asked first. A caching bug
   * here is an authorization bug, not a stale label.
   *
   * The expense was never these two `git config` reads (~23 ms); it was the `gh` call below, which
   * is cached on disk where the value really is stable.
   */
  const name = localGitDisplayName(root) ?? '';
  const email = git(['config', '--get', 'user.email'], { cwd: root, allowFailure: true }).stdout.trim();
  /**
   * `offline` no longer means "pretend there is no account". It means "do not dial out for one" —
   * a fresh cache still answers, and only a cold one degrades to a declared non-answer.
   */
  const github = cachedGithubAccount(root, { cacheOnly: offline });
  let account = {};
  if (github.status === 0) { try { account = JSON.parse(github.stdout); } catch { account = {}; } }
  const resolved = {
    name: account.name || name || process.env.USER || process.env.USERNAME || 'unknown-user',
    email: email || null,
    login: account.login || null,
    githubLookup: github.lookup
  };
  return resolved;
}

/**
 * Drop every per-process Git memo.
 *
 * Only tests need this. A real process never outlives a change of signed-in account or a repository
 * moving, but a test suite creates, deletes and recreates repositories at the same temporary path,
 * where a path-keyed memo would hand back the previous repository's answer.
 */
export function resetGitProcessCaches() {
  repoRootCache.clear();
  gitDirCache.clear();
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
  runRemoteGit(['fetch', '--prune', remote], {
    cwd: root, operation: 'remote-configuration', allowFailure: false
  });
}

export function fetchOrigin(root) { return fetchRemote(root, 'origin'); }

export function hasUpstream(root) {
  return git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: root, allowFailure: true }).status === 0;
}

export function pullFastForward(root) {
  if (hasUpstream(root)) runRemoteGit(['pull', '--ff-only'], {
    cwd: root, operation: 'remote-configuration', allowFailure: false
  });
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

/** Files Git does not track and `.gitignore` does not exclude. */
export function untrackedFiles(root) {
  return nullList(git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root }).stdout);
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
/**
 * Refuse the commit if the content going into it contains a credential.
 *
 * Placed here rather than in each caller because this file owns both ways a commit is made, and a
 * gate that each caller has to remember to invoke is a gate that the next caller forgets. Every
 * governed publication and every plain `commit()` in this codebase passes through one of the two.
 *
 * It scans what is *about to be committed*, resolved the same way the commit resolves it: the
 * working-tree content of the named paths for a scoped commit, and the staged content when the
 * whole index is being committed. Scanning the working tree instead would pass a file whose clean
 * version is on disk and whose staged version has the key in it.
 *
 * Deleted paths are skipped, not failed. A commit that removes a file containing a credential is
 * the commit you want to succeed.
 */
export function assertNoSecrets(root, paths = null, { label = 'This commit' } = {}) {
  const listed = paths?.length
    ? [...new Set(paths.filter(Boolean))]
    : git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], { cwd: root, allowFailure: true })
      .stdout.split('\0').filter(Boolean);
  if (!listed.length) return null;

  const entries = [];
  for (const item of listed) {
    // A scoped commit takes the working tree; an index commit takes the staged blob. Read whichever
    // one this commit will actually use.
    if (paths?.length) {
      const absolute = path.resolve(root, item);
      let content;
      try {
        const stat = statSync(absolute);
        // A path may name a directory the caller staged wholesale; expand it to its tracked files.
        if (stat.isDirectory()) {
          const tracked = git(['ls-files', '-z', '--', item], { cwd: root, allowFailure: true })
            .stdout.split('\0').filter(Boolean);
          for (const file of tracked) {
            entries.push({ path: file, content: readFileSync(path.resolve(root, file), 'utf8') });
          }
          continue;
        }
        content = readFileSync(absolute, 'utf8');
      } catch (error) {
        // ENOENT is a deletion. Anything else is unreadable, and unreadable fails closed inside
        // `scanEntries` by arriving with no content.
        if (error?.code === 'ENOENT') continue;
        entries.push({ path: item });
        continue;
      }
      entries.push({ path: item, content });
    } else {
      const show = git(['show', `:${item}`], { cwd: root, allowFailure: true });
      if (show.status !== 0) continue;
      entries.push({ path: item, content: show.stdout });
    }
  }

  const scan = scanEntries(entries);
  const refusal = secretRefusal(scan);
  if (refusal) {
    throw new SingularityFlowError(`${label} was refused.\n\n${refusal}`, { code: 'SECRET_DETECTED' });
  }
  return scan;
}

export function commit(root, message, paths = null) {
  assertNoSecrets(root, paths);
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
  fault = null,
  transaction = null,
  onCommitCreated = null,
  onRefAdvanced = null
} = {}) {
  // Optional transaction roots may legitimately remain absent (for example an approval that was
  // allowed to harvest knowledge but found none). Git rejects an entirely unknown pathspec even
  // when `git add -A` is otherwise correct. Keep paths that exist now or were tracked at HEAD so
  // deletions are still staged; omit only roots that have never contained governed bytes.
  const scope = [...new Set((paths ?? []).filter(Boolean))].filter((candidate) =>
    existsSync(path.join(root, candidate))
      || Boolean(git(['ls-files', '-z', '--', candidate], { cwd: root }).stdout));
  if (!scope.length) throw new SingularityFlowError('Governed publication requires at least one allowed path.');

  const stagedOverlap = git(['diff', '--cached', '--name-only', '-z', expectedHead, '--', ...scope], { cwd: root }).stdout
    .split('\0').filter(Boolean);
  if (stagedOverlap.length) {
    throw new SingularityFlowError(
      `Governed publication cannot replace already staged governed path(s): ${stagedOverlap.join(', ')}. `
      + 'Commit or unstage those paths, then retry.'
    );
  }

  // Before the temporary index is built, so a refusal leaves no scratch directory behind.
  assertNoSecrets(root, scope, { label: 'Governed publication' });

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
    const boundTransaction = transaction?.id
      ? {
          ...transaction,
          stateSha256: transaction.stateSha256
            ?? transaction.stateSha256ForTree?.(tree)
            ?? null
        }
      : null;
    const transactionMessage = boundTransaction?.id
      ? `${message}\n\nSingularity-Flow-Transaction: ${transaction.id}`
        + `\nSingularity-Flow-Event-SHA256: ${boundTransaction.eventSha256 ?? 'none'}`
        + `\nSingularity-Flow-State-SHA256: ${boundTransaction.stateSha256 ?? 'none'}`
        + `\nSingularity-Flow-Publication-Mode: ${boundTransaction.publicationMode ?? 'required'}`
      : message;
    sourceCommit = git(
      ['commit-tree', tree, '-p', expectedHead, ...signing, '-m', transactionMessage],
      { cwd: root, env }
    ).stdout.trim();
    if (onCommitCreated) await onCommitCreated({ expectedHead, sourceCommit, tree, transaction: boundTransaction });
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
    if (onRefAdvanced) await onRefAdvanced({ expectedHead, sourceCommit, tree, transaction: boundTransaction });

    // The real index still describes the old HEAD. Refresh only governed entries so they do not
    // appear as synthetic staged reversions; unrelated staged entries remain byte-for-byte intact.
    git(['reset', '-q', sourceCommit, '--', ...scope], { cwd: root });
    if (fault) await fault('after-ref-update', { expectedHead, sourceCommit, tree });
    return sourceCommit;
  } catch (error) {
    // Before update-ref succeeds, every object/index artefact is unreachable scratch data. Once the
    // ref advances, the commit is durable and must be recovered/published rather than rolled back.
    error.publicationRefAdvanced = refAdvanced;
    // The exact commit object is useful to recovery even if compare-and-swap did not advance the
    // branch. `publicationRefAdvanced` remains the authority for deciding whether rollback is
    // allowed; callers must never infer that boundary from whatever HEAD happens to be later.
    error.publicationCommit = sourceCommit;
    error.publicationTree = sourceCommit
      ? git(['rev-parse', `${sourceCommit}^{tree}`], { cwd: root, allowFailure: true }).stdout.trim() || null
      : null;
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function pushBranch(root, remote = 'origin', branchName = branch(root)) {
  // Capture stderr so desktop and recovery records contain Git's real rejection reason. Callers
  // already surface their own success result, while an inherited child left error="" and reduced
  // every failure to the unhelpful generic "fix remote access" message.
  return runRemoteGit(['push', '-u', remote, `HEAD:refs/heads/${branchName}`], {
    cwd: root, operation: 'remote-push'
  });
}

/** Publish one previously proven commit as a Story branch without depending on current HEAD. */
export function pushCommitToBranch(root, remote, commitSha, branchName) {
  validBranch(root, branchName);
  const commit = git(['rev-parse', '--verify', `${commitSha}^{commit}`], {
    cwd: root, allowFailure: true
  });
  if (commit.status !== 0) {
    return { ...commit, stderr: commit.stderr || `Commit '${commitSha}' is not available locally.` };
  }
  const result = runRemoteGit([
    'push', remote, `${commit.stdout.trim()}:refs/heads/${branchName}`
  ], { cwd: root, operation: 'remote-push' });
  if (result.status === 0 && refExists(root, `refs/heads/${branchName}`)) {
    configureUpstream(root, branchName, remote);
  }
  return result;
}

/**
 * Prove that the configured remote will accept creation of a Story ref before the worktree moves.
 *
 * The source is an already-fetched remote base ref. `--dry-run` negotiates with the real remote and
 * exercises its authentication/authorization path without creating the destination branch. The
 * actual publication still uses HEAD after the governed commit exists.
 */
export function preflightPushBranch(root, remote, sourceRef, branchName) {
  validBranch(root, branchName);
  return runRemoteGit([
    'push', '--dry-run', '--porcelain', remote,
    `${sourceRef}:refs/heads/${branchName}`
  ], { cwd: root, operation: 'remote-push' });
}

export function remoteContains(root, sha, remote = 'origin', branchName = branch(root)) {
  if (!sha || !refExists(root, `refs/remotes/${remote}/${branchName}`)) return false;
  return git(['merge-base', '--is-ancestor', sha, `refs/remotes/${remote}/${branchName}`], { cwd: root, allowFailure: true }).status === 0;
}

/** Whether one exact commit is contained by another local commit/ref. */
export function commitIsAncestor(root, ancestor, descendant = 'HEAD') {
  if (!ancestor || !descendant) return false;
  return git(['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: root, allowFailure: true
  }).status === 0;
}

/** Read the immutable identity embedded in a governed transaction commit. */
export function governedCommitIdentity(root, sha) {
  const verified = git(['rev-parse', '--verify', `${sha}^{commit}`], { cwd: root, allowFailure: true });
  if (verified.status !== 0) return null;
  const commit = verified.stdout.trim();
  const tree = git(['rev-parse', `${commit}^{tree}`], { cwd: root }).stdout.trim();
  const parents = git(['show', '-s', '--format=%P', commit], { cwd: root }).stdout.trim().split(/\s+/).filter(Boolean);
  const message = git(['show', '-s', '--format=%B', commit], { cwd: root }).stdout;
  const trailer = (name) => {
    const matches = [...message.matchAll(new RegExp(`^${name}:\\s*(.+?)\\s*$`, 'gmi'))];
    return matches.length === 1 ? matches[0][1] : null;
  };
  return {
    commit,
    tree,
    parents,
    transactionId: trailer('Singularity-Flow-Transaction'),
    eventSha256: trailer('Singularity-Flow-Event-SHA256'),
    stateSha256: trailer('Singularity-Flow-State-SHA256'),
    publicationMode: trailer('Singularity-Flow-Publication-Mode')
  };
}
