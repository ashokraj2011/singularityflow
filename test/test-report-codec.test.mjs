import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import ts from 'typescript';
import * as legacy from '../src/code-delivery-tests.mjs';
import {createTestReportCodec,TEST_REPORT_BYTE_SYNTAX,parseXml,nodeTestObservation,jsonTestReport} from '../src/kernel/test-report-codec.mjs';
import {createNodeTestReportCodec} from '../src/verification/test-report-reader.mjs';
import {nodeTestReporterEnvironment} from '../src/verification/node-test-observation.mjs';
import * as observations from '../src/verification/node-test-observation.mjs';
import * as markers from '../src/test-module-markers.mjs';
import * as runtime from '../src/test-runtime.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const packet=JSON.parse(await readFile(new URL('./fixtures/test-report-packets/native-v1.json',import.meta.url)));
const bytes=Object.freeze({profile:TEST_REPORT_BYTE_SYNTAX,from:Buffer.from.bind(Buffer),alloc:Buffer.alloc.bind(Buffer),concat:Buffer.concat.bind(Buffer),
  sha256:value=>createHash('sha256').update(value).digest('hex')});
function inputs(c){const reports=c.reports?.map(value=>({contents:value.hex?Buffer.from(value.hex,'hex'):Buffer.from(value.text)}));
  if(c.method==='replayTestReports')return [c.adapter,reports];
  if(c.method==='replayLocalJavascriptJsonObservation')return [reports,c.adapter];
  if(c.method==='junitCaseLocations')return [reports.map(value=>value.contents)];
  if(c.method.startsWith('parse')&&c.method!=='parseXml')return [Buffer.from(c.value)];return [reports??c.value];}
for(const [name,factory] of [['native compatibility facade',()=>legacy],['explicit Node reader',createNodeTestReportCodec],['pure explicit byte capability',()=>createTestReportCodec(bytes)]]) {
  test(name+' preserves all captured native report values and errors',async t=>{
    const codec=factory();
    for(const c of packet.cases)await t.test(c.id,async()=>{
      if(c.prepare)await codec.prepareTestReportReader(c.adapter);
      let actual;try{actual={value:codec[c.method](...inputs(c))};}
      catch(error){actual={error:{name:error.name,code:error.code??null,message:error.message,details:error.details??null}};}
      assert.deepEqual(JSON.parse(JSON.stringify(actual)),c.expected,c.id);
    });
  });
}
test('all 38 extracted rule bodies retain their original syntax and native exports retain their identity',async()=>{
  assert.deepEqual(Object.keys(legacy).sort(),packet.api);
  assert.equal(legacy.parseXml,parseXml);assert.equal(observations.nodeTestObservation,nodeTestObservation);assert.equal(markers.jsonTestReport,jsonTestReport);
  assert.equal(observations.nodeTestReporterEnvironment,runtime.nodeTestReporterEnvironment);
  assert.equal(Object.getPrototypeOf(parseXml('<root/>').attributes),null);
  const source=await readFile(new URL('../src/kernel/test-report-codec.mjs',import.meta.url),'utf8');
  const tree=ts.createSourceFile('test-report-codec.mjs',source,ts.ScriptTarget.Latest,true);
  const printer=ts.createPrinter({removeComments:true,newLine:ts.NewLineKind.LineFeed}),found=new Map();
  function visit(node){if(ts.isFunctionDeclaration(node)&&packet.bodies[node.name?.text]){
    assert.equal(found.has(node.name.text),false);found.set(node.name.text,createHash('sha256').update(printer.printNode(ts.EmitHint.Unspecified,node.body,tree)).digest('hex'));}
    ts.forEachChild(node,visit);}
  visit(tree);assert.deepEqual(Object.fromEntries([...found].sort()),Object.fromEntries(Object.entries(packet.bodies).sort()));
});
test('report syntax is captured without invoking functions or getters',()=>{
  let calls=0;const fake=Object.freeze({...bytes,from(){calls++;throw Error('No eager byte conversion.');},sha256(){calls++;throw Error('No eager digest.');}});
  createTestReportCodec(fake);assert.equal(calls,0);
  const getter={...bytes};Object.defineProperty(getter,'from',{get(){throw Error('Getter was invoked.');}});Object.freeze(getter);
  assert.throws(()=>createTestReportCodec(getter),{code:'ENGINE_TEST_REPORT_SYNTAX_INVALID'});
  assert.throws(()=>createTestReportCodec({...bytes}),{code:'ENGINE_TEST_REPORT_SYNTAX_INVALID'});
});
test('real Node execution keeps exact test identities and counts through the same portable reader',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-report-codec-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const file=path.join(directory,'arithmetic.test.mjs');
  await writeFile(file,"import test from 'node:test';import assert from 'node:assert/strict';\ntest('adds',()=>assert.equal(1+1,2));\ntest.skip('later',()=>{});\n");
  const env=await nodeTestReporterEnvironment(process.env,directory,{argv:[process.execPath,'--test',file]});
  const result=await promisify(execFile)(process.execPath,['--test',file],{cwd:directory,env,timeout:30_000,maxBuffer:4*1024*1024});
  const parsed=createNodeTestReportCodec().replayTestReports('node-tap',[{contents:result.stdout}]);
  assert.deepEqual(parsed.tests,{discovered:2,passed:1,failed:0,skipped:1});
  assert.deepEqual(parsed.testcaseObservation.occurrences.map(value=>[value.file,value.name,value.outcome]),[
    ['arithmetic.test.mjs','adds','passed'],['arithmetic.test.mjs','later','skipped']]);
  assert.equal(Object.hasOwn(parsed,'verified'),false);assert.equal(Object.hasOwn(parsed,'approval'),false);
});
