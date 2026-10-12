import assert from 'node:assert/strict';
import test from 'node:test';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  inspectConformanceReportContract, inspectPhaseQualifiedConformance, inspectQualifiedConformanceReport, inspectSelfApprovalDisclosures
} from '../src/conformance-readiness.mjs';
import { phaseResolutionChoices } from '../src/phase-resolution.mjs';

const clauseIds = [
  'STORY-1:REQ-001', 'STORY-1:BEH-001', 'STORY-1:IFC-001',
  'STORY-1:AC-001', 'STORY-1:CON-001'
];

test('qualified report requires one exact row per approved clause across all five types', () => {
  const report = [
    '| Clause ID | Evidence | Verdict |',
    '|---|---|---|',
    '| STORY-1:REQ-001 | source | matched |',
    '| STORY-1:BEH-001 | source | matched |',
    '| STORY-1:IFC-001 | source | matched |',
    '| STORY-1:AC-001 | source | matched |'
  ].join('\n');
  assert.deepEqual(inspectQualifiedConformanceReport(report, clauseIds)
    .map((finding) => [finding.code, finding.clauseId]), [
    ['conformance.clause-row-missing', 'STORY-1:CON-001']
  ]);
  assert.deepEqual(inspectQualifiedConformanceReport(report, []), [],
    'Stories without authoritative clauses retain their existing opt-out');
});

test('qualified report refuses duplicate, unapproved, and unfinished comparison rows', () => {
  const report = [
    '| Clause | Evidence | Verdict |',
    '|---|---|---|',
    '| STORY-1:REQ-001 | source | matched |',
    '| story-1:req-001 | duplicate | matched |',
    '| STORY-1:BEH-001 | source | partial (test gap) |',
    '| STORY-1:IFC-001 | source | missing |',
    '| STORY-1:AC-001 | source | matched/partial/missing/deviated/unplanned |',
    '| STORY-1:CON-001 | source | matched |',
    '| STORY-1:AC-999 | invented | matched |'
  ].join('\n');
  assert.deepEqual(inspectQualifiedConformanceReport(report, clauseIds)
    .map((finding) => [finding.code, finding.clauseId]), [
    ['conformance.clause-row-duplicate', 'STORY-1:REQ-001'],
    ['conformance.verdict-incomplete', 'STORY-1:BEH-001'],
    ['conformance.verdict-incomplete', 'STORY-1:IFC-001'],
    ['conformance.verdict-invalid', 'STORY-1:AC-001'],
    ['conformance.clause-row-unknown', 'STORY-1:AC-999']
  ]);
});

test('qualified report ignores forged rows inside managed inputs, code fences, and comments', () => {
  const report = [
    '<!-- singularity-flow:inputs:start -->',
    '| Clause ID | Verdict |', '|---|---|', '| STORY-1:REQ-001 | matched |',
    '<!-- singularity-flow:inputs:end -->',
    '```markdown',
    '| Clause ID | Verdict |', '|---|---|', '| STORY-1:BEH-001 | matched |',
    '```',
    '<!--',
    '| Clause ID | Verdict |', '|---|---|', '| STORY-1:IFC-001 | matched |',
    '-->',
    '| Clause ID | Verdict |', '|---|---|', '| STORY-1:AC-001 | matched |',
    '| STORY-1:CON-001 | matched |'
  ].join('\n');
  assert.deepEqual(inspectQualifiedConformanceReport(report, clauseIds)
    .filter((finding) => finding.code === 'conformance.clause-row-missing')
    .map((finding) => finding.clauseId), [
    'STORY-1:REQ-001', 'STORY-1:BEH-001', 'STORY-1:IFC-001'
  ]);
});

test('qualified report rejects extra bare rows and spaced template verdict choices', () => {
  const report = [
    '| Clause ID | Evidence | Verdict |',
    '|---|---|---|',
    '| STORY-1:REQ-001 | source | matched / partial |',
    '| AC-001 | extra bare row | matched |'
  ].join('\n');
  const findings = inspectQualifiedConformanceReport(report, ['STORY-1:REQ-001']);
  assert.deepEqual(findings.map((finding) => finding.code), [
    'conformance.verdict-invalid', 'conformance.clause-row-invalid'
  ]);
});

test('self-approval disclosure comes from retained decisions and ignores managed metadata and inputs', () => {
  const workflow = {
    phaseOrder: ['planning', 'release'],
    phases: {
      planning: { approvals: [{ decision: 'approved', selfApproval: true, actor: { login: 'reviewer-one' } }] },
      release: { approvals: [] }
    }
  };
  const managedOnly = [
    '<!-- singularity-flow:metadata',
    '{"phase":"planning","login":"reviewer-one"}',
    '-->',
    '# Conformance',
    '## Self-approval disclosures',
    'None.',
    '<!-- singularity-flow:inputs:start -->',
    'planning was approved by reviewer-one',
    '<!-- singularity-flow:inputs:end -->'
  ].join('\n');
  assert.deepEqual(inspectSelfApprovalDisclosures(managedOnly, workflow).map((entry) => entry.code), [
    'conformance.self-approval-undisclosed'
  ]);
  const disclosed = managedOnly.replace('None.', 'planning was self-approved by reviewer-one.');
  assert.deepEqual(inspectSelfApprovalDisclosures(disclosed, workflow), []);
});

