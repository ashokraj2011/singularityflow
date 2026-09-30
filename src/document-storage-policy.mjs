/**
 * Which storage a Story document may use. Pure, so the workflow definition loader can validate a
 * policy without depending on the machine-local store in src/document-storage.mjs.
 */
import { SingularityFlowError } from './util.mjs';

function fail(message, code, details) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

export const DOCUMENT_STORAGE_KINDS = Object.freeze(['git', 'local']);
/** Destinations people ask for that have no implementation yet; refused by name, not as unknown. */
const PLANNED_STORAGE_KINDS = Object.freeze(['onedrive', 'sharepoint', 'jira']);

/**
 * The storage a new document uses: the one asked for, else the policy default, else Git. The
 * policy (`documents.storage: {allowed, default}`) may narrow what a Story accepts.
 */
export function resolveDocumentStorage(requested, policy = {}) {
  const configured = policy?.storage ?? {};
  const kind = String(requested ?? configured.default ?? 'git').trim().toLowerCase();
  if (PLANNED_STORAGE_KINDS.includes(kind)) {
    fail(`Keeping Story documents in ${kind} is not available yet. Use --store git to commit the document, or --store local to keep it on this machine only.`,
      'DOCUMENT_STORAGE_UNSUPPORTED', { storage: kind });
  }
  if (!DOCUMENT_STORAGE_KINDS.includes(kind)) {
    fail(`Unknown document storage '${requested}'. Choose git or local.`, 'DOCUMENT_STORAGE_INVALID', { storage: kind });
  }
  const allowed = Array.isArray(configured.allowed) && configured.allowed.length ? configured.allowed : DOCUMENT_STORAGE_KINDS;
  if (!allowed.includes(kind)) {
    fail(`This Story's document policy does not allow '${kind}' storage. Allowed: ${allowed.join(', ')}.`,
      'DOCUMENT_STORAGE_NOT_ALLOWED', { storage: kind, allowed: [...allowed] });
  }
  return kind;
}

/** Validate `documents.storage` in a workflow definition or work type. */
export function assertDocumentStoragePolicy(storage, label = 'documents.storage') {
  if (storage == null) return;
  if (typeof storage !== 'object' || Array.isArray(storage)) fail(`${label} must be an object with allowed and default.`, 'DOCUMENT_STORAGE_POLICY_INVALID');
  const allowed = storage.allowed ?? DOCUMENT_STORAGE_KINDS;
  if (!Array.isArray(allowed) || !allowed.length || allowed.some((kind) => !DOCUMENT_STORAGE_KINDS.includes(kind))) {
    fail(`${label}.allowed must list one or more of: ${DOCUMENT_STORAGE_KINDS.join(', ')}.`, 'DOCUMENT_STORAGE_POLICY_INVALID');
  }
  if (storage.default != null && !allowed.includes(storage.default)) {
    fail(`${label}.default '${storage.default}' is not one of ${label}.allowed.`, 'DOCUMENT_STORAGE_POLICY_INVALID');
  }
}
