/**
 * The VS Code Decide card says what the terminal and the Copilot CLI card say after a pin or plan amendment changed the
 * open code step after its summary was written: update the summary before prepublishing [owner, 2026-11-13].
 *
 * The card runs here against a `vscode` stub, as in vscode-sf-guard.test.mjs, with a client that answers the list and
 * the record the way `decisions record --json` does. The note's words come from the engine's own
 * summaryUpdateAfterDecision on a checkout whose summary predates the pin, so the card and the CLI cannot drift apart.
 *
 * And how a card a chat opened ends when only the step's approval is left [owner's Story, 2026-11-20]: VS Code's
 * /sf-approve sent its chat to this card, the card answered "nothing to decide" with /sf-approve as next, and the chat
 * asked for the approval again. Now the approval page opens on that Story and step, and the chat is handed no approve
 * route: the ratchet below fails on any /sf-approve, `approve` or @sflow /approve in what the chat gets back.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import { summaryUpdateAfterDecision } from '../src/summary-step-changes.mjs';
import { decisionPacket } from '../src/decision-list.mjs';
import { withPlainWords } from '../src/decision-plain.mjs';
import { withStoryNext } from '../src/commands/decisions.mjs';

const panels = [];
const shown = [];
const executed = [];
// What a command answers, by its ID: the approval page's panel, for the Story it shows [hardening C, F4].
const answers = {};
globalThis.__decideSummaryNoteVscode = {
  ViewColumn: { Active: 1, Beside: 2 },
  Uri: { file: (fsPath) => ({ fsPath }), joinPath: () => ({}) },
  commands: { executeCommand: async (id, ...args) => { executed.push([id, ...args]); return answers[id]?.(...args); }, getCommands: async () => [] },
  env: { clipboard: { writeText: async () => undefined } },
  workspace: { workspaceFolders: [{ uri: { fsPath: os.tmpdir() } }], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  window: {
    createWebviewPanel: (viewType, title) => {
      let receive = () => {};
      let disposed = () => {};
      const panel = {
        viewType, title, visible: true,
        webview: { html: '', cspSource: 'vscode-resource:', onDidReceiveMessage(listener) { receive = listener; return { dispose() {} }; } },
        post: (message) => receive(message),
        onDidDispose(listener) { disposed = listener; return { dispose() {} }; },
        reveal() {}, dispose() { if (!panel.visible) return; panel.visible = false; disposed(); }
      };
      panels.push(panel);
      return panel;
    },
    showInformationMessage: async (message) => { shown.push(message); },
    setStatusBarMessage: () => ({ dispose() {} }),
    showErrorMessage: async () => undefined
  }
};
const vscodeShim = 'data:text/javascript,' + encodeURIComponent(`
  const api = globalThis.__decideSummaryNoteVscode;
  export const ViewColumn = api.ViewColumn, Uri = api.Uri, commands = api.commands, env = api.env, workspace = api.workspace, window = api.window;
`);
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: ${JSON.stringify(vscodeShim)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`));
// The card's module graph holds a class Node's type stripping cannot load, so it is bundled first, `vscode` left to the stub.
const bundled = await mkdtemp(path.join(os.tmpdir(), 'sflow-decide-card-bundle-'));
test.after(() => rm(bundled, { recursive: true, force: true }));
await build({ entryPoints: ['decide-card', 'approvals'].map((name) => fileURLToPath(new URL(`../apps/vscode/src/views/${name}.ts`, import.meta.url))), bundle: true, platform: 'node',
  format: 'esm', external: ['vscode'], outdir: bundled, outExtension: { '.js': '.mjs' }, logLevel: 'silent' });
const { reviewDecisions } = await import(pathToFileURL(path.join(bundled, 'decide-card.mjs')).href);
const approvalsPage = await import(pathToFileURL(path.join(bundled, 'approvals.mjs')).href);
const model = await import('../apps/vscode/src/views/decision-list-model.ts');
const cardPage = await import('../apps/vscode/src/views/decide-card-page.ts');

const W = 'W-1';
const DIGEST = `sha256:${'7'.repeat(64)}`;
const SUMMARY = 'singularity/work-items/W-1/artifacts/implementation/implementation-summary.md';
const REASON = 'The Vitest suite needs Node 22; the code does not change.';

// The open code step whose summary (minute 5) predates the person's pin (minute 10), as in summary-step-changes.test.mjs.
async function summaryUpdate(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-decide-note-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = Date.parse('2026-11-13T10:00:00.000Z');
  const at = (minutes) => new Date(started + minutes * 60_000);
  const write = async (relative, text, minutes) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
    await utimes(path.join(root, relative), at(minutes), at(minutes));
  };
  await write(SUMMARY, '# Implementation summary\n\nNo `.nvmrc` was added.\n', 5);
  await write('.nvmrc', '22\n', 10);
  const workflow = { workItem: { id: W }, currentPhase: 'implementation',
    planAmendments: [{ id: 'PAM-001', at: at(10).toISOString(), reason: REASON,
      changes: [{ kind: 'add-supporting', path: '.nvmrc', class: 'build-configuration', reason: REASON }] }],
    phases: { implementation: { id: 'implementation', status: 'in_progress', generation: 0, generationPolicy: { task: 'code' },
      requiredArtifact: { path: 'artifacts/implementation/implementation-summary.md' },
      generationIntent: { status: 'open', generation: 1, startedAt: at(0).toISOString() } } } };
  const update = await summaryUpdateAfterDecision(root, {}, workflow);
  assert.ok(update, 'the engine asks for the summary update');
  return update;
}

const packet = () => ({
  schemaVersion: 1, resultType: 'sflow-decisions', revision: 'decision-list-v1', workId: W, phase: 'implementation', phaseLabel: 'Code',
  status: 'decisions-needed', headline: "Code can't be approved yet: 1 decision needed.", rule: 'Keep the honest verdict.',
  items: [{
    id: 'd1', kind: 'node-pin', title: 'The tests failed on Node 26.1.0',
    why: 'package.json asks for Node >=20 <25. It passes on Node 22.14.0.',
    options: [{ id: 'pin-node', label: 'Pin Node 22: create .nvmrc and amend the plan', recommended: true,
      words: 'Creates .nvmrc holding 22 in this checkout and lists it in the plan as a supporting change.',
      effects: [{ kind: 'node-pin', version: '22' }], needs: { reason: { default: REASON, minimum: 20, maximum: 1000 } },
      decidedBy: { groups: ['engineering-reviewers'], labels: ['Engineering reviewers'], allowed: true, words: 'You may decide this.' } }],
    decidedBy: { groups: ['engineering-reviewers'], labels: ['Engineering reviewers'], allowed: true, words: 'You may decide this.' }
  }],
  packetSha256: DIGEST,
  record: { form: `singularity-flow decisions record ${W} --choose <ITEM>=<OPTION> --confirm ${DIGEST}`, recommended: null,
    interactive: `singularity-flow decisions record ${W}`, share: `/sf-decide ${W}` }
});

// What `decisions record --json` returns after the pin, with the engine's own summaryUpdate (src/commands/decisions.mjs).
const recordedWith = (update) => ({ resultType: 'command-result', data: {
  recorded: [{ item: 'd1', kind: 'node-pin', record: 'PAM-001' }], decided: [{ item: 'd1', words: 'Pin Node 22' }], refused: [], remaining: [],
  summaryUpdate: update, agentInstruction: update.words, packetSha256: null } });

function client(update) {
  const runs = [];
  return {
    runs, repository: os.tmpdir(), invalidateReads() {},
    run: async (argv) => {
      runs.push(argv);
      return argv.includes('record') ? recordedWith(update) : { resultType: 'command-result', data: packet() };
    }
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the record\'s summary note reaches the person and the chat\'s agent', async (t) => {
  const update = await summaryUpdate(t);
  const outcome = model.decisionRecordOutcome(recordedWith(update)).outcome;
  assert.equal(outcome.summaryUpdate, update.words);
  assert.ok(outcome.message.endsWith(` ${update.words}`), outcome.message);
  // Without the note, the outcome is as before: no field, no words.
  const plain = model.decisionRecordOutcome({ data: { recorded: [{ item: 'd1', kind: 'node-pin', record: 'PAM-001' }], refused: [], remaining: [] } }).outcome;
  assert.equal('summaryUpdate' in plain, false);
  assert.equal(plain.message, 'Recorded 1 record from your choices.');
});

test('the Decide card returns the summary note to the chat after recording a pin', async (t) => {
  const update = await summaryUpdate(t);
  const cli = client(update);
  panels.length = 0;
  const result = reviewDecisions(cli, { workId: W }, async () => undefined, { askedInChat: true });
  await settle();
  const card = panels.find((panel) => panel.viewType === 'singularityFlow.decide');
  assert.ok(card, 'the card opened');
  assert.match(card.webview.html, /Pin Node 22: create \.nvmrc and amend the plan/u);
  card.post({ type: 'decide.review', rows: [{ item: 'd1', option: 'pin-node', reason: REASON, title: 'The tests failed on Node 26.1.0' }] });
  // The card writes the answers file and reads SF Guard's card for it before it asks (presence/card-channel.mjs).
  for (const started = Date.now(); Date.now() - started < 5_000 && !panels.some((panel) => panel.viewType === 'singularityFlow.reviewConfirmation');) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const confirmation = panels.find((panel) => panel.viewType === 'singularityFlow.reviewConfirmation');
  assert.ok(confirmation, 'the person confirms what is recorded');
  confirmation.post({ type: 'confirmation.accept', acknowledged: true });
  const answer = await result;
  assert.ok(cli.runs.some((argv) => argv.includes('record')), 'recorded through the CLI');
  assert.equal(answer.status, 'recorded');
  assert.equal(answer.summaryUpdate, update.words, 'the chat\'s agent is told to update the summary');
  assert.match(answer.message, /^1 decision recorded\. Pin Node 22\. All decided\. This changed implementation after its summary was written \(PAM-001: \.nvmrc\)\./u);
  assert.equal(answer.message.split(update.words).length, 2, 'said once');
});

// ---- A chat-opened card with only the approval left [owner's Story, 2026-11-20] ----

const P = 'PLAN-1';
const AUTHORITIES = { planners: { label: 'Planners', allowAnyGitIdentity: true, members: [] } };
const ME = { name: 'Person', email: 'person@example.invalid' };
// Any route that approves, in what a chat gets back: Copilot's, VS Code's chat participant's and the terminal's.
const APPROVE_ROUTE = /\/sf-approve|@sflow \/approve|\b(?:singularity-flow|sflow) approve\b/u;
// With the page open the chat offers no command at all: the person approves or sends it back there [owner, 2026-11-28].
const PAGE_WORDS = 'The approval page is open for Planning v1 with its documents. The person approves or sends it back there; this chat records nothing and offers no command.';
// The one approve route a chat is handed: the person's own model-free @sflow /approve, as `next`, beside the page [owner's
// Story arshy, 2026-11-20: an approve turn ended with no route]. Anything else that approves is the chat sent round again.
const PERSON_APPROVE = { kind: 'approve-in-chat', title: 'Approve Planning v1 yourself: type this in the chat box', command: null, copilotCommand: null,
  modelFreeCommand: `@sflow /approve planning --work-id ${P}` };
const noAgentApprove = (result, message) => assert.doesNotMatch(JSON.stringify({ ...result, next: result.next?.kind === 'approve-in-chat' ? null : result.next }), APPROVE_ROUTE, message);

/** The engine's own list for a Planning step awaiting approval with nothing else open: only the approval row. */
function approvalOnly({ storyNext = null } = {}) {
  const workflow = { workItem: { id: P, workType: 'custom' }, status: 'in_progress', currentPhase: 'planning', phaseOrder: ['planning', 'implementation'], history: [],
    phases: { planning: { id: 'planning', label: 'Planning', status: 'awaiting_approval', generation: 1, approvals: [], approvalPolicy: { authorities: ['planners'], minimum: 1 },
      artifacts: [{ path: `singularity/work-items/${P}/artifacts/planning/plan.md` }] },
    implementation: { id: 'implementation', label: 'Implementation', status: 'pending', generation: 0 } },
    resolution: { approvalAuthorities: AUTHORITIES } };
  const list = { ...withPlainWords(workflow, decisionPacket(workflow, { phaseId: 'planning' }, { authorities: AUTHORITIES, actor: ME, at: '2026-11-20T09:00:00.000Z' })), repositoryPath: '/repo' };
  return withStoryNext(list, storyNext);
}
// The planner's "now" for a step awaiting approval, when one is read beside the list: an approve route too.
const PLANNER_APPROVE = { kind: 'story-next', title: 'Review and approve Planning', command: `singularity-flow approve planning --work-id ${P} --fetch`,
  copilotCommand: `/sf-approve planning --work-id ${P}`, modelFreeCommand: `@sflow /approve planning --work-id ${P}` };

