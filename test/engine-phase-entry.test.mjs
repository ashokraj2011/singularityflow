import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine,ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';
import {currentEntryPhase} from '../src/kernel/phase-admission.mjs';
import {approvedInputPhases as nativeInputs} from '../src/phase-input-policy.mjs';
import {approvedInputPhases} from '../src/kernel/phase-inputs.mjs';

const sha='a'.repeat(64),rendered='b'.repeat(64);
function fixture(hook=()=>{}) {
  const context={paused:false,subject:{kind:'story',id:'STORY-1'},revision:'revision-1',ready:true,
    inspectionGeneration:1,generatesCode:false,codeGenerationReady:false,deterministic:false,agentId:'team-author',
    workflow:{workItem:{id:'STORY-1'},currentPhase:'team-build',phases:{'team-build':{
      id:'team-build',generation:0,status:'in_progress'}},resolution:{inputsMode:'enforce',phases:[{id:'team-build',inputs:[]}]}}};
  const facts={workId:'STORY-1',phase:'team-build',generation:0,inspectionGeneration:1,
    authoring:{entry:{status:'authoring-entry',reason:null},policyVerified:true,policyReason:null,hasAuthoringRoute:true,targetGeneration:null},
    recovery:{requiresRecovery:false,actions:[],blockers:[]},references:{status:'not-configured'},deterministic:false,
    documents:{status:'ready',localDocumentCount:0,documentCount:0,missing:[]},
    resources:['SYS-STORY','SYS-SOURCE'].map(id=>({id,role:'story-source',reference:{kind:'story-document',id,workId:'STORY-1'},
      producer:null,sourceKey:null,required:true,expected:null,locality:'project',availability:'verify-on-read'})),
    budgets:{documentPreviewBytes:1048576,supportingTotalBytes:49152}};
  const composition={workId:'STORY-1',phase:'team-build',generation:1,deliveredSha256:sha,renderedSha256:rendered,bytes:42,fileAvailable:true};
  const clarification={workId:'STORY-1',phase:'team-build',generation:1,mode:'required',recordState:'missing',errorCount:1,
    maxQuestions:6,recordedQuestions:0,recordPromptSha256:null,staleOnly:false,stagingIssued:true};
  const finished={workId:'STORY-1',phase:'team-build',generation:1,task:null},calls=[],args={},port={};
  for(const stage of ['load','inspect','compose','clarify','finish'])port[stage]=async(...values)=>{
    calls.push(stage);args[stage]=values;
    const replacement=await hook(stage,{context,facts,composition,clarification,finished,calls},values);
    return replacement!==undefined?replacement:{load:context,inspect:facts,compose:composition,clarify:clarification,finish:finished}[stage];
  };
  return {context,facts,composition,clarification,finished,calls,args,engine:createEngine({ports:{phaseEntry:port}})};
}

test('entry is a registered context operation with manifests, and never tests, approves or advances',async()=>{
  const descriptor=ENGINE_OPERATIONS.find(operation=>operation.id==='phase.enter');
  assert.equal(descriptor.effect,'context-entry');assert.equal(descriptor.humanDecision,false);
  const f=fixture(),result=await f.engine.run('phase.enter',{});
  assert.deepEqual(f.calls,['load','inspect','clarify','finish']);assert.equal(result.status,'clarification-required');
  assert.equal(result.authoringAllowed,false);assert.equal(result.admission.allowed,true);assert.equal(result.contextComposition,'not-requested');
  assert.equal(result.manifest.contract,'sflow-phase-entry-manifest/v1');assert.equal(result.manifest.clarification.contextRequired,true);
  assert.deepEqual(result.manifest.resources.map(item=>item.id),['SYS-SOURCE','SYS-STORY']);
  assert.equal(Object.isFrozen(result.manifest.resources[0]),true);assert.equal('sourceKey' in result.manifest.resources[0],false);
  for(const key of ['testsRun','storyAdvanced','committed','pushed','approvalRecorded'])assert.equal(result.effects[key],false,key);
  assert.equal(result.effects.modelInvocations,0);assert.equal('commandGuidance' in result,false);
});

test('composition is explicit and admitted, with rendered answer binding distinct from delivered text',async()=>{
  const f=fixture(),result=await f.engine.run('phase.enter',{workId:'STORY-1',phaseId:'team-build',compose:true});
  assert.deepEqual(f.calls,['load','inspect','compose','clarify','finish']);
  assert.equal(result.contextComposition,'delivered');assert.equal(result.manifest.context.deliveredSha256,sha);
  assert.equal(result.manifest.clarification.answerBinding.promptSha256,rendered);
  assert.equal(result.manifest.clarification.contextRequired,false);assert.equal(result.manifest.clarification.questioningAllowed,true);
  assert.equal('text' in result.manifest.context,false);assert.equal('file' in result.manifest.context,false);
});

