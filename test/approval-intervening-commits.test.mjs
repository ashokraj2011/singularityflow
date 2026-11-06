/**
 * Approval names the commits that stop it, and routes an undecided intent amendment first.
 *
 * Real case (2026-10-24): planning was submitted, an intent amendment changing two approved clauses
 * was proposed six hours later, and approving planning refused with "repository history changed
 * after its immutable review evidence was recorded". It named neither the commit nor the amendment,
 * and its first route was a recover command that finds nothing to recover. The person could not tell
 * that the amendment had to be decided before planning could be revised or resubmitted. The same
 * commits are now named beforehand, as an advisory, in the approval packet's readiness, in phase
 * show and on the VS Code approval page; none of them stops the review. Since SPEC-OAP M2 the
 * proposal itself makes nothing stale: it holds the approval until a person decides it, and a
 * rejection leaves planning approvable as submitted.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { refusalDetails, refusalEnvelope, refusalRemediationPlan, renderRefusalPlan } from '../src/refusal-remediation.mjs';
import { approvalCheckLines, blockingCommitLines } from '../src/owed-decisions.mjs';
import { actionCommandLines, copilotAction, copilotCommandForCommand } from '../src/copilot-guidance.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { CLI, specification, submittedPlanningStory } from './helpers/submitted-planning-story.mjs';

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = 'HEX-2018';
const APPROVE = ['approve', 'planning', '--work-id', WORK];
const STATUS = `singularity-flow story intent-amendment status --work-id ${WORK} --json`;
const DECIDE = `singularity-flow story intent-amendment decide AMD-001 --decision <approve|reject> --confirm AMD-001 --work-id ${WORK}`;
const EXISTING_ROUTES = ['inspect-current-phase', 'leave-approval-turn', 'inspect-current-phase-evidence'];
const NO_ROUTE = 'no verified equivalent';

function refusal(details, code = 'STORY_REVIEW_INTERVENING_COMMIT') {
  return new SingularityFlowError('history changed', { code,
    details: { workId: WORK, phase: 'planning', generation: 1, ...details } });
}

const pendingDetails = {
  scopePhase: 'specification', blockingCommitCount: 1,
  blockingCommits: [{ commit: '1b3bf2703ebb', subject: `[${WORK}][intent-amendment:propose] AMD-001`, kind: 'intent-amendment-proposal',
    amendment: { id: 'AMD-001', action: 'propose', status: 'proposed', changedClauses: [`${WORK}:AC-001`, `${WORK}:REQ-002`] } }],
  pendingIntentAmendments: [{ id: 'AMD-001', commit: '1b3bf2703ebb', changedClauses: [`${WORK}:AC-001`, `${WORK}:REQ-002`] }],
  nextAction: { command: STATUS, label: 'See intent amendment AMD-001.' }
};

test('an undecided amendment after the submission is seen and decided before any phase repair', () => {
  // SPEC-OAP M2: the proposal holds the approval (APPROVAL_INTENT_AMENDMENT_PENDING) and makes nothing stale.
  const { blockingCommits, blockingCommitCount, ...held } = pendingDetails;
  const plan = refusalRemediationPlan(refusal(held, 'APPROVAL_INTENT_AMENDMENT_PENDING'), APPROVE);
  assert.deepEqual(plan.steps.map((step) => step.id), ['inspect-intent-amendment', 'decide-intent-amendment', 'leave-approval-turn']);
  assert.equal(plan.steps[0].command, STATUS);
  assert.match(plan.steps[0].label, /AMD-001, proposed in 1b3bf2703ebb after planning was submitted; it changes HEX-2018:AC-001, HEX-2018:REQ-002/u);
  assert.equal(plan.steps[1].command, DECIDE);
  // A person decides; the outcome of each decision is stated, and neither one makes this approval pass.
  assert.match(plan.steps[1].label, /A person who approves specification decides AMD-001 in their own terminal; an agent cannot/u);
  assert.match(plan.steps[1].label, /Approving it changes those clauses, so planning reopens to be revised and submitted again/u);
  // Rejecting keeps the submission valid [SPEC-OAP decision 1]: planning is approved as submitted.
  assert.match(plan.steps[1].label, /Rejecting it keeps the approved clauses, and planning can then be approved as submitted, with no fresh submission/u);
  assert.match(plan.retry.label, /this submission as it is once the amendment is rejected/u);
  // Only commits that record more than the amendment still need a fresh submission after a rejection.
  assert.match(refusalRemediationPlan(refusal(pendingDetails), APPROVE).steps[1].label,
    /Rejecting it keeps the approved clauses, but these commits record more than its proposal and rejection, so planning still needs a fresh submission/u);
  assert.equal(plan.context.strategy, 'person-decides-intent-amendment');
  assert.equal(plan.context.turn, 'new-turn');
  assert.equal(plan.retry.command, null);
  assert.ok(!plan.steps.some((step) => step.argv?.[0] === 'approve'), 'no route retries approval');
  const rendered = renderRefusalPlan(plan);
  assert.match(rendered, /an intent amendment proposed after its submission waits for a person's decision/u);
  assert.ok(rendered.indexOf(STATUS) < rendered.indexOf('End this approval-only turn'), rendered);
});

/**
 * Seen live (2026-10-24, hex-2018): both commands of this plan printed `Copilot: /sf-reject`. The
 * crosswalk sent the whole `story intent-amendment` family to /sf-reject, which returns the phase:
 * a different decision, and one its approval-only turn may not record for the amendment. Each step
 * now carries its own routes, and neither the read nor the person's decision has a Copilot one.
 */
