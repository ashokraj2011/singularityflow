import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
// Synchronous, because `identity()` is synchronous and called from synchronous code throughout.
import {
  accessSync, constants as FS_CONSTANTS, existsSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, statSync, writeFileSync
} from 'node:fs';
import { SingularityFlowError, gitReadOutput, invariant, isGitRefName, run, writeAtomic, removeTemporaryTree } from './util.mjs';
import { processResultCompleted, processResultSucceeded } from './process-result.mjs';
import { gitEmptyConfigPath, gitDisabledHooksPath } from './git-isolation-paths.mjs';
import { readLocalGitBlobs, repositoryObjectFormat } from './git-blob-batch.mjs';
import { repositoryGitPath } from './git-directory.mjs';
import {
  branch, gitCommonDir, gitDir, head, headAndBranch, localGitDisplayName, refHead, repoRoot, resetGitDirCache,
  runRemoteGitAsync
} from './git-execution.mjs';
import { probeStoryBranchPublication } from './story-publication-preflight.mjs';
import { observePublicationHookEffects } from './git-hook-effects.mjs';
import {
  assertCredentialFreeRemote, classifyGitRemoteFailure, configuredRemoteAuthority,
  configuredRemoteIdentity, frozenRemoteTransport, safeGitDiagnosticReference, isPortableAbsoluteGitPath
} from './git-remote-diagnostics.mjs';
import { withoutGitProcessOverrides } from './git-enterprise-environment.mjs';
import { scopedReadSync } from './read-scope.mjs';
import { scannablePath, scannedAsExtractedText, scanEntries, secretRefusal } from './secrets.mjs';
import { extractSourceTextForPath } from './source-text.mjs';
import {
  ENVIRONMENT_DECLARATION_PATH, loadEnvironmentDeclarationSync, matchEnvironmentLocalPath,
  parseEnvironmentDeclaration
} from './environment-declaration.mjs';
import { configurationReadRootForPath } from './configuration-read-scope.mjs';
import { parsePorcelainV2Status } from './git-status-detail.mjs';

function git(args, options = {}) {
  // stdout is the data channel: `--json` callers parse this process's stdout, so a child git's
  // progress chatter ("[main abc1234] message", "branch 'main' set up to track...") must never
  // land there. Inherited git output is routed to the parent's stderr (fd 2) instead, which keeps
  // it visible in a terminal while leaving stdout pure for machine-readable output.
  if (options.stdio === 'inherit') return run('git', args, { ...options, stdio: ['inherit', 2, 'inherit'] });
  return run('git', args, options);
}

/**
 * Git's answer to a read a decision rests on, or a refusal when Git could not give one.
 *
 * Empty output here means no configured identity, no remotes, no remote default branch, nothing
 * staged to scan for secrets or no refspec installed yet. A read that failed used to mean the same;
 * only a successful read, or Git's documented negative answer (`absentStatus`), may be empty.
 */
function gitAnswer(args, options, label, { absentStatus = null } = {}) {
  return gitReadOutput(git(args, { ...options, allowFailure: true }), label, { absentStatus }) ?? '';
}

/**
 * Isolate immutable local-object reads from caller-selected indexes/object stores and Git replace
 * refs. Exact admission must never reinterpret an admitted OID, and a partial clone must not turn
 * a local verification step into an undeclared network fetch.
 */
function immutableLocalGitEnvironment(source = process.env, { indexFile = null } = {}) {
  const env = {
    ...withoutGitProcessOverrides(source),
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1'
  };
  if (indexFile != null) env.GIT_INDEX_FILE = indexFile;
  return env;
}

// The basic local reads (root, Git directories, branch, HEAD, display name) live in
// git-execution.mjs so light surfaces need not load this module; they are re-exported here.
export { branch, gitCommonDir, head, headAndBranch, repoRoot };

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
  const symbolic = gitAnswer(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remoteName}/HEAD`], {
    cwd: root
  }, `The '${remoteName}' default branch`, { absentStatus: 1 }).trim();
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


/** The commit a branch, tag or commit name points at, or null when there is none by that name. */
export function commitOfRef(root, ref) {
  const name = String(ref ?? '');
  if (!name || name.startsWith('-') || !/^[\w./@{}^~+-]+$/u.test(name)) return null;
  const result = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${name}^{commit}`], { cwd: root, allowFailure: true });
  return gitReadOutput(result, `The commit of '${name}'`, { absentStatus: 1 })?.trim() || null;
}

/**
 * Local and remote-tracking branches, most recently committed first: short name, commit, the remote
 * (null for a local branch) and the branch name without the remote.
 */
export function recentBranches(root, { limit = 500 } = {}) {
  const output = gitAnswer(['for-each-ref', '--sort=-committerdate', `--count=${limit}`,
    '--format=%(refname)%09%(refname:short)%09%(objectname)%09%(symref)', 'refs/heads', 'refs/remotes'], { cwd: root }, 'The repository branches');
  return output.split('\n').map((line) => line.split('\t')).filter(([full, name, commit, symref]) => full && name && commit && !symref)
    .map(([full, name, commit]) => {
      const remote = full.startsWith('refs/remotes/') ? full.slice('refs/remotes/'.length).split('/')[0] : null;
      return { name, commit, remote, branch: remote ? full.slice(`refs/remotes/${remote}/`.length) : full.slice('refs/heads/'.length) };
    });
}

/**
 * In a partial clone, download the blobs of `commit` whose paths `wanted` accepts and that are not
 * here yet: one fetch from the promisor remote into the object store, nothing checked out. Returns
 * how many were fetched (0 for a complete clone, or when nothing was missing).
 */
export function fetchMissingBlobs(root, commit, wanted, { limit = 20000 } = {}) {
  const promisors = git(['config', '--local', '--get-regexp', '^remote\\..*\\.promisor$'], { cwd: root, allowFailure: true });
  const remote = String(promisors.stdout ?? '').split('\n').map((line) => line.trim().split(/\s+/u))
    .find(([, value]) => value === 'true')?.[0]?.replace(/^remote\.|\.promisor$/gu, '') ?? null;
  if (!remote) return { fetched: 0, remote: null };
  const local = { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
  const listed = git(['ls-tree', '-r', '-z', '--format=%(objecttype)%x09%(objectname)%x09%(path)', commit], { cwd: root, env: local, allowFailure: true });
  if (listed.status !== 0) return { fetched: 0, remote };
  const oids = [...new Set(String(listed.stdout ?? '').split('\0').map((row) => row.split('\t'))
    .filter(([type, , file]) => type === 'blob' && file && wanted(file)).map(([, oid]) => oid))];
  if (!oids.length) return { fetched: 0, remote };
  const checked = git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { cwd: root, env: local, allowFailure: true, input: `${oids.join('\n')}\n` });
  const missing = String(checked.stdout ?? '').split('\n').filter((line) => line.endsWith(' missing')).map((line) => line.split(' ')[0]);
  if (!missing.length) return { fetched: 0, remote };
  if (missing.length > limit) {
    throw new SingularityFlowError(`${missing.length} files of ${commit.slice(0, 12)} are not downloaded in this partial clone, more than ${limit} to fetch at once. Check the branch out, or fetch it in full, then try again.`, { code: 'GIT_PARTIAL_CLONE_TOO_MANY_MISSING' });
  }
  // The same request Git makes for a lazy fetch, made once for the whole set.
  const fetched = git(['-c', 'fetch.negotiationAlgorithm=noop', 'fetch', remote, '--no-tags', '--no-write-fetch-head',
    '--recurse-submodules=no', '--filter=blob:none', '--stdin'], {
    cwd: root, allowFailure: true, input: `${missing.join('\n')}\n`,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }
  });
  if (fetched.status !== 0) {
    const detail = String(fetched.stderr ?? '').trim().split('\n').at(-1) || `git exited ${fetched.status}`;
    throw new SingularityFlowError(`${missing.length} files of ${commit.slice(0, 12)} are not downloaded in this partial clone, and fetching them from '${remote}' failed: ${detail}`, { code: 'GIT_PARTIAL_CLONE_FETCH_FAILED' });
  }
  return { fetched: missing.length, remote };
}

export { gitDir };

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
 * A failed lookup, remembered by this process only and only briefly.
 *
 * A failure is never written to disk (one offline moment must not look like a signed-out account
 * for ten minutes), but one Story start asked five times and paid for every failure: no `gh`, a
 * signed-out account or no network answers the same within one command. A minute bounds a long
 * running host such as the VS Code extension.
 */
const GITHUB_FAILURE_TTL_MS = 60 * 1000;
const githubLookupFailures = new Map();

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
  // The account belongs to the repository, not to one of its checkouts: every Story worktree shares
  // the main checkout's answer, and a worktree no longer has one it can never write.
  return repositoryGitPath(root, 'singularity-flow', 'github-account.json');
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
  // Anything that chooses which `gh` runs or which account it asks for is part of the key.
  const failureKey = [file, ...['PATH', 'HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'GH_HOST', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']
    .map((name) => `${name}=${env[name] ?? ''}`)].join('\0');
  const failed = githubLookupFailures.get(failureKey);
  if (failed && Date.now() - failed.at < GITHUB_FAILURE_TTL_MS) return failed.result;

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
  const answered = { ...result, lookup };
  if (result.status === 0) githubLookupFailures.delete(failureKey);
  else if (!result.blocked) {
    if (githubLookupFailures.size >= 64) githubLookupFailures.clear();
    githubLookupFailures.set(failureKey, { at: Date.now(), result: answered });
  }
  return answered;
}

/** The repository's configured presentation name, without account or environment fallbacks. */
export { localGitDisplayName };

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
    email: gitAnswer(['config', '--get', 'user.email'], { cwd: root, env }, 'Git user.email', { absentStatus: 1 }).trim() || null,
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
  const normalized = Object.freeze({
    name: normalizedCommitIdentityField(value.name, 'user.name'),
    email: normalizedCommitIdentityField(value.email, 'user.email'),
    source: value.source
  });
  // `source` is evidence about how the value was obtained, not a caller-controlled label.  The
  // compatibility fallback has one deliberately low-assurance representation; accepting arbitrary
  // names under that label would let a reconstructed/replayed operation disguise configured
  // metadata as the service identity (or vice versa).
  if (normalized.source === 'service-fallback'
      && (normalized.name !== FALLBACK_COMMIT_IDENTITY.name
        || normalized.email !== FALLBACK_COMMIT_IDENTITY.email)) {
    throw commitIdentityError(
      'identity', 'the service fallback must use the canonical Singularity Flow metadata'
    );
  }
  return normalized;
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
  const email = gitAnswer(['config', '--get', 'user.email'], { cwd: root, env }, 'Git user.email', { absentStatus: 1 }).trim();
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
 * Ordinary CLI lifetimes are one command. A warm read worker resets before and after every request
 * so account changes, pruned objects and a recreated repository cannot reuse an earlier command's
 * observations. Tests also create, delete and recreate repositories at the same temporary path.
 */
export function resetGitProcessCaches() {
  resetGitDirCache();
  // Long-lived read workers must re-prove local object presence and account configuration.
  githubLookupFailures.clear();
  exactObjectFiles.clear();
  resolvedCommittedPaths.clear();
}

export function validBranch(root, name) {
  if (git(['check-ref-format', '--branch', name], { cwd: root, allowFailure: true }).status !== 0) {
    throw new SingularityFlowError(`Invalid Git branch name: ${name}`);
  }
}

/**
 * Whether a commit sits on a shallow clone's boundary: the clone is shallow and at least one parent
 * the commit records was never fetched. History before such a commit cannot be proven locally.
 */
export function shallowBoundaryCommit(root, commit) {
  const shallow = git(['rev-parse', '--is-shallow-repository'], { cwd: root, allowFailure: true });
  if (shallow.status !== 0 || shallow.stdout.trim() !== 'true') return false;
  const object = git(['cat-file', '-p', commit], { cwd: root, allowFailure: true });
  if (object.status !== 0) return true;
  const parents = [...object.stdout.matchAll(/^parent ([0-9a-f]{40,64})$/gmu)].map((match) => match[1]);
  if (!parents.length) return false;
  const env = { ...process.env, GIT_NO_LAZY_FETCH: '1' };
  if (parents.length === 1) {
    return git(['cat-file', '-e', `${parents[0]}^{commit}`], { cwd: root, allowFailure: true, env }).status !== 0;
  }
  // A merge records several parents; one batch check answers for all of them.
  const checked = git(['cat-file', '--batch-check=%(objecttype)'], {
    cwd: root, allowFailure: true, env, input: `${parents.map((parent) => `${parent}^{commit}`).join('\n')}\n`
  });
  if (checked.status !== 0) return true;
  const rows = String(checked.stdout ?? '').trim().split(/\r?\n/u);
  return rows.length !== parents.length || rows.some((row) => row.trim() !== 'commit');
}

export function refExists(root, ref) {
  return git(['show-ref', '--verify', '--quiet', ref], { cwd: root, allowFailure: true }).status === 0;
}

export function hasRemote(root, remote = 'origin', { env = process.env } = {}) {
  return git(['remote', 'get-url', remote], { cwd: root, env, allowFailure: true }).status === 0;
}

/** Enumerate configured remote names through the shared Git execution boundary. */
export function remoteNames(root, { env = process.env } = {}) {
  return gitAnswer(['remote'], { cwd: root, env }, 'Git remotes')
    .split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
}

/** Read one configured remote URL without exposing a raw Git subprocess at the caller. */
export function remoteUrl(root, remote = 'origin', { env = process.env } = {}) {
  const observed = git(['remote', 'get-url', remote], {
    cwd: root, env, allowFailure: true
  });
  return observed.status === 0 ? observed.stdout.trim() : null;
}

/**
 * The working tree's status. Inside a read scope it is asked once: a full snapshot asked three
 * times, and on a large Windows checkout each one is a scan of every file.
 */
export function changes(root, { refreshIndex = false } = {}) {
  // A mutation owns its new isolated checkout and may retain freshly verified stat metadata.
  // Ordinary UI/read snapshots still avoid optional index locks. Explicit host policy wins,
  // including differently cased Windows environment names; no file content or staged OID changes.
  const refresh = refreshIndex && !Object.keys(process.env).some(key => key.toUpperCase() === 'GIT_OPTIONAL_LOCKS');
  return scopedReadSync(`git.changes:${path.resolve(root)}${refreshIndex ? ':refresh' : ''}`, () =>
    git(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root,
      ...(refresh ? { env: { ...process.env, GIT_OPTIONAL_LOCKS: '1' } } : {}) }).stdout);
}

/** Exact local status roster for lifecycle decisions; paths are never quote/line parsed. */
export function worktreeStatusDetail(root) {
  const env = immutableLocalGitEnvironment();
  const objectFormat = repositoryObjectFormat(root, { env });
  if (!objectFormat) {
    throw new SingularityFlowError('Git could not establish the repository object format for the worktree status.', {
      code: 'GIT_OBJECT_FORMAT_UNAVAILABLE'
    });
  }
  const bytes = git(['status', '--porcelain=v2', '-z', '--untracked-files=all'], {
    cwd: root, env, encoding: 'buffer'
  }).stdout;
  return parsePorcelainV2Status(bytes, { objectFormat });
}

/** One lossless status observation replaces separate tracked, staged and untracked scans. */
export function artifactChangeInventory(root) {
  const detail = worktreeStatusDetail(root);
  const paths = new Set();
  const untracked = new Set();
  for (const entry of detail.entries) {
    if (entry.type === 'ignored') continue;
    for (const candidate of [entry.path, entry.sourcePath].filter(Boolean)) {
      if (candidate.kind !== 'utf8') throw new SingularityFlowError(
        'Artifact discovery cannot represent a non-UTF-8 repository path.', { code: 'ARTIFACT_PATH_UNREPRESENTABLE' }
      );
      paths.add(candidate.value);
    }
    if (entry.type === 'untracked') untracked.add(entry.path.value);
  }
  return { paths: [...paths].sort(), untracked };
}

export function assertClean(root, options) {
  if (changes(root, options).trim()) throw new SingularityFlowError('Working tree is not clean. Commit or stash changes, or pass --allow-dirty deliberately.');
}

export function prepareRemoteBranchTracking(root, remote = 'origin', { env = process.env } = {}) {
  if (!hasRemote(root, remote, { env })) return false;
  // Validate the tracking namespace without rewriting remote.<name>.fetch. Callers that need all
  // branches pass an explicit one-shot refspec to fetch; a failed fetch must leave custom and
  // single-branch Git configuration exactly as the contributor configured it.
  const trackingProbe = `refs/remotes/${remote}/singularity-flow-probe`;
  if (git(['check-ref-format', trackingProbe], { cwd: root, env, allowFailure: true }).status !== 0) {
    throw new SingularityFlowError(`Git remote '${remote}' cannot be used as a remote-tracking namespace.`);
  }
  return true;
}

