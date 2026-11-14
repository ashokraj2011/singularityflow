import test from 'node:test';import assert from 'node:assert/strict';import {readFile,writeFile,rm} from 'node:fs/promises';import path from 'node:path';
import {namespaceCodeReuseFixture,reuseReason} from './helpers/namespace-code-reuse-fixture.mjs';
import {namespaceEvidenceReuseFixture} from './helpers/namespace-evidence-reuse-fixture.mjs';
const publish={phaseId:'build',authored:'governed-agent',channel:'copilot-host'};
test('old artifact hosts cannot reinterpret an exact raw execution as a v1 approved producer',{timeout:120000},async t=>{
 const f=await namespaceEvidenceReuseFixture(t,{backend:'sqlite'});
 await assert.rejects(f.engine.run('evidence-reuse.context',{phaseId:'assess',producerPhaseId:'produce',producerOperationId:'original'}),
  error=>error.code==='ENGINE_PORT_UNAVAILABLE'&&error.details.required[0]==='qualified-code-recovery-reuse');
 await assert.rejects(f.engine.run('evidence-reuse.context',{phaseId:'assess',producerPhaseId:'produce'}),{code:'ENGINE_INPUT_INVALID'});
 for(const producerOperationId of ['', ' ', 'x'.repeat(513)])await assert.rejects(f.engine.run('evidence-reuse.context',{phaseId:'assess',producerOperationId}),{code:'ENGINE_INPUT_INVALID'});
 await assert.rejects(f.engine.run('decision.evidence-reuse',{phaseId:'assess',producerPhaseId:'produce',attemptId:'actual',reason:reuseReason}),{code:'EVIDENCE_REUSE_INVALID'});
});
test('the original no-reuse agreement and actual failed execution cannot authorize Code reuse',{timeout:120000},async t=>{
 const old=await namespaceCodeReuseFixture(t,{recovery:true,recoveryReuse:'never'});
 await assert.rejects(old.view(),error=>error.code==='ENGINE_EVIDENCE_REUSE_AGREEMENT_REQUIRED'
  &&error.details.actions.some(row=>row.operation==='test-recovery.context'));assert.equal(old.starts(),1);
 const failed=await namespaceCodeReuseFixture(t,{testSource:"import test from 'node:test';import assert from 'node:assert/strict';\n// @ac:STORY-1:AC-001\ntest('converts the approved value',()=>assert.equal(1,2));\n"});
 await assert.rejects(failed.view(),{code:'EVIDENCE_REUSE_NOT_ELIGIBLE'});assert.equal(failed.starts(),1);
});
test('source, dependencies, environment and real read failures cannot be hidden by Code reuse',{timeout:120000},async t=>{
 const f=await namespaceCodeReuseFixture(t,{recovery:true}),view=await f.view(),request={phaseId:'build',...f.producer,attemptId:view.manifest.candidates[0].taskId,reason:reuseReason};f.human();
 const source=path.join(f.root,'src/converter.js'),original=await readFile(source);await writeFile(source,String(original)+'\n// Changed after the original execution.\n');
 await assert.rejects(f.engine.run('decision.evidence-reuse',request),{code:'ENGINE_SOURCE_CHANGED'});await writeFile(source,original);
 const dependency=path.join(f.root,'package-lock.json');await writeFile(dependency,'{}\n');
 await assert.rejects(f.engine.run('decision.evidence-reuse',request),{code:'ENGINE_SOURCE_CHANGED'});await rm(dependency);
 const rebind=read=>f.make({checks:{...f.checks,bindings:f.checks.bindings.map(row=>({...row,unit:{...row.unit,observeEnvironment:read(row.unit)}}))}});
 for(const code of ['EACCES','ETIMEDOUT'])await assert.rejects(rebind(()=>async()=>{throw Object.assign(new Error('Actual qualified environment read failed.'),{code,path:f.root});}).run('decision.evidence-reuse',request),
  error=>error.code===code&&error.path===f.root);
 const moved=rebind(unit=>async(...args)=>{const value=await unit.observeEnvironment(...args);return {...value,qualification:{...value.qualification,hostId:'different-host'}};});
 await assert.rejects(moved.run('decision.evidence-reuse',request),{code:'ENGINE_EVIDENCE_REUSE_ENVIRONMENT_CHANGED'});
 const accepted=await f.engine.run('decision.evidence-reuse',request);assert.equal(accepted.record.schemaVersion,3);
 assert.deepEqual((await f.engine.run('decision.evidence-reuse',request)).record,accepted.record);
 await assert.rejects(f.engine.run('decision.evidence-reuse',{...request,reason:reuseReason+' A duplicate is not another permission.'}),{code:'EVIDENCE_REUSE_ALREADY_RECORDED'});
 await f.rebase();await assert.rejects(moved.run('phase.publish',publish),{code:'ENGINE_EVIDENCE_REUSE_ENVIRONMENT_CHANGED'});
 await f.engine.run('phase.publish',publish);await assert.rejects(moved.run('phase.submit',{phaseId:'build'}),{code:'ENGINE_EVIDENCE_REUSE_ENVIRONMENT_CHANGED'});
 await f.engine.run('phase.submit',{phaseId:'build'});f.human();const binding=(await f.engine.run('phase.review',{phaseId:'build'})).manifest.reviewBinding;
 await assert.rejects(moved.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:binding.generation,reviewPacketSha256:binding.packetSha256}}),{code:'ENGINE_EVIDENCE_REUSE_ENVIRONMENT_CHANGED'});
 assert.equal((await f.capture()).workflow.phases.build.approvals.length,0);assert.equal(f.starts(),1);
});
test('recovery evidence age is enforced without mutating the original execution or approval authority',{timeout:120000},async t=>{
 const f=await namespaceCodeReuseFixture(t,{recovery:true,configure:source=>{source.definition.testRecovery.maxEvidenceAgeSeconds=1;}}),view=await f.view(),request={phaseId:'build',...f.producer,attemptId:view.manifest.candidates[0].taskId,reason:reuseReason};
 f.human();const at=f.control.now;f.control.now='2026-11-08T00:00:02.000Z';
 const stale=(await f.view()).manifest;assert.equal(stale.candidates[0].evidenceAge.eligible,false);
 assert.ok(!stale.actions.some(row=>row.operation==='decision.evidence-reuse'));assert.ok(stale.actions.some(row=>row.operation==='phase.checks.run'));
 await assert.rejects(f.engine.run('decision.evidence-reuse',request),error=>error.code==='ENGINE_EVIDENCE_REUSE_TOO_OLD'&&error.details.actions[0].operation==='phase.checks.run');
 f.control.now=at;await f.engine.run('decision.evidence-reuse',request);await f.rebase();f.control.now='2026-11-08T00:00:02.000Z';
 await assert.rejects(f.engine.run('phase.publish',publish),{code:'ENGINE_EVIDENCE_REUSE_TOO_OLD'});
 assert.equal((await f.capture()).workflow.namespaceEvidenceReuses.length,1);assert.equal(f.starts(),1);
});
