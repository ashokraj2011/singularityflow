import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine} from '../src/engine-sdk/index.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';

function fixture({phase = null, decisions = [], retained = false, hook = () => {}} = {}) {
  phase ??= {id:'team-spec',status:'in_progress',generation:1,approvalPolicy:{mode:'required'}};
  const context = {subject:{kind:'story',id:'STORY-1'},phase,
    workflow:{workItem:{id:'STORY-1'},resolution:{decisions}}};
  const facts = {workId:'STORY-1',phase:phase.id,generation:1,revision:'a'.repeat(40),pushed:false,
    phaseStatus:'awaiting_approval',submittedAt:'2026-11-07T00:00:00.000Z',approvalMode:'required',
    currentPhase:phase.id,reviewPacket:'b'.repeat(64)};
  const calls = [];
  const port = Object.fromEntries(['load','retained','prepare','commit','finish'].map(name => [name,async (...args) => {
    calls.push(name); await hook(name,args,context,facts);
    return name === 'load' ? context : name === 'retained' ? retained ? facts : null
      : name === 'commit' ? {sha:facts.revision,pushed:false} : name === 'finish' ? facts : {};
  }]));
  port.notice = event => {calls.push(event.code);};
  return {engine:createEngine({ports:{submission:port}}),calls,context,facts,port};
}

test('submission uses one registry sequence for its helper and freezes the caller input',async()=>{
  let received;
  const a=fixture({hook(stage,args){if(stage==='load')received=args[0];}}), b=fixture();
  const input={workId:'STORY-1',phaseId:'team-spec',decisionValues:{}};
  const running=a.engine.run('phase.submit',input);
  input.workId='OTHER';input.decisionValues.changed='later';
  const result=await running;
  assert.deepEqual(result,await b.engine.submitPhase({workId:'STORY-1',phaseId:'team-spec'}));
  assert.equal(result.status,'awaiting-approval');
  assert.deepEqual(a.calls,['load','retained','prepare','commit','finish']);
  assert.equal(received.workId,'STORY-1');assert.deepEqual(received.decisionValues,{});
  assert.equal(Object.isFrozen(received.decisionValues),true);
  assert.equal('commandGuidance' in result,false);
  a.port.commit=()=>{throw new Error('redirected');};
  assert.equal((await a.engine.submitPhase({})).revision,result.revision);
});

test('ordinary submit cannot receive convergence confirmation or a private authority flag',async()=>{
  const phase={id:'team-reconcile',status:'in_progress',requiredArtifact:{kind:'convergence-report'},approvalPolicy:{mode:'required'}};
  const f=fixture({phase});
  await assert.rejects(f.engine.submitPhase({confirmation:`sha256:${'1'.repeat(64)}`}),{code:'ENGINE_INPUT_INVALID'});
  await assert.rejects(f.engine.submitPhase({submissionContext:true}),{code:'ENGINE_INPUT_INVALID'});
  assert.deepEqual(f.calls,[]);
  await assert.rejects(f.engine.submitPhase({}),{code:'CONVERGENCE_ADVANCE_CONFIRMATION_REQUIRED'});
  assert.equal(f.calls.includes('prepare'),false);
  for(const confirmation of [null,'yes','sha256:wrong']) {
    await assert.rejects(f.engine.submitConvergence({confirmation}),{code:'CONVERGENCE_ADVANCE_CONFIRMATION_REQUIRED'});
  }
  const result=await f.engine.submitConvergence({confirmation:`sha256:${'1'.repeat(64)}`});
  assert.equal(result.operation,'convergence.submit');
  const waived=fixture({phase:{...phase,approvalPolicy:{mode:'none'}}});
  await assert.rejects(waived.engine.submitConvergence({confirmation:`sha256:${'1'.repeat(64)}`}),{code:'CONVERGENCE_HUMAN_APPROVAL_REQUIRED'});
  assert.equal(waived.calls.includes('prepare'),false);
  await assert.rejects(fixture().engine.submitConvergence({confirmation:`sha256:${'1'.repeat(64)}`}),{code:'CONVERGENCE_PHASE_REQUIRED'});
});

