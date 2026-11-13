/**
 * The review is written to its staging file and never silently dropped [owner, 2026-11-13].
 *
 * On a real Story the reviewer typed its report into `review-source stage --report-json '…'` six times: twice the
 * shell-quoted JSON broke ("Unterminated string"), and four times the quotes inside `toBe('10')` were eaten, so every
 * repair cited text no line held. The review was never retained, `review-source status` then said no review existed,
 * and the author's turn previewed `phase rollover --reason` with words of its own. Now: the file is the one write route
 * and an inline refusal names it; a repair packet gives the exact line text, and a quote whose marks a shell ate gets
 * the line's own text back; spent repairs leave the draft staged and the review recorded as incomplete with the way to
 * finish it; and neither a review turn nor the turn that started the reviewer opens a generation with its own reason.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { recordRepositoryBoundaryTurn } from '../src/copilot-repository-boundary.mjs';
import { captureMutationTurn, mutationToolGuard } from '../src/copilot-mutation-guard.mjs';
import { agentAct, completeAgentResult } from '../src/agent-output.mjs';
import { sourceReviewRepairGuide } from '../src/source-review-contract.mjs';
import { publishedSpecificationStory, reviewReport } from './helpers/source-review-fixture.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const executable = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'bin/singularity-flow.mjs');
const NOTES = 'Export is out of scope.\n\nThe save button reads \'Save\' once the draft is kept.';
const QUOTED = 'The save button reads \'Save\' once the draft is kept.';

function run(root, args) {
  const result = spawnSync(process.execPath, [executable, ...args], { cwd: root, encoding: 'utf8', timeout: childTimeout(60_000),
    env: { ...process.env, SINGULARITY_FLOW_AGENT_OUTPUT: 'full', SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.git/test-workspace-registry.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.git/test-active-workspace.json') } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, value: result.stdout.trim() ? completeAgentResult(result.stdout) : null };
}
const ok = (root, args) => {
  const result = run(root, args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result.value;
};

/** A published specification awaiting review, with the Copilot guard's records kept beside it. */
async function reviewStory(t, options = {}) {
  const story = await publishedSpecificationStory(t, options);
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(story.root, '.git', 'review-host', 'mode.json');
  t.after(() => { if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE; else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous; });
  const turn = async (sessionId, prompt) => {
    const hook = { cwd: await realpath(story.root), sessionId, prompt };
    await recordRepositoryBoundaryTurn(hook, { captureMutation: (payload, record) => captureMutationTurn(payload, record, { resolveRoot: async () => hook.cwd }) });
    return {
      hook,
      shell: (command) => mutationToolGuard({ ...hook, toolName: 'bash', toolArgs: { command, cwd: hook.cwd } }),
      tool: (toolName, toolArgs) => mutationToolGuard({ ...hook, toolName, toolArgs })
    };
  };
  const packet = ok(story.root, ['review-source', 'context', story.phaseId, '--for-agent', '--json']);
  const check = () => ok(story.root, ['review-source', 'check', story.phaseId, '--report-file', packet.stagingPath, '--for-agent', '--json']);
  const write = (report) => writeFile(packet.stagingPath, `${JSON.stringify(report, null, 2)}\n`);
  return { ...story, turn, packet, check, write };
}

test('the report goes to its staging file: the protocol offers no inline JSON, and an inline refusal names the file route', async (t) => {
  const { root, phaseId, turn, packet, check, write } = await reviewStory(t);
  const review = await turn('review-file-route', `/sf-review-source ${phaseId}`);
  const protocol = packet.stagingProtocol;
  assert.equal(protocol.writeTool, 'file-edit');
  assert.equal(protocol.inlineJsonAllowed, false);
  assert.equal(protocol.kernelStage, undefined, 'no inline route is offered');
  assert.equal(protocol.path, packet.stagingPath);
  assert.match(protocol.write, /with your file-edit tool at exactly stagingPath.*never type the JSON into a shell argument/u);
  assert.match(packet.reviewGuide.role, /write it with your file-edit tool at stagingProtocol\.path and run stagingProtocol\.check/u);
  assert.match(packet.progress.instruction, /Write it with your file-edit tool at exactly stagingPath/u);

  // Shell-quoted JSON cut short by an apostrophe, as on the real Story: refused with the file route, nothing staged.
  const cut = run(root, ['review-source', 'stage', phaseId, '--report-json', '{"schemaVersion":1,"rows":[{"note":"the author', '--json']);
  assert.notEqual(cut.status, 0);
  assert.equal(cut.value.error.code, 'SOURCE_REVIEW_REPORT_INVALID');
  assert.match(cut.value.error.message, /^The review JSON is invalid \(.+\); nothing was staged\. JSON typed into a shell argument breaks on its quotes: /u);
  assert.ok(cut.value.error.message.endsWith(`write the whole report with your file-edit tool at ${packet.stagingPath}, then run ${protocol.check.command}.`), cut.value.error.message);
  assert.equal(cut.value.error.details.nextAction, protocol.check.command);
  assert.equal(cut.value.error.details.stagingPath, packet.stagingPath);
  await assert.rejects(lstat(packet.stagingPath), 'nothing was staged');

  // The reviewer's file-edit tool may write that one file in its review turn, and no other.
  assert.deepEqual(await review.tool('create', { path: packet.stagingPath, file_text: '{}' }), {});
  assert.equal((await review.tool('create', { path: path.join(root, 'notes.json'), file_text: '{}' })).permissionDecision, 'deny');
  await write(reviewReport(packet));
  const checked = check();
  assert.equal(checked.retentionReady, true, JSON.stringify(checked.findings));
  const retained = ok(root, ['review-source', 'submit', phaseId, '--report-file', packet.stagingPath, '--for-agent', '--json']);
  assert.ok(retained.reportSha256);
});

