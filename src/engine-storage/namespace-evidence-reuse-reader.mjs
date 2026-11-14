/** Read actual producer approvals, SGOS test receipts and source bytes. Never execute or accept caller verdicts. */
import {createHash} from 'node:crypto';
import {canonicalJson,NAMESPACE_EVIDENCE_REUSE_SCHEMAS,namespaceEvidenceReuseRecordProfile} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {sourceSnapshot,validateSourceUnit} from '../foundation/source-snapshot.mjs';
import {namespaceEvidenceReusePhase,namespaceEvidenceReuseState,namespaceEvidenceReusePlan,namespaceReuseEnvironment,NAMESPACE_EVIDENCE_REUSE_PROFILE} from '../kernel/evidence-reuse.mjs';
import {evidenceReuseAuthorities} from '../kernel/approval-fallback.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {standaloneDecisionAdmission} from '../kernel/decision-plan.mjs';
import {sourceBaselineInventory} from '../engine-compatibility/node-source-policy.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespaceTestCommandOwners} from './namespace-test-command-reader.mjs';
import {createNamespaceSourceObservations} from './namespace-source-observations.mjs';
import {memoNamespaceObservedDecision} from './namespace-story-reader.mjs';
import {namespaceEvidencePolicyManifest} from './namespace-policy-contract.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=value=>createHash('sha256').update(value).digest('hex'),
  fail=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>{throw new SingularityFlowError(message,{code,details});},
  unique=values=>[...new Map(values.map(value=>[canonicalJson(value),value])).values()];
export const EVIDENCE_REUSE_POLICY='evidence-reuse/v1';
export const namespaceEvidenceReuseManifest=(value,scope)=>namespaceEvidencePolicyManifest(value,{...scope,
  family:NAMESPACE_EVIDENCE_REUSE_SCHEMAS.policy,format:namespaceEvidenceReuseRecordProfile('policy',value).profile});
