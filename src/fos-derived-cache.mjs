import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { incrementCommandCounter } from './dx-timing-context.mjs';
import { recordSha256 } from './records.mjs';
import { createRepoContext } from './repo-context.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { SingularityFlowError, writeAtomic } from './util.mjs';

export const FOS_CACHE_LIMITS = Object.freeze({
  repositoryBytes: 256 * 1024 * 1024,
  entryBytes: 32 * 1024 * 1024
});

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function keyRecord(key) {
  const dependencyDigests = [
    'configuration', 'parser', 'membership', 'sparse', 'ignore', 'pathResolution'
  ];
  if (!key || typeof key !== 'object' || Array.isArray(key)
      || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(key.producer ?? '')
      || typeof key.producerVersion !== 'string'
      || !Array.isArray(key.inputs)
      || key.inputs.some((input) => !/^sha256:[a-f0-9]{64}$/.test(input))
      || dependencyDigests.some((field) => key[field] != null
        && !/^sha256:[a-f0-9]{64}$/.test(key[field]))) {
    throw new SingularityFlowError(
      'A FOS cache key requires a producer, version and complete SHA-256 input set.', {
        code: 'FOS_CACHE_KEY_INVALID'
      }
    );
  }
  return stable({
    producer: key.producer,
    producerVersion: key.producerVersion,
    inputs: [...key.inputs],
    configuration: key.configuration ?? null,
    parser: key.parser ?? null,
    membership: key.membership ?? null,
    sparse: key.sparse ?? null,
    ignore: key.ignore ?? null,
    pathResolution: key.pathResolution ?? null
  });
}

async function roots(root) {
  const identity = await createRepoContext(root).identity();
  return Object.freeze({
    shared: path.join(identity.commonDir, 'singularity-flow', 'cache', 'fos', 'v1', 'shared'),
    worktree: path.join(identity.gitDir, 'singularity-flow', 'cache', 'fos', 'v1', 'worktree'),
    identity
  });
}

async function refuseSymlinkAncestors(target, boundary) {
  let current = target;
  while (current.startsWith(boundary) && current !== boundary) {
    const info = await lstat(current).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new SingularityFlowError(
      'FOS derived-cache path contains a symbolic link and was refused.', {
        code: 'FOS_CACHE_PATH_INVALID'
      }
    );
    current = path.dirname(current);
  }
}

export async function fosDerivedCachePath(root, key, { scope = 'shared' } = {}) {
  if (!['shared', 'worktree'].includes(scope)) throw new SingularityFlowError(
    `Unknown FOS cache scope '${scope}'.`, { code: 'FOS_CACHE_SCOPE_INVALID' }
  );
  const resolved = await roots(root);
  const normalized = keyRecord(key);
  const keySha256 = hash(JSON.stringify(normalized));
  const directory = resolved[scope];
  const target = path.join(directory, keySha256.slice(0, 2), `${keySha256}.json`);
  await refuseSymlinkAncestors(path.dirname(target), directory);
  return { target, directory, key: normalized, keySha256: `sha256:${keySha256}` };
}

export async function readFosDerivedCache(root, key, options = {}) {
  const located = await fosDerivedCachePath(root, key, options);
  try {
    const raw = await readFile(located.target, 'utf8');
    if (Buffer.byteLength(raw) > FOS_CACHE_LIMITS.entryBytes) return null;
    const record = readRecord('fos-derived-cache-entry', raw).record;
    if (record.kind !== 'fos-derived-cache-entry'
        || record.keySha256 !== located.keySha256
        || record.authoritative !== false
        || record.payloadSha256 !== `sha256:${recordSha256(record.payload)}`) {
      incrementCommandCounter('cache.misses');
      return null;
    }
    incrementCommandCounter('cache.hits');
    return structuredClone(record.payload);
  } catch {
    incrementCommandCounter('cache.misses');
    return null;
  }
}

export async function writeFosDerivedCache(root, key, payload, options = {}) {
  const located = await fosDerivedCachePath(root, key, options);
  const record = {
    schemaVersion: currentSchemaVersion('fos-derived-cache-entry'),
    kind: 'fos-derived-cache-entry',
    keySha256: located.keySha256,
    key: located.key,
    authoritative: false,
    payload,
    payloadSha256: `sha256:${recordSha256(payload)}`
  };
  const bytes = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(bytes) > FOS_CACHE_LIMITS.entryBytes) {
    return { cached: false, reason: 'entry-too-large' };
  }
  try {
    await mkdir(path.dirname(located.target), { recursive: true, mode: 0o700 });
    await writeAtomic(located.target, bytes, { mode: 0o600 });
    const quota = await enforceFosCacheQuota(root);
    return { cached: true, keySha256: located.keySha256, path: located.target, quota };
  } catch (error) {
    // Cache storage is an optimization. A full disk, denied write, or transient cleanup failure
    // cannot change the caller's governed result. Contract violations detected before this block
    // (invalid keys/scopes and escaped/symlinked paths) remain hard refusals.
    incrementCommandCounter('cache.write-failures');
    return {
      cached: false,
      reason: 'cache-unavailable',
      errorCode: typeof error?.code === 'string' ? error.code : 'CACHE_IO_FAILED'
    };
  }
}

async function entryStats(directory) {
  const entries = [];
  for (const prefix of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
    for (const file of await readdir(path.join(directory, prefix.name), { withFileTypes: true }).catch(() => [])) {
      if (!file.isFile() || !/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
      const absolute = path.join(directory, prefix.name, file.name);
      const info = await stat(absolute).catch(() => null);
      if (info) entries.push({ absolute, size: info.size, mtimeMs: info.mtimeMs });
    }
  }
  return entries;
}

export async function enforceFosCacheQuota(root) {
  const resolved = await roots(root);
  const entries = [
    ...await entryStats(resolved.shared),
    ...await entryStats(resolved.worktree)
  ].sort((left, right) => left.mtimeMs - right.mtimeMs);
  let bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  let evicted = 0;
  for (const entry of entries) {
    if (bytes <= FOS_CACHE_LIMITS.repositoryBytes) break;
    await rm(entry.absolute, { force: true });
    incrementCommandCounter('cache.invalidations');
    bytes -= entry.size;
    evicted += 1;
  }
  return { bytes, entries: entries.length - evicted, evicted };
}

export async function clearFosDerivedCache(root) {
  const resolved = await roots(root);
  const targets = [
    {
      boundary: resolved.identity.commonDir,
      target: path.join(resolved.identity.commonDir, 'singularity-flow', 'cache', 'fos', 'v1')
    },
    {
      boundary: resolved.identity.gitDir,
      target: path.join(resolved.identity.gitDir, 'singularity-flow', 'cache', 'fos', 'v1')
    }
  ];
  let removedEntries = 0;
  const unique = new Map(targets.map((entry) => [entry.target, entry]));
  for (const { target, boundary } of unique.values()) {
    const relative = path.relative(boundary, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)
        || relative !== path.join('singularity-flow', 'cache', 'fos', 'v1')) {
      throw new SingularityFlowError('Refused an invalid FOS derived-cache cleanup target.', {
        code: 'FOS_CACHE_PATH_INVALID'
      });
    }
    await refuseSymlinkAncestors(target, boundary);
    removedEntries += (await entryStats(path.join(target, 'shared'))).length;
    removedEntries += (await entryStats(path.join(target, 'worktree'))).length;
    await rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
  }
  if (removedEntries > 0) incrementCommandCounter('cache.invalidations', removedEntries);
  return { status: 'cleared', removedEntries };
}
