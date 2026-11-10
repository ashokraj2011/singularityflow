/** Registered conformance decisions and read context; retained proof is a separate read-only owner. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceHumanDecisionPort} from './namespace-human-decision.mjs';
import {createNamespaceConformanceDecisionOwner} from './namespace-conformance-decision-reader.mjs';
const error=(message,code,details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceConformanceDecisionPorts(options){
  const {scope,workId,access,clock}=options,observer=createNamespaceStoryObserver(options),
    owned=createNamespaceConformanceDecisionOwner({observer,scope,workId});
  function request(input){
    if(!input.phaseId||!input.expected||!input.clauseId||!input.ownerPhase||!input.outcome||input.fetch===true)throw error(
      'Use the exact conformance context, clause, upstream owner and human outcome.','ENGINE_INPUT_INVALID');
    return {phaseId:input.phaseId,expected:input.expected,clauseId:input.clauseId,ownerPhase:input.ownerPhase,outcome:input.outcome,
      expires:input.expires??null,reason:(input.reason??'').trim()};
  }
  const conformanceDecision=createNamespaceHumanDecisionPort(options,{operation:'conformance.decide',request,owner:owned.owner,
    finish:(value,revision)=>({workId,phase:value.phase,recordKind:'conformance-gap',record:value,revision,pushed:false,
      actorId:value.actor.principalId,authorityGroup:value.authorityGroup,currentPhase:value.outcome.currentPhase})});
  const contexts=new WeakMap(),conformanceContext={
    async load(input,{signal}={}){
      if(input.workId!=null&&input.workId!==workId)throw error('Use the bound Story.','ACTIVE_SUBJECT_MISMATCH');
      const facts=await access.current({projectId:scope.projectId,workId,operation:'conformance.context',signal});
      phaseTransitionAccess(facts,scope.projectId,'conformance.context');const snapshot=(await observer.inspect({signal})).snapshot,
        phaseId=input.phaseId??snapshot.workflow.currentPhase,context={subject:{kind:'story',id:workId},workflow:snapshot.workflow,phase:snapshot.workflow.phases[phaseId]};
      contexts.set(context,{snapshot,phaseId});return context;
    },
    async read(context,{signal}={}){
      const s=contexts.get(context);if(!s)throw error('Use the issued conformance context.','ENGINE_INPUT_INVALID');
      const source=await owned.owner.read(s.snapshot,{phaseId:s.phaseId},{signal}),at=await clock.now(),retained=await owned.retained(s.snapshot,source,{signal,at});
      const current=s.snapshot.workflow.status==='in_progress'&&s.snapshot.workflow.currentPhase===s.phaseId;
      return {phase:s.phaseId,generation:source.generation,expected:source.expected,publication:source.identity.publication,report:source.identity.report,
        gaps:source.gaps.map(gap=>({...gap,owners:gap.owners.map(owner=>{
          const retainedDecision=retained.find(row=>row.value.request.clauseId===gap.clauseId&&row.value.request.ownerPhase===owner),
            decision=retainedDecision?{operationId:retainedDecision.value.operationId,outcome:retainedDecision.value.request.outcome,
              expiresAt:retainedDecision.value.outcome.expiresAt,active:retainedDecision.active,record:retainedDecision.reference,
              actorId:retainedDecision.value.actor.principalId,authorityGroup:retainedDecision.value.authorityGroup,
              recordedAt:retainedDecision.value.recordedAt,reason:retainedDecision.value.outcome.reason}:null;
          return {phase:owner,authorities:[...(s.snapshot.workflow.phases[owner]?.approvalPolicy.authorities??[])],decision,
            choices:current&&!decision?.active?['accept-risk','dismiss'].map(outcome=>({operation:'conformance.decide',
              inputs:{workId,phaseId:s.phaseId,expected:source.expected,clauseId:gap.clauseId,ownerPhase:owner,outcome},
              requiredInputs:outcome==='accept-risk'?['reason','expires']:['reason']})):[]};
        })})),
        actions:current?[{operation:'phase.review.resources',inputs:{workId,phaseId:s.phaseId}},{operation:'phase.review',inputs:{workId,phaseId:s.phaseId}}]:[]};
    }
  };
  return {conformanceDecision,conformanceContext};
}
