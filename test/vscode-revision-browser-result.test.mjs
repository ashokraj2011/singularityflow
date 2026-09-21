import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRevisionBrowserResultView,
  revisionBrowserResultCardHtml
} from '../apps/vscode/src/views/revision-browser-result-model.ts';

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;
const TREE = 'd'.repeat(40);

function observedResult(overrides = {}) {
  return {
    runId: 'BRR-20260921-001',
    runState: { state: 'terminal', reasonCode: 'completed' },
    receipt: {
      status: 'completed',
      reasonCode: 'completed',
      executionAssurance: 'bounded-effects-only',
      receiptSha256: HASH_B,
      runKey: {
        candidateId: 'CAN-20260921-001',
        candidateTree: TREE,
        candidateRefSha256: HASH_A,
        runKeySha256: HASH_C
      },
      tests: { discovered: 5, passed: 3, failed: 1, skipped: 1, flaky: 0 },
      artifacts: [
        {
          kind: 'playwright-screenshot',
          path: 'revision/browser/home.png',
          mediaType: 'image/png',
          sha256: HASH_A,
          bytes: 8412,
          captureProvenanceSha256: HASH_C,
          accessClass: 'private',
          retentionClass: 'story',
          previewable: true
        },
        {
          kind: 'structured-test-result',
          path: 'revision/browser/tests.json',
          mediaType: 'application/json',
          sha256: HASH_B,
          bytes: 512,
          accessClass: 'private',
          retentionClass: 'story',
          previewable: true
        },
        {
          kind: 'playwright-video',
          path: 'revision/browser/failure.webm',
          mediaType: 'video/webm',
          sha256: HASH_C,
          bytes: 12000,
          accessClass: 'private',
          retentionClass: 'ephemeral',
          previewable: true
        }
      ],
      visualComparisons: []
    },
    comparison: {
      status: 'observed',
      staleBindings: ['baseline', 'candidate-ref'],
      visuals: [{
        testId: 'filters/default-customer',
        verdict: 'different',
        diffRatio: 0.08,
        tolerance: 0.01,
        baselineSha256: HASH_A,
        actualSha256: HASH_B,
        diffSha256: HASH_C
      }],
      criterionSatisfactionEstablished: true
    },
    assertionWitnessEstablished: true,
    testingVerificationEstablished: true,
    publicationEligibilityEstablished: true,
    ...overrides
  };
}

test('revision browser result card reports bounded evidence without granting authority', () => {
  const view = buildRevisionBrowserResultView(observedResult());

  assert.equal(view.available, true);
  assert.equal(view.tone, 'observed');
  assert.equal(view.candidate.id, 'CAN-20260921-001');
  assert.equal(view.candidate.tree, TREE);
  assert.equal(view.run.id, 'BRR-20260921-001');
  assert.equal(view.run.resultStatus, 'completed');
  assert.equal(view.run.comparisonStatus, 'observed');
  assert.deepEqual(view.tests, { discovered: 5, passed: 3, failed: 1, skipped: 1, flaky: 0 });
  assert.deepEqual(view.staleBindings, ['baseline', 'candidate-ref']);
  assert.deepEqual(view.artifacts.map(({ kind, provenance, previewable }) => ({
    kind, provenance, previewable
  })), [
    { kind: 'playwright-screenshot', provenance: 'unverified', previewable: false },
    { kind: 'structured-test-result', provenance: 'unverified', previewable: false },
    { kind: 'playwright-video', provenance: 'unverified', previewable: false }
  ]);
  assert.deepEqual(view.boundary, {
    executionAssurance: 'bounded-effects-only',
    assertionWitnessEstablished: false,
    criterionSatisfactionEstablished: false,
    testingVerificationEstablished: false,
    publicationEligibilityEstablished: false,
    statement: 'Observed candidate evidence only — this card does not establish a passing repository test, criterion satisfaction, Testing or Verification, publication, approval, merge, deployment, or release authority.'
  });

  const html = revisionBrowserResultCardHtml(view);
  assert.match(html, /CAN-20260921-001/);
  assert.match(html, /BRR-20260921-001/);
  assert.match(html, /Discovered<\/dt><dd>5/);
  assert.match(html, /baseline/);
  assert.match(html, /unverified/);
  assert.match(html, /Opaque artifacts/);
  assert.doesNotMatch(html, /<h3>Artifact provenance<\/h3>/);
  assert.doesNotMatch(html, />complete</);
  assert.match(html, /8\.00%/);
  assert.match(html, /does not establish a passing repository test/);
  assert.doesNotMatch(html, /publication enabled|criterion satisfied|green verdict/i);
});

test('revision browser result card escapes hostile record text and ignores unsafe payload fields', () => {
  const source = observedResult();
  source.runState.reasonCode = '<img src=x onerror=alert(1)>';
  source.receipt.artifacts[0].path = '<script>steal()</script>.png';
  source.receipt.artifacts[0].reportHtml = '<img src=x onerror=steal()>';
  source.receipt.artifacts[0].bytesPayload = '<script>payload()</script>';
  source.comparison.staleBindings = ['<svg onload=steal()>'];
  source.comparison.visuals[0].testId = '<a href="command:evil">click</a>';
  source.command = 'rm -rf /';
  source.actionHandle = 'unsafe-handle';

  const view = buildRevisionBrowserResultView(source);
  const html = revisionBrowserResultCardHtml(view);

  assert.match(html, /&lt;script&gt;steal\(\)&lt;\/script&gt;\.png/);
  assert.match(html, /&lt;svg onload=steal\(\)&gt;/);
  assert.match(html, /&lt;a href=&quot;command:evil&quot;&gt;click&lt;\/a&gt;/);
  assert.doesNotMatch(html, /<script|<img|<svg|<a href=/i);
  assert.doesNotMatch(html, /onerror=alert|onerror=steal|payload\(\)|rm -rf|unsafe-handle/i);
  assert.doesNotMatch(html, /onclick|data-command|href=["']command:/i);
});

test('revision browser result model exposes unavailable or malformed observations honestly', () => {
  const unavailable = buildRevisionBrowserResultView({
    publicationEligibilityEstablished: true,
    reportHtml: '<h1>passed</h1>'
  });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.tone, 'unavailable');
  assert.equal(unavailable.run.state, 'unavailable');
  assert.equal(unavailable.tests, null);
  assert.equal(unavailable.boundary.publicationEligibilityEstablished, false);
  assert.match(revisionBrowserResultCardHtml(unavailable), /Structured test totals are not available/);

  const malformed = observedResult();
  malformed.receipt.tests = { discovered: 4, passed: 4, failed: 1, skipped: 0, flaky: 0 };
  malformed.comparison.status = 'stale';
  const view = buildRevisionBrowserResultView(malformed);
  assert.equal(view.tests, null);
  assert.equal(view.tone, 'attention');
  assert.equal(view.headline, 'Browser revision evidence is stale');
});