export function safePruneRefspecs(root, remote, { env = process.env } = {}) {
  const configured = git(['config', '--get-all', `remote.${remote}.fetch`], {
    cwd: root, env: withoutGitProcessOverrides(env), allowFailure: true
  });
  if (configured.status === 1 && !configured.stdout.trim() && !configured.stderr.trim()) return [];
  if (configured.status !== 0 || configured.stderr.trim()) return null;
  const refspecs = configured.stdout.split(/\r?\n/u).filter(Boolean);
  // Pruning with a one-shot wildcard alone can delete a user's separate tracking namespace.
  // Include only simple, safe custom head mappings in Git's prune relation. Exotic/negative
  // mappings disable pruning rather than risking deletion of a ref that SFlow does not own.
  for (const spec of refspecs) {
    const match = /^\+?(refs\/heads\/[A-Za-z0-9._/*-]+):(refs\/remotes\/[A-Za-z0-9._/*-]+)$/u.exec(spec);
    if (!match || !match[2].startsWith(`refs/remotes/${remote}/`)) return null;
  }
  return refspecs;
}

export async function fetchRemote(root, remote = 'origin', options = {}) {
  // A new Story needs one selected base, not every Story/config-history branch in a large remote.
  // Never apply wildcard pruning or custom refspecs to this narrow refresh: unrelated tracking refs
  // and the contributor's remote configuration must remain untouched.
  if (options.branches != null && !Array.isArray(options.branches)) {
    throw new SingularityFlowError('A selected-branch fetch requires an array of branch names.', {
      code: 'GIT_REMOTE_BRANCH_INVALID'
    });
  }
  const branches = options.branches == null ? null : [...new Set(options.branches)];
  if (branches && (!branches.length || branches.some((name) => typeof name !== 'string'
      || !name || name.startsWith('-') || git(['check-ref-format', `refs/heads/${name}`], {
        cwd: root, allowFailure: true
      }).status !== 0))) {
    throw new SingularityFlowError('A selected-branch fetch requires valid, explicit branch names.', {
      code: 'GIT_REMOTE_BRANCH_INVALID'
    });
  }
  if (!prepareRemoteBranchTracking(root, remote)) {
    if (Object.hasOwn(options, 'transportRemote')) {
      throw new SingularityFlowError(
        `Git remote '${remote}' disappeared after its fetch authority was selected. Nothing was fetched.`, {
          code: 'GIT_REMOTE_AUTHORITY_CHANGED'
        }
      );
    }
    return;
  }
  const identity = configuredRemoteIdentity(root, remote, { direction: 'fetch' });
  if (!identity.configured || identity.ambiguous) {
    throw new SingularityFlowError(`Git remote '${remote}' has no unambiguous fetch authority.`, {
      code: 'GIT_REMOTE_CONFIG_INVALID'
    });
  }
  const requestedTransport = Object.hasOwn(options, 'transportRemote')
    ? assertCredentialFreeRemote(options.transportRemote)
    : identity.url;
  const effectiveTransport = Object.hasOwn(options, 'transportRemote')
    ? configuredRemoteAuthority(root, remote, { direction: 'fetch' }).url
    : identity.url;
  if (requestedTransport !== identity.url && requestedTransport !== effectiveTransport) {
    throw new SingularityFlowError(
      `Git remote '${remote}' changed after its fetch authority was selected. Nothing was fetched.`, {
        code: 'GIT_REMOTE_AUTHORITY_CHANGED'
      }
    );
  }
  // Even the ordinary fetch path uses the exact local authority resolved at the call boundary.
  // Git must not re-read a mutable remote name after the permission/configuration check.
  const frozen = frozenRemoteTransport(requestedTransport);
  const pruneRefspecs = branches ? null : safePruneRefspecs(root, remote);
  const partialClone = options.respectPartialClone === true
    && git(['config', '--local', '--get', `remote.${remote}.promisor`], {
      cwd: root, allowFailure: true
    }).stdout.trim() === 'true'
    && git(['config', '--local', '--get', `remote.${remote}.partialclonefilter`], {
      cwd: root, allowFailure: true
    }).stdout.trim() === 'blob:none';
  const result = await runRemoteGitAsync([
    'fetch', ...(pruneRefspecs ? ['--prune'] : []),
    ...(partialClone ? ['--filter=blob:none'] : []), ...(branches ? ['--no-tags'] : []), frozen.remote,
    ...(branches
      ? branches.map((name) => `+refs/heads/${name}:refs/remotes/${remote}/${name}`)
      : [`+refs/heads/*:refs/remotes/${remote}/*`, ...(pruneRefspecs ?? [])])
  ], {
    cwd: root, operation: 'remote-configuration', allowFailure: false,
    env: frozen.env
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
  return scopedReadSync(`git.hasUpstream:${path.resolve(root)}`, () =>
    git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: root, allowFailure: true }).status === 0);
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
  // `git branch --set-upstream-to origin/name` refuses a fetched branch outside a narrow clone's
  // configured fetch refspec. Record the upstream pair, then add only this branch's tracking
  // refspec if Git still cannot resolve it. Fetch itself never rewrites a user's remote config.
  git(['config', '--local', `branch.${name}.remote`, remote], { cwd: root });
  git(['config', '--local', `branch.${name}.merge`, `refs/heads/${name}`], { cwd: root });
  if (!hasUpstream(root)) {
    const exact = `+refs/heads/${name}:refs/remotes/${remote}/${name}`;
    const configured = gitAnswer(['config', '--local', '--get-all', `remote.${remote}.fetch`], { cwd: root },
      `Git remote '${remote}' fetch refspecs`, { absentStatus: 1 }).split(/\r?\n/u).filter(Boolean);
    if (!configured.includes(exact)) {
      git(['config', '--local', '--add', `remote.${remote}.fetch`, exact], { cwd: root });
    }
  }
}

export async function checkout(root, name, {
  base = 'main',
  fetch = false,
  fetched = false,
  existingOnly = false,
  remote = 'origin',
  preferRemoteBase = fetch,
  exactCommit = null,
  exactCommitErrorCode = 'BRANCH_CHANGED'
} = {}) {
  validBranch(root, name);
  if (fetch) await fetchRemote(root, remote);
  const synchronize = fetch || fetched;
  const immutableCommit = exactCommit == null
    ? null
    : refHead(root, `${exactCommit}^{commit}`);
  if (exactCommit != null && immutableCommit !== exactCommit) {
    throw new SingularityFlowError(
      `Branch ${name} cannot be checked out because its accepted commit is unavailable.`,
      {
        code: exactCommitErrorCode,
        details: { branch: name, expectedCommit: exactCommit, observedCommit: immutableCommit }
      }
    );
  }
  const assertExactRef = (ref) => {
    if (!immutableCommit) return;
    const observedCommit = refHead(root, ref);
    if (observedCommit !== immutableCommit) {
      throw new SingularityFlowError(
        `Branch ${name} moved after its accepted commit was frozen.`,
        {
          code: exactCommitErrorCode,
          details: { branch: name, ref, expectedCommit: immutableCommit, observedCommit }
        }
      );
    }
  };
  if (branch(root) === name) {
    assertExactRef(`refs/heads/${name}`);
    if (!immutableCommit && synchronize && refExists(root, `refs/remotes/${remote}/${name}`)) {
      if (!hasUpstream(root)) {
        configureUpstream(root, name, remote);
      }
      // The exact remote-tracking ref was refreshed above or by the caller. Fast-forward to those
      // local bytes instead of asking the remote a second time through `git pull`.
      fastForwardTo(root, `${remote}/${name}`);
    }
    return 'already-current';
  }
  // One bounded, fresh observation replaces up to four separate processes on the new-branch
  // path. Keep it inside checkout, after any fetch: mutable refs are never cached across calls.
  const candidates = localRefHeads(root, [
    `refs/heads/${name}`, `refs/remotes/${remote}/${name}`,
    ...(!existingOnly ? [`refs/remotes/${remote}/${base}`, `refs/heads/${base}`] : [])
  ].filter(isGitRefName));
  if (candidates.has(`refs/heads/${name}`)) {
    assertExactRef(`refs/heads/${name}`);
    git(['switch', name], { cwd: root, stdio: 'inherit' });
    if (!immutableCommit && synchronize && refExists(root, `refs/remotes/${remote}/${name}`)) {
      if (!hasUpstream(root)) {
        configureUpstream(root, name, remote);
      }
      fastForwardTo(root, `${remote}/${name}`);
    }
    return 'checked-out-local';
  }
  if (candidates.has(`refs/remotes/${remote}/${name}`)) {
    assertExactRef(`refs/remotes/${remote}/${name}`);
    git(['switch', '--no-track', '-c', name, immutableCommit ?? `${remote}/${name}`], {
      cwd: root, stdio: 'inherit'
    });
    configureUpstream(root, name, remote);
    return 'tracked-remote';
  }
  if (existingOnly) throw new SingularityFlowError(`Branch ${name} does not exist locally or on ${remote}.`);
  // A fetched start must fork from the ref that was just refreshed. Preferring a stale local
  // `main` here silently excluded configuration and world-model commits already merged upstream.
  // Callers that deliberately work offline retain the historical local-first behavior.
  const remoteBase = candidates.has(`refs/remotes/${remote}/${base}`) ? `${remote}/${base}` : null;
  const localBase = candidates.has(`refs/heads/${base}`) ? base : null;
  const baseRef = preferRemoteBase
    ? remoteBase ?? localBase ?? 'HEAD'
    : localBase ?? remoteBase ?? 'HEAD';
  git(['switch', '-c', name, baseRef], { cwd: root, stdio: 'inherit' });
  return `created-from-${baseRef}`;
}

/** Observe a small set of exact local refs in one bounded read, without caching mutable tips. */
export function localRefHeads(root, refs) {
  if (!Array.isArray(refs) || !refs.length || refs.length > 32
      || refs.some((ref) => typeof ref !== 'string' || !ref.startsWith('refs/')
        || /[\s\u0000-\u001f\u007f*?\[\\~^:]/u.test(ref) || ref.includes('..')
        || ref.endsWith('/') || ref.startsWith('-'))) {
    throw new SingularityFlowError('Local ref observation requires bounded exact ref names.', {
      code: 'GIT_REF_SELECTION_INVALID'
    });
  }
  const selected = new Set(refs);
  const result = git(['for-each-ref', '--format=%(refname) %(objectname)', ...selected], {
    cwd: root, allowFailure: true, maxBuffer: 64 * 1024
  });
  const output = gitReadOutput(result, 'Selected local refs');
  const observed = new Map();
  for (const line of output.trim().split(/\r?\n/u).filter(Boolean)) {
    const [ref, commit, extra] = line.split(' ');
    if (extra || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit ?? '')) throw new SingularityFlowError(
      'Local ref observation returned an invalid object identity.', { code: 'GIT_READ_UNAVAILABLE' }
    );
    // Git also lists descendants of a requested ref prefix. They are not the requested ref.
    if (selected.has(ref)) observed.set(ref, commit);
  }
  return observed;
}

export { refHead };

/** The commit a ref names, or null when it names none (`rev-parse --verify --quiet` answers 1). */
export function refCommit(root, ref, { env = process.env } = {}) {
  const result = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, env, allowFailure: true });
  return gitReadOutput(result, `The commit of ${ref}`, { absentStatus: 1 })?.trim() || null;
}

/**
 * Remote-tracking branches that share no history with the default branch: orphan branches, such as
 * one that holds pages or state, which can never be a line of application work. Read from this
 * clone's remote-tracking refs without contacting the remote, in two Git calls however many
 * branches there are. `checked` is false when this clone cannot tell: it is shallow, so its root
 * commits are only a boundary, or it has no copy of the default branch.
 */
export function orphanRemoteBranches(root, { remote = 'origin', defaultBranch = 'main', env = process.env } = {}) {
  const unknown = { checked: false, orphans: [] };
  const shallow = git(['rev-parse', '--is-shallow-repository'], { cwd: root, env, allowFailure: true });
  if (shallow.status !== 0 || String(shallow.stdout).trim() !== 'false') return unknown;
  const roots = git(['rev-list', '--max-parents=0', `refs/remotes/${remote}/${defaultBranch}`, '--'], {
    cwd: root, env, allowFailure: true
  });
  if (roots.status !== 0) return unknown;
  const rootCommits = String(roots.stdout).split('\n').map((line) => line.trim()).filter(Boolean);
  if (!rootCommits.length) return unknown;
  // A branch that contains none of the default branch's root commits shares none of its history.
  const listed = git([
    'for-each-ref', '--format=%(refname)', ...rootCommits.flatMap((commit) => ['--no-contains', commit]),
    `refs/remotes/${remote}/`
  ], { cwd: root, env, allowFailure: true });
  if (listed.status !== 0) return unknown;
  const prefix = `refs/remotes/${remote}/`;
  const orphans = String(listed.stdout).split('\n').map((line) => line.trim())
    .filter((ref) => ref.startsWith(prefix)).map((ref) => ref.slice(prefix.length))
    .filter((name) => name && name !== 'HEAD');
  return { checked: true, orphans: [...new Set(orphans)].sort() };
}

/**
 * Whether two refs share any history: false for an orphan branch against the default branch, null
 * when Git cannot answer (a missing ref or object). `merge-base` exits 1 with no output exactly
 * when the two have no common ancestor.
 */
export function refsShareHistory(root, left, right, { env = process.env } = {}) {
  const result = git(['merge-base', left, right, '--'], { cwd: root, env, allowFailure: true });
  if (result.status === 0 && String(result.stdout).trim()) return true;
  if (result.status === 1 && !String(result.stdout).trim()) return false;
  return null;
}

/** The checked-out branch, or null when HEAD is detached. */
export function checkedOutBranch(root, { env = process.env } = {}) {
  const result = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root, env, allowFailure: true });
  return gitReadOutput(result, 'The checked-out branch', { absentStatus: 1 })?.trim() || null;
}

/** Changed and untracked paths under `paths` in the working tree, sorted. */
export function changedPaths(root, paths, { env = process.env } = {}) {
  const output = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths], { cwd: root, env }).stdout;
  return String(output).split('\0').filter(Boolean).map((entry) => entry.slice(3)).filter(Boolean).sort();
}

/**
 * A digest of every tracked entry at HEAD (mode, object id and path) outside `excludedRoot`, or null
 * when HEAD cannot be read. Rework compares it to tell whether an approval's code is unchanged.
 */
export function headTreeDigest(root, { excludedRoot = null, env = process.env } = {}) {
  const listed = git(['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], { cwd: root, env, allowFailure: true });
  if (listed.status !== 0) return null;
  const entries = String(listed.stdout).split('\0')
    .filter((entry) => entry && !(excludedRoot && entry.slice(entry.indexOf('\t') + 1).startsWith(excludedRoot)));
  return `sha256:${createHash('sha256').update(entries.join('\0')).digest('hex')}`;
}

/** The names of a commit's top-level tree entries. */
export function topLevelEntries(root, commit, { env = process.env } = {}) {
  const output = git(['ls-tree', '-z', '--name-only', commit], { cwd: root, env }).stdout;
  return new Set(String(output).split('\0').filter(Boolean));
}

/**
 * The SHA-256 of every file at a commit under `paths`, keyed by repository path, read from the
 * object database. A path the commit does not have is absent from the map.
 */
export function committedFileDigests(root, commit, paths, { env = process.env } = {}) {
  const output = git(['ls-tree', '-r', '-z', '--full-tree', commit, '--', ...paths], { cwd: root, env }).stdout;
  const entries = String(output).split('\0').filter(Boolean).map((line) => {
    const [meta, file] = line.split('\t');
    const [, type, oid] = meta.split(' ');
    return { type, oid, file };
  }).filter((entry) => entry.type === 'blob');
  const blobs = readLocalGitBlobs(root, entries.map((entry) => entry.oid), { env, label: 'Committed configuration' });
  return new Map(entries.map((entry) => [entry.file, createHash('sha256').update(blobs.get(entry.oid)).digest('hex')]));
}

/** One file's text at a ref, or null when the ref or the file does not exist. */
export function committedFileText(root, ref, relative, { env = process.env } = {}) {
  const result = git(['cat-file', '-p', `${ref}:${relative}`], { cwd: root, env, allowFailure: true });
  if (result.status === 0) return result.stdout;
  // cat-file answers 128 for a missing ref or path; anything else is a failure to read.
  return gitReadOutput(result, `${relative} at ${ref}`, { absentStatus: 128 });
}

/** One file's bytes at a ref, or null when the ref or the file does not exist. */
export function committedFileBytes(root, ref, relative, { env = process.env } = {}) {
  const result = git(['rev-parse', '--verify', '--quiet', `${ref}:${relative}`], { cwd: root, env, allowFailure: true });
  const oid = gitReadOutput(result, `${relative} at ${ref}`, { absentStatus: 1, absentWhen: (observed) => observed.status === 128 })?.trim();
  if (!oid) return null;
  return readLocalGitBlobs(root, [oid], { env, label: `${relative} at ${ref}` }).get(oid);
}

/** Files of exact objects already read in this process (exactFileAtObject). `[perf]` */
const exactObjectFiles = new Map();

/**
 * `<commit ID>:<path>` names the same object forever, so a row Git resolved for one is kept for
 * this process. `[perf]` One lifecycle command asked for the same Story files at the same commits
 * up to six times: about a hundred repeated resolutions in one Story. A missing row is not kept (a
 * fetch can supply the object), nor is anything asked under a relocating Git environment.
 */
const resolvedCommittedPaths = new Map();
const RESOLVED_COMMITTED_PATHS = 8_192;
const FULL_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const OBJECT_RELOCATING_ENV = ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];

function resolvedCommittedPathRows(root, names, refs, env, resolve) {
  const scope = OBJECT_RELOCATING_ENV.some((name) => env[name]) ? null : path.resolve(root);
  const keyOf = (index) => (scope && FULL_OBJECT_ID.test(refs[index]) ? `${scope}\0${names[index]}` : null);
  const rows = names.map((name, index) => {
    const key = keyOf(index);
    return key ? resolvedCommittedPaths.get(key) ?? null : null;
  });
  const unknown = names.map((name, index) => index).filter((index) => rows[index] === null);
  if (!unknown.length) return { status: 0, rows };
  const checked = resolve(unknown.map((index) => names[index]));
  if (checked.status !== 0) return { status: checked.status, checked, rows: null };
  const answered = String(checked.stdout).split('\n');
  unknown.forEach((index, position) => {
    const row = String(answered[position] ?? '');
    rows[index] = row;
    const key = keyOf(index);
    if (key && /^[a-f0-9]{40,64} \w+ \d+$/u.test(row.trim())) {
      resolvedCommittedPaths.set(key, row);
      if (resolvedCommittedPaths.size > RESOLVED_COMMITTED_PATHS) {
        resolvedCommittedPaths.delete(resolvedCommittedPaths.keys().next().value);
      }
    }
  });
  return { status: 0, checked, rows };
}

/**
 * Files at several revisions, read in a fixed number of Git calls however many are asked for.
 * `requests` is `[{ key, ref, path }]`; the map holds the bytes of each file that exists and fits
 * `maximumObjectBytes`. A missing ref or path, or one past either byte ceiling, is simply absent.
 * `requireCompleteRead` refuses resolver/size failures instead of silently omitting known files,
 * for callers with an independent-copy fallback. Missing refs/files can still be absent.
 */
/** A name the line-based batch reader would split, truncate or alias; it is read exactly instead. */
const BATCH_UNSAFE_NAME = /[\u0000-\u001f\u007f]/u;

export function committedFilesAtRevisions(root, requests, {
  env = process.env, maximumObjectBytes = 4 * 1024 * 1024, maximumBytes = 32 * 1024 * 1024,
  requireCompleteRead = false
} = {}) {
  // `cat-file --batch-check` reads one name per line and drops a trailing carriage return, so
  // "a.js\r" resolved to a.js: a different file than the one asked for. A name with any control
  // character is left out (absent here); a caller that must know reads it exactly.
  const wanted = (requests ?? []).filter((request) => request?.ref && request?.path
    && !BATCH_UNSAFE_NAME.test(`${request.ref}:${request.path}`));
  if (!wanted.length) return new Map();
  const resolution = resolvedCommittedPathRows(root,
    wanted.map((request) => `${request.ref}:${request.path}`), wanted.map((request) => request.ref), env,
    (names) => {
      const checked = git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
        cwd: root, env: immutableLocalGitEnvironment(env), allowFailure: true,
        input: `${names.join('\n')}\n`
      });
      if (requireCompleteRead) gitReadOutput(checked, 'Committed file resolution');
      return checked;
    });
  if (resolution.status !== 0) {
    if (requireCompleteRead) gitReadOutput(resolution.checked, 'Committed file resolution');
    return new Map();
  }
  const rows = resolution.rows;
  const found = [];
  let total = 0;
  wanted.forEach((request, index) => {
    // A missing name echoes the request back ("<name> missing"), so only a blob row is a file.
    const [oid, type, rawSize] = String(rows[index] ?? '').trim().split(' ');
    const size = Number(rawSize);
    if (type !== 'blob' || !/^[a-f0-9]{40,64}$/u.test(oid ?? '') || !Number.isSafeInteger(size)
      || size < 0) return;
    if (size > maximumObjectBytes || total + size > maximumBytes) {
      if (requireCompleteRead) throw new SingularityFlowError('Committed files exceed the batch byte ceiling.', {
        code: 'GIT_COMMITTED_FILE_LIMIT'
      });
      return;
    }
    total += size;
    found.push({ key: request.key, oid });
  });
  if (!found.length) return new Map();
  const blobs = readLocalGitBlobs(root, found.map((entry) => entry.oid), { env, label: 'Committed files' });
  return new Map(found.map((entry) => [entry.key, blobs.get(entry.oid)]));
}

