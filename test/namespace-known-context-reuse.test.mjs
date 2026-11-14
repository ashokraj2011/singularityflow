import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceKnownTestRiskFixture} from './helpers/namespace-known-test-risk-fixture.mjs';
import {createNamespaceReadSession} from '../src/engine-storage/namespace-read-session.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespaceKnownTestRiskOwner} from '../src/engine-storage/namespace-known-test-risk-reader.mjs';
test('retained known-failure context reuse isolates results and keeps actual read errors across writes and invocations',{timeout:120000},async t=>{
 const f=await namespaceKnownTestRiskFixture(t,{backend:'sqlite'}),snapshot=await f.capture(),failure=Object.freeze(Object.assign(Error('Original retained comparison cannot be read.'),{code:'EACCES'}));let denied=false;
 const session=createNamespaceReadSession({records:f.records,content:{...f.content,read(...args){if(denied)throw failure;return f.content.read(...args);}}}),
  observer=createNamespaceStoryObserver({...f.common,records:session.records,content:session.content}),owner=createNamespaceKnownTestRiskOwner({observer,scope:f.scope,workId:f.inputs.workId}),
  read=()=>owner.context(snapshot,f.request,{at:f.control.now});
 await session.run(async()=>{const first=await read();assert.equal(first.context.value.testsPassed,false);first.context.value.testsPassed=true;
  const second=await read();assert.equal(second.context.value.testsPassed,false);assert.equal(second.context.sha256,f.view.manifest.expectedContext);
  denied=true;assert.equal((await read()).context.value.testsPassed,false,'an already observed immutable context is private to this invocation');
  await session.records.transact(f.scope,{operationId:'invalidate-known-comparison',preconditions:[{namespace:'runtime',key:'test/known-context-invalidation',version:null}],
   changes:[{op:'put',namespace:'runtime',key:'test/known-context-invalidation',immutable:false,value:{sequence:1}}],events:[]});
  await assert.rejects(read(),error=>error===failure);
 });
 for(let n=0;n<2;n++)await assert.rejects(session.run(()=>read()),error=>error===failure);
 denied=false;assert.equal((await session.run(()=>read())).context.sha256,f.view.manifest.expectedContext);
});
