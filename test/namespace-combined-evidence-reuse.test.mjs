import test from 'node:test';import assert from 'node:assert/strict';import {readFile,writeFile,rm} from 'node:fs/promises';import {createHash} from 'node:crypto';import path from 'node:path';
import {namespaceSelectiveTestRecoveryFixture,selectionReason} from './helpers/namespace-selective-test-recovery-fixture.mjs';
import {namespaceCodeReuseFixture,reuseReason} from './helpers/namespace-code-reuse-fixture.mjs';
import {createEnvironmentQualifiedNodeCommandExecutionUnit} from '../src/sgos/node-check-execution-unit.mjs';
const publish={phaseId:'build',authored:'governed-agent',channel:'copilot-host'};
for(const backend of ['filesystem','sqlite','application'])test('selected-scope risk and qualified reuse retain separate permissions and no receiving execution: '+backend,{timeout:180000},async t=>{
  const f=await namespaceSelectiveTestRecoveryFixture(t,{backend,reuse:'environment-qualified-selected',configure:source=>{
    source.definition.testRecovery.reuseProfile='environment-qualified-selected/v1';
  }});f.control.permissions.push('evidence-reuse.context','decision.evidence-reuse');await f.confirm();await f.rebase();const original=await f.run();assert.equal(original.verdict,'passed');const started=f.starts();
  const checks={...f.checks,combinedEvidenceReuse:true},engine=f.make({checks}),producer={producerPhaseId:'build',producerOperationId:'selected-receiving-execution'};
  f.human();const view=await engine.run('evidence-reuse.context',{phaseId:'build',...producer});assert.equal(view.manifest.schemaVersion,4);
  assert.equal(view.manifest.candidates.length,2);assert.ok(view.manifest.candidates.every(row=>row.environmentMatches));
  const requests=[],acceptedRecords=[];for(const candidate of view.manifest.candidates){const request={phaseId:'build',...producer,attemptId:candidate.taskId,reason:reuseReason,expires:'2026-11-19'};requests.push(request);
    const accepted=await engine.run('decision.evidence-reuse',request);assert.equal(accepted.record.schemaVersion,4);assert.equal(accepted.record.selection.rows[0].excludedIds[0],'legacy:second');}
  await f.rebase('rebase-selected-reuse');await engine.run('phase.publish',publish);const state=await f.capture(),p=await f.json(state.workflow.phases.build.publicationBindings[0].record);
  assert.equal(p.checks,null);assert.ok(p.policyEvidence.some(row=>row.kind==='code-delivery/v41'));assert.ok(p.policyEvidence.some(row=>row.kind==='test-recovery/v5'));
  const reuse=await f.json((await f.json(p.policyEvidence.find(row=>row.kind==='evidence-reuse/v4').record)).report);
  assert.equal(reuse.testsExecutedByReceiver,false);assert.equal(reuse.selection.rows[0].excludedIds[0],'legacy:second');assert.ok(reuse.selectionPermission.decision);
  await engine.run('phase.submit',{phaseId:'build'});f.human();const binding=(await engine.run('phase.review',{phaseId:'build'})).manifest.reviewBinding;
  await engine.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:binding.generation,reviewPacketSha256:binding.packetSha256}});
  acceptedRecords.push(...(await f.capture()).workflow.namespaceEvidenceReuses);
  assert.equal(f.starts(),started);await rm(f.root,{recursive:true,force:true});const offline=f.make({working:null,sources:[],checks:{mode:'retained-only'},clock:{now(){throw Error('Replay cannot restamp evidence.');}}});
  for(const [index,request]of requests.entries())assert.deepEqual((await offline.run('decision.evidence-reuse',request)).record,acceptedRecords[index]);
});
test('full-only reuse cannot borrow selected evidence, and either permission can expire independently',{timeout:180000},async t=>{
  const f=await namespaceSelectiveTestRecoveryFixture(t,{reuse:'environment-qualified-selected',configure:source=>{source.definition.testRecovery.reuseProfile='environment-qualified-selected/v1';}});
  f.control.permissions.push('evidence-reuse.context','decision.evidence-reuse');
  await f.confirm();await f.rebase();await f.run();const producer={producerPhaseId:'build',producerOperationId:'selected-receiving-execution'};
  await assert.rejects(f.make({checks:{...f.checks,codeRecoveryReuse:true}}).run('evidence-reuse.context',{phaseId:'build',...producer}),{code:'EVIDENCE_REUSE_NOT_ELIGIBLE'});
  const engine=f.make({checks:{...f.checks,combinedEvidenceReuse:true}});f.human();const view=await engine.run('evidence-reuse.context',{phaseId:'build',...producer});
  for(const row of view.manifest.candidates)await engine.run('decision.evidence-reuse',{phaseId:'build',...producer,attemptId:row.taskId,reason:reuseReason,expires:'2026-11-19'});
  await f.rebase('rebase-two-permissions');f.control.now='2026-11-19T23:59:59.999Z';
  await assert.rejects(engine.run('phase.publish',publish),{code:'ENGINE_EVIDENCE_REUSE_INCOMPLETE'});
  f.control.now='2026-11-08T00:00:00.000Z';f.human();await engine.run('test-recovery.select-confirm',{operationId:'revoke-original-selected-scope',revoke:'STR-001',reason:selectionReason});await f.rebase('rebase-revoked-scope');
  await assert.rejects(engine.run('phase.publish',publish),{code:'SELECTIVE_TEST_RECOVERY_NOT_CURRENT'});
});
test('qualified mixed compile/test reuse preserves real command results and refuses changed inputs',{timeout:180000},async t=>{
  const f=await namespaceCodeReuseFixture(t,{run:false,configure:source=>{source.definition.phases.build.qualityCommands.push({id:'syntax',kind:'compile',argv:['node','--check','src/converter.js'],modelPolicy:'never',timeoutMs:300000,requirement:'required'});}}),
    executableSha256='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex'),
    unit=await createEnvironmentQualifiedNodeCommandExecutionUnit({id:'qualified-compiler',hostId:'qualified-code-host',root:f.root,projectId:f.scope.projectId,repositoryId:'app',content:f.content,
      commandKind:'compile',command:{executable:process.execPath,executableSha256,arguments:['--check','src/converter.js'],environment:{}},authorizeCommand:m=>m.manifestSha256}),
    checks={...f.checks,combinedEvidenceReuse:true,bindings:[...f.checks.bindings,{phaseId:'build',commandId:'syntax',repositoryId:'app',executable:'node',executableSha256,environment:{},unit}]},engine=f.make({checks});
  await engine.run('phase.checks.run',f.runInput);f.human();const view=await engine.run('evidence-reuse.context',{phaseId:'build',...f.producer});assert.equal(view.manifest.candidates.length,2);
  assert.equal(view.manifest.candidates.find(row=>row.command.id==='syntax').tests,null);
  for(const row of view.manifest.candidates)await engine.run('decision.evidence-reuse',{phaseId:'build',...f.producer,attemptId:row.taskId,reason:reuseReason});
  await f.rebase();const file=path.join(f.root,'src/converter.js'),original=await readFile(file);await writeFile(file,String(original)+'\n// Current source changed\n');
  await assert.rejects(engine.run('phase.publish',publish),error=>['ENGINE_SOURCE_CHANGED','ENGINE_EVIDENCE_REUSE_INCOMPLETE'].includes(error.code));await writeFile(file,original);
  await engine.run('phase.publish',publish);const p=await f.json((await f.capture()).workflow.phases.build.publicationBindings[0].record);assert.ok(p.policyEvidence.some(row=>row.kind==='code-delivery/v42'));assert.equal(p.checks,null);
  await engine.run('phase.submit',{phaseId:'build'});f.human();const binding=(await engine.run('phase.review',{phaseId:'build'})).manifest.reviewBinding;
  await engine.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:binding.generation,reviewPacketSha256:binding.packetSha256}});
});
