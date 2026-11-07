import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine, ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const confirmed = {workId:'STORY-1', confirmation:digest};

function fixture({retained=false, hook=()=>{}, withReview=null, submission=true, invocation=null}={}) {
  const calls=[];
  let locked=false;
  const phase={id:'team-reconcile',generation:2,status:retained?'awaiting_approval':'in_progress',
    requiredArtifact:{kind:'convergence-report'},approvalPolicy:{mode:'required'}};
  const context={subject:{kind:'story',id:'STORY-1'},phase,
    workflow:{workItem:{id:'STORY-1'},resolution:{decisions:[]}},
    review:{workId:'STORY-1',phase:phase.id,generation:2,iteration:3,findings:4,
      reconciliation:'b'.repeat(64),confirmationDigest:digest}};
  const facts={workId:'STORY-1',phase:phase.id,generation:2,revision:'c'.repeat(40),pushed:false,
    phaseStatus:'awaiting_approval',submittedAt:'2026-11-07T00:00:00.000Z',approvalMode:'required',
    currentPhase:phase.id,reviewPacket:'d'.repeat(64)};
  const state={calls,context,facts,get locked(){return locked;}};
  const advance={
    async withReview(input,operation,options) {
      calls.push('review');
      locked=true;
      try {
        await hook('review',state,input);
        return await (withReview ? withReview(context,operation,options,state) : operation(context));
      } finally {
        locked=false;
        calls.push('release');
        await hook('release',state,input);
      }
    },
    async notice(event) {calls.push(event.code);await hook('notice',state,event);}
  };
  const writer=Object.fromEntries(['load','retained','prepare','commit','finish'].map(stage=>[stage,async (...args)=>{
    assert.equal(locked,true,`${stage} left the native Story lease`);
    calls.push(stage);
    await hook(stage,state,args);
    return stage==='load'?context:stage==='retained'?retained?facts:null:
      stage==='commit'?{sha:facts.revision,pushed:false}:stage==='finish'?facts:{};
  }]));
  const ports={advancement:advance,...(submission?{submission:writer}:{}),...(invocation?{invocation}:{} )};
  return {...state,advance,writer,engine:createEngine({ports})};
}

test('advancement is a registered, read-only preview with one helper and no host commands',async()=>{
  const operation=ENGINE_OPERATIONS.find(entry=>entry.id==='convergence.advance');
  assert.equal(operation.delegatesTo,'convergence.submit');
  assert.equal(operation.humanDecision,true);
  assert.equal(Object.isFrozen(operation),true);
  assert.equal('execute' in operation,false);
  const f=fixture(), other=fixture();
  const result=await f.engine.run('convergence.advance',{workId:'STORY-1'});
  assert.deepEqual(result,await other.engine.advanceConvergence({workId:'STORY-1'}));
  assert.equal(result.status,'ready-to-confirm');
  assert.equal(result.phase,'team-reconcile');
  assert.equal(result.iteration,3);
  assert.equal(result.confirmationDigest,digest);
  assert.deepEqual(result.effects,{committed:false,pushed:false});
  assert.deepEqual(f.calls,['review','release']);
  assert.equal(Object.isFrozen(result),true);
  assert.equal('commandGuidance' in result,false);
  assert.equal('next' in result,false);
});

test('exact consent submits through the existing writer while the review lease remains held',async()=>{
  let input;
  const invocations=[];
  const f=fixture({hook(stage,state,args){if(stage==='load')input=args[0];},
    invocation:{async run(operation){invocations.push('enter');try{return await operation();}finally{invocations.push('leave');}}}});
  const result=await f.engine.advanceConvergence({...confirmed,runChecks:false});
  assert.equal(result.status,'awaiting-approval');
  assert.equal(result.submission.operation,'convergence.submit');
  assert.equal(result.submission.submission.approvalMode,'required');
  assert.equal(result.submission.submission.currentPhase,'team-reconcile');
  assert.deepEqual(result.effects,{committed:true,pushed:false});
  assert.deepEqual(input,{workId:'STORY-1',phaseId:'team-reconcile',confirmation:digest,runChecks:false,decisionValues:{}});
  assert.deepEqual(f.calls,['review','advancement.confirmed','load','retained','prepare','commit','finish','release']);
  assert.deepEqual(invocations,['enter','enter','leave','leave']);
});

