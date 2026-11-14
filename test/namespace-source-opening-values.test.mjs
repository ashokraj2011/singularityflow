import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceCodePolicyProfile,namespaceCodePreflightVersion,namespaceCodeExecutionRiskEvidenceAllowed,namespaceSourceOpeningContextProfile} from '../src/foundation/record-schema.mjs';
import {SOURCE_LIMITS} from '../src/foundation/source-snapshot.mjs';import {namespaceSourceOpeningPolicies} from '../src/kernel/source-opening.mjs';
import {sourceSnapshotChanges} from '../src/kernel/source-changes.mjs';import {phaseRolloverPlan} from '../src/kernel/phase-policy.mjs';import {NODE_TEXT_DIGESTS} from '../src/records.mjs';
const values=namespaceSourceOpeningPolicies(NODE_TEXT_DIGESTS),descriptor={contract:'sflow-source-unit/v1',id:'source',projectId:'project',repositoryId:'app',provider:'filesystem',selection:{excludePaths:[]},limits:SOURCE_LIMITS},
  original={schemaVersion:1,format:'sflow-source-snapshot/v1',unitId:'source',projectId:'project',repositoryId:'app',provider:'filesystem',selection:descriptor.selection,entries:[{path:'src/app.js',sha256:'a'.repeat(64),bytes:3,executable:false}]},
  next={...original,entries:[{...original.entries[0],sha256:'b'.repeat(64),bytes:4}]},changes=sourceSnapshotChanges(original,next,descriptor),
  context={schemaVersion:1,profile:'sflow-namespace-source-opening-context/v1',kind:'initial',workId:'story',phase:'code',generation:1,fromGeneration:0,
    basis:{head:{operationId:'original-binding'},revision:'original-revision',configuration:{}},sourceBinding:{operationId:'bound-source'},predecessor:null,repair:null,priorCode:null,previousDraft:null,artifact:null,
    repositories:[{repository:{id:'app',descriptor},baseline:{revision:values.hash(original),content:{namespace:'evidence',sha256:'c'.repeat(64),bytes:100}},
      observedRevision:values.hash(next),changes,classification:{entries:changes.entries.map(row=>({...row,protected:false,sourceBoundaryAllowed:true})),totals:changes.totals,roles:{source:1}}}],dirtyStartPolicy:'allow-explicit-adoption'};
test('exact source comparisons reconstruct every unchanged member and reject invented, removed or renamed bytes',()=>{
  assert.deepEqual(values.restored(original,changes,descriptor),next);
  for(const change of [row=>{row.entries[0].before.sha256='c'.repeat(64);},row=>{row.entries[0].newPath='../outside';},row=>{row.entries.push(row.entries[0]);},row=>{row.extra='hidden';}]){
    const bad=structuredClone(changes);change(bad);assert.throws(()=>values.restored(original,bad,descriptor),{code:'ENGINE_STORAGE_CORRUPT'});
  }
});
test('initial adoption is bound to every baseline, selection, delta, artifact and predecessor field',()=>{
  const plan=values.plan(context),opening=values.admit(context,{adoptExisting:true,confirm:plan.confirmation});assert.equal(values.assert(opening),opening);
  for(const change of [row=>{row.artifact={key:'summary.md',content:{namespace:'local',sha256:'d'.repeat(64),bytes:100}};},
    row=>{row.basis.revision='changed';},row=>{row.repositories[0].observedRevision=values.hash(original);},row=>{row.sourceBinding.operationId='different';}]){
    const next=structuredClone(context);change(next);assert.throws(()=>values.admit(next,{adoptExisting:true,confirm:plan.confirmation}),{code:'GENERATION_DIRTY_START'});
  }
  assert.equal(namespaceSourceOpeningContextProfile(context).version,1);
  assert.throws(()=>namespaceSourceOpeningContextProfile({...context,schemaVersion:2}),{code:'SCHEMA_VERSION_FUTURE'});
});
test('rollover summaries bound the display without reducing the confirmed complete change set',()=>{
  const many=structuredClone(context);many.repositories[0].classification.entries=Array.from({length:250},(_,i)=>({...context.repositories[0].classification.entries[0],newPath:'src/file-'+i+'.js'}));
  many.repositories[0].classification.totals={added:0,modified:250,removed:0,changes:250};
  const plan=values.plan(many);assert.equal(plan.review.changedPaths.length,200);assert.equal(plan.review.changedPathCount,250);assert.equal(plan.review.truncated,true);
  const binding={workId:'story',phase:'code',fromGeneration:0,generation:1};assert.equal(phaseRolloverPlan(binding,plan).schemaVersion,2);
  for(const change of [row=>{row.review.command='shell';},row=>{row.review.changedPathCount=1;},row=>{row.review.violations=Array(201).fill({});}]){
    const bad=structuredClone(plan);change(bad);assert.throws(()=>phaseRolloverPlan(binding,bad),{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  const changed=structuredClone(many);changed.repositories[0].classification.entries[249].newPath='src/not-in-the-preview.js';assert.notEqual(values.plan(changed).confirmation,plan.confirmation);
});
test('new successor and risk profiles do not reinterpret any original Code risk envelope',()=>{
  assert.deepEqual(namespaceCodePolicyProfile('code',{schemaVersion:32}),{version:32,executionRisk:true,kind:'code-delivery/v32',format:'sflow-namespace-code-policy/v32'});
  assert.deepEqual(namespaceCodePolicyProfile('code',{schemaVersion:33}),{version:33,executionRisk:true,knownFailureRisk:true,kind:'code-delivery/v33',format:'sflow-namespace-code-policy/v33'});
  assert.equal(namespaceCodePreflightVersion({history:{profile:'sflow-namespace-code-history/v13'}}),34);
  for(const version of [34,35]){const p=namespaceCodePolicyProfile('code',{schemaVersion:version});assert.equal(p.reviewedSuccessor,true);assert.equal(p.humanAcceptance===true,version===35);}
  for(const version of [32,33,36,37]){const p=namespaceCodePolicyProfile('code',{schemaVersion:version});
    for(const evidence of [1,31,32,33,34,35,36,37,38])assert.equal(namespaceCodeExecutionRiskEvidenceAllowed(p,evidence),version>=36?[34,35].includes(evidence):[1,31].includes(evidence));}
  assert.throws(()=>namespaceCodePolicyProfile('code',{schemaVersion:39}),{code:'SCHEMA_VERSION_FUTURE'});
});
