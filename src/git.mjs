import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// Synchronous, because `identity()` is synchronous and called from synchronous code throughout.
import {
  accessSync, constants as FS_CONSTANTS, existsSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, statSync, writeFileSync
} from 'node:fs';
import { SingularityFlowError, invariant, run } from './util.mjs';
import { readLocalGitBlobs } from './git-blob-batch.mjs';
import { runRemoteGitAsync } from './git-execution.mjs';
import {
  classifyGitRemoteFailure, frozenRemoteTransport, safeGitDiagnosticReference
} from './git-remote-diagnostics.mjs';
import { withoutGitProcessOverrides } from './git-enterprise-environment.mjs';
import { scopedReadSync } from './read-scope.mjs';
import { scannablePath, scanEntries, secretRefusal } from './secrets.mjs';

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
function cachedGithubAccount(root, { cacheOnly = false, env = process.env } = {}) {
  const file = githubAccountCacheFile(root);
  try {
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    if (Date.now() - cached.at < GITHUB_ACCOUNT_TTL_MS) return { status: 0, stdout: cached.stdout, lookup: GITHUB_LOOKUP.RESOLVED };
  } catch { /* No cache, unreadable, or unparseable is simply a miss. */ }
  if (cacheOnly) return { status: 1, stdout: '', lookup: GITHUB_LOOKUP.NOT_CHECKED };

  const result = run('gh', ['api', 'user', '--jq', '{login: .login, name: .name}'], {
    cwd: root, env, allowFailure: true
  });
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
export function localGitDisplayName(root, { env = process.env } = {}) {
  return git(['config', '--get', 'user.name'], { cwd: root, env, allowFailure: true }).stdout.trim() || null;
}

/**
 * The identity Git will put on a commit, without consulting GitHub or any other network service.
 *
 * Authoring a temporary configuration commit used to call `identity()`. Every temporary clone has
 * a different `.git` directory, so the GitHub-account cache could never hit and one capability
 * proposal paid for the same `gh api user` request twice. Commit authorship needs only the two Git
 * configuration values; account membership is resolved separately at approval boundaries.
 */
export function gitCommitIdentity(root, { env = process.env } = {}) {
  if (env.NODE_ENV === 'test' && env.SINGULARITY_FLOW_TEST_IDENTITY) {
    return {
      name: env.SINGULARITY_FLOW_TEST_IDENTITY,
      email: `${env.SINGULARITY_FLOW_TEST_IDENTITY.toLowerCase().replace(/\s+/g, '.')}@example.com`,
      login: null,
      githubLookup: GITHUB_LOOKUP.NOT_CHECKED
    };
  }
  return {
    name: localGitDisplayName(root, { env }) || env.USER || env.USERNAME || 'Singularity Flow',
    email: git(['config', '--get', 'user.email'], { cwd: root, env, allowFailure: true }).stdout.trim() || null,
    login: null,
    githubLookup: GITHUB_LOOKUP.NOT_CHECKED
  };
}

const FALLBACK_COMMIT_IDENTITY = Object.freeze({
  name: 'Singularity Flow',
  email: 'unknown@invalid',
  source: 'service-fallback'
});
const COMMIT_IDENTITY_MAX_BYTES = 512;

function commitIdentityError(field, reason) {
  return new SingularityFlowError(
    `Git commit ${field} is invalid: ${reason}. Configure a valid user.name and user.email, then retry.`, {
      code: 'GIT_COMMIT_IDENTITY_INVALID',
      details: {
        field,
        nextAction: {
          command: 'git config --global user.name <NAME> && git config --global user.email <EMAIL>'
        }
      }
    }
  );
}

function normalizedCommitIdentityField(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw commitIdentityError(field, 'the configured value is empty');
  if (Buffer.byteLength(normalized, 'utf8') > COMMIT_IDENTITY_MAX_BYTES) {
    throw commitIdentityError(field, `the configured value exceeds ${COMMIT_IDENTITY_MAX_BYTES} UTF-8 bytes`);
  }
  if (/\0|\r|\n/u.test(normalized)) {
    throw commitIdentityError(field, 'NUL and line-break characters are not allowed');
  }
  if (/[<>]/u.test(normalized)) {
    throw commitIdentityError(field, "'<' and '>' are not allowed by Git identity syntax");
  }
  return normalized;
}

/**
 * Freeze the presentation identity used by isolated commits for one operation.
 *
 * This is deliberately separate from `identity()`: Git metadata is not approval authority. The
 * ordinary repository/global `user.*` configuration participates, while ambient author/committer
 * variables and repository selectors cannot substitute another identity after it has been frozen.
 */
export function resolveGitCommitIdentity(root = process.cwd(), {
  env = process.env
} = {}) {
  const queryEnv = withoutGitProcessOverrides(env);
  const identityOverrides = new Set([
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE'
  ]);
  // Windows environment names are case-insensitive. Remove every spelling so a lower/mixed-case
  // inherited override cannot survive beside the canonical value and win Node's environment
  // de-duplication when the isolated Git process is launched.
  for (const key of Object.keys(queryEnv)) {
    if (identityOverrides.has(key.toUpperCase())) delete queryEnv[key];
  }
  if (queryEnv.NODE_ENV === 'test' && queryEnv.SINGULARITY_FLOW_TEST_IDENTITY) {
    const name = normalizedCommitIdentityField(
      queryEnv.SINGULARITY_FLOW_TEST_IDENTITY, 'user.name'
    );
    const email = normalizedCommitIdentityField(
      `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`, 'user.email'
    );
    return Object.freeze({ name, email, source: 'configured' });
  }
  const configuredName = git(['config', '--get', 'user.name'], {
    cwd: root, env: queryEnv, allowFailure: true
  });
  const configuredEmail = git(['config', '--get', 'user.email'], {
    cwd: root, env: queryEnv, allowFailure: true
  });
  if (![0, 1].includes(configuredName.status) || ![0, 1].includes(configuredEmail.status)) {
    throw commitIdentityError('identity', 'Git could not read the configured presentation identity');
  }
  const namePresent = configuredName.status === 0;
  const emailPresent = configuredEmail.status === 0;
  // A wholly or partially absent presentation identity is not approval evidence. Preserve the
  // long-standing service metadata pair rather than mixing one configured field with a fabricated
  // counterpart. A value Git says exists but that is empty/malformed is explicit and is refused.
  if (!namePresent || !emailPresent) {
    if (namePresent) normalizedCommitIdentityField(configuredName.stdout, 'user.name');
    if (emailPresent) normalizedCommitIdentityField(configuredEmail.stdout, 'user.email');
    return FALLBACK_COMMIT_IDENTITY;
  }
  return Object.freeze({
    name: normalizedCommitIdentityField(configuredName.stdout, 'user.name'),
    email: normalizedCommitIdentityField(configuredEmail.stdout, 'user.email'),
    source: 'configured'
  });
}

/** Validate an explicitly threaded value instead of trusting a structurally similar object. */
export function validateGitCommitIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !['configured', 'service-fallback'].includes(value.source)) {
    throw commitIdentityError('identity', 'the frozen operation value is incomplete');
  }
  return Object.freeze({
    name: normalizedCommitIdentityField(value.name, 'user.name'),
    email: normalizedCommitIdentityField(value.email, 'user.email'),
    source: value.source
  });
}

