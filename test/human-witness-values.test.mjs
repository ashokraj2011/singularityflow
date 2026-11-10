import test from 'node:test';import assert from 'node:assert/strict';
import {witnessRecordPolicies,WITNESS_CHECKLIST} from '../src/kernel/human-witnesses.mjs';
import {NODE_TEXT_DIGESTS} from '../src/records.mjs';
import * as native from '../src/verification/witness-records.mjs';
import {readFile} from 'node:fs/promises';
const captured=JSON.parse(await readFile(new URL('./fixtures/human-witnesses/native-v1.json',import.meta.url),'utf8'));
const rules=witnessRecordPolicies(NODE_TEXT_DIGESTS),sha='sha256:'+'a'.repeat(64),clauseId='EXAMPLE:AC-001',file='evidence/screen.png',
  workflow=()=>({workItem:{id:'example'},phaseOrder:['plan','code'],phases:{plan:{id:'plan',claimMaps:{planned:{sha256:'b'.repeat(64)}}},
    code:{id:'code',generation:1,generationCommit:'c'.repeat(40),deliveryEvidence:{sourceTreeSha256:'d'.repeat(64),testInputSha256:'e'.repeat(64),
      fulfillment:[{clauseId,fulfillment:'evidence',paths:[{path:file,state:'present',sha256:sha}]}]}}}}),
  input=()=>({clauseId,file,sha256:sha,slot:{slot:'screen',method:'visual',witness:{target:'example-screen'}},
    plannedClaim:{fulfillment:'evidence',expectedPaths:[file]},answers:Object.fromEntries(WITNESS_CHECKLIST.map(key=>[key,'yes'])),
    reason:'The reviewer inspected the exact retained result.',actor:'independent-reviewer',authorityGroup:'reviewers',at:'2026-11-08T00:00:00.000Z'});
test('native human witness compatibility matches frozen pre-extraction results and errors',()=>{
  for(const row of captured.contexts){assert.equal(native.witnessContextBinding(row.workflow,row.options),row.outcome);
    assert.equal(rules.witnessContextBinding(row.workflow,row.options),row.outcome);}
  for(const row of captured.cases){const w=structuredClone(row.workflow);let outcome;
    try{outcome={record:native.recordWitness(w,row.input),workflow:w};}catch(error){outcome={error:{name:error.name,code:error.code,message:error.message,details:error.details??null},workflow:w};}
    assert.deepEqual(outcome,row.outcome,row.name);}
});
test('human witness rules retain native context hashes, records, negative answers and active-result meanings',()=>{
  for(const deny of [false,true]){const before=workflow(),a=structuredClone(before),b=structuredClone(before),value=input();
    if(deny)value.answers['matches-the-criterion']='no';
    assert.equal(rules.witnessContextBinding(a),native.witnessContextBinding(b));
    assert.equal(rules.witnessContextBinding(a,{legacy:true}),native.witnessContextBinding(b,{legacy:true}));
    const observed=native.publishedRetainedEvidence(a),actual=rules.recordWitnessWithEvidence(a,value,observed),expected=native.recordWitness(b,value);
    assert.deepEqual(actual,expected);assert.deepEqual(a,b);
    for(const current of [new Map([[file,sha]]),new Map([[file,'sha256:'+'f'.repeat(64)]]),new Map()]){
      const contextBinding=rules.witnessContextBindings(a);
      assert.deepEqual(rules.witnessRecordResults(a.witnessRecords,current,{contextBinding}),native.witnessRecordResults(b.witnessRecords,current,{contextBinding}));}
  }
});
test('shared witness values require actual publication observations and explicit bound checklist answers',()=>{
  const w=workflow(),value=input();
  assert.throws(()=>rules.recordWitnessWithEvidence(w,value),error=>error.code==='WITNESS_EVIDENCE_UNPUBLISHED'&&error.details.file===file);
  assert.equal(w.witnessRecords,undefined);
  const published=native.publishedRetainedEvidence(w);
  assert.throws(()=>rules.recordWitnessWithEvidence(w,{...value,answers:{}},published),{code:'WITNESS_RECORD_INVALID'});
  assert.throws(()=>rules.recordWitnessWithEvidence(w,value,published,'invented-ready'),{code:'WITNESS_RECORD_INVALID'});
  const context='sha256:'+'1'.repeat(64),record=rules.recordWitnessWithEvidence(w,value,published,context);
  assert.equal(record.contextBinding,context);assert.equal(rules.witnessRecordResults([record],new Map([[file,sha]]),{contextBinding:context})[0].status,'met');
  assert.equal(rules.witnessRecordResults([record],new Map([[file,sha]]),{contextBinding:'sha256:'+'2'.repeat(64)})[0].status,'missing');
});
