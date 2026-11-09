import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {setTimeout as pause} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {namespacePreparationFixture} from './helpers/namespace-preparation-fixture.mjs';
import {createNamespacePhaseChecksEngine,createNamespacePhaseCheckReader} from '../src/engine-storage/namespace-phase-checks.mjs';
import {createNamespaceSourceEngine} from '../src/engine-storage/namespace-source.mjs';
import {createFilesystemSourceUnit} from '../src/sgos/filesystem-source-unit.mjs';
import {createNodeCheckExecutionUnit} from '../src/sgos/node-check-execution-unit.mjs';
import {createNodeExecutionOwner} from '../src/sgos/node-execution-owner.mjs';
import {createNamespaceLifecycleObserver} from '../src/engine-storage/namespace-lifecycle-reader.mjs';
const executableSha256='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex');
const command={id:'node-tests',argv:['node','--test','--test-reporter=tap','case.test.mjs'],kind:'test',modelPolicy:'never',
  result:{adapter:'node-tap',path:'results/tests.tap'}};
const input={operationId:'check-one',workId:'portable-story',phaseId:'intake'};
async function fixture(t,{backend='filesystem',failing=false,modify=()=>{}}={}) {
  const f=await namespacePreparationFixture(t,{backend,configure:source=>{source.definition.phases.intake.qualityCommands=[command];}});
  const root=path.join(f.directory,'checkout');await mkdir(root);
  await writeFile(path.join(root,'case.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';test('actual pinned check',()=>assert.equal(2+2,"+(failing?'5':'4')+"));");
  const source=await createFilesystemSourceUnit({root,id:'app-checkout',projectId:f.scope.projectId,repositoryId:'app'});
  const options={records:f.records,content:f.content,localRecords:f.localRecords,localContent:f.localContent,scope:f.scope,
    workId:f.inputs.workId,authority:f.authority,access:f.access,clock:f.clock,sources:[source]};
  await createNamespaceSourceEngine(options).run('source.bind',{operationId:'source-for-checks',workId:f.inputs.workId,
    expectedRevision:f.story.revision,repositories:['app'],reason:'Select the real repository for phase checks.'});
  const control={starts:0};
  const raw=await createNodeCheckExecutionUnit({id:'node-phase-check',root,projectId:f.scope.projectId,repositoryId:'app',content:f.content,
    command:{executable:process.execPath,executableSha256,arguments:command.argv.slice(1),environment:{}},
    report:{adapter:'node-tap',files:[]},authorizeCommand:manifest=>manifest.manifestSha256});
  const unit={...raw,start(task){control.starts++;return raw.start(task);}};
  const owner=createNodeExecutionOwner({hostId:'phase-check-host'}),checks={owner,bindings:[{phaseId:'intake',commandId:command.id,repositoryId:'app',
    executable:'node',executableSha256,environment:{},unit}]};
  modify({checks,options,control});f.control.permissions.push('phase.checks.run');
  const make=extra=>createNamespacePhaseChecksEngine({...options,checks,...extra}),engine=make();
  await engine.run('phase.prepare');const draft=await engine.run('phase.draft.read',{phaseId:'intake'});
  const reference=await f.upload('# Checked artifact\n\nThe authored phase artifact has meaningful observed content.');
  await engine.run('phase.draft.write',{operationId:'author-for-checks',workId:f.inputs.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
    content:reference,reason:'Complete the actual phase artifact before executing its pinned checks.'});
  const boundInput={...input,workId:f.inputs.workId};
  const state=()=>createNamespaceLifecycleObserver(options).capture();
  return {...f,accessControl:f.control,root,source,control,options,checks,make,engine,input:boundInput,state};
}
for(const backend of ['filesystem','sqlite','application'])test(backend+': registered checks run the real pinned command and record evidence without advancing the phase',async t=>{
  const f=await fixture(t,{backend}),before=await f.state(),draft=await f.engine.run('phase.draft.read',{phaseId:'intake'});
  const result=await f.engine.run('phase.checks.run',f.input);
  assert.equal(result.status,'recorded');assert.equal(result.verdict,'passed');assert.equal(result.generation,1);assert.equal(result.checks[0].tests.passed,1);
  assert.deepEqual((await f.state()).snapshot,before.snapshot);assert.equal(f.control.starts,1);
  assert.equal(result.effects.phasePublished,false);assert.equal(result.effects.approvalRecorded,false);assert.equal(result.effects.storyAdvanced,false);
  assert.deepEqual(await f.engine.run('phase.draft.read',{phaseId:'intake'}),draft);
  const again=await f.make().run('phase.checks.run',f.input);assert.equal(again.status,'retained');assert.equal(again.record.version,result.record.version);assert.equal(f.control.starts,1);
});
test('an actual failing test is retained as failed evidence without a false passing verdict',async t=>{
  const f=await fixture(t,{failing:true}),result=await f.engine.run('phase.checks.run',f.input);
  assert.equal(result.verdict,'failed');assert.equal(result.checks[0].status,'failed');assert.equal(result.checks[0].tests.failed,1);assert.equal(f.control.starts,1);
});
test('accepted check results reopen without the original private draft or executor',async t=>{
  const f=await fixture(t),first=await f.engine.run('phase.checks.run',f.input);
  const later=createNamespacePhaseChecksEngine({...f.options,localRecords:null,localContent:null,checks:{}});
  const retained=await later.run('phase.checks.run',f.input);assert.equal(retained.status,'retained');assert.deepEqual(retained.record,first.record);assert.equal(f.control.starts,1);
});
test('missing current execution permission cannot launch a check',async t=>{
  const f=await fixture(t);f.accessControl.permissions=f.accessControl.permissions.filter(value=>value!=='phase.checks.run');
  await assert.rejects(f.engine.run('phase.checks.run',f.input),{code:'ENGINE_AUTHORITY_REQUIRED'});assert.equal(f.control.starts,0);
});
test('the operation accepts only phase selection, never replacement argv or a caller result',async t=>{
  const f=await fixture(t);
  for(const extra of [{argv:['node','evil']},{ready:true},{result:{status:'passed'}}])await assert.rejects(f.engine.run('phase.checks.run',{...f.input,...extra}),{code:'ENGINE_INPUT_INVALID'});
  assert.equal(f.control.starts,0);
});
test('the exact registered executable and argv binding is required before an attempt is claimed',async t=>{
  const f=await fixture(t,{modify:({checks})=>{checks.bindings[0].executable='other';}});
  await assert.rejects(f.engine.run('phase.checks.run',f.input),{code:'ENGINE_CHECK_BINDING_CHANGED'});assert.equal(f.control.starts,0);
});
for(const stage of ['check-prepare-','check-record-'])test('a lost '+stage+' acknowledgement resumes the same operation without a duplicate process',async t=>{
  const f=await fixture(t);let interrupted=false;
  const original=Object.assign(new Error('The actual accepted check acknowledgement was lost.'),{code:'SDA_NAMESPACE_OUTCOME_UNKNOWN'});
  const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
    if(!interrupted&&tx.operationId.startsWith(stage)){interrupted=true;throw original;}return result;}};
  const engine=f.make({records});await assert.rejects(engine.run('phase.checks.run',f.input),cause=>cause===original);
  assert.equal(f.control.starts,stage==='check-prepare-'?0:1);
  const result=await engine.run('phase.checks.run',f.input);assert.equal(result.verdict,'passed');assert.equal(f.control.starts,1);
});
test('an acceptance-storage outage retains actual execution and resumes without running the tests again',async t=>{
  const f=await fixture(t);let failed=false;const original=Object.assign(new Error('Check acceptance storage unavailable.'),{code:'EACCES'});
  const records={...f.records,transact(scope,tx,options){if(!failed&&tx.operationId.startsWith('check-record-')){failed=true;throw original;}return f.records.transact(scope,tx,options);}};
  const engine=f.make({records});await assert.rejects(engine.run('phase.checks.run',f.input),cause=>cause===original);assert.equal(f.control.starts,1);
  assert.equal((await engine.run('phase.checks.run',f.input)).verdict,'passed');assert.equal(f.control.starts,1);
});
test('concurrent requests claim at most one real check execution',async t=>{
  const f=await fixture(t),results=await Promise.allSettled([f.engine.run('phase.checks.run',f.input),f.engine.run('phase.checks.run',f.input)]);
  assert.ok(results.some(result=>result.status==='fulfilled'));assert.equal(f.control.starts,1);
  assert.equal((await f.engine.run('phase.checks.run',f.input)).status,'retained');assert.equal(f.control.starts,1);
});
test('permission repair in the same phase can accept a retained run without repeating it',async t=>{
  let accessControl;const f=await fixture(t,{modify:({checks})=>{const collect=checks.bindings[0].unit.collect;
    checks.bindings[0].unit={...checks.bindings[0].unit,async collect(...args){const candidate=await collect(...args);
      accessControl.permissions=accessControl.permissions.filter(value=>value!=='phase.checks.run');return candidate;}};}});
  accessControl=f.accessControl;await assert.rejects(f.engine.run('phase.checks.run',f.input),{code:'ENGINE_AUTHORITY_REQUIRED'});assert.equal(f.control.starts,1);
  accessControl.permissions.push('phase.checks.run');assert.equal((await f.engine.run('phase.checks.run',f.input)).verdict,'passed');assert.equal(f.control.starts,1);
});
test('source drift after a command cannot become accepted evidence for the earlier snapshot',async t=>{
  let root,changed=false;const f=await fixture(t,{modify:({checks})=>{const collect=checks.bindings[0].unit.collect;
    checks.bindings[0].unit={...checks.bindings[0].unit,async collect(...args){const candidate=await collect(...args);
      if(!changed){changed=true;await writeFile(path.join(root,'new-source.js'),'export const changed = true;');}return candidate;}};}});root=f.root;
  await assert.rejects(f.engine.run('phase.checks.run',f.input),{code:'ENGINE_SOURCE_CHANGED'});assert.equal(f.control.starts,1);
  await assert.rejects(f.engine.run('phase.checks.run',f.input),{code:'ENGINE_SOURCE_CHANGED'});assert.equal(f.control.starts,1);
  assert.equal((await f.engine.run('phase.checks.run',{...f.input,operationId:'after-reviewed-source-change'})).verdict,'passed');assert.equal(f.control.starts,2);
});
test('retained acknowledgement authenticates the original person without requiring the old phase agent or write permission',async t=>{
  const f=await fixture(t);await f.engine.run('phase.checks.run',f.input);f.accessControl.agentId='another-phase-agent';f.accessControl.permissions=[];
  assert.equal((await f.engine.run('phase.checks.run',f.input)).status,'retained');assert.equal(f.control.starts,1);
  f.accessControl.principalId='another-person';await assert.rejects(f.engine.run('phase.checks.run',f.input),{code:'ENGINE_ACTOR_CHANGED'});assert.equal(f.control.starts,1);
});
test('missing or corrupt retained report bytes remain explicit errors and cannot trigger a replacement run',async t=>{
  const f=await fixture(t);await f.engine.run('phase.checks.run',f.input);
  const reader=createNamespacePhaseCheckReader(f.options),accepted=await reader.accepted(f.input),reference=accepted.body.results[0].candidate.output.reports.raw[0].content;
  for(const missing of [true,false]){const content={...f.content,async read(scope,ref,options){const result=await f.content.read(scope,ref,options);
    if(ref.sha256!==reference.sha256)return result;
    return missing?{status:'missing',reference:ref,data:null}:{...result,data:Buffer.alloc(result.data.byteLength,33)};}};
    const engine=f.make({content});await assert.rejects(engine.run('phase.checks.run',f.input),{code:missing?'ENGINE_STORAGE_CONTENT_MISSING':'ENGINE_STORAGE_CORRUPT'});}
  assert.equal(f.control.starts,1);
});
test('cancellation during an ownership claim cannot launch a late test process',async t=>{
  const controller=new AbortController();
  const f=await fixture(t,{modify:({checks})=>{const original=checks.owner;checks.owner={...original,async acquire(){const token=await original.acquire();controller.abort();return token;}};}});
  await writeFile(path.join(f.root,'case.test.mjs'),"import {writeFileSync} from 'node:fs';writeFileSync('launched','unexpected');");
  await assert.rejects(f.engine.run('phase.checks.run',f.input,{signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
  await assert.rejects(access(path.join(f.root,'launched')),{code:'ENOENT'});
  assert.equal(await createNamespacePhaseCheckReader(f.options).accepted(f.input),null);
});
test('cancelling an active registered check waits for the actual test process to terminate',async t=>{
  const f=await fixture(t),controller=new AbortController();t.after(()=>controller.abort());
  await writeFile(path.join(f.root,'case.test.mjs'),"import test from 'node:test';import {writeFileSync} from 'node:fs';test('bounded running fixture',async()=>{writeFileSync('test.pid',String(process.pid));setInterval(()=>{},1000);await new Promise(()=>{});});");
  const running=f.engine.run('phase.checks.run',f.input,{signal:controller.signal});running.catch(()=>{});
  let pid;const deadline=Date.now()+10_000;
  while(!pid&&Date.now()<deadline){try{pid=Number(await readFile(path.join(f.root,'test.pid'),'utf8'));}catch(cause){if(cause.code!=='ENOENT')throw cause;await pause(10);}}
  assert.ok(pid);controller.abort();await assert.rejects(running,{code:'ENGINE_OPERATION_CANCELLED'});
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  assert.equal(await createNamespacePhaseCheckReader(f.options).accepted(f.input),null);
});
