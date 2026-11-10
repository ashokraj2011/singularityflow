/** Reconstruct exact submitted article decisions from actual accepted namespace receipts. Read only. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {hasPublishedPhaseGeneration,phaseNeedsGeneration} from '../kernel/phase-policy.mjs';
import {namespaceConstitutionExceptionPolicies,namespaceConstitutionExceptionActive} from '../kernel/namespace-constitution-exceptions.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {namespaceDecisionContract,namespaceDecisionReceipts} from './namespace-decision-contract.mjs';
const operation='decision.constitution-exception',same=(a,b)=>canonicalJson(a)===canonicalJson(b),
  error=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceConstitutionExceptionOwners({observer,scope,workId}){
  const rules=namespaceConstitutionExceptionPolicies(NODE_TEXT_DIGESTS);let reader;
  async function json(reference,signal){const bytes=await observer.bytes(reference,reference.bytes,signal);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch(cause){throw new SingularityFlowError('The article proof is not retained UTF-8 JSON.',{code:'ENGINE_STORAGE_CORRUPT',cause});}}
  async function admitted(snapshot,options={}){
    const rows=snapshot.workflow.namespaceConstitutionExceptions??[],links=namespaceDecisionReceipts(snapshot.workflow).filter(row=>row.operation===operation);
    if(!Array.isArray(rows)||rows.length!==links.length)throw error('The article exception inventory has no matching human receipt sequence.');
    if(rows.length>64)throw error('The article exception inventory exceeds its bounded contract.','ENGINE_STORAGE_LIMIT');
    const checked=rows.map(rules.value);
    if(!links.length){if(rows.length)throw error('Article exceptions have no actual human decision receipts.');return {rows:[],links:[],references:[]};}
    const last=await reader.accepted(links.at(-1),options);
    if(!same(rows,last.accepted.state.workflow.namespaceConstitutionExceptions))throw error('The article exception inventory differs from its accepted transition.');
    return {rows:checked,links,references:links.map(row=>row.record)};
  }
  async function source(snapshot,request,{signal,policyTraversal,bound}={}){
    const phase=snapshot.workflow.phases[request.phaseId],checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),
      packets=createNamespaceSubmissionReader({observer,scope,workId,checks}),proof=phase?await packets.inspect(snapshot,request.phaseId,{signal,policyTraversal}):null;
    if(!phase)throw error('Choose a phase in the pinned Story workflow.','ENGINE_PHASE_UNAVAILABLE',{phaseId:request.phaseId,actions:[{operation:'story.status',inputs:{workId}}]});
    if(!proof){const generationRequired=!hasPublishedPhaseGeneration(phase)||phaseNeedsGeneration(snapshot.workflow,phase);
      throw error(generationRequired?'Author and publish the current generation before reviewing an article exception.':'Submit the exact publication before recording its article exception.',
        generationRequired?'PHASE_GENERATION_REQUIRED':'PHASE_SUBMISSION_REQUIRED',{actions:[{operation:generationRequired?'phase.prepare':'phase.submit',inputs:{workId,phaseId:request.phaseId}}]});}
    const binding=proof.published.policyEvidence?.find(row=>row.kind==='constitution-policy/v1');
    if(!binding)throw error('The publication has no authenticated constitution policy.','CONSTITUTION_POLICY_REQUIRED');
    const manifest=await json(binding.record,signal),report=await json(manifest.report,signal),article=report.pin?.articles.find(row=>row.id===request.articleId);
    if(!article)throw error('Choose an exact article from the pinned constitution.','CONSTITUTION_ARTICLE_UNKNOWN',{articleId:request.articleId});
    if(report.errors.length)throw error('Repair the machine policy or constitution integrity before any human exception.','CONSTITUTION_POLICY_REQUIRED');
    const prior=await admitted(snapshot,{signal,policyTraversal}),identity={profile:'sflow-namespace-constitution-exception-source/v1',
      configuration:snapshot.configuration,storySource:snapshot.workflow.workItem.source.content,publication:proof.value.publication,reviewPacket:proof.binding.record,
      constitution:{policy:binding.record,report:manifest.report,source:report.pin.source.content,articleId:article.id,articleSha256:article.articleSha256},prior:prior.links};
    if(bound&&!same(identity,bound))throw error('The exception lost its original submitted article and decision inputs.');
    await observer.bytes(identity.storySource,identity.storySource.bytes,signal);
    return {generation:phase.generation,identity,article,prior:prior.rows,contextBinding:'sha256:'+NODE_TEXT_DIGESTS.sha256Utf8(canonicalJson(identity)),
      references:[proof.value.publication.record,proof.binding.record,binding.record,manifest.report,...prior.references]};
  }
  const owner={read:source,assertNew(snapshot){if(snapshot.workflow.resolution.presence)throw error('The configured human-presence policy needs its actual evidence owner.',
      'ENGINE_PORT_UNAVAILABLE',{required:['person-presence']});},authority(workflow,request,actor){const policy=workflow.phases[request.phaseId].approvalPolicy;
    return requireApprovalAuthority(workflow.resolution.approvalAuthorities,{mode:'required',authorities:[...new Set([...(policy.authorities??[]),...(policy.requiredAuthorities??[])])],minimum:1},actor.identity).authorityGroup;},plan:rules.plan};
  reader=createNamespaceRecordedMutationReader({observer,scope,workId,operation,owner,contract:namespaceDecisionContract});
  async function assertPublication(snapshot,publication,{at,signal,policyTraversal}={}){
    if(!snapshot||!Number.isFinite(Date.parse(at)))throw error('Review article exceptions against the actual approval basis and time.','ENGINE_INPUT_INVALID');
    const prior=await admitted(snapshot,{signal,policyTraversal});
    const applicable=prior.rows.filter(row=>row.binding.phase===publication.phase&&row.binding.generation===publication.generation
      &&same(row.binding.configuration,publication.configuration));
    for(const row of applicable){const value=await json(row.binding.publication.record,signal);
      if(!same(value,publication))throw error('The article exception names a different submitted publication.');}
    const latest=new Map(applicable.map(row=>[row.articleId,row]));
    for(const row of latest.values())if(!namespaceConstitutionExceptionActive(row,at))throw error('Renew the expired exception against this exact article and publication before approval.',
      'CONSTITUTION_EXCEPTION_EXPIRED',{id:row.id,actions:[{operation:'constitution.exception.context',inputs:{workId,phaseId:publication.phase,articleId:row.articleId}}]});
    return applicable.length?prior.references:[];
  }
  return Object.freeze({owner,reader,source,admitted,assertPublication});
}
