import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine} from '../src/engine-sdk/index.mjs';
import {inputFindingSeverity,inputReadinessFindings} from '../src/kernel/phase-inputs.mjs';
import {inputFindingSeverity as compatibilitySeverity} from '../src/lifecycle-evidence-policy.mjs';
import {inputReadinessFindings as compatibilityFindings} from '../src/inputs.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';

const digest = 'a'.repeat(64);
function fixture({dryRun=false,hook=()=>{}}={}) {
  const workflow = {workItem:{id:'INPUT-1'},currentPhase:'custom-review',phases:{'custom-review':{id:'custom-review',generation:0,
    requiredArtifact:{path:'artifacts/custom-review/report.md'}}},resolution:{inputsMode:'enforce',phases:[{id:'custom-review',inputs:[{phase:'design'}]}]}};
  const facts = {workId:'INPUT-1',phase:'custom-review',generation:1,dryRun,mode:'enforce',renderedSha256:digest,
    artifact:{key:'artifacts/custom-review/report.md',sha256:dryRun?null:digest,bytes:dryRun?null:2048,
      managedSha256:dryRun?null:digest,managedMatchesRendered:dryRun?null:true},
    audit:dryRun?null:{key:'singularity/work-items/INPUT-1/context/inputs-custom-review-gen1.json',sha256:digest,generation:1},
    auditRecorded:!dryRun,generationOpened:false,records:[{phase:'design',key:'singularity/work-items/INPUT-1/artifacts/design/design.md',
      optional:false,status:'captured',producerStatus:'approved',generation:1,approvedSha256:digest,observedSha256:digest,bytes:512,
      maximumBytes:1024,maximumSummaryBytes:128,truncated:false,
      representation:{kind:'summary',sha256:digest,bytes:64,complete:false,expansionHandle:'retained:design'},
      brief:{key:'singularity/work-items/INPUT-1/context/design-brief.md',sha256:digest},
      output:null,receipt:null,selectedClauses:null}],errorCount:0,warningCount:0,remoteWarningCount:0,remoteOutputCount:0};
  const calls = [], port = Object.fromEntries(['load','prepare','inspect'].map(stage=>[stage,async(...args)=>{
    calls.push(stage);await hook(stage,args);return stage==='load'?{workflow}:stage==='inspect'?facts:null;
  }]));
  return {workflow,facts,calls,engine:createEngine({ports:{phaseInputs:port}})};
}

test('legacy input severity and readiness imports resolve to the same kernel rules',()=>{
  assert.equal(compatibilitySeverity,inputFindingSeverity);assert.equal(compatibilityFindings,inputReadinessFindings);
  assert.equal(inputFindingSeverity('enforce',true,'skipped'),null);
  assert.equal(inputFindingSeverity('enforce',true,'hash_mismatch'),'error');
  assert.equal(inputFindingSeverity('record',false,'missing'),'warning');
  const record={phase:'design',repositoryPath:'artifacts/design.md',status:'hash_mismatch',producerStatus:'approved',approvedSha256:digest,sha256:'b'.repeat(64)};
  assert.deepEqual(inputReadinessFindings({mode:'enforce',records:[record]}),[{phase:'design',path:'artifacts/design.md',status:'hash_mismatch',
    producerStatus:'approved',approvedSha256:digest,sha256:'b'.repeat(64),restorable:true}]);
  assert.deepEqual(inputReadinessFindings({mode:'record',records:[record]}),[]);
});

test('custom phases receive a body-free input manifest without an authoring or publication claim',async()=>{
  const f=fixture(),result=await f.engine.run('phase.inputs',{workId:'INPUT-1',phaseId:'custom-review'});
  assert.deepEqual(f.calls,['load','prepare','inspect']);assert.equal(result.status,'prepared');
  assert.equal(result.manifest.records[0].representation.kind,'summary');assert.equal(result.manifest.audit.recordedInThisOperation,true);
  assert.equal(result.manifest.authoringCompleted,false);assert.equal(result.manifest.publicationReadinessInspected,false);
  assert.equal(result.effects.inputAuditRecorded,true);assert.equal(result.effects.committed,false);
  assert.equal(result.effects.testsRun,false);assert.equal(JSON.stringify(result).includes('routes'),false);
});

