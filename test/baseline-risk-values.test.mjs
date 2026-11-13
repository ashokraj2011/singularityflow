import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {buildBaselineRiskDecision} from '../src/test-recovery-admission.mjs';
import {testRecoveryPolicies} from '../src/kernel/test-recovery.mjs';import {NODE_TEXT_DIGESTS} from '../src/records.mjs';
import {baselineRiskValueCases,observeBaselineRiskValue} from './helpers/baseline-risk-values-fixture.mjs';
const capture=JSON.parse(await readFile(new URL('./fixtures/baseline-risk-values/native-v1.json',import.meta.url),'utf8')),
  values=testRecoveryPolicies(NODE_TEXT_DIGESTS);
test('baseline intake rules reproduce all independent native values and failures without discovering authority',()=>{
  assert.equal(capture.baseline,'b1a77c07845ebcb7fa75c5ace22b4bdfeb6eb493');
  assert.equal(capture.sha256,'ecee87b42c8693897823e13592d6b3c32101bc3a76904c4d3ec38bd4ee1c636f');
  const rows=baselineRiskValueCases();assert.equal(rows.length,24);assert.equal(capture.cases.length,rows.length);
  for(const [index,row]of rows.entries())for(const build of [buildBaselineRiskDecision,values.buildBaselineRiskDecision]){
    assert.equal(row.name,capture.cases[index].name);assert.deepEqual(observeBaselineRiskValue(build,row),capture.cases[index].observation,row.name);}
});
test('pure baseline intake construction requires admitted time and does not produce a human receipt',()=>{
  const row=baselineRiskValueCases()[0],options={...row.options};delete options.createdAt;
  assert.throws(()=>values.buildBaselineRiskDecision(row.agreement,row.baseline,options),{code:'ENGINE_INPUT_INVALID'});
  const record=values.buildBaselineRiskDecision(row.agreement,row.baseline,row.options);
  assert.ok(Object.isFrozen(record));assert.equal(record.receipt,undefined);assert.equal(values.authorize,undefined);
  const gate=values.evaluateTestRecoveryGate({...row.options,policy:row.options.authority.policy,agreement:row.agreement,
    subject:row.baseline.subject,operation:'publish',at:row.options.createdAt,decisions:[record]});
  assert.notEqual(gate.status,'pass');
});
