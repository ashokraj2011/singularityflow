import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,readFile} from 'node:fs/promises';import path from 'node:path';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {converterSource} from './helpers/namespace-source-clause-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createOwnedExecutionUnit,createExecutionUnitManifest} from '../src/sgos/node-execution-unit.mjs';
import {createNodeExecutionOwner} from '../src/sgos/node-execution-owner.mjs';
import {sha256} from '../src/sgos/node-execution-values.mjs';
const reason='Review all configured checks and the exact bounded repair scope without accepting failed tests.';
async function fixture(t,{backend='sqlite',maximum=3,repair=null}={}){
  const broken=converterSource.replace('toUpperCase()','toLowerCase()'),f=await namespaceTestWitnessFixture(t,{backend,source:broken,
    configure(source){source.definition.testRecovery={enabled:true,maxDistinctAutomaticAttempts:maximum};},beforeSpecification:async f=>{
      f.control.permissions.push('test-recovery.context','test-recovery.confirm');
      const engine=createNamespaceEngine(f.common),{manifest}=await engine.run('test-recovery.context',{});
      await engine.run('test-recovery.confirm',{operationId:'confirm-initial-recovery',phaseId:'intake',expectedContext:manifest.expectedContext,reason});
    }});
  f.control.permissions.push('phase.repair.run','phase.delivery.inspect');let repairs=0;
  const manifest=createExecutionUnitManifest({id:'fixture-source-repair',version:'1.0.0',publisher:'test-fixture',provider:'deterministic-test-repair',models:[],
    capabilities:{readFiles:true,writeFiles:true,shell:false,subagents:false,worktrees:false},sandbox:{enforcement:'task-scope'},network:{mode:'deny'},
    toolPolicy:{profile:'sflow-namespace-test-repair-execution/v1',projectId:f.scope.projectId,phaseId:'build'},risk:{class:'low'},
    tests:{conformanceReceiptSha256:sha256('actual-scope-enforced-filesystem-repair')}}),
    unit=createOwnedExecutionUnit(manifest,async contract=>{repairs++;assert.deepEqual(contract.writeScope,['app:src/converter.js']);
      if(repair)await repair(f,contract);else await writeFile(path.join(f.roots[0],'src/converter.js'),converterSource);
      return {output:{path:'src/converter.js',attempt:repairs}};}),
    bindings={owner:createNodeExecutionOwner({hostId:'repair-fixture-host'}),bindings:[{phaseId:'build',unit}]},
    engine=createNamespaceEngine({...f.options,checks:f.checks,repairs:bindings}),input={operationId:'repair-observed-failure',workId:f.inputs.workId,phaseId:'build',failedOperationId:'witness-execution'};
  return {...f,engine,input,repairs:()=>repairs,bindings};
}
for(const backend of ['filesystem','sqlite','application'])test(backend+' a real bounded repair reruns the configured test and publishes with original failure retained',{timeout:120000},async t=>{
  const f=await fixture(t,{backend}),failure=await f.engine.run('phase.checks.run',{operationId:'witness-execution',workId:f.inputs.workId,phaseId:'build'});
  assert.equal(failure.verdict,'failed');const testsBefore=await readFile(path.join(f.roots[0],'test/converter.test.js'),'utf8');
  const result=await f.engine.run('phase.repair.run',f.input);assert.equal(result.manifest.verdict,'repaired');assert.equal(result.manifest.attempt,1);
  assert.equal(result.effects.testsRun,true);assert.equal(f.starts(),2);assert.equal(f.repairs(),1);
  assert.equal(await readFile(path.join(f.roots[0],'test/converter.test.js'),'utf8'),testsBefore);
  const repeated=await f.engine.run('phase.repair.run',f.input);assert.equal(repeated.manifest.replayed,true);assert.equal(f.repairs(),1);assert.equal(f.starts(),2);
  assert.equal((await f.engine.run('phase.checks.run',{operationId:'witness-execution',workId:f.inputs.workId,phaseId:'build'})).verdict,'failed');
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});await f.approve('build');
  const replay=createNamespaceEngine({...f.common,checks:f.checks,repairs:f.bindings});
  assert.equal((await replay.run('phase.repair.run',f.input)).manifest.verdict,'repaired');assert.equal(f.repairs(),1);
});
test('the automatic budget counts real unsuccessful executions and offers human recovery instead of an endless retry',{timeout:120000},async t=>{
  const f=await fixture(t,{maximum:1,repair:async()=>{}}),first=await f.engine.run('phase.repair.run',f.input);
  assert.equal(first.manifest.verdict,'repair-required');assert.equal(f.starts(),2);
  await assert.rejects(f.engine.run('phase.repair.run',{...f.input,operationId:'cannot-reset-by-new-id'}),error=>
    error.code==='TEST_RECOVERY_BUDGET_EXHAUSTED'&&error.details.limit===1&&error.details.actions.some(row=>row.operation==='test-command.context'));
  assert.equal(f.repairs(),1);assert.equal(f.starts(),2);
});
test('a scope violation retains the actual effects and never runs or publishes a claimed successful repair',{timeout:120000},async t=>{
  const f=await fixture(t,{repair:async f=>{await writeFile(path.join(f.roots[0],'test/converter.test.js'),'// Removed assertions.\n');}}),
    result=await f.engine.run('phase.repair.run',f.input);
  assert.equal(result.manifest.verdict,'scope-review-required');assert.equal(result.manifest.scopeViolation.code,'TEST_RECOVERY_SCOPE_CHANGED');
  assert.equal(result.effects.testsRun,false);assert.equal(f.starts(),1);assert.equal(f.repairs(),1);
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'}),
    error=>['PHASE_CHECKS_NOT_PASSED','ENGINE_SOURCE_CHANGED'].includes(error.code));
});
for(const stage of ['reservation','completion'])test('lost '+stage+' acknowledgement preserves the real timeout and never duplicates repair execution',{timeout:120000},async t=>{
  const f=await fixture(t),failure=Object.freeze(Object.assign(Error('The real '+stage+' reply deadline elapsed.'),{code:'ETIMEDOUT',details:{deadlineMs:319,stage}}));let lost=false;
  const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
    if(!lost&&tx.operationId.startsWith(stage==='reservation'?'repair-reserve-':'repair-complete-')){lost=true;throw failure;}return result;}},
    engine=createNamespaceEngine({...f.options,records,checks:f.checks,repairs:f.bindings});
  await assert.rejects(engine.run('phase.repair.run',f.input),error=>error===failure);assert.equal(lost,true);
  assert.equal(f.repairs(),stage==='reservation'?0:1);
  const resumed=await engine.run('phase.repair.run',f.input);assert.equal(resumed.manifest.verdict,'repaired');assert.equal(f.repairs(),1);assert.equal(f.starts(),2);
  assert.equal((await engine.run('phase.repair.run',f.input)).manifest.replayed,true);
});
test('a host execution failure remains a failed attempt with its original code and deadline details',{timeout:120000},async t=>{
  const f=await fixture(t,{repair:async()=>{throw Object.assign(Error('The repair tool could not read its selected input.'),{code:'EACCES',details:{path:'selected-input',deadlineMs:317}});}}),
    result=await f.engine.run('phase.repair.run',f.input);
  assert.equal(result.manifest.verdict,'repair-required');assert.equal(result.manifest.failure.code,'EACCES');
  assert.deepEqual(result.manifest.failure.details,{path:'selected-input',deadlineMs:317});assert.equal(result.effects.testsRun,false);assert.equal(f.starts(),1);
});
test('a second automatic attempt consumes its original failed retry instead of losing the first reservation',{timeout:120000},async t=>{
  let attempt=0;const f=await fixture(t,{repair:async f=>{
    await writeFile(path.join(f.roots[0],'src/converter.js'),++attempt===1?converterSource.replace('toUpperCase()','toLowerCase()'):converterSource);
  }}),first=await f.engine.run('phase.repair.run',f.input);
  assert.equal(first.manifest.verdict,'repair-required');assert.ok(first.manifest.checks);
  const secondInput={...f.input,operationId:'second-actual-failure-repair',failedOperationId:first.manifest.checks.operationId},
    second=await f.engine.run('phase.repair.run',secondInput);
  assert.equal(second.manifest.attempt,2);assert.equal(second.manifest.verdict,'repaired');assert.equal(f.repairs(),2);assert.equal(f.starts(),3);
  assert.equal((await f.engine.run('phase.repair.run',f.input)).manifest.verdict,'repair-required');assert.equal(f.starts(),3);
});
