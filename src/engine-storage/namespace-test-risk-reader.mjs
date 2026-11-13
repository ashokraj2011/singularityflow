/** Authentic human risk receipts and actual failed SGOS observations. Never executes or fabricates a pass. */
import {createNamespaceTestRecoveryOwner} from './namespace-test-recovery-reader.mjs';
import {isNamespaceTestRiskPolicy,canonicalJson,NAMESPACE_TEST_RISK_SCHEMAS,namespaceTestRiskRecordProfile} from '../foundation/record-schema.mjs';
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {testRunCausePolicies} from '../kernel/test-run-cause.mjs';
import {testRunRiskRecordPolicies,namespaceTestRiskPlan,namespaceTestRiskState,namespaceTestRiskCoverage} from '../kernel/test-recovery.mjs';
import {testRunRiskAuthorities} from '../kernel/approval-fallback.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {standaloneDecisionAdmission} from '../kernel/decision-plan.mjs';
import {phaseRequiresCodeDelivery} from '../kernel/phase-policy.mjs';
import {sourceSnapshotChanges} from '../kernel/source-changes.mjs';
import {createNamespaceSourceObservations} from './namespace-source-observations.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {createNamespaceTestCommandOwners} from './namespace-test-command-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {memoNamespaceObservedDecision} from './namespace-story-reader.mjs';
import {namespaceSpecificationIdentity} from './namespace-specification-contract.mjs';
import {namespaceEvidencePolicyManifest} from './namespace-policy-contract.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex'),
  causes=testRunCausePolicies({toBytes:value=>Buffer.from(value)}),rules=testRunRiskRecordPolicies(causes),
  fail=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>{throw new SingularityFlowError(message,{code,details});},
  unique=values=>[...new Map(values.map(value=>[canonicalJson(value),value])).values()];
export const TEST_RISK_POLICY='test-risk/v1';
export const isTestRiskPolicy=isNamespaceTestRiskPolicy;
export const namespaceTestRiskManifest=(value,scope)=>namespaceEvidencePolicyManifest(value,{...scope,
  family:NAMESPACE_TEST_RISK_SCHEMAS.policy,format:namespaceTestRiskRecordProfile('policy',value).profile});
