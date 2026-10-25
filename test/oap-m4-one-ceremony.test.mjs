/**
 * One approval ceremony [docs/SPEC-OAP-ONE-APPROVAL-PATH-v1.md, M4].
 *
 * Review, decide, confirm once. The approval receipt binds what was reviewed, not a clock or HEAD,
 * so a 40-minute review still approves, and a review-safe commit made meanwhile does not spend it.
 * The approver's own decisions are written into the approval's transaction, so they and the approval
 * are one commit and one push. A choice that is not an approval (a return) or a stale list is
 * refused before anything is written. A chat turn may carry only the upstream-issue options it may
 * record, and /sf-decide continues into the approval with the same receipt-bound commands.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { specification, submittedPlanningStory } from './helpers/submitted-planning-story.mjs';

const WORK = 'HEX-4001';
// The real CLI, with the decision list reading planning as the Story's last step (see the helper).
const ENDING_STEP_CLI = fileURLToPath(new URL('./helpers/ending-step-cli.mjs', import.meta.url));
const endingStep = (run, ...args) => run(process.execPath, ['--experimental-test-module-mocks', '--no-warnings', ENDING_STEP_CLI, '--no-model', ...args],
  { allowFailure: true });
/** The JSON a command printed last: approve prints the human review before its result. */
const lastJson = (text) => {
  const starts = [...String(text).matchAll(/^\{$/gmu)];
  return JSON.parse(starts.length ? String(text).slice(starts.at(-1).index) : text);
};
const payload = (result) => {
  const parsed = lastJson(result.stdout);
  return parsed.data ?? parsed;
};
/** A refusal's code, message and details, from the JSON a refused command prints. */
const refusalOf = (result) => lastJson(result.stdout).error;
const commitsSince = (git, from) => Number(git('rev-list', '--count', `${from}..HEAD`));
const workflowOf = async (item) => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));

test('a 40-minute review still approves, after a review-safe commit, with the receipt it began', async (t) => {
  const { cli, git, item, candidate } = await submittedPlanningStory(t, WORK);
  const begun = JSON.parse(cli('choices', 'begin', 'approve', WORK, '--json').stdout);
  assert.equal(begun.expiresAt, null, 'no clock');
  assert.equal(begun.binding, 'review-digest');
  // The person reads for forty minutes.
  const receiptFile = path.join(git('rev-parse', '--absolute-git-dir'), 'singularity-flow', 'choices', `${begun.token}.json`);
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
  await writeFile(receiptFile, `${JSON.stringify({ ...receipt, createdAt: new Date(Date.now() - 40 * 60_000).toISOString() }, null, 2)}\n`);
  // Meanwhile an intent amendment is proposed and rejected: a review-safe pair that moves HEAD (M2).
  await writeFile(candidate, specification(WORK, 2));
  cli('story', 'intent-amendment', 'propose', '--file', candidate, '--reason', 'Review showed that value 2 is required.');
  cli('story', 'intent-amendment', 'decide', 'AMD-001', '--decision', 'reject', '--confirm', 'AMD-001', '--reason', 'Value 1 stays as approved.');
  cli('choices', 'answer', begun.token, 'phase-confirmation', 'planning', '--json');
  cli('approve', 'planning', '--work-id', WORK, '--selection-receipt', begun.token, '--json');
  assert.equal((await workflowOf(item)).phases.planning.status, 'approved');
});

const succeeded = (result) => {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return payload(result);
};

test('the approver\'s decision and the approval are one commit, named in the approval\'s event', async (t) => {
  const { cli, git, item, run } = await submittedPlanningStory(t, WORK);
  cli('upstream-issue', 'raise', '--phase', 'specification', '--about', `${WORK}:AC-001`,
    '--problem', 'The specification never says what a reader sees when the value is missing.');
  const listed = succeeded(endingStep(run, 'decisions', WORK, '--json'));
  const issue = listed.items.find((entry) => entry.kind === 'upstream-issue');
  assert.ok(issue?.holdsApproval, 'the issue holds the approval');
  assert.deepEqual(listed.inApproval, { items: [issue.id], options: { [issue.id]: ['accept-risk', 'dismiss'] },
    command: `singularity-flow approve planning --work-id ${WORK}` }, 'a return is not offered in the approval');
  const preview = succeeded(endingStep(run, 'decisions', WORK, '--choose', `${issue.id}=dismiss`, '--json')).preview;
  assert.equal(preview.withApproval.recordInChat, true);
  assert.equal(preview.withApproval.flags, `--choose ${issue.id}=dismiss --decisions ${listed.packetSha256}`);

  const before = git('rev-parse', 'HEAD');
  const approved = succeeded(endingStep(run, 'approve', 'planning', '--work-id', WORK, '--yes', '--choose', `${issue.id}=dismiss`,
    '--decisions', listed.packetSha256, '--json'));
  assert.equal(commitsSince(git, before), 1, 'one commit holds the decision and the approval');
  assert.match(git('log', '-1', '--format=%s'), /\[approve\] .+ with 1 decision record$/u);
  assert.deepEqual(approved.decisions, [{ item: issue.id, kind: 'upstream-issue-decision', record: 'UPI-001 dismiss' }]);
  const workflow = await workflowOf(item);
  assert.equal(workflow.phases.planning.status, 'approved');
  assert.equal(workflow.upstreamIssueDecisions.at(-1).outcome, 'dismiss');
  const event = workflow.publicationProjections.at(-1).event;
  assert.equal(event.type, 'phase-approved');
  assert.deepEqual(event.payload.decisions, approved.decisions);
});