test('each step of the pending-amendment plan carries its own routes, and none of them is /sf-reject', async () => {
  const plan = refusalRemediationPlan(refusal(pendingDetails), APPROVE);
  const routes = plan.steps.map(({ id, command, skill, copilotCommand, copilotReason = null }) => ({ id, command, skill, copilotCommand, copilotReason }));
  assert.deepEqual(routes, [
    { id: 'inspect-intent-amendment', command: STATUS, skill: null, copilotCommand: null, copilotReason: null },
    { id: 'decide-intent-amendment', command: DECIDE, skill: null, copilotCommand: null, copilotReason: 'no verified equivalent: decide it in your terminal' },
    { id: 'leave-approval-turn', command: null, skill: null, copilotCommand: null, copilotReason: null }
  ]);
  const rendered = renderRefusalPlan(plan).split('\n');
  // Each route is its own bullet, Copilot first (8f25dc4b standardized the three surfaces).
  const routesOf = (command) => rendered.slice(rendered.indexOf(`     - Shell: ${command}`) - 1, rendered.indexOf(`     - Shell: ${command}`) + 2);
  for (const command of [STATUS, DECIDE]) {
    assert.deepEqual(routesOf(command), [`     - Copilot: ${NO_ROUTE}`, `     - Shell: ${command}`, '     - VS Code (model-free): not available for this action']);
  }
  assert.doesNotMatch(rendered.join('\n'), /Copilot: \/sf-/u);
  // Returning the phase is named as what it is, and as not deciding the amendment.
  assert.match(plan.steps[1].label, /Returning planning instead \(a person, with \/sf-reject in a new turn\) does not decide AMD-001/u);

  // VS Code rebuilds every route from the command, so it reaches the same answer.
  const envelope = JSON.parse(JSON.stringify(refusalEnvelope(refusal(pendingDetails), APPROVE)));
  const { refusalFor } = await import('../apps/vscode/src/views/refusal.ts');
  const { resultCardHtml } = await import('../apps/vscode/src/views/result-card-page.ts');
  const { commandGuidanceText } = await import('../apps/vscode/src/views/command-guidance.ts');
  const { view: card } = refusalFor({ message: 'history changed', result: envelope });
  assert.deepEqual(card.actions.map(({ command, skill, copilotCommand }) => ({ command, skill, copilotCommand })),
    [{ command: STATUS, skill: null, copilotCommand: null }, { command: DECIDE, skill: null, copilotCommand: null }]);
  const html = resultCardHtml(card);
  assert.equal(html.split(`Copilot:</strong> ${NO_ROUTE} </li>`).length - 1, 2, html);
  assert.doesNotMatch(html, /\/sf-reject<\/code>|Copilot: <code>/u);
  assert.equal(commandGuidanceText(STATUS), `- Copilot: ${NO_ROUTE}\n- Shell: ${STATUS}\n- VS Code (model-free): not available for this action`);
});

