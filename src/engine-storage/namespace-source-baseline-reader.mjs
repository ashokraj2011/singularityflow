/** Read actual accepted baseline bytes without the old checkout, private drafts or write authority. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {sourceContentReaderDescriptor,SOURCE_CONTENT_MAXIMUM_CHUNKS} from '../foundation/source-snapshot.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {sourceBaselineInventory} from '../engine-compatibility/node-source-policy.mjs';
import {sourceBaselineRetentionInput} from '../kernel/source-changes.mjs';
import {storyActorValue} from '../kernel/story-creation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {namespaceScope,namespaceRevision,namespaceIdentifier,namespaceKey,exactObject} from '../sda/namespace/values.mjs';
import {namespaceLimits} from '../sda/namespace/contract.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceLifecycleCodec} from './namespace-lifecycle-codec.mjs';
import {createNamespaceSourceObservations} from './namespace-source-observations.mjs';
import {verifySourceFileChunks} from './namespace-source-content-reader.mjs';
import {createNamespaceSourceBaselineCodec,sourceBaselineValue,NAMESPACE_SOURCE_BASELINE_PROFILE} from './namespace-source-baseline-contract.mjs';
const hash=data=>createHash('sha256').update(data).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code='ENGINE_STORAGE_CORRUPT',cause=undefined)=>new SingularityFlowError(message,{code,cause});
export const emptySourceBaselineTotals=()=>({files:0,bytes:0,chunks:0});
export function createNamespaceSourceBaselineReader(options={}){
  const {records,content,workId,authority,observer:givenObserver}=options,scope=namespaceScope(options.scope),limits=namespaceLimits(records.descriptor.limits);
  const observer=givenObserver??createNamespaceStoryObserver({...options,scope}),observations=createNamespaceSourceObservations({observer,scope});
  const codec=createNamespaceSourceBaselineCodec({scope,workId,authority,limits,textDigests:NODE_TEXT_DIGESTS});
  const lifecycle=createNamespaceLifecycleCodec({scope,workId,authority,limits,textDigests:NODE_TEXT_DIGESTS}),inspect=records.inspectOperation.bind(records);
  async function json(reference,kind,signal){reference=contentReference(reference);const data=await observer.bytes(reference,reference.bytes,signal);
    try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));return kind?sourceBaselineValue(kind,value):value;}
    catch(cause){if(cause.code==='ENGINE_STORAGE_UNSUPPORTED')throw cause;throw error('The required baseline JSON is invalid.','ENGINE_STORAGE_CORRUPT',cause);}}
  async function inventory(repository,workflow,definition,signal){return sourceBaselineInventory(await observations.baseline(repository,signal),{workflow,definition});}
  async function intent(input,{signal}={}){
    const k=codec.keys(input),accepted=await inspect(scope,k.prepareOperation,{signal}),saved=await observer.record('runtime',k.intent,true,signal,true);
    if(accepted?.status==='missing'&&accepted.receipt===null){if(saved)throw error('Unaccepted baseline metadata cannot authorize retention.');return null;}
    if(!saved)throw error('The accepted baseline intent is missing.');
    let actualInput;try{actualInput=sourceBaselineRetentionInput({...input,sourceBindingId:saved.value.sourceBindingId});}
    catch(cause){throw error('The retained baseline metadata has another source-binding identity.','ENGINE_STORAGE_CORRUPT',cause);}
    const metadata=codec.verifyMetadata('intent',saved.value,actualInput),plan=await json(metadata.content,'plan',signal);
    try{
      sourceBaselineRetentionInput(plan.input);
      exactObject(plan.basis,['authorityVersion','headVersion','configurationVersion','configuration','head']);
      exactObject(plan.basis.configuration,['key','content']);
      namespaceIdentifier(plan.basis.head?.operationId);namespaceKey(plan.basis.configuration.key);
      if(contentReference(plan.basis.configuration.content).namespace!=='config')throw Error('Another configuration namespace.');
      if(['authorityVersion','headVersion','configurationVersion'].some(key=>namespaceRevision(plan.basis[key])===null))throw Error('Missing basis.');
      if(plan.profile!==NAMESPACE_SOURCE_BASELINE_PROFILE||!same(plan.binding,codec.binding)||!same(plan.input,actualInput)
        ||plan.parametersSha256!==metadata.parametersSha256||plan.parametersSha256!==hash(canonicalJson({input:actualInput,binding:codec.binding}))
        ||!Array.isArray(plan.sources)||plan.sources.length<1||plan.sources.length>32)throw Error('Another plan.');
      storyActorValue(plan.actor);projectEnrollmentTimestamp(plan.recordedAt);
    }catch(cause){throw error('The baseline intent lost its original request or authority basis.','ENGINE_STORAGE_CORRUPT',cause);}
    const receipt=codec.receipt(accepted,codec.transaction(plan,metadata.content,{intent:true}));
    if(receipt.records.find(row=>row.key===k.intent)?.version!==saved.version)throw error('The baseline intent differs from its accepted receipt.');
    const basis=await observer.accepted(plan.basis.head.operationId,{signal}),head=lifecycle.head(basis.plan);
    if(!same(head,plan.basis.head)||basis.receipt.records.find(row=>row.key===lifecycle.headKey)?.version!==plan.basis.headVersion
      ||basis.plan.basis.configurationVersion!==plan.basis.configurationVersion||!same(head.configuration,plan.basis.configuration))throw error('The baseline has no accepted lifecycle basis.');
    const {workflow,selected}=await observations.binding(actualInput.sourceBindingId,signal);
    if(plan.sources.length!==selected.repositories.length)throw error('The baseline lost selected repositories.');
    for(const [index,source]of plan.sources.entries()){
      exactObject(source,['repository','reader']);if(!same(source.repository,selected.repositories[index]))throw error('The baseline changed a selected repository.');
      if(source.reader!==null&&!same(sourceContentReaderDescriptor(source.reader).source,source.repository.descriptor))throw error('The baseline reader has another source selection.');
    }
    const definition=(await observer.approved({workflow,configuration:head.configuration},{signal})).compiled.definition;
    if(!same(actualInput,input))throw error('This operation ID belongs to another baseline request.','ENGINE_OPERATION_ID_REUSED');
    return {plan,reference:metadata.content,workflow,definition};
  }
  async function verifyRepository(prepared,source,reference,signal){
    const body=await json(reference,'repository',signal),expected=await inventory(source.repository,prepared.workflow,prepared.definition,signal);
    if(body.profile!==NAMESPACE_SOURCE_BASELINE_PROFILE||!same(body.plan,prepared.reference)||body.id!==source.repository.id||body.baselineRevision!==source.repository.revision
      ||body.selection!==expected.selection||!same(body.roles,expected.roles)||!Array.isArray(body.entries)||body.entries.length!==expected.entries.length)throw error('The baseline repository differs from its accepted original inventory.');
    const totals=emptySourceBaselineTotals();
    for(const [index,entry]of body.entries.entries()){
      exactObject(entry,[...Object.keys(expected.entries[index]),'chunks']);const {chunks,...facts}=entry;
      if(!same(facts,expected.entries[index])||entry.bytes>0&&source.reader===null)throw error('The baseline member lost its original source binding.');
      const verified=await verifySourceFileChunks(entry,chunks,{maximumChunkBytes:source.reader?.maximumChunkBytes,read:observer.bytes,signal});
      totals.files++;totals.bytes+=verified.bytes;totals.chunks+=verified.chunks;
      if(totals.chunks>SOURCE_CONTENT_MAXIMUM_CHUNKS)throw error('The baseline exceeds its bounded repository chunk set.');
    }
    return {body,totals};
  }
  async function accepted(input,{signal}={}){
    const k=codec.keys(input),receipt=await inspect(scope,k.operation,{signal}),saved=await observer.record('evidence',k.manifest,true,signal,true);
    if(receipt?.status==='missing'&&receipt.receipt===null){if(saved)throw error('The baseline result has no accepted transaction.');return null;}
    if(!saved)throw error('The accepted baseline result metadata is missing.');const prepared=await intent(input,{signal});if(!prepared)throw error('The baseline lost its accepted preparation.');
    const metadata=codec.verifyMetadata('manifest',saved.value,input);if(metadata.parametersSha256!==prepared.plan.parametersSha256)throw error('The baseline result changed its request.');
    const result=codec.receipt(receipt,codec.transaction(prepared.plan,metadata.content,{previousIndexVersion:metadata.previousIndexVersion}));
    if(result.records.find(row=>row.key===k.manifest)?.version!==saved.version)throw error('The accepted baseline metadata changed.');
    const body=await json(metadata.content,'result',signal);
    if(body.profile!==NAMESPACE_SOURCE_BASELINE_PROFILE||!same(body.plan,prepared.reference)||body.recordedAt!==prepared.plan.recordedAt
      ||!Array.isArray(body.repositories)||body.repositories.length!==prepared.plan.sources.length)throw error('The baseline result has another plan or repository set.');
    const totals=emptySourceBaselineTotals();for(const [index,item]of body.repositories.entries()){
      exactObject(item,['id','manifest']);if(item.id!==prepared.plan.sources[index].repository.id||contentReference(item.manifest).namespace!=='evidence')throw error('The baseline result changed its repository identity.');
      const verified=await verifyRepository(prepared,prepared.plan.sources[index],item.manifest,signal);for(const key of Object.keys(totals))totals[key]+=verified.totals[key];}
    if(!same(body.totals,totals))throw error('The baseline summary contradicts its retained files.');
    return {...prepared,body,record:{key:k.manifest,version:saved.version,content:metadata.content},indexVersion:result.records.find(row=>row.key===codec.indexKey(input)).version,replayed:true};
  }
  async function inspectBinding(sourceBindingId,{signal}={}) {
    const key=codec.indexKey({sourceBindingId}),index=await observer.record('evidence',key,false,signal,true);if(!index)return null;
    const selected=codec.index(index.value,{sourceBindingId}),metadata=await observer.record('evidence',selected.manifestKey,true,signal);
    const found=await accepted({operationId:metadata.value.operationId,workId,sourceBindingId},{signal});
    if(!found||found.record.key!==selected.manifestKey||found.indexVersion!==index.version)throw error('The source baseline index lost its actual accepted result.');
    return {...found,indexKey:key};
  }
  return Object.freeze({observer,codec,json,intent,inventory,binding:observations.binding,verifyRepository,accepted,inspectBinding});
}
