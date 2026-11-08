import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine,ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';
import {phaseReviewBriefRecords,phaseReviewSelection,assertHistoricalReviewPhase} from '../src/kernel/phase-policy.mjs';

const sha='a'.repeat(64),packet='b'.repeat(64);
function fixture(hook=()=>{}) {
  const context={subject:{kind:'story',id:'STORY-1'},workflow:{workItem:{id:'STORY-1'},currentPhase:'team-code',
    phases:{'team-code':{id:'team-code',generation:2,status:'awaiting_approval',artifacts:[{path:'artifacts/code.md',sha256:sha,size:24}]},
      'team-plan':{id:'team-plan',generation:1,status:'approved',artifacts:[{path:'artifacts/plan.md',sha256:sha,size:24}]}}}};
  const document={id:'PRIMARY',reference:'opaque-member-1',role:'artifact',kind:'implementation-summary',mimeType:'text/markdown',
    sourceKey:'artifacts/code.md',generation:2,primary:true,expected:{sha256:sha,bytes:24},observed:{sha256:sha,bytes:24,binary:false},error:null};
  const facts={workId:'STORY-1',phase:'team-code',generation:2,status:'awaiting_approval',revision:'opaque-revision-2',
    budgets:{previewBytes:1048576,sourcePreviewBytes:4096,sourceFullBytes:65536},documents:[document],
    reviewBinding:{workId:'STORY-1',phase:'team-code',generation:2,packetSha256:packet,sourceRevision:'source-1',observedRevision:'opaque-revision-2'}};
  const calls=[],observed={},port={};
  for(const stage of ['load','read'])port[stage]=async(...args)=>{
    calls.push(stage);observed[stage]=args;
    const replacement=await hook(stage,{context,facts,document,calls},args);
    return replacement!==undefined?replacement:stage==='load'?context:facts;
  };
  return {context,facts,document,calls,observed,engine:createEngine({ports:{phaseReview:port}})};
}

test('phase review is one registered read returning references, budgets and byte integrity without consent',async()=>{
  const descriptor=ENGINE_OPERATIONS.find(operation=>operation.id==='phase.review');
  assert.equal(descriptor.effect,'read');assert.deepEqual(descriptor.stages,['load','read']);
  const f=fixture(),result=await f.engine.run('phase.review',{workId:'STORY-1'});
  assert.deepEqual(f.calls,['load','read']);assert.equal(result.status,'inspected');assert.equal(result.phase,'team-code');
  assert.deepEqual(result.effects,{committed:false,pushed:false,humanReviewRecorded:false,approvalRecorded:false});
  assert.equal(result.manifest.contract,'sflow-phase-review-manifest/v1');assert.equal(result.manifest.integrity,'matched');
  assert.equal(result.manifest.items[0].reference.kind,'phase-document');assert.equal(result.manifest.items[0].reference.workId,'STORY-1');
  assert.equal(result.manifest.reviewBinding.packetSha256,packet);assert.equal(Object.isFrozen(result.manifest.items[0]),true);
  assert.equal('content' in result.manifest.items[0],false);assert.equal('commandGuidance' in result,false);
});

test('actor, workflow, body, source paths, presentation preferences and callbacks fail before any I/O',async()=>{
  const f=fixture();
  for(const input of [{actor:'forged'},{workflow:{}},{documents:[]},{root:'/other'},{presentation:{}},{includeSheet:true},
    {confirmation:'yes'},{phaseId:2},{read(){}},{get workId(){throw Error('do not execute');}}]) {
    await assert.rejects(f.engine.run('phase.review',input),{code:'ENGINE_INPUT_INVALID'});
  }
  assert.deepEqual(f.calls,[]);
});

test('an unavailable or changed retained file stays visible and cannot carry an approval binding',async()=>{
  for(const mode of ['missing','changed','unbound']) {
    const f=fixture((stage,{context,document})=>{
      if(stage==='load'&&mode==='unbound')context.workflow.phases['team-code'].artifacts=[];
      if(stage==='read') {
      if(mode==='missing') {document.observed=null;document.error={name:'Error',message:'Permission denied',code:'EACCES',
        details:{member:'PRIMARY'},cause:{name:'Error',message:'volume unavailable',code:'EIO'}};}
      if(mode==='changed')document.observed.sha256='c'.repeat(64);
      if(mode==='unbound')document.expected=null;
    }});
    const result=await f.engine.run('phase.review');
    assert.equal(result.manifest.items.length,1);assert.equal(result.manifest.integrity,mode==='missing'?'unavailable':mode);
    assert.equal(result.manifest.reviewBinding,null);
    if(mode==='missing')assert.equal(result.manifest.items[0].error.cause.code,'EIO');
  }
});

