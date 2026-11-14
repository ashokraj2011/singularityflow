import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,writeFile,rm} from 'node:fs/promises';import path from 'node:path';
import {namespaceSelectiveTestRecoveryFixture,selectionReason} from './helpers/namespace-selective-test-recovery-fixture.mjs';
import {createNamespacePublicationPolicyReader} from '../src/engine-storage/namespace-policy-reader.mjs';
import {createNamespacePhaseCheckReader} from '../src/engine-storage/namespace-phase-check-reader.mjs';
const publish={phaseId:'build',authored:'governed-agent',channel:'copilot-host'};
for(const backend of ['filesystem','sqlite','application'])test('reviewed independent selection runs only complete selected files and retains honest Code evidence: '+backend,{timeout:180000},async t=>{
  const f=await namespaceSelectiveTestRecoveryFixture(t,{backend}),{request,result,view}=await f.confirm();
  assert.equal(view.manifest.impactComplete,false);assert.deepEqual(view.manifest.rows[0].selectedIds,['legacy:first']);assert.deepEqual(view.manifest.rows[0].excludedIds,['legacy:second']);
  assert.equal(result.record.id,'STR-001');await f.rebase();const run=await f.run();
  assert.equal(run.verdict,'passed');assert.equal(run.checks.find(row=>row.id==='legacy-tests').tests.passed,1);assert.equal(f.starts(),4);
  assert.equal(run.execution.completeSuiteClaimed,false);assert.deepEqual(run.execution.unexecuted[0].testIds,['legacy:second']);
  await f.engine.run('phase.publish',publish).catch(error=>{throw Object.assign(new Error(JSON.stringify({code:error.code,message:error.message,details:error.details,stack:error.stack,cause:error.cause?.message})),{cause:error});});
  const s=await f.capture(),p=await f.json(s.workflow.phases.build.publicationBindings[0].record),b=p.policyEvidence.find(row=>row.kind==='test-recovery/v2'),m=await f.json(b.record),report=await f.json(m.report);
  assert.equal(report.executionMode,'reviewed-file-selection');assert.equal(report.executed.find(row=>row.id==='legacy-tests').tests.discovered,1);
  assert.deepEqual(report.excluded,[{repositoryId:'app',commandId:'legacy-tests',testId:'legacy:second',outcome:'not-run'}]);
  assert.ok(p.policyEvidence.some(row=>row.kind==='code-delivery/v38'));
  const relabelled=structuredClone(p);relabelled.policyEvidence.find(row=>row.kind==='test-recovery/v2').kind='test-recovery/v1';
  await assert.rejects(createNamespacePublicationPolicyReader({observer:f.observer,scope:f.scope,workId:f.inputs.workId,
    checks:createNamespacePhaseCheckReader({...f.options,observer:f.observer})}).verify(relabelled),{code:'ENGINE_STORAGE_CORRUPT'});
  await f.engine.run('phase.submit',{phaseId:'build'});f.human();const binding=(await f.engine.run('phase.review',{phaseId:'build'})).manifest.reviewBinding;
  await f.engine.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:binding.generation,reviewPacketSha256:binding.packetSha256}});
  await rm(f.root,{recursive:true,force:true});const offline=f.make({working:null,sources:[],checks:{mode:'retained-only'},clock:{now(){throw Error('Original records cannot restamp time.');}}});
  assert.equal((await offline.run('test-recovery.select-confirm',request)).status,'retained');
  f.author();
  assert.equal((await offline.run('phase.checks.run',{operationId:'selected-receiving-execution',workId:f.inputs.workId,phaseId:'build'})).replayed,true);assert.equal(f.starts(),4);
});
test('selection preserves authority, exact context, original baseline and the full-run fallback',{timeout:120000},async t=>{
  const f=await namespaceSelectiveTestRecoveryFixture(t),view=await f.view();f.human();
  const request={...f.contextInput,operationId:'human-selection',expectedContext:view.manifest.expectedContext,reason:selectionReason,expires:'2026-11-20',followUpOwner:'suite-owner',remediationRef:'FIX-1'};
  await assert.rejects(f.engine.run('test-recovery.select-confirm',{...request,expectedContext:'sha256:'+'0'.repeat(64)}),{code:'SELECTIVE_TEST_RECOVERY_CONTEXT_CHANGED'});
  f.control.creator.email='outside@example.test';await assert.rejects(f.engine.run('test-recovery.select-confirm',request),{code:'APPROVAL_IDENTITY_NOT_AUTHORIZED'});f.human();
  await f.engine.run('test-recovery.select-confirm',request);
  await assert.rejects(f.engine.run('test-recovery.select-confirm',{...request,operationId:'duplicate-selection'}),{code:'SELECTIVE_TEST_RECOVERY_ALREADY_CONFIRMED'});
  await f.engine.run('test-recovery.select-confirm',{operationId:'revoke-selection',revoke:'STR-001',reason:'Return this generation to the complete configured test command inventory.'});await f.rebase();
  const full=await f.run('full-receiving-execution');assert.equal(full.checks.find(row=>row.id==='legacy-tests').tests.discovered,2);assert.equal(full.verdict,'passed');
  await assert.rejects(f.engine.run('test-recovery.select-context',{...f.contextInput,baselineOperationId:'full-receiving-execution'}),{code:'SELECTIVE_TEST_BASELINE_REQUIRED'});
});
test('changed tests, dependencies, source and expired selection cannot inherit the reviewed scope',{timeout:120000},async t=>{
  const f=await namespaceSelectiveTestRecoveryFixture(t),file=path.join(f.root,'test/second.test.js'),original=await readFile(file,'utf8');
  await writeFile(file,original+'\n// Changed independent test input\n');
  await assert.rejects(f.view(),{code:'SELECTIVE_TEST_REQUIRED_FILE_EXCLUDED'});await writeFile(file,original);
  await writeFile(path.join(f.root,'package-lock.json'),'{}\n');await assert.rejects(f.view(),{code:'SELECTIVE_TEST_PROTECTED_INPUT_CHANGED'});await rm(path.join(f.root,'package-lock.json'));
  await f.confirm();await f.rebase();await f.run();
  await writeFile(path.join(f.root,'src/converter.js'),(await readFile(path.join(f.root,'src/converter.js'),'utf8'))+'\n// new source after reviewed execution\n');
  await assert.rejects(f.engine.run('phase.publish',publish),error=>['ENGINE_SOURCE_CHANGED','ENGINE_CODE_CHECK_SOURCE_MISMATCH'].includes(error.code));
});
