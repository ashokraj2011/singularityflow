import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIntentAmendmentDraft, draftSlot, hasDraftSlots } from '../src/intent-amendment-draft.mjs';
import { extractClauses } from '../src/specifications.mjs';

const SPEC = [
  '# QF-9 — Quick fix scope and plan', '', '## Acceptance criteria', '',
  '| Clause | Observable outcome |', '|---|---|',
  '| [QF-9:AC-001] | The greeting says hello. |', '',
  '## Planned implementation evidence', '',
  '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
  '| `QF-9:AC-001` | `greeting.mjs` | `tests/greeting.test.mjs` | modified |', '',
  '## Out of scope', '', 'Nothing else.', ''
].join('\n');

test('a slot is one safe line: no comment end, no table pipe, no newline', () => {
  const slot = draftSlot('a | b --> c\nd');
  assert.equal(slot, '<!-- sflow-draft: a / b - -> c d -->');
  assert.equal(hasDraftSlots(`x ${slot}`), true);
  assert.equal(hasDraftSlots('nothing here'), false);
});

test('a revision marks the clause in its own row and an adoption adds a clause and its plan row', () => {
  const clauses = extractClauses(SPEC, { sourcePath: 'intake.md' });
  const { text, slots } = buildIntentAmendmentDraft({
    text: SPEC, clauses, namespace: 'QF-9', proposeCommand: 'singularity-flow story intent-amendment propose --file draft.md',
    revisions: [{ clauseId: 'QF-9:AC-001', why: ['Convergence CF-1 was dispositioned update-intent: the code is right.'] }],
    additions: [{ fromWorkId: 'OLD-1', fromClauseId: 'OLD-1:AC-003', type: 'AC', statement: 'Greetings are formal.',
      evidence: ['Lines 1-2 of greeting.mjs that delivered OLD-1:AC-003 changed.'], productPaths: ['greeting.mjs'], testPaths: ['tests/greeting.test.mjs'] }]
  });
  const lines = text.split('\n');
  assert.deepEqual(slots, [{ kind: 'revise', clauseId: 'QF-9:AC-001', line: 7 }, { kind: 'add', clauseId: 'QF-9:AC-002', from: 'OLD-1:AC-003' }]);
  assert.match(lines[6], /^\| \[QF-9:AC-001\] \| The greeting says hello\. <!-- sflow-draft: revise QF-9:AC-001 so it says what the code does\. Convergence CF-1 .* --> \|$/u);
  assert.match(lines[7], /^\| \[QF-9:AC-002\] \| <!-- sflow-draft: state the behaviour that replaces OLD-1:AC-003 of closed Story OLD-1 \("Greetings are formal\."\) as the code now has it\. Lines 1-2 .* --> \|$/u,
    'the new clause joins the table that holds this kind of clause');
  assert.equal(lines[14], '| `QF-9:AC-002` | `greeting.mjs` | `tests/greeting.test.mjs` | existing |', 'the adopted code is planned as existing');
  assert.match(lines.at(-2), /^<!-- sflow-draft: drafted from the approved specification\. .* singularity-flow story intent-amendment propose --file draft\.md -->$/u);
  // The table structure survives: the extractor reads both clauses where they belong.
  assert.deepEqual(extractClauses(text, { sourcePath: 'intake.md' }).map((clause) => clause.id), ['QF-9:AC-001', 'QF-9:AC-002']);
});

test('without a table of that kind the adopted clause gets a section of its own', () => {
  const plain = '# QF-9\n\nThe greeting says hello [QF-9:REQ-001].\n';
  const { text } = buildIntentAmendmentDraft({ text: plain, clauses: extractClauses(plain, { sourcePath: 'spec.md' }), namespace: 'QF-9',
    proposeCommand: 'propose', additions: [{ fromWorkId: 'OLD-1', fromClauseId: 'OLD-1:AC-003', type: 'AC', statement: null, evidence: [], productPaths: [], testPaths: [] }] });
  assert.match(text, /\n## Adopted behaviour\n\n- \[QF-9:AC-001\] <!-- sflow-draft: state the behaviour that replaces OLD-1:AC-003 of closed Story OLD-1 as the code now has it\. -->\n/u);
});
