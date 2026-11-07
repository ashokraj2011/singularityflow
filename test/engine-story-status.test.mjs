import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine} from '../src/engine-sdk/index.mjs';
import {recordedEvidenceSummary} from '../src/kernel/phase-policy.mjs';

function fixture({context: changeContext=value=>value, facts: changeFacts=value=>value, hook=()=>{}}={}) {
  const workflow={workItem:{id:'STATUS-1',title:'Private title'},status:'in_progress',currentPhase:'custom-check',
    phaseOrder:['intake','custom-check'],phases:{
      intake:{id:'intake',status:'approved',generation:1,artifacts:[{sha256:'a'},{status:'recorded'},{}],
        checks:[{status:'passed'},{status:'pass'},{status:'failed'},{status:'blocked'},{status:'fail'},{status:'not-run'}],
        approvals:[{decision:'approved',selfApproval:true},{decision:'approved',invalidatedAt:'yesterday'},{decision:'rejected'}]},
      'custom-check':{id:'custom-check',status:'in_progress',generation:0,artifacts:[],checks:[],approvals:[]}
    },prompt:'Private author instructions',history:[{private:'History body'}]};
  const calls=[],source={kind:'working-tree',revision:null};
  const port={async load(input){calls.push(['load',input]);await hook('load');
    return changeContext({subject:{kind:'story',id:'STATUS-1'},workflow,source});},
  async read(_context,binding){calls.push(['read',binding]);await hook('read');return changeFacts({workId:'STATUS-1',source,
    publication:{state:'not-retained',commit:null,error:null}});}};
  return {engine:createEngine({ports:{storyStatus:port}}),calls,workflow,source,port};
}

test('status and next steps share recorded counts without implying execution, quorum or acceptance',async()=>{
  const f=fixture(),result=await f.engine.run('story.status',{workId:'STATUS-1'});
  assert.equal(result.operation,'story.status');assert.equal(result.manifest.contract,'sflow-story-status/v1');
  assert.equal(result.manifest.currentPhase,'custom-check');assert.equal(result.manifest.inventoryComplete,true);
  assert.deepEqual(result.manifest.evidence,recordedEvidenceSummary(f.workflow));
  assert.deepEqual(result.manifest.evidence,{artifacts:{recorded:2,total:3},checks:{passed:2,failed:3,total:6},approvals:{approved:1,total:2}});
  assert.equal(result.manifest.publication.state,'not-retained');
  for(const field of ['authorityVerified','finalBindingChecked','acceptanceChecked'])assert.equal(result.manifest[field],false);
  assert.deepEqual(result.effects,{committed:false,pushed:false,testsRun:false,modelInvocations:0,approvalRecorded:false,storyAdvanced:false});
  assert.doesNotMatch(JSON.stringify(result),/Private|prompt|History body|singularity-flow|\/sf-/u);
  assert.equal(Object.isFrozen(result.manifest.phases),true);
  f.workflow.phases.intake.checks.push({status:'passed'});assert.equal(result.manifest.evidence.checks.passed,2);
});

test('unknown input, nonlogical selectors, pre-cancellation and unmatched Story cannot read another record',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();
  for(const input of [null,[],{workId:1},{workId:''},{workId:' '.repeat(10)},{workId:'a'.repeat(513)},
    {root:'/other'},{reference:'feature/branch'},{fetch:true},{workId:'STATUS-1',phaseId:'intake'}]) {
    await assert.rejects(f.engine.run('story.status',input),{code:'ENGINE_INPUT_INVALID'});
  }
  await assert.rejects(f.engine.run('story.status',{}, {signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
  assert.deepEqual(f.calls,[]);
  await assert.rejects(f.engine.run('story.status',{workId:'OTHER'}),{code:'ACTIVE_SUBJECT_MISMATCH'});
  assert.equal(f.calls.length,1);
});

test('legacy record gaps stay diagnostic and never become invented zero-complete coverage',async()=>{
  const f=fixture({context:value=>{value.workflow.phaseOrder.push('missing','intake');
    value.workflow.phases.intake.artifacts=[null,{sha256:'a'}];delete value.workflow.phases['custom-check'].checks;return value;}});
  const result=await f.engine.run('story.status');
  assert.equal(result.manifest.inventoryComplete,false);
  assert.deepEqual(result.manifest.phases.at(-1),{id:'missing',status:null,generation:null});
  assert.deepEqual(result.manifest.diagnostics.map(item=>item.code),[
    'status.evidence.incomplete','status.evidence.incomplete','status.phase.unavailable','status.phase-order.invalid']);
  assert.equal(result.manifest.evidence.artifacts.recorded,1);
});

test('retained pending and unreadable records remain distinct, including original failure details',async()=>{
  const error={name:'SingularityFlowError',message:'real deadline error',code:'GIT_TIMEOUT',details:{timeoutMs:300000},
    cause:{name:'Error',message:'remote child timed out',code:'ETIMEDOUT'}};
  for(const publication of [{state:'pending',commit:'a'.repeat(40),error:null},{state:'unreadable',commit:null,error}]) {
    const result=await fixture({facts:value=>({...value,publication})}).engine.run('story.status');
    assert.deepEqual(result.manifest.publication,publication);
  }
});

test('moved bindings, non-JSON output and an absent reader cannot masquerade as status success',async()=>{
  for(const facts of [value=>({...value,workId:'OTHER'}),value=>({...value,source:{kind:'ref',revision:'moved'}}),
    value=>({...value,prompt:'body'}),value=>({...value,publication:{state:'not-retained',commit:'unexpected',error:null}}),
    value=>({...value,publication:{state:'unreadable',commit:null,error:null}}),value=>({...value,extra:()=>{}})]) {
    await assert.rejects(fixture({facts}).engine.run('story.status'),{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  const engine=createEngine({ports:{workflowAssets:{load(){},read(){}}}});
  await assert.rejects(engine.run('story.status'),{code:'ENGINE_PORT_UNAVAILABLE'});
});

test('native failure identity and cancellation are preserved at both read stages',async()=>{
  for(const stage of ['load','read']) {
    const error=new Error('native failure',{cause:new Error('original cause')});error.code='READ_FAILED';
    await assert.rejects(fixture({hook:name=>{if(name===stage)throw error;}}).engine.run('story.status'),value=>value===error);
    const controller=new AbortController(),f=fixture({hook:name=>{if(name===stage)controller.abort();}});
    await assert.rejects(f.engine.run('story.status',{}, {signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
    assert.equal(f.calls.length,stage==='load'?1:2);
  }
});
