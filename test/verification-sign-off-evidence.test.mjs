/**
 * A criterion proved by a person's visual sign-off, not a test (owner's d-story, 2026-11-22): the verification evidence
 * SFlow writes said "no tagged test" for it, its reviewer was given only the Story's reference image, judged the claim
 * unproved, and blocked verification up to version 5. Now the evidence names the sign-off, and the review of a document
 * that cites it is given its exact image.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { testEvidence } from '../src/record-documents.mjs';
import { citedSignOffSources } from '../src/source-review-lifecycle.mjs';

const FILE = 'singularity/work-items/D-1/evidence/visual-sign-offs/D-1-AC-004-responsive-screen.png';
const record = (overrides = {}) => ({ id: 'WIT-004', clauseId: 'D-1:AC-004', slot: 'responsive-screen', method: 'visual', file: FILE, ...overrides });
const row = (status = 'satisfied') => ({ id: 'D-1:AC-004', type: 'AC', verification: { association: 'none', witnesses: [],
  contract: { slots: [{ slot: 'responsive-screen', method: 'visual', status, witnesses: ['WIT-004'] }] } } });

test('a criterion a person signed off is cited by its sign-off, never "no tagged test"', () => {
  assert.equal(testEvidence(row(), [record()]), `visual sign-off \`WIT-004\` (\`${FILE}\`), confirmed by a person`);
  // The latest record of the slot, after a capture was taken again.
  assert.match(testEvidence(row(), [record({ id: 'WIT-002', file: 'old.png' }), record()]), /WIT-004/u);
  // Only a satisfied slot counts; nothing signed is still no test.
  assert.equal(testEvidence(row('missing'), [record()]), 'no tagged test');
  assert.equal(testEvidence(row(), []), 'no tagged test');
  // A test and a sign-off both: both are said.
  const both = { ...row(), verification: { ...row().verification, witnesses: [{ test: 'graph stays visible', attemptId: 'A-1', outcome: 'passed' }] } };
  assert.equal(testEvidence(both, [record()]), `graph stays visible, run \`A-1\`: passed; visual sign-off \`WIT-004\` (\`${FILE}\`), confirmed by a person`);
});

test('the review of a document that cites a sign-off is given its exact committed image, and only that one', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sign-off-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Review Test', '-c', 'user.email=review-test@example.test', ...args], { cwd: root });
  git('init', '-q', '-b', 'main');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  await mkdir(path.join(root, path.dirname(FILE)), { recursive: true });
  await writeFile(path.join(root, FILE), bytes);
  await writeFile(path.join(root, 'other.png'), bytes);
  git('add', '.');
  git('commit', '-q', '-m', 'evidence');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const workflow = { workItem: { id: 'D-1' }, witnessRecords: [record({ sha256: `sha256:${sha}` }), record({ id: 'WIT-005', clauseId: 'D-1:AC-005', slot: 'other', file: 'other.png', sha256: `sha256:${sha}` })] };
  const cited = await citedSignOffSources(root, workflow, { text: '| `D-1:AC-004` | visual sign-off `WIT-004` | verified |' }, [], []);
  assert.deepEqual(cited.map((source) => [source.id, source.path, source.originalSha256, source.mimeType]), [['WIT-004', FILE, sha, 'image/png']]);
  assert.match(cited[0].instruction, /native image\/PDF tool/u);
  // A document that cites none gets none; an image already offered is not offered twice.
  assert.deepEqual(await citedSignOffSources(root, workflow, { text: 'nothing cited' }, [], []), []);
  assert.deepEqual(await citedSignOffSources(root, workflow, { text: FILE }, [], [{ id: 'X', path: FILE }]), []);
});

// ------------------------------------------------------------------ any workflow, any author (owner, 2026-11-22)

import { phaseReadsWitnessDecisions } from '../src/verification/witness-decisions.mjs';
import { witnessUncitedFindings } from '../src/verification/witness-report-findings.mjs';

/** A custom workflow, as a team or a marketplace agent names it: a code step `build`, then `uat` writing a free-form report. */
const custom = () => ({ workItem: { id: 'D-1' }, status: 'in_progress', phaseOrder: ['scope', 'build', 'uat'], resolution: { phases: [] },
  phases: { scope: { id: 'scope', requiredArtifact: { kind: 'custom-notes' } },
    build: { id: 'build', generationPolicy: { task: 'code' } },
    uat: { id: 'uat', generationPolicy: { task: 'document' }, requiredArtifact: { kind: 'uat-report' } } },
  witnessRecords: [record()] });

test('a custom step after the code, whatever it is called, reads the Story\'s sign-offs; a step before the code does not', () => {
  const workflow = custom();
  assert.equal(phaseReadsWitnessDecisions(workflow, workflow.phases.uat), true, 'a QA or acceptance step a team or marketplace agent named');
  assert.equal(phaseReadsWitnessDecisions(workflow, workflow.phases.scope), false);
  assert.equal(phaseReadsWitnessDecisions(workflow, workflow.phases.build), false, 'the code step itself');
});

test('a report that marks a criterion proved without citing its sign-off is the author\'s to fix before review, by any author', () => {
  const witness = { id: 'WIT-004', clauseId: 'D-1:AC-004', slot: 'responsive-screen', method: 'visual', file: FILE, valid: true, decision: 'satisfies' };
  // The d-story table, and the same claim in a sentence a marketplace agent might write.
  for (const report of ['| `D-1:AC-004` | no tagged test | `src/App.css` | verified |', 'D-1:AC-004 is verified at desktop and tablet widths.']) {
    const [finding, ...rest] = witnessUncitedFindings(report, [witness]);
    assert.equal(rest.length, 0);
    assert.equal(finding?.code, 'conformance.witness-uncited', report);
    assert.match(finding.message, /marks D-1:AC-004 proved; its proof is WIT-004, a person's visual sign-off of .+\. Cite WIT-004 there\.$/u);
    assert.ok(finding.message.length <= 200, finding.message);
  }
  // Cited by its ID or its file, or not claimed, or a sign-off that no longer holds: nothing to fix.
  assert.deepEqual(witnessUncitedFindings('| `D-1:AC-004` | visual sign-off `WIT-004` | verified |', [witness]), []);
  assert.deepEqual(witnessUncitedFindings(`D-1:AC-004 is verified by ${FILE}.`, [witness]), []);
  assert.deepEqual(witnessUncitedFindings('D-1:AC-004 is still pending.', [witness]), []);
  assert.deepEqual(witnessUncitedFindings('D-1:AC-004 is verified.', [{ ...witness, valid: false }]), []);
});

test('the reviewer of a custom report step gets the sign-off of every criterion it names, cited or not', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sign-off-custom-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Review Test', '-c', 'user.email=review-test@example.test', ...args], { cwd: root });
  git('init', '-q', '-b', 'main');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5, 6]);
  await mkdir(path.join(root, path.dirname(FILE)), { recursive: true });
  await writeFile(path.join(root, FILE), bytes);
  git('add', '.');
  git('commit', '-q', '-m', 'evidence');
  const workflow = custom();
  workflow.witnessRecords = [record({ sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` })];
  const uncited = { text: 'D-1:AC-004 is verified at desktop and tablet widths.' };
  assert.deepEqual((await citedSignOffSources(root, workflow, uncited, [], [], workflow.phases.uat)).map((source) => source.id), ['WIT-004']);
  // The same words in a step before the code are not a report on it: nothing is offered.
  assert.deepEqual(await citedSignOffSources(root, workflow, uncited, [], [], workflow.phases.scope), []);
});
