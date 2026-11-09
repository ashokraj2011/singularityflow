/** Independently captured native regions, explanations, symbols and review choices. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {NODE_TEXT_DIGESTS} from '../src/records.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../src/engine-compatibility/node-configuration-path.mjs';
import {implementationBindingPolicies,reviewBindings} from '../src/kernel/code-delivery-evidence.mjs';
import {publicDeclarations,changedDeclarations,codeDocumentationPolicies} from '../src/kernel/code-documentation.mjs';
import {maskPolyglotNonCode,extractPolyglotSymbols,extractPolyglotImports,polyglotPathPolicies} from '../src/kernel/polyglot-lexical.mjs';
import * as node from '../src/engine-compatibility/node-source-analysis.mjs';
import * as native from '../src/implementation-bindings.mjs';
import * as documentation from '../src/code-documentation.mjs';
import * as lexical from '../src/polyglot-lexical.mjs';
import {implementationBindingCases,implementationBindingFixture} from './helpers/implementation-binding-fixture.mjs';
const oracle=JSON.parse(await readFile(new URL('./fixtures/implementation-bindings/native-v1.json',import.meta.url),'utf8')),
  rules=implementationBindingPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_DIGESTS),docs=codeDocumentationPolicies(NODE_CONFIGURATION_PATH_SYNTAX),paths=polyglotPathPolicies(NODE_CONFIGURATION_PATH_SYNTAX);
const json=value=>JSON.parse(JSON.stringify(value));
function replay(method,row){const run=method(row.input),requests=[];let step=run.next();while(!step.done){
  const request=step.value;assert.ok(Object.isFrozen(request));requests.push(request);
  if(request.kind==='implementation-diff-preview')step=run.next(structuredClone(row.preview));
  else{assert.equal(request.kind,'implementation-source');assert.equal(request.maximumBytes,2*1024*1024);assert.ok(Object.hasOwn(row.sources,request.path));step=run.next(row.sources[request.path]);}}
  return {value:step.value,requests};}
test('the binding oracle comes from original native owners before extraction',()=>{
  assert.equal(oracle.nativeCommit,'ce0f19d2ea341f0b5e411a045ee94a25e1f920f6');assert.equal(oracle.cases.length,27);assert.equal(Object.keys(oracle.sourceSha256).length,3);
  assert.equal(oracle.sourceSha256['src/implementation-bindings.mjs'],'b6605c458ba6e91d413c4a70b6d43c1e543e6904fa1f4c49f89cf3ccc1f14f76');
  assert.equal(oracle.sourceSha256['src/code-documentation.mjs'],'92c4c7e6a611c4a80a0b185928390b81229f5aaea816b5937ec3cebbcdcb77ab');
  assert.equal(oracle.sourceSha256['src/polyglot-lexical.mjs'],'fcb25a1f46fd9db98e7e1390ed5430c460a1d5560f9b190c8570e042ca81962e');
});
for(const row of oracle.cases)test('original implementation regions and explanations: '+row.id,async t=>{
  const pure=replay(rules.implementationBindingsReplay,row),bound=replay(node.implementationBindingsReplay,row);
  assert.deepEqual(pure.value,row.expected);assert.deepEqual(bound.value,row.expected);
  const f=await implementationBindingFixture(implementationBindingCases().find(value=>value.id===row.id));t.after(f.close);
  assert.deepEqual(await native.implementationBindings(f.root,f.input),row.expected);
  const sourcePaths=pure.requests.filter(request=>request.kind==='implementation-source').map(request=>request.path);
  assert.equal(sourcePaths.length,new Set(sourcePaths).size,'one invocation never rereads the same supplied source');
});
test('documentation and polyglot rules preserve native observations and compatibility exports',()=>{
  assert.equal(documentation.publicDeclarations,publicDeclarations);assert.equal(documentation.changedDeclarations,changedDeclarations);
  assert.equal(documentation.documentationLanguage,node.documentationLanguage);assert.equal(lexical.maskPolyglotNonCode,maskPolyglotNonCode);
  assert.equal(native.reviewBindings,reviewBindings);
  for(const row of oracle.values){assert.deepEqual(publicDeclarations(row.source,row.language),row.expected);
    assert.deepEqual(changedDeclarations(row.expected,new Set([2,3,7]),row.source.split(/\r?\n/u)),row.changed);}
  for(const row of oracle.paths){assert.equal(docs.documentationLanguage(row.file),row.language);assert.equal(docs.unsupportedSourceLanguage(row.file),row.unsupported);}
  for(const row of oracle.lexicalCases){assert.equal(maskPolyglotNonCode(row.source,row.language),row.mask);assert.deepEqual(extractPolyglotSymbols(row.source,row.language),row.symbols);assert.deepEqual(extractPolyglotImports(row.source,row.language),row.imports);}
  for(const row of oracle.resolutions)assert.equal(paths.resolvePolyglotLocal(...row.args),row.expected);
});
for(const row of oracle.decisions)test('original binding review policy: '+row.id,()=>{
  let actual;try{actual={value:reviewBindings(...row.args)};}catch(error){actual={error:{name:error.name,message:error.message,code:error.code,details:error.details,exitCode:error.exitCode}};}
  assert.deepEqual(json(actual),row.outcome);
});
test('value rules never acquire source I/O, and exact owner errors cannot be turned into successful bindings',()=>{
  const row=oracle.cases.find(value=>value.id==='modified'),replay=rules.implementationBindingsReplay(row.input),first=replay.next();
  assert.equal(first.value.kind,'implementation-diff-preview');const original=Object.assign(Error('Original Git/source deadline.'),{code:'ETIMEDOUT',timeoutMs:300000});
  assert.throws(()=>replay.throw(original),error=>error===original);
  let evaluated=false;const invalid=Object.freeze({profile:NODE_TEXT_DIGESTS.profile,get sha256Utf8(){evaluated=true;return ()=>'';}});
  assert.throws(()=>implementationBindingPolicies(NODE_CONFIGURATION_PATH_SYNTAX,invalid),{code:'ENGINE_TEXT_DIGEST_PORT_INVALID'});assert.equal(evaluated,false);
  const bad=implementationBindingPolicies(NODE_CONFIGURATION_PATH_SYNTAX,Object.freeze({profile:NODE_TEXT_DIGESTS.profile,sha256Utf8:()=> 'wrong'}));
  assert.throws(()=>bad.bindingsDigest([]),{code:'ENGINE_TEXT_DIGEST_RESULT_INVALID'});
});
