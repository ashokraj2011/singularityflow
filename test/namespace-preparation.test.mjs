import test from 'node:test';
import assert from 'node:assert/strict';
import { namespacePreparationFixture } from './helpers/namespace-preparation-fixture.mjs';
import { SingularityFlowError } from '../src/foundation/failures.mjs';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createFilesystemSourceUnit } from '../src/sgos/filesystem-source-unit.mjs';
import { createNamespaceSourceEngine } from '../src/engine-storage/namespace-source.mjs';
import { LIFECYCLE_AUTHORITY_KEY } from '../src/engine-storage/namespace-lifecycle-contract.mjs';
import { createNamespaceDraftStore } from '../src/engine-storage/namespace-draft-store.mjs';
import { createEngine } from '../src/engine-sdk/index.mjs';

for(const backend of ['filesystem','sqlite','application']) {
  test(`${backend}: preparation retains actual template bytes only in device-local drafts`,async t=>{
    const f=await namespacePreparationFixture(t,{backend}),before=await f.head();
    assert.equal((await f.read(f.engine)).manifest.status,'missing');
    const prepared=await f.engine.run('phase.prepare',{workId:f.inputs.workId,phaseId:'intake'});
    assert.equal(prepared.status,'prepared');assert.equal(prepared.generation,1);assert.equal(prepared.effects.localDraftSaved,true);
    assert.equal(prepared.effects.committed,false);assert.equal(prepared.effects.generationOpened,false);
    assert.equal(prepared.manifest.inputContext.generation,1);assert.equal(prepared.manifest.inputContext.integrityVerified,false);
    const draft=await f.read(f.engine);assert.equal(draft.manifest.status,'open');
    assert.equal(draft.manifest.artifact.content.text,'# Intake\n\n## Requirements\n\n## Acceptance criteria\n');
    assert.equal(draft.manifest.artifact.reference.namespace,'local');
    assert.deepEqual(await f.head(),before,'preparation never changes canonical lifecycle state');
    assert.equal((await f.records.list(f.scope,'runtime',{limit:100})).entries.some(row=>JSON.stringify(row.value).includes('sflow-namespace-prepared-phase')),false);
    assert.equal(JSON.stringify(prepared).includes(f.privateDirectory),false);
  });
  test(`${backend}: authored bytes survive prepare retry and a separate engine instance`,async t=>{
    const f=await namespacePreparationFixture(t,{backend});await f.engine.run('phase.prepare');
    const before=await f.read(f.engine),content=await f.upload('# Authored intake\n\nAn observable requirement.\n');
    const input={operationId:'write-intake-1',workId:f.inputs.workId,phaseId:'intake',expectedRevision:before.manifest.draft.revision,
      content,reason:'Complete the requirement draft.'};
    const written=await f.engine.run('phase.draft.write',input);assert.equal(written.status,'saved');
    assert.equal(written.effects.committed,false);assert.equal(written.effects.approvalRecorded,false);
    const reopened=f.make();await reopened.run('phase.prepare');
    assert.equal((await f.read(reopened)).manifest.artifact.content.text,'# Authored intake\n\nAn observable requirement.\n');
    assert.deepEqual(await reopened.run('phase.draft.write',input),{...written,replayed:true});
    assert.equal((await f.head()).record.version,f.story.revision);
  });
}

test('permission revocation before private acceptance preserves shared state and creates no draft head',async t=>{
  const f=await namespacePreparationFixture(t);f.control.draftHook=(_count,request)=>{
    if(request.operation==='phase.prepare'&&f.control.draftCalls===2)f.control.permissions=[];
  };
  await assert.rejects(f.engine.run('phase.prepare'),{code:'ENGINE_AUTHORITY_REQUIRED'});
  f.control.permissions=['phase.draft.read'];assert.equal((await f.read(f.make())).manifest.status,'missing');
  assert.equal((await f.head()).record.version,f.story.revision);
});

