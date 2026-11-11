import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSourceReviewReport } from '../src/source-review-lifecycle.mjs';
import { sourceReviewBinding } from '../src/source-grounded-review.mjs';
import { sourceReviewCitationGuide } from '../src/source-review-contract.mjs';
import { refusalEnvelope } from '../src/refusal-remediation.mjs';
import { SingularityFlowError } from '../src/util.mjs';

function fixture({ newline = '\n', phase = 'specification' } = {}) {
  const input = { workId: 'CONVERTER', phase, kind: 'specification', generation: 1,
    authorAgentId: 'product-owner', reviewerAgentId: 'source-reviewer',
    sources: [{ id: 'story', path: 'USER-STORY.md',
      text: ['# Converter', 'Add a converter.', '', 'Provide screenshot and testcases.', ''].join(newline) }],
    artifact: { path: 'spec.md', text: `# Specification
### S1 — Convert
- Convert in both directions. (S1) [CONVERTER:REQ-001]
### S2 — Evidence
- Provide a screenshot and automated tests. (S2) [CONVERTER:AC-001]
` },
    clarifications: [{ id: 'clarification:current-phase', phase, generation: 1,
      path: 'clarification.json', sha256: 'a'.repeat(64), responses: [
        { id: 'Q-001', status: 'answered', answer: 'Both directions, screenshots and automated test cases.' }
      ] }] };
  input.binding = sourceReviewBinding(input);
  const report = { schemaVersion: 1, resultType: 'source-grounded-review', kind: input.kind,
    binding: structuredClone(input.binding), reviewer: { agentId: input.reviewerAgentId, readOnly: true },
    sourcesReviewed: ['story'], clarificationsReviewed: ['clarification:current-phase'],
    rows: [{ id: 'conversion', sourceId: 'story', line: 2, quote: 'Add a converter.',
      outcome: 'covered', scenarioId: 'S1', clauseIds: ['CONVERTER:REQ-001'] }], findings: [] };
  return { input, report };
}

test('context identifies every scenario/clause and the exact source citation domain for copied scope phases', () => {
  const { input } = fixture({ phase: 'custom-intake' });
  const guide = sourceReviewCitationGuide(input);
  assert.deepEqual(guide.scenarioIds, ['S1', 'S2']);
  assert.deepEqual(guide.clauseIds, ['CONVERTER:REQ-001', 'CONVERTER:AC-001']);
  assert.match(guide.lineBasis, /not the JSON packet/u);
  assert.match(guide.quoteRule, /Do not paraphrase/u);
  assert.match(guide.mappingRule, /retain a blocking finding instead of inventing coverage/u);
  assert.equal(Object.hasOwn(sourceReviewCitationGuide({ ...input, kind: 'planning' }), 'scenarioIds'), false);
  input.artifact.text += '- Duplicate. [CONVERTER:REQ-001]\n';
  assert.match(sourceReviewCitationGuide(input).clauseInventoryError, /duplicated/u,
    'a malformed historical artifact must not turn advisory guidance into another context refusal');
});

for (const newline of ['\n', '\r\n']) test(`exact quote relocation is a proposal only (${JSON.stringify(newline)})`, () => {
  const { input, report } = fixture({ newline });
  report.rows[0].line = 99;
  const before = JSON.stringify({ input, report });
  const checked = checkSourceReviewReport(report, input);
  assert.equal(checked.retentionReady, false);
  assert.equal(checked.repair.status, 'repair-packet');
  assert.deepEqual(checked.repair.citations[0].proposedEdit, { field: 'rows[0].line', value: 2 });
  assert.equal(checked.repair.citations[0].textSha256, input.binding.sources[0].textSha256);
  assert.equal(JSON.stringify({ input, report }), before, 'check cannot silently fix/re-hash or mutate anything');
  assert.ok(checked.repair.mappingTasks.some(entry => entry.scenarioId === 'S2'));
  report.rows[0].line = checked.repair.citations[0].proposedEdit.value;
  const fixed = checkSourceReviewReport(report, input);
  assert.equal(fixed.retentionReady, true, 'missing mapping remains an honest retainable gap');
  assert.equal(fixed.evaluation.status, 'correction-required');
});

test('unmatched paraphrases and multiline quotes never receive replacement text or a guessed line', () => {
  for (const quote of ['Add a hexadecimal converter.', 'Add a converter.\n', 'Provide screenshot and  testcases.', '']) {
    const { input, report } = fixture();
    report.rows[0].quote = quote;
    const checked = checkSourceReviewReport(report, input);
    assert.equal(checked.retentionReady, false);
    for (const citation of checked.repair.citations) {
      assert.equal(citation.matchCount, 0);
      assert.equal(Object.hasOwn(citation, 'proposedEdit'), false);
      assert.equal(Object.hasOwn(citation, 'replacementQuote'), false);
    }
  }
});

