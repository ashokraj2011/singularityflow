import { createHash } from 'node:crypto';
import path from 'node:path';

import { workDir } from './state-stores.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { posix, readJson, run, SingularityFlowError, writeJson } from './util.mjs';
import {
  activeWorkspaceFile, workspaceMemberContextForRepository, workspaceRegistryFile
} from './workspace-context.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function remoteProjection(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { url: null, fingerprint: null, portability: 'unavailable' };
  try {
    const parsed = new URL(value);
    if (!['https:', 'ssh:'].includes(parsed.protocol)) {
      return { url: null, fingerprint: sha256(value), portability: 'machine-local' };
    }
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return { url: parsed.toString(), fingerprint: sha256(parsed.toString()), portability: 'portable' };
  } catch {
    // SCP-style SSH remotes contain an account name, not a credential. Absolute and relative
    // filesystem paths are never written into a governed locator.
    if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(value)) {
      return { url: value, fingerprint: sha256(value), portability: 'portable' };
    }
    return { url: null, fingerprint: sha256(value), portability: 'machine-local' };
  }
}

export function returnLocatorPath(root, config, workId) {
  return path.join(workDir(root, config, workId), 'context', 'return-locator.json');
}

/** Write the small non-secret locator that lets another clone identify durable Story refs. */
export async function writeReturnLocator(root, config, workflow) {
  const remote = config.git?.remote ?? 'origin';
  const result = run('git', ['remote', 'get-url', remote], { cwd: root, allowFailure: true });
  const projected = remoteProjection(result.status === 0 ? result.stdout.trim() : null);
  const repositoryId = workflow.resolution?.capability?.repositoryId ?? path.basename(root);
  let repositories = [{ id: repositoryId, remote, required: true, ...projected }];
  const context = await workspaceMemberContextForRepository(
    root, activeWorkspaceFile(process.env), workspaceRegistryFile(process.env), { strict: true }
  );
  if (context?.workspacePath) {
    const workspace = context.workspace;
    if (!workspace) {
      throw new SingularityFlowError(
        'The Story return locator cannot read an unbound workspace manifest snapshot.',
        { code: 'ACTIVE_WORKSPACE_UNAVAILABLE' }
      );
    }
    repositories = Object.entries(workspace.repositories ?? {}).map(([id, repository]) => ({
      id,
      remote: id === context.repositoryId ? remote : 'origin',
      required: repository.required !== false,
      ...remoteProjection(repository.url)
    })).sort((left, right) => left.id.localeCompare(right.id));
  }
  const body = {
    schemaVersion: currentSchemaVersion('return-locator'),
    kind: 'return-locator',
    workId: workflow.workItem.id,
    capabilityId: workflow.resolution?.capability?.id ?? null,
    originRepositoryId: repositoryId,
    repositories,
    lifecycleRef: `refs/heads/${workflow.lineage?.canonicalBranch ?? workflow.workItem.branch}`,
    workBranchRef: `refs/heads/${workflow.workItem.branch}`,
    configuration: {
      sha256: workflow.resolution?.configSha256 ?? null,
      branch: workflow.resolution?.configurationSource?.branch ?? null,
      commit: workflow.resolution?.configurationSource?.commit ?? null
    },
    cloneStrategy: 'existing-or-clone'
  };
  const locator = { ...body, integritySha256: sha256(body) };
  const file = returnLocatorPath(root, config, workflow.workItem.id);
  await writeJson(file, locator);
  return { locator, path: posix(path.relative(root, file)) };
}

/** Read and hash-check a locator after fetch/clone without consulting machine-local state. */
export async function readReturnLocator(root, config, workId) {
  const file = returnLocatorPath(root, config, workId);
  const locator = readRecord('return-locator', await readJson(file)).record;
  verifyReturnLocator(locator, workId);
  return { locator, path: posix(path.relative(root, file)) };
}

function verifyReturnLocator(locator, workId) {
  const { integritySha256, ...body } = locator;
  if (locator.kind !== 'return-locator') {
    throw new SingularityFlowError(`Return locator for '${workId}' has an unsupported schema.`, { code: 'RETURN_LOCATOR_SCHEMA_UNSUPPORTED' });
  }
  if (locator.workId !== workId || !integritySha256 || sha256(body) !== integritySha256) {
    throw new SingularityFlowError(`Return locator for '${workId}' failed its integrity check.`, { code: 'RETURN_LOCATOR_INTEGRITY_INVALID' });
  }
  return locator;
}

/** Read a locator from a fetched lifecycle ref before the checkout is changed. */
export function readReturnLocatorAtRef(root, config, workId, ref) {
  const relative = posix(path.relative(root, returnLocatorPath(root, config, workId)));
  const result = run('git', ['show', `${ref}:${relative}`], { cwd: root, allowFailure: true });
  if (result.status !== 0) {
    throw new SingularityFlowError(
      `Published Story '${workId}' has no readable return locator on '${ref}'. Fetch a newer Story branch or use singularity-flow resume ${workId} --fetch.`,
      { code: 'RETURN_LOCATOR_UNAVAILABLE' }
    );
  }
  const locator = readRecord('return-locator', result.stdout).record;
  verifyReturnLocator(locator, workId);
  return { locator, path: relative, ref };
}
