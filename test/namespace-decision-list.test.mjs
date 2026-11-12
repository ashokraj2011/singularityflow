import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
const permissions=['decisions.list','decision.scope','decision.applicability','upstream.raise','upstream.decide','test-command.request','test-command.decide'];
for(const backend of ['filesystem','sqlite','application'])test(backend+': decision lists read actual scope and human receipts without changing the Story',async t=>{
  const f=await namespaceEngineFixture(t,{backend,storyText:JSON.stringify({acceptanceCriteria:['Retain exact test cases for the confirmed behavior.']})});
  await f.bootstrap();f.control.permissions.push(...permissions);f.asReviewer();const before=await f.capture(),shown=await f.engine.run('decisions.list');
  assert.equal(shown.manifest.profile,'sflow-decision-list/v1');const item=shown.manifest.policy.items.find(row=>row.kind==='scope-disposition');assert.ok(item);
  assert.ok(item.options.find(row=>row.id==='scope-informative').decidedBy.allowed);assert.deepEqual(await f.capture(),before);
  const repeated=await f.engine.run('decisions.list');assert.equal(repeated.manifest.policy.packetSha256,shown.manifest.policy.packetSha256);
  const target=item.options[0].effects[0].inputs.item;
  await f.engine.run('decision.scope',{operationId:'actual-list-source',item:target,disposition:'informative',reason:'The independent reviewer classified this exact retained request.'});
  const after=await f.engine.run('decisions.list');assert.equal(after.manifest.policy.items.some(row=>row.title===target),false);
  assert.notEqual(after.manifest.policy.packetSha256,shown.manifest.policy.packetSha256);
  const readonly=f.make({working:null});assert.equal((await readonly.run('decisions.list')).manifest.policy.packetSha256,after.manifest.policy.packetSha256);
});
test('the list separates observed choice authority from read permission and preserves genuine content errors',async t=>{
  const f=await namespaceEngineFixture(t);await f.bootstrap();f.control.permissions.push('decisions.list');
  const before=await f.capture(),shown=await f.engine.run('decisions.list');
  assert.ok(shown.manifest.policy.items.length);assert.ok(shown.manifest.policy.items.every(row=>row.options.every(option=>!option.decidedBy.allowed)));
  const source=before.workflow.workItem.source.content,denied=Object.freeze(Object.assign(Error('Retained Story source denied.'),{code:'EACCES',details:{deadlineMs:5544}})),
    unavailable=f.make({content:{...f.content,read(scope,reference,options){if(reference.sha256===source.sha256)throw denied;return f.content.read(scope,reference,options);}}});
  await assert.rejects(unavailable.run('decisions.list'),error=>error===denied);assert.deepEqual(await f.capture(),before);
});
test('a permission change during listing refuses the stale choice authority without writing',async t=>{
  const f=await namespaceEngineFixture(t);await f.bootstrap();f.control.permissions.push(...permissions);f.asReviewer();const before=await f.capture();
  let reads=0;f.control.engineHook=(_count,request)=>{if(request.operation==='decisions.list'&&++reads===2)
    f.control.permissions=f.control.permissions.filter(permission=>permission!=='decision.scope');};
  await assert.rejects(f.engine.run('decisions.list'),{code:'ENGINE_CONTEXT_CHANGED'});assert.deepEqual(await f.capture(),before);
});
test('the list propagates its cancellation signal through actual retained content reads',async t=>{
  const f=await namespaceEngineFixture(t);await f.bootstrap();f.control.permissions.push('decisions.list');
  const source=(await f.capture()).workflow.workItem.source.content,controller=new AbortController();let signalled=false;
  const content={...f.content,read(scope,reference,options){if(reference.sha256===source.sha256&&options?.signal===controller.signal)signalled=true;return f.content.read(scope,reference,options);}};
  await f.make({content}).run('decisions.list',{}, {signal:controller.signal});assert.equal(signalled,true);
});
