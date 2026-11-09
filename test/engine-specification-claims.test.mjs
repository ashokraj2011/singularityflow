import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import * as native from '../src/specifications.mjs';
import * as nodeValues from '../src/engine-compatibility/node-specification-policy.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../src/engine-compatibility/node-configuration-path.mjs';
import {NODE_TEXT_VALUE_SYNTAX} from '../src/records.mjs';
import {specificationClaimPolicies,SPECIFICATION_CLAIM_TIMESTAMP_REQUEST,FULFILLMENT_TYPES} from '../src/kernel/specification-values.mjs';
import {SPECIFICATION_CLAIM_MAP_SCHEMA,canonicalJson} from '../src/foundation/record-schema.mjs';
import {schemaFamily} from '../src/schema-migrations.mjs';
import {specificationClaimCases,nativeSpecificationClaimOutcome,CLAIM_CAPTURE_TIME} from './helpers/specification-claims-fixture.mjs';

const oracle=JSON.parse(await readFile(new URL('./fixtures/specification-claims/native-v2.json',import.meta.url),'utf8'));
const capturedSyntax=Object.freeze({...NODE_CONFIGURATION_PATH_SYNTAX,grammar:'posix',isAbsolute:path.posix.isAbsolute,
  normalize:path.posix.normalize,parse:path.posix.parse,toPosix:value=>value.split('/').join('/')});
const rules=specificationClaimPolicies(capturedSyntax,NODE_TEXT_VALUE_SYNTAX);
const hostRules=specificationClaimPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_VALUE_SYNTAX);
const claimDigest=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
function sharedOutcome(entry,api=rules) {
  let clocks=0;
  try {
    const method=api[entry.operation+'Replay'];let result;
    if(method){const replay=method(...structuredClone(entry.args));let step=replay.next();while(!step.done){
      assert.equal(step.value,SPECIFICATION_CLAIM_TIMESTAMP_REQUEST);clocks++;step=replay.next(CLAIM_CAPTURE_TIME);
    }result=step.value;}else result=api[entry.operation](...structuredClone(entry.args));
    return {result:result??null,clocks};
  }catch(error){return {error:{name:error.name,code:error.code??null,message:error.message,details:error.details??null},clocks};}
}

test('shared claim-map rules retain the independent native v2 records, diagnostics and clock counts',()=>{
  assert.equal(oracle.capturedAtCommit,'ce8f198f0');assert.equal(oracle.cases.length,111);
  assert.deepEqual(oracle.cases.map(({outcome,...entry})=>entry),specificationClaimCases());
  for(const entry of oracle.cases){
    const shared=sharedOutcome(entry);
    const compatibility=nativeSpecificationClaimOutcome(native,entry);
    assert.deepEqual(JSON.parse(JSON.stringify(shared)),entry.outcome,'shared wire '+entry.name);
    assert.deepEqual(sharedOutcome(entry,hostRules),compatibility,'host rules and in-memory keys '+entry.name);
    if(entry.outcome.result?.schemaVersion)assert.equal(claimDigest(shared.result),claimDigest(entry.outcome.result),entry.name+' record identity');
  }
});

test('explicit POSIX and Win32 value syntax preserves legacy normalization and strict authored-path refusal',()=>{
  const win32=specificationClaimPolicies(Object.freeze({...NODE_CONFIGURATION_PATH_SYNTAX,grammar:'win32',
    isAbsolute:path.win32.isAbsolute,normalize:path.win32.normalize,parse:path.win32.parse,
    toPosix:value=>value.split('\\').join('/')}),NODE_TEXT_VALUE_SYNTAX);
  const input=oracle.cases.find(entry=>entry.name==='paths-'+JSON.stringify(['src\\value.js']));
  assert.deepEqual(sharedOutcome(input).result.claims['CLAIM:REQ-001'].expectedPaths,['src\\value.js']);
  assert.deepEqual(sharedOutcome(input,win32).result.claims['CLAIM:REQ-001'].expectedPaths,['src/value.js']);
  const authored=structuredClone(oracle.cases.find(entry=>entry.name==='inspect-complete'));
  authored.args[0]=authored.args[0].replace('`src/value.js`','`src\\value.js`');
  for(const api of [rules,win32]) {
    const result=sharedOutcome(authored,api).result;
    assert.equal(result.valid,false);assert.equal(result.claimMap,null);
    assert.ok(result.diagnostics.some(finding=>/platform-specific syntax/u.test(finding.message)));
  }
});

