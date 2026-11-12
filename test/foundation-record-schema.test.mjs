import test from 'node:test';
import assert from 'node:assert/strict';
import { admitRecordSchemaVersion, COMMAND_TIMING_SCHEMA, CONTENT_STORAGE_SCHEMA, NAMESPACE_READER_SCHEMAS, NAMESPACE_PHASE_POLICY_SCHEMAS, namespaceCodePolicyProfile, namespaceCodePolicyVersionsMatch, namespaceConformancePolicyProfile,namespacePreparedPayloadProfile,namespaceWitnessContextProfile,namespaceGenerationProfile,namespacePlanCorrectionRecordProfile } from '../src/foundation/record-schema.mjs';
import { NAMESPACE_STORAGE_SCHEMAS, SQLITE_NAMESPACE_SCHEMAS,
  admitNamespaceStorageSchema, admitSqliteNamespaceSchema } from '../src/sda/namespace/storage-schemas.mjs';
import { readRecord, schemaFamily } from '../src/schema-migrations.mjs';
import { WORLD_MODEL_VIEW_CONTRACT_SCHEMA_VERSION as legacyViewVersion } from '../src/world-model/view-contract-schema-version.mjs';
test('namespace evidence classification is a separate row profile while the original record and context remain unchanged',()=>{
  assert.deepEqual(namespacePlanCorrectionRecordProfile('record',{schemaVersion:1}),{version:1,format:'sflow-namespace-plan-row-correction/v1'});
  assert.deepEqual(namespacePlanCorrectionRecordProfile('record',{schemaVersion:2}),{version:2,format:'sflow-namespace-plan-row-correction/v2',evidenceClassification:true});
  assert.deepEqual(namespacePlanCorrectionRecordProfile('context',{schemaVersion:1}),{version:1,format:'sflow-namespace-plan-correction-context/v1'});
  assert.throws(()=>namespacePlanCorrectionRecordProfile('record',{schemaVersion:3}),{code:'SCHEMA_VERSION_FUTURE'});
  assert.throws(()=>namespacePlanCorrectionRecordProfile('context',{schemaVersion:2}),{code:'SCHEMA_VERSION_FUTURE'});
});

test('shared version admission preserves current records and the registered missing/future/archived diagnostics', () => {
  const entry = { id: 'sample', currentVersion: 3, minimumReadableVersion: 2, maximumReadableVersion: 3, unversionedAs: null };
  const input = Object.freeze({ schemaVersion: 3, data: 'original' });
  assert.equal(admitRecordSchemaVersion(entry, input).record, input);
  for (const [value, code] of [[undefined, 'MISSING'], [1, 'ARCHIVED'], [4, 'FUTURE']]) {
    assert.throws(() => admitRecordSchemaVersion(entry, { schemaVersion: value }), error =>
      error.code === `SCHEMA_VERSION_${code}` && error.details.family === 'sample');
  }
  const unversioned = { data: 'legacy' };
  assert.deepEqual(admitRecordSchemaVersion({ ...entry, unversionedAs: 2 }, unversioned), {
    record: { data: 'legacy', schemaVersion: 2 }, storedVersion: 2
  });
  assert.deepEqual(unversioned, { data: 'legacy' });
});

test('filesystem durable families have one frozen registry owner and never migrate accepted history', () => {
  assert.equal(legacyViewVersion, 1);
  assert.equal(schemaFamily('world-model-view-contract').currentVersion, legacyViewVersion);
  assert.equal(schemaFamily(COMMAND_TIMING_SCHEMA.id).currentVersion, COMMAND_TIMING_SCHEMA.currentVersion);
  for (const [definitions, admit] of [[NAMESPACE_STORAGE_SCHEMAS, admitNamespaceStorageSchema],
    [SQLITE_NAMESPACE_SCHEMAS, admitSqliteNamespaceSchema]]) for (const [kind, definition] of Object.entries(definitions)) {
    const registered = schemaFamily(definition.id);
    for (const key of ['currentVersion', 'minimumReadableVersion', 'maximumReadableVersion', 'migrationPolicy', 'immutable']) {
      assert.equal(registered[key], definition[key]);
    }
    const value = { schemaVersion: 1, kind };
    assert.deepEqual(admit(kind, value), { record: value, storedVersion: 1 });
    assert.deepEqual(readRecord(definition.id, value), { record: value, storedVersion: 1, migratedThrough: [] });
    assert.throws(() => admit(kind, { schemaVersion: 2 }), error =>
      error.code === 'SDA_NAMESPACE_UNSUPPORTED' && error.cause.code === 'SCHEMA_VERSION_FUTURE');
  }
});