test('the intent-amendment crosswalk routes only drafting and proposing to /sf-reject', () => {
  for (const command of [STATUS, DECIDE, `singularity-flow story intent-amendment --work-id ${WORK}`,
    `singularity-flow story intent-amendment acknowledge AMD-001 --work-id ${WORK}`]) {
    const guidance = safeCommandGuidance(command);
    assert.equal(guidance?.command, command, command);
    assert.equal(guidance.skill, null, command);
    assert.equal(guidance.copilotCommand, null, command);
    assert.equal(copilotCommandForCommand(command, '/sf-reject'), null, `a supplied skill is no route either: ${command}`);
    // A producer asserting the old route is contradicted, never shown.
    assert.equal(safeCommandGuidance({ command, skill: '/sf-reject' }), null, command);
    assert.equal(safeCommandGuidance({ command, copilotCommand: '/sf-reject' }), null, command);
    const action = copilotAction({ skill: '/sf-reject', command, reason: 'x' });
    assert.deepEqual([action.skill, action.copilotCommand], [null, null], command);
    assert.equal(actionCommandLines({ skill: '/sf-reject', command })[1], `- Copilot: ${NO_ROUTE}`);
  }
  for (const command of [`singularity-flow story intent-amendment draft --work-id ${WORK}`,
    `singularity-flow story intent-amendment propose --work-id ${WORK} --file amended.md --reason x`]) {
    assert.equal(safeCommandGuidance(command)?.copilotCommand, '/sf-reject', command);
  }
});

test('commits of any other kind keep the existing recover and new-turn reject routes', () => {
  for (const details of [
    { blockingCommitCount: 1, blockingCommits: [{ commit: '2555541e97d0', subject: 'Unrelated empty commit', kind: 'commit' }] },
    // A decided amendment whose commits record more than its proposal and rejection waits for no one:
    // the phase needs a fresh submission. (An exact rejected pair never blocks.)
    { blockingCommitCount: 2, blockingCommits: [
      { commit: '1b3bf2703ebb', subject: `[${WORK}][intent-amendment:propose] AMD-001`, kind: 'intent-amendment-proposal',
        amendment: { id: 'AMD-001', action: 'propose', status: 'rejected' } },
      { commit: '1880d4d4cac5', subject: `[${WORK}][intent-amendment:reject] AMD-001`, kind: 'intent-amendment-decision',
        amendment: { id: 'AMD-001', action: 'reject', status: 'rejected' } }] }
  ]) {
    const plan = refusalRemediationPlan(refusal(details), APPROVE);
    assert.deepEqual(plan.steps.map((step) => step.id), EXISTING_ROUTES);
    assert.equal(plan.steps[0].command, `singularity-flow recover ${WORK} --phase planning --json`);
    assert.equal(plan.context.strategy, 'new-turn-repair');
  }
});

test('the blocking commits and the undecided amendment cross the process boundary', () => {
  const projected = refusalDetails({ workId: WORK, phase: 'planning', ...pendingDetails, interveningCommits: ['a'.repeat(40)] });
  assert.equal(projected.nextAction, STATUS);
  assert.equal(projected.blockingCommitCount, 1);
  assert.deepEqual(projected.blockingCommits, [{ commit: '1b3bf2703ebb', subject: `[${WORK}][intent-amendment:propose] AMD-001`,
    kind: 'intent-amendment-proposal', amendment: { id: 'AMD-001', action: 'propose', status: 'proposed' } }]);
  assert.deepEqual(projected.pendingIntentAmendments, [{ id: 'AMD-001', commit: '1b3bf2703ebb',
    changedClauses: [`${WORK}:AC-001`, `${WORK}:REQ-002`] }]);
  assert.equal(refusalDetails({ blockingCommits: [{ commit: 'not a commit', subject: 'x' }] }), null, 'only commit names cross');
});

const advisory = {
  advisory: true, count: 1,
  statement: 'Approving planning now would be refused: a commit after its submission may not precede approval.',
  commits: pendingDetails.blockingCommits,
  lines: ['This commit after the submission (evidence 0123456789ab) may not precede approval:',
    `- 1b3bf2703ebb [${WORK}][intent-amendment:propose] AMD-001 (intent amendment AMD-001, still waiting for a decision).`],
  pendingIntentAmendments: pendingDetails.pendingIntentAmendments,
  actions: [{ label: 'See intent amendment AMD-001.', command: STATUS },
    { label: 'A person who approves specification decides AMD-001 in their own terminal; an agent cannot.', command: DECIDE },
    { label: 'Not a Singularity Flow command.', command: 'rm -rf /' }]
};

