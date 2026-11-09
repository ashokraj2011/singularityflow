/** Shape admission alone grants no authority; malformed nested reads fail before receipt replay. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceControlRecord,sourceControlValue} from '../src/engine-storage/namespace-source-control-contract.mjs';
import {SOURCE_UNIT_CONTRACT,SOURCE_LIMITS} from '../src/foundation/source-snapshot.mjs';
import {SOURCE_CONTROL_LIMITS} from '../src/foundation/source-control.mjs';
const sha='a'.repeat(64);
function plan(){
  const archive={sourceBindingId:'original',operationId:'archive',result:{key:'source-baseline/results/'+sha,version:'original-result',
    content:{namespace:'evidence',sha256:sha,bytes:1}},index:{key:'source-baseline/bindings/'+sha,version:'original-index'}},
    source={contract:SOURCE_UNIT_CONTRACT,id:'unit',projectId:'project',repositoryId:'app',provider:'filesystem',selection:{excludePaths:[]},limits:SOURCE_LIMITS},
    reader={contract:'sflow-source-control-reader/v2',id:'origins',source,profile:'git-selected-worktree-line-origins/v2',baselineRevision:'baseline',originRevision:'origin',
      executableSha256:'sha256:'+sha,environmentSha256:'sha256:'+sha,limits:SOURCE_CONTROL_LIMITS};
  // Other plan members belong to accepted-receipt/Story admission, not this shape-only test.
  return sourceControlRecord('plan',{profile:'sflow-namespace-source-control/v2',binding:null,input:null,parametersSha256:null,actor:null,basis:null,generation:null,
    draft:null,source:null,observations:[{id:'app',reader,revision:'sha256:'+sha,content:{namespace:'runtime',sha256:sha,bytes:1}}],
    origins:[{id:'app',origin:archive,baseline:structuredClone(archive)}]},2);
}
test('v2 shape admission preserves the exact bound references and never adds approval or readiness',()=>{
  const value=plan(),parsed=sourceControlValue('plan',value);assert.equal(parsed,value);assert.deepEqual(Object.keys(parsed),Object.keys(value));
  assert.equal(Object.hasOwn(parsed,'approved'),false);assert.equal(Object.hasOwn(parsed,'ready'),false);
});
for(const [name,mutate]of [
  ['missing origin array',p=>{p.origins=null;}],['null origin member',p=>{p.origins=[null];}],
  ['null archive member',p=>{p.origins[0].origin=null;}],['absent archive revision',p=>{p.origins[0].origin.index.version=null;}],
  ['wrong content namespace',p=>{p.origins[0].origin.result.content.namespace='runtime';}],
  ['wrong archive address',p=>{p.origins[0].origin.result.key='../another';}],
  ['duplicate repository',p=>{p.origins.push(structuredClone(p.origins[0]));}],
  ['null observation',p=>{p.observations=[null];}],['invalid reader',p=>{p.observations[0].reader=null;}],
  ['incomplete v2 reader',p=>{delete p.observations[0].reader.originRevision;}]
])test('v2 nested reads reject '+name+' as stored-data corruption',()=>{
  const value=plan();mutate(value);assert.throws(()=>sourceControlValue('plan',value),{code:'ENGINE_STORAGE_CORRUPT'});
});
test('unknown future source-control records keep the explicit upgrade error',()=>{
  const value=plan();value.schemaVersion=3;value.format='sflow-namespace-source-control-plan/v3';
  assert.throws(()=>sourceControlValue('plan',value),{code:'ENGINE_STORAGE_UNSUPPORTED'});
});
