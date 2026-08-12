/**
 * Specification quality and clarification markers. `[SPK:AC-002]`
 *
 * Two properties carry the weight. A marker is resolved only when a later generation removes it
 * **and** the answer is on record `[SPK:REQ-067]` — deleting the question is what someone does to
 * quiet the gate, and treating that as resolution would make the mechanism decorative. And the
 * analyzer never claims prose is good `[SPK:CON-027]`; it reports only what is checkably wrong,
 * because a tool that issues judgements without a model is guessing while sounding certain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MARKER_MODES, evaluateMarkerPolicy, extractMarkers, markerPolicy, reconcileMarkers
} from '../src/clarification-markers.mjs';
import {
  CHECKLIST_DECISIONS, STARTER_CHECKLIST, analyzeSpecification, evaluateSpecificationQuality,
  policyHash, specificationQualityPolicy, validateChecklistDecisions
} from '../src/specification-quality.mjs';

const SPEC = [
  '# Specification', '', '## Actors', '', 'A reviewer.', '',
  '## User scenarios', '', 'Given a Story, when published, then it is reviewable.', '',
  '## Requirements', '',
  '- The system records an answer. [DEMO:REQ-001]',
  '- The system refuses a deletion. [DEMO:REQ-002]'
].join('\n');

const analyze = (markdown, options = {}) => analyzeSpecification(markdown, {
  artifactPath: 'artifacts/specification/spec.md', phase: 'specification', generation: 1,
  policy: { mode: 'enforce' }, namespace: 'DEMO', ...options
});

test('markers are found only where a marker can mean something', () => {
  // `[SPK:REQ-063]`: the same ignored regions as clause extraction — fenced code, inline code, and
  // kernel-managed blocks. Asserted through the real extractor, not a copy of the rules.
  const document = [
    '[NEEDS CLARIFICATION: which roles may retry?]',
    'Inline `[NEEDS CLARIFICATION: not this one]` stays quiet.',
    '```', '[NEEDS CLARIFICATION: nor this one]', '```',
    '<!-- singularity-flow:inputs:start -->',
    '[NEEDS CLARIFICATION: nor this]',
    '<!-- singularity-flow:inputs:end -->'
  ].join('\n');
  const { markers } = extractMarkers(document);
  assert.equal(markers.length, 1, 'a marker inside code or a managed block was counted');
  assert.equal(markers[0].question, 'which roles may retry?');
  assert.equal(markers[0].line, 1);
});

test('a marker that asks nothing, or never closes, is malformed rather than open', () => {
  const { markers, malformed } = extractMarkers('[NEEDS CLARIFICATION: ]\n[NEEDS CLARIFICATION: never closed\n');
  assert.equal(markers.length, 0);
  assert.deepEqual(malformed.map((entry) => entry.reason).sort(), [
    'the marker is not closed on its line', 'the question is empty'
  ]);
});

test('deleting a question is not answering it', () => {
  // `[SPK:REQ-067]`, and the whole reason the mechanism is worth having.
  const previous = [{ question: 'who may retry?', questionHash: 'who may retry?', line: 4 }];

  const deleted = reconcileMarkers({ current: [], previous, answers: [] });
  assert.equal(deleted.vanished.length, 1);
  assert.match(deleted.vanished[0].reason, /without a recorded clarification answer/);
  assert.equal(deleted.open.length, 0);

  // The same removal with an answer on record is resolution, and reports nothing.
  const answered = reconcileMarkers({ current: [], previous, answers: [{ questionHash: 'who may retry?' }] });
  assert.deepEqual(answered.vanished, []);

  // An answer recorded while the marker is still in the text does not resolve it: the artifact has
  // not been regenerated to incorporate the answer yet.
  const stillPresent = reconcileMarkers({
    current: previous, previous, answers: [{ questionHash: 'who may retry?' }]
  });
  assert.equal(stillPresent.open.length, 0);
  assert.equal(stillPresent.incorporated.length, 1);
});

test('marker policy blocks, warns, or stays silent', () => {
  const open = [{ line: 3, question: 'who?' }];
  assert.deepEqual([...MARKER_MODES], ['off', 'warn', 'block']);
  assert.equal(evaluateMarkerPolicy({ mode: 'block' }, { open }).errors.length, 1);
  assert.equal(evaluateMarkerPolicy({ mode: 'warn' }, { open }).warnings.length, 1);
  assert.deepEqual(evaluateMarkerPolicy({ mode: 'off' }, { open }), { mode: 'off', errors: [], warnings: [] });
  // Pinned separately from the conversational clarification mode `[SPK:REQ-064]`, and absent means
  // off — a gate nobody asked for is a trap.
  assert.equal(markerPolicy(undefined).mode, 'off');
  assert.throws(() => markerPolicy({ mode: 'strict' }), /must be one of/);
});

test('the analyzer reports what is checkable and refuses to judge the prose', () => {
  const clean = analyze(SPEC);
  assert.deepEqual(clean.findings, [], `a clean specification produced ${JSON.stringify(clean.findings)}`);
  assert.equal(clean.clauseCount, 2);
  // `[SPK:CON-027]`: said in the report itself, because a clean run is exactly when someone reads
  // it as "the specification is good".
  assert.match(clean.disclaimer, /makes no claim that the specification is complete, clear, consistent, or correct/);

  const withMarker = analyze(`${SPEC}\n\n[NEEDS CLARIFICATION: who may retry?]\n`);
  assert.deepEqual(withMarker.findings.map((finding) => finding.kind), ['unresolved-clarification']);

  const missingSection = analyze('# Specification\n\n## Requirements\n\n- A thing. [DEMO:REQ-001]\n');
  const kinds = missingSection.findings.map((finding) => finding.kind);
  assert.ok(kinds.every((kind) => kind === 'missing-required-section'));
  assert.equal(missingSection.findings.length, 2, 'Actors and User scenarios are both required');
});

test('a defect the kernel extractor owns is surfaced, not re-implemented', () => {
  // `extractClauses` already refuses duplicate anchors and dangling dependencies. The analyzer
  // reports its refusal rather than carrying a second, weaker copy of those checks.
  const duplicated = analyze('# S\n\n## Actors\n\nx\n\n## User scenarios\n\ny\n\n## Requirements\n\n- One. [DEMO:REQ-001]\n- Two. [DEMO:REQ-001]\n');
  assert.deepEqual(duplicated.findings.map((finding) => finding.kind), ['clause-extraction-failed']);
  assert.match(duplicated.findings[0].message, /duplicated/);
});

test('the same bytes always produce the same findings', () => {
  // `[SPK:REQ-056]`, and the reason the analyzer takes no clock: the observation time is the
  // caller's to add, so a report can be compared against another run.
  const first = analyze(SPEC);
  const second = analyze(SPEC);
  assert.deepEqual(first, second);
  assert.equal(first.binding.artifactSha256, second.binding.artifactSha256);

  // The report is bound to what produced it, so it cannot be quoted against a different artifact.
  const elsewhere = analyze(SPEC, { artifactPath: 'artifacts/planning/plan.md' });
  assert.notEqual(elsewhere.binding.artifactPath, first.binding.artifactPath);
  assert.equal(elsewhere.binding.artifactSha256, first.binding.artifactSha256, 'same bytes, same content hash');
});

test('the policy decides severity, and enforce is the starter default for specification', () => {
  const report = analyze(`${SPEC}\n\n[NEEDS CLARIFICATION: who?]\n`);
  assert.equal(evaluateSpecificationQuality(report).errors.length, 1);
  assert.equal(evaluateSpecificationQuality({ ...report, mode: 'warn' }).warnings.length, 1);
  assert.deepEqual(evaluateSpecificationQuality({ ...report, mode: 'off' }), { errors: [], warnings: [] });

  assert.equal(specificationQualityPolicy({ mode: 'enforce' }).mode, 'enforce');
  assert.equal(specificationQualityPolicy({}).mode, 'off');
  assert.equal(specificationQualityPolicy({}).assisted, false, 'assisted analysis must be opt-in');
  assert.throws(() => specificationQualityPolicy({ mode: 'strict' }), /must be one of/);
  // The policy hash binds the checklist too, so changing an article changes the report identity.
  assert.notEqual(
    policyHash({ mode: 'enforce' }),
    policyHash({ mode: 'enforce' }, { ...STARTER_CHECKLIST, version: 2 })
  );
});

test('every checklist article needs a decision, and an exception needs a reason', () => {
  // `[SPK:REQ-060]`, `[SPK:REQ-061]`, `[SPK:REQ-181]`. Six articles, none machine-decidable — the
  // checklist is the reviewer's instrument and the analyzer only supplies evidence for it.
  assert.equal(STARTER_CHECKLIST.articles.length, 6);
  assert.deepEqual(STARTER_CHECKLIST.articles.map((article) => article.id), [
    'completeness', 'ambiguity', 'consistency', 'verifiability', 'boundary-conditions', 'non-functional'
  ]);
  assert.deepEqual([...CHECKLIST_DECISIONS], ['satisfied', 'exception', 'not-applicable']);

  const complete = STARTER_CHECKLIST.articles.map((article) => ({ article: article.id, decision: 'satisfied' }));
  assert.deepEqual(validateChecklistDecisions(complete).errors, []);

  // In enforce mode an absent article fails the approval outright.
  assert.equal(validateChecklistDecisions(complete.slice(0, 5)).errors.length, 1);
  assert.match(validateChecklistDecisions(complete.slice(0, 5)).errors[0], /has no decision/);

  const unreasoned = [...complete.slice(0, 5), { article: 'non-functional', decision: 'exception' }];
  assert.match(validateChecklistDecisions(unreasoned).errors[0], /needs a human-authored reason/);
  const reasoned = [...complete.slice(0, 5), { article: 'non-functional', decision: 'exception', reason: 'Internal tool, no SLA.' }];
  assert.deepEqual(validateChecklistDecisions(reasoned).errors, []);

  // Warn mode reports the same problems without blocking.
  assert.equal(validateChecklistDecisions([], { mode: 'warn' }).errors.length, 0);
  assert.equal(validateChecklistDecisions([], { mode: 'warn' }).warnings.length, 6);
});

test('one requirement written twice is reported, since it will be verified twice', () => {
  // The one clause-level check the kernel extractor does not own: identical normalized bodies under
  // different anchors. Kept because it fires — the checks that did not are gone.
  const doc = [
    '# Specification', '', '## Actors', '', 'x', '', '## User scenarios', '', 'y', '',
    '## Requirements', '',
    '[DEMO:REQ-001] The system records an answer.', '',
    '[DEMO:REQ-002] The system records an answer.'
  ].join('\n');
  const report = analyze(doc);
  assert.equal(report.clauseCount, 2);
  assert.deepEqual(report.findings.map((finding) => finding.kind), ['duplicate-clause-text']);
  assert.match(report.findings[0].message, /state the same requirement/);
});