/** Command-scoped Git configuration for a frozen identity. */
export function gitCommitIdentityArgs(value) {
  const commitIdentity = validateGitCommitIdentity(value);
  return ['-c', `user.name=${commitIdentity.name}`, '-c', `user.email=${commitIdentity.email}`];
}

/** Author and committer variables are forced too: Git gives them precedence over `-c user.*`. */
export function gitCommitIdentityEnvironment(sourceEnv, value) {
  const commitIdentity = validateGitCommitIdentity(value);
  const env = { ...(sourceEnv ?? process.env) };
  const identityOverrides = new Set([
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE'
  ]);
  for (const key of Object.keys(env)) {
    if (identityOverrides.has(key.toUpperCase())) delete env[key];
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: commitIdentity.name,
    GIT_AUTHOR_EMAIL: commitIdentity.email,
    GIT_COMMITTER_NAME: commitIdentity.name,
    GIT_COMMITTER_EMAIL: commitIdentity.email
  };
}

function signingConfigurationError(reason, setting = 'user.signingkey') {
  return new SingularityFlowError(
    `Git commit signing configuration is invalid: ${reason}. Configure a valid ${setting}, then retry.`, {
      code: 'GIT_COMMIT_SIGNING_INVALID',
      details: {
        setting,
        nextAction: {
          command: setting === 'user.signingkey'
            ? 'git config --global user.signingkey <KEY>'
            : `git config --global ${setting} <PROGRAM>`
        }
      }
    }
  );
}

const SIGNING_FORMATS = Object.freeze(['openpgp', 'ssh', 'x509']);

function normalizedSigningSetting(value, setting) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw signingConfigurationError(`${setting} is empty`, setting);
  if (Buffer.byteLength(normalized, 'utf8') > COMMIT_IDENTITY_MAX_BYTES
      || /\0|\r|\n/u.test(normalized)) {
    throw signingConfigurationError(
      `${setting} is malformed or exceeds ${COMMIT_IDENTITY_MAX_BYTES} UTF-8 bytes`, setting
    );
  }
  return normalized;
}

function signingProgramSetting(format) {
  return `gpg.${format}.program`;
}

/**
 * Return the program Git would select after processing its configuration in order.
 *
 * `gpg.program` is a legacy synonym only for `gpg.openpgp.program`. When both aliases
 * occur, Git's config parser applies the last occurrence, so querying each key independently and
 * preferring one would silently choose a different signer.
 */
function configuredSigningProgram(root, format, env) {
  const setting = signingProgramSetting(format);
  const pattern = format === 'openpgp'
    ? '^gpg\\.(program|openpgp\\.program)$'
    : `^gpg\\.${format}\\.program$`;
  const configured = git(['config', '--null', '--get-regexp', pattern], {
    cwd: root, env, allowFailure: true
  });
  if (configured.status === 1) return null;
  if (configured.status !== 0) {
    throw signingConfigurationError(`Git could not read ${setting}`, setting);
  }
  const records = String(configured.stdout ?? '').split('\0').filter(Boolean);
  if (!records.length) throw signingConfigurationError(`${setting} is empty`, setting);
  const selected = records.at(-1);
  const separator = selected.indexOf('\n');
  if (separator <= 0) throw signingConfigurationError(`${setting} is malformed`, setting);
  return normalizedSigningSetting(selected.slice(separator + 1), setting);
}

function environmentValue(env, name) {
  if (env?.[name] != null) return String(env[name]);
  if (process.platform !== 'win32') return '';
  const match = Object.keys(env ?? {}).find((key) => key.toLowerCase() === name.toLowerCase());
  return match ? String(env[match]) : '';
}

function expandedHomePath(value, env) {
  if (value !== '~' && !value.startsWith('~/') && !value.startsWith('~\\')) return value;
  const configuredHome = environmentValue(env, process.platform === 'win32' ? 'USERPROFILE' : 'HOME');
  const home = configuredHome && path.isAbsolute(configuredHome) ? configuredHome : os.homedir();
  return path.join(home, value.slice(2));
}

function executableExtensions(value, env) {
  if (process.platform !== 'win32' || path.extname(value)) return [''];
  const configured = environmentValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD';
  return ['', ...configured.split(';').map((entry) => entry.trim()).filter(Boolean)];
}

function usableExecutable(candidate) {
  try {
    const canonical = realpathSync.native(candidate);
    if (!statSync(canonical).isFile()) return null;
    accessSync(canonical, process.platform === 'win32' ? FS_CONSTANTS.F_OK : FS_CONSTANTS.X_OK);
    return canonical;
  } catch {
    return null;
  }
}

