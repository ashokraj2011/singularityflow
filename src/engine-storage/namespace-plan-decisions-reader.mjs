/** Exact approved plan and human amendment proof. Reads never acquire a writer or a checkout. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {sourceSnapshot} from '../foundation/source-snapshot.mjs';
import {standaloneDecisionAdmission,planCorrectionOwnerSelection} from '../kernel/decision-plan.mjs';
import {planCorrectionPolicies} from '../kernel/plan-corrections.mjs';
import {validatePlannedVerification} from '../kernel/verification-policy.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../engine-compatibility/node-configuration-path.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {normalizeClaimMapReplay} from '../engine-compatibility/node-specification-policy.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {hasPublishedPhaseGeneration,phaseNeedsGeneration,phaseInspectionGeneration} from '../kernel/phase-policy.mjs';
import {mergePlannedClaimRecords} from '../kernel/specification-policy.mjs';
import {planDecisions} from '../engine-compatibility/node-plan-policy.mjs';
import {repositoryPlanTestLocation} from '../engine-compatibility/node-repository-plan.mjs';
import {createNamespaceSpecificationReader} from './namespace-specifications.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceSourceObservations} from './namespace-source-observations.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {namespaceDecisionContract,namespaceDecisionReceipts} from './namespace-decision-contract.mjs';
import {memoNamespaceObservedDecision} from './namespace-story-reader.mjs';
const operation='decision.plan',correctionOperation='plan.correction.record',same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=value=>createHash('sha256').update(value).digest('hex'),
  error=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespacePlanDecisionOwners({observer,scope,workId,sources=[]}){
  const checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),observations=createNamespaceSourceObservations({observer,scope,sources});
  let reader,correctionReader;
  const rowPolicies=planCorrectionPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_DIGESTS);
  async function admitted(snapshot,{signal,policyTraversal}={}){
    const rows=snapshot.workflow.planAmendments??[],links=namespaceDecisionReceipts(snapshot.workflow).filter(row=>[operation,correctionOperation].includes(row.operation));
    if(!Array.isArray(rows)||links.length>64)throw error('The accepted plan amendment inventory exceeds its contract.','ENGINE_STORAGE_LIMIT');
    if(!links.length){if(rows.length)throw error('Plan amendments have no accepted human receipts.');return {rows:[],links:[],references:[]};}
    const link=links.at(-1),last=await memoNamespaceObservedDecision(observer,{owner:'plan-amendments',link},async()=>{
      const accepted=await (link.operation===operation?reader:correctionReader).accepted(link,{signal,policyTraversal});
      return {rows:accepted.accepted.state.workflow.planAmendments};},{signal});
    if(!same(rows,last.rows))throw error('The plan amendment list differs from its last human transition.');
    // Each prior record is authenticated while replaying that transition's original prefix.
    return {rows,links,references:links.map(row=>row.record)};
  }
  async function basePlans(snapshot,{signal,rows=[]}={}){
    const workflow=snapshot.workflow,owners=workflow.resolution?.plannedClaims?.owners??{},seen=new Set(),values=[],
      specifications=createNamespaceSpecificationReader({observer,scope,workId,checks});
    for(const codeId of workflow.phaseOrder){const owner=owners[codeId],phase=workflow.phases[owner];
      if(!owner||seen.has(owner)||phase?.status!=='approved'||phase.generation<1)continue;seen.add(owner);
      const value=await specifications.sourcePlan(snapshot,codeId,{signal,includeAmendments:false});values.push({codeId,...value,planned:rowPolicies.applyNamespacePlanCorrections(value.planned,workflow,rows,{originalMapSha256:value.proof.planned.sha256})});}
    if(!values.length)throw error('This Story has no approved planning input to amend.','SPEC_PLANNED_CLAIM_MAP_REQUIRED');
    const references=values.flatMap(row=>[row.proof.publication,row.proof.reviewPacket,row.proof.planned,
      ...row.proof.indices.map(item=>item.record),...(row.proof.repositoryPlan?[row.proof.repositoryPlan]:[])]);
    return {values,plan:mergePlannedClaimRecords(values.map(row=>row.planned)),references};
  }
  async function observedSource(snapshot,plans,changes,bound,signal){
    const selected=snapshot.workflow.sourceBindings?.current;
    if(!selected){if(bound?.observations?.length)throw error('The original plan had no bound source selection.');return {rows:[],references:[],pendingEvidence:[],contentHashes:{}};}
    const accepted=await observations.binding(selected.operationId,signal);
    if(!same(accepted.selected,selected))throw error('The plan source selection differs from its accepted transaction.');
    const rows=[],references=[],pendingEvidence=[],contentHashes={},captured=new Map();
    if(bound&&(!Array.isArray(bound.observations)||bound.observations.length!==selected.repositories.length))throw error('The plan decision lost a source observation.');
    for(const repository of selected.repositories){
      let snapshot,reference,revision;
      if(bound){const retained=bound.observations.find(row=>row.id===repository.id);
        if(!retained||!same(retained.descriptor,repository.descriptor))throw error('A plan source observation has another repository.');
        if(retained.content?.namespace!=='evidence')throw error('The original amendment source needs shared snapshot evidence.');
        const bytes=await observer.bytes(retained.content,retained.content.bytes,signal);
        try{snapshot=sourceSnapshot(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),repository.descriptor);}catch(cause){
          throw new SingularityFlowError('The retained plan source snapshot is invalid.',{code:'ENGINE_STORAGE_CORRUPT',cause});}
        reference=retained.content;revision='sha256:'+hash(canonicalJson(snapshot));if(retained.revision!==revision)throw error('The plan source revision has another digest.');
      }else{const actual=await observations.capture(repository,signal);snapshot=actual.snapshot;revision=actual.revision;
        const bytes=Buffer.from(canonicalJson(snapshot));reference={namespace:'evidence',sha256:hash(bytes),bytes:bytes.byteLength};pendingEvidence.push({reference,bytes});}
      rows.push({id:repository.id,descriptor:repository.descriptor,revision,content:reference});references.push(reference);captured.set(repository.id,snapshot);
    }
    for(const change of changes){
      const declared=plans.values.map(row=>row.repositoryPlan).find(Boolean),location=declared?repositoryPlanTestLocation(declared,change.path,{workflow:snapshot.workflow}):null;
      if(!declared&&selected.repositories.length!==1)throw error('A multi-repository amendment needs an approved repository-qualified plan.','ENGINE_PORT_UNAVAILABLE',{required:['repository-qualified-plan-amendment']});
      const id=location?.repositoryId??selected.repositories[0].id,path=location?.path??change.path,entry=captured.get(id)?.entries.find(row=>row.path===path);
      if(declared&&!location)throw error('The amended path is outside the approved repository roots.','PLAN_AMENDMENT_INVALID',{path:change.path});
      if(entry)contentHashes[change.path]=entry.sha256;
    }
    return {rows,references,pendingEvidence,contentHashes};
  }
  const owner={
    async read(snapshot,request,{signal,bound,policyTraversal}={}){
      const prior=await admitted(snapshot,{signal,policyTraversal}),plans=await basePlans(snapshot,{signal,rows:prior.rows}),phase=snapshot.workflow.phases[request.phaseId];
      if(!phase)throw error('The amendment has another phase binding.','ENGINE_PHASE_UNAVAILABLE');
      // Validate and normalize exact paths before asking an execution port to observe them.
      const normalized=planDecisions.recordPlanAmendment(structuredClone(snapshot.workflow),{changes:request.changes,reason:request.reason,plan:plans.plan}).changes,
        observed=await observedSource(snapshot,plans,normalized,bound,signal),identity={profile:'sflow-namespace-plan-amendment-source/v1',
          plans:plans.values.map(row=>row.proof),observations:observed.rows,contentHashes:observed.contentHashes};
      if(bound&&!same(bound,identity))throw error('The amendment no longer replays its original planning and source inputs.');
      return {generation:phase.generation,identity,plan:plans.plan,references:[...prior.references,...plans.references,...observed.references],pendingEvidence:observed.pendingEvidence};
    },
    async fresh(snapshot,_request,source,{signal}={}){
      const selected=snapshot.workflow.sourceBindings?.current;
      for(const row of source.identity.observations){const repository=selected?.repositories.find(item=>item.id===row.id);
        if(!repository||!same(repository.descriptor,row.descriptor))throw error('The amendment source selection changed.','ENGINE_CONTEXT_CHANGED');
        const current=await observations.capture(repository,signal);if(current.revision!==row.revision)throw error(
          'The source changed after the human reviewed this plan amendment. Review the current files and use a new operation ID.','ENGINE_SOURCE_CHANGED',{
            repositoryId:row.id,expected:row.revision,observed:current.revision,requiredInputs:['operationId']});}
    },
    authority(workflow,_request,actor){const groups=planDecisions.planAuthorities(workflow);
      if(!groups.length)throw error('This Story has no authorized planning reviewer.','PLAN_AMENDMENT_AUTHORITY_UNAVAILABLE');
      return requireApprovalAuthority(workflow.resolution.approvalAuthorities,{mode:'required',authorities:groups,requiredAuthorities:[],minimum:1},actor.identity).authorityGroup;},
    plan(workflow,request,facts,source){standaloneDecisionAdmission(operation,workflow);
      if(request.phaseId!==workflow.currentPhase)throw error('The amendment has another current-phase binding.','ENGINE_CONTEXT_CHANGED');
      const proposed=structuredClone(workflow),record=planDecisions.recordPlanAmendment(proposed,{...request,plan:source.plan,contentHashes:source.identity.contentHashes,
        actor:facts.actorId,authorityGroup:facts.authorityGroup,identityAssurance:null,at:facts.at});
      proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:'plan_amended',phase:workflow.currentPhase,
        detail:record.id+': '+record.changes.map(change=>change.kind==='add-location'?change.path+' added to '+change.clauseId:change.path+' listed as '+change.class).join('; ')+'. '+record.reason});
      return {workflow:proposed,outcome:{currentPhase:workflow.currentPhase,record}};
    }
  };
  async function correctionPreview(snapshot,request,{signal,policyTraversal}={}){
    const prior=await admitted(snapshot,{signal,policyTraversal}),plans=await basePlans(snapshot,{signal,rows:prior.rows}),workflow=snapshot.workflow,
      selected=planCorrectionOwnerSelection(workflow,request.ownerPhase,plans.values.map(row=>row.planned.phase)),value=plans.values.find(row=>row.planned.phase===selected.id);
    if(!value)throw error('The exact approved plan owner could not be read.','PLAN_ROW_CORRECTION_INVALID');
    const ownerRecord=value.planned,clauses=value.active.indexes.flatMap(index=>index.clauses),clauseIds=[...new Set(clauses.map(row=>row.id))],
      normalizeRow=(clauseId,raw)=>{const replay=normalizeClaimMapReplay({claims:{[clauseId]:raw}},{kind:'planned',clauseIds,policy:workflow.resolution.spec});
        let step=replay.next();while(!step.done)step=replay.next(ownerRecord.recordedAt);return step.value.claims[clauseId];},
      evidenceOperations=(request.operations??[]).filter(row=>row.op==='reclassify-evidence');
    let namespaceEvidence=null;
    if(evidenceOperations.length){const phase=workflow.phases[workflow.currentPhase],approved=await observer.approved(snapshot,{signal}),definition=approved.compiled.definition;
      if(workflow.status!=='in_progress'||workflow.resolution.plannedClaims?.owners?.[workflow.currentPhase]!==selected.id
        ||hasPublishedPhaseGeneration(phase)&&!phaseNeedsGeneration(workflow,phase)){
        const canRaise=workflow.status==='in_progress'&&phase&&workflow.phaseOrder.indexOf(selected.id)>=0
          &&workflow.phaseOrder.indexOf(selected.id)<workflow.phaseOrder.indexOf(phase.id);
        throw error('Correct retained evidence in the current unpublished draft. A published generation needs its original planning owner and an authorized return.',
          'PLAN_EVIDENCE_CORRECTION_LIFECYCLE',{actions:canRaise?[{operation:'upstream.raise',inputs:{workId,phaseId:selected.id,about:'retained-evidence contract',proposed:'return'},
            requiredInputs:['operationId','problem','assumption','impact']}]:[{operation:'story.status',inputs:{workId}}]});}
      namespaceEvidence={root:(definition.workItemRoot??'singularity/work-items')+'/'+workId+'/evidence',
        phaseId:phase.id,generation:phaseInspectionGeneration(workflow,phase),
        protectedPaths:[...(definition.governance?.protectedPaths??[]),...(workflow.resolution.capability?.policy?.protectedPaths??[])]};}
    const parameters={ownerRecord,ownerMapSha256:value.proof.planned.sha256,operations:request.operations,activeClauseIds:clauseIds,normalizeRow,
        validate:plan=>validatePlannedVerification(plan.claims,plan.verificationContracts??[],clauses),reason:request.reason,upstreamIssue:request.upstreamIssue},
      preview=rowPolicies.previewNamespacePlanCorrection(workflow,{...parameters,...(namespaceEvidence?{namespaceEvidence}:{})});
    if(namespaceEvidence)parameters.namespaceEvidence=namespaceEvidence;
    const evidenceReferences=preview.operations.filter(row=>row.op==='reclassify-evidence').map(row=>row.content);
    for(const reference of evidenceReferences)await observer.bytes(reference,reference.bytes,signal);
    if(value.repositoryPlan)for(const row of Object.values(preview.after))for(const path of [...(row.expectedPaths??[]),...(row.tests??[])]){
      if(!repositoryPlanTestLocation(value.repositoryPlan,path,{workflow}))throw error('Keep the corrected path inside an approved repository root.','PLAN_ROW_CORRECTION_INVALID',{path});}
    const groups=rowPolicies.planCorrectionAuthorities(workflow,selected.id);if(!groups.length)throw error('The exact plan owner has no human reviewers.','PLAN_AMENDMENT_AUTHORITY_UNAVAILABLE');
    return {generation:workflow.phases[workflow.currentPhase]?.generation??0,preview,parameters,groups,recording:rowPolicies.namespaceCorrectionRequirements(workflow,preview),
      identity:{profile:'sflow-namespace-plan-correction-source/v1',owner:value.proof,amendments:prior.links,previewSha256:preview.previewSha256},
      references:[...prior.references,...plans.references,...evidenceReferences]};
  }
  const correctionOwner={
    async read(snapshot,request,options={}){const value=await correctionPreview(snapshot,request,options);
      if(options.bound&&!same(options.bound,value.identity))throw error('The original plan correction lost its exact reviewed inputs.');return value;},
    authority(workflow,_request,actor,source){return requireApprovalAuthority(workflow.resolution.approvalAuthorities,
      {mode:'required',authorities:source.groups,requiredAuthorities:[],minimum:1},actor.identity).authorityGroup;},
    assertNew(snapshot,_request,source){const requirements=rowPolicies.namespaceCorrectionRequirements(snapshot.workflow,source.preview);
      if(requirements.requiredOwners.length)throw error('This correction needs its actual revalidation or person-presence owner.','ENGINE_PORT_UNAVAILABLE',{
        required:requirements.requiredOwners,affectedPhases:requirements.affectedPhases});},
    plan(workflow,request,facts,source){standaloneDecisionAdmission(correctionOperation,workflow);
      correctionOwner.assertNew({workflow},request,source);
      if(request.phaseId!==workflow.currentPhase)throw error('The correction has another current-phase binding.','ENGINE_CONTEXT_CHANGED');
      const proposed=structuredClone(workflow),record=rowPolicies.recordNamespacePlanCorrection(proposed,{...source.parameters,expectedPreview:request.expectedPreview,
        actor:facts.actorId,authorityGroup:facts.authorityGroup,at:facts.at});
      proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:'plan_amended',phase:workflow.currentPhase,
        detail:record.id+' corrects '+record.ownerPhase+': '+record.operations.map(row=>row.op+' '+row.clauseId).join('; ')+'. '+record.reason});
      return {workflow:proposed,outcome:{currentPhase:workflow.currentPhase,record}};}
  };
  correctionReader=createNamespaceRecordedMutationReader({observer,scope,workId,operation:correctionOperation,owner:correctionOwner,contract:namespaceDecisionContract});
  reader=createNamespaceRecordedMutationReader({observer,scope,workId,operation,owner,contract:namespaceDecisionContract});
  async function projection(snapshot,options){const value=await admitted(snapshot,options),record=planDecisions.planAmendmentRecord(snapshot.workflow,value.rows);
    return {record,rows:value.rows,receipts:value.links,references:value.references};}
  return Object.freeze({owner,reader,projection,correctionOwner,correctionReader,correctionPreview});
}
