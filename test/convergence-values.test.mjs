/** Captured before extraction; these are synthetic value fixtures, never Story evidence. */
import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {convergenceValuePolicies} from '../src/kernel/convergence-values.mjs';
import * as native from '../src/convergence.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../src/engine-compatibility/node-configuration-path.mjs';
import {NODE_TEXT_VALUE_SYNTAX} from '../src/records.mjs';
const values=convergenceValuePolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_VALUE_SYNTAX),
  golden=JSON.parse(await readFile(new URL('./fixtures/convergence-values/native-v6.json',import.meta.url),'utf8'));
for(const row of golden.cases)test('shared convergence preserves native '+row.name+' values, hashes, disclosures and artifact bytes',()=>{
  const facts=values.convergenceFacts(row.input),bindings=values.convergenceBindings({iteration:1,configurationSha256:'e'.repeat(64),...row.input}),
    projection=values.convergenceProjection({workId:'case-1',bindings,facts,adjudications:row.adjudications});
  assert.deepEqual({facts,bindings,projection,artifact:values.renderConvergenceArtifact(projection),serialized:values.serializeConvergence(projection)},row.expected);
  const nativeFacts=native.convergenceFacts(row.input),nativeBindings=native.convergenceBindings({iteration:1,configurationSha256:'e'.repeat(64),...row.input}),
    nativeProjection=native.convergenceProjection({workId:'case-1',bindings:nativeBindings,facts:nativeFacts,adjudications:row.adjudications});
  assert.deepEqual({facts:nativeFacts,bindings:nativeBindings,projection:nativeProjection,artifact:native.renderConvergenceArtifact(nativeProjection),
    serialized:native.serializeConvergence(nativeProjection)},row.expected);
});
for(const row of golden.errors)test('shared convergence preserves native '+row.name+' refusal',()=>{
  let actual;try{values[row.operation](...row.arguments);}catch(error){actual={name:error.name,message:error.message,code:error.code??null,details:error.details??null};}
  assert.deepEqual(actual,row.expected);
  let installed;try{native[row.operation](...row.arguments);}catch(error){installed={name:error.name,message:error.message,code:error.code??null,details:error.details??null};}
  assert.deepEqual(installed,row.expected);
});
test('native stale-binding guidance stays outside the pure convergence error',()=>{
  const projection=golden.cases[0].expected.projection,options={currentBindings:{...projection.bindings,iteration:2}};
  assert.throws(()=>values.assertConvergenceIntegrity(projection,options),error=>error.code==='CONVERGENCE_BINDINGS_STALE'&&!error.message.includes('singularity-flow'));
  assert.throws(()=>native.assertConvergenceIntegrity(projection,options),error=>error.code==='CONVERGENCE_BINDINGS_STALE'
    &&error.message==='Convergence bindings no longer match the current approved inputs. Run singularity-flow story converge again before adjudicating or advancing.');
});
test('convergence rules do not turn unreviewed facts into decisions or lose the original primitive failure',()=>{
  const row=golden.cases[0],open=values.convergenceProjection({workId:'case-1',bindings:row.expected.bindings,facts:row.expected.facts});
  assert.deepEqual(open.findings,[]);assert.deepEqual(open.allowedNext,['adjudicate']);
  assert.throws(()=>values.assertConvergencePublishable(open,values.renderConvergenceArtifact(open)),{code:'CONVERGENCE_REVIEW_REQUIRED'});
  const failure=Object.assign(Error('The declared digest primitive failed.'),{code:'EACCES',details:{primitive:'utf8-digest'}}),
    broken=convergenceValuePolicies(NODE_CONFIGURATION_PATH_SYNTAX,Object.freeze({...NODE_TEXT_VALUE_SYNTAX,sha256Utf8(){throw failure;}}));
  assert.throws(()=>broken.itemId('CF',{kind:'missing'}),actual=>actual===failure);
  assert.throws(()=>convergenceValuePolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_VALUE_SYNTAX,{schemaVersion:7}),{code:'ENGINE_STORAGE_UNSUPPORTED'});
});
test('plan settlement preserves hash, protected-path, human-return and classification restrictions',()=>{
  const hash='a'.repeat(64),entry={kind:'amendment',id:'PAM-001',class:'build-configuration',sha256:hash,text:'Configure the actual browser test runner.'},
    entries=[{file:'vite.config.js',approved:true,problem:null,entry}],base={path:'vite.config.js',status:'present',sha256:hash,clauseIds:[],protected:false},
    account=values.planAccountsFromEntries(entries),fact={id:'CF-config',kind:'unclaimed-changed-path',paths:['vite.config.js'],clauseIds:[],evidence:[],detail:'No observed claim cites this path.'};
  assert.deepEqual(account(base),entry);assert.equal(values.settleChangedPaths([fact],{reconciliation:{findings:[base]},planAccount:account}).settled[0].id,fact.id);
  for(const changed of [{...base,sha256:'b'.repeat(64)},{...base,protected:true},{...base,status:'deleted'},
    {...base,clauseIds:['S:REQ-001']},{...base,status:'symlink'}]){
    assert.equal(typeof account(changed).askedBecause,'string');
    assert.deepEqual(values.settleChangedPaths([fact],{reconciliation:{findings:[changed]},planAccount:account}).facts,[fact]);
  }
  for(const keptByPerson of [null,new Set(['vite.config.js'])])assert.equal(typeof values.planAccountsFromEntries(entries,{keptByPerson})(base).askedBecause,'string');
  const wrong=[{...entries[0],entry:{...entry,class:'documentation'}}];assert.match(values.planAccountsFromEntries(wrong)(base).askedBecause,/path is build-configuration/u);
});
