import assert from 'node:assert/strict';
import test from 'node:test';

import { compileContextManifest } from '../src/context-manifest.mjs';
import { selectContextCandidates } from '../src/context-ranking.mjs';
import {
  dailyTokenLedgerPeriod, dailyTokenLedgerProjection, tokenLedgerProjection,
  tokenLedgerText
} from '../src/token-ledger.mjs';
import {
  classifyTokenOptimization, normalizeTokenEconomy, selectedTokenEconomyProfile,
  tokenEconomyDigest
} from '../src/token-economy.mjs';

test('[TKN:REQ-140] pilot policy defaults to observe and keeps feature switches independent', () => {
  const policy = normalizeTokenEconomy();
  assert.equal(policy.enabled, true);
  assert.equal(policy.mode, 'observe');
  assert.equal(policy.composer, 'legacy-v1');
  assert.equal(policy.observationFirewall, true);
  assert.equal(policy.historicalMemory, false);
  assert.equal(selectedTokenEconomyProfile(policy).maximumEstimatedPromptTokens, 18_000);
  assert.equal(normalizeTokenEconomy({ enabled: false, mode: 'enforce' }).mode, 'off');
  assert.equal(normalizeTokenEconomy({ composer: 'tkr-v1' }).composer, 'tkr-v1');
  assert.throws(() => normalizeTokenEconomy({ composer: 'ambient-latest' }), /composer/);
  assert.throws(
    () => selectedTokenEconomyProfile(policy, 'not-approved'),
    (error) => error.code === 'TKN_PROFILE_NOT_APPROVED'
  );
});

test('legacy composer preserves the historical token-economy digest convention', () => {
  const historicalDefaultDigest = '245c9fc0147b287981a3beecdfad8ddfff15eb7746d2eb1d72faaaefc5ec7f16';
  assert.equal(tokenEconomyDigest({}), historicalDefaultDigest);
  assert.equal(tokenEconomyDigest({ composer: 'legacy-v1' }), historicalDefaultDigest);
  assert.notEqual(tokenEconomyDigest({ composer: 'tkr-v1' }), historicalDefaultDigest);
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

test('daily Token Ledger uses an exact local-day interval and excludes identifying detail', () => {
  const period = dailyTokenLedgerPeriod({
    now: new Date('2026-09-07T06:00:00.000Z'), offsetMinutes: 330
  });
  assert.deepEqual(period, {
    date: '2026-09-07', timezone: 'utc-offset:+05:30', offsetMinutes: 330,
    startAt: '2026-09-06T18:30:00.000Z', endAt: '2026-09-07T18:30:00.000Z'
  });
  const models = [{
    id: 'private-invocation', status: 'completed', startedAt: '2026-09-06T18:31:00.000Z',
    provider: 'private-provider', model: 'private-model', requestedModel: 'private-request',
    subject: { id: 'PRIVATE-STORY', generation: 2 },
    usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 25 }
  }, {
    id: 'outside', status: 'completed', startedAt: '2026-09-06T18:29:59.999Z',
    usage: { inputTokens: 900, outputTokens: 100 }
  }, {
    id: 'failed', status: 'failed', startedAt: '2026-09-07T10:00:00.000Z',
    usage: { inputTokens: null, outputTokens: null }
  }];
  const packets = [{
    packetId: 'ctx-private', workId: 'PRIVATE-STORY', recordedAt: '2026-09-07T01:00:00.000Z',
    includedBytes: 400, estimatedTokens: 100, expandedBytes: 0,
    expandedEstimatedTokens: 0, expansions: [], itemUsage: [], captureCoverage: 'estimated'
  }, {
    packetId: 'legacy-private', workId: 'OLD-STORY', recordedAt: null,
    includedBytes: 800, estimatedTokens: 200
  }];
  const ledger = dailyTokenLedgerProjection(models, packets, { period });
  assert.equal(ledger.activity.modelInvocations, 2);
  assert.equal(ledger.activity.contextPackets, 1);
  assert.equal(ledger.activity.undatedInvocationsExcluded, 0);
  assert.equal(ledger.activity.legacyPacketsExcluded, 1);
  assert.equal(ledger.activity.invocationStatuses.completed, 1);
  assert.equal(ledger.activity.invocationStatuses.failed, 1);
  assert.equal(ledger.totals.inputTokens.value, 100);
  assert.equal(ledger.totals.sflowEstimatedTokens.value, 100);
  const serialized = JSON.stringify(ledger);
  for (const secret of [
    'private-invocation', 'private-provider', 'private-model', 'private-request',
    'PRIVATE-STORY', 'ctx-private', 'legacy-private', 'OLD-STORY'
  ]) assert.equal(serialized.includes(secret), false, secret);
  assert.match(tokenLedgerText(ledger), /2026-09-07/);
  assert.match(tokenLedgerText(ledger), /Historical packets without timestamps excluded: 1/);
});

test('[TKN:AC-010] lower tokens with a regressed quality floor is cheaper-but-worse', () => {
  const comparison = {
    evidenceGrade: 'B', cohorts: { matchedBaseline: 20, matchedTreatment: 20, privacyFloor: 10 },
    primaryMetric: { id: 'input-tokens', unit: 'tokens' },
    measurementAssurance: { primary: { providerTokenEvidence: true } },
    result: { gainPercent: 40 }, qualityGatePassed: false,
    guardrails: [{ metric: 'verification-success', passed: false }]
  };
  const classified = classifyTokenOptimization(comparison);
  assert.equal(classified.state, 'cheaper-but-worse');
  assert.equal(classified.releaseClaimAllowed, false);
  assert.equal(classifyTokenOptimization({
    ...comparison, qualityGatePassed: true, guardrails: [{ metric: 'verification-success', passed: true }]
  }).state, 'improved');
  assert.equal(classifyTokenOptimization({
    ...comparison,
    measurementAssurance: { primary: { providerTokenEvidence: false } },
    qualityGatePassed: true,
    guardrails: [{ metric: 'verification-success', passed: true }]
  }).releaseClaimAllowed, false);
});
