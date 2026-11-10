/** Explicit read host. It cannot publish, approve, execute tools or select installed authority. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createEngine } from '../engine-sdk/index.mjs';
import { SingularityFlowError } from '../foundation/failures.mjs';
import { recordSha256 } from '../records.mjs';
import { resolveDocumentRecord } from '../document-identity.mjs';
import { phaseReviewSelection,assertHistoricalReviewPhase,hasPublishedPhaseGeneration,phaseNeedsGeneration } from '../kernel/phase-policy.mjs';
import { validateNamespaceStore,NAMESPACE_STORE_METHODS } from '../sda/namespace/contract.mjs';
import { namespaceScope, namespaceRevision,namespaceIdentifier,exactObject } from '../sda/namespace/values.mjs';
import { validateContentStore,contentReference,CONTENT_STORE_METHODS } from '../sda/content/contract.mjs';
import { namespaceReadHead, namespaceReadLifecycleHead, namespaceReadState, namespaceReadPolicy, namespaceDocumentIndex,
  namespaceReadRecord,projectNamespaceLifecycleReadState } from './namespace-read-contract.mjs';
import {namespaceLifecycleStoryKey} from './namespace-lifecycle-reader.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import { createNamespaceSubmissionReader } from './namespace-submission-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceRoutingChoiceReader} from './namespace-routing-choice-reader.mjs';
import {namespaceStoryReadKey} from './namespace-story-codec.mjs';
export {namespaceStoryReadKey} from './namespace-story-codec.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const unavailable = (message, code, details = null, cause = undefined) => new SingularityFlowError(message, { code, details, cause });
const sameRef = (a,b) => a.namespace === b.namespace && a.sha256 === b.sha256 && a.bytes === b.bytes;
const documentKey = record => JSON.stringify([record.phase,record.generation,record.role,record.sourceKey]);
const bodyReference = (workId,phase,record) => ({ kind: 'phase-document', id: `review-document-${recordSha256({ workId,
  phase: phase.id, generation: phase.generation, path: record.sourceKey, role: record.role })}`, workId, phase: phase.id, generation: phase.generation });

function cancelled(signal) { if (signal?.aborted) throw unavailable('The read was cancelled before it recorded any effect.', 'ENGINE_OPERATION_CANCELLED'); }
function errorData(error, depth = 0) {
  const result = { name: error.name ?? 'Error', message: error.message ?? String(error), code: error.code ?? null,
    details: error.details ?? null, cause: error.cause == null ? null : depth >= 8 ? { truncated: true } : errorData(error.cause, depth + 1) };
  for (const key of ['errcode','errstr','errno','syscall','path','dest','exitCode','timedOut']) if (error[key] != null) result[key] = error[key];
  return result;
}

/** Ports are application-owned. This projection is never used as a fresh approval binding. */
export function createNamespaceReadEngine({ records, content, localContent = null, scope, workId } = {}) {
  return createEngine({ports:createNamespaceReadPorts({records,content,localContent,scope,workId})});
}

