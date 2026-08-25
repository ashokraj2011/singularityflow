import assert from 'node:assert/strict';
import test from 'node:test';

import { assessTokenAdmission } from '../src/token-admission.mjs';

// This closed fixture tokenizer is intentionally not presented as any provider tokenizer. Its fixed
// vocabulary makes the admission arithmetic reproducible while proving bytes/4 is only an estimate.
function fixtureTokens(text) {
  return [...String(text).matchAll(/[\p{L}\p{N}_]+|[^\s]/gu)].length;
}

const corpus = {
  prose: 'The service retries failed requests with bounded exponential backoff.',
  source: 'public final class RetryPolicy { int attempts = 3; }',
  json: '{"enabled":true,"maximum":3}',
  table: '| Name | Value |\n|---|---|\n| retry | 3 |',
  unicode: 'नमस्ते दुनिया 👋🏽 café 東京',
  identifiers: 'thisIsAnExtremelyLongIdentifierThatAByteEstimateCannotTokenizeExactly',
  minified: 'function f(a){return a.map(x=>x+1).filter(Boolean)}'
};

test('deterministic tokenizer fixtures keep exact counts distinct from bytes-per-four estimates', () => {
  let differs = 0;
  for (const [kind, text] of Object.entries(corpus)) {
    const exact = fixtureTokens(text);
    const estimate = Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
    if (exact !== estimate) differs += 1;
    const admission = assessTokenAdmission({
      model: `fixture/${kind}`,
      logicalPromptBytes: Buffer.byteLength(text, 'utf8'),
      logicalPromptTokens: { value: exact, assurance: 'tokenizer-exact' },
      systemAndToolReserveTokens: { value: 12, assurance: 'conservative-upper-bound' },
      historyTokens: { value: 0, assurance: 'conservative-upper-bound' },
      maximumInputTokens: exact + 12,
      policyApprovedConservativeUpperBound: true
    });
    assert.equal(admission.safeToEnforce, true, kind);
    assert.equal(admission.admitted, true, kind);
    assert.equal(admission.logicalPromptTokens.value, exact, kind);
  }
  assert.ok(differs >= 5, 'the corpus must expose substantial bytes/4 estimation disagreement');
});

test('unknown history stays unknown and can never be silently admitted as zero', () => {
  const admission = assessTokenAdmission({
    logicalPromptBytes: 400,
    logicalPromptTokens: { value: 100, assurance: 'tokenizer-exact' },
    systemAndToolReserveTokens: { value: 20, assurance: 'provider-reported' },
    maximumInputTokens: 200
  });
  assert.equal(admission.historyTokens.value, null);
  assert.equal(admission.safeToEnforce, false);
  assert.equal(admission.admitted, null);
  assert.equal(admission.totalAdmissionTokens.value, 120);
  assert.equal(admission.totalAdmissionTokens.assurance, 'partial');
});

test('bare numeric observations never masquerade as provider or tokenizer assurance', () => {
  const admission = assessTokenAdmission({
    logicalPromptBytes: 100,
    logicalPromptTokens: 25,
    systemAndToolReserveTokens: 10,
    historyTokens: 0,
    maximumInputTokens: 100
  });
  assert.equal(admission.logicalPromptTokens.assurance, 'estimated');
  assert.equal(admission.systemAndToolReserveTokens.assurance, 'estimated');
  assert.equal(admission.historyTokens.assurance, 'estimated');
  assert.equal(admission.safeToEnforce, false);
  assert.equal(admission.admitted, null);
});
