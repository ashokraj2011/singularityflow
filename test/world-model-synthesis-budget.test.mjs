import assert from 'node:assert/strict';
import test from 'node:test';

import { compileWorldModelSynthesisPrompt } from '../src/world-model-synthesis-budget.mjs';

function packets() {
  return ['architecture', 'business', 'development', 'operations', 'release', 'security', 'testing']
    .map((view, index) => {
      const content = `# ${view} discovery packet\n\n${String(index).repeat(24 * 1024)}`;
      return {
        view, content, bytes: Buffer.byteLength(content),
        file: `/trusted/synthesis-packets/${view}.md`,
        expansionHandle: `file:/trusted/synthesis-packets/${view}.md`
      };
    });
}

test('aggregate synthesis budgeting summarizes oversized packet sets with exact expansion handles', () => {
  const result = compileWorldModelSynthesisPrompt({
    basePrompt: '# Builder contract\n\nCreate the registered files.',
    repositoryFacts: '## Deterministic facts\n\n- commit: abc',
    packets: packets(),
    maximumSynthesisInputTokens: 6000
  });
  assert.ok(Buffer.byteLength(result.text) <= 6000 * 4);
  assert.equal(result.receipt.packetSummaries, 7);
  assert.equal(result.receipt.packetExpansionHandles, 7);
  assert.ok(result.receipt.omittedPacketBytes > 0);
  assert.match(result.text, /Context omitted under approved policy/);
  assert.match(result.text, /file:\/trusted\/synthesis-packets\//);
  assert.equal(result.receipt.admissionAssurance, 'estimated');
  assert.equal(result.receipt.safeToEnforce, false);
});

test('aggregate synthesis keeps packet details when the estimated prompt-text budget fits', () => {
  const result = compileWorldModelSynthesisPrompt({
    basePrompt: '# Builder contract', repositoryFacts: '## Facts', packets: packets(),
    maximumSynthesisInputTokens: 100_000
  });
  assert.equal(result.receipt.omittedPacketBytes, 0);
  assert.equal(result.receipt.selectedPacketBytes, result.receipt.candidatePacketBytes);
  assert.match(result.text, /## security packet detail/);
});

test('aggregate synthesis refuses when mandatory contract and facts cannot fit', () => {
  assert.throws(() => compileWorldModelSynthesisPrompt({
    basePrompt: `# Builder\n\n${'x'.repeat(12 * 1024)}`,
    repositoryFacts: `## Facts\n\n${'y'.repeat(12 * 1024)}`,
    maximumSynthesisInputTokens: 2048
  }), (error) => error.code === 'WORLD_MODEL_SYNTHESIS_BUDGET_EXCEEDED');
});
