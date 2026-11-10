/** Captured native values include errors and partial reducer state, rather than self-comparison. */
import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {recordPhaseAssignmentState,phaseAssignmentStateReplay} from '../src/kernel/phase-policy.mjs';
const captured=JSON.parse(await readFile(new URL('./fixtures/phase-assignments/native-v1.json',import.meta.url),'utf8')),
  workflow=()=>({workItem:{id:'fixture'},status:'in_progress',currentPhase:'intake',phases:{intake:{id:'intake',label:'Intake'},future:{id:'future',label:'Future'}},history:[]});
for(const row of captured.cases)test('assignment compatibility: '+row.name,()=>{
  const value={...workflow(),...structuredClone(row.initial)};let observed;
  try{observed={value:recordPhaseAssignmentState(value,row.phaseId,row.assignee,row.session,{at:captured.at}),workflow:value};}
  catch(error){observed={error:{name:error.name,message:error.message},workflow:value};}
  assert.deepEqual(JSON.parse(JSON.stringify(observed)),row.outcome);
});
test('the original assignment validation and initialization happen before its explicit clock checkpoint',()=>{
  const unknown=phaseAssignmentStateReplay(workflow(),'absent','Example',null);assert.throws(()=>unknown.next(),/Unknown phase/u);
  const value=workflow(),replay=phaseAssignmentStateReplay(value,'intake','Example',null),time=replay.next();
  assert.equal(time.value,'phase-assignment-timestamp');assert.deepEqual(value.collaboration,{assignments:{},notifications:[]});
  assert.equal(replay.next(captured.at).value.assignedAt,captured.at);
});
