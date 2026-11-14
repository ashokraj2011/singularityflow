import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceCodeReuseFixture,reuseReason} from './helpers/namespace-code-reuse-fixture.mjs';
import {verificationWorkflow,codeInputArtifact} from './helpers/namespace-code-input-fixture.mjs';
const publish={authored:'governed-agent',channel:'copilot-host'};
test('artifact recovery consumes an actually approved full execution without running it again',{timeout:120000},async t=>{
 const f=await namespaceCodeReuseFixture(t,{recovery:true,configure:source=>{verificationWorkflow(source);
  source.definition.phases.verify.qualityCommands=structuredClone(source.definition.phases.build.qualityCommands);}});
 async function approve(engine,phaseId){await engine.run('phase.submit',{phaseId});f.human();const binding=(await engine.run('phase.review',{phaseId})).manifest.reviewBinding;
  await engine.run('phase.approve',{phaseId,confirmation:{workId:f.inputs.workId,phase:phaseId,generation:binding.generation,reviewPacketSha256:binding.packetSha256}});}
 await f.engine.run('phase.publish',{phaseId:'build',...publish});await approve(f.engine,'build');
 const checks={...f.checks,bindings:[...f.checks.bindings,...f.checks.bindings.map(row=>({...row,phaseId:'verify'}))]},engine=f.make({checks});
 f.author();f.control.agentId='verifier';await engine.run('phase.prepare',{phaseId:'verify'});const draft=await engine.run('phase.draft.read',{phaseId:'verify'});
 await engine.run('phase.draft.write',{operationId:'author-qualified-recovery',workId:f.inputs.workId,phaseId:'verify',expectedRevision:draft.manifest.draft.revision,
  content:await f.upload(codeInputArtifact),reason:reuseReason});f.human();
 const view=(await engine.run('evidence-reuse.context',{phaseId:'verify'})).manifest,candidate=view.candidates[0];
 assert.ok(candidate.publication.record);assert.ok(candidate.submission.record);assert.equal(candidate.environmentMatches,true);
 const reused=await engine.run('decision.evidence-reuse',{phaseId:'verify',attemptId:candidate.taskId,reason:reuseReason});assert.equal(reused.record.schemaVersion,3);
 f.author();f.control.agentId='verifier';const changed=await engine.run('phase.draft.read',{phaseId:'verify'});
 await engine.run('phase.draft.rebase',{operationId:'retain-approved-recovery-basis',workId:f.inputs.workId,phaseId:'verify',expectedRevision:changed.manifest.draft.revision,confirm:changed.manifest.draft.bodySha256,reason:reuseReason});
 await engine.run('phase.publish',{phaseId:'verify',...publish});const state=await f.capture(),value=await f.json(state.workflow.phases.verify.publicationBindings[0].record),
  binding=value.policyEvidence.find(row=>row.kind==='test-recovery/v3'),manifest=await f.json(binding.record),report=await f.json(manifest.report);
 assert.equal(value.checks,null);assert.equal(report.executionMode,'reused-full-execution');assert.equal(report.receiverExecuted,false);
 assert.equal(report.reuse.checks.operationId,f.producer.producerOperationId);await approve(engine,'verify');assert.equal(f.starts(),1);
 f.control.permissions.push('story.evidence');assert.equal((await engine.run('story.evidence',{})).manifest.report.completion.kind,'complete');
});
