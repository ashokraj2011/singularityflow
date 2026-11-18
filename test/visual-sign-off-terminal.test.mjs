/**
 * Two follow-ups to the visual sign-off [owner, 2026-11-18]. (A) In the person's own terminal walkthrough
 * (`decisions record`, interactive) the person is there: the screenshot is asked as their step ("Take the screenshot
 * now?"), taken at SFlow's browser, and then signed off with the card's one question; it never showed up as a check
 * that "did not finish in time". (B) A Story that adopted application review names its live review as the other way to
 * satisfy the sign-off.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { decisionPacket } from '../src/decision-list.mjs';
import { withPlainWords } from '../src/decision-plain.mjs';
import { promptDecisionAnswers } from '../src/commands/decisions.mjs';
import { screenshotWalkthrough } from '../src/commands/decisions-screenshot.mjs';
import { applicationReviewRoute, signOffFile } from '../src/visual-sign-off-capture.mjs';
import { decisionsTable } from '../plugin/extensions/decisions/card.mjs';

const AT = '2026-11-18T16:40:00.000Z';
const W = 'WORK-9';
const ME = { name: 'Person', email: 'person@example.invalid' };
const AUTHORITIES = { engineering: { label: 'Engineering reviewers', allowAnyGitIdentity: true, members: [] } };
const FILE = `singularity/work-items/${W}/evidence/visual-sign-offs/WORK-9-AC-002-graph-layout-0123456789abcdef.png`;
const COMMAND = `singularity-flow decision screenshot --work-id ${W} --criterion ${W}:AC-002 --slot graph-layout`;

function story(resolution = {}) {
  return { workItem: { id: W }, status: 'in_progress', currentPhase: 'implementation', phaseOrder: ['implementation'],
    phases: { implementation: { id: 'implementation', label: 'Implementation', status: 'in_progress', generation: 1, approvals: [], approvalPolicy: { authorities: ['engineering'], minimum: 1 } } },
    resolution: { approvalAuthorities: AUTHORITIES, ...resolution }, history: [] };
}
const owed = (extra = {}) => ({ kind: 'witness', clauseId: `${W}:AC-002`, clauseText: 'The graph lays out in the Grapher workspace.', slot: 'graph-layout', method: 'visual',
  files: [], owners: ['implementation'], available: false, groups: ['engineering'], contextBinding: `sha256:${'c'.repeat(64)}`, ...extra });
const NEEDED = { status: 'needed', workId: W, file: FILE, command: COMMAND, target: 'Grapher workspace at desktop viewport', viewport: { width: 1280, height: 800 },
  build: { source: 'inferred', words: 'npm ci --no-audit --no-fund, then npm run build (inferred: package.json builds with vite build; output dist)' } };
const TAKEN = { status: 'taken', workId: W, file: FILE, again: `${COMMAND} --replace` };
const packetOf = (entry, workflow = story()) => ({ ...withPlainWords(workflow, decisionPacket(workflow, { phaseId: 'implementation', pending: { owed: [entry] } },
  { authorities: AUTHORITIES, actor: ME, at: AT })), packetSha256: `sha256:${'a'.repeat(64)}`, repositoryPath: '/repo' });
const signOff = (packet) => packet.items.find((item) => item.details?.clause === `${W}:AC-002`);
const io = (lines) => {
  const output = new PassThrough();
  let said = '';
  output.on('data', (chunk) => { said += chunk; });
  return { io: { input: Readable.from(lines.map((line) => `${line}\n`)), output }, said: () => said };
};

test('(A) the terminal walkthrough asks the person to take the screenshot, never a check that runs out of time', async () => {
  const packet = packetOf(owed({ capture: NEEDED }));
  const yes = io(['y']);
  assert.deepEqual(await promptDecisionAnswers(packet, yes.io), { screenshot: { item: signOff(packet).id, subject: `sign-off:${W}:AC-002`, take: true } });
  assert.match(yes.said(), /Take the screenshot now\? It opens your app in a browser \[y\/N\]: /u);
  // No: the command to run later, and the walk goes on; nothing is recorded.
  const no = io(['n']);
  assert.equal(await promptDecisionAnswers(packet, no.io), null);
  assert.match(no.said(), new RegExp(`Take it later yourself: ${COMMAND}`, 'u'));
  assert.doesNotMatch(no.said(), /did not finish in time/u);
  // A screenshot already taken: its sign-off is asked here too.
  const taken = packetOf(owed({ files: [FILE], available: true, command: 'singularity-flow decision witness', capture: TAKEN }));
  const sign = io(['y']);
  assert.deepEqual(await promptDecisionAnswers(taken, sign.io), { screenshot: { item: signOff(taken).id, subject: `sign-off:${W}:AC-002`, take: false } });
  assert.match(sign.said(), /Look at the screenshot and sign it off now\? \[y\/N\]: /u);
});

test('(A) taken at the browser, then signed off with the card\'s one question; r takes it again; a closed browser takes nothing', async () => {
  const before = packetOf(owed({ capture: NEEDED }));
  const after = packetOf(owed({ files: [FILE], available: true, command: 'singularity-flow decision witness', capture: TAKEN }));
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-visual-terminal-'));
  const absolute = path.join(root, FILE);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, 'png bytes');
  const shown = { ...after, repositoryPath: root };
  const takes = [], records = [], opened = [];
  const deps = { take: async (input) => { takes.push(input); }, record: async (args) => { records.push(args); return { data: { record: { id: 'WIT-001', outcome: 'met' } } }; },
    open: async (file) => { opened.push(file); } };
  try {
    const walk = io(['r', 'y', 'The grapher workspace shows the laid-out graph.']);
    const outcome = await screenshotWalkthrough(root, { workId: W, packet: before, request: { item: signOff(before).id, subject: `sign-off:${W}:AC-002`, take: true },
      reread: async () => shown, io: walk.io, deps });
    assert.deepEqual(outcome, { status: 'recorded', record: 'WIT-001' });
    assert.deepEqual(takes, [{ workId: W, clauseId: `${W}:AC-002`, slot: 'graph-layout', again: false }, { workId: W, clauseId: `${W}:AC-002`, slot: 'graph-layout', again: true }],
      'taken, then taken again (--replace) when the person said r');
    assert.deepEqual(opened, [absolute, absolute]);
    assert.match(walk.said(), /Opening your app in SFlow's browser: bring up the screen AC-002 is about, then click "Capture this screen" on SFlow's bar \(up to 10 minutes; closing the browser takes nothing\)\./u);
    assert.match(walk.said(), /Does this screenshot show what AC-002 asks for\? y = yes, n = no \(say what's wrong\), s = not sure, r = take it again \[s\]: /u);
    const args = records[0];
    assert.deepEqual(args.slice(0, 8), ['decision', 'witness', '--work-id', W, '--criterion', `${W}:AC-002`, '--slot', 'graph-layout']);
    assert.ok(args.includes('--expected-context-sha256') && args.includes(`sha256:${'c'.repeat(64)}`));
    assert.deepEqual(args.filter((word) => word === '--confirm').length, 3);
    // The browser closed before a capture: nothing taken, said, nothing recorded.
    const closed = io([]);
    const refused = await screenshotWalkthrough(root, { workId: W, packet: before, request: { item: signOff(before).id, subject: `sign-off:${W}:AC-002`, take: true },
      reread: async () => shown, io: closed.io, deps: { ...deps, take: async () => { throw Object.assign(new Error('The browser was closed before a screen was captured, so nothing was taken.'), { code: 'ARA_CAPTURE_NOT_TAKEN' }); } } });
    assert.deepEqual(refused, { status: 'not-taken' });
    assert.match(closed.said(), /No screenshot was taken: The browser was closed before a screen was captured, so nothing was taken\./u);
    assert.equal(records.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('(B) a Story that adopted application review names its live review as the other way to satisfy the sign-off', async (t) => {
  const adopted = story({ applicationReview: { mode: 'optional', surface: 'web' } });
  assert.deepEqual(applicationReviewRoute(adopted), { copilot: '/sf-app-review', command: `singularity-flow app-review start --work-id ${W} --json`,
    vscode: 'Singularity Flow: Review Application' });
  assert.equal(applicationReviewRoute(story()), null, 'no application review: as it was');
  assert.equal(applicationReviewRoute(story({ applicationReview: { mode: 'off', surface: 'web' } })), null);
  assert.equal(applicationReviewRoute(story({ applicationReview: { mode: 'optional', surface: 'library' } })), null);
  assert.equal(applicationReviewRoute(story({ applicationReview: { mode: 'optional', surface: 'web' }, presence: { status: 'required' } })), null,
    'signed person presence: the local review adapter cannot sign it');
  // The file facts carry it, and so do the terminal lines.
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-visual-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }));
  await writeFile(path.join(root, 'package-lock.json'), '{}');
  const { capture } = signOffFile({ root, config: {} }, adopted, { clauseId: `${W}:AC-002`, slot: 'graph-layout', owners: ['implementation'], row: null });
  assert.deepEqual(capture.appReview, applicationReviewRoute(adopted));
  assert.match(capture.lines.join('\n'), /Or accept it in the application review: \/sf-app-review, or singularity-flow app-review start --work-id WORK-9 --json/u);
  assert.equal(signOffFile({ root, config: {} }, story(), { clauseId: `${W}:AC-002`, slot: 'graph-layout', owners: ['implementation'], row: null }).capture.appReview, undefined);
  // On the item, beside "Take the screenshot", on every host.
  const packet = packetOf(owed({ capture: { ...NEEDED, appReview: applicationReviewRoute(adopted) } }), adopted);
  const item = signOff(packet);
  assert.equal(item.check.label, 'Take the screenshot');
  const review = item.options.find((option) => option.id === 'review');
  assert.equal(review.label, 'Or accept it in the application review');
  assert.equal(review.action.command, `singularity-flow app-review start --work-id ${W} --json`);
  assert.equal(review.words, 'Accepting its visual dimension in the live review satisfies AC-002: /sf-app-review in Copilot, Singularity Flow: Review Application in VS Code, or this command in your terminal.');
  assert.match(decisionsTable(packet), /- Or accept it in the application review, in your terminal: `singularity-flow app-review start --work-id WORK-9 --json`/u);
  // Without application review the item is as it was.
  assert.equal(signOff(packetOf(owed({ capture: NEEDED }))).options.some((option) => option.id === 'review'), false);
});
