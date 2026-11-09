import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as nativeQuality from '../src/specification-quality.mjs';
import * as nativeMarkers from '../src/clarification-markers.mjs';
import * as markers from '../src/kernel/specification-markers.mjs';
import {specificationAnalysisPolicies,SPECIFICATION_ANALYSIS_DECLARATIONS} from '../src/kernel/specification-analysis.mjs';
import {SPECIFICATION_REQUIRED_SECTIONS} from '../src/kernel/specification-policy.mjs';
import {NODE_TEXT_VALUE_SYNTAX} from '../src/records.mjs';
import {boundedEnvelope,DEFAULT_ANALYSIS_LIMITS} from '../src/analysis-limits.mjs';

const declaration=Object.freeze({profile:SPECIFICATION_ANALYSIS_DECLARATIONS,requiredSections:SPECIFICATION_REQUIRED_SECTIONS,starterChecklist:nativeQuality.STARTER_CHECKLIST});
const valueApi={...specificationAnalysisPolicies(NODE_TEXT_VALUE_SYNTAX,declaration),...markers},nativeApi={...nativeQuality,...nativeMarkers};
const serialized=value=>JSON.parse(JSON.stringify(value));
function outcome(api,entry) {
  try{return {value:api[entry.method](...structuredClone(entry.args))};}
  catch(error){return {error:{name:error.name,message:error.message,code:error.code,details:error.details,exitCode:error.exitCode}};}
}
test('shared analysis preserves independently captured native report, warning and error values',async()=>{
  const oracle=JSON.parse(await readFile(new URL('./fixtures/specification-analysis/native-v1.json',import.meta.url)));
  assert.equal(oracle.capturedAtCommit,'055b08129');assert.equal(oracle.cases.length,94);
  for(const entry of oracle.cases) {
    const shared=outcome(valueApi,entry),native=outcome(nativeApi,entry);
    assert.deepEqual(serialized(shared),entry.outcome,entry.id);assert.deepEqual(shared,native,entry.id+' native in-memory shape');
  }
});
test('analysis content is an explicit captured value declaration and cannot supply readiness callbacks',()=>{
  assert.throws(()=>specificationAnalysisPolicies(NODE_TEXT_VALUE_SYNTAX,{...declaration,profile:'arbitrary'}),{code:'ENGINE_INPUT_INVALID'});
  assert.throws(()=>specificationAnalysisPolicies(NODE_TEXT_VALUE_SYNTAX,{...declaration,ready:()=>true}),{code:'ENGINE_INPUT_INVALID'});
  const extra=structuredClone(declaration);extra.starterChecklist.articles[0].ready=()=>true;
  assert.throws(()=>specificationAnalysisPolicies(NODE_TEXT_VALUE_SYNTAX,extra),{code:'ENGINE_INPUT_INVALID'});
  const duplicate=structuredClone(declaration);duplicate.starterChecklist.articles.push(duplicate.starterChecklist.articles[0]);
  assert.throws(()=>specificationAnalysisPolicies(NODE_TEXT_VALUE_SYNTAX,duplicate),{code:'ENGINE_INPUT_INVALID'});
  const given=structuredClone(declaration),rules=specificationAnalysisPolicies(NODE_TEXT_VALUE_SYNTAX,given),before=rules.policyHash({mode:'enforce'});
  given.requiredSections.push('Injected section');given.starterChecklist.articles[0].question='Injected wording';
  assert.equal(rules.policyHash({mode:'enforce'}),before);assert.notEqual(nativeQuality.STARTER_CHECKLIST.articles[0].question,'Injected wording');
});
test('native gate severity and human checklist authority match the independently captured folds',async()=>{
  const oracle=JSON.parse(await readFile(new URL('./fixtures/specification-analysis/native-gates-v1.json',import.meta.url)));
  assert.equal(oracle.cases.length,54);
  for(const entry of oracle.cases)assert.deepEqual(serialized(valueApi[entry.method](...structuredClone(entry.args))),entry.outcome,entry.id);
});
test('a clean deterministic report stays distinct from semantic completeness, execution and human approval',()=>{
  const report=valueApi.analyzeSpecification('## Actors\nOperator.\n\n## User scenarios\nConvert.\n\n## Requirements\n[APP:REQ-001] Return a value.',{namespace:'APP',policy:{mode:'enforce'}});
  assert.equal(report.findings.length,0);assert.match(report.disclaimer,/no claim.*complete/u);
  assert.equal(Object.hasOwn(report,'approved'),false);assert.equal(Object.hasOwn(report,'testsPassed'),false);
  const verdict=valueApi.validateChecklistDecisions([],{mode:'enforce'});assert.equal(verdict.errors.length,6);
});
test('the retained native envelope can call the extracted cap and discloses both count and byte limits',()=>{
  assert.deepEqual(boundedEnvelope([{id:'one',excerpt:'observed'}]),{
    entries:[{id:'one',excerpt:'observed',truncated:false}],bytes:8,dropped:0,disclosure:null});
  assert.deepEqual(boundedEnvelope([{id:'one',excerpt:'abc'},{id:'two',excerpt:'def'},{id:'three',excerpt:'ghi'}],{
    limits:{...DEFAULT_ANALYSIS_LIMITS,maxEvidenceRecords:2,maxOutputBytes:5}}),{
      entries:[{id:'one',excerpt:'abc',truncated:false}],bytes:3,dropped:2,
      disclosure:'2 reference(s) were not sent to the model: the envelope is bounded to 2 records and 5 bytes.'});
  assert.deepEqual(boundedEnvelope([{id:'one',excerpt:'abcdef'}],{maxEntryBytes:2}),{
    entries:[{id:'one',excerpt:'ab',truncated:true}],bytes:2,dropped:0,disclosure:null});
});
