import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {namespaceDeliveryInspectionFixture} from './helpers/namespace-delivery-inspection-fixture.mjs';
import {namespacePreparationFixture} from './helpers/namespace-preparation-fixture.mjs';
import {createNamespaceDeliveryInspectionEngine} from '../src/engine-storage/namespace-delivery-inspection.mjs';
import {createEngine} from '../src/engine-sdk/index.mjs';
for(const backend of ['filesystem','sqlite','application'])test(`${backend}: read actual original/current files and executed checks without publishing or running another test`,async t=>{
  const f=await namespaceDeliveryInspectionFixture(t,{backend});await f.retain();const run=await f.run();assert.equal(run.verdict,'passed');
  const before=await f.head(),starts=f.control.starts,clocks=f.accessControl.clockCalls;
  const result=await f.inspect(),m=result.manifest;
  assert.equal(result.operation,'phase.delivery.inspect');assert.equal(m.status,'observed');assert.equal(m.tests.status,'passed');
  assert.equal(m.evidence.baseline.operationId,'delivery-original');assert.equal(m.evidence.changes.operationId,'delivery-changes');assert.equal(m.evidence.checks.operationId,f.input.operationId);
  assert.equal(m.repositories[0].sourceMatched,true);assert.equal(m.repositories[0].checksMatched,true);assert.equal(m.repositories[0].coverage.uncoveredPaths,0);
  assert.equal(m.repositories[0].coverage.changedExecutableTests,1);assert.ok(m.repositories[0].coverage.paths.some(row=>row.path==='app.mjs'&&row.covered===true));
  assert.equal(m.observationsOnly,true);assert.equal(m.publicationReadinessInspected,false);assert.equal(m.applicationAcceptanceEstablished,false);
  assert.equal(m.requiredPolicyOwners.includes('code-delivery'),true);assert.deepEqual(m.actions,[]);
  assert.equal(f.control.starts,starts);assert.equal(f.accessControl.clockCalls,clocks);assert.deepEqual(await f.head(),before);
  f.accessControl.permissions.push('phase.publish');
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'}),error=>error.code==='ENGINE_PORT_UNAVAILABLE'&&error.details.required.includes('code-delivery'));
});
test('missing retained evidence gets exact registry actions instead of a readiness or approval claim',async t=>{
  const f=await namespaceDeliveryInspectionFixture(t,{retainBaseline:false}),result=await f.inspect(),m=result.manifest;
  assert.equal(m.evidence.baseline,null);assert.equal(m.evidence.changes,null);assert.equal(m.tests.status,'missing');
  assert.deepEqual(m.actions.map(row=>row.operation),['source.baseline.retain','phase.source.retain','phase.checks.run']);
  assert.deepEqual(m.actions[0].inputs,{workId:f.inputs.workId,sourceBindingId:'source-for-checks'});
  assert.deepEqual(m.actions[0].prerequisites,['original-source-selection-available']);assert.equal(m.actions.every(row=>row.required.includes('operationId')),true);
});
test('a passed Node command cannot establish affected Python coverage',async t=>{
  const f=await namespaceDeliveryInspectionFixture(t);await writeFile(path.join(f.root,'script.py'),'answer = 42\n');await f.retain();await f.run();
  const m=(await f.inspect()).manifest;assert.equal(m.tests.status,'passed');assert.equal(m.repositories[0].coverage.uncoveredPaths,1);
  assert.ok(m.repositories[0].coverage.paths.some(row=>row.path==='script.py'&&row.covered===false));assert.equal(m.applicationAcceptanceEstablished,false);
});
test('a failed check is reported as observed evidence with an explicit repair prerequisite',async t=>{
  const f=await namespaceDeliveryInspectionFixture(t,{failing:true});await f.retain();assert.equal((await f.run()).verdict,'failed');
  const m=(await f.inspect()).manifest;assert.equal(m.tests.status,'failed');assert.equal(m.tests.checks[0].tests.failed,1);
  const next=m.actions.find(row=>row.operation==='phase.checks.run');assert.deepEqual(next.prerequisites,['repair-observed-check-failures']);
});
test('source drift invalidates the current evidence match without discarding the accepted receipts',async t=>{
  const f=await namespaceDeliveryInspectionFixture(t);await f.retain();await f.run();await writeFile(path.join(f.root,'app.mjs'),'export const answer = 43;\n');
  const m=(await f.inspect()).manifest;assert.equal(m.repositories[0].sourceMatched,false);assert.equal(m.repositories[0].checksMatched,false);
  assert.deepEqual(m.actions.map(row=>row.operation),['phase.source.retain','phase.checks.run']);assert.equal(m.tests.status,'passed','historical test execution is not rewritten');
});
test('bounded previews expose complete counts, read-only readers never become authors, and forged readiness packets are refused',async t=>{
  const f=await namespaceDeliveryInspectionFixture(t);await f.retain();await f.run();f.accessControl.agentId='independent-reader';f.accessControl.permissions=['phase.source.inspect'];
  const result=await f.reader.run('phase.delivery.inspect',{phaseId:'intake',maximumEntries:0}),m=result.manifest;
  assert.equal(m.repositories[0].coverage.paths.length,0);assert.equal(m.repositories[0].coverage.truncated,true);assert.ok(m.repositories[0].coverage.pathCount>0);
  await assert.rejects(f.reader.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'}),{code:'ENGINE_PORT_UNAVAILABLE'});
  const forged=createEngine({ports:{phaseDeliveryInspection:{load:()=>({subject:{kind:'story',id:f.inputs.workId},phase:'intake'}),inspect:()=>({...m,ready:true})}}});
  await assert.rejects(forged.run('phase.delivery.inspect',{workId:f.inputs.workId,phaseId:'intake'}),{code:'ENGINE_PORT_RESULT_INVALID'});
});
test('an unprepared or non-code phase has a precise observation state and cannot create source or test evidence',async t=>{
  const f=await namespacePreparationFixture(t),options={records:f.records,content:f.content,localRecords:f.localRecords,localContent:f.localContent,
    scope:f.scope,workId:f.inputs.workId,authority:f.authority,access:f.access,clock:f.clock};f.control.permissions.push('phase.source.inspect');
  const reader=createNamespaceDeliveryInspectionEngine(options),m=(await reader.run('phase.delivery.inspect')).manifest;
  assert.equal(m.status,'missing-draft');assert.equal(m.actions[0].operation,'phase.prepare');await f.engine.run('phase.prepare');
  assert.equal((await reader.run('phase.delivery.inspect')).manifest.status,'not-code-generation');
});
test('real missing-file, permission and timeout failures remain their original errors',async t=>{
  const f=await namespaceDeliveryInspectionFixture(t),head=await f.head();
  for(const code of ['ENOENT','EACCES','SGOS_SOURCE_TIMEOUT']){
    const original=Object.assign(new Error('actual selected-source read failed'),{code,details:{stage:'read',path:'app.mjs'},...(code==='SGOS_SOURCE_TIMEOUT'?{timedOut:true,timeoutMs:500}: {})});
    const reader=f.make({sources:[{descriptor:f.source.descriptor,capture(){throw original;}}]});
    await assert.rejects(reader.run('phase.delivery.inspect'),error=>error===original);
  }
  assert.deepEqual(await f.head(),head);assert.equal(f.control.starts,0);
});
test('final source freshness and access checks refuse drift and permission revocation',async t=>{
  const f=await namespaceDeliveryInspectionFixture(t);let calls=0;
  const changed={descriptor:f.source.descriptor,async capture(options){const value=await f.source.capture(options);
    if(++calls===1)await writeFile(path.join(f.root,'app.mjs'),'export const answer = 44;\n');return value;}};
  await assert.rejects(f.make({sources:[changed]}).run('phase.delivery.inspect'),{code:'ENGINE_SOURCE_CHANGED'});assert.equal(calls,2);
  const revoked={descriptor:f.source.descriptor,async capture(options){const value=await f.source.capture(options);
    f.accessControl.permissions=f.accessControl.permissions.filter(value=>value!=='phase.source.inspect');return value;}};
  await assert.rejects(f.make({sources:[revoked]}).run('phase.delivery.inspect'),{code:'ENGINE_AUTHORITY_REQUIRED'});
});
