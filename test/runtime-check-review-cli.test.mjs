/**
 * The runtime check between publication and review, through the CLI on a real quick-fix Story (step intents spec §12.3,
 * §12.4): the Story adopts applicationReview (optional), its code step publishes a change that drops a library export,
 * and the reviewer's context carries what SFlow saw when it ran the change, with check (e) and the library checklist.
 * The reviewer cannot retain a report that leaves the runtime finding unanswered; answered as breaks use, citing the
 * line, it is a blocking finding for the author, under the existing brake. The capture is kept for the version: the
 * runtime-check command shows the same one, and nothing runs twice.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { repository } from './helpers/run-and-test-fixture.mjs';

const INTAKE = ['# QF-1 — Quick fix scope and plan', '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
  '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', '| [QF-1:AC-001] | The exported value equals 2. |', '',
  '## Planned implementation evidence', '',
  '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
  '| `QF-1:AC-001` | `src/value.mjs` | `test/value.test.mjs` | modified | The test reads 2. |', '',
  '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n');

function cite(source, needle) {
  const index = source.text.split(/\r?\n/u).findIndex((line) => line.includes(needle));
  assert.ok(index >= 0, `${source.id} has no line with ${needle}`);
  return { sourceId: source.id, line: index + 1, quote: needle };
}

test('the code step\'s review reads the runtime check of its version and must answer what breaks use', { timeout: 300_000 }, async (t) => {
  const repo = await repository(t, { implementCommands: false, reviews: true, applicationReview: { mode: 'optional' },
    files: { 'package.json': JSON.stringify({ name: 'value-lib', version: '1.0.0', type: 'module', main: 'src/value.mjs', scripts: { test: 'node --test' } }),
      'src/value.mjs': 'export const value = 1;\nexport const other = 1;\n' } });
  const { root, sflow, sflowJson, must } = repo;
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(repo.base, 'remote.git')], repo.base);
  must('git', ['remote', 'add', 'origin', path.join(repo.base, 'remote.git')]);
  must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.');
  sflow('prepare', 'intake');
  await writeFile(path.join(root, 'singularity/work-items/QF-1/artifacts/intake/intake.md'), INTAKE);
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  const document = sflowJson('review-source', 'context', 'intake').value;
  assert.equal(document.runtimeCheck, undefined, 'a document step is not run');
  const intake = { ...document.reportTemplate, findings: [],
    rows: document.sources.map((source, index) => ({ id: `row-${index + 1}`, ...cite(source, source.text.split(/\r?\n/u).find((line) => line.trim()).trim()), outcome: 'consistent' })) };
  const staged = sflowJson('review-source', 'stage', 'intake', '--report-json', JSON.stringify(intake));
  assert.equal(sflowJson('review-source', 'submit', 'intake', '--report-file', staged.value.stagingPath).status, 0);
  sflow('submit', 'intake');
  sflow('approve', 'intake', '--yes');
  sflow('resume', 'QF-1');

  // The change: the value becomes 2, and the module's other export is dropped (a breaking change nobody declared).
  sflow('prepare', 'implement');
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 — return the approved value\nexport const value = 2;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", '// @ac:QF-1:AC-001', "test('returns two', () => assert.equal(value, 2));", ''].join('\n'));
  sflow('prepare', 'implement');
  assert.equal(sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator').status, 0);

  const packet = sflowJson('review-source', 'context', 'implement').value;
  assert.equal(packet.kind, 'code');
  const [check] = packet.runtimeCheck.checks;
  assert.deepEqual([check.kind, check.status], ['library', 'ran'], JSON.stringify(packet.runtimeCheck));
  assert.deepEqual(check.findings.map((finding) => [finding.id, finding.use, finding.title]), [['RT-001', 'breaks-use', 'other is no longer exported']]);
  assert.equal(packet.reportTemplate.runtimeChecked, packet.runtimeCheck.id);
  assert.match(packet.citationGuide.checks[4], /^\(e\) Does it work for its users and callers/u);
  assert.deepEqual(Object.keys(packet.citationGuide.useChecklist), ['any code', 'library']);
  // Kept for this version: the command shows the same capture, and nothing ran again.
  assert.equal(sflowJson('app-review', 'runtime-check').value.id, packet.runtimeCheck.id);
  // The kind is the person's to confirm, once, by the short code of the line SFlow shows.
  const kinds = sflowJson('capability', 'kind').value;
  assert.match(kinds.question, /^SFlow sees this repository as a library \(a published package \(package\.json\)\)\. Right\?$/u);
  assert.match(kinds.confirm.copilotCommand, /^\/sf-confirm [0-9A-Z]{4}-[0-9A-Z]{4}$/u);
  assert.equal(kinds.confirm.byCode, `singularity-flow confirm ${kinds.confirm.copilotCommand.split(' ')[1]}`);
  // Another kind is named first, and shown again to confirm; nothing is recorded by naming it.
  const named = sflowJson('capability', 'kind', '--kind', 'repository-root=backend').value;
  assert.equal(named.projects[0].kind, 'backend');
  assert.match(named.confirm.command, /^singularity-flow capability kind --kind repository-root=backend --confirm sha256:[a-f0-9]{64}$/u);
  assert.equal(sflowJson('confirm', kinds.confirm.copilotCommand.split(' ')[1]).value.recorded, true);
  assert.deepEqual([sflowJson('capability', 'kind').value.confirmed, sflowJson('capability', 'kind').value.question], [true, null]);

  const code = packet.sources.find((entry) => entry.path === 'src/value.mjs');
  const tests = packet.sources.find((entry) => entry.path === 'test/value.test.mjs');
  const report = (findings) => ({ ...packet.reportTemplate, findings, unplannedPaths: [], qualityReviewed: packet.code.quality.map((entry) => entry.id),
    rows: [{ clauseId: 'QF-1:AC-001', implementation: [cite(code, 'export const value = 2;')], tests: [cite(tests, "test('returns two'")], assessment: 'implemented', testAssessment: 'proves' }] });
  // Left unanswered, the staged report is refused with exactly that to repair: the reviewer's own, before retaining.
  const silent = sflowJson('review-source', 'stage', 'implement', '--report-json', JSON.stringify(report([])));
  assert.equal(silent.value.error?.code, 'SOURCE_REVIEW_REPORT_INVALID', JSON.stringify(silent.value).slice(0, 2000));
  assert.deepEqual(silent.value.error.details.findings.map((entry) => entry.code), ['runtime-finding-unanswered']);
  assert.match(silent.value.error.details.findings[0].message, /RT-001: other is no longer exported/u);
  const answered = sflowJson('review-source', 'stage', 'implement', '--report-json', JSON.stringify(report([{ id: 'dropped-export', check: 'use', use: 'breaks-use',
    runtimeFinding: 'RT-001', severity: 'blocking', message: 'The module no longer exports other; callers that import it break, and the plan keeps the interface.',
    ...cite(code, 'export const value = 2;') }])));
  assert.equal(sflowJson('review-source', 'check', 'implement', '--report-file', answered.value.stagingPath).value.retentionReady, true);
  assert.equal(sflowJson('review-source', 'submit', 'implement', '--report-file', answered.value.stagingPath).status, 0);
  const status = sflowJson('review-source', 'status', 'implement').value;
  assert.equal(status.status, 'correction-required');
  assert.ok(status.findings.some((entry) => entry.code === 'reviewer-blocker' && entry.reviewFindingId === 'dropped-export'), JSON.stringify(status.findings).slice(0, 2000));
  assert.deepEqual([status.continuation.nextSkill, status.continuation.copilotCommand], ['/sf-code', '/sf-code implement'], 'the author fixes it in the next version');
});