/**
 * The subjects of the most recent commits on the first-parent line of `commit`, newest first: the
 * line of work a branch followed, without the history its merges brought in. Empty when Git
 * cannot walk it.
 */
export function recentFirstParentSubjects(root, commit, { limit = 100, env = process.env } = {}) {
  const result = git(['log', '--first-parent', `--max-count=${limit}`, '--format=%x1f%s', commit, '--'], {
    cwd: root, env: immutableLocalGitEnvironment(env), allowFailure: true
  });
  if (result.status !== 0) return [];
  // Marked, so lines a configured log.showSignature adds are never read as subjects.
  return String(result.stdout).split('\n').filter((line) => line.startsWith('\x1f'))
    .map((line) => line.slice(1).trim()).filter(Boolean);
}

/** The most recent commit reachable from HEAD that added `relative`, or null. */
export function commitAddingPath(root, relative, { env = process.env } = {}) {
  const output = git(['log', '--diff-filter=A', '--format=%H', '-1', '--', relative], { cwd: root, env }).stdout.trim();
  return output || null;
}

/** The paths one commit changed against its first parent, sorted. */
export function commitChangedPaths(root, commit, { env = process.env } = {}) {
  const output = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', commit], { cwd: root, env }).stdout;
  return String(output).split('\0').filter(Boolean).sort();
}

/** Every ref and the object it names, for proving which refs an operation moved. */
export function refSnapshot(root, { env = process.env } = {}) {
  const output = git(['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: root, env }).stdout;
  return new Map(String(output).split('\n').filter(Boolean).map((line) => line.split(' ')));
}

/**
 * Bundle `refs` into `file` and verify it, so every listed ref can be fetched back from the file
 * alone. Refuses to overwrite an existing file.
 */
export function createRefsBundle(root, file, refs, { env = process.env } = {}) {
  invariant(refs.length > 0, 'A bundle needs at least one ref.');
  invariant(refs.every((ref) => /^(?:HEAD|refs\/[A-Za-z0-9._\/-]+)$/u.test(ref) && !ref.includes('..')), 'Bundle refs are invalid.');
  if (existsSync(file)) throw new SingularityFlowError(`Backup bundle ${file} already exists.`, { code: 'GOVERNANCE_BACKUP_EXISTS' });
  git(['bundle', 'create', file, ...refs], { cwd: root, env });
  git(['bundle', 'verify', file], { cwd: root, env });
}

/**
 * Write the files a commit has under `paths` into `directory`, through a private index, so neither
 * the checkout, its index nor any ref changes.
 */
export async function exportCommitPaths(root, commit, paths, directory, { env = process.env } = {}) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-export-index-'));
  try {
    const indexEnv = { ...env, GIT_INDEX_FILE: path.join(scratch, 'index') };
    git(['read-tree', '--empty'], { cwd: root, env: indexEnv });
    for (const entry of paths) git(['read-tree', `--prefix=${entry}/`, `${commit}:${entry}`], { cwd: root, env: indexEnv });
    git(['checkout-index', '-a', '-f', `--prefix=${directory.replace(/\/?$/u, '/')}`], { cwd: root, env: indexEnv });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Keep `commit` reachable under `ref` (refs/... only), so moving a branch away from it loses nothing. */
export function preserveCommitRef(root, ref, commit) {
  invariant(/^refs\/[A-Za-z0-9._\/-]+$/u.test(String(ref ?? '')) && !String(ref).includes('..'), 'Preserved commit ref is invalid.');
  invariant(/^[0-9a-f]{40,64}$/u.test(String(commit ?? '')), 'Preserved commit ID is invalid.');
  git(['update-ref', ref, commit], { cwd: root });
}

/**
 * Point the checked-out branch at `commit`, refusing if a local change would be lost: Git's
 * `reset --keep`. Callers prove the tree clean and preserve the commit they leave first.
 */
export function moveCheckedOutBranch(root, commit) {
  invariant(/^[0-9a-f]{40,64}$/u.test(String(commit ?? '')), 'Branch target commit ID is invalid.');
  git(['reset', '--keep', commit], { cwd: root });
  return head(root);
}

export function fastForwardTo(root, ref) {
  git(['merge', '--ff-only', ref], { cwd: root, stdio: 'inherit' });
  return head(root);
}

/** A local ancestry proof; a missing object or malformed ref is never treated as an ancestor. */
export function isAncestor(root, older, newer) {
  return git(['merge-base', '--is-ancestor', older, newer], {
    cwd: root, allowFailure: true
  }).status === 0;
}

/**
 * Discard only a newly-created, still-empty attach staging checkout. Never touch a Story branch,
 * a dirty checkout, an unregistered path, or the current process directory.
 */
export function removeCleanAttachStagingWorktree(root, target, stagingBranch) {
  const absolute = path.resolve(target);
  const same = (left, right) => {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === 'win32'
      ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b;
  };
  const registered = git(['worktree', 'list', '--porcelain'], { cwd: root }).stdout
    .split(/(?=^worktree )/mu)
    .find((record) => record.startsWith('worktree ')
      && same(record.split(/\r?\n/u)[0].slice('worktree '.length), absolute));
  if (!registered || !registered.split(/\r?\n/u).includes(`branch refs/heads/${stagingBranch}`)
      || !same(gitCommonDir(absolute), gitCommonDir(root))
      || branch(absolute) !== stagingBranch || changes(absolute).trim()
      || same(absolute, process.cwd())) return false;
  const removed = git(['worktree', 'remove', '--', absolute], { cwd: root, allowFailure: true });
  if (removed.status !== 0) return false;
  git(['branch', '-D', '--', stagingBranch], { cwd: root, allowFailure: true });
  return true;
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
  const target = ref === 'HEAD' ? (refHead(root, 'HEAD') ?? ref) : ref;
  const result = git(['show', `${target}:${file}`], { cwd: root, allowFailure: true });
  return result.status === 0 ? result.stdout : null;
}

/** Local, disposable-checkout reads for a capability proposal's exact rebase review. */
export function proposalGitRef(root, ref, { env = process.env } = {}) {
  return refHead(root, ref, { env });
}

export function proposalGitFile(root, ref, file, { env = process.env } = {}) {
  const result = git(['show', `${ref}:${file}`], { cwd: root, env, allowFailure: true });
  return result.status === 0 ? result.stdout : null;
}

/** `null` means the local Git cannot establish a result, never that a merge is clean. */
export function proposalGitMergeProbe(root, targetCommit, proposalRef, {
  env = process.env, forceLegacyProbe = false
} = {}) {
  // The explicit fallback switch is used by the minimum-supported-Git regression fixture;
  // production callers always take the modern probe first when their Git supports it.
  if (!forceLegacyProbe) {
    const result = git(['merge-tree', '--write-tree', '--quiet', targetCommit, proposalRef], {
      cwd: root, env, allowFailure: true
    });
    if (result.error || result.timedOut) return null;
    if (result.status === 0) return true;
    if (result.status === 1) return false;
  }
  // Git 2.25 is still supported, but its merge-tree has no --write-tree status contract.
  // Probe in a *local disposable clone* instead of guessing from the legacy human-readable
  // merge-tree output. A non-zero merge result proves a conflict only when Git left unmerged
  // index entries; auth, object, hook, and other failures remain unknown.
  const target = proposalGitRef(root, targetCommit, { env });
  const proposal = proposalGitRef(root, proposalRef, { env });
  if (!target || !proposal) return null;
  let scratch;
  try { scratch = mkdtempSync(path.join(os.tmpdir(), 'sflow-proposal-merge-probe-')); }
  catch { return null; }
  const probeEnv = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };
  let outcome = null;
  try {
    const cloned = git(['clone', '--quiet', '--shared', '--no-checkout', '--', root, scratch], {
      cwd: root, env: probeEnv, allowFailure: true
    });
    if (cloned.status === 0) {
      const disabledHooks = ['-c', `core.hooksPath=${path.join(scratch, '.git', 'sflow-disabled-hooks')}`];
      const checkedOut = git([...disabledHooks, 'checkout', '--quiet', '--detach', target], {
        cwd: scratch, env: probeEnv, allowFailure: true
      });
      if (checkedOut.status === 0) {
        const merged = git([
          ...disabledHooks,
          '-c', 'commit.gpgsign=false',
          '-c', 'user.name=Singularity Flow merge probe',
          '-c', 'user.email=merge-probe@localhost',
          'merge', '--no-commit', '--no-ff', '--no-edit', proposal
        ], { cwd: scratch, env: probeEnv, allowFailure: true });
        if (merged.status === 0) outcome = true;
        else if (!merged.error && !merged.timedOut) {
          const unmerged = git(['ls-files', '--unmerged', '-z'], {
            cwd: scratch, env: probeEnv, allowFailure: true
          });
          if (unmerged.status === 0 && unmerged.stdout) outcome = false;
        }
      }
    }
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // A locked temporary probe is not evidence that the authority is mergeable.
      outcome = null;
    }
  }
  return outcome;
}

export function proposalGitStatus(root, { env = process.env } = {}) {
  return git(['status', '--porcelain', '-z'], { cwd: root, env }).stdout;
}

export function proposalGitChangedPaths(root, { env = process.env } = {}) {
  return git(['diff', '--name-only', '-z', 'HEAD'], { cwd: root, env }).stdout
    .split('\0').filter(Boolean);
}

/**
 * Preserve original proposal ancestry in a newly reviewed semantic merge commit.
 * The scratch checkout already contains an ordinary single-parent proposal commit. Repoint its
 * branch by compare-and-swap to an equivalent-tree, two-parent commit; the working tree and index
 * are unchanged, so no destructive reset is necessary. The caller still performs final validation
 * and a leased push before anything leaves this disposable checkout.
 */
export function proposalGitLineageCommit(root, {
  baseCommit, sourceCommit, message, author, env = process.env
}) {
  const previous = proposalGitRef(root, 'HEAD', { env });
  if (!previous) throw new SingularityFlowError('Rebase review commit is unavailable in its checkout.');
  const tree = git(['rev-parse', `${previous}^{tree}`], { cwd: root, env }).stdout.trim();
  const created = git([
    '-c', `user.name=${author.name}`,
    '-c', `user.email=${author.email}`,
    'commit-tree', tree, '-p', baseCommit, '-p', sourceCommit, '-m', message
  ], { cwd: root, env }).stdout.trim();
  const updated = git(['update-ref', 'HEAD', created, previous], {
    cwd: root, env, allowFailure: true
  });
  if (updated.status !== 0) {
    throw new SingularityFlowError('Rebase review branch changed before its lineage commit was installed.', {
      code: 'CAPABILITY_PROPOSAL_REBASE_PLAN_STALE'
    });
  }
  return created;
}

const EXACT_LOCAL_OBJECT_ID = /^[a-f0-9]{40,64}$/iu;

/**
 * Optional, bounded prefetch for repeated exact-object replay reads. `[perf]`
 *
 * Only full immutable object IDs qualify. Returned blobs have verified object hashes, but do not
 * prove a regular-file mode: a regularOnly caller must still use exactFileAtObject. An omitted
 * path is not evidence of absence; the caller must use its ordinary exact read for that path or
 * a different byte limit. Special object stores retain their per-read cleanup/environment checks.
 */
export function prefetchExactObjectFiles(root, objectId, files, {
  maximumObjectBytes = 16 * 1024 * 1024, maximumBytes = 32 * 1024 * 1024
} = {}) {
  if (!EXACT_LOCAL_OBJECT_ID.test(String(objectId ?? ''))
      || ISOLATED_GIT_OBJECT_REPOSITORIES.has(root)
      || OBJECT_RELOCATING_ENV.some((name) => process.env[name])) return new Map();
  const wanted = [...new Set(files)].filter((file) => typeof file === 'string' && file.length > 0
    && file.length <= 4096 && !BATCH_UNSAFE_NAME.test(file)).slice(0, 512);
  const prefetched = new Map();
  let remainingBytes = maximumBytes;
  const scope = path.resolve(root);
  for (const file of wanted) {
    const known = exactObjectFiles.get(`${scope}\0${objectId}:${file}`);
    if (known && known.length <= maximumObjectBytes && known.length <= remainingBytes) {
      prefetched.set(file, Buffer.from(known));
      remainingBytes -= known.length;
    }
  }
  const unread = wanted.filter(file => !prefetched.has(file));
  // A small replay already benefits from exactFileAtObject's process-local memo; don't add a
  // resolver and object-format lookup just to replace one or two reads.
  if (unread.length < 4 || remainingBytes <= 0) return prefetched;
  // An integrity or process-boundary refusal must propagate, never downgrade to a less strict
  // read. Ordinary missing/oversized entries are omitted by the bounded batch and read normally.
  const batch = committedFilesAtRevisions(root, unread.map((file) => ({ key: file, ref: objectId, path: file })), {
    maximumObjectBytes, maximumBytes: remainingBytes
  });
  return new Map([...prefetched, ...batch]);
}

/** Read one blob from an exact local object without replace refs or a promisor-network fallback. */
export function exactFileAtObject(root, objectId, file, { maximumBytes = 1024 * 1024, regularOnly = false } = {}) {
  invariant(EXACT_LOCAL_OBJECT_ID.test(String(objectId ?? '')), 'Exact Git object ID is invalid.');
  invariant(typeof file === 'string' && file.length > 0 && !file.includes('\0'), 'Exact Git path is invalid.');
  if (regularOnly) {
    const entry = git(['--literal-pathspecs', 'ls-tree', '-z', objectId, '--', file], {
      cwd: root, env: immutableLocalGitEnvironment(), allowFailure: true, maxBuffer: Buffer.byteLength(file) + 512
    });
    const match = String(entry.stdout ?? '').match(/^(100644|100755) blob [a-f0-9]{40,64}\t([^\0]+)\0$/u);
    if (entry.status !== 0 || !match || match[2] !== file) return null;
  }
  // An exact object's file never changes; a repeat in this process reads what Git already gave.
  const isolated = ISOLATED_GIT_OBJECT_REPOSITORIES.has(root);
  const memoKey = isolated || OBJECT_RELOCATING_ENV.some((name) => process.env[name]) ? null
    : `${path.resolve(root)}\0${objectId}:${file}`;
  const known = memoKey ? exactObjectFiles.get(memoKey) : null;
  if (known && known.length <= maximumBytes) return Buffer.from(known);
  const result = git(['show', `${objectId}:${file}`], {
    cwd: root,
    env: immutableLocalGitEnvironment(),
    allowFailure: true,
    encoding: 'buffer',
    maxBuffer: maximumBytes
  });
  if (memoKey && result.status === 0 && Buffer.isBuffer(result.stdout) && result.stdout.length <= 1024 * 1024) {
    exactObjectFiles.set(memoKey, Buffer.from(result.stdout));
    if (exactObjectFiles.size > 512) exactObjectFiles.delete(exactObjectFiles.keys().next().value);
  }
  if (isolated && !processResultCompleted(result)) {
    const error = new SingularityFlowError('The isolated exact-object read did not prove process cleanup.', { code: 'GIT_OBJECT_READ_UNAVAILABLE' });
    error.temporaryGitCleanupUnproven = true;
    throw error;
  }
  if (result.status !== 0) return null;
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
}

/** Bounded first-parent record history; never use textconv, external diff, replace refs or lazy fetch. */
export function exactFirstParentFileChanges(root, objectId, file, { pattern, maximum = 1000 } = {}) {
  invariant(EXACT_LOCAL_OBJECT_ID.test(String(objectId ?? '')), 'Exact Git history tip is invalid.');
  invariant(typeof file === 'string' && file.length > 0 && !file.includes('\0'), 'Exact Git history path is invalid.');
  invariant(typeof pattern === 'string' && pattern.length > 0 && pattern.length <= 256 && !/[\x00-\x1f]/u.test(pattern), 'Git record history pattern is invalid.');
  invariant(Number.isInteger(maximum) && maximum > 0 && maximum <= 4096, 'Git record history limit is invalid.');
  const output = gitAnswer(['--literal-pathspecs', 'log', '--first-parent', '--diff-merges=first-parent',
    '--format=%H', '--no-show-signature', '--no-notes', '--no-decorate', '--no-ext-diff', '--no-textconv',
    `--max-count=${maximum}`, '-G', pattern, '--no-patch', objectId, '--', file],
  { cwd: root, env: immutableLocalGitEnvironment(), maxBuffer: maximum * 65 + 512 }, 'Exact record history');
  const commits = output.trim().split('\n').filter(Boolean).reverse();
  invariant(commits.every(commit => EXACT_LOCAL_OBJECT_ID.test(commit)), 'Git record history returned invalid commit identities.');
  return commits;
}

/** List paths from an exact local tree under the same immutable-object boundary. */
export function exactTreePathsAtObject(root, objectId, pathspec = []) {
  invariant(EXACT_LOCAL_OBJECT_ID.test(String(objectId ?? '')), 'Exact Git object ID is invalid.');
  invariant(Array.isArray(pathspec) && pathspec.every((entry) => (
    typeof entry === 'string' && entry.length > 0 && !entry.includes('\0')
  )), 'Exact Git pathspec is invalid.');
  const result = git(['ls-tree', '-r', '--name-only', '-z', objectId, ...pathspec], {
    cwd: root,
    env: immutableLocalGitEnvironment(),
    allowFailure: true
  });
  if (ISOLATED_GIT_OBJECT_REPOSITORIES.has(root) && !processResultCompleted(result)) {
    const error = new SingularityFlowError('The isolated exact-tree read did not prove process cleanup.', { code: 'GIT_OBJECT_READ_UNAVAILABLE' });
    error.temporaryGitCleanupUnproven = true;
    throw error;
  }
  return result.status === 0 ? nullList(result.stdout) : null;
}

/** Compare exact local object trees without replace refs, caller indexes or lazy remote fetches. */
export function exactChangedPathsBetweenObjects(root, before, after) {
  invariant(EXACT_LOCAL_OBJECT_ID.test(String(before ?? '')) && EXACT_LOCAL_OBJECT_ID.test(String(after ?? '')),
    'Exact Git comparison requires full object IDs.');
  const result = git(['diff-tree', '--no-commit-id', '--no-ext-diff', '--no-renames', '--name-only', '-r', '-z', before, after, '--'], {
    cwd: root, env: immutableLocalGitEnvironment(), allowFailure: true, maxBuffer: 4 * 1024 * 1024
  });
  const output = gitReadOutput(result, 'Exact local changed paths');
  return nullList(output);
}

/**
 * A transient exact-object repository, never a worktree or a contributor object database.
 * Remote contact stays at the existing frozen enterprise transport boundary. A child with an
 * indeterminate termination leaves its private scratch retained rather than racing Windows
 * directory removal against a surviving Git/helper process.
 */
const ISOLATED_GIT_OBJECT_REPOSITORIES = new Set();

export async function withIsolatedGitObjectRepository({
  remote, expectedCommit = null, objectFormat = 'sha1', maximumBytes = 64 * 1024 * 1024
}, callback) {
  assertCredentialFreeRemote(remote);
  invariant(isPortableAbsoluteGitPath(remote) || /^[a-z][a-z0-9+.-]*:\/\//iu.test(remote)
    || /^(?:[^/@:\s]+@)?(?:\[[^\]]+\]|[^/:\s]+):.+$/u.test(remote) && !/^file:/iu.test(remote),
  'Isolated Git repositories require an already anchored remote destination.');
  invariant(['sha1', 'sha256'].includes(objectFormat), 'Invalid isolated Git object format.');
  invariant(expectedCommit === null || EXACT_LOCAL_OBJECT_ID.test(expectedCommit)
    && expectedCommit.length === (objectFormat === 'sha256' ? 64 : 40), 'Invalid exact remote object identity.');
  invariant(Number.isSafeInteger(maximumBytes) && maximumBytes > 0
    && maximumBytes <= 512 * 1024 * 1024 && typeof callback === 'function', 'Invalid isolated object budget.');
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-exact-objects-'));
  let retained = false;
  const controls = Object.freeze({ retainTemporaryTree() { retained = true; } });
  const env = isolatedObjectWriterEnvironment();
  async function repositoryBytes(directory) {
    let total = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new SingularityFlowError('The isolated Git repository contains an unsafe entry.', { code: 'GIT_OBJECT_REPOSITORY_INVALID' });
      }
      total += entry.isDirectory() ? await repositoryBytes(file) : (await lstat(file)).size;
      if (total > maximumBytes + 1024 * 1024) {
        throw new SingularityFlowError('The isolated Git repository exceeds its storage budget.', { code: 'GIT_OBJECT_REPOSITORY_LIMIT' });
      }
    }
    return total;
  }
  try {
    const initialized = git(['-c', `core.hooksPath=${gitDisabledHooksPath()}`, 'init', '--bare', '--quiet', '--template=', `--object-format=${objectFormat}`, scratch], { cwd: scratch, env, allowFailure: true, timeoutMs: 30_000 });
    if (!processResultCompleted(initialized)) retained = true;
    if (!processResultSucceeded(initialized)) throw new SingularityFlowError('Unable to initialize an isolated exact-object repository.', { code: 'GIT_OBJECT_REPOSITORY_UNAVAILABLE' });
    ISOLATED_GIT_OBJECT_REPOSITORIES.add(scratch);
    if (expectedCommit !== null) {
      const transport = frozenRemoteTransport(remote);
      const fetched = await runRemoteGitAsync([
        '-c', `core.hooksPath=${gitDisabledHooksPath()}`, '-c', 'fetch.unpackLimit=1',
        'fetch', '--no-tags', '--no-write-fetch-head', '--depth=1', '--', transport.remote, expectedCommit
      ], { cwd: scratch, env: transport.env, operation: 'remote-configuration', maxBuffer: 1024 * 1024 });
      if (!processResultCompleted(fetched)) retained = true;
      if (!processResultSucceeded(fetched)) throw new SingularityFlowError('Unable to fetch the exact shared object revision.', { code: 'GIT_OBJECT_REPOSITORY_UNAVAILABLE' });
      await repositoryBytes(scratch);
      // Closed, inert callers may not reinterpret a symlink or submodule as an ordinary retained
      // byte sequence. Check the whole exact tree before returning any file to the caller.
      const listed = git(['ls-tree', '-r', '-z', expectedCommit], { cwd: scratch, env, allowFailure: true, maxBuffer: 2 * 1024 * 1024, timeoutMs: 30_000 });
      if (!processResultCompleted(listed)) retained = true;
      if (!processResultSucceeded(listed) || listed.stdout.split('\0').filter(Boolean).some((row) => !/^100644 blob (?:[a-f0-9]{40}|[a-f0-9]{64})\t/u.test(row))) {
        throw new SingularityFlowError('The exact shared tree contains a non-regular or unreadable entry.', { code: 'GIT_OBJECT_REPOSITORY_INVALID' });
      }
    }
    return await callback(scratch, controls);
  } catch (error) {
    if (error?.temporaryGitCleanupUnproven === true) retained = true;
    throw error;
  } finally {
    ISOLATED_GIT_OBJECT_REPOSITORIES.delete(scratch);
    if (!retained) await removeTemporaryTree(scratch);
  }
}

