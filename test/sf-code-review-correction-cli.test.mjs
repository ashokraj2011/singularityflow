/**
 * Story new-ash-graph, end to end through the CLI (owner, 2026-11-18): a code step's version 1 publishes with its tests
 * passing at the gate; its review, shown only the changed test files and a summary written before the gate ran, keeps
 * a finding about the tests; the person says yes to "fix the review's findings", and version 2 changes test lines only.
 *   E: the review packet carries every run the gate made of the version, with its counts and the Node it ran on, and
 *      tells the reviewer those runs stand over the summary's word.
 *   F: version 2 publishes on version 1's unchanged source, never refused as having no product source, never an appeal.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { repository } from './helpers/run-and-test-fixture.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const INTAKE = ['# QF-1 — Quick fix scope and plan', '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
  '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', '| [QF-1:AC-001] | The exported value equals 2. |', '',
  '## Planned implementation evidence', '',
  '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
  '| `QF-1:AC-001` | `src/value.mjs` | `test/value.test.mjs` | modified | The test reads 2. |', '',
  '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n');

const TEST_LINES = ["import test from 'node:test';", "import assert from 'node:assert/strict';", "import { value } from '../src/value.mjs';",
  '// @ac:QF-1:AC-001', "test('returns two', () => assert.equal(value, 2));", ''];

function cite(source, needle) {
  const lines = source.text.split(/\r?\n/u);
  const index = lines.findIndex((line) => line.includes(needle));
  assert.ok(index >= 0, `${source.id} has no line with ${needle}`);
  return { sourceId: source.id, line: index + 1, quote: needle };
}

function retainReview(repo, phase, report) {
  const staged = repo.sflowJson('review-source', 'stage', phase, '--report-json', JSON.stringify(report));
  assert.equal(staged.status, 0, JSON.stringify(staged.value));
  const checked = repo.sflowJson('review-source', 'check', phase, '--report-file', staged.value.stagingPath);
  assert.equal(checked.value.retentionReady, true, JSON.stringify(checked.value.findings ?? checked.value, null, 2).slice(0, 4000));
  const retained = repo.sflowJson('review-source', 'submit', phase, '--report-file', staged.value.stagingPath);
  assert.equal(retained.status, 0, JSON.stringify(retained.value));
  return repo.sflowJson('review-source', 'status', phase).value;
}

function codeReport(packet, blocking = []) {
  const code = packet.sources.find((entry) => entry.path === 'src/value.mjs');
  const tests = packet.sources.find((entry) => entry.path === 'test/value.test.mjs');
  assert.ok(code && tests, JSON.stringify(packet.sources.map((entry) => entry.path)));
  return { ...packet.reportTemplate,
    rows: [{ clauseId: 'QF-1:AC-001', implementation: [cite(code, 'export const value = 2;')],
      tests: [cite(tests, "test('returns two', () => assert.equal(value, 2));")], assessment: 'implemented', testAssessment: 'proves' }],
    unplannedPaths: [], qualityReviewed: packet.code.quality.map((entry) => entry.id), findings: blocking.map((make) => make(code, tests)) };
}

test('E and F: a version opened for a review finding about the tests publishes on the published source, and the review reads the gate\'s own runs',
  slowLane({ timeout: 480_000 }), async (t) => {
    const repo = await repository(t, { implementCommands: false, reviews: true });
    const { root, sflow, sflowJson, must } = repo;
    must('git', ['init', '-q', '--bare', '-b', 'main', path.join(repo.base, 'remote.git')], repo.base);
    must('git', ['remote', 'add', 'origin', path.join(repo.base, 'remote.git')]);
    must('git', ['push', '-q', '-u', 'origin', 'main']);
    sflow('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.');
    sflow('prepare', 'intake');
    await writeFile(path.join(root, 'singularity/work-items/QF-1/artifacts/intake/intake.md'), INTAKE);
    sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
    const document = sflowJson('review-source', 'context', 'intake').value;
    const intake = retainReview(repo, 'intake', { ...document.reportTemplate,
      rows: document.sources.map((source, index) => ({ id: `row-${index + 1}`, ...cite(source, source.text.split(/\r?\n/u).find((line) => line.trim()).trim()), outcome: 'consistent' })),
      findings: [] });
    assert.equal(intake.status, 'ready', JSON.stringify(intake.findings));
    sflow('submit', 'intake');
    sflow('approve', 'intake', '--yes');
    sflow('resume', 'QF-1');

    // Version 1: its code and test, published; the gate runs the test and it passes.
    sflow('prepare', 'implement');
    await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 — return the approved value\nexport const value = 2;\n');
    await writeFile(path.join(root, 'test/value.test.mjs'), TEST_LINES.join('\n'));
    sflow('prepare', 'implement');
    const published = sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
    assert.equal(published.status, 0, JSON.stringify(published.value));

    // E: the packet names the gate's own run of version 1, with its counts and the Node it ran on.
    const first = sflowJson('review-source', 'context', 'implement').value;
    assert.equal(first.testRuns?.length, 1, JSON.stringify(first.testRuns ?? first.code).slice(0, 2000));
    const [run] = first.testRuns;
    assert.equal(run.status, 'passed');
    assert.deepEqual([run.tests?.passed, run.tests?.failed], [1, 0]);
    assert.match(String(run.node), /^\d+\.\d+\.\d+$/u, 'the Node the test ran on, from its own record');
    assert.match(run.words, /passed: 1 of 1 tests passed, 0 failed, on Node \d+\.\d+\.\d+\.$/u);
    assert.match(first.citationGuide.checks[1], /context\.testRuns: they stand over any test result the summary states/u);

    // The review keeps a finding about the tests, as new-ash-graph's did from a summary written before the gate.
    const corrected = retainReview(repo, 'implement', codeReport(first, [(code, tests) => ({ id: 'regression-run', severity: 'blocking', check: 'tests',
      clauseId: 'QF-1:AC-001', message: 'The summary says the suite failed on Node 26 and a rerun is pending: run it on Node 22.',
      ...cite(tests, "test('returns two', () => assert.equal(value, 2));") })]));
    assert.equal(corrected.status, 'correction-required');
    // The person's yes to "fix the review's findings": version 2 opens through the reviewed rollover.
    const preview = sflowJson('phase', 'rollover', 'implement');
    assert.equal(preview.status, 0, JSON.stringify(preview.value));
    const opened = sflowJson('phase', 'rollover', 'implement', '--confirm', preview.value.confirmation);
    assert.equal(opened.status, 0, JSON.stringify(opened.value));
    const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));
    assert.equal(workflow.phases.implement.versionOpening?.reason, 'review-corrections', JSON.stringify(workflow.phases.implement.versionOpening));

    // F: version 2 changes test lines only, as new-ash-graph's did, and publishes on version 1's exact source.
    sflow('prepare', 'implement');
    await writeFile(path.join(root, 'test/value.test.mjs'), TEST_LINES.join('\n').replace('// @ac:QF-1:AC-001',
      '// @ac:QF-1:AC-001 The test reads the exported value.'));
    sflow('prepare', 'implement');
    const republished = sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
    assert.equal(republished.status, 0, JSON.stringify(republished.value).slice(0, 3000));
    const after = JSON.parse(await readFile(path.join(root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));
    assert.equal(after.phases.implement.generation, 2);
    assert.deepEqual(after.phases.implement.deliveryEvidence.sourcePaths, ['src/value.mjs']);

    // Its review reads version 2's own run, and the step submits once it is ready.
    const second = sflowJson('review-source', 'context', 'implement').value;
    assert.equal(second.generation, 2);
    assert.equal(second.testRuns?.[0]?.status, 'passed', JSON.stringify(second.testRuns));
    const ready = retainReview(repo, 'implement', codeReport(second));
    assert.equal(ready.status, 'ready', JSON.stringify(ready.findings));
    assert.match(sflow('submit', 'implement'), /implement/u);
  });
