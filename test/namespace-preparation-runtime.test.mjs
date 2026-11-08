import test from 'node:test';
import assert from 'node:assert/strict';
import {namespacePreparationFixture} from './helpers/namespace-preparation-fixture.mjs';
import {createNamespacePreparationRuntime} from '../src/engine-storage/namespace-preparation.mjs';

function runtime(f,extra={}) {return createNamespacePreparationRuntime({records:f.records,content:f.content,localRecords:f.localRecords,
  localContent:f.localContent,scope:f.scope,workId:f.inputs.workId,authority:f.authority,access:f.access,clock:f.clock,...extra});}
async function authored(f,text='# Authored result\n\nActual evidence and an observable outcome.') {
  await f.engine.run('phase.prepare');const initial=await f.read(f.engine);
  await f.engine.run('phase.draft.write',{operationId:'author-result',workId:f.inputs.workId,phaseId:'intake',
    expectedRevision:initial.manifest.draft.revision,content:await f.upload(text),reason:'Complete the actual private draft.'});
  return text;
}
for(const backend of ['filesystem','sqlite','application'])test(`${backend}: runtime capture binds actual private bytes, actor and pinned resources without moving shared state`,async t=>{
  const f=await namespacePreparationFixture(t,{backend}),text=await authored(f),before=await f.head(),r=runtime(f);
  f.control.permissions.push('phase.publish');
  const selected=await r.captureDraft('intake'),identity=r.draftIdentity(selected),admitted=await r.admitDraft(selected,'phase.publish');
  const facts=r.draftFacts(admitted);
  assert.equal(facts.operation,'phase.publish');assert.equal(facts.revision,before.record.version);assert.equal(facts.draftRevision,identity.revision);
  assert.equal(facts.bodySha256,identity.bodySha256);assert.equal(facts.actor.principalId,f.control.principalId);assert.equal(facts.agentId,'analyst');
  assert.ok(facts.resources.some(item=>item.kind==='story-source'));assert.ok(facts.resources.some(item=>item.kind==='skill'&&item.id==='framework'));
  assert.equal(r.artifactBytes(admitted).toString(),text);
  const copy=r.artifactBytes(admitted);copy.fill(0);assert.equal(r.artifactBytes(admitted).toString(),text);
  facts.payload.artifact.key='another.md';facts.actor.principalId='not-the-author';
  assert.notEqual(r.draftFacts(admitted).payload.artifact.key,'another.md');assert.equal(r.draftFacts(admitted).actor.principalId,f.control.principalId);
  await r.revalidateDraft(admitted);assert.deepEqual(await f.head(),before);
  const other=runtime(f);assert.throws(()=>other.draftIdentity(selected),{code:'ENGINE_INPUT_INVALID'});
  await assert.rejects(other.revalidateDraft(admitted),{code:'ENGINE_INPUT_INVALID'});
});

test('a private capture is not operation permission and a revoked permission cannot revalidate it',async t=>{
  const f=await namespacePreparationFixture(t);await authored(f);const r=runtime(f),selected=await r.captureDraft('intake');
  await assert.rejects(r.admitDraft(selected,'phase.publish'),{code:'ENGINE_AUTHORITY_REQUIRED'});
  f.control.permissions.push('phase.publish');const admitted=await r.admitDraft(selected,'phase.publish');
  f.control.permissions=f.control.permissions.filter(value=>value!=='phase.publish');
  await assert.rejects(r.revalidateDraft(admitted),{code:'ENGINE_AUTHORITY_REQUIRED'});
});

test('a newer private edit invalidates both an old selection and a previously admitted runtime snapshot',async t=>{
  const f=await namespacePreparationFixture(t);await authored(f);f.control.permissions.push('phase.publish');const r=runtime(f),selected=await r.captureDraft('intake');
  const admitted=await r.admitDraft(selected,'phase.publish'),current=await f.read(f.engine);
  await f.engine.run('phase.draft.write',{operationId:'newer-result',workId:f.inputs.workId,phaseId:'intake',
    expectedRevision:current.manifest.draft.revision,content:await f.upload('# A newer authored result'),reason:'Preserve a new private edit.'});
  await assert.rejects(r.admitDraft(selected,'phase.publish'),{code:'ENGINE_CONTEXT_CHANGED'});
  await assert.rejects(r.revalidateDraft(admitted),{code:'ENGINE_CONTEXT_CHANGED'});
});

test('private read snapshots reuse already verified immutable bytes within one invocation',async t=>{
  const f=await namespacePreparationFixture(t);await f.engine.run('phase.prepare');let reads=0;
  const localContent={...f.localContent,async read(...args){reads++;return f.localContent.read(...args);}};
  const result=await f.make({localContent}).run('phase.draft.read');
  assert.equal(result.manifest.status,'open');
  assert.equal(reads,3,'one private body, one shared initial/current artifact and one input context');
  await f.make({localContent}).run('phase.draft.read');assert.equal(reads,6,'a later invocation verifies its own bytes again');
});