test('dry-run findings remain visible and preserve possible local task progress without claiming artifact writes',async()=>{
  const f=fixture({dryRun:true});f.facts.records[0]={...f.facts.records[0],status:'missing',representation:null,observedSha256:null};f.facts.errorCount=1;
  const result=await f.engine.run('phase.inputs',{dryRun:true});
  assert.equal(result.status,'inspected');assert.equal(result.manifest.ready,false);assert.equal(result.manifest.errorCount,1);
  assert.equal(result.effects.artifactPrepared,false);assert.equal(result.effects.inputAuditRecorded,false);
  assert.equal(result.effects.localProgressMayBeWritten,true);assert.equal(result.manifest.audit,null);
});

test('advisory input modes disclose mismatched bytes instead of claiming they matched the approved source',async()=>{
  const f=fixture();f.facts.mode='record';f.facts.warningCount=1;
  Object.assign(f.facts.records[0],{status:'hash_mismatch',observedSha256:'b'.repeat(64),representation:null});
  const result=await f.engine.run('phase.inputs');assert.equal(result.manifest.ready,true);
  assert.equal(result.manifest.mode,'record');assert.equal(result.manifest.warningCount,1);assert.equal(result.manifest.records[0].status,'hash_mismatch');
});

test('input options cannot inject native state, content, identity or alternate roots before binding',async()=>{
  const f=fixture();
  for(const input of [{dryRun:'true'},{root:'/other'},{workflow:{}},{records:[]},{actor:{}},{phaseId:[]},{content:'invented'}]) {
    await assert.rejects(f.engine.run('phase.inputs',input),{code:'ENGINE_INPUT_INVALID'});
  }
  assert.deepEqual(f.calls,[]);
});

test('invalid source bindings or body-bearing facts cannot become a successful input manifest',async()=>{
  for(const mutate of [f=>{f.facts.phase='another';},f=>{f.facts.generation=2;},f=>{f.facts.records[0].content='not allowed';},
    f=>{f.facts.records[0].key='/another/checkout';},f=>{f.facts.records[0].observedSha256='b'.repeat(64);},f=>{f.facts.errorCount=1;},
    f=>{f.facts.records[0].brief=null;},f=>{f.facts.records[0].output='contract';},f=>{f.facts.records[0].representation.complete=true;},
    f=>{f.facts.records[0].status='unknown-status';}]) {
    const f=fixture();mutate(f);
    await assert.rejects(f.engine.run('phase.inputs'),error=>error.code==='ENGINE_PORT_RESULT_INVALID'&&error.enginePhaseInputs.localEffectsMayExist===true);
  }
});

test('a skill receipt must bind the selected output generation and observed approved bytes',async()=>{
  const f=fixture(),record=f.facts.records[0];record.output='contract';record.receipt={generation:1,packetSha256:digest,evidenceCommit:'opaque-source-revision',
    submittedSha256:'b'.repeat(64),approvedSha256:digest,submittedBundleSha256:null,bundleSha256:null,acceptance:'human-approved'};
  const result=await f.engine.run('phase.inputs');assert.equal(result.manifest.records[0].receipt.generation,1);
  record.receipt.generation=2;
  await assert.rejects(f.engine.run('phase.inputs'),{code:'ENGINE_PORT_RESULT_INVALID'});
});

test('clause-selection truncation remains distinct from a shorter complete selection and discloses its byte budget',async()=>{
  const f=fixture(),record=f.facts.records[0];record.representation={...record.representation,kind:'clauses',bytes:32};
  record.selectedClauses=['REQ-1'];record.truncated=true;record.maximumBytes=32;record.maximumSummaryBytes=null;record.brief=null;
  const truncated=await f.engine.run('phase.inputs');
  assert.equal(truncated.manifest.records[0].maximumBytes,32);assert.equal(truncated.manifest.records[0].truncated,true);
  record.truncated=false;assert.equal((await f.engine.run('phase.inputs')).manifest.records[0].truncated,false);
});

test('native failures keep their exact causes and cancellation discloses already prepared local effects',async()=>{
  const cause=new Error('actual permission denial'),error=new SingularityFlowError('Inputs unavailable.',{code:'PHASE_INPUTS_NOT_READY',cause});
  const f=fixture({hook(stage){if(stage==='prepare')throw error;}});
  await assert.rejects(f.engine.run('phase.inputs'),actual=>actual===error&&actual.cause===cause);
  assert.equal(f.calls.includes('inspect'),false);
  const controller=new AbortController(),cancelled=fixture({hook(stage){if(stage==='prepare')controller.abort();}});
  await assert.rejects(cancelled.engine.run('phase.inputs',{}, {signal:controller.signal}),error=>error.code==='ENGINE_OPERATION_CANCELLED'
    &&error.enginePhaseInputs.localEffectsMayExist===true&&error.enginePhaseInputs.committed===false);
});