test('retained submission stays retained without another write or an invented approval',async()=>{
  const f=fixture({retained:true});
  const result=await f.engine.advanceConvergence(confirmed);
  assert.equal(result.status,'retained');
  assert.deepEqual(result.effects,{committed:false,pushed:false});
  assert.deepEqual(f.calls,['review','advancement.confirmed','load','retained','release']);
});

test('caller authority, phase overrides, callbacks and accessors fail before any native read',async()=>{
  const f=fixture();
  for(const input of [{...confirmed,phaseId:'other'},{...confirmed,actor:{id:'forged'}},
    {...confirmed,approval:true},{...confirmed,packet:{}},{...confirmed,callback(){}},
    {confirmation:true},{get confirmation(){throw new Error('caller getter executed');}},
    {runChecks:'false'},{decisionValues:{nested:{}}}]) {
    await assert.rejects(f.engine.advanceConvergence(input),{code:'ENGINE_INPUT_INVALID'});
  }
  assert.deepEqual(f.calls,[]);
});

test('stale consent retains the exact refusal and cannot enter the submission writer',async()=>{
  for(const confirmation of ['yes',`sha256:${'0'.repeat(64)}`]) {
    const f=fixture();
    await assert.rejects(f.engine.advanceConvergence({...confirmed,confirmation}),error=>{
      assert.equal(error.code,'CONVERGENCE_ADVANCE_CONFIRMATION_STALE');
      assert.equal(error.message,`The convergence result changed after preview. Review it again and confirm ${digest}.`);
      assert.deepEqual(error.details,{workId:'STORY-1',supplied:confirmation,expected:digest});
      return true;
    });
    assert.deepEqual(f.calls,['review','release']);
  }
});

test('review facts must bind the requested Story, native phase and generation before consent',async()=>{
  const mutations=[state=>{state.context.review.workId='OTHER';},
    state=>{state.context.review.phase='other';},state=>{state.context.review.generation=1;},
    state=>{state.context.review.confirmationDigest='not-a-digest';},
    state=>{state.context.review.iteration=0;},state=>{state.context.review.findings=-1;},
    state=>{state.context.review.command='singularity-flow approve';},
    state=>{state.context.review={get workId(){throw new Error('port getter executed');}};}];
  for(const mutate of mutations) {
    const f=fixture({hook(stage,state){if(stage==='review')mutate(state);}});
    await assert.rejects(f.engine.advanceConvergence(confirmed),{code:'ENGINE_PORT_RESULT_INVALID'});
    assert.deepEqual(f.calls,['review','release']);
  }
  await assert.rejects(fixture().engine.advanceConvergence({workId:'OTHER'}),{code:'ENGINE_PORT_RESULT_INVALID'});
});

test('a native zero-generation preview remains a preview and cannot invent a publication',async()=>{
  const f=fixture({hook(stage,state){if(stage==='review'){state.context.phase.generation=0;state.context.review.generation=0;}}});
  const result=await f.engine.advanceConvergence({});
  assert.equal(result.generation,0);
  assert.equal(result.status,'ready-to-confirm');
  assert.deepEqual(result.effects,{committed:false,pushed:false});
});

test('the review port must enter once and return the actual scoped receipt',async()=>{
  for(const withReview of [async()=>null,
    async(context,operation)=>({...await operation(context),findings:0}),
    async(context,operation)=>{await operation(context);return operation(context); }]) {
    const f=fixture({withReview});
    await assert.rejects(f.engine.advanceConvergence({}),{code:'ENGINE_PORT_RESULT_INVALID'});
    assert.equal(f.calls.includes('commit'),false);
  }
  let late;
  const f=fixture({withReview(context,operation){late=()=>operation(context);return null;}});
  await assert.rejects(f.engine.advanceConvergence({}),{code:'ENGINE_PORT_RESULT_INVALID'});
  await assert.rejects(late(),{code:'ENGINE_PORT_RESULT_INVALID'});
  assert.equal(f.calls.includes('commit'),false);
});

test('a read-only host can preview but cannot turn confirmation into a missing writer',async()=>{
  const f=fixture({submission:false});
  assert.equal((await f.engine.advanceConvergence({})).status,'ready-to-confirm');
  await assert.rejects(f.engine.advanceConvergence(confirmed),error=>error.code==='ENGINE_PORT_UNAVAILABLE'
    && error.engineAdvancement.review.confirmationDigest===digest && error.engineAdvancement.submission===null);
  assert.equal(f.calls.includes('commit'),false);
});

