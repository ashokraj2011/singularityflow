/** Synthetic contract values only; real receipt acceptance is exercised by namespace journeys. */
import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceConvergencePolicies,namespaceConvergenceSelection} from '../src/kernel/namespace-convergence.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../src/engine-compatibility/node-configuration-path.mjs';
import {NODE_TEXT_VALUE_SYNTAX} from '../src/records.mjs';
const values=namespaceConvergencePolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_VALUE_SYNTAX),
  reference=letter=>({namespace:'evidence',sha256:letter.repeat(64),bytes:123}),
  input={phase:'deliver',generation:1,publication:{schemaVersion:1,format:'sflow-phase-publication-binding/v1',generation:1,record:reference('a')},
    reviewPacket:reference('b'),policy:reference('c'),report:reference('d'),approvals:[reference('e')]},
  configuration={key:'approved',content:{...reference('f'),namespace:'config'}};
function source({missing=false}={}){return {projectId:'example',workId:'story',phase:'reconcile',generation:1,configuration,inputs:[input],
  indexes:[{clauses:[{id:'S:REQ-001',body:'Convert frontend values.'},{id:'S:REQ-002',body:'Preserve backend values.'}]}],
  repositories:['frontend','backend'].map((id,index)=>{const clauseId='S:REQ-00'+(index+1);return {id,
    planned:[{claims:{[clauseId]:{expectedPaths:['src/converter.js'],tests:[]}}}],
    observed:[{claims:missing&&index?{}:{[clauseId]:{verdict:'matched',observedPaths:['src/converter.js'],testResults:[]}}}],
    reconciliation:{findings:[{path:'src/converter.js',status:'present',clauseIds:[clauseId]}]},planEntries:[]};})};}
test('namespace convergence keeps repository ownership and binds portable references without inventing Git metadata',()=>{
  const projection=values.project(source());assert.deepEqual(projection.projection.facts,[]);assert.equal(projection.source.inputs[0].publication.record.sha256,'a'.repeat(64));
  assert.deepEqual(projection.projection.allowedNext,['advance-to-verification']);
  assert.doesNotMatch(JSON.stringify(projection),/sourceBaseCommit|sourceTargetCommit|branchName|repositoryPath/u);
  assert.match(values.render(projection),/Input snapshot: `sha256:/u);assert.equal(values.publishable(projection,values.render(projection)),projection);
  assert.throws(()=>values.publishable(projection,values.render(projection)+'\nAn invented claim.'),{code:'CONVERGENCE_ARTIFACT_MISMATCH'});
});
test('a genuine missing trace remains visible until an exact human decision is part of the projection',()=>{
  const selected=source({missing:true}),open=values.project(selected);assert.ok(open.projection.facts.some(row=>row.repositoryId==='backend'&&row.clauseIds.includes('S:REQ-002')));
  assert.ok(open.projection.facts.every(row=>row.repositoryId==='backend'));
  assert.throws(()=>values.publishable(open,values.render(open)),{code:'CONVERGENCE_REVIEW_REQUIRED'});
  const adjudications=open.projection.facts.map(row=>({itemId:row.id,disposition:'accepted-deviation',reason:'The exact missing trace is accepted by the isolated contract reviewer.',
    actor:'reviewer',at:'2026-11-12T10:00:00.000Z',clauseIds:row.clauseIds})),decided=values.project({...selected,adjudications});
  assert.equal(decided.sourceSha256,open.sourceSha256);assert.notEqual(decided.projection.convergenceSha256,open.projection.convergenceSha256);
  assert.equal(values.publishable(decided,values.render(decided)),decided);assert.equal(decided.projection.findings.length,open.projection.facts.length);
});
test('repository-qualified fact identities cannot collide and unreadable prior human answers change the input binding',()=>{
  const selected=source({missing:true});selected.repositories[0].observed=[{claims:{}}];
  const both=values.project(selected);assert.equal(new Set(both.projection.facts.map(row=>row.id)).size,both.projection.facts.length);
  const unknown=structuredClone(selected);unknown.repositories[0].keptByPerson=null;
  assert.notEqual(values.project(unknown).sourceSha256,both.sourceSha256);
  const changed=structuredClone(both);changed.source.generation++;
  assert.throws(()=>values.assert(changed),{code:'ENGINE_CONVERGENCE_PROJECTION_INVALID'});
  assert.throws(()=>values.project({...selected,inputs:[{...input,approvals:[]}]}),{code:'ENGINE_CONVERGENCE_INPUT_INVALID'});
});
test('a retained successor selects its actual generation while a genuine reopened phase selects the next one',()=>{
  const phase={id:'reconcile',requiredArtifact:{kind:'convergence-report'},status:'in_progress',generation:2,approvalPolicy:{mode:'required'},reworkRevalidation:{generation:1}},
    workflow={status:'in_progress',currentPhase:'reconcile',phaseOrder:['reconcile'],phases:{reconcile:phase}};
  assert.equal(namespaceConvergenceSelection(workflow).generation,2);
  phase.reworkRevalidation.generation=2;assert.equal(namespaceConvergenceSelection(workflow).generation,3);
  phase.approvalPolicy.mode='none';assert.throws(()=>namespaceConvergenceSelection(workflow),{code:'CONVERGENCE_HUMAN_APPROVAL_REQUIRED'});
});
test('Code rework advances convergence iteration without inventing a convergence publication generation',()=>{
  const selected=source(),before=values.project(selected),successor=structuredClone(selected);
  successor.inputs[0].generation=2;successor.inputs[0].publication.generation=2;
  const after=values.project(successor);assert.equal(after.generation,1);assert.equal(after.iteration,2);
  assert.notEqual(after.sourceSha256,before.sourceSha256);assert.equal(values.assert(after),after);
  successor.inputs[0].publication.generation=1;
  assert.throws(()=>values.project(successor),{code:'ENGINE_CONVERGENCE_INPUT_INVALID'});
});
