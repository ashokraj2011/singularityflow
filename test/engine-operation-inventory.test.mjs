import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {engineOperationInventory} from '../scripts/engine-operation-inventory.mjs';
import {ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
test('every default native registry operation names a real compatibility qualifier without opening infrastructure',async()=>{
  const report=engineOperationInventory();assert.equal(report.profile,'sflow-engine-operation-inventory/v1');
  assert.deepEqual(report.operations.map(row=>row.id),ENGINE_OPERATIONS.map(row=>row.id));
  assert.equal(report.totals.registered,88);assert.equal(report.totals.native,42);assert.equal(report.totals.namespace,78);
  for(const row of report.operations){assert.equal(row.nativeBound,row.nativeQualification.length>0);
    for(const name of row.nativeQualification)assert.ok((await readFile(new URL('../'+name,import.meta.url),'utf8')).includes('test('),name);}
  assert.equal(report.qualificationExecuted,false);assert.equal(report.authorityGranted,false);assert.equal(report.readinessEstablished,false);
  assert.equal(report.operations.find(row=>row.id==='phase.checks.run').optionalCapability,'explicit-check-execution');
  assert.equal(report.operations.find(row=>row.id==='plan.correct').namespaceBound,false,'the native terminal ceremony is not a portable success flag');
});
test('operation audit results are detached and do not change the actual public vocabulary',()=>{
  const first=engineOperationInventory();first.operations[0].inputFields.push('invented');first.operations[0].nativeQualification.length=0;
  assert.equal(engineOperationInventory().operations[0].inputFields.includes('invented'),false);
  assert.ok(engineOperationInventory().operations[0].nativeQualification.length);
});