function listClient(lists, recorded = null) {
  const runs = [];
  let read = 0;
  return {
    runs, repository: os.tmpdir(), invalidateReads() {},
    run: async (argv) => {
      runs.push(argv);
      if (argv.includes('record')) return recorded;
      // SF Guard's card: none from this engine, so the confirmation is today's.
      if (argv[0] !== 'decisions') throw new Error('not here');
      return { resultType: 'command-result', data: lists[Math.min(read++, lists.length - 1)] };
    }
  };
}
const approvalsOpened = () => executed.filter(([id]) => id === 'singularityFlow.openApprovals');

test('the incident\'s list: only the approval waits, and its own next step is /sf-approve', () => {
  const list = approvalOnly();
  assert.deepEqual(list.items.map((item) => item.kind), ['approval']);
  assert.equal(list.items[0].details.ready, true);
  assert.equal(list.items[0].decidedBy.allowed, true);
  assert.equal(cardPage.readyApproval(list), list.items[0]);
  // What the chat was handed back before: the route that sent it to this card.
  assert.match(JSON.stringify(list.next), APPROVE_ROUTE);
  assert.equal(cardPage.approvesRoute(list.next), true);
  assert.equal(cardPage.chatNext(list.next), null);
  assert.equal(cardPage.approvesRoute(PLANNER_APPROVE), true);
  // The card itself is never a chat's next step either; another step is kept as it is.
  assert.equal(cardPage.chatNext({ kind: 'decide-card', title: 'Open the Decide card', command: `singularity-flow decisions record ${P}`, copilotCommand: `/decide ${P}` }), null);
  const code = { kind: 'story-next', title: 'Write the code', command: 'singularity-flow phase work implementation', copilotCommand: '/sf-code implementation' };
  assert.equal(cardPage.chatNext(code), code);
});

