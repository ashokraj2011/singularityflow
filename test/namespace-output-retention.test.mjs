import test from 'node:test';import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';import path from 'node:path';
import {namespaceSourceRetentionFixture} from './helpers/namespace-source-retention-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespaceOutputRetentionReader} from '../src/engine-storage/namespace-output-retention-reader.mjs';
const bytes=Buffer.from([137,80,78,71,13,10,26,10,0,1,2,3]); // Isolated bytes; never a claim of an application visual pass.
async function fixture(t,backend){const f=await namespaceSourceRetentionFixture(t,{backend});f.control.permissions.push('phase.output.retain');
  const {localRecords,localContent,...common}=f.options,options={...common,working:{records:localRecords,content:localContent},localContent},
    make=extra=>createNamespaceEngine({...options,...extra});await f.engine.run('phase.source.retain',f.input);
  return {...f,make,options,output:async(operationId='retain-current-output',name='proof.png')=>({operationId,workId:f.inputs.workId,phaseId:f.input.phaseId,
    path:'singularity/work-items/'+f.inputs.workId+'/evidence/'+name,content:(await localContent.put(f.scope,'local',bytes)).reference})};}
for(const backend of ['filesystem','sqlite','application'])test(backend+': output acceptance preserves lifecycle and retained source, and replays without the original device',{timeout:120000},async t=>{
  const f=await fixture(t,backend),engine=f.make(),input=await f.output(),head=await f.head(),result=await engine.run('phase.output.retain',input);
  assert.equal(result.status,'retained');assert.equal(result.generation,1);assert.deepEqual(result.content,{...input.content,namespace:'evidence'});
  assert.deepEqual(result.effects,{lifecycleChanged:false,sourceFilesChanged:false,testsRun:false,approvalRecorded:false});assert.deepEqual(await f.head(),head);
  const reader=createNamespaceOutputRetentionReader(f.options),accepted=await reader.accepted(input),identity={phaseId:input.phaseId,generation:1,
    configuration:accepted.plan.basis.configuration,source:accepted.source},selected=await reader.selection(identity);
  assert.equal(selected.files[0].path,input.path);assert.deepEqual(selected.files[0].content,result.content);
  const second=await f.output('retain-second-output','detail.png');await engine.run('phase.output.retain',second);
  assert.equal((await reader.selection(identity)).files.length,2);assert.deepEqual(await reader.selection(identity,{binding:selected}),selected);
  await assert.rejects(engine.run('phase.output.retain',{...input,operationId:'case-variant-output',path:input.path.replace('proof.png','PROOF.png')}),error=>
    error.code==='ENGINE_OUTPUT_PATH_CONFLICT'&&error.details.existingPath===input.path&&error.details.actions[0].operation==='phase.output.retain');
  assert.equal((await reader.selection(identity)).files.length,2);assert.deepEqual(await f.head(),head);
  const takeover=f.make({working:null,localContent:null,sources:[],sourceReaders:[],clock:{now(){throw Error('Replay cannot replace the original output time.');}}}),
    replay=await takeover.run('phase.output.retain',input);
  assert.equal(replay.replayed,true);assert.equal(replay.recordedAt,result.recordedAt);assert.deepEqual(replay.record,result.record);assert.deepEqual(await f.head(),head);
  await assert.rejects(takeover.run('phase.output.retain',{...input,path:input.path.replace('proof.png','forged.png')}),{code:'ENGINE_OPERATION_ID_REUSED'});
});
test('actual output content errors, source changes and lost acknowledgement keep their exact recovery and never record acceptance',{timeout:120000},async t=>{
  const f=await fixture(t,'filesystem'),input=await f.output(),denied=Object.freeze(Object.assign(Error('Actual device output permission failure.'),{code:'EACCES',path:'local-output'})),
    bad=f.make({localContent:{...f.options.localContent,read(){throw denied;}}}),head=await f.head();
  await assert.rejects(bad.run('phase.output.retain',input),error=>error===denied);assert.deepEqual(await f.head(),head);
  const timeout=Object.freeze(Object.assign(Error('Actual accepted output acknowledgement timed out.'),{code:'ETIMEDOUT',details:{deadlineMs:9137}}));let failed=false;
  const interrupted=f.make({records:{...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
    if(!failed&&tx.operationId.startsWith('output-retain-')){failed=true;throw timeout;}return result;}}});
  await assert.rejects(interrupted.run('phase.output.retain',input),error=>error===timeout);
  const result=await f.make({clock:{now(){throw Error('Resume accepted output, never recapture or restamp.');}}}).run('phase.output.retain',input);assert.equal(result.replayed,true);
  await writeFile(path.join(f.sourceRoot,'app.js'),'export const answer = 999;');
  await assert.rejects(f.make().run('phase.output.retain',await f.output('after-source-change')),{code:'ENGINE_OUTPUT_SOURCE_CHANGED'});assert.deepEqual(await f.head(),head);
});
