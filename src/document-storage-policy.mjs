export { DOCUMENT_STORAGE_KINDS, documentStorageChoices, resolveDocumentStorage, assertDocumentStoragePolicy } from './kernel/configuration-policy.mjs';
/**
 * Which storage a Story document may use. Pure, so the workflow definition loader can validate a
 * policy without depending on the machine-local store in src/document-storage.mjs.
 */