test('a stale editor cannot overwrite a newer authored draft',async t=>{
  const f=await namespacePreparationFixture(t);await f.engine.run('phase.prepare');const initial=await f.read(f.engine);
  const content=await f.upload('# First edit'),other=await f.upload('# Stale edit');
  const input={operationId:'first-edit',workId:f.inputs.workId,phaseId:'intake',expectedRevision:initial.manifest.draft.revision,content,reason:'First edit.'};
  await f.engine.run('phase.draft.write',input);
  await assert.rejects(f.make().run('phase.draft.write',{...input,operationId:'stale-edit',content:other}),{code:'ENGINE_CONTEXT_CHANGED'});
  assert.equal((await f.read(f.engine)).manifest.artifact.content.text,'# First edit');
});

test('the local write survives a lost acknowledgement without duplicate changes',async t=>{
  const f=await namespacePreparationFixture(t);await f.engine.run('phase.prepare');const initial=await f.read(f.engine),content=await f.upload('# Retained edit');
  const failure=new SingularityFlowError('Local acknowledgement lost.',{code:'SDA_NAMESPACE_OUTCOME_UNKNOWN',outcomeClass:'OUTCOME_UNKNOWN'});let once=false;
  const localRecords={...f.localRecords,async transact(...args){const result=await f.localRecords.transact(...args);if(!once){once=true;throw failure;}return result;}};
  const input={operationId:'unknown-edit',workId:f.inputs.workId,phaseId:'intake',expectedRevision:initial.manifest.draft.revision,content,reason:'Retain the actual edit.'};
  await assert.rejects(f.make({localRecords}).run('phase.draft.write',input),error=>error===failure);
  const replay=await f.make().run('phase.draft.write',input);assert.equal(replay.replayed,true);
  assert.equal((await f.read(f.engine)).manifest.artifact.content.text,'# Retained edit');
});

test('an explicit digest-bound rebind preserves authored bytes after the shared basis changes',async t=>{
  const f=await namespacePreparationFixture(t);await f.engine.run('phase.prepare');const first=await f.read(f.engine);
  const content=await f.upload('# Keep this authored draft');
  await f.engine.run('phase.draft.write',{operationId:'before-rebase',workId:f.inputs.workId,phaseId:'intake',
    expectedRevision:first.manifest.draft.revision,content,reason:'Authored before the shared update.'});
  const root=path.join(f.directory,'checkout');await mkdir(root);await writeFile(path.join(root,'app.js'),'export const answer = 42;');
  const unit=await createFilesystemSourceUnit({root,id:'app-unit',projectId:f.scope.projectId,repositoryId:'app'});
  f.control.permissions.push('source.bind');
  const bound=await createNamespaceSourceEngine({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority,
    sources:[unit],access:f.access,clock:f.clock}).run('source.bind',{operationId:'bind-before-rebase',workId:f.inputs.workId,
      expectedRevision:f.story.revision,repositories:['app'],reason:'Bind the actual source checkout.'});
  const stale=await f.read(f.engine);assert.equal(stale.manifest.status,'stale');
  await assert.rejects(f.engine.run('phase.prepare'),{code:'ENGINE_DRAFT_BASIS_CHANGED'});
  const input={operationId:'rebase-intake',workId:f.inputs.workId,phaseId:'intake',expectedRevision:stale.manifest.draft.revision,
    confirm:stale.manifest.draft.bodySha256,reason:'Preserve the reviewed draft against the current Story revision.'};
  await assert.rejects(f.engine.run('phase.draft.rebase',{...input,confirm:'0'.repeat(64)}),{code:'ENGINE_CONFIRMATION_REQUIRED'});
  const result=await f.engine.run('phase.draft.rebase',input);assert.equal(result.status,'rebound');
  const after=await f.read(f.make());assert.equal(after.manifest.status,'open');
  assert.equal(after.manifest.artifact.content.text,'# Keep this authored draft');
  assert.equal(after.manifest.draft.baseRevision,bound.revision);assert.equal((await f.head()).record.version,bound.revision);
  const local=createNamespaceDraftStore({records:f.localRecords,content:f.localContent,scope:f.scope,workId:f.inputs.workId,phaseId:'intake'});
  assert.equal((await local.capture()).payload.reason,input.reason);
  assert.deepEqual(await f.make().run('phase.draft.rebase',input),{...result,replayed:true});
});

