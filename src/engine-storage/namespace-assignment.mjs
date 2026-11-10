/** One conditional assignment writer; coordination grants no approval or authoring permissions. */
import {standaloneDecisionRequest} from '../kernel/decision-plan.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceRecordedMutationPort} from './namespace-recorded-mutation.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespaceAssignmentOwners} from './namespace-assignment-reader.mjs';
export function createNamespaceAssignmentPort(options){const {workId,scope}=options,observer=createNamespaceStoryObserver(options),
  owned=createNamespaceAssignmentOwners({observer,scope,workId});
  return createNamespaceRecordedMutationPort(options,{operation:'phase.assign',request:input=>standaloneDecisionRequest('phase.assign',input),
    owner:owned.owner,contract:namespaceDecisionContract,requiresHuman:false,explicitIdentity:true,
    finish:(value,revision)=>({workId,phase:value.phase,recordKind:'phase-assignment',record:value.outcome.record,revision,pushed:false,
      actorId:value.actor.principalId,authorityGroup:null,currentPhase:value.outcome.currentPhase})});
}