test('host flags, model/provider requests, raw context, authority and accessors are rejected before I/O',async()=>{
  const f=fixture();
  for(const input of [{root:'/other'},{cwd:'/other'},{modelEnabled:false},{provider:'other'},{actor:'forged'},
    {workflow:{}},{context:{}},{agentId:'override'},{phaseId:7},{compose:'true'},
    {get workId(){throw Error('do not execute');}}])await assert.rejects(f.engine.run('phase.enter',input),{code:'ENGINE_INPUT_INVALID'});
  assert.deepEqual(f.calls,[]);
});

test('pause and missing binding do not load authoring or consume clarification/context stages',async()=>{
  const paused=fixture(stage=>stage==='load'?{paused:true}:undefined),result=await paused.engine.run('phase.enter',{compose:true});
  assert.equal(result.status,'paused');assert.equal(result.subject,null);assert.equal(result.manifest,null);assert.deepEqual(paused.calls,['load']);
  const missing=fixture((stage,{context})=>{if(stage==='load')context.ready=false;});
  const held=await missing.engine.run('phase.enter',{compose:true});
  assert.deepEqual(missing.calls,['load','finish']);assert.equal(held.status,'binding-required');assert.equal(held.manifest,null);
  assert.deepEqual(held.admission.blockers,[{code:'PHASE_CONTEXT_BINDING_REQUIRED'}]);
});

test('composition cannot cross policy, agent-route, recovery, reference or worktree authority gates',async()=>{
  const changes=[facts=>{facts.authoring.policyVerified=false;},facts=>{facts.authoring.hasAuthoringRoute=false;},
    facts=>{facts.recovery.requiresRecovery=true;},facts=>{facts.references.status='blocked';},facts=>{
      facts.recovery.actions=[{id:'working-tree',automatic:false,mode:'manual',confirmation:'human-authority',paths:['other.txt'],
        unexpectedPaths:['other.txt'],authoringContinuation:null}];}];
  for(const change of changes) {
    const f=fixture((stage,{facts})=>{if(stage==='inspect')change(facts);});
    const result=await f.engine.run('phase.enter',{compose:true});
    assert.equal(result.admission.allowed,false);assert.equal(result.contextComposition,'not-admitted');assert.equal(result.authoringAllowed,false);
    assert.equal(f.calls.includes('compose'),false);assert.equal(result.manifest.clarification.questioningAllowed,false);
  }
  const deterministic=fixture((stage,{context,facts})=>{if(stage==='load')context.deterministic=true;if(stage==='inspect')facts.deterministic=true;});
  assert.equal((await deterministic.engine.run('phase.enter',{compose:true})).admission.blockers[0].code,'PHASE_CONTEXT_DETERMINISTIC');
});

test('settled clarifications are reused; code edits still require an open native generation',async()=>{
  const f=fixture((stage,{context,clarification})=>{
    if(stage==='load')context.generatesCode=true;
    if(stage==='clarify')Object.assign(clarification,{recordState:'complete',errorCount:0,recordedQuestions:2,recordPromptSha256:rendered});
  });
  const result=await f.engine.run('phase.enter',{compose:true});
  assert.equal(result.authoringAllowed,true);assert.equal(result.codeAuthoringReady,false);
  assert.equal(result.manifest.clarification.questioningAllowed,false);assert.equal(result.manifest.clarification.remainingQuestions,4);
  assert.equal(f.args.finish[2].plan.newQuestionAllowed,true);assert.equal(f.args.finish[2].plan.recordingAllowed,false);
});

test('stale recorded answers require human rebinding and cannot be accepted by entry',async()=>{
  const f=fixture((stage,{clarification})=>{if(stage==='clarify')Object.assign(clarification,{
    recordState:'stale-or-incomplete',staleOnly:true,recordedQuestions:2,recordPromptSha256:'c'.repeat(64)});});
  const result=await f.engine.run('phase.enter',{compose:true});
  assert.equal(result.authoringAllowed,false);assert.equal(result.manifest.clarification.staleOnly,true);
  assert.equal(result.manifest.clarification.answerBinding.promptSha256,rendered);assert.equal(f.args.finish[2].plan.rebindAllowed,true);
});

test('a retained input cannot disappear or have its captured hash replaced during inspection',async()=>{
  const f=fixture((stage,{context,facts})=>{
    if(stage==='load') {
      context.workflow.resolution.phases[0].inputs=['team-plan'];
      context.workflow.phases['team-plan']={id:'team-plan',generation:2,status:'approved',artifacts:[{path:'plan.md',sha256:sha,size:24}]};
    }
    if(stage==='inspect')facts.resources.push({id:'INPUT-team-plan',role:'approved-input',producer:'team-plan',sourceKey:'plan.md',required:true,
      reference:{kind:'phase-document',id:'opaque-plan',workId:'STORY-1',phase:'team-plan',generation:2},expected:{sha256:'d'.repeat(64),bytes:24},
      locality:'project',availability:'verify-on-read'});
  });
  await assert.rejects(f.engine.run('phase.enter'),{code:'ENGINE_PORT_RESULT_INVALID'});
  assert.deepEqual(f.calls,['load','inspect']);
});

