import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import * as policy from '../src/kernel/configuration-policy.mjs';
import { configurationPolicyResults, nativePolicyModules } from './helpers/configuration-policy-cases.mjs';

const baseline=JSON.parse(await readFile(new URL('./fixtures/engine-configuration-policies/native-v1.json',import.meta.url),'utf8'));

test('60 captured policy results preserve native values and exact refusal details',()=>{
  assert.deepEqual(configurationPolicyResults(),baseline.results);
});

test('all 39 extracted rule bodies keep their original native syntax',async()=>{
  const text=await readFile(new URL('../src/kernel/configuration-policy.mjs',import.meta.url),'utf8');
  const ast=ts.createSourceFile('configuration-policy.mjs',text,ts.ScriptTarget.Latest,true),printer=ts.createPrinter({removeComments:true});
  const functions=new Map(ast.statements.filter(ts.isFunctionDeclaration).map(node=>[node.name.text,node]));
  for(const [original,expected]of Object.entries(baseline.functions)) {
    const name=original.split(':')[1],node=functions.get(name);assert.ok(node,original);
    const body=printer.printNode(ts.EmitHint.Unspecified,node.body,ast);
    assert.equal(createHash('sha256').update(body).digest('hex'),expected,original);
  }
  assert.equal(functions.size,Object.keys(baseline.functions).length);
});

test('native compatibility exports expose the same kernel functions and policy values',async()=>{
  for(const [file,names]of Object.entries(baseline.owners)) {
    const native=await import(new URL('../'+file,import.meta.url));
    for(const name of names)assert.equal(native[name],policy[name],file+':'+name);
  }
  assert.equal(nativePolicyModules.session.normalizeSessionPolicy,policy.normalizeSessionPolicy);
  assert.equal(Object.isFrozen(policy.MODEL_TASKS),true);
  assert.equal(Object.isFrozen(policy.DEFAULT_CODE_DELIVERY_POLICY.tests),true);
});

test('normalizing policy leaves caller data intact and preserves explicit failures',()=>{
  for(const [name,input]of [
    ['normalizeSessionPolicy',{workItemSelection:'prompt'}],
    ['normalizeTemplateCatalog',{example:{label:'Example',path:'common/example.md'}}],
    ['normalizeTestRuntime',{nodeOptions:['--no-experimental-webstorage','--no-experimental-webstorage']}],
    ['normalizeCodeDeliveryPolicy',{tests:{minimumPassed:2}}],
    ['normalizeSpecPolicy',{mode:'enforce'}]
  ]) {
    const before=structuredClone(input);policy[name](input);assert.deepEqual(input,before,name);
  }
  assert.throws(()=>policy.normalizeTestRuntime({nodeOptions:['--require=/outside']}),{code:'TEST_RUNTIME_INVALID'});
  assert.throws(()=>policy.resolveDocumentStorage('git',{storage:{allowed:['local']}}),{code:'DOCUMENT_STORAGE_NOT_ALLOWED'});
  assert.throws(()=>policy.resolveTemplate({templates:{}},'template:absent'),{code:'TEMPLATE_UNKNOWN'});
});
