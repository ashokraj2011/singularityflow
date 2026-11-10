import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import * as native from '../src/story-test-commands.mjs';
import {storyTestCommandPolicies} from '../src/kernel/test-recovery.mjs';
import {NODE_TEXT_DIGESTS} from '../src/records.mjs';
const captured=JSON.parse(await readFile(new URL('./fixtures/story-test-command-values/native-v1.json',import.meta.url),'utf8')),
  rules=storyTestCommandPolicies(NODE_TEXT_DIGESTS);
for(const row of captured.cases)test('Story-command values retain original native '+row.name,()=>{
  for(const owner of [native,...(row.name==='review'?[]:[rules])]){
    const workflow=structuredClone(row.initial),results=[];
    for(const step of row.steps){try{results.push({record:step.op==='request'?owner.recordStoryTestCommandRequest(workflow,step.input):owner.recordStoryTestCommandDecision(workflow,step.input)});}
      catch(error){results.push({error:{name:error.name,code:error.code,message:error.message,details:error.details??null}});}}
    assert.deepEqual(results,row.results);assert.deepEqual(workflow,row.workflow);
  }
});