test('duplicate quote matches require independent selection, never a first-match repair', () => {
  const { input, report } = fixture();
  input.sources[0].text += 'Add a converter.\n';
  input.binding = report.binding = sourceReviewBinding(input);
  report.rows[0].line = 1;
  const checked = checkSourceReviewReport(report, input);
  const hint = checked.repair.citations[0];
  assert.equal(hint.matchCount, 2);
  assert.deepEqual(hint.matchingLines, [2, 5]);
  assert.equal(Object.hasOwn(hint, 'proposedEdit'), false);
  assert.equal(hint.suppliedLineText, '# Converter');
});

test('reviewer finding citations get exact field paths too; findings do not bypass citation checks', () => {
  const { input, report } = fixture();
  report.findings.push({ id: 'evidence-gap', severity: 'blocking', message: 'Evidence is missing.',
    sourceId: 'story', line: 3, quote: 'Provide screenshot and testcases.' });
  const checked = checkSourceReviewReport(report, input);
  assert.equal(checked.retentionReady, false);
  assert.deepEqual(checked.repair.citations[0].proposedEdit, { field: 'findings[0].line', value: 4 });
});

test('S2 can be repaired with a genuinely supporting pinned source row and clarification acknowledgement', () => {
  const { input, report } = fixture();
  report.rows.push({ id: 'evidence', sourceId: 'story', line: 4, quote: 'screenshot and testcases',
    outcome: 'covered', scenarioId: 'S2', clauseIds: ['CONVERTER:AC-001'] });
  const checked = checkSourceReviewReport(report, input);
  assert.equal(checked.retentionReady, true);
  assert.equal(checked.evaluation.status, 'ready');
  assert.deepEqual(checked.repair.mappingTasks, []);
  report.clarificationsReviewed = [];
  assert.equal(checkSourceReviewReport(report, input).retentionReady, false, 'source mapping cannot waive reading answers');
});

test('a real unsupported scenario is retainable as correction-required, never silently covered', () => {
  const { input, report } = fixture();
  report.findings.push({ id: 'unsupported-evidence', severity: 'blocking', message: 'No reviewed mapping supports S2.' });
  const checked = checkSourceReviewReport(report, input);
  assert.equal(checked.retentionReady, true);
  assert.equal(checked.evaluation.status, 'correction-required');
  assert.ok(checked.evaluation.findings.some(entry => entry.code === 'reviewer-blocker'));
  assert.match(checked.repair.instruction, /retain already-reviewed genuine gaps/u);
  assert.equal(report.rows.length, 1);
});

test('stale bindings and invalid packet structure never receive usable mechanical citation repairs', () => {
  const { input, report } = fixture();
  report.rows[0].line = 99;
  report.binding.generation = 2;
  const stale = checkSourceReviewReport(report, input);
  assert.equal(stale.retentionReady, false);
  assert.equal(stale.repair.status, 'reload-context');
  assert.deepEqual(stale.repair.citations, []);
  report.rows = 'invalid';
  const invalid = checkSourceReviewReport(report, input);
  assert.equal(invalid.retentionReady, false);
  assert.deepEqual(invalid.repair.citations, []);
});

test('a hash mistyped when copying the binding is repaired in the same turn, never sent back to reload (Story anu-bin, 2026-11-11)', () => {
  const { input, report } = fixture();
  const path = (binding) => binding.sources[0].textSha256;
  // The live slip: two characters typed into a 64-character hash while retyping the whole report.
  const real = path(input.binding);
  report.binding.sources[0].textSha256 = `${real.slice(0, 8)}34${real.slice(8)}`;
  const slipped = checkSourceReviewReport(report, input);
  assert.equal(slipped.retentionReady, false, 'a mistyped binding is never retained');
  assert.equal(slipped.repair.status, 'repair-packet');
  assert.ok(slipped.findings.some((entry) => entry.code === 'review-binding-mistyped'));
  assert.deepEqual(slipped.repair.binding, [{ field: 'binding.sources[0].textSha256', proposedEdit: { field: 'binding.sources[0].textSha256', value: real } }]);
  assert.match(slipped.repair.instruction, /Copy each binding proposedEdit value exactly; the inputs did not change/u);
  // The refusal at stage carries the same exact values.
  const refusal = refusalEnvelope(new SingularityFlowError('Repair report format, citations or exact binding; no staging bytes changed.', {
    code: 'SOURCE_REVIEW_REPORT_INVALID', details: { findings: slipped.findings, repair: slipped.repair } }), ['review-source', 'stage', 'specification']);
  assert.deepEqual(refusal.error.details.repair.binding, slipped.repair.binding);
  // Copied back exactly, it is retainable.
  report.binding.sources[0].textSha256 = real;
  assert.equal(checkSourceReviewReport(report, input).retentionReady, true);
  // A really changed input changes nearly the whole hash: still stale, still a reload.
  report.binding.sources[0].textSha256 = 'f'.repeat(64);
  assert.equal(checkSourceReviewReport(report, input).repair.status, 'reload-context');
  // So does a slip beside any other difference.
  report.binding.sources[0].textSha256 = `${real.slice(0, 8)}34${real.slice(8)}`;
  report.binding.generation = 2;
  assert.equal(checkSourceReviewReport(report, input).repair.status, 'reload-context');
});

