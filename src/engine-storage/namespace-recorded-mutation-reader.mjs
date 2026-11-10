/** Recompute a human mutation from its original accepted conditional receipt, never a state flag. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {phaseAgentMutationFacts} from '../kernel/phase-admission.mjs';
import {namespaceAcceptedEvidence} from './namespace-lifecycle-receipt-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const corrupt=cause=>new SingularityFlowError('The human decision does not replay its original authority, evidence and transition.',{code:'ENGINE_STORAGE_CORRUPT',cause});
export function createNamespaceRecordedMutationReader({observer,scope,workId,operation,owner,contract}){
  async function admitAgent(snapshot,phaseId,agentId,{signal}={}){
    phaseId=owner.agentPhase?.(snapshot,phaseId)??phaseId;
    const approved=await observer.approved(snapshot,{signal}),facts=phaseAgentMutationFacts({agents:Object.fromEntries(
      approved.compiled.definition.agentCatalog.map(row=>[row.id,row]))},snapshot.workflow,snapshot.workflow.phases[phaseId],{agent:agentId},operation.split('.').at(-1));
    if(!facts.allowed)throw new SingularityFlowError('This phase agent cannot record the human mutation.',{code:facts.code,details:facts});
  }
  async function decode(reference,{signal}={}){
    const bytes=await observer.bytes(reference,reference.bytes,signal);let value;
    try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch(cause){throw corrupt(cause);}
    return contract.value(value,{projectId:scope.projectId,workId});
  }
  function proposed(workflow,value,reference,source){
    const planned=owner.plan(workflow,value.request,{at:value.recordedAt,actor:value.actor,actorId:value.actor.principalId,actorKind:value.actor.actorKind,
      agentId:value.agentId,authorityGroup:value.authorityGroup},source);
    if(!same(planned.outcome,value.outcome))throw corrupt();
    planned.workflow[contract.receiptField]=[...structuredClone(contract.receipts(workflow)),contract.receipt(value,reference)];
    return planned.workflow;
  }
  async function verify(plan,reference,{signal,policyTraversal}={}){
    const value=await decode(reference,{signal}),head=plan.basis.head,
      original=await observer.state(await observer.bytes(head.state,head.state.bytes,signal),head,{signal}),
      snapshot={revision:plan.basis.headVersion,configuration:head.configuration,workflow:original.workflow},
      source=await owner.read(snapshot,value.request,{signal,at:value.recordedAt,policyTraversal,bound:value.source});
    if(value.operation!==operation||plan.operation!==operation||value.operationId!==plan.operationId||value.requestSha256!==plan.inputsSha256
      ||value.requestSha256!==hash({workId,request:value.request})||value.baseRevision!==plan.basis.headVersion
      ||!same(value.configuration,head.configuration)||value.generation!==source.generation||!same(value.source,source.identity)
      ||!same(plan.readBindings??[],source.readBindings??[])
      ||![reference,...source.references].every(ref=>plan.evidence.some(row=>same(row,ref))))throw corrupt();
    await admitAgent(snapshot,value.phase,value.agentId,{signal});
    await owner.assertNew?.(snapshot,value.request,source,{signal,at:value.recordedAt,policyTraversal});
    let proposal;
    try{if(owner.authority(original.workflow,value.request,value.actor,source)!==value.authorityGroup)throw corrupt();
      proposal=proposed(original.workflow,value,reference,source);
    }catch(cause){if(cause.code==='ENGINE_STORAGE_CORRUPT')throw cause;throw corrupt(cause);}
    const body=await observer.state(await observer.bytes(plan.state,plan.state.bytes,signal),head,{signal});
    if(!same(body.workflow,proposal))throw corrupt();
    return {value,reference,source,original:snapshot};
  }
  async function accepted(link,{signal,policyTraversal}={}){
    const value=await decode(link.record,{signal}),proof=await namespaceAcceptedEvidence(observer,{record:link.record},value,operation,{signal}),
      verified=await verify(proof.plan,link.record,{signal,policyTraversal});
    if(!same(link,contract.receipt(value,link.record))
      ||!contract.receipts(proof.state.workflow).some(row=>same(row,link)))throw corrupt();
    return {...verified,accepted:proof};
  }
  return Object.freeze({decode,verify,accepted,proposed,admitAgent});
}