function isolatedObjectWriterEnvironment() {
  return {
    ...immutableLocalGitEnvironment(),
    GIT_CONFIG_SYSTEM: gitEmptyConfigPath(), GIT_CONFIG_GLOBAL: gitEmptyConfigPath(),
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never'
  };
}

/**
 * Write literal Git blobs/trees and one commit; do not stage, check out, update a ref, or run hooks.
 * This exact-object owner accepts bounded bytes, not caller source paths or executable Git flags.
 */
export async function writeExactGitObjectCommit(root, {
  parentCommit = null, files, commitIdentity, message
}) {
  invariant(path.isAbsolute(root), 'An exact object repository root is required.');
  invariant(ISOLATED_GIT_OBJECT_REPOSITORIES.has(root), 'Exact object writes require a live isolated repository owned by the Git service.');
  invariant(parentCommit === null || EXACT_LOCAL_OBJECT_ID.test(parentCommit), 'Invalid exact commit parent.');
  invariant(files instanceof Map && files.size > 0 && files.size <= 16_384, 'Invalid exact object file count.');
  invariant(typeof message === 'string' && Buffer.byteLength(message) <= 4096 && !message.includes('\0'), 'Invalid exact commit message.');
  const identityValue = validateGitCommitIdentity(commitIdentity);
  const env = gitCommitIdentityEnvironment(isolatedObjectWriterEnvironment(), identityValue);
  const formatResult = git(['rev-parse', '--show-object-format'], { cwd: root, env, allowFailure: true, timeoutMs: 30_000, killSignal: 'SIGKILL' });
  if (!processResultSucceeded(formatResult)) {
    const error = new SingularityFlowError('The isolated repository object format is unavailable.', { code: 'GIT_OBJECT_WRITE_UNAVAILABLE' });
    error.temporaryGitCleanupUnproven = !processResultCompleted(formatResult);
    throw error;
  }
  const format = formatResult.stdout.trim();
  invariant(['sha1', 'sha256'].includes(format), 'Unknown exact object repository format.');
  invariant(parentCommit === null || parentCommit.length === (format === 'sha256' ? 64 : 40), 'Exact parent object format mismatch.');
  const temporary = await mkdtemp(path.join(root, 'exact-write-'));
  let retained = false;
  const checked = (args, options = {}) => {
    const result = git(['-c', `core.hooksPath=${gitDisabledHooksPath()}`, ...args], { cwd: root, env, timeoutMs: 30_000, killSignal: 'SIGKILL', allowFailure: true, ...options });
    if (!processResultCompleted(result)) retained = true;
    if (!processResultSucceeded(result)) {
      const error = new SingularityFlowError('Exact Git object creation failed.', { code: 'GIT_OBJECT_WRITE_UNAVAILABLE' });
      error.temporaryGitCleanupUnproven = retained;
      throw error;
    }
    return result.stdout.trim();
  };
  async function object(type, bytes) {
    const source = path.join(temporary, 'literal-object');
    await writeAtomic(source, bytes, { mode: 0o600 });
    const oid = checked(['hash-object', '-t', type, '-w', '--no-filters', '--', source]);
    invariant(EXACT_LOCAL_OBJECT_ID.test(oid) && oid.length === (format === 'sha256' ? 64 : 40), 'Invalid exact Git object result.');
    return oid;
  }
  try {
    if (parentCommit !== null) checked(['cat-file', '-e', `${parentCommit}^{commit}`]);
    const tree = new Map(); const folded = new Set(); let total = 0;
    for (const [relative, bytes] of files) {
      invariant(typeof relative === 'string' && Buffer.byteLength(relative) <= 512
        && !/[\\\0\r\n:]/u.test(relative) && !relative.startsWith('/')
        && relative.split('/').every((part) => /^[A-Za-z0-9._-]+$/u.test(part) && part !== '.' && part !== '..'), 'Invalid exact object path.');
      invariant(Buffer.isBuffer(bytes) && bytes.length <= 32 * 1024 * 1024, 'Invalid exact object bytes.');
      total += bytes.length;
      invariant(total <= 288 * 1024 * 1024, 'Exact object byte budget exceeded.');
      const normalized = relative.toLowerCase();
      invariant(!folded.has(normalized), 'Exact object paths collide on a portable filesystem.'); folded.add(normalized);
      const parts = relative.split('/'); let node = tree;
      for (const part of parts.slice(0, -1)) {
        if (!node.has(part)) node.set(part, new Map());
        invariant(node.get(part) instanceof Map, 'Exact object file/tree collision.'); node = node.get(part);
      }
      invariant(!node.has(parts.at(-1)), 'Exact object file/tree collision.');
      node.set(parts.at(-1), { oid: await object('blob', bytes) });
    }
    async function writeTree(node) {
      const entries = [...node.entries()].sort(([a, av], [b, bv]) => Buffer.compare(Buffer.from(a + (av instanceof Map ? '/' : '')), Buffer.from(b + (bv instanceof Map ? '/' : ''))));
      const chunks = [];
      for (const [name, value] of entries) {
        const directory = value instanceof Map;
        const oid = directory ? await writeTree(value) : value.oid;
        chunks.push(Buffer.from(`${directory ? '40000' : '100644'} ${name}\0`), Buffer.from(oid, 'hex'));
      }
      return object('tree', Buffer.concat(chunks));
    }
    const treeOid = await writeTree(tree);
    return checked(['commit-tree', treeOid, ...(parentCommit ? ['-p', parentCommit] : []), '-m', message]);
  } finally {
    if (!retained) await removeTemporaryTree(temporary);
  }
}

/** Publish only a live isolated author's draft object, with no local ref/tracking mutation. */
export async function pushIsolatedGitDraftCommit(root, {
  remote, commit, branch, expectedRemoteSha
}) {
  invariant(ISOLATED_GIT_OBJECT_REPOSITORIES.has(root), 'Draft pushes require a live isolated object repository.');
  invariant(/^sflow\/drafts\/[a-z0-9][a-z0-9-]{0,63}$/u.test(branch), 'Draft publication cannot target application or approved-configuration refs.');
  invariant(EXACT_LOCAL_OBJECT_ID.test(commit) && (expectedRemoteSha === null
    || EXACT_LOCAL_OBJECT_ID.test(expectedRemoteSha) && expectedRemoteSha.length === commit.length), 'Draft publication requires exact object identities.');
  assertCredentialFreeRemote(remote);
  const checked = git(['rev-parse', '--verify', `${commit}^{commit}`], {
    cwd: root, env: isolatedObjectWriterEnvironment(), allowFailure: true, timeoutMs: 30_000
  });
  if (!processResultSucceeded(checked) || checked.stdout.trim() !== commit) {
    const error = new SingularityFlowError('The exact draft commit could not be verified.', { code: 'GIT_OBJECT_WRITE_UNAVAILABLE' });
    error.temporaryGitCleanupUnproven = !processResultCompleted(checked);
    throw error;
  }
  const destination = `refs/heads/${branch}`;
  const transport = frozenRemoteTransport(remote, { push: true });
  const result = await runRemoteGitAsync([
    'push', '--porcelain', `--force-with-lease=${destination}:${expectedRemoteSha ?? ''}`,
    '--', transport.remote, `${commit}:${destination}`
  ], { cwd: root, env: transport.env, operation: 'remote-push', maxBuffer: 1024 * 1024 });
  if (processResultSucceeded(result)) {
    const transition = result.stdout.split(/\r?\n/u).map((line) => {
      const [flag, refspec] = line.split('\t');
      return refspec?.endsWith(`:${destination}`) ? flag : null;
    }).find((flag) => flag !== null);
    const acquired = expectedRemoteSha === null ? transition === '*' : transition === ' ' || transition === '+';
    if (!acquired) return { ...result, status: 1, leaseNotAcquired: true };
  }
  return result;
}

// ---- After-step Git deliveries -----------------------------------------------------------------
//
// A Git target receives one approved artifact as a commit on a branch of another repository (or a
// non-protected branch of this one). Everything happens in a live isolated object repository: the
// branch tip is read and its recent history fetched over the frozen transport, the file is written
// over the parent tree with a private index, and the commit is pushed without force, so the remote
// accepts only a fast-forward. No local ref, index, worktree or hook is touched.

/** A branch an after-step delivery may write: an ordinary name, never one Singularity Flow owns. */
export function validDeliveryBranch(branch) {
  return typeof branch === 'string' && branch.length >= 1 && branch.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(branch) && !branch.startsWith('sflow/')
    && !/(?:^|\/)\.|\.\.|\/\/|\.lock(?:\/|$)|\/$|@\{/u.test(branch) && branch !== 'HEAD';
}

function liveDeliveryRepository(root) {
  invariant(path.isAbsolute(root) && ISOLATED_GIT_OBJECT_REPOSITORIES.has(root), 'Git deliveries require a live isolated object repository owned by the Git service.');
}

function deliveryGitFailure(message, result, code = 'GIT_DELIVERY_REMOTE_FAILED') {
  const error = new SingularityFlowError(message, { code });
  error.remote = classifyGitRemoteFailure(result);
  error.temporaryGitCleanupUnproven = !processResultCompleted(result);
  return error;
}

/** The commit a remote branch points at, or null when the branch does not exist there yet. */
export async function isolatedRemoteBranchTip(root, { remote, branch }) {
  liveDeliveryRepository(root);
  assertCredentialFreeRemote(remote);
  invariant(validDeliveryBranch(branch), 'Invalid delivery branch.');
  const transport = frozenRemoteTransport(remote);
  const result = await runRemoteGitAsync([
    '-c', `core.hooksPath=${gitDisabledHooksPath()}`, 'ls-remote', '--heads', '--', transport.remote, `refs/heads/${branch}`
  ], { cwd: root, env: transport.env, operation: 'remote-configuration', maxBuffer: 64 * 1024 });
  if (!processResultSucceeded(result)) throw deliveryGitFailure('The delivery repository could not be read.', result);
  const row = result.stdout.split(/\r?\n/u).find((line) => line.endsWith(`\trefs/heads/${branch}`));
  const tip = row ? row.split('\t')[0] : null;
  invariant(tip === null || EXACT_LOCAL_OBJECT_ID.test(tip), 'Invalid remote branch tip.');
  return tip;
}

/** Fetch a remote tip with its recent history into the isolated repository. */
export async function fetchIsolatedDeliveryHistory(root, { remote, commit, depth = 100 }) {
  liveDeliveryRepository(root);
  assertCredentialFreeRemote(remote);
  invariant(EXACT_LOCAL_OBJECT_ID.test(commit) && Number.isSafeInteger(depth) && depth >= 1 && depth <= 500, 'Invalid delivery history request.');
  const transport = frozenRemoteTransport(remote);
  const result = await runRemoteGitAsync([
    '-c', `core.hooksPath=${gitDisabledHooksPath()}`, '-c', 'fetch.unpackLimit=1',
    'fetch', '--no-tags', '--no-write-fetch-head', `--depth=${depth}`, '--', transport.remote, commit
  ], { cwd: root, env: transport.env, operation: 'remote-configuration', maxBuffer: 1024 * 1024 });
  if (!processResultSucceeded(result)) throw deliveryGitFailure('The delivery branch could not be fetched.', result);
}

/** The recent commits of a fetched tip, newest first: id and full message, bounded. */
export function isolatedCommitMessages(root, { commit, limit = 100 }) {
  liveDeliveryRepository(root);
  invariant(EXACT_LOCAL_OBJECT_ID.test(commit) && Number.isSafeInteger(limit) && limit >= 1 && limit <= 500, 'Invalid delivery history read.');
  const result = git(['log', `-n${limit}`, '--format=%H%x00%B%x1e', commit, '--'], {
    cwd: root, env: isolatedObjectWriterEnvironment(), allowFailure: true, maxBuffer: 4 * 1024 * 1024, timeoutMs: 30_000
  });
  if (!processResultSucceeded(result)) throw deliveryGitFailure('The delivery branch history could not be read.', result, 'GIT_DELIVERY_HISTORY_UNAVAILABLE');
  return result.stdout.split('\x1e').map((entry) => entry.replace(/^\s+/u, '')).filter(Boolean).map((entry) => {
    const at = entry.indexOf('\0');
    return { commit: entry.slice(0, at), message: entry.slice(at + 1) };
  });
}

/**
 * A commit that writes one file over its parent's tree (or starts a branch with it), using a
 * private index. Returns the commit, or null when the parent already holds these exact bytes.
 */
export async function writeExactGitFileCommit(root, { parentCommit = null, relative, bytes, commitIdentity, message }) {
  liveDeliveryRepository(root);
  invariant(parentCommit === null || EXACT_LOCAL_OBJECT_ID.test(parentCommit), 'Invalid delivery commit parent.');
  invariant(typeof relative === 'string' && Buffer.byteLength(relative) <= 512 && !relative.startsWith('/')
    && relative.split('/').every((part) => /^[A-Za-z0-9._-]+$/u.test(part) && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'), 'Invalid delivery file path.');
  invariant(Buffer.isBuffer(bytes) && bytes.length <= 32 * 1024 * 1024, 'Invalid delivery file bytes.');
  invariant(typeof message === 'string' && Buffer.byteLength(message) <= 4096 && !message.includes('\0'), 'Invalid delivery commit message.');
  const identityValue = validateGitCommitIdentity(commitIdentity);
  const temporary = await mkdtemp(path.join(root, 'delivery-write-'));
  // The isolated writer environment (no system or global configuration), with a private index.
  const env = gitCommitIdentityEnvironment({ ...isolatedObjectWriterEnvironment(), GIT_INDEX_FILE: path.join(temporary, 'index') }, identityValue);
  let retained = false;
  const checked = (args) => {
    const result = git(['-c', `core.hooksPath=${gitDisabledHooksPath()}`, ...args], { cwd: root, env, timeoutMs: 30_000, killSignal: 'SIGKILL', allowFailure: true });
    if (!processResultCompleted(result)) retained = true;
    if (!processResultSucceeded(result)) {
      const error = new SingularityFlowError('The delivery commit could not be written.', { code: 'GIT_OBJECT_WRITE_UNAVAILABLE' });
      error.temporaryGitCleanupUnproven = retained;
      throw error;
    }
    return result.stdout.trim();
  };
  try {
    const source = path.join(temporary, 'literal-object');
    await writeAtomic(source, bytes, { mode: 0o600 });
    const blob = checked(['hash-object', '-t', 'blob', '-w', '--no-filters', '--', source]);
    invariant(EXACT_LOCAL_OBJECT_ID.test(blob), 'Invalid delivery blob.');
    let parentTree = null;
    if (parentCommit !== null) {
      parentTree = checked(['rev-parse', '--verify', `${parentCommit}^{tree}`]);
      checked(['read-tree', parentTree]);
    }
    checked(['update-index', '--add', '--cacheinfo', `100644,${blob},${relative}`]);
    const tree = checked(['write-tree']);
    if (tree === parentTree) return null;
    return checked(['commit-tree', tree, ...(parentCommit ? ['-p', parentCommit] : []), '-m', message]);
  } finally {
    if (!retained) await removeTemporaryTree(temporary);
  }
}

/**
 * Push one delivery commit without force: the remote takes it only as a fast-forward of the tip it
 * was built on (or as a new branch). Returns 'pushed' or 'moved' when the branch moved meanwhile.
 */
export async function pushIsolatedDeliveryCommit(root, { remote, commit, branch }) {
  liveDeliveryRepository(root);
  assertCredentialFreeRemote(remote);
  invariant(validDeliveryBranch(branch) && EXACT_LOCAL_OBJECT_ID.test(commit), 'Invalid delivery push.');
  const destination = `refs/heads/${branch}`;
  const transport = frozenRemoteTransport(remote, { push: true });
  const result = await runRemoteGitAsync([
    '-c', `core.hooksPath=${gitDisabledHooksPath()}`, 'push', '--porcelain', '--', transport.remote, `${commit}:${destination}`
  ], { cwd: root, env: transport.env, operation: 'remote-push', maxBuffer: 1024 * 1024 });
  if (processResultSucceeded(result)) return 'pushed';
  if (/\[rejected\][^\n]*(?:fetch first|non-fast-forward)|\[remote rejected\][^\n]*(?:stale info|cannot lock ref)/iu.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)) return 'moved';
  throw deliveryGitFailure('The delivery commit could not be pushed.', result);
}

function nullList(value) {
  return value.split('\0').filter(Boolean);
}

/**
 * A detached worktree of `commit` in an empty directory, where a candidate's tests run apart from
 * the developer's worktree [E2G-027, D9]. False when Git cannot create it.
 */
export function addCandidateWorktree(root, target, commit = 'HEAD') {
  return git(['worktree', 'add', '--detach', '--quiet', '--', target, commit], { cwd: root, allowFailure: true }).status === 0;
}

/** Remove a candidate worktree's registration; the caller removes the directory. */
export function removeCandidateWorktree(root, target) {
  git(['worktree', 'remove', '--force', '--', target], { cwd: root, allowFailure: true });
  git(['worktree', 'prune'], { cwd: root, allowFailure: true });
}

/** The committed mode and object of each of `paths` HEAD has, keyed by path. */
export function headTreeEntries(root, paths) {
  const entries = new Map();
  for (let start = 0; start < paths.length; start += 200) {
    const listed = git(['ls-tree', '-z', '--full-tree', 'HEAD', '--', ...paths.slice(start, start + 200).map((entry) => `:(literal)${entry}`)], { cwd: root, allowFailure: true });
    if (listed.status !== 0) continue;
    for (const record of nullList(listed.stdout)) {
      const tab = record.indexOf('\t');
      const [mode, , object] = record.slice(0, tab).split(' ');
      entries.set(record.slice(tab + 1), { mode, object });
    }
  }
  return entries;
}

/** Paths the commits from `base` to HEAD changed. */
export function committedChangedPaths(root, base) {
  return nullList(git(['diff', '--name-only', '-z', '--no-renames', base, 'HEAD', '--'], { cwd: root, allowFailure: true }).stdout ?? '');
}

/** Directories `.gitignore` excludes, repository-relative without a trailing slash. */
export function ignoredDirectories(root) {
  return nullList(git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { cwd: root, allowFailure: true }).stdout ?? '')
    .filter((entry) => entry.endsWith('/')).map((entry) => entry.slice(0, -1));
}

/** Files Git does not track and `.gitignore` does not exclude. */
export function untrackedFiles(root) {
  return nullList(git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root }).stdout);
}

