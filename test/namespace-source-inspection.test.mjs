import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {namespacePreparationFixture} from './helpers/namespace-preparation-fixture.mjs';
import {createNamespaceSourceInspectionEngine} from '../src/engine-storage/namespace-source-inspection.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespaceSourceEngine} from '../src/engine-storage/namespace-source.mjs';
import {createFilesystemSourceUnit} from '../src/sgos/filesystem-source-unit.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';
import {createEngine,ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
import {sourceSnapshotChanges,phaseSourceInspectionManifest} from '../src/kernel/source-changes.mjs';

const options=f=>({records:f.records,content:f.content,localRecords:f.localRecords,localContent:f.localContent,
  scope:f.scope,workId:f.inputs.workId,authority:f.authority,access:f.access,clock:f.clock,sources:f.unit?[f.unit]:[]});
const inspect=(f,extra={})=>createNamespaceSourceInspectionEngine({...options(f),...extra}).run('phase.source.inspect');
const readOnly=port=>({...port,...Object.fromEntries(['put','transact'].filter(name=>typeof port[name]==='function')
  .map(name=>[name,()=>{assert.fail('A source inspection cannot invoke '+name);}]))});
const permit=f=>f.control.permissions.push('phase.source.inspect');

for(const backend of ['filesystem','sqlite','application'])test(`${backend}: actual generation changes use shared policy without changing either store`,async t=>{
  const f=await namespacePreparationFixture(t,{backend,code:true,configure:source=>{source.definition.governance={...(source.definition.governance??{}),protectedPaths:['src/locked.js']};}});
  permit(f);await f.engine.run('phase.prepare');const head=await f.head();
  await mkdir(path.join(f.sourceRoot,'src'));await mkdir(path.join(f.sourceRoot,'test'));
  await writeFile(path.join(f.sourceRoot,'app.js'),'export const answer = 43;');
  await writeFile(path.join(f.sourceRoot,'src/locked.js'),'export const owned = true;');
  await writeFile(path.join(f.sourceRoot,'package.json'),'{}');
  await writeFile(path.join(f.sourceRoot,'test/app.test.js'),'test("an actual source file, not an executed test",()=>{});');
  // An independent read principal does not have to assume the configured phase-author role.
  f.control.agentId='independent-reader';f.control.principalId='read-only-principal';f.control.permissions=['phase.source.inspect'];
  const binding={records:readOnly(f.records),content:readOnly(f.content),localRecords:readOnly(f.localRecords),localContent:readOnly(f.localContent)};
  const result=await inspect(f,binding),m=result.manifest;
  assert.equal(m.status,'inspected');assert.equal(m.contract,'sflow-phase-source-inspection/v1');
  assert.deepEqual(m.totals,{added:3,modified:1,removed:0,changes:4,shown:4,truncated:false});
  assert.deepEqual(m.repositories[0].roles,{'product-source':2,'build-configuration':1,'test-source':1});
  assert.equal(m.repositories[0].protectedChanges,1);assert.equal(m.repositories[0].boundaryViolations,0);
  const packageEntry=m.repositories[0].entries.find(entry=>entry.newPath==='package.json');
  assert.equal(packageEntry.role,'build-configuration');assert.equal(packageEntry.protected,false);
  assert.equal(m.repositories[0].entries.find(entry=>entry.newPath==='src/locked.js').protected,true);
  assert.equal(m.repositories[0].policy.tracking,'not-observed');assert.equal(m.repositories[0].policy.renameDetection,'not-observed');
  assert.equal(m.sourceContentsRetained,false);assert.equal(m.publicationReadinessInspected,false);assert.equal(m.testsRun,false);
  assert.deepEqual(Object.values(result.effects),Object.values(result.effects).map(()=>false));
  assert.deepEqual(await f.head(),head);assert.equal(JSON.stringify(result).includes(f.sourceRoot),false);
  const repeated=await inspect(f,binding);assert.deepEqual(repeated,result);
});

test('the public namespace Engine binds the same registered read operation',async t=>{
  const f=await namespacePreparationFixture(t,{code:true});permit(f);await f.engine.run('phase.prepare');
  const engine=createNamespaceEngine({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority,
    access:f.access,clock:f.clock,working:{records:f.localRecords,content:f.localContent},sources:[f.unit]});
  assert.deepEqual(await engine.run('phase.source.inspect'),await inspect(f));
  const definition=ENGINE_OPERATIONS.find(item=>item.id==='phase.source.inspect');
  assert.equal(definition.effect,'read');assert.deepEqual(definition.stages,['load','inspect']);assert.equal(definition.humanDecision,false);
});

test('missing and non-code drafts have explicit states without claiming source or publication readiness',async t=>{
  const f=await namespacePreparationFixture(t);permit(f);
  const missing=await inspect(f);assert.equal(missing.manifest.status,'missing-draft');
  assert.deepEqual(missing.manifest.recovery,{operation:'phase.prepare',inputs:{workId:f.inputs.workId,phaseId:'intake'}});
  await f.engine.run('phase.prepare');assert.equal((await inspect(f)).manifest.status,'not-code-generation');
  await assert.rejects(inspect(f,{localRecords:null,localContent:null}),error=>error.code==='ENGINE_PORT_UNAVAILABLE'
    &&error.details.required.includes('machine-local-working-store'));
});

test('a stale source draft keeps the exact reviewed rebind route and never recaptures a replacement baseline',async t=>{
  const f=await namespacePreparationFixture(t,{code:true});permit(f);await f.engine.run('phase.prepare');
  const draft=await f.read(f.engine),head=await f.head();
  await createNamespaceSourceEngine(options(f)).run('source.bind',{operationId:'later-source-binding',workId:f.inputs.workId,
    expectedRevision:head.record.version,repositories:['app'],reason:'Another accepted selection makes the old private basis stale.'});
  const result=await inspect(f,{sources:[{descriptor:f.unit.descriptor,capture(){assert.fail('A stale draft cannot select a new baseline.');}}]});
  assert.equal(result.manifest.status,'stale-draft');
  assert.equal(result.manifest.recovery.operation,'phase.draft.rebase');
  assert.equal(result.manifest.recovery.inputs.expectedRevision,draft.manifest.draft.revision);
  assert.equal(result.manifest.recovery.inputs.confirm,draft.manifest.draft.bodySha256);
});

test('an entry budget truncates only presentation, after full protected and boundary analysis',async t=>{
  const f=await namespacePreparationFixture(t,{code:true,configure:source=>{
    source.definition.phases.intake.sourceBoundary='test-automation';
    source.definition.governance={...(source.definition.governance??{}),protectedPaths:['app.js']};
  }});permit(f);await f.engine.run('phase.prepare');await writeFile(path.join(f.sourceRoot,'app.js'),'product changes outside a test-only phase');
  const engine=createNamespaceSourceInspectionEngine(options(f));
  const result=await engine.run('phase.source.inspect',{maximumEntries:0}),m=result.manifest;
  assert.equal(m.totals.changes,1);assert.equal(m.totals.shown,0);assert.equal(m.totals.truncated,true);
  assert.equal(m.repositories[0].protectedChanges,1);assert.equal(m.repositories[0].boundaryViolations,1);
  assert.deepEqual(m.repositories[0].entries,[]);
  for(const input of [{maximumEntries:-1},{maximumEntries:1025},{maximumEntries:1.1},{ready:true}]){
    await assert.rejects(engine.run('phase.source.inspect',input),{code:'ENGINE_INPUT_INVALID'});
  }
});

test('actual source drift during the read is refused rather than returning an outdated change list',async t=>{
  const f=await namespacePreparationFixture(t,{code:true});permit(f);await f.engine.run('phase.prepare');let calls=0;
  const source={descriptor:f.unit.descriptor,async capture(options){const found=await f.unit.capture(options);
    if(++calls===1)await writeFile(path.join(f.sourceRoot,'app.js'),'a concurrent source edit');return found;}};
  await assert.rejects(inspect(f,{sources:[source]}),{code:'ENGINE_SOURCE_CHANGED'});assert.equal(calls,2);
});

test('every selected repository is inspected against its own accepted baseline',async t=>{
  const f=await namespacePreparationFixture(t,{code:true});permit(f);
  const root=path.join(f.directory,'backend');await mkdir(root);await writeFile(path.join(root,'Service.java'),'class Service {}');
  const second=await createFilesystemSourceUnit({root,id:'backend-checkout',projectId:f.scope.projectId,repositoryId:'backend'});
  const sources=[f.unit,second];
  await createNamespaceSourceEngine({...options(f),sources}).run('source.bind',{operationId:'select-both-repositories',workId:f.inputs.workId,
    expectedRevision:(await f.head()).record.version,repositories:['backend','app'],reason:'Retain distinct frontend and backend baselines.'});
  await f.make({sources}).run('phase.prepare');
  await writeFile(path.join(root,'Service.java'),'class Service { public int answer() { return 42; } }');
  const result=await inspect(f,{sources});
  assert.deepEqual(result.manifest.repositories.map(repo=>[repo.id,repo.totals.changes]),[['app',0],['backend',1]]);
  assert.equal(result.manifest.repositories[1].entries[0].newPath,'Service.java');assert.equal(result.manifest.totals.changes,1);
  await assert.rejects(inspect(f,{sources:[f.unit]}),error=>error.code==='ENGINE_SOURCE_UNIT_UNAVAILABLE'&&error.details.repositoryId==='backend');
});

test('an unchanged-byte snapshot cannot impersonate the original source unit',async t=>{
  const f=await namespacePreparationFixture(t,{code:true});permit(f);await f.engine.run('phase.prepare');
  const source=await createFilesystemSourceUnit({root:f.sourceRoot,id:'another-unit',projectId:f.scope.projectId,repositoryId:'app'});
  await assert.rejects(inspect(f,{sources:[source]}),{code:'ENGINE_SOURCE_UNIT_UNAVAILABLE'});
});

test('permission revocation and independent private-draft changes remain final read failures',async t=>{
  const f=await namespacePreparationFixture(t,{code:true});permit(f);await f.engine.run('phase.prepare');
  let revoke=true;
  const source={descriptor:f.unit.descriptor,async capture(options){const found=await f.unit.capture(options);
    if(revoke)f.control.permissions=f.control.permissions.filter(value=>value!=='phase.source.inspect');return found;}};
  await assert.rejects(inspect(f,{sources:[source]}),{code:'ENGINE_AUTHORITY_REQUIRED'});revoke=false;permit(f);
  const draft=await f.read(f.engine),content=await f.upload('# Concurrently authored draft');let calls=0;
  const changed={descriptor:f.unit.descriptor,async capture(options){const found=await f.unit.capture(options);
    if(++calls===2)await f.engine.run('phase.draft.write',{operationId:'concurrent-source-read-edit',workId:f.inputs.workId,phaseId:'intake',
      expectedRevision:draft.manifest.draft.revision,content,reason:'An independent editor saved a new draft.'});return found;}};
  await assert.rejects(inspect(f,{sources:[changed]}),{code:'ENGINE_CONTEXT_CHANGED'});
  assert.equal((await f.read(f.engine)).manifest.artifact.content.text,'# Concurrently authored draft');
});

test('real source I/O failures, explicit timeout details and cancellation keep their original meanings',async t=>{
  const f=await namespacePreparationFixture(t,{code:true});permit(f);await f.engine.run('phase.prepare');
  const failure=new SingularityFlowError('The office source device did not respond before its deadline.',{
    code:'SGOS_SOURCE_TIMEOUT',details:{timeoutMs:300000,stage:'read-source'}});
  await assert.rejects(inspect(f,{sources:[{descriptor:f.unit.descriptor,capture(){throw failure;}}]}),error=>error===failure);
  await rm(f.sourceRoot,{recursive:true});await assert.rejects(inspect(f),error=>error.code==='ENOENT');
  const controller=new AbortController();controller.abort();
  await assert.rejects(createNamespaceSourceInspectionEngine(options(f)).run('phase.source.inspect',{}, {signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
});

test('snapshot comparison retains executable-only changes and reports a move as deletion plus addition',async t=>{
  const f=await namespacePreparationFixture(t,{code:true}),before=(await f.unit.capture()).snapshot;
  const after=structuredClone(before);after.entries[0].executable=!after.entries[0].executable;
  const mode=sourceSnapshotChanges(before,after,f.unit.descriptor);
  assert.equal(mode.totals.modified,1);assert.equal(mode.entries[0].before.sha256,mode.entries[0].after.sha256);
  after.entries[0].path='renamed.js';
  const moved=sourceSnapshotChanges(before,after,f.unit.descriptor);
  assert.deepEqual(moved.entries.map(entry=>entry.status),['D','A']);assert.equal(moved.renameDetection,'not-observed');
});

test('the SDK rejects inspection packets that invent readiness or contradict the selected binding',async t=>{
  const f=await namespacePreparationFixture(t,{code:true});permit(f);await f.engine.run('phase.prepare');
  const result=await inspect(f),base=structuredClone(result.manifest);
  for(const key of ['schemaVersion','contract','inference','sourceContentsRetained','publicationReadinessInspected','finalBindingChecked','testsRun','approvalRecorded','humanReviewRecorded'])delete base[key];
  for(const mutate of [value=>value.workId='other',value=>value.status='ready',value=>value.totals.changes++,value=>value.repositories[0].policy.tracking='tracked']){
    const forged=structuredClone(base);mutate(forged);
    assert.throws(()=>phaseSourceInspectionManifest(f.inputs.workId,'intake',forged,200),{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  const engine=createEngine({ports:{phaseSourceInspection:{load(){return {subject:{kind:'story',id:'another-story'},phase:'intake'};},inspect(){assert.fail('A changed binding cannot be inspected.');}}}});
  await assert.rejects(engine.run('phase.source.inspect',{workId:f.inputs.workId}),{code:'ENGINE_PORT_RESULT_INVALID'});
});
