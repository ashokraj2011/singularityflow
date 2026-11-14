/** Observed-suite baselines and human cohort receipts. No execution, checkout discovery or test-success flags. */
import {isNamespaceTestRiskPolicy,namespaceTestRiskRecordProfile,canonicalJson,namespaceTestCohortRecordProfile,NAMESPACE_TEST_COHORT_SCHEMAS} from '../foundation/record-schema.mjs';
import {createNamespaceTestRiskOwner} from './namespace-test-risk-reader.mjs';
import {createNamespaceEvidenceReuseOwner} from './namespace-evidence-reuse-reader.mjs';
import {createNamespaceSelectiveTestRecoveryOwner} from './namespace-selective-test-recovery-reader.mjs';
import {createNamespaceTestRecoveryOwner} from './namespace-test-recovery-reader.mjs';
import {createNamespaceTestCommandOwners} from './namespace-test-command-reader.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {namespaceTestCohortPolicies,namespaceTestCohortReviewInput} from '../kernel/test-recovery.mjs';
import {configurationFilePolicies} from '../kernel/source-path-policies.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../engine-compatibility/node-configuration-path.mjs';
import {testRunRiskAuthorities} from '../kernel/approval-fallback.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {standaloneDecisionAdmission} from '../kernel/decision-plan.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {memoNamespaceObservedDecision} from './namespace-story-reader.mjs';
import {namespaceEvidencePolicyManifest} from './namespace-policy-contract.mjs';
import {qualifiedCheckReportLocation} from '../sgos/node-execution-values.mjs';
const operation='test-cohort.confirm',same=(a,b)=>canonicalJson(a)===canonicalJson(b),rules=namespaceTestCohortPolicies(NODE_TEXT_DIGESTS),
  configuration=configurationFilePolicies(NODE_CONFIGURATION_PATH_SYNTAX),
  fail=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>{throw new SingularityFlowError(message,{code,details});},
  unique=rows=>[...new Map(rows.map(row=>[canonicalJson(row),row])).values()];
export const TEST_COHORT_POLICY='test-cohort/v1';
export const namespaceTestCohortManifest=(value,scope)=>namespaceEvidencePolicyManifest(value,{...scope,
  family:NAMESPACE_TEST_COHORT_SCHEMAS.policy,format:'sflow-namespace-test-cohort-policy-manifest/v'+value.schemaVersion});