test('input, review and trusted methods are captured before later caller or observer changes',async()=>{
  let received, submitted;
  const f=fixture({hook(stage,state,args){
    if(stage==='review')received=args;
    if(stage==='notice')state.context.review.confirmationDigest=`sha256:${'0'.repeat(64)}`;
    if(stage==='load')submitted=args[0];
  }});
  f.advance.withReview=()=>{throw new Error('redirected review');};
  f.writer.commit=()=>{throw new Error('redirected commit');};
  const input={...confirmed,decisionValues:{}};
  const running=f.engine.advanceConvergence(input);
  input.workId='OTHER';input.decisionValues.changed='later';
  const result=await running;
  assert.equal(result.confirmationDigest,digest);
  assert.equal(submitted.confirmation,digest);
  assert.equal(received.workId,'STORY-1');
  assert.deepEqual(received.decisionValues,{});
  assert.equal(Object.isFrozen(received.decisionValues),true);
});

test('cancellation stops the next effect but cannot undo an accepted submission',async()=>{
  const before=new AbortController();before.abort();
  const untouched=fixture();
  await assert.rejects(untouched.engine.advanceConvergence(confirmed,{signal:before.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
  assert.deepEqual(untouched.calls,[]);
  for(const at of ['review','notice','load','retained','prepare','commit','release']) {
    const controller=new AbortController();
    const f=fixture({hook(stage){if(stage===at)controller.abort();}});
    const running=f.engine.advanceConvergence(confirmed,{signal:controller.signal});
    if(['commit','release'].includes(at))assert.equal((await running).effects.committed,true);
    else {
      await assert.rejects(running,{code:'ENGINE_OPERATION_CANCELLED'});
      assert.equal(f.calls.includes('commit'),false);
    }
  }
});

test('native refusal and unknown-effect identity, cause and recovery details are preserved',async()=>{
  for(const at of ['review','prepare','commit']) {
    const cause=new Error('actual transport deadline');
    const native=new SingularityFlowError('retained publication',{code:'PUBLICATION_PENDING',cause,
      details:{nextAction:'recover the same operation',pushOutcome:'transport-indeterminate'}});
    native.publicationCommit='e'.repeat(40);
    const f=fixture({hook(stage){if(stage===at)throw native;}});
    await assert.rejects(f.engine.advanceConvergence(confirmed),error=>error===native
      && error.cause===cause && error.publicationCommit==='e'.repeat(40)
      && error.details.pushOutcome==='transport-indeterminate');
  }
});

test('post-commit failures retain the actual accepted effect instead of inviting another submission',async()=>{
  for(const at of ['finish','release']) {
    const native=new Error(`native ${at} failed`);
    const f=fixture({hook(stage){if(stage===at)throw native;}});
    await assert.rejects(f.engine.advanceConvergence(confirmed),error=>{
      assert.equal(error,native);
      assert.equal(error.engineAdvancement.review.confirmationDigest,digest);
      if(at==='finish')assert.equal(error.enginePublication.sha,'c'.repeat(40));
      else assert.equal(error.engineAdvancement.submission.effects.committed,true);
      return true;
    });
    assert.equal(f.calls.filter(stage=>stage==='commit').length,1);
  }
});

test('submission cannot change its reviewed generation or claim convergence approval',async()=>{
  for(const mutate of [state=>{state.facts.generation=3;},state=>{
    state.facts.phaseStatus='approved';state.facts.approvalMode='none';
  }]) {
    const f=fixture({hook(stage,state){if(stage==='finish')mutate(state);}});
    await assert.rejects(f.engine.advanceConvergence(confirmed),error=>error.code==='ENGINE_PORT_RESULT_INVALID'
      && error.engineAdvancement.submission.effects.committed===true);
  }
  const f=fixture({hook(stage,state){if(stage==='review')state.context.phase.approvalPolicy.mode='none';}});
  await assert.rejects(f.engine.advanceConvergence(confirmed),{code:'CONVERGENCE_HUMAN_APPROVAL_REQUIRED'});
  assert.equal(f.calls.includes('prepare'),false);
});
