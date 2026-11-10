/** Reconstruct a human route from its original question, authority, conditional receipt and state. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {planRoutingChoice,routingChoiceAuthority,routingChoiceRequirements} from '../kernel/routed-approval.mjs';
import {namespaceAcceptedEvidence} from './namespace-lifecycle-receipt-reader.mjs';
import {createNamespaceRoutingChoiceReader} from './namespace-routing-choice-reader.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {namespaceRoutingChoiceValue,namespaceRoutingChoiceReceipt,namespaceRoutingChoiceReceipts} from './namespace-routing-choice-contract.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const corrupt=message=>new SingularityFlowError(message,{code:'ENGINE_STORAGE_CORRUPT'});
export function createNamespaceRoutingReceiptReader({observer,scope,workId}) {
  const checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),
    packets=createNamespaceSubmissionReader({observer,scope,workId,checks}),
    questions=createNamespaceRoutingChoiceReader({observer,scope,workId,packets,checks});
  async function decode(reference,{signal}={}) {
    const bytes=await observer.bytes(reference,reference.bytes,signal);let value;
    try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch(cause){throw new SingularityFlowError(
      'The retained choice is not UTF-8 JSON.',{code:'ENGINE_STORAGE_CORRUPT',cause});}
    return namespaceRoutingChoiceValue(value,{projectId:scope.projectId,workId});
  }
  function proposed(workflow,value,reference) {
    const planned=planRoutingChoice(workflow,value.request,{at:value.recordedAt,actorId:value.actor.principalId,
      agentId:value.agentId,authorityGroup:value.authorityGroup});
    if(!same(planned.outcome,value.outcome)||planned.workflow.currentPhase!==value.currentPhase)throw corrupt('The choice changed its original pinned transition.');
    planned.workflow.namespaceRoutingChoiceReceipts=[...structuredClone(namespaceRoutingChoiceReceipts(workflow,{projectId:scope.projectId,workId})),namespaceRoutingChoiceReceipt(value,reference)];
    return planned.workflow;
  }
  function evidence(value,reference,proof) {return [reference,value.question.approval,proof.binding.record,proof.value.publication.record,proof.published.artifact.content];}
  async function requirements(snapshot,source,choice,{signal,policyTraversal}={}) {
    const workflow=snapshot.workflow,phase=workflow.phases[choice.phase],approved=(await observer.approved(snapshot,{signal})).compiled.definition,
      fulfilled=packets.publicationOwners(source.proof.published),reviewedPhases=[],references=[];
    if(source.proof.published.checks)fulfilled.push('check-execution');
    if(workflow.phaseOrder.some(id=>workflow.resolution.obligationGraph?.nodes?.find(node=>node.id===id)?.responsibilities?.some(role=>role!=='review'))) {
      const ids=workflow.phaseOrder.slice(0,workflow.phaseOrder.indexOf(phase.id)+1).filter(id=>workflow.phases[id].status==='approved'),
        proofs=await packets.inspectApprovedMany(snapshot,ids,{signal,policyTraversal});
      for(const [index,id]of ids.entries()) {
        const proof=proofs[index];if(!proof)throw corrupt('A reviewed return lost an original approved phase.');
        const owners=packets.publicationOwners(proof.published);if(proof.published.checks)owners.push('check-execution');
        if(!routingChoiceRequirements(workflow,workflow.phases[id],{definition:approved,fulfilled:owners,reviewedPhases:workflow.phaseOrder,outcome:choice.outcome}).length)reviewedPhases.push(id);
        references.push(proof.binding.record,proof.value.publication.record,...packets.publicationPolicyEvidence(proof.published));
      }
    }
    return {required:routingChoiceRequirements(workflow,phase,{definition:approved,fulfilled,reviewedPhases,outcome:choice.outcome}),references};
  }
  async function verify(plan,reference,{signal,policyTraversal}={}) {
    const value=await decode(reference,{signal}),head=plan.basis.head,
      original=await observer.state(await observer.bytes(head.state,head.state.bytes,signal),head,{signal}),
      snapshot={workflow:original.workflow,configuration:head.configuration,revision:plan.basis.headVersion},source=await questions.read(snapshot,{signal,policyTraversal}),
      link=namespaceRoutingChoiceReceipt(value,reference),body=await observer.state(await observer.bytes(plan.state,plan.state.bytes,signal),head,{signal});
    if(!source||plan.operation!=='decision.choose'||value.operationId!==plan.operationId||value.requestSha256!==plan.inputsSha256
      ||value.requestSha256!==hash({workId,request:value.request})||value.baseRevision!==plan.basis.headVersion||!same(value.configuration,head.configuration)
      ||value.phase!==source.selected.phase||value.generation!==source.approved.value.generation||!same(value.question.approval,source.approved.binding.record)
      ||!evidence(value,reference,source.proof).every(ref=>plan.evidence.some(row=>same(row,ref)))
      ||!namespaceRoutingChoiceReceipts(body.workflow,{projectId:scope.projectId,workId}).some(row=>same(row,link)))throw corrupt('The retained choice differs from its original question or evidence.');
    try{if(value.authorityGroup!==routingChoiceAuthority(original.workflow,value.actor)||!same(proposed(original.workflow,value,reference),body.workflow))throw corrupt('The retained choice does not replay its original human authority and whole transition.');}
    catch(cause){if(cause.code==='ENGINE_STORAGE_CORRUPT')throw cause;throw new SingularityFlowError(
      'The retained choice no longer proves its original human transition.',{code:'ENGINE_STORAGE_CORRUPT',cause});}
    const qualified=await requirements(snapshot,source,{phase:value.phase,outcome:value.outcome},{signal,policyTraversal});
    if(qualified.required.length||!qualified.references.every(ref=>plan.evidence.some(row=>same(row,ref))))throw corrupt('The original choice lost its delivery policy proofs.');
    return {value,reference,source,original:snapshot,state:body};
  }
  async function accepted(link,options={}) {
    const value=await decode(link.record,options),proof=await namespaceAcceptedEvidence(observer,{record:link.record},value,'decision.choose',options),
      verified=await verify(proof.plan,link.record,options);
    if(!same(link,namespaceRoutingChoiceReceipt(value,link.record)))throw corrupt('The routing link differs from its original receipt.');
    return {...verified,accepted:proof};
  }
  return Object.freeze({decode,proposed,evidence,requirements,verify,accepted,question:questions.read});
}