test('a native stage cannot switch the captured phase/generation or smuggle prompt/command content',async()=>{
  for(const change of [facts=>{facts.phase='other';},facts=>{facts.generation=2;},facts=>{facts.authoring.command='shell';},
    facts=>{facts.resources.pop();},facts=>{facts.resources[0].reference.workId='OTHER';}]) {
    const f=fixture((stage,{facts})=>{if(stage==='inspect')change(facts);});
    await assert.rejects(f.engine.run('phase.enter',{compose:true}),{code:'ENGINE_PORT_RESULT_INVALID'});
    assert.deepEqual(f.calls,['load','inspect']);
  }
  const prompt=fixture((stage,{composition})=>{if(stage==='compose')composition.text='Provider prompt prose';});
  await assert.rejects(prompt.engine.run('phase.enter',{compose:true}),{code:'ENGINE_PORT_RESULT_INVALID'});
});

test('interrupted tasks and exhausted budgets stay visible and cannot authorize new code edits',async()=>{
  const f=fixture((stage,{context,clarification,finished})=>{
    if(stage==='load')Object.assign(context,{generatesCode:true,codeGenerationReady:true});
    if(stage==='clarify')Object.assign(clarification,{recordState:'complete',errorCount:0,recordedQuestions:1,recordPromptSha256:rendered});
    if(stage==='finish')finished.task={operationId:'opaque-task',state:'inspect-interrupted-operation',continuationBudget:{consumed:3,maximum:0}};
  });
  const result=await f.engine.run('phase.enter');
  assert.equal(result.status,'attention-required');assert.equal(result.authoringAllowed,false);assert.equal(result.codeAuthoringReady,false);
  assert.deepEqual(result.manifest.task.continuationBudget,{consumed:3,maximum:0});
});

test('native errors and cancellation preserve partial local effects, without retries or rollback claims',async()=>{
  for(const at of ['load','inspect','compose','clarify','finish']) {
    const error=new SingularityFlowError('Original entry failure.',{code:'EACCES',cause:new Error('local volume'),details:{recovery:'original route'}});
    const f=fixture(stage=>{if(stage===at)throw error;});
    await assert.rejects(f.engine.run('phase.enter',{compose:true}),actual=>actual===error&&actual.cause.message==='local volume');
    assert.equal(f.calls.filter(stage=>stage===at).length,1);assert.equal(error.enginePhaseEntry.pendingStage,at);
    const controller=new AbortController(),cancelled=fixture(stage=>{if(stage===at)controller.abort();});
    await assert.rejects(cancelled.engine.run('phase.enter',{compose:true},{signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
    assert.equal(cancelled.calls.at(-1),at);
  }
});

test('clarification stage and question permission come from kernel policy, never a port-provided override',async()=>{
  for(const change of [value=>{value.stage='complete';},value=>{value.questioningAllowed=false;},value=>{value.errorCount=0;},
    value=>{value.maxQuestions=11;},value=>{value.recordState='complete';value.errorCount=0;}]) {
    const f=fixture((stage,{clarification})=>{if(stage==='clarify')change(clarification);});
    await assert.rejects(f.engine.run('phase.enter'),{code:'ENGINE_PORT_RESULT_INVALID'});
    assert.equal(f.calls.includes('finish'),false);
  }
  const malformed=fixture((stage,{clarification})=>{if(stage==='clarify')Object.assign(clarification,{
    recordState:'stale-or-incomplete',recordPromptSha256:'declared-invalid-hash'});});
  const result=await malformed.engine.run('phase.enter');
  assert.equal(result.authoringAllowed,false);assert.equal(result.manifest.clarification.stage,'inspect-binding');
  assert.equal(result.manifest.clarification.answerBinding.promptSha256,'declared-invalid-hash','unverified diagnostics are preserved, without acceptance');
});

test('phase selection and input selection have one pure owner, including custom names and terminal inspection',()=>{
  assert.equal(nativeInputs,approvedInputPhases);
  const workflow={currentPhase:null,phases:{}};
  assert.equal(currentEntryPhase(workflow,null,{allowTerminal:true}),null);
  for(const id of ['unknown','constructor','__proto__'])assert.throws(()=>currentEntryPhase(workflow,id),{code:'PHASE_DRAFT_NOT_ACTIVE'});
  workflow.currentPhase='constructor';workflow.phases.constructor={id:'constructor'};
  assert.equal(currentEntryPhase(workflow).id,'constructor');
});

test('entry diagnostics cannot mask a native error whose diagnostic property is read-only',async()=>{
  const original=Object.defineProperty(new Error('Original native refusal'),'enginePhaseEntry',{value:null,writable:false});
  const f=fixture(stage=>{if(stage==='inspect')throw original;});
  await assert.rejects(f.engine.run('phase.enter'),error=>error===original);
});
