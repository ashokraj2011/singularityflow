/** Registered human checkpoints over shared namespaced records; private inputs stay on the device. */
import {createHash} from 'node:crypto';
import {createEngine} from '../engine-sdk/index.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {clarificationResponseSet,normalizeResponse} from '../kernel/clarification-responses.mjs';
import {phaseAccessIdentity,phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {sequenceAdmission} from '../kernel/lifecycle-transitions.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {phaseExplicitlyReopened} from '../kernel/phase-policy.mjs';
import {namespaceJson} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceClarificationReader,clarificationRecord} from './namespace-clarification-reader.mjs';
import {CLARIFICATION_EVIDENCE} from './namespace-clarification-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
export function createNamespaceClarificationPorts(options) {
  const {records,content,scope,workId,access,clock,localContent}=options,observer=createNamespaceStoryObserver(options);
  const checks=createNamespacePhaseCheckReader({...options,observer});
  const reader=createNamespaceClarificationReader({observer,scope,workId,checks,limits:records.descriptor.limits,
    localRead:localContent?async(reference,{signal}={})=>{
      const value=await localContent.read(scope,reference,{signal,maximumBytes:reference.bytes});
      if(value?.status==='missing')throw error('The uploaded file is unavailable on this device.','ENGINE_STORAGE_CONTENT_MISSING');
      if(value?.status!=='present'||!(value.data instanceof Uint8Array)||!same(value.reference,reference)||value.truncated
        ||value.data.byteLength!==reference.bytes||hash(value.data)!==reference.sha256)throw error('The local content reader returned different uploaded bytes.','ENGINE_PORT_RESULT_INVALID');
      return value.data;
    }:null});
  const current=access.current.bind(access),now=clock.now.bind(clock),transact=records.transact.bind(records),put=content.put.bind(content),contexts=new WeakMap(),prepared=new WeakMap();
  const selected=context=>{const value=contexts.get(context);if(!value)throw error('Use the issued clarification context.','ENGINE_INPUT_INVALID');return value;};
  const cancelled=signal=>{if(signal?.aborted)throw error('The clarification operation was cancelled before its next effect.','ENGINE_OPERATION_CANCELLED');};
  async function actor(operation,signal,expected=null,identityOnly=false) {
    cancelled(signal);const facts=namespaceJson(await current({projectId:scope.projectId,workId,operation,signal}));cancelled(signal);
    const value=identityOnly||operation==='clarification.status'?phaseAccessIdentity(facts,scope.projectId):phaseTransitionAccess(facts,scope.projectId,operation);
    if(expected&&!same(expected,value.actor))throw error('Resume clarification under its original authenticated human.','ENGINE_ACTOR_CHANGED');
    return value;
  }
  async function load(input,{signal}={}) {
    if(input.workId!==undefined&&input.workId!==workId)throw error('Clarification is bound to another Story.','ACTIVE_SUBJECT_MISMATCH');
    const context=Object.freeze({subject:{kind:'story',id:workId},phase:input.phaseId??null});contexts.set(context,{input});cancelled(signal);return context;
  }
  async function basis(s,signal,agentId=undefined) {
    const captured=await observer.capture({signal}),phaseId=s.input.phaseId??captured.snapshot.workflow.currentPhase;
    if(!phaseId)throw error('The Story has no active authoring phase.','ENGINE_PHASE_UNAVAILABLE');
    const selectedAgent=s.input.agentId===undefined?captured.snapshot.workflow.phases[phaseId]?.defaultAgent??agentId:s.input.agentId;
    const manifest=await reader.context(captured,phaseId,{signal,agentId:selectedAgent});return {captured,manifest};
  }
  async function original(s,signal) {
    const found=await reader.accepted(s.input.operationId,{signal});if(!found)return null;
    if(!same(found.value.input,s.input))throw error('This clarification operation ID has a different request.','ENGINE_OPERATION_ID_REUSED');
    await actor('clarification.record',signal,found.value.actor,true);return {...found,replayed:true};
  }
  const status={load,async inspect(context,_input,{signal}={}) {
    const s=selected(context),principal=await actor('clarification.status',signal);
    const current=await observer.inspect({signal}),phaseId=s.input.phaseId??current.snapshot.workflow.currentPhase,
      phase=current.snapshot.workflow.phases[phaseId];
    if(phase?.generation>0&&!phaseExplicitlyReopened(current.snapshot.workflow,phase)) {
      const binding=phase.publicationBindings?.find(item=>item.generation===phase.generation);
      if(!binding)throw error('The published generation has no retained publication.','ENGINE_STORAGE_CORRUPT');
      const publication=await createNamespacePublicationReader({observer,scope,workId,checks}).accepted(binding,phaseId,{signal}),
        checkpointBinding=publication.policyEvidence?.find(item=>item.kind===CLARIFICATION_EVIDENCE),
        checkpoint=checkpointBinding?await reader.json(checkpointBinding.record,signal):null,
        found=checkpoint?.response?await reader.accepted(checkpoint.response.operationId,{signal}):null,
        value=found?.value??null;
      return {subject:{kind:'story',id:workId},phase:phaseId,generation:phase.generation,status:'published',ready:true,
        context:checkpoint?{sha256:checkpoint.contextSha256,manifest:checkpoint.context}:null,
        record:value?{operationId:value.operationId,reference:found.reference,contextSha256:value.contextSha256,responses:value.responses,completed:value.completed,recordedAt:value.recordedAt,actor:value.actor}:null,
        checkpoint:{stage:'published',questioningAllowed:false,requiresHumanResponse:false},actions:[{operation:'phase.review',inputs:{workId,phaseId}}],
        effects:{committed:false,pushed:false,approvalRecorded:false,phaseAdvanced:false}};
    }
    const {captured,manifest}=await basis(s,signal,phase?.defaultAgent??principal.agentId),checkpoint=await reader.checkpoint(manifest.value,{signal}),record=checkpoint.accepted?.value??null;
    let state;
    try{state=reader.readiness(manifest.value,record);}
    catch(cause){if(cause.code!=='CLARIFICATION_RECORD_BINDING_MISMATCH')throw cause;
      state={mode:manifest.value.policy.mode,ready:false,errors:['record-binding-changed'],checkpoint:{stage:'inspect-binding',questioningAllowed:false,requiresHumanResponse:false}};}
    const active=sequenceAdmission(captured.snapshot.workflow,{requestedPhase:manifest.value.phase}).allowed;
    const replacing=record!==null&&!state.ready;
    return {subject:{kind:'story',id:workId},phase:manifest.value.phase,generation:manifest.value.generation,
      context:{sha256:manifest.sha256,manifest:manifest.value},record:record?{operationId:record.operationId,reference:checkpoint.accepted.reference,contextSha256:record.contextSha256,
        responses:record.responses,completed:record.completed,recordedAt:record.recordedAt,actor:record.actor}:null,
      ...state,checkpoint:{...state.checkpoint,questioningAllowed:active&&state.checkpoint.questioningAllowed},
      actions:state.ready?[]:[{operation:'clarification.record',inputs:{workId,phaseId:manifest.value.phase,agentId:manifest.value.agentId,contextSha256:manifest.sha256,...(replacing?{replace:true}:{})},
        prerequisites:[...(replacing?['review-existing-answers','reason']:[]),'human-responses','authenticated-phase-authority']}],
      effects:{committed:false,pushed:false,approvalRecorded:false,phaseAdvanced:false}};
  }};
  const record={load,async retained(context,_input,{signal}={}) {return original(selected(context),signal);},
    async prepare(context,_input,{signal}={}) {
      const s=selected(context),principal=await actor('clarification.record',signal),
        {captured,manifest}=await basis(s,signal,principal.agentId),workflow=captured.snapshot.workflow,phase=workflow.phases[s.input.phaseId];
      if(!sequenceAdmission(workflow,{requestedPhase:s.input.phaseId}).allowed)throw error('Clarification recording requires the current authoring phase.','PHASE_DRAFT_NOT_ACTIVE');
      if(phase.generation>0&&!phaseExplicitlyReopened(workflow,phase))throw error('Continue the published generation; a successor needs reviewed reopening.','GENERATION_INTENT_ALREADY_CONSUMED',{
        operation:'phase.review',phase:s.input.phaseId});
      if(manifest.value.policy.mode==='off')throw error('Clarification is off for this phase.','CLARIFICATION_MODE_OFF');
      if(manifest.sha256!==s.input.contextSha256)throw error('Review the exact current phase inputs before recording answers.','CLARIFICATION_RECORD_BINDING_MISMATCH',{
        operation:'clarification.status',phase:s.input.phaseId,expected:s.input.contextSha256,observed:manifest.sha256});
      reader.authorizeHuman(manifest.definition,workflow,phase,principal.actor);
      const checkpoint=await reader.checkpoint(manifest.value,{signal}),previous=checkpoint.accepted;
      if(previous&&!same(previous.value.context,manifest.value)&&!s.input.replace)throw error('Review changed phase inputs before explicitly replacing their answers.','CLARIFICATION_RECORD_BINDING_MISMATCH',{
        operation:'clarification.record',phase:s.input.phaseId,contextSha256:manifest.sha256,replace:true,prerequisites:['review-existing-answers','reason','human-responses']});
      const folded=clarificationResponseSet({phaseId:s.input.phaseId,policy:manifest.value.policy,previous:previous?.value.responses.map(normalizeResponse)??null,
        responses:s.input.responses,replace:s.input.replace});
      if(folded.reused&&same(previous.value.actor,principal.actor)) {
        const token=Object.freeze({});prepared.set(token,{context,reused:{...previous,replayed:true}});return token;
      }
      const value=clarificationRecord('response',{projectId:scope.projectId,workId,phase:s.input.phaseId,generation:manifest.value.generation,
        operationId:s.input.operationId,parametersSha256:hash(canonicalJson({input:s.input,actor:principal.actor})),input:s.input,
        context:manifest.value,contextSha256:manifest.sha256,actor:principal.actor,recordedAt:projectEnrollmentTimestamp(await now()),
        responses:folded.responses,completed:folded.completed,previous:previous?{operationId:previous.value.operationId,record:previous.reference}:null,
        observed:checkpoint.observed,basis:captured.basis});
      const data=Buffer.from(canonicalJson(value)),reference={namespace:'evidence',sha256:hash(data),bytes:data.byteLength},saved=await put(scope,'evidence',data,{signal});
      if(!same(contentReference(saved?.reference),reference)||typeof saved.reused!=='boolean')throw error('The content store acknowledged another clarification record.','ENGINE_PORT_RESULT_INVALID');
      await observer.bytes(reference,reference.bytes,signal);cancelled(signal);
      const token=Object.freeze({});prepared.set(token,{context,value,reference});return token;
    },
    async commit(context,token,{signal}={}) {
      const s=selected(context),p=prepared.get(token);if(!p||p.context!==context)throw error('Use the issued clarification preparation.','ENGINE_INPUT_INVALID');
      if(p.reused)return p.reused;
      const accepted=await original(s,signal);if(accepted)return accepted;
      const {captured,manifest}=await basis(s,signal,p.value.context.agentId);await actor('clarification.record',signal,p.value.actor);
      reader.authorizeHuman(manifest.definition,captured.snapshot.workflow,captured.snapshot.workflow.phases[s.input.phaseId],p.value.actor);
      if(manifest.sha256!==p.value.contextSha256||captured.basis.authorityVersion!==p.value.basis.authorityVersion)throw error('The phase input or authority changed before clarification acceptance.','ENGINE_CONTEXT_CHANGED');
      const tx=reader.transaction(p.value,p.reference);cancelled(signal);
      try{reader.receipt(await transact(scope,tx,{signal}),tx);}
      catch(cause){if(!['SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
        const concurrent=await original(s,signal);if(concurrent)return concurrent;throw cause;}
      return {...await reader.accepted(s.input.operationId,{signal}),replayed:false};
    },
    async finish(context,accepted) {
      const s=selected(context),value=accepted?.value;
      if(!value||value.phase!==s.input.phaseId)throw error('The accepted clarification has another phase.','ENGINE_PORT_RESULT_INVALID');
      return {status:value.completed?'recorded':'pending',subject:{kind:'story',id:workId},phase:value.phase,generation:value.generation,
        operationId:s.input.operationId,originalOperationId:value.operationId,contextSha256:value.contextSha256,reference:accepted.reference,recordedAt:value.recordedAt,actor:value.actor,
        responses:value.responses,completed:value.completed,replayed:accepted.replayed,
        effects:{committed:!accepted.replayed,pushed:false,clarificationRecorded:true,approvalRecorded:false,phaseAdvanced:false}};
    }};
  return {clarificationStatus:status,clarificationRecord:record};
}
export function createNamespaceClarificationEngine(options) {return createEngine({ports:createNamespaceClarificationPorts(options)});}
