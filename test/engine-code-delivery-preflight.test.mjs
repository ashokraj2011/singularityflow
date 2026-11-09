import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {evaluateCodeDeliveryPreflight,specificationCriteria,unknownCriterionTags,reviewCodeSource,reviewMayReturnToCode} from '../src/delivery-evidence.mjs';
import {codeDeliveryEvidencePolicies} from '../src/kernel/code-delivery-evidence.mjs';
import {TEST_REPORT_BYTE_SYNTAX} from '../src/kernel/test-report-codec.mjs';
import {TEST_DELIVERY_POLICY_FACTS,REPOSITORY_CHANGE_SET_VALUES} from '../src/kernel/source-path-policies.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX,TEST_COMMAND_ECOSYSTEMS} from '../src/engine-compatibility/node-configuration-path.mjs';
import {GOVERNED_ROOTS} from '../src/governed-roots.mjs';
import {ecosystemOfAdapter,ecosystemOfProgram} from '../src/test-runners.mjs';
import * as binding from '../src/engine-compatibility/node-source-policy.mjs';
import * as semantic from '../src/kernel/specification-policy.mjs';
import * as phases from '../src/kernel/phase-policy.mjs';
import {loadActiveSpecRecords} from '../src/specifications.mjs';
import {taggedAcceptanceIds} from '../src/delivery-evidence.mjs';
import {codeDeliveryPreflightFixture,codeDeliveryPreflightCases,preflightProjection} from './helpers/code-delivery-preflight-fixture.mjs';
const original=JSON.parse(await readFile(new URL('./fixtures/code-delivery-preflight/native-v1.json',import.meta.url),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const owner=()=>codeDeliveryEvidencePolicies(NODE_CONFIGURATION_PATH_SYNTAX,GOVERNED_ROOTS,
  Object.freeze({profile:TEST_DELIVERY_POLICY_FACTS,ecosystems:TEST_COMMAND_ECOSYSTEMS,posixExtname:path.posix.extname,ecosystemOfAdapter,ecosystemOfProgram}),
  Object.freeze({profile:REPOSITORY_CHANGE_SET_VALUES,sha256Text:value=>'sha256:'+hash(value),compareUtf8:(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))}),
  Object.freeze({profile:TEST_REPORT_BYTE_SYNTAX,from:Buffer.from.bind(Buffer),alloc:Buffer.alloc.bind(Buffer),concat:Buffer.concat.bind(Buffer),sha256:hash}));

test('33 pre-extraction native preflight outcomes retain delivery bindings, finding identities and exact recovery details',async()=>{
  assert.equal(original.baseline,'c1fe0a6db');assert.equal(original.functionSha256,'e2e28cdcbf06a48cc917dd4564ee7f4c1f029998a826fe9d586a7f18414fccdc');assert.equal(original.cases.length,33);
  const expected=new Map(original.cases.map(row=>[row.id,row.outcome]));
  for(const row of codeDeliveryPreflightCases()){
    const f=await codeDeliveryPreflightFixture(row.options);
    try{let outcome;try{outcome={value:preflightProjection(await evaluateCodeDeliveryPreflight(f.root,f.config,f.workflow,f.phase,row.mode))};}
      catch(error){outcome={error:{name:error.name,message:error.message,code:error.code??null,details:error.details??null}};}
      assert.deepEqual(JSON.parse(JSON.stringify(outcome).split(f.root).join('<checkout>')),expected.get(row.id),row.id);
    }finally{await f.close();}
  }
});

test('native phase, criterion, path and finding exports use the same shared rule instances',async()=>{
  assert.equal(reviewCodeSource,phases.reviewCodeSource);assert.equal(reviewMayReturnToCode,phases.reviewMayReturnToCode);
  assert.equal(specificationCriteria,semantic.specificationCriteria);assert.equal(unknownCriterionTags,semantic.unknownCriterionTags);
  const spec=await import('../src/specifications.mjs'),findings=await import('../src/finding-identity.mjs'),disputes=await import('../src/phase-finding-dispute.mjs');
  assert.equal(spec.mergePlannedClaimRecords,semantic.mergePlannedClaimRecords);
  assert.equal(spec.plannedProductSourcePaths,binding.plannedProductSourcePaths);
  assert.equal(spec.plannedSupportingFiles,binding.plannedSupportingFiles);
  assert.equal(findings.canonicalFinding,binding.canonicalFinding);assert.equal(findings.canonicalFindingId,binding.canonicalFindingId);
  assert.equal(disputes.codeDeliveryCandidateSha256,binding.codeDeliveryCandidateSha256);
});

test('unknown criteria read baseline ownership lazily and preserve exact namespace distinctions',()=>{
  const workflow={workItem:{id:'OWN'},resolution:{spec:{namespace:'SHARED'}}};
  const criteria=semantic.specificationCriteria({indexes:[{clauses:[{id:'SHARED:AC-001',bodySha256:'a'}]}]},workflow);
  let reads=0;const carried=()=>{reads++;return new Set(['SHARED:AC-002']);};
  assert.deepEqual(semantic.unknownCriterionTags(criteria,{locations:[{clauseId:'SHARED:AC-001',testSource:'test/x.js',line:1}],carried}),[]);assert.equal(reads,0);
  const findings=semantic.unknownCriterionTags(criteria,{locations:[
    {clauseId:'SHARED:AC-002',testSource:'test/x.js',line:2},
    {clauseId:'SHARED:AC-003',testSource:'test/x.js',line:3},
    {clauseId:'OTHER:AC-001',testSource:'test/x.js',line:4},
    {clauseId:'OWN:AC-002',testSource:'test/x.js',line:5}],carried});
  assert.equal(reads,1);assert.deepEqual(findings.map(row=>row.clauseId),['SHARED:AC-003','OWN:AC-002']);
});

test('candidate scope remains allocated, supporting files remain classified, and tests cannot become product source',()=>{
  const rules=owner(),workflow={resolution:{plannedClaims:{mode:'required'}}},phase={id:'code',generationPolicy:{task:'code'},writeScope:'source-and-artifact'};
  const maps=[{phase:'plan',generation:1,claims:{A:{expectedPaths:['src/app.js','test/app.test.js','package.json'],tests:['test/app.test.js'],steps:['code']}},supportingFiles:['package-lock.json','src/unapproved.js']},
    {phase:'plan',generation:2,amendment:true,claims:{B:{expectedPaths:['src/other.js'],steps:['other']}},accountedPaths:{A:['config/app.yaml']}}];
  const scope=rules.codeDeliveryCandidateScope(maps,workflow,phase);
  for(const file of ['src/app.js','test/app.test.js','package.json','package-lock.json','config/app.yaml','test/new.test.js'])assert.equal(scope.allows(file),true,file);
  for(const file of ['src/other.js','src/unapproved.js'])assert.equal(scope.allows(file),false,file);
  assert.deepEqual(rules.plannedProductSourcePaths(maps[0].claims.A),['src/app.js']);
  assert.deepEqual(rules.plannedCodeStepPaths(maps,workflow,phase),{sourcePaths:['package.json','src/app.js','test/app.test.js'],testPaths:['test/app.test.js']});
});

test('preflight cannot proceed when the actual generation baseline owner is unavailable',()=>{
  const rules=owner(),phase={id:'code',writeScope:'source-and-artifact',generationPolicy:{task:'code'}};
  const plan=rules.codeDeliveryPreflightReplay({}, {workItem:{id:'example'}}, phase);
  assert.equal(plan.next().value.kind,'prepare-local-exclusions');assert.equal(plan.next().value.kind,'verify-work-interval');
  const failure=Object.assign(new Error('actual baseline unavailable'),{code:'EACCES'});
  assert.throws(()=>plan.throw(failure),error=>error===failure);
  assert.equal(plan.next().done,true);
});

async function retainedPreflightFacts(t){
  const f=await codeDeliveryPreflightFixture();t.after(f.close);
  const delivery=await evaluateCodeDeliveryPreflight(f.root,f.config,f.workflow,f.phase);
  const records=await loadActiveSpecRecords(path.join(f.root,'singularity/work-items/PREFLIGHT'),f.workflow);
  const tags=await taggedAcceptanceIds(f.root,delivery.testPaths);
  const plan=JSON.parse(await readFile(path.join(f.root,f.workflow.phases.planning.claimMaps.planned.path),'utf8'));
  const rules=owner(),scope=rules.codeDeliveryCandidateScope(records.planned??[],f.workflow,f.phase);
  await f.close(); // The remaining replay has no checkout or Git objects to consult.
  const read=overrides=>async request=>{
    assert.equal(Object.isFrozen(request),true);
    if(Object.hasOwn(overrides,request.kind))return overrides[request.kind](request);
    switch(request.kind){
      case 'prepare-local-exclusions':case 'verify-work-interval':case 'candidate-coverage':return;
      case 'working-change-set':return delivery.changeSet;
      case 'candidate-scope':return scope;
      case 'outside-candidates':return candidate=>!scope.allows(candidate);
      case 'executable-test-path':return delivery.testPaths.includes(request.candidate);
      case 'reusable-paths':assert.deepEqual(request.candidates,[]);return [];
      case 'reviewed-baseline-tests':return [];
      case 'allocated-obligations':return Object.entries(plan.claims).map(([clauseId,claim])=>({clauseId,...claim}));
      case 'required-acceptance':return delivery.acceptanceCriteria.required;
      case 'specification-records':return records;
      case 'acceptance-tags':return tags;
      case 'acceptance-witnesses':return {...delivery.acceptanceCriteria,errors:[],errorFindings:[]};
      case 'source-clause-bindings':return delivery.sourceBindings;
      case 'implementation-bindings':return {...delivery.implementationBindings,problems:[],problemFindings:[],explanationsMissing:[]};
      case 'accepted-dispute':return {active:null};
      case 'path-evidence':return delivery.paths;
      case 'format-preflight-refusal':return Object.assign(new Error('Observed preflight refusal'),{code:'PREFLIGHT_REFUSED',details:request});
      default:throw Object.assign(new Error('Required fact owner unavailable: '+request.kind),{code:'ENGINE_PORT_UNAVAILABLE'});
    }
  };
  const replay=async(overrides={})=>{
    const replay=rules.codeDeliveryPreflightReplay(f.config,f.workflow,f.phase),reader=read(overrides);let step=replay.next();
    while(!step.done){let answer;try{answer=await reader(step.value);}catch(error){step=replay.throw(error);continue;}step=replay.next(answer);}return step.value;
  };
  return {...f,delivery,replay};
}

test('preflight replays observed source and plan facts after the original checkout is removed',async t=>{
  const f=await retainedPreflightFacts(t),before=structuredClone(f.workflow),result=await f.replay();
  assert.deepEqual(preflightProjection(result),preflightProjection(f.delivery));assert.deepEqual(result.paths,f.delivery.paths);
  assert.deepEqual(f.workflow,before);assert.equal(f.phase.generation,0,'candidate inspection cannot publish a generation');
});

test('a refusal renderer cannot turn failed source evidence into an admissible delivery',async t=>{
  const f=await retainedPreflightFacts(t),ack=Object.freeze({status:'ready',approved:true});let refused;
  await assert.rejects(f.replay({
    'source-clause-bindings':()=>({...f.delivery.sourceBindings,missing:[{clauseId:'PREFLIGHT:REQ-001',expectedPaths:['src/app.js']}]}),
    'format-preflight-refusal':request=>{refused=request;return ack;}
  }),error=>error===ack);
  assert.equal(refused.reason,'evidence');assert.ok(refused.errors.some(error=>error.includes('planned product source does not contain required clause comments')));
  assert.equal(f.phase.generation,0);
});

test('the separate claim-coverage owner stays required and retains the exact private repair candidate',async t=>{
  const f=await retainedPreflightFacts(t),failure=Object.assign(new Error('actual planned coverage is incomplete'),{code:'SPEC_COVERAGE_INCOMPLETE'});
  await assert.rejects(f.replay({'candidate-coverage':()=>{throw failure;}}),error=>error===failure);
  assert.deepEqual(preflightProjection(failure.qualityRiskCandidate),preflightProjection(f.delivery));
  assert.equal(Object.keys(failure).includes('qualityRiskCandidate'),false,'private repair bytes must not leak into CLI error JSON');
  const unavailable=Object.assign(new Error('actual claim owner unavailable'),{code:'ENGINE_PORT_UNAVAILABLE'});
  await assert.rejects(f.replay({'candidate-coverage':()=>{throw unavailable;}}),error=>error===unavailable);
  assert.equal(Object.hasOwn(unavailable,'qualityRiskCandidate'),false);
});
