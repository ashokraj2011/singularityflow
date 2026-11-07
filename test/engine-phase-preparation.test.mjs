import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine,ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';
import * as kernel from '../src/kernel/phase-policy.mjs';
import * as legacy from '../src/code-delivery-policy.mjs';
import {convergencePreparationState} from '../src/kernel/phase-preparation.mjs';
import {convergencePreparationState as oldSummary} from '../src/commands/shared/convergence-preparation-state.mjs';

const sha=`sha256:${'a'.repeat(64)}`;
function fixture(hook=()=>{}) {
  const phase={id:'custom-draft',status:'in_progress',generation:0,
    generationPolicy:{defaultProducer:'governed-agent',allowedProducers:['governed-agent','human'],task:'document'},
    requiredArtifact:{path:'artifacts/custom/draft.md',kind:'requirements'}};
  const workflow={workItem:{id:'PREPARE-1'},currentPhase:phase.id,phases:{[phase.id]:phase}};
  const context={workflow,modelEnabled:true};
  const facts={workId:'PREPARE-1',phase:phase.id,generation:1,producer:'governed-agent',artifactKey:phase.requiredArtifact.path,
    inputContext:null,generationIntent:null,convergence:null,generationOpened:false};
  const calls=[],port={};
  for(const stage of ['load','prepare','inspect'])port[stage]=async(...args)=>{
    calls.push(stage);await hook(stage,{context,workflow,phase,facts,args});
    return stage==='load'?context:stage==='inspect'?facts:undefined;
  };
  return {context,workflow,phase,facts,calls,engine:createEngine({ports:{phasePreparation:port}})};
}

test('preparation has one registry path and describes a prepared artifact without claiming authoring, evidence or publication',async()=>{
  const descriptor=ENGINE_OPERATIONS.find(operation=>operation.id==='phase.prepare');
  assert.equal(descriptor.effect,'preparation');assert.equal(descriptor.humanDecision,false);
  const f=fixture(),result=await f.engine.preparePhase({workId:'PREPARE-1',phaseId:'custom-draft'});
  assert.deepEqual(f.calls,['load','prepare','inspect']);assert.equal(result.status,'prepared');
  assert.equal(result.manifest.contract,'sflow-phase-preparation-manifest/v1');assert.equal(result.manifest.mode,'phase-draft');
  assert.deepEqual(result.manifest.artifact,{key:'artifacts/custom/draft.md',contentVerified:false});
  assert.equal(result.manifest.authoringRequired,true);assert.equal(result.manifest.codeDeliveryRequired,false);
  for(const key of ['publicationReadinessInspected','finalBindingChecked','testsRun','approvalRecorded','humanReviewRecorded'])assert.equal(result.manifest[key],false,key);
  for(const key of ['generationOpened','testsRun','committed','pushed','approvalRecorded','storyAdvanced'])assert.equal(result.effects[key],false,key);
  assert.equal(result.effects.prepared,true);assert.equal(result.effects.localDraftSaved,true);assert.equal(result.effects.modelInvocations,0);
  for(const key of ['commands','prompt','root','text'])assert.equal(key in result.manifest,false,key);
  assert.equal(Object.isFrozen(result.manifest.artifact),true);
});

