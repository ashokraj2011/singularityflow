import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
/** Exact published source reviews. Reading one never grants an author or approval capability. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,NAMESPACE_SOURCE_REVIEW_SCHEMAS,namespaceSourceReviewRecordProfile} from '../foundation/record-schema.mjs';
import {sourceReviewRequired,sourceReviewKind,scopeStepOf} from '../kernel/phase-policy.mjs';
import {standaloneDecisionAdmission} from '../kernel/decision-plan.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {sourceReviewContinuationEvidence,sourceGroundedReviewPolicies} from '../kernel/source-grounded-review.mjs';
import {authoredArtifactText} from '../kernel/artifact-content.mjs';
import {NODE_TEXT_DIGESTS,NODE_TEXT_VALUE_SYNTAX} from '../records.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../engine-compatibility/node-configuration-path.mjs';
import {namespaceLocalInputBytes} from './namespace-story-reader.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {namespaceDecisionContract,namespaceDecisionReceipts} from './namespace-decision-contract.mjs';
const recordOperation='source-review.record',decisionOperation='source-review.decide',same=(a,b)=>canonicalJson(a)===canonicalJson(b),
  hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex'),
  error=(message,code='ENGINE_STORAGE_CORRUPT',details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause}),
  rules=sourceGroundedReviewPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_VALUE_SYNTAX,NODE_TEXT_DIGESTS);
export function createNamespaceSourceReviewOwners({observer,scope,workId}){
  let publications,packets;const readers=new Map(),checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer});
  const publicationReader=()=>publications??=createNamespacePublicationReader({observer,scope,workId,checks}),
    packetReader=()=>packets??=createNamespaceSubmissionReader({observer,scope,workId,checks});
  async function text(reference,signal,local=false){const data=local?await namespaceLocalInputBytes(observer,reference,{signal}):await observer.bytes(reference,reference.bytes,signal);
    try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);}catch(cause){throw error('The source review requires an actual supported text or visual reader.','SOURCE_REVIEW_SOURCE_UNREADABLE',{reference},cause);}}
  const replay=(report,context,at)=>{const value=rules.evaluateSourceGroundedReviewReplay(report,context);let step=value.next();while(!step.done)step=value.next(at);return step.value;};
  async function admitted(snapshot,options={}){
    const rows=snapshot.workflow.namespaceSourceReviews??[],decisions=snapshot.workflow.namespaceSourceReviewDecisions??[],
      links=namespaceDecisionReceipts(snapshot.workflow).filter(row=>[recordOperation,decisionOperation].includes(row.operation));
    if(!Array.isArray(rows)||!Array.isArray(decisions)||links.length>128)throw error('The source-review inventory exceeds its contract.','ENGINE_STORAGE_LIMIT');
    if(!links.length){if(rows.length||decisions.length)throw error('Source reviews need accepted original review receipts.');return {rows,decisions,links,references:[]};}
    const link=links.at(-1),proof=await readers.get(link.operation).accepted(link,options),expected=proof.accepted.state.workflow;
    if(!same(rows,expected.namespaceSourceReviews??[])||!same(decisions,expected.namespaceSourceReviewDecisions??[]))throw error('Source reviews differ from their last accepted transition.');
    return {rows,decisions,links,references:links.map(row=>row.record)};
  }
  async function context(snapshot,phaseId,{signal,policyTraversal}={}){
    const workflow=snapshot.workflow,phase=workflow.phases[phaseId],kind=sourceReviewKind(workflow,phaseId);
    if(!phase||!kind||!sourceReviewRequired(workflow,phaseId))throw error('This pinned phase does not require source review.','SOURCE_REVIEW_NOT_REQUIRED',{phase:phaseId});
    const binding=phase.publicationBindings?.find(row=>row.generation===phase.generation);
    if(!binding)throw error('Publish this exact generation before independently reviewing it.','PHASE_GENERATION_REQUIRED',{phase:phaseId});
    const published=await publicationReader().accepted(binding,phaseId,{signal,policyTraversal}),source=workflow.workItem.source.content,storyDocument=workflow.namespaceDocuments?.find(row=>row.id==='story-source'&&same(row.content,source));
    if(!storyDocument)throw error('The pinned Story source has no exact document identity.');
    const sources=[{id:'story-source',path:storyDocument.sourceKey,text:await text(source,signal),originalSha256:source.sha256}],
      references=[binding.record,published.artifact.content,source],resources=[{id:'story-source',kind:'story-source',reference:source}],visualSources=[],unreadableSources=[];
    for(const input of published.inputs.filter(row=>row.kind==='supporting-document')){
      const document=(workflow.namespaceDocuments??[]).find(row=>row.id===input.id&&same(row.content,input.reference));
      if(!document)throw error('A published source document lost its declared identity.');
      const local=document.locality==='machine-local',path=document.sourceKey??document.id;
      if(document.mimeType?.startsWith('image/')||document.mimeType==='application/pdf'){
        if(local)await namespaceLocalInputBytes(observer,input.reference,{signal});else await observer.bytes(input.reference,input.reference.bytes,signal);
        visualSources.push({id:input.id,path,originalSha256:input.reference.sha256,mimeType:document.mimeType});
      }else if(document.encoding==='utf8')sources.push({id:input.id,path,text:await text(input.reference,signal,local),originalSha256:input.reference.sha256});
      else unreadableSources.push({id:input.id,name:document.name,code:local?'machine-local-storage':'no-text-layer',originalSha256:input.reference.sha256});
      resources.push({id:input.id,kind:'supporting-document',reference:input.reference,locality:document.locality});
      if(!local)references.push(input.reference);
    }
    const clarification=publicationReader().policies.clarificationEvidence(published),clarifications=[];
    function addClarification(value,id){if(!value?.response)return;const ref=value.manifest.response.record,answer=value.response.value,document=workflow.namespaceDocuments.find(row=>row.kind==='clarification-record'&&same(row.content,ref));
      if(!document)throw error('The actual clarification has no exact issued document identity.');
      clarifications.push({id,phase:answer.phase,generation:answer.generation,path:document.sourceKey,sha256:ref.sha256});
      references.push(ref);resources.push({id,kind:'clarification',reference:ref});}
    addClarification(clarification,'clarification:current-phase');
    let upstreamSpec=null;
    if(kind==='planning'){
      if(workflow.phaseOrder.filter(id=>sourceReviewKind(workflow,id)==='specification'&&workflow.phases[id].status==='approved').length>1)throw error('Planning review needs its multiple approved scope-source contract.','ENGINE_PORT_UNAVAILABLE',{required:['multi-source-planning-review']});
      const scopePhase=scopeStepOf(workflow);if(!scopePhase||scopePhase.status!=='approved')throw error('Planning review requires the actual approved scope.','SPEC_APPROVED_INDEX_REQUIRED');
      const proof=(await packetReader().inspectApprovedMany(snapshot,[scopePhase.id],{signal,policyTraversal}))[0];
      if(!proof)throw error('Planning review needs the retained original scope approval.','SPEC_APPROVED_INDEX_REQUIRED');
      upstreamSpec={path:proof.published.artifact.sourceKey,text:authoredArtifactText(await text(proof.published.artifact.content,signal)),originalSha256:proof.published.artifact.content.sha256};
      references.push(proof.binding.record,proof.value.publication.record,proof.published.artifact.content);
      resources.push({id:'approved-scope',kind:'approved-input',reference:proof.published.artifact.content});
      addClarification(packetReader().publicationClarification(proof.published),'clarification:approved-scope');
    }
    const value={kind,workId,phase:phaseId,generation:phase.generation,sources,visualSources,unreadableSources,clarifications,
      artifact:{path:published.artifact.sourceKey,text:authoredArtifactText(await text(published.artifact.content,signal)),originalSha256:published.artifact.content.sha256},
      ...(upstreamSpec?{upstreamSpec}:{}),authorAgentId:published.agentId,reviewerAgentId:workflow.resolution.sourceReview.reviewerAgent,reviewerReadOnly:true};
    resources.push({id:'published-artifact',kind:'artifact',reference:published.artifact.content});
    for(const resource of resources){const candidates=(workflow.namespaceDocuments??[]).filter(row=>same(row.content,resource.reference)&&row.status!=='detached'),
      selected=candidates.find(row=>row.id===resource.id)??candidates[0];
      if(!selected)throw error('A review source has no exact issued document reader.','ENGINE_STORAGE_CORRUPT',{sourceId:resource.id});
      resource.read={operation:'document.read',inputs:{reference:selected.role==='file'?{kind:'story-document',id:selected.id,workId}:selected.sourceKey}};
    }
    const identity={profile:'sflow-namespace-source-review-source/v1',publication:binding,binding:rules.sourceReviewBinding(value),authorAgentId:value.authorAgentId,reviewerAgentId:value.reviewerAgentId};
    return {value,identity,resources,published,references:[...new Map(references.filter(ref=>ref.namespace==='evidence').map(ref=>[canonicalJson(ref),ref])).values()]};
  }
  function status(source,prior,at){const row=prior.rows.findLast(row=>row.phase===source.value.phase&&row.generation===source.value.generation),
    dispositions=prior.decisions.filter(entry=>entry.phase===source.value.phase&&entry.generation===source.value.generation);
    return replay(row?.report??null,{...source.value,humanDispositions:dispositions},at??source.published.publishedAt);}
  function currentReview(workflow,request){if(workflow.currentPhase!==request.phaseId||workflow.phases[request.phaseId]?.status!=='in_progress')throw error('Record this review while its published phase is current and in progress.','SOURCE_REVIEW_NOT_CURRENT');}
  function contextDigest(source,prior,at){return 'sha256:'+hash({profile:'sflow-namespace-source-review-candidate/v1',source:source.identity,status:status(source,prior,at)});}
  async function read(snapshot,request,options={}){const prior=await admitted(snapshot,options),source=await context(snapshot,request.phaseId,options),
    selected=status(source,prior,options.at),digest=contextDigest(source,prior,options.at);
    return {...source,prior,status:selected,contextBinding:digest,generation:source.value.generation,
      identity:{...source.identity,priorReviewsSha256:hash(prior.rows),priorDecisionsSha256:hash(prior.decisions)},references:[...prior.references,...source.references]};}
  const recordOwner={async read(snapshot,request,options={}){const source=await read(snapshot,request,options),bytes=Buffer.from(canonicalJson(request.report)),
      reference={namespace:'evidence',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.byteLength};
    if(options.bound?.reportContent){if(!same(options.bound.reportContent,reference))throw error('The report content differs from its original request.');await observer.bytes(reference,reference.bytes,options.signal);}
    return {...source,reportContent:reference,identity:{...source.identity,reportContent:reference},references:[...source.references,reference],pendingEvidence:[{reference,bytes}]};},authority(){return null;},
    plan(workflow,request,facts,source){standaloneDecisionAdmission(recordOperation,workflow);currentReview(workflow,request);
      if(request.expectedContext!==source.contextBinding)throw error('The exact review candidate changed. Read its current context.','SOURCE_REVIEW_BINDING_CHANGED',{
        actions:[{operation:'source-review.context',inputs:{workId,phaseId:request.phaseId}}]});
      const evaluation=replay(request.report,source.value,facts.at);
      if(evaluation.status==='stale'||evaluation.findings.some(row=>['reviewer-not-independent','review-contract-invalid','review-self-disposition'].includes(row.code)))throw error(
        'The report does not describe the exact independent review contract.','SOURCE_REVIEW_REPORT_INVALID',{evaluation});
      if(source.prior.rows.some(row=>row.phase===request.phaseId&&row.generation===source.generation&&row.reportSha256===evaluation.reportSha256))throw error('This exact report is already retained.','SOURCE_REVIEW_ALREADY_RECORDED');
      const proposed=structuredClone(workflow),record={phase:request.phaseId,generation:source.generation,report:structuredClone(request.report),reportSha256:evaluation.reportSha256,reportContent:source.reportContent,
        reviewerAgent:facts.agentId,actor:facts.actorId,at:facts.at};
      const sourceKey=(workflow.resolution.workItemRoot??'singularity/work-items')+'/'+workId+'/source-reviews/'+request.phaseId+'-gen'+source.generation+'-'+evaluation.reportSha256+'.json';
      proposed.namespaceDocuments.push({id:'SOURCE-REVIEW-'+evaluation.reportSha256,phase:request.phaseId,generation:source.generation,sourceKey,role:'file',name:'Independent source review',kind:'source-review',mimeType:'application/json',encoding:'utf8',locality:'project',status:'active',aliases:[],content:source.reportContent});
      proposed.namespaceSourceReviews??=[];proposed.namespaceSourceReviews.push(record);
      proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:'source_review_recorded',phase:request.phaseId,detail:evaluation.status+': '+evaluation.reportSha256});
      return {workflow:proposed,outcome:{currentPhase:workflow.currentPhase,record}};}
  };
  const decisionOwner={read,authority(workflow,request,actor){if(workflow.resolution.presence)throw error('This source-review decision requires its configured human presence owner.','ENGINE_PORT_UNAVAILABLE',{required:['person-presence']});return requireApprovalAuthority(workflow.resolution.approvalAuthorities,workflow.phases[request.phaseId].approvalPolicy,actor.identity).authorityGroup;},
    plan(workflow,request,facts,source){standaloneDecisionAdmission(decisionOperation,workflow);currentReview(workflow,request);
      if(request.expectedContext!==source.contextBinding||!source.status.reportSha256||source.status.status==='stale'
        ||!source.status.pendingDispositions.some(row=>row.id===request.findingId))throw error('Confirm the exact pending source-review finding.','SOURCE_REVIEW_DISPOSITION_NOT_PENDING');
      if(typeof request.reason!=='string'||!request.reason.trim())throw error('A human-authored reason is required.','SOURCE_REVIEW_DISPOSITION_REASON_REQUIRED');
      const proposed=structuredClone(workflow),record={phase:request.phaseId,generation:source.generation,id:request.findingId,reportSha256:source.status.reportSha256,
        decision:'accepted',reason:request.reason.trim(),actor:facts.actorId,authorityGroup:facts.authorityGroup,at:facts.at};
      proposed.namespaceSourceReviewDecisions??=[];proposed.namespaceSourceReviewDecisions.push(record);
      proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:'source_review_disposition_recorded',phase:request.phaseId,detail:record.id+': '+record.reason});
      return {workflow:proposed,outcome:{currentPhase:workflow.currentPhase,record}};}
  };
  readers.set(recordOperation,createNamespaceRecordedMutationReader({observer,scope,workId,operation:recordOperation,owner:recordOwner,contract:namespaceDecisionContract}));
  readers.set(decisionOperation,createNamespaceRecordedMutationReader({observer,scope,workId,operation:decisionOperation,owner:decisionOwner,contract:namespaceDecisionContract}));
  async function inspect(snapshot,phaseId,options={}){const value=await read(snapshot,{phaseId},options);const profile=namespaceSourceReviewRecordProfile('context',{schemaVersion:NAMESPACE_SOURCE_REVIEW_SCHEMAS.context.currentVersion});return {
    schemaVersion:profile.version,profile:profile.profile,workId,phase:phaseId,generation:value.generation,revision:snapshot.revision,
    binding:rules.sourceReviewBinding(value.value),contextBinding:value.contextBinding,resources:value.resources,
    reviewer:{agentId:value.value.reviewerAgentId,readOnly:true,authorAgentId:value.value.authorAgentId},status:value.status};}
  async function acceptance(snapshot,phaseId,options={}){if(!sourceReviewRequired(snapshot.workflow,phaseId))return null;
    const result=await read(snapshot,{phaseId},options);
    if(result.status.status!=='ready')throw error('Finish the independently bound source review before submission.','SOURCE_REVIEW_NOT_READY',{
      phase:phaseId,status:result.status,actions:[{operation:'source-review.context',inputs:{workId,phaseId}}]});
    const row=result.prior.rows.findLast(row=>row.phase===phaseId&&row.generation===result.generation);
    const profile=namespaceSourceReviewRecordProfile('submitted',{schemaVersion:NAMESPACE_SOURCE_REVIEW_SCHEMAS.submitted.currentVersion});return {binding:{schemaVersion:profile.version,profile:profile.profile,phase:phaseId,generation:result.generation,
      reportSha256:row.reportSha256,report:row.reportContent,contextBinding:result.contextBinding,records:result.prior.references},references:[...result.references,row.reportContent]};}
  return Object.freeze({recordOwner,decisionOwner,inspect,acceptance,admitted,continuation:sourceReviewContinuationEvidence});
}
