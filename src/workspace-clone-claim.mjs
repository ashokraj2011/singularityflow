/** Completed workspace clones are recoverable data, never disposable retry scratch. */
import { createHash } from 'node:crypto';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeCloneStrategy } from './clone-strategy.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { canonicalJson } from './foundation/record-schema.mjs';
import { remoteFingerprint } from './git-remote-diagnostics.mjs';
import { worktreeFingerprint } from './worktree-fingerprint.mjs';
import { run, SingularityFlowError } from './util.mjs';

export const CLONE_COMPLETION_FILE = '.sflow-clone-complete.json';
const OWNER = '.sflow-bootstrap-owner.json';
const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES']);
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const targetIdentity = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const fail = (message, code = 'WORKSPACE_CLONE_RESUME_UNSAFE') => {
  throw new SingularityFlowError(message, { code });
};

export function cloneClaimPolicy(env = process.env) {
  const integer = (key, fallback, maximum) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail(
      `${key} must be an integer between 1 and ${maximum}.`, 'WORKSPACE_CLONE_CLAIM_SETTINGS_INVALID');
    return value;
  };
  return Object.freeze({
    timeoutMs: integer('SINGULARITY_FLOW_CLONE_CLAIM_TIMEOUT_MS', 300_000, 1_800_000),
    initialDelayMs: integer('SINGULARITY_FLOW_CLONE_CLAIM_RETRY_DELAY_MS', 100, 10_000),
    maxAttempts: integer('SINGULARITY_FLOW_CLONE_CLAIM_MAX_ATTEMPTS', 1_000, 10_000)
  });
}

/** Recheck ownership and occupancy before every attempt; only filesystem contention is retried. */
export async function retryWorkspaceCloneClaim(action, beforeAttempt, policy) {
  const started = performance.now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      await beforeAttempt();
      return await action();
    } catch (error) {
      const remaining = policy.timeoutMs - (performance.now() - started);
      const exhausted = () => {
        Object.defineProperty(error, 'claimRetry', { value: {
          attempts, elapsedMs: Math.round(performance.now() - started), ...policy
        }, configurable: true });
        throw error;
      };
      if (!TRANSIENT.has(error?.code) || attempts >= policy.maxAttempts || remaining <= 0) exhausted();
      // Avoid a busy loop when the ownership observation itself was transiently locked.
      await delay(Math.min(remaining, 2_000, policy.initialDelayMs * (2 ** Math.min(attempts - 1, 10))));
      if (performance.now() - started >= policy.timeoutMs) exhausted();
    }
  }
}

export function workspaceCloneLeasePath(target) {
  return path.join(path.dirname(target), `.sflow-clone-target-${hash(targetIdentity(target)).slice(0, 24)}`);
}

export function workspaceCloneStagingPrefix(target) {
  return `.sflow-clone-${hash(targetIdentity(target)).slice(0, 24)}-`;
}

function binding(operation) {
  return hash({ workspaceId: operation.workspaceId ?? null, repository: operation.repository,
    target: targetIdentity(operation.target), remote: remoteFingerprint(operation.url),
    branch: operation.branch, clone: normalizeCloneStrategy(operation.clone) });
}

function directoryIdentity(info) {
  return { dev: String(info.dev), ino: String(info.ino), birthtimeMs: info.birthtimeMs };
}

async function regularJson(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 65_536) fail(`Unsafe clone recovery record: ${file}`);
  return JSON.parse(await readFile(file, 'utf8'));
}

// Editors record their own branch metadata the moment they see a new repository: VS Code's Git
// extension writes branch.<name>.vscode-merge-base, the GitHub Pull Requests extension its
// github-pr-* keys. Git never reads them, so a clone they touched is still the clone that completed.
const EDITOR_BRANCH_KEY = /^\s*(?:vscode-|github-pr-)[a-z0-9-]*\s*(?:=|$)/iu;