test('ratchet: a chat-opened card with only a ready approval opens the approval page and hands back no approve route at all', async () => {
  for (const storyNext of [null, PLANNER_APPROVE]) {
    const list = approvalOnly({ storyNext });
    panels.length = 0; executed.length = 0;
    const result = await reviewDecisions(listClient([list]), { workId: P }, async () => undefined, { askedInChat: true });
    assert.deepEqual(result, { status: 'approval-open', message: PAGE_WORDS, next: null });
    noAgentApprove(result, 'the chat was sent back to an approve route');
    assert.deepEqual(approvalsOpened(), [['singularityFlow.openApprovals', { workId: P, phase: 'planning' }]], 'the approval page opens on this Story and step');
    assert.equal(panels.some((panel) => panel.viewType === 'singularityFlow.decide'), false, 'no Decide card with nothing on it');
  }
});

test('a held approval says why, and one that is plainly someone else\'s names who and where to see them; neither hands a chat an approve route of its own or opens', async () => {
  const base = approvalOnly();
  const approval = base.items[0];
  const held = { ...base, items: [{ ...approval, why: '0 of 1 approvals recorded. It waits for the review of the plan first.', details: { ...approval.details, ready: false } }] };
  panels.length = 0; executed.length = 0;
  const waiting = await reviewDecisions(listClient([held]), { workId: P }, async () => undefined, { askedInChat: true });
  assert.equal(waiting.status, 'nothing-to-decide');
  assert.match(waiting.message, /It waits for the review of the plan first\./u);
  // Held: the person's own @sflow /approve, which says what holds it and approves it once cleared, never no route.
  assert.deepEqual(waiting.next, PERSON_APPROVE);
  noAgentApprove(waiting);
  assert.deepEqual(approvalsOpened(), []);
  // Someone else's, as the engine says it (its groups named): who, and the route to see and ask them [hardening C].
  const theirs = { ...base, items: [{ ...approval, decidedBy: { ...approval.decidedBy, allowed: false, people: ['Pat'], words: 'The Planners (Pat) decide this; ask them.', share: `/sf-decide ${P}` } }] };
  const result = await reviewDecisions(listClient([theirs]), { workId: P }, async () => undefined, { askedInChat: true });
  assert.deepEqual(result, { status: 'approval-by-others', message: 'The Planners (Pat) decide this; ask them. They approve it on their own approval page.',
    next: { kind: 'approvers', title: `See who approves ${P} and ask them`, command: `singularity-flow approvals ${P}`, copilotCommand: `/sf-approvals ${P}`,
      modelFreeCommand: 'Command Palette: Singularity Flow: Approvals' } });
  noAgentApprove(result);
  assert.deepEqual(approvalsOpened(), []);
});

