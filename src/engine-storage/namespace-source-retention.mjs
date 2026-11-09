/** Retain actual changed application bytes. Canonical Story state and source files are untouched. */
import {createHash} from 'node:crypto';
import {createEngine} from '../engine-sdk/index.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {validateSourceContentReader,sourceContentReadResult} from '../foundation/source-snapshot.mjs';
import {phaseAccessIdentity} from '../kernel/phase-preparation.mjs';
import {phaseRequiresCodeDelivery} from '../kernel/phase-policy.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {namespaceScope,namespaceIdentifier,namespaceJson} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {createNamespacePreparationRuntime} from './namespace-preparation.mjs';
import {createNamespaceSourceObservations} from './namespace-source-observations.mjs';
import {createNamespaceSourceRetentionReader,emptySourceRetentionTotals} from './namespace-source-retention-reader.mjs';
import {sourceRetentionRecord,NAMESPACE_SOURCE_RETENTION_PROFILE,SOURCE_RETENTION_MAXIMUM_CHUNKS} from './namespace-source-retention-contract.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code='ENGINE_INPUT_INVALID',details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
function cancelled(signal){if(signal?.aborted)throw error('Source retention was cancelled; the draft and prepared evidence are preserved.','ENGINE_OPERATION_CANCELLED');}

