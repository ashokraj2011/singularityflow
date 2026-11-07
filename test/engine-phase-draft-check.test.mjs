import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine,ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';

const finding=(patch={})=>({code:'artifact.template.unchanged',sourceCode:null,category:'authoring',message:'Exact native diagnostic.',
  phaseId:null,path:'draft.md',line:3,clauseId:null,upstreamDecisionComplete:false,coverageReviewRequired:false,riskEligible:false,...patch});
function fixture(hook=()=>{}) {
  const workflow={workItem:{id:'DRAFT-1'},currentPhase:'custom-draft',phases:{'custom-draft':{id:'custom-draft',status:'in_progress',generation:0}}};
  const facts={workId:'DRAFT-1',phase:'custom-draft',generation:1,phaseStatus:'in_progress',inspectionStage:'authoring',
    producer:'governed-agent',qualityDisposition:'checked',draftFingerprint:'native-fingerprint',findings:[],advisories:[],warningCount:0,
    correction:{class:'agent-authoring',sameTurn:false,requiresNewGeneration:false},task:null};
  const calls=[],port={};
  for(const stage of ['load','inspect'])port[stage]=async(...args)=>{
    calls.push(stage);await hook(stage,{workflow,facts,args});return stage==='load'?{workflow}:facts;
  };
  return {workflow,facts,calls,engine:createEngine({ports:{phaseDraftCheck:port}})};
}

test('draft-check uses the registry and reports draft health without claiming publication admission',async()=>{
  const descriptor=ENGINE_OPERATIONS.find(operation=>operation.id==='phase.draft-check');
  assert.equal(descriptor.effect,'inspection');assert.equal(descriptor.humanDecision,false);
  const f=fixture(),result=await f.engine.draftCheckPhase({workId:'DRAFT-1',phaseId:'custom-draft'});
  assert.deepEqual(f.calls,['load','inspect']);assert.equal(result.operation,'phase.draft-check');assert.equal(result.status,'ready');
  assert.equal(result.manifest.contract,'sflow-phase-draft-manifest/v1');assert.equal(result.manifest.draftReady,true);
  assert.equal(result.manifest.inspectionScope,'authored-draft');assert.equal(result.manifest.publicationReadinessInspected,false);
  for(const key of ['readiness','admittedForAttempt','commands','prompt'])assert.equal(key in result.manifest,false,key);
  for(const key of ['finalBindingChecked','testsRun','mutationAuthorityGranted','approvalRecorded','humanReviewRecorded'])assert.equal(result.manifest[key],false,key);
  for(const key of ['draftChanged','testsRun','committed','pushed','approvalRecorded','storyAdvanced','finalBindingChecked'])assert.equal(result.effects[key],false,key);
  assert.equal(result.effects.localProgressMayBeWritten,true);assert.equal(result.effects.modelInvocations,0);
  assert.equal(Object.isFrozen(result.manifest),true);
});

test('draft findings keep their diagnostic, integrity priority and upstream owner; advisories do not block',async()=>{
  const f=fixture((stage,{facts})=>{if(stage==='inspect'){
    facts.findings=[finding(),finding({code:'GENERATION_BINDING_REQUIRED',sourceCode:'artifact.required.too-short'}),
      finding({code:'conformance.verdict-incomplete',phaseId:'earlier-owner'}),finding({code:'conformance.verdict-incomplete'})];
    facts.correction.sameTurn=true;
  }});
  const result=await f.engine.run('phase.draft-check'),rows=result.manifest.findings;
  assert.equal(result.status,'correction-required');assert.equal(result.manifest.draftReady,false);
  assert.equal(rows[0].message,'Exact native diagnostic.');assert.equal(rows[0].affectedPhase,'custom-draft');
  assert.equal(rows[0].policy.repairableByProducer,true);assert.equal(rows[1].policy.classification,'integrity-or-authority');
  assert.equal(rows[2].affectedPhase,'earlier-owner');assert.equal(rows[3].affectedPhase,null,'unknown upstream ownership is not assigned to this author');
  for(const row of rows)assert.equal(row.policy.automaticRiskAcceptance,false);
  const advisory=fixture((stage,{facts})=>{if(stage==='inspect')facts.advisories=[{
    code:'conformance.verdict-incomplete',category:'traceability',message:'Honest partial outcome.',requiredBefore:'approve',
    ownerPhase:'verification-owner',clauseId:'DRAFT-1:AC-001',issueRefs:['UPI-001'],status:'open'}];});
  const green=await advisory.engine.run('phase.draft-check');assert.equal(green.status,'ready');
  assert.deepEqual(green.manifest.advisories[0],advisory.facts.advisories[0]);
});