test('bounded draft reads preserve UTF-8 BOM and multibyte characters while binary content stays metadata only',async t=>{
  const f=await namespacePreparationFixture(t);await f.engine.run('phase.prepare');let before=await f.read(f.engine);
  const text='\uFEFFé🧮z',content=await f.upload(text);
  await f.engine.run('phase.draft.write',{operationId:'unicode-edit',workId:f.inputs.workId,phaseId:'intake',
    expectedRevision:before.manifest.draft.revision,content,reason:'Preserve actual UTF-8 bytes.'});
  const bounded=await f.engine.run('phase.draft.read',{maximumBytes:5});
  assert.deepEqual(bounded.manifest.artifact.content,{kind:'text',text:'\uFEFFé',bytes:5,truncated:true});
  before=await f.read(f.engine);assert.equal(before.manifest.artifact.content.text,text);assert.equal(before.manifest.artifact.content.truncated,false);
  const image=Buffer.from([137,80,78,71,13,10,26,10,0,255]),reference=await f.upload(image);
  await f.engine.run('phase.draft.write',{operationId:'binary-edit',workId:f.inputs.workId,phaseId:'intake',
    expectedRevision:before.manifest.draft.revision,content:reference,reason:'Keep the actual supplied binary bytes.'});
  await f.engine.run('phase.prepare');const binary=await f.read(f.engine);
  assert.deepEqual(binary.manifest.artifact.content,{kind:'binary',bytes:image.byteLength});
  assert.deepEqual(Buffer.from((await f.localContent.read(f.scope,reference)).data),image);
});

test('concurrent preparation keeps one accepted private origin and never replaces it with a second clock',async t=>{
  const f=await namespacePreparationFixture(t);
  const results=await Promise.all([f.make().run('phase.prepare'),f.make().run('phase.prepare')]);
  assert.equal(results[0].manifest.inputContext.sha256,results[1].manifest.inputContext.sha256);
  const rows=await f.localRecords.list(f.scope,'local',{limit:100});
  assert.equal(rows.entries.filter(row=>row.key.endsWith('/head')).length,1);
  assert.equal(rows.entries.filter(row=>row.key.includes('/operations/')).length,1);
  assert.equal((await f.head()).record.version,f.story.revision);
});

test('shared stores cannot masquerade as private working storage',async t=>{
  const f=await namespacePreparationFixture(t);
  assert.throws(()=>f.make({localRecords:f.records}),{code:'ENGINE_INPUT_INVALID'});
  assert.throws(()=>f.make({localContent:f.content}),{code:'ENGINE_INPUT_INVALID'});
});

test('a genuine private content permission failure remains its original error',async t=>{
  const f=await namespacePreparationFixture(t);await f.engine.run('phase.prepare');const original=await f.read(f.engine);
  const failure=Object.assign(new Error('Actual local read denied.'),{code:'EACCES',path:'private-content'});
  const localContent={...f.localContent,async read(scope,ref,options){if(ref.sha256===original.manifest.artifact.reference.sha256)throw failure;
    return f.localContent.read(scope,ref,options);}};
  await assert.rejects(f.read(f.make({localContent})),error=>error===failure);
});

