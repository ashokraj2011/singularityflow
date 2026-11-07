import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine,ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';

const sha=letter=>`sha256:${letter.repeat(64)}`;
function fixture(hook=()=>{}) {
  const workflow={workItem:{id:'ROLL-1'},currentPhase:'custom-code',phases:{'custom-code':{
    id:'custom-code',generation:3,generationIntent:{status:'consumed',generation:3}}}};
  const facts={workId:'ROLL-1',phase:'custom-code',fromGeneration:3,toGeneration:4,confirmation:sha('a'),changeSetDigest:sha('a'),currentResultDigest:sha('b')};
  const opened={workId:'ROLL-1',phase:'custom-code',generation:4,intent:{id:'new-intent',sha256:sha('c'),baselineCommit:'published-source',status:'open'}};
  const calls=[],port={};
  for(const stage of ['load','inspect','begin'])port[stage]=async(...args)=>{
    calls.push(stage);await hook(stage,{workflow,facts,opened,args});return stage==='load'?{workflow}:stage==='inspect'?facts:opened;
  };
  return {workflow,facts,opened,calls,engine:createEngine({ports:{phaseRollover:port}})};
}

test('rollover previews through the registry without granting authority or writing a successor',async()=>{
  const descriptor=ENGINE_OPERATIONS.find(operation=>operation.id==='phase.rollover');
  assert.equal(descriptor.confirmation,'exact-current-draft-digest');assert.equal(descriptor.humanDecision,false);
  const f=fixture(),result=await f.engine.rolloverPhase({workId:'ROLL-1',phaseId:'custom-code'});
  assert.equal(result.status,'preview');assert.deepEqual(f.calls,['load','inspect']);assert.equal(result.intent,null);
  assert.equal(result.plan.contract,'sflow-generation-rollover-plan/v1');assert.equal(result.plan.fromGeneration,3);assert.equal(result.plan.toGeneration,4);
  assert.equal(result.plan.confirmation,sha('a'));assert.equal(result.plan.finalBindingChecked,false);assert.equal(result.plan.mutationAuthorityGranted,false);
  for(const key of ['generationOpened','draftSaved','testsRun','committed','pushed','approvalRecorded','storyAdvanced'])assert.equal(result.effects[key],false,key);
  for(const key of ['command','argv','platformCommands','root'])assert.equal(key in result.plan,false,key);
  assert.equal(Object.isFrozen(result.plan),true);
});

test('only the exact current confirmation opens a successor, while preserving the published generation and allocation watermark',async()=>{
  const f=fixture((stage,{workflow,facts,opened,args})=>{
    if(stage==='load'){workflow.phases['custom-code'].generationHighWatermark=6;facts.toGeneration=7;opened.generation=7;}
    if(stage==='begin'){assert.equal(args[2].confirmation,sha('a'));assert.equal(Object.isFrozen(args[2]),true);}
  });
  const before=structuredClone(f.workflow);
  const result=await f.engine.run('phase.rollover',{confirm:sha('a')});
  assert.equal(result.status,'begun');assert.equal(result.generation,7);assert.equal(result.plan.fromGeneration,3);assert.deepEqual(f.calls,['load','inspect','begin']);
  assert.equal(result.effects.localOnly,true);assert.equal(result.effects.generationOpened,true);assert.equal(result.effects.draftSaved,true);
  assert.equal(result.effects.approvalRecorded,false);assert.equal(result.intent.id,'new-intent');assert.equal('path' in result.intent,false);
  assert.equal(f.workflow.phases['custom-code'].generation,before.phases['custom-code'].generation);
  const artifactOnly=fixture((stage,{facts})=>{if(stage==='inspect'){facts.changeSetDigest=null;facts.confirmation=facts.currentResultDigest;}});
  assert.equal((await artifactOnly.engine.run('phase.rollover',{confirm:sha('b')})).status,'begun');
});

test('stale confirmations never invoke the writer; omitted and empty confirmation remain previews',async()=>{
  const f=fixture();
  await assert.rejects(f.engine.run('phase.rollover',{confirm:sha('f')}),error=>error.code==='GENERATION_ROLLOVER_STALE'
    &&error.details.confirmation===sha('a')&&error.enginePhaseRollover.localEffectsMayExist===false);
  assert.deepEqual(f.calls,['load','inspect']);
  assert.equal((await fixture().engine.run('phase.rollover',{confirm:''})).status,'preview');
});

