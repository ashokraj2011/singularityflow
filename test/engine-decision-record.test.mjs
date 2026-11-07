import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine,ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';

const cases=[
  ['decision.scope',{item:'SRI-1',disposition:'informative',reason:'Reviewed context'},'scope-disposition'],
  ['decision.completeness',{confirm:`sha256:${'a'.repeat(64)}`,checklist:[]},'completeness-review'],
  ['decision.applicability',{responsibility:'verify',reason:'Reviewed omission'},'applicability'],
  ['decision.risk',{obligationId:'OBL-1',reason:'Reviewed risk'},'obligation-risk'],
  ['decision.plan',{changes:[{kind:'add-location',clauseId:'STORY-1:AC-001',path:'src/helper.mjs'}],reason:'Reviewed supporting implementation'},'plan-amendment'],
  ['decision.choose',{option:'continue',expected:'pending-1',reason:'Reviewed route'},'routing']
];

function fixture({operation='decision.scope',hook=()=>{}}={}) {
  const descriptor=ENGINE_OPERATIONS.find(entry=>entry.id===operation);
  const context={subject:{kind:'story',id:'STORY-1'},workflow:{workItem:{id:'STORY-1'},status:'in_progress',
    currentPhase:'team-scope',pendingDecision:{after:'team-scope',key:'pending-1'}}};
  const facts={workId:'STORY-1',phase:'team-scope',recordKind:descriptor.recordKind,record:{id:'record-1'},
    revision:'b'.repeat(40),pushed:false,actorId:'native-reviewer',authorityGroup:'source-owners',
    currentPhase:operation==='decision.choose'?'team-plan':'team-scope'};
  const calls=[],observations={};
  const port={};
  for(const stage of ['load','prepare','commit','finish'])port[stage]=async(...args)=>{
    calls.push(stage);observations[stage]=args;
    await hook(stage,{context,facts,calls,observations},args);
    return stage==='load'?context:stage==='prepare'?args[1]:stage==='commit'?{sha:facts.revision,pushed:false}:facts;
  };
  return {context,facts,calls,observations,port,engine:createEngine({ports:{decisionRecord:port}})};
}

for(const [operation,input,kind] of cases)test(`${operation} has one registered write path and a bound immutable receipt`,async()=>{
  const f=fixture({operation});
  const result=await f.engine.run(operation,{workId:'STORY-1',...input});
  assert.deepEqual(f.calls,['load','prepare','commit','finish']);
  assert.equal(result.operation,operation);
  assert.equal(result.recordKind,kind);
  assert.equal(result.actorId,'native-reviewer');
  assert.equal(result.authorityGroup,'source-owners');
  assert.equal(result.subject.id,'STORY-1');
  assert.equal(result.phase,'team-scope');
  assert.deepEqual(result.effects,{committed:true,pushed:false});
  assert.equal(Object.isFrozen(result.record),true);
  assert.equal('commandGuidance' in result,false);
  const metadata=f.observations.load[1].operation;
  assert.equal(metadata.humanDecision,true);
  assert.equal(Object.isFrozen(metadata.requestFields),true);
  assert.equal('execute' in metadata,false,'trusted ports receive vocabulary, not private engine executors');
  if(operation==='decision.scope')assert.deepEqual(f.observations.commit[1].clauseIds,[]);
  if(operation==='decision.risk')assert.deepEqual(f.observations.commit[1].transitions,['terminal']);
  if(operation==='decision.choose')assert.equal(result.currentPhase,'team-plan');
});

test('forged actor, policy, phase, packet and callbacks cannot enter standalone decision I/O',async()=>{
  const f=fixture();
  for(const value of [{actor:'forged'},{authorityGroup:'forged'},{policy:{}},{phaseId:'other'},{packet:{}},
    {callback(){}},{fetch:'yes'},{clauseIds:['okay',{}]},{get reason(){throw new Error('caller getter executed');}}]) {
    await assert.rejects(f.engine.run('decision.scope',value),{code:'ENGINE_INPUT_INVALID'});
  }
  assert.deepEqual(f.calls,[]);
});

test('closed Story and missing-route refusals precede human preparation and retain their exact meanings',async()=>{
  for(const [operation,code] of [['decision.scope','SCOPE_STORY_CLOSED'],['decision.completeness','SCOPE_STORY_CLOSED'],
    ['decision.applicability','APPLICABILITY_STORY_CLOSED'],['decision.risk','RISK_STORY_CLOSED']]) {
    const f=fixture({operation,hook(stage,{context}){if(stage==='load')context.workflow.status='closed';}});
    await assert.rejects(f.engine.run(operation,{}),error=>{
      assert.equal(error.code,code);
      if(operation==='decision.applicability')assert.equal(error.message,
        'Story STORY-1 is already closed; applicability is decided while it is in progress.');
      return true;
    });
    assert.deepEqual(f.calls,['load']);
  }
  const f=fixture({operation:'decision.choose',hook(stage,{context}){if(stage==='load')delete context.workflow.pendingDecision;}});
  await assert.rejects(f.engine.run('decision.choose',{}),{code:'DECISION_NOT_PENDING'});
  assert.deepEqual(f.calls,['load']);
});

