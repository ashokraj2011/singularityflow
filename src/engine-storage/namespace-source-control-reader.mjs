/** Reconstruct accepted origin observations using shared evidence and receipts, never a checkout. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {sourceControlReaderDescriptor,sourceControlObservation} from '../foundation/source-control.mjs';
import {storyActorValue} from '../kernel/story-creation.mjs';
import {phaseCatalogAuthorAdmission} from '../kernel/phase-admission.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {verifySourceControlObservation} from '../engine-compatibility/node-source-policy.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {namespaceScope,namespaceIdentifier,exactObject} from '../sda/namespace/values.mjs';
import {namespaceLimits} from '../sda/namespace/contract.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {createNamespaceSourceRetentionReader} from './namespace-source-retention-reader.mjs';
import {sourceRetentionBinding} from './namespace-source-retention-contract.mjs';
import {createNamespaceSourceControlCodec,sourceControlValue,NAMESPACE_SOURCE_CONTROL_PROFILE} from './namespace-source-control-contract.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex'),same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code='ENGINE_STORAGE_CORRUPT',cause=undefined)=>new SingularityFlowError(message,{code,cause});
export function createNamespaceSourceControlReader(options={}){
  const {records,scope:givenScope,workId,authority}=options,scope=namespaceScope(givenScope),sourceReader=createNamespaceSourceRetentionReader(options),{observer}=sourceReader;
  const codec=createNamespaceSourceControlCodec({scope,workId,authority,limits:namespaceLimits(records.descriptor.limits),textDigests:NODE_TEXT_DIGESTS});
  const inspect=records.inspectOperation.bind(records);
  async function json(reference,kind,signal){reference=contentReference(reference);const data=await observer.bytes(reference,reference.bytes,signal);
    try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));return kind?sourceControlValue(kind,value):value;}
    catch(cause){if(cause.code==='ENGINE_STORAGE_UNSUPPORTED')throw cause;throw error('Required source-control JSON is invalid.','ENGINE_STORAGE_CORRUPT',cause);}}
  function subject(source){return {workId,phase:source.plan.input.phaseId,generation:source.plan.generation,generationIntentId:source.plan.generationIntent.id};}
  async function verifyObservation(value,descriptor,source,repository,signal){
    const selected=source.plan.sources.find(row=>row.repository.id===repository.id);
    if(!selected)throw error('Source-control evidence names another retained repository.');
    descriptor=sourceControlReaderDescriptor(descriptor);
    if(!same(descriptor.source,selected.repository.descriptor))throw error('The control reader changed its selected source descriptor.');
    value=sourceControlObservation(value,descriptor,subject(source));
    if(value.current.revision!==selected.observed.revision||value.current.revision!=='sha256:'+hash(canonicalJson(value.current.snapshot)))throw error('Control observations have another retained current-source digest.');
    const baseline=await sourceReader.snapshot(selected.repository.snapshot,descriptor.source,selected.repository.revision,signal),
      current=await sourceReader.snapshot(selected.observed.content,descriptor.source,selected.observed.revision,signal);
    const facts=verifySourceControlObservation(value,{descriptor,subject:subject(source),baseline,current,definition:source.definition,workflow:source.workflow});
    return {value,changes:facts.changes,revision:'sha256:'+hash(canonicalJson(value))};
  }
  async function readObservation(row,source,signal){const reference=contentReference(row.content);
    const verified=await verifyObservation(await json(reference,null,signal),row.reader,source,{id:row.id},signal);
    if(row.revision!==verified.revision||reference.sha256!==row.revision.slice(7))throw error('The retained control observation has another identity.');return verified;}
  async function intent(input,{signal}={}){
    const k=codec.keys(input),receipt=await inspect(scope,k.prepareOperation,{signal}),saved=await observer.record('runtime',k.intent,true,signal,true);
    if(receipt?.status==='missing'&&receipt.receipt===null){if(saved)throw error('Unaccepted control intent metadata cannot authorize evidence.');return null;}
    if(!saved)throw error('The accepted source-control intent is missing.');
    const metadata=codec.verifyMetadata('intent',saved.value,input),plan=await json(metadata.content,'plan',signal);
    if(plan.profile!==NAMESPACE_SOURCE_CONTROL_PROFILE||!same(plan.binding,codec.binding)||!same(plan.input,input)
      ||plan.parametersSha256!==metadata.parametersSha256||plan.parametersSha256!==hash(canonicalJson({input,binding:codec.binding})))throw error('The source-control plan has another request binding.');
    exactObject(plan.input,['operationId','workId','phaseId']);for(const value of Object.values(plan.input))namespaceIdentifier(value);
    sourceRetentionBinding(plan.source);
    const source=await sourceReader.accepted({workId,phaseId:input.phaseId,operationId:plan.source.operationId},{signal});
    if(!source||!same(source.binding,plan.source)||!same(plan.basis,source.plan.basis)||plan.generation!==source.plan.generation||!same(plan.draft,source.plan.draft))throw error('The control intent lost its exact accepted source and generation.');
    exactObject(plan.actor,['actor','agentId']);storyActorValue(plan.actor.actor);if(plan.actor.agentId!==null)namespaceIdentifier(plan.actor.agentId);
    if(!phaseCatalogAuthorAdmission(source.definition,source.workflow,source.workflow.phases[input.phaseId],plan.actor.agentId).allowed)throw error('The control evidence author is not eligible under the pinned phase catalog.');
    if(!Array.isArray(plan.observations)||plan.observations.length!==source.plan.sources.length||plan.observations.length<1||plan.observations.length>32)throw error('Control evidence has another repository set.');
    const accepted=codec.receipt(receipt,codec.transaction(plan,metadata.content,{intent:true}));
    if(accepted.records.find(row=>row.key===k.intent)?.version!==saved.version)throw error('The control intent differs from its accepted receipt.');
    for(const [index,row]of plan.observations.entries()){
      exactObject(row,['id','reader','revision','content']);if(row.id!==source.plan.sources[index].repository.id||contentReference(row.content).namespace!=='runtime')throw error('The control intent has another repository or content namespace.');
      await readObservation(row,source,signal);
    }
    return {plan,reference:metadata.content,source};
  }
  async function accepted(input,{signal}={}){
    const k=codec.keys(input),receipt=await inspect(scope,k.operation,{signal}),saved=await observer.record('evidence',k.manifest,true,signal,true);
    if(receipt?.status==='missing'&&receipt.receipt===null){if(saved)throw error('A control result has no accepted transaction.');return null;}
    if(!saved)throw error('The accepted source-control result is missing.');const prepared=await intent(input,{signal});if(!prepared)throw error('The control result has no accepted preparation.');
    const metadata=codec.verifyMetadata('manifest',saved.value,input);if(metadata.parametersSha256!==prepared.plan.parametersSha256)throw error('Control result request identity changed.');
    const accepted=codec.receipt(receipt,codec.transaction(prepared.plan,metadata.content,{previousIndexVersion:metadata.previousIndexVersion}));
    if(accepted.records.find(row=>row.key===k.manifest)?.version!==saved.version)throw error('Control result metadata differs from its accepted receipt.');
    const body=await json(metadata.content,'result',signal);projectEnrollmentTimestamp(body.recordedAt);
    if(body.profile!==NAMESPACE_SOURCE_CONTROL_PROFILE||!same(body.plan,prepared.reference)||!Array.isArray(body.repositories)||body.repositories.length!==prepared.plan.observations.length)throw error('The control result has another plan or repository set.');
    const totals={repositories:body.repositories.length,changes:0};
    for(const [index,row]of body.repositories.entries()){
      exactObject(row,['id','observation','revision','changes']);const expected=prepared.plan.observations[index];
      if(row.id!==expected.id||row.revision!==expected.revision||!same(contentReference(row.observation),{...expected.content,namespace:'evidence'}))throw error('The control result changed its prepared observations.');
      const verified=await readObservation({...expected,content:row.observation},prepared.source,signal);
      if(row.changes!==verified.changes)throw error('The control result contradicts its actual change count.');totals.changes+=row.changes;
    }
    if(!same(body.totals,totals))throw error('The control result totals contradict their observations.');
    const binding={operationId:input.operationId,result:{key:k.manifest,version:saved.version,content:metadata.content},
      index:{key:codec.indexKey(prepared.plan),version:accepted.records.find(row=>row.key===codec.indexKey(prepared.plan)).version}};
    return {...prepared,body,binding,record:binding.result,replayed:true};
  }
  async function inspectDraft(identity,{signal}={}){
    const key=codec.indexKey({input:{phaseId:identity.phaseId},generation:identity.generation,basis:{headVersion:identity.baseRevision},draft:identity.draft});
    const index=await observer.record('evidence',key,false,signal,true);if(!index)return null;
    const selected=codec.index(index.value),metadata=await observer.record('evidence',selected.manifestKey,true,signal),found=await accepted({workId,phaseId:identity.phaseId,operationId:metadata.value.operationId},{signal});
    if(!found||found.record.key!==selected.manifestKey||found.binding.index.version!==index.version||found.binding.index.key!==key
      ||found.plan.generation!==identity.generation||found.plan.basis.headVersion!==identity.baseRevision||!same(found.plan.draft,identity.draft)
      ||!same(found.plan.basis.configuration,identity.configuration)||!same(found.source.plan.artifact,identity.artifact))throw error('The control index belongs to another authored draft.');
    return found;
  }
  return Object.freeze({observer,codec,sourceReader,subject,json,verifyObservation,readObservation,intent,accepted,inspectDraft});
}
