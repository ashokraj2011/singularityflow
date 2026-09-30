/**
 * Names and phase scope for Story supporting documents.
 *
 * Pure: no filesystem, Git or session access. The catalog writer, the CLI, Story start and every
 * reader share these rules, so the name accepted at upload is the name every later lookup, prompt
 * and citation resolves, and a document offered to a phase is offered the same way everywhere.
 */
import { SingularityFlowError } from './util.mjs';

export const DOCUMENT_NAME_MAXIMUM_LENGTH = 120;
/** Package members are named "<package name>/<relative path>", which can be longer. */
export const DOCUMENT_MEMBER_NAME_MAXIMUM_LENGTH = 512;

const ID_SHAPED = /^(?:DOC|PKG)-\d+$/iu;
const CONTROL = /[\u0000-\u001f\u007f]/u;

function fail(message, code) {
  throw new SingularityFlowError(message, { code });
}

function collapsed(value) {
  return String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** The key two names are compared by: Unicode-normalized, case-folded and single-spaced. */
export function documentNameKey(name) {
  return collapsed(name).toLowerCase();
}

/**
 * A new document name, trimmed and single-spaced. Refuses an empty name, control characters, a
 * name longer than 120 characters, and a name shaped like a document ID, which lookups would
 * always resolve to the ID instead.
 */
export function validateDocumentName(value, { maximumLength = DOCUMENT_NAME_MAXIMUM_LENGTH } = {}) {
  const name = collapsed(value);
  if (!name) fail('Give the document a name, for example --name "Payment API contract".', 'DOCUMENT_NAME_REQUIRED');
  if (CONTROL.test(name)) fail(`Document name '${name.replace(CONTROL, '?')}' contains a control character.`, 'DOCUMENT_NAME_INVALID');
  if (name.length > maximumLength) fail(`Document name '${name.slice(0, 40)}…' is longer than ${maximumLength} characters.`, 'DOCUMENT_NAME_INVALID');
  if (ID_SHAPED.test(name)) fail(`Document name '${name}' looks like a document ID. Use a descriptive name.`, 'DOCUMENT_NAME_INVALID');
  return name;
}

/**
 * One validated name per top-level input, in order: each file or folder, then the URL.
 *
 * `label` is the earlier spelling and is accepted for a single input only, so an existing script
 * that labelled one document keeps working; anything unnamed is refused before any byte is read.
 */
export function assignDocumentNames(inputCount, { names = [], label = null } = {}) {
  const given = (names ?? []).filter((value) => value != null);
  if (!given.length && label != null && String(label).trim() && inputCount === 1) given.push(label);
  if (given.length !== inputCount) {
    fail(inputCount === 1
      ? 'Give the document a name with --name "…"; every Story document needs one.'
      : `Give each of the ${inputCount} documents its own name: repeat --name once per file, folder or URL, in the same order (${given.length} given).`,
    'DOCUMENT_NAME_REQUIRED');
  }
  return given.map((value) => validateDocumentName(value));
}

/**
 * Refuse a name any catalog record already uses — detached records included, so a name cited in
 * an approved artifact never silently points at a replacement — or one repeated among the new ones.
 */
export function assertAvailableDocumentNames(records, names) {
  const taken = new Map();
  for (const record of records ?? []) if (record?.name != null) taken.set(documentNameKey(record.name), record);
  const seen = new Set();
  for (const name of names) {
    const key = documentNameKey(name);
    const existing = taken.get(key);
    if (existing) {
      fail(`Document name '${name}' is already used by ${existing.id}${existing.status === 'detached' ? ' (detached)' : ''}. `
        + `Choose another name, for example '${name} (v2)'.`, 'DOCUMENT_NAME_TAKEN');
    }
    if (seen.has(key)) fail(`Document name '${name}' is given twice. Every document in a Story needs its own name.`, 'DOCUMENT_NAME_TAKEN');
    seen.add(key);
  }
}

function basename(value) {
  return String(value ?? '').split('/').filter(Boolean).at(-1) ?? '';
}

/**
 * The record a reference names. An exact ID or alias wins; then an exact document name, preferring
 * an active record over a detached one; then a repository path or file name. More than one match
 * at the first level that matches anything is refused rather than guessed.
 */
export function resolveDocumentRecord(records, reference) {
  const needle = String(reference ?? '').trim();
  const lower = needle.toLowerCase();
  const pick = (matches, how) => {
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      fail(`Document reference '${needle}' matches ${matches.length} documents by ${how}: ${matches.map((record) => record.id).join(', ')}. Use its document ID.`,
        'DOCUMENT_REFERENCE_AMBIGUOUS');
    }
    return null;
  };
  const byId = pick((records ?? []).filter((record) => record.id?.toLowerCase() === lower
    || (record.aliases ?? []).some((alias) => String(alias).toLowerCase() === lower)), 'ID');
  if (byId) return byId;
  const key = documentNameKey(needle);
  const named = (records ?? []).filter((record) => record.name != null && documentNameKey(record.name) === key);
  const active = named.filter((record) => record.status !== 'detached');
  const byName = pick(active.length ? active : named, 'name');
  if (byName) return byName;
  const byPath = pick((records ?? []).filter((record) => record.path
    && (record.path.toLowerCase() === lower || basename(record.path).toLowerCase() === lower)), 'path');
  if (byPath) return byPath;
  fail(`Document '${needle}' was not found. Run singularity-flow documents list.`, 'DOCUMENT_NOT_FOUND');
}

/** The Story phases a new document is offered to by default: the current phase and every later one. */
export function defaultDocumentPhases(workflow, fromPhase = workflow?.currentPhase) {
  const order = workflow?.phaseOrder ?? [];
  return order.slice(Math.max(0, order.indexOf(fromPhase)));
}

/**
 * The phases a document is offered to, in phase order: a non-empty subset of the Story's phases,
 * `all`, or — when nothing is given — the current phase onward. An upload later in a Story never
 * silently becomes evidence for an earlier, approved phase; that takes an explicit, recorded scope.
 */
export function normalizeDocumentPhases(value, workflow, { fromPhase = workflow?.currentPhase } = {}) {
  const order = workflow?.phaseOrder ?? [];
  const requested = (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map((item) => String(item).trim()).filter(Boolean);
  if (!requested.length) return defaultDocumentPhases(workflow, fromPhase);
  if (requested.some((item) => item.toLowerCase() === 'all')) return [...order];
  const unknown = requested.filter((phaseId) => !order.includes(phaseId));
  if (unknown.length) {
    fail(`This Story has no phase ${unknown.map((phaseId) => `'${phaseId}'`).join(', ')}. Choose from ${order.join(', ')}, or all.`,
      'DOCUMENT_PHASES_INVALID');
  }
  const selected = new Set(requested);
  return order.filter((phaseId) => selected.has(phaseId));
}

/** Whether a document is offered to a phase. Records from before phase scope (`phases` absent or null) are offered to every phase. */
export function documentOfferedToPhase(record, phaseId) {
  return !Array.isArray(record?.phases) || record.phases.includes(phaseId);
}