test('fencing refuses new private writes while an accepted write remains acknowledgeable',async t=>{
  const f=await namespacePreparationFixture(t);await f.engine.run('phase.prepare');const before=await f.read(f.engine),content=await f.upload('# Reviewed private draft');
  const input={operationId:'before-fence',workId:f.inputs.workId,phaseId:'intake',expectedRevision:before.manifest.draft.revision,content,reason:'Save actual authoring bytes.'};
  const saved=await f.engine.run('phase.draft.write',input),active=await f.readAuthority();
  await f.records.transact(f.scope,{operationId:'fence-private-fixture',preconditions:[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:active.record.version}],
    changes:[{op:'put',namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,immutable:false,value:{...active.record.value,status:'fenced'}}],events:[]});
  await assert.rejects(f.engine.run('phase.draft.write',{...input,operationId:'after-fence',expectedRevision:saved.revision}),{code:'ENGINE_AUTHORITY_FENCED'});
  assert.deepEqual(await f.make().run('phase.draft.write',input),{...saved,replayed:true});
});

test('code preparation opens a real private source-snapshot intent without inventing a Git commit',async t=>{
  const f=await namespacePreparationFixture(t,{code:true}),before=await f.head();
  const result=await f.engine.run('phase.prepare');
  assert.equal(result.manifest.codeDeliveryRequired,true);assert.equal(result.effects.generationOpened,true);
  assert.equal(result.manifest.generationIntent.forPreparedGeneration,true);
  const entries=await f.localRecords.list(f.scope,'local',{limit:100}),head=entries.entries.find(row=>row.key.endsWith('/head'));
  const body=JSON.parse(Buffer.from((await f.localContent.read(f.scope,head.value.body)).data));
  const intent=JSON.parse(Buffer.from((await f.localContent.read(f.scope,body.payload.generationIntent.record)).data));
  assert.equal(intent.format,'sflow-namespace-source-generation/v1');assert.equal(intent.sources[0].id,'app');
  assert.equal(Object.hasOwn(intent,'baselineCommit'),false);
  assert.deepEqual(await f.head(),before);assert.equal((await f.engine.run('phase.prepare')).effects.generationOpened,false);
});

test('source changes during code preparation refuse the generation before a private head is accepted',async t=>{
  const f=await namespacePreparationFixture(t,{code:true});let changed=false;
  const unit={descriptor:f.unit.descriptor,async capture(options){const observed=await f.unit.capture(options);
    if(!changed){changed=true;await writeFile(path.join(f.sourceRoot,'app.js'),'a concurrent source edit');}return observed;}};
  await assert.rejects(f.make({sources:[unit]}).run('phase.prepare'),{code:'ENGINE_SOURCE_CHANGED'});
  assert.equal((await f.read(f.engine)).manifest.status,'missing');
});

test('another source unit cannot reuse an accepted repository binding even when its bytes match',async t=>{
  const f=await namespacePreparationFixture(t,{code:true});
  const other=await createFilesystemSourceUnit({root:f.sourceRoot,id:'another-checkout',projectId:f.scope.projectId,repositoryId:'app'});
  await assert.rejects(f.make({sources:[other]}).run('phase.prepare'),{code:'ENGINE_SOURCE_UNIT_UNAVAILABLE'});
  assert.equal((await f.read(f.engine)).manifest.status,'missing');
});

for(const kind of ['context','generation'])test(`a retained private ${kind} from another phase cannot be reused as this draft`,async t=>{
  const f=await namespacePreparationFixture(t,{code:kind==='generation'});await f.engine.run('phase.prepare');const canonical=await f.head();
  const local=createNamespaceDraftStore({records:f.localRecords,content:f.localContent,scope:f.scope,workId:f.inputs.workId,phaseId:'intake'});
  const accepted=await local.capture(),payload=structuredClone(accepted.payload),reference=kind==='context'?payload.inputContext:payload.generationIntent.record;
  const value=JSON.parse(Buffer.from((await f.localContent.read(f.scope,reference)).data));value.phase='another-phase';
  const changed=await f.upload(JSON.stringify(value));
  if(kind==='context')payload.inputContext=changed;
  else payload.generationIntent={...payload.generationIntent,id:'generation-'+changed.sha256,record:changed};
  await local.save({operationId:'corrupt-private-fixture',parametersSha256:'a'.repeat(64),expectedRevision:accepted.revision,payload});
  await assert.rejects(f.read(f.engine),{code:'ENGINE_STORAGE_CORRUPT'});
  await assert.rejects(f.engine.run('phase.prepare'),{code:'ENGINE_STORAGE_CORRUPT'});
  assert.deepEqual(await f.head(),canonical);
});

