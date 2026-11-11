/** Authenticate bounded-return counters and actual reset approvals; no writes or execution. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,NAMESPACE_REPAIR_BUDGET_SCHEMA,admitRecordSchemaVersion} from '../foundation/record-schema.mjs';
import {repairBudgetPhaseForRejection} from '../kernel/test-recovery.mjs';
import {namespaceHumanDecisionReceipts} from './namespace-human-decision-contract.mjs';
import {namespaceDecisionReceipts} from './namespace-decision-contract.mjs';
import {createNamespaceRejectionReader} from './namespace-rejection-reader.mjs';
import {createNamespaceUpstreamOwners} from './namespace-upstream-reader.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {memoNamespaceObservedDecision} from './namespace-story-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),error=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceRepairBudgetReader({observer,scope,workId}){
  async function admitted(snapshot,options){
    const w=snapshot.workflow,history=w.namespaceRepairBudgetHistory??[],budgets=w.repairBudgets??{};
    // Lifecycle byte/node limits apply at decoding and acceptance; authenticate every retained prefix below.
    if(!Array.isArray(history)||!budgets||typeof budgets!=='object'||Array.isArray(budgets))throw error('The bounded-return history is invalid.');
    if(!history.length){if(Object.keys(budgets).length)throw error('Repair counters require their original accepted return receipts.');
      for(const kind of ['rejection','upstream']){
        const links=kind==='rejection'?namespaceHumanDecisionReceipts(w).filter(row=>row.operation==='phase.reject')
          :namespaceDecisionReceipts(w).filter(row=>row.operation==='upstream.decide');
        if(!links.length)continue;
        const reader=kind==='rejection'?createNamespaceRejectionReader({observer,scope,workId}):createNamespaceUpstreamOwners({observer,scope,workId}).readers.get('upstream.decide');
        for(const link of links){const value=await reader.decode(link.record,options);
          if(Object.hasOwn(value.source,'repairBudget'))throw error('An accepted bounded return cannot lose its counter history.');}
      }
      return {prior:null,references:[]};}
    const last=history.at(-1),kind=last.kind,links=kind==='rejection'?namespaceHumanDecisionReceipts(w).filter(row=>row.operation==='phase.reject')
      :kind==='upstream'?namespaceDecisionReceipts(w).filter(row=>row.operation==='upstream.decide'):null;
    if(!links)throw error('A bounded return has an unknown owner.');
    const reader=kind==='rejection'?createNamespaceRejectionReader({observer,scope,workId}):createNamespaceUpstreamOwners({observer,scope,workId}).readers.get('upstream.decide');
    for(const link of [...links].reverse()){
      if(link.phase!==last.phase||link.generation!==last.generation)continue;
      const value=await reader.decode(link.record,options),change=kind==='rejection'?value.outcome.changeRequest:value.outcome.record.changeRequest;
      if(change?.id!==last.changeRequestId)continue;
      const original=await memoNamespaceObservedDecision(observer,{profile:'sflow-namespace-repair-budget-transition-proof/v1',kind,link},async()=>{
        const proof=await reader.accepted(link,options),workflow=proof.accepted.state.workflow;
        return {history:workflow.namespaceRepairBudgetHistory??[],budgets:workflow.repairBudgets??{}};
      },options);
      if(!same(history,original.history)||!same(budgets,original.budgets))throw error('Repair counters differ from their last accepted transition.');
      return {prior:{operation:link.operation,record:link.record},references:[link.record]};
    }
    throw error('The bounded return lost its accepted human receipt.');
  }
  async function inspect(snapshot,sourcePhase,target,options={}){
    const prior=await admitted(snapshot,options),w=snapshot.workflow,phase=repairBudgetPhaseForRejection(w,w.phases[sourcePhase],target);
    if(!phase)return {selection:null,sourcePhase,prior:prior.prior,references:prior.references};
    const policy=phase.repairBudget,resetPhase=policy.resetOnPhase?w.phases[policy.resetOnPhase]:null;
    let resetGeneration=w.repairBudgets?.[phase.id]?.resetGeneration??0,reset=null,references=[...prior.references];
    if(resetPhase?.status==='approved'){
      const checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),packets=createNamespaceSubmissionReader({observer,scope,workId,checks}),
        proof=(await packets.inspectApprovedMany(snapshot,[resetPhase.id],options))[0];
      if(!proof)throw error('The reset phase needs its actual retained human approval.','ENGINE_REPAIR_RESET_APPROVAL_REQUIRED',{phase:resetPhase.id});
      // inspectApprovedMany already verifies every active vote, its authority and reached threshold.
      const votes=resetPhase.approvals.filter(row=>row.decision==='approved'&&!row.invalidatedAt&&row.generation===resetPhase.generation);
      if(!votes.length)throw error('A repair reset needs the configured human approval threshold.','ENGINE_REPAIR_RESET_APPROVAL_REQUIRED',{phase:resetPhase.id});
      resetGeneration=resetPhase.generation;reset={phase:resetPhase.id,generation:resetGeneration,publication:proof.value.publication,reviewPacket:proof.binding.record,
        approvals:votes.map(row=>row.namespaceVote.record)};references.push(proof.binding.record,proof.value.publication.record,...reset.approvals);
    }
    const selection={schemaVersion:NAMESPACE_REPAIR_BUDGET_SCHEMA.currentVersion,profile:'sflow-namespace-repair-budget-source/v1',phase:phase.id,policy,
      resetGeneration,reset,prior:prior.prior};admitRecordSchemaVersion(NAMESPACE_REPAIR_BUDGET_SCHEMA,selection);
    return {selection,sourcePhase,prior:prior.prior,references};
  }
  return Object.freeze({inspect,admitted});
}
