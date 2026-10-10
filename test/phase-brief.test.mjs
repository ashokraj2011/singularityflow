/**
 * The repository brief a phase prompt receives (World Model v5, M0): one ranked, cited, budgeted
 * brief per phase, read from the source with no build and no model.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { phaseBriefProfile, renderPhaseBrief } from '../src/knowledge/phase-brief.mjs';

test('a brief is ranked by the Story, ordered for the phase, cited, and fits the phase budget with one Not known line', () => {
  const template = {
    views: {
      overview: [{ text: 'shop: 12 code files in java', sources: [] }],
      rules: Array.from({ length: 12 }, (_, index) => ({
        text: `Rule ${index}: refuses "message number ${index}" with a fairly long explanation of the condition and outcome`,
        sources: [{ path: `src/rules/Rule${index}.java`, line: 10 + index, label: `src/rules/Rule${index}.java:${10 + index}` }]
      })),
      contracts: [{ text: 'POST /orders handled by OrderController.place', sources: [{ path: 'src/web/OrderController.java', line: 21, label: 'x' }] }],
      flows: [], impact: [], risks: [],
      questions: [{ text: 'Should cancelled orders be refunded?', sources: [] }]
    }
  };
  const profile = phaseBriefProfile('intake');
  assert.deepEqual([profile.id, profile.reader, profile.budget], ['intake', 'product', 2048]);
  const brief = renderPhaseBrief({
    repository: 'shop', commit: '0123456789abcdef', profile, focus: 'Refund cancelled orders', template,
    notKnown: ['no runtime or incident data', 'runtime-guarantee', 'schema-contract'], phase: 'intake'
  });
  assert.ok(Buffer.byteLength(brief.text) <= 2048, `${Buffer.byteLength(brief.text)} bytes`);
  assert.match(brief.text, /^# Repository brief: shop at 0123456789ab \(for intake, focused on this Story\)$/mu);
  assert.ok(brief.text.indexOf('## What exists') < brief.text.indexOf('## Rules that apply'));
  assert.ok(brief.text.indexOf('## Rules that apply') < brief.text.indexOf('## Questions for the product owner'), 'intake gets the product owner\'s questions');
  assert.match(brief.text, /## Contracts\n- POST \/orders handled by OrderController\.place \(OrderController\.java:21\)/u);
  assert.match(brief.text, /- … \d+ more: singularity-flow wm brief --phase intake/u, 'what did not fit is counted, with where to read it');
  assert.equal(brief.text.match(/^Not known: /gmu)?.length, 1);
  assert.match(brief.text, /Not known: no registered producer for runtime-guarantee, schema-contract; no runtime or incident data\./u);
  assert.match(brief.text, /Read without a model from the committed source\./u);
  assert.doesNotMatch(brief.text, /registered World Model/u, 'the brief names no registered World Model');
  const implementation = renderPhaseBrief({ repository: 'shop', profile: phaseBriefProfile('implementation'), template });
  assert.doesNotMatch(implementation.text, /Questions for the product owner/u, 'only the product reader gets questions');
  assert.equal(phaseBriefProfile('verification').budget, 3072);
  assert.equal(phaseBriefProfile('implementation-spec').budget, 4096);
  assert.equal(phaseBriefProfile('fix-design').id, 'implementation-spec');
  assert.equal(phaseBriefProfile('intake', { maxBytes: 5000 }).budget, 5000, 'worldModel.knowledge.maxBytes replaces the default');
});