test('a deterministic code summary still requires application authoring, while custom convergence is a native projection',async()=>{
  const code=fixture((stage,{phase,facts})=>{
    if(stage==='load'){
      phase.generationPolicy={defaultProducer:'deterministic',allowedProducers:['deterministic'],task:'code'};
      phase.requiredArtifact.kind='implementation-summary';facts.producer='deterministic';
    }
    if(stage==='inspect'){
      facts.generationIntent={id:'new-intent',generation:1,sha256:sha};facts.generationOpened=true;
    }
  });
  const result=await code.engine.run('phase.prepare');
  assert.equal(result.manifest.authoringRequired,true);assert.equal(result.manifest.codeDeliveryRequired,true);
  assert.equal(result.manifest.mode,'phase-draft');assert.equal(result.effects.generationOpened,true);
  assert.equal(result.manifest.generationIntent.integrityVerified,false,'the normal edit guard still verifies this local receipt');

  const convergence=fixture((stage,{phase,facts})=>{if(stage==='load'){
    phase.generationPolicy={defaultProducer:'deterministic',allowedProducers:['deterministic'],task:'document'};
    phase.requiredArtifact.kind='convergence-report';facts.producer='deterministic';
    facts.convergence={iteration:2,sha256:sha,factCount:1,settledCount:10,findingCount:0,
      undisposedItemIds:['fact-pending'],unresolvedBlockerCount:1};
  }});
  const projection=await convergence.engine.run('phase.prepare');
  assert.equal(projection.manifest.mode,'deterministic-convergence');assert.equal(projection.manifest.authoringRequired,false);
  assert.equal(projection.manifest.codeDeliveryRequired,false);
  assert.deepEqual(projection.manifest.convergence.undisposedItemIds,['fact-pending']);
  assert.equal(projection.manifest.convergence.settledCount,10,'settled paths and fact counts are different units');
  assert.equal(projection.manifest.approvalRecorded,false);
});

test('the trusted host model mode selects the existing manual fallback without becoming an input override',async()=>{
  const f=fixture((stage,{context,facts,args})=>{
    if(stage==='load')context.modelEnabled=false;
    if(stage==='prepare'){assert.equal(args[1].producer,'human');facts.producer='human';}
  });
  assert.equal((await f.engine.run('phase.prepare')).manifest.producer,'human');
  const invalid=fixture(stage=>{});delete invalid.context.modelEnabled;
  await assert.rejects(invalid.engine.run('phase.prepare'),{code:'ENGINE_PORT_RESULT_INVALID'});
  assert.deepEqual(invalid.calls,['load']);
});

test('legacy and current code/kernel ownership predicates keep one pure implementation and their exact distinctions',()=>{
  for(const name of ['phaseRequiresCodeDelivery','phaseKernelOwned','deterministicOnlyGeneration'])assert.equal(legacy[name],kernel[name]);
  assert.equal(oldSummary,convergencePreparationState);
  for(const phase of [null,{id:'implementation',generationPolicy:{task:'document'}},{id:'verification',generationPolicy:{task:'analyze'},requiredArtifact:{kind:'implementation-summary'}}])assert.equal(kernel.phaseRequiresCodeDelivery(phase),false);
  for(const phase of [{id:'planning',generationPolicy:{task:'code'}},{id:'custom',requiredArtifact:{kind:'implementation-summary'}},
    {generation:{task:'code'},artifact:{kind:'document'}}])assert.equal(kernel.phaseRequiresCodeDelivery(phase),true);
  assert.equal(kernel.phaseKernelOwned({generation:{producer:'deterministic',task:'document'}}),true);
  assert.equal(kernel.phaseKernelOwned({generationPolicy:{defaultProducer:'deterministic',allowedProducers:['deterministic'],task:'code'}}),false);
  assert.equal(kernel.deterministicOnlyGeneration({generation:{allowedProducers:['deterministic','human']}}),false);
});

test('recorded input and open-intent generations remain observed provenance rather than new verification',async()=>{
  const f=fixture((stage,{facts})=>{if(stage==='inspect'){
    facts.inputContext={generation:0,sha256:sha,renderedSha256:null};
    facts.generationIntent={id:null,generation:0,sha256:null};
  }});
  const result=await f.engine.run('phase.prepare');
  assert.equal(result.manifest.inputContext.forPreparedGeneration,false);assert.equal(result.manifest.inputContext.integrityVerified,false);
  assert.equal(result.manifest.generationIntent.forPreparedGeneration,false);assert.equal(result.effects.generationOpened,false);
});

