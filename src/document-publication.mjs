import { createHash } from 'node:crypto';
import path from 'node:path';
import { readLocalGitBlobs } from './git-blob-batch.mjs';
import { recordSha256 } from './records.mjs';
import { readRecord } from './schema-migrations.mjs';
import { SingularityFlowError, posix, run } from './util.mjs';

// Version of the embedded event binding, not a separately persisted schema family.
const DOCUMENT_SET_FORMAT_VERSION = 1;
const GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/u;
const CONTENT_SHA256 = /^[a-f0-9]{64}$/u;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_DOCUMENT_SET_BYTES = 256 * 1024 * 1024;
const TREE_QUERY_BATCH = 512;

function refusal(message, code, details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

function canonicalDocumentRecords(records) {
  if (!Array.isArray(records) || !records.length) {
    refusal('A governed document set must contain at least one document record.', 'DOCUMENT_SET_INVALID');
  }
  const identities = records.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || typeof record.id !== 'string' || !record.id.trim()
        || record.id !== record.id.trim()) {
      refusal('A governed document set contains an invalid document record.', 'DOCUMENT_SET_INVALID');
    }
    return structuredClone(record);
  });
  const ids = identities.map((record) => record.id);
  if (new Set(ids).size !== ids.length) {
    refusal('A governed document set contains duplicate document IDs.', 'DOCUMENT_SET_INVALID');
  }
  // Persisted digests must not depend on a laptop's locale or ICU build.
  return identities.sort((left, right) => Buffer.compare(
    Buffer.from(left.id, 'utf8'), Buffer.from(right.id, 'utf8')
  ));
}

/**
 * Bind the complete finalized manifest records, not merely their allocated IDs.
 *
 * The wrapper version makes the digest vocabulary explicit. Sorting only the set order preserves
 * every record field while avoiding a caller-order dependency; recordSha256 canonicalizes object
 * keys recursively.
 */
export function documentSetSha256(records) {
  return `sha256:${recordSha256({
    schemaVersion: DOCUMENT_SET_FORMAT_VERSION,
    documents: canonicalDocumentRecords(records)
  })}`;
}

export function documentSetLifecycleBinding(records) {
  const canonical = canonicalDocumentRecords(records);
  return {
    documentSetSchemaVersion: DOCUMENT_SET_FORMAT_VERSION,
    documentIds: canonical.map((record) => record.id),
    documentSetSha256: documentSetSha256(canonical)
  };
}

function governedTreePath(value, { label = 'Governed document path' } = {}) {
  const candidate = String(value ?? '');
  if (!candidate || candidate.includes('\0') || candidate.includes('\\')
      || /[\u0000-\u001f\u007f]/u.test(candidate) || path.posix.isAbsolute(candidate)
      || path.posix.normalize(candidate) !== candidate || candidate === '.'
      || candidate.startsWith('../')) {
    refusal(`${label} is not a canonical repository-relative path.`, 'DOCUMENT_SET_PATH_INVALID');
  }
  return candidate;
}

function treeEntries(root, tree, requestedPaths) {
  if (!GIT_OBJECT_ID.test(String(tree ?? ''))) {
    refusal('Document publication did not provide an exact prospective Git tree.', 'DOCUMENT_SET_TREE_INVALID');
  }
  const requested = [...new Set(requestedPaths.map((item) => governedTreePath(item)))];
  const wanted = new Set(requested);
  const entries = new Map();
  const env = { ...process.env, GIT_NO_LAZY_FETCH: '1' };
  for (let offset = 0; offset < requested.length; offset += TREE_QUERY_BATCH) {
    const batch = requested.slice(offset, offset + TREE_QUERY_BATCH);
    const result = run('git', [
      '--literal-pathspecs', 'ls-tree', '-r', '--full-tree', '-z', tree, '--', ...batch
    ], {
      cwd: root,
      env,
      allowFailure: true,
      maxBuffer: Math.max(1024 * 1024, batch.length * 4096)
    });
    if (result.status !== 0) {
      refusal('Git could not inspect the prospective document publication tree.', 'DOCUMENT_SET_TREE_UNREADABLE');
    }
    for (const raw of String(result.stdout ?? '').split('\0').filter(Boolean)) {
      const tab = raw.indexOf('\t');
      const header = tab < 0 ? '' : raw.slice(0, tab);
      const item = tab < 0 ? '' : raw.slice(tab + 1);
      const match = header.match(/^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40,64})$/u);
      if (!match || !wanted.has(item)) continue;
      if (entries.has(item)) {
        refusal(`Prospective Git tree contains an ambiguous document entry for '${item}'.`, 'DOCUMENT_SET_TREE_INVALID');
      }
      entries.set(item, { mode: match[1], type: match[2], oid: match[3] });
    }
  }
  for (const item of requested) {
    if (!entries.has(item)) {
      refusal(`Prospective Git tree is missing governed document path '${item}'.`, 'DOCUMENT_SET_TREE_MISMATCH');
    }
  }
  return entries;
}

function readTreeFiles(root, tree, requestedPaths, {
  maximumBytes,
  maximumObjectBytes,
  label
}) {
  const entries = treeEntries(root, tree, requestedPaths);
  for (const [item, entry] of entries) {
    if (!['100644', '100755'].includes(entry.mode) || entry.type !== 'blob') {
      refusal(
        `Prospective Git tree path '${item}' is not a regular governed file.`,
        'DOCUMENT_SET_TREE_MISMATCH'
      );
    }
  }
  const blobs = readLocalGitBlobs(root, [...entries.values()].map((entry) => entry.oid), {
    maximumBytes,
    maximumObjectBytes,
    code: 'DOCUMENT_SET_TREE_UNREADABLE',
    limitCode: 'DOCUMENT_SET_RESOURCE_LIMIT',
    label
  });
  return new Map([...entries].map(([item, entry]) => [item, blobs.get(entry.oid)]));
}