/**
 * The zero-context patch from `base` to the working tree, with renames found, of only the files
 * whose added or removed lines match `pattern` (Git's `-G`). Untracked files are not in it.
 */
export function worktreePatchMatching(root, base, pattern, { maximumBytes = 64 * 1024 * 1024 } = {}) {
  return gitAnswer(['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv',
    '--unified=0', '--find-renames', '--src-prefix=a/', '--dst-prefix=b/', `-G${pattern}`, base, '--'],
  { cwd: root, maxBuffer: maximumBytes }, `Changes since ${base}`);
}

/**
 * The zero-context patch of exactly `paths` from `base` to `target` (a commit) or to the working
 * tree when `target` is null, without rename detection, so every line range is in `base`'s
 * coordinates. Null when Git cannot answer, for example when `base` is not in this clone.
 */
export function pathPatchSince(root, base, target, paths, { maximumBytes = 64 * 1024 * 1024 } = {}) {
  if (!paths.length) return '';
  const result = git(['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv',
    '--unified=0', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', base, ...(target ? [target] : []), '--',
    ...paths.map((relative) => `:(literal)${relative}`)], { cwd: root, allowFailure: true, maxBuffer: maximumBytes });
  return result.status === 0 ? String(result.stdout ?? '') : null;
}

/**
 * Commit exactly `paths`, already written, on the current branch: anything else staged stays
 * staged and out of the commit. Returns the new commit.
 */
export function commitExactPaths(root, paths, message) {
  const pathspecs = paths.map((relative) => `:(literal)${relative}`);
  gitAnswer(['add', '--', ...pathspecs], { cwd: root }, 'Stage the recorded paths');
  gitAnswer(['commit', '--quiet', '--only', '-m', message, '--', ...pathspecs], { cwd: root }, 'Commit the recorded paths');
  return gitAnswer(['rev-parse', 'HEAD'], { cwd: root }, 'The new commit').trim();
}

/**
 * Tracked files, as the working tree holds them, and the line numbers holding any of `literals`
 * (Git's `grep -F`, binary files skipped). Null when Git cannot answer.
 */
export function trackedLinesContaining(root, literals, { maximumBytes = 16 * 1024 * 1024 } = {}) {
  if (!literals.length) return [];
  const result = git(['-c', 'core.quotePath=false', 'grep', '-n', '-I', '-F', '--full-name', '--no-color',
    ...literals.flatMap((literal) => ['-e', literal])], { cwd: root, allowFailure: true, maxBuffer: maximumBytes });
  if (result.status === 1) return [];
  if (result.status !== 0) return null;
  return String(result.stdout ?? '').split('\n').map((line) => /^(.+?):(\d+):/u.exec(line))
    .filter(Boolean).map((match) => ({ path: match[1], line: Number(match[2]) }));
}

/** Whether `commit` names a commit present in this clone, without fetching. */
export function commitPresent(root, commit) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(String(commit ?? ''))) return false;
  return git(['cat-file', '-e', `${commit}^{commit}`], { cwd: root, allowFailure: true,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } }).status === 0;
}

/** The latest commits after `base` up to `target` (HEAD by default) that changed `paths`, newest first. */
export function commitsChangingSince(root, base, paths, { target = 'HEAD', limit = 3 } = {}) {
  if (!paths.length) return [];
  const result = git(['log', `--max-count=${limit}`, '--no-merges', '--format=%H%x09%s', `${base}..${target}`, '--',
    ...paths.map((relative) => `:(literal)${relative}`)], { cwd: root, allowFailure: true });
  if (result.status !== 0) return [];
  return String(result.stdout ?? '').split('\n').filter(Boolean).map((line) => {
    const [commit, ...subject] = line.split('\t');
    return { commit, subject: subject.join('\t') };
  }).filter((entry) => /^[0-9a-f]{40,64}$/u.test(entry.commit));
}

/**
 * Every path Git tracks under `prefix` (the whole repository when null), and whether the listing
 * fit in `maximumBytes`. A listing that does not fit is reported as incomplete with no paths, never
 * cut short into a wrong count: a caller deciding whether a repository is small enough to index
 * needs no more than that.
 */
export function trackedPathListing(root, { prefix = null, maximumBytes = 8 * 1024 * 1024, env = process.env } = {}) {
  const result = git(['ls-files', '-z', ...(prefix ? ['--', `:(literal)${prefix}`] : [])],
    { cwd: root, env, allowFailure: true, maxBuffer: maximumBytes });
  if (result.error?.code === 'ENOBUFS') return { paths: [], complete: false };
  return { paths: nullList(gitReadOutput(result, 'Tracked paths') ?? ''), complete: true };
}

/**
 * The files each recent commit changed, newest first: the raw material for change counts and for
 * which files change together. Merges are skipped (they repeat their parents' files). A failure is
 * an empty history, never a partial one presented as complete.
 */
export function recentCommitFileSets(root, { since = '12 months ago', limit = 2000, paths = [], ref = null, env = process.env } = {}) {
  // Author email and subject ride along for ownership and fix-commit counts; the subject is last on its line.
  const result = git(['log', `--since=${since}`, `--max-count=${limit}`, '--no-merges', '--name-only', '--format=%x00%H%x09%P%x09%ae%x09%s',
    ...(ref ? [ref] : []), ...(paths.length ? ['--', ...paths] : [])], { cwd: root, env, allowFailure: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) return [];
  return String(result.stdout ?? '').split('\0').slice(1).map((chunk) => {
    const [header, ...files] = chunk.split('\n').map((line) => line.trim()).filter(Boolean);
    const [commit, parents = '', author = '', ...subject] = String(header ?? '').split('\t');
    return { commit, parents: parents.split(' ').filter(Boolean), author: author || null, subject: subject.join('\t') || null, files };
  }).filter((entry) => /^[0-9a-f]{40,64}$/u.test(entry.commit ?? ''));
}

/** Those of `paths` that Git tracks. */
export function trackedPaths(root, paths) {
  return paths.length ? nullList(gitAnswer(['ls-files', '-z', '--', ...paths.map((relative) => `:(literal)${relative}`)],
    { cwd: root }, 'Tracked paths')) : [];
}

export function changedFiles(root) {
  return scopedReadSync(`git.changedFiles:${path.resolve(root)}`, () => {
    // Porcelain diff can refresh clean entries' stat data. A path inspection must not rewrite the
    // index that a recovery checkpoint is preserving, even when diff.autoRefreshIndex is enabled.
    const unstaged = nullList(git(['--no-optional-locks', '-c', 'diff.autoRefreshIndex=false', 'diff', '--name-only', '-z', 'HEAD'], { cwd: root }).stdout);
    const staged = nullList(git(['--no-optional-locks', '-c', 'diff.autoRefreshIndex=false', 'diff', '--name-only', '-z', '--cached', 'HEAD'], { cwd: root }).stdout);
    const untracked = nullList(git(['--no-optional-locks', 'ls-files', '--others', '--exclude-standard', '-z'], { cwd: root }).stdout);
    return [...new Set([...contentChanged(root, unstaged), ...staged, ...untracked])].sort();
  });
}

// Without the refresh, a file rewritten with the same bytes still reads as modified because its
// cached stat no longer matches. `git status` compares those contents in memory and, with optional
// locks off, writes nothing, so it settles which worktree candidates really changed.
function contentChanged(root, candidates) {
  if (!candidates.length) return candidates;
  const reported = new Set(nullList(git([
    '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=no', '--no-renames'
  ], { cwd: root }).stdout).map((record) => record.slice(3)));
  return candidates.filter((file) => reported.has(file));
}

function exactIndexRoster(root, env, { maximumBytes = 16 * 1024 * 1024 } = {}) {
  const result = git(['ls-files', '--stage', '-z'], {
    cwd: root, env, allowFailure: true, maxBuffer: maximumBytes
  });
  if (result.status !== 0 || result.error || result.timedOut || result.signal != null
      || result.outputOverflow) {
    throw new SingularityFlowError(
      'Git could not capture the exact candidate-index roster.',
      { code: 'ENVIRONMENT_POLICY_UNAVAILABLE' }
    );
  }
  const entries = result.stdout.split('\0').filter(Boolean).map((record) => {
    const tab = record.indexOf('\t');
    const match = tab < 0 ? null : record.slice(0, tab).match(
      /^(100644|100755|120000|160000) ([a-f0-9]{40,64}) ([0-3])$/u
    );
    const relative = tab < 0 ? '' : record.slice(tab + 1);
    if (!match || !relative) {
      throw new SingularityFlowError(
        'Git returned a malformed candidate-index roster.',
        { code: 'ENVIRONMENT_POLICY_UNAVAILABLE' }
      );
    }
    return Object.freeze({
      path: relative, mode: match[1], oid: match[2], stage: match[3]
    });
  });
  return Object.freeze({ raw: result.stdout, entries: Object.freeze(entries) });
}

function environmentDeclarationFromIndexRoster(root, entries, env) {
  const matches = entries.filter(({ path: relative }) => relative === ENVIRONMENT_DECLARATION_PATH);
  if (!matches.length) return null;
  const entry = matches.length === 1 ? matches[0] : null;
  if (!entry || entry.stage !== '0' || !['100644', '100755'].includes(entry.mode)) {
    throw new SingularityFlowError(
      `Invalid ${ENVIRONMENT_DECLARATION_PATH}: the candidate-index entry must be one regular stage-zero blob.`,
      { code: 'ENVIRONMENT_DECLARATION_INVALID' }
    );
  }
  return environmentDeclarationBlob(root, entry.oid, env, 'Exact candidate index');
}

function exactTreeRoster(root, tree, env) {
  const result = git(['ls-tree', '-r', '-z', tree], {
    cwd: root, env, allowFailure: true
  });
  if (result.status !== 0 || result.error || result.timedOut || result.signal != null
      || result.outputOverflow) return null;
  const entries = new Map();
  for (const record of result.stdout.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    const match = tab < 0 ? null : record.slice(0, tab).match(
      /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40,64})$/u
    );
    const relative = tab < 0 ? '' : record.slice(tab + 1);
    if (!match || !relative || (match[1] === '160000') !== (match[2] === 'commit')) return null;
    entries.set(relative, Object.freeze({ path: relative, mode: match[1], oid: match[3] }));
  }
  return entries;
}

