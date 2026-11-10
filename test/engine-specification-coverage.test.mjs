import test from 'node:test';import assert from 'node:assert/strict';import {readFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';import {spawnSync} from 'node:child_process';import path from 'node:path';import {createHash} from 'node:crypto';
import * as native from '../src/specifications.mjs';
import * as binding from '../src/engine-compatibility/node-specification-policy.mjs';
import * as policy from '../src/kernel/specification-policy.mjs';
import {specificationClaimPolicies,SPECIFICATION_CLAIM_TIMESTAMP_REQUEST} from '../src/kernel/specification-values.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../src/engine-compatibility/node-configuration-path.mjs';
import {NODE_TEXT_VALUE_SYNTAX} from '../src/records.mjs';
import {applicationPathContext} from '../src/engine-compatibility/node-source-policy.mjs';
import {assertStrictCandidateSpecificationCoverage} from '../src/spec-coverage-preview.mjs';
import {createSpecificationCoverageHost,createBoundCoverageFixture,coverageAt,coverageId} from './helpers/specification-coverage-fixture.mjs';
const oracle=JSON.parse(await readFile(new URL('./fixtures/specification-coverage/native-v1.json',import.meta.url),'utf8')),
  rules=specificationClaimPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_VALUE_SYNTAX),
  outcome=async read=>{try{return {value:await read()};}catch(error){return {error:{name:error.name,code:error.code??null,message:error.message,details:error.details??null}};}},
  ordinary=value=>JSON.parse(JSON.stringify(value));
