import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine,ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';
import {storyDraftTransaction} from '../src/engine-compatibility/story-draft-transaction.mjs';
import {storyDraftTransaction as oldDraftTransaction} from '../src/commands/shared/story-draft-transaction.mjs';

const sha=`sha256:${'a'.repeat(64)}`;
function fixture(hook=()=>{}) {
  const workflow={workItem:{id:'BEGIN-1'},currentPhase:'custom-code',phases:{'custom-code':{id:'custom-code',generation:0}}};
  const facts={workId:'BEGIN-1',phase:'custom-code',generation:1,intent:{id:'intent-1',sha256:sha,baselineCommit:'source-revision',status:'open'}};
  const calls=[],port={};
  for(const stage of ['load','verify','begin'])port[stage]=async(...args)=>{
    calls.push(stage);await hook(stage,{workflow,facts,args});
    return stage==='load'?{workflow}:facts;
  };
  return {workflow,facts,calls,engine:createEngine({ports:{phaseBegin:port}})};
}

test('local generation begin is registered once, including its typed helper and explicit adoption data',async()=>{
  const descriptor=ENGINE_OPERATIONS.find(operation=>operation.id==='phase.begin');
  assert.equal(descriptor.effect,'local-draft');assert.equal(descriptor.humanDecision,false);
  let supplied;
  const f=fixture((stage,{args})=>{if(stage==='begin')supplied=args[2];});
  const result=await f.engine.beginPhase({phaseId:'custom-code',workId:'BEGIN-1',adoptExisting:true,confirm:'reviewed-digest'});
  assert.deepEqual(f.calls,['load','begin']);assert.equal(result.operation,'phase.begin');assert.equal(result.status,'begun');
  assert.equal(result.effects.generationOpened,true);assert.equal(result.effects.draftSaved,true);
  assert.equal(supplied.confirm,'reviewed-digest');assert.equal(supplied.adoptExisting,true);
  for(const name of ['committed','pushed','approvalRecorded','storyAdvanced','testsRun'])assert.equal(result.effects[name],false);
  assert.equal(result.effects.modelInvocations,0);assert.equal(Object.isFrozen(result.intent),true);
  assert.equal('path' in result.intent,false);assert.equal('actor' in result.intent,false);
});

test('an existing open intent is verified rather than replaced; high-watermarks select the exact successor',async()=>{
  const f=fixture((stage,{workflow,facts})=>{if(stage==='load'){
    workflow.phases['custom-code'].generationHighWatermark=3;
    workflow.phases['custom-code'].generationIntent={id:'intent-1',status:'open',generation:4,receiptSha256:sha,baseline:{commit:'source-revision'}};
    facts.generation=4;
  }});
  const result=await f.engine.run('phase.begin');
  assert.equal(result.status,'retained');assert.equal(result.generation,4);assert.deepEqual(f.calls,['load','verify']);
  assert.equal(result.effects.generationOpened,false);assert.equal(result.effects.draftSaved,false);
});

test('host, provider, actor and raw-state overrides are refused before invoking native code',async()=>{
  const f=fixture();
  for(const input of [{root:'/other'},{cwd:'/other'},{provider:'model'},{actor:'owner'},{workflow:{}},
    {adoptExisting:'true'},{confirm:true},{phaseId:3},{get workId(){throw Error('must not run');}}]) {
    await assert.rejects(f.engine.run('phase.begin',input),{code:'ENGINE_INPUT_INVALID'});
  }
  assert.deepEqual(f.calls,[]);
  await assert.rejects(f.engine.run('phase.begin',{workId:'OTHER'}),{code:'ACTIVE_SUBJECT_MISMATCH'});
  assert.deepEqual(f.calls,['load']);
});

test('native facts cannot change the captured generation, intent or provenance or expose private data',async()=>{
  for(const change of [facts=>{facts.workId='OTHER';},facts=>{facts.phase='other';},facts=>{facts.generation=2;},
    facts=>{facts.intent.sha256='invalid';},facts=>{facts.intent.status='consumed';},facts=>{facts.intent.path='/private/receipt';}]) {
    const f=fixture((stage,{facts})=>{if(stage==='begin')change(facts);});
    await assert.rejects(f.engine.run('phase.begin'),{code:'ENGINE_PORT_RESULT_INVALID'});
    assert.deepEqual(f.calls,['load','begin']);
  }
  const retained=fixture((stage,{workflow,facts})=>{
    if(stage==='load')workflow.phases['custom-code'].generationIntent={id:'intent-1',status:'open',generation:1,receiptSha256:sha,baseline:{commit:'source-revision'}};
    if(stage==='verify')facts.intent.id='substituted-intent';
  });
  await assert.rejects(retained.engine.run('phase.begin'),{code:'ENGINE_PORT_RESULT_INVALID'});
});

test('native authority/refusal errors and cancellation keep local-effect diagnostics without retrying',async()=>{
  for(const stage of ['load','begin','verify']) {
    const original=new SingularityFlowError('Exact native refusal',{code:'GENERATION_DIRTY_START',cause:new Error('disk'),details:{recovery:'original'}});
    const f=fixture((at,{workflow})=>{
      if(at==='load'&&stage==='verify')workflow.phases['custom-code'].generationIntent={id:'intent-1',status:'open',generation:1,receiptSha256:sha,baseline:{commit:'source-revision'}};
      if(at===stage)throw original;
    });
    await assert.rejects(f.engine.run('phase.begin'),error=>error===original&&error.cause.message==='disk');
    assert.equal(original.enginePhaseBegin.pendingStage,stage);
    assert.equal(original.enginePhaseBegin.localEffectsMayExist,stage==='begin');
    assert.equal(f.calls.filter(value=>value===stage).length,1);
  }
  const controller=new AbortController(),cancelled=fixture(stage=>{if(stage==='begin')controller.abort();});
  await assert.rejects(cancelled.engine.run('phase.begin',{}, {signal:controller.signal}),error=>
    error.code==='ENGINE_OPERATION_CANCELLED'&&error.enginePhaseBegin.localEffectsMayExist===true);
  assert.deepEqual(cancelled.calls,['load','begin']);
});

test('unknown and inherited phase names are rejected and the old transaction export has no second implementation',async()=>{
  assert.equal(oldDraftTransaction,storyDraftTransaction);
  const f=fixture();
  for(const phaseId of ['missing','constructor','__proto__'])await assert.rejects(f.engine.run('phase.begin',{phaseId}),
    error=>error.message===`Unknown or unavailable phase '${phaseId}'. Provide a phase ID.`);
});

test('an incomplete retained intent reaches native verification and keeps its original refusal',async()=>{
  const original=new SingularityFlowError('The open generation intent has no durable receipt path.',{code:'GENERATION_INTENT_REQUIRED'});
  const f=fixture((stage,{workflow})=>{
    if(stage==='load')workflow.phases['custom-code'].generationIntent={status:'open',generation:1};
    if(stage==='verify')throw original;
  });
  await assert.rejects(f.engine.run('phase.begin'),error=>error===original);
  assert.deepEqual(f.calls,['load','verify']);
});

test('read-only or frozen diagnostic properties cannot replace the original native error',async()=>{
  for(const original of [Object.freeze(new Error('Frozen native error')),Object.defineProperty(new Error('Read-only diagnostics'),
    'enginePhaseBegin',{value:null,writable:false})]) {
    const f=fixture(stage=>{if(stage==='begin')throw original;});
    await assert.rejects(f.engine.run('phase.begin'),error=>error===original);
  }
});
