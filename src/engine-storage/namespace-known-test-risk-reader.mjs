/** Authenticated pre-feature baselines, independent inventories and original human known-failure receipts. */
import path from 'node:path';
import {canonicalJson,NAMESPACE_KNOWN_TEST_RISK_SCHEMAS,admitRecordSchemaVersion} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {namespaceKnownTestRecoveryPolicies} from '../kernel/known-test-recovery.mjs';
import {testRecoveryPolicies} from '../kernel/test-recovery.mjs';
import {parseNativeNodeJunitReport} from '../verification/test-report-reader.mjs';
import {testRunRiskAuthorities} from '../kernel/approval-fallback.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceTestCommandOwners} from './namespace-test-command-reader.mjs';
import {createNamespaceTestRecoveryOwner} from './namespace-test-recovery-reader.mjs';
import {createNamespaceSourceObservations} from './namespace-source-observations.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {memoNamespaceObservedDecision} from './namespace-story-reader.mjs';
import {createNamespaceSpecificationReader} from './namespace-specifications.mjs';
import {plannedClaimAllocatedTo} from '../kernel/specification-policy.mjs';
import {isExecutableTestSourceCandidate} from '../engine-compatibility/node-source-policy.mjs';
import {repositoryPlanTestLocation} from '../engine-compatibility/node-repository-plan.mjs';
const operation='test-risk.confirm-known',rules=namespaceKnownTestRecoveryPolicies(NODE_TEXT_DIGESTS),trp=testRecoveryPolicies(NODE_TEXT_DIGESTS),
  same=(a,b)=>canonicalJson(a)===canonicalJson(b),unique=rows=>[...new Map(rows.map(row=>[canonicalJson(row),row])).values()],
  fail=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>{throw new SingularityFlowError(message,{code,details});};
