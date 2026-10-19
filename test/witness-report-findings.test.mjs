import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recordWitness, WITNESS_CHECKLIST } from '../src/verification/witness-records.mjs';
import { witnessDecisionsFrom } from '../src/verification/witness-decisions.mjs';
import {
  reportUnits, witnessReportAdvisories, witnessReportFindings, WITNESS_UNREPORTED_CODE
} from '../src/verification/witness-report-findings.mjs';

const SCREEN = 'singularity/work-items/bin-501/evidence/decimal-to-binary.png';
const BYTES = Buffer.from('png-bytes-as-captured');
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function story() {
  const workflow = {
    workItem: { id: 'BIN-501' }, currentPhase: 'release', phaseOrder: ['verification', 'release'],
    phases: {
      verification: { id: 'verification', requiredArtifact: { kind: 'visual-test-evidence' } },
      release: { id: 'release', requiredArtifact: { kind: 'conformance-report' } }
    }
  };
  recordWitness(workflow, {
    clauseId: 'BIN-501:AC-001', file: SCREEN, sha256: digest(BYTES),
    slot: { slot: 'decimal-to-binary-screenshot', method: 'visual', witness: { target: 'converter screen' } },
    answers: Object.fromEntries(WITNESS_CHECKLIST.map((item) => [item, 'yes'])),
    reason: 'inspected the screenshot and it look fine', actor: 'reviewer@example.invalid',
    authorityGroup: 'qa-approvers', at: '2026-10-18T09:30:00.000Z'
  });
  return workflow;
}

const decisions = (workflow, bytes = BYTES) => witnessDecisionsFrom(workflow, new Map([[SCREEN, digest(bytes)]]));

// The incident's wording: a row and a residual-risk sentence that deny the recorded review.
const INCIDENT = [
  '<!-- singularity-flow:metadata',
  'phase: release',
  '-->',
  '# Release conformance',
  '',
  '| Clause | Verdict | Evidence |',
  '|---|---|---|',
  '| BIN-501:AC-001 | matched | `converts 10 to 1010` passed in generation 1; this verdict does not claim independent human visual acceptance. |',
  '| BIN-501:AC-002 | matched | `rejects negative input` passed in generation 1. |',
  '',
  '## Residual risks',
  '',
  'Tests pass for every criterion. The screenshot for BIN-501:AC-001 and separate human visual review remain disclosed.',
  ''
].join('\n');

test('the incident report wording raises one advisory per denying row or sentence', () => {
  const findings = witnessReportFindings(INCIDENT, decisions(story()));
  assert.deepEqual(findings.map((entry) => [entry.code, entry.line, entry.clauseId, entry.record]), [
    [WITNESS_UNREPORTED_CODE, 8, 'BIN-501:AC-001', 'WIT-001'],
    [WITNESS_UNREPORTED_CODE, 13, 'BIN-501:AC-001', 'WIT-001']
  ]);
  for (const finding of findings) {
    assert.equal(finding.blocking, false);
    assert.equal(finding.category, 'evidence');
    assert.match(finding.message, /^Line \d+ says BIN-501:AC-001 has no human visual review, but WIT-001 recorded a visual review of singularity\/work-items\/bin-501\/evidence\/decimal-to-binary\.png \(slot decimal-to-binary-screenshot\) by reviewer@example\.invalid at 2026-10-18T09:30:00\.000Z that satisfies it, and its bound file is unchanged\. Cite WIT-001/u);
    assert.doesNotMatch(finding.message, /\bgoverned\b/iu);
  }
});

test('a report that cites WIT-001 has seen the record and gets no advisory', () => {
  const cited = INCIDENT
    .replace('this verdict does not claim independent human visual acceptance.', 'human visual acceptance is WIT-001; this verdict does not claim independent human visual acceptance beyond it.');
  assert.deepEqual(witnessReportFindings(cited, decisions(story())), []);
  const elsewhere = `${INCIDENT}\n## Recorded human visual reviews\n\n- WIT-001 satisfies BIN-501:AC-001.\n`;
  assert.deepEqual(witnessReportFindings(elsewhere, decisions(story())), []);
});

test('no advisory for a review that is not valid, another criterion, or a claim in another sentence', () => {
  assert.deepEqual(witnessReportFindings(INCIDENT, decisions(story(), Buffer.from('recaptured'))), [],
    'a bound file changed since the review: the report is right that no valid review exists');
  assert.deepEqual(witnessReportFindings(INCIDENT, []), []);
  const other = '| BIN-501:AC-002 | matched | No human visual review was recorded. |\n';
  assert.deepEqual(witnessReportFindings(other, decisions(story())), []);
  const apart = 'BIN-501:AC-001 is matched by its tests.\nThe release has no human visual sign-off of the layout.\n';
  assert.deepEqual(witnessReportFindings(apart, decisions(story())), [], 'conservative: the criterion and the claim share no sentence');
  const satisfied = '| BIN-501:AC-001 | matched | The screenshot was reviewed by a person. |\n';
  assert.deepEqual(witnessReportFindings(satisfied, decisions(story())), []);
});

test('engine-written inputs and fenced code are not the author\'s claims', () => {
  const managed = [
    '# Release conformance', '',
    '<!-- singularity-flow:inputs:start -->',
    'BIN-501:AC-001 has no human visual review yet.',
    '<!-- singularity-flow:inputs:end -->', '',
    '```text', 'BIN-501:AC-001: no human visual review', '```', ''
  ].join('\n');
  assert.deepEqual(witnessReportFindings(managed, decisions(story())), []);
  const units = reportUnits('First sentence about BIN-501:AC-001.  Second one\nwraps a line.\n\n| a | b |\n|---|---|\n| c | d |\n');
  assert.deepEqual(units.map((unit) => unit.line), [1, 1, 4, 6]);
});

test('a bare criterion ID counts when exactly one witnessed criterion ends with it', () => {
  const bare = '| AC-001 | matched | Separate human visual review remains outstanding. |\n';
  assert.deepEqual(witnessReportFindings(bare, decisions(story())).map((entry) => entry.clauseId), ['BIN-501:AC-001']);
});

test('the draft-check advisory reads the step\'s report and the files the witness binds', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-witness-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, path.dirname(SCREEN)), { recursive: true });
  await writeFile(path.join(root, SCREEN), BYTES);
  const report = 'singularity/work-items/bin-501/artifacts/release/conformance.md';
  await mkdir(path.join(root, path.dirname(report)), { recursive: true });
  await writeFile(path.join(root, report), INCIDENT);
  const workflow = story();
  const advisories = await witnessReportAdvisories(root, workflow, workflow.phases.release, { path: report, exists: true });
  assert.deepEqual(advisories.map((entry) => [entry.path, entry.line, entry.record]), [[report, 8, 'WIT-001'], [report, 13, 'WIT-001']]);
  assert.deepEqual(await witnessReportAdvisories(root, workflow, { id: 'implementation', requiredArtifact: { kind: 'implementation-summary' } },
    { path: report, exists: true }), [], 'a step that does not report on visual evidence is not checked');
  assert.deepEqual(await witnessReportAdvisories(root, { ...workflow, witnessRecords: [] }, workflow.phases.release, { path: report, exists: true }), []);
  await writeFile(path.join(root, SCREEN), 'recaptured');
  assert.deepEqual(await witnessReportAdvisories(root, workflow, workflow.phases.release, { path: report, exists: true }), []);
});
