import test from 'node:test';
import assert from 'node:assert/strict';
import {namespaceApprovalFixture} from './helpers/namespace-approval-fixture.mjs';
import {createNamespaceSubmissionEngine} from '../src/engine-storage/namespace-submission.mjs';
import {canonicalJson} from '../src/foundation/record-schema.mjs';
const submit=f=>createNamespaceSubmissionEngine({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,
  authority:f.authority,access:f.access,clock:f.clock});
test('missing and inherited phase names never become a generation or approval opportunity',async t=>{
  const f=await namespaceApprovalFixture(t),head=await f.head(),clockCalls=f.control.clockCalls;
  for(const phaseId of ['missing-phase','constructor','toString','__proto__'])for(const [engine,operation]of [[f.makeApproval(),'phase.approve'],[submit(f),'phase.submit']]) {
    await assert.rejects(engine.run(operation,{phaseId}),error=>error.code==='ENGINE_PHASE_UNAVAILABLE'&&error.details.phaseId===phaseId);
  }
  assert.deepEqual(await f.head(),head);assert.equal(f.control.clockCalls,clockCalls);
});
test('a malformed publication inventory is explicit corruption before generation guidance or a raw property failure',async t=>{
  const f=await namespaceApprovalFixture(t),head=await f.head();
  const body=JSON.parse(Buffer.from((await f.content.read(f.scope,head.record.value.state)).data));body.workflow.phases.intake.publicationBindings={};
  const corrupted=(await f.content.put(f.scope,'state',Buffer.from(canonicalJson(body)))).reference;
  await f.records.transact(f.scope,{operationId:'malformed-publication-inventory',preconditions:[{namespace:'state',key:head.record.key,version:head.record.version}],
    changes:[{op:'put',namespace:'state',key:head.record.key,immutable:false,value:{...head.record.value,state:corrupted}}],events:[]});
  const before=await f.head();
  for(const [engine,operation]of [[f.makeApproval(),'phase.approve'],[submit(f),'phase.submit']])await assert.rejects(engine.run(operation,{phaseId:'intake'}),{code:'ENGINE_STORAGE_CORRUPT'});
  assert.deepEqual(await f.head(),before);
});
