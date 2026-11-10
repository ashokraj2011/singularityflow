/** Explicit human approval over shared retained records; no private checkout, Git or provider. */
import {createHash} from 'node:crypto';
import {createEngine} from '../engine-sdk/index.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,NAMESPACE_APPROVAL_SCHEMAS,namespaceApprovalRoutingProfile} from '../foundation/record-schema.mjs';
import {phaseAccessIdentity,phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {assertApprovalReviewConfirmation,principalApprovalPlan} from '../kernel/approval-policy.mjs';
import {phaseAgentMutationFacts,skillPhaseHostRequirement} from '../kernel/phase-admission.mjs';
import {phaseGovernancePlan,assertHistoricalReviewPhase,phaseNeedsGeneration,hasPublishedPhaseGeneration} from '../kernel/phase-policy.mjs';
import {primaryDocumentPublicationRequirements} from '../kernel/publication-intent.mjs';
import {sequenceAdmission,recordPhaseApprovalState,advanceCompletedPhase,resolvePhaseChangeRequests} from '../kernel/lifecycle-transitions.mjs';
import {decisionAfter,decisionOutcomeFacts} from '../kernel/workflow-decisions.mjs';
import {routedApprovalSelection,planRoutedApproval} from '../kernel/routed-approval.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {namespaceScope,namespaceIdentifier,namespaceJson} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {namespaceLifecycleStoryKey} from './namespace-lifecycle-reader.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceLifecycleCommitter} from './namespace-lifecycle-commit.mjs';
import {commitNamespaceOperation,prepareNamespaceOperation} from './namespace-commit-coordination.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceApprovalReader,namespaceRoutingQuestionKey} from './namespace-approval-reader.mjs';
import {createNamespaceReadPorts} from './namespace-reader.mjs';
import {lifecycleRecord} from './namespace-lifecycle-contract.mjs';
import {STARTER_CHECKLIST} from '../engine-compatibility/node-specification-policy.mjs';
import {namespaceApprovalValue,namespaceApprovalRecord,namespaceApprovalBindingValue,namespaceApprovalArtifactSetValue,namespaceApprovalArtifactSetRecord,namespaceApprovalChecklistAnswers,namespaceApprovalDecision,
  namespaceApprovalReceipt,namespaceApprovalReceipts,NAMESPACE_APPROVAL_PROFILE,NAMESPACE_ROUTED_APPROVAL_PROFILE} from './namespace-approval-contract.mjs';
export {NAMESPACE_APPROVAL_PROFILE,NAMESPACE_ROUTED_APPROVAL_PROFILE};
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
function cancelled(signal){if(signal?.aborted)throw error('Approval was cancelled before its next effect.','ENGINE_OPERATION_CANCELLED');}

