import test from 'node:test';
import assert from 'node:assert/strict';
import {testRunRiskAuthorities,evidenceReuseAuthorities,visualProfileAuthorities,testCommandDecisionPhase,
  fallbackAuthorities} from '../src/kernel/approval-fallback.mjs';

function workflow() {
  return {phaseOrder:['scope','code','qa','end'],phases:{
    scope:{approvalPolicy:{authorities:['product']}},
    code:{approvalPolicy:{authorities:[]}},
    qa:{approvalPolicy:{authorities:['quality','quality'],requiredAuthorities:['security']}},
    end:{approvalPolicy:{authorities:[]}}
  }};
}

test('test decision authority uses its own groups or the next approving step, never a prior one',()=>{
  const story=workflow(),before=structuredClone(story);
  for(const authority of [testRunRiskAuthorities,evidenceReuseAuthorities,visualProfileAuthorities]) {
    assert.deepEqual(authority(story,'scope'),['product']);
    assert.deepEqual(authority(story,'code'),['quality','security']);
    assert.deepEqual(authority(story,'qa'),['quality','security']);
    assert.deepEqual(authority(story,'end'),[]);
    authority(story,'qa').push('caller-only');
  }
  assert.deepEqual(fallbackAuthorities(story,['end']),['quality','security'],
    'general fallback is a different policy and must not replace test decision authority');
  assert.deepEqual(story,before);
});

test('test-command self-approval selection retains the exact step that owns its review',()=>{
  const story=workflow();
  assert.equal(testCommandDecisionPhase(story,'scope'),'scope');
  assert.equal(testCommandDecisionPhase(story,'code'),'qa');
  assert.equal(testCommandDecisionPhase(story,'qa'),'qa');
  assert.equal(testCommandDecisionPhase(story,'end'),'end');
});

test('legacy and native authority exports use the same pure policy implementations',async()=>{
  const oldRisk=await import('../src/test-run-risk.mjs');
  const commandRisk=await import('../src/commands/decision-test-risk.mjs');
  const oldReuse=await import('../src/commands/decision-evidence-reuse.mjs');
  const oldVisual=await import('../src/commands/decision-visual-profile.mjs');
  assert.equal(oldRisk.testRunRiskAuthorities,testRunRiskAuthorities);
  assert.equal(commandRisk.testRunRiskAuthorities,testRunRiskAuthorities);
  assert.equal(oldReuse.evidenceReuseAuthorities,evidenceReuseAuthorities);
  assert.equal(oldVisual.visualProfileAuthorities,visualProfileAuthorities);
});
