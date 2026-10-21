/** Portable, hash-bound read-only grants. Absolute laptop paths never enter Auto contracts. */
import path from 'node:path';
import { SingularityFlowError } from '../util.mjs';

const PREFIX = 'sfdoc:local/';
const REFERENCE = /^sfdoc:local\/(DOC-\d+)\/([a-f0-9]{64})$/u;

export function isLocalDocumentReadScope(value) {
  return String(value).startsWith(PREFIX);
}

export function parseLocalDocumentReadScope(value) {
  const match = REFERENCE.exec(String(value));
  if (!match) throw new SingularityFlowError('Invalid local-document read reference.', {
    code: 'AUTO_DOCUMENT_SCOPE_INVALID'
  });
  return { id: match[1], sha256: match[2] };
}

export function localDocumentReadScope(record) {
  const value = `${PREFIX}${record.id}/${record.sha256}`;
  parseLocalDocumentReadScope(value);
  return value;
}

/** Resolve only this phase's exact originals, immediately before provider invocation. */
export async function materializeAutoDocumentReadScope(root, definition, workflow, phaseId, scope) {
  const references = scope.filter(isLocalDocumentReadScope);
  references.forEach(parseLocalDocumentReadScope);
  const { loadManifest, evidenceIsActive } = await import('../documents-read.mjs');
  const { documentOfferedToPhase } = await import('../document-identity.mjs');
  const { isLocalDocument, readLocalDocument } = await import('../document-storage.mjs');
  const records = (await loadManifest(root, definition, workflow)).documents.filter(record =>
    isLocalDocument(record) && evidenceIsActive(record) && documentOfferedToPhase(record, phaseId));
  const expected = records.map(localDocumentReadScope).sort();
  if (JSON.stringify([...new Set(references)].sort()) !== JSON.stringify(expected)) {
    throw new SingularityFlowError(
      'The local attachments offered to this phase changed after its Auto read scope was pinned. Recompose the phase before authoring.',
      { code: 'AUTO_DOCUMENT_SCOPE_CHANGED' }
    );
  }
  if (!records.length) return { readRoots: [], allowedRoots: [] };
  // Supplies the existing exact-ID restore route for missing/changed originals; do not silently
  // proceed from the text composed earlier or widen the scope to a directory of other documents.
  await (await import('../document-runtime.mjs')).requirePhaseDocuments(root, definition, workflow, phaseId);
  const readRoots = await Promise.all(records.map(async record =>
    (await readLocalDocument(root, workflow.workItem.id, record)).absolutePath));
  return { readRoots, allowedRoots: [...new Set(readRoots.map(file => path.dirname(file)))].sort() };
}
