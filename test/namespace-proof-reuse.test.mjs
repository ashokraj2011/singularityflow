import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespacePublicationReader} from '../src/engine-storage/namespace-publication-reader.mjs';
import {createNamespacePhaseCheckReader} from '../src/engine-storage/namespace-phase-check-reader.mjs';
import {createNamespaceCodePolicyReader,withCodePolicyTraversal,verifyCodePolicyInTraversal} from '../src/engine-storage/namespace-code-policy.mjs';
import {namespaceLifecycleStoryKey} from '../src/engine-storage/namespace-lifecycle-reader.mjs';
test('immutable fact reuse returns private copies, keeps mutable reads fresh and expires with its traversal',async t=>{
  const f=await namespaceEngineFixture(t,{backend:'filesystem',working:false});await f.bootstrap();const snapshot=await f.capture(),ref=snapshot.workflow.workItem.source.content,
    before=Buffer.from((await f.content.read(f.scope,ref)).data),denied=Object.assign(Error('Original content permission error.'),{code:'EACCES'}),counts=new Map();
  let bytes=0,blocked=false,escaped,nested;
  const observer=createNamespaceStoryObserver({...f.options,records:{...f.records,read(...args){counts.set(args[2],(counts.get(args[2])??0)+1);return f.records.read(...args);}},
    content:{...f.content,read(scope,reference,options){if(reference.sha256===ref.sha256){bytes++;if(blocked)throw denied;}return f.content.read(scope,reference,options);}}});
  await observer.withReadScope(async scoped=>{escaped=scoped;
    const first=await scoped.record('config',snapshot.configuration.key,true);first.value.changed=true;
    assert.equal((await scoped.record('config',snapshot.configuration.key,true)).value.changed,undefined);assert.equal(counts.get(snapshot.configuration.key),1);
    const a=await scoped.bytes(ref,ref.bytes);a.fill(0);assert.deepEqual(await scoped.bytes(ref,ref.bytes),before);assert.equal(bytes,1);
    await scoped.withReadScope(async child=>{nested=child;assert.deepEqual(await child.bytes(ref,ref.bytes),before);
      assert.equal((await child.record('config',snapshot.configuration.key,true)).value.changed,undefined);});
    await assert.rejects(nested.bytes(ref,ref.bytes),{code:'ENGINE_INPUT_INVALID'});
    assert.deepEqual(await scoped.bytes(ref,ref.bytes),before);assert.equal(bytes,1);assert.equal(counts.get(snapshot.configuration.key),1);
    const head=namespaceLifecycleStoryKey(f.workId);await scoped.record('state',head,false);await scoped.record('state',head,false);assert.equal(counts.get(head),2);
  });
  await assert.rejects(escaped.bytes(ref,ref.bytes),{code:'ENGINE_INPUT_INVALID'});
  await observer.withReadScope(async scoped=>{blocked=true;await assert.rejects(scoped.bytes(ref,ref.bytes),error=>error===denied);blocked=false;assert.deepEqual(await scoped.bytes(ref,ref.bytes),before);});
  assert.equal(bytes,3);assert.deepEqual(await f.capture(),snapshot);
});
test('fresh mutable and partial reads also reject after scope expiry or cancellation',async t=>{
  const f=await namespaceEngineFixture(t,{backend:'filesystem',working:false});await f.bootstrap();const ref=(await f.capture()).workflow.workItem.source.content;
  let pause=null,release;const wait=()=>new Promise(resolve=>{release=resolve;}),
    observer=createNamespaceStoryObserver({...f.options,records:{...f.records,async read(...args){const result=await f.records.read(...args);if(pause==='record')await wait();return result;}},
      content:{...f.content,async read(...args){const result=await f.content.read(...args);if(pause==='bytes')await wait();return result;}}});
  for(const kind of ['record','bytes']){
    pause=kind;let pending;
    await observer.withReadScope(scoped=>{pending=kind==='record'?scoped.record('state',namespaceLifecycleStoryKey(f.workId),false):scoped.bytes(ref,1);});
    const rejected=assert.rejects(pending,{code:'ENGINE_INPUT_INVALID'});while(!release)await new Promise(resolve=>setImmediate(resolve));release();release=null;await rejected;
  }
  pause='bytes';await observer.withReadScope(async scoped=>{const controller=new AbortController(),pending=scoped.bytes(ref,1,controller.signal),
    rejected=assert.rejects(pending,{code:'ENGINE_OPERATION_CANCELLED'});while(!release)await new Promise(resolve=>setImmediate(resolve));controller.abort();release();await rejected;});
});
test('immutable content reuse has an eight-MiB quota and never caches partial reads as full bytes',async t=>{
  const f=await namespaceEngineFixture(t,{backend:'filesystem',working:false});await f.bootstrap();
  const first=(await f.content.put(f.scope,'evidence',Buffer.alloc(6*1024*1024,1))).reference,
    second=(await f.content.put(f.scope,'evidence',Buffer.alloc(6*1024*1024,2))).reference,counts=new Map(),
    observer=createNamespaceStoryObserver({...f.options,content:{...f.content,read(scope,ref,options){counts.set(ref.sha256,(counts.get(ref.sha256)??0)+1);return f.content.read(scope,ref,options);}}});
  await observer.withReadScope(async scoped=>{await scoped.bytes(first,first.bytes);await scoped.bytes(first,first.bytes);
    await scoped.bytes(second,second.bytes);await scoped.bytes(second,second.bytes);assert.equal(counts.get(first.sha256),1);assert.equal(counts.get(second.sha256),2);
    await scoped.bytes(first,1);await scoped.bytes(first,first.bytes);assert.equal(counts.get(first.sha256),2);});
});
test('Code proof reuse is scoped to the same read owner and rebinds only genuine unchanged proofs',async t=>{
  const f=await namespaceTestWitnessFixture(t);await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  const snapshot=await f.capture(),binding=snapshot.workflow.phases.build.publicationBindings[0],publication=await f.json(binding.record),policy=publication.policyEvidence.find(row=>row.kind==='code-delivery/v1'),
    manifest=await f.json(policy.record),report=await f.json(manifest.report),archive=await f.json(report.preflight.source.result.content),repository=await f.json(archive.repositories[0].manifest),
    chunk=repository.entries.find(row=>row.newPath==='src/converter.js').chunks[0],denied=Object.assign(Error('The original source chunk became unreadable.'),{code:'EACCES'});
  let reads=0,blocked=false,escaped;
  const observer=createNamespaceStoryObserver({...f.common,content:{...f.content,read(scope,reference,options){if(reference.sha256===chunk.sha256){reads++;if(blocked)throw denied;}return f.content.read(scope,reference,options);}}}),
    checks=createNamespacePhaseCheckReader({...f.common,observer}),make=()=>createNamespacePublicationReader({observer,scope:f.scope,workId:f.inputs.workId,checks});
  await withCodePolicyTraversal(null,async token=>{escaped=token;await make().accepted(binding,'build',{policyTraversal:token});const before=reads,other=make(),value=await other.accepted(binding,'build',{policyTraversal:token});
    assert.ok(before>0);assert.equal(reads,before);assert.ok(other.policies.owners(value).includes('code-delivery'));await other.policies.freshCodeSources(value,f.sources);
    const reader=createNamespaceCodePolicyReader({observer,scope:f.scope,workId:f.inputs.workId,checks}),
      genuine=await verifyCodePolicyInTraversal(reader,observer,value,policy,{policyTraversal:token});
    const another=createNamespaceStoryObserver(f.common),foreign=createNamespaceCodePolicyReader({observer:another,scope:f.scope,workId:f.inputs.workId,checks});
    assert.throws(()=>foreign.reuse(value,genuine),{code:'ENGINE_CONTEXT_CHANGED'});
    const original=genuine.report.repositories[0].observed.repositoryId;genuine.report.repositories[0].observed.repositoryId='another';
    assert.throws(()=>reader.reuse(value,genuine),{code:'ENGINE_CONTEXT_CHANGED'});assert.equal(reader.proof(value),null);
    genuine.report.repositories[0].observed.repositoryId=original;
    const controller=new AbortController();controller.abort();
    await assert.rejects(verifyCodePolicyInTraversal(createNamespaceCodePolicyReader({observer,scope:f.scope,workId:f.inputs.workId,checks}),observer,value,policy,{policyTraversal:token,signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
  });
  blocked=true;await assert.rejects(make().accepted(binding,'build',{policyTraversal:escaped}),error=>error===denied);
});