test('the registry rejects a draft reader that exceeds the requested byte budget',async t=>{
  const f=await namespacePreparationFixture(t);await f.engine.run('phase.prepare');const facts=(await f.read(f.engine)).manifest;
  const port={load:async()=>({subject:{kind:'story',id:f.inputs.workId},phase:'intake'}),
    read:async()=>({workId:f.inputs.workId,phase:'intake',status:facts.status,draft:facts.draft,artifact:facts.artifact})};
  await assert.rejects(createEngine({ports:{phaseDraftRead:port}}).run('phase.draft.read',{maximumBytes:0}),{code:'ENGINE_PORT_RESULT_INVALID'});
  const inconsistent={...facts.draft,currentRevision:'another-shared-revision'};
  await assert.rejects(createEngine({ports:{phaseDraftRead:{...port,read:async()=>({workId:f.inputs.workId,phase:'intake',status:'open',draft:inconsistent,artifact:facts.artifact})}}})
    .run('phase.draft.read'),{code:'ENGINE_PORT_RESULT_INVALID'});
});

for(const operation of ['phase.prepare','phase.draft.write'])test(`${operation}: a phase-agent change before acceptance cannot borrow earlier author permission`,async t=>{
  const f=await namespacePreparationFixture(t);let input={};
  if(operation==='phase.draft.write') {
    await f.engine.run('phase.prepare');const draft=await f.read(f.engine);
    input={operationId:'agent-change',workId:f.inputs.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
      content:await f.upload('# Edit must stay unaccepted'),reason:'Exercise the original phase author binding.'};
  }
  let calls=0;f.control.draftHook=(_count,request)=>{if(request.operation===operation&&++calls===2)f.control.agentId='another-agent';};
  await assert.rejects(f.engine.run(operation,input),{code:'ENGINE_ACTOR_CHANGED'});
  f.control.agentId='analyst';
  const draft=await f.read(f.engine);
  if(operation==='phase.prepare')assert.equal(draft.manifest.status,'missing');
  else assert.equal(draft.manifest.artifact.content.text.includes('must stay unaccepted'),false);
});

for(const kind of ['context','generation'])test(`a future private ${kind} remains unsupported without replacing its draft`,async t=>{
  const f=await namespacePreparationFixture(t,{code:kind==='generation'});await f.engine.run('phase.prepare');
  const local=createNamespaceDraftStore({records:f.localRecords,content:f.localContent,scope:f.scope,workId:f.inputs.workId,phaseId:'intake'});
  const accepted=await local.capture(),payload=structuredClone(accepted.payload),reference=kind==='context'?payload.inputContext:payload.generationIntent.record;
  const value=JSON.parse(Buffer.from((await f.localContent.read(f.scope,reference)).data));value.schemaVersion=2;
  const changed=await f.upload(JSON.stringify(value));
  if(kind==='context')payload.inputContext=changed;
  else payload.generationIntent={...payload.generationIntent,id:'generation-'+changed.sha256,record:changed};
  const future=await local.save({operationId:'future-private-fixture',parametersSha256:'a'.repeat(64),expectedRevision:accepted.revision,payload});
  await assert.rejects(f.engine.run('phase.prepare'),{code:'ENGINE_STORAGE_UNSUPPORTED'});
  assert.equal((await local.capture()).revision,future.revision);
});
