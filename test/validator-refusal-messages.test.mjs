import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectSpecificationScenarios } from '../src/specification-scenarios.mjs';
import { artifactPlaceholderFindings, artifactFindingMessage, inspectArtifactContent } from '../src/publication-preflight.mjs';
import { inspectPlannedClaimMap } from '../src/specifications.mjs';
import { parseVerificationIntent, validatePlannedVerification } from '../src/verification/intent.mjs';
import { parseVerificationContracts } from '../src/verification/contracts.mjs';
import { inspectQualifiedConformanceReport } from '../src/conformance-readiness.mjs';
import { analyzeSpecification } from '../src/specification-quality.mjs';
import { validateCitations } from '../src/constitution.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { pathDefect, shown } from '../src/draft-diagnostics.mjs';

// Agents looped for many rounds on refusals that named a rule but not the cell that broke it, or that
// skipped a near miss in silence and then called the content missing (office, 2026-10-29). Each
// refusal here must quote what the author wrote and say what belongs there.
const W = 'W-1';
const REQ = `${W}:REQ-001`;
const AC = `${W}:AC-001`;
const table = (header, ...rows) => [header, header.replace(/[^|]+/gu, '---'), ...rows].join('\n');

test('scenario refusals name the near miss, the keywords found and the cell, never a contradictory follow-on', () => {
  const clauses = [{ id: REQ, type: 'REQ', body: 'Adds an item.' }];
  const coverage = (scenario = 'S1') => ['## Scenario coverage', '', table('| Clause | Scenario | Outcome |', `| ${REQ} | ${scenario} | success |`), ''];
  const bold = inspectSpecificationScenarios([...coverage(), '**S1 — add item**', 'Given a cart When I add Then it shows'].join('\n'), clauses, { required: true });
  assert.match(bold.findings[0].message, /no heading starts with S1 \(line 7 holds '\*\*S1 — add item\*\*', which is not a heading\)\. A scenario is a heading such as `### S1 — <situation>`/u);

  const split = inspectSpecificationScenarios([...coverage(), '### S1 — add item', 'Given a user signed in when the page loads', 'When they add an item', 'Then it shows'].join('\n'), clauses, { required: true });
  assert.match(split.findings[0].message, /Case 1 reads Given, When, When, Then: every "given", "when" and "then", in any case and mid-sentence, starts a new field/u);

  const cell = inspectSpecificationScenarios([...coverage('S1 — add item'), '### S1 — add', 'Given a When b Then c'].join('\n'), clauses, { required: true });
  assert.deepEqual(cell.findings.map((entry) => entry.message),
    ["Scenario coverage row at line 5: its Scenario holds 'S1 — add item'; write only the scenario's number, such as `S1`."],
    'no "has no scenario coverage row" for the row it just refused');

  const notes = inspectSpecificationScenarios(['## Scenario coverage', '', table('| Clause | Scenario | Outcome | Notes |', `| ${REQ} | S1 | success | x |`)].join('\n'), clauses, { required: true });
  assert.deepEqual(notes.findings.map((entry) => entry.kind), ['scenario-coverage-format']);
  assert.match(notes.findings[0].message, /its first table row holds '\| Clause \| Scenario \| Outcome \| Notes \|'\. Keep notes outside the table\./u);
});

test('a to-do list Story can publish: TODO counts only in capitals, and the refusal lists what reads as unfinished', () => {
  // Code spans still count (an inline TODO stays executable documentation, publication-preflight test).
  const found = artifactPlaceholderFindings(['# Todo app', '', 'The user adds a todo item.', 'Use `tbd` in a code span.', 'TODO: write this'].join('\n'));
  assert.deepEqual(found, [{ value: 'tbd', line: 4 }, { value: 'TODO', line: 5 }]);
  assert.match(artifactFindingMessage({ code: 'artifact.placeholder.unresolved', path: 'a.md', value: 'TODO', line: 5 }),
    /TODO \(in capitals\), TBD, TBC, FIXME, \{\{\.\.\.\}\} and \[describe \.\.\.\] read as unfinished work, even inside code spans/u);
});

test('a required heading written with numbering or bold is named, not called missing', () => {
  const { findings } = inspectArtifactContent(['# Spec', '', '## 2. Requirements', '', 'Content.', ''].join('\n'),
    { path: 'spec.md', contract: { validation: { requiredHeadings: ['Requirements'] } } });
  assert.match(artifactFindingMessage(findings.find((entry) => entry.code === 'artifact.heading.missing')),
    /Line 3 has '2\. Requirements': write it as a heading with exactly that text, without numbering, bold or a colon\./u);
  const quality = analyzeSpecification(['# Spec', '', '## 2. Requirements', '', 'Content.', '', '**Actors:**', ''].join('\n'));
  const section = (name) => quality.findings.find((entry) => entry.kind === 'missing-required-section' && entry.section === name).message;
  assert.match(section('Requirements'), /'## 2\. Requirements' is not that heading: write it as a heading with exactly 'Requirements'/u);
  assert.match(section('Actors'), /'\*\*Actors:\*\*' is not that heading/u);
  assert.equal(section('User scenarios'), "the specification has no 'User scenarios' section");
});