test('retained, submitted and custom phases keep their exact inspection binding without authoring permission',async()=>{
  for(const status of ['in_progress','awaiting_approval']) {
    const f=fixture((stage,{workflow,facts})=>{if(stage==='load'){
      Object.assign(workflow.phases['custom-draft'],{status,generation:4,generationIntent:{generation:4,status:'consumed'}});
      Object.assign(facts,{generation:4,phaseStatus:status,inspectionStage:'published'});
    }});
    const result=await f.engine.run('phase.draft-check');assert.equal(result.generation,4);assert.equal(result.status,'ready');
    assert.equal(result.manifest.inspectionStage,'published');assert.equal(result.manifest.mutationAuthorityGranted,false);
    assert.equal(result.manifest.publicationReadinessInspected,false);
  }
  const inactive=fixture();inactive.workflow.phases.old={id:'old',status:'approved',generation:2};
  await assert.rejects(inactive.engine.run('phase.draft-check',{phaseId:'old'}),{code:'PHASE_DRAFT_NOT_ACTIVE'});
  for(const phaseId of ['missing','constructor','__proto__'])await assert.rejects(inactive.engine.run('phase.draft-check',{phaseId}));
  const mismatch=fixture();await assert.rejects(mismatch.engine.run('phase.draft-check',{workId:'OTHER'}),{code:'ACTIVE_SUBJECT_MISMATCH'});
  assert.deepEqual(mismatch.calls,['load']);
});

test('host preferences and unsafe inputs are refused before I/O; facts cannot invent readiness or executable routes',async()=>{
  const f=fixture();
  for(const input of [{root:'/other'},{forAgent:true},{actor:'reviewer'},{provider:'model'},{modelEnabled:false},{phaseId:3},
    {get workId(){throw Error('Do not invoke an accessor');}}])await assert.rejects(f.engine.run('phase.draft-check',input),{code:'ENGINE_INPUT_INVALID'});
  assert.deepEqual(f.calls,[]);
  for(const change of [facts=>{facts.workId='OTHER';},facts=>{facts.phase='OTHER';},facts=>{facts.generation=2;},
    facts=>{facts.phaseStatus='approved';},facts=>{facts.readiness={authoring:true};},facts=>{facts.commands={publish:'shell'};},
    facts=>{facts.findings=[{...finding(),command:'shell'}];},facts=>{facts.task={operationId:'t',state:'ready',continuationBudget:{consumed:-1,maximum:2}};},
    facts=>{facts.warningCount=Infinity;}]) {
    const bad=fixture((stage,{facts})=>{if(stage==='inspect')change(facts);});
    await assert.rejects(bad.engine.run('phase.draft-check'),{code:'ENGINE_PORT_RESULT_INVALID'});
  }
});

test('interruption and spent continuation budgets remain observations rather than being reset by a draft query',async()=>{
  const f=fixture((stage,{facts})=>{if(stage==='inspect')facts.task={operationId:'task-original',state:'inspect-interrupted-operation',
    continuationBudget:{consumed:4,maximum:2}};});
  const result=await f.engine.run('phase.draft-check');
  assert.deepEqual(result.manifest.task,f.facts.task);assert.equal(result.manifest.mutationAuthorityGranted,false);
});

test('draft-check preserves original failures, causes and recovery, including frozen errors, without retry',async()=>{
  for(const at of ['load','inspect']) {
    const error=new SingularityFlowError('Original local read failed',{code:'EACCES',cause:new Error('volume'),details:{recovery:'native route'}});
    const f=fixture(stage=>{if(stage===at)throw error;});
    await assert.rejects(f.engine.run('phase.draft-check'),actual=>actual===error&&actual.cause.message==='volume'&&actual.details.recovery==='native route');
    assert.equal(error.enginePhaseDraftCheck.pendingStage,at);assert.equal(f.calls.filter(stage=>stage===at).length,1);
  }
  for(const error of [Object.freeze(new Error('frozen')),Object.defineProperty(new Error('read-only diagnostic'),'enginePhaseDraftCheck',{value:null,writable:false})]) {
    const f=fixture(stage=>{if(stage==='inspect')throw error;});
    await assert.rejects(f.engine.run('phase.draft-check'),actual=>actual===error);
  }
  for(const at of ['load','inspect']) {
    const controller=new AbortController(),f=fixture(stage=>{if(stage===at)controller.abort();});
    await assert.rejects(f.engine.run('phase.draft-check',{}, {signal:controller.signal}),error=>
      error.code==='ENGINE_OPERATION_CANCELLED'&&error.enginePhaseDraftCheck.localProgressMayBeWritten===(at==='inspect'));
    assert.deepEqual(f.calls,at==='load'?['load']:['load','inspect']);
  }
});

test('draft selection avoids unrelated artifact/history enumeration and captures binding before the awaited check',async()=>{
  const f=fixture((stage,{workflow,args})=>{
    if(stage==='load'){
      Object.defineProperty(workflow,'lineage',{get(){throw Error('Unrelated history');}});
      Object.defineProperty(workflow.phases['custom-draft'],'artifacts',{get(){throw Error('Unrelated inventory');}});
    }else{
      workflow.currentPhase='other';workflow.phases['custom-draft'].generation=99;
      assert.equal(Object.isFrozen(args[1]),true);
    }
  });
  const result=await f.engine.run('phase.draft-check');assert.equal(result.phase,'custom-draft');assert.equal(result.generation,1);
});
