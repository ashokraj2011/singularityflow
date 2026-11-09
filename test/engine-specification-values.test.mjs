import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as native from '../src/specifications.mjs';
import * as nativeContracts from '../src/verification/contracts.mjs';
import * as nativeIntent from '../src/verification/intent.mjs';
import * as nativeDiagnostics from '../src/draft-diagnostics.mjs';
import * as values from '../src/kernel/specification-values.mjs';
import * as verification from '../src/kernel/verification-policy.mjs';
import * as diagnostics from '../src/kernel/draft-diagnostics.mjs';
import * as nodeValues from '../src/engine-compatibility/node-specification-policy.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../src/engine-compatibility/node-configuration-path.mjs';
import {canonicalJson,SPECIFICATION_INDEX_SCHEMA,TEXT_DIGEST_PROFILE} from '../src/foundation/record-schema.mjs';
import {normalizeSpecPolicy} from '../src/kernel/configuration-policy.mjs';
import {schemaFamily} from '../src/schema-migrations.mjs';
import {specificationValueOutcome,specificationValueCases} from './helpers/specification-values-fixture.mjs';

const oracle=JSON.parse(await readFile(new URL('./fixtures/specification-values/native-v1.json',import.meta.url),'utf8'));
const digests=Object.freeze({profile:TEXT_DIGEST_PROFILE,sha256Utf8:text=>createHash('sha256').update(text).digest('hex')});
const shared={...values,...verification,...diagnostics,canonicalJson,
  ...values.specificationValuePolicies(digests),...verification.verificationContractPolicies(NODE_CONFIGURATION_PATH_SYNTAX,digests)};
const legacy={...native,...nativeContracts,...nativeIntent,...nativeDiagnostics};

test('shared specification and verification values retain the independent pre-extraction native outcomes',()=>{
  assert.equal(oracle.capturedAtCommit,'60002eefe');
  assert.equal(oracle.cases.length,89);
  assert.deepEqual(oracle.cases.map(({outcome,...entry})=>entry),specificationValueCases(),'oracle inputs are explicit and cannot silently drift');
  for(const entry of oracle.cases) {
    assert.deepEqual(specificationValueOutcome(shared,entry),entry.outcome,'shared: '+entry.name);
    assert.deepEqual(specificationValueOutcome(legacy,entry),entry.outcome,'compatibility: '+entry.name);
  }
});

test('the native facades expose the same rule instances and share one diagnostic overflow ledger',()=>{
  for(const name of ['ignoredRanges','isIgnored','clauseReferences','plannedClaimSource'])assert.equal(native[name],values[name],name);
  for(const name of ['parseVerificationIntent','nonTestVerification','validatePlannedVerification'])assert.equal(nativeIntent[name],verification[name],name);
  for(const [name,rule] of Object.entries(nativeContracts))assert.equal(rule,name==='VERIFICATION_METHODS'?verification[name]:nodeValues[name],name);
  assert.equal(native.extractClauses,nodeValues.extractClauses);
  assert.equal(native.canonicalJson,canonicalJson);
  for(const name of Object.keys(nativeDiagnostics))assert.equal(nativeDiagnostics[name],diagnostics[name],name);
  const findings=[];
  for(let index=0;index<260;index++)(index%2?nativeDiagnostics:diagnostics).collectDraftDiagnostic(findings,{message:'Invalid path.'},{line:index});
  assert.deepEqual(nativeDiagnostics.draftDiagnosticSummary(findings),{maximum:256,omitted:4,complete:false});
  assert.deepEqual(diagnostics.draftDiagnosticSummary(findings),nativeDiagnostics.draftDiagnosticSummary(findings));
});

test('actual native index bytes and portable value construction retain four independently captured records',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'sflow-shared-spec-index-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const entry of oracle.indexes) {
    const bytes=entry.bytes?Buffer.from(entry.bytes):Buffer.from(entry.text);
    await writeFile(path.join(root,'spec.md'),bytes);
    const actual=await native.buildSpecIndex(root,'spec.md',{...entry.options,write:false});
    assert.deepEqual(actual,entry.index,'native: '+entry.name);
    const policy=normalizeSpecPolicy(entry.options.policy??{});
    const clauses=shared.extractClauses(bytes.toString('utf8'),{sourcePath:'spec.md',namespace:policy.namespace,limits:policy.limits});
    const source={path:'spec.md',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
    const candidate=shared.specificationIndexRecord({...entry.options,source,clauses});
    assert.deepEqual(candidate,entry.index,'portable: '+entry.name);
    assert.equal(Object.hasOwn(candidate,'recordedAt'),false);
    assert.equal(Object.hasOwn(candidate,'kind'),false);
    if(entry.bytes)assert.notEqual(candidate.source.sha256,createHash('sha256').update(bytes.toString('utf8')).digest('hex'),
      'an observed raw-byte hash must not become a hash of replacement characters');
  }
});