test('a conformance report owes its self-approval disclosure before publication, whatever its row policy', async (t) => {
  // The approval gate refuses an undisclosed self-approval for every conformance report. The draft
  // check asked only under the qualified-row policy, so a release under another policy was published
  // and then refused at approval.
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-conformance-disclosure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { workItemRoot: 'singularity/work-items' };
  const phase = { id: 'release', requiredArtifact: { kind: 'conformance-report', path: 'artifacts/release/conformance.md' } };
  const workflow = { workItem: { id: 'HEX-1' }, phaseOrder: ['planning', 'release'], resolution: { spec: { conformanceRows: 'legacy' } },
    phases: { planning: { approvals: [{ selfApproval: true, actor: { login: 'release-reviewer' } }] }, release: { approvals: [] } } };
  const report = path.join(root, config.workItemRoot, 'HEX-1', phase.requiredArtifact.path);
  assert.deepEqual(await inspectPhaseQualifiedConformance(root, config, workflow, phase), [], 'no report yet, nothing to inspect');
  await mkdir(path.dirname(report), { recursive: true });
  await writeFile(report, '# Conformance\n\n| Clause | Verdict |\n|---|---|\n| AC-001 | matched |\n');
  assert.deepEqual((await inspectPhaseQualifiedConformance(root, config, workflow, phase)).map((finding) => finding.code),
    ['conformance.self-approval-undisclosed']);
  await writeFile(report, '# Conformance\n\n| Clause | Verdict |\n|---|---|\n| AC-001 | matched |\n\n## Self-approval disclosures\n\n- `planning`: self-approved by release-reviewer; not an independent review.\n');
  assert.deepEqual(await inspectPhaseQualifiedConformance(root, config, workflow, phase), []);
});

test('every conformance report owes the gate\'s rows and verdicts before publication, whatever its row policy', async (t) => {
  // The gate refused a report without qualified rows for a missing identifier, no verdict or a
  // partial verdict only at approval; the draft check, publication and submission now ask the same.
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-conformance-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { workItemRoot: 'singularity/work-items' };
  const phase = { id: 'release', requiredArtifact: { kind: 'conformance-report', path: 'artifacts/release/conformance.md' } };
  const workflow = { workItem: { id: 'HEX-2' }, phaseOrder: ['intake', 'build', 'release'], resolution: { spec: { conformanceRows: 'legacy' } },
    phases: {
      intake: { id: 'intake', approvals: [], requiredArtifact: { kind: 'requirements', path: 'artifacts/intake/intake.md' } },
      build: { id: 'build', approvals: [], generationPolicy: { task: 'code' }, writeScope: 'source-and-artifact', requiredArtifact: { kind: 'implementation-summary' } },
      release: { id: 'release', approvals: [] }
    } };
  const item = path.join(root, config.workItemRoot, 'HEX-2');
  await mkdir(path.join(item, 'artifacts/intake'), { recursive: true });
  await mkdir(path.join(item, 'artifacts/release'), { recursive: true });
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), '| [AC-001] | Keys show digits. |\n| [AC-002] | Clear resets. |\n');
  const report = path.join(item, phase.requiredArtifact.path);
  await writeFile(report, '# Conformance\n\n| Clause | Planned | Observed | Tests | Verdict |\n|---|---|---|---|---|\n| AC-001 | keypad | keypad | yes | partial |\n');
  const findings = await inspectPhaseQualifiedConformance(root, config, workflow, phase);
  assert.deepEqual(findings.map((finding) => [finding.code, finding.clauseId]),
    [['conformance.clause-row-missing', 'AC-002'], ['conformance.verdict-incomplete', 'AC-001']]);
  // An honest partial verdict is the delivering step's gap: routed to an upstream issue, never to an edit of the verdict.
  const [choice] = phaseResolutionChoices(workflow, phase, { ...findings[1], category: 'traceability', value: 'AC-001' }).choices;
  assert.equal(choice.kind, 'upstream-issue');
  assert.match(choice.command, /^singularity-flow upstream-issue raise --phase build --about AC-001 /u);
  await writeFile(report, '# Conformance\n\nAC-001 and AC-002 were compared.\n');
  assert.deepEqual((await inspectPhaseQualifiedConformance(root, config, workflow, phase)).map((finding) => finding.code),
    ['conformance.verdict-invalid']);
  // Qualified rows judge rows and verdicts themselves; only the verdict presence is shared.
  assert.deepEqual(inspectConformanceReportContract('| AC-001 | partial |', { rowsQualified: true, expected: ['AC-009'] }), []);
  assert.deepEqual(inspectConformanceReportContract('nothing here', { rowsQualified: true }).map((finding) => finding.code), ['conformance.verdict-invalid']);
});
