import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceSelectiveTestRecoveryFixture,selectionReason} from './helpers/namespace-selective-test-recovery-fixture.mjs';
import {converterSource} from './helpers/namespace-source-clause-fixture.mjs';
const publish={phaseId:'build',authored:'governed-agent',channel:'copilot-host'},
 serviceTest="import test from 'node:test';import assert from 'node:assert/strict';import net from 'node:net';import {once} from 'node:events';\n"
  +"import {convert,remoteRequired} from '../src/converter.js';\n// @ac:STORY-1:AC-001\n"
  +"test('converts the approved value',async()=>{assert.equal(convert(255),'FF');if(!remoteRequired)return;const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));await once(net.connect({host:'127.0.0.1',port}),'connect');});\n";
for(const backend of ['filesystem','sqlite','application'])test('selected execution retains its real environment failure and independent scope permission: '+backend,{timeout:180000},async t=>{
 const f=await namespaceSelectiveTestRecoveryFixture(t,{backend,baselineSource:converterSource+'export const remoteRequired=false;\n',source:converterSource+'export const remoteRequired=true;\n',
  baselineTestSource:serviceTest,testSource:serviceTest,configure:source=>source.definition.testRecovery.enabledRiskCategories.push('validation-unavailable')});
 f.control.permissions.push('test-risk.context','test-risk.confirm-recovery','test-cohort.context','test-cohort.confirm');const selection=await f.confirm();f.human();
 const risk=(await f.engine.run('test-risk.context',{phaseId:'build'})).manifest,command=risk.commands.find(row=>row.command.id==='node-tests');
 await f.engine.run('test-risk.confirm-recovery',{operationId:'accept-actual-service-unavailable',phaseId:'build',expectedRecovery:risk.expectedRecovery,
  commandId:'node-tests',argvSha256:command.argvSha256,causeClass:'service-unreachable',cause:'The local integration service is genuinely unavailable.',
  reason:selectionReason,expires:'2026-11-19'});
 await f.rebase();const run=await f.run();assert.equal(run.verdict,'failed');assert.equal(run.checks.find(row=>row.id==='node-tests').tests.failed,1);
 assert.equal(run.checks.find(row=>row.id==='legacy-tests').tests.passed,1);
 f.human();const cohortInput={phaseId:'build',baselineOperationId:'pre-feature-full-execution',observedOperationId:'selected-receiving-execution'},
  cohort=(await f.engine.run('test-cohort.context',cohortInput)).manifest;
 assert.equal(cohort.schemaVersion,2);assert.equal(cohort.execution.verdict,'failed');assert.equal(cohort.newExecutionClaimed,false);
 await f.engine.run('test-cohort.confirm',{...cohortInput,operationId:'accept-independent-observed-scope',expectedContext:cohort.expectedContext,reason:selectionReason,expires:'2026-11-20'});
 await f.rebase('rebase-risk-and-cohort');await f.run('cohort-confirmed-failed-execution');
 f.control.now='2026-11-20T00:00:00.000Z';await assert.rejects(f.engine.run('phase.publish',publish),{code:'TEST_RUN_RISK_NOT_COVERED'});
 f.control.now='2026-11-08T00:00:00.000Z';await f.engine.run('phase.publish',publish);
 const p=await f.json((await f.capture()).workflow.phases.build.publicationBindings[0].record),
  riskReport=await f.json((await f.json(p.policyEvidence.find(row=>row.kind==='test-risk/v4').record)).report),
  recovery=await f.json((await f.json(p.policyEvidence.find(row=>row.kind==='test-recovery/v6').record)).report);
 assert.equal(p.checks,null);assert.ok(p.policyEvidence.some(row=>row.kind==='code-delivery/v43'));
 assert.equal(riskReport.testsPassed,false);assert.equal(riskReport.selection.record.id,'STR-001');assert.equal(recovery.executed[0].tests.failed,1);
 assert.equal(recovery.excluded[0].outcome,'not-run');assert.equal(recovery.executionMode,'selected-with-execution-risk');assert.equal(recovery.riskKind,'environment');
 assert.equal((await f.engine.run('phase.prepublish',{phaseId:'build'})).manifest.qualityDisposition,'ready');
 f.human();await f.engine.run('test-recovery.select-confirm',{operationId:'withdraw-selected-scope',revoke:'STR-001',reason:selectionReason});
 f.author();await assert.rejects(f.engine.run('phase.submit',{phaseId:'build'}),{code:'SELECTIVE_TEST_RECOVERY_NOT_CURRENT'});
 f.human();await f.engine.run('test-recovery.select-confirm',{...selection.request,operationId:'renew-original-selected-scope'});
 f.author();await f.engine.run('phase.submit',{phaseId:'build'});f.human();const binding=(await f.engine.run('phase.review',{phaseId:'build'})).manifest.reviewBinding;
 await f.engine.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:binding.generation,reviewPacketSha256:binding.packetSha256}});
 assert.equal(f.starts(),6);const evidence=(await f.engine.run('story.evidence',{})).manifest;assert.equal(evidence.report.completion.kind,'complete-with-exceptions');
});
