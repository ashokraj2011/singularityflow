import test from 'node:test';import assert from 'node:assert/strict';
import {createValidatedNamespaceViewCache} from '../src/sda/namespace/validated-view-cache.mjs';
const view=value=>({scope:{projectId:'p'},sequence:1,sha256:'a'.repeat(64),state:{records:new Map([['row',{value}]]),events:new Map(),operations:new Map()}});
test('validated views are private on insertion and retrieval and require the exact journal token',()=>{
  const cache=createValidatedNamespaceViewCache(),original=view(1);cache.put('p',1,original);original.state.records.clear();
  const first=cache.get('p',1);assert.equal(first.state.records.get('row').value,1);first.state.records.get('row').value=99;
  assert.equal(cache.get('p',1).state.records.get('row').value,1);assert.equal(cache.get('p',2),null);cache.clear();assert.equal(cache.get('p',1),null);
});
test('view reuse has bounded entry/byte retention and evicts the least recently used prefix',()=>{
  const cache=createValidatedNamespaceViewCache({maximumEntries:2,maximumBytes:2048});cache.put('a',1,view(1));cache.put('b',1,view(2));cache.get('a',1);
  cache.put('c',1,view(3));assert.equal(cache.get('b',1),null);assert.equal(cache.get('a',1).state.records.get('row').value,1);
  assert.equal(cache.put('a',2,view('x'.repeat(4096))),false);assert.equal(cache.get('a',1),null);assert.equal(cache.get('c',1).state.records.get('row').value,3);
});
