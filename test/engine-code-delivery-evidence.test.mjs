import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {codeDeliveryEvidencePolicies,clauseTagExplanation} from '../src/kernel/code-delivery-evidence.mjs';
import {TEST_DELIVERY_POLICY_FACTS,REPOSITORY_CHANGE_SET_VALUES} from '../src/kernel/source-path-policies.mjs';
import {TEST_REPORT_BYTE_SYNTAX} from '../src/kernel/test-report-codec.mjs';
import {canonicalJson} from '../src/foundation/record-schema.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX,TEST_COMMAND_ECOSYSTEMS} from '../src/engine-compatibility/node-configuration-path.mjs';
import * as native from '../src/engine-compatibility/node-source-policy.mjs';
import {GOVERNED_ROOTS} from '../src/governed-roots.mjs';
import {ecosystemOfAdapter,ecosystemOfProgram} from '../src/test-runners.mjs';
import {verifyCodeDeliveryReceipt} from '../src/delivery-evidence.mjs';
import {readRecord} from '../src/schema-migrations.mjs';
import {scanJavaScriptDeclarations} from '../src/verification/javascript-declarations.mjs';
import {scanSourceClauseTags} from '../src/source-clause-tags.mjs';
import {codeDeliveryReplayFixture,codeDeliveryReplayCases,receiptReplayProjection} from './helpers/code-delivery-replay-fixture.mjs';