/**
 * Verify a finalized document event against the immutable tree admitted for its governed commit.
 *
 * A watcher can replace a destination after addDocuments snapshots it but before Git stages the
 * transaction. Re-reading the worktree would race again. This verifier instead reads documents.json
 * and every selected blob from the prospective tree produced by the publication kernel; the later
 * isolated commit is already required to reproduce that exact tree.
 */
export function validateDocumentPublicationTree(root, config, workflow, event, {
  prospectiveTree
} = {}) {
  const ids = event?.payload?.documentIds;
  const expectedDigest = event?.payload?.documentSetSha256;
  const bindingVersion = event?.payload?.documentSetSchemaVersion;
  if (ids == null && expectedDigest == null && bindingVersion == null) {
    return { status: 'not-applicable' };
  }
  if (!Array.isArray(ids) || !ids.length || bindingVersion !== DOCUMENT_SET_FORMAT_VERSION
      || !/^sha256:[a-f0-9]{64}$/u.test(String(expectedDigest ?? ''))) {
    refusal(
      'Document publication is missing its canonical finalized document-set binding.',
      'DOCUMENT_SET_BINDING_MISSING'
    );
  }
  if (ids.some((id) => !String(id ?? '').trim()) || new Set(ids).size !== ids.length) {
    refusal('Document publication contains invalid or duplicate document IDs.', 'DOCUMENT_SET_BINDING_INVALID');
  }

  const itemRoot = posix(path.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id));
  const manifestPath = governedTreePath(path.posix.join(itemRoot, 'documents.json'), {
    label: 'Governed document manifest path'
  });
  const manifestBytes = readTreeFiles(root, prospectiveTree, [manifestPath], {
    maximumBytes: MAX_MANIFEST_BYTES,
    maximumObjectBytes: MAX_MANIFEST_BYTES,
    label: 'Prospective document manifest'
  }).get(manifestPath);
  let manifest;
  try {
    manifest = readRecord('document-manifest', manifestBytes).record;
  } catch (error) {
    refusal(
      `Prospective document manifest is invalid: ${error.message}`,
      'DOCUMENT_SET_MANIFEST_INVALID'
    );
  }
  if (manifest.workId !== workflow.workItem.id || !Array.isArray(manifest.documents)) {
    refusal('Prospective document manifest belongs to a different Story or is malformed.', 'DOCUMENT_SET_MANIFEST_INVALID');
  }
  const selected = [];
  for (const id of ids) {
    const matches = manifest.documents.filter((record) => record?.id === id);
    if (matches.length !== 1) {
      refusal(
        `Prospective document manifest does not contain exactly one record for '${id}'.`,
        'DOCUMENT_SET_MANIFEST_MISMATCH'
      );
    }
    selected.push(matches[0]);
  }
  const actualDigest = documentSetSha256(selected);
  if (actualDigest !== expectedDigest) {
    refusal(
      'Prospective document manifest changed after the lifecycle event finalized its document set.',
      'DOCUMENT_SET_MANIFEST_MISMATCH',
      { expected: expectedDigest, actual: actualDigest }
    );
  }

  const files = [];
  let totalBytes = 0;
  for (const record of selected) {
    if (record.type === 'url') {
      if (!String(record.url ?? '').trim() || record.path != null) {
        refusal(`Document '${record.id}' has an invalid URL record.`, 'DOCUMENT_SET_MANIFEST_INVALID');
      }
      continue;
    }
    if (record.type !== 'file' || !Number.isSafeInteger(record.size) || record.size < 0
        || !CONTENT_SHA256.test(String(record.sha256 ?? ''))) {
      refusal(`Document '${record.id}' has invalid file identity metadata.`, 'DOCUMENT_SET_MANIFEST_INVALID');
    }
    const recordPath = governedTreePath(record.path, { label: `Document '${record.id}' path` });
    if (!recordPath.startsWith(`${itemRoot}/inputs/`)) {
      refusal(`Document '${record.id}' is outside the governed Story input directory.`, 'DOCUMENT_SET_PATH_INVALID');
    }
    totalBytes += record.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_DOCUMENT_SET_BYTES) {
      refusal('Governed document set exceeds its publication verification byte limit.', 'DOCUMENT_SET_RESOURCE_LIMIT');
    }
    files.push({ record, path: recordPath });
  }
  if (files.length) {
    const blobs = readTreeFiles(root, prospectiveTree, files.map((item) => item.path), {
      maximumBytes: MAX_DOCUMENT_SET_BYTES,
      maximumObjectBytes: MAX_DOCUMENT_SET_BYTES,
      label: 'Prospective governed document set'
    });
    for (const item of files) {
      const bytes = blobs.get(item.path);
      const observedSha256 = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== item.record.size || observedSha256 !== item.record.sha256) {
        refusal(
          `Governed document '${item.record.id}' changed after its manifest record was finalized.`,
          'DOCUMENT_SET_BLOB_MISMATCH',
          {
            documentId: item.record.id,
            expectedBytes: item.record.size,
            observedBytes: bytes.length,
            expectedSha256: item.record.sha256,
            observedSha256
          }
        );
      }
    }
  }
  return {
    status: 'verified',
    schemaVersion: bindingVersion,
    documentIds: [...ids],
    documentSetSha256: actualDigest,
    prospectiveTree
  };
}
