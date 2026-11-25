/**
 * SFlow sets the citation values a review packet's own quotes fix exactly [owner, 2026-11-20].
 *
 * On a real Story, `/sf-review-source implementation` ended "unretained after two citation repair attempts": the
 * reviewer's judgments were right and only four citation line numbers were off by one or more. Each check said the
 * unchanged quote was on exactly one line (matchCount 1, proposedEdit 14); the reviewer set line 14 and also copied
 * line 15's text into the quote, so the next check proposed 15, and it flipped back and forth until its repairs ran
 * out. Now the check (and submit, and the older stage route) moves such a line itself, in the staged file, and checks
 * again; a quote on two or more lines, or one the reviewer changed, stays the reviewer's repair as before.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { agentAct, completeAgentResult } from '../src/agent-output.mjs';
import { refusalDetails } from '../src/refusal-remediation.mjs';
import { codeSourceId, sourceReviewBinding } from '../src/source-grounded-review.mjs';
import { sourceReviewCorrectionWords, sourceReviewReportTemplate } from '../src/source-review-contract.mjs';
import { checkSourceReviewReport, correctSourceReviewReport } from '../src/source-review-lifecycle.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { publishedSpecificationStory, reviewReport } from './helpers/source-review-fixture.mjs';

// The owner's shape: a clause comment line, then the function it marks.
const CODE = ['// @clause:ARSHY:REQ-001 balances the equation', 'export const normalizeEquation = (input) => {', '  return input.trim();', '};', ''].join('\n');
const TESTS = ["import test from 'node:test';", "import assert from 'node:assert/strict';", "import { normalizeEquation } from '../src/equation.mjs';",
  '// @ac:ARSHY:REQ-001', "test('trims the equation', () => assert.equal(normalizeEquation(' H2 '), 'H2'));", ''].join('\n');

function context(code = CODE) {
  const sources = [
    { id: codeSourceId('src/equation.mjs'), path: 'src/equation.mjs', text: code },
    { id: codeSourceId('test/equation.test.mjs'), path: 'test/equation.test.mjs', text: TESTS }
  ];
  const input = { kind: 'code', workId: 'ARSHY', phase: 'implementation', generation: 1, sources,
    code: { deliveredClauses: ['ARSHY:REQ-001'], changedPaths: sources.map((source) => source.path), passedTests: ['test/equation.test.mjs'], quality: [],
      planned: { 'ARSHY:REQ-001': { expectedPaths: ['src/equation.mjs'], tests: ['test/equation.test.mjs'], testDisposition: 'unspecified' } } },
    artifact: { path: 'singularity/work-items/ARSHY/artifacts/implementation/summary.md', text: '# Implementation summary\n' },
    plan: { path: 'singularity/work-items/ARSHY/artifacts/intake/intake.md', text: '# Plan\n' },
    authorAgentId: 'sflow-coder', reviewerAgentId: 'sflow-source-reviewer', reviewerReadOnly: true };
  return { ...input, binding: sourceReviewBinding(input) };
}

const lineOf = (text, quote) => text.split('\n').findIndex((line) => line.includes(quote)) + 1;
const IMPLEMENTED = 'export const normalizeEquation = (input) => {';
const PROVED = "test('trims the equation'";

function report(ctx, { implementation = lineOf(CODE, IMPLEMENTED), test: testLine = lineOf(TESTS, PROVED), quote = IMPLEMENTED } = {}) {
  return { ...sourceReviewReportTemplate(ctx),
    rows: [{ clauseId: 'ARSHY:REQ-001',
      implementation: [{ sourceId: codeSourceId('src/equation.mjs'), line: implementation, quote }],
      tests: [{ sourceId: codeSourceId('test/equation.test.mjs'), line: testLine, quote: PROVED }],
      assessment: 'implemented', testAssessment: 'proves' }],
    unplannedPaths: [], qualityReviewed: [], findings: [] };
}

test('a wrong line under an unchanged quote on exactly one line is set by SFlow, and the packet is retainable', () => {
  const ctx = context();
  assert.equal(checkSourceReviewReport(report(ctx), ctx).retentionReady, true, 'the fixture is a valid review');
  const value = report(ctx, { implementation: 3, test: 4 });
  const before = JSON.stringify(value);
  const { report: corrected, checked, corrected: edits } = correctSourceReviewReport(value, ctx);
  assert.deepEqual(edits, [
    { field: 'rows[0].implementation[0].line', from: 3, to: 2 },
    { field: 'rows[0].tests[0].line', from: 4, to: 5 }]);
  assert.equal(checked.retentionReady, true, JSON.stringify(checked.findings));
  assert.equal(checked.repair.status, 'retain');
  assert.deepEqual(corrected, report(ctx), 'only the two line numbers changed: quotes, judgments and findings are as written');
  assert.equal(JSON.stringify(value), before, 'the packet given is not changed in place');
  assert.equal(sourceReviewCorrectionWords(edits), 'SFlow moved 2 citation line numbers to the lines their quotes are on.');

  // The owner's flip: the line set to 2 and line 1's text copied into the quote. The quote decides; it is never changed back.
  const flipped = report(ctx, { implementation: 2, quote: '// @clause:ARSHY:REQ-001 balances the equation' });
  const settled = correctSourceReviewReport(flipped, ctx);
  assert.deepEqual(settled.corrected, [{ field: 'rows[0].implementation[0].line', from: 2, to: 1 }]);
  assert.equal(settled.report.rows[0].implementation[0].quote, '// @clause:ARSHY:REQ-001 balances the equation');
  assert.equal(settled.checked.retentionReady, true);
  // A line outside the source is the same slip.
  assert.deepEqual(correctSourceReviewReport(report(ctx, { implementation: 999 }), ctx).corrected, [{ field: 'rows[0].implementation[0].line', from: 999, to: 2 }]);
});

test('a quote on two or more lines, one the reviewer changed, a stale binding or a malformed packet is never corrected', () => {
  const twice = context(`${CODE}export const normalizeEquation = (input) => {\n`);
  const ambiguous = report(twice, { implementation: 3 });
  const many = correctSourceReviewReport(ambiguous, twice);
  assert.deepEqual(many.corrected, []);
  assert.equal(many.report, ambiguous, 'nothing to set: the same packet');
  assert.equal(many.checked.retentionReady, false);
  const [hint] = many.checked.repair.citations;
  assert.equal(hint.matchCount, 2);
  assert.deepEqual(hint.matchingLines, [2, 5]);
  assert.equal(hint.sflowCorrects, undefined);
  assert.equal(hint.proposedEdit, undefined);
  assert.match(hint.instruction, /multiple lines\. Independently select the supporting line/u);

  const ctx = context();
  const changed = report(ctx, { implementation: 2, quote: 'export const normaliseEquation = (input) => {' });
  const none = correctSourceReviewReport(changed, ctx);
  assert.deepEqual(none.corrected, []);
  assert.equal(none.checked.retentionReady, false);
  assert.equal(none.checked.repair.citations[0].matchCount, 0);
  assert.equal(none.checked.repair.citations[0].sflowCorrects, undefined);

  const stale = report(ctx, { implementation: 3 });
  stale.binding = { ...stale.binding, generation: 2 };
  assert.deepEqual(correctSourceReviewReport(stale, ctx).corrected, [], 'changed inputs are reviewed again, never relocated');
  const malformed = report(ctx, { implementation: 3 });
  malformed.rows[0].tests[0].line = '5';
  assert.deepEqual(correctSourceReviewReport(malformed, ctx).corrected, [], 'a format error is repaired first');
});

test('an uncorrected draft is told to run the check, not to edit what the check sets', () => {
  const ctx = context();
  const only = checkSourceReviewReport(report(ctx, { implementation: 3, test: 4 }), ctx);
  assert.ok(only.repair.citations.every((entry) => entry.sflowCorrects === true && entry.matchCount === 1));
  assert.match(only.repair.citations[0].instruction, /stagingProtocol\.check moves this line field there itself\. Leave this citation, its line and its quote, as they are\./u);
  assert.match(only.repair.instruction, /^Run stagingProtocol\.check now and change nothing in the file: it moves each citation marked sflowCorrects/u);
  const mixed = checkSourceReviewReport(report(ctx, { implementation: 3, test: 4, quote: 'export const normaliseEquation' }), ctx);
  assert.deepEqual(mixed.repair.citations.map((entry) => entry.sflowCorrects ?? false), [false, true]);
  assert.match(mixed.repair.instruction, /^Leave each citation marked sflowCorrects as it is: stagingProtocol\.check corrects it\. /u);
});

test('the words, the act and the refusal name what SFlow set, and never send the reviewer to set it again', () => {
  const four = ['rows[0].implementation[0]', 'rows[1].implementation[0]', 'rows[2].implementation[0]', 'rows[3].tests[0]']
    .map((field, index) => ({ field: `${field}.line`, from: 14 + index, to: 15 + index }));
  assert.equal(sourceReviewCorrectionWords(four), 'SFlow moved 4 citation line numbers to the lines their quotes are on.');
  assert.equal(sourceReviewCorrectionWords(four.slice(0, 1)), 'SFlow moved a citation line number to the line its quote is on.');
  assert.equal(sourceReviewCorrectionWords([{ field: 'rows[3].quote', from: 'a', to: 'b' }, { field: 'rows[3].line', from: 1, to: 2 }]),
    'SFlow moved a citation line number to the line its quote is on and put back the quote marks a shell removed from a quote.');
  assert.equal(sourceReviewCorrectionWords([]), null);

  const words = sourceReviewCorrectionWords(four);
  const retain = { command: 'singularity-flow review-source submit implementation --report-file /x/review.json --for-agent --json' };
  const ready = agentAct({ resultType: 'source-review-check', retentionReady: true, corrected: four, correctedWords: words, findings: [],
    repair: { status: 'retain', mappingTasks: [] }, continuation: { nextAction: retain } });
  assert.equal(ready.state, 'retain');
  assert.ok(ready.said.startsWith(`${words} Packet valid: retain it now`), ready.said);
  const left = agentAct({ resultType: 'source-review-check', retentionReady: false, corrected: four, correctedWords: words,
    findings: [{ code: 'source-unknown', field: 'rows[4].tests[0].sourceId', message: 'unknown source' }], repair: { status: 'repair-packet', mappingTasks: [] } });
  assert.equal(left.state, 'correct');
  assert.match(left.said, /^SFlow moved 4 citation line numbers to the lines their quotes are on\. Leave those lines and quotes as they are now\. Repair only the fields still listed/u);
  assert.doesNotMatch(left.said, /change only this line/u);

  // A stage or submit refusal carries them across the process boundary.
  const projected = refusalDetails({ corrected: four, correctedWords: words,
    repair: { status: 'repair-packet', instruction: 'Repair.', citations: [{ field: 'rows[0]', matchCount: 1, matchingLines: [15], sflowCorrects: true,
      proposedEdit: { field: 'rows[0].line', value: 15 } }] } });
  assert.deepEqual(projected.corrected, four);
  assert.equal(projected.correctedWords, words);
  assert.equal(projected.repair.citations[0].sflowCorrects, true);
  const said = agentAct({ error: { code: 'SOURCE_REVIEW_REPORT_INVALID', details: { ...projected, repair: { ...projected.repair } } } }).said;
  assert.ok(said.startsWith(`${words} Leave those as they are now. Staged, not retained yet.`), said);
});

const executable = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'bin/singularity-flow.mjs');

function run(root, args) {
  const result = spawnSync(process.execPath, [executable, ...args], { cwd: root, encoding: 'utf8', timeout: childTimeout(60_000),
    env: { ...process.env, SINGULARITY_FLOW_AGENT_OUTPUT: 'full', SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.git/test-workspace-registry.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.git/test-active-workspace.json') } });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return completeAgentResult(result.stdout);
}

test('review-source check and submit set those lines in the staged file itself, keeping the reviewer\'s layout (owner, 2026-11-20)', async (t) => {
  const { root, phaseId } = await publishedSpecificationStory(t);
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(root, '.git', 'review-host', 'mode.json');
  t.after(() => { if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE; else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous; });
  const packet = run(root, ['review-source', 'context', phaseId, '--for-agent', '--json']);
  const check = () => run(root, ['review-source', 'check', phaseId, '--report-file', packet.stagingPath, '--for-agent', '--json']);
  // The binding left to SFlow, as the template allows: a correction never writes the binding into the file.
  const report = { ...reviewReport(packet), binding: 'from-context' };
  const lines = packet.sources.find((entry) => entry.id === 'story').text.split(/\r?\n/u);
  for (const row of report.rows) assert.equal(lines.filter((line) => line.includes(row.quote)).length, 1, row.quote);

  // A quote the reviewer changed: not SFlow's to set; the file stays byte for byte.
  const changed = structuredClone(report);
  changed.rows[0].quote = 'Save a draft and keep its saved status.';
  await writeFile(packet.stagingPath, JSON.stringify(changed));
  const refused = check();
  assert.equal(refused.retentionReady, false);
  assert.equal(refused.corrected, undefined);
  assert.equal(await readFile(packet.stagingPath, 'utf8'), JSON.stringify(changed));
  assert.equal(agentAct(refused).state, 'correct');

  // Two lines off, written on one line: set where they stand, and the packet goes straight to retention.
  const wrong = structuredClone(report);
  wrong.rows[0].line += 1;
  wrong.rows[2].line = wrong.rows[2].line === 1 ? 2 : 1;
  await writeFile(packet.stagingPath, JSON.stringify(wrong));
  const checked = check();
  assert.deepEqual(checked.corrected, [
    { field: 'rows[0].line', from: wrong.rows[0].line, to: report.rows[0].line },
    { field: 'rows[2].line', from: wrong.rows[2].line, to: report.rows[2].line }]);
  assert.equal(checked.correctedWords, 'SFlow moved 2 citation line numbers to the lines their quotes are on.');
  assert.equal(checked.retentionReady, true, JSON.stringify(checked.findings));
  assert.equal(checked.continuation.nextAction.command, packet.stagingProtocol.retain.command);
  const act = agentAct(checked);
  assert.equal(act.state, 'retain');
  assert.ok(act.said.startsWith(checked.correctedWords), act.said);
  assert.equal(await readFile(packet.stagingPath, 'utf8'), JSON.stringify(report), 'only the two numbers changed in the file');

  // Submitted without a check first, the same correction is made before the review is retained.
  const again = structuredClone(report);
  again.rows[1].line = again.rows[1].line === 1 ? 2 : 1;
  await writeFile(packet.stagingPath, `${JSON.stringify(again, null, 4)}\n`);
  const retained = run(root, ['review-source', 'submit', phaseId, '--report-file', packet.stagingPath, '--for-agent', '--json']);
  assert.ok(retained.reportSha256);
  assert.deepEqual(retained.corrected, [{ field: 'rows[1].line', from: again.rows[1].line, to: report.rows[1].line }]);
  assert.equal(await readFile(packet.stagingPath, 'utf8'), `${JSON.stringify(report, null, 4)}\n`, 'four-space layout kept');
  const record = JSON.parse(await readFile(path.resolve(root, retained.reportPath), 'utf8'));
  assert.deepEqual(record.report.rows.map((row) => row.line), report.rows.map((row) => row.line), 'the retained review cites the lines its quotes are on');
});

// The owner's next chat (2026-11-20): with the turn's repairs spent, the only route offered was the same check, which
// failed the same way; and a check of the corrected file must evaluate those bytes and retain them.
test('spent repairs never stop SFlow correcting and retaining, and their route is a fresh review turn, never the same check (owner, 2026-11-20)', async (t) => {
  const { root, phaseId } = await publishedSpecificationStory(t);
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(root, '.git', 'review-host', 'mode.json');
  t.after(() => { if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE; else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous; });
  const packet = run(root, ['review-source', 'context', phaseId, '--for-agent', '--json']);
  const check = () => run(root, ['review-source', 'check', phaseId, '--report-file', packet.stagingPath, '--for-agent', '--json']);
  const report = { ...reviewReport(packet), binding: 'from-context' };
  const digest = async () => (await import('node:crypto')).createHash('sha256').update(await readFile(packet.stagingPath)).digest('hex');
  // Three changed packets whose quote no line holds: the reviewer's to repair, and the turn's two repairs are spent.
  const spend = async () => {
    let result;
    for (const attempt of [1, 2, 3]) {
      await writeFile(packet.stagingPath, JSON.stringify({ ...report, rows: report.rows.map((row, index) => (index ? row : { ...row, quote: `Save a draft, attempt ${attempt}.` })) }));
      result = check();
    }
    return result;
  };
  const spent = await spend();
  assert.equal(spent.retentionReady, false);
  assert.equal(spent.incomplete.recorded, true);
  const fresh = packet.stagingProtocol.check.command.replace(/ stage .*$/u, ` context ${phaseId} --for-agent --json`);
  assert.equal(spent.continuation.nextAction.command, fresh, 'the way on is a fresh review turn');
  assert.notEqual(spent.continuation.nextAction.command, packet.stagingProtocol.check.command);
  assert.equal(spent.progress.state, 'repairs-spent', 'no host continuation repeats the check');
  assert.equal(spent.progress.nextAction.command, fresh);
  assert.equal(agentAct(spent).state, 'blocked');
  const again = check();
  assert.equal(again.continuation.nextAction.command, fresh, 'an unchanged check again is still routed on, never to itself');
  assert.equal(again.progress.stagedSha256, await digest(), 'the result names the bytes it read');

  // The offered check of a packet whose only problems are lines SFlow knows: corrected and retainable, spent or not.
  const wrong = structuredClone(report);
  wrong.rows[0].line = wrong.rows[0].line === 1 ? 2 : 1;
  await writeFile(packet.stagingPath, JSON.stringify(wrong));
  const corrected = check();
  assert.deepEqual(corrected.corrected, [{ field: 'rows[0].line', from: wrong.rows[0].line, to: report.rows[0].line }]);
  assert.equal(corrected.retentionReady, true, JSON.stringify(corrected.findings));
  assert.equal(corrected.incomplete, undefined);
  assert.equal(agentAct(corrected).state, 'retain');
  assert.equal(corrected.progress.stagedSha256, await digest(), 'the bytes SFlow left at stagingPath');

  // Spent again, then the reviewer corrects the file itself: the check evaluates those bytes, and they are retained.
  assert.ok((await spend()).incomplete);
  await writeFile(packet.stagingPath, `${JSON.stringify(report, null, 2)}\n`);
  const current = check();
  assert.equal(current.progress.stagedSha256, await digest());
  assert.equal(current.retentionReady, true, JSON.stringify(current.findings));
  assert.equal(current.corrected, undefined);
  assert.equal(current.continuation.nextAction.command, packet.stagingProtocol.retain.command);
  const retained = run(root, ['review-source', 'submit', phaseId, '--report-file', packet.stagingPath, '--for-agent', '--json']);
  assert.ok(retained.reportSha256);
});

// The owner's second chat (2026-11-20): its task record already held 2/2 continuations an earlier chat spent; the agent
// read that as "the changed-packet repair limit is exhausted" and ran no check. A new request shows a fresh budget.
test('a Story whose earlier chat spent every task-wide continuation: a new request is shown a fresh budget and the check and retain route (owner, 2026-11-20)', async (t) => {
  const { root, phaseId } = await publishedSpecificationStory(t);
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(root, '.git', 'review-host', 'mode.json');
  t.after(() => { if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE; else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous; });
  const first = run(root, ['review-source', 'context', phaseId, '--for-agent', '--json']);
  const { loadAcceptedStoryExecution } = await import('../src/accepted-story-execution.mjs');
  const { workflowTaskIdentity } = await import('../src/workflow-task.mjs');
  const { readWorkflowTask, reserveWorkflowTaskContinuation } = await import('../src/workflow-task-store.mjs');
  const { workflow } = await loadAcceptedStoryExecution(root);
  const phase = workflow.phases[phaseId];
  const expected = workflowTaskIdentity(workflow, phase, 'source-reviewer');
  assert.equal(first.taskResume.operationId, expected.id);
  // The earlier chat: every task-wide continuation spent, as the old stop hook claimed them.
  while ((await reserveWorkflowTaskContinuation(root, expected.id, expected)).allowed);
  const spent = await readWorkflowTask(root, workflow, phase, { role: 'source-reviewer' });
  assert.equal(spent.continuations, spent.maximumContinuations);
  assert.equal(spent.maximumContinuations, 2);

  // The new request: its draft has a line SFlow knows, and its budget is whole.
  const report = { ...reviewReport(first), binding: 'from-context' };
  const wrong = structuredClone(report);
  wrong.rows[0].line = wrong.rows[0].line === 1 ? 2 : 1;
  await writeFile(first.stagingPath, JSON.stringify(wrong));
  const packet = run(root, ['review-source', 'context', phaseId, '--for-agent', '--json']);
  assert.deepEqual(packet.taskResume.continuationBudget, { consumed: 0, maximum: 2 });
  assert.deepEqual(packet.progress.continuationBudget, { consumed: 0, maximum: 2 });
  assert.equal(packet.progress.state, 'repair-report');
  assert.equal(packet.progress.nextAction.command, packet.stagingProtocol.check.command, 'the check is offered');
  assert.match(packet.progress.instruction, /^Run stagingProtocol\.check now and change nothing in the file/u);
  const checked = run(root, ['review-source', 'check', phaseId, '--report-file', packet.stagingPath, '--for-agent', '--json']);
  assert.equal(checked.retentionReady, true, JSON.stringify(checked.findings));
  assert.equal(checked.continuation.nextAction.command, packet.stagingProtocol.retain.command, 'then retention');
  assert.ok(run(root, ['review-source', 'submit', phaseId, '--report-file', packet.stagingPath, '--for-agent', '--json']).reportSha256);
});
