/** Local input attachment metadata; the shared Story never acquires the uploaded bytes. */
import {SingularityFlowError} from '../foundation/failures.mjs';
const fail=(message,code='ENGINE_INPUT_INVALID')=>{throw new SingularityFlowError(message,{code});};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
export function storyDocumentRequest(operation,input) {
  if(!id(input.documentId))fail('Name one stable document ID.');
  if(typeof input.reason!=='string')fail('Provide a concrete reason as text.');
  const reason=input.reason.trim();if(reason.length<10||reason.length>1000)fail('Say why this input is attached or detached in 10 to 1000 characters.');
  if(operation==='story.document.detach')return {documentId:input.documentId,reason};
  if(operation!=='story.document.attach')fail('Unknown input-document operation.','ENGINE_OPERATION_UNSUPPORTED');
  if(typeof input.name!=='string'||!input.name.trim()||input.name.length>512||/[\u0000-\u001f\u007f]/u.test(input.name)
    ||typeof input.mimeType!=='string'||input.mimeType.length>256||!/^[-a-zA-Z0-9.+]+\/[-a-zA-Z0-9.+]+$/u.test(input.mimeType)
    ||!['utf8','binary'].includes(input.encoding)||/^image\//u.test(input.mimeType)&&input.encoding!=='binary')fail('Provide the document name, media type and text or binary encoding.');
  const content=input.content;
  if(!content||typeof content!=='object'||Array.isArray(content)||Object.keys(content).length!==3||content.namespace!=='local'
    ||!/^([a-f0-9]{64})$/u.test(content.sha256??'')||!Number.isSafeInteger(content.bytes)||content.bytes<1||content.bytes>33_554_432)fail('An upload needs its actual bounded machine-local content reference.');
  return {documentId:input.documentId,name:input.name.trim(),mimeType:input.mimeType,encoding:input.encoding,content:{...content},reason};
}
export function planStoryDocument(workflow,operation,request) {
  if(workflow.status!=='in_progress'||workflow.currentPhase!==request.phaseId)fail('Attach inputs to the active Story.','ENGINE_CONTEXT_CHANGED');
  const proposed=structuredClone(workflow),rows=proposed.namespaceDocuments??[];let document;
  if(!Array.isArray(rows)||rows.length>8192||operation==='story.document.attach'&&rows.length===8192)fail('The Story input index exceeds its retained document bound.','ENGINE_STORAGE_LIMIT');
  const existing=rows.find(row=>row.id===request.documentId);
  if(operation==='story.document.detach') {
    if(!existing||existing.kind!=='input-document')fail('This Story has no attached input with that ID.','DOCUMENT_UNKNOWN');
    if(existing.status==='detached')fail('This input is already detached.','DOCUMENT_ALREADY_DETACHED');
    document={...existing,status:'detached'};rows.splice(rows.indexOf(existing),1,document);
  } else {
    if(existing)fail('This document ID is already retained. Use a new ID for another upload.','DOCUMENT_ID_REUSED');
    document={id:request.documentId,phase:null,generation:null,sourceKey:'documents/'+request.documentId,role:'file',name:request.name,
      kind:'input-document',mimeType:request.mimeType,encoding:request.encoding,locality:'machine-local',status:'active',aliases:[],content:request.content};
    rows.push(document);
  }
  proposed.namespaceDocuments=rows;return {workflow:proposed,outcome:{currentPhase:workflow.currentPhase,record:document}};
}
