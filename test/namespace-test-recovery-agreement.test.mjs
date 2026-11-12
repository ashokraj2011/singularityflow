import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
import {namespacePhaseCheckPlanProfile} from '../src/foundation/record-schema.mjs';
const reason='The human reviewed all configured checks and the pinned bounded automatic repair policy.';
for(const backend of ['filesystem','sqlite','application'])test(backend+' recovery agreement is an actual human receipt used through independent publication and replay',async t=>{
  const f=await namespaceEngineFixture(t,{backend,configure(source){source.definition.testRecovery={enabled:true};}});await f.bootstrap();
  f.control.permissions.push('test-recovery.context','test-recovery.confirm');
  const first=await f.engine.run('test-recovery.context',{}),request={operationId:'confirm-recovery',phaseId:'intake',
    expectedContext:first.manifest.expectedContext,reason};
  const before=await f.capture();
  await assert.rejects(f.engine.run('test-recovery.confirm',{...request,expectedContext:'sha256:'+'0'.repeat(64)}),{code:'TEST_RECOVERY_CONFIRMATION_REQUIRED'});
  assert.deepEqual(await f.capture(),before);
  const confirmed=await f.engine.run('test-recovery.confirm',request);assert.equal(confirmed.record.context.executionMode,'all-configured');
  assert.equal(confirmed.record.context.maximumAutomaticAttempts,3);assert.equal(confirmed.record.revision,1);
  await assert.rejects(f.engine.run('test-recovery.confirm',{...request,operationId:'duplicate',
    expectedContext:(await f.engine.run('test-recovery.context',{})).manifest.expectedContext}),{code:'TEST_RECOVERY_ALREADY_CONFIRMED'});
  await f.author();await f.review();const closed=await f.capture();assert.equal(closed.workflow.status,'closed');f.asAuthor();
  assert.equal((await f.make({working:null}).run('test-recovery.confirm',request)).record.revision,1);
  assert.deepEqual(await f.capture(),closed);
});
test('original check plans retain their profile and recovery plans are explicitly versioned',()=>{
  assert.deepEqual(namespacePhaseCheckPlanProfile({schemaVersion:1}),{version:1,format:'sflow-namespace-phase-check-plan/v1',commands:false});
  assert.deepEqual(namespacePhaseCheckPlanProfile({schemaVersion:2}),{version:2,format:'sflow-namespace-phase-check-plan/v2',commands:true});
  assert.deepEqual(namespacePhaseCheckPlanProfile({schemaVersion:3}),{version:3,format:'sflow-namespace-phase-check-plan/v3',commands:true,recovery:true});
  assert.throws(()=>namespacePhaseCheckPlanProfile({schemaVersion:4}),{code:'SCHEMA_VERSION_FUTURE'});
});
