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

/**
 * Jira's imported Epic is already a committed, immutable snapshot. Treat it as a
 * first-class source when no external documents were uploaded so Requirements can
 * cite the Jira data instead of being forced to invent a document.
 */
export function jiraSnapshotSource(initiative) {
  const source = initiative?.initiative?.source;
  if (source?.type !== 'jira') return null;
  const content = JSON.stringify(source, null, 2);
  const digest = sha256(content);
  return {
    sourceId: `SRC-${digest.slice(0, 12).toUpperCase()}`,
    name: `Jira Epic ${source.key ?? initiative.initiative.id} snapshot`,
    provider: 'jira-snapshot',
    version: source.updatedAt ?? source.id ?? null,
    sha256: digest,
    bytes: Buffer.byteLength(content),
    mimeType: 'application/json',
    status: 'pinned',
    content
  };
}

function safeSegment(value, label) {
  const text = String(value ?? '').trim();
  if (!text || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(text)) throw new SingularityFlowError(`${label} must be a portable filename or identifier.`);
  return text;
}

// Storage keys and cache paths must be portable, but a user's file is called what it is called.
// Rejecting "Auth V2 PRD.pdf" outright turned an ordinary filename into an error; the object key is
// normalised instead and the record keeps the original name for display and citation.
function portableFilename(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new SingularityFlowError(`${label} must be a filename.`);
  const normalized = text
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 255);
  if (!normalized || !/^[A-Za-z0-9]/.test(normalized)) throw new SingularityFlowError(`${label} has no portable characters: ${text}`);
  return normalized;
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
  // The only provider that needs nothing outside the repository. Every other adapter reaches a
  // system — Jira, Artifactory, SharePoint, S3 — so a repository with none of them configured could
  // pin a Markdown note and nothing else: a PDF brief, the most ordinary intake document there is,
  // had no path in. Bytes are committed beside the initiative rather than cached under .git, because
  // a pinned source has to verify on somebody else's machine; a cache that only exists locally would
  // make `epic sources verify` pass for the author and fail for the reviewer.
  if (type === 'local') {
    const blobPath = (initiativeId, contentSha, filename) => path.posix.join('sources', 'blobs', contentSha, filename);
    const resolve = async (initiativeId, relative, options = {}) => {
      if (!runtime.root || !runtime.portfolio) {
        throw new SingularityFlowError(`Local storage provider '${providerId}' is only available for initiative sources.`);
      }
      return secureInitiativePath(runtime.root, runtime.portfolio, initiativeId, relative, {
        label: `Local source object for '${initiativeId}'`, ...options
      });
    };
    return {
      async put({ initiativeId, filename, bytes, sha256: contentSha }) {
        const target = await resolve(initiativeId, blobPath(initiativeId, contentSha, filename), { type: 'file' });
        if (!target.exists) {
          await mkdir(path.dirname(target.absolute), { recursive: true });
          await writeAtomic(target.absolute, bytes);
        }
        // Content addressing means re-registering the same bytes is a no-op rather than a duplicate.
        return { objectId: target.relative, url: null, version: contentSha, etag: null, providerMetadata: { local: true } };
      },
      async get(reference, { maxBytes }) {
        const target = await resolve(reference.initiativeId, blobPath(reference.initiativeId, reference.version, path.posix.basename(reference.objectId ?? '')), {
          mustExist: true, type: 'file'
        });
        const bytes = await readFile(target.absolute);
        if (maxBytes != null && bytes.length > maxBytes) {
          throw new SingularityFlowError(`Local source object exceeds the ${maxBytes} bytes limit.`);
        }
        return { bytes, mimeType: reference.mimeType ?? 'application/octet-stream', version: reference.version };
      },
      async head(reference) {
        const target = await resolve(reference.initiativeId, blobPath(reference.initiativeId, reference.version, path.posix.basename(reference.objectId ?? '')), { type: 'file' });
        return { exists: target.exists, version: reference.version, etag: null };
      }
    };
  }
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
  // An object that already lives in the provider — a Jira attachment on the Epic, for example.
  // Pinning it means fetching and hashing what is there, not uploading a copy.
  remoteRef = null,
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
  const adapter = storageAdapter(selectedId, provider, { ...sourceRuntime(runtime, selectedId), root, portfolio });
  let filename, displayName = null, bytes = null, contentSha = null, size = null, remote;
  if (filePath) {
    const absolute = await realpath(path.resolve(filePath));
    const metadata = await lstat(absolute);
    if (!metadata.isFile()) throw new SingularityFlowError('Epic source upload must be a regular file.');
    const info = await snapshot(absolute);
    if (info.size > maxBytes) throw new SingularityFlowError(`Epic source exceeds the configured ${maxBytes} bytes limit.`);
    displayName = path.basename(absolute);
    filename = portableFilename(displayName, 'Epic source filename');
    bytes = await readFile(absolute);
    contentSha = info.sha256;
    size = info.size;
    remote = await adapter.put({ initiativeId, filename, bytes, filePath: absolute, mimeType, sha256: contentSha });
  } else if (url) {
    // A plain URL is only trusted through the https-reference provider. A remoteRef is different:
    // the caller is naming an object the provider already holds, so any provider that can fetch is
    // acceptable — the bytes are still downloaded and hashed before anything is recorded.
    if (provider.type !== 'https-reference' && !remoteRef) {
      throw new SingularityFlowError('URL-only source registration requires an https-reference provider.');
    }
    const fetched = await adapter.get({ url, mimeType, version: remoteRef?.version ?? null }, { maxBytes });
    bytes = fetched.bytes;
    displayName = remoteRef?.filename || path.basename(new URL(url).pathname) || 'source';
    filename = portableFilename(displayName, 'Epic source filename');
    contentSha = sha256(bytes);
    size = bytes.length;
    remote = {
      objectId: remoteRef?.objectId ?? url,
      url,
      version: fetched.version ?? remoteRef?.version ?? contentSha,
      etag: fetched.version ?? null
    };
  } else throw new SingularityFlowError('Epic source registration requires --file or --url.');
  const actor = identity(root);
  const observedAt = nowIso();
  const record = {
    schemaVersion: SOURCE_RECORD_VERSION,
    initiativeId,
    sourceId: `SRC-${contentSha.slice(0, 12).toUpperCase()}`,
    // The name is what a person and a citation see, so it keeps the file's real title; `filename`
    // is the normalised storage key.
    name: label || displayName || filename,
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

/**
 * Governed text is useful for workshop notes and answers to Copilot questions.
 * The Markdown bytes live with the Epic branch and use the same immutable
 * source manifest as uploaded documents.
 */
export async function registerEpicTextSource(root, {
  initiativeId,
  text,
  label = 'Epic notes',
  kind = 'note'
} = {}) {
  const content = String(text ?? '').trim();
  if (!content) throw new SingularityFlowError('Epic text source cannot be empty.');
  if (!['note', 'question-answer'].includes(kind)) throw new SingularityFlowError(`Unsupported Epic text source kind '${kind}'.`);
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const contentSha = sha256(Buffer.from(`${content}\n`, 'utf8'));
  const sourceId = `SRC-${contentSha.slice(0, 12).toUpperCase()}`;
  const filename = `${kind}-${contentSha.slice(0, 12)}.md`;
  const contentTarget = await secureInitiativePath(root, portfolio, initiativeId, `sources/text/${filename}`, {
    label: `Epic '${initiativeId}' governed text`
  });
  await writeText(contentTarget.absolute, `${content}\n`);
  const actor = identity(root);
  const observedAt = nowIso();
  const record = {
    schemaVersion: SOURCE_RECORD_VERSION,
    initiativeId,
    sourceId,
    name: String(label || 'Epic notes').trim(),
    filename,
    provider: 'git',
    providerType: 'git-managed-markdown',
    objectId: contentTarget.relative,
    url: null,
    version: contentSha,
    etag: null,
    sha256: contentSha,
    bytes: Buffer.byteLength(`${content}\n`),
    mimeType: 'text/markdown',
    uploadedAt: observedAt,
    uploadedBy: actor,
    status: 'pinned'
  };
  const recordHash = sourceRecordHash(record);
  const recordPath = await secureInitiativePath(root, portfolio, initiativeId, `sources/records/${recordHash}.json`, {
    label: `Epic '${initiativeId}' text source record`
  });
  await writeJson(recordPath.absolute, record);
  const manifest = await readSourceManifest(root, portfolio, initiativeId);
  manifest.sources = manifest.sources.filter((entry) => entry.sourceId !== sourceId);
  manifest.sources.push({
    sourceId,
    recordSha256: recordHash,
    recordPath: recordPath.relative,
    name: record.name,
    provider: 'git',
    sha256: contentSha,
    bytes: record.bytes,
    mimeType: record.mimeType,
    status: 'pinned'
  });
  manifest.sources.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const manifestPath = await sourceManifestPath(root, portfolio, initiativeId);
  await writeText(manifestPath.absolute, YAML.stringify(manifest));
  initiative.sources ??= { records: 0, verifiedAt: null };
  initiative.sources.records = manifest.sources.length;
  initiative.history.push({
    at: observedAt,
    actor: actor.email?.toLowerCase() ?? actor.name,
    event: 'epic_text_source_registered',
    phase: initiative.currentPhase,
    detail: `${sourceId} ${kind}`
  });
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
    if (record.provider === 'git' && record.providerType === 'git-managed-markdown') {
      try {
        const target = await secureInitiativePath(
          root,
          portfolio,
          initiativeId,
          record.objectId.slice(`${posix(portfolio.initiativeRoot)}/${initiativeId}/`.length),
          { label: `Epic text source '${record.sourceId}'`, mustExist: true, type: 'file' }
        );
        const current = await snapshot(target.absolute);
        results.push({
          sourceId: record.sourceId,
          status: current.sha256 === record.sha256 ? 'verified' : 'hash-mismatch',
          expectedSha256: record.sha256,
          actualSha256: current.sha256,
          version: record.version,
          cachePath: record.objectId,
          record
        });
      } catch (error) {
        results.push({ sourceId: record.sourceId, status: 'unavailable', expectedSha256: record.sha256, error: error.message });
      }
      continue;
    }
    const provider = storage.providers?.[record.provider];
    if (!provider) {
      results.push({ sourceId: record.sourceId, status: 'provider-missing', expectedSha256: record.sha256 });
      continue;
    }
    try {
      const adapter = storageAdapter(record.provider, provider, { ...sourceRuntime(runtime, record.provider), root, portfolio });
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

/**
 * Pin the Jira Epic's own attachments as governed sources.
 *
 * The Epic record already lists them, but a listed attachment is not evidence: requirements may
 * only cite a source that has been fetched and hash-pinned. Doing that by hand for every Epic is
 * the most common reason intake stalls, so it happens at start.
 *
 * Never throws. A failure to pin one attachment must not fail the Epic start — the user can pin it
 * manually, and reporting the failure is more useful than losing the Epic.
 */
export async function pinJiraEpicAttachments(root, initiativeId, {
  attachments = [],
  providerId = null,
  runtime = {},
  maxAttachments = 25
} = {}) {
  const pinned = [];
  const skipped = [];
  const considered = attachments.filter((file) => file?.url && file?.filename);
  if (considered.length > maxAttachments) {
    skipped.push({ filename: `${considered.length - maxAttachments} further attachment(s)`, reason: `only the first ${maxAttachments} are pinned automatically` });
  }
  for (const file of considered.slice(0, maxAttachments)) {
    try {
      const result = await registerEpicSource(root, {
        initiativeId,
        providerId,
        url: file.url,
        label: file.filename,
        mimeType: file.mimeType ?? 'application/octet-stream',
        remoteRef: { objectId: file.id ?? file.url, filename: file.filename, version: file.id ?? null },
        runtime
      });
      pinned.push({ filename: file.filename, sourceId: result.record?.sourceId ?? null, sha256: result.record?.sha256 ?? null });
    } catch (error) {
      skipped.push({ filename: file.filename, reason: error?.message ?? String(error) });
    }
  }
  return { pinned, skipped };
}
