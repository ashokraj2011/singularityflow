import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import * as nativeCauses from '../src/test-run-cause.mjs';import * as nativeMessages from '../src/test-case-messages.mjs';
import {testRunCausePolicies} from '../packages/engine-sdk/src/testing/causes.mjs';
import {testRunCauseValueCases} from './helpers/test-run-cause-values-fixture.mjs';
test('the pure and native owners reproduce 152 pre-extraction classification and report-message outcomes',async()=>{
  const capture=JSON.parse(await readFile(new URL('./fixtures/test-run-cause-values/native-v1.json',import.meta.url),'utf8'));
  assert.equal(capture.capturedFrom,'6e3ae5797');assert.equal(capture.cases.length,152);
  for(const api of [{...nativeCauses,...nativeMessages},testRunCausePolicies({toBytes:value=>Buffer.from(value)})]){
    const observed=testRunCauseValueCases(api);assert.equal(observed.length,capture.cases.length);
    for(const [index,row]of observed.entries())assert.deepEqual(row,capture.cases[index],row.name);
  }
});
test('byte normalization is explicit and the SDK description table cannot alter private cause rules',()=>{
  assert.throws(()=>testRunCausePolicies(),{code:'ENGINE_INPUT_INVALID'});
  const codec={toBytes:value=>Buffer.from(value)},rules=testRunCausePolicies(codec);codec.toBytes=()=>{throw Error('A later callback cannot replace the captured capability.');};
  assert.throws(()=>{rules.TEST_RUN_CAUSES['syntax-error'][0]='environment';},TypeError);
  assert.equal(rules.classifyTestRunCause({check:{status:'failed',stderr:'SyntaxError: unexpected token\nECONNREFUSED'}}).category,'code');
  assert.deepEqual(rules.testCaseMessages('vitest-json',['{"testResults":[]}'],0),[]);
});