test('decision input policy applies to every host before the submission transaction',async()=>{
  const decision={id:'choose-channel',after:'team-spec',label:'Channel',mode:'auto',
    inputs:[{name:'channel',type:'choice',values:['Web','Mobile']}]};
  const f=fixture({decisions:[decision]});
  await assert.rejects(f.engine.submitPhase({}),{code:'DECISION_INPUTS_MISSING'});
  await assert.rejects(f.engine.submitPhase({decisionValues:{other:'Web'}}),{code:'DECISION_INPUT_UNKNOWN'});
  await assert.rejects(f.engine.submitPhase({decisionValues:{channel:'missing'}}),{code:'DECISION_INPUT_INVALID'});
  assert.equal(f.calls.includes('prepare'),false);
  assert.equal((await f.engine.submitPhase({decisionValues:{channel:'web'}})).status,'awaiting-approval');
  await assert.rejects(fixture().engine.submitPhase({decisionValues:{channel:'Web'}}),{code:'DECISION_INPUT_UNKNOWN'});
});

test('an already submitted generation returns its retained outcome and warns about ignored values',async()=>{
  const phase={id:'team-spec',status:'awaiting_approval',approvalPolicy:{mode:'required'}};
  const f=fixture({phase,retained:true});
  const result=await f.engine.submitPhase({decisionValues:{channel:'Mobile'}});
  assert.equal(result.status,'retained');assert.deepEqual(result.effects,{committed:false,pushed:false});
  assert.deepEqual(f.calls,['load','submission.decision-values-ignored','retained']);
});

test('invalid values and unavailable operation ports fail without executing trusted I/O',async()=>{
  const f=fixture();
  const getter={get runChecks(){throw new Error('caller getter executed');}};
  for(const input of [getter,{runChecks:'false'},{decisionValues:[]},{decisionValues:{nested:{}}},{actor:{name:'forged'}}]) {
    await assert.rejects(f.engine.submitPhase(input),{code:'ENGINE_INPUT_INVALID'});
  }
  await assert.rejects(f.engine.publishPhase({}),{code:'ENGINE_PORT_UNAVAILABLE'});
  assert.deepEqual(f.calls,[]);
});

test('submission cancellation preserves accepted effects and original native recovery errors',async()=>{
  for(const cancelAt of ['load','retained','prepare','commit']) {
    const controller=new AbortController();
    const f=fixture({hook(stage){if(stage===cancelAt)controller.abort();}});
    const running=f.engine.submitPhase({},{signal:controller.signal});
    if(cancelAt==='commit') assert.equal((await running).status,'awaiting-approval');
    else {await assert.rejects(running,{code:'ENGINE_OPERATION_CANCELLED'});assert.equal(f.calls.includes('commit'),false);}
  }
  const cause=new Error('actual transport timeout');
  const native=new SingularityFlowError('pending publication',{code:'PUBLICATION_PENDING',cause,details:{recovery:'same operation'}});
  native.publicationCommit='c'.repeat(40);
  const f=fixture({hook(stage){if(stage==='commit')throw native;}});
  await assert.rejects(f.engine.submitPhase({}),error=>error===native&&error.cause===cause&&error.publicationCommit==='c'.repeat(40));
});

test('submission receipts cannot change the bound subject, invent a push or hide a committed tail failure',async()=>{
  const f=fixture({hook(stage,args,context,facts){if(stage==='finish')facts.workId='OTHER';}});
  await assert.rejects(f.engine.submitPhase({}),error=>error.code==='ENGINE_PORT_RESULT_INVALID'&&error.enginePublication.sha==='a'.repeat(40));
  const retained=fixture({retained:true,hook(stage,args,context,facts){facts.pushed=true;}});
  await assert.rejects(retained.engine.submitPhase({}),{code:'ENGINE_PORT_RESULT_INVALID'});
  const approval=fixture({hook(stage,args,context,facts){if(stage==='finish')facts.phaseStatus='approved';}});
  await assert.rejects(approval.engine.submitPhase({}),{code:'ENGINE_PORT_RESULT_INVALID'},
    'a required human approval cannot be declared complete by submission facts');
});
