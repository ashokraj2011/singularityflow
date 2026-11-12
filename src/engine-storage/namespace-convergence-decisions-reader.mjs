/** Convergence decisions replay chronologically from original conditional receipts; no recursive history scan. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {phaseExplicitlyReopened} from '../kernel/phase-policy.mjs';
import {createNamespaceConvergenceReader} from './namespace-convergence-reader.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {namespaceConvergenceDecisionContract as contract} from './namespace-convergence-contract.mjs';
import {withCodePolicyTraversal} from './namespace-code-policy.mjs';
const hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex'),same=(a,b)=>canonicalJson(a)===canonicalJson(b),
  error=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>new SingularityFlowError(message,{code,details});
const held=new Set(['rework','update-intent','deferred']);
export function createNamespaceConvergenceDecisionOwner({observer,scope,workId}){
  const inputs=createNamespaceConvergenceReader({observer,scope,workId}),walks=new WeakMap();let decisions;
  const key=link=>canonicalJson(link);
  function reduced(proof,prior){
    const wire=proof.value,actual=wire.outcome.record.adjudication,{replaced:_replaced,...answer}=actual,
      preceding=prior.findLast(row=>row.phase===wire.phase&&row.generation===wire.generation&&row.basisSha256===wire.source.basisSha256&&row.adjudication.itemId===answer.itemId),
      adjudication={...answer,...(preceding?{replaced:inputs.values.values.replacedAnswers(preceding.adjudication)}:{})};
    if(!same(adjudication,actual))throw error('The convergence answer lost the original answer it replaced.');
    const item=[...proof.source.projection.projection.facts,...proof.source.projection.projection.settledByPlan].find(row=>row.id===answer.itemId);
    if(!item)throw error('A convergence decision lost its actual reviewed item.');
    return {phase:wire.phase,generation:wire.generation,basisSha256:wire.source.basisSha256,sourceSha256:wire.source.sourceSha256,adjudication,
      repositoryId:item.repositoryId,paths:item.paths,reference:proof.reference,projection:wire.source.projection,operationId:wire.operationId};
  }
  async function context(snapshot,phaseId,{signal,policyTraversal}={}){
    return withCodePolicyTraversal(policyTraversal,async token=>{
      let walk=walks.get(token),outer=false;if(!walk){walk={verified:new Map(),order:[]};walks.set(token,walk);outer=true;}
      try{
        const base=await inputs.source(snapshot,phaseId,{signal,policyTraversal:token}),links=contract.receipts(snapshot.workflow).filter(row=>row.phase===base.phase),rows=[];
        if(links.some(row=>row.generation>base.generation))throw error('A convergence history belongs to a later generation.');
        for(const link of links){let row=walk.verified.get(key(link));
          if(!row){if(!outer)throw error('A convergence history is not the original chronological receipt prefix.');
            const proof=await decisions.accepted(link,{signal,policyTraversal:token});row=reduced(proof,rows);walk.verified.set(key(link),row);walk.order.push(key(link));}
          rows.push(row);
        }
        const basisSha256=base.projection.sourceSha256,previous=new Map();
        for(const row of rows)if(row.generation<base.generation||row.basisSha256!==basisSha256)previous.set(canonicalJson([row.generation,row.basisSha256,row.adjudication.itemId]),row);
        const kept=new Map();for(const row of previous.values())if(held.has(row.adjudication.disposition)){
          const paths=kept.get(row.repositoryId)??new Set();for(const path of row.paths)paths.add(path);kept.set(row.repositoryId,paths);}
        const selected={...base.selectedInputs,repositories:base.selectedInputs.repositories.map(row=>({...row,keptByPerson:[...(kept.get(row.id)??[])].sort()}))},
          unreviewed=inputs.values.project(selected),latest=new Map();
        for(const row of rows.filter(row=>row.generation===base.generation&&row.basisSha256===basisSha256)){
          if(row.sourceSha256!==unreviewed.sourceSha256)throw error('The recorded convergence answers belong to other retained inputs.','ENGINE_CONVERGENCE_DECISIONS_STALE',{
            phase:base.phase,actions:[{operation:'phase.review',inputs:{workId,phaseId:base.phase}}]});
          latest.set(row.adjudication.itemId,row);
        }
        const projection=inputs.values.project({...selected,adjudications:[...latest.values()].map(row=>row.adjudication)}),bytes=Buffer.from(canonicalJson(projection)),
          reference={namespace:'evidence',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.byteLength},
          expectedContext='sha256:'+hash({projectId:scope.projectId,workId,phase:base.phase,generation:base.generation,configuration:snapshot.configuration,projection:reference}),
          identity={profile:'sflow-namespace-convergence-decision-source/v1',projection:reference,basisSha256,sourceSha256:projection.sourceSha256,
            projectionSha256:projection.projection.convergenceSha256,expectedContext};
        return {...base,projection,latest,rows,identity,expectedContext,pendingEvidence:[{reference,bytes}],
          references:[...new Map([reference,...base.references,...rows.flatMap(row=>[row.reference,row.projection])].map(ref=>[canonicalJson(ref),ref])).values()]};
      }finally{if(outer)walks.delete(token);}
    });
  }
  const owner={
    async read(snapshot,request,options={}){const result=await context(snapshot,request.phaseId,options);
      if(options.bound){const bytes=await observer.bytes(options.bound.projection,options.bound.projection.bytes,options.signal);
        if(!same(options.bound,result.identity)||!Buffer.from(bytes).equals(result.pendingEvidence[0].bytes))throw error('The original reviewed convergence projection differs from its retained source.');}
      return result;},
    authority(workflow,request,actor){return requireApprovalAuthority(workflow.resolution.approvalAuthorities,workflow.phases[request.phaseId].approvalPolicy,actor.identity).authorityGroup;},
    assertNew(snapshot,request,source){
      const phase=snapshot.workflow.phases[request.phaseId];
      if(phase.generation>0&&!phaseExplicitlyReopened(snapshot.workflow,phase))throw error('Review the published convergence; a different answer needs an actual reviewed successor.',
        'ENGINE_CONVERGENCE_ALREADY_PUBLISHED',{actions:[{operation:'phase.review',inputs:{workId,phaseId:phase.id}}]});
      if(request.expectedContext!==source.expectedContext)throw error('Review the exact current convergence context after its inputs or human answers changed.',
        'ENGINE_CONVERGENCE_CONFIRMATION_STALE',{expected:source.expectedContext,actions:[{operation:'convergence.context',inputs:{workId,phaseId:phase.id}}]});
      const known=new Set(source.selectedInputs.indexes.flatMap(index=>index.clauses.map(row=>row.id)));
      if(request.clauseIds.some(id=>!known.has(id)))throw error('The decision names an unknown approved clause.','ENGINE_REPAIR_CLAUSE_UNKNOWN');
      if(![...source.projection.projection.facts,...source.projection.projection.settledByPlan].some(row=>row.id===request.itemId))throw error(
        'Select the exact fact from this convergence context.','ENGINE_CONVERGENCE_ITEM_UNKNOWN');
    },
    plan(workflow,request,facts,source){
      const previous=source.latest.get(request.itemId)?.adjudication,
        adjudication=inputs.values.values.validateAdjudication({itemId:request.itemId,disposition:request.disposition,reason:request.reason,
          clauseIds:request.clauseIds,actor:facts.actorId,at:facts.at,...(previous?{replaced:inputs.values.values.replacedAnswers(previous)}:{})},
        {facts:[...source.projection.projection.facts,...source.projection.projection.settledByPlan]}),
        id='CFA-'+String(contract.receipts(workflow).length+1).padStart(3,'0'),record={schemaVersion:1,format:'sflow-namespace-convergence-finding/v1',id,
          phase:request.phaseId,generation:source.generation,sourceSha256:source.projection.sourceSha256,adjudication,authorityGroup:facts.authorityGroup},proposed=structuredClone(workflow);
      proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:'convergence_adjudicated',phase:request.phaseId,
        detail:request.itemId+': '+request.disposition});
      return {workflow:proposed,outcome:{currentPhase:workflow.currentPhase,record}};
    }
  };
  decisions=createNamespaceRecordedMutationReader({observer,scope,workId,operation:'convergence.adjudicate',owner,contract});
  return Object.freeze({owner,context,inputs});
}
