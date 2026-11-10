/** Retain an explicitly supplied output. Never discover files, approve a criterion or change code. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {phaseAccessIdentity} from '../kernel/phase-preparation.mjs';
import {phaseOutputSelection,phaseOutputPathKey,PHASE_OUTPUT_LIMITS} from '../kernel/phase-outputs.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {namespaceScope,namespaceIdentifier,namespaceJson} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {createNamespaceLocalContentReader} from './namespace-local-content-reader.mjs';
import {createNamespaceSourceObservations} from './namespace-source-observations.mjs';
import {createNamespaceOutputRetentionReader} from './namespace-output-retention-reader.mjs';
import {outputRetentionRecord,NAMESPACE_OUTPUT_RETENTION_PROFILE} from './namespace-output-retention-contract.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex'),same=(a,b)=>canonicalJson(a)===canonicalJson(b),
  error=(message,code='ENGINE_INPUT_INVALID',details=null)=>new SingularityFlowError(message,{code,details});
function cancelled(signal){if(signal?.aborted)throw error('Output retention was cancelled; the draft and accepted outputs remain preserved.','ENGINE_OPERATION_CANCELLED');}
export function createNamespaceOutputRetentionPort(options={},runtime=null){
  const {records,content,access,clock}=options,scope=namespaceScope(options.scope),workId=namespaceIdentifier(options.workId),
    reader=createNamespaceOutputRetentionReader({...options,scope,workId}),{observer,codec}=reader,
    observations=createNamespaceSourceObservations({observer,sources:options.sources,scope}),
    local=createNamespaceLocalContentReader({content:options.localContent,scope}),contexts=new WeakMap(),prepared=new WeakMap(),collected=new WeakMap();
  if(typeof access?.current!=='function'||typeof clock?.now!=='function')throw error('Output retention needs explicit access and clock ports.');
  const current=access.current.bind(access),now=clock.now.bind(clock),put=content.put.bind(content),transact=records.transact.bind(records),
    selected=context=>{const found=contexts.get(context);if(!found)throw error('Use this issued output-retention context.');return found;},
    parameters=input=>hash(canonicalJson({input,binding:codec.binding}));
  function checked(plan,s){if(plan.parametersSha256!==s.parameters||!same(plan.input,s.input))throw error('This operation ID belongs to another output request.','ENGINE_OPERATION_ID_REUSED');return plan;}
  async function acknowledged(s,signal){const accepted=await reader.accepted(s.input,{signal});if(!accepted)return null;checked(accepted.plan,s);cancelled(signal);
    const identity=phaseAccessIdentity(namespaceJson(await current({projectId:scope.projectId,workId,operation:'phase.output.retain',signal})),scope.projectId);
    if(!same(identity.actor,accepted.plan.actor.actor))throw error('Acknowledge retained output under its original authenticated person.','ENGINE_ACTOR_CHANGED');return {...accepted,replayed:true};}
  async function fresh(s,signal){cancelled(signal);await runtime.revalidateDraft(s.admission,{signal});
    for(const source of s.source?.plan.sources??[]){const captured=await observations.capture(source.repository,signal);
      if(captured.revision!==source.observed.revision)throw error('The application changed after output preparation. Retain fresh source and output.','ENGINE_OUTPUT_SOURCE_CHANGED',{
        actions:[{operation:'phase.source.retain',inputs:{workId,phaseId:s.input.phaseId}},{operation:'phase.output.retain',inputs:{workId,phaseId:s.input.phaseId,path:s.input.path}}],newOperationRequired:true});}}
  async function shared(bytes,namespace,signal){const expected={namespace,sha256:hash(bytes),bytes:bytes.byteLength},saved=await put(scope,namespace,bytes,{signal});
    if(!same(contentReference(saved?.reference),expected)||typeof saved.reused!=='boolean')throw error('The content store returned another output.','ENGINE_PORT_RESULT_INVALID');
    await observer.bytes(expected,expected.bytes,signal);return expected;}
  async function budget(plan,prior,signal){let total=plan.input.content.bytes,count=1;
    for(const row of prior?.value.entries??[]){if(row.path===plan.input.path)continue;
      if(phaseOutputPathKey(row.path)===phaseOutputPathKey(plan.input.path))throw error('Use the existing exact logical output path; case variants would collide on a portable checkout.',
        'ENGINE_OUTPUT_PATH_CONFLICT',{path:plan.input.path,existingPath:row.path,newOperationRequired:true,actions:[{operation:'phase.output.retain',
          inputs:{workId,phaseId:plan.input.phaseId,path:row.path},requiredInputs:['operationId','content']}]});
      const found=await reader.byKey(row.manifestKey,{signal});
      if(found.plan.selection.phase!==plan.selection.phase||found.plan.selection.generation!==plan.selection.generation||found.plan.input.path!==row.path)throw error('The prior output index substituted its generation or path.','ENGINE_STORAGE_CORRUPT');
      total+=found.body.content.bytes;count++;}
    if(count>PHASE_OUTPUT_LIMITS.files||total>PHASE_OUTPUT_LIMITS.totalBytes)throw error('Retained outputs exceed the per-generation file or byte bound.','ENGINE_STORAGE_LIMIT');}
  return {
    async load(input,{signal}={}){cancelled(signal);if(input.workId!==workId)throw error('Output retention is bound to another Story.','ACTIVE_SUBJECT_MISMATCH');
      const context=Object.freeze({subject:{kind:'story',id:workId},phase:input.phaseId});contexts.set(context,{input,parameters:parameters(input)});return context;},
    async retained(context,_input,{signal}={}){return acknowledged(selected(context),signal);},
    async prepare(context,_input,{signal}={}){const s=selected(context);if(!runtime)throw error('Retaining new output requires the actual open authored generation.','ENGINE_PORT_UNAVAILABLE',{
        operation:'phase.output.retain',required:['machine-local-working-store']});
      const draft=await runtime.captureDraft(s.input.phaseId,{signal});s.admission=await runtime.admitDraft(draft,'phase.output.retain',{signal});
      const facts=runtime.draftFacts(s.admission),captured=await observer.capture({signal}),selection=phaseOutputSelection(facts.definition,captured.snapshot.workflow,{phaseId:s.input.phaseId,path:s.input.path});
      if(captured.snapshot.revision!==facts.revision||selection.generation!==facts.payload.generation)throw error('The Story changed before output preparation.','ENGINE_CONTEXT_CHANGED');
      s.source=selection.sourceRequired?await reader.sources.inspectDraft({phaseId:s.input.phaseId,generation:selection.generation,baseRevision:facts.revision,
        draft:runtime.draftIdentity(draft),artifact:facts.payload.artifact.current,configuration:captured.snapshot.configuration},{signal}):null;
      if(selection.sourceRequired&&!s.source)throw error('Retain this actual Code source before attaching its output.','ENGINE_SOURCE_EVIDENCE_REQUIRED',{
        actions:[{operation:'phase.source.retain',inputs:{workId,phaseId:s.input.phaseId}}]});
      const original=await reader.intent(s.input,{signal});
      if(original){s.plan=checked(original.plan,s);s.reference=original.reference;
        if(!same(s.plan.draft,runtime.draftIdentity(draft))||s.plan.basis.headVersion!==facts.revision
          ||!same(s.plan.actor,{actor:facts.actor,agentId:facts.agentId})||!same(s.plan.source,s.source?.binding??null))throw error('Resume this intent on its original unchanged generation, or select a new operation.','ENGINE_CONTEXT_CHANGED');
      }else{s.plan=outputRetentionRecord('plan',{profile:NAMESPACE_OUTPUT_RETENTION_PROFILE,binding:codec.binding,input:s.input,parametersSha256:s.parameters,
          selection,draft:runtime.draftIdentity(draft),artifact:facts.payload.artifact.current,actor:{actor:facts.actor,agentId:facts.agentId},
          basis:{authorityVersion:captured.basis.authorityVersion,headVersion:captured.basis.headVersion,configurationVersion:captured.basis.configurationVersion,
            configuration:captured.snapshot.configuration,head:captured.basis.head},source:s.source?.binding??null});
        s.reference=await shared(Buffer.from(canonicalJson(s.plan)),'runtime',signal);await fresh(s,signal);const tx=codec.transaction(s.plan,s.reference,{intent:true});
        try{codec.receipt(await transact(scope,tx,{signal}),tx);}catch(cause){if(!['SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
          const concurrent=await reader.intent(s.input,{signal});if(!concurrent||!same(concurrent.plan,s.plan))throw cause;}}
      await fresh(s,signal);const token=Object.freeze({});prepared.set(token,context);return token;},
    async collect(context,token,{signal}={}){if(prepared.get(token)!==context)throw error('Use the issued output preparation.');const s=selected(context);await fresh(s,signal);
      const bytes=s.input.content.namespace==='local'?await local(s.input.content,{signal}):await observer.bytes(s.input.content,s.input.content.bytes,signal),
        retained=await shared(bytes,'evidence',signal),body=outputRetentionRecord('result',{profile:NAMESPACE_OUTPUT_RETENTION_PROFILE,plan:s.reference,
          recordedAt:projectEnrollmentTimestamp(await now()),content:retained}),reference=await shared(Buffer.from(canonicalJson(body)),'evidence',signal),issued=Object.freeze({});
      collected.set(issued,{context,reference});return issued;},
    async commit(context,token,{signal}={}){const completed=collected.get(token);if(!completed||completed.context!==context)throw error('Use the completed output collection.');const s=selected(context);
      for(let attempt=0;attempt<8;attempt++){const accepted=await acknowledged(s,signal);if(accepted)return accepted;await fresh(s,signal);
        const row=await observer.record('evidence',codec.indexKey(s.plan.selection),false,signal,true),previousIndex=row?{version:row.version,value:codec.index(row.value)}:null;
        await budget(s.plan,previousIndex,signal);const tx=codec.transaction(s.plan,completed.reference,{previousIndex});
        try{codec.receipt(await transact(scope,tx,{signal}),tx);return {...await reader.accepted(s.input,{signal}),replayed:false};}
        catch(cause){if(!['SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;}}
      throw error('The output index changed beyond its bounded acceptance retry.','ENGINE_CONTEXT_CHANGED');},
    async finish(context,accepted){const s=selected(context);if(!accepted?.record||!same(accepted.plan.input,s.input))throw error('Use the exact accepted output receipt.','ENGINE_PORT_RESULT_INVALID');
      return {workId,phase:s.input.phaseId,operationId:s.input.operationId,generation:accepted.plan.selection.generation,recordedAt:accepted.body.recordedAt,
        principalId:accepted.plan.actor.actor.principalId,record:accepted.record,replayed:accepted.replayed,path:s.input.path,content:accepted.body.content};}
  };
}