export function createNamespaceApprovalPorts({records,content,scope,workId,authority,access,clock}={}) {
  scope=namespaceScope(scope);workId=namespaceIdentifier(workId,'Story ID');authority=Object.freeze(structuredClone(authority));
  const observer=createNamespaceStoryObserver({records,content,scope,workId,authority});
  const committer=createNamespaceLifecycleCommitter({records,content,scope,workId,authority});
  const checks=createNamespacePhaseCheckReader({records,content,scope,workId,authority,observer});
  const packets=createNamespaceSubmissionReader({observer,scope,workId,checks}),votes=createNamespaceApprovalReader({observer,scope,workId,checks});
  if(typeof access?.current!=='function'||typeof clock?.now!=='function')throw error('Approval needs explicit authenticated access and clock ports.','ENGINE_INPUT_INVALID');
  const current=access.current.bind(access),now=clock.now.bind(clock),put=content.put.bind(content),contexts=new WeakMap(),preparations=new WeakMap();
  function selected(context){const value=contexts.get(context);if(!value)throw error('Use the issued approval context.','ENGINE_INPUT_INVALID');return value;}
  async function identity(signal) {
    cancelled(signal);const facts=namespaceJson(await current({projectId:scope.projectId,workId,operation:'phase.approve',signal}));cancelled(signal);
    return {facts,reviewer:phaseAccessIdentity(facts,scope.projectId)};
  }
  async function authorize(signal,expected) {const {facts}=await identity(signal);return phaseTransitionAccess(facts,scope.projectId,'phase.approve',{expected});}
  async function unchanged(snapshot,signal) {
    const fresh=await observer.capture({signal});
    if(fresh.snapshot.revision!==snapshot.revision)throw error('The Story changed during approval. Review its current packet before retrying.','ENGINE_CONTEXT_CHANGED');
  }
  function checkedPlan(plan,s) {
    if(plan&&(plan.operation!=='phase.approve'||plan.inputsSha256!==s.requestSha256))throw error('This approval ID has another retained intent.','ENGINE_OPERATION_ID_REUSED');
    return plan;
  }
  function checkRetainedChecklist(s,value,publication) {
    if(s.checklistRequest===null||packets.publicationChecklist(publication,value.actor,[])===null)return;
    const request={workId,phaseId:s.phaseId,confirmation:s.checklistRequest.confirmation??s.reviewBinding,checklist:s.checklistRequest.checklist};
    if(hash(canonicalJson(request))!==value.requestSha256)throw error('This approval already retained different human checklist answers. Review the original receipt; a retry cannot rewrite the decision.',
      'ENGINE_OPERATION_ID_REUSED');
  }
  function routing(workflow,phase,reached,at,version=NAMESPACE_APPROVAL_SCHEMAS.routing.currentVersion) {
    const selected=routedApprovalSelection(workflow,phase,{reached,at});
    const profile=namespaceApprovalRoutingProfile({schemaVersion:version}),pendingKey=namespaceRoutingQuestionKey(selected.pending,phase.generation,version);
    return {selected,pending:selected.pending?{...selected.pending,key:pendingKey}:null,value:{schemaVersion:profile.version,
      format:profile.format,decision:selected.decision,outcome:selected.outcome,pendingKey,...(profile.generationBound?{generation:phase.generation}:{})}};
  }
  function routedWorkflow(workflow,phaseId,value,binding) {
    const selected=routing(workflow,workflow.phases[phaseId],value.thresholdReached,value.recordedAt,value.routing.schemaVersion);
    if(!same(value.routing,selected.value)||value.currentPhase!==selected.selected.currentPhase)throw error('The routed vote differs from its original pinned outcome.','ENGINE_STORAGE_CORRUPT');
    const proposed=planRoutedApproval(workflow,phaseId,{decision:namespaceApprovalDecision(value,binding),reached:value.thresholdReached,
      at:value.recordedAt,actorId:value.actor.principalId,agentId:value.agentId,authorityGroup:value.authorityGroup,
      outcome:selected.selected.outcome,pending:selected.pending}).workflow;
    proposed.namespaceApprovalReceipts=[...structuredClone(namespaceApprovalReceipts(workflow,{projectId:scope.projectId,workId})),namespaceApprovalReceipt(value,binding)];
    return proposed;
  }
  async function retainedRouting(plan,s,body,signal) {
    const links=namespaceApprovalReceipts(body.workflow,{projectId:scope.projectId,workId}).filter(item=>item.operationId===s.operationId);
    if(links.length!==1)throw error('The routed approval lost its exact retained receipt link.','ENGINE_STORAGE_CORRUPT');
    const link=links[0],binding=namespaceApprovalBindingValue({schemaVersion:NAMESPACE_APPROVAL_SCHEMAS.binding.currentVersion,
      format:'sflow-namespace-phase-approval-binding/v1',generation:link.generation,record:link.record});
    if(s.receiptReference&&!same(binding.record,s.receiptReference))throw error('The current receipt link differs from its originally accepted vote.','ENGINE_STORAGE_CORRUPT');
    const original=await observer.state(await observer.bytes(plan.basis.head.state,plan.basis.head.state.bytes,signal),plan.basis.head,{signal});
    const snapshot={workflow:original.workflow,configuration:plan.basis.head.configuration,revision:plan.basis.headVersion};
    const proof=await packets.inspect(snapshot,s.phaseId,{signal});
    if(!proof||proof.review.packetSha256!==s.reviewBinding.reviewPacketSha256)throw error('The routed approval lost its original submitted packet.','ENGINE_STORAGE_CORRUPT');
    const value=await votes.read(binding,s.phaseId,proof,{signal,approvalCandidate:{operationId:s.operationId,snapshot}}),active=await votes.activeAccepted(snapshot,s.phaseId,proof,{signal});
    checkRetainedChecklist(s,value,proof.published);
    if(!value.routing||value.operationId!==s.operationId||value.requestSha256!==s.requestSha256||value.baseRevision!==plan.basis.headVersion
      ||!same(value.configuration,plan.basis.head.configuration)||!same(value.actor,s.reviewer.actor)||value.agentId!==s.reviewer.agentId
      ||!same(link,namespaceApprovalReceipt(value,binding))
      ||![binding.record,value.artifactSet,value.reviewPacket,proof.value.publication.record,proof.published.artifact.content,...votes.evidence(value)].every(ref=>plan.evidence.some(item=>same(item,ref)))) {
      throw error('The routed approval differs from its original actor, intent or evidence.','ENGINE_STORAGE_CORRUPT');
    }
    try {
      const policy=principalApprovalPlan(original.workflow,original.workflow.phases[s.phaseId],{actor:value.actor,agentId:value.agentId},
        {author:proof.published.actor,active:active.decisions});
      if(policy.authorityGroup!==value.authorityGroup||policy.selfApproval!==value.selfApproval||policy.reached!==value.thresholdReached
        ||!same(routedWorkflow(original.workflow,s.phaseId,value,binding),body.workflow))throw Error('The routed proposal changed its original human threshold or transition.');
    }catch(cause){if(['ENGINE_STORAGE_UNSUPPORTED','ENGINE_STORAGE_CORRUPT'].includes(cause.code))throw cause;
      throw error('The retained routed approval no longer proves its original transition.','ENGINE_STORAGE_CORRUPT',null,cause);}
    return {value,binding,workflow:body.workflow};
  }
  async function retained(plan,s,signal) {
    checkedPlan(plan,s);
    const body=await observer.state(await observer.bytes(plan.state,plan.state.bytes,signal),plan.basis.head,{signal});
    if(s.routed)return retainedRouting(plan,s,body,signal);
    const snapshot={workflow:body.workflow,configuration:plan.basis.head.configuration,revision:plan.basis.headVersion};
    const proof=await packets.inspect(snapshot,s.phaseId,{signal});
    if(!proof||proof.review.packetSha256!==s.reviewBinding.reviewPacketSha256)throw error('The retained approval lost its submitted packet.','ENGINE_STORAGE_CORRUPT');
    let approvalCandidate=null;
    if(packets.publicationRequiresDisposition(proof.published,{reached:true})){
      const original=await observer.state(await observer.bytes(plan.basis.head.state,plan.basis.head.state.bytes,signal),plan.basis.head,{signal});
      approvalCandidate={operationId:s.operationId,snapshot:{workflow:original.workflow,configuration:plan.basis.head.configuration,revision:plan.basis.headVersion}};
    }
    const active=await votes.active(snapshot,s.phaseId,proof,{signal,approvalCandidate}),matches=active.votes.filter(item=>item.value.operationId===s.operationId);
    if(matches.length!==1)throw error('The retained approval has no exact human vote.','ENGINE_STORAGE_CORRUPT');
    const {value,binding}=matches[0],phase=body.workflow.phases[s.phaseId];
    checkRetainedChecklist(s,value,proof.published);
    if(value.requestSha256!==s.requestSha256||value.baseRevision!==plan.basis.headVersion||!same(value.configuration,plan.basis.head.configuration)
      ||!same(value.actor,s.reviewer.actor)||value.agentId!==s.reviewer.agentId||value.currentPhase!==body.workflow.currentPhase
      ||phase.status!==(value.thresholdReached?'approved':'awaiting_approval')
      ||![binding.record,value.artifactSet,value.reviewPacket,proof.value.publication.record,proof.published.artifact.content,...votes.evidence(value)].every(ref=>plan.evidence.some(item=>same(item,ref)))) {
      throw error('The retained approval differs from its original actor, evidence or transition.','ENGINE_STORAGE_CORRUPT');
    }
    return {value,binding,workflow:body.workflow};
  }
  function facts(s,result,accepted) {
    const record=accepted.receipt.records.find(item=>item.namespace==='state'&&item.key===namespaceLifecycleStoryKey(workId));
    if(!record)throw error('The approval receipt has no accepted Story revision.','ENGINE_PORT_RESULT_INVALID');
    const value=result.value;
    return {workId,phase:s.phaseId,generation:value.generation,revision:record.version,pushed:false,reviewPacket:value.reviewPacket.sha256,
      artifactSet:value.artifactSet.sha256,actorId:value.actor.principalId,authorityGroup:value.authorityGroup,selfApproval:value.selfApproval,
      thresholdReached:value.thresholdReached,currentPhase:value.currentPhase};
  }
  async function save(value,signal) {
    const data=Buffer.from(canonicalJson(value)),reference={namespace:'evidence',sha256:hash(data),bytes:data.byteLength};
    const saved=await put(scope,'evidence',data,{signal});
    if(!same(contentReference(saved?.reference),reference)||typeof saved.reused!=='boolean')throw error('The content port stored another approval record.','ENGINE_PORT_RESULT_INVALID');
    await observer.bytes(reference,reference.bytes,signal);return reference;
  }
  const approval={
    async load(input,{signal}={}) {
      cancelled(signal);if(input.workId!=null&&input.workId!==workId)throw error('Approval is bound to another Story.','ACTIVE_SUBJECT_MISMATCH');
      const observed=await observer.inspect({signal}),workflow=observed.snapshot.workflow;
      assertHistoricalReviewPhase(workflow,input.phaseId);const phaseId=input.phaseId??workflow.currentPhase,phase=workflow.phases[phaseId];
      if(!Object.hasOwn(workflow.phases,phaseId))throw error('The selected phase is unavailable.','ENGINE_PHASE_UNAVAILABLE',{phaseId});
      if(phase.publicationBindings!==undefined&&!Array.isArray(phase.publicationBindings))throw error('The retained publication inventory is invalid.','ENGINE_STORAGE_CORRUPT');
      let identified=null;
      const links=namespaceApprovalReceipts(workflow,{projectId:scope.projectId,workId});
      if(links.length) {
        identified=await identity(signal);
        const link=links.findLast(item=>item.phase===phaseId&&item.principalId===identified.reviewer.actor.principalId
          &&(input.confirmation?item.generation===input.confirmation.generation&&item.reviewPacketSha256===input.confirmation.reviewPacketSha256
            :item.generation===phase.generation&&(input.phaseId!=null||!phaseNeedsGeneration(workflow,phase))));
        if(link) {
          const binding={schemaVersion:NAMESPACE_APPROVAL_SCHEMAS.binding.currentVersion,format:'sflow-namespace-phase-approval-binding/v1',generation:link.generation,record:link.record};
          const value=await votes.decode(binding,phaseId,{signal});
          if(!value.routing||!same(link,namespaceApprovalReceipt(value,binding)))throw error('The routed receipt link does not match its immutable vote.','ENGINE_STORAGE_CORRUPT');
          if(!same(value.actor,identified.reviewer.actor))throw error('Acknowledge the routed receipt under its original authenticated identity.','ENGINE_ACTOR_CHANGED');
          const plan=await committer.intent(value.operationId,{signal});if(!plan)throw error('The routed receipt lost its original prepared operation.','ENGINE_STORAGE_CORRUPT');
          const original=await observer.state(await observer.bytes(plan.basis.head.state,plan.basis.head.state.bytes,signal),plan.basis.head,{signal});
          if(original.workflow.phases[phaseId]?.generation!==value.generation)throw error('The routed receipt belongs to another original generation.','ENGINE_STORAGE_CORRUPT');
          const context={subject:{kind:'story',id:workId},workflow:original.workflow,phase:original.workflow.phases[phaseId],
            reviewBinding:{workId,phase:phaseId,generation:value.generation,reviewPacketSha256:value.reviewPacket.sha256}};
          contexts.set(context,{phaseId,reviewer:{actor:identified.reviewer.actor,agentId:value.agentId},reviewBinding:context.reviewBinding,
            operationId:value.operationId,requestSha256:value.requestSha256,replay:true,routed:true,receiptReference:link.record,observed:observed.snapshot,
            checklistRequest:input.checklist==null?null:{confirmation:input.confirmation,checklist:input.checklist}});
          return context;
        }
      }
      if(phase.status!=='approved'&&(phaseNeedsGeneration(workflow,phase)||!hasPublishedPhaseGeneration(phase)))throw error(
        'Author and publish the current generation before requesting approval.','PHASE_GENERATION_REQUIRED',{
          workId,phase:phaseId,actions:[{operation:'phase.prepare',inputs:{workId,phaseId}}]});
      const proof=await packets.inspect(observed.snapshot,phaseId,{signal});
      if(!proof)throw error('Submit the published generation before requesting approval.','PHASE_SUBMISSION_REQUIRED',{
        workId,phase:phaseId,actions:[{operation:'phase.submit',inputs:{workId,phaseId}}]});
      const {facts:initialFacts,reviewer:authenticated}=identified??await identity(signal),active=await votes.activeAccepted(observed.snapshot,phaseId,proof,{signal});
      const reviewBinding={workId,phase:phaseId,generation:phase.generation,reviewPacketSha256:proof.review.packetSha256};
      const previous=active.votes.find(item=>item.value.actor.principalId===authenticated.actor.principalId);
      if(previous&&!same(previous.value.actor,authenticated.actor))throw error(
        'Acknowledge this approval under its original authenticated human identity.','ENGINE_ACTOR_CHANGED');
      // An original receipt keeps its audit agent; changing the current prompt grants no new vote.
      const reviewer=previous?{actor:authenticated.actor,agentId:previous.value.agentId}:authenticated;
      // This profile has no additional human decision fields; absent/false host options are one intent.
      // Unsupported features are refused before a candidate can be accepted.
      const hasPolicyChecklist=packets.publicationChecklist(proof.published,reviewer.actor,[])!==null;
      if(hasPolicyChecklist&&input.checklist!=null)namespaceApprovalChecklistAnswers(input.checklist);
      const request={workId,phaseId,confirmation:input.confirmation??null,...(hasPolicyChecklist?{checklist:input.checklist??[]}:{})},requestSha256=previous?.value.requestSha256??hash(canonicalJson(request));
      const operationId=previous?.value.operationId??'approve-'+hash(canonicalJson({scope,workId,authority,reviewer,requestSha256,
        reviewPacket:proof.binding.record,basis:{revision:observed.snapshot.revision,authorityVersion:observed.basis.authorityVersion}}));
      const context={subject:{kind:'story',id:workId},workflow,phase,reviewBinding};
      contexts.set(context,{phaseId,reviewer,initialFacts,proof,active,reviewBinding,operationId,requestSha256,replay:!!previous,
        routed:!!decisionAfter(workflow,phaseId),observed:observed.snapshot,
        checklistRequest:input.checklist==null?null:{confirmation:input.confirmation,checklist:input.checklist}});
      return context;
    },
    async prepare(context,input,{signal}={}) {
      const s=selected(context);
      if(input.confirmation!=null)assertApprovalReviewConfirmation(s.reviewBinding,input.confirmation);
      return prepareNamespaceOperation(committer,s.operationId,async()=>{
        const accepted=await committer.inspect(s.operationId,{signal}),plan=checkedPlan(await committer.intent(s.operationId,{signal}),s);
        if(accepted.status==='committed') {
          if(!plan)throw error('The accepted approval lost its retained candidate.','ENGINE_STORAGE_CORRUPT');
          await retained(plan,s,signal);
          const token=Object.freeze({confirmation:s.reviewBinding});preparations.set(token,{context,accepted});return token;
        }
        if(s.replay)throw error('The retained human vote has no accepted original receipt.','ENGINE_STORAGE_CORRUPT');
        assertApprovalReviewConfirmation(s.reviewBinding,input.confirmation);
        phaseTransitionAccess(s.initialFacts,scope.projectId,'phase.approve');
        const snapshot=await committer.capture({signal}),workflow=snapshot.workflow,phase=workflow.phases[s.phaseId];
        const approved=await observer.approved(snapshot,{signal});
        if(snapshot.revision!==(plan?.basis.headVersion??s.observed.revision))throw error('The Story changed before approval preparation.','ENGINE_CONTEXT_CHANGED');
        const sequence=sequenceAdmission(workflow,{requestedPhase:s.phaseId,allowedStatuses:['awaiting_approval']});
        if(!sequence.allowed)throw error('Approval requires the current submitted phase.','PHASE_DRAFT_NOT_ACTIVE',{sequence});
        const hold=phaseGovernancePlan(workflow,phase);if(hold)throw error('Resolve the phase hold before approval.',hold.code,hold);
        if(!same(approved.configuration,snapshot.configuration))throw error('Approval has another configuration pin.','ENGINE_STORAGE_CORRUPT');
        const mutation=phaseAgentMutationFacts({agents:Object.fromEntries(approved.compiled.definition.agentCatalog.map(item=>[item.id,item]))},
          workflow,phase,{agent:s.reviewer.agentId},'approve');
        if(!mutation.allowed)throw error('The selected agent cannot approve this phase.',mutation.code,mutation);
        const required=new Set(primaryDocumentPublicationRequirements(workflow,phase,{definition:approved.compiled.definition}));
        for(const owner of packets.publicationOwners(s.proof.published))required.delete(owner);
        const policyChecklist=packets.publicationChecklist(s.proof.published,s.reviewer.actor,input.checklist??[]);
        // Check the authenticated human before inviting answers; legacy ordering stays unchanged.
        const checklistAuthority=policyChecklist?principalApprovalPlan(workflow,phase,s.reviewer,{author:s.proof.published.actor,active:s.active.decisions}):null;
        if(policyChecklist?.result.errors.length)throw error('Complete the human checklist for this exact submitted generation before approval.','APPROVAL_CHECKLIST_INCOMPLETE',{
          workId,phase:s.phaseId,errors:policyChecklist.result.errors,checklist:STARTER_CHECKLIST.id,articles:STARTER_CHECKLIST.articles,
          actions:[{operation:'phase.approve',inputs:{workId,phaseId:s.phaseId,confirmation:s.reviewBinding}}]});
        if(!policyChecklist&&input.checklist?.length)required.add('approval-checklist');
        if(s.proof.published.checks)required.delete('check-execution'); // The submission reader verified actual immutable execution proof.
        if(skillPhaseHostRequirement(workflow,phase))required.add('qualified-skill-host');
        if(phase.approvalPolicy.mode!=='required')required.add('automatic-approval-disposition');
        if(workflow.resolution.presence)required.add('person-presence');
        if(s.routed&&!s.proof.value.routing)required.add('namespace-submission-routing');
        for(const key of ['selectionReceipt','witnessMappings','bindingDecisions','decisions','confirmEvidence','evidenceReason','fetch']) {
          if(input[key]!=null&&input[key]!==false&&(!Array.isArray(input[key])||input[key].length))required.add('approval-'+key);
        }
        if(input.agent!=null&&input.agent!==s.reviewer.agentId)throw error('Approval uses the authenticated agent, never the request agent.','ENGINE_ACTOR_CHANGED');
        if(required.size)throw error('This approval needs additional policy or execution owners.','ENGINE_PORT_UNAVAILABLE',{
          operation:'phase.approve',required:[...required].sort()});
        const policy=checklistAuthority??principalApprovalPlan(workflow,phase,s.reviewer,{author:s.proof.published.actor,active:s.active.decisions});
        const outcome=policy.reached&&s.routed?decisionOutcomeFacts(workflow,phase):null;
        s.approvalPolicy={reached:policy.reached,reworkTarget:outcome?.kind==='loop'?outcome.target:null};
        s.dispositionRequired=packets.publicationRequiresDisposition(s.proof.published,s.approvalPolicy);
        s.dispositionEvidence=await packets.publicationApproval(s.proof.published,{...s.approvalPolicy,snapshot,
          at:s.dispositionRequired?projectEnrollmentTimestamp(await now()):null,signal});
        if(plan) {
          const original=await retained(plan,s,signal);
          if(original.value.authorityGroup!==policy.authorityGroup||original.value.selfApproval!==policy.selfApproval||original.value.thresholdReached!==policy.reached) {
            throw error('The retained approval no longer matches its policy basis.','ENGINE_CONTEXT_CHANGED');
          }
          s.plan=plan;
        }else {
          const recordedAt=projectEnrollmentTimestamp(await now()),set=namespaceApprovalArtifactSetRecord({projectId:scope.projectId,workId,phase:s.phaseId,generation:phase.generation,
            reviewPacket:s.proof.binding.record,artifact:{sourceKey:s.proof.published.artifact.sourceKey,kind:s.proof.published.artifact.kind,content:s.proof.published.artifact.content}},{policyChecklist});
          namespaceApprovalArtifactSetValue(set,{projectId:scope.projectId,workId,phaseId:s.phaseId});
          const route=s.routed?routing(workflow,phase,policy.reached,recordedAt):null;
          const artifactSet=await save(set,signal),value=namespaceApprovalRecord({projectId:scope.projectId,workId,phase:s.phaseId,
            generation:phase.generation,operationId:s.operationId,requestSha256:s.requestSha256,baseRevision:snapshot.revision,configuration:snapshot.configuration,
            reviewPacket:s.proof.binding.record,artifactSet,actor:s.reviewer.actor,agentId:s.reviewer.agentId,recordedAt,
            authorityGroup:policy.authorityGroup,selfApproval:policy.selfApproval,thresholdReached:policy.reached,currentPhase:s.routed?route.selected.currentPhase:s.phaseId},
            {routing:route?.value??null});
          // Only the checked human threshold can complete this ordinary sequential phase.
          if(!s.routed&&policy.reached) {
            resolvePhaseChangeRequests(workflow,phase,{at:recordedAt,actor:s.reviewer.actor.principalId});
            advanceCompletedPhase(workflow,phase,recordedAt);
          }
          if(!s.routed)value.currentPhase=workflow.currentPhase;
          namespaceApprovalValue(value,{projectId:scope.projectId,workId,phaseId:s.phaseId});
          const reference=await save(value,signal),binding=namespaceApprovalBindingValue({schemaVersion:NAMESPACE_APPROVAL_SCHEMAS.binding.currentVersion,
            format:'sflow-namespace-phase-approval-binding/v1',generation:phase.generation,record:reference});
          let proposed=workflow;
          if(s.routed)proposed=routedWorkflow(workflow,s.phaseId,value,binding);
          else {
            const decision=namespaceApprovalDecision(value,binding);recordPhaseApprovalState(phase,decision,{key:value.actor.principalId,reached:policy.reached});
            workflow.history.push({at:recordedAt,actor:value.actor.principalId,agent:value.agentId,event:'phase_approved',phase:s.phaseId,
              detail:policy.reached?'required human approvals recorded':'human approval recorded; threshold not yet met'});
          }
          const body=lifecycleRecord('state',{projectId:scope.projectId,workId,authorityId:authority.id,epoch:authority.epoch,configuration:snapshot.configuration.content,workflow:proposed});
          await authorize(signal,s.reviewer);await unchanged(snapshot,signal);
          const evidence=[...new Map([reference,artifactSet,value.reviewPacket,s.proof.value.publication.record,s.proof.published.artifact.content,
            ...packets.publicationPolicyEvidence(s.proof.published),...s.dispositionEvidence].map(ref=>[canonicalJson(ref),ref])).values()];
          try {await committer.prepare(snapshot,{operationId:s.operationId,operation:'phase.approve',inputsSha256:s.requestSha256,
            state:Buffer.from(canonicalJson(body)),evidence},{signal});}
          catch(cause){if(!['ENGINE_OPERATION_ID_REUSED','SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
            const competing=checkedPlan(await committer.intent(s.operationId,{signal}),s);if(!competing)throw cause;await retained(competing,s,signal);}
          s.plan=checkedPlan(await committer.intent(s.operationId,{signal}),s);
        }
        if(!s.plan)throw error('Approval preparation has no retained candidate.','ENGINE_STORAGE_CORRUPT');
        const token=Object.freeze({confirmation:s.reviewBinding});preparations.set(token,{context,snapshot});return token;
      },async accepted=>{
        const plan=checkedPlan(await committer.intent(s.operationId,{signal}),s);
        if(!plan)throw error('The accepted approval lost its retained candidate.','ENGINE_STORAGE_CORRUPT');
        await retained(plan,s,signal);s.plan=plan;
        const token=Object.freeze({confirmation:s.reviewBinding});preparations.set(token,{context,accepted});return token;
      },{signal});
    },
    async commit(context,token,{signal}={}) {
      const s=selected(context),p=preparations.get(token);if(!p||p.context!==context)throw error('Use this approval preparation.','ENGINE_INPUT_INVALID');
      if(p.accepted)return p.accepted;
      return commitNamespaceOperation(committer,s.operationId,async()=>{await authorize(signal,s.reviewer);await unchanged(p.snapshot,signal);
        if(s.dispositionRequired)await packets.publicationApproval(s.proof.published,{...s.approvalPolicy,snapshot:p.snapshot,at:projectEnrollmentTimestamp(await now()),signal});},{signal});
    },
    async finish(context,_prepared,accepted) {
      const s=selected(context),plan=checkedPlan(await committer.intent(s.operationId),s);
      if(!plan)throw error('The accepted approval lost its retained candidate.','ENGINE_STORAGE_CORRUPT');
      return facts(s,await retained(plan,s),accepted);
    }
  };
  return {approval};
}

export function createNamespaceApprovalEngine({records,content,scope,workId,authority,access,clock,localContent=null}={}) {
  scope=namespaceScope(scope);const options={records,content,scope,workId,authority,access,clock,localContent};
  const ports=createNamespaceApprovalPorts(options);
  return createEngine({ports:{...createNamespaceReadPorts(options),...ports}});
}
