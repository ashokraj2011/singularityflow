import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {namespaceHumanDecisionProfile,namespaceCodePolicyProfile,namespaceCodePreflightVersion} from '../src/foundation/record-schema.mjs';
const previous=JSON.parse(await readFile(new URL('./fixtures/targeted-repair-contracts/previous-profiles.json',import.meta.url),'utf8'));
for(const row of previous.human)test('original human decision profile '+row.schemaVersion+' keeps its pre-extraction value',()=>assert.deepEqual(namespaceHumanDecisionProfile({schemaVersion:row.schemaVersion}),row.value));
for(const row of previous.code)test('original Code profile '+row.schemaVersion+' keeps its pre-extraction value',()=>assert.deepEqual(namespaceCodePolicyProfile('code',{schemaVersion:row.schemaVersion}),row.value));
test('original combined Code preflight priorities retain their captured values',()=>{
  for(const row of previous.preflights)assert.equal(namespaceCodePreflightVersion(row.input),row.value,JSON.stringify(row.input));
});
test('targeted Code profiles carry their own optional outputs and predecessors without changing older meanings',()=>{
  const preflight={history:{profile:'sflow-namespace-code-history/v8'},outputs:{profile:'sflow-namespace-code-outputs/v1',files:[{}]},
    priorCode:{profile:'sflow-namespace-code-predecessors/v1',phases:[{}]}};
  assert.equal(namespaceCodePreflightVersion(preflight),14);
  for(const version of [14,15]){const profile=namespaceCodePolicyProfile('code',{schemaVersion:version});assert.equal(profile.targeted,true);
    assert.equal(profile.optionalOutputs,true);assert.equal(profile.optionalPredecessors,true);assert.equal(Boolean(profile.humanAcceptance),version===15);}
  assert.equal(namespaceHumanDecisionProfile({schemaVersion:3}).targeted,true);
  for(const targeted of [false,true]){const scoped={...preflight,...(!targeted?{history:null}:{}),repositoryScope:{profile:'sflow-namespace-repository-coverage/v1',repositories:[]}};
    assert.equal(namespaceCodePreflightVersion(scoped),targeted?18:16);
    for(const version of targeted?[18,19]:[16,17])assert.equal(namespaceCodePolicyProfile('code',{schemaVersion:version}).repositoryCoverage,true);}
  assert.throws(()=>namespaceHumanDecisionProfile({schemaVersion:5}),{code:'SCHEMA_VERSION_FUTURE'});
  assert.throws(()=>namespaceCodePolicyProfile('code',{schemaVersion:40}),{code:'SCHEMA_VERSION_FUTURE'});
});