test('host, actor, raw-state and provider fields are rejected before native I/O',async()=>{
  const f=fixture();
  for(const input of [{root:'/other'},{actor:'reviewer'},{workflow:{}},{modelEnabled:false},{provider:'model'},{forAgent:true},
    {phaseId:3},{adoptExisting:true},{get workId(){throw Error('do not execute');}}])await assert.rejects(f.engine.run('phase.prepare',input),{code:'ENGINE_INPUT_INVALID'});
  assert.deepEqual(f.calls,[]);
  await assert.rejects(f.engine.run('phase.prepare',{workId:'OTHER'}),{code:'ACTIVE_SUBJECT_MISMATCH'});
  assert.deepEqual(f.calls,['load']);
});

test('native facts cannot substitute a generation, producer, artifact, convergence mode or executable command',async()=>{
  for(const change of [facts=>{facts.workId='OTHER';},facts=>{facts.phase='OTHER';},facts=>{facts.generation=2;},
    facts=>{facts.producer='human';},facts=>{facts.artifactKey='other.md';},facts=>{facts.command='shell';},
    facts=>{facts.inputContext={generation:1,sha256:'invalid',renderedSha256:sha};},facts=>{facts.generationOpened=true;},
    facts=>{facts.convergence={iteration:1,sha256:sha,factCount:0,settledCount:0,findingCount:0,undisposedItemIds:[],unresolvedBlockerCount:0};}]) {
    const f=fixture((stage,{facts})=>{if(stage==='inspect')change(facts);});
    await assert.rejects(f.engine.run('phase.prepare'),error=>error.code==='ENGINE_PORT_RESULT_INVALID'&&error.enginePhasePreparation.localEffectsMayExist===true);
    assert.deepEqual(f.calls,['load','prepare','inspect']);
  }
});

test('preparation preserves native failures and interruption, without retries or an invented rollback',async()=>{
  for(const at of ['load','prepare','inspect']) {
    const error=new SingularityFlowError('Exact native failure',{code:'PHASE_NATIVE_FAILURE',cause:new Error('disk'),details:{recovery:'native receipt route'}});
    const f=fixture(stage=>{if(stage===at)throw error;});
    await assert.rejects(f.engine.run('phase.prepare'),actual=>actual===error&&actual.cause.message==='disk'&&actual.details.recovery==='native receipt route');
    assert.equal(error.enginePhasePreparation.pendingStage,at);assert.equal(error.enginePhasePreparation.localEffectsMayExist,at!=='load');
    assert.equal(f.calls.filter(stage=>stage===at).length,1);
  }
  for(const error of [Object.freeze(new Error('frozen')),Object.defineProperty(new Error('read-only'),'enginePhasePreparation',{value:null,writable:false})]) {
    const f=fixture(stage=>{if(stage==='prepare')throw error;});await assert.rejects(f.engine.run('phase.prepare'),actual=>actual===error);
  }
  for(const at of ['load','prepare','inspect']) {
    const controller=new AbortController(),f=fixture(stage=>{if(stage===at)controller.abort();});
    await assert.rejects(f.engine.run('phase.prepare',{}, {signal:controller.signal}),error=>
      error.code==='ENGINE_OPERATION_CANCELLED'&&error.enginePhasePreparation.localEffectsMayExist===(at!=='load'));
    assert.deepEqual(f.calls,at==='load'?['load']:at==='prepare'?['load','prepare']:['load','prepare','inspect']);
  }
});

test('preparation captures the monotonic generation without enumerating unrelated artifacts or history',async()=>{
  const f=fixture((stage,{workflow,phase,facts,args})=>{
    if(stage==='load'){
      phase.generationHighWatermark=3;facts.generation=4;
      Object.defineProperty(workflow,'lineage',{get(){throw Error('Unrelated history');}});
      Object.defineProperty(phase,'artifacts',{get(){throw Error('Unrelated inventory');}});
    }
    if(stage==='prepare')assert.equal(Object.isFrozen(args[1]),true);
  });
  assert.equal((await f.engine.run('phase.prepare')).generation,4);
  for(const phaseId of ['missing','constructor','__proto__'])await assert.rejects(f.engine.run('phase.prepare',{phaseId}));
});
