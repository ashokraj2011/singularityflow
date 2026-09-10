import { createHash } from 'node:crypto';
import { lstat, open, stat } from 'node:fs/promises';
import path from 'node:path';

import { assertCredentialFreeRemote } from '../git-remote-diagnostics.mjs';
import { readRecord } from '../schema-migrations.mjs';
import { leadRegistryFile } from '../lead-repositories.mjs';
import { organisationCacheFile } from '../organisation.mjs';
import { workspaceRegistryFile } from '../workspace-context.mjs';
import { RDS_DEFAULTS } from './constants.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sourceRef(kind, digest) {
  return `rdssrc_${kind}_${sha256(`${kind}\0${digest}`).slice(0, 24)}`;
}

function repositoryRef(remote) {
  return `rdsr_local_${sha256(remote).slice(0, 24)}`;
}

function displayFromRemote(remote) {
  const value = String(remote);
  try {
    const parsed = new URL(value);
    const pathname = decodeURIComponent(parsed.pathname).replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    return pathname || parsed.hostname;
  } catch {
    const match = /^(?:[^@\s]+@)?[^:\s]+:(.+)$/u.exec(value);
    return (match?.[1] ?? path.basename(value)).replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  }
}

function safeRemote(value) {
  try { return assertCredentialFreeRemote(value); } catch { return null; }
}

function sourceSummary(kind, availability, overrides = {}) {
  return {
    sourceRef: overrides.sourceRef ?? sourceRef(kind, availability),
    sourceKind: kind,
    sourceAvailability: availability,
    enumeration: availability === 'available' || availability === 'absent' ? 'exhausted' : 'failed',
    consistency: 'captured_local_inputs',
    freshness: { origin: 'local-capture', viewerChecked: false, observedAt: overrides.observedAt ?? null },
    acceptedRecords: overrides.acceptedRecords ?? 0,
    omittedRecords: overrides.omittedRecords ?? 0,
    reasons: overrides.reasons ?? []
  };
}

async function boundedFile(file, budget, { optional = false } = {}) {
  const before = await lstat(file).catch((error) => {
    if (error?.code === 'ENOENT' && optional) return null;
    throw error;
  });
  if (!before) return { state: 'absent', bytes: null, digest: null, observedAt: null };
  if (before.isSymbolicLink() || !before.isFile()) {
    const error = new Error('Registered local catalog source is not a regular non-symlink file.');
    error.code = 'REPOSITORY_CATALOG_SOURCE_INVALID';
    throw error;
  }
  if (before.size > RDS_DEFAULTS.maximumLocalFileBytes
      || budget.bytes + before.size > RDS_DEFAULTS.maximumLocalBytes
      || budget.files + 1 > RDS_DEFAULTS.maximumLocalFiles) {
    const error = new Error('Registered local catalog source exceeds the reviewed capture budget.');
    error.code = 'REPOSITORY_CATALOG_LIMIT_REACHED';
    throw error;
  }
  const handle = await open(file, 'r');
  let bytes;
  try { bytes = await handle.readFile(); } finally { await handle.close(); }
  const after = await stat(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs) {
    const error = new Error('Registered local catalog source changed during capture.');
    error.code = 'REPOSITORY_CATALOG_SOURCE_INVALID';
    throw error;
  }
  budget.bytes += bytes.byteLength;
  budget.files += 1;
  return {
    state: 'available', bytes,
    digest: sha256(bytes),
    observedAt: new Date(before.mtimeMs).toISOString()
  };
}

function parseJson(snapshot, family, { legacyArray = false } = {}) {
  let parsed;
  try { parsed = JSON.parse(snapshot.bytes.toString('utf8')); }
  catch {
    const error = new Error('Registered local catalog source contains invalid JSON.');
    error.code = 'REPOSITORY_CATALOG_SOURCE_INVALID';
    throw error;
  }
  if (legacyArray && Array.isArray(parsed)) return parsed;
  try { return readRecord(family, parsed).record; }
  catch {
    const error = new Error('Registered local catalog source uses an unsupported or invalid schema.');
    error.code = 'REPOSITORY_CATALOG_SOURCE_INVALID';
    throw error;
  }
}

function association(kind, source, fields = {}) {
  return { kind, sourceRef: source, verificationBasis: 'captured-local-record', ...fields };
}

