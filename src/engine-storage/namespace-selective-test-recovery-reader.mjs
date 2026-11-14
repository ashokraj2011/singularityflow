/** Independent full baselines, reviewed whole-file selection and current qualified execution. */
import {canonicalJson,admitRecordSchemaVersion,NAMESPACE_SELECTIVE_TEST_RECOVERY_SCHEMA} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {sourceSnapshot,validateSourceUnit} from '../foundation/source-snapshot.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {namespaceSelectiveTestRecoveryPolicies} from '../kernel/test-recovery.mjs';
import {namespaceReuseEnvironment} from '../kernel/evidence-reuse.mjs';
import {plannedClaimAllocatedTo} from '../kernel/specification-policy.mjs';
import {testRunRiskAuthorities} from '../kernel/approval-fallback.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {repositoryPlanTestLocation} from '../engine-compatibility/node-repository-plan.mjs';
import {createNamespaceTestCommandOwners} from './namespace-test-command-reader.mjs';
import {createNamespaceTestRecoveryOwner} from './namespace-test-recovery-reader.mjs';
import {createNamespaceKnownTestRiskOwner} from './namespace-known-test-risk-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceSourceObservations} from './namespace-source-observations.mjs';
import {createNamespaceSpecificationReader} from './namespace-specifications.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {memoNamespaceObservedDecision} from './namespace-story-reader.mjs';
const operation='test-recovery.select-confirm',rules=namespaceSelectiveTestRecoveryPolicies(NODE_TEXT_DIGESTS),
  same=(a,b)=>canonicalJson(a)===canonicalJson(b),unique=rows=>[...new Map(rows.map(row=>[canonicalJson(row),row])).values()],
  fail=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>{throw new SingularityFlowError(message,{code,details});};
