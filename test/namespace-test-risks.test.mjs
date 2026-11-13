import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceTestRiskFixture} from './helpers/namespace-test-risk-fixture.mjs';
import {createNamespaceTestRiskOwner} from '../src/engine-storage/namespace-test-risk-reader.mjs';
import {createNamespacePhaseCheckReader} from '../src/engine-storage/namespace-phase-check-reader.mjs';
import {createNamespaceSubmissionReader} from '../src/engine-storage/namespace-submission-reader.mjs';
import {rm,writeFile} from 'node:fs/promises';import path from 'node:path';
test('a human authorizes only the exact command and cause; a genuine failed SGOS run stays failed',{timeout:120000},async t=>{
  const f=await namespaceTestRiskFixture(t);f.human();const decision=await f.engine.run('decision.test-risk',f.request);
  assert.equal(decision.record.profile,'sflow-namespace-test-run-risk/v1');assert.equal(decision.record.boundBy,'command-digest');assert.equal(decision.record.observation,undefined);
  assert.equal(f.control.starts,0);f.author();await f.rebase('continue-after-risk');const run=await f.engine.run('phase.checks.run',f.input);
  assert.equal(run.verdict,'failed');assert.equal(run.checks[0].tests.failed,1);assert.equal(f.control.starts,1);
  const snapshot=(await f.observer.inspect()).snapshot,checks=createNamespacePhaseCheckReader(f.common),found=await checks.accepted(f.input),
    binding={schemaVersion:1,format:'sflow-namespace-phase-check-evidence-binding/v1',operationId:f.input.operationId,result:found.record,
      index:{key:checks.codec.indexKey(found.plan),version:found.receipt.records.find(row=>row.key===checks.codec.indexKey(found.plan)).version}};
  const value=await createNamespaceTestRiskOwner({observer:f.observer,...f.common}).candidate({phase:'intake'},snapshot,{at:f.accessControl.now,checked:{binding,found}});
  assert.equal(value.report.testsPassed,false);assert.equal(value.report.observations[0].cause.class,'service-unreachable');
  assert.equal(value.report.observations[0].decision.record.id,'TRR-001');assert.equal(value.report.observations[0].status,'failed');
});
for(const backend of ['filesystem','sqlite','application'])test(backend+': an accepted environment failure publishes, submits and receives independent approval without claiming passed tests',{timeout:120000},async t=>{
  const f=await namespaceTestRiskFixture(t,{backend});f.human();const recorded=await f.engine.run('decision.test-risk',f.request);
  f.author();await f.rebase('continue-with-environment-risk');const run=await f.engine.run('phase.checks.run',f.input);assert.equal(run.verdict,'failed');
  const prepublish=await f.engine.run('phase.prepublish',{phaseId:'intake'});assert.equal(prepublish.manifest.qualityDisposition,'ready');
  assert.equal(prepublish.manifest.readiness.requiredTests,'accepted-environment-failure');
  const published=await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});assert.equal(published.status,'published');
  assert.equal(f.control.starts,1);await f.engine.run('phase.submit',{phaseId:'intake'});f.human();
  const review=await f.engine.run('phase.review',{phaseId:'intake'}),binding=review.manifest.reviewBinding;
  assert.ok((await f.engine.run('phase.review.resources',{phaseId:'intake'})).manifest.resources.some(row=>row.kind==='test-run-risk'));
  const result=await f.engine.run('phase.approve',{phaseId:'intake',confirmation:{workId:f.inputs.workId,phase:'intake',generation:binding.generation,reviewPacketSha256:binding.packetSha256}});
  assert.equal(result.status,'recorded');
  const snapshot=(await f.observer.inspect()).snapshot,checks=createNamespacePhaseCheckReader(f.common),
    [proof]=await createNamespaceSubmissionReader({observer:f.observer,...f.common,checks}).inspectApprovedMany(snapshot,['intake']);
  assert.equal(proof.published.checks,null);assert.equal(proof.published.policyEvidence[0].kind,'test-risk/v1');
  const risk=proof.published.policyEvidence[0],manifest=JSON.parse(new TextDecoder().decode((await f.content.read(f.scope,risk.record)).data)),
    report=JSON.parse(new TextDecoder().decode((await f.content.read(f.scope,manifest.report)).data));
  assert.equal(report.testsPassed,false);assert.equal(report.observations[0].tests.failed,1);assert.equal(report.observations[0].status,'failed');
  assert.equal(report.observations[0].decision.record.id,recorded.record.id);assert.equal(f.control.starts,1);
  await rm(f.root,{recursive:true,force:true});
  const later=f.make({working:undefined,sources:[],checks:undefined,clock:{now(){throw Error('Accepted replay cannot consult the old device or clock.');}}});
  assert.deepEqual((await later.run('decision.test-risk',f.request)).record,recorded.record);
  assert.deepEqual(await later.run('phase.approve',{phaseId:'intake',confirmation:{workId:f.inputs.workId,phase:'intake',generation:binding.generation,reviewPacketSha256:binding.packetSha256}}),result);
  f.author();assert.equal((await later.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'})).status,'retained');
  assert.equal((await later.run('phase.submit',{phaseId:'intake'})).status,'retained');
});
test('risk identity, command and environment class cannot be supplied as success flags',{timeout:120000},async t=>{
  const f=await namespaceTestRiskFixture(t);
  await assert.rejects(f.engine.run('decision.test-risk',{...f.request,approved:true}),{code:'ENGINE_INPUT_INVALID'});
  f.human();f.accessControl.actorKind='service';await assert.rejects(f.engine.run('decision.test-risk',f.request),{code:'ENGINE_HUMAN_AUTHORITY_REQUIRED'});
  f.human();f.accessControl.creator.email='outside@example.test';await assert.rejects(f.engine.run('decision.test-risk',f.request),{code:'APPROVAL_IDENTITY_NOT_AUTHORIZED'});
  f.human();for(const extra of [{argvSha256:'0'.repeat(64)},{commandId:'invented'},{causeClass:'assertion-failure'}])
    await assert.rejects(f.engine.run('decision.test-risk',{...f.request,...extra}),{code:'TEST_RUN_RISK_INVALID'});
  assert.equal((await f.observer.inspect()).snapshot.workflow.namespaceTestRunRisks,undefined);assert.equal(f.control.starts,0);
});
test('a real assertion cannot consume an environment risk and can be repaired in the same phase',{timeout:120000},async t=>{
  const f=await namespaceTestRiskFixture(t,{assertion:true});f.human();await f.engine.run('decision.test-risk',f.request);
  f.author();await f.rebase('rebase-risk-before-code-failure');await f.engine.run('phase.checks.run',f.input);
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'}),error=>
    error.code==='TEST_RUN_RISK_NOT_ELIGIBLE'&&error.details.cause.category==='code'&&!error.details.actions.some(row=>row.operation==='decision.test-risk'));
  await writeFile(path.join(f.root,'case.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';test('repaired assertion',()=>assert.equal(2+2,4));\n");
  assert.equal((await f.engine.run('phase.checks.run',{...f.input,operationId:'actually-repaired-check'})).verdict,'passed');
  await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
  const snapshot=(await f.observer.inspect()).snapshot,checks=createNamespacePhaseCheckReader(f.common),packets=createNamespaceSubmissionReader({observer:f.observer,...f.common,checks}),
    published=await packets.publicationReader.accepted(snapshot.workflow.phases.intake.publicationBindings[0],'intake');
  assert.ok(published.checks);assert.equal(published.policyEvidence,undefined);assert.equal(f.control.starts,2);
});
test('an environment failure returns the exact human risk route without inventing a decision',{timeout:120000},async t=>{
  const f=await namespaceTestRiskFixture(t);await f.engine.run('phase.checks.run',f.input);
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'}),error=>
    error.code==='PHASE_CHECKS_NOT_PASSED'&&error.details.testRunRisk.cause.class==='service-unreachable'
      &&error.details.testRunRisk.actions.some(row=>row.operation==='decision.test-risk'&&row.inputs.argvSha256===f.request.argvSha256));
  assert.equal((await f.observer.inspect()).snapshot.workflow.namespaceTestRunRisks,undefined);assert.equal(f.control.starts,1);
});
test('revocation is append-only and prevents submitting a formerly accepted environment failure',{timeout:120000},async t=>{
  const f=await namespaceTestRiskFixture(t);f.human();await f.engine.run('decision.test-risk',f.request);f.author();await f.rebase('rebase-original-risk');
  await f.engine.run('phase.checks.run',f.input);await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
  f.human();await f.engine.run('decision.test-risk',{revoke:'TRR-001',reason:'The independent reviewer withdraws this particular environment risk.'});f.author();
  await assert.rejects(f.engine.run('phase.submit',{phaseId:'intake'}),{code:'TEST_RUN_RISK_NOT_COVERED'});
  assert.equal((await f.observer.inspect()).snapshot.workflow.namespaceTestRunRisks.length,2);assert.equal(f.control.starts,1);
});
test('expiry and a changed source cannot carry an old environment failure through approval',{timeout:120000},async t=>{
  const f=await namespaceTestRiskFixture(t);f.human();await f.engine.run('decision.test-risk',f.request);f.author();await f.rebase('rebase-expiring-risk');
  await f.engine.run('phase.checks.run',f.input);await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
  await f.engine.run('phase.submit',{phaseId:'intake'});f.human();const review=await f.engine.run('phase.review',{phaseId:'intake'}),binding=review.manifest.reviewBinding,
    confirm={phaseId:'intake',confirmation:{workId:f.inputs.workId,phase:'intake',generation:binding.generation,reviewPacketSha256:binding.packetSha256}},at=f.accessControl.now;
  f.accessControl.now='2026-11-21T00:00:00.000Z';await assert.rejects(f.engine.run('phase.approve',confirm),{code:'TEST_RUN_RISK_NOT_COVERED'});
  f.accessControl.now=at;await writeFile(path.join(f.root,'new-input.txt'),'A dependency input changed after the original run.');
  await assert.rejects(f.engine.run('phase.approve',confirm),{code:'ENGINE_SOURCE_CHANGED'});
  assert.equal((await f.observer.inspect()).snapshot.workflow.phases.intake.approvals.length,0);assert.equal(f.control.starts,1);
});
test('original risk errors survive and a lost acceptance acknowledgement recovers one record',{timeout:120000},async t=>{
  const f=await namespaceTestRiskFixture(t);f.human();let interrupted=false;
  const lost=Object.assign(Error('The actual acceptance acknowledgement was lost.'),{code:'SDA_NAMESPACE_OUTCOME_UNKNOWN'}),
    engine=f.make({records:{...f.records,async transact(scope,transaction,options){const result=await f.records.transact(scope,transaction,options);
      if(!interrupted&&transaction.operationId.startsWith('lifecycle-')&&transaction.changes.some(row=>row.namespace==='state'&&row.key.startsWith('stories/'))){interrupted=true;throw lost;}return result;}}});
  await assert.rejects(engine.run('decision.test-risk',f.request),error=>error===lost);
  const record=await engine.run('decision.test-risk',f.request);assert.equal(record.record.id,'TRR-001');
  await assert.rejects(f.engine.run('decision.test-risk',{...f.request,reason:f.request.reason+' An unnecessary duplicate.'}),{code:'TEST_RUN_RISK_ALREADY_RECORDED'});
  const snapshot=(await f.observer.inspect()).snapshot,original=snapshot.workflow.namespaceDecisionReceipts.find(row=>row.operation==='decision.test-risk').record;
  for(const code of ['EACCES','ETIMEDOUT','SDA_CONTENT_MISSING']){const failure=Object.assign(Error('The original human receipt is unavailable.'),{code,path:'original-risk-receipt',timeoutMs:300000}),
    denied=f.make({content:{...f.content,read(scope,reference,options){if(reference.sha256===original.sha256)throw failure;return f.content.read(scope,reference,options);}}});
    await assert.rejects(denied.run('test-risk.context',{phaseId:'intake'}),error=>error===failure);}
  assert.equal(snapshot.workflow.namespaceTestRunRisks.length,1);assert.equal(f.control.starts,0);
});
test('a pending approval can renew its exact expired risk without reopening or rewriting the published phase',{timeout:120000},async t=>{
  const f=await namespaceTestRiskFixture(t);f.human();await f.engine.run('decision.test-risk',f.request);f.author();await f.rebase('rebase-renewable-risk');
  await f.engine.run('phase.checks.run',f.input);await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
  await f.engine.run('phase.submit',{phaseId:'intake'});f.human();const before=(await f.observer.inspect()).snapshot,view=await f.engine.run('phase.review',{phaseId:'intake'}),r=view.manifest.reviewBinding,
    confirmation={phaseId:'intake',confirmation:{workId:f.inputs.workId,phase:'intake',generation:r.generation,reviewPacketSha256:r.packetSha256}};
  f.accessControl.now='2026-11-21T00:00:00.000Z';await assert.rejects(f.engine.run('phase.approve',confirmation),{code:'TEST_RUN_RISK_NOT_COVERED'});
  const renewed=await f.engine.run('decision.test-risk',{...f.request,expires:'2026-12-10',reason:'The independent reviewer renews only the original unavailable service risk until integration validation.'});
  assert.equal(renewed.record.id,'TRR-002');assert.equal(renewed.currentPhase,'intake');assert.equal(f.control.starts,1);
  const list=await f.engine.run('decisions.list',{phaseId:'intake'});assert.ok(list.manifest.policy.offered.some(row=>row.kind==='test-run-risk'));
  await f.engine.run('phase.approve',confirmation);const after=(await f.observer.inspect()).snapshot;
  assert.deepEqual(after.workflow.phases.intake.publicationBindings,before.workflow.phases.intake.publicationBindings);
  assert.deepEqual(after.workflow.phases.intake.namespaceSubmission,before.workflow.phases.intake.namespaceSubmission);
  assert.equal(after.workflow.phases.intake.status,'approved');assert.equal(after.workflow.namespaceTestRunRisks.length,2);assert.equal(f.control.starts,1);
});
