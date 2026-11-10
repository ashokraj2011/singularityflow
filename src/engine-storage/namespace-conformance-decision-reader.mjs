/** Exact conformance context and upstream-owner decisions over immutable publication proof. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {conformanceDecisionAuthority,planConformanceDecision,conformanceDecisionActive} from '../kernel/conformance-decisions.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceHumanDecisionReader} from './namespace-human-decision-reader.mjs';
import {namespaceHumanDecisionReceipts} from './namespace-human-decision-contract.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const error=(message,code,details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceConformanceDecisionOwner({observer,scope,workId}){
  let publications;
  const reader=()=>publications??=createNamespacePublicationReader({observer,scope,workId,
    checks:createNamespacePhaseCheckReader({...observer.evidenceReads,observer})});
  async function read(snapshot,request,{signal}={}){
    const phase=snapshot.workflow.phases[request.phaseId],binding=phase?.publicationBindings?.find(row=>row.generation===phase.generation);
    if(!binding)throw error('Publish the exact conformance generation before deciding its gaps.','PHASE_PUBLICATION_REQUIRED');
    const publication=await reader().accepted(binding,request.phaseId,{signal}),proof=reader().policies.conformanceEvidence(publication);
    if(!proof)throw error('This publication has no retained conformance report.','ENGINE_PORT_UNAVAILABLE',{required:['retained-conformance-policy']});
    const identity={publication:binding,policy:proof.binding,report:proof.manifest.report},generation=publication.generation,
      expected=hash({projectId:scope.projectId,workId,phase:request.phaseId,generation,configuration:publication.configuration,...identity});
    return {identity,generation,expected,gaps:proof.report.gaps,publication,proof,
      references:[binding.record,publication.artifact.content,...reader().policies.evidence(publication)]};
  }
  const owner={read,authority:conformanceDecisionAuthority,plan:planConformanceDecision};
  const decisions=createNamespaceHumanDecisionReader({observer,scope,workId,operation:'conformance.decide',owner});
  async function retained(snapshot,source,{signal,at}={}){
    const latest=new Map();
    for(const link of namespaceHumanDecisionReceipts(snapshot.workflow).filter(row=>row.operation==='conformance.decide'
      &&row.phase===source.publication.phase&&row.generation===source.generation)){
      const proof=await decisions.accepted(link,{signal}),value=proof.value;
      if(value.request.expected!==source.expected||!same(value.source,source.identity))throw error('The decision names another retained conformance binding.','ENGINE_STORAGE_CORRUPT');
      const key=canonicalJson([value.request.clauseId,value.request.ownerPhase]),previous=latest.get(key);
      if(previous&&conformanceDecisionActive(previous.value,value.recordedAt))throw error('This conformance gap has duplicate active decisions.','ENGINE_STORAGE_CORRUPT');
      latest.set(key,proof);
    }
    return [...latest.values()].map(proof=>({...proof,active:conformanceDecisionActive(proof.value,at)}));
  }
  owner.assertNew=async(snapshot,request,source,{signal,at})=>{
    for(const link of namespaceHumanDecisionReceipts(snapshot.workflow).filter(row=>row.operation==='conformance.decide'&&row.phase===request.phaseId&&row.generation===source.generation)){
      const value=await decisions.decode(link.record,{signal});
      if(value.request.clauseId!==request.clauseId||value.request.ownerPhase!==request.ownerPhase)continue;
      const previous=await decisions.accepted(link,{signal});
      if(previous.value.request.expected!==source.expected)throw error('The decision has another original report.','ENGINE_STORAGE_CORRUPT');
      if(conformanceDecisionActive(previous.value,at))throw error('This exact gap already has an active human disposition. Use the retained receipt.','ENGINE_CONFORMANCE_ALREADY_DECIDED',{
        operationId:previous.value.operationId,outcome:previous.value.request.outcome});
    }
  };
  return Object.freeze({owner,decisions,retained});
}
