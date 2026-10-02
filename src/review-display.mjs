import { createHash } from 'node:crypto';
import path from 'node:path';

/** Detect a document changing between catalog enumeration and the verified read, including binaries. */
export function phaseDocumentVersionMatches(record, viewed) {
  return Boolean(record.sha256 && record.sha256 === viewed.verifiedSha256
    && Number.isSafeInteger(record.size) && record.size === viewed.size);
}

/**
 * Content identity for reusing a complete visible document display in the same conversation.
 * Unlike reviewBinding, this intentionally survives submission's HEAD/packet change. It is not
 * evidence that a person saw the content, an approval receipt, or permission to reuse consent.
 * Callers supply documents only after the normal document reader has verified their source bytes.
 */
export function phaseDisplayBinding(root, workId, phase, documents) {
  if (!root || !workId || !phase?.id || !Number.isSafeInteger(phase.generation)
      || phase.generation < 1 || !Array.isArray(documents) || !documents.length) return null;
  const identities = [];
  const ids = new Set();
  const paths = new Set();
  for (const document of documents) {
    const digest = typeof document.sha256 === 'string'
      ? /^(?:sha256:)?([a-f0-9]{64})$/u.exec(document.sha256)?.[1] : null;
    if (document.error || document.truncated !== false || !digest
        || typeof document.id !== 'string' || !document.id
        || typeof document.kind !== 'string' || !document.kind
        || typeof document.path !== 'string' || !document.path
        || typeof document.binary !== 'boolean'
        || !Number.isSafeInteger(document.size) || document.size < 0
        || document.generation !== phase.generation
        || ids.has(document.id) || paths.has(document.path)) return null;
    // The source-code display may contain a bounded preview alongside complete text. Only the
    // complete representation is reusable; matching metadata cannot make a preview complete.
    if (!document.binary) {
      const content = document.content ?? document.display?.full;
      if (typeof content !== 'string') return null;
      const bytes = Buffer.from(content, 'utf8');
      if (bytes.length !== document.size
          || createHash('sha256').update(bytes).digest('hex') !== digest) return null;
    }
    ids.add(document.id);
    paths.add(document.path);
    identities.push({
      id: document.id, kind: document.kind, path: document.path, size: document.size,
      sha256: digest, generation: document.generation, binary: document.binary
    });
  }
  identities.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return {
    schemaVersion: 1, repositoryPath: path.resolve(root), workId,
    phase: phase.id, generation: phase.generation, documents: identities
  };
}
