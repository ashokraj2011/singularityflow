/** Registered data coordination. SGOS owns attempts; SDA owns conditional acceptance. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,admitRecordSchemaVersion,WORK_PRODUCT_SCHEMAS} from '../foundation/record-schema.mjs';
import {captureExecutionUnit} from '../foundation/execution-unit-port.mjs';
import {phaseNeedsGeneration} from '../kernel/phase-policy.mjs';
import {phaseAccessIdentity,phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {workProductMutationRequest} from '../kernel/work-products.mjs';
import {createAgentTaskContract,validateExecutionUnitManifest,sha256} from '../sgos/node-execution-values.mjs';
import {sqliteDataRequest,sqliteDataObservation} from '../sgos/sql-data-values.mjs';
import {createNamespaceSgosOperationalStore} from '../sgos/namespace-operational-store.mjs';
import {createDurableExecutionUnit} from '../sgos/durable-execution-unit.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {namespaceTransaction} from '../sda/namespace/transaction.mjs';
import {exactObject,namespaceIdentifier} from '../sda/namespace/values.mjs';
import {namespaceJournalReceipt} from '../sda/namespace/journal-contract.mjs';
import {LIFECYCLE_AUTHORITY_KEY} from './namespace-lifecycle-contract.mjs';
import {namespaceLifecycleStoryKey} from './namespace-lifecycle-reader.mjs';
import {namespaceApprovedWorkProductInputs} from './namespace-work-product-inputs.mjs';
import {dataExecutionKey,dataExecutionStoreId} from './namespace-data-reader.mjs';
const hash=v=>createHash('sha256').update(typeof v==='string'||v instanceof Uint8Array?v:canonicalJson(v)).digest('hex'),same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const fail=(message,code='ENGINE_INPUT_INVALID',details=null)=>{throw new SingularityFlowError(message,{code,details});};
const cancelled=signal=>{if(signal?.aborted)fail('Data execution was cancelled; retain and reconcile its original attempt.','ENGINE_OPERATION_CANCELLED');};
export function createNamespaceDataExecutionPort(options,{observer,owned,mutation}){
  const {records,content,scope,workId,access,clock,data}=options,contexts=new WeakMap(),plans=new WeakMap(),completed=new WeakMap(),units=new Map(),signals=new Map();
  const retainedOnly=data?.mode==='retained-only';
  if(!data||typeof data!=='object'||(retainedOnly?Object.keys(data).some(k=>k!=='mode'):Object.keys(data).some(k=>!['owner','bindings'].includes(k))||!Array.isArray(data.bindings)||data.bindings.length>64))
    fail('Bind explicit data execution adapters and an execution owner.');
  const history=createNamespaceSgosOperationalStore({records,content,scope,storeId:dataExecutionStoreId(scope,workId)});
  for(const binding of data.bindings??[]){
    if(!binding||Object.keys(binding).sort().join(',')!=='adapterId,unit'||units.has(binding.adapterId))fail('Each data adapter has one explicit binding.');
    const unit=captureExecutionUnit(binding.unit),manifest=validateExecutionUnitManifest(unit.descriptor());
    if(manifest.id!==binding.adapterId||manifest.provider!=='deterministic-sqlite'||manifest.models.length||manifest.toolPolicy.profile!=='sflow-sql-data-execution/v1')
      fail('Data execution requires its deterministic SQL adapter.','ENGINE_DATA_BINDING_INVALID');
    units.set(binding.adapterId,{unit,manifest,inspect:typeof binding.unit.inspectBatch==='function'?binding.unit.inspectBatch.bind(binding.unit):null,runtime:createDurableExecutionUnit({unit:{...unit,start:contract=>unit.start(contract,{signal:signals.get(contract.contractSha256)??null})},
      store:history,content,scope,owner:data.owner,clock})});
  }
  const state=context=>{const value=contexts.get(context);if(!value)fail('Use the issued data context.');return value;};
  async function authorize(s,signal){cancelled(signal);const facts=await access.current({projectId:scope.projectId,workId,operation:'data.execute',signal}),identity=phaseAccessIdentity(facts,scope.projectId);
    phaseTransitionAccess(facts,scope.projectId,'data.execute',{expected:{actor:s.binding.actor,agentId:s.binding.agentId}});return identity;}
  async function fresh(s,signal){await authorize(s,signal);const captured=await observer.capture({signal});
    if(captured.snapshot.revision!==s.binding.revision)fail('The data execution basis changed. Preserve its original attempt.','ENGINE_CONTEXT_CHANGED');
    return captured;}
  async function save(value,signal){cancelled(signal);const bytes=Buffer.from(canonicalJson(value)),reference={namespace:'evidence',sha256:hash(bytes),bytes:bytes.byteLength},saved=await content.put(scope,'evidence',bytes,{signal});
    if(!same(contentReference(saved?.reference),reference)||typeof saved.reused!=='boolean')fail('The content store acknowledged different data bytes.','ENGINE_PORT_RESULT_INVALID');
    await observer.bytes(reference,reference.bytes,signal);return reference;}
  async function originalIndex(index,indexKey,signal){
    const value=index.value;admitRecordSchemaVersion(WORK_PRODUCT_SCHEMAS.activeIntent,value);
    exactObject(value,['schemaVersion','profile','operationId','request']);namespaceIdentifier(value.operationId);
    if(value.profile!=='sflow-active-data-intent/v1'||!same(value.request,workProductMutationRequest('data.execute',value.request)))fail('The active data index has another request binding.','ENGINE_STORAGE_CORRUPT');
    const key=dataExecutionKey(scope,workId,value.operationId)+'/intent',intent=await observer.record('runtime',key,true,signal,true);
    if(!intent||!same(intent.value.request,value.request)||intent.value.phase!==value.request.phaseId)fail('The active data index lost its original immutable intent.','ENGINE_STORAGE_CORRUPT');
    const operationId='data-intent-'+hash({scope,workId,id:value.operationId}),observed=await records.inspectOperation(scope,operationId,{signal});
    if(observed?.status!=='committed')fail('The active data index needs its original accepted transaction.','ENGINE_STORAGE_CORRUPT');
    const receipt=namespaceJournalReceipt(observed.receipt,scope,operationId);
    for(const [entryKey,entry]of [[indexKey,index],[key,intent]])if(receipt.records.find(row=>row.namespace==='runtime'&&row.key===entryKey)?.version!==entry.version)
      fail('The active data index differs from its original transaction revision.','ENGINE_STORAGE_CORRUPT');
  }
  async function persist(s,suffix,value,captured,{signal}={}){
    const key=dataExecutionKey(scope,workId,s.input.operationId)+'/'+suffix,prior=await observer.record('runtime',key,true,signal,true);
    if(prior){if(!same(prior.value,value))fail('This data operation has a different retained intent.','ENGINE_OPERATION_ID_REUSED');return;}
    const extraConditions=[],extraChanges=[];
    if(suffix==='intent'){
      const indexKey='work-products/data-active/'+hash({scope,workId,phase:value.phase,generation:value.generation}),index=await observer.record('runtime',indexKey,false,signal,true);
      const genesisKey=indexKey+'/genesis',genesis=await observer.record('runtime',genesisKey,true,signal,true);
      if(genesis){admitRecordSchemaVersion(WORK_PRODUCT_SCHEMAS.intentGenesis,genesis.value);exactObject(genesis.value,['schemaVersion','profile','operationId']);namespaceIdentifier(genesis.value.operationId);
        if(genesis.value.profile!=='sflow-data-intent-genesis/v1')fail('The original data-attempt claim has another profile.','ENGINE_STORAGE_CORRUPT');}
      if(genesis&&!index)fail('The data-attempt index is missing but its original claim is retained. Reconcile that attempt instead of launching another.','ENGINE_DATA_EXECUTION_PENDING',{operationId:genesis.value.operationId,automaticRetry:false});
      if(index&&!genesis)fail('The data-attempt index lost its original claim.','ENGINE_STORAGE_CORRUPT');
      if(index)await originalIndex(index,indexKey,signal);
      if(!genesis){extraConditions.push({namespace:'runtime',key:genesisKey,version:null});extraChanges.push({op:'put',namespace:'runtime',key:genesisKey,immutable:true,value:{schemaVersion:1,profile:'sflow-data-intent-genesis/v1',operationId:s.input.operationId}});}
      if(index&&index.value.operationId!==s.input.operationId){
        const previous=await owned.dataReader().record(index.value.operationId,{signal});
        if(!previous)fail('Reconcile the original data attempt before starting another in this phase.','ENGINE_DATA_EXECUTION_PENDING',{
          operationId:index.value.operationId,automaticRetry:false,actions:[{operation:'data.execute',inputs:{workId,phaseId:value.phase,operationId:index.value.operationId,...index.value.request}}]});
        if(previous.actual.output.effect==='unknown'&&(value.request.batchId!==previous.report.batchId||value.input.sha256!==previous.report.input.sha256)){
          if(!s.executor.inspect)fail('Bind the original sink inspector before changing an uncertain batch.','ENGINE_PORT_UNAVAILABLE',{required:['data-sink-reconciliation'],operationId:index.value.operationId});
          await authorize(s,signal);const observation=await s.executor.inspect({contract:previous.report.contract,signal});
          admitRecordSchemaVersion(WORK_PRODUCT_SCHEMAS.sinkObservation,observation);
          if(observation?.profile!=='sflow-sql-data-sink-observation/v1'||!['absent','committed'].includes(observation.status)
            ||observation.projectId!==scope.projectId||observation.executionUnitManifestSha256!==previous.report.manifest.manifestSha256
            ||observation.sinkId!==previous.report.manifest.toolPolicy.sinkId||!Number.isFinite(Date.parse(observation.observedAt))||observation.contractSha256!==previous.report.contract.contractSha256||observation.batchId!==previous.report.batchId
            ||observation.requestSha256!==previous.input.requestSha256)fail('The sink inspector returned another original batch binding.','ENGINE_PORT_RESULT_INVALID');
          if(observation.status==='committed'&&value.request.batchId===previous.report.batchId)fail('This batch ID is already committed with another transformation. Review it and select a distinct batch ID for a new logical batch.','DATA_BATCH_ID_REUSED',{
            batchId:value.request.batchId,observation,actions:[{operation:'work-product.context',inputs:{workId,phaseId:value.phase}}]});
          value.reconciliation={previous:previous.reference,observation:await save(observation,signal)};
        }
      }
      extraConditions.push({namespace:'runtime',key:indexKey,version:index?.version??null});extraChanges.push({op:'put',namespace:'runtime',key:indexKey,immutable:false,
        value:{schemaVersion:1,profile:'sflow-active-data-intent/v1',operationId:s.input.operationId,request:value.request}});
    }
    const tx=namespaceTransaction({operationId:'data-'+suffix+'-'+hash({scope,workId,id:s.input.operationId}),preconditions:[
      {namespace:'runtime',key,version:null},{namespace:'state',key:namespaceLifecycleStoryKey(workId),version:captured.basis.headVersion},
      {namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:captured.basis.authorityVersion},...extraConditions],
      changes:[{op:'put',namespace:'runtime',key,immutable:true,value},...extraChanges],events:[]});
    // A lost acknowledgement is retried under this exact ID, never as a new external attempt.
    try{await records.transact(scope,tx,{signal});}
    catch(cause){const actual=await observer.record('runtime',key,true,null,true);if(!actual||!same(actual.value,value))throw cause;}
  }
  return {
    async load(input,{signal}={}){const context=await mutation.load(input,{signal});contexts.set(context,{input,binding:mutation.binding(context)});return context;},
    async retained(context,input,{signal}={}){const s=state(context);if(!s.binding.replay)return null;
      const intent=await mutation.prepare(context,input,{signal}),accepted=await mutation.commit(context,intent,{signal});return mutation.finish(context,intent,accepted);},
    async prepare(context,input,{signal}={}){
      const s=state(context);if(!same(input,s.input))fail('Use the original data request.');const captured=await fresh(s,signal),selected=await owned.context(captured.snapshot,input.phaseId,{signal});
      if(captured.snapshot.workflow.currentPhase!==input.phaseId||!selected.phase.execution)fail('Select the current declared data phase.','ENGINE_PHASE_UNAVAILABLE');
      if(!phaseNeedsGeneration(captured.snapshot.workflow,captured.snapshot.workflow.phases[input.phaseId]))fail('This generation is already published. Review its retained data outcome.','PHASE_ALREADY_PUBLISHED',{actions:[{operation:'phase.review',inputs:{workId,phaseId:input.phaseId}}]});
      if(selected.contextSha256!==input.expected)fail('The data input binding changed.','ENGINE_CONTEXT_CHANGED');
      if(selected.missing.length)fail('Retain and approve the declared data inputs.','ENGINE_DATA_INPUT_REQUIRED',{missing:selected.missing});
      await namespaceApprovedWorkProductInputs({observer,scope,workId},captured.snapshot,selected,{signal});
      const execution=selected.phase.execution,bound=units.get(execution.adapterId);
      s.executor=bound;
      if(execution.kind==='query'&&input.batchId!=null||execution.kind==='batch'&&input.batchId==null)fail('Batch execution requires its stable batch ID; a query has no batch ID.');
      const previous=await observer.record('runtime',dataExecutionKey(scope,workId,input.operationId)+'/intent',true,signal,true);
      let intent,retained=null;
      if(previous){
        intent=previous.value;admitRecordSchemaVersion(WORK_PRODUCT_SCHEMAS.transaction,intent);
        if(intent.profile!=='sflow-namespace-data-intent/v1'||!same(intent.request,workProductMutationRequest('data.execute',input))
          ||!same(intent.actor,s.binding.actor)||intent.agentId!==s.binding.agentId||intent.contextSha256!==selected.contextSha256
          ||!same(intent.configuration,captured.snapshot.configuration)||intent.revision!==captured.snapshot.revision)
          fail('This data operation has another retained intent.','ENGINE_OPERATION_ID_REUSED');
        retained=await owned.dataReader().record(input.operationId,{signal});
        if(!retained&&bound&&!same(intent.manifest,bound.manifest))fail('The unfinished attempt needs its original qualified executor. Preserve and reconcile it before changing the runtime.','ENGINE_DATA_EXECUTOR_CHANGED',{
          required:['original-data-executor-or-completed-sgos-evidence'],operationId:input.operationId,automaticRetry:false});
      }
      if(!retained){
        if(retainedOnly)fail('This host can finish completed retained data evidence only. Bind the original executor for an unfinished or new run.','ENGINE_PORT_UNAVAILABLE',{required:['data-execution-binding'],mode:'retained-only'});
        if(!bound)fail('Bind the approved deterministic data executor.','ENGINE_PORT_UNAVAILABLE',{required:['data-executor'],adapterId:execution.adapterId});
        if(bound.manifest.capabilities[execution.kind]!==true)fail('The bound adapter lacks the declared data capability.','ENGINE_PORT_UNAVAILABLE',{adapterId:execution.adapterId,kind:execution.kind});
      }
      if(!previous){
        const query=selected.assets.find(row=>row.asset.id===execution.query),datasets=[];
        if(query.asset.content.bytes+execution.inputs.reduce((total,item)=>total+selected.assets.find(row=>row.asset.id===item.assetId).asset.content.bytes,0)>4*1024*1024)
          fail('The declared complete data input exceeds the SQL task limit.','ENGINE_WORK_PRODUCT_LIMIT');
        for(const spec of execution.inputs){const row=selected.assets.find(row=>row.asset.id===spec.assetId);datasets.push({table:spec.table,data:await owned.json(row.asset.content,signal)});}
        const task=sqliteDataRequest({kind:execution.kind,query:new TextDecoder('utf-8',{fatal:true}).decode(await observer.bytes(query.asset.content,query.asset.content.bytes,signal)),datasets,batchId:input.batchId??null}),
          taskInput=await save(task,signal),contract=createAgentTaskContract({taskId:'data-'+hash({scope,workId,id:input.operationId}).slice(0,48),processId:'data-workflow',instructionId:'approved-data-phase',
            objective:'Execute the exact retained query and immutable datasets.',acceptanceClauses:selected.phase.criteria.map(c=>c.id),policySnapshotSha256:'sha256:'+selected.binding.policySha256,
            programSha256:sha256(execution),inputs:['evidence:'+taskInput.sha256+':'+taskInput.bytes],readScope:selected.assets.map(row=>'asset:'+row.asset.id),
            writeScope:execution.kind==='batch'?['sink:'+bound.manifest.toolPolicy.sinkId]:[],forbiddenScope:[],allowedDevices:[],environmentManifestSha256:sha256(bound.manifest),
            candidatePolicy:'immutable-snapshot',outputSchema:{type:'object'},requiredEvidence:['result'],budgets:{activeMinutes:5,modelInvocations:0,touchedResources:1},
            stopConditions:[],executionUnitManifestSha256:bound.manifest.manifestSha256});
        intent={schemaVersion:1,profile:'sflow-namespace-data-intent/v1',projectId:scope.projectId,workId,operationId:input.operationId,
          request:workProductMutationRequest('data.execute',input),contextSha256:selected.contextSha256,phase:input.phaseId,generation:selected.binding.generation,
          revision:captured.snapshot.revision,configuration:captured.snapshot.configuration,actor:s.binding.actor,agentId:s.binding.agentId,
          recordedAt:projectEnrollmentTimestamp(await clock.now()),manifest:bound.manifest,contract,input:taskInput};
        await authorize(s,signal);await persist(s,'intent',intent,captured,{signal});
      }
      const token=Object.freeze({});plans.set(token,{context,intent,bound,retained});return token;
    },
    async execute(context,plan,{signal}={}){
      const s=state(context),prepared=plans.get(plan);if(!prepared||prepared.context!==context)fail('Use this data operation\'s prepared task.');
      const {intent,bound}=prepared;await fresh(s,signal);
      let retained=prepared.retained??await owned.dataReader().record(intent.operationId,{signal});
      if(!retained){
        signals.set(intent.contract.contractSha256,signal??null);let handle;
        try{handle=await bound.runtime.start(intent.contract,{signal});}finally{signals.delete(intent.contract.contractSha256);}
        let stopping=null;
        const stop=()=>{stopping??=bound.runtime.requestStop(handle,{reason:'The data operation was cancelled.'});stopping.catch(()=>{});};
        signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
        let candidate;
        try{candidate=await bound.runtime.collect(handle);await bound.runtime.quiesce(handle);if(stopping)await stopping;}
        finally{signal?.removeEventListener('abort',stop);if(signal?.aborted){stop();await stopping;await bound.runtime.quiesce(handle);}}
        // Retain terminal truth even when later acceptance is refused by a changed Story/actor.
        let observedAt=null;for await(const event of bound.runtime.observe(handle))observedAt=event.recordedAt;
        if(!observedAt)fail('The completed data attempt lost its events.','ENGINE_STORAGE_CORRUPT');
        const output=candidate.output?.result?.data?await save(candidate.output.result.data,null):null,
          observation=await save(sqliteDataObservation({output:candidate.output,usage:candidate.usage,recordedAt:observedAt}),null),
          report={schemaVersion:1,profile:'sflow-data-execution/v1',projectId:scope.projectId,workId,operationId:intent.operationId,
            phase:intent.phase,generation:intent.generation,contextSha256:intent.contextSha256,kind:intent.request.batchId===null?'query':'batch',batchId:intent.request.batchId,
            configuration:intent.configuration,actor:intent.actor,agentId:intent.agentId,recordedAt:projectEnrollmentTimestamp(observedAt),
            manifest:intent.manifest,contract:intent.contract,input:intent.input,handle,output,observation},reference=await save(report,null);
        const captured=await observer.capture();
        // The result pointer is observational runtime data, not a successful lifecycle mutation.
        await persist(s,'result',{schemaVersion:1,profile:'sflow-namespace-data-transaction/v1',reference},captured);
        retained=await owned.dataReader().record(intent.operationId,{});
      }
      if(!retained)fail('The actual data result was not retained.','ENGINE_STORAGE_CORRUPT');cancelled(signal);
      const token=Object.freeze({});completed.set(token,{context,intent:await mutation.prepare(context,s.input,{signal})});return token;
    },
    async commit(context,token,{signal}={}){const saved=completed.get(token);if(!saved||saved.context!==context)fail('Use this data operation\'s completed result.');return mutation.commit(context,saved.intent,{signal});},
    async finish(context,token,accepted){const saved=completed.get(token);if(!saved||saved.context!==context)fail('Use this data operation\'s completed result.');return mutation.finish(context,saved.intent,accepted);}
  };
}
