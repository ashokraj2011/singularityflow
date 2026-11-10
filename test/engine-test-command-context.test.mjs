import test from 'node:test';import assert from 'node:assert/strict';
import {createEngine} from '../src/engine-sdk/index.mjs';
const context=()=>({subject:{kind:'story',id:'example'},workflow:{workItem:{id:'example'},phases:{build:{id:'build'}}},phase:{id:'build'}}),
  facts=()=>({schemaVersion:1,format:'sflow-namespace-test-command-context/v1',workId:'example',phase:'build',revision:'revision-one',
    commands:[{command:{id:'unit',argv:['node','--test']},sha256:'sha256:'+'a'.repeat(64)}],requests:[],authorities:['reviewers']});
test('the command context uses only its read port and captures its binding before awaited host work',async()=>{
  const c=context(),expected=facts(),engine=createEngine({ports:{testCommandContext:{load:()=>c,read(){c.subject.id='another';c.phase.id='other';return expected;}}}}),
    result=await engine.run('test-command.context',{workId:'example',phaseId:'build'});
  assert.deepEqual(result.subject,{kind:'story',id:'example'});assert.deepEqual(result.manifest,expected);
  assert.deepEqual(result.effects,{committed:false,pushed:false,approvalRecorded:false,storyAdvanced:false});
});
test('malformed command contexts refuse with a protocol error rather than a raw file or property exception',async()=>{
  for(const change of [value=>({...value,workId:'another'}),value=>({...value,phase:'other'}),value=>({...value,commands:[null]}),
    value=>({...value,requests:[null]}),value=>({...value,requests:[{id:'TCD-001',request:{id:'TCD-002',phase:'build'},state:'requested'}]}),
    value=>({...value,ready:true}),value=>({...value,schemaVersion:99})]){
    const engine=createEngine({ports:{testCommandContext:{load:context,read:()=>change(facts())}}});
    await assert.rejects(engine.run('test-command.context',{}),{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  let reads=0;const engine=createEngine({ports:{testCommandContext:{load:()=>undefined,read(){reads++;return facts();}}}});
  await assert.rejects(engine.run('test-command.context',{}),{code:'ENGINE_PORT_RESULT_INVALID'});assert.equal(reads,0);
});
test('command context input validation and cancellation happen before an unbound read',async()=>{
  const forbidden=()=>{throw Error('No host access is authorized.');},engine=createEngine({ports:{testCommandContext:{load:forbidden,read:forbidden}}});
  await assert.rejects(engine.run('test-command.context',{ready:true}),{code:'ENGINE_INPUT_INVALID'});
  const controller=new AbortController();controller.abort();await assert.rejects(engine.run('test-command.context',{}, {signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
});
