/** Accept actual source-control observations through conditional namespace evidence transactions. */
import {createHash} from 'node:crypto';
import {createEngine} from '../engine-sdk/index.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {validateSourceControlReader,sourceControlObservation} from '../foundation/source-control.mjs';
import {phaseAccessIdentity} from '../kernel/phase-preparation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {namespaceScope,namespaceIdentifier,namespaceJson} from '../sda/namespace/values.mjs';
import {createNamespacePreparationRuntime} from './namespace-preparation.mjs';
import {createNamespaceSourceContent} from './namespace-source-content.mjs';
import {createNamespaceSourceControlReader} from './namespace-source-control-reader.mjs';
import {sourceControlRecord,NAMESPACE_SOURCE_CONTROL_PROFILE} from './namespace-source-control-contract.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex'),same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code='ENGINE_INPUT_INVALID',details=null)=>new SingularityFlowError(message,{code,details});
function cancelled(signal){if(signal?.aborted)throw error('Control evidence was cancelled; prepared work is preserved.','ENGINE_OPERATION_CANCELLED');}
export function createNamespaceSourceControlPort(options={},runtime=null){
  const {records,content,access,clock}=options,scope=namespaceScope(options.scope),workId=namespaceIdentifier(options.workId),reader=createNamespaceSourceControlReader({...options,scope,workId}),{observer,codec,sourceReader}=reader;
  if(typeof access?.current!=='function'||typeof clock?.now!=='function')throw error('Control evidence needs explicit access and clock capabilities.');
  const supplied=options.sourceControlReaders??[];if(!Array.isArray(supplied)||supplied.length>32)throw error('Bind a bounded explicit source-control reader list.');
  const readers=new Map(),ids=new Set();for(const port of supplied){const descriptor=validateSourceControlReader(port),id=descriptor.source.repositoryId;
    if(descriptor.source.projectId!==scope.projectId||readers.has(id)||ids.has(descriptor.id))throw error('Control readers must be distinct and project bound.');
    readers.set(id,{descriptor,capture:port.capture.bind(port)});ids.add(descriptor.id);}
  const {shared}=createNamespaceSourceContent({scope,content,observer}),transact=records.transact.bind(records),current=access.current.bind(access),now=clock.now.bind(clock);
  const contexts=new WeakMap(),prepared=new WeakMap(),collected=new WeakMap();
  const selected=context=>{const s=contexts.get(context);if(!s)throw error('Use the issued control-evidence context.');return s;};
  const parameters=input=>hash(canonicalJson({input,binding:codec.binding}));
  function checked(value,s){if(value&&(value.parametersSha256!==s.parameters||!same(value.input,s.input)))throw error('The operation ID belongs to another control request.','ENGINE_OPERATION_ID_REUSED');return value;}
  function bound(id,expected){const port=readers.get(id);if(!port||!same(port.descriptor,expected))throw error('Bind the prepared source-control reader for this repository.','ENGINE_SOURCE_CONTROL_READER_UNAVAILABLE',{
    operation:'phase.source-control.retain',repositoryId:id,readerId:expected?.id??null});return port;}
  async function capture(port,source,id,signal){cancelled(signal);const subject=reader.subject(source),answer=await port.capture(subject,{signal});cancelled(signal);
    const value=sourceControlObservation(answer?.observation,port.descriptor,subject),revision='sha256:'+hash(canonicalJson(value));
    if(answer.revision!==revision)throw error('The source-control reader returned another observation digest.','ENGINE_PORT_RESULT_INVALID');
    if(value.current.revision!==source.plan.sources.find(row=>row.repository.id===id)?.observed.revision)throw error('Source bytes changed after retention; refresh their retained evidence in this phase.','ENGINE_SOURCE_CHANGED',{
      repositoryId:id,operation:'phase.source.retain',newOperationRequired:true});
    await reader.verifyObservation(value,port.descriptor,source,{id},signal);return {value,revision};
  }
  async function acknowledge(s,signal){const saved=await reader.accepted(s.input,{signal});if(!saved)return null;checked(saved.plan,s);cancelled(signal);
    const identity=phaseAccessIdentity(namespaceJson(await current({projectId:scope.projectId,workId,operation:'phase.source.retain',signal})),scope.projectId);
    if(!same(identity.actor,saved.plan.actor.actor))throw error('Acknowledge control evidence under its original authenticated person.','ENGINE_ACTOR_CHANGED');return {...saved,replayed:true};}
  async function fresh(s,signal){cancelled(signal);await runtime.revalidateDraft(s.admission,{signal});
    const found=await sourceReader.inspectDraft(s.identity,{signal});if(!found||!same(found.binding,s.plan.source))throw error('The retained source selection changed after control preparation; select a new control operation.','ENGINE_CONTEXT_CHANGED',{
      operation:'phase.source-control.retain',newOperationRequired:true});
    for(const row of s.plan.observations){const observed=await capture(bound(row.id,row.reader),found,row.id,signal);
      if(observed.revision!==row.revision)throw error('Git/source facts changed after control preparation; preserve the intent and select a new operation.','ENGINE_SOURCE_CHANGED',{
        repositoryId:row.id,operation:'phase.source-control.retain',newOperationRequired:true});}
    await runtime.revalidateDraft(s.admission,{signal});
  }
  return {
    async load(input,{signal}={}){if(input.workId!==workId)throw error('Control evidence is bound to another Story.','ACTIVE_SUBJECT_MISMATCH');cancelled(signal);
      const context=Object.freeze({subject:{kind:'story',id:workId},phase:input.phaseId});contexts.set(context,{input,parameters:parameters(input)});return context;},
    async retained(context,_input,{signal}={}){return acknowledge(selected(context),signal);},
    async prepare(context,_input,{signal}={}){
      const s=selected(context);if(!runtime)throw error('New control evidence needs its machine-local authored generation.','ENGINE_PORT_UNAVAILABLE',{
        operation:'phase.source-control.retain',required:['machine-local-working-store']});
      const draft=await runtime.captureDraft(s.input.phaseId,{signal});s.admission=await runtime.admitDraft(draft,'phase.source.retain',{signal});
      const facts=runtime.draftFacts(s.admission);s.identity={phaseId:s.input.phaseId,generation:facts.payload.generation,baseRevision:facts.revision,
        draft:runtime.draftIdentity(draft),artifact:facts.payload.artifact.current,configuration:facts.payload.configuration};
      const source=await sourceReader.inspectDraft(s.identity,{signal});
      if(!source)throw error('Retain this generation\'s actual changed source bytes before accepting control observations.','ENGINE_SOURCE_RETENTION_REQUIRED',{
        operation:'phase.source.retain',inputs:{workId,phaseId:s.input.phaseId},requires:['operationId']});
      const original=await reader.intent(s.input,{signal});
      if(original){s.plan=checked(original.plan,s);s.reference=original.reference;
        if(!same(s.plan.source,source.binding)||!same(s.plan.draft,s.identity.draft)||!same(s.plan.actor,{actor:facts.actor,agentId:facts.agentId}))throw error('The preserved control intent belongs to another draft, source receipt or author; select a new operation.','ENGINE_CONTEXT_CHANGED');
        await fresh(s,signal);
      }else{
        const observations=[];for(const row of source.plan.sources){const port=readers.get(row.repository.id);
          if(!port||!same(port.descriptor.source,row.repository.descriptor))throw error('Bind the original repository control reader.','ENGINE_SOURCE_CONTROL_READER_UNAVAILABLE',{
            repositoryId:row.repository.id,operation:'phase.source-control.retain'});
          const captured=await capture(port,source,row.repository.id,signal);observations.push({id:row.repository.id,reader:port.descriptor,revision:captured.revision,
            content:await shared(Buffer.from(canonicalJson(captured.value)),'runtime',signal)});}
        s.plan=sourceControlRecord('plan',{profile:NAMESPACE_SOURCE_CONTROL_PROFILE,binding:codec.binding,input:s.input,parametersSha256:s.parameters,
          actor:{actor:facts.actor,agentId:facts.agentId},basis:source.plan.basis,generation:source.plan.generation,draft:source.plan.draft,source:source.binding,observations});
        s.reference=await shared(Buffer.from(canonicalJson(s.plan)),'runtime',signal);await fresh(s,signal);const tx=codec.transaction(s.plan,s.reference,{intent:true});
        try{codec.receipt(await transact(scope,tx,{signal}),tx);}catch(cause){if(!['SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
          const concurrent=await reader.intent(s.input,{signal});if(!concurrent||!same(concurrent.plan,s.plan))throw cause;}
      }
      const token=Object.freeze({});prepared.set(token,context);return token;
    },
    async collect(context,token,{signal}={}){if(prepared.get(token)!==context)throw error('Use the issued control preparation.');const s=selected(context),source=await sourceReader.accepted({workId,phaseId:s.input.phaseId,operationId:s.plan.source.operationId},{signal}),repositories=[];
      let changes=0;for(const row of s.plan.observations){const verified=await reader.readObservation(row,source,signal);
        repositories.push({id:row.id,revision:row.revision,changes:verified.changes,observation:await shared(Buffer.from(canonicalJson(verified.value)),'evidence',signal)});changes+=verified.changes;}
      const body=sourceControlRecord('result',{profile:NAMESPACE_SOURCE_CONTROL_PROFILE,plan:s.reference,recordedAt:projectEnrollmentTimestamp(await now()),
        repositories,totals:{repositories:repositories.length,changes}}),reference=await shared(Buffer.from(canonicalJson(body)),'evidence',signal),issued=Object.freeze({});
      collected.set(issued,{context,reference});return issued;},
    async commit(context,token,{signal}={}){const completed=collected.get(token);if(!completed||completed.context!==context)throw error('Use the completed control collection.');const s=selected(context);
      for(let attempt=0;attempt<8;attempt++){const existing=await acknowledge(s,signal);if(existing)return existing;await fresh(s,signal);
        const prior=await observer.record('evidence',codec.indexKey(s.plan),false,signal,true);
        if(prior){const pointer=codec.index(prior.value),metadata=await observer.record('evidence',pointer.manifestKey,true,signal),saved=await reader.accepted({workId,phaseId:s.input.phaseId,operationId:metadata.value.operationId},{signal});
          if(!saved||codec.indexKey(saved.plan)!==codec.indexKey(s.plan))throw error('The control index has no matching accepted generation.','ENGINE_STORAGE_CORRUPT');}
        const tx=codec.transaction(s.plan,completed.reference,{previousIndexVersion:prior?.version??null});
        try{codec.receipt(await transact(scope,tx,{signal}),tx);return {...await reader.accepted(s.input,{signal}),replayed:false};}
        catch(cause){if(!['SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;}
      }throw error('The control index changed beyond bounded acceptance retry.','ENGINE_CONTEXT_CHANGED');},
    async finish(context,accepted){const s=selected(context);if(!accepted?.record||!same(accepted.plan.input,s.input))throw error('Use this control operation\'s accepted receipt.','ENGINE_PORT_RESULT_INVALID');
      return {workId,phase:s.input.phaseId,operationId:s.input.operationId,generation:accepted.plan.generation,record:accepted.record,
        recordedAt:accepted.body.recordedAt,principalId:accepted.plan.actor.actor.principalId,replayed:accepted.replayed,repositories:accepted.body.repositories,totals:accepted.body.totals};}
  };
}
export function createNamespaceSourceControlEngine(options={}){const runtime=options.localRecords&&options.localContent?createNamespacePreparationRuntime(options):null;
  return createEngine({ports:{...(runtime?.ports??{}),phaseSourceControlRetention:createNamespaceSourceControlPort(options,runtime)}});}
