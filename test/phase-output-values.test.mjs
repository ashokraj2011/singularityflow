import test from 'node:test';import assert from 'node:assert/strict';
import {phaseOutputSelection,PHASE_OUTPUT_LIMITS} from '../src/kernel/phase-outputs.mjs';
import {phaseOutputRetentionInput,phaseOutputRetentionResult} from '../src/kernel/source-changes.mjs';
const phase='custom-code',workflow=()=>({status:'in_progress',workItem:{id:'story'},currentPhase:phase,resolution:{},phases:{[phase]:{
  id:phase,status:'in_progress',generation:0,writeScope:'source-and-artifact',generationPolicy:{task:'code'}}}}),
  path='singularity/work-items/story/evidence/output.png',reference={namespace:'local',sha256:'a'.repeat(64),bytes:3},
  input={operationId:'retain-exact-output',workId:'story',phaseId:phase,path,content:reference};
test('supporting output selection uses the current generation and source role without changing input or recording acceptance',()=>{
  const state=workflow(),before=structuredClone(state),selected=phaseOutputSelection({},state,{phaseId:phase,path});
  assert.deepEqual(selected,{workId:'story',phase,generation:1,path,purpose:'supporting-evidence',sourceRequired:true});assert.deepEqual(state,before);
  state.phases[phase].generation=1;state.phases[phase].status='in_progress';
  assert.equal(phaseOutputSelection({},state,{phaseId:phase,path}).generation,2);
});
test('closed, noncurrent, submitted and already published generations cannot acquire another output',()=>{
  for(const change of [s=>{s.status='closed';},s=>{s.currentPhase='other';},s=>{s.phases[phase].status='awaiting_approval';},
    s=>{s.phases[phase].generation=1;s.phases[phase].generationIntent={status:'consumed',generation:1};}]){
    const state=workflow();change(state);assert.throws(()=>phaseOutputSelection({},state,{phaseId:phase,path}),{code:'ENGINE_OUTPUT_AUTHORING_REQUIRED'});
  }
});
test('portable output selection preserves protected paths and custom Story roots',()=>{
  for(const candidate of ['../output.png','/tmp/output.png','C:/output.png','singularity/work-items/other/evidence/output.png',
    path.replace('output.png','../output.png'),path.replace('output.png','NUL.png'),path.replace('output.png','output.png.'),path.replace('output.png','*.png')])
    assert.throws(()=>phaseOutputSelection({},workflow(),{phaseId:phase,path:candidate}),{code:'ENGINE_OUTPUT_SCOPE_INVALID'});
  assert.throws(()=>phaseOutputSelection({governance:{protectedPaths:['singularity/work-items/story/evidence']}},workflow(),{phaseId:phase,path}),{code:'ENGINE_OUTPUT_PROTECTED'});
  assert.equal(phaseOutputSelection({workItemRoot:'work'},workflow(),{phaseId:phase,path:'work/story/evidence/output.png'}).path,'work/story/evidence/output.png');
  assert.ok(Object.isFrozen(PHASE_OUTPUT_LIMITS));
});
test('output input/result contracts require explicit bytes and reject invented acceptance or a substituted digest',()=>{
  const before=structuredClone(input);assert.deepEqual(phaseOutputRetentionInput(input),input);assert.deepEqual(input,before);
  for(const value of [null,{...input,content:'/tmp/output.png'},{...input,approved:true},{...input,path:'../output.png'},
    {...input,content:{...reference,bytes:PHASE_OUTPUT_LIMITS.fileBytes+1}},{...input,content:{...reference,namespace:'state'}}])
    assert.throws(()=>phaseOutputRetentionInput(value),{code:'ENGINE_INPUT_INVALID'});
  const fact={workId:'story',phase,operationId:input.operationId,generation:1,recordedAt:'2026-11-11T00:00:00.000Z',principalId:'author',
    record:{key:'output-retention/results/'+'b'.repeat(64),version:'accepted-revision',content:{...reference,namespace:'evidence'}},
    replayed:false,path,content:{...reference,namespace:'evidence'}};
  assert.equal(phaseOutputRetentionResult(input,fact).effects.approvalRecorded,false);
  for(const update of [{generation:0},{path:'other.png'},{approvalRecorded:true},{content:{...fact.content,sha256:'c'.repeat(64)}}])
    assert.throws(()=>phaseOutputRetentionResult(input,{...fact,...update}),{code:'ENGINE_PORT_RESULT_INVALID'});
});
