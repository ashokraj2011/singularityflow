/** Human inspection over exact published bytes and independently approved verification contracts. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,namespaceCodePolicyProfile} from '../foundation/record-schema.mjs';
import {sourceRelativePath} from '../foundation/source-snapshot.mjs';
import {standaloneDecisionAdmission} from '../kernel/decision-plan.mjs';
import {witnessRecordPolicies} from '../kernel/human-witnesses.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {stepGroups,fallbackAuthorities} from '../kernel/approval-fallback.mjs';
import {plannedClaimAllocatedTo,mergePlannedClaimRecords} from '../kernel/specification-policy.mjs';
import {phaseNeedsGeneration} from '../kernel/phase-policy.mjs';
import {ASSURANCE} from '../kernel/verification-policy.mjs';
import {aggregateWitnesses} from '../kernel/verification-witnesses.mjs';
import {verificationContractSummary} from '../kernel/verification-contract-results.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {effectiveContract,mergedVerificationContracts} from '../engine-compatibility/node-specification-policy.mjs';
import {createNamespaceSpecificationReader} from './namespace-specifications.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {namespaceDecisionContract,namespaceDecisionReceipts} from './namespace-decision-contract.mjs';
import {memoNamespaceObservedWitness} from './namespace-story-reader.mjs';
const operation='decision.witness',same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex'),
  error=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>new SingularityFlowError(message,{code,details}),values=witnessRecordPolicies(NODE_TEXT_DIGESTS);
export function createNamespaceWitnessOwners({observer,scope,workId}){
  const checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),publications=createNamespacePublicationReader({observer,scope,workId,checks}),
    specifications=createNamespaceSpecificationReader({observer,scope,workId,checks});let reader;
  async function admitted(snapshot,{signal,policyTraversal}={}){
    const rows=snapshot.workflow.witnessRecords??[],links=namespaceDecisionReceipts(snapshot.workflow).filter(row=>row.operation===operation);
    if(!Array.isArray(rows)||links.length>256)throw error('The human witness inventory exceeds its contract.','ENGINE_STORAGE_LIMIT');
    if(!links.length){if(rows.length)throw error('Human witness records need their accepted original receipts.');return {rows:[],references:[]};}
    const last=await memoNamespaceObservedWitness(observer,{link:links.at(-1)},
      ()=>reader.accepted(links.at(-1),{signal,policyTraversal}),{signal});
    if(!same(rows,last.accepted.state.workflow.witnessRecords))throw error('The witness list differs from its last accepted human transition.');
    return {rows,references:links.map(row=>row.record)};
  }
  async function candidateContext(snapshot,request,{signal,policyTraversal}={}){
    const workflow=snapshot.workflow,plans=[],published=[],references=[],eligible=[],files=[];
    for(const id of workflow.phaseOrder){const phase=workflow.phases[id],ownerId=workflow.resolution.plannedClaims?.owners?.[id];
      if(!ownerId||workflow.phases[ownerId]?.status!=='approved')continue;
      const plan=await specifications.sourcePlan(snapshot,id,{signal});
      if(!plan.active.indexes.some(index=>index.clauses.some(row=>row.id===request.clauseId&&row.type==='AC'))||!plannedClaimAllocatedTo(plan.planned.claims[request.clauseId],id))continue;
      plans.push(plan);eligible.push(id);references.push(plan.proof.publication,plan.proof.reviewPacket,plan.proof.planned,...plan.proof.indices.map(row=>row.record),...(plan.proof.repositoryPlan?[plan.proof.repositoryPlan]:[]),...(plan.proof.amendments??[]).map(row=>row.record));
      const binding=phase.publicationBindings?.find(row=>row.generation===phase.generation);
      if(!binding||phaseNeedsGeneration(workflow,phase))continue;
      const value=await publications.accepted(binding,id,{signal,policyTraversal});published.push({phase:id,generation:value.generation,publication:binding});references.push(binding.record,value.artifact.content);
      files.push({path:value.artifact.sourceKey,content:value.artifact.content,phase:id,generation:value.generation});
      const code=publications.policies.codeEvidence(value);
      for(const output of code?.report.preflight.outputs?.files??[]){await observer.bytes(output.content,output.content.bytes,signal);
        files.push({path:output.path,content:output.content,phase:id,generation:value.generation});references.push(output.content);}
      if(code)for(const correction of plan.amendments)for(const operation of correction.operations??[]){
        if(operation.op!=='reclassify-evidence'||operation.clauseId!==request.clauseId||operation.delivery.phase!==id||operation.delivery.generation!==value.generation)continue;
        const retained=code.report.preflight.repositories.some(repository=>repository.delivery.fulfillment?.some(row=>row.clauseId===request.clauseId&&row.fulfillment==='evidence'
          &&row.paths.some(file=>file.path===operation.path&&file.state==='present'&&file.sha256===operation.content.sha256)));
        if(retained){await observer.bytes(operation.content,operation.content.bytes,signal);files.push({path:operation.path,content:operation.content,phase:id,generation:value.generation});references.push(operation.content);}}
      const bundle=publications.policies.artifactSetEvidence(value);
      if(bundle)for(const resource of publications.policies.resources(value).filter(row=>row.kind==='artifact-set-member')){
        const relative=resource.sourceKey.slice(value.artifact.sourceKey.length-bundle.report.primary.length);
        if(!bundle.report.members.some(row=>row.authority==='governed'&&row.entries.some(entry=>entry.path===relative&&same(entry.content,resource.reference))))continue;
        files.push({path:resource.sourceKey,content:resource.reference,phase:id,generation:value.generation});references.push(resource.reference);}
    }
    if(!plans.length)throw error('The independently approved plan has no such acceptance criterion.','WITNESS_CRITERION_UNKNOWN',{clauseId:request.clauseId});
    const records=plans.flatMap(row=>row.records),claim=mergePlannedClaimRecords(records)[request.clauseId],contract=effectiveContract(request.clauseId,mergedVerificationContracts(records),claim),
      slot=contract?.slots.find(row=>row.slot===request.slotName);
    if(!slot||!['inspection','visual'].includes(slot.method))throw error('Select one approved inspection or visual slot. Test slots use their execution records.','WITNESS_RECORD_INVALID');
    return {plans,published,references,eligible,files,slot,claim};
  }
  function candidateIdentity(request,{plans,published},file){
    const contextBinding='sha256:'+hash({profile:'sflow-namespace-witness-candidate/v1',workId,plans:plans.map(row=>row.proof),published});
    return {profile:'sflow-namespace-witness-source/v1',plans:plans.map(row=>row.proof),published,clauseId:request.clauseId,slotName:request.slotName,file,contextBinding};
  }
  async function context(snapshot,request,options={}){
    const source=await candidateContext(snapshot,request,options),{files,eligible,references,slot,claim}=source;
    sourceRelativePath(request.file);const file=files.findLast(row=>row.path===request.file);
    if(!file)throw error('Publish the exact retained output before asking a human to witness it.','WITNESS_EVIDENCE_UNPUBLISHED',{
      file:request.file,actions:eligible.flatMap(phaseId=>[{operation:'phase.review',inputs:{workId,phaseId}},{operation:'phase.artifact.inspect',inputs:{workId,phaseId},prerequisites:['machine-local-working-store']}])});
    await observer.bytes(file.content,file.content.bytes,options.signal);
    const identity=candidateIdentity(request,source,file);
    return {identity,slot,claim,eligible,references:[...new Map(references.map(ref=>[canonicalJson(ref),ref])).values()]};
  }
  const owner={
    async read(snapshot,request,options={}){const prior=await admitted(snapshot,options),source=await context(snapshot,request,options);
      if(options.bound&&!same(options.bound,source.identity))throw error('The original human witness no longer replays its exact published candidate.');
      return {...source,generation:snapshot.workflow.phases[request.phaseId]?.generation??0,references:[...prior.references,...source.references]};},
    authority(workflow,_request,actor,source){const groups=[...new Set(source.eligible.flatMap(id=>stepGroups(workflow,id)))].sort(),authorities=groups.length?groups:fallbackAuthorities(workflow,source.eligible);
      if(!authorities.length)throw error('The criterion owner has no configured human witness authority.','WITNESS_AUTHORITY_UNAVAILABLE');
      return requireApprovalAuthority(workflow.resolution.approvalAuthorities,{mode:'required',authorities,requiredAuthorities:[],minimum:1},actor.identity).authorityGroup;},
    plan(workflow,request,facts,source){standaloneDecisionAdmission(operation,workflow);const file=source.identity.file,contextBinding=source.identity.contextBinding,sha256='sha256:'+file.content.sha256;
      if(request.expectedContext!==contextBinding||request.expectedFile!==sha256)throw error('The reviewed candidate or file changed. Reopen its exact witness context before deciding.',
        'WITNESS_REVIEW_CHANGED',{actions:[{operation:'witness.context',inputs:{workId,clauseId:request.clauseId,slotName:request.slotName,file:request.file}}]});
      const duplicate=values.witnessRecordResults(workflow.witnessRecords,new Map([[request.file,sha256]]),{contextBinding}).find(row=>row.clauseId===request.clauseId&&row.slot===request.slotName&&row.status==='met');
      if(duplicate)throw error('This criterion and slot already have a human sign-off for the same candidate.','WITNESS_ALREADY_RECORDED',{recordId:duplicate.recordId});
      const proposed=structuredClone(workflow),record=values.recordWitnessWithEvidence(proposed,{clauseId:request.clauseId,slot:source.slot,file:request.file,sha256,answers:request.answers,reason:request.reason,
        actor:facts.actorId,authorityGroup:facts.authorityGroup,identityAssurance:null,at:facts.at,plannedClaim:source.claim},[{clauseId:request.clauseId,path:request.file,sha256}],contextBinding);
      proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:'witness_recorded',phase:workflow.currentPhase,
        detail:record.id+': '+record.method+' of '+record.file+' for '+record.clauseId+' slot '+record.slot+' is '+record.outcome+'. '+record.reason});
      return {workflow:proposed,outcome:{currentPhase:workflow.currentPhase,record}};}
  };
  reader=createNamespaceRecordedMutationReader({observer,scope,workId,operation,owner,contract:namespaceDecisionContract});
  async function status(snapshot,request,options={}){const prior=await admitted(snapshot,options),source=await context(snapshot,request,options),digest='sha256:'+source.identity.file.content.sha256,
    result=values.witnessRecordResults(prior.rows,new Map([[request.file,digest]]),{contextBinding:source.identity.contextBinding}).find(row=>row.clauseId===request.clauseId&&row.slot===request.slotName);
    return {...source,result:result??{clauseId:request.clauseId,slot:request.slotName,method:source.slot.method,status:'missing'},references:[...prior.references,...source.references]};}
  async function candidates(snapshot,request,options={}){
    const prior=await admitted(snapshot,options),source=await candidateContext(snapshot,request,options),files=[...new Map(source.files.map(row=>[row.path,row])).values()],
      rows=files.map(file=>{const identity=candidateIdentity(request,source,file),digest='sha256:'+file.content.sha256,
        result=values.witnessRecordResults(prior.rows,new Map([[file.path,digest]]),{contextBinding:identity.contextBinding})
          .find(row=>row.clauseId===request.clauseId&&row.slot===request.slotName);
        return {identity,result:result??{clauseId:request.clauseId,slot:request.slotName,method:source.slot.method,status:'missing'}};});
    return {rows,eligible:source.eligible,references:[...prior.references,...source.references]};
  }
  async function assertAcceptance(snapshot,publication,proof,{signal,policyTraversal,reached=true,reworkTarget=null}={}){
    if(!reached||reworkTarget||!namespaceCodePolicyProfile('codeReport',proof.report).humanAcceptance)return [];
    const prior=await admitted(snapshot,{signal,policyTraversal}),references=[...prior.references],open=[];
    for(const criterion of proof.report.acceptance.filter(row=>row.contract)){
      const slots=[];
      for(const slot of criterion.contract.slots){
        if(slot.method==='test'){const observed=criterion.testSlots.find(row=>row.slot===slot.slot)?.results??[],results=observed.map(row=>row.result),summary=aggregateWitnesses(results),
            required=observed.reduce((value,row)=>ASSURANCE.indexOf(row.requiredAssurance)>ASSURANCE.indexOf(value)?row.requiredAssurance:value,slot.requiredAssurance??'none');
          slots.push({...slot,...summary,status:summary.status==='met'&&ASSURANCE.indexOf(summary.assurance)<ASSURANCE.indexOf(required)?'inconclusive':summary.status,
            requiredAssurance:required,results,excepted:false,findings:[]});continue;}
        const candidates=prior.rows.filter(row=>row.clauseId===criterion.clauseId&&row.slot===slot.slot).slice(-1),record=candidates[0];let found=null;
        if(record){try{const source=await context(snapshot,{clauseId:criterion.clauseId,slotName:slot.slot,file:record.file},{signal,policyTraversal});
            found=values.witnessRecordResults(prior.rows,new Map([[record.file,'sha256:'+source.identity.file.content.sha256]]),{contextBinding:source.identity.contextBinding})
              .find(row=>row.clauseId===criterion.clauseId&&row.slot===slot.slot);references.push(...source.references);
          }catch(cause){if(!['WITNESS_EVIDENCE_UNPUBLISHED','WITNESS_CRITERION_UNKNOWN','WITNESS_RECORD_INVALID'].includes(cause.code))throw cause;}}
        slots.push({...slot,status:found?.status??'missing',assurance:found?.status==='met'?'source-bound':'none',identity:found?.status==='met'?'source-bound':'none',execution:'none',
          requiredAssurance:slot.requiredAssurance??'source-bound',results:[],excepted:false,findings:[]});
      }
      const result=verificationContractSummary(criterion.contract,slots);if(result.status!=='met')open.push({clauseId:criterion.clauseId,status:result.status,slots:result.slots,
        actions:slots.filter(row=>row.method!=='test'&&row.role==='primary'&&row.status!=='met').map(row=>({operation:'witness.context',inputs:{workId,clauseId:criterion.clauseId,slotName:row.slot},requiredInputs:['file']}))});
    }
    if(open.length)throw error('Complete the approved verification contract with actual test results and human inspection decisions.','ENGINE_WITNESS_DECISION_REQUIRED',{phase:publication.phase,criteria:open});
    return [...new Map(references.map(ref=>[canonicalJson(ref),ref])).values()];
  }
  return Object.freeze({owner,reader,admitted,context,status,candidates,assertAcceptance});
}
