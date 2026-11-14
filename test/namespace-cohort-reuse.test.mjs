import test from 'node:test';import assert from 'node:assert/strict';import {rm} from 'node:fs/promises';
import {namespaceObservedCohortFixture,cohortReason} from './helpers/namespace-observed-cohort-fixture.mjs';
const publish={phaseId:'build',authored:'governed-agent',channel:'copilot-host'};
for(const backend of ['filesystem','sqlite','application'])test('observed cohort and reused execution keep independent permission and original attribution: '+backend,{timeout:180000},async t=>{
 const f=await namespaceObservedCohortFixture(t,backend,{qualified:true});f.control.permissions.push('evidence-reuse.context','decision.evidence-reuse','story.evidence');
 f.human();await f.engine.run('test-cohort.confirm',f.request);
 const engine=f.make({checks:{...f.checks,codeRecoveryReuse:true}}),producer={producerPhaseId:'build',producerOperationId:'selected-suite'},
  view=(await engine.run('evidence-reuse.context',{phaseId:'build',...producer})).manifest;
 assert.equal(view.candidates.length,1);await engine.run('decision.evidence-reuse',{phaseId:'build',...producer,attemptId:view.candidates[0].taskId,reason:cohortReason,expires:'2026-11-25'});
 f.author();await f.rebase('rebase-reused-cohort');await f.retain('retained-reused-cohort');await engine.run('phase.publish',publish);
 const p=await f.json((await f.capture()).workflow.phases.build.publicationBindings[0].record),
  cohort=await f.json((await f.json(p.policyEvidence.find(row=>row.kind==='test-cohort/v3').record)).report);
 assert.equal(p.checks,null);assert.equal(cohort.testsReused,true);assert.equal(cohort.reuse.receiverExecuted,false);
 assert.equal(cohort.selection[0].excludedIds.length,1);assert.equal(cohort.checks.operationId,'selected-suite');assert.equal(f.starts(),2);
 assert.equal((await engine.run('phase.prepublish',{phaseId:'build'})).manifest.readiness.requiredTests,'reused-not-executed');
 f.control.now='2026-11-21T00:00:00.000Z';await assert.rejects(engine.run('phase.submit',{phaseId:'build'}),{code:'TEST_COHORT_NOT_COVERED'});
 f.human();await engine.run('test-cohort.confirm',{...f.request,operationId:'renew-original-cohort',expires:'2026-12-01'});
 f.author();await engine.run('phase.submit',{phaseId:'build'});f.human();const binding=(await engine.run('phase.review',{phaseId:'build'})).manifest.reviewBinding;
 await engine.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:binding.generation,reviewPacketSha256:binding.packetSha256}});
 assert.equal(f.starts(),2);assert.equal((await engine.run('story.evidence',{})).manifest.report.completion.kind,'complete-with-exceptions');
 await rm(f.root,{recursive:true,force:true});const offline=f.make({working:null,sources:[],checks:{mode:'retained-only'},clock:{now(){throw Error('Receipt replay cannot restamp original evidence.');}}});
 assert.equal((await offline.run('phase.publish',publish)).status,'retained');
});
test('explicit successor cohort review keeps its receiving generation and original observed execution separate',{timeout:180000},async t=>{
 const f=await namespaceObservedCohortFixture(t,'sqlite',{qualified:true});f.human();
 const input={phaseId:'build',baselineOperationId:'baseline-suite',observedOperationId:'selected-suite',observedPhaseId:'build',candidateGeneration:2};
 await assert.rejects(f.engine.run('test-cohort.context',input),{code:'TEST_COHORT_INVALID'});
 await f.engine.run('test-cohort.confirm',f.request);f.author();await f.rebase('continue-original-cohort');await f.retain('original-cohort-current-source');await f.run('original-cohort-current-checks');
 await f.engine.run('phase.publish',publish);const starts=f.starts();f.human();const view=(await f.engine.run('test-cohort.context',input)).manifest;
 assert.equal(view.generation,2);assert.equal(view.execution.generation,1);assert.equal(view.execution.phase,'build');
 const decision=await f.engine.run('test-cohort.confirm',{...input,operationId:'review-successor-cohort',expectedContext:view.expectedContext,reason:cohortReason,expires:'2026-11-25'});
 assert.equal(decision.record.generation,2);assert.equal(decision.record.context.generation,2);assert.equal(decision.record.context.execution.generation,1);
 assert.equal((await f.capture()).workflow.phases.build.generation,1);assert.equal(f.starts(),starts);
});
