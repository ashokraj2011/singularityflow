/** Human article decisions through the registry; storage and proof readers remain separate. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {standaloneDecisionRequest} from '../kernel/decision-plan.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceRecordedMutationPort} from './namespace-recorded-mutation.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespaceConstitutionExceptionOwners} from './namespace-constitution-exception-reader.mjs';
export function createNamespaceConstitutionExceptionPorts(options){
  const {scope,workId,access}=options,observer=createNamespaceStoryObserver(options),owned=createNamespaceConstitutionExceptionOwners({observer,scope,workId}),states=new WeakMap(),
    operation='constitution.exception.context',context={async load(input,{signal}={}){
      if(input.workId!=null&&input.workId!==workId)throw new SingularityFlowError('Use the bound Story.',{code:'ACTIVE_SUBJECT_MISMATCH'});
      const principal=phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation,signal}),scope.projectId,operation),
        snapshot=(await observer.inspect({signal})).snapshot,value={subject:{kind:'story',id:workId},workflow:snapshot.workflow};
      states.set(value,{snapshot,principal,request:{phaseId:input.phaseId??snapshot.workflow.currentPhase,articleId:input.articleId}});return value;
    },async read(context,{signal}={}){const state=states.get(context);if(!state)throw new SingularityFlowError('Use the issued article context.',{code:'ENGINE_INPUT_INVALID'});
      const source=await owned.source(state.snapshot,state.request,{signal});
      phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation,signal}),scope.projectId,operation,{expected:state.principal});
      if((await observer.inspect({signal})).snapshot.revision!==state.snapshot.revision)throw new SingularityFlowError('The submitted article changed during review.',{code:'ENGINE_CONTEXT_CHANGED'});
      const workflow=state.snapshot.workflow,phase=workflow.phases[state.request.phaseId],policy=phase.approvalPolicy,
        active=workflow.status==='in_progress'&&workflow.currentPhase===phase.id&&phase.status==='awaiting_approval';
      return {schemaVersion:1,format:'sflow-namespace-constitution-exception-context/v1',workId,phase:state.request.phaseId,generation:source.generation,revision:state.snapshot.revision,
        article:source.article,expectedContext:source.contextBinding,source:source.identity,existing:source.prior.filter(row=>row.articleId===state.request.articleId),
        authorities:[...new Set([...(policy.authorities??[]),...(policy.requiredAuthorities??[])])],
        recording:{status:!active?'read-only':workflow.resolution.presence?'owner-required':'requires-human-review',requiredOwners:workflow.resolution.presence?['person-presence']:[]},
        read:{operation:'phase.review.resources',inputs:{workId,phaseId:state.request.phaseId}},machinePoliciesWaived:false,phaseApproved:false};
    }},decision=createNamespaceRecordedMutationPort(options,{operation:'decision.constitution-exception',explicitIdentity:true,
      request:input=>standaloneDecisionRequest('decision.constitution-exception',input),owner:owned.owner,contract:namespaceDecisionContract,
      finish:(value,revision)=>({workId,phase:value.phase,recordKind:'constitution-exception',record:value.outcome.record,revision,pushed:false,
        actorId:value.actor.principalId,authorityGroup:value.authorityGroup,currentPhase:value.outcome.currentPhase})});
  return Object.freeze({context,decision});
}
