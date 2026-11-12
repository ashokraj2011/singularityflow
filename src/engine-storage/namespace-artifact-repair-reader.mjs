/** Read original target bundles and authenticated human returns. No private or shared writes. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {rejectionTarget} from '../kernel/approval-policy.mjs';
import {namespaceArtifactSetPolicies} from '../kernel/namespace-artifact-sets.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../engine-compatibility/node-configuration-path.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceRejectionReader} from './namespace-rejection-reader.mjs';
import {namespaceHumanDecisionReceipts} from './namespace-human-decision-contract.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),error=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceArtifactRepairReader({observer,scope,workId,publications:providedPublications=null,packets:providedPackets=null}){
  const checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),
    publications=providedPublications??createNamespacePublicationReader({observer,scope,workId,checks}),
    packets=providedPackets??createNamespaceSubmissionReader({observer,scope,workId,checks}),
    policies=namespaceArtifactSetPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_DIGESTS);
  async function target(snapshot,request,{signal,policyTraversal}={}){
    const workflow=snapshot.workflow,{targetId}=rejectionTarget(workflow,workflow.phases[request.phaseId],request.target),phase=workflow.phases[targetId],
      definition=(await observer.approved(snapshot,{signal})).compiled.definition,
      selected=policies.repairSelection(definition,workflow,phase,request.members),
      binding=phase.publicationBindings?.find(row=>row.generation===phase.generation);
    if(!binding)throw error('A member return needs the exact retained target publication.','ENGINE_PUBLICATION_REQUIRED',{phase:targetId});
    const publication=await publications.accepted(binding,targetId,{signal,policyTraversal}),bundle=publications.policies.artifactSetEvidence(publication);
    if(!bundle)throw error('The target needs its original typed bundle proof.','ENGINE_PORT_UNAVAILABLE',{required:['retained-artifact-set'],phase:targetId});
    const proof=phase.status==='approved'?(await packets.inspectApprovedMany(snapshot,[targetId],{signal,policyTraversal}))[0]
      :targetId===request.phaseId?await packets.inspect(snapshot,targetId,{signal,policyTraversal}):null;
    if(!proof||!same(proof.value.publication,binding))throw error('The target bundle needs its original submitted or independently approved packet.');
    const identity={profile:'sflow-namespace-artifact-return-source/v1',phase:targetId,generation:phase.generation,publication:binding,
      reviewPacket:proof.binding.record,bundle:{binding:bundle.binding,report:bundle.manifest.report},members:selected.members};
    return {identity,publication,bundle,references:[binding.record,proof.binding.record,publication.artifact.content,...publications.policies.evidence(publication)]};
  }
  async function active(snapshot,phaseId,{signal,policyTraversal}={}){
    const workflow=snapshot.workflow,phase=workflow.phases[phaseId],reopen=phase?.surgicalReopen;
    if(!reopen)return null;
    if(reopen.profile!=='sflow-namespace-artifact-reopen/v1')throw error('This output return requires its declared compatibility owner.','ENGINE_PORT_UNAVAILABLE',{
      required:['artifact-reopen-profile'],phase:phaseId});
    if(phase.generation>reopen.previousGeneration)return null;
    if(phase.generation!==reopen.previousGeneration||phase.reworkRevalidation?.generation!==phase.generation)throw error('The output return has another original generation.');
    const request=(workflow.changeRequests??[]).find(row=>row.id===reopen.changeRequestId);
    if(!request||request.status!=='open'||request.targetPhase!==phaseId)throw error('The output reopen lost its exact open change request.');
    const returns=createNamespaceRejectionReader({observer,scope,workId});let retained=null;
    for(const link of namespaceHumanDecisionReceipts(workflow).filter(row=>row.operation==='phase.reject'&&row.phase===request.sourcePhase&&row.generation===request.sourceGeneration).reverse()){
      const value=await returns.decode(link.record,{signal});
      if(value.outcome.changeRequest.id!==request.id)continue;
      const proof=await returns.accepted(link,{signal,policyTraversal});
      if(!same(proof.value.outcome.changeRequest,request)||!same(proof.accepted.state.workflow.phases[phaseId].surgicalReopen,reopen)
        ||phase.reworkRevalidation.invalidatedAt!==value.recordedAt||!value.source.artifactRepair)throw error('The output return differs from its original human decision.');
      retained={link,proof};break;
    }
    if(!retained)throw error('A copied reopen cannot authorize target member repair.');
    const source=retained.proof.source.artifactRepair;
    if(!source||source.identity.phase!==phaseId||source.identity.generation!==phase.generation||!same(source.identity.members,reopen.members))throw error('The target repair lost its original bundle scope.');
    return {...source,receipt:retained.link,changeRequestId:request.id,
      references:[retained.link.record,...source.references]};
  }
  return Object.freeze({target,active,description:policies.repairEntry});
}
