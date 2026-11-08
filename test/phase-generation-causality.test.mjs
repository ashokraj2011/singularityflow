import test from 'node:test';
import assert from 'node:assert/strict';
import {phaseNeedsGeneration,hasPublishedPhaseGeneration} from '../src/kernel/phase-policy.mjs';
const at='2026-11-08T18:00:00.000Z';
const binding=generation=>({schemaVersion:1,format:'sflow-phase-publication-binding/v1',generation,
  record:{namespace:'evidence',sha256:'a'.repeat(64),bytes:10}});
function fixture(){const phase={id:'review',generation:2,status:'in_progress',rejectedAt:at,reworkRevalidation:{generation:1,invalidatedAt:at},
  generationPolicy:{requirement:'required'}};
  return {phase,workflow:{workItem:{id:'example'},phases:{review:phase},history:[{event:'phase_generated',phase:'review',at}]}};}
test('legacy unbound generations retain their original timestamp readiness meaning',()=>{
  const {workflow,phase}=fixture();assert.equal(phaseNeedsGeneration(workflow,phase),true);
  workflow.history[0].at='2026-11-08T18:00:00.001Z';assert.equal(phaseNeedsGeneration(workflow,phase),false);
});
test('a retained successor publication supersedes rework without relying on wall-clock ordering',()=>{
  for(const rejectedAt of [at,'2026-11-09T00:00:00.000Z']) {
    const {workflow,phase}=fixture();phase.rejectedAt=rejectedAt;phase.publicationBindings=[binding(1),binding(2)];
    assert.equal(hasPublishedPhaseGeneration(phase),true);assert.equal(phaseNeedsGeneration(workflow,phase),false);
  }
});
test('old, absent, open or malformed publication bindings cannot satisfy causal readiness',()=>{
  const {workflow,phase}=fixture();phase.publicationBindings=[binding(1)];assert.equal(phaseNeedsGeneration(workflow,phase),true);
  phase.publicationBindings=[binding(2)];phase.generation=1;assert.equal(phaseNeedsGeneration(workflow,phase),true);
  phase.generation=2;phase.generationIntent={status:'open',generation:2};assert.equal(phaseNeedsGeneration(workflow,phase),true);
  delete phase.generationIntent;phase.publicationBindings[0].record.sha256='invalid';
  assert.throws(()=>phaseNeedsGeneration(workflow,phase),{code:'PUBLICATION_BINDING_INVALID'});
});
test('an affected skill amendment still requires its own successor even when an older causal binding exists',()=>{
  const {workflow,phase}=fixture();phase.publicationBindings=[binding(2)];phase.skillAmendmentRevalidation={state:'affected',generationAtAdoption:2};
  assert.equal(phaseNeedsGeneration(workflow,phase),true);
});