export function createNamespaceSelectiveTestRecoveryOwner({observer,scope,workId,sources=[],checks:executors}){
  const checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer,checks:executors}),
    commands=createNamespaceTestCommandOwners({observer,scope,workId}),recovery=createNamespaceTestRecoveryOwner({observer,scope,workId}),
    known=createNamespaceKnownTestRiskOwner({observer,scope,workId}),origin=createNamespaceSourceObservations({observer,scope});let reader;
  const binding=found=>{const key=checks.codec.indexKey(found.plan);return {schemaVersion:1,format:'sflow-namespace-phase-check-evidence-binding/v1',operationId:found.plan.input.operationId,
    result:found.record,index:{key,version:found.receipt.records.find(row=>row.key===key).version}};};
  async function admitted(snapshot,options={}){
    const rows=snapshot.workflow.namespaceSelectiveTestRecoveries??[],links=namespaceDecisionContract.receipts(snapshot.workflow).filter(row=>row.operation===operation);
    if(!Array.isArray(rows)||rows.length!==links.length||rows.length>128)fail('Selective recovery lost its original bounded human receipts.');
    for(const row of rows){admitRecordSchemaVersion(NAMESPACE_SELECTIVE_TEST_RECOVERY_SCHEMA,row);if(row.profile!=='sflow-namespace-selective-test-recovery/v1')fail('Another selective recovery profile.');}
    const proofs=[];for(const link of links)proofs.push(await memoNamespaceObservedDecision(observer,{profile:'sflow-selective-test-recovery-proof/v1',record:link.record},()=>reader.accepted(link,options),options));
    if(!same(rows,proofs.map(row=>row.value.outcome.record)))fail('Selective recovery differs from its accepted human records.');return proofs;
  }
  async function sourceRows(snapshot,{signal,bound=null}={}){
    const repositories=snapshot.workflow.sourceBindings?.current?.repositories??[],units=new Map(sources.map(unit=>[validateSourceUnit(unit).repositoryId,unit])),rows=[],pendingEvidence=[];
    if(!repositories.length||bound!==null&&(!Array.isArray(bound)||bound.length!==repositories.length))fail('Selective recovery requires the exact bound repository inventory.');
    for(const [index,repository]of repositories.entries()){
      let observed,reference;
      if(bound!==null){const row=bound[index];if(row.repositoryId!==repository.id||!same(row.descriptor,repository.descriptor))fail('Selective recovery changed its source selection.');
        reference=row.content;observed={snapshot:await checks.snapshot(reference,repository.descriptor,signal),revision:row.revision};}
      else{const unit=units.get(repository.id);if(!unit||!same(validateSourceUnit(unit),repository.descriptor))fail('Bind the actual current source before selecting tests.','ENGINE_SOURCE_UNIT_UNAVAILABLE');
        observed=await unit.capture({signal});sourceSnapshot(observed.snapshot,repository.descriptor);
        const bytes=Buffer.from(canonicalJson(observed.snapshot));reference={namespace:'evidence',sha256:rules.hash(observed.snapshot).slice(7),bytes:bytes.byteLength};pendingEvidence.push({reference,bytes});}
      if(observed.revision!==rules.hash(observed.snapshot))fail('The source reader returned another byte revision.','ENGINE_PORT_RESULT_INVALID');
      rows.push({repositoryId:repository.id,descriptor:repository.descriptor,revision:observed.revision,content:reference,snapshot:observed.snapshot});
    }
    return {rows,pendingEvidence};
  }
  async function required(snapshot,phaseId,{signal}={}){
    if(snapshot.workflow.phases[phaseId].writeScope!=='source-and-artifact')return {files:[],references:[]};
    const plan=await createNamespaceSpecificationReader({observer,scope,workId,checks}).sourcePlan(snapshot,phaseId,{signal}),
      definition=(await observer.approved(snapshot,{signal})).compiled.definition,files=[];
    for(const [id,claim]of Object.entries(plan.planned.claims).filter(([,row])=>plannedClaimAllocatedTo(row,phaseId))){
      const contract=plan.planned.verificationContracts?.find(row=>row.clauseId===id),paths=new Set([...(claim.tests??[]),
        ...(contract?.slots??[]).filter(slot=>slot.method==='test'&&slot.role==='primary').flatMap(slot=>slot.witness.path?[slot.witness.path]:slot.witness.paths??[])]);
      for(const file of paths){
      const local=plan.repositoryPlan?repositoryPlanTestLocation(plan.repositoryPlan,file,{workflow:snapshot.workflow,definition})
        :snapshot.workflow.sourceBindings.current.repositories.length===1?{repositoryId:snapshot.workflow.sourceBindings.current.repositories[0].id,path:file}:null;
      if(!local)fail('Planned tests need their exact repository selection.','SELECTIVE_TEST_RECOVERY_UNSUPPORTED');files.push(local);}}
    return {files,references:[plan.proof.publication,plan.proof.reviewPacket,plan.proof.planned,...plan.proof.indices.map(row=>row.record),
      ...(plan.proof.repositoryPlan?[plan.proof.repositoryPlan]:[]),...(plan.proof.amendments??[])]};
  }
  async function context(snapshot,request,options={}){
    const policy=snapshot.workflow.resolution.testRecovery,phase=snapshot.workflow.phases[request.phaseId];
    if(!phase||policy?.enabled!==true||policy.allowEvidenceReuse!==true||!policy.enabledRiskCategories.includes('reduced-coverage'))fail(
      'Enable independent inventories and human reduced-coverage review in the approved workflow.','SELECTIVE_TEST_RECOVERY_DISABLED');
    const selected=rules.selection(request.selection),agreement=await recovery.current(snapshot,options),configured=await commands.commands(snapshot,request.phaseId,options),
      baseline=await checks.accepted({operationId:request.baselineOperationId,workId,phaseId:request.phaseId},options);
    if(!baseline||baseline.plan.selection)fail('Select an actual full configured pre-feature execution.','SELECTIVE_TEST_BASELINE_REQUIRED');
    const repositories=snapshot.workflow.sourceBindings?.current?.repositories??[];
    if(!same(baseline.plan.basis.configuration,snapshot.configuration)||!same(baseline.plan.steps.filter((_,index)=>index%repositories.length===0).map(row=>row.command),configured.commands)
      ||!same(baseline.plan.sources.map(row=>({id:row.id,descriptor:row.descriptor})),repositories.map(row=>({id:row.id,descriptor:row.descriptor})))
      ||baseline.plan.recovery?.agreementSha256!==agreement.agreement.contextSha256)fail('Selection changed its acknowledged commands, configuration, repositories or recovery agreement.','SELECTIVE_TEST_RECOVERY_PIN_CHANGED');
    const observed=await sourceRows(snapshot,{...options,bound:options.bound?.observations??null}),planned=await required(snapshot,request.phaseId,options),rows=[],references=[
      ...agreement.references,...configured.references,...planned.references,baseline.record.content];
    for(const repository of baseline.plan.sources){const original=snapshot.workflow.sourceBindings.origins?.find(row=>row.id===repository.id);
      if(!original)fail('The selected repository has no original Story baseline.','SELECTIVE_TEST_BASELINE_REQUIRED');
      const proof=await origin.binding(original.operationId,options.signal),bound=proof.selected.repositories.find(row=>row.id===repository.id);
      if(repository.revision!==bound?.revision||!same(repository.descriptor,bound?.descriptor))fail('A later full run cannot be relabeled as the original pre-feature baseline.','SELECTIVE_TEST_BASELINE_REQUIRED');references.push(bound.snapshot);}
    for(const wanted of selected){
      const index=baseline.plan.steps.findIndex(row=>row.command.id===wanted.commandId&&row.repositoryId===wanted.repositoryId);
      if(index<0)fail('Select a configured command in its bound repository.','SELECTIVE_TEST_RECOVERY_INVALID');
      const step=baseline.plan.steps[index],before=await known.observed(baseline,index,snapshot,configured,options),current=observed.rows.find(row=>row.repositoryId===wanted.repositoryId),
        declaration=policy.caseInventory.find(row=>row.phaseId===request.phaseId&&row.commandId===wanted.commandId);
      if(before.exit!==0||before.facts.counts.failed||before.facts.counts.skipped)fail('Only passing independently inventoried baseline cases may be excluded. Repair the baseline or run all checks.','SELECTIVE_TEST_BASELINE_NOT_PASSED');
      const repository=repositories.find(row=>row.id===wanted.repositoryId),qualified=options.bound?.rows?.find(row=>row.repositoryId===wanted.repositoryId&&row.commandId===wanted.commandId)?.environment
        ??(await checks.environment(request.phaseId,step.command,repository,options)).identity,
        expected=namespaceReuseEnvironment(before.qualification,step.manifest.toolPolicy.command);
      if(!same(qualified,expected))fail('The executor environment changed. Execute the complete configured command.','ENGINE_EVIDENCE_REUSE_ENVIRONMENT_CHANGED');
      const oldSnapshot=await checks.snapshot(baseline.plan.sources.find(row=>row.id===wanted.repositoryId).content,repository.descriptor,options.signal),
        changedTests=declaration.tests.filter(row=>!same(oldSnapshot.entries.find(file=>file.path===row.path),current.snapshot.entries.find(file=>file.path===row.path))).map(row=>row.path),
        narrowed=rules.narrow(step.command,declaration,wanted.files,{requiredFiles:[...planned.files.filter(row=>row.repositoryId===wanted.repositoryId).map(row=>row.path),...changedTests]}),
        after=known.rules.observed({workId,phaseId:request.phaseId,generation:baseline.plan.generation,repositoryId:wanted.repositoryId,command:step.command,commands:configured.commands,
          declaration,snapshot:current.snapshot,qualification:before.qualification,parsed:before.parsed,reportSha256s:before.facts.reportSha256s,at:baseline.body.recordedAt,
          configuration:snapshot.configuration,sourceRevision:current.revision});
      if(!same(before.facts.dependencies.find(row=>row.id==='baseline-compatibility'),after.dependencies.find(row=>row.id==='baseline-compatibility')))
        fail('Protected test, assertion, fixture or dependency inputs changed. Execute the full command.','SELECTIVE_TEST_PROTECTED_INPUT_CHANGED');
      rows.push({repositoryId:wanted.repositoryId,commandId:wanted.commandId,command:step.command,declaration,environment:qualified,...narrowed});references.push(...before.references);
    }
    const baselineTests=[];
    for(const [index,step]of baseline.plan.steps.entries()){
      const old=baseline.plan.sources.find(row=>row.id===step.repositoryId),current=observed.rows.find(row=>row.repositoryId===step.repositoryId),
        original=await checks.snapshot(old.content,old.descriptor,options.signal),cases=baseline.body.results[index].candidate?.output?.reports.parsed?.testcaseObservation?.occurrences??[];
      if(step.command.kind!=='test')continue;
      for(const file of step.command.argv.slice(2)){
        if(!file||file.startsWith('-')||file.startsWith('/')||file.includes('\\')||file.split('/').some(part=>['','..','.'].includes(part)))continue;
        const member=original.entries.find(row=>row.path===file);
        if(member&&same(member,current.snapshot.entries.find(row=>row.path===file))&&cases.some(row=>row.file===file))
          baselineTests.push({repositoryId:step.repositoryId,commandId:step.command.id,path:file,source:member});
      }
    }
    const value={schemaVersion:1,profile:'sflow-namespace-selective-test-recovery-context/v1',workId,phase:request.phaseId,generation:baseline.plan.generation,
      baseline:binding(baseline),recovery:agreement.agreement.contextSha256,commands:configured.identity,rows,
      observations:observed.rows.map(({snapshot,...row})=>row),baselineTests,maximumRiskDays:policy.maxRiskDays,impactComplete:false,testsExecuted:false,executionMode:'reviewed-file-selection',failuresWaived:false},
      sha256=rules.hash(value);
    if(Buffer.byteLength(canonicalJson(value))>2_097_152)fail('The selection review exceeds its bounded packet.','ENGINE_STORAGE_LIMIT');
    return {context:{value,sha256},generation:phase.generation,maximumDays:policy.maxRiskDays,pendingEvidence:observed.pendingEvidence,
      references:unique([...references,...value.observations.map(row=>row.content)].filter(row=>row.namespace==='evidence'))};
  }
  const owner={agentPhase:snapshot=>snapshot.workflow.currentPhase,
    async read(snapshot,request,options={}){
      const prior=await admitted(snapshot,options),phase=snapshot.workflow.phases[request.phaseId];if(!phase)fail('Name a phase of this Story.','ENGINE_PHASE_UNAVAILABLE');
      if(request.revoke){const target=prior.find(row=>row.value.outcome.record.id===request.revoke);if(!target)fail('The selected recovery does not exist.','SELECTIVE_TEST_RECOVERY_INVALID');
        return {generation:phase.generation,identity:{profile:'sflow-selective-test-recovery-source/v1',revoke:target.reference},references:prior.map(row=>row.reference)};}
      const source=await context(snapshot,request,options),renewal=prior.some(row=>row.value.outcome.record.id&&row.value.outcome.record.contextSha256===source.context.sha256);
      if((snapshot.workflow.currentPhase!==phase.id||['awaiting_approval','approved'].includes(phase.status))&&!renewal)
        fail('A new selection requires its current authoring phase; later renewal may preserve only the identical original scope.','SELECTIVE_TEST_RECOVERY_NOT_CURRENT');
      return {...source,identity:source.context.value,references:unique([...source.references,...prior.map(row=>row.reference)])};
    },
    authority(workflow,request,actor){if(workflow.resolution.presence)fail('Supply the configured person-presence evidence.','ENGINE_PORT_UNAVAILABLE',{required:['person-presence']});
      const authorities=testRunRiskAuthorities(workflow,request.phaseId);if(!authorities.length)fail('Configure the human test-risk authority.','RISK_AUTHORITY_UNAVAILABLE');
      return requireApprovalAuthority(workflow.resolution.approvalAuthorities,{mode:'required',authorities,requiredAuthorities:[],minimum:1},actor.identity).authorityGroup;},
    plan:rules.confirm,
    async fresh(snapshot,request,source,options={}){if(!request.revoke){const current=await context(snapshot,request,options);
      if(current.context.sha256!==source.context.sha256)fail('Source or environment changed during selection review.','SELECTIVE_TEST_RECOVERY_CONTEXT_CHANGED');}}
  };
  reader=createNamespaceRecordedMutationReader({observer,scope,workId,operation,owner,contract:namespaceDecisionContract});
  async function current(snapshot,phaseId,{signal,at,bound=null}={}){
    const proofs=await admitted(snapshot,{signal}),records=proofs.map(row=>row.value.outcome.record),proof=bound
      ?proofs.find(row=>same(row.reference,bound.decision)):proofs.toReversed().find(row=>row.value.phase===phaseId&&row.value.outcome.record.id&&rules.state(records,row.value.outcome.record,at)==='active');
    if(!proof)return null;
    const record=proof.value.outcome.record;if(!bound&&rules.state(records,record,at)!=='active')fail('The reviewed test selection expired or was revoked.','SELECTIVE_TEST_RECOVERY_NOT_CURRENT');
    const source=await context(snapshot,{phaseId,baselineOperationId:record.context.baseline.operationId,
      selection:record.context.rows.map(row=>({repositoryId:row.repositoryId,commandId:row.commandId,files:row.files}))},{signal,...(bound?{bound:record.context}:{})});
    if(source.context.sha256!==record.contextSha256)fail('The current source, environment or command inventory changed after file-selection review.','SELECTIVE_TEST_RECOVERY_CONTEXT_CHANGED',{
      actions:[{operation:'test-recovery.select-context',inputs:{workId,phaseId,baselineOperationId:record.context.baseline.operationId,
        selection:record.context.rows.map(row=>({repositoryId:row.repositoryId,commandId:row.commandId,files:row.files}))}},
      {operation,inputs:{workId,revoke:record.id},requiredInputs:['operationId','reason'],prerequisites:['authenticated-test-risk-authority']}]});
    return {profile:'sflow-namespace-selective-test-recovery-check/v1',decision:proof.reference,record,rows:source.context.value.rows,
      observations:source.context.value.observations};
  }
  async function baselineTestPaths(snapshot,phaseId,repositoryId,options={}){
    const proofs=await admitted(snapshot,options),proof=proofs.toReversed().find(row=>row.value.phase===phaseId&&row.value.outcome.record.id);
    return [...new Set([...(proof?.value.outcome.record.context.rows??[]).filter(row=>row.repositoryId===repositoryId).flatMap(row=>row.declaration.tests.map(test=>test.path)),
      ...(proof?.value.outcome.record.context.baselineTests??[]).filter(row=>row.repositoryId===repositoryId).map(row=>row.path)])];
  }
  return Object.freeze({owner,reader,admitted,context,current,rules,baselineTestPaths});
}
