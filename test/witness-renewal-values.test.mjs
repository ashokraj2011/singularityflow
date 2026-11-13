import test from 'node:test';import assert from 'node:assert/strict';import {readFile}from'node:fs/promises';
import * as native from '../src/witness-exception-renewals.mjs';
import {witnessExceptionRenewalPolicies,witnessRenewalExpiryValue}from'../packages/engine-sdk/src/evidence.mjs';
import {witnessRenewalValueCases}from'./helpers/witness-renewal-values-fixture.mjs';
test('shared renewal values preserve 30 original approval-selection, renewal, expiry and error outcomes',async()=>{
  const capture=JSON.parse(await readFile(new URL('./fixtures/witness-renewal-values/native-v1.json',import.meta.url),'utf8'));
  assert.equal(capture.capturedFrom,'68d584dbf');assert.equal(capture.cases.length,30);
  const query=(workflow,phaseId,generation,mapping)=>witnessRenewalExpiryValue(workflow.witnessExceptionRenewals,phaseId,generation,mapping),
    shared={...witnessExceptionRenewalPolicies({renewedWitnessExpiry:query}),renewedWitnessExpiry:query};
  for(const api of [native,shared]){const cases=witnessRenewalValueCases(api);assert.equal(cases.length,capture.cases.length);
    for(const [index,row]of cases.entries())assert.deepEqual(row,capture.cases[index],row.name);}
});
test('the prior expiry is an explicit captured value capability, not a clock, authorization or command renderer',()=>{
  assert.throws(()=>witnessExceptionRenewalPolicies(),{code:'ENGINE_INPUT_INVALID'});
  const input={renewedWitnessExpiry:()=>null},values=witnessExceptionRenewalPolicies(input);input.renewedWitnessExpiry=()=>{throw Error('A caller cannot replace the captured value callback.');};
  assert.equal(values.witnessException({phases:{}},'missing','sha256:'+'a'.repeat(64)),null);assert.ok(Object.isFrozen(values));
  assert.equal(values.approve,undefined);assert.equal(values.witnessExceptionRenewalCommand,undefined);
});
