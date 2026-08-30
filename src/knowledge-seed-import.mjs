/**
 * Strict, read-only preflight plus import adapter for reviewed knowledge seed manifests.
 *
 * The manifest is only a transport.  It creates no authority of its own: every entry is checked
 * against the existing approved Story/Initiative provenance path before the first record is
 * written, and the existing `recordKnowledge` writer performs that check again when it writes.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import YAML from 'yaml';
import { KNOWLEDGE_TYPES, preflightKnowledgeRecord, recordKnowledge } from './knowledge.mjs';
import { SingularityFlowError, secureRepositoryPath } from './util.mjs';

export const KNOWLEDGE_SEED_MANIFEST_VERSION = 1;
export const KNOWLEDGE_SEED_LIMITS = Object.freeze({
  manifestBytes: 1024 * 1024,
  entries: 256,
  textBytes: 16 * 1024,
  provenancePerEntry: 16,
  scopeValuesPerEntry: 64,
  scalarBytes: 1024
});

const MANIFEST_KEYS = new Set(['schemaVersion', 'entries']);
const ENTRY_KEYS = new Set([
  'type', 'text', 'provenance', 'scope', 'status', 'validFrom', 'validUntil', 'supersedes'
]);
const PROVENANCE_KEYS = new Set(['workId', 'artifact', 'sha256', 'approvedRevision']);
const SCOPE_KEYS = new Set(['capabilities', 'repositories', 'paths', 'environments']);
const STATUS = new Set(['active', 'resolved', 'superseded']);
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DISALLOWED_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

function fail(message) {
  throw new SingularityFlowError(`Invalid knowledge seed manifest: ${message}`, {
    code: 'KNOWLEDGE_SEED_INVALID'
  });
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}

function keys(value, allowed, required, label) {
  object(value, label);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) fail(`${label} has unknown ${unknown.length === 1 ? 'key' : 'keys'}: ${unknown.join(', ')}.`);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) fail(`${label} is missing required ${missing.length === 1 ? 'key' : 'keys'}: ${missing.join(', ')}.`);
}

function string(value, label, maximumBytes = KNOWLEDGE_SEED_LIMITS.scalarBytes) {
  if (typeof value !== 'string') fail(`${label} must be a string.`);
  const clean = value.trim();
  if (!clean) fail(`${label} must not be empty.`);
  if (DISALLOWED_CONTROLS.test(clean)) fail(`${label} contains a disallowed control character.`);
  const bytes = Buffer.byteLength(clean, 'utf8');
  if (bytes > maximumBytes) fail(`${label} exceeds the ${maximumBytes}-byte limit.`);
  return clean;
}

function timestamp(value, label) {
  if (value == null) return null;
  const clean = string(value, label, 64);
  if (!RFC3339.test(clean) || !Number.isFinite(Date.parse(clean))) fail(`${label} must be an RFC 3339 timestamp or null.`);
  return clean;
}

function normalizeProvenance(value, entryLabel) {
  if (!Array.isArray(value) || value.length < 1) fail(`${entryLabel}.provenance must contain at least one item.`);
  if (value.length > KNOWLEDGE_SEED_LIMITS.provenancePerEntry) {
    fail(`${entryLabel}.provenance exceeds the ${KNOWLEDGE_SEED_LIMITS.provenancePerEntry}-item limit.`);
  }
  const seen = new Set();
  return value.map((item, index) => {
    const label = `${entryLabel}.provenance[${index}]`;
    keys(item, PROVENANCE_KEYS, [...PROVENANCE_KEYS], label);
    const approvedRevision = item.approvedRevision;
    if (!Number.isSafeInteger(approvedRevision) || approvedRevision < 0) {
      fail(`${label}.approvedRevision must be a non-negative safe integer.`);
    }
    const result = {
      workId: string(item.workId, `${label}.workId`),
      artifact: string(item.artifact, `${label}.artifact`),
      sha256: string(item.sha256, `${label}.sha256`, 64),
      approvedRevision
    };
    if (!/^[a-f0-9]{64}$/.test(result.sha256)) fail(`${label}.sha256 must be a full lowercase SHA-256.`);
    const identity = `${result.workId}\0${result.artifact}\0${result.sha256}\0${result.approvedRevision}`;
    if (seen.has(identity)) fail(`${label} duplicates an earlier provenance item.`);
    seen.add(identity);
    return result;
  });
}

function normalizeScope(value, entryLabel) {
  const label = `${entryLabel}.scope`;
  keys(value, SCOPE_KEYS, [], label);
  const result = {};
  let total = 0;
  for (const key of SCOPE_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const items = value[key];
    if (!Array.isArray(items) || !items.length) fail(`${label}.${key} must be a non-empty array when present.`);
    const normalized = items.map((item, index) => string(item, `${label}.${key}[${index}]`));
    if (new Set(normalized).size !== normalized.length) fail(`${label}.${key} must not contain duplicates.`);
    total += normalized.length;
    result[key] = normalized;
  }
  if (!total) fail(`${label} must name at least one capability, repository, path, or environment.`);
  if (total > KNOWLEDGE_SEED_LIMITS.scopeValuesPerEntry) {
    fail(`${label} exceeds the ${KNOWLEDGE_SEED_LIMITS.scopeValuesPerEntry}-value limit.`);
  }
  return result;
}

function normalizeEntry(value, index) {
  const label = `entries[${index}]`;
  keys(value, ENTRY_KEYS, ['type', 'text', 'provenance', 'scope', 'status'], label);
  const type = string(value.type, `${label}.type`, 32);
  if (!KNOWLEDGE_TYPES.has(type)) fail(`${label}.type must be one of ${[...KNOWLEDGE_TYPES].join(', ')}.`);
  const status = string(value.status, `${label}.status`, 32);
  if (!STATUS.has(status)) fail(`${label}.status must be active, resolved, or superseded.`);
  const validFrom = timestamp(value.validFrom, `${label}.validFrom`);
  const validUntil = timestamp(value.validUntil, `${label}.validUntil`);
  if (validFrom && validUntil && Date.parse(validUntil) <= Date.parse(validFrom)) {
    fail(`${label}.validUntil must be later than validFrom.`);
  }
  let supersedes = null;
  if (value.supersedes != null) {
    supersedes = string(value.supersedes, `${label}.supersedes`, 64);
    if (!/^[a-f0-9]{64}$/.test(supersedes)) fail(`${label}.supersedes must be a full lowercase record SHA-256 or null.`);
  }
  return {
    type,
    text: string(value.text, `${label}.text`, KNOWLEDGE_SEED_LIMITS.textBytes),
    provenance: normalizeProvenance(value.provenance, label),
    scope: normalizeScope(value.scope, label),
    status,
    validFrom,
    validUntil,
    supersedes
  };
}

function parseManifest(bytes, relative, extension) {
  if (bytes.length > KNOWLEDGE_SEED_LIMITS.manifestBytes) {
    fail(`the file exceeds the ${KNOWLEDGE_SEED_LIMITS.manifestBytes}-byte limit.`);
  }
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('the file must contain valid UTF-8.'); }
  if (extension === '.json') {
    try { JSON.parse(source); }
    catch (error) { fail(`${relative} could not be parsed as JSON: ${error.message}`); }
  }
  let document;
  try {
    document = YAML.parseDocument(source, { prettyErrors: false, strict: true, uniqueKeys: true });
  } catch (error) {
    fail(`${relative} could not be parsed: ${error.message}`);
  }
  if (document.errors.length) fail(`${relative} could not be parsed: ${document.errors[0].message}`);
  let manifest;
  try { manifest = document.toJS({ maxAliasCount: 0 }); }
  catch (error) { fail(`${relative} could not be parsed: ${error.message}`); }
  keys(manifest, MANIFEST_KEYS, ['schemaVersion', 'entries'], 'root');
  const manifestVersion = manifest.schemaVersion;
  if (manifestVersion !== KNOWLEDGE_SEED_MANIFEST_VERSION) {
    fail(`root.schemaVersion must be ${KNOWLEDGE_SEED_MANIFEST_VERSION}.`);
  }
  if (!Array.isArray(manifest.entries) || !manifest.entries.length) fail('root.entries must contain at least one entry.');
  if (manifest.entries.length > KNOWLEDGE_SEED_LIMITS.entries) {
    fail(`root.entries exceeds the ${KNOWLEDGE_SEED_LIMITS.entries}-entry limit.`);
  }
  return { schemaVersion: manifestVersion, entries: manifest.entries.map(normalizeEntry) };
}

/** Read, strictly validate, fully provenance-preflight, and optionally import one seed manifest. */
export async function importKnowledgeSeedManifest(root, manifestPath, { dryRun = false } = {}) {
  if (typeof manifestPath !== 'string' || !manifestPath.trim()) fail('a repository-relative manifest path is required.');
  if (path.isAbsolute(manifestPath) || /^(?:[a-z]:[\\/]|\\\\)/i.test(manifestPath)) {
    fail('the manifest path must be repository-relative.');
  }
  const extension = path.extname(manifestPath).toLowerCase();
  if (!['.json', '.yaml', '.yml'].includes(extension)) fail('the manifest path must end in .json, .yaml, or .yml.');
  const target = await secureRepositoryPath(root, manifestPath, {
    label: 'Knowledge seed manifest', mustExist: true, type: 'file'
  });
  if (target.entry.size > KNOWLEDGE_SEED_LIMITS.manifestBytes) {
    fail(`the file exceeds the ${KNOWLEDGE_SEED_LIMITS.manifestBytes}-byte limit.`);
  }
  const bytes = await readFile(target.absolute);
  const manifest = parseManifest(bytes, target.relative, extension);

  // This loop completes for every entry before the write loop begins.  The helper always invokes
  // the existing approved-provenance verifier and offers no transport-based bypass.
  const plans = [];
  const seen = new Set();
  for (const entry of manifest.entries) {
    const plan = await preflightKnowledgeRecord(root, entry);
    if (seen.has(plan.sha256)) fail(`entries contain duplicate claim ${plan.sha256}.`);
    seen.add(plan.sha256);
    plans.push(plan);
  }

  const base = {
    schemaVersion: KNOWLEDGE_SEED_MANIFEST_VERSION,
    manifest: {
      path: target.relative,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length
    },
    validated: plans.length,
    dryRun: Boolean(dryRun)
  };
  if (dryRun) {
    return {
      ...base,
      created: 0,
      skipped: plans.filter((plan) => !plan.created).length,
      wouldCreate: plans.filter((plan) => plan.created).length,
      records: plans.map(({ sha256, path: recordPath, created }) => ({ sha256, path: recordPath, wouldCreate: created }))
    };
  }

  const records = [];
  for (const plan of plans) {
    // Do not pass approvedSourceVerified here.  The writer reuses the same verifier at the actual
    // mutation boundary, rather than treating completion of manifest parsing as approval.
    records.push(await recordKnowledge(root, plan.input));
  }
  return {
    ...base,
    created: records.filter((record) => record.created).length,
    skipped: records.filter((record) => !record.created).length,
    wouldCreate: 0,
    records: records.map(({ sha256, path: recordPath, created }) => ({ sha256, path: recordPath, created }))
  };
}
