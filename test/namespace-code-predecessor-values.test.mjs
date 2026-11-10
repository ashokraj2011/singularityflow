import test from 'node:test';import assert from 'node:assert/strict';
import {changedApprovedSourceInputs} from '../src/kernel/source-changes.mjs';
const row=(path,sha256='a',executable=false)=>({path,sha256,bytes:10,executable});
test('carried inputs require exact prior values and permit separately delivered new paths',()=>{
  const original=[row('src/value.js'),row('test/value.test.js')],copy=structuredClone(original);
  assert.deepEqual(changedApprovedSourceInputs(original,[...copy,row('src/new.js')]),[]);assert.deepEqual(original,copy);
  assert.deepEqual(changedApprovedSourceInputs(original,[row('src/value.js','b'),row('test/value.test.js','a',true)]),['src/value.js','test/value.test.js']);
  assert.deepEqual(changedApprovedSourceInputs(original,[]),['src/value.js','test/value.test.js']);
});
test('an approved absence cannot turn into a reused present source',()=>{
  assert.deepEqual(changedApprovedSourceInputs([],[],{absentPaths:['src/removed.js']}),[]);
  assert.deepEqual(changedApprovedSourceInputs([],[row('src/removed.js')],{absentPaths:['src/removed.js']}),['src/removed.js']);
});
test('duplicate or malformed inventories cannot become a carried source observation',()=>{
  assert.throws(()=>changedApprovedSourceInputs([row('a'),row('a')],[]),{code:'ENGINE_INPUT_INVALID'});
  assert.throws(()=>changedApprovedSourceInputs([],[row('a'),row('a')]),{code:'ENGINE_INPUT_INVALID'});
  assert.throws(()=>changedApprovedSourceInputs(null,[]),{code:'ENGINE_INPUT_INVALID'});
  assert.throws(()=>changedApprovedSourceInputs([],[row('../outside.js')]),error=>Boolean(error.code));
});
