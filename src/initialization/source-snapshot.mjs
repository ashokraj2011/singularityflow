import { createHash } from 'node:crypto';
import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';

import { recordSha256 } from '../records.mjs';
import { SingularityFlowError, posix, run } from '../util.mjs';

export const SMART_INIT_BOUNDS = Object.freeze({
  maxFiles: 2_000,
  maxBytes: 32 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  maxModules: 200,
  maxCommands: 100,
  maxSuggestions: 100
});

const MANIFEST_NAMES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml',
  'pnpm-workspace.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'go.mod', 'go.work', 'pom.xml', 'settings.gradle', 'settings.gradle.kts',
  'build.gradle', 'build.gradle.kts', 'gradlew', 'gradlew.bat', 'mvnw', 'mvnw.cmd',
  'pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini', 'poetry.lock', 'uv.lock',
  'pipfile.lock', 'cargo.toml', 'cargo.lock', 'makefile', 'gnumakefile',
  'dockerfile'
]);

function isRequirements(name) {
  return /^requirements(?:[-_.][a-z0-9_.-]+)?\.txt$/i.test(name);
}

function candidateKind(relative) {
  const normalized = posix(relative);
  // Smart init's own managed output must not become a new detector input on the second run.
  // Repository-authored files at other .github paths remain visible as optional protection signals.
  if (normalized.startsWith('singularity/') || normalized.startsWith('.github/agents/')) return null;
  const name = path.posix.basename(normalized).toLowerCase();
  if (name === 'bun.lockb') return 'binary-manifest';
  if (MANIFEST_NAMES.has(name) || isRequirements(name)) return 'manifest';
  if (/(?:^|\/)\.env[^/]*$/i.test(normalized) || /(?:^|\/)secrets?[^/]*$/i.test(normalized)) {
    return 'sensitive-path';
  }
  if (/^dockerfile(?:[._-].+)?$/i.test(name)) return 'manifest';
  if (/(?:^|\/)(?:auth|security|migrations)(?:\/|$)/i.test(normalized)
      || /^(?:infra|deploy|\.github)(?:\/|$)/i.test(normalized)) return 'protection-path';
  return null;
}

function utf8(bytes, relative) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (error) {
    throw new SingularityFlowError(`Initialization manifest is not valid UTF-8: ${relative}`, {
      code: 'INI_MANIFEST_UNREADABLE', cause: error, details: { path: relative }
    });
  }
}

function sanitizeRemote(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (/^[^/@\s]+@[^:/\s]+:[^\s]+$/.test(value)) return value;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
    }
    return parsed.toString();
  } catch {
    // Local filesystem remotes are identities too. They are deliberately not persisted: an
    // absolute user path would make proposal bytes machine-specific.
    if (path.isAbsolute(value) || value.startsWith('file:')) return null;
    return value.replace(/\/+/g, '/');
  }
}

function git(root, args, code, message) {
  const result = run('git', args, { cwd: root, allowFailure: true });
  if (result.status !== 0) throw new SingularityFlowError(message, { code });
  return result.stdout.trim();
}

function trackedModes(root) {
  const listed = run('git', ['ls-files', '--stage', '-z'], { cwd: root, allowFailure: true });
  if (listed.status !== 0) throw new SingularityFlowError(
    'Git could not read tracked file modes for smart initialization.',
    { code: 'INI_MANIFEST_UNREADABLE' }
  );
  const modes = new Map();
  for (const record of listed.stdout.split('\0').filter(Boolean)) {
    const match = /^([0-9]{6}) [0-9a-f]+ ([0-3])\t([\s\S]+)$/u.exec(record);
    if (match?.[2] === '0') modes.set(posix(match[3]), match[1]);
  }
  return modes;
}

