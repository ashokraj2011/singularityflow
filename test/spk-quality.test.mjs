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
import { readFile, readdir } from 'node:fs/promises';

import { extractClauses } from '../src/specifications.mjs';

import {
  MARKER_MODES, evaluateMarkerPolicy, extractMarkers, markerPolicy, reconcileMarkers
} from '../src/clarification-markers.mjs';
import {
  CHECKLIST_DECISIONS, STARTER_CHECKLIST, analyzeSpecification, evaluateSpecificationQuality,
  policyHash, specificationQualityPolicy, validateChecklistDecisions, WITNESSED_CLAUSE_PROFILE,
  WITNESS_TYPES
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

const WITNESSED_POLICY = Object.freeze({
  mode: 'enforce',
  witnessedClauses: { profile: 'witnessed-v1' }
});

const WITNESSED_SPEC = [
  '# Specification', '', '## Actors', '', 'An authenticated account holder.', '',
  '## User scenarios', '', 'Given an account, when its balance is requested, then its persisted balance is returned.', '',
  '## Requirements', '',
  '### [DEMO:AC-001]', '',
  '- bEhAvIoR: When an authenticated user requests the balance, the service returns that user\'s balance.',
  '- OBSERVABLE: The response is HTTP 200 and the amount and currency equal the persisted values.',
  '- Witness: test', '',
  '```markdown', '- Behavior: this example is not a governed field', '```'
].join('\n');

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
  assert.equal(answered.resolved.length, 1);

  /**
   * The other half of `[SPK:REQ-067]`, and the half I got wrong first: filing the answer while
   * leaving the marker in the text is **not** resolution either. Under `block` that mistake let a
   * specification publish while still literally asking the question, which is the one outcome the
   * gate exists to prevent — the artifact is the thing people read. Found by driving a real Story,
   * not by this file, which is why the assertion is here now.
   */
  const stillPresent = reconcileMarkers({
    current: previous, previous, answers: [{ questionHash: 'who may retry?' }]
  });
  assert.equal(stillPresent.open.length, 1, 'an answered marker still in the text was treated as resolved');
  assert.deepEqual(stillPresent.resolved, []);
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

test('witnessed-clause policy is strict, normalized, and absent unless explicitly enrolled', () => {
  const legacy = specificationQualityPolicy({ mode: 'warn' });
  assert.equal('witnessedClauses' in legacy, false, 'an absent profile changed the legacy policy projection');

  const policy = specificationQualityPolicy(WITNESSED_POLICY);
  assert.deepEqual(policy.witnessedClauses, {
    profile: WITNESSED_CLAUSE_PROFILE,
    clauseTypes: ['acceptance'],
    enforceableWitnessTypes: ['test'],
    lexicalHints: 'off',
    limits: { maxClauses: 500, maxFieldBytes: 4096, maxReportBytes: 262144 }
  });
  assert.deepEqual([...WITNESS_TYPES], ['test', 'inspection', 'metric', 'runtime', 'manual']);
  assert.throws(
    () => specificationQualityPolicy({ witnessedClauses: { profile: 'witnessed-v1', surprise: true } }),
    /unknown field 'surprise'/
  );
  assert.throws(
    () => specificationQualityPolicy({ witnessedClauses: { profile: 'witnessed-v1', limits: { maxFields: 3 } } }),
    /unknown field 'maxFields'/
  );
  assert.throws(
    () => specificationQualityPolicy({ witnessedClauses: { profile: 'witnessed-v1', enforceableWitnessTypes: ['inspection'] } }),
    /unsupported value 'inspection'/
  );
  assert.throws(
    () => specificationQualityPolicy({ witnessedClauses: { profile: 'witnessed-v2' } }),
    /must be 'witnessed-v1'/
  );
});

test('witnessed acceptance fields are parsed from the existing clause index without semantic overclaim', () => {
  const report = analyze(WITNESSED_SPEC, { policy: WITNESSED_POLICY });
  assert.deepEqual(report.findings, []);
  assert.equal(report.clauseCount, 1);
  assert.equal(report.witnessedClauses.profile, 'witnessed-v1');
  assert.equal(report.witnessedClauses.enrolledClauseCount, 1);
  assert.deepEqual(report.witnessedClauses.clauses.map((clause) => clause.clauseId), ['DEMO:AC-001']);
  assert.deepEqual(report.witnessedClauses.clauses[0].fields, {
    behavior: { status: 'present', occurrences: 1, bytes: 89 },
    observable: { status: 'present', occurrences: 1, bytes: 80 },
    witness: { status: 'present', occurrences: 1, bytes: 4 }
  });
  assert.equal(report.witnessedClauses.clauses[0].witnessType, 'test');
  assert.equal(report.witnessedClauses.clauses[0].enforceable, true);
  assert.deepEqual(report.witnessedClauses.lexicalHints, []);
  assert.match(report.disclaimer, /makes no claim that the specification is complete, clear, consistent, or correct/);

  // A non-acceptance anchor remains under the existing analyzer and is not silently enrolled.
  const legacyClauses = analyze(SPEC, { policy: WITNESSED_POLICY });
  assert.equal(legacyClauses.witnessedClauses.enrolledClauseCount, 0);
  assert.deepEqual(legacyClauses.findings, []);
});

test('witnessed structural defects are deterministic gate findings, not prose judgements', () => {
  const malformed = [
    '# Specification', '', '## Actors', '', 'A user.', '', '## User scenarios', '', 'A scenario.', '',
    '## Requirements', '',
    '- [DEMO:AC-001]',
    '- Behavior: first behavior',
    '- behavior: second behavior',
    '- Observable:',
    '- Witness: oracle', '',
    '### [DEMO:AC-002]',
    '- Behavior returns the result',
    '- Observable: The result is visible.',
    '- Witness: manual'
  ].join('\n');
  const report = analyze(malformed, { policy: WITNESSED_POLICY });
  const kinds = report.findings.map((finding) => finding.kind);
  assert.ok(kinds.includes('witnessed-clause-heading-malformed'));
  assert.ok(kinds.includes('witnessed-field-duplicate'));
  assert.ok(kinds.includes('witnessed-field-empty'));
  assert.ok(kinds.includes('witnessed-field-malformed'));
  assert.ok(kinds.includes('witnessed-field-missing'));
  assert.ok(kinds.includes('witnessed-witness-unknown'));
  assert.equal(report.witnessedClauses.clauses[1].witnessType, 'manual');
  assert.equal(report.witnessedClauses.clauses[1].enforceable, false);
  assert.ok(evaluateSpecificationQuality(report).errors.length >= 6);
  assert.equal(evaluateSpecificationQuality({ ...report, mode: 'warn' }).errors.length, 0);
});

test('witnessed clause, field, and report bounds disclose every truncation', () => {
  const clauses = Array.from({ length: 10 }, (_, index) => [
    `### [DEMO:AC-${String(index + 1).padStart(3, '0')}]`,
    `- Behavior: behavior number ${index + 1}`,
    `- Observable: observable number ${index + 1}`,
    '- Witness: test', ''
  ].join('\n'));
  const document = [
    '# Specification', '', '## Actors', '', 'A user.', '', '## User scenarios', '', 'A scenario.', '',
    '## Requirements', '', ...clauses
  ].join('\n');

  const clauseBound = analyze(document, { policy: {
    mode: 'warn',
    witnessedClauses: {
      profile: 'witnessed-v1',
      limits: { maxClauses: 1, maxFieldBytes: 5, maxReportBytes: 262144 }
    }
  } });
  assert.ok(clauseBound.findings.some((finding) => finding.kind === 'witnessed-clause-limit-exceeded'));
  assert.ok(clauseBound.findings.some((finding) => finding.kind === 'witnessed-field-limit-exceeded'));
  assert.equal(clauseBound.witnessedClauses.analyzedClauseCount, 1);
  assert.equal(clauseBound.witnessedClauses.truncated.disclosures[0].limit, 'maxClauses');

  const reportBound = analyze(document, { policy: {
    mode: 'warn',
    witnessedClauses: {
      profile: 'witnessed-v1',
      limits: { maxClauses: 10, maxFieldBytes: 4096, maxReportBytes: 2048 }
    }
  } });
  assert.ok(reportBound.findings.some((finding) => finding.kind === 'witnessed-report-limit-exceeded'));
  assert.ok(reportBound.witnessedClauses.reportedClauseCount < reportBound.witnessedClauses.analyzedClauseCount);
  assert.ok(reportBound.witnessedClauses.truncated.disclosures.some((entry) => entry.limit === 'maxReportBytes'));
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

test('the starter template leads with scenarios and asks for what is usually left out', async () => {
  /**
   * `[SPK:REQ-068]` `[SPK:REQ-069]`. The ordering is the substance of the clause, not decoration: a
   * requirement written before anyone described the situation it serves tends to describe the
   * system instead of the need, and nobody notices until verification. A well-meant reorganisation
   * of this template would undo that silently, so the order is asserted rather than trusted.
   */
  const template = await readFile(new URL('../templates/artifacts/spec-driven/spec.md', import.meta.url), 'utf8');
  const at = (heading) => template.indexOf(`\n## ${heading}`);
  for (const heading of [
    'Actors', 'User scenarios', 'Failure and empty states', 'Permissions', 'Boundary conditions',
    'Requirements', 'Non-functional requirements', 'Assumptions'
  ]) assert.ok(at(heading) > -1, `the starter template has no '${heading}' section`);

  assert.ok(at('User scenarios') < at('Requirements'), 'general requirements come before the scenarios they serve');
  assert.ok(at('Actors') < at('User scenarios'), 'scenarios are described before their actors');
  assert.match(template, /\*\*Given\*\*[\s\S]*\*\*When\*\*[\s\S]*\*\*Then\*\*/, 'no Given/When/Then acceptance case');
  assert.match(template, /\*\*Priority:\*\*/, 'scenarios are not prioritized');

  // The marker grammar is shown only with a neutral placeholder. A concrete example is still part
  // of the composed model prompt even when the kernel ignores its HTML comment, so the model can
  // otherwise mistake an example domain question for the current Story's real ambiguity.
  assert.match(template, /\[NEEDS CLARIFICATION: <one question grounded in the current Story evidence>\]/);
  assert.doesNotMatch(template, /failed payment|retry a payment/i);
  assert.deepEqual(extractMarkers(template).markers, [], 'the template ships an unresolved marker');
});

test('shipped artifact templates contain no live or concrete clarification questions', async () => {
  const directory = new URL('../templates/artifacts/', import.meta.url);
  const names = (await readdir(directory, { recursive: true }))
    .filter((name) => name.endsWith('.md'))
    .sort();
  assert.ok(names.length > 0, 'no shipped artifact templates were audited');

  for (const name of names) {
    const template = await readFile(new URL(name, directory), 'utf8');
    const extracted = extractMarkers(template);
    assert.deepEqual(extracted.markers, [], `${name} ships a live clarification marker`);
    assert.deepEqual(extracted.malformed, [], `${name} ships a malformed clarification marker`);

    for (const match of template.matchAll(/\[NEEDS CLARIFICATION:([^\]\n]*)\]/g)) {
      assert.match(
        match[1].trim(),
        /^<[^>]+>$/,
        `${name} contains a concrete clarification example that a model could reuse`
      );
    }
  }
});

test('a starter template contributes no clauses of its own', async () => {
  /**
   * The templates explain themselves by citing the clause that motivates each section. Written as
   * bare `[SPK:REQ-071]`, those citations are **anchors**, so every Story started from a template
   * inherited them as clauses of its own specification — `spec index` counted boilerplate as
   * requirements, and a phase could satisfy "has stable clause anchors" without the author writing
   * one. They are wrapped in inline code now, which extraction already ignores.
   */
  const directory = new URL('../templates/artifacts/spec-driven/', import.meta.url);
  for (const name of ['spec.md', 'plan.md', 'convergence.md', 'release.md']) {
    const template = await readFile(new URL(name, directory), 'utf8');
    assert.deepEqual(
      extractClauses(template).map((clause) => clause.id), [],
      `${name} contributes clauses to every Story that starts from it`
    );
    // The citations must still be readable — the point was never to delete them.
    assert.match(template, /`\[SPK:(?:REQ|CON)-\d{3}\]`/, `${name} lost its clause citations`);
  }
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
