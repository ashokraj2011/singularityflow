import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stampBuildInfo } from '../src/build-info-stamp.mjs';

const SOURCE_DATE_EPOCH = 'SOURCE_DATE_EPOCH';
export const PACKAGING_COMMIT = 'SINGULARITY_FLOW_PACKAGING_COMMIT';
export const PACKAGING_TREE = 'SINGULARITY_FLOW_PACKAGING_TREE';
export const STAMPED_BUILD_INFO_SHA256 = 'SINGULARITY_FLOW_STAMPED_BUILD_INFO_SHA256';
const CAPTURE_FIELDS = [PACKAGING_COMMIT, PACKAGING_TREE, STAMPED_BUILD_INFO_SHA256];
const BUILD_INFO_PATH = 'src/build-info.mjs';

function normalizedEpoch(value, label = SOURCE_DATE_EPOCH) {
  const text = String(value ?? '');
  if (!/^(?:0|[1-9]\d*)$/.test(text)) {
    throw new Error(`${label} must be a non-negative integer number of seconds since the Unix epoch.`);
  }
  const seconds = Number(text);
  const date = new Date(seconds * 1_000);
  if (!Number.isSafeInteger(seconds) || !Number.isFinite(date.getTime())) {
    throw new Error(`${label} is outside the supported JavaScript date range.`);
  }
  return String(seconds);
}

function git(root, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    if (allowFailure) return null;
    const detail = String(result.stderr || result.error?.message || 'unknown Git failure').trim();
    throw new Error(`Could not resolve reproducible build identity${detail ? `: ${detail}` : '.'}`);
  }
  return result.stdout.trim();
}

function canonicalPath(value) {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

/** Return the repository top-level only when `root` is that exact directory. */
export function exactGitRoot(root) {
  const topLevel = git(root, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  // Git searches parent directories by default. A copied/Git-less package nested below another
  // checkout must not silently inherit that parent's commit identity.
  if (topLevel == null || canonicalPath(topLevel) !== canonicalPath(root)) return null;
  return topLevel;
}

function captureRequested(environment) {
  return CAPTURE_FIELDS.some((name) => Object.hasOwn(environment, name));
}

function sha256File(file) {
  return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
}

function gitBlob(root, revision, relative) {
  const result = spawnSync('git', ['show', `${revision}:${relative}`], { cwd: root, encoding: null });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || '').trim();
    throw new Error(`Could not read committed build provenance source${detail ? `: ${detail}` : '.'}`);
  }
  return result.stdout;
}

/**
 * Verify the installer's one allowed tracked mutation and its immutable source identity.
 *
 * Presence of any capture field is fail-closed: all fields must be well formed and must still
 * match HEAD, the index, every other worktree path, and the exact bytes of the stamped file.
 */
export function verifiedPackagingProvenance(root, environment = process.env) {
  if (!captureRequested(environment)) return null;
  const missing = CAPTURE_FIELDS.filter((name) => !Object.hasOwn(environment, name));
  if (missing.length > 0) {
    throw new Error(`Incomplete packaging provenance capture; missing ${missing.join(', ')}.`);
  }
  const expectedCommit = String(environment[PACKAGING_COMMIT]);
  const expectedTree = String(environment[PACKAGING_TREE]);
  const expectedStamp = String(environment[STAMPED_BUILD_INFO_SHA256]);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expectedCommit)) {
    throw new Error(`${PACKAGING_COMMIT} must be a full lowercase Git object ID.`);
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expectedTree)) {
    throw new Error(`${PACKAGING_TREE} must be a full lowercase Git object ID.`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedStamp)) {
    throw new Error(`${STAMPED_BUILD_INFO_SHA256} must be a sha256: digest.`);
  }
  if (exactGitRoot(root) == null) {
    throw new Error('Captured packaging provenance requires the exact Git repository root.');
  }
  const actualCommit = git(root, ['rev-parse', '--verify', 'HEAD']);
  const actualTree = git(root, ['rev-parse', 'HEAD^{tree}']);
  const indexComparison = spawnSync('git', ['diff', '--cached', '--quiet', 'HEAD', '--'], {
    cwd: root,
    stdio: 'ignore'
  });
  if (actualCommit !== expectedCommit) {
    throw new Error('Captured packaging commit no longer matches HEAD.');
  }
  if (actualTree !== expectedTree || indexComparison.error || indexComparison.status !== 0) {
    throw new Error('Captured packaging tree no longer matches HEAD and the Git index.');
  }
  const status = git(root, [
    'status', '--porcelain=v1', '--untracked-files=all', '--', '.', `:(exclude)${BUILD_INFO_PATH}`
  ]);
  if (status !== '') {
    throw new Error('Packaging checkout changed after provenance was captured.');
  }
  const stampedFile = path.join(root, BUILD_INFO_PATH);
  const sourceEpoch = Object.hasOwn(environment, SOURCE_DATE_EPOCH)
    ? normalizedEpoch(environment[SOURCE_DATE_EPOCH])
    : normalizedEpoch(git(root, ['show', '-s', '--format=%ct', actualCommit]), 'Git commit timestamp');
  const expectedBytes = Buffer.from(stampBuildInfo(
    gitBlob(root, actualCommit, BUILD_INFO_PATH).toString('utf8'),
    {
      commit: actualCommit,
      sourceSha256: null,
      branch: null,
      dirty: false,
      builtAt: new Date(Number(sourceEpoch) * 1_000).toISOString()
    }
  ));
  const expectedDeterministicStamp = `sha256:${createHash('sha256').update(expectedBytes).digest('hex')}`;
  if (expectedStamp !== expectedDeterministicStamp || sha256File(stampedFile) !== expectedStamp) {
    throw new Error('Stamped build provenance bytes do not match the captured digest.');
  }
  return Object.freeze({
    commit: actualCommit,
    tree: actualTree,
    stampedBuildInfo: BUILD_INFO_PATH,
    stampedBuildInfoSha256: expectedStamp
  });
}

