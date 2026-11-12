import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {namespacePublicationRecordProfile,namespaceSubmissionRecordProfile,namespaceApprovalRecordProfile,namespaceApprovalWriterProfile,namespaceCodePolicyProfile,namespaceCodePreflightVersion} from '../src/foundation/record-schema.mjs';
const values=JSON.parse(await readFile(new URL('./fixtures/forward-amendment-values/namespace-profiles-v1.json',import.meta.url),'utf8'));
test('all prior publication, submission, vote and ordinary writer meanings are unchanged',()=>{
  for(const [key,fn]of [['publication',namespacePublicationRecordProfile],['submission',namespaceSubmissionRecordProfile],['approval',namespaceApprovalRecordProfile]])
    for(const row of values[key])assert.deepEqual(fn({schemaVersion:row.schemaVersion}),row.value);
  for(const row of values.writers)assert.deepEqual(namespaceApprovalWriterProfile({routing:row.routing}),row.value);
});
test('forward projections have explicit new profiles and do not silently read future meanings',()=>{
  assert.equal(namespacePublicationRecordProfile({schemaVersion:5}).forwardAmendment,true);
  assert.equal(namespaceSubmissionRecordProfile({schemaVersion:6}).forwardAmendment,true);
  assert.equal(namespaceApprovalRecordProfile({schemaVersion:3}).forwardAmendment,true);
  for(const [fn,version]of [[namespacePublicationRecordProfile,6],[namespaceSubmissionRecordProfile,7],[namespaceApprovalRecordProfile,4]])
    assert.throws(()=>fn({schemaVersion:version}),{code:'SCHEMA_VERSION_FUTURE'});
});
const code=JSON.parse(await readFile(new URL('./fixtures/forward-amendment-values/code-profiles-v27.json',import.meta.url),'utf8'));
test('Code v1 through v27 retain their pre-amendment meanings',()=>{
  for(const row of code.profiles)for(const kind of ['code','codeReport'])assert.deepEqual(namespaceCodePolicyProfile(kind,{schemaVersion:row.version}),row[kind==='code'?'code':'report']);
  for(const history of ['v11','v12']){
    assert.equal(namespaceCodePreflightVersion({history:{profile:'sflow-namespace-code-history/'+history}}),28);
    assert.equal(namespaceCodePreflightVersion({history:{profile:'sflow-namespace-code-history/'+history},repositoryScope:{profile:'sflow-namespace-repository-coverage/v1'}}),30);
  }
  assert.equal(namespaceCodePolicyProfile('code',{schemaVersion:29}).humanAcceptance,true);
  assert.equal(namespaceCodePolicyProfile('code',{schemaVersion:31}).repositoryCoverage,true);
  assert.throws(()=>namespaceCodePolicyProfile('code',{schemaVersion:32}),{code:'SCHEMA_VERSION_FUTURE'});
});
