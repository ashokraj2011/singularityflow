/**
 * One approval check every surface reads [docs/SPEC-OAP-ONE-APPROVAL-PATH-v1.md, M1].
 *
 * evaluateApproval is the approval gate, run as stages over shared facts: recording throws its first
 * refusal (approvePhase), previewing keeps every refusal as a hold with who clears it. These tests
 * pin that the two are the same code, that every hold has an owner, and that a real Story's preview
 * and its recorded refusal agree.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { APPROVAL_HOLD_OWNERS, approvalHoldOwner } from '../src/approval-check.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { CLI, specification, submittedPlanningStory } from './helpers/submitted-planning-story.mjs';

const OWNERS = ['you-decide', 'someone-decides', 'author-repairs', 'machine'];
const stateSource = await readFile(new URL('../src/state.mjs', import.meta.url), 'utf8');
const evaluateSource = stateSource.slice(stateSource.indexOf('export async function evaluateApproval('),
  stateSource.indexOf('export async function approvePhase('));
const recordSource = stateSource.slice(stateSource.indexOf('export async function approvePhase('));
const recordBody = recordSource.slice(0, recordSource.indexOf('\n}\n') + 2);

test('the gate guard: every refusal comes from the one check, and every one names who clears it', () => {
  assert.ok(evaluateSource.length > 10_000, 'evaluateApproval holds the gate');
  const codes = [...new Set([...evaluateSource.matchAll(/code: '([A-Z][A-Z0-9_]+)'/gu)].map((match) => match[1]))];
  assert.ok(codes.length >= 15, String(codes.length));
  assert.deepEqual(codes.filter((code) => !APPROVAL_HOLD_OWNERS[code]), [],
    'a refusal the approval gate throws has no owner class in APPROVAL_HOLD_OWNERS (src/approval-check.mjs)');
  for (const [code, owner] of Object.entries(APPROVAL_HOLD_OWNERS)) assert.ok(OWNERS.includes(owner), `${code}: ${owner}`);
  // Recording adds no refusal of its own: everything that can refuse is a stage the preview runs.
  assert.doesNotMatch(recordBody, /new SingularityFlowError|\bthrow\b/u, 'approvePhase refuses only through evaluateApproval');
  assert.match(recordBody, /await evaluateApproval\(root, config, workflow, \{ \.\.\.options, preview: false \}\)/u);
  // Nothing in the check runs outside a stage, so the preview sees every refusal the gate can raise.
  const body = evaluateSource.slice(evaluateSource.indexOf('\n  try {\n') + 9, evaluateSource.indexOf('\n  } catch (error) {\n    if (error !== APPROVAL_PREVIEW_STOP)'));
  const outside = body.split('\n').filter((line) => /^ {4}\S/u.test(line) && !/^ {4}(await stage\(|\}(\)|, \{))/u.test(line));
  assert.deepEqual(outside, [], 'a check outside a stage would refuse without the preview seeing it');
});

test('who clears a hold follows what it says', () => {
  const error = (code, details = {}) => new SingularityFlowError('refused', { code, details });
  assert.equal(approvalHoldOwner(error('STORY_REVIEW_INTERVENING_COMMIT')), 'author-repairs');
  assert.equal(approvalHoldOwner(error('STORY_REVIEW_INTERVENING_COMMIT', { pendingIntentAmendments: [{ id: 'AMD-001' }] })), 'someone-decides');
  assert.equal(approvalHoldOwner(error('PHASE_VALIDATION_FAILED')), 'author-repairs');
  assert.equal(approvalHoldOwner(error('PHASE_VALIDATION_FAILED', { testRunRisk: { lapsed: 'expired' } })), 'someone-decides');
  assert.equal(approvalHoldOwner(error('APPROVAL_CHECKLIST_INCOMPLETE')), 'you-decide');
  assert.equal(approvalHoldOwner(error('IMPLEMENTATION_BINDING_DECISION_INVALID')), 'you-decide');
  assert.equal(approvalHoldOwner(error('STORY_PUBLICATION_PENDING')), 'machine');
  assert.equal(approvalHoldOwner(error('A_CODE_NOBODY_LISTED')), 'author-repairs');
});

test('a real Story: the preview lists every hold in gate order, and recording refuses with the first', async (t) => {
  const WORK = 'OAP-M1';
  const { run, git, cli, submitted } = await submittedPlanningStory(t, WORK);
  const readiness = () => JSON.parse(cli('status', WORK, '--submission-readiness', '--json').stdout);
  const clean = readiness().approvalCheck;
  assert.deepEqual({ ready: clean.ready, holds: clean.holds }, { ready: true, holds: [] });
  assert.equal(clean.statement, 'Approving planning would pass every check.');

  // Application source committed during review: two holds, the source binding and the commit itself.
  const root = git('rev-parse', '--show-toplevel');
  await writeFile(path.join(root, 'value.mjs'), 'export const value = 1;\n');
  git('add', 'value.mjs');
  git('commit', '-qm', 'Implement the value during the planning review');
  const heldReadiness = readiness(); const held = heldReadiness.approvalCheck;
  assert.equal(heldReadiness.classification, 'already-submitted');
  assert.equal(heldReadiness.reasonCode, 'APPROVAL_HOLDS_REQUIRED');
  assert.equal(heldReadiness.nextCommand, `singularity-flow decisions ${WORK} --for-agent --json`);
  assert.equal(heldReadiness.command, heldReadiness.nextCommand);
  assert.equal(heldReadiness.nextSkill, '/sf-decide');
  assert.equal(held.ready, false);
  assert.deepEqual(held.holds.map((hold) => [hold.code, hold.owner]),
    [['STORY_REVIEW_SOURCE_CHANGED', 'author-repairs'], ['STORY_REVIEW_INTERVENING_COMMIT', 'author-repairs']]);
  assert.ok(held.holds.every((hold) => hold.who && hold.summary && !hold.unclassified));
  const shown = JSON.parse(cli('phase', 'show', 'planning', '--json').stdout).approvalCheck;
  assert.deepEqual(shown.holds.map((hold) => hold.code), held.holds.map((hold) => hold.code), 'phase show reads the same check');
  const refused = run(process.execPath, [CLI, '--no-model', 'approve', 'planning', '--work-id', WORK, '--yes', '--json'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.equal(JSON.parse(refused.stdout).error.code, held.holds[0].code, 'the gate refuses with the preview\'s first hold');
  assert.equal(git('rev-list', '--count', `${submitted}..HEAD`), '1', 'the preview and the refusal recorded nothing');
});

/**
 * A Story whose planning awaits approval, with intent amendment AMD-001 to propose and reject. A
 * crafted commit is published as a person would push it, so only the history rule can tell it apart.
 */
