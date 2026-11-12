import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {forwardAmendmentPhaseTarget,forwardAmendmentReaderPhases} from '../src/kernel/upstream-issues.mjs';
const captured=JSON.parse(await readFile(new URL('./fixtures/forward-amendment-values/native-target-v1.json',import.meta.url),'utf8'));
for(const row of captured.cases)test('native amendment target '+row.id+' retains its original outcome',()=>{
  if(row.result.error)assert.throws(()=>forwardAmendmentPhaseTarget(row.workflow,row.phaseId),row.result.error);
  else{const value=forwardAmendmentPhaseTarget(row.workflow,row.phaseId);assert.deepEqual({phase:value.phase.id,current:value.current.id},row.result);}
});
test('native amendment readers retain exact approved direct dependencies',()=>{
  const {workflow,phase,current,result}=captured.reader;
  assert.deepEqual(forwardAmendmentReaderPhases(workflow,workflow.phases[phase],workflow.phases[current]),result);
});