test('native index writing remains canonical and invalid policy is still checked before file discovery',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'sflow-spec-index-write-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const input=oracle.indexes[0];
  await writeFile(path.join(root,'spec.md'),input.text);
  const index=await native.buildSpecIndex(root,'spec.md',{...input.options,outputPath:'context/index.json'});
  assert.equal(await readFile(path.join(root,'context/index.json'),'utf8'),canonicalJson(index));
  await assert.rejects(native.buildSpecIndex(root,'absent.md',{policy:{mode:'invalid'}}),error=>/spec\.mode/u.test(error.message));
  await assert.rejects(native.buildSpecIndex(root,'absent.md'),error=>/Specification artifact/u.test(error.message)&&!/spec\.mode/u.test(error.message));
  await mkdir(path.join(root,'directory'));
  await assert.rejects(native.buildSpecIndex(root,'directory'),error=>/Specification artifact/u.test(error.message));
});

test('native source paths retain actual escape refusal instead of becoming candidate value data',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'sflow-spec-index-path-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'outside.md'),'[VALUE:REQ-001] Exact source.');
  await mkdir(path.join(root,'checkout'));
  await symlink(path.join(root,'outside.md'),path.join(root,'checkout','escape.md'));
  await assert.rejects(native.buildSpecIndex(path.join(root,'checkout'),'escape.md'),error=>/outside|symlink|symbolic/u.test(error.message));
});

test('specification-index v1 retains the native family identity and migration policy',()=>{
  const family=schemaFamily('specification-index');
  for(const [key,value] of Object.entries(SPECIFICATION_INDEX_SCHEMA))assert.equal(family[key],value,key);
  assert.equal(family.model,'never');
  assert.deepEqual(family.steps,[]);
});

test('constructing the rule sets captures frozen primitives without executing them or inspecting a checkout',()=>{
  let calls=0;
  const bound=Object.freeze({profile:TEXT_DIGEST_PROFILE,sha256Utf8(text){calls++;return createHash('sha256').update(text).digest('hex');}});
  const spec=values.specificationValuePolicies(bound);
  const contracts=verification.verificationContractPolicies(NODE_CONFIGURATION_PATH_SYNTAX,bound);
  assert.equal(calls,0);
  assert.ok(Object.isFrozen(spec));assert.ok(Object.isFrozen(contracts));
  assert.equal(contracts.contractSha256(null),null);
  assert.equal(calls,0);
  assert.equal(spec.extractClauses('[VALUE:REQ-001] Exact.').length,1);
  assert.equal(calls,1);
  assert.throws(()=>values.specificationValuePolicies({...bound}),{code:'ENGINE_TEXT_DIGEST_PORT_INVALID'});
  assert.throws(()=>verification.verificationContractPolicies({...NODE_CONFIGURATION_PATH_SYNTAX},bound),{code:'ENGINE_CONFIGURATION_PATH_SYNTAX_INVALID'});
  const invalid=values.specificationValuePolicies(Object.freeze({profile:TEXT_DIGEST_PROFILE,sha256Utf8:()=> 'accepted'}));
  assert.throws(()=>invalid.extractClauses('[VALUE:REQ-001] Exact.'),{code:'ENGINE_TEXT_DIGEST_RESULT_INVALID'});
});

test('exact source body, dependencies and verification intent stay deterministic across rule instances',()=>{
  const entry=oracle.cases.find(entry=>entry.name==='intent-index');
  const again=values.specificationValuePolicies(digests);
  assert.deepEqual(shared.extractClauses(...entry.args),again.extractClauses(...entry.args));
  assert.deepEqual(shared.extractClauses(...entry.args).map(clause=>clause.verification),[
    {methods:['visual'],criterionId:'VALUE:AC-001'},{methods:['visual'],criterionId:'VALUE:AC-001'}]);
  const contract=oracle.cases.find(entry=>entry.name==='contract-default').outcome.result[0];
  assert.equal(shared.contractSha256(contract),nodeValues.contractSha256(contract));
});