export function createNamespaceEvidenceReuseOwner({observer,scope,workId,sources=[],checks:bindings,environmentChecks=null}){
  const operation='decision.evidence-reuse',sourceBindings=createNamespaceSourceObservations({observer,scope}),checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer,checks:bindings}),
    packets=createNamespaceSubmissionReader({observer,scope,workId,checks}),commands=createNamespaceTestCommandOwners({observer,scope,workId});let reader;
  async function json(reference,signal){const bytes=await observer.bytes(reference,reference.bytes,signal);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch(cause){throw new SingularityFlowError(
      'The reuse source is not retained UTF-8 JSON.',{code:'ENGINE_STORAGE_CORRUPT',cause});}}
  async function admitted(snapshot,options={}){
    const rows=snapshot.workflow.namespaceEvidenceReuses??[],links=namespaceDecisionContract.receipts(snapshot.workflow).filter(row=>row.operation===operation);
    if(!Array.isArray(rows)||rows.length!==links.length||rows.length>128)fail('The reuse inventory lost its bounded original human receipts.');
    for(const row of rows){let profile;try{profile=namespaceEvidenceReuseRecordProfile('record',row);}catch(cause){throw new SingularityFlowError(
      'The retained reuse decision has an unsupported schema.',{code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',cause});}
      if(row.profile!==profile.profile)fail('The retained reuse decision has another profile.');}
    const proofs=[];
    for(const link of links)proofs.push(await memoNamespaceObservedDecision(observer,{profile:NAMESPACE_EVIDENCE_REUSE_PROFILE,record:link.record},
      ()=>reader.accepted(link,options),options));
    if(!same(rows,proofs.map(proof=>proof.value.outcome.record)))fail('The reuse inventory differs from its accepted decisions.');
    return proofs;
  }
  async function inventory(snapshot,phaseId,options={}){
    const workflow=snapshot.workflow;namespaceEvidenceReusePhase(workflow,phaseId);
    const selected=await commands.commands(snapshot,phaseId,options),repositories=workflow.sourceBindings?.current?.repositories??[];
    if(!repositories.length||repositories.length>32||workflow.phaseOrder.length>256)fail('Reuse requires the actual bounded source selection.','ENGINE_SOURCE_UNIT_UNAVAILABLE');
    const original=await sourceBindings.binding(workflow.sourceBindings.current.operationId,options.signal);
    if(!same(original.selected,workflow.sourceBindings.current))fail('The reuse source selection differs from its original accepted binding.');
    const prior=workflow.phaseOrder.slice(0,workflow.phaseOrder.indexOf(phaseId)).filter(id=>workflow.phases[id].status==='approved'
      &&workflow.phases[id].namespaceSubmission),
      producers=await packets.inspectApprovedMany(snapshot,prior,options),candidates=[],references=[...selected.references];
    const minimums=workflow.resolution.codeDelivery?.tests??{};
    for(const [index,proof]of producers.entries()){
      if(!proof?.published.checks)continue;
      const tested=await checks.publication(proof.published,options),producerPhase=workflow.phases[prior[index]];
      const votes=(producerPhase.approvals??[]).filter(row=>row.namespaceVote).map(row=>row.namespaceVote.record);
      references.push(proof.binding.record,proof.value.publication.record,tested.record.content,...votes);
      // Reuse covers the complete same repository set, never a smaller source selection.
      if(!same(tested.plan.sources.map(row=>({id:row.id,selection:row.descriptor.selection})),repositories.map(row=>({id:row.id,selection:row.descriptor.selection}))))continue;
      for(const [offset,step]of tested.plan.steps.entries()){
        const observed=tested.body.checks[offset],tests=observed.tests;
        if(step.command.kind!=='test'||observed.status!=='passed'||!tests||tests.discovered<Math.max(1,minimums.minimumDiscovered??1)
          ||tests.passed<Math.max(1,minimums.minimumPassed??1)||tests.failed!==0||tests.skipped!==0||(tests.cancelled??0)!==0||(tests.todo??0)!==0
          ||!selected.commands.some(row=>same(row,step.command)))continue;
        const producer={phase:prior[index],generation:proof.value.generation,publication:proof.value.publication,submission:proof.binding,
          checks:proof.published.checks,taskId:step.contract.taskId,repositoryId:step.repositoryId,command:step.command,
          tests,completedAt:tested.body.recordedAt,executionSha256:'sha256:'+hash(canonicalJson(tested.body.results[offset]))};
        candidates.push({taskId:step.contract.taskId,producer,sources:tested.plan.sources,
          qualification:step.manifest.toolPolicy.environmentQualification??null,command:step.manifest.toolPolicy.command});
      }
    }
    if(candidates.length>1024)fail('The reuse candidate inventory exceeds its explicit bound.','ENGINE_STORAGE_LIMIT');
    return {candidates,commands:selected.commands,commandIdentity:selected.identity,repositories,references:unique(references)};
  }
  async function observations(snapshot,repositorySet,{signal,bound=null,units=sources}={}){
    const definition=(await observer.approved(snapshot,{signal})).compiled.definition,selected=new Map(units.map(unit=>[validateSourceUnit(unit).repositoryId,unit])),
      rows=[],pendingEvidence=[];
    if(bound!==null&&(!Array.isArray(bound)||bound.length!==repositorySet.length))fail('The reuse source inventory is incomplete.');
    for(const [index,repository]of repositorySet.entries()){
      let value,descriptor,reference;
      if(bound!==null){const row=bound[index];if(row.id!==repository.id)fail('The reuse source changed its repository order.');
        descriptor=row.descriptor;value=sourceSnapshot(await json(row.content,signal),descriptor);reference=row.content;
        if(descriptor.projectId!==scope.projectId||descriptor.repositoryId!==repository.id||!same(descriptor.selection,repository.descriptor.selection))fail('The reuse source changed its actual repository selection.');
      }else{
        const unit=selected.get(repository.id);descriptor=unit&&validateSourceUnit(unit);
        if(!descriptor||descriptor.projectId!==scope.projectId||!same(descriptor.selection,repository.descriptor.selection))fail(
          'Bind the actual source unit before authorizing or consuming reused tests.','ENGINE_SOURCE_UNIT_UNAVAILABLE',{repositoryId:repository.id});
        const observed=await unit.capture({signal});value=sourceSnapshot(observed.snapshot,descriptor);
        const bytes=Buffer.from(canonicalJson(value));reference={namespace:'evidence',sha256:hash(bytes),bytes:bytes.byteLength};
        if(observed.revision!=='sha256:'+reference.sha256)fail('The reuse source port returned another revision.','ENGINE_PORT_RESULT_INVALID');
        pendingEvidence.push({reference,bytes});
      }
      const inventorySha256='sha256:'+hash(canonicalJson(sourceBaselineInventory(value,{definition,workflow:snapshot.workflow})));
      const row={id:repository.id,descriptor,content:reference,inventorySha256};
      if(bound!==null&&!same(row,bound[index]))fail('The retained reuse source inventory differs from its actual bytes.');rows.push(row);
    }
    return {rows,pendingEvidence};
  }
  async function matches(snapshot,candidate,observed,{signal}={}){
    const definition=(await observer.approved(snapshot,{signal})).compiled.definition;
    if(candidate.sources.length!==observed.length)return false;
    for(const [index,repository]of candidate.sources.entries()){
      const original=sourceSnapshot(await json(repository.content,signal),repository.descriptor),row=observed[index];
      if(row.id!==repository.id||row.inventorySha256!=='sha256:'+hash(canonicalJson(sourceBaselineInventory(original,{definition,workflow:snapshot.workflow}))))return false;
    }
    return true;
  }
  const environmentReader=environmentChecks??checks;
  async function environment(snapshot,phaseId,candidate,observed,{signal,bound=null}={}){
    const expected=namespaceReuseEnvironment(candidate.qualification,candidate.command),repository=snapshot.workflow.sourceBindings.current.repositories.find(row=>row.id===candidate.producer.repositoryId),
      source=candidate.sources.find(row=>row.id===repository.id),original=sourceSnapshot(await json(source.content,signal),source.descriptor),
      fingerprint=value=>'sha256:'+hash(canonicalJson({selection:value.selection,entries:value.entries})),expectedInputs=fingerprint(original);let current;
    if(bound!==null){if(!Array.isArray(bound)||bound.length!==1)fail('The qualified reuse environment is incomplete.');current=bound[0];}
    else{
      const found=await environmentReader.environment(phaseId,candidate.producer.command,repository,{signal}),inventorySha256=fingerprint(found.source);
      current={repositoryId:repository.id,commandId:candidate.producer.command.id,identity:found.identity,inventorySha256};
    }
    if(!same(current,{repositoryId:repository.id,commandId:candidate.producer.command.id,identity:expected,inventorySha256:expectedInputs}))fail(
      'The receiving environment or its dependency/source inputs differ from the original execution. Run current checks.','ENGINE_EVIDENCE_REUSE_ENVIRONMENT_CHANGED',{
        repositoryId:repository.id,commandId:candidate.producer.command.id,actions:[{operation:'phase.checks.run',inputs:{workId,phaseId},requiredInputs:['operationId']}]});
    return [current];
  }
  const owner={
    agentPhase:snapshot=>snapshot.workflow.currentPhase,
    async read(snapshot,request,options={}){
      const previous=await admitted(snapshot,options),phase=snapshot.workflow.phases[request.phaseId];
      if(!phase)fail('Name a phase of this Story.','EVIDENCE_REUSE_INVALID');
      if(request.revoke){const target=previous.find(row=>row.value.outcome.record.id===request.revoke);
        if(!target)fail('This Story has no such reuse decision.','EVIDENCE_REUSE_UNKNOWN');
        return {generation:phase.generation,identity:{profile:NAMESPACE_EVIDENCE_REUSE_PROFILE,revoke:target.reference},
          references:previous.map(row=>row.reference)};}
      if(snapshot.workflow.currentPhase!==request.phaseId||phase.status==='awaiting_approval')fail(
        'Authorize reused tests in the active authoring phase before submitting its packet.','EVIDENCE_REUSE_NOT_ELIGIBLE',{
          actions:[{operation:'phase.review',inputs:{workId,phaseId:request.phaseId}}]});
      const values=await inventory(snapshot,request.phaseId,options),candidate=values.candidates.find(row=>row.taskId===request.attemptId);
      if(!candidate)fail('This task is not a matching passing execution of an earlier approved phase.','EVIDENCE_REUSE_NOT_ELIGIBLE',{
        actions:[{operation:'evidence-reuse.context',inputs:{workId,phaseId:request.phaseId}},{operation:'phase.checks.run',inputs:{workId,phaseId:request.phaseId},requiredInputs:['operationId']}]});
      const observed=await observations(snapshot,values.repositories,{...options,bound:options.bound?.observations??null});
      if(!await matches(snapshot,candidate,observed.rows,options))fail('Source or test inputs changed after the original execution. Run current checks.','ENGINE_SOURCE_CHANGED',{
        actions:[{operation:'phase.checks.run',inputs:{workId,phaseId:request.phaseId},requiredInputs:['operationId']}]});
      const qualified=options.bound?Object.hasOwn(options.bound,'environments'):environmentReader.environmentSensitiveReuse,
        environments=qualified?await environment(snapshot,request.phaseId,candidate,observed.rows,{...options,bound:options.bound?.environments??null}):null;
      return {generation:phase.generation,candidate,observations:observed.rows,...(qualified?{environments}:{}),identity:{profile:qualified?'sflow-namespace-evidence-reuse/v2':NAMESPACE_EVIDENCE_REUSE_PROFILE,
        candidate:candidate.producer,commands:values.commandIdentity,observations:observed.rows,...(qualified?{environments}:{})},
        pendingEvidence:observed.pendingEvidence,references:unique([...previous.map(row=>row.reference),...values.references,...observed.rows.map(row=>row.content)])};
    },
    authority(workflow,request,actor){
      if(workflow.resolution.presence)fail('Reuse requires its configured person-presence evidence.','ENGINE_PORT_UNAVAILABLE',{required:['person-presence']});
      const groups=evidenceReuseAuthorities(workflow,request.phaseId);
      if(!groups.length)fail('Configure the human group authorized to reuse evidence.','EVIDENCE_REUSE_AUTHORITY_UNAVAILABLE');
      return requireApprovalAuthority(workflow.resolution.approvalAuthorities,{mode:'required',authorities:groups,requiredAuthorities:[],minimum:1},actor.identity).authorityGroup;
    },
    plan(workflow,request,facts,source){standaloneDecisionAdmission(operation,workflow);return namespaceEvidenceReusePlan(workflow,request,facts,source);},
    async fresh(snapshot,request,source,{signal}={}){if(request.revoke)return;
      const selected=await observations(snapshot,snapshot.workflow.sourceBindings.current.repositories,{signal});
      if(!same(selected.rows.map(row=>({id:row.id,inventorySha256:row.inventorySha256})),source.observations.map(row=>({id:row.id,inventorySha256:row.inventorySha256}))))fail(
        'Source bytes changed while recording reuse.','ENGINE_SOURCE_CHANGED');
      if(source.environments&&!same(source.environments,await environment(snapshot,request.phaseId,source.candidate,selected.rows,{signal})))fail(
        'The receiving environment changed while recording reuse.','ENGINE_EVIDENCE_REUSE_ENVIRONMENT_CHANGED');}
  };
  reader=createNamespaceRecordedMutationReader({observer,scope,workId,operation,owner,contract:namespaceDecisionContract});
  async function publication(snapshot,phaseId,{signal,at,bound=null,units=sources,policyTraversal}={}){
    const proofs=await admitted(snapshot,{signal,policyTraversal}),rows=proofs.map(proof=>({record:proof.value.outcome.record,reference:proof.reference}))
      .filter(row=>row.record.id&&row.record.phase===phaseId);
    if(!rows.length)return null;
    const values=await inventory(snapshot,phaseId,{signal,policyTraversal}),observed=await observations(snapshot,values.repositories,{signal,bound:bound?.sources??null,units}),
      selected=[],missing=[],lapsed=[],environments=[];
    for(const command of values.commands)for(const repository of values.repositories){
      const matching=rows.filter(row=>row.record.producer.repositoryId===repository.id&&row.record.producer.command.id===command.id);
      let chosen=null;
      for(const row of matching.toReversed()){
        const state=namespaceEvidenceReuseState(snapshot.workflow,row.record,{at}),candidate=values.candidates.find(value=>same(value.producer,row.record.producer));
        if(state==='active'&&candidate&&same(candidate.producer.command,command)&&await matches(snapshot,candidate,observed.rows,{signal})){
          if(namespaceEvidenceReuseRecordProfile('record',row.record).environmentQualified){const current=await environment(snapshot,phaseId,candidate,observed.rows,{signal,bound:bound?row.record.environments:null});
            if(!same(current,row.record.environments))fail('Qualified reuse changed its reviewed environment.');environments.push(...current);}
          else if(!bound&&environmentReader.environmentSensitiveReuse)fail('Authorize environment-qualified reuse for this receiving host, or execute current checks.','ENGINE_EVIDENCE_REUSE_ENVIRONMENT_REQUIRED');
          chosen=row;break;}
        lapsed.push({id:row.record.id,state:state!=='active'?state:!candidate?'producer-or-command-changed':'source-changed'});
      }
      if(chosen)selected.push({decision:chosen.reference,record:chosen.record});else missing.push({commandId:command.id,repositoryId:repository.id});
    }
    if(!values.commands.length||missing.length)fail('Reused tests do not cover the current exact command and repository inventory. Run current checks or review its reuse decisions.',
      'ENGINE_EVIDENCE_REUSE_INCOMPLETE',{phase:phaseId,missing,lapsed,actions:[{operation:'evidence-reuse.context',inputs:{workId,phaseId}},
        {operation:'phase.checks.run',inputs:{workId,phaseId},requiredInputs:['operationId']}]});
    const version=environments.length?2:1;
    if(version===2&&selected.some(row=>!namespaceEvidenceReuseRecordProfile('record',row.record).environmentQualified))fail('A qualified reuse set requires qualified decisions for every receiving command and repository.','ENGINE_EVIDENCE_REUSE_ENVIRONMENT_REQUIRED');
    return {report:{schemaVersion:version,profile:'sflow-namespace-evidence-reuse-policy/v'+version,workId,phaseId,commands:values.commandIdentity,
      reused:selected,sources:observed.rows,...(version===2?{environments}:{}),testsExecutedByReceiver:false,environmentRechecked:version===2,failuresWaived:false},
      references:unique([...proofs.map(proof=>proof.reference),...values.references,...observed.rows.map(row=>row.content)]),
      pendingEvidence:observed.pendingEvidence,policy:{owners:['check-execution']}};
  }
  async function context(snapshot,phaseId,{signal,at}={}){
    const proofs=await admitted(snapshot,{signal}),values=await inventory(snapshot,phaseId,{signal}),observed=await observations(snapshot,values.repositories,{signal}),candidates=[];
    const version=environmentReader.environmentSensitiveReuse?2:1;
    for(const candidate of values.candidates){const sourceMatches=await matches(snapshot,candidate,observed.rows,{signal});let environmentMatches=false,environmentIssue=null;
      if(version===2&&sourceMatches)try{await environment(snapshot,phaseId,candidate,observed.rows,{signal});environmentMatches=true;}
      catch(cause){if(!['ENGINE_EVIDENCE_REUSE_ENVIRONMENT_CHANGED','ENGINE_EVIDENCE_REUSE_ENVIRONMENT_REQUIRED'].includes(cause.code))throw cause;
        environmentIssue={code:cause.code,message:cause.message,details:cause.details??null};}
      candidates.push({...candidate.producer,sourceMatches,...(version===2?{environmentMatches,environmentIssue}:{})});}
    return {schemaVersion:version,profile:'sflow-namespace-evidence-reuse-context/v'+version,workId,phase:phaseId,revision:snapshot.revision,candidates,
      decisions:proofs.filter(row=>row.value.phase===phaseId).map(row=>({record:row.value.outcome.record,reference:row.reference,
        state:row.value.outcome.record.revokes?'revocation':namespaceEvidenceReuseState(snapshot.workflow,row.value.outcome.record,{at})})),
      authorities:evidenceReuseAuthorities(snapshot.workflow,phaseId),testsExecutedByReceiver:false,
      actions:[...candidates.filter(row=>row.sourceMatches&&(version===1||row.environmentMatches)).map(row=>({operation,inputs:{workId,phaseId,attemptId:row.taskId},requiredInputs:['reason']})),
        ...(version===2?[{operation:'phase.checks.run',inputs:{workId,phaseId},requiredInputs:['operationId'],prerequisites:['authored-current-phase-draft','explicit-check-execution-bindings']}]:[])]};
  }
  return Object.freeze({owner,reader,admitted,inventory,context,publication});
}