export function createNamespaceTestRiskOwner({observer,scope,workId}){
  const operation='decision.test-risk',commands=createNamespaceTestCommandOwners({observer,scope,workId}),
    checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),recovery=createNamespaceTestRecoveryOwner({observer,scope,workId});let readers;
  function phase(workflow,phaseId){const selected=workflow.phases[phaseId];
    if(!selected)fail('Name a phase of this Story.','TEST_RUN_RISK_INVALID');
    if(!phaseRequiresCodeDelivery(selected)&&selected.writeScope!=='artifact-only')fail('Bind the declared phase test-risk owner.','ENGINE_PORT_UNAVAILABLE',{required:['phase-test-risk']});
    return selected;
  }
  async function admitted(snapshot,options={}){
    const rows=snapshot.workflow.namespaceTestRunRisks??[],links=namespaceDecisionContract.receipts(snapshot.workflow).filter(row=>[operation,'test-risk.confirm-recovery'].includes(row.operation));
    if(!Array.isArray(rows)||rows.length!==links.length||rows.length>128)fail('The risk inventory lost its bounded original human receipts.');
    for(const row of rows){let profile;try{profile=namespaceTestRiskRecordProfile('record',row);}catch(cause){throw new SingularityFlowError(
      'The retained risk has an unsupported schema.',{code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',cause});}
      if(row.profile!==profile.profile)fail('The risk decision has another profile.');}
    const proofs=[];for(const link of links)proofs.push(await memoNamespaceObservedDecision(observer,{profile:'sflow-namespace-test-run-risk/v1',record:link.record},
      ()=>readers.get(link.operation).accepted(link,options),options));
    if(!same(rows,proofs.map(proof=>proof.value.outcome.record)))fail('The risk inventory differs from its original accepted decisions.');
    return proofs;
  }
  const owner={agentPhase:snapshot=>snapshot.workflow.currentPhase,
    async read(snapshot,request,options={}){
      const previous=await admitted(snapshot,options),selected=phase(snapshot.workflow,request.phaseId),version=snapshot.workflow.resolution.testRecovery?.enabled?3:phaseRequiresCodeDelivery(selected)?2:1,profile='sflow-namespace-test-run-risk/v'+version,references=previous.map(row=>row.reference);
      if(request.revoke){const target=previous.find(row=>row.value.outcome.record.id===request.revoke);
        if(!target)fail('This Story has no such test-run risk.','TEST_RUN_RISK_UNKNOWN');
        return {generation:selected.generation,identity:{profile:target.value.outcome.record.profile,revoke:target.reference},references};}
      const agreement=snapshot.workflow.resolution.testRecovery?.enabled?await recovery.current(snapshot,options):null;
      if(agreement&&(!snapshot.workflow.resolution.testRecovery.enabledRiskCategories.includes('validation-unavailable')
        ||request.expectedRecovery!==agreement.agreement.contextSha256))fail('Review and explicitly confirm this environment risk against its exact current recovery agreement.',
        'TEST_RECOVERY_RISK_CONFIRMATION_REQUIRED',{expectedRecovery:agreement.agreement.contextSha256,
          actions:[{operation:'test-risk.context',inputs:{workId,phaseId:request.phaseId}},{operation:'test-risk.confirm-recovery',inputs:{workId,phaseId:request.phaseId,expectedRecovery:agreement.agreement.contextSha256},requiredInputs:['operationId','commandId','argvSha256','causeClass','cause','reason','expires']}]});
      const renewal=previous.some(row=>{const record=row.value.outcome.record;return record.id&&record.phase===request.phaseId
        &&record.commandId===request.commandId&&record.argvSha256===request.argvSha256&&record.causeClass===request.causeClass;});
      if((snapshot.workflow.currentPhase!==request.phaseId||selected.status==='awaiting_approval')&&!renewal)fail(
        'Decide an environment risk in the active authoring phase before submitting its packet.','TEST_RUN_RISK_NOT_ELIGIBLE',{
          actions:[{operation:'phase.review',inputs:{workId,phaseId:request.phaseId}}]});
      const current=await commands.commands(snapshot,request.phaseId,options),command=current.commands.find(row=>row.id===request.commandId);
      if(!command||command.kind!=='test'||command.requirement!=='required'||!command.argv||request.argvSha256!==hash(command.argv))fail(
        'Review the exact configured or acknowledged test command and use its returned argument digest.','TEST_RUN_RISK_INVALID',{
          actions:[{operation:'test-risk.context',inputs:{workId,phaseId:request.phaseId}}]});
      return {generation:selected.generation,commandSha256:'sha256:'+hash(command),...(agreement?{recovery:{maximumDays:snapshot.workflow.resolution.testRecovery.maxRiskDays}}:{}),identity:{profile,...(agreement?{recovery:{agreementSha256:agreement.agreement.contextSha256,agreements:agreement.references}}:{}),
        commands:current.identity,command,argvSha256:hash(command.argv)},references:unique([...references,...current.references,...(agreement?.references??[])])};
    },
    authority(workflow,request,actor){
      if(workflow.resolution.presence)fail('A risk decision requires its configured person-presence evidence.','ENGINE_PORT_UNAVAILABLE',{required:['person-presence']});
      const groups=testRunRiskAuthorities(workflow,request.phaseId);
      if(!groups.length)fail('Configure the human group authorized to accept this test risk.','RISK_AUTHORITY_UNAVAILABLE');
      return requireApprovalAuthority(workflow.resolution.approvalAuthorities,{mode:'required',authorities:groups,requiredAuthorities:[],minimum:1},actor.identity).authorityGroup;
    },
    plan(workflow,request,facts,source){standaloneDecisionAdmission(operation,workflow);return namespaceTestRiskPlan(workflow,request,facts,source,rules);}
  };
  readers=new Map([operation,'test-risk.confirm-recovery'].map(operation=>[operation,createNamespaceRecordedMutationReader({observer,scope,workId,operation,owner,contract:namespaceDecisionContract})]));
  async function context(snapshot,phaseId,{signal,at}={}){
    phase(snapshot.workflow,phaseId);const proofs=await admitted(snapshot,{signal}),selected=await commands.commands(snapshot,phaseId,{signal}),agreement=snapshot.workflow.resolution.testRecovery?.enabled?await recovery.current(snapshot,{signal}):null;
    return {schemaVersion:agreement?3:phaseRequiresCodeDelivery(snapshot.workflow.phases[phaseId])?2:1,profile:'sflow-namespace-test-risk-context/v'+(agreement?3:phaseRequiresCodeDelivery(snapshot.workflow.phases[phaseId])?2:1),...(agreement?{expectedRecovery:agreement.agreement.contextSha256,recoveryAgreements:agreement.references}:{}),workId,phase:phaseId,revision:snapshot.revision,
      commands:selected.commands.filter(row=>row.kind==='test').map(command=>({command,commandSha256:'sha256:'+hash(command),argvSha256:hash(command.argv)})),
      decisions:proofs.filter(row=>row.value.phase===phaseId).map(row=>({record:row.value.outcome.record,reference:row.reference,
        state:row.value.outcome.record.revokes?'revocation':namespaceTestRiskState(snapshot.workflow,row.value.outcome.record,{at})})),
      environmentCauses:Object.keys(causes.TEST_RUN_CAUSES).filter(value=>causes.testRunCauseCategory(value)==='environment'),
      authorities:testRunRiskAuthorities(snapshot.workflow,phaseId),testsPassed:false,executionObserved:false};
  }
  async function candidate(publication,snapshot,{signal,at,checked,bound=null}={}){
    phase(snapshot.workflow,publication.phase);const agreement=snapshot.workflow.resolution.testRecovery?.enabled?await recovery.current(snapshot,{signal}):null;
    if(agreement&&!snapshot.workflow.resolution.testRecovery.enabledRiskCategories.includes('validation-unavailable'))fail('The pinned recovery policy does not enable environment-risk acceptance.','TEST_RUN_RISK_NOT_ELIGIBLE');
    if(!checked?.binding||!checked.found)fail('An actual retained failed check is required.','ENGINE_CHECK_EVIDENCE_REQUIRED');
    const proofs=await admitted(snapshot,{signal}),selected=await commands.commands(snapshot,publication.phase,{signal}),{found,binding}=checked,
      steps=found.plan.steps,records=proofs.map(proof=>({record:proof.value.outcome.record,reference:proof.reference})),rows=[],references=[...proofs.map(proof=>proof.reference),...selected.references,...(agreement?.references??[]),
        binding.result.content,found.body.plan,...found.plan.sources.map(row=>row.content)];
    if(agreement&&found.plan.recovery?.agreementSha256!==agreement.agreement.contextSha256)fail('The failed execution has another confirmed recovery agreement.','TEST_RUN_RISK_NOT_ELIGIBLE');
    if(found.plan.input.phaseId!==publication.phase||found.body.verdict==='passed'
      ||(found.plan.testCommands?!same(found.plan.testCommands,selected.identity):selected.identity.receipts.length!==0)
      ||!same(found.plan.sources.map(row=>({id:row.id,descriptor:row.descriptor})),(snapshot.workflow.sourceBindings?.current?.repositories??[]).map(row=>({id:row.id,descriptor:row.descriptor})))
      ||!same(steps.filter((_,index)=>index%found.plan.sources.length===0).map(row=>row.command),selected.commands))fail(
        'The risk observation differs from the exact current command inventory.','ENGINE_STORAGE_CORRUPT');
    const sourceReader=createNamespaceSourceObservations({observer,scope}),original=await sourceReader.binding(snapshot.workflow.sourceBindings.current.operationId,signal),changed=new Map();
    if(!same(original.selected,snapshot.workflow.sourceBindings.current))fail('The risk source selection differs from its original accepted binding.');
    for(const repository of found.plan.sources){
      const before=await sourceReader.baseline(original.selected.repositories.find(row=>row.id===repository.id),signal),
        after=await checks.snapshot(repository.content,repository.descriptor,signal),delta=sourceSnapshotChanges(before,after,repository.descriptor);
      changed.set(repository.id,[...new Set(delta.entries.flatMap(row=>[row.oldPath,row.newPath].filter(Boolean)))]);
    }
    for(const [index,step]of steps.entries()){
      const observed=found.body.checks[index],result=found.body.results[index];
      if(observed.status==='passed'){rows.push({taskId:step.contract.taskId,repositoryId:step.repositoryId,commandId:step.command.id,status:'passed',tests:observed.tests,decision:null,cause:null});continue;}
      const out=result.candidate?.output;
      if(step.command.kind!=='test'||!out||out.process.closed!==true||out.process.timedOut||out.process.overflow||out.process.signal!==null||out.diagnostics.length
        ||!['failed','blocked'].includes(observed.status)||!same(out.source.before.revision,out.source.after?.revision))fail(
          'This failure is not an intact, completed environment-only test observation. Repair and execute the current checks.','TEST_RUN_RISK_NOT_ELIGIBLE',{
            commandId:step.command.id,repositoryId:step.repositoryId,actions:[{operation:'phase.checks.run',inputs:{workId,phaseId:publication.phase},requiredInputs:['operationId']}]});
      const rawReports=[];for(const row of out.reports.raw){references.push(row.content);rawReports.push({contents:await observer.bytes(row.content,row.content.bytes,signal)});}
      references.push(out.stdout,out.stderr,out.source.before.content,out.source.after.content);
      const check={status:observed.status,exitCode:out.process.status,timedOut:out.process.timedOut,
        stdout:new TextDecoder().decode(await observer.bytes(out.stdout,out.stdout.bytes,signal)),stderr:new TextDecoder().decode(await observer.bytes(out.stderr,out.stderr.bytes,signal))},
        cause=causes.attemptRunCause({check,parsed:{rawReports},attempt:{adapter:out.reports.adapter,tests:observed.tests,occurrences:out.reports.parsed?.testcaseObservation?.occurrences??[]},delivery:{sourcePaths:changed.get(step.repositoryId)}}),
        original=bound?.observations.find(row=>row.taskId===step.contract.taskId)?.decision,
        decision=records.toReversed().find(row=>row.record.id&&(!agreement||namespaceTestRiskRecordProfile('record',row.record).recoveryRisk&&row.record.recovery?.agreementSha256===agreement.agreement.contextSha256)&&(!original||same(row,original))&&row.record.phase===publication.phase&&row.record.commandId===step.command.id
          &&row.record.argvSha256===hash(step.command.argv)&&row.record.commandSha256==='sha256:'+hash(step.command)&&row.record.causeClass===cause.class
          &&namespaceTestRiskCoverage(snapshot.workflow,row.record,{at}));
      if(cause.category!=='environment'||!decision)fail('This actual failed run has no active human decision for its exact environment cause.',cause.category==='environment'?'TEST_RUN_RISK_NOT_COVERED':'TEST_RUN_RISK_NOT_ELIGIBLE',{
        commandId:step.command.id,repositoryId:step.repositoryId,argvSha256:hash(step.command.argv),cause,
        actions:[...(cause.category==='environment'?[{operation:'test-risk.context',inputs:{workId,phaseId:publication.phase}},{operation:agreement?'test-risk.confirm-recovery':'decision.test-risk',inputs:{workId,phaseId:publication.phase,...(agreement?{expectedRecovery:agreement.agreement.contextSha256}:{}),
          commandId:step.command.id,argvSha256:hash(step.command.argv),causeClass:cause.class},requiredInputs:[...(agreement?['operationId']:[]),'cause','reason','expires'],prerequisites:['authenticated-human-phase-approver']}]:[]),
          {operation:'phase.checks.run',inputs:{workId,phaseId:publication.phase},requiredInputs:['operationId']}]});
      rows.push({taskId:step.contract.taskId,repositoryId:step.repositoryId,commandId:step.command.id,status:observed.status,tests:observed.tests,
        cause,decision:{record:decision.record,reference:decision.reference}});
    }
    if(!rows.some(row=>row.decision))fail('Passing checks do not need a test risk.','TEST_RUN_RISK_NOT_ELIGIBLE');
    const version=agreement?3:phaseRequiresCodeDelivery(snapshot.workflow.phases[publication.phase])?2:1;
    return {report:{schemaVersion:version,profile:'sflow-namespace-test-risk-policy/v'+version,...(agreement?{recovery:{agreementSha256:agreement.agreement.contextSha256,agreements:agreement.references}}:{}),workId,phaseId:publication.phase,checks:binding,commands:selected.identity,
      observations:rows,testsPassed:false,codeFailuresWaived:false,crossPhaseReuse:false,freshness:'same-draft-retained-run',sourceRechecked:true},references:unique(references.filter(row=>row.namespace==='evidence')),policy:{owners:['check-execution']}};
  }
  async function draftCandidate(value,snapshot,options={}){
    try{return await candidate(value,snapshot,options);}catch(cause){
      // A newly available recovery route does not change the pre-existing failure of an unamended phase.
      if(options.checkInput&&!(snapshot.workflow.namespaceTestRunRisks??[]).some(row=>row.id&&row.phase===value.phase)
        &&['TEST_RUN_RISK_NOT_COVERED','TEST_RUN_RISK_NOT_ELIGIBLE'].includes(cause.code)){
        try{await checks.forDraft(options.checkInput,{signal:options.signal});}catch(original){
          if(original.code==='PHASE_CHECKS_NOT_PASSED')original.details={...original.details,testRunRisk:{profile:'sflow-namespace-test-risk-handoff/v1',code:cause.code,...cause.details}};
          throw original;
        }
      }
      throw cause;
    }
  }
  async function publication(value,snapshot,{signal,at,bound=null}={}){
    const found=await checks.publicationObservation({...value,checks:value.riskChecks}, {signal});
    return candidate(value,snapshot,{signal,at,bound,checked:{binding:value.riskChecks,found}});
  }
  async function forPublication(value,snapshot,{signal}={}){
    const binding=value.policyEvidence?.find(row=>isTestRiskPolicy(row.kind));if(!binding)return null;
    const json=async reference=>{const bytes=await observer.bytes(reference,reference.bytes,signal);
      try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch(cause){throw new SingularityFlowError(
        'The retained test-risk evidence is not UTF-8 JSON.',{code:'ENGINE_STORAGE_CORRUPT',cause});}},
      manifest=namespaceTestRiskManifest(await json(binding.record),{scope,workId,phaseId:value.phase}),report=await json(manifest.report),
      version=namespaceTestRiskRecordProfile('report',report).version;
    if(binding.kind!=='test-risk/v'+version||version!==manifest.schemaVersion||value.checks
      ||manifest.recordedAt!==value.publishedAt||!same(manifest.artifact,{key:value.artifact.sourceKey,content:value.artifact.content})
      ||!same(namespaceSpecificationIdentity(value),Object.fromEntries(Object.keys(namespaceSpecificationIdentity(value)).map(key=>[key,manifest[key]]))))fail('The failed test evidence has another publication binding.');
    const original=await observer.state(await observer.bytes(manifest.basis.head.state,manifest.basis.head.state.bytes,signal),manifest.basis.head,{signal}),
      basis={revision:manifest.basis.revision,configuration:manifest.basis.head.configuration,workflow:original.workflow},
      proof=await publication({...value,riskChecks:report.checks},basis,{signal,at:value.publishedAt});
    if(!same(report,proof.report))fail('The failed test evidence differs from its actual execution and original human decisions.');
    return {found:await checks.publicationObservation({...value,checks:report.checks},{signal}),report,binding:report.checks};
  }
  async function fresh(value,snapshot,units,{signal,at,bound=null}={}){
    await checks.freshObservedSources(value.riskChecks,value.phase,units,{signal});
    return publication(value,snapshot,{signal,at,bound});
  }
  return Object.freeze({owner,reader:readers.get(operation),admitted,context,candidate,draftCandidate,publication,forPublication,fresh,readBindings:checks.readBindings});
}
