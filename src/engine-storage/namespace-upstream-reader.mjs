/** Read-only upstream source, authority and accepted-receipt replay. No lifecycle writes. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {upstreamOperationAdmission,upstreamOperationRequest} from '../kernel/decision-plan.mjs';
import {raiseUpstreamIssue,decideUpstreamIssue,upstreamIssueStates,upstreamIssueAuthorities} from '../kernel/upstream-issues.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const error=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceUpstreamOwners({observer,scope,workId}) {
  const owners=new Map(),readers=new Map(),checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),
    publications=createNamespacePublicationReader({observer,scope,workId,checks});
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
      if(!same(proof.value.outcome.record,(snapshot.workflow.upstreamIssueDecisions??[]).findLast(row=>row.issue===proof.value.request.issueId)))continue;
      results.push(proof);
    }
    return results;
  }
  for(const operation of ['upstream.raise','upstream.decide']) {
    const owner={
      agentPhase:snapshot=>snapshot.workflow.currentPhase,
      async read(snapshot,request,{signal,policyTraversal}={}) {
        await admitted(snapshot,{signal,policyTraversal});
        const phase=snapshot.workflow.phases[request.phaseId];
        if(!phase)throw error('The upstream owner is not in the pinned Story.','UPSTREAM_ISSUE_INVALID');
        const binding=phase.publicationBindings?.find(row=>row.generation===phase.generation);
        if(!binding)throw error('An upstream issue needs its actual published producer.','ENGINE_PUBLICATION_REQUIRED',{phase:phase.id});
        const publication=await publications.accepted(binding,phase.id,{signal,policyTraversal});
        return {generation:phase.generation,identity:{profile:'sflow-namespace-upstream-source/v1',producer:binding,
          issuesSha256:hash(snapshot.workflow.upstreamIssues??[]),decisionsSha256:hash(snapshot.workflow.upstreamIssueDecisions??[])},
          publication,references:[binding.record,publication.artifact.content,...publications.policies.evidence(publication)]};
      },
      authority(workflow,request,actor) {
        if(operation==='upstream.raise')return null;
        return requireApprovalAuthority(workflow.resolution.approvalAuthorities,{mode:'required',
          authorities:upstreamIssueAuthorities(workflow,request.phaseId),requiredAuthorities:[],minimum:1},actor.identity).authorityGroup;
      },
      plan(workflow,request,facts) {
        upstreamOperationAdmission(operation,workflow);const proposed=structuredClone(workflow);let record;
        if(operation==='upstream.raise') {
          if(request.fromArtifact)throw error('Read and name the exact artifact discrepancy before raising it.','ENGINE_PORT_UNAVAILABLE',{
            required:['namespace-artifact-discrepancies'],operation:'phase.draft.read',workId});
          const authored=request.authored??(facts.actorKind==='human'?'human':'governed-agent');
          if((authored==='human')!==(facts.actorKind==='human'))throw error('The issue authorship differs from its authenticated producer.','ENGINE_ACTOR_CHANGED');
          record=raiseUpstreamIssue(proposed,{phase:request.phaseId,about:request.about,problem:request.problem,assumption:request.assumption,
            impact:request.impact,proposed:request.proposed??'unknown',source:null,supersedes:request.supersedes,
            raisedBy:facts.actorId,authored,agent:facts.agentId,at:facts.at});
          proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:'upstream_issue_raised',phase:workflow.currentPhase,
            detail:record.id+' against '+record.phase+' ('+record.about+'): '+record.problem+(record.supersedes?' It supersedes '+record.supersedes+'.':'')});
        } else {
          if(['return','amend','plan-correction'].includes(request.outcome))throw error('This outcome needs its accepted repair or amendment owner.','ENGINE_PORT_UNAVAILABLE',{
            required:['namespace-upstream-'+request.outcome],operation:request.outcome==='return'?'phase.reject':request.outcome==='amend'?'forward-amendment.propose':'plan.correction.preview',workId});
          record=decideUpstreamIssue(proposed,{issue:request.issueId,outcome:request.outcome,reason:request.reason,link:request.link,
            expiresAt:request.expires,actor:facts.actorId,authorityGroup:facts.authorityGroup,identityAssurance:null,at:facts.at});
          proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:'upstream_issue_decided',phase:workflow.currentPhase,
            detail:record.issue+': '+record.outcome+'. '+record.reason});
        }
        return {workflow:proposed,outcome:{currentPhase:proposed.currentPhase,record}};
      }
    };
    owners.set(operation,owner);readers.set(operation,createNamespaceRecordedMutationReader({observer,scope,workId,operation,owner,contract:namespaceDecisionContract}));
  }
  return Object.freeze({owners,readers,admitted,decisions});
}
