import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import * as native from '../src/test-narrowing.mjs';import {testNarrowingPolicies} from '../src/kernel/test-recovery.mjs';
import {NODE_TEXT_DIGESTS} from '../src/records.mjs';import {testNarrowingValueCases,observeTestNarrowingValue,admittedTestNarrowingValues} from './helpers/test-narrowing-values-fixture.mjs';
const capture=JSON.parse(await readFile(new URL('./fixtures/test-narrowing-values/native-v1.json',import.meta.url),'utf8')),
  values=testNarrowingPolicies(NODE_TEXT_DIGESTS),portable=admittedTestNarrowingValues(values);
test('test narrowing values and the native adapter reproduce all independent original outcomes',()=>{
  assert.equal(capture.baseline,'8252c93b7');assert.equal(capture.sha256,'f25537f7a50dc8f4b61368d63211590bb56183830c1886d5cefad54452b36a90');
  const rows=testNarrowingValueCases();assert.equal(rows.length,88);assert.equal(capture.cases.length,rows.length);
  for(const [index,row]of rows.entries())for(const api of [native,portable]){
    assert.equal(row.name,capture.cases[index].name);assert.deepEqual(observeTestNarrowingValue(api,row),capture.cases[index].observation,row.name);}
});
test('portable narrowing rules need explicit admitted observations and time without granting approval or executing a check',()=>{
  assert.ok(Object.isFrozen(values));assert.equal(values.approve,undefined);assert.equal(values.execute,undefined);
  assert.throws(()=>values.testNarrowingState([],{id:'TNR-001'}),{code:'ENGINE_INPUT_INVALID'});
  assert.throws(()=>values.recordTestNarrowingRevocation({testNarrowings:[]},{narrowingId:'TNR-001'}),{code:'ENGINE_INPUT_INVALID'});
});
test('native narrowing state reads the host clock only for a live expiring decision without an explicit time',()=>{
  const original=Date.now;let reads=0;
  Date.now=()=>{reads++;return Date.parse('2026-11-13T12:00:00.000Z');};
  try{
    const decision={id:'TNR-001',expiresAt:'2026-11-14T00:00:00.000Z'};
    assert.equal(native.testNarrowingState({testNarrowings:[]},decision),'active');assert.equal(reads,1);
    assert.equal(native.testNarrowingState({testNarrowings:[]},decision,{at:'2026-11-15T00:00:00.000Z'}),'expired');assert.equal(reads,1);
    assert.equal(native.testNarrowingState({testNarrowings:[]},{id:'TNR-001',expiresAt:null}),'active');assert.equal(reads,1);
    assert.equal(native.testNarrowingState({testNarrowings:[{revokes:'TNR-001'}]},decision),'revoked');assert.equal(reads,1);
  }finally{Date.now=original;}
});