async function amendmentStory(t, WORK) {
  const fixture = await submittedPlanningStory(t, WORK);
  const { run, git, cli, candidate } = fixture;
  await writeFile(candidate, specification(WORK, 2));
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  return {
    ...fixture,
    root: git('rev-parse', '--show-toplevel'),
    head: () => git('rev-parse', '--short=12', 'HEAD'),
    propose: () => cli('story', 'intent-amendment', 'propose', '--file', candidate, '--reason', 'Review showed that value 2 is required.'),
    reject: () => cli('story', 'intent-amendment', 'decide', 'AMD-001', '--decision', 'reject', '--confirm', 'AMD-001'),
    publish: () => git('push', '-q', '-f', 'origin', `HEAD:refs/heads/${branch}`),
    refused: () => {
      const result = run(process.execPath, [CLI, '--no-model', 'approve', 'planning', '--work-id', WORK, '--yes', '--json'], { allowFailure: true });
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      return JSON.parse(result.stdout).error;
    }
  };
}

const PROPOSE = (WORK) => `[${WORK}][intent-amendment:propose] AMD-001`;
const REJECT = (WORK) => `[${WORK}][intent-amendment:reject] AMD-001`;

/**
 * SPEC-OAP decision 1 lets a rejected amendment's proposal and rejection precede approval only when
 * each is exactly what those commands record (rejectedIntentAmendments in src/state.mjs). The real
 * journey passes (test/approval-intervening-commits.test.mjs); a pending amendment still holds (the
 * same file). These do not count as one.
 */
