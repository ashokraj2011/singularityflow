import assert from 'node:assert/strict';
import test from 'node:test';

import { compileContextManifest } from '../src/context-manifest.mjs';
import { selectContextCandidates } from '../src/context-ranking.mjs';
import { tokenLedgerProjection } from '../src/token-ledger.mjs';
import {
  classifyTokenOptimization, normalizeTokenEconomy, selectedTokenEconomyProfile
} from '../src/token-economy.mjs';

test('[TKN:REQ-140] pilot policy defaults to observe and keeps feature switches independent', () => {
  const policy = normalizeTokenEconomy();
  assert.equal(policy.enabled, true);
  assert.equal(policy.mode, 'observe');
  assert.equal(policy.observationFirewall, true);
  assert.equal(policy.historicalMemory, false);
  assert.equal(selectedTokenEconomyProfile(policy).maxInputTokens, 18_000);
  assert.equal(normalizeTokenEconomy({ enabled: false, mode: 'enforce' }).mode, 'off');
  assert.throws(
    () => selectedTokenEconomyProfile(policy, 'not-approved'),
    (error) => error.code === 'TKN_PROFILE_NOT_APPROVED'
  );
});

test('[TKN:CON-008] mandatory governance context is selected first and never budget-evicted', () => {
  const candidates = [
    {
      kind: 'source', subject: 'optional', content: 'o'.repeat(30), mandatory: false,
      reason: { code: 'flight-plan.direct-target' }, source: { type: 'git' }
    },
    {
      kind: 'policy', subject: 'law', content: 'l'.repeat(20), mandatory: true,
      reason: { code: 'governance.mandatory' }, source: { type: 'pinned-resolution' }
    }
  ];
  const selected = selectContextCandidates(candidates, 25);
  assert.deepEqual(selected.items.map((entry) => entry.subject), ['law']);
  assert.throws(
    () => selectContextCandidates(candidates, 19),
    (error) => error.code === 'TKN_MANDATORY_CONTEXT_OVERFLOW'
      && error.details.requiredBytes === 20
      && /larger token-economy profile/.test(error.details.nextAction)
  );
});

test('[TKN:REQ-070] cache composition has stable, session-stable, and variable identities', () => {
  const first = compileContextManifest({
    definition: { workflow: 'v1' }, flightPlan: { id: 'plan-1' }, observation: { id: 'one' }
  });
  const second = compileContextManifest({
    definition: { workflow: 'v1' }, flightPlan: { id: 'plan-1' }, observation: { id: 'two' }
  });
  assert.equal(first.cacheKey, second.cacheKey);
  assert.equal(first.sessionCacheKey, second.sessionCacheKey);
  assert.notEqual(first.cacheManifestId, second.cacheManifestId);
  assert.deepEqual(first.mutableTail, [...first.sessionStable, ...first.variable]);
});

test('[TKN:REQ-082] ledger distinguishes delivered from digest-deduplicated unique context', () => {
  const workflow = {
    workItem: { id: 'TKN-1' }, phaseOrder: ['implementation'],
    phases: { implementation: { id: 'implementation', usage: [] } }
  };
  const base = {
    phase: 'implementation', includedBytes: 400, estimatedTokens: 100,
    expandedBytes: 0, expandedEstimatedTokens: 0, expansions: [],
    itemUsage: [{ itemDigest: 'same', bytes: 400, estimatedTokens: 100 }],
    captureCoverage: 'estimated', outcome: { completed: true, verification: 'passed' }
  };
  const ledger = tokenLedgerProjection(workflow, [
    { ...base, packetId: 'ctx-1' }, { ...base, packetId: 'ctx-2' }
  ]);
  assert.equal(ledger.totals.deliveredContextTokens.value, 200);
  assert.equal(ledger.totals.uniqueContextTokens.value, 100);
  assert.equal(ledger.outcomes.length, 2);
  assert.equal(ledger.coverage.estimated, 2);
});

test('[TKN:AC-010] lower tokens with a regressed quality floor is cheaper-but-worse', () => {
  const comparison = {
    evidenceGrade: 'B', cohorts: { matchedBaseline: 20, matchedTreatment: 20, privacyFloor: 10 },
    result: { gainPercent: 40 }, qualityGatePassed: false,
    guardrails: [{ metric: 'verification-success', passed: false }]
  };
  const classified = classifyTokenOptimization(comparison);
  assert.equal(classified.state, 'cheaper-but-worse');
  assert.equal(classified.releaseClaimAllowed, false);
  assert.equal(classifyTokenOptimization({
    ...comparison, qualityGatePassed: true, guardrails: [{ metric: 'verification-success', passed: true }]
  }).state, 'improved');
});
