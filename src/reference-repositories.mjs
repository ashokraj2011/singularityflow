/**
 * Immutable, read-only repository references attached to one Story.
 *
 * A reference repository is deliberately not a capability/delivery repository. SFlow may read its
 * pinned source while authoring the target Story, but it never creates a Story branch there, stages
 * its files, commits to it, or pushes it. The durable Story records a credential-free remote,
 * requested branch and exact commit/tree; each laptop may reproduce the detached local checkout.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from './git.mjs';
import { gitRemoteProbeTimeout, gitTimeouts, runRemoteGitAsync } from './git-execution.mjs';
import {
  assertCredentialFreeRemote, remoteFingerprint, sanitizeRemote
} from './git-remote-diagnostics.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import {
  SingularityFlowError, ensureSecureRepositoryDirectory, isGitRefName, mapLimit, nowIso, posix,
  readJson, run, secureRepositoryPath, writeJson
} from './util.mjs';

export const REFERENCE_REPOSITORY_FAMILY = 'story-reference-repository-set';
export const REFERENCE_REPOSITORY_LOCAL_ROOT = '.singularity-flow/reference-repositories';
const MAXIMUM_REFERENCES = 16;
const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const EXCLUDE_PATTERN = `/${REFERENCE_REPOSITORY_LOCAL_ROOT}/`;
const PROJECT_MARKERS = Object.freeze([
  'pom.xml', 'settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts',
  'gradlew', 'mvnw', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'poetry.lock',
  'package.json', 'Cargo.toml', 'go.mod', 'Makefile'
]);
const SOURCE_ROOT_NAMES = new Set([
  'src', 'app', 'apps', 'lib', 'libs', 'modules', 'packages', 'services', 'test', 'tests'
]);

function fail(message, code = 'REFERENCE_REPOSITORY_INVALID', details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

function normalizePinnedReference(reference, { requireTree = false } = {}) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
    fail('A reference repository pin must be an object.');
  }
  const id = String(reference.id ?? '');
  if (!IDENTIFIER.test(id) || id.length > 64) {
    fail('A reference repository pin has an invalid lower-case kebab identifier.',
      'REFERENCE_REPOSITORY_ID_INVALID');
  }
  const repository = sanitizeRemote(assertCredentialFreeRemote(reference.repository));
  const repositorySha256 = `sha256:${remoteFingerprint(repository)}`;
  if (reference.repositorySha256 !== repositorySha256) {
    fail(`Reference repository '${id}' does not match its repository fingerprint.`,
      'REFERENCE_REPOSITORY_MANIFEST_MISMATCH');
  }
  if (!isGitRefName(reference.requestedBranch)) {
    fail(`Reference repository '${id}' has an invalid requested branch.`,
      'REFERENCE_REPOSITORY_BRANCH_INVALID');
  }
  if (!OBJECT_ID.test(String(reference.commit ?? ''))) {
    fail(`Reference repository '${id}' has an invalid pinned commit.`,
      'REFERENCE_REPOSITORY_MANIFEST_MISMATCH');
  }
  if ((requireTree || reference.tree != null) && !OBJECT_ID.test(String(reference.tree ?? ''))) {
    fail(`Reference repository '${id}' has no valid pinned tree.`,
      'REFERENCE_REPOSITORY_MANIFEST_MISMATCH');
  }
  if (reference.localPath !== `${REFERENCE_REPOSITORY_LOCAL_ROOT}/${id}`) {
    fail(`Reference repository '${id}' has an invalid local materialization path.`,
      'REFERENCE_REPOSITORY_PATH_UNSAFE');
  }
  if (reference.required != null && typeof reference.required !== 'boolean') {
    fail(`Reference repository '${id}' has an invalid required flag.`,
      'REFERENCE_REPOSITORY_MANIFEST_MISMATCH');
  }
  return {
    ...reference,
    id,
    repository,
    repositorySha256,
    requestedBranch: String(reference.requestedBranch),
    commit: String(reference.commit).toLowerCase(),
    tree: reference.tree == null ? null : String(reference.tree).toLowerCase(),
    required: reference.required !== false,
    localPath: `${REFERENCE_REPOSITORY_LOCAL_ROOT}/${id}`
  };
}

function normalizePinnedReferences(references, options = {}) {
  if (!Array.isArray(references) || references.length > MAXIMUM_REFERENCES) {
    fail(`A Story may declare at most ${MAXIMUM_REFERENCES} reference repositories.`,
      'REFERENCE_REPOSITORY_LIMIT');
  }
  const normalized = references.map((reference) => normalizePinnedReference(reference, options));
  const ids = new Set(normalized.map((reference) => reference.id));
  if (ids.size !== normalized.length) fail('A Story reference repository identifier is duplicated.');
  return normalized;
}

function parseAssignment(raw, option) {
  const value = String(raw ?? '');
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) {
    fail(`--${option} requires ID=VALUE, for example --${option} java-rule-engine=VALUE.`);
  }
  const id = value.slice(0, separator).trim();
  const assigned = value.slice(separator + 1).trim();
  if (!IDENTIFIER.test(id) || id.length > 64) {
    fail(`Reference repository identifier '${id}' must use lower-case kebab case.`,
      'REFERENCE_REPOSITORY_ID_INVALID');
  }
  if (!assigned) fail(`--${option} has no value for '${id}'.`);
  return { id, value: assigned };
}

/** Parse repeatable paired CLI options without making URL/ref delimiter guesses. */
export function parseReferenceRepositoryOptions(repositoryValues = [], branchValues = []) {
  if (!repositoryValues.length && !branchValues.length) return [];
  if (repositoryValues.length > MAXIMUM_REFERENCES || branchValues.length > MAXIMUM_REFERENCES) {
    fail(`A Story may declare at most ${MAXIMUM_REFERENCES} reference repositories.`,
      'REFERENCE_REPOSITORY_LIMIT');
  }
  const repositories = new Map();
  for (const raw of repositoryValues) {
    const { id, value } = parseAssignment(raw, 'reference-repository');
    if (repositories.has(id)) fail(`Reference repository '${id}' is declared more than once.`);
    repositories.set(id, assertCredentialFreeRemote(value));
  }
  const branches = new Map();
  for (const raw of branchValues) {
    const { id, value } = parseAssignment(raw, 'reference-branch');
    if (branches.has(id)) fail(`Reference branch '${id}' is declared more than once.`);
    if (!isGitRefName(value)) fail(`Reference branch '${value}' for '${id}' is not a safe Git branch name.`,
      'REFERENCE_REPOSITORY_BRANCH_INVALID');
    branches.set(id, value);
  }
  for (const id of repositories.keys()) {
    if (!branches.has(id)) {
      fail(`Reference repository '${id}' requires --reference-branch ${id}=<BRANCH>.`,
        'REFERENCE_REPOSITORY_BRANCH_REQUIRED');
    }
  }
  for (const id of branches.keys()) {
    if (!repositories.has(id)) {
      fail(`--reference-branch declares unknown reference repository '${id}'.`,
        'REFERENCE_REPOSITORY_UNKNOWN');
    }
  }
  return [...repositories].map(([id, repository]) => ({
    id, repository, requestedBranch: branches.get(id), required: true
  }));
}