test('a rejection commit that also changes application source is no rejected amendment, in the preview or the gate', async (t) => {
  const WORK = 'OAP-RJ1';
  const { git, cli, root, head, propose, reject, publish, refused } = await amendmentStory(t, WORK);
  propose();
  const proposal = head();
  reject();
  await writeFile(path.join(root, 'value.mjs'), 'export const value = 2;\n');
  git('add', 'value.mjs');
  git('commit', '-q', '--amend', '--no-edit');
  publish();
  const readiness = JSON.parse(cli('status', WORK, '--submission-readiness', '--json').stdout);
  assert.deepEqual(readiness.approvalCheck.holds.map((hold) => hold.code), ['STORY_REVIEW_SOURCE_CHANGED', 'STORY_REVIEW_INTERVENING_COMMIT']);
  assert.equal(readiness.approvalCheck.notes, undefined, 'nothing is noted as a rejected amendment');
  assert.deepEqual(readiness.blockingCommits.commits.map((entry) => [entry.commit, entry.subject]),
    [[proposal, PROPOSE(WORK)], [head(), REJECT(WORK)]]);
  assert.match(readiness.blockingCommits.lines.join('\n'),
    /Decided after the submission: intent amendment AMD-001 \(rejected\)\. Only a rejected amendment whose proposal and rejection change nothing else may precede approval/u);
  assert.equal(refused().code, 'STORY_REVIEW_SOURCE_CHANGED', 'the gate refuses with the preview\'s first hold');
});

test('a merge commit carrying the rejection is no rejected amendment', async (t) => {
  const WORK = 'OAP-RJ2';
  const { git, head, propose, reject, publish, refused } = await amendmentStory(t, WORK);
  propose();
  const proposal = head();
  reject();
  const rejection = git('rev-parse', 'HEAD');
  // The same rejection, subject and trailers merged in: a commit with two parents is never one.
  git('reset', '-q', '--hard', proposal);
  git('merge', '-q', '--no-ff', '-m', git('log', '-1', '--format=%B', rejection), rejection);
  publish();
  const error = refused();
  assert.equal(error.code, 'STORY_REVIEW_INTERVENING_COMMIT');
  assert.deepEqual(error.details.blockingCommits.map((entry) => [entry.commit, entry.subject]),
    [[proposal, PROPOSE(WORK)], [head(), REJECT(WORK)]]);
});

test('a proposal commit that adds a file of its own is no rejected amendment', async (t) => {
  const WORK = 'OAP-RJ3';
  const { git, item, head, propose, reject, publish, refused } = await amendmentStory(t, WORK);
  propose();
  const notes = path.join(item, 'context/intent-amendments/AMD-001-notes.md');
  await writeFile(notes, 'Why the value changes.\n');
  git('add', notes);
  git('commit', '-q', '--amend', '--no-edit');
  publish();
  const proposal = head();
  reject();
  const error = refused();
  assert.equal(error.code, 'STORY_REVIEW_INTERVENING_COMMIT');
  assert.deepEqual(error.details.blockingCommits.map((entry) => [entry.commit, entry.subject]),
    [[proposal, PROPOSE(WORK)], [head(), REJECT(WORK)]]);
});