/** The config text without editor-only branch keys, and any branch section left empty by that. */
export function withoutEditorBranchKeys(text) {
  const kept = [];
  let section = null;
  const close = () => {
    if (section && !(section.removed && !section.other)) kept.push(...section.lines);
    section = null;
  };
  for (const line of String(text).split(/(?<=\n)/u)) {
    if (/^\s*\[/u.test(line)) {
      close();
      section = /^\s*\[\s*branch\s+"/iu.test(line) ? { lines: [line], removed: false, other: false } : null;
      if (!section) kept.push(line);
    } else if (!section) kept.push(line);
    else if (EDITOR_BRANCH_KEY.test(line)) section.removed = true;
    else {
      section.lines.push(line);
      if (line.trim() && !/^\s*[#;]/u.test(line)) section.other = true;
    }
  }
  close();
  return kept.join('');
}

async function configBytes(staging) {
  const file = path.join(staging, '.git', 'config');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) fail('Unsafe retained clone Git configuration.');
  return readFile(file);
}

const sha256Hex = value => createHash('sha256').update(value).digest('hex');

async function configDigest(staging) {
  return sha256Hex(withoutEditorBranchKeys((await configBytes(staging)).toString('utf8')));
}

/** A record sealed before this rule holds the digest of the raw bytes; either form matches. */
async function configMatches(staging, recorded) {
  const bytes = await configBytes(staging);
  return recorded === sha256Hex(withoutEditorBranchKeys(bytes.toString('utf8'))) || recorded === sha256Hex(bytes);
}

function snapshot(staging, operation, env) {
  env = { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };
  const git = args => run('git', args, { cwd: staging, env, timeoutMs: 30_000, maxBuffer: 1024 * 1024 }).stdout.trim();
  const [head, ref] = git(['rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD']).split(/\r?\n/u);
  if (git(['config', '--local', '--get', 'remote.origin.url']) !== operation.url
      || ref !== `refs/heads/${operation.branch}`) fail('The retained clone origin or selected branch changed. Its bytes were preserved.');
  return { head,
    worktree: worktreeFingerprint(staging, { fresh: true, env }).sha256 };
}

/** Called only after all clone, sparse-checkout and origin restoration work has succeeded. */
export async function sealWorkspaceClone(stagingRoot, owner, operation, actualClone, fallbackUsed, env) {
  const staging = path.join(stagingRoot, 'repository');
  const gitDirectory = await lstat(path.join(staging, '.git'));
  if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()) fail('The completed clone must have its own ordinary .git directory.');
  const core = { schemaVersion: currentSchemaVersion('workspace-clone-completion'),
    kind: 'sflow-completed-workspace-clone', ownerSha256: hash(owner), bindingSha256: binding(operation),
    source: directoryIdentity(await lstat(staging)), gitConfigSha256: await configDigest(staging),
    snapshot: snapshot(staging, operation, env),
    actualClone, fallbackUsed, completedAt: new Date().toISOString() };
  const record = { ...core, sha256: hash(core) };
  const handle = await open(path.join(stagingRoot, CLONE_COMPLETION_FILE), 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  return record;
}

export async function verifyCompletedWorkspaceClone(stagingRoot, owner, operation, record, env) {
  const currentOwner = readRecord('workspace-bootstrap-owner', await regularJson(path.join(stagingRoot, OWNER))).record;
  const currentRecord = readRecord('workspace-clone-completion', await regularJson(path.join(stagingRoot, CLONE_COMPLETION_FILE))).record;
  const { sha256, ...core } = record;
  const staging = path.join(stagingRoot, 'repository');
  const source = await lstat(staging);
  const gitDirectory = await lstat(path.join(staging, '.git'));
  // Name each fact that differs, cheapest first; the Git reads run only for an otherwise intact clone.
  const changed = [];
  if (record.kind !== 'sflow-completed-workspace-clone' || hash(core) !== sha256 || hash(currentRecord) !== hash(record)) {
    changed.push('its recovery record');
  }
  if (hash(currentOwner) !== hash(owner) || record.ownerSha256 !== hash(owner)) changed.push('its staging owner record');
  if (record.bindingSha256 !== binding(operation)) changed.push('the workspace repository it was cloned for (target, remote, branch or clone strategy)');
  if (!source.isDirectory() || source.isSymbolicLink() || !gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()
      || hash(directoryIdentity(source)) !== hash(record.source)) changed.push('its directory');
  if (!changed.length && !await configMatches(staging, record.gitConfigSha256)) changed.push('its Git configuration (.git/config)');
  if (!changed.length && hash(snapshot(staging, operation, env)) !== hash(record.snapshot)) changed.push('its checked-out HEAD or files');
  if (changed.length) fail(`The completed clone no longer matches its recovery record: ${changed.join(', ')} changed after the clone `
    + `completed. Its bytes were preserved at ${stagingRoot}. SFlow claims a retained clone only as it completed: undo that change and `
    + 'run the same command again, or move the retained clone out of the repository folder to download a fresh copy.');
  return record;
}

/** Bounded search in this target's parent only; no remote, home-directory or branch discovery. */
export async function findCompletedWorkspaceClone(parent, operation, env) {
  const names = (await readdir(parent)).filter(name => name.startsWith(workspaceCloneStagingPrefix(operation.target)));
  if (names.length > 1_024) fail('Too many workspace clone staging entries; inspect retained recovery before retrying.');
  const matches = [];
  for (const name of names) {
    const stagingRoot = path.join(parent, name);
    const info = await lstat(stagingRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    const completion = await lstat(path.join(stagingRoot, CLONE_COMPLETION_FILE)).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!completion) continue;
    const owner = readRecord('workspace-bootstrap-owner', await regularJson(path.join(stagingRoot, OWNER))).record;
    if (targetIdentity(owner.targetPath) !== targetIdentity(operation.target)) continue;
    if (await realpath(stagingRoot) !== owner.canonicalPath || path.dirname(owner.canonicalPath) !== parent
        || owner.repositoryId !== operation.repository) fail(`Clone recovery ownership changed: ${stagingRoot}`);
    const record = readRecord('workspace-clone-completion', await regularJson(path.join(stagingRoot, CLONE_COMPLETION_FILE))).record;
    await verifyCompletedWorkspaceClone(stagingRoot, owner, operation, record, env);
    matches.push({ stagingRoot, owner, record });
  }
  if (matches.length > 1) fail('Multiple completed clones claim this workspace target. Nothing was moved; inspect recovery.');
  return matches[0] ?? null;
}
