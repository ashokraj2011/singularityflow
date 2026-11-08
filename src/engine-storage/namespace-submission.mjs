/** Shared-record submission of an actual published document. No private draft or Git discovery. */
import {createHash} from 'node:crypto';
import {createEngine} from '../engine-sdk/index.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,NAMESPACE_SUBMISSION_SCHEMAS,phasePublicationBindingValue} from '../foundation/record-schema.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {phaseAgentMutationFacts,skillPhaseHostRequirement} from '../kernel/phase-admission.mjs';
import {phaseGovernancePlan,hasPublishedPhaseGeneration,phaseNeedsGeneration} from '../kernel/phase-policy.mjs';
import {primaryDocumentPublicationRequirements} from '../kernel/publication-intent.mjs';
import {beginPhaseSubmission,applyPhaseSubmissionDisposition,sequenceAdmission,submittedDecisionInputPlan,applySubmittedDecisionInput} from '../kernel/lifecycle-transitions.mjs';
import {submissionRoutingSelection} from '../kernel/submission-routing.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {namespaceScope,namespaceIdentifier,namespaceJson} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {createNamespaceLifecycleObserver,namespaceLifecycleStoryKey} from './namespace-lifecycle-reader.mjs';
import {createNamespaceLifecycleCommitter} from './namespace-lifecycle-commit.mjs';
import {createNamespaceConfigurationObserver} from './namespace-configuration-reader.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespaceReadPorts} from './namespace-reader.mjs';
import {lifecycleRecord} from './namespace-lifecycle-contract.mjs';
import {namespaceSubmissionBindingValue,namespaceSubmissionValue,namespaceSubmissionRecord,namespaceSubmissionRoutingValue,
  NAMESPACE_SUBMISSION_PROFILE,NAMESPACE_SUBMISSION_DECISION_PROFILE} from './namespace-submission-contract.mjs';
export {NAMESPACE_SUBMISSION_PROFILE,NAMESPACE_SUBMISSION_DECISION_PROFILE};
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
function cancelled(signal){if(signal?.aborted)throw error('Submission was cancelled before its next effect.','ENGINE_OPERATION_CANCELLED');}

