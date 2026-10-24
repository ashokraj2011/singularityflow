/**
 * Approval names the commits that stop it, and routes an undecided intent amendment first.
 *
 * Real case (2026-10-24): planning was submitted, an intent amendment changing two approved clauses
 * was proposed six hours later, and approving planning refused with "repository history changed
 * after its immutable review evidence was recorded". It named neither the commit nor the amendment,
 * and its first route was a recover command that finds nothing to recover. The person could not tell
 * that the amendment had to be decided before planning could be revised or resubmitted. The same
 * commits are now named beforehand, as an advisory, in the approval packet's readiness, in phase
 * show and on the VS Code approval page; none of them stops the review.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { refusalDetails, refusalRemediationPlan, renderRefusalPlan } from '../src/refusal-remediation.mjs';
import { blockingCommitLines } from '../src/owed-decisions.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PACKAGE, 'bin/singularity-flow.mjs');
const WORK = 'HEX-2018';
const APPROVE = ['approve', 'planning', '--work-id', WORK];
const STATUS = `singularity-flow story intent-amendment status --work-id ${WORK} --json`;
const DECIDE = `singularity-flow story intent-amendment decide AMD-001 --decision <approve|reject> --confirm AMD-001 --work-id ${WORK}`;
const EXISTING_ROUTES = ['inspect-current-phase', 'leave-approval-turn', 'inspect-current-phase-evidence'];

function refusal(details) {
  return new SingularityFlowError('history changed', { code: 'STORY_REVIEW_INTERVENING_COMMIT',
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
  const plan = refusalRemediationPlan(refusal(pendingDetails), APPROVE);
  assert.deepEqual(plan.steps.map((step) => step.id), ['inspect-intent-amendment', 'decide-intent-amendment', 'leave-approval-turn']);
  assert.equal(plan.steps[0].command, STATUS);
  assert.match(plan.steps[0].label, /AMD-001, proposed in 1b3bf2703ebb after planning was submitted; it changes HEX-2018:AC-001, HEX-2018:REQ-002/u);
  assert.equal(plan.steps[1].command, DECIDE);
  // A person decides; the outcome of each decision is stated, and neither one makes this approval pass.
  assert.match(plan.steps[1].label, /A person who approves specification decides AMD-001 in their own terminal; an agent cannot/u);
  assert.match(plan.steps[1].label, /Approving it changes those clauses, so planning reopens to be revised and submitted again/u);
  assert.match(plan.steps[1].label, /Rejecting it keeps the approved clauses, but planning still needs a fresh submission before approval/u);
  assert.equal(plan.context.strategy, 'person-decides-intent-amendment');
  assert.equal(plan.context.turn, 'new-turn');
  assert.equal(plan.retry.command, null);
  assert.ok(!plan.steps.some((step) => step.argv?.[0] === 'approve'), 'no route retries approval');
  const rendered = renderRefusalPlan(plan);
  assert.match(rendered, /an intent amendment proposed after its submission waits for a person's decision/u);
  assert.ok(rendered.indexOf(STATUS) < rendered.indexOf('End this approval-only turn'), rendered);
});

test('commits of any other kind keep the existing recover and new-turn reject routes', () => {
  for (const details of [
    { blockingCommitCount: 1, blockingCommits: [{ commit: '2555541e97d0', subject: 'Unrelated empty commit', kind: 'commit' }] },
    // A decided amendment no longer waits for anyone: the phase needs a fresh submission.
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
  assert.ok(lines.includes(`    Shell: ${STATUS}`) && lines.includes(`    Shell: ${DECIDE}`), lines.join('\n'));
  assert.ok(lines.includes('    Copilot: /sf-reject'), lines.join('\n'));
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

function specification(value) {
  return [
    `# ${WORK} — Specification`, '',
    '## Agent brief', '', `The exported value must be ${value}, with a matching executable test.`, '',
    '## Actors', '', 'A user reads the value.', '',
    '## User scenarios', '', '### S1 — Read the value', '',
    '- **Given** a ready application', '  **When** a user reads the value', `  **Then** ${value} is displayed.`, '',
    '## Failure and empty states', '', 'A missing value is rejected without inventing data.', '',
    '## Permissions', '', 'A user may read the value without special privileges.', '',
    '## Boundary conditions', '', 'Only the approved integer value is exposed.', '',
    '## Requirements', '',
    `- The user sees the value ${value}. [${WORK}:AC-001]`,
    `- The application returns the value ${value}. [${WORK}:REQ-002]`, '',
    '## Scenario coverage', '',
    '| Clause | Scenario | Outcome |', '|---|---|---|',
    `| \`${WORK}:AC-001\` | S1 | success |`, `| \`${WORK}:REQ-002\` | S1 | success |`, '',
    '## Boundary and non-functional requirements', '', 'Do not expose private data; invalid input is rejected deterministically.', '',
    '## Non-functional requirements', '', 'A local read returns deterministically without a network call.', '',
    '## Assumptions', '', 'The value is available in the local application.', '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    `| \`${WORK}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`,
    `| \`${WORK}:REQ-002\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, '',
    '## Evidence and assumptions', '', 'The pinned repository is the implementation source.', '',
    '## Out of scope', '', 'No unrelated application changes.'
  ].join('\n');
}

/** A Story whose planning was submitted and awaits approval, in a repository of its own. */
async function submittedPlanningStory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-approval-history-'));
  const root = path.join(directory, 'repository');
  const remote = path.join(directory, 'origin.git');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = (command, args, { allowFailure = false, cwd = root } = {}) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: childTimeout(60_000),
      env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'History Tester' } });
    if (!allowFailure) assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  run('git', ['init', '-q', '-b', 'main', root], { cwd: directory });
  const git = (...args) => run('git', args).stdout.trim();
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args]);
  git('config', 'user.name', 'History Tester');
  git('config', 'user.email', 'history@example.test');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  cli('init');
  const configurationPath = path.join(root, 'singularity/workflow.yml');
  const configuration = YAML.parse(await readFile(configurationPath, 'utf8'));
  configuration.worldModel.grounding = 'off';
  configuration.approvalSecurity = { profile: 'poc' };
  configuration.repositoryReadiness = { ...(configuration.repositoryReadiness ?? {}), requiredBeforeStory: false };
  for (const authority of Object.values(configuration.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  configuration.workTypes['spec-driven-standard'].sourceReview = { mode: 'off' };
  await writeFile(configurationPath, YAML.stringify(configuration));
  git('add', '.');
  git('commit', '-qm', 'Initialize approval history fixture');
  run('git', ['init', '--bare', '-b', 'main', remote]);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', '-u', 'origin', 'main');

  cli('start', WORK, '--from-branch', 'main', '--work-type', 'spec-driven-standard',
    '--title', 'Validate a value', '--description', 'Return an approved value.');
  const item = path.join(root, 'singularity/work-items', WORK);
  await writeFile(path.join(item, 'artifacts/specification/spec.md'), specification(1));
  cli('artifact', 'scan', '--phase', 'specification');
  cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'specification', '--skip-checks');
  cli('approve', 'specification', '--yes');
  cli('prepare', 'planning');
  await writeFile(path.join(item, 'artifacts/planning/plan.md'), [
    `# ${WORK} — Implementation plan`, '',
    '## Agent brief', '', 'Return the approved value and prove both clauses with one focused test.', '',
    '## Approach', '', 'Export a constant from the value module and assert it in a unit test.', '',
    '## Affected surfaces', '', '| Surface | Change | Serves |', '|---|---|---|',
    `| \`src/value.mjs\` | exported value | ${WORK}:REQ-002 |`, '',
    '## Test strategy', '', '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    `| \`${WORK}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`,
    `| \`${WORK}:REQ-002\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, '',
    '## Risks and rollback', '', 'Risk is a wrong constant; rollback restores the previous module.', ''
  ].join('\n'));
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'planning', '--skip-checks');
  const submitted = git('rev-parse', 'HEAD');
  const candidate = path.join(directory, 'amended-spec.md');
  return { run, git, cli, item, submitted, candidate };
}

test('approving a submitted phase names each later commit and leads with an undecided amendment', async (t) => {
  const { run, git, cli, submitted, candidate } = await submittedPlanningStory(t);
  assert.equal(JSON.parse(cli('status', WORK, '--submission-readiness', '--json').stdout).blockingCommits, undefined,
    'nothing is named while nothing blocks');
  const refuse = () => {
    const result = run(process.execPath, [CLI, '--no-model', ...APPROVE, '--yes', '--json'], { allowFailure: true });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.error.code, 'STORY_REVIEW_INTERVENING_COMMIT', result.stdout);
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
  await writeFile(candidate, specification(2));
  cli('story', 'intent-amendment', 'propose', '--file', candidate, '--reason', 'Review showed that value 2 is required.');
  const proposal = git('rev-parse', '--short=12', 'HEAD');
  // Named before the review too, as an advisory that changes no route and stops nothing.
  const readiness = JSON.parse(cli('status', WORK, '--submission-readiness', '--json').stdout);
  assert.equal(readiness.classification, 'already-submitted');
  assert.equal(readiness.nextCommand, `singularity-flow approve planning --work-id ${WORK} --fetch`);
  assert.equal(readiness.blockingCommits.advisory, true);
  assert.equal(readiness.blockingCommits.statement, 'Approving planning now would be refused: a commit after its submission may not precede approval.');
  assert.deepEqual(readiness.blockingCommits.commits.map((entry) => [entry.commit, entry.subject, entry.kind]),
    [[proposal, `[${WORK}][intent-amendment:propose] AMD-001`, 'intent-amendment-proposal']]);
  assert.deepEqual(readiness.blockingCommits.pendingIntentAmendments.map((entry) => entry.id), ['AMD-001']);
  assert.deepEqual(readiness.blockingCommits.actions.map((action) => action.command), [STATUS, DECIDE]);
  const packet = JSON.parse(cli('choices', 'begin', 'approve', WORK, '--json', '--review-packet').stdout);
  assert.equal(packet.ready, false, 'the receipt is begun as before; nothing is answered');
  assert.deepEqual(packet.approvalPacket.readiness.blockingCommits, readiness.blockingCommits);
  assert.deepEqual(packet.approvalPacket.review.blockingCommits, readiness.blockingCommits);
  const shown = cli('phase', 'show', 'planning');
  assert.match(shown.stderr, /Approving planning now would be refused: a commit after its submission may not precede approval\. \(Advisory; the approval gate decides\.\)/u);
  assert.ok(shown.stderr.includes(`Shell: ${STATUS}`), shown.stderr);
  const pending = refuse();
  const subject = `[${WORK}][intent-amendment:propose] AMD-001`;
  assert.ok(pending.error.message.includes(`- ${proposal} ${subject} (intent amendment AMD-001, still waiting for a decision).`), pending.error.message);
  assert.match(pending.error.message, new RegExp(`Intent amendment AMD-001 changes ${WORK}:AC-001 and ${WORK}:REQ-002 and is still waiting for a decision by a person who approves specification`, 'u'));
  assert.match(pending.error.message, /rejecting it keeps them, but planning still needs a fresh submission before it can be approved/u);
  assert.deepEqual(pending.error.details.pendingIntentAmendments, [{ id: 'AMD-001', commit: proposal, changedClauses: [`${WORK}:AC-001`, `${WORK}:REQ-002`] }]);
  assert.equal(pending.error.details.blockingCommits[0].kind, 'intent-amendment-proposal');
  assert.equal(pending.error.details.nextAction, STATUS);
  assert.deepEqual(pending.remediationPlan.steps.map((step) => step.id), ['inspect-intent-amendment', 'decide-intent-amendment', 'leave-approval-turn']);
  assert.deepEqual(pending.remediationPlan.steps.slice(0, 2).map((step) => step.command), [STATUS, DECIDE]);
  // The VS Code card leads with the same route and names the amendment.
  const { refusalFor } = await import('../apps/vscode/src/views/refusal.ts');
  const { view } = refusalFor({ result: pending, message: pending.error.message });
  assert.deepEqual(view.actions.map((action) => action.command), [STATUS, DECIDE]);
  assert.equal(view.actions[0].emphasis, 'primary');
  assert.match(view.why[0].label, new RegExp(`${proposal} \\[${WORK}\\]\\[intent-amendment:propose\\] AMD-001`, 'u'));
  assert.ok(view.warnings.some((warning) => /End this approval-only turn/u.test(warning.label)));

  // Rejected, the amendment waits for no one; planning still needs a fresh submission.
  cli('story', 'intent-amendment', 'decide', 'AMD-001', '--decision', 'reject', '--confirm', 'AMD-001');
  const decided = refuse();
  assert.match(decided.error.message, /These 2 commits after the submission/u);
  assert.match(decided.error.message, /AMD-001 \(intent amendment AMD-001, now rejected\);/u);
  assert.match(decided.error.message, /\[intent-amendment:reject\] AMD-001 \(decision on intent amendment AMD-001\)\./u);
  assert.match(decided.error.message, /Decided after the submission: intent amendment AMD-001 \(rejected\)\. Phase 'planning' still needs a fresh submission/u);
  assert.equal(decided.error.details.pendingIntentAmendments, undefined);
  assert.deepEqual(decided.remediationPlan.steps.map((step) => step.id), EXISTING_ROUTES);
});

test('approving an amendment reopens the step awaiting approval, so its acknowledgement precedes a fresh submission', async (t) => {
  const { cli, item, candidate } = await submittedPlanningStory(t);
  // SPEC-OAP D4 did not reproduce: approving an amendment reopens the step awaiting approval, even one
  // that only adds a clause nothing cites, so its acknowledgement always precedes a fresh submission
  // and never sits between a submission and its approval.
  await writeFile(candidate, specification(1).replace('## Scenario coverage', `- The value is logged once. [${WORK}:REQ-009]\n\n## Scenario coverage`));
  cli('story', 'intent-amendment', 'propose', '--file', candidate, '--reason', 'Review showed the value must be logged.');
  cli('story', 'intent-amendment', 'decide', 'AMD-001', '--decision', 'approve', '--confirm', 'AMD-001');
  const reopened = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.equal(reopened.phases.planning.status, 'in_progress');
  assert.equal(JSON.parse(cli('status', WORK, '--submission-readiness', '--json').stdout).classification, 'amendment-acknowledgement-required');
});
