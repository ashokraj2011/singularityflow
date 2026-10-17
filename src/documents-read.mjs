/** Canonical governed document reads, independent of upload/detach/remote management. */
import { createHash } from 'node:crypto';
import { incrementCommandCounter } from './dx-timing-context.mjs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { workDir } from './story-paths.mjs';
import { SingularityFlowError, exists, posix, snapshot } from './util.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { documentOfferedToPhase, resolveDocumentRecord } from './document-identity.mjs';
import { agentBriefReviewDocuments } from './agent-briefs.mjs';
import { exactFileAtObject, head } from './git.mjs';
import { SOURCE_TEXT_EXTRACTOR_VERSION, TEXT_SOURCE_EXTENSIONS, documentMimeType as mimeTypeForName, effectiveDocumentMimeType, extractSourceText, hasTextExtractor } from './source-text.mjs';
import { isLocalDocument, localDocumentAvailability, readLocalDocument } from './document-storage.mjs';
import { loadEnvironmentDeclarationSync, matchEnvironmentLocalPath } from './environment-declaration.mjs';

export const DOCUMENT_MANIFEST_SCHEMA_VERSION = currentSchemaVersion('document-manifest');

// One list for prompts and source review, so a format shown to a phase as text can also be cited.
export const TEXT_EXTENSIONS = TEXT_SOURCE_EXTENSIONS;

export function manifestPath(root, config, workflow) { return path.join(workDir(root, config, workflow.workItem.id), 'documents.json'); }

export function mimeType(file) { return mimeTypeForName(file); }

/** The first line of a Git LFS pointer, which a checkout without git-lfs leaves in place of the bytes. */
export const GIT_LFS_POINTER = /^version https:\/\/git-lfs\.[^/\s]+\/spec\/v1\r?\n/u;

/**
 * The committed bytes of a document when this checkout's copy differs from them only by line
 * endings. Any other difference is a changed document, and is still refused.
 */
export function committedDocumentBytes(root, relative, expected, working) {
  let committed = null;
  try { committed = exactFileAtObject(root, head(root), relative, { maximumBytes: (expected.size ?? working.length) + 1 }); }
  catch { return null; }
  if (!committed || createHash('sha256').update(committed).digest('hex') !== expected.sha256) return null;
  const strip = (bytes) => Buffer.from(bytes.filter((byte) => byte !== 0x0d));
  return strip(committed).equals(strip(working)) ? committed : null;
}

export async function loadManifest(root, config, workflow) {
  const file = manifestPath(root, config, workflow);
  const manifest = await exists(file)
    ? readRecord('document-manifest', await readFile(file)).record
    : { schemaVersion: DOCUMENT_MANIFEST_SCHEMA_VERSION, workId: workflow.workItem.id, documents: [], packages: [] };
  manifest.packages ??= [];
  return manifest;
}

export function evidenceIsActive(record) {
  // Detachment is the only catalog status that removes a document from active
  // composition and browsing. Lifecycle artifacts reuse this catalog but carry
  // phase statuses such as `in_progress`, `awaiting_approval`, and `approved`.
  // Treating the evidence vocabulary as an allowlist silently hid every generated
  // phase artifact from editor snapshots while leaving the status-less system
  // documents visible.
  return record?.status !== 'detached';
}

export function documentPolicy(workflow, config) {
  // With no policy, documents go to the Story's first step, whatever it is called.
  return workflow.resolution?.documents ?? config.documents ?? { allowedPhases: [], maxFileBytes: 26214400, maxPreviewBytes: 1048576 };
}

export function environmentLocalRefusal(candidate, match) {
  const rule = match.pattern ?? match.rule ?? match.source ?? 'environment-local';
  const owner = match.environmentId
    ? `environments.${match.environmentId}.localFiles` : 'neverCommit';
  return new SingularityFlowError(
    `Document upload was refused: '${candidate}' matches ${owner} rule '${rule}'. `
      + 'Environment-local files must remain in the machine-local binding and cannot become Story documents.',
    {
      code: 'ENVIRONMENT_LOCAL_CONTENT_REFUSED',
      details: { path: candidate, rule }
    }
  );
}