function repositoryIdentity(root, environment) {
  const captured = verifiedPackagingProvenance(root, environment);
  if (captured != null) {
    return {
      commit: git(root, ['rev-parse', '--short=7', captured.commit]),
      local: false,
      commitEpoch: git(root, ['show', '-s', '--format=%ct', captured.commit])
    };
  }
  if (exactGitRoot(root) == null) {
    return { commit: 'unknown', local: true, commitEpoch: null };
  }
  const fullCommit = git(root, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  if (fullCommit == null) return { commit: 'unknown', local: true, commitEpoch: null };
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all'], {
    allowFailure: true
  });
  return {
    commit: git(root, ['rev-parse', '--short=7', fullCommit]),
    local: status == null || status !== '',
    commitEpoch: git(root, ['show', '-s', '--format=%ct', fullCommit], { allowFailure: true })
  };
}

function localEpoch(now) {
  const milliseconds = Number(now());
  if (!Number.isFinite(milliseconds)) {
    throw new Error('Local build timestamp must be a finite number of milliseconds.');
  }
  return normalizedEpoch(Math.floor(milliseconds / 1_000), 'Local build timestamp');
}

function sourceEpoch(environment, identity, now) {
  if (Object.hasOwn(environment, SOURCE_DATE_EPOCH)) {
    return normalizedEpoch(environment[SOURCE_DATE_EPOCH]);
  }
  if (!identity.local && identity.commitEpoch != null) {
    return normalizedEpoch(identity.commitEpoch, 'Git HEAD commit timestamp');
  }
  return localEpoch(now);
}

/**
 * Resolve the standard reproducible-build timestamp.
 *
 * An explicit SOURCE_DATE_EPOCH always wins. A clean checkout uses the exact HEAD commit time so
 * separate release hosts produce the same bytes. Dirty and Git-less development builds retain the
 * previous wall-clock identity: they are deliberately local rather than reproducible artifacts.
 */
export function resolveSourceDateEpoch(
  root,
  environment = process.env,
  { now = Date.now } = {}
) {
  return sourceEpoch(environment, repositoryIdentity(root, environment), now);
}

/** Give subprocesses the same epoch used by the visible build stamp and reproducible ZIP metadata. */
export function reproducibleBuildEnvironment(root, environment = process.env, options = {}) {
  return {
    ...environment,
    [SOURCE_DATE_EPOCH]: resolveSourceDateEpoch(root, environment, options)
  };
}

/** Preserve commit/local identity while making clean builds deterministic from source time. */
export function vscodeBuildIdentity(root, environment = process.env, options = {}) {
  const identity = repositoryIdentity(root, environment);
  const epoch = sourceEpoch(environment, identity, options.now ?? Date.now);
  const timestamp = `${new Date(Number(epoch) * 1_000).toISOString().slice(0, 16)}Z`;
  return Object.freeze({
    commit: identity.commit,
    local: identity.local,
    sourceDateEpoch: epoch,
    stamp: `${identity.commit}${identity.local ? '+local' : ''} ${timestamp}`
  });
}
