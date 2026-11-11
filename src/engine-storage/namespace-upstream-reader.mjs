/** Read-only upstream source, authority and accepted-receipt replay. No lifecycle writes. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,NAMESPACE_UPSTREAM_PLAN_CORRECTION_PROFILE} from '../foundation/record-schema.mjs';
import {upstreamOperationAdmission,upstreamOperationRequest} from '../kernel/decision-plan.mjs';
import {raiseUpstreamIssue,decideUpstreamIssue,upstreamIssueStates,upstreamIssueAuthorities,planNamespaceUpstreamReturn,NAMESPACE_UPSTREAM_RETURN_PROFILE,NAMESPACE_UPSTREAM_BOUNDED_RETURN_PROFILE,isNamespaceUpstreamReturnProfile} from '../kernel/upstream-issues.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespaceUpstreamArtifactReader} from './namespace-upstream-artifact-reader.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {createNamespacePlanDecisionOwners} from './namespace-plan-decisions-reader.mjs';
import {createNamespaceRepairBudgetReader} from './namespace-repair-budget-reader.mjs';
import {memoNamespaceObservedDecision} from './namespace-story-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const error=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceUpstreamOwners({observer,scope,workId,runtime=null,artifactSelection=null,artifactReports=null}) {
  const owners=new Map(),readers=new Map(),checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),
    publications=createNamespacePublicationReader({observer,scope,workId,checks});
  const reports=artifactReports??createNamespaceUpstreamArtifactReader({observer,scope,workId,publications,runtime});
  let planOwners;const plans=()=>planOwners??=createNamespacePlanDecisionOwners({observer,scope,workId});
  async function admitted(snapshot,{signal,policyTraversal}={}) {
    const references=[];
    for(const [operation,field]of [['upstream.raise','upstreamIssues'],['upstream.decide','upstreamIssueDecisions']]) {
      const rows=snapshot.workflow[field]??[],links=namespaceDecisionContract.receipts(snapshot.workflow).filter(row=>row.operation===operation);
      if(!Array.isArray(rows))throw error('The upstream record inventory is invalid.');
      if(!rows.length&&!links.length)continue;
      if(!links.length)throw error('Upstream records require their original accepted operation.');
      const proof=await readers.get(operation).accepted(links.at(-1),{signal,policyTraversal});
      if(!same(proof.accepted.state.workflow[field]??[],rows))throw error('The upstream inventory differs from its accepted transition.');
      references.push(links.at(-1).record);
    }
    return references;
  }
  async function decisions(snapshot,{signal,policyTraversal}={}) {
    await admitted(snapshot,{signal,policyTraversal});
    const results=[];
    for(const link of namespaceDecisionContract.receipts(snapshot.workflow).filter(row=>row.operation==='upstream.decide')){
      const proof=await readers.get('upstream.decide').accepted(link,{signal,policyTraversal});
      const {changeRequest,...decision}=proof.value.outcome.record;
      const {repairBudget,...plain}=decision;
      if(!same(changeRequest&&isNamespaceUpstreamReturnProfile(proof.value.source.profile)?plain:proof.value.outcome.record,(snapshot.workflow.upstreamIssueDecisions??[]).findLast(row=>row.issue===proof.value.request.issueId)))continue;
      results.push(proof);
    }
    return results;
  }
  for(const operation of ['upstream.raise','upstream.decide']) {
    const owner={
      agentPhase:snapshot=>snapshot.workflow.currentPhase,
      async read(snapshot,request,{signal,policyTraversal,bound,at}={}) {
        const admittedReferences=await admitted(snapshot,{signal,policyTraversal});
        const phase=snapshot.workflow.phases[request.phaseId];
        if(!phase)throw error('The upstream owner is not in the pinned Story.','UPSTREAM_ISSUE_INVALID');
        const binding=phase.publicationBindings?.find(row=>row.generation===phase.generation);
        if(!binding)throw error('An upstream issue needs its actual published producer.','ENGINE_PUBLICATION_REQUIRED',{phase:phase.id});
        const publication=await publications.accepted(binding,phase.id,{signal,policyTraversal});
        const base={generation:phase.generation,identity:{profile:'sflow-namespace-upstream-source/v1',producer:binding,
          issuesSha256:hash(snapshot.workflow.upstreamIssues??[]),decisionsSha256:hash(snapshot.workflow.upstreamIssueDecisions??[])},
          publication,references:[binding.record,publication.artifact.content,...publications.policies.evidence(publication)]};
        if(operation==='upstream.decide'&&request.outcome==='return'){
          const required=[...(snapshot.workflow.resolution.presence?['person-presence']:[]),
            ...(snapshot.workflow.resolution.testRecovery?.enabled?['test-recovery']:[])];
          if(required.length)throw error('This upstream return requires its actual additional authority owners.','ENGINE_PORT_UNAVAILABLE',{required});
          const issue=snapshot.workflow.upstreamIssues.find(row=>row.id===request.issueId);
          if(!issue)throw error('The upstream issue is not in this Story.','UPSTREAM_ISSUE_NOT_FOUND');
          const producer=phase.publicationBindings?.find(row=>row.generation===issue.producerGeneration);
          if(!producer)throw error('The original upstream producer has no retained publication.');
          const original=await publications.accepted(producer,issue.phase,{signal,policyTraversal}),artifacts=publications.artifacts(original);
          if(!issue.producerArtifacts.every(row=>artifacts.some(item=>item.path===row.path&&item.sha256===row.sha256)))throw error('The issue differs from its original producer artifacts.');
          const repairBudget=await createNamespaceRepairBudgetReader({observer,scope,workId}).inspect(snapshot,snapshot.workflow.currentPhase,issue.phase,{signal,policyTraversal});
          return {...base,issue,issueProducer:producer,repairBudget,identity:{...base.identity,
            profile:repairBudget.selection||repairBudget.prior?NAMESPACE_UPSTREAM_BOUNDED_RETURN_PROFILE:NAMESPACE_UPSTREAM_RETURN_PROFILE,
            issueProducer:producer,issueSha256:hash(issue),...(repairBudget.selection||repairBudget.prior?{repairBudget:repairBudget.selection,priorBudget:repairBudget.prior}:{})},
            references:[...base.references,...admittedReferences,producer.record,original.artifact.content,...publications.policies.evidence(original),...repairBudget.references]};
        }
        if(operation==='upstream.decide'&&request.outcome==='plan-correction'){
          const corrections=await plans().projection(snapshot,{signal,policyTraversal});
          return {...base,identity:{...base.identity,profile:NAMESPACE_UPSTREAM_PLAN_CORRECTION_PROFILE,
            corrections:{receipts:corrections.receipts,rowsSha256:hash(corrections.rows)}},
            planAmendments:corrections.rows,references:[...base.references,...corrections.references]};
        }
        if(operation!=='upstream.raise'||!artifactSelection&&bound?.profile!=='sflow-namespace-upstream-source/v2')return base;
        const selected=bound?{token:await reports.restore(snapshot,bound.report,{signal,policyTraversal}),batch:bound.batch}:artifactSelection,
          expected={phase:request.phaseId,about:request.about,problem:request.problem,assumption:request.assumption,impact:request.impact,
            proposed:request.proposed??'unknown',supersedes:request.supersedes},found=reports.requests(snapshot,selected.token,selected.batch?.at??at).requests.find(row=>{
              const {source,...fields}=row;return same({...fields,proposed:selected.batch?.proposed??fields.proposed},expected);});
        if(!found||!selected.batch||typeof selected.batch.operationId!=='string'||!/^[a-f0-9]{64}$/u.test(selected.batch.requestSha256??''))throw error(
          'The issued discrepancy does not match its original report.');
        projectEnrollmentTimestamp(selected.batch.at);
        const evidence=reports.evidence(selected.token);
        return {...base,identity:{...base.identity,profile:'sflow-namespace-upstream-source/v2',report:reports.identity(selected.token),
          discrepancy:found.source,batch:selected.batch},references:[...base.references,...evidence.references],pendingEvidence:evidence.pendingEvidence,
          artifactToken:selected.token,discrepancy:found.source};
      },
      async fresh(snapshot,_request,source,options){if(source.identity.profile==='sflow-namespace-upstream-source/v2'){
        const actual=await observer.inspect(options);await reports.fresh(actual.snapshot,source.artifactToken,options);
      }},
      authority(workflow,request,actor) {
        if(operation==='upstream.raise')return null;
        return requireApprovalAuthority(workflow.resolution.approvalAuthorities,{mode:'required',
          authorities:upstreamIssueAuthorities(workflow,request.phaseId),requiredAuthorities:[],minimum:1},actor.identity).authorityGroup;
      },
      plan(workflow,request,facts,source) {
        upstreamOperationAdmission(operation,workflow);const proposed=structuredClone(workflow);let record;
        if(operation==='upstream.raise') {
          if(request.fromArtifact)throw error('Read and name the exact artifact discrepancy before raising it.','ENGINE_PORT_UNAVAILABLE',{
            required:['namespace-artifact-discrepancies'],operation:'phase.draft.read',workId});
          const authored=request.authored??(facts.actorKind==='human'?'human':'governed-agent');
          if((authored==='human')!==(facts.actorKind==='human'))throw error('The issue authorship differs from its authenticated producer.','ENGINE_ACTOR_CHANGED');
          record=raiseUpstreamIssue(proposed,{phase:request.phaseId,about:request.about,problem:request.problem,assumption:request.assumption,
            impact:request.impact,proposed:request.proposed??'unknown',source:source?.discrepancy??null,supersedes:request.supersedes,
            raisedBy:facts.actorId,authored,agent:facts.agentId,at:facts.at});
          proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:'upstream_issue_raised',phase:workflow.currentPhase,
            detail:record.id+' against '+record.phase+' ('+record.about+'): '+record.problem+(record.supersedes?' It supersedes '+record.supersedes+'.':'')});
        } else {
          if(request.outcome==='return')return planNamespaceUpstreamReturn(workflow,request,facts,source);
          if(request.outcome==='amend')throw error('This outcome needs its accepted repair or amendment owner.','ENGINE_PORT_UNAVAILABLE',{
            required:['namespace-upstream-'+request.outcome],operation:request.outcome==='return'?'phase.reject':'forward-amendment.propose',workId});
          record=decideUpstreamIssue(proposed,{issue:request.issueId,outcome:request.outcome,reason:request.reason,link:request.link,
            expiresAt:request.expires,actor:facts.actorId,authorityGroup:facts.authorityGroup,identityAssurance:null,at:facts.at},
            request.outcome==='plan-correction'?{planAmendments:source.planAmendments}:{});
          proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:'upstream_issue_decided',phase:workflow.currentPhase,
            detail:record.issue+': '+record.outcome+'. '+record.reason});
        }
        return {workflow:proposed,outcome:{currentPhase:proposed.currentPhase,record}};
      }
    };
    owners.set(operation,owner);
    const reader=createNamespaceRecordedMutationReader({observer,scope,workId,operation,owner,contract:namespaceDecisionContract});
    readers.set(operation,operation==='upstream.decide'?Object.freeze({...reader,accepted:(link,options={})=>memoNamespaceObservedDecision(observer,
      {profile:'sflow-namespace-accepted-upstream-disposition/v1',link},()=>reader.accepted(link,options),options)}):reader);
  }
  return Object.freeze({owners,readers,admitted,decisions,reports});
}