/** Capture only registered detector sources and path-only protection signals. No command runs. */
export async function captureSmartInitSnapshot(root, { bounds = SMART_INIT_BOUNDS } = {}) {
  const baseCommit = git(root, ['rev-parse', '--verify', 'HEAD^{commit}'],
    'INI_BASE_COMMIT_REQUIRED', 'Smart initialization requires one reviewed base commit.');
  const checkedOutRef = git(root, ['symbolic-ref', '--quiet', 'HEAD'],
    'INI_BASE_COMMIT_REQUIRED', 'Smart initialization requires a checked-out branch.');
  const tree = git(root, ['rev-parse', 'HEAD^{tree}'],
    'INI_BASE_COMMIT_REQUIRED', 'Smart initialization requires one reviewed base commit.');
  const remoteResult = run('git', ['config', '--get', 'remote.origin.url'], {
    cwd: root, allowFailure: true
  });
  const remote = remoteResult.status === 0 ? sanitizeRemote(remoteResult.stdout) : null;
  const listed = run('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root, allowFailure: true
  });
  if (listed.status !== 0) throw new SingularityFlowError(
    'Git could not enumerate repository files for smart initialization.', { code: 'INI_MANIFEST_UNREADABLE' }
  );
  const modes = trackedModes(root);
  const candidates = [...new Set(listed.stdout.split('\0').filter(Boolean).map(posix))]
    .map((relative) => ({ relative, kind: candidateKind(relative) }))
    .filter((entry) => entry.kind)
    .sort((left, right) => left.relative.localeCompare(right.relative, 'en'));
  if (candidates.length > bounds.maxFiles) throw new SingularityFlowError(
    `Smart initialization found ${candidates.length} detector inputs; the bound is ${bounds.maxFiles}.`,
    { code: 'INI_DETECTION_BOUND_EXCEEDED', details: { bound: 'maxFiles', observed: candidates.length } }
  );

  const entries = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    const absolute = path.join(root, candidate.relative);
    const info = await lstat(absolute).catch((error) => {
      throw new SingularityFlowError(`Initialization input cannot be inspected: ${candidate.relative}`, {
        code: 'INI_MANIFEST_UNREADABLE', cause: error, details: { path: candidate.relative }
      });
    });
    if (info.isSymbolicLink() || (!info.isFile() && ['manifest', 'binary-manifest'].includes(candidate.kind))) {
      throw new SingularityFlowError(`Initialization manifest must be a regular non-symlink file: ${candidate.relative}`, {
        code: 'INI_MANIFEST_UNSAFE', details: { path: candidate.relative }
      });
    }
    if (!info.isFile()) continue;
    // Sensitive/protection signals bind only the path and byte metadata. Their content is neither
    // needed nor read, so an env or secrets file cannot leak through a proposal or diagnostic.
    if (!['manifest', 'binary-manifest'].includes(candidate.kind)) {
      entries.push({ path: candidate.relative, kind: candidate.kind, mode: modes.get(candidate.relative) ?? '100644', bytes: info.size, sha256: null });
      continue;
    }
    if (info.size > bounds.maxFileBytes) throw new SingularityFlowError(
      `Initialization manifest exceeds the ${bounds.maxFileBytes}-byte file bound: ${candidate.relative}`,
      { code: 'INI_DETECTION_BOUND_EXCEEDED', details: { path: candidate.relative, bound: 'maxFileBytes', observed: info.size } }
    );
    totalBytes += info.size;
    if (totalBytes > bounds.maxBytes) throw new SingularityFlowError(
      `Initialization manifests exceed the ${bounds.maxBytes}-byte total bound.`,
      { code: 'INI_DETECTION_BOUND_EXCEEDED', details: { bound: 'maxBytes', observed: totalBytes } }
    );
    const bytes = await readFile(absolute);
    const content = candidate.kind === 'binary-manifest' ? null : utf8(bytes, candidate.relative);
    if (/\.xml$/i.test(candidate.relative) && /<!DOCTYPE|<!ENTITY/i.test(content)) {
      throw new SingularityFlowError(`Initialization XML contains a forbidden entity declaration: ${candidate.relative}`, {
        code: 'INI_MANIFEST_UNSAFE', details: { path: candidate.relative }
      });
    }
    entries.push({
      path: candidate.relative,
      kind: candidate.kind,
      mode: modes.get(candidate.relative) ?? '100644',
      bytes: bytes.length,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      content
    });
  }
  const publicEntries = entries.map(({ content: _content, ...entry }) => entry);
  const sourceManifest = {
    entries: publicEntries,
    totalManifestBytes: totalBytes,
    bounds: { ...bounds }
  };
  const sourceManifestSha256 = `sha256:${recordSha256(sourceManifest)}`;
  // The base commit already binds source history. Repository identity must remain stable after the
  // activation commit, so it is derived from the credential-free logical remote, not the tree.
  const repositoryFingerprint = `sha256:${recordSha256({ remote })}`;
  return Object.freeze({
    root,
    subject: { repositoryFingerprint, baseCommit, checkedOutRef },
    repository: { remote, tree },
    sourceManifest,
    sourceManifestSha256,
    entries
  });
}
