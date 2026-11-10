/** Verify original output receipts and bytes without the old author's private checkout. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {phaseOutputSelection,PHASE_OUTPUT_LIMITS} from '../kernel/phase-outputs.mjs';
import {phaseOutputRetentionInput} from '../kernel/source-changes.mjs';
import {phaseCatalogAuthorAdmission} from '../kernel/phase-admission.mjs';
import {storyActorValue} from '../kernel/story-creation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {namespaceScope,namespaceIdentifier,namespaceRevision,namespaceKey,exactObject} from '../sda/namespace/values.mjs';
import {namespaceLimits} from '../sda/namespace/contract.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceLifecycleCodec} from './namespace-lifecycle-codec.mjs';
import {createNamespaceSourceRetentionReader} from './namespace-source-retention-reader.mjs';
import {sourceRetentionBinding as outputSourceBinding} from './namespace-source-retention-contract.mjs';
import {createNamespaceOutputRetentionCodec,outputRetentionValue,outputRetentionRecord,outputRetentionBinding,
  NAMESPACE_OUTPUT_RETENTION_PROFILE} from './namespace-output-retention-contract.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex'),same=(a,b)=>canonicalJson(a)===canonicalJson(b),
  error=(message,code='ENGINE_STORAGE_CORRUPT',details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
export function createNamespaceOutputRetentionReader({records,content,scope,workId,authority,observer:givenObserver,sourceReader:givenSources}={}){
  scope=namespaceScope(scope);const observer=givenObserver??createNamespaceStoryObserver({records,content,scope,workId,authority}),
    limits=namespaceLimits(records.descriptor.limits),options={records,content,scope,workId,authority,observer},
    codec=createNamespaceOutputRetentionCodec({...options,limits,textDigests:NODE_TEXT_DIGESTS}),
    lifecycle=createNamespaceLifecycleCodec({...options,limits,textDigests:NODE_TEXT_DIGESTS}),sources=givenSources??createNamespaceSourceRetentionReader(options),
    inspect=records.inspectOperation.bind(records);
  if(!same(sources.codec.binding,codec.binding)||typeof sources.isAccepted!=='function')throw error('An output reader needs the same actual source-evidence owner.','ENGINE_INPUT_INVALID');
  async function json(reference,kind,signal){const bytes=await observer.bytes(reference,reference.bytes,signal);try{
      const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));return kind?outputRetentionValue(kind,value):value;
    }catch(cause){if(cause.code==='ENGINE_STORAGE_UNSUPPORTED')throw cause;throw error('The retained output JSON is invalid.','ENGINE_STORAGE_CORRUPT',null,cause);}}
  async function intent(input,{signal,source:givenSource}={}){
    const k=codec.keys(input),receipt=await inspect(scope,k.prepareOperation,{signal}),saved=await observer.record('runtime',k.intent,true,signal,true);
    if(receipt?.status==='missing'&&receipt.receipt===null){if(saved)throw error('Unaccepted output intent cannot authorize retention.');return null;}
    if(!saved)throw error('The accepted output intent is missing.');
    const metadata=codec.verifyMetadata('intent',saved.value,input),plan=await json(metadata.content,'plan',signal);
    if(plan.profile!==NAMESPACE_OUTPUT_RETENTION_PROFILE||!same(plan.binding,codec.binding)
      ||plan.parametersSha256!==metadata.parametersSha256||plan.parametersSha256!==hash(canonicalJson({input:plan.input,binding:codec.binding})))throw error('The output intent has another request binding.');
    if(!same(plan.input,input))throw error('This output operation ID belongs to another exact request.','ENGINE_OPERATION_ID_REUSED');
    try{phaseOutputRetentionInput(plan.input);exactObject(plan.basis,['authorityVersion','headVersion','configurationVersion','configuration','head']);
      if(['authorityVersion','headVersion','configurationVersion'].some(key=>namespaceRevision(plan.basis[key])===null))throw Error('Missing basis.');
      namespaceIdentifier(plan.basis.head?.operationId);exactObject(plan.basis.configuration,['key','content']);namespaceKey(plan.basis.configuration.key);
      if(contentReference(plan.basis.configuration.content).namespace!=='config')throw Error('Another configuration.');
      exactObject(plan.draft,['workId','phase','revision','bodySha256']);exactObject(plan.actor,['actor','agentId']);storyActorValue(plan.actor.actor);
      if(plan.actor.agentId!==null)namespaceIdentifier(plan.actor.agentId);
      if(plan.draft.workId!==workId||plan.draft.phase!==input.phaseId||namespaceRevision(plan.draft.revision)===null
        ||!/^[a-f0-9]{64}$/u.test(plan.draft.bodySha256??'')||contentReference(plan.artifact).namespace!=='local')throw Error('Another draft.');
    }catch(cause){throw error('The output plan lost its original author, draft or basis.','ENGINE_STORAGE_CORRUPT',null,cause);}
    const accepted=codec.receipt(receipt,codec.transaction(plan,metadata.content,{intent:true}));
    if(accepted.records.find(row=>row.key===k.intent)?.version!==saved.version)throw error('The output intent differs from its accepted receipt.');
    const basis=await observer.accepted(plan.basis.head.operationId,{signal}),head=lifecycle.head(basis.plan);
    if(!same(head,plan.basis.head)||basis.receipt.records.find(row=>row.key===lifecycle.headKey)?.version!==plan.basis.headVersion
      ||basis.plan.basis.configurationVersion!==plan.basis.configurationVersion||!same(head.configuration,plan.basis.configuration))throw error('The output lost its accepted lifecycle basis.');
    const workflow=basis.state.workflow,definition=(await observer.approved({workflow,configuration:head.configuration},{signal})).compiled.definition,
      selection=phaseOutputSelection(definition,workflow,{phaseId:input.phaseId,path:input.path});
    if(!same(selection,plan.selection)||!phaseCatalogAuthorAdmission(definition,workflow,workflow.phases[input.phaseId],plan.actor.agentId).allowed)throw error('The output changed its author or generation selection.');
    let source=null;
    if(selection.sourceRequired){const binding=plan.source&&outputSourceBinding(plan.source),
        found=binding&&(givenSource&&sources.isAccepted(givenSource)&&same(givenSource.binding,binding)?givenSource
          :await sources.accepted({operationId:binding.operationId,workId,phaseId:input.phaseId},{signal}));
      if(!found||!same(found.binding,binding)||found.plan.generation!==selection.generation||found.plan.basis.headVersion!==plan.basis.headVersion
        ||!same(found.plan.draft,plan.draft)||!same(found.plan.artifact,plan.artifact)||!same(found.plan.basis.configuration,plan.basis.configuration))throw error('The output lost its actual Code source retention.');source=found;
    }else if(plan.source!==null)throw error('An artifact-only output cannot invent an application-source receipt.');
    return {plan,reference:metadata.content,workflow,definition,source};
  }
  async function accepted(input,{signal,source}={}){
    const k=codec.keys(input),receipt=await inspect(scope,k.operation,{signal}),saved=await observer.record('evidence',k.manifest,true,signal,true);
    if(receipt?.status==='missing'&&receipt.receipt===null){if(saved)throw error('Output bytes have no accepted transaction.');return null;}
    if(!saved)throw error('The accepted output metadata is missing.');
    const prepared=await intent(input,{signal,source});if(!prepared)throw error('Output acceptance lost its preparation.');
    const metadata=codec.verifyMetadata('manifest',saved.value,input);
    if(metadata.parametersSha256!==prepared.plan.parametersSha256)throw error('The output result changed its request binding.');
    const proof=codec.receipt(receipt,codec.transaction(prepared.plan,metadata.content,{previousIndex:metadata.previousIndex})),body=await json(metadata.content,'result',signal);
    if(proof.records.find(row=>row.key===k.manifest)?.version!==saved.version||body.profile!==NAMESPACE_OUTPUT_RETENTION_PROFILE
      ||!same(body.plan,prepared.reference)||!same(body.content,{...input.content,namespace:'evidence'}))throw error('The output result changed its accepted bytes.');
    projectEnrollmentTimestamp(body.recordedAt);await observer.bytes(body.content,body.content.bytes,signal);
    const binding=outputRetentionRecord('binding',{operationId:input.operationId,result:{key:k.manifest,version:saved.version,content:metadata.content},
      index:{key:codec.indexKey(prepared.plan.selection),version:proof.records.find(row=>row.key===codec.indexKey(prepared.plan.selection)).version}});outputRetentionBinding(binding);
    return {...prepared,body,record:binding.result,binding,replayed:true};
  }
  // The original request is immutable in the accepted intent, not reconstructed from a laptop path.
  async function byKey(key,{signal,source}={}){const saved=await observer.record('evidence',key,true,signal);if(!saved)throw error('An output index lost its immutable result.');
    const metadata=outputRetentionValue('manifest',saved.value),body=await json(metadata.content,'result',signal),plan=await json(body.plan,'plan',signal),found=await accepted(plan.input,{signal,source});
    if(!found||found.record.key!==key)throw error('An output index names another accepted result.');return found;}
  function compatible(found,{phaseId,generation,configuration,source}){
    if(found.plan.selection.phase!==phaseId||found.plan.selection.generation!==generation||!same(found.plan.basis.configuration,configuration))throw error('Output belongs to another generation or configuration.');
    const observed=value=>value?.plan.sources.map(row=>({repository:row.repository,observed:row.observed}))??null;
    if(!same(observed(found.source),observed(source)))throw error('Retain a fresh output for the actual current Code source.','ENGINE_OUTPUT_SOURCE_CHANGED',{
      operation:'phase.output.retain',workId,phaseId,path:found.plan.input.path,newOperationRequired:true});
  }
  async function selection(identity,{signal,binding=null}={}){
    let rows,index;
    if(binding){exactObject(binding,['profile','index','files']);exactObject(binding.index,['key','version']);
      if(binding.profile!=='sflow-namespace-code-outputs/v1'||namespaceRevision(binding.index.version)===null||!Array.isArray(binding.files))throw error('The published output selection is invalid.');
      index=binding.index;rows=binding.files.map(row=>{exactObject(row,['path','content','retention']);outputRetentionBinding(row.retention);return {path:row.path,manifestKey:row.retention.result.key};});
    }else{const key=codec.indexKey({phase:identity.phaseId,generation:identity.generation}),saved=await observer.record('evidence',key,false,signal,true);
      if(!saved)return null;const value=codec.index(saved.value);index={key,version:saved.version};rows=value.entries;}
    if(index.key!==codec.indexKey({phase:identity.phaseId,generation:identity.generation})||!rows.length||rows.length>PHASE_OUTPUT_LIMITS.files
      ||new Set(rows.map(row=>row.path)).size!==rows.length)throw error('The output selection changed its generation or member bound.');
    const files=[];let bytes=0;
    for(const row of rows){const found=await byKey(row.manifestKey,{signal,source:identity.source});compatible(found,identity);
      if(found.plan.input.path!==row.path)throw error('The output selection substituted a logical path.');
      bytes+=found.body.content.bytes;files.push({path:row.path,content:found.body.content,retention:found.binding});}
    if(bytes>PHASE_OUTPUT_LIMITS.totalBytes)throw error('The output selection exceeds the retained byte bound.','ENGINE_STORAGE_LIMIT');
    const value={profile:'sflow-namespace-code-outputs/v1',index,files};if(binding&&!same(binding,value))throw error('The published output selection changed its original receipt or bytes.');return value;
  }
  return Object.freeze({observer,codec,json,sources,intent,accepted,byKey,selection});
}
