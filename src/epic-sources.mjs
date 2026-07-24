import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { identity } from './git.mjs';
import { downloadJiraAttachment, uploadJiraAttachment } from './jira.mjs';
import { loadInitiative, saveInitiative, secureInitiativePath } from './initiative-state.mjs';
import {
  commandExists, nowIso, posix, run, SingularityFlowError, snapshot, writeAtomic, writeJson, writeText
} from './util.mjs';

const SOURCE_RECORD_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 60_000;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeSegment(value, label) {
  const text = String(value ?? '').trim();
  if (!text || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(text)) throw new SingularityFlowError(`${label} must be a portable filename or identifier.`);
  return text;
}

function ensureMime(mimeType, policy, label) {
  const allowed = policy.allowedMimeTypes ?? [];
  if (allowed.length && !allowed.some((entry) => entry === mimeType || (entry.endsWith('/*') && mimeType.startsWith(entry.slice(0, -1))))) {
    throw new SingularityFlowError(`${label} MIME type '${mimeType}' is outside the configured allowlist.`);
  }
}

function maxBytesFor(storage, provider) {
  return provider.maxBytes ?? storage.maxBytes ?? 100 * 1024 * 1024;
}

function httpsUrl(value, label) {
  let parsed;
  try { parsed = new URL(String(value)); } catch { throw new SingularityFlowError(`${label} must be a valid HTTPS URL.`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new SingularityFlowError(`${label} must use HTTPS without embedded credentials.`);
  return parsed;
}

async function fetchBytes(url, {
  fetchImpl = globalThis.fetch,
  headers = {},
  maxBytes,
  method = 'GET',
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method, headers, body, redirect: 'error', signal: controller.signal });
    if (!response.ok) throw new SingularityFlowError(`Storage request failed (${response.status}).`);
    if (method === 'HEAD' || response.status === 204) return { response, bytes: null };
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new SingularityFlowError(`Storage object exceeds the configured ${maxBytes} bytes limit.`);
    let bytes;
    if (response.body?.getReader) {
      const chunks = [];
      const reader = response.body.getReader();
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new SingularityFlowError(`Storage object exceeds the configured ${maxBytes} bytes limit.`);
        }
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks, total);
    } else {
      bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxBytes) throw new SingularityFlowError(`Storage object exceeds the configured ${maxBytes} bytes limit.`);
    }
    return { response, bytes };
  } catch (error) {
    if (controller.signal.aborted) throw new SingularityFlowError(`Storage request timed out after ${timeoutMs} milliseconds.`);
    if (error instanceof SingularityFlowError) throw error;
    throw new SingularityFlowError(`Storage request failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function bearer(runtime, name) {
  const token = runtime?.token ?? runtime?.tokens?.[name] ?? null;
  if (!token) throw new SingularityFlowError(`${name} credentials are unavailable. Configure them in the desktop secure credential store or environment.`);
  return { Authorization: `Bearer ${token}` };
}

export function storageAdapter(providerId, provider, runtime = {}) {
  const type = provider.type;
  if (type === 'jira-attachment') return {
    async put({ initiativeId, filename, bytes, mimeType }) {
      const item = await uploadJiraAttachment(initiativeId, { filename, bytes, mimeType }, {
        connection: runtime.jiraConnection,
        fetchImpl: runtime.fetchImpl
      });
      return { objectId: item.id, url: item.url, version: item.id, etag: null, providerMetadata: item };
    },
    async get(reference, { maxBytes }) {
      return downloadJiraAttachment(reference.url, {
        connection: runtime.jiraConnection,
        fetchImpl: runtime.fetchImpl,
        maxBytes
      });
    },
    async head(reference) {
      return { exists: true, version: reference.version, etag: reference.etag ?? null };
    }
  };
  if (type === 'artifactory') {
    const base = httpsUrl(provider.baseUrl, `Artifactory provider '${providerId}' baseUrl`).toString().replace(/\/$/, '');
    const headers = () => bearer(runtime, providerId);
    return {
      async put({ initiativeId, filename, bytes, sha256: contentSha }) {
        const objectPath = `${provider.repository}/singularity-flow/${encodeURIComponent(initiativeId)}/${contentSha}/${encodeURIComponent(filename)}`;
        const url = `${base}/${objectPath}`;
        await fetchBytes(url, { fetchImpl: runtime.fetchImpl, headers: headers(), method: 'PUT', body: bytes, maxBytes: bytes.length + 1 });
        return { objectId: objectPath, url, version: contentSha, etag: null };
      },
      async get(reference, { maxBytes }) {
        const result = await fetchBytes(httpsUrl(reference.url, 'Artifactory object URL'), { fetchImpl: runtime.fetchImpl, headers: headers(), maxBytes });
        return { bytes: result.bytes, mimeType: result.response.headers?.get?.('content-type')?.split(';')[0] ?? 'application/octet-stream', version: result.response.headers?.get?.('etag') ?? reference.version };
      },
      async head(reference) {
        const result = await fetchBytes(httpsUrl(reference.url, 'Artifactory object URL'), { fetchImpl: runtime.fetchImpl, headers: headers(), method: 'HEAD', maxBytes: 1 });
        return { exists: true, version: result.response.headers?.get?.('etag') ?? reference.version, etag: result.response.headers?.get?.('etag') ?? null };
      }
    };
  }
  if (type === 'sharepoint') {
    const graph = 'https://graph.microsoft.com/v1.0';
    const headers = () => bearer(runtime, providerId);
    return {
      async put({ initiativeId, filename, bytes, sha256: contentSha }) {
        const objectPath = `${initiativeId}/${contentSha}/${filename}`;
        const url = `${graph}/sites/${encodeURIComponent(provider.siteId)}/drives/${encodeURIComponent(provider.driveId)}/root:/${objectPath.split('/').map(encodeURIComponent).join('/')}:/content`;
        const result = await fetchBytes(url, { fetchImpl: runtime.fetchImpl, headers: headers(), method: 'PUT', body: bytes, maxBytes: bytes.length + 1024 });
        const item = JSON.parse(result.bytes.toString('utf8'));
        return { objectId: item.id, url: item['@microsoft.graph.downloadUrl'] ?? item.webUrl, version: item.eTag ?? item.cTag, etag: item.eTag ?? null, providerMetadata: { webUrl: item.webUrl ?? null } };
      },
      async get(reference, { maxBytes }) {
        const url = `${graph}/sites/${encodeURIComponent(provider.siteId)}/drives/${encodeURIComponent(provider.driveId)}/items/${encodeURIComponent(reference.objectId)}/content`;
        const result = await fetchBytes(url, { fetchImpl: runtime.fetchImpl, headers: headers(), maxBytes });
        return { bytes: result.bytes, mimeType: result.response.headers?.get?.('content-type')?.split(';')[0] ?? 'application/octet-stream', version: result.response.headers?.get?.('etag') ?? reference.version };
      },
      async head(reference) {
        const url = `${graph}/sites/${encodeURIComponent(provider.siteId)}/drives/${encodeURIComponent(provider.driveId)}/items/${encodeURIComponent(reference.objectId)}`;
        const result = await fetchBytes(url, { fetchImpl: runtime.fetchImpl, headers: headers(), maxBytes: 1024 * 1024 });
        const item = JSON.parse(result.bytes.toString('utf8'));
        return { exists: true, name: item.name ?? null, mimeType: item.file?.mimeType ?? null, size: item.size ?? null, version: item.eTag ?? item.cTag, etag: item.eTag ?? null };
      },
      async list({ path: subPath = '' } = {}) {
        const base = `${graph}/sites/${encodeURIComponent(provider.siteId)}/drives/${encodeURIComponent(provider.driveId)}`;
        const clean = String(subPath).split('/').filter(Boolean);
        const url = clean.length
          ? `${base}/root:/${clean.map(encodeURIComponent).join('/')}:/children`
          : `${base}/root/children`;
        const result = await fetchBytes(url, { fetchImpl: runtime.fetchImpl, headers: headers(), maxBytes: 8 * 1024 * 1024 });
        const payload = JSON.parse(result.bytes.toString('utf8'));
        return (payload.value ?? []).map((item) => ({
          id: item.id,
          name: item.name,
          size: item.size ?? null,
          mimeType: item.file?.mimeType ?? (item.folder ? 'inode/directory' : 'application/octet-stream'),
          folder: Boolean(item.folder),
          path: clean.length ? `${clean.join('/')}/${item.name}` : item.name
        }));
      }
    };
  }
  if (type === 's3') {
    if (!commandExists('aws')) throw new SingularityFlowError('The S3 storage adapter requires the AWS CLI and a configured AWS credential/SSO profile.');
    const aws = (args, options = {}) => {
      const base = [...args, ...(provider.region ? ['--region', provider.region] : []), ...(provider.profile ? ['--profile', provider.profile] : [])];
      const result = (runtime.runCommand ?? run)('aws', base, { allowFailure: true, ...options });
      if (result.status !== 0) throw new SingularityFlowError(`AWS storage operation failed: ${(result.stderr || result.stdout).trim()}`);
      return result;
    };
    return {
      async put({ initiativeId, filename, filePath, sha256: contentSha }) {
        const key = [provider.prefix, initiativeId, contentSha, filename].filter(Boolean).join('/');
        aws(['s3api', 'put-object', '--bucket', provider.bucket, '--key', key, '--body', filePath]);
        return { objectId: key, url: `s3://${provider.bucket}/${key}`, version: contentSha, etag: null };
      },
      async get(reference, { targetPath }) {
        aws(['s3api', 'get-object', '--bucket', provider.bucket, '--key', reference.objectId, targetPath]);
        return { filePath: targetPath, mimeType: reference.mimeType, version: reference.version };
      },
      async head(reference) {
        const result = aws(['s3api', 'head-object', '--bucket', provider.bucket, '--key', reference.objectId, '--output', 'json']);
        const item = JSON.parse(result.stdout);
        return { exists: true, version: item.VersionId ?? item.ETag ?? reference.version, etag: item.ETag ?? null };
      }
    };
  }
  if (type === 'https-reference') return {
    async put() { throw new SingularityFlowError('HTTPS reference providers do not upload bytes. Register a URL instead.'); },
    async get(reference, { maxBytes }) {
      const result = await fetchBytes(httpsUrl(reference.url, 'Source URL'), { fetchImpl: runtime.fetchImpl, maxBytes });
      return { bytes: result.bytes, mimeType: result.response.headers?.get?.('content-type')?.split(';')[0] ?? reference.mimeType, version: result.response.headers?.get?.('etag') ?? reference.version };
    },
    async head(reference) {
      const result = await fetchBytes(httpsUrl(reference.url, 'Source URL'), { fetchImpl: runtime.fetchImpl, method: 'HEAD', maxBytes: 1 });
      return { exists: true, version: result.response.headers?.get?.('etag') ?? reference.version, etag: result.response.headers?.get?.('etag') ?? null };
    }
  };
  throw new SingularityFlowError(`Unsupported storage provider type '${type}'.`);
}