test('an approval whose approver the read could not establish opens the approval page, which checks it when the person approves', async () => {
  // Owner's Story arshy, 2026-11-20: VS Code's /sf-approve reached a ready approval with no holds, #sflowDecide answered
  // "nothing to decide" because the row's decidedBy.allowed was not true, and the chat ended with no route. Only an explicit
  // false, with the read sure who the person is and who approves named, is someone else's.
  const base = approvalOnly();
  const approval = base.items[0];
  const { allowed: ignored, ...noAllowed } = approval.decidedBy;
  for (const decidedBy of [noAllowed, { ...approval.decidedBy, allowed: false, established: false, words: 'SFlow could not tell here whether you are one of the Planners: it checks that when you do this.' },
    { allowed: false, words: 'Singularity Flow cannot say who decides this.' }]) {
    const list = { ...base, items: [{ ...approval, decidedBy }] };
    assert.equal(cardPage.readyApproval(list), list.items[0], JSON.stringify(decidedBy));
    panels.length = 0; executed.length = 0;
    const result = await reviewDecisions(listClient([list]), { workId: P }, async () => undefined, { askedInChat: true });
    assert.deepEqual(result, { status: 'approval-open', message: PAGE_WORDS, next: null }, JSON.stringify(decidedBy));
    assert.deepEqual(approvalsOpened(), [['singularityFlow.openApprovals', { workId: P, phase: 'planning' }]]);
  }
});