/** Capture the exact prospective index tree and bounded selected blob metadata, never worktree bytes. */
export function exactConfigurationProposalGitTree(root, {
  baselineCommit, objectId = null, env: sourceEnv = process.env
} = {}) {
  const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
  const refusal = (message) => { throw new SingularityFlowError(message, { code: 'CONFIGURATION_PROPOSAL_EXACT_TREE_UNAVAILABLE' }); };
  if (!oid.test(baselineCommit ?? '') || objectId !== null && !oid.test(objectId ?? '')) refusal('Exact proposal-tree capture requires full Git object IDs.');
  const env = immutableLocalGitEnvironment(sourceEnv);
  const resolve = (object) => {
    const result = git(object === null ? ['write-tree'] : ['rev-parse', '--verify', `${object}^{tree}`], {
      cwd: root, env, allowFailure: true, maxBuffer: 1024
    });
    const tree = String(result.stdout ?? '').trim();
    if (!processResultCompleted(result) || result.status !== 0 || !oid.test(tree)) refusal('Git could not capture the exact proposal tree.');
    return tree;
  };
  const baselineTree = resolve(baselineCommit); const candidateTree = resolve(objectId);
  let parents = null;
  if (objectId !== null) {
    const result = git(['rev-list', '--parents', '-n', '1', objectId], {
      cwd: root, env, allowFailure: true, maxBuffer: 4096
    });
    const row = String(result.stdout ?? '').trim().split(' ');
    if (!processResultCompleted(result) || result.status !== 0 || row[0] !== objectId || row.some((value) => !oid.test(value))) refusal('Git could not bind the exact proposal commit ancestry.');
    parents = Object.freeze(row.slice(1));
  }
  const baseline = exactTreeRoster(root, baselineTree, env); const candidate = exactTreeRoster(root, candidateTree, env);
  if (!baseline || !candidate || baseline.size > 100_000 || candidate.size > 100_000) refusal('Git could not capture a bounded exact proposal-tree roster.');
  const changedPaths = [...new Set([...baseline.keys(), ...candidate.keys()])].filter((relative) => {
    const old = baseline.get(relative); const next = candidate.get(relative);
    return !old || !next || old.mode !== next.mode || old.oid !== next.oid;
  }).sort();
  const fileMetadata = (paths) => {
    if (!Array.isArray(paths) || paths.length > 1024 || new Set(paths).size !== paths.length
        || paths.some((relative) => typeof relative !== 'string' || !relative || relative.includes('\0')
          || relative.includes('\\') || path.posix.normalize(relative) !== relative || path.posix.isAbsolute(relative)
          || relative.split('/').includes('..') || Buffer.from(relative).toString('utf8') !== relative)) {
      refusal('Selected proposal files require bounded exact repository-relative paths.');
    }
    const selected = paths.map((relative) => {
      const entry = candidate.get(relative);
      if (!entry || !['100644', '100755'].includes(entry.mode)) refusal('A reviewed proposal file is missing or is not an ordinary Git blob.');
      return entry;
    });
    const blobs = readLocalGitBlobs(root, selected.map((entry) => entry.oid), {
      env, maximumBytes: 32 * 1024 * 1024, maximumObjectBytes: 16 * 1024 * 1024,
      code: 'CONFIGURATION_PROPOSAL_EXACT_TREE_UNAVAILABLE', label: 'Exact reviewed proposal files'
    });
    let total = 0;
    return Object.freeze(selected.map((entry) => {
      const bytes = blobs.get(entry.oid); total += bytes.length;
      if (total > 32 * 1024 * 1024) refusal('Selected proposal files exceed their aggregate byte budget.');
      return Object.freeze({ path: entry.path, mode: entry.mode, objectId: entry.oid,
        bytes: bytes.length, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
    }));
  };
  return Object.freeze({ candidateTree, baselineTree, parents, changedPaths: Object.freeze(changedPaths), fileMetadata });
}

/**
 * Closed local Git observations used by `env audit`.
 *
 * Keeping these argv forms in the Git owner prevents the command surface from creating a second
 * Git execution path. Returned blob bytes are invocation-local and must be reduced to redacted
 * findings by the caller; they are never written to logs or durable records.
 */
export function environmentAuditGitSnapshot(root, {
  maximumObjectBytes = 1024 * 1024,
  maximumTotalBytes = 16 * 1024 * 1024
} = {}) {
  const env = immutableLocalGitEnvironment();
  const indexSnapshot = exactIndexRoster(root, env, {
    maximumBytes: Math.max(1024 * 1024, maximumTotalBytes)
  });
  const tracked = [...new Set(indexSnapshot.entries.map(({ path: relative }) => relative))];
  const untracked = nullList(git(
    ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: root, env }
  ).stdout);
  const ignored = nullList(git(
    ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'], { cwd: root, env }
  ).stdout);
  const stagedEntries = [];
  const headEntries = [];
  const headPaths = [];
  const skipped = [];
  // Keep each immutable source bound to the declaration stored in that same source. The command
  // combines these with the stable worktree declaration so neither a staged nor unstaged policy
  // weakening can make an older local-only path disappear from the audit.
  const candidateIndexDeclaration = environmentDeclarationFromIndexRoster(
    root, indexSnapshot.entries, env
  );
  let lastPublicationDeclaration = null;
  const verifiedHead = git(['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'], {
    cwd: root, env, allowFailure: true, maxBuffer: 256
  });
  const headTree = verifiedHead.status === 0
      && /^([a-f0-9]{40}|[a-f0-9]{64})\r?\n?$/u.test(verifiedHead.stdout)
    ? verifiedHead.stdout.trim()
    : null;
  const cleanMissingHead = verifiedHead.status === 1 && !verifiedHead.stdout
    && !verifiedHead.stderr && !verifiedHead.error && !verifiedHead.timedOut
    && verifiedHead.signal == null;
  const candidateBaseline = headTree ? exactTreeRoster(root, headTree, env)
    : cleanMissingHead ? new Map() : null;
  const indexByPath = new Map();
  for (const entry of indexSnapshot.entries) {
    const entries = indexByPath.get(entry.path) ?? [];
    entries.push(entry);
    indexByPath.set(entry.path, entries);
  }
  let admittedBytes = 0;
  for (const [relative, stages] of indexByPath) {
    const selected = stages.length === 1 && stages[0].stage === '0' ? stages[0] : null;
    if (!selected) {
      skipped.push(Object.freeze({
        path: relative, source: 'candidate-index', reason: 'staged-entry-unavailable'
      }));
      continue;
    }
    const baseline = candidateBaseline?.get(relative);
    if (candidateBaseline && baseline?.mode === selected.mode && baseline.oid === selected.oid) {
      continue;
    }
    if (selected.mode === '160000') {
      skipped.push(Object.freeze({
        path: relative, source: 'candidate-index', reason: 'staged-entry-unavailable'
      }));
      continue;
    }
    const forceScan = selected.mode === '120000';
    if (!forceScan && !scannablePath(relative)) continue;
    let content = null;
    try {
      content = readLocalGitBlobs(root, [selected.oid], {
        env,
        maximumBytes: Math.max(0, maximumTotalBytes - admittedBytes),
        maximumObjectBytes,
        code: 'ENVIRONMENT_AUDIT_INDEX_UNREADABLE',
        label: 'Environment audit candidate-index scan'
      }).get(selected.oid) ?? null;
    } catch {
      // Reduced to a bounded unavailable finding below; raw Git diagnostics and bytes stay private.
    }
    if (!content) {
      skipped.push(Object.freeze({
        path: relative, source: 'candidate-index',
        reason: 'staged-audit-byte-ceiling-or-unreadable'
      }));
      continue;
    }
    const bytes = content.length;
    if (bytes > maximumObjectBytes || admittedBytes + bytes > maximumTotalBytes) {
      skipped.push(Object.freeze({
        path: relative, source: 'candidate-index',
        reason: 'staged-audit-byte-ceiling-or-unreadable'
      }));
      continue;
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(content); }
    catch {
      skipped.push(Object.freeze({
        path: relative, source: 'candidate-index', reason: 'staged-audit-invalid-utf8'
      }));
      continue;
    }
    if (content.includes(0)) {
      skipped.push(Object.freeze({
        path: relative, source: 'candidate-index', reason: 'staged-audit-binary'
      }));
      continue;
    }
    admittedBytes += bytes;
    stagedEntries.push(Object.freeze({ path: relative, content: text, forceScan }));
  }

  // Audit the exact last-published tree independently of the mutable index/worktree. A path that
  // is now deleted or staged for deletion is still relevant historical evidence, and replacement
  // refs must not be allowed to substitute cleaner bytes for the committed object.
  if (headTree) {
    lastPublicationDeclaration = exactEnvironmentDeclarationAtRef(root, headTree, env, {
      allowMissingRef: false
    });
    const listing = git(['ls-tree', '-r', '-z', '--long', headTree], {
      cwd: root, env, allowFailure: true, encoding: 'buffer',
      maxBuffer: Math.max(1024 * 1024, maximumTotalBytes)
    });
    if (listing.status !== 0 || listing.error || listing.timedOut || listing.signal != null) {
      skipped.push(Object.freeze({
        path: 'HEAD', source: 'last-publication', reason: 'head-tree-unreadable'
      }));
    } else {
      const descriptors = [];
      let malformed = false;
      let listingText = null;
      try { listingText = new TextDecoder('utf-8', { fatal: true }).decode(listing.stdout); }
      catch {
        skipped.push(Object.freeze({
          path: 'HEAD', source: 'last-publication', reason: 'head-tree-invalid-utf8'
        }));
      }
      for (const record of (listingText ?? '').split('\0').filter(Boolean)) {
        const tab = record.indexOf('\t');
        const match = tab < 0 ? null : record.slice(0, tab).match(
          /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40,64}) +([0-9]+|-)$/u
        );
        const relative = tab < 0 ? '' : record.slice(tab + 1);
        if (!match || !relative || (match[1] === '160000') !== (match[2] === 'commit')) {
          malformed = true;
          break;
        }
        headPaths.push(relative);
        const forceScan = match[1] === '120000';
        if (!forceScan && !scannablePath(relative)) continue;
        if (match[1] === '160000' || match[4] === '-') {
          skipped.push(Object.freeze({
            path: relative, source: 'last-publication', reason: 'head-entry-unreadable'
          }));
          continue;
        }
        const bytes = Number(match[4]);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximumObjectBytes) {
          skipped.push(Object.freeze({
            path: relative, source: 'last-publication', reason: 'head-audit-byte-ceiling'
          }));
          continue;
        }
        descriptors.push({ path: relative, oid: match[3], bytes, forceScan });
      }
      if (listingText == null) {
        headPaths.length = 0;
      } else if (malformed) {
        headPaths.length = 0;
        skipped.push(Object.freeze({
          path: 'HEAD', source: 'last-publication', reason: 'head-tree-malformed'
        }));
      } else {
        let headBytes = 0;
        const admitted = [];
        for (const descriptor of descriptors) {
          if (headBytes + descriptor.bytes > maximumTotalBytes) {
            skipped.push(Object.freeze({
              path: descriptor.path, source: 'last-publication', reason: 'head-audit-byte-ceiling'
            }));
            continue;
          }
          headBytes += descriptor.bytes;
          admitted.push(descriptor);
        }
        let blobs = null;
        if (admitted.length) {
          try {
            blobs = readLocalGitBlobs(root, admitted.map(({ oid }) => oid), {
              env, maximumBytes: maximumTotalBytes, maximumObjectBytes,
              code: 'ENVIRONMENT_AUDIT_HEAD_UNREADABLE',
              label: 'Environment audit last-publication scan'
            });
          } catch {
            for (const descriptor of admitted) skipped.push(Object.freeze({
              path: descriptor.path, source: 'last-publication', reason: 'head-entry-unreadable'
            }));
          }
        }
        if (blobs) {
          for (const descriptor of admitted) {
            const content = blobs.get(descriptor.oid);
            if (!content) {
              skipped.push(Object.freeze({
                path: descriptor.path, source: 'last-publication', reason: 'head-entry-unreadable'
              }));
              continue;
            }
            if (content.includes(0)) {
              skipped.push(Object.freeze({
                path: descriptor.path, source: 'last-publication', reason: 'head-audit-binary'
              }));
              continue;
            }
            let text;
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(content); }
            catch {
              skipped.push(Object.freeze({
                path: descriptor.path, source: 'last-publication', reason: 'head-audit-invalid-utf8'
              }));
              continue;
            }
            headEntries.push(Object.freeze({
              path: descriptor.path, content: text, forceScan: descriptor.forceScan
            }));
          }
        }
      }
    }
  } else if (!(verifiedHead.status === 1 && !verifiedHead.stdout && !verifiedHead.stderr
      && !verifiedHead.error && !verifiedHead.timedOut && verifiedHead.signal == null)) {
    skipped.push(Object.freeze({
      path: 'HEAD', source: 'last-publication', reason: 'head-tree-unavailable'
    }));
  }
  const verifiedIndexSnapshot = exactIndexRoster(root, env, {
    maximumBytes: Math.max(1024 * 1024, maximumTotalBytes)
  });
  if (verifiedIndexSnapshot.raw !== indexSnapshot.raw) {
    skipped.push(Object.freeze({
      path: 'INDEX', source: 'candidate-index', reason: 'candidate-index-changed-during-audit'
    }));
  }
  return Object.freeze({
    tracked: Object.freeze(tracked),
    untracked: Object.freeze(untracked),
    ignored: Object.freeze(ignored),
    stagedEntries: Object.freeze(stagedEntries),
    headPaths: Object.freeze(headPaths),
    headEntries: Object.freeze(headEntries),
    declarations: Object.freeze({
      candidateIndex: candidateIndexDeclaration,
      lastPublication: lastPublicationDeclaration
    }),
    skipped: Object.freeze(skipped),
    admittedBytes
  });
}

export function add(root, paths) {
  if (paths.length) git(['add', '-A', '--', ...paths], { cwd: root });
}

/**
 * Refuse repository paths which the committed environment declaration classifies as local-only.
 *
 * This is intentionally enforced beside the secret scan at the final Git boundary. `.gitignore`
 * is useful guidance, but `git add -f` bypasses it; callers also cannot be trusted to remember a
 * second gate. The declaration contains names and path rules only, so diagnostics can identify the
 * offending path and rule without ever reading or printing an environment value.
 */
function assertNoEnvironmentLocalPaths(declarations, paths, { label }) {
  const policies = (Array.isArray(declarations) ? declarations : [declarations]).filter(Boolean);
  if (!policies.length) return;
  const findings = [...new Set((paths ?? []).filter(Boolean).map((item) => item.replaceAll('\\', '/')))]
    // The names-only declaration is the policy source, not environment-local content. A broad
    // safety pattern must not make it impossible to tighten or repair the declaration itself.
    .filter((item) => item !== ENVIRONMENT_DECLARATION_PATH)
    .flatMap((item) => policies.flatMap((declaration) => {
      const match = matchEnvironmentLocalPath(declaration, item);
      return match ? [{ path: item, match }] : [];
    }))
    .filter((entry, index, entries) => entries.findIndex((candidate) =>
      candidate.path === entry.path
        && candidate.match.environmentId === entry.match.environmentId
        && candidate.match.pattern === entry.match.pattern) === index);
  if (!findings.length) return;
  const rendered = findings.map(({ path: item, match }) => {
    const rule = match.pattern ?? match.rule ?? match.source ?? 'environment-local';
    const owner = match.environmentId
      ? `environments.${match.environmentId}.localFiles` : 'neverCommit';
    return `- ${item} matches ${owner} rule '${rule}'`;
  }).join('\n');
  throw new SingularityFlowError(
    `${label} was refused because environment-local content must never enter Git:\n\n${rendered}\n\n`
      + 'Remove the path from the index and keep its value in a machine-local environment binding.',
    {
      code: 'ENVIRONMENT_LOCAL_CONTENT_REFUSED',
      details: { paths: findings.map((entry) => entry.path) }
    }
  );
}

function hasConfigurationOverlay(root) {
  return path.resolve(configurationReadRootForPath(root, ENVIRONMENT_DECLARATION_PATH))
    !== path.resolve(root);
}

const MAXIMUM_ENVIRONMENT_DECLARATION_BYTES = 256 * 1024;

function environmentDeclarationBlob(root, objectId, env, sourceLabel) {
  let blobs;
  try {
    blobs = readLocalGitBlobs(root, [objectId], {
      env,
      maximumBytes: MAXIMUM_ENVIRONMENT_DECLARATION_BYTES,
      maximumObjectBytes: MAXIMUM_ENVIRONMENT_DECLARATION_BYTES,
      code: 'ENVIRONMENT_POLICY_UNAVAILABLE',
      label: sourceLabel
    });
  } catch {
    throw new SingularityFlowError(
      `${sourceLabel} could not read its exact environment declaration.`,
      { code: 'ENVIRONMENT_POLICY_UNAVAILABLE' }
    );
  }
  const bytes = blobs.get(objectId);
  if (!bytes) {
    throw new SingularityFlowError(
      `${sourceLabel} could not read its exact environment declaration.`,
      { code: 'ENVIRONMENT_POLICY_UNAVAILABLE' }
    );
  }
  return parseEnvironmentDeclaration(bytes);
}

/** Resolve environment policy from an exact commit/tree without replace refs or lazy fetches. */
export function exactEnvironmentDeclarationAtRef(
  root, ref = 'HEAD', env = immutableLocalGitEnvironment(), {
    allowMissingRef = ref === 'HEAD', useConfigurationOverlay = true
  } = {}
) {
  if (useConfigurationOverlay && hasConfigurationOverlay(root)) {
    // The request-local overlay is an already verified immutable configuration snapshot. It is the
    // authority when application branches intentionally do not carry configuration files.
    return loadEnvironmentDeclarationSync(root, { optional: true });
  }
  const resolved = git(['rev-parse', '--verify', '--quiet', `${ref}^{tree}`], {
    cwd: root, env, allowFailure: true, maxBuffer: 256
  });
  if (resolved.status !== 0) {
    const cleanMissing = allowMissingRef && resolved.status === 1 && !resolved.stdout
      && !resolved.stderr && !resolved.error && !resolved.timedOut && resolved.signal == null;
    if (cleanMissing) return null;
    throw new SingularityFlowError(
      'Git could not resolve the exact environment-policy tree.',
      { code: 'ENVIRONMENT_POLICY_UNAVAILABLE' }
    );
  }
  const tree = resolved.stdout.trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(tree)) {
    throw new SingularityFlowError(
      'Git returned an invalid exact environment-policy tree identity.',
      { code: 'ENVIRONMENT_POLICY_UNAVAILABLE' }
    );
  }
  const listed = git([
    'ls-tree', '-z', tree, '--', `:(literal)${ENVIRONMENT_DECLARATION_PATH}`
  ], { cwd: root, env, allowFailure: true, maxBuffer: 4096 });
  if (listed.status !== 0 || listed.error || listed.timedOut || listed.signal != null
      || listed.outputOverflow) {
    throw new SingularityFlowError(
      'Git could not inspect the exact environment-policy tree.',
      { code: 'ENVIRONMENT_POLICY_UNAVAILABLE' }
    );
  }
  const records = listed.stdout.split('\0').filter(Boolean);
  if (!records.length) return null;
  const match = records.length === 1 ? records[0].match(
    /^(100644|100755) blob ([a-f0-9]{40,64})\tsingularity\/environments\.yml$/u
  ) : null;
  if (!match) {
    throw new SingularityFlowError(
      `Invalid ${ENVIRONMENT_DECLARATION_PATH}: the exact Git entry must be one regular blob.`,
      { code: 'ENVIRONMENT_DECLARATION_INVALID' }
    );
  }
  return environmentDeclarationBlob(root, match[2], env, 'Exact Git tree');
}

/** Resolve the policy from the temporary exact index used by governed publication admission. */
export function exactIndexedEnvironmentDeclaration(root, env = immutableLocalGitEnvironment()) {
  if (hasConfigurationOverlay(root)) return loadEnvironmentDeclarationSync(root, { optional: true });
  const listed = git([
    'ls-files', '--stage', '-z', '--', ENVIRONMENT_DECLARATION_PATH
  ], { cwd: root, env, allowFailure: true, maxBuffer: 4096 });
  if (listed.status !== 0 || listed.error || listed.timedOut || listed.signal != null
      || listed.outputOverflow) {
    throw new SingularityFlowError(
      'Git could not inspect the exact candidate-index environment policy.',
      { code: 'ENVIRONMENT_POLICY_UNAVAILABLE' }
    );
  }
  const records = listed.stdout.split('\0').filter(Boolean);
  if (!records.length) return null;
  const match = records.length === 1 ? records[0].match(
    /^(100644|100755) ([a-f0-9]{40,64}) 0\tsingularity\/environments\.yml$/u
  ) : null;
  if (!match || /^0+$/.test(match[2])) {
    throw new SingularityFlowError(
      `Invalid ${ENVIRONMENT_DECLARATION_PATH}: the candidate-index entry must be one regular stage-zero blob.`,
      { code: 'ENVIRONMENT_DECLARATION_INVALID' }
    );
  }
  return environmentDeclarationBlob(root, match[2], env, 'Exact candidate index');
}

function indexPaths(root, env = immutableLocalGitEnvironment()) {
  return nullList(git(['ls-files', '-z'], { cwd: root, env }).stdout);
}

function treePaths(root, tree, env = immutableLocalGitEnvironment()) {
  return nullList(git(['ls-tree', '-r', '--name-only', '-z', tree], { cwd: root, env }).stdout);
}

/**
 * Admit bytes from an already-materialized prospective Git tree.
 *
 * Candidate issuers deliberately build their trees in private indexes, outside the ordinary
 * commit/publication path.  Passing the resulting object ID through this owner keeps those callers
 * from growing weaker, subtly different copies of the environment-local and secret policy.  Both
 * declarations are read from immutable Git objects: a mutable worktree edit after `write-tree`
 * cannot loosen the policy applied to the retained Candidate.
 *
 * A successful admission is remembered for the process. Every input is immutable (two object IDs,
 * declarations read from those trees or from the request's verified configuration overlay, which
 * is part of the key), so admitting the same pair again cannot reach a different verdict. A Story
 * start admitted its one prospective tree four times, each with eleven Git processes and a secret
 * scan of every changed file. A refusal is never remembered: it throws, and the next call retries.
 */