function resolveSigningProgram(root, configured, format, env) {
  // Leave Git's built-in default alone. Git for Windows can resolve its bundled signer from its own
  // installation even when that directory is absent from the extension host's PATH. Only an
  // explicitly configured program is configuration authority that must be frozen and carried.
  if (configured == null) return null;
  const setting = signingProgramSetting(format);
  const requested = normalizedSigningSetting(configured, setting);
  const expanded = expandedHomePath(requested, env);
  const pathLike = path.isAbsolute(expanded) || expanded.includes('/') || expanded.includes('\\');
  const bases = pathLike
    ? [path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded)]
    : environmentValue(env, 'PATH').split(path.delimiter)
      .map((directory) => path.resolve(root, directory || '.', expanded));
  for (const base of bases) {
    for (const extension of executableExtensions(base, env)) {
      const found = usableExecutable(`${base}${extension}`);
      if (found) return found;
    }
  }
  throw signingConfigurationError(
    `configured ${setting} is unavailable or not executable`, setting
  );
}

function sshSigningKey(root, value, env) {
  // Git accepts both the current `key::` form and the deprecated raw `ssh-*` public-key form.
  if (value.startsWith('key::') || value.startsWith('ssh-')) return value;
  const expanded = expandedHomePath(value, env);
  const candidate = path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded);
  try {
    const canonical = realpathSync.native(candidate);
    if (!statSync(canonical).isFile()) throw new Error('not a file');
    accessSync(canonical, FS_CONSTANTS.R_OK);
    return canonical;
  } catch {
    throw signingConfigurationError(
      'the SSH user.signingkey path is unavailable or unreadable', 'user.signingkey'
    );
  }
}

function assertFrozenSigningResources(signing) {
  const setting = signingProgramSetting(signing.format);
  if (signing.program != null
      && (!path.isAbsolute(signing.program) || !usableExecutable(signing.program))) {
    throw signingConfigurationError('the frozen signing program is unavailable or not executable', setting);
  }
  if (signing.format === 'ssh'
      && !signing.key.startsWith('key::') && !signing.key.startsWith('ssh-')) {
    if (!path.isAbsolute(signing.key)) {
      throw signingConfigurationError(
        'the frozen SSH user.signingkey path is not absolute', 'user.signingkey'
      );
    }
    try {
      if (!statSync(signing.key).isFile()) throw new Error('not a file');
      accessSync(signing.key, FS_CONSTANTS.R_OK);
    } catch {
      throw signingConfigurationError(
        'the frozen SSH user.signingkey path is unavailable or unreadable', 'user.signingkey'
      );
    }
  }
}

/** Capture only the key, format, and selected executable required by a signed isolated commit. */
export function resolveGitCommitSigning(root = process.cwd(), {
  env = process.env, required = false
} = {}) {
  if (!required) return Object.freeze({ required: false, key: null, format: null });
  const queryEnv = withoutGitProcessOverrides(env);
  const key = git(['config', '--get', 'user.signingkey'], {
    cwd: root, env: queryEnv, allowFailure: true
  });
  if (key.status === 1) {
    throw signingConfigurationError('required signing has no user.signingkey');
  }
  if (key.status !== 0) {
    throw signingConfigurationError('Git could not read user.signingkey');
  }
  if (!String(key.stdout ?? '').trim()) {
    throw signingConfigurationError('required signing has no user.signingkey');
  }
  const normalizedKey = normalizedSigningSetting(key.stdout, 'user.signingkey');
  const configuredFormat = git(['config', '--get', 'gpg.format'], {
    cwd: root, env: queryEnv, allowFailure: true
  });
  if (![0, 1].includes(configuredFormat.status)) {
    throw signingConfigurationError('Git could not read gpg.format', 'gpg.format');
  }
  const format = configuredFormat.status === 0
    ? String(configuredFormat.stdout ?? '').trim().toLowerCase()
    : 'openpgp';
  if (!SIGNING_FORMATS.includes(format)) {
    throw signingConfigurationError(`unsupported gpg.format '${format || '(empty)'}'`, 'gpg.format');
  }
  const configuredProgram = configuredSigningProgram(root, format, queryEnv);
  const program = resolveSigningProgram(root, configuredProgram, format, queryEnv);
  const frozenKey = format === 'ssh'
    ? sshSigningKey(root, normalizedKey, queryEnv)
    : normalizedKey;
  return Object.freeze({ required: true, key: frozenKey, format, program });
}

export function validateGitCommitSigning(value) {
  if (!value?.required) return Object.freeze({ required: false, key: null, format: null });
  const key = normalizedSigningSetting(value.key, 'user.signingkey');
  const format = String(value.format ?? '').trim().toLowerCase();
  if (!SIGNING_FORMATS.includes(format)) {
    throw signingConfigurationError(`unsupported gpg.format '${format || '(empty)'}'`, 'gpg.format');
  }
  const program = value.program == null
    ? null
    : normalizedSigningSetting(value.program, signingProgramSetting(format));
  const signing = Object.freeze({ required: true, key, format, program });
  assertFrozenSigningResources(signing);
  return signing;
}

export function gitCommitSigningArgs(value = null) {
  const signing = validateGitCommitSigning(value);
  if (!signing.required) return [];
  return [
    '-c', `user.signingkey=${signing.key}`,
    '-c', `gpg.format=${signing.format}`,
    ...(signing.program == null
      ? []
      : ['-c', `${signingProgramSetting(signing.format)}=${signing.program}`])
  ];
}

/** Ask Git itself to parse the frozen author and committer before any remote authority update. */
export function preflightGitCommitIdentity(root, value, {
  env = process.env, signing = null
} = {}) {
  const commitIdentity = validateGitCommitIdentity(value);
  const commitEnv = gitCommitIdentityEnvironment(env, commitIdentity);
  const args = gitCommitIdentityArgs(commitIdentity);
  const commitSigning = signing?.required ? validateGitCommitSigning(signing) : null;
  const signingArgs = commitSigning ? gitCommitSigningArgs(commitSigning) : [];
  for (const variable of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const parsed = git([...args, ...signingArgs, 'var', variable], {
      cwd: root, env: commitEnv, allowFailure: true
    });
    if (parsed.status !== 0 || !String(parsed.stdout ?? '').trim()) {
      throw commitIdentityError('identity', `Git rejected ${variable.toLowerCase()}`);
    }
  }
  if (commitSigning?.program != null) {
    const signingProgram = git([
      ...args, ...signingArgs, 'config', '--get', signingProgramSetting(commitSigning.format)
    ], { cwd: root, env: commitEnv, allowFailure: true });
    if (signingProgram.status !== 0
        || String(signingProgram.stdout ?? '').trim() !== commitSigning.program) {
      throw signingConfigurationError(
        'Git rejected the frozen signing program', signingProgramSetting(commitSigning.format)
      );
    }
  }
  return commitIdentity;
}