test('validation happens before time; serialized UTF-8 size is checked after the timestamp',()=>{
  const before=oracle.cases.find(entry=>entry.name==='unknown-clause');
  const invalid=rules.normalizeClaimMapReplay(...before.args);
  assert.throws(()=>invalid.next(),{code:'SPEC_CLAIM_MAP_UNKNOWN_CLAUSE'});
  assert.equal(before.outcome.clocks,0);
  const bounded=oracle.cases.find(entry=>entry.name==='byte-limit-after-clock');
  const replay=rules.normalizeClaimMapReplay(...bounded.args);
  assert.equal(replay.next().value,SPECIFICATION_CLAIM_TIMESTAMP_REQUEST);
  assert.throws(()=>replay.next(CLAIM_CAPTURE_TIME),/planned claim map exceeds 100 bytes/u);
  assert.equal(bounded.outcome.clocks,1);
  const projection=oracle.cases.find(entry=>entry.name==='projection-bad-path');
  const observed=rules.deriveObservedClaimMapReplay(...projection.args);
  assert.equal(observed.next().value,SPECIFICATION_CLAIM_TIMESTAMP_REQUEST,'the reviewed plan is normalized first');
  assert.throws(()=>observed.next(CLAIM_CAPTURE_TIME),/repository-relative/u);
});

test('a real clock failure stays the same failure for direct normalization',()=>{
  const replay=rules.normalizeClaimMapReplay({claims:{}},{kind:'planned'}),failure=new Error('Clock unavailable');
  assert.equal(replay.next().value,SPECIFICATION_CLAIM_TIMESTAMP_REQUEST);
  assert.throws(()=>replay.throw(failure),error=>error===failure);
});

test('planning inspection retains its original diagnostic handling at nested clock checkpoints',()=>{
  const input=oracle.cases.find(entry=>entry.name==='inspect-complete');
  const replay=rules.inspectPlannedClaimMapReplay(...input.args),failure=Object.assign(new Error('Clock unavailable'),{code:'CLOCK_UNAVAILABLE'});
  let step=replay.next(),requests=0;
  while(!step.done){assert.equal(step.value,SPECIFICATION_CLAIM_TIMESTAMP_REQUEST);requests++;step=replay.throw(failure);}
  assert.equal(requests,3,'two row normalizations followed by the whole map');
  assert.equal(step.value.valid,false);assert.equal(step.value.claimMap,null);
  assert.equal(step.value.diagnostics.length,3);
  assert.ok(step.value.diagnostics.every(finding=>finding.code==='CLOCK_UNAVAILABLE'&&finding.message==='Clock unavailable'));
});

test('claim-map candidate replay can reproduce retained timestamps without an ambient clock or filesystem',()=>{
  const sample=oracle.cases.find(entry=>entry.name==='ordinary');
  const replay=rules.normalizeClaimMapReplay(...sample.args);let step=replay.next();
  assert.equal(step.value,SPECIFICATION_CLAIM_TIMESTAMP_REQUEST);
  step=replay.next(sample.outcome.result.recordedAt);
  assert.equal(step.done,true);assert.deepEqual(step.value,sample.outcome.result);
  assert.equal(claimDigest(step.value),claimDigest(sample.outcome.result));
  assert.equal(Object.hasOwn(step.value,'accepted'),false);
  assert.equal(Object.hasOwn(step.value,'approved'),false);
});

test('native and optional Node utilities use one shared fulfillment and claim-rule owner',()=>{
  assert.equal(native.FULFILLMENT_TYPES,FULFILLMENT_TYPES);
  for(const name of ['validatePlannedEvidenceTypes','planSupportingFiles','testOnlyClaimEvidence'])assert.equal(native[name],nodeValues[name],name);
  const sample=oracle.cases.find(entry=>entry.name==='projection-exact-bindings');
  assert.deepEqual(sharedOutcome(sample,nodeValues),sample.outcome);
  assert.deepEqual(FULFILLMENT_TYPES,['new','modified','existing','removed','test-only','document','configuration','evidence']);
});

test('v2 claim-map read metadata retains the installed v1 migration and authority classification',()=>{
  const family=schemaFamily('specification-claim-map');
  for(const [key,value] of Object.entries(SPECIFICATION_CLAIM_MAP_SCHEMA))assert.equal(family[key],value,key);
  assert.equal(family.model,'never');assert.equal(family.steps.length,1);
  assert.equal(family.steps[0].from,1);assert.equal(family.steps[0].to,2);
});

test('claim factories capture only frozen syntax and never execute a primitive or clock at construction',()=>{
  let calls=0;
  const syntax=Object.freeze({...NODE_TEXT_VALUE_SYNTAX,byteLengthUtf8(value){calls++;return Buffer.byteLength(value);},sha256Utf8(value){calls++;return createHash('sha256').update(value).digest('hex');}});
  const fresh=specificationClaimPolicies(NODE_CONFIGURATION_PATH_SYNTAX,syntax);
  assert.equal(calls,0);assert.ok(Object.isFrozen(fresh));
  assert.throws(()=>specificationClaimPolicies(NODE_CONFIGURATION_PATH_SYNTAX,{...syntax}),{code:'ENGINE_TEXT_VALUE_SYNTAX_INVALID'});
  const replay=fresh.normalizeClaimMapReplay({claims:{}},{kind:'planned'});
  assert.equal(replay.next().value,SPECIFICATION_CLAIM_TIMESTAMP_REQUEST);assert.equal(calls,0);
  const result=replay.next(CLAIM_CAPTURE_TIME);assert.equal(result.done,true);assert.equal(calls,1);
});