const original=JSON.parse(await readFile(new URL('./fixtures/code-delivery-evidence/native-v2.json',import.meta.url),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const testFacts=Object.freeze({profile:TEST_DELIVERY_POLICY_FACTS,ecosystems:TEST_COMMAND_ECOSYSTEMS,
  posixExtname:path.posix.extname,ecosystemOfAdapter,ecosystemOfProgram});
const changeValues=Object.freeze({profile:REPOSITORY_CHANGE_SET_VALUES,sha256Text:value=>'sha256:'+hash(value),
  compareUtf8:(left,right)=>Buffer.compare(Buffer.from(left,'utf8'),Buffer.from(right,'utf8'))});
const byteSyntax=extra=>Object.freeze({profile:TEST_REPORT_BYTE_SYNTAX,
  from:Buffer.from.bind(Buffer),alloc:Buffer.alloc.bind(Buffer),concat:Buffer.concat.bind(Buffer),sha256:hash,...extra});
const rules=syntax=>codeDeliveryEvidencePolicies(NODE_CONFIGURATION_PATH_SYNTAX,GOVERNED_ROOTS,testFacts,changeValues,syntax??byteSyntax());
const outcome=async invoke=>{try{return {value:receiptReplayProjection(await invoke())};}
  catch(error){return {error:{name:error.name,message:error.message,code:error.code??null}};}};

async function drive(plan,read){
  let step=plan.next();
  while(!step.done){let answer;try{answer=await read(step.value);}catch(error){step=plan.throw(error);continue;}step=plan.next(answer);}
  return step.value;
}

/** Raw immutable facts only: no filesystem, process, current source, publisher or ready verdict. */
function memoryReader(f,owner,overrides={}){
  return async request=>{
    assert.equal(Object.isFrozen(request),true);
    if(Object.hasOwn(overrides,request.kind))return overrides[request.kind](request);
    switch(request.kind){
      case 'generation-tree':return {status:0,stdout:f.receipt.tree.generationTree};
      case 'change-set':return {status:0,stdout:canonicalJson(f.changeSet)};
      case 'decode-record':return readRecord(request.family,request.value).record;
      case 'prepare-generation-files':case 'prepare-test-replay':return;
      case 'generation-file':return request.path==='src/app.js'?Buffer.from(f.source):request.path==='test/app.test.js'?Buffer.from(f.testSource):null;
      case 'javascript-declarations':return scanJavaScriptDeclarations(request.source,{sourcePath:request.sourcePath,framework:request.framework});
      case 'source-clause-tags':return scanSourceClauseTags(request.source,{sourcePath:request.sourcePath});
      case 'test-receipt':return structuredClone(f.record);
      case 'test-report':return Buffer.from(f.raw);
      case 'prepare-report-reader':return owner.prepareTestReportReader(request.adapter);
      default:throw Object.assign(new Error('The required evidence owner is unavailable: '+request.kind),{code:'ENGINE_PORT_UNAVAILABLE'});
    }
  };
}

test('90 independently captured native v2 outcomes retain exact errors, order and execution identities',async t=>{
  assert.equal(original.baseline,'a09cfd37f');assert.equal(original.functionSha256,'cdd20835a03d8aa9d024522eed19124b0e933491c53f9064143400c7b7db4d18');
  assert.equal(original.cases.length,90);
  const f=await codeDeliveryReplayFixture();t.after(f.close);
  const expected=new Map(original.cases.map(row=>[row.id,row.outcome]));
  for(const row of codeDeliveryReplayCases()){
    const receipt=structuredClone(f.receipt),policy={...f.policy};row.edit(receipt,policy,f);
    assert.deepEqual(await outcome(()=>verifyCodeDeliveryReceipt(f.root,receipt,policy)),expected.get(row.id),row.id);
  }
});

test('the same complete receipt replays through raw in-memory facts without a checkout or writer',async t=>{
  const f=await codeDeliveryReplayFixture();t.after(f.close);const owner=rules();
  await f.close(); // The original repository and committed objects are genuinely unavailable.
  const receipt=structuredClone(f.receipt),before=structuredClone(receipt),requests=[];
  const read=memoryReader(f,owner),result=await drive(owner.codeDeliveryReceiptReplay(receipt,f.policy),request=>{requests.push(request.kind);return read(request);});
  assert.deepEqual(receipt,before);assert.deepEqual(receiptReplayProjection(result),original.cases[0].outcome.value);
  assert.deepEqual(result.changeSet,f.changeSet);assert.equal(result.executions.length,1);assert.deepEqual(result.executions[0],f.record);
  assert.ok(requests.includes('generation-file'));assert.ok(requests.includes('test-report'));
  assert.equal(requests.some(kind=>/publish|approve|write|commit/u.test(kind)),false);
});

test('a fact reader cannot replace actual raw report replay with a ready flag or forged counts',async t=>{
  const f=await codeDeliveryReplayFixture();t.after(f.close);const owner=rules();
  const receipt=structuredClone(f.receipt),record=structuredClone(f.record);record.tests.passed=99;
  receipt.testExecutions[0].receiptSha256=hash(canonicalJson(record));
  const result=await drive(owner.codeDeliveryReceiptReplay(receipt,f.policy),memoryReader(f,owner,{'test-receipt':()=>record}));
  assert.equal(result.valid,false);assert.ok(result.errors.includes('test receipt unit module counts do not replay from its raw reports'));
  const bytes=await drive(owner.codeDeliveryReceiptReplay(f.receipt,f.policy),memoryReader(f,owner,{'test-report':()=>Buffer.from('different bytes')}));
  assert.equal(bytes.valid,false);assert.ok(bytes.errors.includes('test receipt unit raw report differs from its content address'));
  const verdict=await drive(owner.codeDeliveryReceiptReplay(f.receipt,f.policy),memoryReader(f,owner,{'test-receipt':()=>({ready:true})}));
  assert.equal(verdict.valid,false);assert.ok(verdict.errors.some(error=>error.includes("test receipt unit is unavailable: Durable record 'test-execution' has no valid schemaVersion.")));
});

test('missing readers and real permission errors keep their original failure boundaries',async t=>{
  const f=await codeDeliveryReplayFixture();t.after(f.close);const owner=rules();
  const error=Object.assign(new Error('actual retained report permission denied'),{code:'EACCES'});
  const result=await drive(owner.codeDeliveryReceiptReplay(f.receipt,f.policy),memoryReader(f,owner,{'test-report':()=>{throw error;}}));
  assert.ok(result.errors.includes('test receipt unit raw report is unavailable: actual retained report permission denied'));
  await assert.rejects(drive(owner.codeDeliveryReceiptReplay(f.receipt,f.policy),memoryReader(f,owner,{'generation-file':()=>{throw error;}})),actual=>actual===error);
  const receipt=structuredClone(f.receipt);receipt.autoCandidate={};
  const missing=await drive(owner.codeDeliveryReceiptReplay(receipt,f.policy),memoryReader(f,owner));
  assert.equal(missing.valid,false);assert.ok(missing.errors.includes('Auto Candidate binding is invalid: The required evidence owner is unavailable: auto-candidate'));
});

test('accepted risk and pin owners remain explicitly required rather than invented by the reader',async t=>{
  const f=await codeDeliveryReplayFixture();t.after(f.close);const owner=rules(),receipt=structuredClone(f.receipt),record=structuredClone(f.record);
  record.pin={id:'original'};receipt.testExecutions[0].receiptSha256=hash(canonicalJson(record));
  await assert.rejects(drive(owner.codeDeliveryReceiptReplay(receipt,f.policy),memoryReader(f,owner,{'test-receipt':()=>record})),{code:'ENGINE_PORT_UNAVAILABLE'});
  const risks=structuredClone(f.receipt);risks.testExecutions[0].testRunRisk={id:'original'};
  await assert.rejects(drive(owner.codeDeliveryReceiptReplay(risks,{...f.policy,testRunRisks:{workflow:{}}}),memoryReader(f,owner)),{code:'ENGINE_PORT_UNAVAILABLE'});
});

test('construction captures explicit primitives without invoking them and rejects accessors',()=>{
  let calls=0,getters=0;const error=Object.freeze(Object.assign(new Error('actual byte hashing unavailable'),{code:'HASH_UNAVAILABLE'}));
  const owner=rules(byteSyntax({sha256(){calls++;throw error;},from(){calls++;throw error;}}));
  assert.equal(calls,0);assert.throws(()=>owner.bindingsDigest([]),actual=>actual===error);assert.equal(calls,1);
  const invalid=Object.freeze({...byteSyntax(),get sha256(){getters++;return hash;}});
  assert.throws(()=>rules(invalid),{code:'ENGINE_TEST_REPORT_SYNTAX_INVALID'});assert.equal(getters,0);
  assert.throws(()=>rules({...byteSyntax()}),{code:'ENGINE_TEST_REPORT_SYNTAX_INVALID'});
  assert.throws(()=>rules(byteSyntax({sha256:()=>({valid:true})})).bindingsDigest([]),{code:'ENGINE_CODE_DELIVERY_DIGEST_INVALID'});
});

test('native materialization and content identities share the extracted rule instances',async()=>{
  const materialization=await import('../src/configuration-materialization.mjs'),bindings=await import('../src/implementation-bindings.mjs');
  const corner=await import('../src/verification/corner-case-obligations.mjs');
  assert.equal(materialization.approvedConfigurationMaterializations,native.approvedConfigurationMaterializations);
  assert.equal(materialization.evaluateStoryProtectedPaths,native.evaluateStoryProtectedPaths);
  assert.equal(bindings.bindingsDigest,native.implementationBindingsDigest);assert.equal(corner.cornerCaseMatrixDigest,native.cornerCaseMatrixDigest);
  assert.equal(bindings.clauseTagExplanation,clauseTagExplanation);
  const matrix={schemaVersion:1,status:'satisfied',summary:{inadequateDeclarations:0},harness:'ignored',obligations:['ignored']};
  assert.equal(native.cornerCaseMatrixDigest(matrix),'sha256:'+hash(canonicalJson({schemaVersion:1,status:'satisfied',summary:{inadequateDeclarations:0}})));
});
