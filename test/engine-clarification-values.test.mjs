import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as values from '../src/kernel/clarification-responses.mjs';
import {normalizeClarificationPolicy} from '../src/kernel/phase-inputs.mjs';
const serial=value=>JSON.parse(JSON.stringify(value));
const failure=error=>({error:{name:error.name,message:error.message,code:error.code,details:error.details,exitCode:error.exitCode}});
test('shared reply and marker values preserve the independent native outcomes',async()=>{
  const oracle=JSON.parse(await readFile(new URL('./fixtures/clarification-values/native-v1.json',import.meta.url)));
  assert.equal(oracle.capturedAtCommit,'a90762eda');assert.equal(oracle.cases.length,49);
  for(const entry of oracle.cases) {
    let outcome;try{outcome={value:values[entry.method](...structuredClone(entry.args))};}catch(error){outcome=failure(error);}
    assert.deepEqual(serial(outcome),entry.outcome,entry.id);
  }
});
test('the shared fold preserves actual native writes, retries, limits, deferrals and replacement outcomes',async()=>{
  const oracle=JSON.parse(await readFile(new URL('./fixtures/clarification-values/native-v1.json',import.meta.url)));
  assert.equal(oracle.folds.length,12);
  for(const entry of oracle.folds) {
    let outcome;try {
      const policy=normalizeClarificationPolicy({mode:'required',maxQuestions:entry.maxQuestions??3});
      const previous=entry.previous?values.clarificationResponseSet({phaseId:'custom-scope',policy,responses:entry.previous}).responses:null;
      outcome={value:values.clarificationResponseSet({phaseId:'custom-scope',policy,previous,responses:entry.responses,replace:entry.replace??false})};
    }catch(error){outcome=failure(error);}
    assert.deepEqual(serial(outcome),entry.outcome,entry.id);
  }
});
