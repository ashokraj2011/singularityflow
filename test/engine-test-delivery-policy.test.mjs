import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import * as native from '../src/engine-compatibility/node-source-policy.mjs';
import * as tests from '../src/code-delivery-tests.mjs';
import * as delivery from '../src/delivery-evidence.mjs';
import {testDeliveryPolicies,TEST_DELIVERY_POLICY_FACTS} from '../src/kernel/source-path-policies.mjs';
import {CONFIGURATION_PATH_SYNTAX} from '../src/kernel/configuration-path-policies.mjs';
import {TEST_COMMAND_ECOSYSTEMS} from '../src/engine-compatibility/node-configuration-path.mjs';
import {ecosystemOfAdapter,ecosystemOfProgram} from '../src/test-runners.mjs';
const original=JSON.parse(await readFile(new URL('./fixtures/test-delivery-policy-packets/native-v1.json',import.meta.url),'utf8'));
const digest=value=>createHash('sha256').update(value).digest('hex');
const syntax=grammar=>Object.freeze({profile:CONFIGURATION_PATH_SYNTAX,grammar:grammar.sep==='\\'?'win32':'posix',
  isAbsolute:grammar.isAbsolute,normalize:grammar.normalize,parse:grammar.parse,posixIsAbsolute:path.posix.isAbsolute,
  posixNormalize:path.posix.normalize,posixBasename:path.posix.basename,toPosix:value=>value.split(grammar.sep).join('/')});
const facts=extra=>Object.freeze({profile:TEST_DELIVERY_POLICY_FACTS,ecosystems:TEST_COMMAND_ECOSYSTEMS,
  posixExtname:path.posix.extname,ecosystemOfAdapter,ecosystemOfProgram,...extra});
const outcome=invoke=>{try{return JSON.parse(JSON.stringify({value:invoke()}));}
  catch(error){return {error:{name:error.name,message:error.message,code:error.code??null,details:error.details??null}};}};
test('all 6,161 independently captured test-name, ecosystem and affected-module outcomes retain native values and refusals',()=>{
  assert.equal(original.baseline,'5309738f9');assert.equal(original.cases.length,6161);
  const rules=testDeliveryPolicies(syntax(path.posix),facts());
  for(const {method,args,outcome:expected}of original.cases)assert.deepEqual(outcome(()=>rules[method](...structuredClone(args))),expected,method+': '+JSON.stringify(args));
});
test('all twelve original test-delivery policy bodies keep their independent native fingerprints',async()=>{
  const text=await readFile(new URL('../src/kernel/source-path-policies.mjs',import.meta.url),'utf8'),ast=ts.createSourceFile('rules.mjs',text,ts.ScriptTarget.Latest,true),printer=ts.createPrinter({removeComments:false}),seen=new Set();
  const visit=node=>{if(ts.isFunctionDeclaration(node)&&Object.hasOwn(original.functions,node.name?.text??'')){
    assert.equal(digest(printer.printNode(ts.EmitHint.Unspecified,node.body,ast)),original.functions[node.name.text],node.name.text);seen.add(node.name.text);}
    ts.forEachChild(node,visit);};visit(ast);
  assert.deepEqual([...seen].sort(),Object.keys(original.functions).sort());
});
test('219 actual native change-cohort projections retain rename, deletion, submodule and configuration distinctions',()=>{
  assert.equal(original.cohorts.cases.length,219);
  const rules=testDeliveryPolicies(syntax(path.posix),facts());
  for(const {entries,value}of original.cohorts.cases)assert.deepEqual(rules.deliveryPathCohorts(structuredClone(entries)),value,JSON.stringify(entries));
});
test('legacy delivery/test exports and the native SDK binding use the same rule instances',()=>{
  for(const {group,method}of original.cases)assert.equal({tests,delivery}[group][method],native[method],group+': '+method);
});
test('51 original executable-test filesystem decisions retain their values with a shared name policy',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'sflow-test-policy-files-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  for(const candidate of new Set(original.io.map(row=>row.candidate).filter(name=>!['missing/test.js','test/custom_spec.feature'].includes(name)))){
    await mkdir(path.dirname(path.join(root,candidate)),{recursive:true});await writeFile(path.join(root,candidate),'observed test source');}
  for(const {candidate,options,value}of original.io)assert.equal(await tests.isExecutableTestSourcePath(root,candidate,options),value,JSON.stringify({candidate,options}));
  await symlink(path.join(root,'src/App.test.js'),path.join(root,'src/linked.test.js'));
  assert.equal(await tests.isExecutableTestSourcePath(root,'src/linked.test.js'),false);
  assert.equal(native.isExecutableTestSourceCandidate('src/linked.test.js'),true,'a path rule does not claim a file-kind observation');
});
test('frozen explicit fact bindings reject getters and retain their captured ecosystem order',()=>{
  const port=syntax(path.posix),ecosystems=[...TEST_COMMAND_ECOSYSTEMS],bound=testDeliveryPolicies(port,facts({ecosystems}));ecosystems[0]='altered';
  assert.equal(bound.sourceEcosystem('src/app.js'),'node');let calls=0;
  const invalid=Object.freeze({...facts(),get ecosystemOfProgram(){calls++;return ecosystemOfProgram;}});
  assert.throws(()=>testDeliveryPolicies(port,invalid),{code:'ENGINE_TEST_DELIVERY_FACTS_INVALID'});assert.equal(calls,0);
  assert.throws(()=>testDeliveryPolicies(port,{...facts()}),{code:'ENGINE_TEST_DELIVERY_FACTS_INVALID'});
});
test('explicit POSIX and Win32 string bindings keep ecosystem and Android device coverage separate',()=>{
  for(const grammar of [path.posix,path.win32]){
    const rules=testDeliveryPolicies(syntax(grammar),facts());
    assert.equal(rules.testCommandCoversPath({argv:['node','--test'],affectedRoots:['.'],provenance:'inferred'},'api/main.py'),false);
    assert.equal(rules.testCommandCoversPath({argv:['mvn','test'],affectedRoots:['.'],provenance:'inferred'},'api/src/androidTest/java/UiTest.java'),false);
    assert.equal(rules.testCommandCoversPath({argv:['gradle','connectedAndroidTest'],affectedRoots:['.'],ecosystem:'jvm'},'api/src/androidTest/java/UiTest.java'),true);
    assert.equal(rules.testCommandCoversPath({affectedRoots:['.']},'api/main.py'),true,'an older configured command keeps its declared roots');
    assert.deepEqual(rules.testCoverageDeliveryPaths({sourcePaths:['app.js'],configurationPaths:['package.json','.github/workflows/build.yml','.gitignore']}),['app.js','package.json']);
  }
});