/** Resolve each requested branch once, before Story mutation, and pin its exact advertised tip. */
export async function resolveReferenceRepositoryPins(requests, {
  env = process.env, runGit = runRemoteGitAsync, workers = 4
} = {}) {
  return mapLimit(requests, Math.max(1, Math.min(workers, 4)), async (request) => {
    const ref = `refs/heads/${request.requestedBranch}`;
    const result = await runGit(['ls-remote', '--heads', request.repository, ref], {
      env, operation: 'remote-probe', timeoutMs: gitRemoteProbeTimeout(request.repository, env),
      allowFailure: false
    });
    const lines = String(result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const match = lines.map((line) => line.match(/^([0-9a-f]{40}(?:[0-9a-f]{24})?)\s+(refs\/heads\/[^\s]+)$/i))
      .find((candidate) => candidate?.[2] === ref);
    if (!match || !OBJECT_ID.test(match[1])) {
      fail(`Reference repository '${request.id}' has no advertised branch '${request.requestedBranch}'.`,
        'REFERENCE_REPOSITORY_BRANCH_NOT_FOUND', { id: request.id, branch: request.requestedBranch });
    }
    const repository = sanitizeRemote(request.repository);
    return {
      schemaVersion: currentSchemaVersion(REFERENCE_REPOSITORY_FAMILY),
      id: request.id,
      repository,
      repositorySha256: `sha256:${remoteFingerprint(repository)}`,
      requestedBranch: request.requestedBranch,
      commit: match[1].toLowerCase(),
      tree: null,
      required: request.required !== false,
      localPath: `${REFERENCE_REPOSITORY_LOCAL_ROOT}/${request.id}`,
      pinnedAt: nowIso()
    };
  });
}

async function ensureLocallyExcluded(root) {
  const common = gitCommonDir(root);
  const info = path.join(common, 'info');
  const exclude = path.join(info, 'exclude');
  await mkdir(info, { recursive: true });
  const current = await readFile(exclude, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  if (current.split(/\r?\n/).includes(EXCLUDE_PATTERN)) return;
  await appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${EXCLUDE_PATTERN}\n`, 'utf8');
}

function localObservation(target) {
  const object = run('git', ['rev-parse', 'HEAD'], { cwd: target, allowFailure: true });
  const tree = run('git', ['rev-parse', 'HEAD^{tree}'], { cwd: target, allowFailure: true });
  const activeBranch = run('git', ['branch', '--show-current'], { cwd: target, allowFailure: true });
  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: target, allowFailure: true
  });
  const remote = run('git', ['remote', 'get-url', 'origin'], { cwd: target, allowFailure: true });
  return {
    ok: [object, tree, activeBranch, status, remote].every((result) => result.status === 0),
    commit: object.stdout.trim().toLowerCase(),
    tree: tree.stdout.trim().toLowerCase(),
    branch: activeBranch.stdout.trim(),
    dirty: Boolean(status.stdout.trim()),
    repositorySha256: remote.status === 0
      ? `sha256:${remoteFingerprint(assertCredentialFreeRemote(remote.stdout.trim()))}` : null
  };
}

function assertObservation(reference, observed) {
  const reasons = [];
  if (!observed.ok) reasons.push('it is not a readable Git checkout');
  if (observed.commit !== reference.commit) reasons.push(`HEAD is ${observed.commit || 'unavailable'}, expected ${reference.commit}`);
  if (observed.branch) reasons.push(`it is attached to branch '${observed.branch}', expected detached HEAD`);
  if (observed.dirty) reasons.push('it contains local changes');
  if (observed.repositorySha256 !== reference.repositorySha256) reasons.push('its origin is a different repository');
  if (reference.tree && observed.tree !== reference.tree) reasons.push('its tree differs from the pinned tree');
  if (reasons.length) {
    fail(
      `Reference repository '${reference.id}' is not the immutable Story reference: ${reasons.join('; ')}. `
      + `SFlow will not reset or overwrite it. Move it aside, then run singularity-flow story references materialize --work-id <WORK-ID>.`,
      'REFERENCE_REPOSITORY_TAMPERED', { id: reference.id, reasons }
    );
  }
  return observed;
}

async function materializeOne(root, reference, { env, runGit }) {
  const secured = await secureRepositoryPath(root, reference.localPath, {
    label: `Reference repository '${reference.id}'`
  });
  if (secured.exists) {
    if (!secured.entry?.isDirectory()) fail(`Reference repository path '${reference.localPath}' is not a directory.`,
      'REFERENCE_REPOSITORY_PATH_UNSAFE');
    const observed = assertObservation(reference, localObservation(secured.absolute));
    return { ...reference, tree: reference.tree ?? observed.tree, materialization: 'reused' };
  }
  const parent = await ensureSecureRepositoryDirectory(root, path.dirname(reference.localPath), {
    label: 'Reference repository local root'
  });
  const staging = await mkdtemp(path.join(parent.absolute, `.${reference.id}-`));
  try {
    run('git', ['init', '--quiet'], { cwd: staging });
    run('git', ['remote', 'add', 'origin', reference.repository], { cwd: staging });
    await runGit(['fetch', '--depth=1', '--no-tags', 'origin', reference.commit], {
      cwd: staging, env, operation: 'remote-configuration',
      timeoutMs: gitTimeouts(env).configuration, allowFailure: false
    });
    run('git', ['checkout', '--quiet', '--detach', reference.commit], { cwd: staging });
    const observed = assertObservation(reference, localObservation(staging));
    await rename(staging, secured.absolute);
    return { ...reference, tree: observed.tree, materialization: 'created' };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Materialize pinned sources beneath the selected Story checkout, never in home or a temp cache. */
export async function materializeReferenceRepositories(root, references, {
  env = process.env, runGit = runRemoteGitAsync, workers = 2
} = {}) {
  const normalized = normalizePinnedReferences(references);
  if (!normalized.length) return [];
  await ensureLocallyExcluded(root);
  const tracked = run('git', ['ls-files', '--', REFERENCE_REPOSITORY_LOCAL_ROOT], {
    cwd: root, allowFailure: true
  }).stdout.trim();
  if (tracked) {
    fail(`Reference materialization root '${REFERENCE_REPOSITORY_LOCAL_ROOT}' contains tracked files. `
      + 'Remove those files from the application repository before attaching read-only references.',
    'REFERENCE_REPOSITORY_PATH_TRACKED');
  }
  return mapLimit(normalized, Math.max(1, Math.min(workers, 2)), (reference) =>
    materializeOne(root, reference, { env, runGit }));
}

export function referenceRepositoryManifestRelative(config, workId) {
  return posix(path.join(
    config.workItemRoot ?? 'singularity/work-items', workId, 'context/reference-repositories.json'
  ));
}

export async function writeReferenceRepositoryManifest(root, config, workId, references) {
  const normalized = normalizePinnedReferences(references, { requireTree: true });
  if (!normalized.length) return null;
  const relative = referenceRepositoryManifestRelative(config, workId);
  const record = {
    schemaVersion: currentSchemaVersion(REFERENCE_REPOSITORY_FAMILY),
    kind: REFERENCE_REPOSITORY_FAMILY,
    workId,
    repositories: normalized.map(({ materialization: _materialization, ...reference }) => reference)
      .sort((left, right) => left.id.localeCompare(right.id))
  };
  record.setSha256 = `sha256:${createHash('sha256').update(JSON.stringify(record.repositories)).digest('hex')}`;
  await writeJson(path.join(root, relative), record);
  return { path: relative, record };
}

export async function readReferenceRepositoryManifest(root, config, workId) {
  const relative = referenceRepositoryManifestRelative(config, workId);
  const secured = await secureRepositoryPath(root, relative, {
    label: 'Story reference repository manifest', mustExist: true, type: 'file'
  });
  return { path: relative, record: readRecord(REFERENCE_REPOSITORY_FAMILY, await readJson(secured.absolute)).record };
}

/** Bind the durable manifest to the same immutable set captured in the Story workflow snapshot. */
export async function storyReferenceRepositories(root, config, workflow) {
  const pinned = normalizePinnedReferences(
    workflow.resolution?.referenceRepositories ?? [], { requireTree: true }
  )
    .sort((left, right) => left.id.localeCompare(right.id));
  if (!pinned.length) return [];
  const { record } = await readReferenceRepositoryManifest(root, config, workflow.workItem.id);
  const recorded = normalizePinnedReferences(record.repositories ?? [], { requireTree: true })
    .sort((left, right) => left.id.localeCompare(right.id));
  const computed = `sha256:${createHash('sha256').update(JSON.stringify(recorded)).digest('hex')}`;
  if (record.workId !== workflow.workItem.id || record.setSha256 !== computed
      || JSON.stringify(recorded) !== JSON.stringify(pinned)) {
    fail(`Story '${workflow.workItem.id}' reference repository manifest does not match its pinned workflow policy.`,
      'REFERENCE_REPOSITORY_MANIFEST_MISMATCH');
  }
  return recorded;
}

/** Verify local materializations without fetching, rewriting, resetting, or cleaning anything. */
export async function verifyReferenceRepositories(root, references) {
  references = normalizePinnedReferences(references, { requireTree: true });
  const results = [];
  for (const reference of references ?? []) {
    const secured = await secureRepositoryPath(root, reference.localPath, {
      label: `Reference repository '${reference.id}'`
    });
    if (!secured.exists) {
      results.push({ id: reference.id, status: 'missing', required: reference.required !== false,
        localPath: reference.localPath, commit: reference.commit, requestedBranch: reference.requestedBranch });
      continue;
    }
    try {
      const observed = assertObservation(reference, localObservation(secured.absolute));
      results.push({ id: reference.id, status: 'ready', required: reference.required !== false,
        localPath: reference.localPath, commit: observed.commit, tree: observed.tree,
        requestedBranch: reference.requestedBranch });
    } catch (error) {
      results.push({ id: reference.id, status: 'invalid', required: reference.required !== false,
        localPath: reference.localPath, commit: reference.commit, requestedBranch: reference.requestedBranch,
        reason: error.message });
    }
  }
  return {
    status: results.some((entry) => entry.required && entry.status !== 'ready') ? 'blocked'
      : results.length ? 'ready' : 'not-configured',
    repositories: results,
    nextAction: results.some((entry) => entry.status === 'missing')
      ? 'singularity-flow story references materialize --work-id <WORK-ID>' : null
  };
}

function shallowTree(target, treeish = 'HEAD') {
  const listed = run('git', ['ls-tree', '--name-only', treeish], {
    cwd: target, allowFailure: true
  });
  if (listed.status !== 0) return [];
  return listed.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).slice(0, 64);
}

/**
 * Build a bounded, model-free navigation map for the exact detached reference commit.
 *
 * This deliberately does not walk every file and does not create another World Model. A committed
 * reference World Model is exposed as a reusable pointer; otherwise common build descriptors and
 * shallow source roots give the authoring model enough information to choose its next file tool.
 */
export async function referenceRepositoryGroundingContext(root, references) {
  const normalized = normalizePinnedReferences(references, { requireTree: true });
  if (!normalized.length) return { status: 'not-configured', text: '', repositories: [] };
  const verification = await verifyReferenceRepositories(root, normalized);
  const observations = [];
  for (const reference of normalized) {
    const verified = verification.repositories.find((entry) => entry.id === reference.id);
    if (verified?.status !== 'ready') {
      observations.push({
        id: reference.id, status: verified?.status ?? 'missing', requestedBranch: reference.requestedBranch,
        commit: reference.commit, tree: reference.tree, localPath: reference.localPath,
        projectMarkers: [], sourceRoots: [], reusableWorldModel: null
      });
      continue;
    }
    const target = path.join(root, reference.localPath);
    const topLevel = shallowTree(target);
    const topLevelSet = new Set(topLevel);
    const projectMarkers = PROJECT_MARKERS.filter((candidate) => topLevelSet.has(candidate));
    const sourceRoots = topLevel.filter((entry) => SOURCE_ROOT_NAMES.has(entry.toLowerCase()));
    const worldModelPath = 'singularity/world-model/manifest.json';
    // One bounded Git read both proves presence and returns the exact committed bytes. Every
    // project marker is already visible in the shallow tree, so it needs no per-marker process.
    const committedWorldModel = run('git', ['show', `HEAD:${worldModelPath}`], {
      cwd: target, allowFailure: true
    });
    const reusableWorldModel = committedWorldModel.status === 0
      ? {
          path: posix(path.join(reference.localPath, worldModelPath)),
          // The reference commit already binds the blob identity. SHA-256 keeps this projection
          // aligned with SFlow records even when the repository itself uses SHA-1 Git objects.
          sha256: `sha256:${createHash('sha256').update(committedWorldModel.stdout).digest('hex')}`
        }
      : null;
    observations.push({
      id: reference.id, status: 'ready', requestedBranch: reference.requestedBranch,
      commit: reference.commit, tree: reference.tree, localPath: reference.localPath,
      projectMarkers, sourceRoots, reusableWorldModel
    });
  }
  const text = [
    '# Pinned reference-repository grounding',
    '',
    'These are immutable navigation inputs, not delivery repositories. Inspect only the detached paths below; write all generated code and tests in the current Story repository.',
    'No reference World Model was generated by this composition. A listed World Model is an existing blob from the pinned reference commit and may be reused; otherwise use ordinary bounded file tools.',
    '',
    ...observations.flatMap((entry) => [
      `## ${entry.id}`,
      '',
      `- Status: \`${entry.status}\``,
      `- Local detached root: \`${entry.localPath}\``,
      `- Requested branch: \`${entry.requestedBranch}\``,
      `- Pinned commit: \`${entry.commit}\``,
      `- Pinned tree: \`${entry.tree}\``,
      `- Project markers: ${entry.projectMarkers.length
        ? entry.projectMarkers.map((item) => `\`${item}\``).join(', ') : 'none detected'}`,
      `- Shallow source roots: ${entry.sourceRoots.length
        ? entry.sourceRoots.map((item) => `\`${item}\``).join(', ') : 'none detected'}`,
      `- Reusable committed World Model: ${entry.reusableWorldModel
        ? `\`${entry.reusableWorldModel.path}\` (${entry.reusableWorldModel.sha256})` : 'not present'}`,
      ''
    ])
  ].join('\n');
  return {
    status: verification.status,
    text,
    repositories: observations,
    nextAction: verification.nextAction
  };
}

/** A bounded, deterministic prompt block: identity and exact local source boundary, never content. */
export function referenceRepositoryContextMarkdown(references) {
  if (!(references ?? []).length) return '';
  return [
    '<!-- singularity-flow:reference-repositories -->',
    '## Read-only reference repositories',
    '',
    '> These detached repositories are inputs for comprehension and code generation only. Do not edit, branch, commit, or push them. All delivery changes belong in the current Story repository.',
    '',
    ...references.flatMap((reference) => [
      '- **' + reference.id + '** — `' + reference.localPath + '`',
      '  - requested branch: `' + reference.requestedBranch + '`',
      '  - pinned commit: `' + reference.commit + '`'
    ]),
    '<!-- /singularity-flow:reference-repositories -->'
  ].join('\n');
}