test('binary files and hash-bound briefs with unknown retained byte length keep honest metadata',async()=>{
  const f=fixture((stage,{context,document})=>{
    if(stage==='load')Object.assign(context.workflow.phases['team-code'],{artifacts:[],agentBriefs:[{generation:2,
      renderedPath:document.sourceKey,renderedSha256:sha}]});
    if(stage==='read') {
    document.role='agent-brief';document.kind='agent-brief';document.expected.bytes=null;document.observed.binary=true;
  }});
  const result=await f.engine.run('phase.review');
  assert.equal(result.manifest.items[0].observed.binary,true);assert.equal(result.manifest.integrity,'matched');
  assert.equal(result.manifest.items[0].expected.bytes,null);
});

test('historical phases are inspectable without being mistaken for the current submitted review',async()=>{
  const f=fixture((stage,{facts,document})=>{if(stage==='read') {
    facts.phase='team-plan';facts.generation=1;facts.status='approved';facts.reviewBinding=null;document.generation=1;document.sourceKey='artifacts/plan.md';
  }});
  assert.equal((await f.engine.run('phase.review',{phaseId:'team-plan'})).phase,'team-plan');
  assert.equal(f.observed.read[1].current,false);
  const wrong=fixture();
  await assert.rejects(wrong.engine.run('phase.review',{workId:'OTHER'}),{code:'ACTIVE_SUBJECT_MISMATCH'});
  assert.deepEqual(wrong.calls,['load']);
  for(const phaseId of ['unknown','__proto__','constructor','toString']) {
    const unknown=fixture();
    await assert.rejects(unknown.engine.run('phase.review',{phaseId}),error=>error.message===`Unknown or unavailable phase '${phaseId}'. Provide a phase ID.`);
    assert.deepEqual(unknown.calls,['load']);
  }
  const named=fixture((stage,{context,facts})=>{
    if(stage==='load') {
      context.workflow.phases.constructor={...context.workflow.phases['team-code'],id:'constructor'};
      context.workflow.currentPhase='constructor';
    }
    if(stage==='read') {facts.phase='constructor';facts.reviewBinding.phase='constructor';}
  });
  assert.equal((await named.engine.run('phase.review',{phaseId:'constructor'})).phase,'constructor');
});

test('terminal-capable review selection is a pure kernel rule without changing legacy selection errors',()=>{
  const {context:{workflow}}=fixture(),before=structuredClone(workflow);
  assertHistoricalReviewPhase(workflow,null);assert.deepEqual(workflow,before);
  workflow.currentPhase=null;workflow.status='closed';
  assert.throws(()=>assertHistoricalReviewPhase(workflow,null),error=>error.code==='ENGINE_PHASE_SELECTION_REQUIRED'
    &&error.details.workId==='STORY-1'&&error.details.status==='closed'
    &&error.details.actions.every(action=>action.operation==='phase.review'&&Object.hasOwn(workflow.phases,action.inputs.phaseId)));
  assertHistoricalReviewPhase(workflow,'team-plan');assert.equal(phaseReviewSelection(workflow,'team-plan').current,false);
  assert.throws(()=>phaseReviewSelection(workflow),error=>error.message==="Unknown or unavailable phase ''. Provide a phase ID.");
});

test('selection is captured before a native reader can mutate phase, generation or state',async()=>{
  for(const field of ['phase','generation','status']) {
    const f=fixture((stage,{context,facts})=>{if(stage==='read') {
      context.workflow.phases['team-code'].generation=3;
      facts[field]=field==='generation'?3:field==='phase'?'team-plan':'approved';
    }});
    await assert.rejects(f.engine.run('phase.review'),{code:'ENGINE_PORT_RESULT_INVALID'});
  }
});