test('VS Code Reviews shows the holds the preview found and offers no approval into them', async () => {
  const vm = (await import('node:vm')).default;
  const ts = (await import('typescript')).default;
  const messages = await import('../apps/vscode/src/views/messages.ts');
  const webview = await import('../apps/vscode/src/views/webview.ts');
  const approvalsModel = await import('../apps/vscode/src/views/approvals-model.ts');
  const inboxModel = await import('../apps/vscode/src/views/inbox-model.ts');
  const source = await readFile(new URL('../apps/vscode/src/views/inbox.ts', import.meta.url), 'utf8');
  const exports = {};
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    vm.createContext({ exports, Date, require(name) {
      const modules = { vscode: {}, './approvals-model.ts': approvalsModel, './inbox-model.ts': inboxModel, './webview.ts': webview,
        './messages.ts': messages, './navigate.ts': { navigateTo() {} }, '../decisions.ts': { decisionTargetText: () => '' },
        './workspace-stories-page.ts': { workspaceStoriesHtml: () => '', storyCreatedDateHtml: () => '', STORY_FILTER_SCRIPT: '', STORY_CATALOG_STYLE: '' },
        './setup-review-repositories.ts': { capabilityProposalCheck: () => null } };
      if (name in modules) return modules[name];
      throw new Error(`Unexpected dependency: ${name}`);
    } }));
  const snapshot = (holds) => ({
    initiative: null, initiatives: [], selectedInitiativeId: null, selectedWorkId: 'OAP-9', workItems: [{ id: 'OAP-9', title: 'Held' }],
    identities: { git: { email: 'reviewer@example.com' } },
    workflow: { workItem: { id: 'OAP-9', title: 'Held', branch: 'OAP-9', workType: 'demo' }, currentPhase: 'planning', phaseOrder: ['planning'],
      status: 'in_progress', resolution: { approvalAuthorities: { reviewers: { label: 'Reviewers', allowAnyGitIdentity: true, members: [] } } },
      phases: { planning: { id: 'planning', label: 'Planning', status: 'awaiting_approval', generation: 1, artifacts: [], approvals: [],
        approvalPolicy: { authorities: ['reviewers'], minimum: 1, rejectTo: ['planning'] } } } },
    decisions: { schemaVersion: 1, workId: 'OAP-9', decisions: [], ahead: null, pending: null, skipped: [], log: [] },
    submissionReadiness: { phaseId: 'planning', phaseStatus: 'awaiting_approval', classification: 'already-submitted', lifecycleReady: false,
      currentGeneration: 1, publishedGeneration: 1, draftExists: true, draftModified: false, publicationRecorded: true, nextSkill: null, nextCommand: null,
      approvalCheck: { advisory: true, ready: !holds.some((hold) => hold.owner !== 'you-decide'), statement: 'x', holds } }
  });
  const source_changed = { code: 'STORY_REVIEW_SOURCE_CHANGED', owner: 'author-repairs', who: 'The author revises it',
    summary: "Phase 'planning' application source or tests changed after generation 1 was submitted.",
    action: { label: 'Return planning for changes.', command: 'singularity-flow reject planning --work-id OAP-9 --fetch --reason <REASON>' } };
  const [held] = approvalsModel.buildApprovals(snapshot([source_changed])).pending;
  assert.deepEqual(held.approvalHolds.map((hold) => [hold.code, hold.who]), [['STORY_REVIEW_SOURCE_CHANGED', 'The author revises it']]);
  const html = exports.inboxHtml(inboxModel.buildInbox(snapshot([source_changed])));
  assert.match(html, /<h2>Approval would be refused<\/h2>/u);
  assert.match(html, /The author revises it:<\/strong> Phase &#39;planning&#39; application source/u);
  assert.doesNotMatch(html, /data-approve=/u);
  assert.match(html, /data-reject=/u, 'requesting changes stays offered');
  // The approver's own answers are the form's business: Approve stays.
  const own = { code: 'APPROVAL_CHECKLIST_INCOMPLETE', owner: 'you-decide', who: 'You decide', summary: 'Answer the checklist.' };
  assert.deepEqual(approvalsModel.buildApprovals(snapshot([own])).pending[0].approvalHolds, []);
  assert.match(exports.inboxHtml(inboxModel.buildInbox(snapshot([own]))), /data-approve=/u);
});