function addObservation(map, remote, source, associationFact) {
  const normalized = safeRemote(remote);
  if (!normalized) return false;
  let current = map.get(normalized);
  if (!current) {
    current = {
      recordRef: repositoryRef(normalized),
      recordRevision: `sha256:${sha256(normalized)}`,
      repositoryIdentity: { type: 'validated-local-remote', remoteSha256: `sha256:${sha256(normalized)}` },
      display: { nameWithOwner: displayFromRemote(normalized) },
      locators: { https: /^https:\/\//i.test(normalized) ? normalized : null, ssh: /^(?:ssh:\/\/|[^@\s]+@[^:\s]+:)/i.test(normalized) ? normalized : null, web: null },
      providerFacts: null,
      knownAssociations: [],
      inspection: 'required',
      limitations: [],
      conflicts: [],
      sourceRefs: []
    };
    map.set(normalized, current);
  }
  if (!current.sourceRefs.includes(source)) current.sourceRefs.push(source);
  if (!current.knownAssociations.some((item) => JSON.stringify(item) === JSON.stringify(associationFact))) {
    current.knownAssociations.push(associationFact);
  }
  current.knownAssociations.sort((a, b) => `${a.kind}:${a.sourceRef}`.localeCompare(`${b.kind}:${b.sourceRef}`));
  return true;
}

function workspaceValues(record) {
  if (Array.isArray(record)) return record;
  return Array.isArray(record?.workspaces) ? record.workspaces : null;
}

async function captureWorkspaceSources(map, summaries, budget, registryPath) {
  let snapshot;
  try { snapshot = await boundedFile(registryPath, budget, { optional: true }); }
  catch (error) {
    summaries.push(sourceSummary('workspace-registry', 'unavailable', { reasons: [error.code ?? 'REPOSITORY_CATALOG_SOURCE_INVALID'] }));
    return;
  }
  if (snapshot.state === 'absent') {
    summaries.push(sourceSummary('workspace-registry', 'absent'));
    return;
  }
  let entries;
  try { entries = workspaceValues(parseJson(snapshot, 'workspace-registry', { legacyArray: true })); }
  catch (error) {
    summaries.push(sourceSummary('workspace-registry', 'unavailable', {
      sourceRef: sourceRef('workspace-registry', snapshot.digest), observedAt: snapshot.observedAt,
      reasons: [error.code]
    }));
    return;
  }
  if (!entries) {
    summaries.push(sourceSummary('workspace-registry', 'unavailable', {
      sourceRef: sourceRef('workspace-registry', snapshot.digest), observedAt: snapshot.observedAt,
      reasons: ['REPOSITORY_CATALOG_SOURCE_INVALID']
    }));
    return;
  }
  const registryRef = sourceRef('workspace-registry', snapshot.digest);
  let accepted = 0; let omitted = 0;
  for (const entry of entries.slice(0, RDS_DEFAULTS.maximumLocalFiles - budget.files)) {
    if (!entry || typeof entry.path !== 'string') { omitted += 1; continue; }
    const manifestFile = path.join(path.resolve(entry.path), 'workspace.json');
    let manifestSnapshot;
    try { manifestSnapshot = await boundedFile(manifestFile, budget); }
    catch { omitted += 1; continue; }
    let manifest;
    try { manifest = JSON.parse(manifestSnapshot.bytes.toString('utf8')); }
    catch { omitted += 1; continue; }
    const repositoryEntries = manifest && typeof manifest.repositories === 'object'
      && !Array.isArray(manifest.repositories) ? Object.entries(manifest.repositories) : [];
    const manifestRef = sourceRef('workspace-manifest', manifestSnapshot.digest);
    for (const [id, repository] of repositoryEntries) {
      if (budget.records >= RDS_DEFAULTS.maximumSourceRecords) { omitted += 1; continue; }
      if (addObservation(map, repository?.url, manifestRef, association('workspace', manifestRef, {
        repositoryId: String(id).slice(0, 128),
        workspaceRef: `rdsw_${sha256(`${entry.id ?? ''}\0${snapshot.digest}`).slice(0, 24)}`
      }))) { accepted += 1; budget.records += 1; } else omitted += 1;
    }
  }
  if (entries.length > RDS_DEFAULTS.maximumLocalFiles - 1) omitted += entries.length - (RDS_DEFAULTS.maximumLocalFiles - 1);
  summaries.push(sourceSummary('workspace-registry', 'available', {
    sourceRef: registryRef, observedAt: snapshot.observedAt, acceptedRecords: accepted,
    omittedRecords: omitted, reasons: omitted ? ['LOCAL_SOURCE_RECORDS_OMITTED'] : []
  }));
}

async function captureLeadSources(map, summaries, budget, registryPath) {
  let snapshot;
  try { snapshot = await boundedFile(registryPath, budget, { optional: true }); }
  catch (error) {
    summaries.push(sourceSummary('lead-registry', 'unavailable', { reasons: [error.code ?? 'REPOSITORY_CATALOG_SOURCE_INVALID'] }));
    return;
  }
  if (snapshot.state === 'absent') {
    summaries.push(sourceSummary('lead-registry', 'absent'));
    return;
  }
  let record;
  try { record = parseJson(snapshot, 'capability-lead-registry'); }
  catch (error) {
    summaries.push(sourceSummary('lead-registry', 'unavailable', {
      sourceRef: sourceRef('lead-registry', snapshot.digest), observedAt: snapshot.observedAt,
      reasons: [error.code]
    }));
    return;
  }
  const leads = Array.isArray(record?.leads) ? record.leads : null;
  const registryRef = sourceRef('lead-registry', snapshot.digest);
  if (!leads) {
    summaries.push(sourceSummary('lead-registry', 'unavailable', {
      sourceRef: registryRef, observedAt: snapshot.observedAt,
      reasons: ['REPOSITORY_CATALOG_SOURCE_INVALID']
    }));
    return;
  }
  let accepted = 0; let omitted = 0;
  for (const lead of leads) {
    if (budget.records >= RDS_DEFAULTS.maximumSourceRecords) { omitted += 1; continue; }
    const remote = safeRemote(lead?.url);
    if (!remote) { omitted += 1; continue; }
    if (addObservation(map, remote, registryRef, association('registered-lead', registryRef))) {
      accepted += 1; budget.records += 1;
    }
    const cacheFile = organisationCacheFile(remote);
    let cacheSnapshot;
    try { cacheSnapshot = await boundedFile(cacheFile, budget, { optional: true }); }
    catch { omitted += 1; continue; }
    if (cacheSnapshot.state === 'absent') continue;
    let cached;
    try { cached = parseJson(cacheSnapshot, 'organisation-cache'); }
    catch { omitted += 1; continue; }
    if (safeRemote(cached?.url) !== remote || !cached?.organisation
        || typeof cached.organisation.repositories !== 'object') { omitted += 1; continue; }
    const cacheRef = sourceRef('organisation-cache', cacheSnapshot.digest);
    for (const [repositoryId, repository] of Object.entries(cached.organisation.repositories)) {
      if (budget.records >= RDS_DEFAULTS.maximumSourceRecords) { omitted += 1; continue; }
      const capabilities = Array.isArray(repository?.capabilities)
        ? repository.capabilities.filter((id) => typeof id === 'string').slice(0, 64) : [];
      if (addObservation(map, repository?.url, cacheRef, association('capability-map-observation', cacheRef, {
        repositoryId: String(repositoryId).slice(0, 128), capabilities,
        observedRevision: typeof cached.tipSha === 'string' ? cached.tipSha : null,
        historical: true
      }))) { accepted += 1; budget.records += 1; } else omitted += 1;
    }
  }
  summaries.push(sourceSummary('lead-registry', 'available', {
    sourceRef: registryRef, observedAt: snapshot.observedAt, acceptedRecords: accepted,
    omittedRecords: omitted, reasons: omitted ? ['LOCAL_SOURCE_RECORDS_OMITTED'] : []
  }));
}

/**
 * Capture the exact registered local inputs without workspace cleanup, Git, provider calls,
 * checkout probing, or directory discovery.
 */
export async function captureKnownRepositoryCatalog({
  env = process.env,
  home,
  workspaceFile = workspaceRegistryFile(env, home),
  leadFile = leadRegistryFile()
} = {}) {
  const observations = new Map();
  const sources = [];
  const budget = { bytes: 0, files: 0, records: 0 };
  await captureWorkspaceSources(observations, sources, budget, workspaceFile);
  await captureLeadSources(observations, sources, budget, leadFile);
  const repositories = [...observations.values()]
    .map((entry) => ({ ...entry, sourceRefs: [...entry.sourceRefs].sort() }))
    .sort((left, right) => left.display.nameWithOwner.localeCompare(right.display.nameWithOwner)
      || left.recordRef.localeCompare(right.recordRef));
  const failed = sources.some((source) => source.sourceAvailability === 'unavailable');
  const limited = sources.some((source) => source.omittedRecords > 0);
  return {
    repositories,
    sources,
    enumeration: failed ? 'failed' : limited ? 'limited' : 'exhausted',
    reasons: [
      ...(failed ? ['REPOSITORY_CATALOG_PARTIAL'] : []),
      ...(limited ? ['REPOSITORY_CATALOG_LIMIT_REACHED'] : [])
    ],
    usage: { localBytes: budget.bytes, localFiles: budget.files, sourceRecords: budget.records }
  };
}