const ADMITTED_PROSPECTIVE_TREES = new Map();

export function admitExactProspectiveTree(root, {
  baselineCommit, candidateTree, label = 'Governed Candidate', allowGitlinks = false
} = {}) {
  const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
  if (!oid.test(String(baselineCommit ?? '')) || !oid.test(String(candidateTree ?? ''))) {
    throw new SingularityFlowError('Exact prospective-tree admission requires full Git object IDs.', {
      code: 'PROSPECTIVE_TREE_INVALID'
    });
  }
  const admissionKey = [path.resolve(root), path.resolve(configurationReadRootForPath(root, ENVIRONMENT_DECLARATION_PATH)),
    baselineCommit, candidateTree, allowGitlinks ? 'gitlinks' : 'no-gitlinks'].join('\0');
  const admitted = ADMITTED_PROSPECTIVE_TREES.get(admissionKey);
  if (admitted) return admitted;
  const remember = (result) => {
    if (ADMITTED_PROSPECTIVE_TREES.size >= 256) ADMITTED_PROSPECTIVE_TREES.clear();
    ADMITTED_PROSPECTIVE_TREES.set(admissionKey, result);
    return result;
  };
  const env = immutableLocalGitEnvironment();
  const resolved = git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    cwd: root, env, allowFailure: true,
    input: `${baselineCommit}^{tree}\n${candidateTree}^{tree}\n`, maxBuffer: 1024
  });
  const trees = resolved.stdout.trim().split(/\r?\n/u);
  if (!processResultSucceeded(resolved) || trees.length !== 2
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64}) tree$/u.test(trees[0])
      || trees[1] !== `${candidateTree} tree`) {
    throw new SingularityFlowError('Exact prospective-tree admission could not resolve its bound Git trees.', {
      code: 'PROSPECTIVE_TREE_INVALID'
    });
  }

  assertNoEnvironmentLocalPaths([
    exactEnvironmentDeclarationAtRef(root, baselineCommit, env),
    exactEnvironmentDeclarationAtRef(root, candidateTree, env)
  ], treePaths(root, candidateTree, env), { label });

  const listed = nullList(git([
    'diff', '--name-only', '-z', '--diff-filter=ACMRT', baselineCommit, candidateTree, '--'
  ], { cwd: root, env }).stdout);
  if (!listed.length) return remember(Object.freeze({ tree: candidateTree, paths: Object.freeze([]), scan: null }));

  const expectedPaths = new Set(listed);
  const byPath = new Map();
  for (let offset = 0; offset < listed.length; offset += 512) {
    const raw = git([
      'ls-tree', '-z', candidateTree, '--',
      ...listed.slice(offset, offset + 512).map((item) => `:(literal)${item}`)
    ], { cwd: root, env }).stdout;
    for (const record of raw.split('\0').filter(Boolean)) {
      const tab = record.indexOf('\t');
      const match = tab < 0 ? null
        : record.slice(0, tab).match(/^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40,64})$/u);
      const item = tab < 0 ? '' : record.slice(tab + 1);
      if (!match || !expectedPaths.has(item) || byPath.has(item)) {
        throw new SingularityFlowError(
          `Cannot scan '${item || '(unknown)'}' for secrets: its prospective Git entry is ambiguous.`,
          { code: 'SECRET_SCAN_UNREADABLE' }
        );
      }
      byPath.set(item, { mode: match[1], type: match[2], oid: match[3] });
    }
  }
  const descriptors = listed.map((item) => {
    const selected = byPath.get(item);
    if (!selected) {
      throw new SingularityFlowError(
        `Cannot scan '${item}' for secrets: its prospective Git entry mode is unavailable.`,
        { code: 'SECRET_SCAN_UNREADABLE' }
      );
    }
    if (selected.mode === '160000') {
      if (allowGitlinks && selected.type === 'commit') {
        return { path: item, mode: selected.mode, oid: selected.oid, forceScan: false };
      }
      throw new SingularityFlowError(
        `Cannot scan '${item}' for secrets: governed gitlinks are not admitted as binary evidence.`,
        { code: 'SECRET_SCAN_UNREADABLE' }
      );
    }
    if (selected.type !== 'blob') {
      throw new SingularityFlowError(
        `Cannot scan '${item}' for secrets: its prospective Git entry type is unsupported.`,
        { code: 'SECRET_SCAN_UNREADABLE' }
      );
    }
    return { path: item, mode: selected.mode, oid: selected.oid, forceScan: selected.mode === '120000' };
  });
  const blobIds = descriptors.filter(({ mode, path: item }) =>
    mode !== '160000' && (mode === '120000' || scannablePath(item)))
    .map(({ oid: object }) => object);
  const blobs = readLocalGitBlobs(root, blobIds, {
    env,
    maximumObjectBytes: 64 * 1024 * 1024,
    code: 'SECRET_SCAN_UNREADABLE',
    label: 'Prospective tree secret scan'
  });
  const entries = descriptors.flatMap(({ path: item, mode, oid: object, forceScan }) => {
    // A gitlink contains a commit object ID rather than file bytes. The caller opted into retaining
    // that exact pointer; environment path policy still applied above, while there is no blob text
    // to pass to the secret scanner.
    if (mode === '160000') return [];
    if (['100644', '100755'].includes(mode) && !scannablePath(item)) return [{ path: item }];
    const bytes = blobs.get(object);
    if (!bytes) {
      throw new SingularityFlowError(
        `Cannot scan '${item}' for secrets from the prospective tree.`,
        { code: 'SECRET_SCAN_UNREADABLE' }
      );
    }
    // A DOCX or XLSX is a ZIP of XML: its text is scanned, and an unreadable one is still refused.
    if (['100644', '100755'].includes(mode) && scannedAsExtractedText(item)) {
      const extracted = extractSourceTextForPath(bytes, item);
      if (extracted.status === 'extracted') return [{ path: item, content: extracted.text, forceScan }];
      if (extracted.empty) return [{ path: item }];
      throw new SingularityFlowError(
        `Cannot scan '${item}' for secrets: its text could not be extracted (${extracted.reason}).`,
        { code: 'SECRET_SCAN_UNREADABLE' }
      );
    }
    const content = bytes.toString('utf8');
    if (bytes.includes(0) || !Buffer.from(content, 'utf8').equals(bytes)) {
      throw new SingularityFlowError(
        `Cannot scan '${item}' for secrets: its prospective blob is binary or not valid UTF-8.`,
        { code: 'SECRET_SCAN_UNREADABLE' }
      );
    }
    return [{ path: item, content, forceScan }];
  });
  const scan = scanEntries(entries);
  const refusal = secretRefusal(scan);
  if (refusal) {
    throw new SingularityFlowError(`${label} was refused.\n\n${refusal}`, {
      code: 'SECRET_DETECTED'
    });
  }
  return remember(Object.freeze({ tree: candidateTree, paths: Object.freeze([...listed]), scan }));
}

/**
 * Enforce both the last committed declaration and the exact prospective declaration against every
 * path in the tree being committed. Applying their union closes two transition holes: deleting or
 * weakening policy cannot admit an old local-only file, and adding/tightening policy cannot leave
 * a newly forbidden file in the same tree merely because that file was unchanged.
 */
function assertCommitEnvironmentPolicy(root, paths, { label }) {
  const baselineEnv = immutableLocalGitEnvironment();
  const baseline = exactEnvironmentDeclarationAtRef(root, 'HEAD', baselineEnv);
  if (!paths?.length) {
    const env = immutableLocalGitEnvironment();
    const prospective = exactIndexedEnvironmentDeclaration(root, env);
    assertNoEnvironmentLocalPaths([baseline, prospective], indexPaths(root, env), { label });
    return;
  }

  const temporaryRoot = path.join(gitDir(root), 'singularity-flow', 'temporary-indexes');
  mkdirSync(temporaryRoot, { recursive: true });
  const scratch = mkdtempSync(path.join(temporaryRoot, 'environment-policy-'));
  const env = immutableLocalGitEnvironment(process.env, {
    indexFile: path.join(scratch, 'index')
  });
  try {
    const headResult = git(['rev-parse', '--verify', '--quiet', 'HEAD'], {
      cwd: root, env, allowFailure: true
    });
    if (headResult.status === 0) git(['read-tree', 'HEAD'], { cwd: root, env });
    else if (headResult.status === 1 && !headResult.stdout && !headResult.stderr) {
      git(['read-tree', '--empty'], { cwd: root, env });
    } else {
      throw new SingularityFlowError('Git could not establish the baseline environment policy tree.', {
        code: 'ENVIRONMENT_POLICY_UNAVAILABLE'
      });
    }
    git(['add', '-A', '--', ...paths], { cwd: root, env });
    const prospective = exactIndexedEnvironmentDeclaration(root, env);
    assertNoEnvironmentLocalPaths([baseline, prospective], indexPaths(root, env), { label });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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
  const env = immutableLocalGitEnvironment();
  assertCommitEnvironmentPolicy(root, paths, { label });
  const listed = paths?.length
    ? [...new Set(paths.filter(Boolean))]
    // Nothing staged skips the scan below, so a staged list Git could not read must refuse.
    : gitAnswer(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT'], { cwd: root, env },
      `${label} staged paths`).split('\0').filter(Boolean);
  if (!listed.length) return null;

  // A scoped commit takes the working tree; an index commit takes the staged blob. Read whichever
  // one this commit will actually use.
  if (!paths?.length) return refuseSecrets(stagedEntriesForPaths(root, listed, { env, label: `${label} staged blobs` }), label);
  const entries = [];
  for (const item of listed) {
    const absolute = path.resolve(root, item);
    let content;
    try {
      const stat = statSync(absolute);
      // A path may name a directory the caller staged wholesale; expand it to its tracked files.
      if (stat.isDirectory()) {
        const tracked = gitAnswer(['ls-files', '-z', '--', item], { cwd: root, env },
          `${label} tracked files under '${item}'`).split('\0').filter(Boolean);
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
  }
  return refuseSecrets(entries, label);
}

function refuseSecrets(entries, label) {
  const scan = scanEntries(entries);
  const refusal = secretRefusal(scan);
  if (refusal) {
    throw new SingularityFlowError(`${label} was refused.\n\n${refusal}`, { code: 'SECRET_DETECTED' });
  }
  return scan;
}

/**
 * The staged content of `paths`, read as `git show :<path>` would: one `ls-files --stage` and one
 * `cat-file --batch` instead of a process per file. A path that is not staged as a regular file or
 * symbolic link is absent. A path the batch did not answer for is read alone, as before.
 */
export function stagedEntriesForPaths(root, paths, { env = process.env, label = 'Staged blobs' } = {}) {
  const entries = [];
  if (!paths?.length) return entries;
  const showOne = (item) => {
    const show = git(['show', `:${item}`], { cwd: root, env, allowFailure: true });
    if (show.status === 0) entries.push({ path: item, content: show.stdout });
  };
  if (paths.length === 1) {
    showOne(paths[0]);
    return entries;
  }
  const stagedOids = new Map();
  const staged = git(['ls-files', '--stage', '-z', '--', ...paths], { cwd: root, env, allowFailure: true });
  if (staged.status === 0) {
    for (const record of String(staged.stdout ?? '').split('\0').filter(Boolean)) {
      const tab = record.indexOf('\t');
      const match = tab < 0 ? null : /^(?:100644|100755|120000) ([a-f0-9]{40,64}) 0$/u.exec(record.slice(0, tab));
      if (match) stagedOids.set(record.slice(tab + 1), match[1]);
    }
  }
  let blobs = null;
  if (stagedOids.size) {
    try { blobs = readLocalGitBlobs(root, [...stagedOids.values()], { env, label }); } catch { blobs = null; }
  }
  for (const item of paths) {
    const oid = stagedOids.get(item);
    const buffer = oid && blobs ? blobs.get(oid) : null;
    if (buffer) entries.push({ path: item, content: buffer.toString('utf8') });
    else showOne(item);
  }
  return entries;
}

/**
 * Paths `commit` changed (under `prefix`, when given) whose index entry still holds the version
 * in its parent: the index is exactly one commit behind for them. Content someone staged on purpose
 * matches the file on disk instead, and is never reported.
 */
function laggingIndexEntries(root, commit, prefix = null) {
  const env = { ...process.env, GIT_LITERAL_PATHSPECS: '1' };
  const parent = git(['rev-parse', '--verify', '--quiet', `${commit}^1`], { cwd: root, env, allowFailure: true }).stdout.trim();
  if (!parent) return [];
  const changed = nullList(git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', parent, commit,
    ...(prefix ? ['--', prefix] : [])], { cwd: root, env }).stdout);
  if (!changed.length) return [];
  // `ls-files --stage` prints "<mode> <oid> <stage>\t<path>"; `ls-tree` prints "<mode> <type> <oid>\t<path>".
  const entries = (listing, oidField) => new Map(nullList(listing).map((line) => {
    const tab = line.indexOf('\t');
    const fields = line.slice(0, tab).split(' ');
    return [line.slice(tab + 1), `${fields[0]} ${fields[oidField]}`];
  }));
  const indexed = entries(git(['ls-files', '--stage', '-z', '--', ...changed], { cwd: root, env }).stdout, 1);
  const before = entries(git(['ls-tree', '-r', '-z', parent, '--', ...changed], { cwd: root, env }).stdout, 2);
  return changed.filter((file) => (indexed.get(file) ?? null) === (before.get(file) ?? null));
}

/**
 * Bring the real index up to a governed commit the branch already points at, for the paths that
 * commit changed whose index entry still describes its parent.
 *
 * A publication refreshes those entries after its branch advances. When another program held
 * `index.lock` past the wait, that refresh failed: the commit was published, and every published
 * file looked changed ("Working tree is not clean"). Recovery calls this before it publishes the
 * retained commit. An entry someone staged since is left exactly as it is. Returns the paths it
 * refreshed.
 */
export function refreshStalePublishedIndex(root, commit, { lockWaitMs = null } = {}) {
  if (!commit || head(root) !== commit) return [];
  const stale = laggingIndexEntries(root, commit);
  if (stale.length) git(['reset', '-q', commit, '--', ...stale], { cwd: root, env: {
    ...process.env, GIT_LITERAL_PATHSPECS: '1',
    ...(lockWaitMs == null ? {} : { SINGULARITY_FLOW_GIT_INDEX_LOCK_WAIT_MS: String(lockWaitMs) })
  } });
  return stale;
}

/**
 * The index refresh after a commit is durable failed (another program held `index.lock` past the
 * wait, typically). The commit stands; failing now would report a made commit as an error and leave
 * its files looking changed. Record it, so the next command in this checkout completes the refresh.
 */
function deferIndexRefresh(root, commit, result) {
  // The record deferred-index-refresh.mjs completes: the commit ID, in this checkout's Git
  // directory. Written here so this module (and the edit guard that reaches it) loads nothing more.
  const marker = path.join(gitDir(root), 'singularity-flow', 'index-refresh-pending');
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, `${commit}\n`);
  const reason = String(result?.stderr || result?.stdout || '').trim().split(/\r?\n/u)[0];
  process.stderr.write(`Committed ${commit.slice(0, 12)}. Git's index could not be refreshed yet${reason ? ` (${reason})` : ''}; `
    + 'the next Singularity Flow command in this checkout completes it. Until then its files may look changed.\n');
}

/**
 * Story files (under `prefix`, its work-item directory) whose index entry is one commit behind
 * HEAD: what a publication whose index refresh did not complete leaves, and what an older sync left
 * after publishing. To `git status` they look staged, reverted and untracked at once, and the next
 * start refuses a dirty tree. Nothing is reported while a merge, rebase, cherry-pick or revert owns
 * the index.
 */
export function storyIndexDrift(root, prefix) {
  const markers = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];
  // Git remains the owner of private/worktree/override path semantics. Batch these independent
  // path questions, not the mutable marker contents or the subsequent index/HEAD evidence.
  const observed = git(['rev-parse', '--path-format=absolute', ...markers.flatMap(marker => ['--git-path', marker])],
    { cwd: root, allowFailure: true });
  const paths = observed.stdout.trimEnd().split(/\r?\n/u);
  if (observed.status === 0 && paths.length === markers.length && paths.every(value => path.isAbsolute(value))) {
    if (paths.some(value => existsSync(value))) return [];
  } else {
    // Older Git or unusual newline-containing paths keep the exact individual reference route.
    for (const marker of markers) {
      const relative = git(['rev-parse', '--git-path', marker], { cwd: root, allowFailure: true }).stdout.trim();
      if (relative && existsSync(path.resolve(root, relative))) return [];
    }
  }
  return laggingIndexEntries(root, head(root), prefix);
}

/** Point exactly these index entries back at HEAD. The files on disk and every other entry stay as they are. */
export function refreshIndexEntries(root, paths) {
  if (!paths.length) return;
  git(['reset', '-q', 'HEAD', '--', ...paths], { cwd: root, env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } });
}

/** This checkout's `index.lock`, with its age, or null when there is none. */
export function indexLockState(root) {
  const relative = git(['rev-parse', '--git-path', 'index.lock'], { cwd: root, allowFailure: true }).stdout.trim();
  if (!relative) return null;
  const absolute = path.resolve(root, relative);
  const info = statSync(absolute, { throwIfNoEntry: false });
  return info ? { path: absolute, ageMs: Math.max(0, Date.now() - info.mtimeMs), modifiedAt: info.mtime.toISOString() } : null;
}

export function commit(root, message, paths = null) {
  assertNoSecrets(root, paths);
  const scope = paths?.length ? ['--only', '--', ...paths] : [];
  git(['commit', '-m', message, ...scope], { cwd: root, stdio: 'inherit' });
  return head(root);
}

/** Human-reviewed authoring commit, not publication. Keep normal hooks/signing and the user's
 * unrelated staged changes. A veto or a changed hook output never advances the workflow. */
