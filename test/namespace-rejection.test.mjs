import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
import {namespaceLifecycleStoryKey} from '../src/engine-storage/namespace-lifecycle-reader.mjs';
import {canonicalJson} from '../src/foundation/record-schema.mjs';
const reason='The reviewer requests a corrected document for the same approved requirement.';
for(const backend of ['filesystem','sqlite','application'])test(backend+': human returns preserve real commit errors, recover once, and reject changed receipt bytes',async t=>{
  const f=await namespaceEngineFixture(t,{backend});await f.bootstrap();await f.author();f.asReviewer();f.control.permissions.push('phase.reject');
  const {manifest}=await f.engine.run('phase.review',{phaseId:'intake'}),input={phaseId:'intake',reason,confirm:manifest.reviewBinding.packetSha256};
  const head=await f.records.read(f.scope,'state',namespaceLifecycleStoryKey(f.workId));
  await assert.rejects(f.engine.run('phase.reject',{...input,reason:'x'.repeat(2049)}),{code:'ENGINE_INPUT_INVALID'});
  assert.deepEqual(await f.records.read(f.scope,'state',namespaceLifecycleStoryKey(f.workId)),head);
  const original=Object.assign(new Error('The application committed but the reply exceeded its deadline.'),{code:'ETIMEDOUT',details:{deadlineMs:4567}});let lost=false;
  const records={...f.records,async transact(...args){const result=await f.records.transact(...args);
    if(!lost&&args[1].events.some(item=>item.payload?.operation==='phase.reject')){lost=true;throw original;}return result;}};
  await assert.rejects(f.make({records}).run('phase.reject',input),error=>error===original);assert.equal(lost,true);
  const before=await f.capture(),result=await f.make({clock:{now(){throw Error('A retry cannot restamp the return.');}}}).run('phase.reject',input);
  assert.equal(result.changeRequest.id,'CR-001');assert.deepEqual(await f.capture(),before);
  assert.equal(before.workflow.namespaceHumanDecisionReceipts.length,1);assert.equal(before.workflow.changeRequests.length,1);
  const link=before.workflow.namespaceHumanDecisionReceipts[0],value=JSON.parse(Buffer.from((await f.content.read(f.scope,link.record)).data));
  value.outcome.changeRequest.comment='Forged repair reason';
  const forged=(await f.content.put(f.scope,'evidence',Buffer.from(canonicalJson(value)))).reference,
    denied={...f.content,read(scope,ref,options){return ref.sha256===link.record.sha256?f.content.read(scope,forged,options):f.content.read(scope,ref,options);}};
  await assert.rejects(f.make({content:denied}).run('phase.reject',input));
  assert.deepEqual(await f.capture(),before);
});
