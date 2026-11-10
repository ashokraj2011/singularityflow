/** Independent native capture: inputs and expected hashes predate the extraction. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import YAML from 'yaml';
import * as native from '../src/constitution.mjs';
import {constitutionValuePolicies,CONSTITUTION_SYNTAX_PROFILE} from '../src/kernel/constitution.mjs';
import {CONSTITUTION_RECORD_SCHEMA} from '../src/foundation/record-schema.mjs';
import {NODE_TEXT_DIGESTS} from '../src/records.mjs';
import {renderDataPreservingFormatting} from '../src/yaml-formatting.mjs';
import {constitutionValueOutcome} from './helpers/constitution-values-fixture.mjs';
const capture=JSON.parse(await readFile(new URL('./fixtures/constitution-values/native-v1.json',import.meta.url),'utf8'));
const values=constitutionValuePolicies(NODE_TEXT_DIGESTS,Object.freeze({profile:CONSTITUTION_SYNTAX_PROFILE,parse:source=>YAML.parse(source)}),{pathSeparator:capture.pathSeparator});
const pure={...values,generateConstitution(markdown,resolution){const plan=values.generationPlan(markdown,resolution);
  return {markdown:`---\n${renderDataPreservingFormatting(`${plan.frontMatter}\n`,plan.declaration).trimEnd()}\n---\n${plan.body}`,regenerated:plan.regenerated,articles:plan.articles};}};
for(const row of capture.cases)test(`constitution native and pure compatibility: ${row.name}`,()=>{
  assert.deepEqual(constitutionValueOutcome(native,row.input),row.outcome,'native full output, errors and generated formatting');
  const expected=structuredClone(row.outcome);
  if(row.input.method==='parse'&&expected.status==='returned')for(const finding of expected.value.findings)
    if(finding.kind==='missing-generated-block')finding.message=`${finding.id} is enforced and has no generated block.`;
  assert.deepEqual(constitutionValueOutcome(pure,row.input),expected,'pure policy values with only native command rendering removed');
});
test('constitution syntax is a captured explicit primitive and has no implied authority',()=>{
  const parse=source=>YAML.parse(source),syntax=Object.freeze({profile:CONSTITUTION_SYNTAX_PROFILE,parse});
  const selected=constitutionValuePolicies(NODE_TEXT_DIGESTS,syntax);
  assert.equal(Object.isFrozen(selected),true);assert.equal(CONSTITUTION_RECORD_SCHEMA.currentVersion,native.CONSTITUTION_SCHEMA_VERSION);
  for(const invalid of [null,{profile:CONSTITUTION_SYNTAX_PROFILE,parse},Object.freeze({profile:'unknown',parse}),
    Object.freeze({profile:CONSTITUTION_SYNTAX_PROFILE,parse,ready:true}),Object.freeze({profile:CONSTITUTION_SYNTAX_PROFILE,get parse(){throw Error('must not run getter');}})])
    assert.throws(()=>constitutionValuePolicies(NODE_TEXT_DIGESTS,invalid),{code:'ENGINE_CONSTITUTION_SYNTAX_INVALID'});
  assert.throws(()=>constitutionValuePolicies(NODE_TEXT_DIGESTS,syntax,{pathSeparator:':'}),{code:'ENGINE_CONSTITUTION_SYNTAX_INVALID'});
  const original=Object.freeze(new Error('original syntax failure'));
  const failed=constitutionValuePolicies(NODE_TEXT_DIGESTS,Object.freeze({profile:CONSTITUTION_SYNTAX_PROFILE,parse(){throw original;}}));
  assert.throws(()=>failed.parseConstitution('---\narticles: []\n---\n'),error=>error===original);
});