function drive(replay,read){let step=replay.next();while(!step.done){let value;try{value=read(step.value);}catch(error){step=replay.throw(error);continue;}step=replay.next(value);}return step.value;}
function rootObservation(root,request){
  if(request.kind==='specification-coverage-path')return existsSync(path.join(root,request.path));
  if(request.kind==='specification-coverage-commit')return spawnSync('git',['cat-file','-e',request.commit+'^{commit}'],{cwd:root,encoding:'utf8',env:process.env,timeout:15000}).status===0;
  throw Error('Unexpected coverage observation '+request.kind);
}
test('native coverage/selection aliases keep one owner and five original function bodies',()=>{
  for(const [name,hash]of Object.entries(oracle.fingerprints)){
    const selected=['codeCoverageEnforcement','plannedClaimsForObservedPhase','selectActiveSpecRecords'].includes(name)?policy[name]:binding[name];
    assert.equal(native[name],selected,name);assert.equal(createHash('sha256').update(selected.toString()).digest('hex'),hash,name);
  }
});
test('470 frozen native coverage, cumulative fulfillment, acceptance and active-selection outcomes replay unchanged',async t=>{
  const f=await createSpecificationCoverageHost(t);
  for(const entry of oracle.rows){const args=JSON.parse(JSON.stringify(entry.args).replaceAll('@reachable-commit@',f.commit));
    const result=await outcome(()=>{
      if(entry.method==='evaluateSpecCoverage')return drive(rules.evaluateSpecCoverageReplay(...args.slice(0,3),{...args[3],verifyEvidence:entry.host===true}),request=>rootObservation(f.root,request));
      return (rules[entry.method]??policy[entry.method])(...args);
    });assert.deepEqual(ordinary(result),entry.outcome,entry.name);
  }
});
test('native synchronous compatibility still returns every frozen value with real file and commit reads',async t=>{
  const f=await createSpecificationCoverageHost(t);
  for(const entry of oracle.rows){const args=JSON.parse(JSON.stringify(entry.args).replaceAll('@reachable-commit@',f.commit));if(entry.host)args[3]={...args[3],root:f.root};
    assert.deepEqual(ordinary(await outcome(()=>native[entry.method](...args))),entry.outcome,entry.name);}
});
test('candidate replay preserves original final/earlier phase coverage without host commands or authority',()=>{
  for(const entry of oracle.candidates){const requested=[],result=drive(rules.candidateSpecificationCoverageReplay({},entry.workflow,entry.workflow.phases.code,entry.delivery,
    {pathContext:applicationPathContext({},entry.workflow)}),request=>{
      requested.push(request.kind);if(request===SPECIFICATION_CLAIM_TIMESTAMP_REQUEST)return coverageAt;
      assert.equal(request.kind,'candidate-coverage-records');assert.deepEqual(request.options,{requireCommitted:false,throughPhase:entry.later?'code':null,excludeObservedPhase:'code'});return structuredClone(entry.records);
    });
    if(entry.outcome.value===null){assert.equal(result,null,entry.name);assert.deepEqual(requested,[],entry.name);continue;}
    if(entry.outcome.error){assert.equal(result.status,'correction-required',entry.name);assert.deepEqual(result.coverage,entry.outcome.error.details.coverage,entry.name);assert.deepEqual(result.claimGaps,entry.outcome.error.details.claimGaps,entry.name);}
    else{const {advisory,...coverage}=entry.outcome.value;assert.equal(result.status,advisory?'advisory':'ready',entry.name);assert.deepEqual(result.coverage,coverage,entry.name);}
    assert.equal(result.profile,'sflow-candidate-specification-coverage/v1');assert.equal(result.owner,'plan');assert.equal(JSON.stringify(result).includes('singularity-flow '),false);
  }
});
test('19 native prepublication candidates retain exact diagnostics and recovery details over actual bound files',async t=>{
  const f=await createBoundCoverageFixture(t);
  for(const entry of oracle.candidates){const workflow=structuredClone(f.workflow);workflow.resolution.spec.coverage=entry.coverage;workflow.resolution.codeDelivery={traceability:{sourceBindings:entry.sourceBindings}};
    if(entry.later){workflow.phaseOrder.push('later');workflow.phases.later={id:'later',generation:0,requiredArtifact:{kind:'implementation-summary'}};workflow.resolution.plannedClaims.owners.later='plan';}
    assert.deepEqual(ordinary(await outcome(()=>assertStrictCandidateSpecificationCoverage(f.root,f.config,workflow,workflow.phases.code,entry.delivery))),entry.outcome,entry.name);
  }
});
test('coverage requests reject invented readiness and preserve the exact original read failure',()=>{
  const entry=oracle.rows.find(row=>row.host),args=entry.args.slice(0,3),start=()=>rules.evaluateSpecCoverageReplay(...args,{verifyEvidence:true}),
    original=Object.assign(new Error('Original source observation permission failure.'),{code:'EACCES'}),missing=start();
  assert.equal(missing.next().value.kind,'specification-coverage-path');assert.throws(()=>missing.throw(original),error=>error===original);
  const forged=start();forged.next();assert.throws(()=>forged.next({ready:true}),{code:'ENGINE_PORT_RESULT_INVALID'});
  const candidate=oracle.candidates.find(row=>row.coverage==='enforce'),replay=rules.candidateSpecificationCoverageReplay({},candidate.workflow,candidate.workflow.phases.code,candidate.delivery,{pathContext:applicationPathContext()});
  assert.equal(replay.next().value.kind,'candidate-coverage-records');assert.throws(()=>replay.next({ready:true}),{code:'ENGINE_PORT_RESULT_INVALID'});
});
test('pure values replay after the original checkout is removed, and do not turn test presence into execution',async t=>{
  const f=await createSpecificationCoverageHost(t);await rm(f.root,{recursive:true,force:true});
  const entry=oracle.rows.find(row=>row.name==='coverage test-only matched tests-only'),result=drive(rules.evaluateSpecCoverageReplay(...entry.args),()=>assert.fail('Value coverage may not read a checkout.'));
  assert.deepEqual(result,entry.outcome.value);assert.deepEqual(result.testPresenceOnly,[coverageId]);
  assert.equal(Object.hasOwn(result,'execution'),false);assert.equal(Object.hasOwn(result,'approved'),false);
});
