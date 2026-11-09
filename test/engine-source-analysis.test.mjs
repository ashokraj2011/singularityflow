/** Independent pre-extraction outcomes protect native tags, declaration IDs and gap semantics. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {NODE_TEXT_DIGESTS} from '../src/records.mjs';
import {javascriptDeclarationPolicies,tokenizeJavaScript,JAVASCRIPT_DECLARATION_SCHEMA} from '../src/kernel/javascript-declarations.mjs';
import {javascriptSourceComments,scanSourceClauseTags} from '../src/kernel/source-comments.mjs';
import * as tags from '../src/kernel/verification-policy.mjs';
import * as nativeTags from '../src/verification/tags.mjs';
import * as nativeComments from '../src/javascript-source-comments.mjs';
import {scanJavaScriptDeclarations as nativeDeclarations} from '../src/verification/javascript-declarations.mjs';
import {scanSourceClauseTags as nativeSourceTags} from '../src/source-clause-tags.mjs';
import * as node from '../src/engine-compatibility/node-source-analysis.mjs';
const oracle=JSON.parse(await readFile(new URL('./fixtures/source-analysis/native-v1.json',import.meta.url),'utf8'));
const rules=javascriptDeclarationPolicies(NODE_TEXT_DIGESTS),json=value=>JSON.parse(JSON.stringify(value));
const expand=value=>typeof value==='string'?value:value.repeat.repeat(value.count);
test('the oracle identifies the actual previous native owners and immutable declaration schema',()=>{
  assert.equal(oracle.nativeCommit,'5ca5accb4ddc1d856a616144b34ffd644971d107');assert.equal(JAVASCRIPT_DECLARATION_SCHEMA,'javascript-test-v2');
  assert.equal(oracle.sourceSha256['src/verification/javascript-declarations.mjs'],'ae04558b35db4afbddead56d69535a350dbb93ceacb6890eba27ad9dbebd45e1');
  assert.equal(oracle.sourceSha256['src/source-clause-tags.mjs'],'19518b939b90714553f3a01a20379e597fa227d0778151ff1504594967affa0d');
  assert.equal(oracle.declarations.length,23);assert.equal(oracle.sources.length,12);
});
for(const row of oracle.declarations)test('native declaration values: '+row.id,()=>{
  const text=expand(row.source);assert.deepEqual(json(rules.scanJavaScriptDeclarations(text,row.options)),row.expected);
  assert.deepEqual(json(node.scanJavaScriptDeclarations(text,row.options)),row.expected);
  assert.deepEqual(json(nativeDeclarations(text,row.options)),row.expected);
});
for(const row of oracle.sources)test('native source-comment values: '+row.id,()=>{
  assert.deepEqual(scanSourceClauseTags(row.source,row.options),row.expected);assert.deepEqual(node.scanSourceClauseTags(row.source,row.options),row.expected);
  assert.deepEqual(nativeSourceTags(row.source,row.options),row.expected);
  if(row.comments!==null)assert.deepEqual(javascriptSourceComments(row.source,{jsx:!/[cm]?ts$/iu.test(row.options.sourcePath)}),row.comments);
});
test('compatibility exports use one acceptance vocabulary and the same bounded source-comment owner',()=>{
  for(const key of ['isQualifiedAcceptanceId','acceptanceTagsInComment','adjacentWhitespace','acceptanceTagsAboveLine','acceptanceTagLines'])assert.equal(nativeTags[key],tags[key]);
  assert.equal(nativeComments.javascriptSourceComments,javascriptSourceComments);assert.equal(node.tokenizeJavaScript,tokenizeJavaScript);
  for(const row of oracle.tags)assert.deepEqual(tags.acceptanceTagsInComment(row.text),row.expected);
});
test('only an explicit digest primitive can name declarations, and its actual failure is preserved',()=>{
  let invoked=false;const getter=Object.freeze({profile:NODE_TEXT_DIGESTS.profile,get sha256Utf8(){invoked=true;return ()=>'';}});
  assert.throws(()=>javascriptDeclarationPolicies(getter),{code:'ENGINE_TEXT_DIGEST_PORT_INVALID'});assert.equal(invoked,false);
  const source="test('actual',()=>{});",options={sourcePath:'test/example.test.js',framework:'jest'};
  const bad=javascriptDeclarationPolicies(Object.freeze({profile:NODE_TEXT_DIGESTS.profile,sha256Utf8:()=> 'not-a-digest'}));
  assert.throws(()=>bad.scanJavaScriptDeclarations(source,options),{code:'ENGINE_TEXT_DIGEST_RESULT_INVALID'});
  const original=Object.assign(Error('Original primitive failure.'),{code:'EACCES'});
  const failed=javascriptDeclarationPolicies(Object.freeze({profile:NODE_TEXT_DIGESTS.profile,sha256Utf8(){throw original;}}));
  assert.throws(()=>failed.scanJavaScriptDeclarations(source,options),error=>error===original);
});
