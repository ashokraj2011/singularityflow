/** Original recovery agreements and command inventories. This owner cannot execute or write. */
import {canonicalJson,NAMESPACE_TEST_RECOVERY_SCHEMAS} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {namespaceTestRecoveryPolicies} from '../kernel/test-recovery.mjs';
import {testRunRiskAuthorities} from '../kernel/approval-fallback.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {createNamespaceTestCommandOwners} from './namespace-test-command-reader.mjs';
import {namespaceEvidencePolicyManifest} from './namespace-policy-contract.mjs';
import {memoNamespaceObservedDecision} from './namespace-story-reader.mjs';
const rules=namespaceTestRecoveryPolicies(NODE_TEXT_DIGESTS),same=(a,b)=>canonicalJson(a)===canonicalJson(b),
  fail=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>{throw new SingularityFlowError(message,{code,details});};
export const TEST_RECOVERY_EVIDENCE='test-recovery/v1';
export const namespaceTestRecoveryBinding=proof=>({profile:'sflow-namespace-test-recovery-binding/v1',
  agreement:proof.agreement.contextSha256,records:proof.references});
export const namespaceTestRecoveryManifest=(value,scope)=>namespaceEvidencePolicyManifest(value,{...scope,
  family:NAMESPACE_TEST_RECOVERY_SCHEMAS.policy,format:'sflow-namespace-test-recovery-policy-manifest/v1'});
export function createNamespaceTestRecoveryOwner({observer,scope,workId}){
  const operation='test-recovery.confirm',commands=createNamespaceTestCommandOwners({observer,scope,workId});let reader;
  async function admitted(snapshot,options={}){
    const rows=snapshot.workflow.namespaceTestRecoveryAgreements??[],links=namespaceDecisionContract.receipts(snapshot.workflow).filter(row=>row.operation===operation);
    if(!Array.isArray(rows)||rows.length!==links.length||rows.length>64)fail('The recovery agreement inventory lost its original bounded human records.');
    const found=[];
    for(const link of links){const proof=await memoNamespaceObservedDecision(observer,{profile:'sflow-namespace-test-recovery-proof/v1',record:link.record},
      ()=>reader.accepted(link,options),options);found.push(proof);}
    if(!same(rows,found.map(proof=>proof.value.outcome.record)))fail('The recovery agreements differ from their accepted conditional receipts.');
    return found;
  }
  async function context(snapshot,options={}){
    const rows=await admitted(snapshot,options),inventory=[],references=rows.map(row=>row.reference);
    for(const phaseId of snapshot.workflow.phaseOrder){const proof=await commands.commands(snapshot,phaseId,options);
      inventory.push({phaseId,commands:proof.commands});references.push(...proof.references);}
    const last=rows.at(-1)?.value.outcome.record??null,
      value=rules.context(snapshot.workflow,snapshot.configuration,inventory,last?rules.hash(last):null);
    return {context:value,previous:last,references:[...new Map(references.map(row=>[canonicalJson(row),row])).values()]};
  }
  async function current(snapshot,options={}){
    const source=await context(snapshot,options),agreement=rules.current(source.previous,source.context);
    return {...source,context:{value:agreement.context,sha256:agreement.contextSha256},agreement};
  }
  const owner={
    async read(snapshot,request,options={}){
      const phase=snapshot.workflow.phases[request.phaseId];if(!phase||request.phaseId!==snapshot.workflow.currentPhase)fail(
        'Confirm recovery for the current Story phase.','TEST_RECOVERY_NOT_CURRENT');
      if(phase.status==='awaiting_approval')fail('Do not change a recovery agreement during a submitted review.','TEST_RECOVERY_DURING_REVIEW',{
        actions:[{operation:'phase.review',inputs:{workId,phaseId:phase.id}}]});
      const value=await context(snapshot,options);
      return {...value,generation:phase.generation,identity:{profile:'sflow-namespace-test-recovery-source/v1',context:value.context.value,sha256:value.context.sha256}};
    },
    authority(workflow,request,actor){
      if(workflow.resolution.presence)fail('The agreement requires its configured person-presence evidence.','ENGINE_PORT_UNAVAILABLE',{required:['person-presence']});
      const authorities=testRunRiskAuthorities(workflow,request.phaseId);
      if(!authorities.length)fail('Configure the human group authorized to confirm test recovery.','RISK_AUTHORITY_UNAVAILABLE');
      return requireApprovalAuthority(workflow.resolution.approvalAuthorities,{mode:'required',authorities,requiredAuthorities:[],minimum:1},actor.identity).authorityGroup;
    },
    plan(workflow,request,facts,source){return rules.confirm(workflow,request,source,facts);}
  };
  reader=createNamespaceRecordedMutationReader({observer,scope,workId,operation,owner,contract:namespaceDecisionContract});
  async function publication(snapshot,phaseId,options={}){
    const source=await current(snapshot,options);
    return {report:{schemaVersion:1,profile:'sflow-namespace-test-recovery-policy/v1',workId,phaseId,
      agreement:source.agreement,agreements:source.references,commands:source.context.value.commands,
      executionMode:'all-configured',failuresWaived:false},references:source.references,policy:{owners:['test-recovery']}};
  }
  return Object.freeze({owner,reader,admitted,context,current,publication});
}
