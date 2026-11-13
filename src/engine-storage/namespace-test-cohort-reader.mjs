/** Observed-suite baselines and human cohort receipts. No execution, checkout discovery or test-success flags. */
import {isNamespaceTestRiskPolicy,canonicalJson,admitRecordSchemaVersion,NAMESPACE_TEST_COHORT_SCHEMAS} from '../foundation/record-schema.mjs';
import {createNamespaceTestRiskOwner} from './namespace-test-risk-reader.mjs';
import {createNamespaceTestCommandOwners} from './namespace-test-command-reader.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {namespaceTestCohortPolicies} from '../kernel/test-recovery.mjs';
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
    for(const row of rows){admitRecordSchemaVersion(NAMESPACE_TEST_COHORT_SCHEMAS.decision,row);
      if(row.profile!=='sflow-namespace-test-cohort-decision/v1')fail('The cohort decision has another profile.');}
    const proofs=[];for(const link of links)proofs.push(await memoNamespaceObservedDecision(observer,{profile:'sflow-namespace-test-cohort-proof/v1',record:link.record},
      ()=>reader.accepted(link,options),options));
    if(!same(rows,proofs.map(row=>row.value.outcome.record)))fail('The cohort inventory differs from its original conditional receipts.');return proofs;
  }
  function binding(found){const key=checks.codec.indexKey(found.plan);return {schemaVersion:1,format:'sflow-namespace-phase-check-evidence-binding/v1',
    operationId:found.plan.input.operationId,result:found.record,index:{key,version:found.receipt.records.find(row=>row.key===key).version}};}
  async function observed(found,{signal,executionRisk=null}={}){
    const rows=[],references=[found.record.content,found.body.plan,...found.plan.sources.map(row=>row.content)];
    if(found.body.verdict!=='passed'&&!executionRisk)fail('Cohort selection needs an actual completed passing execution; a failure uses its repair or risk owner.','TEST_COHORT_EXECUTION_REQUIRED');
    for(const [index,step]of found.plan.steps.entries()){
      if(step.command.kind!=='test')continue;
      const result=found.body.results[index],out=result.candidate?.output,check=found.body.checks[index],source=found.plan.sources.find(row=>row.id===step.repositoryId),
        snapshot=await checks.snapshot(source.content,source.descriptor,signal),
        config=snapshot.entries.filter(row=>configuration.isConfigurationPath(row.path)),
        cases=rules.cases(check.tests,out?.reports.parsed?.testcaseObservation?.occurrences);
      references.push(out.stdout,out.stderr,...out.reports.raw.map(row=>row.content),out.source.before.content,out.source.after.content);
      rows.push({repositoryId:step.repositoryId,commandId:step.command.id,
        pinSha256:rules.hash({command:step.command,runtime:step.manifest.toolPolicy.command,configuration:config}),cases});
    }
    if(!rows.length)fail('Select an execution with structured test observations.','TEST_COHORT_EXECUTION_REQUIRED');
    return {rows,references:unique(references.filter(row=>row.namespace==='evidence'))};
  }
  async function context(snapshot,request,options={}){
    const baseline=await checks.accepted({operationId:request.baselineOperationId,workId,phaseId:request.baselinePhaseId??request.phaseId},options),
      current=await checks.accepted({operationId:request.observedOperationId,workId,phaseId:request.phaseId},options);
    if(!baseline||!current)fail('Name actual retained baseline and candidate check operations.','ENGINE_CHECK_EVIDENCE_REQUIRED');
    if(!same(baseline.plan.basis.configuration,snapshot.configuration)||!same(current.plan.basis.configuration,snapshot.configuration)
      ||!same(baseline.plan.sources.map(row=>({id:row.id,descriptor:row.descriptor})),current.plan.sources.map(row=>({id:row.id,descriptor:row.descriptor}))))fail(
        'The baseline and candidate need the same approved configuration and repository selection.','TEST_COHORT_PIN_CHANGED');
    const selected=await commands.commands(snapshot,request.phaseId,options);
    if(!same(current.plan.sources.map(row=>({id:row.id,descriptor:row.descriptor})),
      (snapshot.workflow.sourceBindings?.current?.repositories??[]).map(row=>({id:row.id,descriptor:row.descriptor})))
      ||!same(current.plan.steps.filter((_,index)=>index%current.plan.sources.length===0).map(row=>row.command),selected.commands)
      ||(current.plan.testCommands?!same(current.plan.testCommands,selected.identity):selected.identity.receipts.length!==0))
      fail('The observed run must use the current acknowledged commands and bound repositories.','TEST_COHORT_PIN_CHANGED');
    const before=await observed(baseline,options),after=await observed(current,options),selection=rules.compare(before.rows,after.rows),
      value={schemaVersion:1,profile:'sflow-namespace-test-cohort-context/v1',workId,phase:request.phaseId,generation:current.plan.generation,
        baseline:{phase:baseline.plan.input.phaseId,checks:binding(baseline)},observed:binding(current),selection,
        baselineRows:before.rows,observedRows:after.rows,identityAssurance:'report-occurrences',newExecutionClaimed:false};
    if(new TextEncoder().encode(canonicalJson(value)).byteLength>2_097_152)fail('The observed cohort exceeds its bounded human review packet.','ENGINE_STORAGE_LIMIT');
    return {context:{value,sha256:rules.hash(value)},references:unique([...before.references,...after.references,...selected.references]),generation:current.plan.generation};
  }
  const owner={agentPhase:snapshot=>snapshot.workflow.currentPhase,
    async read(snapshot,request,options={}){
      const prior=await admitted(snapshot,options),phase=snapshot.workflow.phases[request.phaseId];
      if(!phase)fail('Name a phase of the bound Story.','TEST_COHORT_INVALID');
      if(snapshot.workflow.resolution.testRecovery?.enabled)fail('This full-command agreement needs a separate selective-recovery owner before cohort selection.','ENGINE_PORT_UNAVAILABLE',{required:['selective-test-recovery']});
      if(request.revoke){const target=prior.find(row=>row.value.outcome.record.id===request.revoke);if(!target)fail('This Story has no such cohort decision.','TEST_COHORT_UNKNOWN');
        return {generation:phase.generation,identity:{profile:'sflow-namespace-test-cohort-source/v1',revoke:target.reference},references:prior.map(row=>row.reference)};}
      const source=await context(snapshot,request,options),sameSelection=prior.some(row=>row.value.outcome.record.id
        &&row.value.outcome.record.contextSha256===source.context.sha256);
      if((phase.status==='awaiting_approval'||snapshot.workflow.currentPhase!==phase.id)&&!sameSelection)fail(
        'Changing test scope during a submitted review needs a reviewed return; an exact renewal may stay in the active phase.','TEST_COHORT_DURING_REVIEW');
      return {...source,identity:{profile:'sflow-namespace-test-cohort-source/v1',contextSha256:source.context.sha256},
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
  async function candidate(publication,snapshot,{signal,at,bound=null,checked=null,riskChecks=null}={}){
    const proofs=await admitted(snapshot,{signal}),rows=proofs.map(row=>row.value.outcome.record),original=bound
      ?proofs.find(row=>same(row.reference,bound.decision.reference)):proofs.filter(row=>row.value.outcome.record.id&&row.value.phase===publication.phase).at(-1);
    if(!original)return null;
    const record=original.value.outcome.record;
    if(record.generation!==publication.generation)fail('Review the actual cohort for this successor generation.','TEST_COHORT_CONTEXT_CHANGED',{
      actions:[{operation:'test-cohort.context',inputs:{workId,phaseId:publication.phase,baselineOperationId:record.context.baseline.checks.operationId,
        baselinePhaseId:record.context.baseline.phase},requiredInputs:['observedOperationId']}]});
    let risk=null;
    if(publication.policyEvidence?.some(row=>isNamespaceTestRiskPolicy(row.kind)&&row.kind!=='test-risk/v1'))risk=await createNamespaceTestRiskOwner({observer,scope,workId}).forPublication(publication,snapshot,{signal});
    else if(riskChecks){const found=await checks.proof(riskChecks,publication.phase,{signal}),observedRisk=await createNamespaceTestRiskOwner({observer,scope,workId}).candidate(publication,snapshot,{signal,at,checked:{binding:riskChecks,found}});
      risk={found,binding:riskChecks,report:observedRisk.report};}
    const binding=checked?.binding??publication.checks??risk?.binding;
    if(!binding)fail('An accepted cohort never replaces a fresh test execution.','ENGINE_CHECK_EVIDENCE_REQUIRED');
    const found=await checks.publicationObservation({...publication,checks:binding},{signal}),actual=await observed(found,{signal,executionRisk:risk?.report});
    const baseline=record.context.baselineRows,selection=rules.compare(baseline,actual.rows),
      latest=proofs.filter(row=>row.value.outcome.record.id&&row.value.outcome.record.selectionSha256===record.selectionSha256).at(-1),
      active=latest&&rules.state(rows,latest.value.outcome.record,at)==='active',
      coverage=selection.every(row=>{
        const selected=record.context.selection.find(item=>item.repositoryId===row.repositoryId&&item.commandId===row.commandId),executed=new Set(row.selectedIds);
        return (active?selected.selectedIds:row.baselineIds).every(id=>executed.has(id));
      });
    if(!coverage)fail('The actual run omits a required baseline or human-selected test. Run it or review the exact changed cohort.','TEST_COHORT_NOT_COVERED',{
      decision:record.id,state:active?'active':latest?rules.state(rows,latest.value.outcome.record,at):'missing',
      actions:[{operation:'phase.checks.run',inputs:{workId,phaseId:publication.phase},requiredInputs:['operationId']},
        {operation:'test-cohort.context',inputs:{workId,phaseId:publication.phase,baselinePhaseId:record.context.baseline.phase,
          baselineOperationId:record.context.baseline.checks.operationId,observedOperationId:found.plan.input.operationId}}]});
    return {report:{schemaVersion:risk?2:1,profile:'sflow-namespace-test-cohort-policy/v'+(risk?2:1),...(risk?{executionRisk:publication.policyEvidence?.find(row=>isNamespaceTestRiskPolicy(row.kind)&&row.kind!=='test-risk/v1')??null,testsPassed:false}:{}),workId,phaseId:publication.phase,checks:binding,
      decision:{record,reference:original.reference},selection,scope:'observed-baseline',testsReused:false,
      disposition:active?'confirmed-cohort':'restored-baseline'},references:unique([...actual.references,...proofs.flatMap(row=>[row.reference,...row.source.references])]),policy:{owners:['test-cohort']}};
  }
  return Object.freeze({owner,reader,admitted,context,candidate,checks,rules});
}