test('the advisory prints as warning lines with every route, and the approval page shows it without running anything', async () => {
  const lines = blockingCommitLines(advisory);
  assert.equal(lines[0], `${advisory.statement} (Advisory; the approval gate decides.)`);
  assert.ok(lines.includes(`    - Shell: ${STATUS}`) && lines.includes(`    - Shell: ${DECIDE}`), lines.join('\n'));
  // Neither the read nor the person's decision is /sf-reject's: that skill returns the phase.
  assert.equal(lines.filter((line) => line === `    - Copilot: ${NO_ROUTE}`).length, 2, lines.join('\n'));
  assert.ok(!lines.some((line) => line.includes('/sf-reject')), lines.join('\n'));
  assert.deepEqual(blockingCommitLines(null), []);
  const { approvalBlockingCommits, approvalBlockingCommitsHtml } = await import('../apps/vscode/src/views/webview.ts');
  const page = approvalBlockingCommits(advisory);
  assert.deepEqual(page.actions.map((action) => action.command), [STATUS, DECIDE], 'only Singularity Flow commands are shown');
  const html = approvalBlockingCommitsHtml(page);
  assert.match(html, /<h2>Approval would be refused<\/h2>/u);
  assert.ok(html.includes('1b3bf2703ebb [HEX-2018][intent-amendment:propose] AMD-001'), html);
  assert.ok(html.includes('&lt;approve|reject&gt;'), 'commands are escaped');
  assert.doesNotMatch(html, /<button|data-command/u, 'nothing on the page runs a command');
  assert.equal(approvalBlockingCommits({ statement: 'x', lines: [] }), null);
  assert.equal(approvalBlockingCommitsHtml(null), '');
  // Seen in real VS Code (2026-10-24): an unwrapped decide command ran past the notice's edge.
  const reviewPage = await readFile(path.join(PACKAGE, 'apps/vscode/src/views/approval-review.ts'), 'utf8');
  assert.match(reviewPage, /\.approval-held pre \{ white-space:pre-wrap; overflow-wrap:anywhere; \}/u);
});


