/**
 * The sources of the Epic a Story was released from, as that Story can import them.
 *
 * Releasing a Story copies the Epic's approved artifacts into its seed, not the Epic's sources: the
 * brief, the research, the designs. In the Epic's lead repository the Story branch descends from the
 * Epic branch, so those sources are in the Story's history at the commit it was cut from. Everything
 * here is read at that pinned base commit with exact Git object reads, never from the working tree
 * (a merge or an edit must not change what "the Epic's source" means), and every source is checked
 * against its record and the hash the Epic manifest pins before it is offered. Importing one copies
 * its bytes into the Story as an ordinary document, through the same guarded path as any fetch.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { epicSourceIsActive, sourceRuntime, storageAdapter } from './epic-sources.mjs';
import { exactFileAtObject, isAncestor } from './git.mjs';
import { loadPortfolio } from './initiative-config.mjs';
import { initiativeRelative } from './initiative-state.mjs';
import { workDir } from './state-stores.mjs';
import { SingularityFlowError, snapshot } from './util.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const STATE_LIMIT = 16 * 1024 * 1024;
const MANIFEST_LIMIT = 4 * 1024 * 1024;
const RECORD_LIMIT = 1024 * 1024;

/** The Story's source.json, only while it matches the hash pinned when the Story started. */
export async function pinnedStorySource(root, config, workflow) {
  const sourcePath = path.join(workDir(root, config, workflow.workItem.id), 'source.json');
  const info = await snapshot(sourcePath);
  if (!info.exists) return null;
  if (workflow.resolution?.sourceSha256 && info.sha256 !== workflow.resolution.sourceSha256) {
    throw new SingularityFlowError('source.json differs from the immutable Story source snapshot.', { code: 'WORK_SOURCE_HASH_MISMATCH' });
  }
  return JSON.parse(await readFile(sourcePath, 'utf8'));
}

function storyBaseCommit(workflow) {
  return workflow.workItem?.baseCommit ?? workflow.phases?.[workflow.phaseOrder?.[0]]?.sourceCommit ?? null;
}

/**
 * `{ epicId, commit, directory, sources, rejected }` for the Epic this Story was released from.
 * `sources` are verified and importable; `rejected` name each active source that failed a check
 * and why. A Story not released from an Epic has `epicId: null` and nothing, unless `required`.
 */
export async function storyEpicSources(root, config, workflow, { required = false } = {}) {
  const none = { epicId: null, commit: null, directory: null, sources: [], rejected: [] };
  const source = await pinnedStorySource(root, config, workflow);
  // Start pins the seed's Epic as the source's epicId; lineage keeps it too (as a Jira key when the
  // Story was fetched from Jira), so either may name the Epic's directory.
  const candidates = [...new Set([source?.epicId, workflow.lineage?.epicId]
    .filter((value) => typeof value === 'string' && value.trim()))];
  if (!candidates.length) {
    if (!required) return none;
    throw new SingularityFlowError(`Story '${workflow.workItem.id}' was not released from an Epic, so it has no Epic sources to import.`,
      { code: 'DOCUMENT_EPIC_SOURCE_REQUIRED' });
  }
  const commit = storyBaseCommit(workflow);
  const unavailable = (detail) => {
    if (!required) return none;
    throw new SingularityFlowError(`${detail} Only a Story released from an Epic into the Epic's lead repository carries its sources; attach the files with documents upload instead.`,
      { code: 'DOCUMENT_EPIC_SOURCES_UNAVAILABLE' });
  };
  if (!commit || !isAncestor(root, commit, 'HEAD')) {
    return unavailable(`The commit Story '${workflow.workItem.id}' was cut from is not in this checkout's history.`);
  }
  const portfolio = await loadPortfolio(root, { required: false }).catch(() => null);
  for (const epicId of candidates) {
    let directory;
    try { directory = initiativeRelative(portfolio ?? {}, epicId); } catch { continue; }
    const state = exactFileAtObject(root, commit, `${directory}/state.json`, { maximumBytes: STATE_LIMIT });
    if (!state) continue;
    const manifestBytes = exactFileAtObject(root, commit, `${directory}/sources/manifest.yml`, { maximumBytes: MANIFEST_LIMIT });
    const manifest = manifestBytes ? YAML.parse(manifestBytes.toString('utf8')) : { version: 1, initiativeId: epicId, sources: [] };
    if (manifest?.version !== 1 || manifest.initiativeId !== epicId || !Array.isArray(manifest.sources)) {
      throw new SingularityFlowError(`Epic '${epicId}' source manifest at ${commit.slice(0, 12)} is invalid.`, { code: 'DOCUMENT_EPIC_SOURCES_INVALID' });
    }
    const sources = []; const rejected = [];
    for (const entry of manifest.sources.filter(epicSourceIsActive)) {
      const checked = checkedEpicSource(root, commit, directory, epicId, entry);
      if (checked.reason) rejected.push({ sourceId: entry?.sourceId ?? null, name: entry?.name ?? null, reason: checked.reason });
      else sources.push(checked.source);
    }
    return { epicId, commit, directory, state, portfolio, sources, rejected };
  }
  return unavailable(`Epic ${candidates.map((id) => `'${id}'`).join(' or ')} is not in this repository at the commit Story '${workflow.workItem.id}' was cut from (${commit.slice(0, 12)}).`);
}

