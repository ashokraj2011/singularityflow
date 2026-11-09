/** Verify accepted changed-source content without a filesystem, executor or private working store. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,NAMESPACE_PREPARATION_SCHEMAS,admitRecordSchemaVersion} from '../foundation/record-schema.mjs';
import {sourceSnapshot,sourceContentReaderDescriptor} from '../foundation/source-snapshot.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {sourceSnapshotChanges} from '../kernel/source-changes.mjs';
import {phaseBeginSelection,phaseRequiresCodeDelivery} from '../kernel/phase-policy.mjs';
import {phaseCatalogAuthorAdmission} from '../kernel/phase-admission.mjs';
import {storyActorValue} from '../kernel/story-creation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {inspectSourceChanges} from '../engine-compatibility/node-source-policy.mjs';
import {namespaceScope,namespaceIdentifier,namespaceRevision,namespaceKey,exactObject} from '../sda/namespace/values.mjs';
import {namespaceLimits} from '../sda/namespace/contract.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceLifecycleCodec} from './namespace-lifecycle-codec.mjs';
import {verifySourceFileChunks} from './namespace-source-content-reader.mjs';
import {createNamespaceSourceObservations} from './namespace-source-observations.mjs';
import {createNamespaceSourceRetentionCodec,sourceRetentionValue,sourceRetentionRecord,sourceRetentionBinding,
  NAMESPACE_SOURCE_RETENTION_PROFILE,SOURCE_RETENTION_MAXIMUM_CHUNKS} from './namespace-source-retention-contract.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code='ENGINE_STORAGE_CORRUPT',cause=undefined)=>new SingularityFlowError(message,{code,cause});
export const emptySourceRetentionTotals=()=>({added:0,modified:0,removed:0,files:0,bytes:0,chunks:0,protectedChanges:0,boundaryViolations:0});
export function createNamespaceSourceRetentionReader({records,content,scope,workId,authority,observer:givenObserver}={}) {
  scope=namespaceScope(scope);const observer=givenObserver??createNamespaceStoryObserver({records,content,scope,workId,authority});
  const limits=namespaceLimits(records.descriptor.limits);
  const observations=createNamespaceSourceObservations({observer,scope});
  const codec=createNamespaceSourceRetentionCodec({scope,workId,authority,limits,textDigests:NODE_TEXT_DIGESTS});
  const lifecycle=createNamespaceLifecycleCodec({scope,workId,authority,limits,textDigests:NODE_TEXT_DIGESTS}),inspect=records.inspectOperation.bind(records);
  async function json(reference,kind,signal) {
    reference=contentReference(reference);const data=await observer.bytes(reference,reference.bytes,signal);
    try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));return kind?sourceRetentionValue(kind,value):value;}
    catch(cause){if(cause.code==='ENGINE_STORAGE_UNSUPPORTED')throw cause;throw error('Required retained source JSON is invalid.','ENGINE_STORAGE_CORRUPT',cause);}
  }
  async function intent(input,{signal}={}) {
    const k=codec.keys(input),accepted=await inspect(scope,k.prepareOperation,{signal}),saved=await observer.record('runtime',k.intent,true,signal,true);
    if(accepted?.status==='missing'&&accepted.receipt===null){if(saved)throw error('Unaccepted source intent metadata cannot authorize retention.');return null;}
    if(!saved)throw error('The accepted source-retention intent is missing.');
    const metadata=codec.verifyMetadata('intent',saved.value,input),plan=await json(metadata.content,'plan',signal);
    if(plan.profile!==NAMESPACE_SOURCE_RETENTION_PROFILE||!same(plan.binding,codec.binding)||!same(plan.input,input)
      ||plan.parametersSha256!==metadata.parametersSha256||plan.parametersSha256!==hash(canonicalJson({input,binding:codec.binding}))
      ||!Array.isArray(plan.sources)||!plan.sources.length||plan.sources.length>32
      ||!Number.isSafeInteger(plan.generation)||plan.generation<1)throw error('The source-retention plan has another binding.');
    try {
      exactObject(plan.basis,['authorityVersion','headVersion','configurationVersion','configuration','head']);
      if(['authorityVersion','headVersion','configurationVersion'].some(key=>namespaceRevision(plan.basis[key])===null))throw Error('Missing basis.');
      namespaceIdentifier(plan.basis.head?.operationId,'Basis operation');
      exactObject(plan.basis.configuration,['key','content']);namespaceKey(plan.basis.configuration.key);
      if(contentReference(plan.basis.configuration.content).namespace!=='config')throw Error('Another configuration namespace.');
      exactObject(plan.generationIntent,['id','reference']);
      if(contentReference(plan.generationIntent.reference).namespace!=='runtime')throw Error('Another generation namespace.');
      exactObject(plan.actor,['actor','agentId']);storyActorValue(plan.actor.actor);
      exactObject(plan.draft,['workId','phase','revision','bodySha256']);
    }catch(cause){throw error('The retained source plan has incomplete generation, author or authority facts.','ENGINE_STORAGE_CORRUPT',cause);}
    exactObject(plan.input,['operationId','workId','phaseId']);for(const value of Object.values(plan.input))namespaceIdentifier(value);
    const receipt=codec.receipt(accepted,codec.transaction(plan,metadata.content,{intent:true}));
    if(receipt.records.find(row=>row.key===k.intent)?.version!==saved.version)throw error('The source intent differs from its accepted receipt.');
    const basis=await observer.accepted(plan.basis.head.operationId,{signal}),head=lifecycle.head(basis.plan);
    if(!same(head,plan.basis.head)||basis.receipt.records.find(row=>row.key===lifecycle.headKey)?.version!==plan.basis.headVersion
      ||basis.plan.basis.configurationVersion!==plan.basis.configurationVersion||!same(head.configuration,plan.basis.configuration))throw error('The source intent has no accepted lifecycle basis.');
    const workflow=basis.state.workflow,phase=workflow.phases[input.phaseId],selection=phaseBeginSelection(workflow,{workId,phaseId:input.phaseId});
    if(!phaseRequiresCodeDelivery(phase)||selection.generation!==plan.generation)throw error('The retained source content is not bound to an actual code generation.');
    exactObject(plan.draft,['workId','phase','revision','bodySha256']);
    if(plan.draft.workId!==workId||plan.draft.phase!==input.phaseId||namespaceRevision(plan.draft.revision)===null
      ||!/^[a-f0-9]{64}$/u.test(plan.draft.bodySha256??'')||contentReference(plan.artifact).namespace!=='local')throw error('The source intent has another private draft.');
    exactObject(plan.actor,['actor','agentId']);storyActorValue(plan.actor.actor);
    if(plan.actor.agentId!==null)namespaceIdentifier(plan.actor.agentId,'Author agent');
    exactObject(plan.generationIntent,['id','reference']);
    const generation=await json(plan.generationIntent.reference,null,signal);
    try{admitRecordSchemaVersion(NAMESPACE_PREPARATION_SCHEMAS.generation,generation);
      exactObject(generation,['schemaVersion','format','workId','phase','generation','baseRevision','configuration','actor','agentId','createdAt','sources','inputContext']);
      if(generation.format!=='sflow-namespace-source-generation/v1'||generation.workId!==workId||generation.phase!==input.phaseId
        ||generation.generation!==plan.generation||generation.baseRevision!==plan.basis.headVersion||!same(generation.configuration,plan.basis.configuration)
        ||contentReference(plan.generationIntent.reference).namespace!=='runtime'
        ||plan.generationIntent.id!=='generation-'+plan.generationIntent.reference.sha256||contentReference(generation.inputContext).namespace!=='local')throw Error('Another generation.');
      projectEnrollmentTimestamp(generation.createdAt);
      storyActorValue(generation.actor);if(generation.agentId!==null)namespaceIdentifier(generation.agentId,'Generation author agent');
    }catch(cause){throw error('The source intent lost its exact generation binding.',['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',cause);}
    exactObject(plan.sourceBinding,['operationId']);const selected=workflow.sourceBindings?.current;
    if(!selected||selected.operationId!==plan.sourceBinding.operationId||plan.sources.length!==selected.repositories.length
      ||!same(generation.sources,selected.repositories))throw error('The retained generation changed its selected repositories.');
    const {selected:acceptedSelection}=await observations.binding(selected.operationId,signal);
    if(!same(acceptedSelection,selected))throw error('The source selection has no matching accepted receipt.');
    for(const [index,source]of plan.sources.entries()){
      exactObject(source,['repository','observed','reader']);exactObject(source.observed,['revision','content']);
      if(!same(source.repository,selected.repositories[index])||contentReference(source.observed.content).namespace!=='runtime'
        ||!/^sha256:[a-f0-9]{64}$/u.test(source.observed.revision??''))throw error('The source plan has another repository or observation.');
      if(source.reader!==null&&!same(sourceContentReaderDescriptor(source.reader).source,source.repository.descriptor))throw error('The retained content reader has another source selection.');
    }
    const definition=(await observer.approved({workflow,configuration:head.configuration},{signal})).compiled.definition;
    if(!phaseCatalogAuthorAdmission(definition,workflow,phase,plan.actor.agentId).allowed)throw error('The retained source author is not eligible under the pinned phase catalog.');
    return {plan,reference:metadata.content,workflow,definition};
  }
  async function snapshot(reference,descriptor,revision,signal) {
    const value=sourceSnapshot(await json(reference,null,signal),descriptor);
    if(revision!=='sha256:'+hash(canonicalJson(value)))throw error('A retained source snapshot has another digest.');return value;
  }
  async function projected(prepared,source,signal) {
    const repository=source.repository,previous=await snapshot(repository.snapshot,repository.descriptor,repository.revision,signal);
    const current=await snapshot(source.observed.content,repository.descriptor,source.observed.revision,signal);
    const changes=sourceSnapshotChanges(previous,current,repository.descriptor);
    return inspectSourceChanges(changes,{definition:prepared.definition,workflow:prepared.workflow,phase:prepared.workflow.phases[prepared.plan.input.phaseId],applicationOnly:true});
  }
  async function verifyRepository(prepared,source,reference,signal) {
    const value=await json(reference,'repository',signal),expected=await projected(prepared,source,signal),{plan}=prepared;
    if(value.profile!==NAMESPACE_SOURCE_RETENTION_PROFILE||!same(value.plan,prepared.reference)||value.id!==source.repository.id
      ||value.selection!=='changed-application-paths/v1'||value.baselineRevision!==source.repository.revision||value.observedRevision!==source.observed.revision
      ||!same(value.policy,expected.policy)||!same(value.totals,expected.totals)||!same(value.roles,expected.roles)
      ||value.protectedChanges!==expected.protectedChanges||value.boundaryViolations!==expected.boundaryViolations
      ||!Array.isArray(value.entries)||value.entries.length!==expected.entries.length)throw error('A retained repository changed its observed paths or policy facts.');
    const totals=emptySourceRetentionTotals();totals.protectedChanges=value.protectedChanges;totals.boundaryViolations=value.boundaryViolations;
    for(const [index,entry]of value.entries.entries()){
      exactObject(entry,[...Object.keys(expected.entries[index]),'chunks']);
      const {chunks,...facts}=entry;if(!same(facts,expected.entries[index])||!Array.isArray(chunks)||chunks.length>SOURCE_RETENTION_MAXIMUM_CHUNKS)throw error('A retained source member changed.');
      totals[entry.status==='A'?'added':entry.status==='D'?'removed':'modified']++;
      if(entry.after===null){if(chunks.length)throw error('A deleted source cannot retain current bytes.');continue;}
      if(entry.after.bytes>0&&source.reader===null)throw error('Retained bytes need their actual content-reader binding.');
      totals.files++;const verified=await verifySourceFileChunks(entry.after,chunks,{maximumChunkBytes:source.reader?.maximumChunkBytes,read:observer.bytes,signal});
      totals.chunks+=verified.chunks;totals.bytes+=verified.bytes;
      if(totals.chunks>SOURCE_RETENTION_MAXIMUM_CHUNKS)throw error('The repository chunk set exceeds its bounded profile.');
    }
    return {value,totals};
  }
  async function accepted(input,{signal}={}) {
    const k=codec.keys(input),receipt=await inspect(scope,k.operation,{signal}),saved=await observer.record('evidence',k.manifest,true,signal,true);
    if(receipt?.status==='missing'&&receipt.receipt===null){if(saved)throw error('A source result has no accepted transaction.');return null;}
    if(!saved)throw error('The accepted source result metadata is missing.');
    const prepared=await intent(input,{signal});if(!prepared)throw error('The source result has no accepted preparation.');
    const metadata=codec.verifyMetadata('manifest',saved.value,input);
    if(metadata.parametersSha256!==prepared.plan.parametersSha256)throw error('The source result has another request binding.');
    const result=codec.receipt(receipt,codec.transaction(prepared.plan,metadata.content,{previousIndexVersion:metadata.previousIndexVersion}));
    if(result.records.find(row=>row.key===k.manifest)?.version!==saved.version)throw error('The source result changed after acceptance.');
    const body=await json(metadata.content,'result',signal);
    if(body.profile!==NAMESPACE_SOURCE_RETENTION_PROFILE||!same(body.plan,prepared.reference)||!Array.isArray(body.repositories)
      ||body.repositories.length!==prepared.plan.sources.length)throw error('The source result has another plan or repository set.');
    projectEnrollmentTimestamp(body.recordedAt);const totals=emptySourceRetentionTotals();
    for(const [index,item]of body.repositories.entries()){
      exactObject(item,['id','manifest']);if(item.id!==prepared.plan.sources[index].repository.id||contentReference(item.manifest).namespace!=='evidence')throw error('The source result has another repository.');
      const verified=await verifyRepository(prepared,prepared.plan.sources[index],item.manifest,signal);
      for(const key of Object.keys(totals))totals[key]+=verified.totals[key];
    }
    if(!same(body.totals,totals))throw error('The source summary contradicts its retained files.');
    const binding=sourceRetentionRecord('binding',{operationId:input.operationId,result:{key:k.manifest,version:saved.version,content:metadata.content},
      index:{key:codec.indexKey(prepared.plan),version:result.records.find(row=>row.key===codec.indexKey(prepared.plan)).version}});sourceRetentionBinding(binding);
    return {...prepared,body,record:binding.result,binding,replayed:true};
  }
  async function inspectDraft({phaseId,generation,baseRevision,draft,artifact,configuration},{signal}={}) {
    const key=codec.indexKey({input:{phaseId},generation,basis:{headVersion:baseRevision},draft});
    const index=await observer.record('evidence',key,false,signal,true);if(!index)return null;
    const selected=codec.index(index.value),metadata=await observer.record('evidence',selected.manifestKey,true,signal);
    const found=await accepted({operationId:metadata.value.operationId,workId,phaseId},{signal});
    if(!found||found.record.key!==selected.manifestKey||found.binding.index.key!==key||found.binding.index.version!==index.version
      ||found.plan.generation!==generation||found.plan.basis.headVersion!==baseRevision||!same(found.plan.draft,draft)
      ||!same(found.plan.basis.configuration,configuration)||!same(found.plan.artifact,artifact))throw error('The retained source index has another authored draft binding.');
    return found;
  }
  return Object.freeze({observer,codec,json,intent,snapshot,projected,accepted,verifyRepository,inspectDraft});
}
