import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceKnownTestRiskFixture,knownFailureReason} from './helpers/namespace-known-test-risk-fixture.mjs';
const publish={phaseId:'build',authored:'governed-agent',channel:'copilot-host'};
for(const backend of ['filesystem','sqlite','application'])test('known failed sentinels stay executed beside a separately selected passing cohort: '+backend,{timeout:180000},async t=>{
 const f=await namespaceKnownTestRiskFixture(t,{backend,selective:true});f.human();
 const scope={phaseId:'build',baselineOperationId:'original-pre-feature-checks',selection:[{repositoryId:'app',commandId:'stable-tests',files:['test/stable-first.test.js']}]},
  view=(await f.engine.run('test-recovery.select-context',scope)).manifest;
 await f.engine.run('test-recovery.select-confirm',{...scope,operationId:'accept-independent-stable-selection',expectedContext:view.expectedContext,reason:knownFailureReason,
  expires:'2026-11-20',followUpOwner:'stable-suite-owners',remediationRef:'STABLE-1'});
 await f.engine.run('test-risk.confirm-known',f.request);f.author();await f.rebase('continue-known-and-selected');await f.retain('known-selected-source');
 const current=await f.run('known-selected-execution');assert.equal(current.verdict,'failed');
 assert.equal(current.checks.find(row=>row.id==='legacy-tests').tests.failed,1);assert.equal(current.checks.find(row=>row.id==='stable-tests').tests.passed,1);
 f.human();const input={phaseId:'build',baselineOperationId:'original-pre-feature-checks',observedOperationId:'known-selected-execution'},
  cohort=(await f.engine.run('test-cohort.context',input)).manifest;
 assert.equal(cohort.schemaVersion,2);assert.equal(cohort.execution.failedBaseline,true);
 assert.equal(cohort.selection.find(row=>row.commandId==='stable-tests').excludedIds.length,1);
 assert.equal(cohort.selection.find(row=>row.commandId==='legacy-tests').excludedIds.length,0);
 await f.engine.run('test-cohort.confirm',{...input,operationId:'review-known-baseline-cohort',expectedContext:cohort.expectedContext,reason:knownFailureReason,expires:'2026-11-20'});
 f.author();await f.rebase('continue-confirmed-known-cohort');await f.retain('known-cohort-current-source');await f.run('confirmed-known-selected-execution');
 await f.engine.run('phase.publish',publish);const p=await f.json((await f.capture()).workflow.phases.build.publicationBindings[0].record),
  risk=await f.json((await f.json(p.policyEvidence.find(row=>row.kind==='known-test-risk/v2').record)).report);
 assert.ok(p.policyEvidence.some(row=>row.kind==='code-delivery/v44'));assert.ok(p.policyEvidence.some(row=>row.kind==='test-cohort/v3'));
 assert.equal(p.checks,null);assert.equal(risk.testsPassed,false);assert.equal(risk.selection.rows[0].excludedIds[0],'stable:second');
 assert.equal(risk.observations.find(row=>row.commandId==='legacy-tests').failedCases.length,1);
 await f.engine.run('phase.submit',{phaseId:'build'});f.human();const binding=(await f.engine.run('phase.review',{phaseId:'build'})).manifest.reviewBinding;
 await f.engine.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:binding.generation,reviewPacketSha256:binding.packetSha256}});
 assert.equal((await f.engine.run('story.evidence',{})).manifest.report.completion.kind,'complete-with-exceptions');assert.equal(f.starts(),12);
});
