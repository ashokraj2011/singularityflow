import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {selectCurrentCodeReturn} from '../src/kernel/code-delivery-evidence.mjs';
import {namespaceCodePolicyProfile,namespaceCodePreflightVersion} from '../src/foundation/record-schema.mjs';
import {isCodePolicyEvidence} from '../src/engine-storage/namespace-policy-contract.mjs';
test('all 23 earlier Code wire profiles retain their captured meanings',async()=>{
  const captured=JSON.parse(await readFile(new URL('./fixtures/targeted-repair-contracts/code-profiles-v23.json',import.meta.url),'utf8'));
  for(const row of captured.profiles){assert.deepEqual(namespaceCodePolicyProfile('code',{schemaVersion:row.version}),row.code);
    assert.deepEqual(namespaceCodePolicyProfile('codeReport',{schemaVersion:row.version}),row.report);}
});
test('repeated returns have distinct Code profiles for repository scope and human acceptance',()=>{
  for(const repositoryCoverage of [false,true])for(const humanAcceptance of [false,true]){
    const base=repositoryCoverage?26:24,profile=namespaceCodePolicyProfile('code',{schemaVersion:base+(humanAcceptance?1:0)});
    assert.equal(profile.repeatedReturns,true);assert.equal(Boolean(profile.humanAcceptance),humanAcceptance);assert.equal(Boolean(profile.repositoryCoverage),repositoryCoverage);
    assert.equal(isCodePolicyEvidence(profile.kind),true);
    assert.equal(namespaceCodePreflightVersion({history:{profile:'sflow-namespace-code-history/v10'},...(repositoryCoverage?{repositoryScope:{profile:'sflow-namespace-repository-coverage/v1'}}:{})}),base);
  }
  assert.equal(isCodePolicyEvidence('code-delivery/v28'),false);
});
test('the current return is selected by its authenticated target generation, independently of time or row order',()=>{
  assert.deepEqual(selectCurrentCodeReturn(2,[{id:'CR-002',generation:2},{id:'CR-001',generation:1}]),{current:'CR-002',earlier:['CR-001']});
  for(const rows of [[{id:'CR-001',generation:1}],[{id:'CR-001',generation:2},{id:'CR-002',generation:2}]])
    assert.throws(()=>selectCurrentCodeReturn(2,rows),{code:'ENGINE_CODE_REWORK_REQUIRED'});
  for(const rows of [[{id:'CR-001',generation:1},{id:'CR-001',generation:2}],[{id:'CR-003',generation:3}],Array(257).fill({id:'copied',generation:1})])
    assert.throws(()=>selectCurrentCodeReturn(2,rows),{code:'ENGINE_STORAGE_CORRUPT'});
});
