/** Explicit read host. It cannot publish, approve, execute tools or select installed authority. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createEngine } from '../engine-sdk/index.mjs';
import { SingularityFlowError } from '../foundation/failures.mjs';
import { recordSha256 } from '../records.mjs';
import { resolveDocumentRecord } from '../document-identity.mjs';
import { phaseReviewSelection } from '../kernel/phase-policy.mjs';
import { validateNamespaceStore } from '../sda/namespace/contract.mjs';
import { namespaceScope, namespaceRevision } from '../sda/namespace/values.mjs';
import { validateContentStore, contentReference } from '../sda/content/contract.mjs';
import { namespaceReadHead, namespaceReadState, namespaceReadPolicy, namespaceDocumentIndex } from './namespace-read-contract.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const unavailable = (message, code, details = null, cause = undefined) => new SingularityFlowError(message, { code, details, cause });
const sameRef = (a,b) => a.namespace === b.namespace && a.sha256 === b.sha256 && a.bytes === b.bytes;
const documentKey = record => JSON.stringify([record.phase,record.generation,record.role,record.sourceKey]);
const bodyReference = (workId,phase,record) => ({ kind: 'phase-document', id: `review-document-${recordSha256({ workId,
  phase: phase.id, generation: phase.generation, path: record.sourceKey, role: record.role })}`, workId, phase: phase.id, generation: phase.generation });

export function namespaceStoryReadKey(workId) {
  if (typeof workId !== 'string' || !workId || workId.length > 2048) throw unavailable('A namespace read host needs one explicit Story ID.', 'ENGINE_INPUT_INVALID');
  return `stories/${recordSha256({workId})}/read-head`;
}
function cancelled(signal) { if (signal?.aborted) throw unavailable('The read was cancelled before it recorded any effect.', 'ENGINE_OPERATION_CANCELLED'); }
function errorData(error, depth = 0) {
  const result = { name: error.name ?? 'Error', message: error.message ?? String(error), code: error.code ?? null,
    details: error.details ?? null, cause: error.cause == null ? null : depth >= 8 ? { truncated: true } : errorData(error.cause, depth + 1) };
  for (const key of ['errcode','errstr','errno','syscall','path','dest','exitCode','timedOut']) if (error[key] != null) result[key] = error[key];
  return result;
}

/** Ports are application-owned. This projection is never used as a fresh approval binding. */
export function createNamespaceReadEngine({ records, content, localContent = null, scope, workId } = {}) {
  validateNamespaceStore(records); validateContentStore(content);
  scope = namespaceScope(scope); const key = namespaceStoryReadKey(workId);
  if (records.descriptor.binding.kind !== 'shared' || content.descriptor.binding.kind !== 'shared') {
    throw unavailable('Story read snapshots need shared metadata and content ports.', 'ENGINE_INPUT_INVALID');
  }
  if (localContent) {
    validateContentStore(localContent);
    if (localContent.descriptor.binding.kind !== 'machine-local') throw unavailable('Local attachments need an explicit device-bound content port.', 'ENGINE_INPUT_INVALID');
  }
  // Capture method bindings. A caller cannot redirect a running host by replacing methods.
  const readRecord = records.read.bind(records);
  const readContent = content.read.bind(content), readLocal = localContent?.read.bind(localContent);
  async function head(signal) {
    cancelled(signal); const result = await readRecord(scope, 'state', key, { signal }); cancelled(signal);
    if (result?.status === 'missing' && result.record === null) throw unavailable('This backend has no read snapshot for the bound Story.', 'ENGINE_STORY_SNAPSHOT_MISSING', { projectId: scope.projectId, workId });
    if (result?.status !== 'present' || result.record?.key !== key || result.record.namespace !== 'state') {
      throw unavailable('The metadata port returned another read head.', 'ENGINE_PORT_RESULT_INVALID');
    }
    if (namespaceRevision(result.record.version) === null) throw unavailable('A read head needs an observed revision.', 'ENGINE_PORT_RESULT_INVALID');
    try { return { revision: result.record.version, value: namespaceReadHead(result.record.value, scope, workId) }; }
    catch (cause) {
      if (cause.code === 'ENGINE_STORAGE_UNSUPPORTED') throw cause;
      throw unavailable('The stored Story read head is invalid.', 'ENGINE_STORAGE_CORRUPT', { workId, stage: 'read-head' }, cause);
    }
  }
  async function bytes(reference, maximumBytes, signal, locality = 'project', id = null) {
    cancelled(signal);
    const read = locality === 'machine-local' ? readLocal : readContent;
    if (!read) throw unavailable('This laptop needs the original local attachment again.', 'DOCUMENT_REUPLOAD_REQUIRED', { workId, documentId: id, expected: reference });
    const result = await read(scope, reference, { maximumBytes, signal }); cancelled(signal);
    if (result?.status === 'missing' && result.data === null) throw unavailable(locality === 'machine-local'
      ? 'The attachment is unavailable on this laptop; upload matching bytes again.' : 'Retained content is missing from this backend.',
    locality === 'machine-local' ? 'DOCUMENT_REUPLOAD_REQUIRED' : 'ENGINE_STORAGE_CONTENT_MISSING', { workId, documentId: id, expected: reference });
    if (result?.status !== 'present' || !sameRef(contentReference(result.reference), reference)
      || !(result.data instanceof Uint8Array) || result.data.byteLength !== Math.min(maximumBytes, reference.bytes)
      || result.truncated !== (maximumBytes < reference.bytes)) throw unavailable('The content port returned a different reference or read budget.', 'ENGINE_PORT_RESULT_INVALID');
    const data = Buffer.from(result.data);
    if (!result.truncated && hash(data) !== reference.sha256) throw unavailable('The content port returned bytes with a different digest.', 'ENGINE_STORAGE_CORRUPT', { workId, expected: reference });
    return data;
  }
  async function json(reference, signal) {
    const data = await bytes(reference, reference.bytes, signal);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
    catch (cause) { throw unavailable('A read projection is not valid UTF-8 JSON.', 'ENGINE_STORAGE_CORRUPT', { workId, expected: reference }, cause); }
  }
  async function load(_inputs, { signal } = {}) {
    const selected = await head(signal);
    const results = await Promise.allSettled([json(selected.value.state, signal), json(selected.value.policy, signal), json(selected.value.documents, signal)]);
    let failure = null; for (const result of results) if (result.status === 'rejected' && failure === null) failure = result.reason;
    if (failure !== null) throw failure;
    let workflow, policy, documents;
    try { workflow = namespaceReadState(results[0].value, workId); policy = namespaceReadPolicy(results[1].value);
      documents = namespaceDocumentIndex(results[2].value).documents; }
    catch (cause) {
      if (cause.code === 'ENGINE_STORAGE_UNSUPPORTED') throw cause;
      throw unavailable('A stored read projection has invalid metadata.', 'ENGINE_STORAGE_CORRUPT', { workId }, cause);
    }
    return { subject: { kind: 'story', id: workId }, workflow, policy, documents, revision: selected.revision };
  }
  async function unchanged(context, signal) {
    const selected = await head(signal);
    if (selected.revision !== context.revision) throw unavailable('The Story read snapshot changed during this operation. Read it again.',
      'ENGINE_CONTEXT_CHANGED', { workId, expectedRevision: context.revision, observedRevision: selected.revision });
  }
  function inventory(context, selected) {
    const phase = context.workflow.phases[selected.phase];
    const primary = path.posix.join(context.policy.workItemRoot, workId, phase.requiredArtifact.path ?? '');
    const records = context.documents.filter(document => document.phase === phase.id && document.generation === phase.generation
      && ['artifact','agent-brief'].includes(document.role)).map(document => ({ ...document }));
    const identities = new Set(records.map(documentKey));
    for (const member of selected.retained) {
      const identity = documentKey({ ...member, phase: phase.id, generation: phase.generation });
      if (identities.has(identity)) continue;
      identities.add(identity); records.push({ id: member.sourceKey === primary ? `PHASE-${phase.id.toUpperCase()}`
        : `ART-RETAINED-${recordSha256(member.sourceKey).slice(0,20)}`, phase: phase.id, generation: phase.generation,
      sourceKey: member.sourceKey, role: member.role, name: null, kind: member.role === 'agent-brief' ? 'agent-brief' : phase.requiredArtifact.kind ?? 'unknown',
      mimeType: member.sourceKey.endsWith('.md') ? 'text/markdown' : 'application/octet-stream', encoding: 'binary', locality: 'project', content: null });
    }
    return records.map(record => ({ ...record, primary: record.sourceKey === primary,
      reference: bodyReference(workId, phase, record), retained: selected.retained.find(member => member.role === record.role && member.sourceKey === record.sourceKey) ?? null }));
  }
  function expected(record) { return record.retained?.sha256 ? { sha256: record.retained.sha256, bytes: record.retained.bytes } : null; }
  const phaseReview = { load, async read(context, selected, { signal } = {}) {
    const documents = [];
    for (const record of inventory(context, selected)) {
      let observed = null, error = null;
      try {
        if (!record.content) throw unavailable('The read snapshot has no body binding for this retained member.', 'ENGINE_STORAGE_CONTENT_MISSING', { workId, documentId: record.id });
        await bytes(record.content, 0, signal, record.locality, record.id);
        observed = { sha256: record.content.sha256, bytes: record.content.bytes, binary: record.encoding === 'binary' };
      } catch (cause) { if (cause.code === 'ENGINE_OPERATION_CANCELLED' || cause.code === 'SDA_CONTENT_CANCELLED') throw cause; error = errorData(cause); }
      documents.push({ id: record.id, reference: record.reference.id, sourceKey: record.sourceKey, role: record.role,
        kind: record.kind, mimeType: record.mimeType, generation: record.generation, primary: record.primary,
        expected: expected(record), observed, error });
    }
    await unchanged(context, signal);
    const display = context.workflow.resolution.codeDelivery.display;
    return { workId, phase: selected.phase, generation: selected.generation, status: selected.status, revision: context.revision,
      budgets: { previewBytes: context.workflow.resolution.documents.maxPreviewBytes ?? context.policy.maximumPreviewBytes,
        sourcePreviewBytes: display.previewBytes, sourceFullBytes: display.fullDocumentMaximumBytes }, documents, reviewBinding: null };
  } };
  const documentRead = { load, async resolve(context, selected) {
    const candidates = [...selected.phases.flatMap(phase => inventory(context, phase)),
      ...context.documents.filter(document => document.role === 'file' && (selected.includeDetached || document.status !== 'detached')).map(document => ({ ...document, retained: null,
        reference: { kind: 'story-document', id: document.id, workId } }))];
    const request = selected.reference;
    let record;
    if (typeof request === 'object' && request.kind === 'phase-document') record = candidates.find(record => record.reference.id === request.id);
    else {
      try { record = resolveDocumentRecord(candidates.map(record => ({ ...record, path: record.sourceKey })), typeof request === 'string' ? request : request.id); }
      catch (cause) { if (cause.code !== 'DOCUMENT_NOT_FOUND') throw cause;
        throw unavailable('The document was not found in this Story read snapshot.', cause.code, { workId, reference: request }, cause); }
    }
    if (!record) throw unavailable('The phase reference was not found in the retained snapshot.', 'DOCUMENT_NOT_FOUND', { workId, reference: request });
    context.record = record;
    const maximumBytes = Math.min(context.workflow.resolution.documents.maxPreviewBytes ?? context.policy.maximumPreviewBytes, selected.maximumBytes);
    return { workId, id: record.id, reference: record.reference, phase: record.phase, generation: record.generation,
      sourceKey: record.sourceKey, role: record.role, name: record.name, kind: record.kind, mimeType: record.mimeType, locality: record.locality,
      expected: record.role === 'file' ? { sha256: record.content.sha256, bytes: record.content.bytes } : expected(record), maximumBytes, uri: null };
  }, async read(context, binding, { signal } = {}) {
    const record = context.record;
    if (!record.content) throw unavailable('The retained member has no content binding.', 'ENGINE_STORAGE_CONTENT_MISSING', { workId, documentId: record.id });
    const data = await bytes(record.content, record.encoding === 'binary' ? 0 : record.content.bytes, signal, record.locality, record.id);
    let content = null;
    if (record.encoding === 'utf8') {
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
      catch (cause) { throw unavailable('The retained text is not valid UTF-8.', 'DOCUMENT_ENCODING_INVALID', { workId, documentId: record.id }, cause); }
      let length = 0, end = 0;
      for (const character of text) { const n = Buffer.byteLength(character); if (length + n > binding.maximumBytes) break; length += n; end += character.length; }
      content = { kind: 'text', text: text.slice(0,end), bytes: length, truncated: length < record.content.bytes };
    }
    await unchanged(context, signal);
    return { id: record.id, revision: context.revision, observed: { sha256: record.content.sha256, bytes: record.content.bytes, binary: record.encoding === 'binary' }, content, extractionFailure: null };
  } };
  return createEngine({ ports: { phaseReview, documentRead } });
}