test('planned-table refusals quote the cell, name the path defect, and catch a reordered header without a cascade', () => {
  const options = { clauseIds: [REQ], requireComplete: true };
  const reordered = inspectPlannedClaimMap(table('| Clause | Planned tests | Expected paths |', `| ${REQ} | \`test/a.test.js\` | \`src/a.js\` |`), options);
  assert.deepEqual(reordered.diagnostics.map((entry) => entry.code), ['SPEC_PLANNED_TABLE_INVALID'], 'one finding, not "complete its row"');
  assert.match(reordered.diagnostics[0].message, /has its columns as 'Clause \| Planned tests \| Expected paths'; the first three must be Clause \| Expected paths \| Planned tests, in this order/u);

  const header = '| Clause | Expected paths | Planned tests |';
  const extra = inspectPlannedClaimMap(table(header, `| ${REQ} | \`src/a.js\` (adds item) | \`test/a.test.js\` |`), options);
  assert.match(extra.diagnostics[0].message, /'\(adds item\)' is outside the backticks/u);
  const folder = inspectPlannedClaimMap(table(header, `| ${REQ} | \`src/\` | \`test/a.test.js\` |`), options);
  assert.match(folder.diagnostics[0].message, /'src\/' is not: it names a folder \(ends with \/\); name a file\./u);
  const id = inspectPlannedClaimMap(table(header, `| REQ-001 | \`src/a.js\` | \`test/a.test.js\` |`), options);
  assert.match(id.diagnostics[0].message, /such as `ORDER:REQ-001`: the Story's namespace, a colon, REQ, BEH, IFC, AC or CON, and three digits\. It holds 'REQ-001'\./u);
  assert.equal(shown(''), 'nothing');
  assert.equal(pathDefect('../x.js'), 'it climbs out with ..; write the path from the repository root');
});

test('verification intent splits its causes and quotes the cells', () => {
  const clauses = [{ id: REQ, type: 'REQ' }, { id: AC, type: 'AC' }];
  const intent = (...rows) => ['## Verification intent', '', table('| Clause | Methods | Criterion |', ...rows)].join('\n');
  assert.throws(() => parseVerificationIntent(intent('| REQ-001 | test | - |'), clauses), /names 'REQ-001', which is not a clause this draft declares; write it in full, as `W-1:REQ-001`\./u);
  assert.throws(() => parseVerificationIntent(intent(`| ${REQ} | test | - |`, `| ${REQ} | test | - |`), clauses), /lists W-1:REQ-001 twice/u);
  assert.throws(() => parseVerificationIntent(intent(`| ${REQ} | test and visual | ${AC} |`), clauses), /it holds 'test and visual'/u);
  assert.throws(() => parseVerificationIntent(intent(`| ${REQ} | test | The list shows |`), clauses), /it holds 'The list shows'/u);
  assert.throws(() => parseVerificationIntent(['## Verification intent', '', table('| Clause | Methods | Criterion | Notes |', `| ${REQ} | test | - | x |`)].join('\n'), clauses),
    /the table at line 3 has 'Clause \| Methods \| Criterion \| Notes'/u);
  assert.throws(() => validatePlannedVerification({ [AC]: { tests: [], testDisposition: 'non-test', verificationCriterion: AC } }, [], clauses),
    /Missing: the Verification contracts table has no row with Criterion `W-1:AC-001`\./u);
});

test('contract and conformance refusals list the allowed words and quote the cell', () => {
  const contracts = ['## Verification contracts', '', table('| Criterion | Slot | Method | Witness | Role | Required assurance |',
    `| \`${AC}\` | unit | test | \`test/a.test.js\` | primary | high |`)].join('\n');
  assert.throws(() => parseVerificationContracts(contracts, { clauseIds: [AC] }),
    /write module-observed or exact-local-observed alone, or leave the column empty\. It holds 'high'\./u);

  const status = table('| Clause ID | Status |', `| ${REQ} | matched |`);
  assert.deepEqual(inspectQualifiedConformanceReport(status, [REQ]).map((entry) => entry.code), ['conformance.table-unrecognized']);
  const verdict = inspectQualifiedConformanceReport(table('| Clause ID | Verdict |', `| ${REQ} | ✅ matched |`), [REQ]);
  assert.match(verdict[0].message, /its Verdict holds '✅ matched'; start it with one word of matched, partial, missing, deviated or unplanned/u);
});

test('supporting files, constitution citations and swallowed errors say what they found', async () => {
  assert.match(inspectPlannedClaimMap(['## Supporting files', '', '- None.', ''].join('\n'), { clauseIds: [] }).diagnostics[0].message,
    /holds 'None\.': when the plan has no supporting files, remove the whole ## Supporting files section\./u);
  assert.match(validateCitations(null, ['ISO-8601']).errors[0], /Every ID-shaped token .* counts as a citation: write 'None' there with no IDs\./u);
  const { readStorySeed } = await import('../src/story-base-lineage.mjs');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seed-yaml-'));
  try {
    await mkdir(path.join(root, 'singularity/seeds'), { recursive: true });
    await writeFile(path.join(root, 'singularity/seeds/W-1.yml'), 'title: [unclosed\n');
    await assert.rejects(readStorySeed(root, { workItem: { id: 'W-1' } }), /is not valid YAML: .*line/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a draft table refused at publish routes to the prepublish recheck, not the generic recover plan', () => {
  for (const code of ['SPEC_PLANNED_TABLE_INVALID', 'SPEC_VERIFICATION_CONTRACT_INVALID', 'SPEC_VERIFICATION_INTENT_INVALID',
    'SPEC_SUPPORTING_FILE_INVALID', 'SPEC_PUBLICATION_GATE_REFUSED']) {
    const plan = refusalRemediationPlan({ code, details: {} }, ['phase', 'publish', 'plan']);
    assert.equal(plan.steps[0].command, 'singularity-flow phase prepublish plan --for-agent --json', code);
  }
});
