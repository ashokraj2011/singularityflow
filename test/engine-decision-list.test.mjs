import test from 'node:test';import assert from 'node:assert/strict';
import {createEngine} from '../src/engine-sdk/index.mjs';
const digest='sha256:'+'a'.repeat(64),policy=()=>({workId:'story',phase:'review',packetSha256:digest,items:[{
  id:'d1',kind:'test-command',title:'TCD-001',options:[{id:'accept',label:'accept',recordable:true,needs:{},effects:[{kind:'test-command',request:'TCD-001'}],decidedBy:{allowed:true,groups:['reviewers']}}]
}],offered:[]});
function fixture(read=()=>({revision:'opaque-revision',policy:policy()})){
  let loaded=0;const port={load(){loaded++;return {subject:{kind:'story',id:'story'},workflow:{workItem:{id:'story'},currentPhase:'review'}};},read};
  return {engine:createEngine({ports:{decisionList:port}}),loaded:()=>loaded};
}
test('decision listing has one read-only registry path and immutable policy values',async()=>{
  const f=fixture(),result=await f.engine.run('decisions.list',{workId:'story'});
  assert.equal(result.operation,'decisions.list');assert.equal(result.manifest.profile,'sflow-decision-list/v1');assert.deepEqual(result.manifest.policy,policy());
  assert.deepEqual(result.effects,{committed:false,pushed:false,humanDecisionRecorded:false});assert.equal(Object.isFrozen(result.manifest.policy.items),true);
  assert.equal(f.loaded(),1);
});
test('native card and command fields are not exported as SDK policy',async()=>{
  const value=policy();value.card='<private-card>';value.items[0].options[0].action={command:'do-private'};
  value.items[0].options[0].decidedBy.share='private-person-route';
  const result=await fixture(()=>({revision:'opaque',policy:value})).engine.run('decisions.list');
  assert.equal(JSON.stringify(result).includes('private'),false);
});
test('caller-selected packets, actors, effects and host formatting cannot enter listing',async()=>{
  for(const field of ['packet','actor','authority','effects','card']){const f=fixture();
    await assert.rejects(f.engine.run('decisions.list',{[field]:true}),{code:'ENGINE_INPUT_INVALID'});assert.equal(f.loaded(),0);}
});
test('the read binds its requested phase and original Story across awaited work',async()=>{
  const f=fixture((_context,binding)=>{assert.equal(binding.phase,'custom');return {revision:'opaque',policy:{...policy(),phase:'custom'}};});
  assert.equal((await f.engine.run('decisions.list',{phaseId:'custom'})).phase,'custom');
  await assert.rejects(f.engine.run('decisions.list',{workId:'other'}),{code:'ACTIVE_SUBJECT_MISMATCH'});
});
test('differently bound lists and duplicated choices are refused',async()=>{
  for(const change of [p=>{p.workId='other';},p=>{p.phase='other';},p=>{p.items.push(structuredClone(p.items[0]));},p=>{p.items[0].options.push(structuredClone(p.items[0].options[0]));}]){
    const p=policy();change(p);await assert.rejects(fixture(()=>({revision:'opaque',policy:p})).engine.run('decisions.list'),{code:'ENGINE_PORT_RESULT_INVALID'});
  }
});
test('real read errors and their deadline details retain exact identity',async()=>{
  const original=Object.freeze(Object.assign(new Error('read denied'),{code:'EACCES',details:Object.freeze({deadlineMs:9000,path:'retained-policy'})}));
  await assert.rejects(fixture(()=>{throw original;}).engine.run('decisions.list'),error=>error===original);
});
test('native long lists keep their IDs and read-only access cannot record a choice',async()=>{
  const p=policy();p.items[0].id='d1000';p.items[0].options[0].recordable=false;
  const f=fixture(()=>({revision:'opaque',policy:p}));assert.equal((await f.engine.run('decisions.list')).manifest.policy.items[0].id,'d1000');
  await assert.rejects(f.engine.run('decisions.record',{confirmation:digest}),{code:'ENGINE_PORT_UNAVAILABLE'});
});
test('structured recovery actions must name a real operation and its accepted input vocabulary',async()=>{
  for(const action of [{operation:'made-up.operation',inputs:{}},{operation:'witness.context',inputs:{invented:true}},
    {operation:'witness.context',inputs:{},requiredInputs:['invented']},{operation:'witness.context',inputs:{},command:'run-this'}]){
    const p=policy();p.items[0].options[0].recordable=false;
    await assert.rejects(fixture(()=>({revision:'opaque',policy:p,actions:[{item:'d1',option:'accept',...action}]})).engine.run('decisions.list'),
      {code:'ENGINE_PORT_RESULT_INVALID'});
  }
});
