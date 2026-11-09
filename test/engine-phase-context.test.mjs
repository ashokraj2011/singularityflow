/** Resource reads bind logical handles and original bytes without accepting host authority. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine,ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
const input={workId:'story',phaseId:'custom',contextSha256:'a'.repeat(64),resourceId:'exact-resource'};
function fixture(change=()=>{},selection={}) {
  const calls=[],facts={workId:'story',phase:'custom',generation:1,contextSha256:input.contextSha256,resourceId:input.resourceId,
    reference:{namespace:'evidence',sha256:'b'.repeat(64),bytes:3},representation:'text',offset:0,encoding:'utf8',
    content:{kind:'text',text:'é!',bytes:3,truncated:false}};
  return {calls,engine:createEngine({ports:{phaseContextRead:{load(){calls.push('load');return {subject:{kind:'story',id:'story'},phase:'custom',...selection};},
    read(_context,request){calls.push('read');change(facts,request);return facts;}}}})};
}
test('resource reads are registered, immutable descriptions with no authority or execution effects',async()=>{
  assert.equal(ENGINE_OPERATIONS.find(item=>item.id==='phase.context.read').effect,'read');
  const f=fixture(),result=await f.engine.run('phase.context.read',input);assert.deepEqual(f.calls,['load','read']);
  assert.equal(result.content.text,'é!');assert.equal(Object.isFrozen(result.content),true);
  assert.deepEqual(result.effects,{committed:false,pushed:false,testsRun:false,approvalRecorded:false,storyAdvanced:false});
});
test('raw paths, forged authority, unbounded bodies and unsupported representations are rejected before loading',async()=>{
  const f=fixture();for(const delta of [{path:'/file'},{ready:true},{actor:'other'},{contextSha256:'bad'},
    {offset:1},{offset:-1},{maximumBytes:1048577},{representation:'prompt'},{workId:null}]) {
    await assert.rejects(f.engine.run('phase.context.read',{...input,...delta}),{code:'ENGINE_INPUT_INVALID'});
  }
  assert.deepEqual(f.calls,[]);
});
test('a misbound loaded subject is rejected before body reads',async()=>{
  for(const selection of [{subject:{kind:'story',id:'other'}},{phase:'other'}]) {
    const f=fixture(()=>{},selection);await assert.rejects(f.engine.run('phase.context.read',input),{code:'ENGINE_PORT_RESULT_INVALID'});assert.deepEqual(f.calls,['load']);
  }
});
test('returned context identities, encoding, size, truncation and base64 counts are checked by the kernel',async()=>{
  for(const change of [facts=>{facts.workId='other';},facts=>{facts.contextSha256='c'.repeat(64);},facts=>{facts.resourceId='other';},
    facts=>{facts.content.bytes=2;},facts=>{facts.content.truncated=true;},facts=>{facts.encoding='binary';},
    facts=>{facts.content=null;},facts=>{facts.reference.path='/host';},facts=>{facts.content={kind:'bytes',base64:'////',bytes:2,truncated:true};facts.representation='base64';}]) {
    const f=fixture(change);await assert.rejects(f.engine.run('phase.context.read',input),{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  const bytes=fixture(facts=>{facts.representation='base64';facts.content={kind:'bytes',base64:'abc=',bytes:1,truncated:true};});
  await assert.rejects(bytes.engine.run('phase.context.read',{...input,representation:'base64'}),{code:'ENGINE_PORT_RESULT_INVALID'});
});