test('a return, a stale list or a missing digest is refused before anything is written', async (t) => {
  const { cli, git, run } = await submittedPlanningStory(t, WORK);
  cli('upstream-issue', 'raise', '--phase', 'specification', '--about', `${WORK}:AC-001`,
    '--problem', 'The specification never says what a reader sees when the value is missing.');
  const listed = succeeded(endingStep(run, 'decisions', WORK, '--json'));
  const issue = listed.items.find((entry) => entry.kind === 'upstream-issue');
  const before = git('rev-parse', 'HEAD');
  const approve = (...extra) => {
    const result = endingStep(run, 'approve', 'planning', '--work-id', WORK, '--yes', '--json', ...extra);
    assert.notEqual(result.status, 0, result.stdout);
    return refusalOf(result);
  };
  const missing = approve('--choose', `${issue.id}=dismiss`);
  assert.equal(missing.code, 'APPROVAL_DECISIONS_CONFIRMATION_REQUIRED');
  assert.equal(missing.details.nextAction, `singularity-flow decisions ${WORK} --phase planning`, 'the refusal routes to the list');
  const stale = approve('--choose', `${issue.id}=dismiss`, '--decisions', `sha256:${'a'.repeat(64)}`);
  assert.equal(stale.code, 'DECISIONS_PACKET_CHANGED');
  if (issue.options.some((option) => option.id === 'return')) {
    const returned = approve('--choose', `${issue.id}=return`, '--decisions', listed.packetSha256);
    assert.equal(returned.code, 'APPROVAL_DECISION_NOT_IN_APPROVAL');
    assert.match(returned.message, /returns the work instead of approving it/u);
  }
  assert.equal(git('rev-parse', 'HEAD'), before, 'nothing was written');
});

test('a review this terminal showed confirms `approve <PHASE>` for that review, identity and shell only', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const { forgetTerminalReview, recordTerminalReview, terminalReviewBinding, terminalReviewShown } = await import('../src/terminal-review.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-terminal-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const terminal = (value) => {
    for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, 'isTTY', { value, configurable: true });
  };
  const [stdinTTY, stdoutTTY] = [process.stdin.isTTY, process.stdout.isTTY];
  t.after(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: stdinTTY, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTTY, configurable: true });
  });
  const workflow = { workItem: { id: WORK }, lineage: { submissions: [{ phase: 'planning', generation: 2, packetSha256: `sha256:${'a'.repeat(64)}` }] } };
  const binding = terminalReviewBinding(workflow, { id: 'planning', status: 'awaiting_approval', generation: 2 });
  assert.equal(terminalReviewBinding(workflow, { id: 'planning', status: 'in_progress', generation: 2 }), null, 'only a step awaiting approval');
  const reviewer = { name: 'Reviewer', email: 'reviewer@example.test' };

  terminal(false);
  await recordTerminalReview(root, binding, reviewer);
  terminal(true);
  assert.equal(await terminalReviewShown(root, binding, reviewer), false, 'a command without a terminal records nothing');
  await recordTerminalReview(root, binding, reviewer);
  assert.equal(await terminalReviewShown(root, binding, reviewer), true);
  assert.equal(await terminalReviewShown(root, binding, { name: 'Other', email: 'other@example.test' }), false, 'another identity');
  assert.equal(await terminalReviewShown(root, { ...binding, generation: 3 }, reviewer), false, 'another review');
  assert.equal(await terminalReviewShown(root, { ...binding, reviewPacketSha256: `sha256:${'b'.repeat(64)}` }, reviewer), false);
  terminal(false);
  assert.equal(await terminalReviewShown(root, binding, reviewer), false, 'never read without a terminal');
  terminal(true);
  await forgetTerminalReview(root, binding, reviewer);
  assert.equal(await terminalReviewShown(root, binding, reviewer), false, 'an approval forgets it');
});

