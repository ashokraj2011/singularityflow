/** Exact human convergence review; submission still owns its final fresh conditional acceptance. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {isConvergencePhase,phaseNeedsGeneration} from '../kernel/phase-policy.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),error=(message,code,details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceConvergenceAdvancementPort(options){
  const {scope,workId,access}=options,observer=createNamespaceStoryObserver(options),
    checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),publications=createNamespacePublicationReader({observer,scope,workId,checks});
  async function authorize(signal,expected=null){const facts=await access.current({projectId:scope.projectId,workId,operation:'convergence.advance',signal}),
    principal=phaseTransitionAccess(facts,scope.projectId,'convergence.advance',{expected:expected?.principal??null}),permissions=[...facts.permissions].sort();
    if(principal.actor.actorKind!=='human')throw error('Convergence advancement requires an authenticated human confirmation.','ENGINE_HUMAN_AUTHORITY_REQUIRED');
    if(expected&&!same(permissions,expected.permissions))throw error('Convergence advancement permissions changed.','ENGINE_ACTOR_CHANGED');return {principal,permissions};}
  return {async withReview(input,review,{signal}={}){
    if(input.workId!=null&&input.workId!==workId)throw error('Use the bound Story.','ACTIVE_SUBJECT_MISMATCH');
    const actor=await authorize(signal),captured=await observer.capture({signal}),workflow=captured.snapshot.workflow,phase=workflow.phases[workflow.currentPhase];
    if(!phase||!isConvergencePhase(phase))throw error('Select the actual current convergence phase.','CONVERGENCE_PHASE_REQUIRED');
    const binding=phase.publicationBindings?.find(row=>row.generation===phase.generation);
    if(!binding||phaseNeedsGeneration(workflow,phase))throw error('Publish the exact deterministic convergence generation before advancement.','PHASE_GENERATION_REQUIRED',{
      actions:[{operation:'phase.prepare',inputs:{workId,phaseId:phase.id}}]});
    const published=await publications.accepted(binding,phase.id,{signal,snapshot:captured.snapshot}),found=publications.policies.convergenceReview(published,binding),
      projection=found.projection.projection;
    await authorize(signal,actor);const fresh=await observer.capture({signal});
    if(fresh.snapshot.revision!==captured.snapshot.revision||fresh.basis.authorityVersion!==captured.basis.authorityVersion)throw error('The convergence review binding changed.','ENGINE_CONTEXT_CHANGED');
    return review({subject:{kind:'story',id:workId},workflow,phase,review:{workId,phase:phase.id,generation:phase.generation,
      iteration:found.projection.iteration,findings:projection.findings.length,reconciliation:'sha256:'+projection.bindings.reconciliation.sha256,
      confirmationDigest:found.confirmation.confirmationDigest}});
  }};
}
