/** Exact terminal-only risk decisions over real retained observations and original human receipts. */
import {canonicalJson,admitRecordSchemaVersion,NAMESPACE_OBLIGATION_RISK_SCHEMA} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {obligationRiskPolicies,planNamespaceObligationRisk} from '../kernel/obligation-risks.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {standaloneDecisionAdmission} from '../kernel/decision-plan.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {createNamespaceEvidenceReader} from './namespace-evidence-reader.mjs';
import {memoNamespaceObservedDecision} from './namespace-story-reader.mjs';
import {qualifiedClauseIds} from '../foundation/traceability-ids.mjs';
import {createNamespaceUpstreamOwners} from './namespace-upstream-reader.mjs';
const operation='decision.risk',rules=obligationRiskPolicies(NODE_TEXT_DIGESTS),same=(a,b)=>canonicalJson(a)===canonicalJson(b),
  fail=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>{
    throw new SingularityFlowError(message,{code,details});};
export function createNamespaceObligationRiskOwner({observer,scope,workId}){
  let reader,evidence;const freshness=new WeakMap();
  const evidenceReader=()=>evidence??=createNamespaceEvidenceReader({observer,scope,workId});
  function ownerBindings(workflow,obligation){
    const ids=obligation.owningSteps.length?obligation.owningSteps:(workflow.resolution.obligationGraph?.nodes??[])
      .filter(row=>row.responsibilities.includes(obligation.responsibility)).map(row=>row.id);
    return [...new Set(ids)].sort().map(id=>({phase:id,generation:workflow.phases[id].generation,
      publication:workflow.phases[id].publicationBindings?.find(row=>row.generation===workflow.phases[id].generation)??null}));
  }
  function bindings(snapshot,report,proofs){const obligations=report.rows.flatMap(row=>row.obligations),states={};
    for(const proof of proofs){const record=proof.value.outcome.record;if(!record.id)continue;
      const obligation=obligations.find(row=>row.id===record.obligationId);
      states[record.id]=obligation&&same(proof.value.source.owners,ownerBindings(snapshot.workflow,obligation))?'current':'overtaken';
    }return states;
  }
  async function admitted(snapshot,options={}){
    const rows=snapshot.workflow.namespaceObligationRisks??[],links=namespaceDecisionContract.receipts(snapshot.workflow).filter(row=>row.operation===operation);
    if(!Array.isArray(rows)||rows.length!==links.length||rows.length>128)fail('The obligation-risk inventory needs every original bounded human receipt.');
    for(const row of rows){try{admitRecordSchemaVersion(NAMESPACE_OBLIGATION_RISK_SCHEMA,row);
        if(row?.profile!=='sflow-namespace-obligation-risk/v1')fail('The obligation risk has another wire profile.');
      }catch(cause){throw new SingularityFlowError('The obligation risk requires its original supported record reader.',{
        code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',cause});}}
    const proofs=[];for(const link of links)proofs.push(await memoNamespaceObservedDecision(observer,{profile:'sflow-namespace-obligation-risk/v1',record:link.record},
      ()=>reader.accepted(link,options),options));
    if(!same(rows,proofs.map(proof=>proof.value.outcome.record)))fail('The obligation risks differ from their original accepted human decisions.');
    return proofs;
  }
  const owner={agentPhase:snapshot=>snapshot.workflow.currentPhase,
    async read(snapshot,request,options={}){
      const prior=await admitted(snapshot,options),rows=prior.map(proof=>proof.value.outcome.record);
      const target=request.revoke?rows.find(row=>row.id===request.revoke):null;
      if(request.revoke&&!target)fail('This Story has no such obligation risk.','RISK_DECISION_UNKNOWN');
      const observed=await evidenceReader().unexcepted(snapshot,options),id=target?.obligationId??request.obligationId,
        obligation=observed.report.rows.flatMap(row=>row.obligations).find(row=>row.id===id)??null;
      if(!request.revoke&&!rules.riskEligibility(obligation,{untrusted:observed.graph.untrusted}).eligible){
        // Use the shared rule's original error identity and diagnostic.
        rules.recordRiskDecision({riskDecisions:[]},{obligation,untrusted:observed.graph.untrusted,at:options.at});
      }
      if(obligation?.subject==='story')fail('Story-wide risks require their separately versioned evaluation owner; no criterion decision can substitute for them.',
        'ENGINE_PORT_UNAVAILABLE',{required:['story-obligation-risk-evaluation']});
      if(request.revoke&&!obligation)fail('The original obligation needs its retained observation owner.','ENGINE_PORT_UNAVAILABLE',{required:['original-risk-obligation']});
      const identity={profile:'sflow-namespace-obligation-risk-source/v1',inputSha256:observed.graph.inputSha256,
        observation:rules.observationDigest(obligation),obligationId:id,owners:ownerBindings(snapshot.workflow,obligation),
        ...(target?{revokes:prior.find(row=>row.value.outcome.record.id===target.id).reference}:{})};
      const source={generation:snapshot.workflow.phases[request.phaseId]?.generation??0,identity,obligation,
        references:[...observed.references.filter(row=>row.namespace==='evidence'),...prior.map(row=>row.reference)],readBindings:observed.readBindings};
      freshness.set(source,observed.fresh);return source;
    },
    authority(workflow,_request,actor,source){
      if(workflow.resolution.presence)fail('An obligation risk needs its configured person-presence proof.','ENGINE_PORT_UNAVAILABLE',{required:['person-presence']});
      const groups=rules.riskAuthorities(workflow,source.obligation);
      if(!groups.length)fail('Configure the original obligation owners\' risk authority.','RISK_AUTHORITY_UNAVAILABLE');
      return requireApprovalAuthority(workflow.resolution.approvalAuthorities,{mode:'required',authorities:groups,requiredAuthorities:[],minimum:1},actor.identity).authorityGroup;
    },
    async assertNew(snapshot,request,source,options){
      if(request.revoke)return;
      const prior=await admitted(snapshot,options),current=rules.riskDecisionState(snapshot.workflow,source.obligation,{at:options.at},prior.map(row=>row.value.outcome.record));
      const currentProof=current&&prior.find(row=>row.value.outcome.record.id===current.decision.id);
      if(current?.state==='active'&&same(currentProof.value.source.owners,source.identity.owners))fail('This exact obligation already has an active human risk decision. Use its retained receipt.','RISK_ALREADY_DECIDED',{
        riskId:current.decision.id,actions:[{operation:'story.evidence',inputs:{workId}}]});
      const subject=source.obligation.subject,owners=source.identity.owners.map(row=>row.phase);
      const issues=(snapshot.workflow.upstreamIssues??[]).filter(row=>owners.includes(row.phase)&&qualifiedClauseIds(row.about).has(subject));
      if(issues.length)await createNamespaceUpstreamOwners({observer,scope,workId}).admitted(snapshot,options);
      if(issues.length)fail('Decide the original upstream issue once rather than creating a second decision for its gap.','ENGINE_CONFORMANCE_UPSTREAM_ISSUE_REQUIRED',{
        issueIds:issues.map(row=>row.id),actions:issues.map(row=>({operation:'upstream.decide',inputs:{workId,issueId:row.id},requiredInputs:['operationId','outcome','reason']}))});
    },
    plan(workflow,request,facts,source){standaloneDecisionAdmission(operation,workflow);return planNamespaceObligationRisk(workflow,request,facts,source,rules);},
    fresh(_snapshot,_request,source){const check=freshness.get(source);if(!check)fail('Use the actual observed risk source before acceptance.','ENGINE_INPUT_INVALID');return check();}
  };
  reader=createNamespaceRecordedMutationReader({observer,scope,workId,operation,owner,contract:namespaceDecisionContract});
  async function observations(snapshot,options){const observed=await evidenceReader().unexcepted(snapshot,options),proofs=await admitted(snapshot,options);
    return {observed,proofs,bindings:bindings(snapshot,observed.report,proofs)};
  }
  async function conformance(snapshot,gaps,options){
    if(!(snapshot.workflow.namespaceObligationRisks??[]).length)return {covered:[],references:[]};
    const {observed,proofs,bindings:current}=await observations(snapshot,options),rows=proofs.map(row=>row.value.outcome.record),covered=[],references=[];
    for(const gap of gaps)for(const ownerPhase of gap.owners)for(const obligation of observed.report.rows.find(row=>row.id===gap.clauseId)?.obligations??[]){
      const state=rules.riskDecisionState(snapshot.workflow,obligation,{at:options.at},rows),proof=state&&proofs.find(row=>row.value.outcome.record.id===state.decision.id);
      if(state?.state!=='active'||current[state.decision.id]!=='current'||!proof.value.source.owners.some(row=>row.phase===ownerPhase))continue;
      covered.push({clauseId:gap.clauseId,ownerPhase,riskId:state.decision.id});references.push(proof.reference,...proof.source.references);
    }
    return {covered,references};
  }
  return Object.freeze({owner,reader,admitted,rules,bindings,observations,conformance});
}