async function sourceManifestPath(root, portfolio, initiativeId) {
  return secureInitiativePath(root, portfolio, initiativeId, 'sources/manifest.yml', {
    label: `Epic '${initiativeId}' source manifest`
  });
}

async function readSourceManifest(root, portfolio, initiativeId) {
  const target = await sourceManifestPath(root, portfolio, initiativeId);
  if (!target.exists) return { version: 1, initiativeId, sources: [] };
  const parsed = YAML.parse(await readFile(target.absolute, 'utf8'));
  if (parsed?.version !== 1 || parsed?.initiativeId !== initiativeId || !Array.isArray(parsed.sources)) throw new SingularityFlowError(`Epic '${initiativeId}' source manifest is invalid.`);
  return parsed;
}

function sourceRecordHash(record) {
  return sha256(JSON.stringify(record));
}

export function sourceRuntime(runtime, providerId) {
  const envName = `SINGULARITY_FLOW_STORAGE_TOKEN_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return { ...runtime, token: runtime.token ?? process.env[envName] ?? null };
}

export async function registerEpicSource(root, {
  initiativeId,
  providerId = null,
  filePath = null,
  url = null,
  label = null,
  mimeType = 'application/octet-stream',
  runtime = {}
} = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const storage = initiative.resolution.storage ?? portfolio.storage;
  const selectedId = providerId ?? storage.defaultProvider;
  const provider = storage.providers?.[selectedId];
  if (!provider) throw new SingularityFlowError(`Unknown or unavailable Epic source provider '${selectedId ?? ''}'.`);
  const maxBytes = maxBytesFor(storage, provider);
  ensureMime(mimeType, storage, 'Epic source');
  ensureMime(mimeType, provider, `Storage provider '${selectedId}'`);
  const adapter = storageAdapter(selectedId, provider, sourceRuntime(runtime, selectedId));
  let filename, bytes = null, contentSha = null, size = null, remote;
  if (filePath) {
    const absolute = await realpath(path.resolve(filePath));
    const metadata = await lstat(absolute);
    if (!metadata.isFile()) throw new SingularityFlowError('Epic source upload must be a regular file.');
    const info = await snapshot(absolute);
    if (info.size > maxBytes) throw new SingularityFlowError(`Epic source exceeds the configured ${maxBytes} bytes limit.`);
    filename = safeSegment(path.basename(absolute), 'Epic source filename');
    bytes = await readFile(absolute);
    contentSha = info.sha256;
    size = info.size;
    remote = await adapter.put({ initiativeId, filename, bytes, filePath: absolute, mimeType, sha256: contentSha });
  } else if (url) {
    if (provider.type !== 'https-reference') throw new SingularityFlowError('URL-only source registration requires an https-reference provider.');
    const fetched = await adapter.get({ url, mimeType, version: null }, { maxBytes });
    bytes = fetched.bytes;
    filename = safeSegment(path.basename(new URL(url).pathname) || 'source', 'Epic source filename');
    contentSha = sha256(bytes);
    size = bytes.length;
    remote = { objectId: url, url, version: fetched.version ?? contentSha, etag: fetched.version ?? null };
  } else throw new SingularityFlowError('Epic source registration requires --file or --url.');
  const actor = identity(root);
  const observedAt = nowIso();
  const record = {
    schemaVersion: SOURCE_RECORD_VERSION,
    initiativeId,
    sourceId: `SRC-${contentSha.slice(0, 12).toUpperCase()}`,
    name: label || filename,
    filename,
    provider: selectedId,
    providerType: provider.type,
    objectId: remote.objectId,
    url: remote.url ?? null,
    version: remote.version ?? contentSha,
    etag: remote.etag ?? null,
    sha256: contentSha,
    bytes: size,
    mimeType,
    uploadedAt: observedAt,
    uploadedBy: actor,
    status: 'pinned'
  };
  const recordHash = sourceRecordHash(record);
  const recordPath = await secureInitiativePath(root, portfolio, initiativeId, `sources/records/${recordHash}.json`, {
    label: `Epic '${initiativeId}' source record`
  });
  await writeJson(recordPath.absolute, record);
  const manifest = await readSourceManifest(root, portfolio, initiativeId);
  manifest.sources = manifest.sources.filter((entry) => entry.sourceId !== record.sourceId);
  manifest.sources.push({ sourceId: record.sourceId, recordSha256: recordHash, recordPath: recordPath.relative, name: record.name, provider: selectedId, sha256: contentSha, bytes: size, mimeType, status: 'pinned' });
  manifest.sources.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const manifestPath = await sourceManifestPath(root, portfolio, initiativeId);
  await writeText(manifestPath.absolute, YAML.stringify(manifest));
  initiative.sources ??= { records: 0, verifiedAt: null };
  initiative.sources.records = manifest.sources.length;
  initiative.history.push({ at: observedAt, actor: actor.email?.toLowerCase() ?? actor.name, event: 'epic_source_registered', phase: initiative.currentPhase, detail: `${record.sourceId} ${record.sha256.slice(0, 12)}` });
  await saveInitiative(root, portfolio, initiative);
  return { portfolio, initiative, record, recordSha256: recordHash, manifest };
}

export async function listEpicSources(root, initiativeId) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const manifest = await readSourceManifest(root, portfolio, initiativeId);
  return { portfolio, initiative, manifest };
}

export async function verifyEpicSources(root, initiativeId, { runtime = {}, materialize = false } = {}) {
  const { portfolio, initiative, manifest } = await listEpicSources(root, initiativeId);
  const storage = initiative.resolution.storage ?? portfolio.storage;
  const results = [];
  for (const entry of manifest.sources) {
    const base = `${posix(portfolio.initiativeRoot)}/${initiativeId}/`;
    if (!entry.recordPath.startsWith(base)) throw new SingularityFlowError(`Epic source record '${entry.sourceId}' escapes the Epic directory.`);
    const recordTarget = await secureInitiativePath(root, portfolio, initiativeId, entry.recordPath.slice(base.length), {
      label: `Epic source record '${entry.sourceId}'`,
      mustExist: true,
      type: 'file'
    });
    const record = JSON.parse(await readFile(recordTarget.absolute, 'utf8'));
    if (sourceRecordHash(record) !== entry.recordSha256) {
      results.push({
        sourceId: entry.sourceId,
        status: 'record-tampered',
        expectedSha256: entry.sha256,
        error: `Source record hash does not match ${entry.recordSha256}.`
      });
      continue;
    }
    if (record.sourceId !== entry.sourceId || record.sha256 !== entry.sha256 || record.provider !== entry.provider) {
      results.push({
        sourceId: entry.sourceId,
        status: 'record-mismatch',
        expectedSha256: entry.sha256,
        error: 'Source manifest and source record disagree.'
      });
      continue;
    }
    const provider = storage.providers?.[record.provider];
    if (!provider) {
      results.push({ sourceId: record.sourceId, status: 'provider-missing', expectedSha256: record.sha256 });
      continue;
    }
    try {
      const adapter = storageAdapter(record.provider, provider, sourceRuntime(runtime, record.provider));
      const headResult = await adapter.head(record);
      let actualSha256 = null;
      let cachePath = null;
      if (materialize) {
        const cacheRoot = path.join(root, '.git', 'singularity-flow', 'epic-sources', initiativeId, record.sha256);
        await mkdir(cacheRoot, { recursive: true });
        cachePath = path.join(cacheRoot, record.filename);
        const temporary = `${cachePath}.download-${process.pid}-${randomUUID()}`;
        try {
          const fetched = await adapter.get(record, { maxBytes: maxBytesFor(storage, provider), targetPath: temporary });
          if (fetched.bytes) {
            await writeAtomic(cachePath, fetched.bytes);
            actualSha256 = sha256(fetched.bytes);
          } else {
            await rename(temporary, cachePath);
            actualSha256 = (await snapshot(cachePath)).sha256;
          }
          await writeText(`${cachePath}.sha256`, `${actualSha256}  ${record.filename}`);
        } finally {
          await rm(temporary, { force: true }).catch(() => {});
        }
      }
      const changed = actualSha256 != null && actualSha256 !== record.sha256;
      results.push({
        sourceId: record.sourceId,
        status: changed ? 'hash-mismatch' : 'verified',
        expectedSha256: record.sha256,
        actualSha256,
        version: headResult.version ?? record.version,
        cachePath: cachePath ? posix(path.relative(root, cachePath)) : null,
        record
      });
    } catch (error) {
      results.push({ sourceId: record.sourceId, status: 'unavailable', expectedSha256: record.sha256, error: error.message });
    }
  }
  const valid = results.every((entry) => entry.status === 'verified');
  return { initiativeId, valid, results };
}