test('ordered manifests require distinct references and do not expose unexpected content or host fields',async()=>{
  for(const change of [document=>{document.content='prompt body';},document=>{document.generation=3;},
    document=>{document.observed=null;},document=>{document.expected.sha256='bad';}]) {
    const f=fixture((stage,{document})=>{if(stage==='read')change(document);});
    await assert.rejects(f.engine.run('phase.review'),{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  const repeated=fixture((stage,{facts,document})=>{if(stage==='read')facts.documents.push({...document});});
  await assert.rejects(repeated.engine.run('phase.review'),{code:'ENGINE_PORT_RESULT_INVALID'});
  const f=fixture((stage,{context,facts,document})=>{
    if(stage==='load') {
      context.workflow.phases['team-code'].artifacts.push({path:'src/value.mjs',sha256:sha,size:24});
      context.workflow.phases['team-code'].agentBriefs=[{generation:2,renderedPath:'context/brief.md',renderedSha256:sha}];
    }
    if(stage==='read') {
    facts.documents=[{...document,id:'BRIEF',reference:'brief',sourceKey:'context/brief.md',primary:false,role:'agent-brief',expected:{sha256:sha,bytes:null}},document,
      {...document,id:'CODE',reference:'code',sourceKey:'src/value.mjs',primary:false}];
  }});
  assert.deepEqual((await f.engine.run('phase.review')).manifest.items.map(item=>[item.order,item.id]),[[1,'PRIMARY'],[2,'CODE'],[3,'BRIEF']]);
});

test('a reader cannot omit a retained member or replace its captured expected bytes',async()=>{
  const missing=fixture((stage,{facts})=>{if(stage==='read')facts.documents=[];});
  await assert.rejects(missing.engine.run('phase.review'),{code:'ENGINE_PORT_RESULT_INVALID'});
  const swapped=fixture((stage,{context,document})=>{if(stage==='read') {
    context.workflow.phases['team-code'].artifacts[0].sha256='c'.repeat(64);
    document.expected.sha256='c'.repeat(64);document.observed.sha256='c'.repeat(64);
  }});
  await assert.rejects(swapped.engine.run('phase.review'),{code:'ENGINE_PORT_RESULT_INVALID'});
});

test('brief selection keeps the exact submitted projection and strict installed generation matching',()=>{
  const phase={id:'team-code',generation:2,agentBriefs:[{generation:2,renderedPath:'mutable.md'}]};
  const workflow={lineage:{submissions:[{phase:'team-code',generation:2,projection:{agentBriefs:[{renderedPath:'submitted.md'}]}}]}};
  assert.deepEqual(phaseReviewBriefRecords(workflow,phase),[{renderedPath:'submitted.md'}]);
  workflow.lineage.submissions[0].generation='2';
  assert.deepEqual(phaseReviewBriefRecords(workflow,phase),phase.agentBriefs);
  assert.deepEqual(phaseReviewBriefRecords(workflow,{...phase,generation:0}),[]);
});

test('native overall read errors preserve original identity, causes and recovery without retry',async()=>{
  for(const stage of ['load','read']) {
    const error=new SingularityFlowError('Original read failure.',{code:'NATIVE_STORAGE_UNAVAILABLE',cause:new Error('disk offline'),
      details:{nextAction:'original recovery'}});
    const f=fixture(at=>{if(at===stage)throw error;});
    await assert.rejects(f.engine.run('phase.review'),actual=>actual===error&&actual.cause.message==='disk offline');
    assert.equal(f.calls.filter(at=>at===stage).length,1);
  }
});

test('cancellation stops read-only inspection at each stage and native fact accessors never execute',async()=>{
  for(const stage of ['load','read']) {
    const controller=new AbortController(),f=fixture(at=>{if(at===stage)controller.abort();});
    await assert.rejects(f.engine.run('phase.review',{}, {signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
  }
  const f=fixture((stage,{facts})=>{if(stage==='read')Object.defineProperty(facts,'revision',{enumerable:true,
    get(){throw Error('native getter must not execute');}});});
  await assert.rejects(f.engine.run('phase.review'),error=>error.code==='ENGINE_PORT_RESULT_INVALID'&&error.cause.code==='ENGINE_INPUT_INVALID');
});