export async function governedDocumentPath(root, config, workflow, record) {
  if (!record.path) throw new SingularityFlowError(`Document '${record.id}' has no repository path.`);
  // Published code/test artifacts belong to the repository, not the Story's document folder.
  // Only a catalog entry backed by this phase's exact registered path/hash gets that scope.
  const repositoryArtifact = record.type === 'artifact' && record.id.startsWith('ART-')
    && /^[a-f0-9]{64}$/u.test(record.sha256 ?? '')
    && workflow.phases?.[record.phase]?.artifacts?.some((entry) =>
      entry.path === record.path && entry.sha256 === record.sha256 && entry.size === record.size);
  const itemRoot = repositoryArtifact ? path.resolve(root)
    : path.resolve(workDir(root, config, workflow.workItem.id));
  const absolute = path.resolve(root, record.path);
  const relative = path.relative(itemRoot, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SingularityFlowError(`Document '${record.id}' is outside work item ${workflow.workItem.id}.`);
  }
  if (repositoryArtifact) {
    const declaration = loadEnvironmentDeclarationSync(root, { optional: true });
    const match = matchEnvironmentLocalPath(declaration, posix(record.path));
    if (match) throw environmentLocalRefusal(record.path, match);
  }
  const fileInfo = await lstat(absolute).catch(() => null);
  if (!fileInfo?.isFile() || fileInfo.isSymbolicLink()) {
    throw new SingularityFlowError(`Document '${record.id}' is not a regular governed file.`);
  }
  const [realItemRoot, realDocument] = await Promise.all([realpath(itemRoot), realpath(absolute)]);
  const realRelative = path.relative(realItemRoot, realDocument);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new SingularityFlowError(`Document '${record.id}' resolves outside work item ${workflow.workItem.id}.`);
  }
  return absolute;
}

export async function systemDocument(root, config, workflow, id, label, relative) {
  const absolute = path.join(workDir(root, config, workflow.workItem.id), relative); if (!(await exists(absolute))) return null;
  const info = await snapshot(absolute); return { id, type: 'system', label, kind: 'workflow', path: posix(path.relative(root, absolute)), mimeType: mimeType(relative), size: info.size, sha256: info.sha256, phase: null };
}

