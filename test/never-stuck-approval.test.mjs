/**
 * Never stuck at approval: SFlow's own records never undo an approval [owner, 2026-11-28].
 *
 * Real case (d-story, Release v4, 2026-11-23): Release was submitted; in /sf-decide the person raised UPI-003 against
 * Implementation and accepted it as a risk. SFlow wrote two commits for it, and the approval was then refused: "repository
 * history changed after its immutable review evidence was recorded". The way out was to send Release back: two
 * /sf-reject, a reason, two version confirmations, a review and a submission, about 11 person actions, a fifth version
 * and 3 h 40 min. Both commits were review-safe decisions in REVIEW_EFFECTS; the classifier read the Story's state with
 * Git's 1 MB default, and d-story's state was 1.1 MB, so every decision recorded after the submission read as "not
 * SFlow's". The classifier now reads the state as the other state readers do (STORY_STATE_OBJECT_BYTES), one classifier
 * (sflowRecordCommit) serves the approval's history check and an Auto flight's resume, and every lifecycle event that is
 * review-safe names the check that verifies it.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { CLI, submittedPlanningStory } from './helpers/submitted-planning-story.mjs';

const WORK = 'NSA-1';
const STATE = `singularity/work-items/${WORK}/workflow.json`;
const expires = () => new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);

/** The person's own actions in the walk, counted as they happen. */
function counter(cli) {
  const actions = [];
  return { actions, act: (label, ...argv) => { actions.push(label); return cli(...argv); } };
}