test('a person who opened the card sees the approval row, and its button opens the approval page itself on this Story and step', async () => {
  panels.length = 0; executed.length = 0;
  const result = reviewDecisions(listClient([approvalOnly()]), { workId: P }, async () => undefined);
  await settle();
  const card = panels.find((panel) => panel.viewType === 'singularityFlow.decide');
  assert.ok(card, 'the card opened with its approval row');
  assert.match(card.webview.html, /data-approval="d1">Review and approve<\/button>/u);
  assert.deepEqual(approvalsOpened(), [], 'nothing opens before the person clicks');
  card.post({ type: 'decide.approval' });
  await settle();
  // The approval page itself, never the Approvals list first, whose Approve opened this card's loop [owner, 2026-11-28].
  assert.deepEqual(approvalsOpened(), []);
  const approve = executed.filter(([id]) => id === 'singularityFlow.approve');
  assert.deepEqual(approve.map(([, node]) => node.approve), [{ kind: 'story', workId: P, phaseId: 'planning', expected: 'planning', summary: `Approve ${P} / Planning` }]);
  card.post({ type: 'decide.cancel' });
  assert.equal((await result).status, 'cancelled');
});

test('ratchet: once a chat-opened card records the last decision, the approval page opens and the chat gets no approve route but the person\'s own @sflow /approve', async () => {
  const after = approvalOnly();
  const approval = after.items[0];
  const row = packet().items[0];
  const before = { ...after, items: [{ ...row, id: 'd1' }, { ...approval, id: 'd2', why: '0 of 1 approvals recorded. It waits for d1 first.', details: { ...approval.details, heldBy: ['d1'], ready: false } }],
    packetSha256: DIGEST };
  // What `decisions record --json` returns once the pin is recorded: `remaining` is the list read after it, item by item, its
  // approval row included (src/commands/decisions.mjs: after.items.map(({ id, kind, title }))).
  const remaining = after.items.map((item) => ({ id: item.id, kind: item.kind, title: item.title }));
  assert.deepEqual(remaining, [{ id: 'd1', kind: 'approval', title: 'Approve Planning' }]);
  const recorded = { resultType: 'command-result', data: { recorded: [{ item: 'd1', kind: 'node-pin', record: 'PAM-001' }], decided: [{ item: 'd1', words: 'Pin Node 22' }],
    refused: [], remaining, packetSha256: after.packetSha256 } };
  assert.deepEqual(model.decisionRecordOutcome(recorded).outcome.approvalLeft, ['d1: Approve Planning'], 'the approval is told apart from what is still open');
  const cli = listClient([before, after], recorded);
  panels.length = 0; executed.length = 0;
  const result = reviewDecisions(cli, { workId: P }, async () => undefined, { askedInChat: true });
  await settle();
  const card = panels.find((panel) => panel.viewType === 'singularityFlow.decide');
  assert.ok(card, 'the card opened for the decision before the approval');
  card.post({ type: 'decide.review', rows: [{ item: 'd1', option: 'pin-node', reason: REASON, title: row.title }] });
  for (const started = Date.now(); Date.now() - started < 5_000 && !panels.some((panel) => panel.viewType === 'singularityFlow.reviewConfirmation');) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const confirmation = panels.find((panel) => panel.viewType === 'singularityFlow.reviewConfirmation');
  assert.ok(confirmation, 'the person confirms what is recorded');
  confirmation.post({ type: 'confirmation.accept', acknowledged: true });
  const answer = await result;
  assert.ok(cli.runs.some((argv) => argv.includes('record')), 'recorded through the CLI');
  assert.equal(answer.status, 'approval-open');
  assert.equal(answer.next, null, 'the page is open: no command');
  assert.deepEqual(answer.remaining, [], 'the approval is on its page, not a decision still open');
  assert.equal(answer.message, `1 decision recorded. Pin Node 22. All decided. ${PAGE_WORDS}`);
  assert.doesNotMatch(answer.message, /Still open|Approve Planning/u);
  noAgentApprove(answer, 'the chat was sent back to an approve route');
  assert.deepEqual(approvalsOpened(), [['singularityFlow.openApprovals', { workId: P, phase: 'planning' }]]);
});

