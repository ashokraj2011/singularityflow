import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine,ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';

const reviewed=Object.freeze({workId:'REVIEW-1',phase:'team-design',generation:1,reviewPacketSha256:'a'.repeat(64)});
function fixture({hook=()=>{},confirmation=reviewed}={}) {
  const calls=[];
  const context={subject:{kind:'story',id:reviewed.workId},reviewBinding:reviewed};
  const facts={workId:reviewed.workId,phase:reviewed.phase,generation:1,revision:'b'.repeat(40),pushed:false,
    reviewPacket:reviewed.reviewPacketSha256,artifactSet:'c'.repeat(64),actorId:'reviewer@example.test',
    authorityGroup:'architecture-reviewers',selfApproval:false,thresholdReached:true,currentPhase:'implementation'};
  const port=Object.fromEntries(['load','prepare','commit','finish'].map(stage=>[stage,async(...args)=>{
    calls.push(stage);await hook(stage,args,context,facts);
    return stage==='load'?context:stage==='prepare'?{confirmation}:stage==='commit'?{sha:facts.revision,pushed:false}:facts;
  }]));
  return {engine:createEngine({ports:{approval:port}}),calls,context,facts,port};
}

test('approval is one registry operation, and a typed helper records the same exact review',async()=>{
  const a=fixture(),b=fixture();
  assert.deepEqual(await a.engine.run('phase.approve',{confirmation:reviewed}),await b.engine.approvePhase({confirmation:reviewed}));
  assert.deepEqual(a.calls,['load','prepare','commit','finish']);
  assert.equal((await a.engine.approvePhase({confirmation:reviewed})).status,'recorded');
  const descriptor=ENGINE_OPERATIONS.find(operation=>operation.id==='phase.approve');
  assert.equal(descriptor.humanDecision,true);
  assert.equal('execute' in descriptor,false);
  assert.equal('validate' in descriptor,false);
  a.port.commit=()=>{throw new Error('redirected');};
  assert.equal((await a.engine.approvePhase({confirmation:reviewed})).revision,'b'.repeat(40));
});

test('a host cannot record an absent or differently bound human confirmation',async()=>{
  for(const confirmation of [null,{...reviewed,workId:'OTHER'},{...reviewed,phase:'other'},
    {...reviewed,generation:2},{...reviewed,reviewPacketSha256:'d'.repeat(64)}]) {
    const f=fixture({confirmation});
    await assert.rejects(f.engine.approvePhase({}),{code:confirmation===null?'ENGINE_APPROVAL_CONFIRMATION_REQUIRED':'ENGINE_APPROVAL_CONFIRMATION_STALE'});
    assert.equal(f.calls.includes('commit'),false);
  }
});

test('actor, authority, presence, executable callbacks and unreviewed packet data are not approval inputs',async()=>{
  const f=fixture();
  const getter={};Object.defineProperty(getter,'confirmation',{enumerable:true,get(){throw new Error('caller getter');}});
  for(const input of [{actor:{}},{authorityGroup:'anyone'},{presence:{}},{prepare:()=>{}},getter,
    {confirmation:{...reviewed,actor:'forged'}},{confirmation:{...reviewed,generation:'1'}},
    {fetch:'yes'},{checklist:{}},{decisions:{packet:{},answers:{}}}]) {
    await assert.rejects(f.engine.approvePhase(input),{code:'ENGINE_INPUT_INVALID'});
  }
  assert.deepEqual(f.calls,[]);
});

test('a partial threshold decision remains a recorded vote, with its current phase',async()=>{
  const f=fixture({hook(stage,args,context,facts){facts.thresholdReached=false;facts.currentPhase=reviewed.phase;}});
  const receipt=await f.engine.approvePhase({});
  assert.equal(receipt.status,'recorded');assert.equal(receipt.approval.thresholdReached,false);
  assert.equal(receipt.currentPhase,reviewed.phase);assert.equal(receipt.effects.committed,true);
});

test('approval cancellation never turns an accepted decision into an undone effect',async()=>{
  for(const stage of ['load','prepare','commit']) {
    const controller=new AbortController();
    const f=fixture({hook(name){if(name===stage)controller.abort();}});
    const running=f.engine.approvePhase({},{signal:controller.signal});
    if(stage==='commit')assert.equal((await running).status,'recorded');
    else {await assert.rejects(running,{code:'ENGINE_OPERATION_CANCELLED'});assert.equal(f.calls.includes('commit'),false);}
  }
});

test('approval retains real authority/transport refusals and committed projection failure details',async()=>{
  const cause=new Error('original credential detail');
  const native=new SingularityFlowError('native refusal',{code:'APPROVAL_IDENTITY_NOT_AUTHORIZED',cause});
  native.details={identity:'refused@example.test'};
  const failed=fixture({hook(stage){if(stage==='commit')throw native;}});
  await assert.rejects(failed.engine.approvePhase({}),error=>error===native&&error.cause===cause);
  const mixed=fixture({hook(stage,args,context,facts){if(stage==='finish')facts.reviewPacket='wrong';}});
  await assert.rejects(mixed.engine.approvePhase({}),error=>error.code==='ENGINE_PORT_RESULT_INVALID'&&error.enginePublication.sha==='b'.repeat(40));
});
