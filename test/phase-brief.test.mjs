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

test('a step whose name matches no profile is profiled by the task it declares', () => {
  // User-defined step names: before, all of these got the developer's implementation brief.
  assert.equal(phaseBriefProfile('root-cause', { task: 'analyze' }).id, 'verification');
  assert.equal(phaseBriefProfile('fix-proposal', { task: 'reason' }).id, 'design');
  assert.equal(phaseBriefProfile('handoff', { task: 'summarize' }).id, 'release');
  assert.equal(phaseBriefProfile('collect-facts', { task: 'clarify' }).id, 'intake');
  assert.equal(phaseBriefProfile('handoff', { task: 'summarize', maxBytes: 5000 }).budget, 5000);
  // Unchanged: a code task, no task, an unknown task, and any name a profile already matches.
  assert.equal(phaseBriefProfile('apply-change', { task: 'code' }).id, 'implementation');
  assert.equal(phaseBriefProfile('handoff').id, 'implementation');
  assert.equal(phaseBriefProfile('handoff', { task: 'toString' }).id, 'implementation');
  assert.equal(phaseBriefProfile('triage-intake', { task: 'analyze' }).id, 'intake');
  assert.equal(phaseBriefProfile('design', { task: 'summarize' }).id, 'design');
});

test('a declared output kind or code task chooses the reader before the step name', () => {
  // Before, a code step named for its Story matched "story" and got the product owner's brief.
  assert.equal(phaseBriefProfile('implement-story', { task: 'code' }).id, 'implementation');
  assert.equal(phaseBriefProfile('implement-story', { kind: 'implementation-summary' }).id, 'implementation');
  assert.equal(phaseBriefProfile('story-design', { kind: 'design' }).id, 'design');
  assert.equal(phaseBriefProfile('test-plan', { kind: 'design' }).id, 'design');
  assert.equal(phaseBriefProfile('sign-off', { kind: 'conformance-report' }).id, 'conformance');
  assert.equal(phaseBriefProfile('acceptance-proof', { kind: 'test-evidence', task: 'analyze' }).id, 'verification');
  // A name for the same reader still refines the declared kind.
  assert.equal(phaseBriefProfile('fix-spec', { kind: 'implementation-spec' }).id, 'reproduction');
  assert.equal(phaseBriefProfile('requirements', { kind: 'requirements' }).id, 'intake');
  // An unknown kind leaves the name, then the declared document task, in charge.
  assert.equal(phaseBriefProfile('triage-intake', { task: 'analyze', kind: 'impact-analysis' }).id, 'intake');
  assert.equal(phaseBriefProfile('collect', { task: 'analyze', kind: 'impact-analysis' }).id, 'verification');
  assert.equal(phaseBriefProfile('implement-story', { kind: 'implementation-summary', maxBytes: 5000 }).budget, 5000);
});