export async function documentCatalog(root, config, workflow, { includeDetached = false, phaseId = null } = {}) {
  incrementCommandCounter('documents.catalog-build');
  const manifest = await loadManifest(root, config, workflow);
  // A phase filter narrows the supporting documents to those offered to that phase; system
  // documents and phase artifacts are listed as before.
  const records = [];
  for (const record of manifest.documents) {
    if (!(includeDetached || evidenceIsActive(record)) || !(phaseId == null || documentOfferedToPhase(record, phaseId))) continue;
    // Whether this checkout holds a machine-local document differs by machine, so it is computed
    // here and never written back to the catalog.
    records.push(isLocalDocument(record)
      ? { ...record, availability: await localDocumentAvailability(root, workflow.workItem.id, record) }
      : record);
  }
  for (const packageRecord of manifest.packages ?? []) {
    if (!includeDetached && !evidenceIsActive(packageRecord)) continue;
    for (const [suffix, label, kind, filePath, type] of [['INVENTORY', `${packageRecord.name} inventory`, 'package-inventory', packageRecord.inventoryPath, 'text/markdown'], ['GALLERY', `${packageRecord.name} gallery`, 'package-gallery', packageRecord.galleryPath, 'text/html'], ['MANIFEST', `${packageRecord.name} manifest`, 'package-manifest', packageRecord.manifestPath, 'application/json']]) {
      if (!filePath || !(await exists(path.join(root, filePath)))) continue;
      const info = await snapshot(path.join(root, filePath)); records.push({ id: `PACKAGE-${packageRecord.id}-${suffix}`, type: 'package', label, kind, path: filePath, mimeType: type, size: info.size, sha256: info.sha256, phase: packageRecord.phase, packageId: packageRecord.id });
    }
  }
  for (const [id, label, relative] of [['SYS-README', 'Work-item guide', 'README.md'], ['SYS-STATUS', 'Workflow status', 'STATUS.md'], ['SYS-WORKFLOW', 'Workflow state', 'workflow.json'], ['SYS-SOURCE', 'Source context', 'source.json'], ['SYS-STORY', 'User story', 'USER-STORY.md']]) {
    const record = await systemDocument(root, config, workflow, id, label, relative); if (record) records.push(record);
  }
  for (const phaseId of workflow.phaseOrder ?? Object.keys(workflow.phases ?? {})) {
    const phase = workflow.phases[phaseId];
    if (!phase?.requiredArtifact?.path) continue;
    const absolute = path.join(workDir(root, config, workflow.workItem.id), phase.requiredArtifact.path);
    if (!(await exists(absolute))) continue; const info = await snapshot(absolute);
    records.push({ id: `PHASE-${phaseId.toUpperCase()}`, type: 'artifact', label: phase.label, kind: phase.requiredArtifact.kind, path: posix(path.relative(root, absolute)), mimeType: mimeType(absolute), size: info.size, sha256: info.sha256, phase: phaseId, status: phase.status, generation: phase.generation });
    let extraIndex = 0;
    for (const artifact of (phase.artifacts ?? []).filter((item) => item.path !== posix(path.relative(root, absolute)))) {
      if (!(await exists(path.join(root, artifact.path)))) continue; extraIndex += 1;
      records.push({ id: `ART-${phaseId.toUpperCase()}-${String(extraIndex).padStart(2, '0')}`, type: 'artifact', label: path.basename(artifact.path), kind: artifact.kind, path: artifact.path, mimeType: mimeType(artifact.path), size: artifact.size, sha256: artifact.sha256, phase: phaseId, status: artifact.status, generation: phase.generation });
    }
    for (const brief of agentBriefReviewDocuments(workflow, phase).filter((entry) => entry.id && entry.path)) {
      let info = null;
      try {
        const absolute = await governedDocumentPath(root, config, workflow, { id: brief.id, path: brief.path });
        info = await snapshot(absolute);
      } catch {
        // Keep the packet-bound registry entry visible. The eventual view/approval preflight emits
        // the precise missing, escaped, symlinked, or non-file refusal instead of hiding the brief.
      }
      records.push({
        id: brief.id,
        aliases: brief.legacyId ? [brief.legacyId] : [],
        type: 'agent-brief',
        label: `Agent brief for ${brief.consumerPhase}`,
        kind: 'agent-brief',
        path: brief.path,
        recordPath: brief.recordPath,
        mimeType: 'text/markdown',
        size: info?.size ?? null,
        // The published/submitted projection hash is the authority. Never bless current bytes by
        // recomputing their hash while constructing the catalog.
        sha256: brief.sha256,
        phase: phaseId,
        producerPhase: phaseId,
        consumerPhase: brief.consumerPhase,
        status: brief.status,
        generation: brief.generation,
        integritySha256: brief.integritySha256,
        sourceSha256: brief.sourceSha256
      });
    }
  }
  return records;
}

export async function viewDocument(root, config, workflow, reference, { includeDetached = false } = {}) {
  const records = await documentCatalog(root, config, workflow, { includeDetached });
  return viewDocumentRecord(root, config, workflow, resolveDocumentRecord(records, reference));
}

/** A request-local catalog, never a cross-request evidence or approval cache. */
export async function createDocumentReadSession(root, config, workflow) {
  const catalogPath = manifestPath(root, config, workflow);
  const manifestBytes = () => readFile(catalogPath).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const before = await manifestBytes();
  const binding = JSON.stringify(workflow);
  const records = await documentCatalog(root, config, workflow);
  const unchanged = async () => {
    const current = await manifestBytes();
    if (JSON.stringify(workflow) !== binding
        || (before == null ? current != null : current == null || !before.equals(current))) {
      throw new SingularityFlowError('The document catalog changed during this review. Read the phase again.', {
        code: 'DOCUMENT_REVIEW_CHANGED'
      });
    }
  };
  await unchanged();
  return Object.freeze({
    records: structuredClone(records),
    view: async reference => {
      await unchanged();
      const viewed = await viewDocumentRecord(root, config, workflow, resolveDocumentRecord(records, reference));
      await unchanged();
      return viewed;
    }
  });
}

