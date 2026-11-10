/** Authenticate coordination records without acquiring a writer, checkout or approval capability. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,NAMESPACE_PHASE_POLICY_SCHEMAS} from '../foundation/record-schema.mjs';
import {phaseAssignmentSelection,recordPhaseAssignmentState} from '../kernel/phase-policy.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {namespaceDecisionContract,namespaceDecisionReceipts} from './namespace-decision-contract.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex'),operation='phase.assign';
const error=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceAssignmentOwners({observer,scope,workId}){
  let reader;
  async function admitted(snapshot,{signal,policyTraversal}={}){
    const assignments=snapshot.workflow.collaboration?.assignments??{},links=namespaceDecisionReceipts(snapshot.workflow).filter(row=>row.operation===operation);
    if(!links.length){if(Object.keys(assignments).length)throw error('Assignments need their actual accepted coordination receipts.');return {assignments,references:[]};}
    const proof=await reader.accepted(links.at(-1),{signal,policyTraversal});
    if(!same(assignments,proof.accepted.state.workflow.collaboration?.assignments??{}))throw error('The assignment inventory differs from its last accepted operation.');
    return {assignments,references:links.map(row=>row.record)};
  }
  const owner={agentPhase:snapshot=>snapshot.workflow.currentPhase,
    async read(snapshot,request,options={}){phaseAssignmentSelection(snapshot.workflow,request.phaseId,request.assignee);
      const prior=await admitted(snapshot,options);return {generation:snapshot.workflow.phases[request.phaseId].generation,
        identity:{profile:'sflow-namespace-assignment-source/v1',assignmentsSha256:hash(prior.assignments)},references:prior.references};},
    authority(){return null;},
    plan(workflow,request,facts){const proposed=structuredClone(workflow),record=recordPhaseAssignmentState(proposed,request.phaseId,request.assignee,
      {actor:facts.actor.identity,agent:facts.agentId},{at:facts.at,actorId:facts.actorId});return {workflow:proposed,outcome:{currentPhase:workflow.currentPhase,record}};}
  };
  reader=createNamespaceRecordedMutationReader({observer,scope,workId,operation,owner,contract:namespaceDecisionContract});
  async function publication(snapshot,phaseId,options={}){const prior=await admitted(snapshot,options),record=prior.assignments[phaseId];
    if(!record)throw error('Assign the phase coordinator before publishing this required-assignment workflow.','ENGINE_ASSIGNMENT_REQUIRED',{
      phase:phaseId,actions:[{operation,inputs:{workId,phaseId},requiredInputs:['operationId','assignee']}]});
    return {report:{schemaVersion:NAMESPACE_PHASE_POLICY_SCHEMAS.assignmentReport.currentVersion,format:'sflow-namespace-phase-assignment-report/v1',phase:phaseId,assignment:record,decisions:prior.references},references:prior.references};}
  return Object.freeze({owner,reader,admitted,publication});
}