test('a quote whose quote marks a shell ate gets its line back, and the repaired file is retained within the budget', async (t) => {
  const { root, phaseId, packet, check, write } = await reviewStory(t, { notes: NOTES });
  const story = packet.sources.find((entry) => entry.id === 'story');
  const line = story.text.split(/\r?\n/u).findIndex((entry) => entry === QUOTED) + 1;
  assert.ok(line > 0, story.text);
  const report = reviewReport(packet);
  // What `--report-json '…'` delivers of 'Save': Save.
  report.rows.push({ id: 'save-label', sourceId: 'story', line, quote: QUOTED.replaceAll('\'', ''), outcome: 'question', question: 'Is the label part of the scope?' });
  await write(report);
  const refused = check();
  assert.equal(refused.retentionReady, false);
  const citation = refused.repair.citations.find((entry) => entry.field === 'rows[3]');
  assert.equal(citation.quoteMarksLost, true);
  assert.equal(citation.recoveredQuote, QUOTED);
  assert.equal(citation.lineText, QUOTED);
  assert.equal(citation.suppliedLineText, QUOTED, 'the cited line as it reads');
  assert.deepEqual(citation.matchingLines, [line]);
  assert.match(citation.instruction, /arrived without the quote marks its line holds \('\): a shell argument removes them\. Copy recoveredQuote/u);
  assert.equal(agentAct(refused).state, 'correct');

  // The older inline route's refusal carries the same line text through its projection.
  const inline = run(root, ['review-source', 'stage', phaseId, '--report-json', JSON.stringify(report), '--json']);
  assert.notEqual(inline.status, 0);
  const projected = inline.value.error.details.repair.citations.find((entry) => entry.field === 'rows[3]');
  assert.equal(projected.recoveredQuote, QUOTED);
  assert.equal(projected.suppliedLineText, QUOTED);
  assert.equal(projected.quoteMarksLost, true);
  assert.match(inline.value.error.message, /repair the listed fields in that file with your file-edit tool, then run singularity-flow review-source check /u);

  // One repair in the file, with the issued text: retained.
  report.rows[3].quote = citation.recoveredQuote;
  await write(report);
  const repaired = check();
  assert.equal(repaired.retentionReady, true, JSON.stringify(repaired.findings));
  const retained = ok(root, ['review-source', 'submit', phaseId, '--report-file', packet.stagingPath, '--for-agent', '--json']);
  assert.ok(retained.reportSha256);
});

test('spent repairs leave the draft staged and the review recorded as incomplete with its route; a fresh review turn gets a new budget', async (t) => {
  const { root, phaseId, packet, check, write } = await reviewStory(t);
  const report = reviewReport(packet);
  const wrong = (line) => write({ ...report, rows: report.rows.map((row, index) => (index ? row : { ...row, line })) });
  for (const line of [900, 901]) {
    await wrong(line);
    const result = check();
    assert.equal(result.retentionReady, false);
    assert.equal(result.incomplete, undefined, 'repairs left in this turn');
  }
  await wrong(902);
  const spent = check();
  assert.equal(spent.incomplete.recorded, true);
  assert.equal(spent.incomplete.stagingPath, packet.stagingPath);
  assert.match(spent.incomplete.instruction, /^This review turn's 2 repairs are spent and the report still cannot be retained \(1 field still to repair: rows\[0\]: .*\)\. The draft stays staged at .* and review-source status records the review as incomplete\. End this review turn with that status and the remaining fields; a fresh review turn \(\/sf-review-source specification, or the reviewer started again\) resumes the draft with a new repair budget/u);
  assert.equal(agentAct(spent).state, 'blocked');
  await lstat(packet.stagingPath);

  // The author's turn reads the review as incomplete, with the way to finish it: never "no review exists".
  const status = ok(root, ['review-source', 'status', phaseId, '--json']);
  assert.equal(status.status, 'incomplete');
  assert.equal(status.findings[0].code, 'review-incomplete');
  assert.match(status.findings[0].message, /^A review of generation 1 is staged but not retained: 1 field still to repair/u);
  assert.ok(!status.findings.some((entry) => entry.code === 'review-missing'));
  assert.equal(status.incomplete.budgetSpent, true);
  assert.equal(status.continuation.classification, 'source-review-incomplete');
  assert.match(status.continuation.actions[0].reason, /^Finish the staged review in a fresh review turn: it resumes the draft at .* with a new repair budget, then retains it\. What the step must correct is the review's to record/u);
  const act = agentAct(status);
  assert.equal(act.state, 'review');
  assert.equal(act.said, 'No review of specification generation 1 is retained; its staged draft is incomplete. A correction the step needs is the review\'s blocking finding: '
    + 'never open a generation with your own reason (phase rollover --reason). Start the step\'s reviewer as a sub-agent, prompt /sf-review-source specification '
    + '(a fresh turn, new repair budget); with no sub-agent tool, relay the route in a new chat.');
  assert.ok(!act.said.endsWith('…'), act.said);

  // A fresh review turn: the reason stays, the budget starts again.
  ok(root, ['review-source', 'context', phaseId, '--for-agent', '--json']);
  await wrong(903);
  assert.equal(check().incomplete, undefined, 'a new review turn has its repairs again');
  assert.equal(ok(root, ['review-source', 'status', phaseId, '--json']).status, 'incomplete');
  await write(report);
  assert.equal(check().retentionReady, true);
  await assert.rejects(lstat(packet.stagingPath.replace(/\.json$/u, '.incomplete.json')), 'a packet that can be retained clears the record');
  ok(root, ['review-source', 'submit', phaseId, '--report-file', packet.stagingPath, '--for-agent', '--json']);
  const done = ok(root, ['review-source', 'status', phaseId, '--json']);
  assert.ok(done.reportSha256);
  assert.notEqual(done.status, 'incomplete');
});

test('a review turn never opens a generation, and the turn that started the reviewer opens one only from the review', async (t) => {
  const { phaseId, turn } = await reviewStory(t);
  const review = await turn('review-rollover', `/sf-review-source ${phaseId}`);
  for (const command of [`singularity-flow phase rollover ${phaseId} --reason "Correct the summary" --json`, `singularity-flow phase rollover ${phaseId} --json`]) {
    const denied = await review.shell(command);
    assert.equal(denied.permissionDecision, 'deny', command);
    assert.match(denied.permissionDecisionReason, /a review turn never opens a generation\. Record what the step must correct as a blocking finding/u);
  }

  const author = await turn('author-rollover', `/sf-phase ${phaseId}`);
  const reasoned = `singularity-flow phase rollover ${phaseId} --reason "Correct the summary to document the pin" --json`;
  assert.deepEqual(await author.shell(reasoned), {}, 'before any reviewer, the author\'s turn is as it was');
  assert.deepEqual(await author.tool('task', { agent_type: 'singularity-flow:sflow-source-reviewer', prompt: `/sf-review-source ${phaseId}`, mode: 'sync' }), {});
  const denied = await author.shell(reasoned);
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, new RegExp(`this turn started the step's independent reviewer.*review-source status ${phaseId} --for-agent --json.*\`phase rollover ${phaseId} --json\` \\(no --reason\\)`, 'u'));
  assert.deepEqual(await author.shell(`singularity-flow phase rollover ${phaseId} --json`), {}, 'the review\'s own route stays open');
});

test('the repair packet recovers the line a shell-quoted quote came from, on the real Story\'s line', () => {
  const lines = ['  it(\'displays the binary result for 2\', async () => {', '    expect(getResultText(container)).toBe(\'10\');', '  });'];
  const input = { sources: [{ id: 'code:src:App.test.jsx', text: lines.join('\n') }] };
  const report = { rows: [{ clauseId: 'X:AC-001', implementation: [], tests: [{ sourceId: 'code:src:App.test.jsx', line: 139, quote: 'expect(getResultText(container)).toBe(10);' }] }] };
  const checked = { retentionReady: false, findings: [{ code: 'citation-quote-invalid', field: 'rows[0].tests[0]', sourceId: 'code:src:App.test.jsx' }],
    evaluation: { status: 'correction-required', findings: [], binding: { sources: [{ id: 'code:src:App.test.jsx', textSha256: 'x' }] } } };
  const [citation] = sourceReviewRepairGuide(report, input, checked).citations;
  assert.equal(citation.recoveredQuote, 'expect(getResultText(container)).toBe(\'10\');');
  assert.equal(citation.lineText, lines[1]);
  assert.deepEqual(citation.matchingLines, [2]);
  assert.match(citation.instruction, /and set its line to 2/u);
  // A quote that matches no line even with quote marks taken out is not guessed at.
  report.rows[0].tests[0].quote = 'expect(getResultText(container)).toBe(11);';
  const [none] = sourceReviewRepairGuide(report, input, checked).citations;
  assert.equal(none.quoteMarksLost, undefined);
  assert.equal(none.recoveredQuote, undefined);
  assert.match(none.instruction, /^No exact single-line match/u);
});