async function viewDocumentRecord(root, config, workflow, record) {
  if (record.type === 'url') return { record, content: null, binary: false };
  // An older record whose stored name lost its extension is typed from its original name.
  const mime = effectiveDocumentMimeType(record);
  const extension = (path.extname(record.path ?? record.storage?.key ?? '') || path.extname(record.sourceName ?? '')).toLowerCase();
  const binary = !TEXT_EXTENSIONS.has(extension) && !mime.startsWith('text/');
  let absolute;
  let bytes;
  let current;
  if (isLocalDocument(record)) {
    // Verified against the committed SHA-256, or refused with who has it and how to share it.
    ({ bytes, absolutePath: absolute } = await readLocalDocument(root, workflow.workItem.id, record));
    current = { sha256: record.sha256, size: bytes.length };
  } else {
    absolute = await governedDocumentPath(root, config, workflow, record);
    current = await snapshot(absolute);
    if ((record.sha256 && current.sha256 !== record.sha256)
        || (record.size != null && current.size !== record.size)) {
      // A checkout that rewrote line endings still has the exact bytes in Git; read those.
      const working = await readFile(absolute).catch(() => Buffer.alloc(0));
      const committed = record.sha256 ? committedDocumentBytes(root, posix(record.path), record, working) : null;
      if (committed) {
        bytes = committed;
        current = { sha256: record.sha256, size: committed.length };
      } else {
        if (GIT_LFS_POINTER.test(working.subarray(0, 200).toString('utf8'))) {
          throw new SingularityFlowError(`Document '${record.id}' is a Git LFS pointer in this checkout, not its bytes. Run git lfs pull, then retry.`,
            { code: 'DOCUMENT_LFS_POINTER', details: { documentId: record.id, path: record.path } });
        }
        throw new SingularityFlowError(`Document '${record.id}' no longer matches its committed catalog hash. Expected ${record.sha256}, found ${current.sha256}.`, {
          code: 'DOCUMENT_HASH_MISMATCH',
          details: { workId: workflow.workItem.id, documentId: record.id, path: record.path ?? null,
            expectedSha256: record.sha256, actualSha256: current.sha256 ?? null }
        });
      }
    }
  }
  if (binary) {
    // A DOCX or XLSX is a ZIP of XML whose text is what a reader needs; the bytes stay as they are.
    const rendition = hasTextExtractor(mime)
      ? documentRendition(bytes ?? await readFile(absolute), mime, documentPolicy(workflow, config).maxPreviewBytes ?? 1048576)
      : null;
    return {
      record, content: null, binary: true, absolutePath: absolute,
      verifiedSha256: current.sha256, size: current.size, previewBytes: 0, truncated: false,
      ...(rendition ? { rendition } : {})
    };
  }
  const policy = documentPolicy(workflow, config); bytes ??= await readFile(absolute); const limit = policy.maxPreviewBytes ?? 1048576;
  let previewBytes = Math.min(bytes.length, limit);
  let content = bytes.subarray(0, previewBytes).toString('utf8');
  // Do not end a byte-limited preview halfway through a UTF-8 code point.
  while (content.endsWith('\uFFFD') && previewBytes > 0) {
    previewBytes -= 1;
    content = bytes.subarray(0, previewBytes).toString('utf8');
  }
  const truncated = bytes.length > previewBytes;
  if (truncated) content = `${content}\n… preview truncated …\n`;
  return {
    record, content, binary: false, absolutePath: absolute,
    verifiedSha256: current.sha256, size: current.size, previewBytes, truncated
  };
}

/** Cut text to at most `limit` UTF-8 bytes without ending inside a code point. */
export function utf8Prefix(text, limit) {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= limit) return { text, bytes: encoded.length, truncated: false };
  let end = limit;
  let prefix = encoded.subarray(0, end).toString('utf8');
  while (prefix.endsWith('\uFFFD') && end > 0) { end -= 1; prefix = encoded.subarray(0, end).toString('utf8'); }
  return { text: prefix, bytes: end, truncated: true };
}

/** The extracted text of an Office document, bounded like any text preview, or why there is none. */
export function documentRendition(bytes, type, limit) {
  const extracted = extractSourceText(bytes, type);
  if (extracted.status !== 'extracted') return { status: 'unreadable', reason: extracted.reason };
  const bounded = utf8Prefix(extracted.text, limit);
  return {
    status: 'extracted', extractor: 'source-text', version: SOURCE_TEXT_EXTRACTOR_VERSION,
    text: bounded.truncated ? `${bounded.text}\n… extracted text truncated …\n` : bounded.text,
    bytes: bounded.bytes, sha256: createHash('sha256').update(extracted.text).digest('hex'), truncated: bounded.truncated
  };
}