/** Internal port composition lets creation and reading share one registered Engine instance. */
export function createNamespaceReadPorts({ records, content, localContent = null, scope, workId } = {},{authority=null}={}) {
  validateNamespaceStore(records); validateContentStore(content);
  scope = namespaceScope(scope); const key = namespaceStoryReadKey(workId);
  if(authority!==null) {
    exactObject(authority,['id','epoch']);authority=Object.freeze({id:namespaceIdentifier(authority.id),epoch:authority.epoch});
    if(!Number.isSafeInteger(authority.epoch)||authority.epoch<1)throw unavailable('A bound read authority needs its exact epoch.','ENGINE_INPUT_INVALID');
  }
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
  // An authority locator is data; it must not make us recapture replaceable host methods later.
  const lifecycleRecords=Object.freeze({descriptor:structuredClone(records.descriptor),
    ...Object.fromEntries(NAMESPACE_STORE_METHODS.map(name=>[name,records[name].bind(records)]))});
  const lifecycleContent=Object.freeze({descriptor:structuredClone(content.descriptor),
    ...Object.fromEntries(CONTENT_STORE_METHODS.map(name=>[name,content[name].bind(content)]))});
  async function head(signal) {
    cancelled(signal); const result = await readRecord(scope, 'state', key, { signal }); cancelled(signal);
    if (result?.status === 'missing' && result.record === null) throw unavailable('This backend has no read snapshot for the bound Story.', 'ENGINE_STORY_SNAPSHOT_MISSING', { projectId: scope.projectId, workId });
    if (result?.status !== 'present' || result.record?.key !== key || result.record.namespace !== 'state') {
      throw unavailable('The metadata port returned another read head.', 'ENGINE_PORT_RESULT_INVALID');
    }
    if (namespaceRevision(result.record.version) === null) throw unavailable('A read head needs an observed revision.', 'ENGINE_PORT_RESULT_INVALID');
    try { const value=result.record.value;
      return {revision:result.record.version,value:value?.format?.startsWith('sflow-namespace-read-lifecycle-head/')
        ?namespaceReadLifecycleHead(value,scope,workId):namespaceReadHead(value,scope,workId)}; }
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
    if(selected.value.format==='sflow-namespace-read-lifecycle-head/v1') {
      if(authority&&(selected.value.authority.id!==authority.id||selected.value.authority.epoch!==authority.epoch))throw unavailable(
        'The canonical read locator belongs to another bound authority.','ENGINE_AUTHORITY_FENCED',{workId,authority});
      if(selected.value.lifecycleHead!==namespaceLifecycleStoryKey(workId))throw unavailable('The lifecycle locator points at another Story.','ENGINE_STORAGE_CORRUPT');
      const observer=createNamespaceStoryObserver({records:lifecycleRecords,content:lifecycleContent,localContent,scope,workId,authority:selected.value.authority});
      const {snapshot,basis}=await observer.capture({signal}),workflow=snapshot.workflow;
      let policy,documents,projected;
      try {
        policy=namespaceReadPolicy(namespaceReadRecord('policy',{workItemRoot:workflow.resolution.workItemRoot,
          maximumPreviewBytes:workflow.resolution.codeDelivery?.display?.fullDocumentMaximumBytes??65536}));
        documents=namespaceDocumentIndex(namespaceReadRecord('documents',{documents:workflow.namespaceDocuments})).documents;
        projected=projectNamespaceLifecycleReadState(workflow);
      }catch(cause){if(cause.code==='ENGINE_STORAGE_UNSUPPORTED')throw cause;
        throw unavailable('The canonical namespace read metadata is invalid.','ENGINE_STORAGE_CORRUPT',{workId},cause);}
      const checks=createNamespacePhaseCheckReader({records:lifecycleRecords,content:lifecycleContent,scope,workId,authority:selected.value.authority,observer});
      const submissionReader=createNamespaceSubmissionReader({observer,scope,workId,checks});
      return {subject:{kind:'story',id:workId},workflow:projected,policy,documents,
        revision:snapshot.revision,lifecycleSnapshot:snapshot,submissionReader,
        routingChoiceReader:createNamespaceRoutingChoiceReader({observer,scope,workId,packets:submissionReader,checks}),
        lifecycle:{locatorRevision:selected.revision,key:selected.value.lifecycleHead,authorityVersion:basis.authorityVersion}};
    }
    if(authority)throw unavailable('The bound Engine requires a canonical lifecycle locator.','ENGINE_PORT_UNAVAILABLE',{
      workId,required:['canonical-lifecycle-locator']});
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
    if(context.lifecycle) {
      const current=await readRecord(scope,'state',context.lifecycle.key,{signal});
      const authority=await readRecord(scope,'state','authority/lifecycle',{signal});
      cancelled(signal);
      for(const [result,key] of [[current,context.lifecycle.key],[authority,'authority/lifecycle']]) {
        if(result?.status==='missing'&&result.record===null)throw unavailable('The lifecycle record disappeared during this read.','ENGINE_CONTEXT_CHANGED',{workId,key});
        if(result?.status!=='present'||result.record?.namespace!=='state'||result.record.key!==key||result.record.immutable!==false
          ||namespaceRevision(result.record.version)===null)throw unavailable('The metadata port returned another lifecycle binding.','ENGINE_PORT_RESULT_INVALID',{key});
      }
      if(selected.revision!==context.lifecycle.locatorRevision||current?.record?.version!==context.revision
        ||authority?.record?.version!==context.lifecycle.authorityVersion)throw unavailable('The canonical lifecycle changed during this read. Read it again.','ENGINE_CONTEXT_CHANGED',{workId});
      return;
    }
    if (selected.revision !== context.revision) throw unavailable('The Story read snapshot changed during this operation. Read it again.',
      'ENGINE_CONTEXT_CHANGED', { workId, expectedRevision: context.revision, observedRevision: selected.revision });
  }
  function inventory(context, selected) {
    const phase = context.workflow.phases[selected.phase];
    const primary = path.posix.join(context.policy.workItemRoot, workId, phase.requiredArtifact.path ?? '');
    const records = context.documents.filter(document => document.phase === phase.id && document.generation === phase.generation
      && (['artifact','agent-brief'].includes(document.role)||document.role==='file'&&document.kind==='artifact-set-member'))
      .map(document => ({ ...document,...(document.role==='file'?{role:'artifact'}:{}) }));
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
  const phaseReview = { async load(input,options) {
    const context=await load(input,options);
    assertHistoricalReviewPhase(context.workflow,input.phaseId);
    return context;
  }, async read(context, selected, { signal } = {}) {
    const reviewBinding=context.submissionReader?await context.submissionReader.review(context.lifecycleSnapshot,selected.phase,{signal}):null;
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
        sourcePreviewBytes: display.previewBytes, sourceFullBytes: display.fullDocumentMaximumBytes }, documents, reviewBinding };
  } };
  const phaseReviewResources={load:phaseReview.load,async read(context,selected,{signal}={}) {
    if(!context.submissionReader)throw unavailable('Retained review resources need the canonical submission owner.','ENGINE_PORT_UNAVAILABLE',{
      required:['namespace-submission-context']});
    const {proof,sources}=await context.submissionReader.context(context.lifecycleSnapshot,selected.phase,{signal});
    if(!proof) {
      const phase=context.lifecycleSnapshot.workflow.phases[selected.phase],generationRequired=!hasPublishedPhaseGeneration(phase)
        ||phaseNeedsGeneration(context.lifecycleSnapshot.workflow,phase);
      throw unavailable(generationRequired?'Prepare and publish the current generation before reviewing its retained resources.'
        :'Submit the published generation before requesting its exact review resources.',generationRequired?'PHASE_GENERATION_REQUIRED':'PHASE_SUBMISSION_REQUIRED',{
          workId,phase:selected.phase,actions:[{operation:generationRequired?'phase.prepare':'phase.submit',inputs:{workId,phaseId:selected.phase}}]});
    }
    const resources=[];
    function issued(record) {
      const phase=context.workflow.phases[record.phase],reference=record.role==='file'?{kind:'story-document',id:record.id,workId}:bodyReference(workId,phase,record);
      return {id:record.id,reference,phase:record.phase,generation:record.generation,kind:record.kind,mimeType:record.mimeType,
        expected:{sha256:record.content.sha256,bytes:record.content.bytes}};
    }
    for(const member of [proof,...sources]) {
      for(const [kind,reference,sourceKey] of [['review-packet',member.binding.record,null],
        ['artifact',member.published.artifact.content,member.published.artifact.sourceKey],
        ...(member.value.sourceReview?[['source-review',member.value.sourceReview.report,null]]:[]),
        ...context.submissionReader.publicationResources(member.published).map(item=>[item.kind,item.reference,item.sourceKey??null])]) {
        const candidates=context.documents.filter(record=>record.phase===member.value.phase&&record.generation===member.value.generation
          &&record.status!=='detached'&&record.locality==='project'&&record.content&&sameRef(record.content,reference)
          &&(kind==='artifact'?record.role==='artifact'&&record.sourceKey===sourceKey:record.role==='file'&&record.kind===kind&&(sourceKey===null||record.sourceKey===sourceKey)));
        if(candidates.length!==1)throw unavailable('The retained review has no unique readable resource reference.','ENGINE_STORAGE_CORRUPT',{
          workId,phase:member.value.phase,generation:member.value.generation,kind,expected:reference});
        resources.push(issued(candidates[0]));
      }
    }
    await unchanged(context,signal);
    return {workId,phase:selected.phase,generation:selected.generation,revision:context.revision,
      submission:{packetSha256:proof.binding.record.sha256,sourceRevision:proof.value.baseRevision},resources,
      reviewBinding:selected.current&&selected.status==='awaiting_approval'?proof.review:null};
  }};
  const documentRead = { load, async resolve(context, selected) {
    const candidates = [...selected.phases.flatMap(phase => inventory(context, phase)),
      ...context.documents.filter(document => document.role === 'file' && (selected.includeDetached || document.status !== 'detached')).map(document => ({ ...document, retained: null,
        reference: { kind: 'story-document', id: document.id, workId } }))];
    const request = selected.reference;
    let record;
    if (typeof request === 'object' && request.kind === 'phase-document') record = candidates.find(record => record.reference.id === request.id);
    else if(typeof request==='object'&&request.kind==='story-document')record=candidates.find(record=>record.reference.kind==='story-document'&&record.id===request.id);
    else {
      const aliases=candidates.filter(record=>!(record.kind==='artifact-set-member'&&record.reference.kind==='phase-document'&&candidates.some(other=>other.reference.kind==='story-document'
        &&other.id===record.id&&other.sourceKey===record.sourceKey&&sameRef(other.content,record.content))));
      try { record = resolveDocumentRecord(aliases.map(record => ({ ...record, path: record.sourceKey })), typeof request === 'string' ? request : request.id); }
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
  const decisionContext={async load(input,options) {
    const context=await load(input,options);
    if(!context.lifecycleSnapshot)throw unavailable('A routing question needs its canonical lifecycle owner.','ENGINE_PORT_UNAVAILABLE',{
      required:['namespace-routing-question']});
    return {...context,workflow:context.lifecycleSnapshot.workflow};
  },async read(context,selected,{signal}={}) {
    const retained=await context.routingChoiceReader.read(context.lifecycleSnapshot,{signal});
    await unchanged(context,signal);
    return {workId,phase:selected.phase,revision:context.revision,pendingKey:selected.question?.key??null,
      proof:retained?{generation:retained.approved.value.generation,reviewPacketSha256:retained.proof.binding.record.sha256,
        approvalSha256:retained.approved.binding.record.sha256}:null};
  }};
  return { phaseReview, phaseReviewResources, documentRead, decisionContext };
}
