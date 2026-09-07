import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAutoQualityComparison } from '../src/auto/auto-quality-comparison.mjs';
import { normalizeImpactDefinition } from '../src/impact-config.mjs';
import { compareImpactReceipts } from '../src/impact.mjs';

const CONFIGURATION = 'c'.repeat(64);
const REVISION = 'd'.repeat(40);
const HASH = (character) => `sha256:${character.repeat(64)}`;

function registeredStudy() {
  return normalizeImpactDefinition({
    version: 2,
    automaticEnrollment: true,
    studies: [{
      id: 'auto-token-quality', label: 'Auto token and quality comparison', enabled: true,
      unit: 'story', method: 'matched-observational',
      groups: [
        { id: 'baseline', label: 'Baseline', assistanceMode: 'baseline', weight: 1 },
        { id: 'auto', label: 'Auto', assistanceMode: 'governed-agent', weight: 1 }
      ],
      matching: {
        dimensions: ['capability', 'repository-class', 'work-type', 'complexity', 'risk', 'time-period'],
        timePeriod: 'quarter', seed: 'auto-quality-v1', weighting: 'minimum-cohort-count'
      },
      primaryMetric: { id: 'input-tokens', direction: 'lower' },
      guardrails: [{ id: 'first-pass-approval-rate', maximumRegressionPercent: 0 }],
      reporting: { bootstrapSamples: 100, confidenceLevel: 0.95 },
      privacy: {
        individualReporting: false, minimumCohortSize: 2,
        pseudonymizeContributors: true,
        allowedDimensions: [
          'capability', 'repository-class', 'work-type', 'complexity', 'risk', 'time-period'
        ]
      }
    }]
  }).studies[0];
}

function receipt(groupId, index, tokens, quality = 1, overrides = {}) {
  const workId = groupId === 'auto' && index === 1 ? 'AUTO-STORY' : `${groupId}-${index}`;
  const revision = workId === 'AUTO-STORY' ? REVISION : `${index}`.repeat(40);
  const assistance = groupId === 'baseline' ? 'baseline' : 'governed-agent';
  return {
    schemaVersion: 1, status: 'finalized',
    subject: {
      workId, subjectRevision: { commit: revision, sourceTreeSha256: HASH('a') },
      capability: 'payments', repositoryClass: 'delivery', workType: 'feature',
      complexity: 'medium', risk: 'small', timePeriod: '2026-Q3'
    },
    study: {
      id: 'auto-token-quality', groupId, configurationSha256: CONFIGURATION
    },
    assistance: { planned: assistance, actual: assistance, exposure: [] },
    metrics: {
      'input-tokens': {
        value: tokens, status: 'exact', assurance: 'kernel-derived'
      },
      'first-pass-approval-rate': {
        value: quality, status: 'exact', assurance: 'kernel-derived'
      }
    },
    economics: {
      models: [{ provider: 'provider', model: 'model-a', inputTokens: tokens }]
    },
    publication: { eventType: 'impact-finalized', subjectCommit: revision },
    integrity: { sha256: HASH(groupId === 'baseline' ? 'b' : 'e') },
    ...overrides
  };
}

function cohort({ treatmentQuality = 1 } = {}) {
  return [
    receipt('baseline', 1, 100), receipt('baseline', 2, 110),
    receipt('auto', 1, 60, treatmentQuality), receipt('auto', 2, 70, treatmentQuality)
  ];
}

function report(overrides = {}) {
  return {
    kind: 'auto-flight-report', flightId: `AFL-${'A'.repeat(26)}`,
    reportSha256: HASH('f'), story: { workId: 'AUTO-STORY' },
    lastSuccessfulStoryRevision: REVISION, ...overrides
  };
}

function project(receipts = cohort(), reportValue = report()) {
  const study = registeredStudy();
  const comparison = compareImpactReceipts(receipts, study, {
    configurationSha256: CONFIGURATION
  });
  return buildAutoQualityComparison({
    report: reportValue, study, configurationSha256: CONFIGURATION, receipts, comparison
  });
}

test('Auto comparison permits a savings claim only from exact registered cohort evidence', () => {
  const value = project();
  assert.equal(value.kind, 'auto-quality-comparison');
  assert.equal(value.contentFree, true);
  assert.equal(value.classification.state, 'improved');
  assert.equal(value.classification.releaseClaimAllowed, true);
  assert.equal(value.cohorts.matchedBaseline, 2);
  assert.equal(value.cohorts.matchedTreatment, 2);
  assert.equal(value.tokenMetric.providerTokenEvidence, true);
  assert.match(value.comparisonSha256, /^sha256:[a-f0-9]{64}$/);
});

test('Auto comparison labels lower tokens with regressed quality as cheaper-but-worse', () => {
  const value = project(cohort({ treatmentQuality: 0.5 }));
  assert.equal(value.classification.state, 'cheaper-but-worse');
  assert.equal(value.classification.releaseClaimAllowed, false);
  assert.equal(value.quality.gatePassed, false);
});

test('Auto comparison refuses a receipt that is not bound to the final report revision', () => {
  assert.throws(
    () => project(cohort(), report({ lastSuccessfulStoryRevision: '9'.repeat(40) })),
    (error) => error.code === 'AUTO_COMPARISON_REVISION_MISMATCH'
  );
});

test('Auto comparison refuses unobserved or non-treatment Story evidence', () => {
  const missing = cohort().map((item) => item.subject.workId === 'AUTO-STORY'
    ? { ...item, subject: { ...item.subject, workId: 'someone-else' } } : item);
  assert.throws(
    () => project(missing),
    (error) => error.code === 'AUTO_COMPARISON_RECEIPT_UNAVAILABLE'
  );
  const baselineStory = cohort().map((item) => item.subject.workId === 'AUTO-STORY'
    ? {
        ...item, study: { ...item.study, groupId: 'baseline' },
        assistance: { ...item.assistance, planned: 'baseline', actual: 'baseline' }
      } : item);
  const comparison = compareImpactReceipts(cohort(), registeredStudy(), {
    configurationSha256: CONFIGURATION
  });
  assert.throws(
    () => buildAutoQualityComparison({
      report: report(), study: registeredStudy(), configurationSha256: CONFIGURATION,
      receipts: baselineStory, comparison
    }),
    (error) => error.code === 'AUTO_COMPARISON_TREATMENT_UNPROVEN'
  );
});

test('Auto comparison requires the selected flight to contribute exact matched token evidence', () => {
  const incomplete = cohort().map((item) => item.subject.workId === 'AUTO-STORY'
    ? {
        ...item,
        metrics: {
          ...item.metrics,
          'input-tokens': { ...item.metrics['input-tokens'], status: 'unavailable' }
        }
      } : item);
  const comparison = compareImpactReceipts(cohort(), registeredStudy(), {
    configurationSha256: CONFIGURATION
  });
  assert.throws(
    () => buildAutoQualityComparison({
      report: report(), study: registeredStudy(), configurationSha256: CONFIGURATION,
      receipts: incomplete, comparison
    }),
    (error) => error.code === 'AUTO_COMPARISON_TREATMENT_EVIDENCE_INCOMPLETE'
      && error.details?.exactProviderTokenEvidence === false
  );
});