test('host, actor, provider and raw adoption overrides are rejected before native I/O',async()=>{
  const f=fixture();
  for(const input of [{root:'/other'},{actor:'approver'},{provider:'model'},{adoptExisting:true},{workflow:{}},{confirm:true},{phaseId:1},
    {get workId(){throw Error('do not execute');}}])await assert.rejects(f.engine.run('phase.rollover',input),{code:'ENGINE_INPUT_INVALID'});
  assert.deepEqual(f.calls,[]);
  await assert.rejects(f.engine.run('phase.rollover',{workId:'OTHER'}),{code:'ACTIVE_SUBJECT_MISMATCH'});assert.deepEqual(f.calls,['load']);
});

test('a plan cannot substitute the subject, generation, digest or executable guidance',async()=>{
  for(const change of [facts=>{facts.workId='OTHER';},facts=>{facts.phase='OTHER';},facts=>{facts.fromGeneration=2;},
    facts=>{facts.toGeneration=5;},facts=>{facts.confirmation=sha('d');},facts=>{facts.currentResultDigest='invalid';},
    facts=>{facts.changeSetDigest='invalid';},facts=>{facts.commands={begin:'shell'};}]) {
    const f=fixture((stage,{facts})=>{if(stage==='inspect')change(facts);});
    await assert.rejects(f.engine.run('phase.rollover',{confirm:sha('a')}),{code:'ENGINE_PORT_RESULT_INVALID'});
    assert.deepEqual(f.calls,['load','inspect']);
  }
  const bad=fixture((stage,{opened})=>{if(stage==='begin')opened.generation=5;});
  await assert.rejects(bad.engine.run('phase.rollover',{confirm:sha('a')}),error=>error.code==='ENGINE_PORT_RESULT_INVALID'
    &&error.enginePhaseRollover.localEffectsMayExist===true);
});

test('native authority, submitted-generation and recovery errors retain exact identity and are never retried',async()=>{
  for(const code of ['GENERATION_ROLLOVER_REVIEW_REQUIRED','GENERATION_ROLLOVER_UNAVAILABLE','GENERATION_ROLLOVER_ROUTE_UNAVAILABLE','GENERATION_PUBLICATION_MIGRATION_REQUIRED']) {
    const error=new SingularityFlowError('Exact owner recovery',{code,cause:new Error('source unavailable'),details:{recovery:'original'}});
    const f=fixture(stage=>{if(stage==='inspect')throw error;});
    await assert.rejects(f.engine.run('phase.rollover',{confirm:sha('a')}),actual=>actual===error&&actual.cause.message==='source unavailable');
    assert.deepEqual(f.calls,['load','inspect']);assert.equal(error.enginePhaseRollover.localEffectsMayExist,false);
  }
  for(const error of [Object.freeze(new Error('frozen')),Object.defineProperty(new Error('read-only'),'enginePhaseRollover',{value:null,writable:false})]) {
    const f=fixture(stage=>{if(stage==='begin')throw error;});await assert.rejects(f.engine.run('phase.rollover',{confirm:sha('a')}),actual=>actual===error);
  }
});

test('cancellation at every stage stops the next stage and reports possible local effects after begin',async()=>{
  for(const at of ['load','inspect','begin']) {
    const controller=new AbortController(),f=fixture(stage=>{if(stage===at)controller.abort();});
    await assert.rejects(f.engine.run('phase.rollover',{confirm:sha('a')},{signal:controller.signal}),error=>
      error.code==='ENGINE_OPERATION_CANCELLED'&&error.enginePhaseRollover.localEffectsMayExist===(at==='begin'));
    assert.deepEqual(f.calls,at==='load'?['load']:at==='inspect'?['load','inspect']:['load','inspect','begin']);
  }
});

test('unknown or inherited phases are refused without invoking recovery inspection',async()=>{
  for(const phaseId of ['missing','constructor','__proto__']) {
    const f=fixture();await assert.rejects(f.engine.run('phase.rollover',{phaseId}),error=>error.message===`Unknown or unavailable phase '${phaseId}'. Provide a phase ID.`);
    assert.deepEqual(f.calls,['load']);
  }
});