test('the approval page marks the Story and step it was opened for, and says so when this window holds another Story', async () => {
  const card = { id: 'story-phase:planning', kind: 'phase', phase: 'planning', subject: 'phase', label: 'Planning — Story phase', detail: `Version 1 of ${P}`, standing: 'yours',
    chain: [], authorities: ['Planners'], signatures: [], selfApproval: false, reason: null, heldBy: null, approvalHolds: [], afterApproval: null };
  const approvals = { initiativeId: P, actor: ME.email, pending: [card], obstacles: [], empty: null };
  assert.deepEqual(approvalsPage.approvalFocusOf({ workId: P, phase: 'planning' }), { workId: P, phase: 'planning' });
  for (const junk of [undefined, null, 'planning', { workId: P }, { workId: '../x', phase: 'planning' }, { workId: P, phase: 'a b' }]) assert.equal(approvalsPage.approvalFocusOf(junk), null);
  const focused = approvalsPage.approvalsBodyHtml(approvals, null, { workId: P, phase: 'planning' });
  assert.match(focused, /<article class="card yours focus" data-focus aria-current="true">/u);
  assert.doesNotMatch(approvalsPage.approvalsBodyHtml(approvals), /data-focus|class="callout" role="status"/u, 'opened plainly, the page is as before');
  const other = approvalsPage.approvalsBodyHtml(approvals, null, { workId: 'OTHER-2', phase: 'planning' });
  assert.match(other, /OTHER-2 is not the Story checked out in this window \(PLAN-1 is\): select it here to approve it\. <button class="secondary" data-show-story>Open Stories<\/button>/u);
  assert.deepEqual(approvalsPage.approvalFocusShown(approvals, { workId: 'OTHER-2', phase: 'planning' }), { status: 'elsewhere', story: P });
  assert.deepEqual(approvalsPage.approvalFocusShown(approvals, { workId: P, phase: 'planning' }), { status: 'here', story: P });
  // Still reading the window's Story: nothing is said about another one.
  assert.doesNotMatch(approvalsPage.approvalsBodyHtml(approvals, null, { workId: 'OTHER-2', phase: 'planning' }, { reading: true }), /not the Story checked out/u);
  assert.doesNotMatch(other, /data-focus/u);
  // An open page is brought to the step it is asked for, not opened twice.
  const store = { current: { snapshot: null, error: null, stale: false }, acquireSlices: async () => ({ dispose() {} }), onDidChange: () => ({ dispose() {} }) };
  panels.length = 0;
  const shownPanel = await approvalsPage.ApprovalsPanel.show({ extensionUri: {} }, store, () => {});
  const again = await approvalsPage.ApprovalsPanel.show({ extensionUri: {} }, store, () => {}, null, { workId: 'OTHER-2', phase: 'planning' });
  assert.equal(again, shownPanel);
  assert.equal(panels.filter((panel) => panel.viewType === 'singularityFlow.approvals').length, 1);
  shownPanel.dispose();
});