test('approving a submitted phase names each later commit, and an undecided amendment holds it until decided', async (t) => {
  const { run, git, cli, submitted, candidate } = await submittedPlanningStory(t, WORK);
  assert.equal(JSON.parse(cli('status', WORK, '--submission-readiness', '--json').stdout).blockingCommits, undefined,
    'nothing is named while nothing blocks');
  const refuse = (code = 'STORY_REVIEW_INTERVENING_COMMIT') => {
    const result = run(process.execPath, [CLI, '--no-model', ...APPROVE, '--yes', '--json'], { allowFailure: true });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.error.code, code, result.stdout);
    return envelope;
  };

  // An ordinary commit: named, and routed exactly as before.
  git('commit', '--allow-empty', '-qm', 'Unrelated empty commit');
  const unrelated = git('rev-parse', '--short=12', 'HEAD');
  const ordinary = refuse();
  assert.match(ordinary.error.message, new RegExp(`This commit after the submission \\(evidence [0-9a-f]{12}\\) may not precede approval: - ${unrelated} Unrelated empty commit\\.`, 'u'));
  assert.deepEqual(ordinary.error.details.blockingCommits, [{ commit: unrelated, subject: 'Unrelated empty commit', kind: 'commit' }]);
  assert.equal(ordinary.error.details.pendingIntentAmendments, undefined);
  assert.equal(ordinary.error.details.nextAction, undefined);
  assert.deepEqual(ordinary.remediationPlan.steps.map((step) => step.id), EXISTING_ROUTES);
  const ordinaryAdvisory = JSON.parse(cli('phase', 'show', 'planning', '--json').stdout).blockingCommits;
  assert.deepEqual(ordinaryAdvisory.commits, [{ commit: unrelated, subject: 'Unrelated empty commit', kind: 'commit' }]);
  assert.equal(ordinaryAdvisory.actions, undefined, 'only an undecided amendment carries commands');
  // Only this fixture drops the unpublished commit; a real Story would return planning for a fresh submission.
  git('reset', '-q', '--hard', submitted);

  // An amendment proposed while planning waits for review.
  await writeFile(candidate, specification(WORK, 2));
  cli('story', 'intent-amendment', 'propose', '--file', candidate, '--reason', 'Review showed that value 2 is required.');
  const proposal = git('rev-parse', '--short=12', 'HEAD');
  // SPEC-OAP M2: the proposal makes nothing stale. It holds the approval until a person who approves
  // the scope decides it, seen before the review with who decides and its route.
  const readiness = JSON.parse(cli('status', WORK, '--submission-readiness', '--json').stdout);
  assert.equal(readiness.classification, 'already-submitted');
  // A known hold replaces the refusing approval route with the owner's list (79e0fefa5).
  assert.equal(readiness.reasonCode, 'APPROVAL_HOLDS_REQUIRED');
  assert.equal(readiness.nextCommand, `singularity-flow decisions ${WORK}`);
  assert.equal(readiness.blockingCommits, undefined, 'no commit is named as stale');
  assert.equal(readiness.approvalCheck.ready, false);
  assert.deepEqual(readiness.approvalCheck.holds.map((hold) => [hold.code, hold.owner, hold.action?.command, hold.summary]),
    [['APPROVAL_INTENT_AMENDMENT_PENDING', 'someone-decides', STATUS, 'Approving planning waits for intent amendment AMD-001 to be decided.']]);
  // Next steps offer the list where they offered the approval: its reject and approve are a choice,
  // so the step sheet's next picks neither [study 6.1].
  const next = JSON.parse(cli('nextsteps', WORK, '--json').stdout);
  const nowActions = (next.actions ?? next.data?.actions ?? []).filter((entry) => entry.timing === 'now');
  assert.equal(nowActions[0]?.command, `singularity-flow decisions ${WORK}`, JSON.stringify(nowActions.map((entry) => entry.command)));
  assert.ok(!(next.actions ?? next.data?.actions ?? []).some((entry) => entry.command?.startsWith('singularity-flow approve planning ')),
    'no approval is offered into a refusal');
  const packet = JSON.parse(cli('choices', 'begin', 'approve', WORK, '--json', '--review-packet').stdout);
  assert.equal(packet.begun, false, 'a known hold returns before any receipt or document packet (79e0fefa5)');
  assert.equal(packet.approvalPacket.review, null);
  assert.deepEqual(packet.approvalPacket.sheet.holds.map((hold) => hold.code), readiness.approvalCheck.holds.map((hold) => hold.code));
  const shown = cli('phase', 'show', 'planning');
  assert.ok(shown.stderr.includes('An approver of Specification decides: Approving planning waits for intent amendment AMD-001 to be decided.'), shown.stderr);
  assert.ok(shown.stderr.includes(`Shell: ${STATUS}`), shown.stderr);
  const pending = refuse('APPROVAL_INTENT_AMENDMENT_PENDING');
  assert.equal(pending.error.message, [
    'Approving planning waits for intent amendment AMD-001 to be decided.',
    `Intent amendment AMD-001 changes ${WORK}:AC-001 and ${WORK}:REQ-002 and was proposed after planning was submitted (${proposal}); a person who approves specification decides it.`,
    'Rejecting it keeps this submission, and planning can then be approved as it is; approving it changes the approved clauses, so planning reopens to be revised and submitted again.'
  ].join(' '), 'one sentence per line in a terminal; the JSON envelope joins them');
  assert.deepEqual(pending.error.details.pendingIntentAmendments, [{ id: 'AMD-001', commit: proposal, changedClauses: [`${WORK}:AC-001`, `${WORK}:REQ-002`] }]);
  assert.equal(pending.error.details.nextAction, STATUS);
  assert.deepEqual(pending.remediationPlan.steps.map((step) => step.id), ['inspect-intent-amendment', 'decide-intent-amendment', 'leave-approval-turn']);
  assert.deepEqual(pending.remediationPlan.steps.slice(0, 2).map((step) => step.command), [STATUS, DECIDE]);
  // The VS Code card leads with the same route.
  const { refusalFor } = await import('../apps/vscode/src/views/refusal.ts');
  const { view } = refusalFor({ result: pending, message: pending.error.message });
  assert.deepEqual(view.actions.map((action) => action.command), [STATUS, DECIDE]);
  assert.equal(view.actions[0].emphasis, 'primary');
  assert.ok(view.warnings.some((warning) => /End this approval-only turn/u.test(warning.label)));
  // Rejecting it is the next test's journey.
});