export function createNamespaceSubmissionPorts({records,content,scope,workId,authority,access,clock,notice=()=>{}}={}) {
  scope=namespaceScope(scope);workId=namespaceIdentifier(workId,'Story ID');authority=Object.freeze(structuredClone(authority));
  const observer=createNamespaceLifecycleObserver({records,content,scope,workId,authority});
  const committer=createNamespaceLifecycleCommitter({records,content,scope,workId,authority});
  const configured=createNamespaceConfigurationObserver({records,content,scope,authority});
  const publications=createNamespacePublicationReader({observer,scope,workId});
  const packets=createNamespaceSubmissionReader({observer,scope,workId});
  if(typeof access?.current!=='function'||typeof clock?.now!=='function'||typeof notice!=='function')throw error('Submission needs explicit authenticated access, clock and notice ports.','ENGINE_INPUT_INVALID');
  const current=access.current.bind(access),now=clock.now.bind(clock),put=content.put.bind(content),contexts=new WeakMap(),preparations=new WeakMap();
  function selected(context){const value=contexts.get(context);if(!value)throw error('Use the issued submission context.','ENGINE_INPUT_INVALID');return value;}
  async function authorize(signal,expected=null) {
    cancelled(signal);const facts=namespaceJson(await current({projectId:scope.projectId,workId,operation:'phase.submit',signal}));cancelled(signal);
    return phaseTransitionAccess(facts,scope.projectId,'phase.submit',{expected});
  }
  function checkedPlan(plan,s) {
    if(plan&&(plan.operation!=='phase.submit'||plan.inputsSha256!==s.requestSha256))throw error('This submission ID has another retained intent.','ENGINE_OPERATION_ID_REUSED');
    return plan;
  }
  async function decodedPacket(binding,phaseId,signal) {
    return packets.decode(binding,phaseId,{signal});
  }
  async function packet(binding,s,signal,decoded=null) {
    const value=decoded??await decodedPacket(binding,s.phaseId,signal);
    if(value.operationId!==s.operationId||value.requestSha256!==s.requestSha256||value.generation!==binding.generation
      ||!same(value.publication,s.publication))throw error('The retained review packet names another submission.','ENGINE_STORAGE_CORRUPT');
    const published=await packets.publication(value,{signal});
    return {value,published};
  }
  async function retained(plan,s,signal) {
    checkedPlan(plan,s);const state=observer.state(await observer.bytes(plan.state,plan.state.bytes,signal),plan.basis.head),phase=state.workflow.phases[s.phaseId];
    if(!phase||phase.generation!==s.generation||phase.status!=='awaiting_approval')throw error('The accepted submission has another phase state.','ENGINE_STORAGE_CORRUPT');
    const {value}=await packet(phase.namespaceSubmission,s,signal);
    const submissions=state.workflow.lineage?.submissions;
    if(!Array.isArray(submissions))throw error('The retained submission lineage is invalid.','ENGINE_STORAGE_CORRUPT');
    const lineage=submissions.findLast(item=>item?.phase===s.phaseId&&item.generation===s.generation);
    if(value.baseRevision!==plan.basis.headVersion||!same(value.configuration,plan.basis.head.configuration)||!lineage
      ||lineage.packetSha256!==phase.namespaceSubmission.record.sha256||!same(lineage.packetReference,phase.namespaceSubmission.record)
      ||phase.submittedAt!==value.submittedAt)throw error('The submission state lost its exact review binding.','ENGINE_STORAGE_CORRUPT');
    await packets.verifyRouting({workflow:state.workflow,configuration:plan.basis.head.configuration,revision:plan.basis.headVersion},s.phaseId,value,{signal});
    return {workflow:state.workflow,phase,packet:value};
  }
  async function routing(snapshot,phase,signal) {
    const selected=submissionRoutingSelection(snapshot.workflow,phase);if(!selected)return null;
    const sources=await packets.inspectApprovedMany(snapshot,selected.reused.map(source=>source.phase),{signal});
    const reused=selected.reused.map((source,index)=>{
      const proof=sources[index],record=proof?.value.routing?.record;
      if(!record||record.decision!==source.decision||proof.value.generation!==source.generation
        ||Object.entries(source.values).some(([name,value])=>!Object.hasOwn(record.values,name)||!same(record.values[name],value))) {
        throw error('Reused decision inputs require their exact retained source submission.','ENGINE_ROUTING_INPUT_PROVENANCE_REQUIRED',{
          decision:source.decision,phase:source.phase});
      }
      return {...source,packet:proof.binding.record};
    });
    return namespaceSubmissionRoutingValue({schemaVersion:NAMESPACE_SUBMISSION_SCHEMAS.routing.currentVersion,
      format:'sflow-namespace-submission-routing/v1',decision:selected.decision,record:selected.record,reused});
  }
  function facts(s,result,accepted) {
    const record=accepted.receipt.records.find(item=>item.namespace==='state'&&item.key===namespaceLifecycleStoryKey(workId));
    if(!record)throw error('The submission receipt has no accepted Story revision.','ENGINE_PORT_RESULT_INVALID');
    return {workId,phase:s.phaseId,generation:s.generation,revision:record.version,pushed:false,phaseStatus:result.phase.status,
      submittedAt:result.phase.submittedAt,approvalMode:result.phase.approvalPolicy.mode,currentPhase:result.workflow.currentPhase,
      reviewPacket:result.phase.namespaceSubmission.record.sha256};
  }
  async function unchanged(snapshot,signal) {
    const fresh=await observer.capture({signal});
    if(fresh.snapshot.revision!==snapshot.revision)throw error('The Story changed during submission. Preserve and inspect its original candidate.','ENGINE_CONTEXT_CHANGED');
  }
  const submission={notice,
    async load(input,{signal}={}) {
      cancelled(signal);if(input.workId!=null&&input.workId!==workId)throw error('Submission is bound to another Story.','ACTIVE_SUBJECT_MISMATCH');
      const observed=await observer.inspect({signal}),workflow=observed.snapshot.workflow,phaseId=input.phaseId??workflow.currentPhase;
      const phase=workflow.phases[phaseId];if(!Object.hasOwn(workflow.phases,phaseId))throw error('The selected phase is unavailable.','ENGINE_PHASE_UNAVAILABLE',{phaseId});
      if(phase.publicationBindings!==undefined&&!Array.isArray(phase.publicationBindings))throw error('The retained publication inventory is invalid.','ENGINE_STORAGE_CORRUPT');
      if(!hasPublishedPhaseGeneration(phase)||phase.status!=='awaiting_approval'&&phaseNeedsGeneration(workflow,phase))throw error('Publish the actual phase generation before submission.','PHASE_GENERATION_REQUIRED',{workId,phase:phaseId});
      const publication=(phase.publicationBindings??[]).find(item=>item.generation===phase.generation);
      if(!publication)throw error('This host needs the namespace publication reader for its retained generation.','ENGINE_PORT_UNAVAILABLE',{required:['namespace-publication']});
      phasePublicationBindingValue(publication);
      const request={workId,phaseId,runChecks:input.runChecks!==false,decisionValues:input.decisionValues??{}};
      const basis={revision:observed.snapshot.revision,authorityVersion:observed.basis.authorityVersion};
      let requestSha256=hash(canonicalJson(request)),operationId=null;
      const acknowledging=phase.status==='awaiting_approval';
      if(acknowledging) {
        const previous=await decodedPacket(phase.namespaceSubmission,phaseId,signal);
        operationId=previous.operationId;requestSha256=previous.requestSha256;
      }
      const context={subject:{kind:'story',id:workId},workflow,phase};
      contexts.set(context,{phaseId,generation:phase.generation,publication,basis,request,requestSha256,operationId,acknowledging,observed:observed.snapshot});return context;
    },
    async retained(context,_input,{signal}={}) {
      const s=selected(context);
      if(!s.acknowledging) {
        s.decisionPlan=submittedDecisionInputPlan(context.workflow,context.phase,s.request.decisionValues);
        s.request={...s.request,decisionValues:s.decisionPlan.kind==='record'?s.decisionPlan.values:{}};
        s.requestSha256=hash(canonicalJson(s.request));
        s.agent=await authorize(signal);
        // Another authorized person gets their own candidate without rewriting the first author's checkpoint.
        s.operationId='submit-'+hash(canonicalJson({scope,workId,authority,publication:s.publication,basis:s.basis,request:s.request,author:s.agent}));
      }
      const accepted=await committer.inspect(s.operationId,{signal});
      const plan=checkedPlan(await committer.intent(s.operationId,{signal}),s);
      if(accepted.status==='committed') {
        if(!plan)throw error('The accepted submission lost its retained candidate.','ENGINE_STORAGE_CORRUPT');
        return facts(s,await retained(plan,s,signal),accepted);
      }
      if(s.acknowledging)throw error('The submitted phase has no accepted original operation receipt.','ENGINE_STORAGE_CORRUPT');
      s.plan=plan;return null;
    },
    async prepare(context,input,_intent,{signal}={}) {
      const s=selected(context),agent=s.agent;
      if(!agent)throw error('Submission needs its authenticated selection before preparation.','ENGINE_INPUT_INVALID');
      const snapshot=await committer.capture({signal}),workflow=snapshot.workflow,phase=workflow.phases[s.phaseId];
      const expected=s.plan?.basis.headVersion??s.observed.revision;
      if(snapshot.revision!==expected)throw error('The Story changed before submission preparation.','ENGINE_CONTEXT_CHANGED');
      const sequence=sequenceAdmission(workflow,{requestedPhase:s.phaseId});
      if(!sequence.allowed)throw error('Submission requires the current in-progress phase.','PHASE_DRAFT_NOT_ACTIVE',{sequence});
      const hold=phaseGovernancePlan(workflow,phase);if(hold)throw error('Resolve the phase hold before submission.',hold.code,hold);
      const approved=await configured.approved(workflow.resolution.configurationApprovalId,{signal});
      if(!same(approved.configuration,snapshot.configuration))throw error('Submission has another configuration pin.','ENGINE_STORAGE_CORRUPT');
      const mutation=phaseAgentMutationFacts({agents:Object.fromEntries(approved.compiled.definition.agentCatalog.map(item=>[item.id,item]))},workflow,phase,{agent:agent.agentId},'submit');
      if(!mutation.allowed)throw error('The selected agent cannot submit this phase.',mutation.code,mutation);
      if(phase.defaultAgent&&phase.defaultAgent!==agent.agentId)throw error('Select the pinned phase author before submission.','AGENT_SESSION_REQUIRED',{agentId:phase.defaultAgent});
      const required=new Set(primaryDocumentPublicationRequirements(workflow,phase,{definition:approved.compiled.definition}));
      if(skillPhaseHostRequirement(workflow,phase))required.add('qualified-skill-host');
      if(phase.approvalPolicy.mode!=='required')required.add('automatic-approval-disposition');
      if(s.decisionPlan?.kind==='retained')required.add('retained-decision-input-provenance');
      if(workflow.resolution.presence)required.add('person-presence');
      if(required.size)throw error('This submission needs additional policy or execution owners.','ENGINE_PORT_UNAVAILABLE',{operation:'phase.submit',required:[...required].sort()});
      const published=await publications.read(s.publication,s.phaseId,{signal});
      if(!same(published.configuration,snapshot.configuration)||published.generation!==phase.generation
        ||!Array.isArray(phase.artifacts)||phase.artifacts.length!==1||!phase.artifacts.some(item=>item?.path===published.artifact.sourceKey&&item.sha256===published.artifact.content.sha256&&item.size===published.artifact.content.bytes)) {
        throw error('Submission requires the exact retained artifact and publication configuration.','ENGINE_STORAGE_CORRUPT');
      }
      if(s.plan) {
        const original=await retained(s.plan,s,signal);
        if(!same(original.packet.actor,agent.actor)||original.packet.agentId!==agent.agentId)throw error('Resume submission under its original authenticated author.','ENGINE_ACTOR_CHANGED');
      }else {
        const submittedAt=projectEnrollmentTimestamp(await now());
        if(s.decisionPlan?.kind==='record')applySubmittedDecisionInput(phase,s.decisionPlan,{at:submittedAt,actorId:agent.actor.principalId});
        const value=namespaceSubmissionRecord({projectId:scope.projectId,workId,phase:s.phaseId,generation:phase.generation,
          operationId:s.operationId,requestSha256:s.requestSha256,baseRevision:snapshot.revision,configuration:snapshot.configuration,
          publication:s.publication,actor:agent.actor,agentId:agent.agentId,submittedAt},{routing:await routing(snapshot,phase,signal)});
        namespaceSubmissionValue(value,{projectId:scope.projectId,workId,phaseId:s.phaseId});
        const data=Buffer.from(canonicalJson(value)),expectedReference={namespace:'evidence',sha256:hash(data),bytes:data.byteLength};
        const saved=await put(scope,'evidence',data,{signal});
        if(!same(contentReference(saved?.reference),expectedReference)||typeof saved.reused!=='boolean')throw error('The content port stored another review packet.','ENGINE_PORT_RESULT_INVALID');
        await observer.bytes(expectedReference,expectedReference.bytes,signal);
        beginPhaseSubmission(phase,submittedAt);applyPhaseSubmissionDisposition(phase,{reviewableFailure:false,applicationReviewPending:false,waiver:null});
        phase.namespaceSubmission=namespaceSubmissionBindingValue({schemaVersion:NAMESPACE_SUBMISSION_SCHEMAS.binding.currentVersion,
          format:'sflow-namespace-phase-submission-binding/v1',generation:phase.generation,record:expectedReference});
        workflow.lineage??={};workflow.lineage.submissions??=[];
        workflow.lineage.submissions.push({phase:s.phaseId,generation:phase.generation,packetSha256:expectedReference.sha256,packetReference:expectedReference,submittedAt});
        workflow.namespaceDocuments.push({id:'REVIEW-'+s.phaseId+'-GEN-'+phase.generation,phase:s.phaseId,generation:phase.generation,
          sourceKey:(approved.compiled.definition.workItemRoot??'singularity/work-items')+'/'+workId+'/reviews/'+s.phaseId+'-gen'+phase.generation+'.json',
          role:'file',name:(phase.label??s.phaseId)+' review packet',kind:'review-packet',mimeType:'application/json',encoding:'utf8',locality:'project',status:'active',aliases:[],content:expectedReference});
        workflow.history.push({at:submittedAt,actor:agent.actor.principalId,agent:agent.agentId,event:'phase_submitted',phase:s.phaseId,detail:'generation '+phase.generation});
        const body=lifecycleRecord('state',{projectId:scope.projectId,workId,authorityId:authority.id,epoch:authority.epoch,configuration:snapshot.configuration.content,workflow});
        await authorize(signal,agent);await unchanged(snapshot,signal);
        try {await committer.prepare(snapshot,{operationId:s.operationId,operation:'phase.submit',inputsSha256:s.requestSha256,state:Buffer.from(canonicalJson(body)),
          evidence:[expectedReference,s.publication.record,published.artifact.content]},{signal});}
        catch(cause){if(!['ENGINE_OPERATION_ID_REUSED','SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
          const competing=checkedPlan(await committer.intent(s.operationId,{signal}),s);if(!competing)throw cause;
          const original=await retained(competing,s,signal);if(!same(original.packet.actor,agent.actor)||original.packet.agentId!==agent.agentId)throw cause;}
        s.plan=checkedPlan(await committer.intent(s.operationId,{signal}),s);
      }
      if(!s.plan)throw error('Submission preparation has no retained candidate.','ENGINE_STORAGE_CORRUPT');
      const token=Object.freeze({});preparations.set(token,{context,agent,snapshot});return token;
    },
    async commit(context,token,{signal}={}) {
      const s=selected(context),p=preparations.get(token);if(!p||p.context!==context)throw error('Use this submission preparation.','ENGINE_INPUT_INVALID');
      const accepted=await committer.inspect(s.operationId,{signal});if(accepted.status==='committed')return accepted;
      await authorize(signal,p.agent);await unchanged(p.snapshot,signal);return committer.commit(s.operationId,{signal});
    },
    async finish(context,_prepared,accepted) {
      const s=selected(context),plan=checkedPlan(await committer.intent(s.operationId),s);
      if(!plan)throw error('The accepted submission lost its retained candidate.','ENGINE_STORAGE_CORRUPT');
      return facts(s,await retained(plan,s),accepted);
    }
  };
  return {submission};
}

export function createNamespaceSubmissionEngine({records,content,scope,workId,authority,access,clock,localContent=null,notice=()=>{}}={}) {
  scope=namespaceScope(scope);const options={records,content,scope,workId,authority,access,clock,localContent,notice};
  const ports=createNamespaceSubmissionPorts(options);
  return createEngine({ports:{...createNamespaceReadPorts(options),...ports}});
}
