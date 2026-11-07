import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine,ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';

const mappingSha256=`sha256:${'a'.repeat(64)}`;
const answers={'states-the-outcome':'yes','matches-the-criterion':'yes','current-for-this-change':'yes'};
const inputs={
  'decision.witness':{clauseId:'sample:ac-001',slotName:'plot',file:'evidence/plot.png',answers,reason:'Reviewed the exact rendered outcome.'},
  'decision.witness-exception':{phaseId:'team-build',mappingSha256,expires:'2099-01-01',reason:'The approved exception still stands.'}
};

function fixture(operation='decision.witness',hook=()=>{}) {
  const descriptor=ENGINE_OPERATIONS.find(entry=>entry.id===operation),calls=[],observed={};
  const context={subject:{kind:'story',id:'STORY-1'},workflow:{workItem:{id:'STORY-1'},status:'in_progress',
    currentPhase:'team-review',phases:{'team-build':{status:'approved'},'team-review':{status:'in_progress'}}}};
  const phase=operation==='decision.witness'?'team-review':'team-build';
  const facts={workId:'STORY-1',phase,recordKind:descriptor.recordKind,
    record:operation==='decision.witness'?{id:'WIT-001',outcome:'failed'}:{id:'WXR-001',phase:'team-build',generation:2},
    revision:'b'.repeat(40),pushed:true,actorId:'native-reviewer',authorityGroup:'delivery-owners',currentPhase:'team-review'};
  const token={sha:facts.revision,pushed:true},port={};
  for(const stage of ['load','prepare','commit','finish'])port[stage]=async(...args)=>{
    calls.push(stage);observed[stage]=args;
    const replacement=await hook(stage,{context,facts,token},args);
    if(replacement!==undefined)return replacement;
    return stage==='load'?context:stage==='prepare'?args[1]:stage==='commit'?token:facts;
  };
  return {context,facts,token,calls,observed,port,engine:createEngine({ports:{decisionRecord:port}})};
}

for(const operation of Object.keys(inputs))test(`${operation} uses one registered human-only writer and keeps the current phase`,async()=>{
  const f=fixture(operation),result=await f.engine.run(operation,{workId:'STORY-1',...inputs[operation]});
  assert.deepEqual(f.calls,['load','prepare','commit','finish']);
  assert.equal(f.observed.load[1].operation.humanDecision,true);
  assert.equal(result.phase,operation==='decision.witness'?'team-review':'team-build');
  assert.equal(result.currentPhase,'team-review');
  assert.deepEqual(result.effects,{committed:true,pushed:true});
  assert.equal(result.status,'recorded');
  assert.equal(Object.isFrozen(result.record),true);
  assert.equal('commandGuidance' in result,false);
  if(operation==='decision.witness') {
    assert.equal(f.observed.commit[1].clauseId,'SAMPLE:AC-001');
    assert.equal(result.record.outcome,'failed','recording a negative witness is not approval or passing evidence');
    assert.equal(Object.isFrozen(f.observed.commit[1].answers),true);
  }
});

test('request data cannot invent human identity, evidence hashes, graphs, records or lifecycle phase',async()=>{
  const f=fixture();
  for(const extra of [{actor:'someone'},{authorityGroup:'reviewers'},{actualFile:mappingSha256},{record:{id:'WIT-001'}},
    {graph:{}},{phaseId:'team-build'},{answers:[]},{answers:()=>answers},
    {get reason(){throw new Error('must not invoke this getter');}}]) {
    await assert.rejects(f.engine.run('decision.witness',extra),{code:'ENGINE_INPUT_INVALID'});
  }
  assert.deepEqual(f.calls,[]);
});

test('closed Story and invalid renewal identity retain native diagnostic codes before any write',async()=>{
  for(const [operation,code] of [['decision.witness','WITNESS_STORY_CLOSED'],['decision.witness-exception','WITNESS_EXCEPTION_STORY_CLOSED']]) {
    const f=fixture(operation,(stage,{context})=>{if(stage==='load')context.workflow.status='closed';});
    await assert.rejects(f.engine.run(operation,inputs[operation]),{code});
    assert.deepEqual(f.calls,['load']);
  }
  for(const request of [{},{phaseId:'team-build',mappingSha256:'not-a-mapping'}]) {
    const f=fixture('decision.witness-exception');
    await assert.rejects(f.engine.run('decision.witness-exception',request),{code:'WITNESS_EXCEPTION_RENEWAL_INVALID'});
    assert.deepEqual(f.calls,['load','prepare']);
  }
});

test('a renewal does not turn an absent current phase into its approved target phase',async()=>{
  const f=fixture('decision.witness-exception',(stage,{context,facts})=>{
    if(stage==='load')context.workflow.currentPhase=null;
    if(stage==='finish')facts.currentPhase=null;
  });
  const receipt=await f.engine.run('decision.witness-exception',inputs['decision.witness-exception']);
  assert.equal(receipt.phase,'team-build');assert.equal(receipt.currentPhase,null);
});

test('cancellation during human preparation stops before witness or renewal effects',async()=>{
  for(const operation of Object.keys(inputs)) {
    const controller=new AbortController();
    const f=fixture(operation,stage=>{if(stage==='prepare')controller.abort();});
    await assert.rejects(f.engine.run(operation,inputs[operation],{signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
    assert.deepEqual(f.calls,['load','prepare']);
  }
});

test('native evidence, authority and recovery refusals retain their identity and cause',async()=>{
  for(const code of ['WITNESS_REVIEW_CHANGED','WITNESS_ALREADY_RECORDED','WITNESS_EVIDENCE_UNPUBLISHED','APPROVAL_IDENTITY_NOT_AUTHORIZED']) {
    const cause=new Error('exact evidence unavailable');
    const error=new SingularityFlowError('original writer refusal',{code,cause,details:{file:'evidence/plot.png'}});
    const f=fixture('decision.witness',stage=>{if(stage==='commit')throw error;});
    await assert.rejects(f.engine.run('decision.witness',inputs['decision.witness']),found=>found===error&&found.cause===cause);
    assert.equal(f.calls.includes('finish'),false);
  }
});

test('a post-commit response cannot misreport the witness phase, renewal target, group or current phase',async()=>{
  for(const operation of Object.keys(inputs)) {
    for(const changed of [{phase:'elsewhere'},{authorityGroup:null},{currentPhase:'team-build'},
      ...(operation==='decision.witness-exception'?[{record:{id:'WXR-001',phase:'team-review'}}]:[])]) {
      const f=fixture(operation,(stage,{facts})=>{if(stage==='finish')Object.assign(facts,changed);});
      await assert.rejects(f.engine.run(operation,inputs[operation]),error=>
        error.code==='ENGINE_PORT_RESULT_INVALID'&&error.enginePublication===f.token);
    }
  }
});