/** The VS Code approval page, loaded with a stub `vscode`: its validation and arguments are pure. */
async function approvalPage() {
  const [{ default: vm }, { default: ts }, messages, webview, approvalsModel] = await Promise.all([import('node:vm'), import('typescript'),
    import('../apps/vscode/src/views/messages.ts'), import('../apps/vscode/src/views/webview.ts'), import('../apps/vscode/src/views/approvals-model.ts')]);
  const source = await readFile(new URL('../apps/vscode/src/views/approval-review.ts', import.meta.url), 'utf8');
  const exports = {};
  const context = vm.createContext({ exports, Date, require(name) {
    if (name === 'vscode') return {};
    if (name === './messages.ts') return messages;
    if (name === './webview.ts') return webview;
    if (name === './navigate.ts') return { navigateTo() {} };
    if (name === './approvals-model.ts') return approvalsModel;
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  return exports;
}

test('VS Code answers the approver\'s decisions in the approval form, and the CLI reads exactly those arguments', async () => {
  const [page, { inApprovalOf }, { parseArgs }] = await Promise.all([approvalPage(), import('../apps/vscode/src/decisions.ts'), import('../src/util.mjs')]);
  const digest = `sha256:${'c'.repeat(64)}`;
  const listed = { packetSha256: digest, holding: 1, inApproval: { items: ['d1'], options: { d1: ['accept-risk', 'dismiss'] } },
    items: [{ id: 'd1', kind: 'upstream-issue', title: 'AC-001: a problem reported in Specification', why: 'Planning reported a problem.',
      options: [
        { id: 'accept-risk', label: 'Accept it as a risk until a date', needs: { expires: { default: '2026-11-25', latest: '2027-01-24' }, reason: { default: 'Accepted until the date.' } } },
        { id: 'dismiss', label: 'Dismiss it', needs: { reason: { default: 'Not a defect.' } } },
        { id: 'return', label: 'Return the work to Specification', needs: { reason: { default: 'Returned.' } } }] }] };
  const inApproval = inApprovalOf(listed);
  assert.deepEqual(inApproval.items[0].options.map((option) => option.id), ['accept-risk', 'dismiss'], 'a return is never offered in an approval');
  const request = { title: 'Approve Planning', expected: 'planning', workId: WORK, phaseId: 'planning', phaseLabel: 'Planning', generation: 1,
    artifact: null, articles: [], findings: [], witnessedClauses: null, priorExceptions: [], selfApproval: false,
    pendingDecisions: { count: 1, headline: 'Planning has 1 decision holding its approval.' }, inApproval };
  const body = page.approvalReviewBody(request);
  assert.match(body, /Decide in this approval/u);
  assert.match(body, /data-item="d1"/u);
  assert.doesNotMatch(body, /Decide what blocks this step first/u, 'nothing is left for the decision list');

  const checked = page.validateApprovalReviewSubmission(request, { confirmation: 'planning', decisions: [], witnessDecisions: [],
    inApprovalDecisions: [{ item: 'd1', option: 'accept-risk', expires: '', reason: 'Covered by the release checklist.' }] });
  assert.deepEqual([...checked.errors], []);
  assert.deepEqual({ ...checked.value.inApprovalDecisions[0] }, { item: 'd1', option: 'accept-risk', expires: '2026-11-25', reason: 'Covered by the release checklist.' },
    'a blank value takes its default');
  for (const wrong of [{ item: 'd9', option: 'dismiss' }, { item: 'd1', option: 'return' }]) {
    assert.equal(page.validateApprovalReviewSubmission(request, { confirmation: 'planning', decisions: [], witnessDecisions: [], inApprovalDecisions: [wrong] }).value, null);
  }
  const argv = page.storyApprovalArguments({ workId: WORK, phaseId: 'planning', receiptToken: '11111111-1111-4111-8111-111111111111',
    checklist: [], witnessDecisions: [], inApprovalDecisions: checked.value.inApprovalDecisions, decisionsDigest: inApproval.digest });
  const { options } = parseArgs([...argv]);
  assert.deepEqual([options.choose].flat(), ['d1=accept-risk']);
  assert.deepEqual([options.expires].flat(), ['d1=2026-11-25']);
  assert.deepEqual([options.reason].flat(), ['d1=Covered by the release checklist.']);
  assert.equal(options.decisions, digest);
  // Two faults the real VS Code walk found: the page script took a decision for a checklist article
  // (so the form never became ready), and a field the option does not need stayed visible.
  const source = await readFile(new URL('../apps/vscode/src/views/approval-review.ts', import.meta.url), 'utf8');
  assert.match(source, /querySelectorAll\('\.approval-article\[data-article\]'\)/u, 'checklist rows are only the articles');
  assert.doesNotMatch(body.match(/<fieldset class="[^"]*approval-decision[^>]*>/u)[0], /data-article/u);
  assert.match(source, /\.approval-decision \[data-need\]\[hidden\] \{ display:none; \}/u, 'an unneeded field is hidden');
  // Without a held decision the page still sends the person to the list first.
  const held = page.approvalReviewBody({ ...request, pendingDecisions: { count: 2, headline: 'Planning has 2 decisions holding its approval.' } });
  assert.match(held, /Decide what blocks this step first/u);
});