test('a source written as its path gets its exact source ID, not "Invalid input" (Story anu-bin, 2026-11-11)', () => {
  const { input, report } = fixture();
  // A code source's ID is code: and its path with each / as :; the reviewer wrote the path, as the old wording said.
  input.sources[0].id = 'code:src:App.test.jsx';
  input.binding = report.binding = sourceReviewBinding(input);
  report.sourcesReviewed = ['code:src/App.test.jsx'];
  report.rows[0].sourceId = 'code:src/App.test.jsx';
  const checked = checkSourceReviewReport(report, input);
  assert.equal(checked.retentionReady, false);
  assert.deepEqual(checked.findings.map((entry) => [entry.field, entry.proposedEdit?.value]),
    [['sourcesReviewed[0]', 'code:src:App.test.jsx'], ['rows[0].sourceId', 'code:src:App.test.jsx']]);
  assert.match(checked.findings[0].message, /code:src\/App\.test\.jsx is not a source ID; copy code:src:App\.test\.jsx exactly from sources\[\]\.id/u);
  assert.deepEqual(checked.repair.sourceIds.map((entry) => entry.proposedEdit.value), ['code:src:App.test.jsx', 'code:src:App.test.jsx']);
  assert.match(checked.repair.instruction, /Replace each sourceIds field with its proposedEdit value/u);
  const refusal = refusalEnvelope(new SingularityFlowError('Repair report format, citations or exact binding; no staging bytes changed.', {
    code: 'SOURCE_REVIEW_REPORT_INVALID', details: { findings: checked.findings, repair: checked.repair } }), ['review-source', 'stage', 'specification']);
  assert.deepEqual(refusal.error.details.repair.sourceIds, checked.repair.sourceIds, 'the stage refusal carries the same IDs');
  // A path that is no source here lists the real IDs instead.
  report.sourcesReviewed = ['code:other/file.js'];
  report.rows[0].sourceId = 'code:src:App.test.jsx';
  assert.match(checkSourceReviewReport(report, input).findings[0].message, /copy one from sources\[\]\.id: code:src:App\.test\.jsx/u);
});

test('repair hints and matching-line lists are bounded without losing the true match count', () => {
  const { input, report } = fixture();
  input.sources[0].text = '# Converter\n' + 'Add a converter.\n'.repeat(40);
  input.binding = report.binding = sourceReviewBinding(input);
  report.rows = Array.from({ length: 30 }, (_, index) => ({ ...report.rows[0], id: `conversion-${index}`, line: 1 }));
  const checked = checkSourceReviewReport(report, input);
  assert.equal(checked.repair.citations.length, 25);
  assert.equal(checked.repair.omittedCitations, 5);
  assert.equal(checked.repair.citations[0].matchCount, 40);
  assert.equal(checked.repair.citations[0].matchingLines.length, 10);
});

test('stage/retain refusals preserve bounded exact repair fields through the CLI error boundary', () => {
  const { input, report } = fixture();
  report.rows[0].line = 99;
  const checked = checkSourceReviewReport(report, input);
  const envelope = refusalEnvelope(new SingularityFlowError('Repair citations; no bytes changed.', {
    code: 'SOURCE_REVIEW_REPORT_INVALID', details: checked
  }), ['review-source', 'stage', input.phase, '--json']);
  assert.equal(envelope.error.details.repair.status, 'repair-packet');
  assert.deepEqual(envelope.error.details.repair.citations[0].proposedEdit, { field: 'rows[0].line', value: 2 });
  assert.equal(envelope.error.details.repair.reportSha256, checked.evaluation.reportSha256);
  assert.ok(envelope.error.details.repair.mappingTasks.some(entry => entry.scenarioId === 'S2'));
});
