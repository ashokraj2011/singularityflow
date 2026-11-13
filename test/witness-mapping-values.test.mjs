import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {witnessMappingReviewPolicies,ADEQUACY_FACETS} from '../src/kernel/human-witnesses.mjs';
import {evaluateWitnessMappingReview,ADEQUACY_FACETS as nativeFacets} from '../src/wel-review.mjs';
import {NODE_TEXT_VALUE_SYNTAX,NODE_TEXT_DIGESTS} from '../src/records.mjs';
import {witnessMappingCases,observeWitnessMapping} from './helpers/witness-mapping-values-fixture.mjs';
const capture=JSON.parse(await readFile(new URL('./fixtures/witness-mapping-values/native-v1.json',import.meta.url),'utf8'));
test('native and shared adequacy rules reproduce the independent original outcomes without rewriting them',()=>{
  assert.equal(capture.baseline,'3c0d359d5');assert.equal(capture.sha256,'97c439900f54974741ce975f84f4a712c8d0ded5b14cc09c7d7910f6e2802c8b');
  const cases=witnessMappingCases(),values=witnessMappingReviewPolicies(NODE_TEXT_VALUE_SYNTAX,NODE_TEXT_DIGESTS);assert.equal(cases.length,67);
  assert.equal(capture.cases.length,cases.length);assert.equal(nativeFacets,ADEQUACY_FACETS);
  for(const [index,row]of cases.entries())for(const fn of [evaluateWitnessMappingReview,values.evaluateWitnessMappingReview]){
    assert.equal(capture.cases[index].name,row.name);assert.deepEqual(observeWitnessMapping(fn,row.input),capture.cases[index].observation,row.name);
  }
});
test('shared adequacy values capture primitive capabilities and require explicit time without granting human authority',()=>{
  const utf8={...NODE_TEXT_VALUE_SYNTAX},digests=Object.freeze({...NODE_TEXT_DIGESTS}),values=witnessMappingReviewPolicies(utf8,digests),input=witnessMappingCases()[1].input;
  utf8.byteLengthUtf8=()=>{throw Error('A caller changed the capability.');};assert.throws(()=>{digests.sha256Utf8=utf8.byteLengthUtf8;},TypeError);
  const result=values.evaluateWitnessMappingReview(input);assert.equal(result.valid,true);assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(values));
  assert.throws(()=>values.evaluateWitnessMappingReview({mappings:input.mappings}),{code:'ENGINE_INPUT_INVALID'});
  assert.equal(values.approve,undefined);assert.equal(values.read,undefined);
});
