/**
 * "Why no next action here" [owner, 2026-11-18, Story new-ash-graph]: after /sf-decide recorded the AC-002 sign-off,
 * the card ended "Nothing waits on you now." beside one visual sign-off nobody could give yet, with no next step,
 * while the planner had one: "Fix the review's findings (version 2)" (/sf-code implementation), because the
 * Implementation review found findings. Every screen ends with a next action: when nothing on the list waits on the
 * person, the list ends with the Story's own next step from the planner, on the terminal, the Copilot CLI card and
 * both VS Code pages, and after a recording leaves nothing waiting.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { decisionPacket } from '../src/decision-list.mjs';
import { withPlainWords } from '../src/decision-plain.mjs';
import { sourceReviewContinuation } from '../src/source-review-continuation.mjs';
import { packetText, storyNextFrom, waitsOnPerson, withStoryNext } from '../src/commands/decisions.mjs';
import { decisionsTable, nextWords, runCard } from '../plugin/extensions/decisions/card.mjs';
import { decideHtml } from '../apps/vscode/src/views/decide-card-page.ts';
import { buildDecisionListView } from '../apps/vscode/src/views/decision-list-model.ts';
import { decisionListHtml } from '../apps/vscode/src/views/decision-list-page.ts';
import { repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';

const W = 'NEW-ASH-GRAPH';
const AT = '2026-11-18T18:55:00.000Z';
const ME = { name: 'Person', email: 'person@example.invalid' };
const AUTHORITIES = { engineering: { label: 'Engineering reviewers', allowAnyGitIdentity: true, members: [] } };

function story() {
  const phase = { id: 'implementation', label: 'Implementation', status: 'in_progress', generation: 1, approvals: [], approvalPolicy: { authorities: ['engineering'], minimum: 1 },
    generationPolicy: { requirement: 'required', defaultProducer: 'governed-agent', task: 'code' }, requiredArtifact: { path: 'artifacts/implementation/summary.md' },
    generationIntent: { status: 'consumed', generation: 1 }, generationPublications: [{ generation: 1, record: { path: 'context/implementation-gen1.json' } }] };
  return { workItem: { id: W, workType: 'custom' }, status: 'in_progress', currentPhase: 'implementation', phaseOrder: ['implementation'], phases: { implementation: phase },
    history: [], witnessRecords: [{ id: 'WIT-001', clauseId: `${W}:AC-002`, slot: 'layout-structure', outcome: 'met' }],
    resolution: { approvalAuthorities: AUTHORITIES, sourceReview: { mode: 'enforce', level: 2, phases: ['implementation'], kinds: { implementation: 'code' }, reviewerAgent: 'sflow-source-reviewer' } } };
}
// The review the planner read: correction required, one blocking finding.
const REVIEW = { status: 'correction-required', reportSha256: 'a'.repeat(64), pendingDispositions: [],
  report: { binding: { sources: [] }, findings: [{ id: 'F-1', severity: 'blocking', check: 'tests', message: 'AC-001 has no test.' }] },
  findings: [{ code: 'reviewer-blocker', reviewFindingId: 'F-1', message: "Reviewer finding 'F-1': AC-001 has no test." }] };
// After WIT-001: one visual sign-off left that nobody can give yet (its screenshot is a later step's).
const OWED = [{ kind: 'witness', clauseId: `${W}:AC-002`, slot: 'labeled-grid', method: 'visual', files: [`singularity/work-items/${W}/evidence/grid.png`],
  owners: ['implementation'], available: false, groups: ['engineering'], contextBinding: `sha256:${'c'.repeat(64)}` }];

async function incident() {
  const workflow = story();
  const now = { timing: 'now', ...sourceReviewContinuation(workflow, workflow.phases.implementation, REVIEW).actions[0] };
  const list = { ...withPlainWords(workflow, decisionPacket(workflow, { phaseId: 'implementation', pending: { owed: OWED } }, { authorities: AUTHORITIES, actor: ME, at: AT })),
    packetSha256: `sha256:${'a'.repeat(64)}`, repositoryPath: '/repo' };
  return { list, packet: withStoryNext(list, await storyNextFrom(now, workflow)) };
}

const NEXT = 'Next: Fix the review\'s findings (version 2): /sf-code implementation (or in your terminal: singularity-flow phase rollover implementation --json).';
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/gu, '').replace(/<[^>]+>/gu, ' ').replace(/&#39;/gu, '\'').replace(/&quot;/gu, '"').replace(/&amp;/gu, '&').replace(/\s+/gu, ' ');

test('the incident: nothing waits on the person, so the list ends with the planner\'s "Fix the review\'s findings (version 2)"', async () => {
  const { list, packet } = await incident();
  assert.equal(list.plain.headline, 'Nothing waits on you now.');
  assert.equal(waitsOnPerson(list), false);
  assert.deepEqual(packet.storyNext, { kind: 'story-next', title: 'Fix the review\'s findings (version 2)', command: 'singularity-flow phase rollover implementation --json',
    copilotCommand: '/sf-code implementation' });
  assert.equal(packet.next, packet.storyNext, 'the list\'s own "see nextsteps" pointer gives way to the step itself');
  // Terminal: the last lines.
  assert.deepEqual(packetText(packet).trimEnd().split('\n').slice(-4), ['Next: Fix the review\'s findings (version 2)', '  - Copilot: /sf-code implementation',
    '  - Shell: singularity-flow phase rollover implementation --json', '  - VS Code (model-free): not available for this action']);
  // Copilot CLI: the table and the card's last words.
  assert.equal(nextWords(packet), NEXT);
  assert.match(decisionsTable(packet), new RegExp(`\\*\\*${NEXT.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')}\\*\\*$`, 'u'));
  for (const askedInChat of [false, true]) {
    const result = await runCard({ askedInChat, read: async () => packet, show: async () => {}, ask: async () => ({ action: 'cancel' }),
      record: async () => assert.fail('nothing to record'), witness: async () => assert.fail('nothing to sign'), inspect: async () => {} });
    assert.ok(result.message.endsWith(NEXT), result.message);
    assert.deepEqual(result.next, packet.storyNext);
  }
  // VS Code: the Decide card's last row, with its terminal button, and the Decisions page.
  assert.ok(text(decideHtml(packet)).includes(NEXT));
  assert.match(decideHtml(packet), /data-next>Put it in a terminal<\/button>/u);
  const page = decisionListHtml(buildDecisionListView(packet));
  assert.ok(text(page).includes(NEXT));
  assert.match(page, /data-action="copy-next"/u);
});

test('something that waits on the person keeps the list as it was: no next step is added over it', async () => {
  const { list } = await incident();
  const asked = { ...list, items: [{ ...list.items[0], plain: { question: 'Approve it?' }, decidedBy: { allowed: true } }] };
  assert.equal(waitsOnPerson(asked), true);
  // A list whose next step is the list itself adds nothing either.
  assert.equal(await storyNextFrom({ timing: 'now', command: `singularity-flow decisions ${W}`, copilotCommand: `/sf-decide ${W}` }), null);
});

test('the decisions command ends a list nothing waits on with the planner\'s own "now", the same nextsteps gives', { timeout: 300_000 }, async (t) => {
  const repo = await repository(t, { implementCommands: false });
  await startQuickFix(repo);
  const now = repo.sflowJson('nextsteps', 'QF-1').value.actions.find((entry) => entry.timing === 'now');
  assert.ok(now, 'the planner has a step now');
  const read = repo.sflowJson('decisions', 'QF-1');
  assert.equal(read.status, 0, JSON.stringify(read.value));
  const { storyNext } = read.value.data;
  assert.ok(storyNext, JSON.stringify(read.value.data.headline));
  assert.equal(storyNext.command, now.command);
  assert.match(repo.sflow('decisions', 'QF-1', '--no-probe'), new RegExp(`Next: ${storyNext.title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\n  - Copilot: `, 'u'));
});