/** One manifest entry, verified against its committed record: `{ source }` or `{ reason }`. */
function checkedEpicSource(root, commit, directory, epicId, entry) {
  const recordPath = entry?.recordPath;
  if (typeof recordPath !== 'string' || !recordPath.startsWith(`${directory}/sources/records/`) || recordPath.split('/').includes('..')) {
    return { reason: 'its record is outside the Epic\'s source records' };
  }
  const bytes = exactFileAtObject(root, commit, recordPath, { maximumBytes: RECORD_LIMIT });
  if (!bytes) return { reason: 'its record is missing at the Story\'s base commit' };
  let record;
  try { record = JSON.parse(bytes.toString('utf8')); } catch { return { reason: 'its record is not valid JSON' }; }
  if (sha256(JSON.stringify(record)) !== entry.recordSha256) return { reason: 'its record does not match the hash the Epic manifest pins' };
  if (record.sourceId !== entry.sourceId || record.sha256 !== entry.sha256 || record.provider !== entry.provider || record.initiativeId !== epicId) {
    return { reason: 'its record and the Epic manifest disagree' };
  }
  if (!SHA256.test(record.sha256 ?? '') || record.sourceId !== `SRC-${record.sha256.slice(0, 12).toUpperCase()}`) {
    return { reason: 'its source ID does not name its bytes' };
  }
  return {
    source: Object.freeze({
      sourceId: record.sourceId, name: record.name ?? record.filename ?? record.sourceId, filename: record.filename ?? null,
      provider: record.provider, providerType: record.providerType ?? null, sha256: record.sha256,
      bytes: Number(record.bytes), mimeType: record.mimeType ?? null, recordSha256: entry.recordSha256, record
    })
  };
}

/** The verified source a reference names, or a refusal that lists what this Story can import. */
export function epicSourceById(epic, reference) {
  const wanted = String(reference ?? '').trim().toUpperCase();
  const found = epic.sources.find((source) => source.sourceId === wanted);
  if (found) return found;
  const rejected = epic.rejected.find((source) => String(source.sourceId ?? '').toUpperCase() === wanted);
  if (rejected) {
    throw new SingularityFlowError(`Epic '${epic.epicId}' source ${rejected.sourceId} cannot be imported: ${rejected.reason}.`,
      { code: 'DOCUMENT_EPIC_SOURCE_UNVERIFIED' });
  }
  const available = epic.sources.map((source) => `${source.sourceId} (${source.name})`).join(', ') || 'none';
  throw new SingularityFlowError(`Epic '${epic.epicId}' has no active source '${reference}'. Its sources: ${available}.`,
    { code: 'DOCUMENT_EPIC_SOURCE_UNKNOWN' });
}

