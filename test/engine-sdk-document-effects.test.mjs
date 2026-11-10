/** Adapter failures after an accepted mutation must preserve its known effect and real error. */
import test from 'node:test';import assert from 'node:assert/strict';
import {createEngine} from '../src/engine-sdk/index.mjs';
const inputs={operationId:'detach-one',workId:'story-one',documentId:'input-one',reason:'Remove this input from the active Story.'},
  accepted={status:'committed',receipt:{operationId:inputs.operationId}},
  result={workId:inputs.workId,revision:'opaque-revision',pushed:false,currentPhase:'intake',document:{id:inputs.documentId,kind:'input-document',
    locality:'machine-local',content:{namespace:'local',sha256:'a'.repeat(64),bytes:1},status:'detached'}};
function engine(finish,commit=()=>accepted){return createEngine({ports:{storyDocument:{load:()=>({subject:{kind:'story',id:inputs.workId},
  workflow:{workItem:{id:inputs.workId},currentPhase:'intake'}}),prepare:()=>({}),commit,finish}}});}
test('a failed finish reports the accepted receipt without replacing the actual error',async()=>{
  const original=Object.assign(new Error('The actual post-commit presenter failed.'),{code:'EIO'});
  await assert.rejects(engine(()=>{throw original;}).run('story.document.detach',inputs),error=>error===original);
  assert.deepEqual(original.engineStoryDocument.accepted,accepted);assert.equal(original.engineStoryDocument.metadataMayBeAccepted,true);
  assert.equal(original.engineStoryDocument.applicationChanged,false);assert.equal(original.engineStoryDocument.pendingStage,'finish');
  const malformed=await engine(()=>({...result,revision:null})).run('story.document.detach',inputs).catch(error=>error);
  assert.equal(malformed.code,'ENGINE_PORT_RESULT_INVALID');assert.deepEqual(malformed.engineStoryDocument.accepted,accepted);
});
test('optional effect diagnostics cannot mask frozen errors or a read-only diagnostic property',async()=>{
  for(const original of [Object.freeze(new Error('Immutable provider refusal.')),Object.defineProperty(new Error('Reserved diagnostic.'),'engineStoryDocument',{
    get(){throw Error('A diagnostic getter is not permission to replace the actual error.');},configurable:false})]){
    await assert.rejects(engine(()=>{throw original;}).run('story.document.detach',inputs),error=>error===original);
  }
});
test('cancellation after acceptance still returns the accepted local-only metadata effect',async()=>{
  const controller=new AbortController(),recorded=await engine(()=>result,()=>{controller.abort();return accepted;})
    .run('story.document.detach',inputs,{signal:controller.signal});
  assert.equal(recorded.status,'recorded');assert.equal(recorded.effects.committed,true);assert.equal(recorded.effects.uploadedContent,false);
});