export function createNamespaceSourceRetentionPort(options={},runtime=null) {
  const {records,content,access,clock}=options,scope=namespaceScope(options.scope),workId=namespaceIdentifier(options.workId,'Story ID');
  const reader=createNamespaceSourceRetentionReader({...options,scope,workId}),{observer,codec}=reader;
  const observations=createNamespaceSourceObservations({observer,sources:options.sources,scope}),readers=new Map(),readerIds=new Set();
  if(typeof access?.current!=='function'||typeof clock?.now!=='function'||!Array.isArray(options.sourceReaders??[])||(options.sourceReaders??[]).length>32) {
    throw error('Retaining source needs explicit access, clock and bounded content-reader bindings.');
  }
  for(const port of options.sourceReaders??[]){const descriptor=validateSourceContentReader(port),id=descriptor.source.repositoryId;
    if(descriptor.source.projectId!==scope.projectId||readers.has(id)||readerIds.has(descriptor.id))throw error('Content readers must be distinct and project bound.');
    readers.set(id,{descriptor,read:port.read.bind(port)});readerIds.add(descriptor.id);}
  const put=content.put.bind(content),maximumContentBytes=content.descriptor.maximumBytes,transact=records.transact.bind(records),current=access.current.bind(access),now=clock.now.bind(clock);
  const contexts=new WeakMap(),prepared=new WeakMap(),collected=new WeakMap();
  const selected=context=>{const found=contexts.get(context);if(!found)throw error('Use the issued source-retention context.');return found;};
  const parameters=input=>hash(canonicalJson({input,binding:codec.binding}));
  async function shared(data,namespace,signal) {
    cancelled(signal);const expected={namespace,sha256:hash(data),bytes:data.byteLength},saved=await put(scope,namespace,data,{signal});
    if(!same(contentReference(saved?.reference),expected)||typeof saved.reused!=='boolean')throw error('The content store acknowledged other source bytes.','ENGINE_PORT_RESULT_INVALID');
    await observer.bytes(expected,expected.bytes,signal);return expected;
  }
  function checked(plan,s) {
    if(plan&&(plan.parametersSha256!==s.parameters||!same(plan.input,s.input)))throw error('This operation ID belongs to another source-retention request.','ENGINE_OPERATION_ID_REUSED');return plan;
  }
  async function acknowledged(s,signal) {
    const accepted=await reader.accepted(s.input,{signal});if(!accepted)return null;checked(accepted.plan,s);cancelled(signal);
    const identity=phaseAccessIdentity(namespaceJson(await current({projectId:scope.projectId,workId,operation:'phase.source.retain',signal})),scope.projectId);
    if(!same(identity.actor,accepted.plan.actor.actor))throw error('Acknowledge source retention under its original authenticated person.','ENGINE_ACTOR_CHANGED');
    return {...accepted,replayed:true};
  }
  async function fresh(s,signal) {
    cancelled(signal);await runtime.revalidateDraft(s.admission,{signal});
    const found=[];for(const source of s.plan.sources){const captured=await observations.capture(source.repository,signal);
      if(captured.revision!==source.observed.revision)throw error('The source changed after retention preparation; preserve this intent and select a new operation.','ENGINE_SOURCE_CHANGED',{
        operation:'phase.source.retain',repositoryId:source.repository.id,newOperationRequired:true});found.push(captured);}
    return found;
  }
  function boundReader(source) {
    if(source.reader===null)return null;const bound=readers.get(source.repository.id);
    if(!bound||!same(bound.descriptor,source.reader))throw error('Bind the prepared source content reader before resuming retention.','ENGINE_SOURCE_CONTENT_READER_UNAVAILABLE',{
      repositoryId:source.repository.id,readerId:source.reader.id,operation:'phase.source.retain'});return bound;
  }
  return {
    async load(input,{signal}={}) {
      if(input.workId!==workId)throw error('Source retention is bound to another Story.','ACTIVE_SUBJECT_MISMATCH');cancelled(signal);
      const context=Object.freeze({subject:{kind:'story',id:workId},phase:input.phaseId});contexts.set(context,{input,parameters:parameters(input)});return context;
    },
    async retained(context,_input,{signal}={}){return acknowledged(selected(context),signal);},
    async prepare(context,_input,{signal}={}) {
      const s=selected(context);if(!runtime)throw error('New source retention requires its machine-local authored generation.','ENGINE_PORT_UNAVAILABLE',{
        operation:'phase.source.retain',required:['machine-local-working-store']});
      const draft=await runtime.captureDraft(s.input.phaseId,{signal});s.admission=await runtime.admitDraft(draft,'phase.source.retain',{signal});
      const facts=runtime.draftFacts(s.admission),captured=await observer.capture({signal}),phase=captured.snapshot.workflow.phases[s.input.phaseId];
      if(captured.snapshot.revision!==facts.revision)throw error('The Story changed before source retention.','ENGINE_CONTEXT_CHANGED');
      if(!phaseRequiresCodeDelivery(phase)||!facts.payload.generationIntent)throw error('Prepare an actual code generation before retaining its changed source.','ENGINE_SOURCE_GENERATION_REQUIRED',{
        phase:s.input.phaseId,operation:'phase.prepare'});
      const original=await reader.intent(s.input,{signal});
      if(original){s.plan=checked(original.plan,s);s.reference=original.reference;s.prepared=original;
        if(!same(s.plan.draft,runtime.draftIdentity(draft))||s.plan.basis.headVersion!==facts.revision||!same(s.plan.actor,{actor:facts.actor,agentId:facts.agentId})) {
          throw error('The prepared source intent belongs to another draft or author; select a new operation for the current draft.','ENGINE_CONTEXT_CHANGED');
        }
        await fresh(s,signal);for(const source of s.plan.sources)boundReader(source);
      }else{
        const {selected:selection,repositories}=await observations.generation(captured.snapshot.workflow,facts.payload,signal);
        const currentSources=[];
        for(const repository of repositories){
          const observed=await observations.capture(repository,signal),bound=readers.get(repository.id)??null;
          // Reader requirements are checked against actual changed application files below; pure
          // deletions and empty files do not require a content-capable physical checkout.
          if(bound&&!same(bound.descriptor.source,repository.descriptor))throw error('The content reader changed its selected repository.','ENGINE_SOURCE_CONTENT_READER_UNAVAILABLE',{repositoryId:repository.id});
          currentSources.push({repository,observed,bound});
        }
        const generation=runtime.generationIntentBytes(s.admission);
        if(!generation||hash(generation)!==facts.payload.generationIntent.record.sha256)throw error('The code generation lost its exact retained source intent.','ENGINE_STORAGE_CORRUPT');
        const sources=[];
        for(const {repository,observed,bound}of currentSources)sources.push({repository,observed:{revision:observed.revision,
          content:await shared(Buffer.from(canonicalJson(observed.snapshot)),'runtime',signal)},reader:bound?.descriptor??null});
        s.plan=sourceRetentionRecord('plan',{profile:NAMESPACE_SOURCE_RETENTION_PROFILE,binding:codec.binding,input:s.input,parametersSha256:s.parameters,
          generation:facts.payload.generation,draft:runtime.draftIdentity(draft),artifact:facts.payload.artifact.current,actor:{actor:facts.actor,agentId:facts.agentId},
          basis:{authorityVersion:captured.basis.authorityVersion,headVersion:captured.basis.headVersion,configurationVersion:captured.basis.configurationVersion,
            configuration:captured.snapshot.configuration,head:captured.basis.head},
          generationIntent:{id:facts.payload.generationIntent.id,reference:await shared(generation,'runtime',signal)},sourceBinding:{operationId:selection.operationId},sources});
        s.prepared={plan:s.plan,workflow:captured.snapshot.workflow,definition:facts.definition};
        for(const source of sources){const projection=await reader.projected(s.prepared,source,signal);
          if(projection.entries.some(entry=>entry.after?.bytes>0)&&source.reader===null)throw error('Bind a source content reader for changed file bytes.','ENGINE_SOURCE_CONTENT_READER_UNAVAILABLE',{
            repositoryId:source.repository.id,operation:'phase.source.retain'});}
        s.reference=await shared(Buffer.from(canonicalJson(s.plan)),'runtime',signal);s.prepared.reference=s.reference;await fresh(s,signal);
        const tx=codec.transaction(s.plan,s.reference,{intent:true});
        try{codec.receipt(await transact(scope,tx,{signal}),tx);}
        catch(cause){if(!['SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
          const concurrent=await reader.intent(s.input,{signal});if(!concurrent||!same(concurrent.plan,s.plan))throw cause;}
      }
      const token=Object.freeze({});prepared.set(token,context);return token;
    },
    async collect(context,token,{signal}={}) {
      if(prepared.get(token)!==context)throw error('Use the issued source-retention preparation.');const s=selected(context),repositories=[],totals=emptySourceRetentionTotals();
      for(const source of s.plan.sources){cancelled(signal);const projection=await reader.projected(s.prepared,source,signal),entries=[];let chunkCount=0;
        for(const entry of projection.entries){const chunks=[];
          if(entry.after!==null){const digest=createHash('sha256');let offset=0;totals.files++;const bound=boundReader(source);
            while(offset<entry.after.bytes){cancelled(signal);if(++chunkCount>SOURCE_RETENTION_MAXIMUM_CHUNKS)throw error('The repository exceeds its bounded source chunk set.','ENGINE_STORAGE_LIMIT');
              const request={entry:{path:entry.newPath,...entry.after},offset,maximumBytes:Math.min(bound.descriptor.maximumChunkBytes,maximumContentBytes,1_048_576,entry.after.bytes-offset)};
              const result=sourceContentReadResult(await bound.read(request,{signal}),request,bound.descriptor),data=Buffer.from(result.data);
              digest.update(data);chunks.push(await shared(data,'evidence',signal));offset+=data.byteLength;totals.chunks++;
            }
            if(digest.digest('hex')!==entry.after.sha256)throw error('Read bytes do not match the selected source snapshot; the draft is preserved.','ENGINE_SOURCE_CHANGED',{
              repositoryId:source.repository.id,path:entry.newPath,stage:'retain-bytes'});totals.bytes+=offset;
          }
          entries.push({...entry,chunks});totals[entry.status==='A'?'added':entry.status==='D'?'removed':'modified']++;
        }
        totals.protectedChanges+=projection.protectedChanges;totals.boundaryViolations+=projection.boundaryViolations;
        const body=sourceRetentionRecord('repository',{profile:NAMESPACE_SOURCE_RETENTION_PROFILE,plan:s.reference,id:source.repository.id,
          baselineRevision:source.repository.revision,observedRevision:source.observed.revision,selection:'changed-application-paths/v1',...projection,entries});
        repositories.push({id:source.repository.id,manifest:await shared(Buffer.from(canonicalJson(body)),'evidence',signal)});
      }
      const body=sourceRetentionRecord('result',{profile:NAMESPACE_SOURCE_RETENTION_PROFILE,plan:s.reference,recordedAt:projectEnrollmentTimestamp(await now()),repositories,totals});
      const reference=await shared(Buffer.from(canonicalJson(body)),'evidence',signal),issued=Object.freeze({});collected.set(issued,{context,reference});return issued;
    },
    async commit(context,token,{signal}={}) {
      const completed=collected.get(token);if(!completed||completed.context!==context)throw error('Use the completed source-retention collection.');const s=selected(context);
      for(let attempt=0;attempt<8;attempt++){
        const accepted=await acknowledged(s,signal);if(accepted)return accepted;await fresh(s,signal);
        const prior=await observer.record('evidence',codec.indexKey(s.plan),false,signal,true);
        if(prior){const index=codec.index(prior.value),saved=await observer.record('evidence',index.manifestKey,true,signal);
          if(!saved)throw error('The source index lost its accepted result metadata.','ENGINE_STORAGE_CORRUPT');
          const previous=await reader.accepted({workId,phaseId:saved.value.phase,operationId:saved.value.operationId},{signal});
          if(!previous||codec.indexKey(previous.plan)!==codec.indexKey(s.plan))throw error('The source index points to another generation.','ENGINE_STORAGE_CORRUPT');}
        const tx=codec.transaction(s.plan,completed.reference,{previousIndexVersion:prior?.version??null});
        try{codec.receipt(await transact(scope,tx,{signal}),tx);return {...await reader.accepted(s.input,{signal}),replayed:false};}
        catch(cause){if(!['SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;}
      }throw error('The source index changed beyond the bounded acceptance retry.','ENGINE_CONTEXT_CHANGED');
    },
    async finish(context,accepted){const s=selected(context);if(!accepted?.record||!same(accepted.plan.input,s.input))throw error('Use this source operation\'s accepted receipt.','ENGINE_PORT_RESULT_INVALID');
      return {workId,phase:s.input.phaseId,operationId:s.input.operationId,generation:accepted.plan.generation,record:accepted.record,
        recordedAt:accepted.body.recordedAt,principalId:accepted.plan.actor.actor.principalId,replayed:accepted.replayed,
        repositories:accepted.body.repositories,totals:accepted.body.totals};}
  };
}
export function createNamespaceSourceRetentionEngine(options={}) {
  const runtime=options.localRecords&&options.localContent?createNamespacePreparationRuntime(options):null;
  return createEngine({ports:{...(runtime?.ports??{}),phaseSourceRetention:createNamespaceSourceRetentionPort(options,runtime)}});
}