export async function commitReviewedPaths(root, message, paths, {
  expectedHead, stabilityGuard, onCleanupWarning = warning => console.warn(warning)
} = {}) {
  invariant(expectedHead && stabilityGuard && paths?.length, 'An exact reviewed commit scope is required.');
  const reference = `refs/heads/${branch(root)}`;
  const assertStable = async () => {
    if (head(root) !== expectedHead || `refs/heads/${branch(root)}` !== reference
        || !await stabilityGuard()) throw new SingularityFlowError(
      'The reviewed repository changed. Inspect recovery and confirm a new plan before committing.',
      { code: 'RECOVERY_PLAN_STALE' }
    );
  };
  await assertStable();
  const temporaryRoot = path.join(gitDir(root), 'singularity-flow', 'temporary-indexes');
  await mkdir(temporaryRoot, { recursive: true });
  const scratch = await mkdtemp(path.join(temporaryRoot, 'reviewed-commit-'));
  const env = immutableLocalGitEnvironment(process.env, { indexFile: path.join(scratch, 'index') });
  const scope = paths.map(relative => `:(literal)${relative}`);
  let committed = null;
  try {
    git(['read-tree', expectedHead], { cwd: root, env });
    git(['add', '-A', '--', ...scope], { cwd: root, env });
    const tree = git(['write-tree'], { cwd: root, env }).stdout.trim();
    admitExactProspectiveTree(root, { baselineCommit: expectedHead, candidateTree: tree, label: 'Reviewed authoring commit' });
    await assertStable();
    // Unlike lifecycle commit-tree, this deliberately respects repository hooks and signing.
    const result = git(['commit', '-m', message], { cwd: root, env, allowFailure: true });
    const observed = head(root);
    if (observed !== expectedHead) committed = observed;
    if (result.status !== 0 || !committed) throw new SingularityFlowError(
      `Reviewed commit did not complete: ${(result.stderr || result.stdout).trim() || 'Git refused the commit'}. `
      + 'Preserve the changes and correct the reported Git/hook prerequisite; no lifecycle action was run.',
      { code: 'RECOVERY_COMMIT_FAILED', details: { commit: committed, recoveryCommand: 'singularity-flow recover --json' } }
    );
    const parent = git(['rev-parse', `${committed}^`], { cwd: root, env }).stdout.trim();
    const actualTree = git(['rev-parse', `${committed}^{tree}`], { cwd: root, env }).stdout.trim();
    if (`refs/heads/${branch(root)}` !== reference || parent !== expectedHead || actualTree !== tree) {
      throw new SingularityFlowError(
        'Git or a commit hook changed the reviewed commit. The commit is retained; inspect its exact diff before continuing. No lifecycle action was run.',
        { code: 'RECOVERY_COMMIT_CHANGED', details: { commit: committed, recoveryCommand: 'singularity-flow recover --json' } }
      );
    }
    // Refresh only the reviewed files; do not borrow, commit, reset, or discard any other index entry.
    // The commit stands either way: a refresh another program blocks completes on the next command.
    const refreshed = git(['reset', '-q', committed, '--', ...scope], {
      cwd: root, env: immutableLocalGitEnvironment(), allowFailure: true
    });
    if (refreshed.status !== 0) deferIndexRefresh(root, committed, refreshed);
    return committed;
  } finally {
    try { await removeTemporaryTree(scratch); }
    catch (error) {
      // Windows can retain a temporary-index handle after Git exits. Never turn cleanup of
      // disposable scratch into an ambiguous commit failure or mask a hook's original veto.
      onCleanupWarning(`Temporary reviewed-commit index cleanup is pending at ${scratch}: ${error.message}. `
        + `${committed ? `Commit ${committed} is retained. ` : ''}No lifecycle action was run; do not repeat a completed commit.`);
    }
  }
}

function prospectiveGovernedTreeAndSecretScan(root, scope, expectedHead) {
  const temporaryRoot = path.join(gitDir(root), 'singularity-flow', 'temporary-indexes');
  mkdirSync(temporaryRoot, { recursive: true });
  const scratch = mkdtempSync(path.join(temporaryRoot, 'admission-'));
  const env = immutableLocalGitEnvironment(process.env, {
    indexFile: path.join(scratch, 'index')
  });
  try {
    git(['read-tree', expectedHead], { cwd: root, env });
    // This is the exact operation used later by `commitIsolated`: nested untracked, non-ignored
    // files are part of the prospective index and therefore part of secret admission too.
    git(['add', '-A', '--', ...scope], { cwd: root, env });
    const tree = git(['write-tree'], { cwd: root, env }).stdout.trim();
    admitExactProspectiveTree(root, {
      baselineCommit: expectedHead, candidateTree: tree, label: 'Governed publication'
    });
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
  const scope = governedPublicationScope(root, paths, expectedHead);
  const prospectiveTree = prospectiveGovernedTreeAndSecretScan(root, scope, expectedHead);
  const admitted = [...scope];
  Object.defineProperty(admitted, 'prospectiveTree', {
    value: prospectiveTree, enumerable: false, writable: false, configurable: false
  });
  return Object.freeze(admitted);
}

/** The governed path scope and its pre-staged-overlap refusal, without building its tree. */
function governedPublicationScope(root, paths, expectedHead) {
  const env = immutableLocalGitEnvironment();
  const scope = [...new Set((paths ?? []).filter(Boolean))].filter((candidate) =>
    existsSync(path.join(root, candidate))
      || Boolean(git(['ls-files', '-z', '--', candidate], { cwd: root, env }).stdout));
  if (!scope.length) throw new SingularityFlowError('Governed publication requires at least one allowed path.');
  const stagedOverlap = git(
    ['diff', '--cached', '--name-only', '-z', expectedHead, '--', ...scope], { cwd: root, env }
  ).stdout.split('\0').filter(Boolean);
  if (stagedOverlap.length) {
    throw new SingularityFlowError(
      `Governed publication cannot replace already staged governed path(s): ${stagedOverlap.join(', ')}. `
      + 'Commit or unstage those paths, then retry.'
    );
  }
  return Object.freeze(scope);
}

/**
 * The publication unit of work is the sole production issuer of this closed local-ref request.
 * Keep it private to commitIsolated: accepting an arbitrary ref/argv object from a command would
 * turn a Git transport detail into a second authorization surface. The owner has already sealed
 * its transaction journal and verified the exact prospective tree before this point.
 */
function publicationLocalRefCas(root, request) {
  const keys = ['kind', 'ref', 'expectedOldOid', 'newCommitOid', 'treeOid', 'transactionId'];
  const oid = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
  if (!Object.isFrozen(request) || Object.keys(request).sort().join('\0') !== keys.sort().join('\0')
      || request.kind !== 'publication-local-ref-cas'
      || typeof request.ref !== 'string' || !request.ref.startsWith('refs/heads/')
      || !request.transactionId || typeof request.transactionId !== 'string'
      || !oid.test(request.expectedOldOid) || !oid.test(request.newCommitOid)
      || !oid.test(request.treeOid)
      || request.expectedOldOid.length !== request.newCommitOid.length
      || request.treeOid.length !== request.newCommitOid.length) {
    throw new SingularityFlowError('The governed publication ref transaction is not an exact, owner-bound request.', {
      code: 'PUBLICATION_REF_REQUEST_INVALID'
    });
  }
  validBranch(root, request.ref.slice('refs/heads/'.length));
  const env = immutableLocalGitEnvironment();
  // `update-ref` normally dereferences symbolic refs. A raced symbolic branch must never move a
  // different target, even if its resolved OID happens to match the expected old commit.
  const symbolic = git(['symbolic-ref', '-q', request.ref], {
    cwd: root, env, allowFailure: true
  });
  if (symbolic.status === 0) {
    throw new SingularityFlowError('The governed publication branch became a symbolic ref before its compare-and-swap.', {
      code: 'PUBLICATION_SYMBOLIC_REF_UNSUPPORTED'
    });
  }
  if (symbolic.status !== 1) {
    throw new SingularityFlowError('The governed publication branch type could not be verified before its compare-and-swap.', {
      code: 'PUBLICATION_REF_REQUEST_UNVERIFIED'
    });
  }
  const result = git([
    'update-ref', '--no-deref', request.ref, request.newCommitOid, request.expectedOldOid
  ], { cwd: root, env, allowFailure: true });
  // A failed or interrupted Git process can have written the ref before returning. The durable
  // journal, not the process exit code, owns reconciliation of that exact commit afterward.
  return result.status === 0 ? 'applied' : 'outcome-unknown';
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
  const localEnv = immutableLocalGitEnvironment();
  const checkedOutRef = () => {
    const observed = git(['symbolic-ref', '-q', 'HEAD'], {
      cwd: root, env: localEnv, allowFailure: true
    });
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
  // The tree is built once, below, and that exact tree is admitted (secret, environment and
  // scope checks) before it can be committed. Admission used to build it a first time here only
  // to compare the two builds; an unchanged tree costs nothing to admit again.
  const scope = governedPublicationScope(root, paths, expectedHead);

  // A publisher may perform slow validation before staging while an editor, formatter, or test
  // watcher is still capable of writing the worktree. Capture its content-aware guard immediately
  // before staging and compare it immediately afterwards. A later edit cannot alter the temporary
  // index/tree already built; it remains ordinary uncommitted work for the next generation.
  const stabilityBefore = stabilityGuard ? await stabilityGuard() : null;

  const temporaryRoot = path.join(gitDir(root), 'singularity-flow', 'temporary-indexes');
  await mkdir(temporaryRoot, { recursive: true });
  const scratch = await mkdtemp(path.join(temporaryRoot, 'publication-'));
  const indexPath = path.join(scratch, 'index');
  // The temporary index is the only process-level Git selector this transaction owns. Strip any
  // inherited repository, worktree, index, object, replacement-ref, command-config, SSH and hook
  // authority before adding it so an IDE/parent shell cannot redirect the governed commit.
  const env = immutableLocalGitEnvironment(process.env, { indexFile: indexPath });
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
    admitExactProspectiveTree(root, {
      baselineCommit: expectedHead, candidateTree: tree, label: 'Governed publication'
    });
    if (expectedTree != null && tree !== expectedTree) {
      throw new SingularityFlowError(
        'Governed publication bytes changed after Candidate verification. The commit was not created; freeze and verify a new Candidate.',
        {
          code: 'PUBLICATION_CANDIDATE_DRIFT',
          details: { expectedCandidateTree: expectedTree, observedTree: tree }
        }
      );
    }
    const priorTree = git(['rev-parse', `${expectedHead}^{tree}`], { cwd: root, env }).stdout.trim();
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
        + (boundTransaction.revisionSelectionSha256
          ? `\nSingularity-Flow-REV-Selection-SHA256: ${boundTransaction.revisionSelectionSha256}`
          : '')
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
    if (boundTransaction?.id) {
      const outcome = publicationLocalRefCas(root, Object.freeze({
        kind: 'publication-local-ref-cas', ref, expectedOldOid: expectedHead,
        newCommitOid: sourceCommit, treeOid: tree, transactionId: boundTransaction.id
      }));
      if (outcome !== 'applied') {
        const error = new SingularityFlowError(
          'Governed publication could not prove whether its exact branch compare-and-swap applied. '
          + 'The commit and transaction journal were retained for exact recovery; do not retry publication before reconciliation.',
          { code: 'PUBLICATION_REF_OUTCOME_UNKNOWN' }
        );
        error.publicationRefOutcomeUnknown = true;
        throw error;
      }
      // Fault injection models a process dying after Git installed the ref but before the owner
      // received its acknowledgement. Keep the commit-created journal, then let recovery inspect
      // the exact ref rather than treating the failed callback as proof the CAS did not apply.
      if (fault) {
        try {
          await fault('after-ref-cas-before-ack', { expectedHead, sourceCommit, ref, tree });
        } catch (error) {
          error.publicationRefOutcomeUnknown = true;
          throw error;
        }
      }
    } else {
      // Non-lifecycle owners have their own recovery contracts. Migrate them separately rather
      // than silently changing how they classify a failed ref update in this first GAL increment.
      const update = git(['update-ref', ref, sourceCommit, expectedHead], {
        cwd: root, env: localEnv, allowFailure: true
      });
      if (update.status !== 0) {
        throw new SingularityFlowError(
          `Governed publication lost its branch-head race: ${(update.stderr || update.stdout).trim() || 'compare-and-swap failed'}. `
          + 'Reload the lifecycle state and retry.'
        );
      }
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
    // Updating these object IDs needs no repository-wide stat refresh. In particular, do not walk
    // every monorepo file again after creating its isolated checkout. Status/read guards still
    // inspect live files when needed; this skips neither admission nor any content verification.
    // The commit is durable from here: an index another program holds past the wait no longer
    // fails the publication. The refresh is recorded and completes on the next command.
    const refreshed = git(['reset', '-q', '--no-refresh', sourceCommit, '--', ...scope], { cwd: root, env: localEnv, allowFailure: true });
    if (refreshed.status !== 0) deferIndexRefresh(root, sourceCommit, refreshed);
    const refAfterIndexRefresh = checkedOutRef();
    if (expectedRef !== undefined && refAfterIndexRefresh !== expectedRef) {
      // A checkout racing the index refresh may now own this worktree. Restore its index from its
      // own HEAD; the exact governed commit remains safely reachable from expectedRef.
      git(['reset', '-q', '--no-refresh', 'HEAD', '--', ...scope], {
        cwd: root, env: localEnv, allowFailure: true
      });
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
      ? git(['rev-parse', `${sourceCommit}^{tree}`], {
        cwd: root, env: localEnv, allowFailure: true
      }).stdout.trim() || null
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
export async function exactRemoteBranchObservationAsync(root, remote, branchName, { signal = null } = {}) {
  validBranch(root, branchName);
  const expectedRef = `refs/heads/${branchName}`;
  const frozen = frozenRemoteTransport(remote);
  const observed = await runRemoteGitAsync([
    'ls-remote', '--heads', '--', frozen.remote, expectedRef
  ], { cwd: root, operation: 'remote-probe', env: frozen.env, signal });
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

/**
 * Read every advertised branch head from one frozen remote authority.
 *
 * Create-only publication cannot compare-and-swap an absent target against a commit. Its safety
 * anchor is therefore the parent of the proposed first commit: that parent must already be an
 * exact, published remote head. Returning the commit for every ref from one `ls-remote` keeps that
 * decision both current and cheaper than probing each possible base branch independently.
 */
export async function exactRemoteHeadsObservationAsync(root, remote) {
  const frozen = frozenRemoteTransport(remote);
  const observed = await runRemoteGitAsync([
    'ls-remote', '--heads', '--', frozen.remote, 'refs/heads/*'
  ], { cwd: root, operation: 'remote-probe', env: frozen.env });
  if (observed.status !== 0) {
    return { reachable: false, heads: {}, malformed: false, result: observed };
  }
  // Ref names come from the remote. A branch such as `__proto__` is valid Git but is a magic key
  // on an ordinary object; use a dictionary with no prototype so every advertised ref remains an
  // inert exact string and cannot corrupt target lookup or duplicate detection.
  const heads = Object.create(null);
  let malformed = false;
  for (const line of observed.stdout.split(/\r?\n/).filter((entry) => entry.trim())) {
    const match = line.match(/^([0-9a-f]{40,64})\s+refs\/heads\/([^\s]+)$/i);
    if (!match || Object.hasOwn(heads, match[2])) {
      malformed = true;
      continue;
    }
    heads[match[2]] = match[1].toLowerCase();
  }
  return { reachable: true, heads, malformed, result: observed };
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
  const result = await observePublicationHookEffects(root, () => runRemoteGitAsync([
    'push', '--porcelain', ...lease, frozen?.remote ?? transportRemote,
    `${commit.stdout.trim()}:refs/heads/${branchName}`
  ], {
    cwd: root, operation: 'remote-push',
    ...(frozen ? { env: frozen.env } : {})
  }));
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
  let result = await observePublicationHookEffects(root, () => runRemoteGitAsync([
    'push', '--porcelain', ...lease, frozen?.remote ?? transportRemote,
    `${commit.stdout.trim()}:refs/heads/${branchName}`
  ], {
    cwd: root, operation: 'remote-push',
    ...(frozen ? { env: frozen.env } : {})
  }));
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
  if (result.status === 0) recordBranchPublication(root, branchName, commit.stdout.trim(), upstreamRemote);
  return result;
}

/** Local bookkeeping after a push of `commit` to `branchName` landed: its tracking ref and upstream. */
export function recordBranchPublication(root, branchName, commit, upstreamRemote) {
  const trackingRef = `refs/remotes/${upstreamRemote}/${branchName}`;
  if (git(['check-ref-format', trackingRef], { cwd: root, allowFailure: true }).status === 0) {
    git(['update-ref', trackingRef, commit], { cwd: root });
  }
  if (refExists(root, `refs/heads/${branchName}`)) {
    configureUpstream(root, branchName, upstreamRemote);
  }
}

/**
 * Probe transport access before the worktree moves; this is not application-hook evidence.
 *
 * The source is an already-fetched remote base ref. `--dry-run` negotiates with the real remote and
 * exercises transport authentication without creating the destination branch or running local
 * hooks. Provider receive rules and local hooks are still enforced by the actual publication.
 */
export async function preflightPushBranch(root, remote, sourceRef, branchName, options = {}) {
  const transportRemote = options.transportRemote ?? remote;
  validBranch(root, branchName);
  const authority = Object.hasOwn(options, 'transportRemote') ? transportRemote
    : configuredRemoteAuthority(root, remote, { direction: 'push' }).url;
  return probeStoryBranchPublication(root, authority ?? transportRemote, sourceRef, `refs/heads/${branchName}`);
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

/**
 * Commits on the first-parent line of `tip`, newest first, that are not reachable from any of
 * `after` and whose message contains `text`. One Git walk replaces reading every commit's
 * identity: a caller verifies only these candidates. An `after` commit missing from this
 * repository bounds nothing, so the walk may then reach the root, still as one process.
 */
export function firstParentCommitsMentioning(root, text, { tip = 'HEAD', after = [] } = {}) {
  const objectId = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
  const bounds = after.filter((commit) => typeof commit === 'string' && objectId.test(commit));
  const output = gitReadOutput(git([
    'log', '--first-parent', '--format=%H', '--fixed-strings', `--grep=${text}`, '--ignore-missing',
    tip, ...bounds.map((commit) => `^${commit}`), '--'
  ], { cwd: root, env: immutableLocalGitEnvironment(), allowFailure: true }), `commits mentioning ${text}`);
  // Only object names: a configured log.showSignature, for one, adds lines of its own.
  return (output ?? '').split(/\r?\n/u).filter((line) => objectId.test(line));
}

/** Read the immutable identity embedded in a governed transaction commit. */
export function governedCommitIdentity(root, sha) {
  const env = immutableLocalGitEnvironment();
  const verified = git(['rev-parse', '--verify', `${sha}^{commit}`], {
    cwd: root, env, allowFailure: true
  });
  if (verified.status !== 0) return null;
  const commit = verified.stdout.trim();
  // Tree, parents and message are all in the commit object, so one read replaces three. Its headers
  // end at the first blank line; continuation lines (a signature) start with a space.
  const raw = git(['cat-file', 'commit', commit], { cwd: root, env }).stdout;
  const separator = raw.indexOf('\n\n');
  const message = separator < 0 ? '' : raw.slice(separator + 2);
  let tree = '';
  const parents = [];
  for (const line of (separator < 0 ? raw : raw.slice(0, separator)).split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
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
    revisionSelectionSha256: trailer('Singularity-Flow-REV-Selection-SHA256'),
    candidate: candidateValues.length === 0 ? null
      : candidateValues.length === Object.keys(candidateFields).length ? candidateFields
        : { invalid: true, ...candidateFields }
  };
}
