/** Registered input metadata writes. Bytes remain in the explicitly bound private content store. */
import {createHash} from 'node:crypto';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {storyDocumentRequest} from '../kernel/story-documents.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceRecordedMutationPort} from './namespace-recorded-mutation.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespaceInputDocumentOwners,INPUT_DOCUMENT_OPERATIONS} from './namespace-input-documents-reader.mjs';
const error=(message,code,details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceInputDocumentPort(options) {
  const {scope,workId,localContent}=options,observer=createNamespaceStoryObserver(options),
    owned=createNamespaceInputDocumentOwners({observer,scope,workId}),ports=new Map();
  async function local(request,{signal}={}) {
    if(!localContent||localContent.descriptor.binding.kind!=='machine-local')throw error('Bind this device\'s local input store.','DOCUMENT_REUPLOAD_REQUIRED',{
      workId,documentId:request.documentId,name:request.name,expected:request.content});
    const result=await localContent.read(scope,request.content,{signal});
    if(result?.status==='missing'&&result.data===null)throw error('Upload the matching original document on this device.','DOCUMENT_REUPLOAD_REQUIRED',{
      workId,documentId:request.documentId,name:request.name,expected:request.content});
    if(result?.status!=='present'||!(result.data instanceof Uint8Array)||result.data.byteLength!==request.content.bytes||result.truncated!==false
      ||canonicalJson(result.reference)!==canonicalJson(request.content))throw error('The local reader returned another input binding.','ENGINE_PORT_RESULT_INVALID');
    if(createHash('sha256').update(result.data).digest('hex')!==request.content.sha256)throw error('The local input bytes differ from their content reference.','ENGINE_STORAGE_CORRUPT');
    if(request.encoding==='utf8'){try{const text=new TextDecoder('utf-8',{fatal:true}).decode(result.data);if(text.includes('\0'))throw Error('NUL');}
      catch(cause){throw new SingularityFlowError('The input is not valid UTF-8 text. Attach its actual binary media type instead.',{code:'ENGINE_ARTIFACT_ENCODING_INVALID',cause});}}
  }
  for(const operation of INPUT_DOCUMENT_OPERATIONS) {
    const original=owned.owners.get(operation),owner={...original,...(operation.endsWith('attach')?{fresh:(_snapshot,request,_source,options)=>local(request,options)}:{})},
      request=(input,workflow)=>({...storyDocumentRequest(operation,input),phaseId:workflow.currentPhase});
    ports.set(operation,createNamespaceRecordedMutationPort(options,{operation,request,owner,contract:namespaceDecisionContract,
      explicitIdentity:true,requiresHuman:false,requestUsesWorkflow:true,finish:(value,revision)=>({workId,revision,pushed:false,
        currentPhase:value.outcome.currentPhase,document:value.outcome.record})}));
  }
  return Object.fromEntries(['load','prepare','commit','finish'].map(stage=>[stage,(...args)=>ports.get(args.at(-1)?.operation?.id)[stage](...args)]));
}