export function createNamespaceTestCohortOwner({observer,scope,workId}){
  const checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),commands=createNamespaceTestCommandOwners({observer,scope,workId});let reader;
  async function admitted(snapshot,options={}){
    const rows=snapshot.workflow.namespaceTestCohorts??[],links=namespaceDecisionContract.receipts(snapshot.workflow).filter(row=>row.operation===operation);
    if(!Array.isArray(rows)||rows.length!==links.length||rows.length>128)fail('The cohort inventory lost its original bounded human receipts.');
    for(const row of rows)if(row.profile!==namespaceTestCohortRecordProfile('decision',row).profile)fail('The cohort decision has another profile.');
    const proofs=[];for(const link of links)proofs.push(await memoNamespaceObservedDecision(observer,{profile:'sflow-namespace-test-cohort-proof/v1',record:link.record},
      ()=>reader.consumed(link,options),options));
    if(!same(rows,proofs.map(row=>row.value.outcome.record)))fail('The cohort inventory differs from its original conditional receipts.');return proofs;
  }
  function binding(found){const key=checks.codec.indexKey(found.plan);return {schemaVersion:1,format:'sflow-namespace-phase-check-evidence-binding/v1',
    operationId:found.plan.input.operationId,result:found.record,index:{key,version:found.receipt.records.find(row=>row.key===key).version}};}
  async function observed(found,{signal,executionRisk=null,caseInventory=[]}={}){
    const rows=[],references=[found.record.content,found.body.plan,...found.plan.sources.map(row=>row.content)];
    if(found.body.verdict!=='passed'&&!executionRisk)fail('Cohort selection needs an actual completed passing execution; a failure uses its repair or risk owner.','TEST_COHORT_EXECUTION_REQUIRED');
    for(const [index,step]of found.plan.steps.entries()){
      if(step.command.kind!=='test')continue;
      const result=found.body.results[index],out=result.candidate?.output,check=found.body.checks[index],source=found.plan.sources.find(row=>row.id===step.repositoryId),
        snapshot=await checks.snapshot(source.content,source.descriptor,signal),
        config=snapshot.entries.filter(row=>configuration.isConfigurationPath(row.path)),
        selected=found.plan.selection?.rows.find(row=>row.repositoryId===step.repositoryId&&row.commandId===step.command.id),
        declared=selected?.declaration??caseInventory.find(row=>row.commandId===step.command.id),
        occurrences=(out?.reports.parsed?.testcaseObservation?.occurrences??[]).map(row=>{
          if(!declared)return row;
          const matches=declared.tests.filter(test=>test.name===row.name),file=row.file==null&&matches.length===1?matches[0].path
            :qualifiedCheckReportLocation(row.file,step.manifest.toolPolicy.environmentQualification?.reportRoot);
          return {...row,file,ancestorTitles:row.ancestorTitles??[row.className??row.suite??'JUnit'],framework:row.framework??'junit'};}),cases=rules.cases(check.tests,occurrences),
        runtime=selected?{...step.manifest.toolPolicy.command,argumentsSha256:step.manifest.toolPolicy.selection.originalArgumentsSha256}:step.manifest.toolPolicy.command;
      references.push(out.stdout,out.stderr,...out.reports.raw.map(row=>row.content),out.source.before.content,out.source.after.content);
      rows.push({repositoryId:step.repositoryId,commandId:step.command.id,
        pinSha256:rules.hash({command:step.command,runtime,configuration:config}),cases});
    }
    if(!rows.length)fail('Select an execution with structured test observations.','TEST_COHORT_EXECUTION_REQUIRED');
    return {rows,references:unique(references.filter(row=>row.namespace==='evidence'))};
  }
  async function context(snapshot,request,options={}){
    const target=snapshot.workflow.phases[request.phaseId];
    if(target&&(snapshot.workflow.currentPhase!==request.phaseId||['approved','awaiting_approval'].includes(target.status))){
      const prior=(await admitted(snapshot,options)).toReversed().find(row=>{const record=row.value.outcome.record,context=record.context;
        return record.id&&record.phase===request.phaseId&&namespaceTestCohortRecordProfile('decision',record).executionBinding&&context.baseline.checks.operationId===request.baselineOperationId
          &&context.baseline.phase===(request.baselinePhaseId??request.phaseId)&&context.observed.operationId===request.observedOperationId
          &&(request.observedPhaseId==null||context.execution.phase===request.observedPhaseId)&&(request.candidateGeneration==null||context.generation===request.candidateGeneration);});
      if(prior){const record=prior.value.outcome.record;return {context:{value:record.context,sha256:record.contextSha256},generation:record.generation,renewal:true,
        references:unique([...prior.source.references,prior.reference])};}
    }
    const baseline=await checks.accepted({operationId:request.baselineOperationId,workId,phaseId:request.baselinePhaseId??request.phaseId},options),
      current=await checks.accepted({operationId:request.observedOperationId,workId,phaseId:request.observedPhaseId??request.phaseId},options);
    if(!baseline||!current)fail('Name actual retained baseline and candidate check operations.','ENGINE_CHECK_EVIDENCE_REQUIRED');
    const phase=snapshot.workflow.phases[request.phaseId],generation=request.candidateGeneration??current.plan.generation;
    if(!phase||snapshot.workflow.phaseOrder.indexOf(current.plan.input.phaseId)>snapshot.workflow.phaseOrder.indexOf(request.phaseId)
      ||!Number.isSafeInteger(generation)||generation<1||request.candidateGeneration!=null&&generation>phase.generation+1)fail('Name the actual current or next generation and an existing execution owner.','TEST_COHORT_INVALID');
    if(!same(baseline.plan.basis.configuration,snapshot.configuration)||!same(current.plan.basis.configuration,snapshot.configuration)
      ||!same(baseline.plan.sources.map(row=>({id:row.id,descriptor:row.descriptor})),current.plan.sources.map(row=>({id:row.id,descriptor:row.descriptor}))))fail(
        'The baseline and candidate need the same approved configuration and repository selection.','TEST_COHORT_PIN_CHANGED');
    const selected=await commands.commands(snapshot,request.phaseId,options);
    if(!same(current.plan.sources.map(row=>({id:row.id,descriptor:row.descriptor})),
      (snapshot.workflow.sourceBindings?.current?.repositories??[]).map(row=>({id:row.id,descriptor:row.descriptor})))
      ||!same(current.plan.steps.filter((_,index)=>index%current.plan.sources.length===0).map(row=>row.command),selected.commands)
      ||(current.plan.testCommands?!same(current.plan.testCommands,selected.identity):selected.identity.receipts.length!==0))
      fail('The observed run must use the current acknowledged commands and bound repositories.','TEST_COHORT_PIN_CHANGED');
    const policy=snapshot.workflow.resolution.testRecovery,agreement=policy?.enabled?await createNamespaceTestRecoveryOwner({observer,scope,workId}).current(snapshot,options):null;
    if(agreement&&!policy.enabledRiskCategories.includes('reduced-coverage'))fail('The confirmed recovery policy does not enable observed scope decisions. Run the complete configured checks.','TEST_COHORT_NOT_ELIGIBLE');
    let risk=null;
    if(current.body.verdict!=='passed')risk=await createNamespaceTestRiskOwner({observer,scope,workId}).candidate({phase:request.phaseId},snapshot,{signal:options.signal,at:options.at??current.body.recordedAt,checked:{binding:binding(current),found:current}});
    if(current.plan.selection)await createNamespaceSelectiveTestRecoveryOwner({observer,scope,workId}).permission(snapshot,current.plan.selection,{...options,at:options.at??current.body.recordedAt});
    const failedBaseline=baseline.body.verdict!=='passed';
    if(failedBaseline&&(!risk||!namespaceTestRiskRecordProfile('report',risk.report).knownFailure||!same(risk.report.baseline,binding(baseline))))fail('A failed cohort baseline needs its original authenticated known-failure comparison.','TEST_COHORT_EXECUTION_REQUIRED');
    const observedOptions={...options,caseInventory:policy?.caseInventory?.filter(row=>row.phaseId===request.phaseId)??[]},
      before=await observed(baseline,{...observedOptions,...(failedBaseline?{executionRisk:risk.report}: {})}),after=await observed(current,{...observedOptions,executionRisk:risk?.report}),selection=rules.compare(before.rows,after.rows,{retainFailures:failedBaseline}),
      version=risk||agreement||current.plan.selection||request.observedPhaseId!=null||request.candidateGeneration!=null?2:1,
      value={schemaVersion:version,profile:'sflow-namespace-test-cohort-context/v'+version,workId,phase:request.phaseId,generation,
        ...(version===2?{execution:{phase:current.plan.input.phaseId,generation:current.plan.generation,verdict:current.body.verdict,receiverExecuted:false,
          selection:current.plan.selection?.record.contextSha256??null,recovery:agreement?.agreement.contextSha256??null,failedBaseline}}:{}),
        baseline:{phase:baseline.plan.input.phaseId,checks:binding(baseline)},observed:binding(current),selection,
        baselineRows:before.rows,observedRows:after.rows,identityAssurance:'report-occurrences',newExecutionClaimed:false};
    if(new TextEncoder().encode(canonicalJson(value)).byteLength>2_097_152)fail('The observed cohort exceeds its bounded human review packet.','ENGINE_STORAGE_LIMIT');
    return {context:{value,sha256:rules.hash(value)},references:unique([...before.references,...after.references,...selected.references]),generation};
  }
  const owner={agentPhase:snapshot=>snapshot.workflow.currentPhase,
    async read(snapshot,request,options={}){
      const prior=await admitted(snapshot,options),phase=snapshot.workflow.phases[request.phaseId];
      if(!phase)fail('Name a phase of the bound Story.','TEST_COHORT_INVALID');
      if(request.revoke){const target=prior.find(row=>row.value.outcome.record.id===request.revoke);if(!target)fail('This Story has no such cohort decision.','TEST_COHORT_UNKNOWN');
        return {generation:phase.generation,identity:{profile:'sflow-namespace-test-cohort-source/v1',revoke:target.reference},references:prior.map(row=>row.reference)};}
      const source=await context(snapshot,request,options),sameSelection=prior.some(row=>row.value.outcome.record.id
        &&row.value.outcome.record.contextSha256===source.context.sha256);
      if((phase.status==='awaiting_approval'||snapshot.workflow.currentPhase!==phase.id)&&!sameSelection)fail(
        'Changing test scope during a submitted review needs a reviewed return; an exact renewal may stay in the active phase.','TEST_COHORT_DURING_REVIEW');
      return {...source,identity:{profile:'sflow-namespace-test-cohort-source/v'+source.context.value.schemaVersion,contextSha256:source.context.sha256},
        references:unique([...source.references,...prior.map(row=>row.reference)])};
    },
    authority(workflow,request,actor){
      if(workflow.resolution.presence)fail('Supply the configured original person-presence evidence.','ENGINE_PORT_UNAVAILABLE',{required:['person-presence']});
      const groups=testRunRiskAuthorities(workflow,request.phaseId);if(!groups.length)fail('Configure the phase cohort review authority.','RISK_AUTHORITY_UNAVAILABLE');
      return requireApprovalAuthority(workflow.resolution.approvalAuthorities,{mode:'required',authorities:groups,requiredAuthorities:[],minimum:1},actor.identity).authorityGroup;
    },
    async assertNew(snapshot,request,source,options){if(request.revoke)return;const prior=await admitted(snapshot,options),rows=prior.map(row=>row.value.outcome.record);
      if(rows.some(row=>row.id&&row.contextSha256===source.context.sha256&&rules.state(rows,row,options.at)==='active'))fail(
        'This exact observed cohort is already confirmed. Use its retained receipt.','TEST_COHORT_ALREADY_CONFIRMED');},
    plan(workflow,request,facts,source){standaloneDecisionAdmission(operation,workflow);return rules.confirm(workflow,request,facts,source);}
  };
  reader=createNamespaceRecordedMutationReader({observer,scope,workId,operation,owner,contract:namespaceDecisionContract});
  async function candidate(publication,snapshot,{signal,at,bound=null,checked=null,riskChecks=null,reused=null}={}){
    const proofs=await admitted(snapshot,{signal}),rows=proofs.map(row=>row.value.outcome.record),original=bound
      ?proofs.find(row=>same(row.reference,bound.decision.reference)):proofs.filter(row=>row.value.outcome.record.id&&row.value.phase===publication.phase).at(-1);
    if(!original)return null;
    const record=original.value.outcome.record;
    if(record.generation!==publication.generation)fail('Review the actual cohort for this successor generation.','TEST_COHORT_CONTEXT_CHANGED',{
      actions:[{operation:'test-cohort.context',inputs:{workId,...namespaceTestCohortReviewInput(record),candidateGeneration:publication.generation},requiredInputs:['observedOperationId']}]});
    let risk=null;
    if(publication.policyEvidence?.some(row=>isNamespaceTestRiskPolicy(row.kind)&&row.kind!=='test-risk/v1'))risk=await createNamespaceTestRiskOwner({observer,scope,workId}).forPublication(publication,snapshot,{signal});
    else if(riskChecks){const found=await checks.proof(riskChecks,publication.phase,{signal}),observedRisk=await createNamespaceTestRiskOwner({observer,scope,workId}).candidate(publication,snapshot,{signal,at,checked:{binding:riskChecks,found}});
      risk={found,binding:riskChecks,report:observedRisk.report};}
    if(publication.policyEvidence?.some(row=>['evidence-reuse/v3','evidence-reuse/v4'].includes(row.kind)))reused=await createNamespaceEvidenceReuseOwner({observer,scope,workId}).forPublication(publication,{signal});
    else if(reused?.report)reused={...reused,...await createNamespaceEvidenceReuseOwner({observer,scope,workId}).execution(reused.report,{signal})};
    const binding=checked?.binding??publication.checks??risk?.binding??reused?.checks;
    if(!binding)fail('An accepted cohort never replaces a fresh test execution.','ENGINE_CHECK_EVIDENCE_REQUIRED');
    const found=reused?.found??await checks.publicationObservation({...publication,checks:binding},{signal}),actual=await observed(found,{signal,executionRisk:risk?.report,
      caseInventory:namespaceTestCohortRecordProfile('decision',record).executionBinding?snapshot.workflow.resolution.testRecovery?.caseInventory?.filter(row=>row.phaseId===publication.phase)??[]:[]});
    if(found.plan.selection)await createNamespaceSelectiveTestRecoveryOwner({observer,scope,workId}).permission(snapshot,found.plan.selection,{signal,at});
    const baseline=record.context.baselineRows,selection=rules.compare(baseline,actual.rows,{retainFailures:record.context.execution?.failedBaseline===true}),
      latest=proofs.filter(row=>row.value.outcome.record.id&&row.value.outcome.record.selectionSha256===record.selectionSha256).at(-1),
      active=latest&&rules.state(rows,latest.value.outcome.record,at)==='active',
      coverage=selection.every(row=>{
        const selected=record.context.selection.find(item=>item.repositoryId===row.repositoryId&&item.commandId===row.commandId),executed=new Set(row.selectedIds);
        return (active?selected.selectedIds:row.baselineIds).every(id=>executed.has(id));
      });
    if(!coverage)fail('The actual run omits a required baseline or human-selected test. Run it or review the exact changed cohort.','TEST_COHORT_NOT_COVERED',{
      decision:record.id,state:active?'active':latest?rules.state(rows,latest.value.outcome.record,at):'missing',
      actions:[{operation:'phase.checks.run',inputs:{workId,phaseId:publication.phase},requiredInputs:['operationId']},
        {operation:'test-cohort.context',inputs:{workId,...namespaceTestCohortReviewInput(record)}}]});
    const version=reused||namespaceTestCohortRecordProfile('decision',record).executionBinding?3:risk?2:1;
    return {report:{schemaVersion:version,profile:'sflow-namespace-test-cohort-policy/v'+version,...(risk?{executionRisk:publication.policyEvidence?.find(row=>isNamespaceTestRiskPolicy(row.kind)&&row.kind!=='test-risk/v1')??null,testsPassed:false}:{}),
      ...(version===3?{reuse:reused?{policy:reused.binding??null,report:reused.manifest?.report??null,receiverExecuted:false}:null}:{}),workId,phaseId:publication.phase,checks:binding,
      decision:{record,reference:original.reference},selection,scope:'observed-baseline',testsReused:Boolean(reused),
      disposition:active?'confirmed-cohort':'restored-baseline'},references:unique([...actual.references,...proofs.flatMap(row=>[row.reference,...row.source.references])]),policy:{owners:['test-cohort']}};
  }
  return Object.freeze({owner,reader,admitted,context,candidate,checks,rules});
}
