/** Frozen native results captured before extraction, including negative identity and execution cases. */
import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import ts from 'typescript';
import * as values from '../src/kernel/verification-witnesses.mjs';
import * as legacyJoin from '../src/verification/join.mjs';import * as legacyResults from '../src/verification/witness-results.mjs';
import * as legacyVocabulary from '../src/evidence/vocabulary.mjs';
import {discoverAcceptanceWitnesses} from '../src/delivery-evidence.mjs';
import {discoverAcceptanceWitnessesReplay,commandForTestFileReplay} from '../src/engine-compatibility/node-source-policy.mjs';
import {scanJavaScriptDeclarations} from '../src/engine-compatibility/node-source-analysis.mjs';
const captured=JSON.parse(await readFile(new URL('./fixtures/verification-witnesses/native-v1.json',import.meta.url),'utf8'));
test('native witness aliases retain one function identity and all 738 pre-extraction outcomes',()=>{
  for(const api of [legacyJoin,legacyResults])for(const [key,value]of Object.entries(api))if(key!=='describeWitnessResult')assert.equal(value,values[key],key);
  assert.equal(Object.hasOwn(values,'describeWitnessResult'),false,'human wording stays in the native adapter');
  assert.equal(legacyVocabulary.combinedAssurance,values.combinedAssurance);assert.equal(captured.cases.length,738);
  for(const row of captured.cases){let outcome;try{outcome={value:({...values,describeWitnessResult:legacyResults.describeWitnessResult})[row.method](...row.args)};}catch(error){outcome={error:{name:error.name,message:error.message,code:error.code}};}
    assert.deepEqual(JSON.parse(JSON.stringify(outcome)),row.outcome,row.method);}
});
test('the extracted join, witness and assurance rule bodies retain their original syntax tokens',async()=>{
  const found=new Map();
  for(const relative of ['../src/kernel/verification-witnesses.mjs','../src/evidence/vocabulary.mjs','../src/verification/witness-results.mjs']){
    const text=await readFile(new URL(relative,import.meta.url),'utf8'),ast=ts.createSourceFile(relative,text,ts.ScriptTarget.Latest,true);
    const visit=node=>{if(ts.isFunctionDeclaration(node)&&node.name&&node.body){const scanner=ts.createScanner(ts.ScriptTarget.Latest,true,ts.LanguageVariant.Standard,node.body.getText(ast)),tokens=[];let token;
      while((token=scanner.scan())!==ts.SyntaxKind.EndOfFileToken)tokens.push(scanner.getTokenText());found.set(node.name.text,createHash('sha256').update(JSON.stringify(tokens)).digest('hex'));}
      ts.forEachChild(node,visit);};visit(ast);
  }
  for(const [key,digest]of Object.entries(captured.fingerprints))assert.equal(found.get(key.split(':').at(-1)),digest,key);
});
for(const row of captured.discovery)test('native '+row.name+' discovery preserves exact captured declarations, gaps and command profiles',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'sflow-native-witness-parity-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'package.json'),'{"type":"module"}');
  for(const [file,text]of Object.entries(row.files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}
  let outcome;try{outcome={value:await discoverAcceptanceWitnesses(root,row.phase,row.args)};}catch(error){outcome={error:{name:error.name,message:error.message,code:error.code}};}
  assert.deepEqual(JSON.parse(JSON.stringify(outcome)),row.outcome);
});
test('value discovery requests bytes and adapter observations without acquiring a checkout or authority',()=>{
  const row=captured.discovery.find(row=>row.name==='node'),replay=discoverAcceptanceWitnessesReplay(row.phase,row.args);let step=replay.next(),requests=[];
  while(!step.done){const request=step.value;requests.push(request.kind);let reply;
    if(request.kind==='witness-test-commands')reply=row.phase.qualityCommands;
    else if(request.kind==='witness-command-for-file')reply=request.commands[0];
    else if(request.kind==='witness-declarations'){
      const result=scanJavaScriptDeclarations(row.files[request.files[0]],{sourcePath:request.files[0],framework:'node:test'});
      reply={declarations:result.declarations,unattachedTags:result.unattachedTags.map(tag=>({sourcePath:request.files[0],...tag})),fileGaps:{}};
    }else assert.fail(request.kind);step=replay.next(reply);
  }
  assert.deepEqual(step.value,row.outcome.value);assert.deepEqual(requests,['witness-test-commands','witness-command-for-file','witness-declarations']);
});
test('runner disambiguation reads source only for overlapping commands and preserves native runner names',()=>{
  const commands=[{id:'unit-tests',affectedRoots:['.'],ecosystem:'node',argv:['npm','test'],result:{adapter:'jest-json',path:'result.json'}},
    {id:'playwright-tests',affectedRoots:['.'],ecosystem:'node',argv:['npx','playwright','test'],result:{adapter:'playwright-json',path:'result.json'}}];
  const one=commandForTestFileReplay(commands.slice(0,1),'test/app.test.js');assert.equal(one.next().value,commands[0]);
  const replay=commandForTestFileReplay(commands,'test/app.test.js'),step=replay.next();assert.deepEqual(step.value,{kind:'witness-command-source',file:'test/app.test.js'});
  assert.equal(replay.next("import {test} from '@playwright/test';").value,commands[1]);
});