test('ratchet: the approval page on a window that shows another Story is never "open" to the chat: approval-elsewhere, with the Stories route', async () => {
  // [hardening C, F4] ApprovalsPanel.show answered, and the card said "The approval page is open for Planning v1", while the
  // page itself said this window holds another Story: a dead end that said the opposite of what the page showed.
  const shows = (story) => (target) => ({ focusShown: () => approvalsPage.approvalFocusShown({ initiativeId: story, actor: null, pending: [], obstacles: [], empty: null },
    approvalsPage.approvalFocusOf(target)) });
  try {
    answers['singularityFlow.openApprovals'] = shows('OTHER-2');
    panels.length = 0; executed.length = 0;
    const result = await reviewDecisions(listClient([approvalOnly()]), { workId: P }, async () => undefined, { askedInChat: true });
    assert.equal(result.status, 'approval-elsewhere');
    assert.doesNotMatch(result.message, /The approval page is open/u);
    assert.equal(result.message, 'PLAN-1\'s approval of Planning v1 is not on the approval page: this VS Code window shows OTHER-2. The person selects PLAN-1 here with the page\'s "Open Stories" button, or Command Palette: Singularity Flow: Stories, then Attach. Then they approve it on the approval page; this chat records nothing.');
    assert.deepEqual(result.next, { kind: 'select-story', title: 'Show PLAN-1 in this VS Code window', command: null, copilotCommand: null, modelFreeCommand: 'Command Palette: Singularity Flow: Stories' });
    assert.doesNotMatch(JSON.stringify(result), APPROVE_ROUTE);
    // The same window showing this Story: open, as before.
    answers['singularityFlow.openApprovals'] = shows(P);
    assert.deepEqual(await reviewDecisions(listClient([approvalOnly()]), { workId: P }, async () => undefined, { askedInChat: true }), { status: 'approval-open', message: PAGE_WORDS, next: null });
  } finally { delete answers['singularityFlow.openApprovals']; }
});

test('a chat that asks while the card is open waits for it and gets the person\'s answer there, never "busy"', async () => {
  // [hardening C, F5] A card left open (the Command Palette's, or an earlier turn's) made every chat call answer busy with
  // nothing to follow, and the skill went on to ask the same items beside the open page.
  panels.length = 0; executed.length = 0;
  const update = { words: 'unused' };
  const palette = reviewDecisions(client(update), { workId: W }, async () => undefined);
  await settle();
  const chat = reviewDecisions(client(update), { workId: W }, async () => undefined, { askedInChat: true });
  await settle();
  assert.equal(panels.filter((panel) => panel.viewType === 'singularityFlow.decide').length, 1, 'no second card');
  panels.find((panel) => panel.viewType === 'singularityFlow.decide').post({ type: 'decide.cancel' });
  assert.deepEqual(await palette, { status: 'cancelled', message: 'No decision was recorded.' });
  assert.deepEqual(await chat, { status: 'cancelled', message: 'The Decide card for W-1 was already open; this is what the person did there. No decision was recorded.' });
});