test('content and namespace read projections share registered schema metadata without changing stored versions', () => {
  for (const entry of [CONTENT_STORAGE_SCHEMA, ...Object.values(NAMESPACE_READER_SCHEMAS)]) {
    const registered = schemaFamily(entry.id);
    for (const key of ['currentVersion','minimumReadableVersion','maximumReadableVersion','migrationPolicy','immutable']) assert.equal(registered[key], entry[key]);
    const value = { schemaVersion: entry.currentVersion };
    assert.deepEqual(readRecord(entry.id, value), { record: value, storedVersion: entry.currentVersion, migratedThrough: [] });
    assert.throws(() => admitRecordSchemaVersion(entry, { schemaVersion: entry.maximumReadableVersion+1 }), { code: 'SCHEMA_VERSION_FUTURE' });
    const original={schemaVersion:1,format:'original',data:'unchanged'};
    assert.deepEqual(readRecord(entry.id,original),{record:original,storedVersion:1,migratedThrough:[]});
  }
});


test('Code profiles preserve original versions and separately admit reviewed additive plan evidence v6',()=>{
  for(const kind of ['code','codeReport']){
    const family=NAMESPACE_PHASE_POLICY_SCHEMAS[kind];assert.equal(Object.isFrozen(family),true);
    assert.throws(()=>schemaFamily(family.id),{code:'SCHEMA_FAMILY_UNKNOWN'},'opt-in SDK families do not change the installed native registry');
    for(const version of [1,2,3,4,5,6]){
      const original={schemaVersion:version,data:'original'},profile=namespaceCodePolicyProfile(kind,original);
      assert.equal(profile.version,version);assert.equal(profile.rework,version>=2);
      assert.equal(profile.format,'sflow-namespace-code-policy'+(kind==='codeReport'?'-report':'')+'/v'+version);
      assert.deepEqual(admitRecordSchemaVersion(family,original),{record:original,storedVersion:version});
      assert.equal(admitRecordSchemaVersion(family,original).record,original);
    }
    assert.throws(()=>namespaceCodePolicyProfile(kind,{schemaVersion:20}),{code:'SCHEMA_VERSION_FUTURE'});
  }
  for(const version of [1,2,3,4,5,6])assert.equal(namespaceCodePolicyVersionsMatch({schemaVersion:version},{schemaVersion:version}),true);
  assert.equal(namespaceCodePolicyVersionsMatch({schemaVersion:1},{schemaVersion:2}),false);
  assert.equal(namespaceCodePolicyVersionsMatch({schemaVersion:2},{schemaVersion:1}),false);
  assert.throws(()=>namespaceCodePolicyProfile('unregistered',{schemaVersion:1}),{code:'SCHEMA_FAMILY_UNKNOWN'});
  for(const kind of ['code','codeReport']){const profile=namespaceCodePolicyProfile(kind,{schemaVersion:7});
    assert.equal(profile.humanAcceptance,true);assert.equal(profile.optionalHistory,true);assert.equal(profile.kind,'code-delivery/v7');}
  for(const kind of ['code','codeReport'])for(const version of [8,9]){
    const record={schemaVersion:version,data:'original'},profile=namespaceCodePolicyProfile(kind,record);
    assert.equal(profile.kind,'code-delivery/v'+version);assert.equal(profile.optionalHistory,true);
    assert.equal(profile.humanAcceptance===true,version===9);
    assert.equal(admitRecordSchemaVersion(NAMESPACE_PHASE_POLICY_SCHEMAS[kind],record).record,record);
  }
  for(const kind of ['code','codeReport'])for(const version of [10,11]){
    const record={schemaVersion:version,data:'original'},profile=namespaceCodePolicyProfile(kind,record);
    assert.equal(profile.kind,'code-delivery/v'+version);assert.equal(profile.predecessors,true);
    assert.equal(profile.humanAcceptance===true,version===11);
    assert.equal(admitRecordSchemaVersion(NAMESPACE_PHASE_POLICY_SCHEMAS[kind],record).record,record);
  }
  for(const kind of ['code','codeReport'])for(const version of [12,13]){
    const record={schemaVersion:version,data:'original'},profile=namespaceCodePolicyProfile(kind,record);
    assert.equal(profile.outputs,true);assert.equal(profile.optionalPredecessors,true);assert.equal(profile.predecessors,undefined);
    assert.equal(profile.humanAcceptance===true,version===13);assert.equal(admitRecordSchemaVersion(NAMESPACE_PHASE_POLICY_SCHEMAS[kind],record).record,record);
  }
});
test('Code opening v3 binds approved predecessors without changing original v1/v2 wire profiles',()=>{
  assert.deepEqual(namespaceGenerationProfile({schemaVersion:1}),{version:1,continuation:false,format:'sflow-namespace-source-generation/v1'});
  assert.deepEqual(namespaceGenerationProfile({schemaVersion:2}),{version:2,continuation:true,format:'sflow-namespace-source-generation/v2'});
  assert.deepEqual(namespaceGenerationProfile({schemaVersion:3}),{version:3,continuation:false,predecessors:true,format:'sflow-namespace-source-generation/v3'});
  assert.throws(()=>namespaceGenerationProfile({schemaVersion:4}),{code:'SCHEMA_VERSION_FUTURE'});
});
test('private member and witness context wire versions are admitted by one pure owner',()=>{
  const old={format:'sflow-namespace-prepared-phase/v1',data:'original'},copy=structuredClone(old);
  assert.deepEqual(namespacePreparedPayloadProfile(old),{version:1,format:old.format,members:false});assert.deepEqual(old,copy);
  assert.equal(namespacePreparedPayloadProfile({schemaVersion:2,format:'sflow-namespace-prepared-phase/v2'}).members,true);
  assert.throws(()=>namespacePreparedPayloadProfile({schemaVersion:3,format:'sflow-namespace-prepared-phase/v3'}),{code:'SCHEMA_VERSION_FUTURE'});
  assert.equal(namespaceWitnessContextProfile({schemaVersion:1}).profile,'sflow-namespace-witness-context/v1');
  assert.throws(()=>namespaceWitnessContextProfile({schemaVersion:2}),{code:'SCHEMA_VERSION_FUTURE'});
});

test('conformance association v2 is separate while v1 remains readable without migration or record changes',()=>{
  for(const kind of ['conformance','conformanceReport'])for(const version of [1,2]){
    const record={schemaVersion:version,payload:'original'},profile=namespaceConformancePolicyProfile(kind,record);
    assert.equal(profile.version,version);assert.equal(profile.issueLinks,version===2);assert.equal(profile.kind,'conformance/v'+version);
    assert.equal(profile.format,'sflow-namespace-conformance-policy'+(kind==='conformanceReport'?'-report':'')+'/v'+version);
    assert.equal(admitRecordSchemaVersion(NAMESPACE_PHASE_POLICY_SCHEMAS[kind],record).record,record);
  }
  assert.throws(()=>namespaceConformancePolicyProfile('conformance',{schemaVersion:3}),{code:'SCHEMA_VERSION_FUTURE'});
  assert.throws(()=>namespaceConformancePolicyProfile('unknown',{schemaVersion:1}),{code:'SCHEMA_FAMILY_UNKNOWN'});
});
