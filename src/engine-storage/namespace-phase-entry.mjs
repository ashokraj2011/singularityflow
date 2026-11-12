/** Authoring read plans over actual namespace proofs. No model prose, paths, processes or writes. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {sourceSnapshot,validateSourceUnit} from '../foundation/source-snapshot.mjs';
import {CONTENT_PHASE_ENTRY_PROFILE,TARGETED_PHASE_ENTRY_PROFILE,ARTIFACT_REPAIR_PHASE_ENTRY_PROFILE,phaseContextResources} from '../kernel/phase-entry.mjs';
import {currentEntryPhase} from '../kernel/phase-admission.mjs';
import {phaseTransitionAccess,phasePreparationOpeningAdmission,phasePreparationCatalogAdmission} from '../kernel/phase-preparation.mjs';
import {phaseExplicitlyReopened,phaseRequiresCodeDelivery,phaseKernelOwned,nextPhaseGeneration} from '../kernel/phase-policy.mjs';
import {namespaceJson} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceClarificationReader,CLARIFICATION_EVIDENCE} from './namespace-clarification-reader.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceCodeHistoryReader} from './namespace-code-history.mjs';
import {createNamespaceArtifactRepairReader} from './namespace-artifact-repair-reader.mjs';
import {createNamespaceTestRecoveryOwner} from './namespace-test-recovery-reader.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
const cancelled=signal=>{if(signal?.aborted)throw error('Phase context reading was cancelled.','ENGINE_OPERATION_CANCELLED');};

export function createNamespacePhaseEntryPorts(options,runtime=null) {
  const {scope,workId,access,localContent,records}=options,observer=createNamespaceStoryObserver(options),contexts=new WeakMap();
  const current=access.current.bind(access),local=localContent?.read.bind(localContent);
  const checks=createNamespacePhaseCheckReader({...options,observer}),publications=createNamespacePublicationReader({observer,scope,workId,checks});
  async function authorize(operation,signal,expected=null) {
    cancelled(signal);const facts=namespaceJson(await current({projectId:scope.projectId,workId,operation,signal}));cancelled(signal);
    const identity=phaseTransitionAccess(facts,scope.projectId,operation,{expected:expected?.identity??null}),permissions=[...facts.permissions].sort();
    if(expected&&!same(expected.permissions,permissions))throw error('The access permissions changed during phase entry. Restart under the current binding.','ENGINE_CONTEXT_CHANGED',{
      operation:'phase.enter',workId});
    return {identity,permissions};
  }
  async function localBytes(reference,signal) {
    if(!local)throw error('The declared local input is unavailable on this device.','ENGINE_STORAGE_CONTENT_MISSING',{reference});
    const result=await local(scope,reference,{signal,maximumBytes:reference.bytes});
    if(result?.status==='missing'&&result.data===null)throw error('The uploaded input must be supplied again on this device.','ENGINE_STORAGE_CONTENT_MISSING',{reference});
    if(result?.status!=='present'||!same(contentReference(result.reference),reference)||!(result.data instanceof Uint8Array)
      ||result.data.byteLength!==reference.bytes||result.truncated!==false||hash(result.data)!==reference.sha256)throw error('The local resource reader returned different bytes.','ENGINE_PORT_RESULT_INVALID');
    return Buffer.from(result.data);
  }
  async function load(input,signal,operation) {
    if(input.workId!==undefined&&input.workId!==null&&input.workId!==workId)throw error('Phase entry belongs to another Story.','ACTIVE_SUBJECT_MISMATCH');
    const principal=await authorize(operation,signal),captured=await observer.capture({signal}),workflow=captured.snapshot.workflow,
      phase=currentEntryPhase(workflow,input.phaseId),retained=phase.generation>0&&!phaseExplicitlyReopened(workflow,phase),generation=retained?phase.generation:nextPhaseGeneration(phase);
    const approved=await observer.approved(captured.snapshot,{signal});let draftCapture=null,draft=null;
    if(runtime){draftCapture=await runtime.captureEntryDraft(phase.id,{signal});const found=runtime.entryDraftFacts(draftCapture);
      if(found.revision!==captured.snapshot.revision||found.authorityVersion!==captured.basis.authorityVersion)throw error('The phase changed during its private observation.','ENGINE_CONTEXT_CHANGED');
      draft=found.draft;}
    const p=draft?.payload,liveSources=[],sourceBlockers=[];
    let open=p?.generation===generation&&p.baseRevision===captured.snapshot.revision
      &&same(p.configuration,captured.snapshot.configuration)&&p.generationIntent!==null&&p.sources.length>0;
    if(open)for(const repository of p.sources) {
      const unit=(options.sources??[]).find(unit=>unit.descriptor.id===repository.unitId&&unit.descriptor.repositoryId===repository.id);
      if(!unit||!same(validateSourceUnit(unit),repository.descriptor)) {open=false;sourceBlockers.push({code:'ENGINE_SOURCE_UNIT_UNAVAILABLE',
        message:'Bind the original selected source unit before application authoring.',details:{repositoryId:repository.id,unitId:repository.unitId}});continue;}
      const bytes=await observer.bytes(repository.snapshot,repository.snapshot.bytes,signal);let baseline;
      try{baseline=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
      catch(cause){throw error('The original generation source is not UTF-8 JSON.','ENGINE_STORAGE_CORRUPT',{repositoryId:repository.id},cause);}
      sourceSnapshot(baseline,repository.descriptor);
      if(repository.revision!=='sha256:'+hash(canonicalJson(baseline)))throw error('The original generation source has another digest.','ENGINE_STORAGE_CORRUPT');
      const observed=await unit.capture({signal});sourceSnapshot(observed.snapshot,repository.descriptor);
      if(observed.revision!=='sha256:'+hash(canonicalJson(observed.snapshot)))throw error('The source unit returned another context digest.','ENGINE_PORT_RESULT_INVALID');
      liveSources.push({unit,repositoryId:repository.id,revision:observed.revision});
    }
    const repairScope=!retained&&phaseRequiresCodeDelivery(phase)?await createNamespaceCodeHistoryReader({observer,scope,workId}).repairScope(captured.snapshot,phase.id,{signal}):null;
    const repairs=createNamespaceArtifactRepairReader({observer,scope,workId,publications}),repair=!retained?await repairs.active(captured.snapshot,phase.id,{signal}):null,
      artifactRepairScope=repair?repairs.description(repair):null;
    const context={manifestProfile:artifactRepairScope?ARTIFACT_REPAIR_PHASE_ENTRY_PROFILE:repairScope?TARGETED_PHASE_ENTRY_PROFILE:CONTENT_PHASE_ENTRY_PROFILE,
      ...(artifactRepairScope?{hasCodeRepair:Boolean(repairScope)}:{}),projectId:scope.projectId,paused:workflow.status==='paused',
      subject:{kind:'story',id:workId},phase:phase.id,workflow,revision:captured.snapshot.revision,
      ready:captured.snapshot.workId===workId&&phase.id===workflow.currentPhase,inspectionGeneration:generation,
      generatesCode:phaseRequiresCodeDelivery(phase),codeGenerationReady:Boolean(open),deterministic:phaseKernelOwned(phase),
      modelEnabled:options.modelEnabled??true,agentId:principal.identity.agentId};
    contexts.set(context,{captured,approved,principal,phase,retained,generation,draft,draftCapture,operation,liveSources,sourceBlockers,repairScope,artifactRepairScope,missing:[],resources:null,clarification:null,facts:null});return context;
  }
  const selected=context=>{const s=contexts.get(context);if(!s)throw error('Use the issued phase-entry observation.','ENGINE_INPUT_INVALID');return s;};
  async function build(context,signal) {
    const s=selected(context);if(s.facts)return s.facts;
    const w=s.captured.snapshot.workflow,phase=s.phase,definition=s.approved.compiled.definition,blockers=[...s.sourceBlockers];
    const captureFailure=operation=>{try{operation();}catch(cause){if(!(cause instanceof SingularityFlowError))throw cause;
      blockers.push({code:cause.code??'PHASE_CONTEXT_AUTHORING_ENTRY_REQUIRED',message:cause.message,details:cause.details??null});}};
    if(!s.retained) {captureFailure(()=>phasePreparationOpeningAdmission(w,phase));
      const testRecovery=w.resolution.testRecovery?.enabled?await createNamespaceTestRecoveryOwner({observer,scope,workId}).current(s.captured.snapshot,{signal}):null;
      captureFailure(()=>phasePreparationCatalogAdmission(definition,w,phase,s.principal.identity.agentId,{testRecovery}));}
    const missing=[];
    const clarifications=createNamespaceClarificationReader({observer,scope,workId,checks,limits:records.descriptor.limits,
      localRead:async(reference,{signal}={})=>{try{return await localBytes(reference,signal);}catch(cause){
        if(cause.code!=='ENGINE_STORAGE_CONTENT_MISSING')throw cause;missing.push({reference,cause});return null;}}});
    let plan,record=null;
    if(s.retained) {
      const binding=phase.publicationBindings?.find(item=>item.generation===phase.generation);
      if(!binding)throw error('The retained generation has no immutable publication binding.','ENGINE_STORAGE_CORRUPT');
      const publication=await publications.accepted(binding,phase.id,{signal}),checkpointBinding=publication.policyEvidence?.find(item=>item.kind===CLARIFICATION_EVIDENCE),
        checkpoint=checkpointBinding?await clarifications.json(checkpointBinding.record,signal):null;
      plan=checkpoint?{value:checkpoint.context,sha256:checkpoint.contextSha256}:await clarifications.context(s.captured,phase.id,{signal,agentId:phase.defaultAgent});
      if(checkpoint?.response)record=await clarifications.accepted(checkpoint.response.operationId,{signal});
    }else {
      plan=await clarifications.context(s.captured,phase.id,{signal,agentId:phase.defaultAgent});
      const found=await clarifications.checkpoint(plan.value,{signal});s.observedCheckpoint=found.observed;record=found.accepted;
    }
    s.clarification={workId,phase:phase.id,generation:s.generation,contextSha256:plan.sha256,
      record:record?{reference:record.reference,contextSha256:record.value.contextSha256,responses:record.value.responses,completed:record.value.completed}:null};
    const declared=plan.value.resources.map(resource=>({...resource})),documentResources=declared.filter(resource=>resource.kind==='supporting-document');
    s.missing=missing.map(({reference})=>{const document=(w.namespaceDocuments??[]).find(item=>same(item.content,reference));
      return {id:document?.id??'local-'+reference.sha256,name:document?.name??'Local input',sha256:reference.sha256};});
    const resource=(kind,id,reference,locality='project',producer=null,sourceGeneration=null)=>({
      id:'resource-'+hash(canonicalJson({kind,id,reference,phase:producer,generation:sourceGeneration})),kind,reference,locality,
      availability:missing.some(item=>same(item.reference,reference))?'reupload-required'
        :s.retained&&kind==='supporting-document'&&locality==='machine-local'?'verify-on-read':'verified',phase:producer,generation:sourceGeneration});
    const resources=declared.map(value=>resource(value.kind,value.id??value.phase,value.reference,value.locality??'project',value.phase??null,value.generation??null));
    resources.push(resource('artifact-template',plan.value.template.key,plan.value.template.reference));
    if(record)resources.push(resource('human-clarifications','human-clarifications',record.reference));
    if(s.repairScope)for(const [index,reference]of s.repairScope.references.entries())resources.push(resource('repair-scope','repair-scope-'+index,reference));
    if(s.artifactRepairScope)for(const [index,reference]of s.artifactRepairScope.references.entries())resources.push(resource('repair-scope','artifact-repair-scope-'+index,reference));
    const p=s.draft?.payload;
    if(p)resources.push(resource('current-draft',p.artifact.key,p.artifact.current,'machine-local',phase.id,p.generation));
    if(p?.generationIntent)resources.push(resource('generation-intent',p.generationIntent.id,p.generationIntent.record,'machine-local',phase.id,p.generation));
    const maximumPreview=Math.min(w.resolution.documents?.maxPreviewBytes??65536,1048576),budgets={documentPreviewBytes:maximumPreview,
      supportingTotalBytes:w.resolution.documents?.maxPromptEvidenceBytes??49152};
    s.resources=phaseContextResources(resources,{maximumBytes:maximumPreview,targetedRepair:Boolean(s.repairScope||s.artifactRepairScope)});
    const draft=p?{generation:p.generation,revision:s.draft.revision,bodySha256:s.draft.bodySha256,baseRevision:p.baseRevision,artifact:p.artifact.current,
      intent:p.generationIntent?{id:p.generationIntent.id,reference:p.generationIntent.record}:null}:null;
    const identity={schemaVersion:s.artifactRepairScope?5:2,contract:s.artifactRepairScope?ARTIFACT_REPAIR_PHASE_ENTRY_PROFILE:CONTENT_PHASE_ENTRY_PROFILE,projectId:scope.projectId,workId,phase:phase.id,generation:s.generation,
      revision:context.revision,configuration:s.captured.snapshot.configuration,authorAgentId:phase.defaultAgent??null,resources:s.resources,
      clarification:{contextSha256:plan.sha256,record:record?.reference??null},draft,budgets,sources:plan.value.sources,
      currentSources:s.liveSources.map(({repositoryId,revision})=>({repositoryId,revision})),...(s.repairScope?{repairScope:s.repairScope}:{}),...(s.artifactRepairScope?{artifactRepairScope:s.artifactRepairScope}:{})};
    const data=Buffer.from(canonicalJson(identity));s.identity={sha256:hash(data),bytes:data.byteLength};
    s.facts={workId,phase:phase.id,generation:phase.generation,inspectionGeneration:s.generation,projectId:scope.projectId,
      authoring:{entry:{status:s.retained?'retained-generation':'authoring-entry',reason:null},policyVerified:blockers.length===0,
        policyReason:blockers[0]?.code??null,hasAuthoringRoute:Boolean(phase.defaultAgent),targetGeneration:null},
      recovery:{requiresRecovery:false,actions:[],blockers:[]},references:{status:'not-configured'},deterministic:context.deterministic,
      documents:{status:missing.length?'reupload-required':'ready',localDocumentCount:documentResources.filter(value=>value.locality==='machine-local').length,
        documentCount:documentResources.length,missing:s.missing},budgets,resources,contextIdentity:s.identity,
      permissions:s.principal.permissions,draft,blockers,configuration:s.captured.snapshot.configuration,...(s.repairScope?{repairScope:s.repairScope}:{}),...(s.artifactRepairScope?{artifactRepairScope:s.artifactRepairScope}:{})};
    return s.facts;
  }
  async function fresh(context,signal) {
    const s=selected(context);await authorize(s.operation,signal,s.principal);
    const found=await observer.capture({signal});
    if(found.snapshot.revision!==s.captured.snapshot.revision||found.basis.authorityVersion!==s.captured.basis.authorityVersion)throw error(
      'The Story or authority changed during phase context reading.','ENGINE_CONTEXT_CHANGED',{operation:'phase.enter',workId});
    if(s.draftCapture)await runtime.revalidateEntryDraft(s.draftCapture,{signal});
    for(const source of s.liveSources) {
      const observed=await source.unit.capture({signal});sourceSnapshot(observed.snapshot,source.unit.descriptor);
      if(observed.revision!=='sha256:'+hash(canonicalJson(observed.snapshot)))throw error('The source unit returned another context digest.','ENGINE_PORT_RESULT_INVALID');
      if(observed.revision!==source.revision)throw error('The selected source changed during phase context reading.','ENGINE_SOURCE_CHANGED',{
        operation:'phase.enter',repositoryId:source.repositoryId});
    }
    if(s.observedCheckpoint) {
      const pointer=await observer.record('evidence',s.observedCheckpoint.key,false,signal,true);
      if((pointer?.version??null)!==s.observedCheckpoint.version)throw error('The human checkpoint changed during phase context reading.','ENGINE_CONTEXT_CHANGED',{
        operation:'phase.enter',workId,phase:s.phase.id});
    }
    cancelled(signal);
  }
  const phaseEntry={load:(input,{signal}={})=>load(input,signal,'phase.enter'),
    inspect:(context,_binding,{signal}={})=>build(context,signal),
    async compose(context,_binding,{signal}={}) {await build(context,signal);const s=selected(context);await fresh(context,signal);
      return {workId,phase:s.phase.id,generation:s.generation,...s.identity};},
    async clarify(context,_binding,{signal}={}) {await build(context,signal);return structuredClone(selected(context).clarification);},
    async finish(context,_binding,_state,{signal}={}) {await fresh(context,signal);const s=selected(context);
      return {workId,phase:s.phase.id,generation:s.generation,revision:context.revision,task:null};}};
  const phaseContextRead={load:(input,{signal}={})=>load(input,signal,'phase.context.read'),
    async read(context,input,{signal}={}) {
      await build(context,signal);const s=selected(context);
      if(s.identity.sha256!==input.contextSha256)throw error('Read a fresh phase-entry manifest after its inputs, answers or draft changed.','ENGINE_CONTEXT_CHANGED',{
        operation:'phase.enter',workId,phase:s.phase.id,expected:input.contextSha256,observed:s.identity.sha256});
      const resource=s.resources.find(item=>item.id===input.resourceId);
      if(!resource)throw error('The resource is not in this exact phase-entry manifest.','DOCUMENT_NOT_FOUND',{operation:'phase.enter',resourceId:input.resourceId});
      let data;
      if(resource.locality==='machine-local') {
        if(['current-draft','generation-intent'].includes(resource.kind))data=await runtime.entryDraftBytes(s.draftCapture,resource.reference,{signal});
        else try{data=await localBytes(resource.reference,signal);}catch(cause){if(cause.code!=='ENGINE_STORAGE_CONTENT_MISSING')throw cause;
          throw error('Upload the matching original input on this device before reading it.','DOCUMENT_REUPLOAD_REQUIRED',{
            operation:'phase.enter',workId,phase:s.phase.id,expected:resource.reference},cause);}
      }else data=await observer.bytes(resource.reference,resource.reference.bytes,signal);
      let text=null;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);if(text.includes('\0'))text=null;}catch{}
      const encoding=text===null?'binary':'utf8',maximum=Math.min(input.maximumBytes,resource.budgetBytes);let content=null;
      if(input.offset>data.byteLength)throw error('The requested offset is outside the declared resource.','ENGINE_INPUT_INVALID');
      if(input.representation==='text'&&text!==null){let value='',bytes=0;for(const character of text){const size=Buffer.byteLength(character);if(bytes+size>maximum)break;value+=character;bytes+=size;}
        content={kind:'text',text:value,bytes,truncated:bytes<data.byteLength};}
      if(input.representation==='base64'){const part=data.subarray(input.offset,input.offset+maximum);content={kind:'bytes',base64:part.toString('base64'),bytes:part.byteLength,truncated:input.offset+part.byteLength<data.byteLength};}
      await fresh(context,signal);
      return {workId,phase:s.phase.id,generation:s.generation,contextSha256:s.identity.sha256,resourceId:resource.id,reference:resource.reference,
        representation:input.representation,offset:input.offset,encoding,content};
    }};
  return {phaseEntry,phaseContextRead};
}
