import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import * as native from '../src/test-run-risk.mjs';
import {testRunCausePolicies} from '../packages/engine-sdk/src/testing/causes.mjs';
import {testRunRiskRecordPolicies} from '../packages/engine-sdk/src/testing/risks.mjs';
import {testRunRiskValueCases} from './helpers/test-run-risk-values-fixture.mjs';
test('shared test-risk record values reproduce 46 native outcomes captured before extraction',async()=>{
  const capture=JSON.parse(await readFile(new URL('./fixtures/test-run-risk-values/native-v1.json',import.meta.url),'utf8'));
  assert.equal(capture.capturedFrom,'9d2ab9f54');assert.equal(capture.cases.length,46);
  for(const api of [native,testRunRiskRecordPolicies(testRunCausePolicies({toBytes:value=>Buffer.from(value)}))]){
    const result=testRunRiskValueCases(api);assert.equal(result.length,capture.cases.length);
    for(const [index,row]of result.entries())assert.deepEqual(row,capture.cases[index],row.name);
  }
});
test('risk construction requires cause values and never supplies a clock, authority or storage',()=>{
  assert.throws(()=>testRunRiskRecordPolicies(),{code:'ENGINE_INPUT_INVALID'});
  const values=testRunRiskRecordPolicies(testRunCausePolicies({toBytes:value=>Buffer.from(value)}));
  assert.ok(Object.isFrozen(values));assert.equal(values.MAX_TEST_RUN_RISK_DAYS,90);
  assert.equal(values.approve,undefined);assert.equal(values.execute,undefined);
});
