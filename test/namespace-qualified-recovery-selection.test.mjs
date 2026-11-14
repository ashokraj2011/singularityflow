import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceSelectiveTestRecoveryFixture,selectionReason} from './helpers/namespace-selective-test-recovery-fixture.mjs';
test('the qualified agreement preserves actual selected execution and cannot relabel it full-suite reuse',{timeout:120000},async t=>{
 const f=await namespaceSelectiveTestRecoveryFixture(t,{reuse:'environment-qualified-exact',configure:source=>{source.definition.testRecovery.reuseProfile='environment-qualified-exact/v1';}});
 await f.confirm();await f.rebase();const checked=await f.run();assert.equal(checked.verdict,'passed');
 const publish={phaseId:'build',authored:'governed-agent',channel:'copilot-host'};await f.engine.run('phase.publish',publish);
 const state=await f.capture(),publication=await f.json(state.workflow.phases.build.publicationBindings[0].record),
  binding=publication.policyEvidence.find(row=>row.kind==='test-recovery/v3'),manifest=await f.json(binding.record),report=await f.json(manifest.report);
 assert.equal(report.agreement.schemaVersion,2);assert.equal(report.executionMode,'reviewed-file-selection');assert.equal(report.excluded.length,1);assert.equal(report.excluded[0].outcome,'not-run');
 f.control.permissions.push('evidence-reuse.context');const extended=f.make({checks:{...f.checks,codeRecoveryReuse:true}});
 await assert.rejects(extended.run('evidence-reuse.context',{phaseId:'build',producerPhaseId:'build',producerOperationId:'selected-receiving-execution'}),{code:'EVIDENCE_REUSE_NOT_ELIGIBLE'});
 await f.engine.run('phase.submit',{phaseId:'build'});f.human();const reviewed=(await f.engine.run('phase.review',{phaseId:'build'})).manifest.reviewBinding;
 await f.engine.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:reviewed.generation,reviewPacketSha256:reviewed.packetSha256}});
 const evidence=(await f.engine.run('story.evidence',{})).manifest;assert.equal(evidence.report.completion.kind,'complete-with-exceptions');
 assert.ok(evidence.excluded.some(row=>row.reason==='reviewed-unselected-baseline-cases-are-not-executed'));assert.equal(f.starts(),4);
});