test('required domain fields are checked before any native effect',async()=>{
  for(const [operation,input,code] of [['decision.scope',{},'SCOPE_DECISION_INCOMPLETE'],
    ['decision.applicability',{},'APPLICABILITY_RESPONSIBILITY_REQUIRED'],
    ['decision.risk',{},'RISK_DECISION_INVALID'],
    ['decision.risk',{revoke:'RISK-1',obligationId:'OBL-1'},'RISK_DECISION_INVALID']]) {
    const f=fixture({operation});
    await assert.rejects(f.engine.run(operation,input),{code});
    assert.deepEqual(f.calls,['load','prepare']);
  }
});

test('host preparation cannot redirect the Story or supply an authority field',async()=>{
  for(const prepared of [{item:'SRI-1',disposition:'informative',workId:'OTHER'},
    {item:'SRI-1',disposition:'informative',actor:'forged'}]) {
    const f=fixture();
    const engine=createEngine({ports:{decisionRecord:{...f.port,prepare:()=>prepared}}});
    await assert.rejects(engine.run('decision.scope',{}),{code:'ENGINE_INPUT_INVALID'});
    assert.equal(f.calls.includes('commit'),false);
  }
});

test('inputs and trusted method references are captured before asynchronous preparation',async()=>{
  const f=fixture();
  f.port.load=()=>{throw new Error('redirected owner');};
  f.port.commit=()=>{throw new Error('redirected writer');};
  const input={workId:'STORY-1',item:'SRI-1',disposition:'informative',clauseIds:['REQ-1']};
  const running=f.engine.run('decision.scope',input);
  input.workId='OTHER';input.clauseIds.push('UNREVIEWED');
  const receipt=await running;
  assert.equal(receipt.subject.id,'STORY-1');
  assert.deepEqual(f.observations.commit[1].clauseIds,['REQ-1']);
  assert.equal(Object.isFrozen(f.observations.commit[1]),true);
});

test('scope binding is captured before a trusted host awaits human input',async()=>{
  const f=fixture({hook(stage,{context,facts}){
    if(stage==='prepare'){context.workflow.currentPhase='other';facts.phase='other';}
  }});
  await assert.rejects(f.engine.run('decision.scope',cases[0][1]),error=>error.code==='ENGINE_PORT_RESULT_INVALID'
    && error.enginePublication.sha==='b'.repeat(40));
  const wrong=fixture();
  await assert.rejects(wrong.engine.run('decision.scope',{workId:'OTHER',...cases[0][1]}),{code:'ENGINE_PORT_RESULT_INVALID'});
  assert.deepEqual(wrong.calls,['load']);
});

test('cancellation stops before the next effect and never reverses an accepted decision',async()=>{
  for(const at of ['load','prepare','commit']) {
    const controller=new AbortController();
    const f=fixture({hook(stage){if(stage===at)controller.abort();}});
    const running=f.engine.run('decision.scope',cases[0][1],{signal:controller.signal});
    if(at==='commit')assert.equal((await running).effects.committed,true);
    else {await assert.rejects(running,{code:'ENGINE_OPERATION_CANCELLED'});assert.equal(f.calls.includes('commit'),false);}
  }
});

test('native identity, conflict and unknown-publication failures keep their original causes and recovery',async()=>{
  for(const stage of ['load','prepare','commit']) {
    const cause=new Error('transport deadline');
    const native=new SingularityFlowError('actual native refusal',{code:'PUBLICATION_PENDING',cause,
      details:{pushOutcome:'transport-indeterminate',nextAction:'recover the same publication'}});
    native.publicationCommit='c'.repeat(40);
    const f=fixture({hook(at){if(at===stage)throw native;}});
    await assert.rejects(f.engine.run('decision.scope',cases[0][1]),error=>error===native&&error.cause===cause
      && error.publicationCommit==='c'.repeat(40)&&error.details.pushOutcome==='transport-indeterminate');
  }
});

test('a malformed result cannot hide a committed decision or invent a differently bound record',async()=>{
  const mutations=[facts=>{facts.workId='OTHER';},facts=>{facts.phase='other';},
    facts=>{facts.recordKind='routing';},facts=>{facts.actorId=null;},facts=>{facts.authorityGroup=null;},
    facts=>{facts.pushed='yes';},facts=>{facts.record=()=>{};},facts=>{facts.command='shell';}];
  for(const mutate of mutations) {
    const f=fixture({hook(stage,{facts}){if(stage==='finish')mutate(facts);}});
    await assert.rejects(f.engine.run('decision.scope',cases[0][1]),error=>error.code==='ENGINE_PORT_RESULT_INVALID'
      && error.enginePublication.sha==='b'.repeat(40));
    assert.equal(f.calls.filter(entry=>entry==='commit').length,1);
  }
});
