import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as native from '../src/sgos/node-execution-unit.mjs';
import * as previous from '../src/sgos/execution-units.mjs';
import {canonicalJson,cloneSgosRecordValue} from '../src/foundation/record-schema.mjs';
import {cloneSgosValue,sha256} from '../src/sgos/contracts.mjs';
const golden=JSON.parse(await readFile(new URL('./fixtures/sgos-execution-unit-packets/native-v1.json',import.meta.url),'utf8'));
const body=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!['schemaVersion','kind','manifestSha256','contractSha256'].includes(key)));
test('actual v1 execution manifests, task contracts, handles, events and receipts retain their bytes and hashes',()=>{
  assert.equal(golden.baseline,'02a68ef23');
  for(const manifest of golden.manifests){assert.deepEqual(native.createExecutionUnitManifest(body(manifest)),manifest);
    assert.deepEqual(native.validateExecutionUnitManifest(manifest),manifest);}
  for(const task of golden.tasks)assert.deepEqual(native.createAgentTaskContract(body(task)),task);
  for(const [value,field] of [[golden.handle,'handleSha256'],...golden.events.map(event=>[event,'eventSha256']),
    [golden.quiescence,'quiescenceReceiptSha256'],[golden.stop,'stopReceiptSha256']]){
    const core={...value};delete core[field];
    assert.equal(value[field],'sha256:'+createHash('sha256').update(canonicalJson(core)).digest('hex'));
  }
  assert.equal(native.executionUnitSha256(golden.result.output),golden.result.outputSha256);
});
test('compatibility imports and installed descriptors use the same operational owners',()=>{
  for(const name of ['createExecutionUnitManifest','validateExecutionUnitManifest','createAgentTaskContract','validateAgentTaskContract',
    'createDeterministicTranslatorExecutionUnit','createGenericProcessExecutionUnit'])assert.equal(previous[name],native[name]);
  assert.deepEqual(previous.installedExecutionUnitManifests(),golden.manifests.slice(0,2));
});
test('captured validation failures retain their original names, codes, messages and details',()=>{
  for(const entry of golden.failures)assert.throws(()=>entry.kind==='manifest'?native.validateExecutionUnitManifest(entry.input):native.createAgentTaskContract(entry.input),
    error=>{for(const field of Object.keys(entry.error))assert.deepEqual(error[field],entry.error[field]);return true;});
});
test('SGOS record and execution hashing share the original JSON-value semantics',()=>{
  const values=[null,true,'text',-0,{b:['😀',42],a:{empty:[]}},Object.assign(Object.create(null),{plain:'value'})];
  for(const value of values){assert.deepEqual(cloneSgosRecordValue(value),cloneSgosValue(value));assert.equal(native.executionUnitSha256(value),sha256(value));}
  const cyclic={};cyclic.self=cyclic;
  for(const value of [cyclic,{bad:NaN},{bad:undefined},{bad:()=>{}},new Date(),JSON.parse('{"__proto__":{}}'),JSON.parse('{"constructor":{}}')]){
    let original;try{cloneSgosValue(value);}catch(error){original=error;}
    assert.ok(original);assert.throws(()=>cloneSgosRecordValue(value),error=>error.code===original.code&&error.message===original.message);
  }
});