/** The bytes of a verified source, read at the Story's base commit or from its provider, hash-checked. */
export async function readStoryEpicSource(root, epic, source, { maxBytes, runtime = {} } = {}) {
  const label = `Epic '${epic.epicId}' source ${source.sourceId} (${source.name})`;
  if (!Number.isSafeInteger(source.bytes) || source.bytes < 0) throw new SingularityFlowError(`${label} records no valid size.`, { code: 'DOCUMENT_EPIC_SOURCE_UNVERIFIED' });
  if (maxBytes != null && source.bytes > maxBytes) {
    throw new SingularityFlowError(`${label} is ${source.bytes} bytes; a Story document may be at most ${maxBytes}.`, { code: 'DOCUMENT_TOO_LARGE' });
  }
  const { record } = source;
  let bytes;
  if (record.provider === 'git' && record.providerType === 'git-managed-markdown') {
    if (typeof record.objectId !== 'string' || !record.objectId.startsWith(`${epic.directory}/sources/text/`) || record.objectId.split('/').includes('..')) {
      throw new SingularityFlowError(`${label} points outside the Epic's governed text.`, { code: 'DOCUMENT_EPIC_SOURCE_UNVERIFIED' });
    }
    bytes = exactFileAtObject(root, epic.commit, record.objectId, { maximumBytes: source.bytes + 1 });
  } else if (record.providerType === 'local') {
    // The local provider commits bytes beside the Epic, addressed by their own hash.
    if (record.version !== record.sha256) throw new SingularityFlowError(`${label} is not stored under its own hash.`, { code: 'DOCUMENT_EPIC_SOURCE_UNVERIFIED' });
    const blob = `${epic.directory}/sources/blobs/${record.sha256}/${path.posix.basename(String(record.objectId ?? ''))}`;
    bytes = exactFileAtObject(root, epic.commit, blob, { maximumBytes: source.bytes + 1 });
  } else {
    bytes = await fetchFromEpicProvider(root, epic, record, { maxBytes, runtime, label });
  }
  if (!bytes) throw new SingularityFlowError(`${label} has no bytes at the commit the Story was cut from.`, { code: 'DOCUMENT_EPIC_SOURCE_UNVERIFIED' });
  if (bytes.length !== source.bytes || sha256(bytes) !== source.sha256) {
    throw new SingularityFlowError(`${label} does not match the SHA-256 the Epic pins, so it was not imported.`, { code: 'DOCUMENT_EPIC_SOURCE_UNVERIFIED' });
  }
  return bytes;
}

/** A source the Epic keeps in external storage, fetched with the Epic's own provider configuration. */
async function fetchFromEpicProvider(root, epic, record, { maxBytes, runtime, label }) {
  let initiative;
  try { initiative = JSON.parse(epic.state.toString('utf8')); } catch { initiative = null; }
  const storage = initiative?.resolution?.storage ?? epic.portfolio?.storage ?? null;
  const provider = storage?.providers?.[record.provider];
  if (!provider) {
    throw new SingularityFlowError(`${label} is kept by storage provider '${record.provider}', which this repository does not configure.`,
      { code: 'DOCUMENT_EPIC_SOURCE_UNAVAILABLE' });
  }
  const adapter = storageAdapter(record.provider, provider, { ...sourceRuntime(runtime, record.provider), root, portfolio: epic.portfolio });
  // Some adapters write to a path rather than returning bytes; give them one that is removed after.
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-epic-source-'));
  try {
    const fetched = await adapter.get(record, { maxBytes, targetPath: path.join(scratch, 'source') });
    if (fetched?.bytes) return Buffer.from(fetched.bytes);
    return await readFile(fetched?.filePath ?? path.join(scratch, 'source'));
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
