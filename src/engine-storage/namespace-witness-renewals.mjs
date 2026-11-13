/** Original-owner human renewals over authenticated mapping approvals. No tests, source edits or approval rewriting. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {witnessExceptionRenewalPolicies,witnessRenewalExpiryValue} from '../kernel/human-witnesses.mjs';
import {standaloneDecisionAdmission,standaloneDecisionRequest} from '../kernel/decision-plan.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {createNamespaceStoryObserver,memoNamespaceObservedDecision} from './namespace-story-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {createNamespaceRecordedMutationPort} from './namespace-recorded-mutation.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {namespaceWitnessMappingContext} from './namespace-witness-mapping-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),operation='decision.witness-exception',
  fail=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>{throw new SingularityFlowError(message,{code,details});},
  rules=witnessExceptionRenewalPolicies({renewedWitnessExpiry:(workflow,phase,generation,mapping)=>witnessRenewalExpiryValue(workflow.witnessExceptionRenewals,phase,generation,mapping)});
export function createNamespaceWitnessRenewalOwner({observer,scope,workId}){
  const checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),packets=createNamespaceSubmissionReader({observer,scope,workId,checks});let reader;
  async function admitted(snapshot,options={}){
    const rows=snapshot.workflow.namespaceWitnessExceptionRenewals??[],links=namespaceDecisionContract.receipts(snapshot.workflow).filter(row=>row.operation===operation);
    if(!Array.isArray(rows)||rows.length!==links.length||rows.length>128)fail('The exception renewals lost their original human receipts.');
    const proofs=[];for(const link of links)proofs.push(await memoNamespaceObservedDecision(observer,{profile:'sflow-namespace-witness-renewal/v1',record:link.record},()=>reader.accepted(link,options),options));
    if(!same(rows,proofs.map(row=>row.value.outcome.record)))fail('The renewal list differs from its accepted original decisions.');return proofs;
  }
  const owner={agentPhase:snapshot=>snapshot.workflow.currentPhase,
    async read(snapshot,request,options={}){
      const previous=await admitted(snapshot,options),phase=snapshot.workflow.phases[request.phaseId];
      if(!phase||phase.status!=='approved')fail('Renew an exception recorded by the current approved generation of its original phase.','WITNESS_EXCEPTION_UNKNOWN');
      const [proof]=await packets.inspectApprovedMany(snapshot,[request.phaseId],options);
      if(!proof||!rules.witnessException(snapshot.workflow,request.phaseId,request.mappingSha256))fail('This approved phase has no such exact test exception.','WITNESS_EXCEPTION_UNKNOWN');
      return {generation:phase.generation,identity:{profile:'sflow-namespace-witness-renewal-source/v1',publication:proof.value.publication,
        packet:proof.binding.record,approvals:phase.approvals.filter(row=>!row.invalidatedAt&&row.generation===phase.generation).map(row=>row.namespaceVote),
        previous:previous.map(row=>row.reference)},references:[proof.value.publication.record,proof.binding.record,
          ...phase.approvals.filter(row=>!row.invalidatedAt&&row.generation===phase.generation).map(row=>row.namespaceVote.record),...previous.map(row=>row.reference)]};
    },
    authority(workflow,request,actor){
      if(workflow.resolution.presence)fail('Supply the configured original person-presence evidence.','ENGINE_PORT_UNAVAILABLE',{required:['person-presence']});
      return requireApprovalAuthority(workflow.resolution.approvalAuthorities,workflow.phases[request.phaseId].approvalPolicy,actor.identity).authorityGroup;
    },
    plan(workflow,request,facts){
      standaloneDecisionAdmission(operation,workflow);const proposed=structuredClone(workflow),native=structuredClone(workflow);
      native.witnessExceptionRenewals=structuredClone(workflow.namespaceWitnessExceptionRenewals??[]);
      const record=rules.recordWitnessExceptionRenewal(native,{phaseId:request.phaseId,mappingSha256:request.mappingSha256,expires:request.expires,
        reason:request.reason,actor:facts.actorId,authorityGroup:facts.authorityGroup,at:facts.at});
      proposed.namespaceWitnessExceptionRenewals=[...structuredClone(workflow.namespaceWitnessExceptionRenewals??[]),record];
      return {workflow:proposed,outcome:{currentPhase:workflow.currentPhase,record}};
    }
  };
  reader=createNamespaceRecordedMutationReader({observer,scope,workId,operation,owner,contract:namespaceDecisionContract});
  async function effective(snapshot,options={}){
    if((snapshot.workflow.witnessExceptionRenewals??[]).length)fail('Native renewal records need their native receipt and presence owner.','ENGINE_PORT_UNAVAILABLE',{required:['native-witness-renewal']});
    const phases=Object.values(snapshot.workflow.phases).filter(phase=>phase.status==='approved'&&(phase.approvals??[]).some(row=>row.witnessMappings?.length));
    if(phases.length)await packets.inspectApprovedMany(snapshot,phases.map(phase=>phase.id),options);
    const proofs=await admitted(snapshot,options),rows=proofs.map(row=>row.value.outcome.record),latest=new Map(),owners={};
    for(const phase of Object.values(snapshot.workflow.phases))for(const approval of phase.approvals??[]){
      if(phase.status!=='approved'||approval.invalidatedAt||approval.decision!=='approved'||approval.generation!==phase.generation)continue;
      for(const mapping of approval.witnessMappings??[]){const expiry=witnessRenewalExpiryValue(rows,phase.id,phase.generation,mapping.mappingSha256);
        latest.set(mapping.mappingSha256,{...mapping,...(expiry&&mapping.decision==='exception'?{expiresAt:expiry}:{})});owners[mapping.mappingSha256]=phase.id;}
    }
    return {decisions:[...latest.values()],owners,references:proofs.map(row=>row.reference)};
  }
  return Object.freeze({owner,reader,admitted,effective,packets});
}
export function createNamespaceWitnessRenewalPorts(options){
  const {scope,workId,access}=options,observer=createNamespaceStoryObserver(options),owned=createNamespaceWitnessRenewalOwner({observer,scope,workId}),
    decision=createNamespaceRecordedMutationPort(options,{operation,request:input=>standaloneDecisionRequest(operation,input),owner:owned.owner,contract:namespaceDecisionContract,
      finish:(value,revision,{replayed})=>({profile:'sflow-namespace-witness-renewal-outcome/v1',workId,phase:value.phase,recordKind:'witness-exception-renewal',record:value.outcome.record,
        revision:replayed?null:revision,pushed:false,retained:replayed,actorId:value.actor.principalId,authorityGroup:value.authorityGroup,currentPhase:value.outcome.currentPhase})}),contexts=new WeakMap(),contextOperation='test-witness.context';
  const context={async load(input,{signal}={}){
    if(input.workId!=null&&input.workId!==workId)fail('Use the bound Story.','ACTIVE_SUBJECT_MISMATCH');
    const principal=phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation:contextOperation,signal}),scope.projectId,contextOperation),
      captured=await observer.capture({signal}),phaseId=input.phaseId??captured.snapshot.workflow.currentPhase,
      value={subject:{kind:'story',id:workId},workflow:captured.snapshot.workflow,phase:captured.snapshot.workflow.phases[phaseId]};
    if(!value.phase)fail('Name a phase of this Story.','ENGINE_PHASE_UNAVAILABLE');contexts.set(value,{captured,principal});return value;
  },async read(context,{signal}={}){
    const saved=contexts.get(context);if(!saved)fail('Use the issued test witness context.','ENGINE_INPUT_INVALID');
    const proof=await owned.packets.inspect(saved.captured.snapshot,context.phase.id,{signal});
    if(!proof)fail('Submit the published Code generation before reviewing its exact test mappings.','PHASE_SUBMISSION_REQUIRED',{
      actions:[{operation:'phase.submit',inputs:{workId,phaseId:context.phase.id}}]});
    const plan=await owned.packets.publicationReader.specifications.sourcePlan(saved.captured.snapshot,context.phase.id,{signal}),
      selected=namespaceWitnessMappingContext(saved.captured.snapshot,proof.published,plan,owned.packets.publicationReader.policies.codeEvidence(proof.published)),
      renewals=await owned.effective(saved.captured.snapshot,{signal});
    phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation:contextOperation,signal}),scope.projectId,contextOperation,{expected:saved.principal});
    const fresh=await observer.capture({signal});if(fresh.snapshot.revision!==saved.captured.snapshot.revision||fresh.basis.authorityVersion!==saved.captured.basis.authorityVersion)
      fail('The Story or authority changed during witness inspection.','ENGINE_CONTEXT_CHANGED');
    return {...selected.identity,contextSha256:selected.contextSha256,mappings:selected.mappings,approvedMappings:renewals.decisions,
      revision:saved.captured.snapshot.revision,approvalRecorded:false,authorities:context.phase.approvalPolicy.authorities};
  }};
  return Object.freeze({decision,context});
}