export function identity(root, { offline = false, env = process.env } = {}) {
  if (env.NODE_ENV === 'test' && env.SINGULARITY_FLOW_TEST_IDENTITY) {
    return {
      name: env.SINGULARITY_FLOW_TEST_IDENTITY,
      email: `${env.SINGULARITY_FLOW_TEST_IDENTITY.toLowerCase().replace(/\s+/g, '.')}@example.com`,
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
  const name = localGitDisplayName(root, { env }) ?? '';
  const email = git(['config', '--get', 'user.email'], { cwd: root, env, allowFailure: true }).stdout.trim();
  /**
   * `offline` no longer means "pretend there is no account". It means "do not dial out for one" —
   * a fresh cache still answers, and only a cold one degrades to a declared non-answer.
   */
  const github = cachedGithubAccount(root, { cacheOnly: offline, env });
  let account = {};
  if (github.status === 0) { try { account = JSON.parse(github.stdout); } catch { account = {}; } }
  const resolved = {
    name: account.name || name || env.USER || env.USERNAME || 'unknown-user',
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

export function hasRemote(root, remote = 'origin', { env = process.env } = {}) {
  return git(['remote', 'get-url', remote], { cwd: root, env, allowFailure: true }).status === 0;
}

export function changes(root) {
  return git(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root }).stdout;
}

export function assertClean(root) {
  if (changes(root).trim()) throw new SingularityFlowError('Working tree is not clean. Commit or stash changes, or pass --allow-dirty deliberately.');
}

export function prepareRemoteBranchTracking(root, remote = 'origin', { env = process.env } = {}) {
  if (!hasRemote(root, remote, { env })) return false;
  // Managed workspaces used to be cloned with --single-branch, leaving the configured fetch
  // refspec pinned to main. A normal `git fetch origin` then never discovered Epic and Story
  // branches created by another machine, so the desktop could create a conflicting local branch
  // and only discover the collision when push was rejected. Broaden the named remote once and
  // fetch its branch namespace. Persisting the refspec is important: Git will not recognize a
  // fetched ref as a valid upstream if that ref is outside remote.<name>.fetch.
  const trackingProbe = `refs/remotes/${remote}/singularity-flow-probe`;
  if (git(['check-ref-format', trackingProbe], { cwd: root, env, allowFailure: true }).status !== 0) {
    throw new SingularityFlowError(`Git remote '${remote}' cannot be used as a remote-tracking namespace.`);
  }
  git(['remote', 'set-branches', remote, '*'], { cwd: root, env });
  return true;
}

export async function fetchRemote(root, remote = 'origin', options = {}) {
  const transportRemote = options.transportRemote ?? remote;
  if (!prepareRemoteBranchTracking(root, remote)) return;
  const frozen = Object.hasOwn(options, 'transportRemote')
    ? frozenRemoteTransport(transportRemote)
    : null;
  const result = await runRemoteGitAsync([
    'fetch', '--prune', frozen?.remote ?? transportRemote,
    ...(frozen ? [`+refs/heads/*:refs/remotes/${remote}/*`] : [])
  ], {
    cwd: root, operation: 'remote-configuration', allowFailure: false,
    ...(frozen ? { env: frozen.env } : {})
  });
  if (result.status !== 0) {
    throw new SingularityFlowError(
      `Git fetch from '${remote}' failed. ${safeGitDiagnosticReference(result, 'Remote fetch failed')}`,
      { code: result.failure?.code ?? 'REMOTE_UNKNOWN' }
    );
  }
}

export async function fetchOrigin(root) { return fetchRemote(root, 'origin'); }

export function hasUpstream(root) {
  return git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: root, allowFailure: true }).status === 0;
}

export async function pullFastForward(root) {
  if (hasUpstream(root)) {
    const result = await runRemoteGitAsync(['pull', '--ff-only'], {
    cwd: root, operation: 'remote-configuration', allowFailure: false
    });
    if (result.status !== 0) {
      throw new SingularityFlowError(
        `Git fast-forward pull failed. ${safeGitDiagnosticReference(result, 'Remote pull failed')}`,
        { code: result.failure?.code ?? 'REMOTE_UNKNOWN' }
      );
    }
  }
}

function configureUpstream(root, name, remote) {
  // `git branch --set-upstream-to origin/name` refuses a perfectly valid remote-tracking ref
  // when the clone's original fetch refspec was --single-branch. Record the standard upstream
  // pair directly so existing managed clones can be repaired without rewriting unrelated config.
  git(['config', '--local', `branch.${name}.remote`, remote], { cwd: root });
  git(['config', '--local', `branch.${name}.merge`, `refs/heads/${name}`], { cwd: root });
}

export async function checkout(root, name, {
  base = 'main',
  fetch = false,
  fetched = false,
  existingOnly = false,
  remote = 'origin',
  preferRemoteBase = fetch
} = {}) {
  validBranch(root, name);
  if (fetch) await fetchRemote(root, remote);
  const synchronize = fetch || fetched;
  if (branch(root) === name) {
    if (synchronize && refExists(root, `refs/remotes/${remote}/${name}`)) {
      if (!hasUpstream(root)) {
        configureUpstream(root, name, remote);
      }
      // The exact remote-tracking ref was refreshed above or by the caller. Fast-forward to those
      // local bytes instead of asking the remote a second time through `git pull`.
      fastForwardTo(root, `${remote}/${name}`);
    }
    return 'already-current';
  }
  if (refExists(root, `refs/heads/${name}`)) {
    git(['switch', name], { cwd: root, stdio: 'inherit' });
    if (synchronize && refExists(root, `refs/remotes/${remote}/${name}`)) {
      if (!hasUpstream(root)) {
        configureUpstream(root, name, remote);
      }
      fastForwardTo(root, `${remote}/${name}`);
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

export function refHead(root, ref, { env = process.env } = {}) {
  const result = git(['rev-parse', '--verify', ref], { cwd: root, env, allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function fastForwardTo(root, ref) {
  git(['merge', '--ff-only', ref], { cwd: root, stdio: 'inherit' });
  return head(root);
}

export function remoteBranches(root, remote = 'origin', { env = process.env } = {}) {
  if (!hasRemote(root, remote, { env })) return [];
  const prefix = `refs/remotes/${remote}/`;
  return git(['for-each-ref', '--format=%(refname)', prefix], { cwd: root, env }).stdout
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
export function localBranches(root, { env = process.env } = {}) {
  const prefix = 'refs/heads/';
  const current = env === process.env
    ? branch(root)
    : git(['branch', '--show-current'], { cwd: root, env, allowFailure: true }).stdout.trim();
  return git(['for-each-ref', '--format=%(refname)', prefix], { cwd: root, env }).stdout
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
    : git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT'], { cwd: root, allowFailure: true })
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

function prospectiveGovernedTreeAndSecretScan(root, scope, expectedHead) {
  const temporaryRoot = path.join(gitDir(root), 'singularity-flow', 'temporary-indexes');
  mkdirSync(temporaryRoot, { recursive: true });
  const scratch = mkdtempSync(path.join(temporaryRoot, 'admission-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') };
  try {
    git(['read-tree', expectedHead], { cwd: root, env });
    // This is the exact operation used later by `commitIsolated`: nested untracked, non-ignored
    // files are part of the prospective index and therefore part of secret admission too.
    git(['add', '-A', '--', ...scope], { cwd: root, env });
    const tree = git(['write-tree'], { cwd: root, env }).stdout.trim();
    const listed = git([
      'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT', expectedHead,
      '--', ...scope
    ], { cwd: root, env }).stdout.split('\0').filter(Boolean);
    const stagedByPath = new Map();
    for (let offset = 0; offset < listed.length; offset += 512) {
      const stagedResult = git(['ls-files', '--stage', '-z', '--', ...listed.slice(offset, offset + 512)], {
        cwd: root, env, allowFailure: true
      });
      if (stagedResult.status !== 0) continue;
      for (const record of stagedResult.stdout.split('\0').filter(Boolean)) {
        const tab = record.indexOf('\t');
        const match = tab < 0 ? null
          : record.slice(0, tab).match(/^(100644|100755|120000|160000) ([a-f0-9]{40,64}) ([0-3])$/);
        if (!match) continue;
        const item = record.slice(tab + 1);
        const values = stagedByPath.get(item) ?? [];
        values.push({ mode: match[1], oid: match[2], stage: match[3] });
        stagedByPath.set(item, values);
      }
    }
    const descriptors = listed.map((item) => {
      const staged = stagedByPath.get(item) ?? [];
      const selected = staged.length === 1 && staged[0].stage === '0' ? staged[0] : null;
      const mode = selected?.mode ?? null;
      if (!mode) {
        throw new SingularityFlowError(
          `Cannot scan '${item}' for secrets: its prospective Git entry mode is unavailable.`,
          { code: 'SECRET_SCAN_UNREADABLE' }
        );
      }
      // The installed secret policy deliberately excludes bounded binary/evidence extensions.
      // Honor that policy only for ordinary blobs. A symlink named `proof.png` still contains a
      // textual target and must be scanned, while a gitlink or any future entry kind remains
      // unreadable rather than being mistaken for approved binary evidence.
      const forceScan = mode === '120000';
      if (mode === '160000') {
        throw new SingularityFlowError(
          `Cannot scan '${item}' for secrets: governed gitlinks are not admitted as binary evidence.`,
          { code: 'SECRET_SCAN_UNREADABLE' }
        );
      }
      return { path: item, mode, oid: selected.oid, forceScan };
    });
    const blobIds = descriptors.filter(({ mode, path: item }) =>
      mode === '120000' || scannablePath(item)).map(({ oid }) => oid);
    const blobs = readLocalGitBlobs(root, blobIds, {
      env,
      maximumObjectBytes: 64 * 1024 * 1024,
      code: 'SECRET_SCAN_UNREADABLE',
      label: 'Prospective publication secret scan'
    });
    const entries = descriptors.map(({ path: item, mode, oid, forceScan }) => {
      if (['100644', '100755'].includes(mode) && !scannablePath(item)) return { path: item };
      const bytes = blobs.get(oid);
      if (!bytes) {
        throw new SingularityFlowError(
          `Cannot scan '${item}' for secrets from the prospective publication tree.`,
          { code: 'SECRET_SCAN_UNREADABLE' }
        );
      }
      const content = bytes.toString('utf8');
      // Secret matching is a text operation. NUL-bearing or invalid UTF-8 bytes must never be
      // silently interpreted as clean merely because a path extension was unfamiliar.
      if (bytes.includes(0) || !Buffer.from(content, 'utf8').equals(bytes)) {
        throw new SingularityFlowError(
          `Cannot scan '${item}' for secrets: its prospective blob is binary or not valid UTF-8.`,
          { code: 'SECRET_SCAN_UNREADABLE' }
        );
      }
      return { path: item, content, forceScan };
    });
    const scan = scanEntries(entries);
    const refusal = secretRefusal(scan);
    if (refusal) {
      throw new SingularityFlowError(
        `Governed publication was refused.\n\n${refusal}`, { code: 'SECRET_DETECTED' }
      );
    }
    return tree;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Normalize and admit the exact path scope used by governed Candidate freeze and commit.
 *
 * Keeping this in the Git kernel prevents the verifier and publisher from interpreting optional,
 * deleted, or already-staged paths differently. Callers run it before retaining a Candidate;
 * `commitIsolated` repeats it at its own boundary to catch races after verification.
 */
export function admitGovernedPublication(root, paths, { expectedHead = head(root) } = {}) {
  const scope = [...new Set((paths ?? []).filter(Boolean))].filter((candidate) =>
    existsSync(path.join(root, candidate))
      || Boolean(git(['ls-files', '-z', '--', candidate], { cwd: root }).stdout));
  if (!scope.length) throw new SingularityFlowError('Governed publication requires at least one allowed path.');
  const stagedOverlap = git(
    ['diff', '--cached', '--name-only', '-z', expectedHead, '--', ...scope], { cwd: root }
  ).stdout.split('\0').filter(Boolean);
  if (stagedOverlap.length) {
    throw new SingularityFlowError(
      `Governed publication cannot replace already staged governed path(s): ${stagedOverlap.join(', ')}. `
      + 'Commit or unstage those paths, then retry.'
    );
  }
  const prospectiveTree = prospectiveGovernedTreeAndSecretScan(root, scope, expectedHead);
  const admitted = [...scope];
  Object.defineProperty(admitted, 'prospectiveTree', {
    value: prospectiveTree, enumerable: false, writable: false, configurable: false
  });
  return Object.freeze(admitted);
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
  expectedRef = undefined,
  sign = false,
  signingKey = null,
  fault = null,
  stabilityGuard = null,
  transaction = null,
  expectedTree = null,
  onCommitCreated = null,
  onRefAdvanced = null
} = {}) {
  const checkedOutRef = () => {
    const observed = git(['symbolic-ref', '-q', 'HEAD'], { cwd: root, allowFailure: true });
    return observed.status === 0 ? observed.stdout.trim() : null;
  };
  const initialRef = checkedOutRef();
  if (expectedRef !== undefined && initialRef !== expectedRef) {
    throw new SingularityFlowError(
      `Governed publication checkout changed before its commit began (expected ${expectedRef ?? 'detached HEAD'}, `
      + `found ${initialRef ?? 'detached HEAD'}). Reload the lifecycle state and retry.`,
      {
        code: 'PUBLICATION_BRANCH_CHANGED',
        details: { expectedRef, currentRef: initialRef }
      }
    );
  }
  // Optional transaction roots may legitimately remain absent (for example an approval that was
  // allowed to harvest knowledge but found none). Git rejects an entirely unknown pathspec even
  // when `git add -A` is otherwise correct. Keep paths that exist now or were tracked at HEAD so
  // deletions are still staged; omit only roots that have never contained governed bytes.
  const scope = admitGovernedPublication(root, paths, { expectedHead });

  // A publisher may perform slow validation before staging while an editor, formatter, or test
  // watcher is still capable of writing the worktree. Capture its content-aware guard immediately
  // before staging and compare it immediately afterwards. A later edit cannot alter the temporary
  // index/tree already built; it remains ordinary uncommitted work for the next generation.
  const stabilityBefore = stabilityGuard ? await stabilityGuard() : null;

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
    const trackedWorktreeDrift = git(['diff', '--quiet', '--', ...scope], {
      cwd: root, env, allowFailure: true
    });
    const untrackedWorktreeDrift = git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...scope], {
      cwd: root, env, allowFailure: true
    });
    if (trackedWorktreeDrift.status > 1 || untrackedWorktreeDrift.status !== 0) {
      throw new SingularityFlowError(
        'Git could not verify the governed publication snapshot after staging.',
        { code: 'PUBLICATION_SNAPSHOT_UNVERIFIED' }
      );
    }
    if (trackedWorktreeDrift.status === 1 || untrackedWorktreeDrift.stdout) {
      throw new SingularityFlowError(
        'Repository bytes changed while the governed publication snapshot was being staged. '
        + 'The commit was not created; wait for editor, formatter, generator, and test writes to finish, then retry.',
        { code: 'PUBLICATION_SNAPSHOT_CHANGED' }
      );
    }
    if (stabilityGuard) {
      const stabilityAfter = await stabilityGuard();
      if (stabilityAfter !== stabilityBefore) {
        throw new SingularityFlowError(
          'Repository bytes changed while the governed publication snapshot was being staged. '
          + 'The commit was not created; wait for editor, formatter, generator, and test writes to finish, then retry.',
          {
            code: 'PUBLICATION_SNAPSHOT_CHANGED',
            details: { before: stabilityBefore, after: stabilityAfter }
          }
        );
      }
    }

    const tree = git(['write-tree'], { cwd: root, env }).stdout.trim();
    if (tree !== scope.prospectiveTree) {
      throw new SingularityFlowError(
        'Governed publication bytes changed after exact secret/scope admission. The commit was not created.',
        {
          code: 'PUBLICATION_SNAPSHOT_CHANGED',
          details: { admittedTree: scope.prospectiveTree, observedTree: tree }
        }
      );
    }
    if (expectedTree != null && tree !== expectedTree) {
      throw new SingularityFlowError(
        'Governed publication bytes changed after Candidate verification. The commit was not created; freeze and verify a new Candidate.',
        {
          code: 'PUBLICATION_CANDIDATE_DRIFT',
          details: { expectedCandidateTree: expectedTree, observedTree: tree }
        }
      );
    }
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
        + (boundTransaction.candidate
          ? `\nSingularity-Flow-Candidate-ID: ${boundTransaction.candidate.candidateId}`
            + `\nSingularity-Flow-Candidate-SHA256: ${boundTransaction.candidate.candidateSha256}`
            + `\nSingularity-Flow-Candidate-Verification-SHA256: ${boundTransaction.candidate.verificationReceiptSha256}`
            + `\nSingularity-Flow-Candidate-Profile-SHA256: ${boundTransaction.candidate.verificationProfileSha256}`
          : '')
      : message;
    sourceCommit = git(
      ['commit-tree', tree, '-p', expectedHead, ...signing, '-m', transactionMessage],
      { cwd: root, env }
    ).stdout.trim();
    if (onCommitCreated) await onCommitCreated({ expectedHead, sourceCommit, tree, transaction: boundTransaction });
    if (fault) await fault('after-commit-object', { expectedHead, sourceCommit, tree });

    const observedRef = checkedOutRef();
    if (expectedRef !== undefined && observedRef !== expectedRef) {
      throw new SingularityFlowError(
        `Governed publication checkout changed while its commit was being prepared (expected ${expectedRef ?? 'detached HEAD'}, `
        + `found ${observedRef ?? 'detached HEAD'}). The commit was not installed; reload the lifecycle state and retry.`,
        {
          code: 'PUBLICATION_BRANCH_CHANGED',
          details: { expectedRef, currentRef: observedRef }
        }
      );
    }
    const ref = expectedRef !== undefined ? expectedRef : observedRef;
    if (!ref) {
      throw new SingularityFlowError('Detached HEAD is not supported for governed publication.');
    }
    const update = git(['update-ref', ref, sourceCommit, expectedHead], { cwd: root, allowFailure: true });
    if (update.status !== 0) {
      throw new SingularityFlowError(
        `Governed publication lost its branch-head race: ${(update.stderr || update.stdout).trim() || 'compare-and-swap failed'}. `
        + 'Reload the lifecycle state and retry.'
      );
    }
    refAdvanced = true;
    if (onRefAdvanced) await onRefAdvanced({ expectedHead, sourceCommit, tree, transaction: boundTransaction });

    const refBeforeIndexRefresh = checkedOutRef();
    if (expectedRef !== undefined && refBeforeIndexRefresh !== expectedRef) {
      throw new SingularityFlowError(
        `Governed publication checkout changed after ${expectedRef} advanced (found ${refBeforeIndexRefresh ?? 'detached HEAD'}). `
        + `Commit ${sourceCommit.slice(0, 12)} was retained on its captured branch; recover or publish that exact commit before retrying.`,
        {
          code: 'PUBLICATION_BRANCH_CHANGED',
          details: { expectedRef, currentRef: refBeforeIndexRefresh, commit: sourceCommit }
        }
      );
    }

    // The real index still describes the old HEAD. Refresh only governed entries so they do not
    // appear as synthetic staged reversions; unrelated staged entries remain byte-for-byte intact.
    git(['reset', '-q', sourceCommit, '--', ...scope], { cwd: root });
    const refAfterIndexRefresh = checkedOutRef();
    if (expectedRef !== undefined && refAfterIndexRefresh !== expectedRef) {
      // A checkout racing the index refresh may now own this worktree. Restore its index from its
      // own HEAD; the exact governed commit remains safely reachable from expectedRef.
      git(['reset', '-q', 'HEAD', '--', ...scope], { cwd: root, allowFailure: true });
      throw new SingularityFlowError(
        `Governed publication checkout changed while ${expectedRef}'s index was being refreshed (found ${refAfterIndexRefresh ?? 'detached HEAD'}). `
        + `Commit ${sourceCommit.slice(0, 12)} was retained on its captured branch and was not published.`,
        {
          code: 'PUBLICATION_BRANCH_CHANGED',
          details: { expectedRef, currentRef: refAfterIndexRefresh, commit: sourceCommit }
        }
      );
    }
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

/** Publish one previously proven commit as a Story branch without depending on current HEAD. */
export function publicationPushOutcome(result) {
  if (result?.status === 0) return 'published';
  // Git may report a transport failure only after receive-pack has committed the update. Timeouts,
  // process termination, connection reset, and EOF all leave that boundary indeterminate. A
  // porcelain rejection/collision has no network-transient classification and remains definitive.
  const failureClass = result?.failure?.classification
    ?? classifyGitRemoteFailure(result).classification;
  if (result?.timedOut === true
    || Boolean(result?.signal)
    || failureClass === 'network-transient') return 'transport-indeterminate';
  return 'rejected';
}

/** Deadline-supervised async form for operator-facing recovery paths. */
export async function exactRemoteBranchObservationAsync(root, remote, branchName) {
  validBranch(root, branchName);
  const expectedRef = `refs/heads/${branchName}`;
  const frozen = frozenRemoteTransport(remote);
  const observed = await runRemoteGitAsync([
    'ls-remote', '--heads', '--', frozen.remote, expectedRef
  ], { cwd: root, operation: 'remote-probe', env: frozen.env });
  if (observed.status !== 0) {
    return { reachable: false, sha: null, malformed: false, result: observed };
  }
  const advertised = observed.stdout.split(/\r?\n/)
    .map((line) => line.match(/^([0-9a-f]{40,64})\s+(refs\/heads\/[^\s]+)$/i))
    .filter((match) => match?.[2] === expectedRef);
  return {
    reachable: true,
    sha: advertised.length === 1 ? advertised[0][1].toLowerCase() : null,
    malformed: advertised.length > 1,
    result: observed
  };
}

/** @deprecated Use pushCommitToBranchAsync; retained as an asynchronous compatibility alias. */
export async function pushCommitToBranch(root, remote, commitSha, branchName, options = {}) {
  const expectedRemoteSha = options.expectedRemoteSha;
  const transportRemote = options.transportRemote ?? remote;
  const upstreamRemote = options.upstreamRemote ?? remote;
  validBranch(root, branchName);
  const commit = git(['rev-parse', '--verify', `${commitSha}^{commit}`], {
    cwd: root, allowFailure: true
  });
  if (commit.status !== 0) {
    return { ...commit, stderr: commit.stderr || `Commit '${commitSha}' is not available locally.` };
  }
  const lease = expectedRemoteSha !== undefined
    ? [`--force-with-lease=refs/heads/${branchName}:${expectedRemoteSha ?? ''}`]
    : [];
  const frozen = Object.hasOwn(options, 'transportRemote')
    ? frozenRemoteTransport(transportRemote, { push: true })
    : null;
  const result = await runRemoteGitAsync([
    'push', '--porcelain', ...lease, frozen?.remote ?? transportRemote,
    `${commit.stdout.trim()}:refs/heads/${branchName}`
  ], {
    cwd: root, operation: 'remote-push',
    ...(frozen ? { env: frozen.env } : {})
  });
  // Git elides an update when another actor already installed the identical object ID. It does so
  // even when an explicit non-null lease names the older ref: receive-pack sees no update and Git
  // reports `=` / "up to date". An explicit lease is an ownership claim, not merely a desired final
  // value, so require porcelain proof that this invocation performed the expected transition.
  if (result.status === 0 && expectedRemoteSha !== undefined
    && String(expectedRemoteSha ?? '').toLowerCase() !== commit.stdout.trim().toLowerCase()) {
    const destination = `refs/heads/${branchName}`;
    const transition = result.stdout.split(/\r?\n/).map((line) => {
      const [flag, refspec] = line.split('\t');
      return refspec?.endsWith(`:${destination}`) ? flag : null;
    }).find((flag) => flag !== null);
    const acquired = expectedRemoteSha === null
      ? transition === '*'
      : transition === ' ' || transition === '+';
    if (!acquired) {
      return {
        ...result,
        status: 1,
        stderr: expectedRemoteSha === null
          ? `Remote branch '${branchName}' already exists; the create-only publication did not acquire it.`
          : `Remote branch '${branchName}' did not move from the explicitly leased commit; this publication did not acquire the update.`
      };
    }
  }
  if (result.status === 0) {
    // A URL transport deliberately bypasses the mutable remote name, so Git does not update the
    // corresponding remote-tracking ref itself. Record the exact commit just proven published.
    const trackingRef = `refs/remotes/${upstreamRemote}/${branchName}`;
    if (git(['check-ref-format', trackingRef], { cwd: root, allowFailure: true }).status === 0) {
      git(['update-ref', trackingRef, commit.stdout.trim()], { cwd: root });
    }
    if (refExists(root, `refs/heads/${branchName}`)) {
      // Keep the ordinary remote name in branch configuration; persisting a URL there would make
      // later `git pull` interpret it as a remote name.
      configureUpstream(root, branchName, upstreamRemote);
    }
  }
  return result;
}

/** Deadline-supervised async equivalent used by interactive recovery surfaces. */
export async function pushCommitToBranchAsync(root, remote, commitSha, branchName, options = {}) {
  const expectedRemoteSha = options.expectedRemoteSha;
  const transportRemote = options.transportRemote ?? remote;
  const upstreamRemote = options.upstreamRemote ?? remote;
  validBranch(root, branchName);
  const commit = git(['rev-parse', '--verify', `${commitSha}^{commit}`], {
    cwd: root, allowFailure: true
  });
  if (commit.status !== 0) {
    return { ...commit, stderr: `Commit '${commitSha}' is not available locally.` };
  }
  const lease = expectedRemoteSha !== undefined
    ? [`--force-with-lease=refs/heads/${branchName}:${expectedRemoteSha ?? ''}`]
    : [];
  const frozen = Object.hasOwn(options, 'transportRemote')
    ? frozenRemoteTransport(transportRemote, { push: true })
    : null;
  let result = await runRemoteGitAsync([
    'push', '--porcelain', ...lease, frozen?.remote ?? transportRemote,
    `${commit.stdout.trim()}:refs/heads/${branchName}`
  ], {
    cwd: root, operation: 'remote-push',
    ...(frozen ? { env: frozen.env } : {})
  });
  if (result.status === 0 && expectedRemoteSha !== undefined
      && String(expectedRemoteSha ?? '').toLowerCase() !== commit.stdout.trim().toLowerCase()) {
    const destination = `refs/heads/${branchName}`;
    const transition = result.stdout.split(/\r?\n/).map((line) => {
      const [flag, refspec] = line.split('\t');
      return refspec?.endsWith(`:${destination}`) ? flag : null;
    }).find((flag) => flag !== null);
    const acquired = expectedRemoteSha === null
      ? transition === '*'
      : transition === ' ' || transition === '+';
    if (!acquired) {
      result = {
        ...result,
        status: 1,
        stderr: expectedRemoteSha === null
          ? `Remote branch '${branchName}' already exists; the create-only publication did not acquire it.`
          : `Remote branch '${branchName}' did not move from the explicitly leased commit; this publication did not acquire the update.`
      };
    }
  }
  if (result.status === 0) {
    const trackingRef = `refs/remotes/${upstreamRemote}/${branchName}`;
    if (git(['check-ref-format', trackingRef], { cwd: root, allowFailure: true }).status === 0) {
      git(['update-ref', trackingRef, commit.stdout.trim()], { cwd: root });
    }
    if (refExists(root, `refs/heads/${branchName}`)) {
      configureUpstream(root, branchName, upstreamRemote);
    }
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
export async function preflightPushBranch(root, remote, sourceRef, branchName, options = {}) {
  const transportRemote = options.transportRemote ?? remote;
  validBranch(root, branchName);
  const frozen = Object.hasOwn(options, 'transportRemote')
    ? frozenRemoteTransport(transportRemote, { push: true })
    : null;
  return runRemoteGitAsync([
    'push', '--dry-run', '--porcelain', frozen?.remote ?? transportRemote,
    `${sourceRef}:refs/heads/${branchName}`
  ], {
    cwd: root, operation: 'remote-push',
    ...(frozen ? { env: frozen.env } : {})
  });
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
  const candidateFields = {
    candidateId: trailer('Singularity-Flow-Candidate-ID'),
    candidateSha256: trailer('Singularity-Flow-Candidate-SHA256'),
    verificationReceiptSha256: trailer('Singularity-Flow-Candidate-Verification-SHA256'),
    verificationProfileSha256: trailer('Singularity-Flow-Candidate-Profile-SHA256')
  };
  const candidateValues = Object.values(candidateFields).filter(Boolean);
  return {
    commit,
    tree,
    parents,
    transactionId: trailer('Singularity-Flow-Transaction'),
    eventSha256: trailer('Singularity-Flow-Event-SHA256'),
    stateSha256: trailer('Singularity-Flow-State-SHA256'),
    publicationMode: trailer('Singularity-Flow-Publication-Mode'),
    candidate: candidateValues.length === 0 ? null
      : candidateValues.length === Object.keys(candidateFields).length ? candidateFields
        : { invalid: true, ...candidateFields }
  };
}