export function createNamespaceKnownTestRiskOwner({observer,scope,workId}){
  const checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),commands=createNamespaceTestCommandOwners({observer,scope,workId}),
    recovery=createNamespaceTestRecoveryOwner({observer,scope,workId}),sources=createNamespaceSourceObservations({observer,scope});let reader;
  function binding(found){const key=checks.codec.indexKey(found.plan);return {schemaVersion:1,format:'sflow-namespace-phase-check-evidence-binding/v1',
    operationId:found.plan.input.operationId,result:found.record,index:{key,version:found.receipt.records.find(row=>row.key===key).version}};}
  async function admitted(snapshot,options={}){
    const rows=snapshot.workflow.namespaceKnownTestRisks??[],links=namespaceDecisionContract.receipts(snapshot.workflow).filter(row=>row.operation===operation);
    if(!Array.isArray(rows)||rows.length!==links.length||rows.length>128)fail('The known-failure inventory lost its bounded original human receipts.');
    for(const row of rows){admitRecordSchemaVersion(NAMESPACE_KNOWN_TEST_RISK_SCHEMAS.record,row);
      if(row.profile!=='sflow-namespace-known-test-run-risk/v1')fail('The known-failure record has another profile.');}
    const proofs=[];for(const link of links)proofs.push(await memoNamespaceObservedDecision(observer,{profile:'sflow-namespace-known-test-risk-proof/v1',record:link.record},
      ()=>reader.accepted(link,options),options));
    if(!same(rows,proofs.map(row=>row.value.outcome.record)))fail('The known-failure inventory differs from its actual conditional receipts.');return proofs;
  }
  async function observed(found,index,snapshot,selected,{signal,additionalTestInputs=[]}={}){
    const step=found.plan.steps[index],result=found.body.results[index],output=result.candidate?.output,check=found.body.checks[index],
      declaration=snapshot.workflow.resolution.testRecovery.caseInventory?.find(row=>row.phaseId===found.plan.input.phaseId&&row.commandId===step.command.id),
      qualification=step.manifest.toolPolicy.environmentQualification,
      source=found.plan.sources.find(row=>row.id===step.repositoryId);
    if(step.command.kind!=='test'||!output||result.failure||!output.process.closed||output.process.status===null||output.process.signal!==null
      ||output.process.timedOut||output.process.overflow||output.diagnostics.length||!['passed','failed'].includes(check.status)
      ||output.reports.raw.length!==1||output.reports.raw[0].path!==null||step.manifest.toolPolicy.command.environmentNames.length
      ||qualification?.profile!=='sflow-node-check-environment/v1'||qualification.runtimeSha256!==step.manifest.toolPolicy.command.executableSha256
      ||qualification.environmentSha256!==step.manifest.toolPolicy.command.environmentSha256)
      fail('Known-failure acceptance needs an intact native Node JUnit run with SGOS-qualified environment and no injected runner controls.','KNOWN_TEST_RISK_NOT_ELIGIBLE');
    const syntax=qualification.reportRoot?.grammar==='win32'?path.win32:qualification.reportRoot?.grammar==='posix'?path.posix:null;
    if(!syntax||!syntax.isAbsolute(qualification.reportRoot.absolute))fail('The executor did not retain its exact reporter root.','KNOWN_TEST_ENVIRONMENT_REQUIRED');
    const raw=output.reports.raw[0].content,bytes=await observer.bytes(raw,raw.bytes,signal),parsed=parseNativeNodeJunitReport(bytes),
      files=[...new Set(declaration?.tests?.map(row=>row.path)??[])];
    parsed.cases=parsed.cases.map(row=>{let file;
      if(row.file===null&&files.length===1)file=files[0];
      else if(typeof row.file==='string'&&syntax.isAbsolute(row.file))file=syntax.relative(qualification.reportRoot.absolute,row.file).split(syntax.sep).join('/');
      else fail('The native report needs an exact, unambiguous executor file identity.','KNOWN_TEST_RISK_NOT_ELIGIBLE');
      return {...row,file};});
    const sourceSnapshot=await checks.snapshot(source.content,source.descriptor,signal),facts=rules.observed({workId,phaseId:found.plan.input.phaseId,generation:found.plan.generation,
      repositoryId:step.repositoryId,command:step.command,commands:selected.commands,declaration,snapshot:sourceSnapshot,qualification,parsed,
      reportSha256s:['sha256:'+raw.sha256],at:found.body.recordedAt,configuration:snapshot.configuration,sourceRevision:source.revision,additionalTestInputs});
    return {facts,exit:output.process.status,references:[raw,output.stdout,output.stderr,output.source.before.content,output.source.after.content,source.content]};
  }
  async function additionalInputs(snapshot,before,after,{signal}={}){
    const candidates=[];
    for(const source of after.plan.sources){const original=before.plan.sources.find(row=>row.id===source.id),
      old=await checks.snapshot(original.content,original.descriptor,signal),current=await checks.snapshot(source.content,source.descriptor,signal),
      existing=new Set(old.entries.map(row=>row.path));
      for(const member of current.entries)if(!existing.has(member.path)&&isExecutableTestSourceCandidate(member.path))
        candidates.push({repositoryId:source.id,path:member.path,source:member});
    }
    if(!candidates.length)return {inputs:[],references:[]};
    const plan=await createNamespaceSpecificationReader({observer,scope,workId,checks}).sourcePlan(snapshot,after.plan.input.phaseId,{signal}),
      definition=(await observer.approved(snapshot,{signal})).compiled.definition,planned=[];
    for(const claim of Object.values(plan.planned.claims).filter(claim=>plannedClaimAllocatedTo(claim,after.plan.input.phaseId)))for(const file of claim.tests??[]){
      const location=plan.repositoryPlan?repositoryPlanTestLocation(plan.repositoryPlan,file,{workflow:snapshot.workflow,definition})
        :after.plan.sources.length===1?{repositoryId:after.plan.sources[0].id,path:file}:null;
      if(location)planned.push(location);
    }
    const inputs=[],references=[plan.proof.publication,plan.proof.reviewPacket,plan.proof.planned,...plan.proof.indices.map(row=>row.record),
      ...(plan.proof.repositoryPlan?[plan.proof.repositoryPlan]:[]),...(plan.proof.amendments??[])];
    for(const candidate of candidates){
      if(!planned.some(row=>row.repositoryId===candidate.repositoryId&&row.path===candidate.path))continue;
      for(const [index,step]of after.plan.steps.entries()){
        const check=after.body.checks[index],output=after.body.results[index].candidate?.output,
          occurrences=output?.reports.parsed?.testcaseObservation?.occurrences?.filter(row=>row.file===candidate.path)??[];
        if(step.repositoryId!==candidate.repositoryId||step.command.kind!=='test'||check.status!=='passed'||check.tests?.failed!==0||check.tests?.skipped!==0
          ||!occurrences.length||occurrences.some(row=>row.outcome!=='passed'))continue;
        inputs.push({...candidate,permission:'new-planned-passing-test-input',commandId:step.command.id,
          cases:rules.testInputCases(occurrences),plan:plan.proof});
        references.push(...output.reports.raw.map(row=>row.content),output.stdout,output.stderr);break;
      }
    }
    return {inputs,references};
  }
  async function context(snapshot,request,options={}){
    const policy=snapshot.workflow.resolution.testRecovery;
    if(policy?.enabled!==true||policy.allowEvidenceReuse!==true||!policy.enabledRiskCategories.includes('known-test-failure'))fail(
      'The approved workflow must explicitly enable independently inventoried known-failure review.','KNOWN_TEST_RISK_DISABLED');
    const agreement=await recovery.current(snapshot,options),selected=await commands.commands(snapshot,request.phaseId,options),
      before=await checks.accepted({operationId:request.baselineOperationId,workId,phaseId:request.phaseId},options),
      after=await checks.accepted({operationId:request.observedOperationId,workId,phaseId:request.phaseId},options);
    if(!before||!after)fail('Select actual retained baseline and candidate executions.','ENGINE_CHECK_EVIDENCE_REQUIRED');
    if(!same(before.plan.basis.configuration,snapshot.configuration)||!same(after.plan.basis.configuration,snapshot.configuration)
      ||!same(before.plan.sources.map(row=>({id:row.id,descriptor:row.descriptor})),after.plan.sources.map(row=>({id:row.id,descriptor:row.descriptor})))
      ||!same(after.plan.sources.map(row=>({id:row.id,descriptor:row.descriptor})),(snapshot.workflow.sourceBindings?.current?.repositories??[]).map(row=>({id:row.id,descriptor:row.descriptor})))
      ||!same(before.plan.steps.map(row=>row.command),after.plan.steps.map(row=>row.command))
      ||!same(after.plan.steps.filter((_,index)=>index%after.plan.sources.length===0).map(row=>row.command),selected.commands)
      ||(after.plan.testCommands?!same(after.plan.testCommands,selected.identity):selected.identity.receipts.length!==0)
      ||before.plan.recovery?.agreementSha256!==agreement.agreement.contextSha256||after.plan.recovery?.agreementSha256!==agreement.agreement.contextSha256)
      fail('The original baseline and candidate must share the acknowledged configuration, commands, agreement and repository selection.','KNOWN_TEST_RISK_PIN_CHANGED');
    const additional=await additionalInputs(snapshot,before,after,options),
      references=[...agreement.references,...selected.references,...additional.references,before.record.content,after.record.content,before.body.plan,after.body.plan],rows=[];
    for(const source of before.plan.sources){
      const origin=snapshot.workflow.sourceBindings.origins?.find(row=>row.id===source.id);
      if(!origin)fail('The repository has no original Story source binding.','KNOWN_TEST_BASELINE_REQUIRED');
      const original=await sources.binding(origin.operationId,options.signal),repository=original.selected.repositories.find(row=>row.id===source.id);
      if(!repository||repository.revision!==origin.revision||!same(repository.descriptor,origin.descriptor)||source.revision!==repository.revision)
        fail('The baseline must have executed on the original pre-feature source; a later failed run cannot be relabeled.','KNOWN_TEST_BASELINE_REQUIRED',{
          repositoryId:source.id,operation:'phase.checks.run',baselineRevision:repository?.revision??null});
      references.push(repository.snapshot);
    }
    for(const [index,step]of after.plan.steps.entries()){
      if(after.body.checks[index].status==='passed')continue;
      if(step.command.kind!=='test')fail('Known test failures cannot waive another configured check.','KNOWN_TEST_RISK_NOT_ELIGIBLE');
      const baseline=await observed(before,index,snapshot,selected,{...options,additionalTestInputs:additional.inputs}),current=await observed(after,index,snapshot,selected,{...options,additionalTestInputs:additional.inputs}),
        projection=rules.project({workId,phaseId:request.phaseId,generation:after.plan.generation,policy,configuration:snapshot.configuration,
          recovery:agreement.agreement,before:baseline.facts,after:current.facts,baselineExit:baseline.exit,currentExit:current.exit});
      if(!rules.eligible(projection))fail('The current failure, environment, semantics or protected dependencies do not match the original baseline. Repair and run the current checks.',
        'KNOWN_TEST_RISK_NOT_ELIGIBLE',{repositoryId:step.repositoryId,commandId:step.command.id,comparison:rules.comparison(projection),actions:[
          {operation:'phase.delivery.inspect',inputs:{workId,phaseId:request.phaseId}},
          {operation:'phase.checks.run',inputs:{workId,phaseId:request.phaseId},requiredInputs:['operationId']}]});
      rows.push({repositoryId:step.repositoryId,commandId:step.command.id,projection});references.push(...baseline.references,...current.references);
    }
    if(!rows.length)fail('A passing execution needs no known-failure exception.','KNOWN_TEST_RISK_NOT_ELIGIBLE');
    const baselineTests=[];
    for(const [index,step]of after.plan.steps.entries()){
      if(step.command.kind!=='test'||step.command.argv?.[0]!=='node'||step.command.argv[1]!=='--test')continue;
      const old=before.body.results[index].candidate?.output?.reports.parsed?.testcaseObservation?.occurrences??[],
        current=after.body.results[index].candidate?.output?.reports.parsed?.testcaseObservation?.occurrences??[],
        previousSource=before.plan.sources.find(row=>row.id===step.repositoryId),currentSource=after.plan.sources.find(row=>row.id===step.repositoryId),
        previous=await checks.snapshot(previousSource.content,previousSource.descriptor,options.signal),latest=await checks.snapshot(currentSource.content,currentSource.descriptor,options.signal);
      for(const file of step.command.argv.slice(2)){
        if(!file||file.startsWith('-')||file.startsWith('/')||file.includes('\\')||file.split('/').some(part=>['','..','.'].includes(part)))continue;
        const member=previous.entries.find(row=>row.path===file);
        if(member&&same(member,latest.entries.find(row=>row.path===file))&&old.some(row=>row.file===file)&&current.some(row=>row.file===file))
          baselineTests.push({repositoryId:step.repositoryId,commandId:step.command.id,path:file,source:member});
      }
    }
    const scopeSha256=rules.hash({phase:request.phaseId,generation:after.plan.generation,baseline:binding(before),baselineTests,
      ...(additional.inputs.length?{additionalTestInputs:additional.inputs}:{}),recovery:agreement.agreement.contextSha256,
      rows:rows.map(({repositoryId,commandId,projection:p})=>({repositoryId,commandId,baseline:p.baseline,agreement:p.agreement,
        expected:p.observation.expectedTestIds,semantics:p.observation.cases.map(row=>({id:row.id,semanticsSha256:row.semanticsSha256})),
        compatibility:p.observation.dependencies.find(row=>row.id==='baseline-compatibility'),environment:{...p.observation.environment,dependencySha256:null}}))}),
      value={schemaVersion:1,profile:'sflow-namespace-known-test-risk-context/v1',workId,phase:request.phaseId,generation:after.plan.generation,
        baseline:binding(before),observed:binding(after),baselineTests,...(additional.inputs.length?{additionalTestInputs:additional.inputs}:{}),
        recovery:{agreement:agreement.agreement,records:agreement.references},rows,scopeSha256,
        identityAssurance:'independent-configured-case-inventory',executionMode:'all-configured',receivingExecutionRequired:true,testsPassed:false};
    const bytes=Buffer.from(canonicalJson(value)),sha256=rules.hash(value),reference={namespace:'evidence',sha256:sha256.slice(7),bytes:bytes.byteLength};
    if(bytes.byteLength>2_097_152)fail('The known-failure review exceeds its bounded packet.','ENGINE_STORAGE_LIMIT');
    return {context:{value,sha256,reference},packet:{reference,bytes},generation:after.plan.generation,maximumDays:policy.maxRiskDays,
      references:unique(references.filter(row=>row.namespace==='evidence'))};
  }
  const owner={agentPhase:snapshot=>snapshot.workflow.currentPhase,
    async read(snapshot,request,options={}){
      const prior=await admitted(snapshot,options),phase=snapshot.workflow.phases[request.phaseId];if(!phase)fail('Name a phase of this Story.','ENGINE_PHASE_UNAVAILABLE');
      if(request.revoke){const target=prior.find(row=>row.value.outcome.record.id===request.revoke);if(!target)fail('The original known-failure decision does not exist.','TEST_RUN_RISK_UNKNOWN');
        return {generation:phase.generation,identity:{profile:'sflow-namespace-known-test-risk-source/v1',revoke:target.reference},references:prior.map(row=>row.reference)};}
      const source=await context(snapshot,request,options),renewal=prior.some(row=>row.value.outcome.record.scopeSha256===source.context.value.scopeSha256);
      if(options.bound)await observer.bytes(source.context.reference,source.context.reference.bytes,options.signal);
      if((snapshot.workflow.currentPhase!==phase.id||phase.status==='awaiting_approval')&&!renewal)fail('A new known-failure scope needs review in its authoring phase.','KNOWN_TEST_RISK_DURING_REVIEW');
      return {...source,pendingEvidence:[source.packet],identity:{profile:'sflow-namespace-known-test-risk-source/v1',contextSha256:source.context.sha256,context:source.context.reference},
        references:unique([...source.references,source.context.reference,...prior.map(row=>row.reference)])};
    },
    authority(workflow,request,actor){if(workflow.resolution.presence)fail('Supply the configured person-presence evidence.','ENGINE_PORT_UNAVAILABLE',{required:['person-presence']});
      const groups=testRunRiskAuthorities(workflow,request.phaseId);if(!groups.length)fail('Configure the original human test-risk authority.','RISK_AUTHORITY_UNAVAILABLE');
      return requireApprovalAuthority(workflow.resolution.approvalAuthorities,{mode:'required',authorities:groups,requiredAuthorities:[],minimum:1},actor.identity).authorityGroup;},
    plan(workflow,request,facts,source){return rules.confirm(workflow,request,facts,source);}
  };
  reader=createNamespaceRecordedMutationReader({observer,scope,workId,operation,owner,contract:namespaceDecisionContract});
  function evaluate(row,proof,agreementProof,at){
    const p=row.projection,record=proof.value.outcome.record,principal=proof.value.actor.principalId,
      decision=rules.risk(p,record,{principal,authorizationRef:'namespace-receipt:'+proof.reference.sha256}),
      authority=(value,ctx)=>{
        const isAgreement=same(value,p.agreement),isDecision=same(value,decision);if(!isAgreement&&!isDecision)return null;
        return {recordSha256:value.recordSha256,principal:value.issuer.principal,policyAuthoritySha256:p.policy.authoritySha256,
          confirmationSha256:isAgreement?value.confirmedPlanSha256:value.confirmationSha256,capability:ctx.capability,
          transitions:value.transitions??[],issuedAt:value.createdAt,revokedAt:null,durable:true,
          authorizationRef:'namespace-receipt:'+(isAgreement?agreementProof.at(-1).sha256:proof.reference.sha256)};
      },
      evidence=value=>[p.baseline,p.observation].some(original=>same(original,value))?{recordSha256:value.recordSha256,authenticated:true,reportsAvailable:true,verifiedAt:at}:null;
    return trp.evaluateTestRecoveryGate({policy:p.policy,agreement:p.agreement,subject:p.observation.subject,operation:'publish',at,observations:[p.observation],
      baselines:[p.baseline],decisions:[decision],selection:p.selection,candidateDependencies:p.observation.dependencies,
      candidateEnvironment:p.observation.environment,verifyAuthority:authority,verifyEvidence:evidence});
  }
  async function candidate(publication,snapshot,{signal,at,checked,bound=null}={}){
    if(!checked?.found||!checked.binding)fail('Use a real retained candidate execution.','ENGINE_CHECK_EVIDENCE_REQUIRED');
    const proofs=await admitted(snapshot,{signal}),records=proofs.map(row=>row.value.outcome.record),
      original=bound?proofs.find(row=>row.value.outcome.record.id===bound.decision.record.id):proofs.filter(row=>row.value.outcome.record.id&&row.value.phase===publication.phase).at(-1);
    if(!original)fail('The failed execution needs its original human known-failure review.','TEST_RUN_RISK_NOT_COVERED');
    const record=original.value.outcome.record,source=await context(snapshot,{phaseId:publication.phase,baselineOperationId:record.context.baseline.operationId,
      observedOperationId:checked.found.plan.input.operationId},{signal}),
      active=proofs.toReversed().find(row=>row.value.outcome.record.id&&row.value.outcome.record.scopeSha256===source.context.value.scopeSha256&&rules.state(records,row.value.outcome.record,at)==='active');
    if(record.scopeSha256!==source.context.value.scopeSha256||!active)fail('The exact known-failure scope needs a current original-owner decision.','TEST_RUN_RISK_NOT_COVERED',{
      actions:[{operation:'test-risk.known-context',inputs:{workId,phaseId:publication.phase,baselineOperationId:record.context.baseline.operationId,
        observedOperationId:checked.found.plan.input.operationId}},{operation,inputs:{workId,phaseId:publication.phase},
        requiredInputs:['operationId','baselineOperationId','observedOperationId','expectedContext','reason','expires','followUpOwner','remediationRef'],prerequisites:['authenticated-human-test-risk-authority']}]});
    const observations=[];
    for(const [index,step]of checked.found.plan.steps.entries()){
      const check=checked.found.body.checks[index],row=source.context.value.rows.find(row=>row.repositoryId===step.repositoryId&&row.commandId===step.command.id);
      if(check.status==='passed'){observations.push({taskId:step.contract.taskId,repositoryId:step.repositoryId,commandId:step.command.id,status:check.status,tests:check.tests,decision:null,cause:null});continue;}
      const gate=evaluate(row,active,source.context.value.recovery.records,at);
      if(gate.gateDecision!=='allow-with-risk'||gate.dispositions.some(row=>row.disposition!=='accepted-known-failures'))fail(
        'The current failure, environment, test semantics or protected dependencies exceed the exact reviewed baseline. Repair and execute the current checks.',
        'KNOWN_TEST_RISK_NOT_ELIGIBLE',{gate,actions:[{operation:'phase.checks.run',inputs:{workId,phaseId:publication.phase},requiredInputs:['operationId']}]});
      observations.push({taskId:step.contract.taskId,repositoryId:step.repositoryId,commandId:step.command.id,status:check.status,tests:check.tests,
        cause:{category:'known-test-failure',baseline:row.projection.baseline.recordSha256},decision:{record,reference:original.reference},
        failedCases:row.projection.observation.cases.filter(row=>row.outcome==='failed'),disposition:'accepted-known-failures'});
    }
    return {report:{schemaVersion:1,profile:'sflow-namespace-known-test-risk-policy/v1',workId,phaseId:publication.phase,checks:checked.binding,
      baseline:record.context.baseline,scopeSha256:record.scopeSha256,decision:{record,reference:original.reference},observations,
      testsPassed:false,codeFailuresWaived:false,crossPhaseReuse:false,executionMode:'all-configured',sourceRechecked:true},
      references:unique([...source.references,original.reference,active.reference,original.source.context.reference,active.source.context.reference]),policy:{owners:['check-execution']}};
  }
  async function baselineTestPaths(snapshot,phaseId,repositoryId,options={}){
    if(snapshot.workflow.phases[phaseId].generation!==0)return [];
    const proofs=await admitted(snapshot,options),proof=proofs.filter(row=>row.value.phase===phaseId&&row.value.outcome.record.id).at(-1);
    return [...new Set((proof?.source.context.value.baselineTests??[]).filter(row=>row.repositoryId===repositoryId).map(row=>row.path))].sort();
  }
  return Object.freeze({owner,reader,rules,admitted,context,candidate,baselineTestPaths});
}
