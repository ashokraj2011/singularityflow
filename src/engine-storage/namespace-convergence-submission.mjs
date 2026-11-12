/** Bind an actual retained convergence projection to explicit confirmation; never accepts a ready flag. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,NAMESPACE_CONVERGENCE_SCHEMAS} from '../foundation/record-schema.mjs';
import {isConvergencePhase} from '../kernel/phase-policy.mjs';
import {namespaceSubmittedConvergence} from './namespace-convergence-contract.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
export function convergenceSubmissionEvidence(publications,published,binding,supplied,{projectId,workId,phaseId,generation}){
  const found=publications.policies.convergenceReview(published,binding),expected=found.confirmation.confirmationDigest;
  if(supplied!==expected)throw new SingularityFlowError('Review the current published convergence before confirming its exact digest.',{
    code:'CONVERGENCE_ADVANCE_CONFIRMATION_STALE',details:{expected,supplied,actions:[{operation:'convergence.advance',inputs:{workId}}]}});
  return namespaceSubmittedConvergence({schemaVersion:NAMESPACE_CONVERGENCE_SCHEMAS.confirmation.currentVersion,...found.confirmation,
    projection:found.reference,contextBinding:found.contextBinding},{projectId,workId,phaseId,generation});
}
export function verifyConvergenceSubmission(publications,published,packet,workflow=null){
  const required=workflow?isConvergencePhase(workflow.phases[packet.phase]):published.artifact.kind==='convergence-report';
  if(required!==(packet.convergence!==undefined))throw new SingularityFlowError('The submission lost its actual convergence confirmation.',{code:'ENGINE_STORAGE_CORRUPT'});
  if(!required)return;
  const expected=convergenceSubmissionEvidence(publications,published,packet.publication,packet.convergence.confirmationDigest,
    {projectId:packet.projectId,workId:packet.workId,phaseId:packet.phase,generation:packet.generation});
  if(!same(expected,packet.convergence)||packet.actor.actorKind!=='human')throw new SingularityFlowError(
    'The submitted convergence has another projection or confirming identity.',{code:'ENGINE_STORAGE_CORRUPT'});
}