test('the real case: an upstream issue raised and accepted while a step waits for approval, then approved at once', async (t) => {
  const { run, git, cli, item } = await submittedPlanningStory(t, WORK);
  const { actions, act } = counter(cli);
  act('raise an issue against Specification', 'upstream-issue', 'raise', '--work-id', WORK, '--phase', 'specification', '--about', 'AC-001',
    '--problem', 'The specification does not say what a missing value shows to the user.');
  act('accept it as a risk', 'upstream-issue', 'decide', 'UPI-001', '--work-id', WORK, '--outcome', 'accept-risk', '--expires', expires(),
    '--reason', 'The gap is small and is carried into the pull request.');
  assert.deepEqual(git('log', '--format=%s', '-2').split('\n'), [`[${WORK}][upstream-issue] UPI-001 accept-risk`, `[${WORK}][upstream-issue] raise against specification`]);
  // Before approving, nothing says the step changed: both commits are SFlow's own records.
  const readiness = JSON.parse(cli('status', WORK, '--submission-readiness', '--json').stdout);
  assert.equal(readiness.blockingCommits, undefined, JSON.stringify(readiness.blockingCommits));
  const approved = run(process.execPath, [CLI, '--no-model', 'approve', 'planning', '--work-id', WORK, '--yes', '--json'], { allowFailure: true });
  actions.push('approve Planning');
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  assert.equal(JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8')).phases.planning.status, 'approved');
  // Person actions: the issue, its decision and the one approval. The real case before this fix: these three, then about 11
  // more (send back twice with a reason, two version answers, a review and a submission, the approval again).
  assert.deepEqual(actions, ['raise an issue against Specification', 'accept it as a risk', 'approve Planning']);
});

test('a long Story: its state passes 1 MB, and a decision recorded after the submission is still SFlow\'s own record', async (t) => {
  const W = `${WORK}B`;
  const { git, cli, item } = await submittedPlanningStory(t, W);
  const root = path.resolve(item, '../../..');
  const state = `singularity/work-items/${W}/workflow.json`;
  cli('upstream-issue', 'raise', '--work-id', W, '--phase', 'specification', '--about', 'AC-001',
    '--problem', 'The specification does not say what a missing value shows to the user.');
  cli('upstream-issue', 'decide', 'UPI-001', '--work-id', W, '--outcome', 'accept-risk', '--expires', expires(),
    '--reason', 'The gap is small and is carried into the pull request.');
  const [decided, raised, submitted] = ['HEAD', 'HEAD~1', 'HEAD~2'].map((name) => git('rev-parse', name));
  // The same two commits, with their own files, messages and events, on a state padded past 1 MB on both sides, as d-story's was.
  const padding = 'x'.repeat(1_200_000);
  const pad = async (commit) => writeFile(path.join(root, state), JSON.stringify({ ...JSON.parse(git('show', `${commit}:${state}`)), padding }, null, 2));
  const message = path.join(root, '.git', 'NSA_MESSAGE');
  git('checkout', '-q', '--detach', submitted);
  await pad(submitted);
  git('commit', '-qam', 'A long Story at its submission');
  for (const [commit, parent] of [[raised, submitted], [decided, raised]]) {
    git('checkout', '-q', commit, '--', ...git('diff', '--name-only', parent, commit).split('\n').filter(Boolean));
    await pad(commit);
    git('add', '-A');
    await writeFile(message, git('log', '-1', '--format=%B', commit));
    git('commit', '-q', '-F', message);
  }
  const big = git('rev-parse', 'HEAD');
  assert.ok(Number(git('cat-file', '-s', `${big}:${state}`)) > 1024 * 1024, 'the state passes Git\'s 1 MB read default');
  const { loadConfig, governedStateChange, sflowRecordCommit } = await import('../src/state.mjs');
  const { workflowTaskDeltaSafe } = await import('../src/workflow-task.mjs');
  const { exactFileAtObject } = await import('../src/git.mjs');
  const config = await loadConfig(root);
  const workflow = JSON.parse(await readFile(path.join(root, state), 'utf8'));
  assert.equal(exactFileAtObject(root, big, state), null, 'Git\'s 1 MB default cannot read it: the cause of the real case');
  assert.ok(governedStateChange(root, config, workflow, big), 'read at the Story state limit');
  assert.equal(sflowRecordCommit(root, config, workflow, big, workflowTaskDeltaSafe), true, 'the decision is SFlow\'s own record');
  assert.equal(sflowRecordCommit(root, config, workflow, git('rev-parse', 'HEAD~1'), workflowTaskDeltaSafe), true, 'and so is the raise');
});

test('a real change after the review still counts: plain words, and Send back with the person\'s reason comes first', async (t) => {
  const { run, git } = await submittedPlanningStory(t, `${WORK}C`);
  git('commit', '--allow-empty', '-qm', 'Change the plan by hand');
  const refused = run(process.execPath, [CLI, '--no-model', 'approve', 'planning', '--work-id', `${WORK}C`, '--yes', '--json'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  const envelope = JSON.parse(refused.stdout);
  assert.equal(envelope.error.code, 'STORY_REVIEW_INTERVENING_COMMIT');
  assert.match(envelope.error.message, /^Planning changed after it was reviewed\. SFlow's own records never count; these commits are other changes, so this is not what was reviewed\./u);
  assert.doesNotMatch(envelope.error.message, /immutable|evidence was recorded/u);
  const [first] = envelope.remediationPlan.steps;
  assert.equal(first.id, 'send-back-changed-step');
  assert.equal(first.command, `singularity-flow reject planning --work-id ${WORK}C --fetch --to planning --reason <reason>`);
  assert.match(first.label, /^Planning changed after it was reviewed, so this is not what was reviewed: Send back so the change is reviewed\. Your reason goes to the next version\.$/u);
});

/** Every lifecycle event a review may sit beside names the check that verifies its commit; a new one fails here. */
const VERIFIERS = Object.freeze({
  'phase-approved': 'priorApprovalCommits',
  'test-risk-attested': 'verifiedStoryTestRiskReviewCommits', 'test-risk-accepted': 'verifiedStoryTestRiskReviewCommits',
  'test-risk-revoked': 'verifiedStoryTestRiskReviewCommits',
  'intent-amendment-proposed': 'pendingIntentAmendmentProposals', 'intent-amendment-rejected': 'rejectedIntentAmendments',
  'intent-amendment-acknowledged': 'intentAmendmentAcknowledgements',
  'evidence-recorded': 'readGovernedAutoCheckpoint',
  'telemetry-recorded': 'sflowRecordCommit'
});

test('one classifier: every review-safe record writer names its check, and the history check and Auto read the same one', async () => {
  const { REVIEW_EFFECTS } = await import('../src/state.mjs');
  const source = await readFile(new URL('../src/state.mjs', import.meta.url), 'utf8');
  const safe = Object.entries(REVIEW_EFFECTS).filter(([key, entry]) => !key.startsWith('decision-made:') && (entry?.effect ?? entry) === 'review-safe').map(([key]) => key);
  assert.deepEqual(safe.filter((type) => !VERIFIERS[type]), [], 'a review-safe event with no named check: add its verifier, then name it here');
  assert.deepEqual(Object.keys(VERIFIERS).filter((type) => !safe.includes(type)), [], 'a named check for an event that is no longer review-safe');
  const history = source.slice(source.indexOf('export async function reviewHistoryCommits('), source.indexOf('/** Who an automatic approval names'));
  for (const check of new Set(Object.values(VERIFIERS))) assert.ok(history.includes(check), `reviewHistoryCommits reads ${check}`);
  const auto = source.slice(source.indexOf('export async function onlyHumanDecisionCommits('), source.indexOf('/** The creation commit'));
  assert.match(auto, /sflowRecordCommit\(/u, 'an Auto flight resumes over the same classifier');
  assert.match(history, /sflowRecordCommit\(/u);
  // The classifiers read a Story's state at the state limit, never Git's 1 MB default.
  const change = source.slice(source.indexOf('export function governedStateChange('), source.indexOf('export function stateChangesOnly('));
  assert.equal(change.match(/maximumBytes: STORY_STATE_OBJECT_BYTES/gu)?.length, 2);
});