/**
 * SPEC-OAP decision 1 (accepted 2026-10-24): a rejected amendment changes no clause, specification
 * generation, artifact or source, so the inputs planning was reviewed on are identical and the
 * submission stays valid. Before, the history rule alone forced a fresh submission. The pair is
 * still named, and approval records it; the test in oap-m1-approval-check.test.mjs pins what does
 * not count as one.
 */
test('rejecting the amendment keeps the submission: planning is approved as submitted, and the pair is still named', async (t) => {
  const { run, git, cli, item, candidate } = await submittedPlanningStory(t, WORK);
  await writeFile(candidate, specification(WORK, 2));
  cli('story', 'intent-amendment', 'propose', '--file', candidate, '--reason', 'Review showed that value 2 is required.');
  const proposal = git('rev-parse', 'HEAD');
  cli('story', 'intent-amendment', 'decide', 'AMD-001', '--decision', 'reject', '--confirm', 'AMD-001');
  const rejection = git('rev-parse', 'HEAD');
  const note = `Decided after the submission: AMD-001 rejected (proposal ${proposal.slice(0, 12)}, rejection ${rejection.slice(0, 12)}); the reviewed inputs are unchanged.`;

  // The approval packet and phase show list it beside a check that passes, as an advisory.
  const packet = JSON.parse(cli('choices', 'begin', 'approve', WORK, '--json', '--review-packet').stdout).approvalPacket;
  for (const check of [packet.readiness.approvalCheck, packet.review.approvalCheck]) {
    assert.equal(check.ready, true, JSON.stringify(check));
    assert.deepEqual(check.holds, []);
    assert.deepEqual(check.notes, [note]);
    assert.deepEqual(check.decidedAfterSubmission, [{ id: 'AMD-001', status: 'rejected',
      proposalCommit: proposal.slice(0, 12), rejectionCommit: rejection.slice(0, 12) }]);
  }
  assert.equal(packet.readiness.blockingCommits, undefined, 'nothing blocks');
  // The packet's review is what phase show prints, through these lines.
  assert.deepEqual(approvalCheckLines(packet.review.approvalCheck), ['Approving planning would pass every check.', `  ${note}`]);

  // Approved as submitted; the decision names the rejected amendment's commits for audit.
  const approved = run(process.execPath, [CLI, '--no-model', ...APPROVE, '--yes', '--json'], { allowFailure: true });
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  const planning = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8')).phases.planning;
  assert.equal(planning.status, 'approved');
  assert.deepEqual(planning.approvals.at(-1).rejectedIntentAmendments,
    [{ id: 'AMD-001', status: 'rejected', proposalCommit: proposal, rejectionCommit: rejection }]);
});

test('approving an amendment reopens the step awaiting approval, so its acknowledgement precedes a fresh submission', async (t) => {
  const { git, cli, item, candidate } = await submittedPlanningStory(t, WORK);
  // SPEC-OAP D4 did not reproduce: approving an amendment reopens the step awaiting approval, even one
  // that only adds a clause nothing cites, so its acknowledgement always precedes a fresh submission
  // and never sits between a submission and its approval.
  await writeFile(candidate, specification(WORK, 1).replace('## Scenario coverage', `- The value is logged once. [${WORK}:REQ-009]\n\n## Scenario coverage`));
  cli('story', 'intent-amendment', 'propose', '--file', candidate, '--reason', 'Review showed the value must be logged.');
  cli('story', 'intent-amendment', 'decide', 'AMD-001', '--decision', 'approve', '--confirm', 'AMD-001');
  const reopened = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.equal(reopened.phases.planning.status, 'in_progress');
  assert.equal(JSON.parse(cli('status', WORK, '--submission-readiness', '--json').stdout).classification, 'amendment-acknowledgement-required');
  // Its acknowledgement adds amendment records only, so it is review-safe too (REVIEW_EFFECTS, SPEC-OAP M2).
  const approved = git('rev-parse', 'HEAD');
  cli('story', 'intent-amendment', 'acknowledge', 'AMD-001');
  const acknowledgement = git('rev-parse', 'HEAD');
  const { loadConfig, reviewHistoryCommits } = await import('../src/state.mjs');
  const root = path.resolve(item, '../../..');
  const workflow = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  const history = await reviewHistoryCommits(root, await loadConfig(root), workflow, workflow.phases.planning, { evidenceCommit: approved });
  assert.deepEqual([history.blocking, history.allowedReviewCommits], [[], [acknowledgement]]);
});
