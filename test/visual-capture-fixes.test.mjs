/**
 * Three faults of the visual sign-off's screenshot, seen live on a real Story's approval [owner, 2026-11-18]:
 *
 * 1. `decision screenshot` refused "This checkout has code nobody published (test-results/.last-run.json)": Playwright's
 *    own untracked output. SFlow builds Git's own files only, so nothing untracked is built, and it refuses only for a
 *    tracked application file changed and not published, named; a tool's output is never application code.
 * 2. The slot's target was "Grapher mode at desktop and narrow viewports", and SFlow opened one 1280×800 viewport. Every
 *    size the target names (or the Story's pinned visual profiles) is captured, from the screen the person brought up,
 *    side by side in the one file the sign-off shows; the bar says which sizes.
 * 3. /sf-approve's next action for the sign-off said "Copilot: no verified equivalent" while /sf-decide <Story> was
 *    exactly that route: a sign-off's screenshot is the Decide card's ("Take the screenshot"), so its Copilot route is
 *    /sf-decide everywhere.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { approvalHold } from '../src/approval-check.mjs';
import { applicationReviewSnapshot } from '../src/application-review-read.mjs';
import { decisionPacket, pendingSummary } from '../src/decision-list.mjs';
import { withPlainWords } from '../src/decision-plain.mjs';
import { decodePngRgba8, encodePngRgba8 } from '../src/png-rgba8.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { NARROW_VIEWPORT, signOffViewports, sizeWords } from '../src/visual-sign-off-capture.mjs';
import { sideBySide, unpublishedApplicationFiles } from '../src/visual-sign-off-screenshot.mjs';
import { VSCODE_DECIDE_CARD } from '../src/model-free-commands.mjs';
import { packetText, withStoryNext } from '../src/commands/decisions.mjs';
import { repository } from './helpers/run-and-test-fixture.mjs';

const W = 'GRAPH-1';
const AT = '2026-11-18T21:00:00.000Z';
const ME = { name: 'Person', email: 'person@example.invalid' };
const AUTHORITIES = { engineering: { label: 'Engineering reviewers', allowAnyGitIdentity: true, members: [] } };
const SHOT = `singularity-flow decision screenshot --work-id ${W} --criterion ${W}:AC-002 --slot layout-structure`;

test('1. an untracked test run output is never code nobody published, and the screenshot builds only Git\'s files', async (t) => {
  const repo = await repository(t, { implementCommands: false });
  await mkdir(path.join(repo.root, 'test-results'), { recursive: true });
  await writeFile(path.join(repo.root, 'test-results/.last-run.json'), '{"status":"passed","failedTests":[]}\n');
  await writeFile(path.join(repo.root, 'src/scratch.mjs'), 'export const scratch = 1;\n');
  assert.deepEqual(await unpublishedApplicationFiles(repo.root, {}, {}), [], 'untracked files are not what the screenshot builds');
  const built = await applicationReviewSnapshot(repo.root, {}, {}, { trackedOnly: true });
  assert.ok(!built.manifest.some((entry) => ['test-results/.last-run.json', 'src/scratch.mjs'].includes(entry.path)), JSON.stringify(built.manifest.map((entry) => entry.path)));
  // A tracked application file changed and not committed is named; a tracked tool output is not.
  const tracked = repo.must('git', ['ls-files', 'src']).split('\n').filter(Boolean)[0];
  assert.ok(tracked, 'the fixture tracks a source file');
  await writeFile(path.join(repo.root, tracked), '// changed here, never published\n');
  await mkdir(path.join(repo.root, 'dist'), { recursive: true });
  await writeFile(path.join(repo.root, 'dist/index.html'), '<p>old</p>\n');
  repo.must('git', ['add', '-f', 'dist/index.html']);
  repo.must('git', ['commit', '-m', 'A tracked build output in this fixture']);
  await writeFile(path.join(repo.root, 'dist/index.html'), '<p>new</p>\n');
  assert.deepEqual(await unpublishedApplicationFiles(repo.root, {}, {}), [tracked]);
});

test('2. every size the target names is captured from the one screen, side by side in one file', async () => {
  const workflow = { resolution: {} };
  assert.deepEqual(signOffViewports(workflow, 'Grapher mode at desktop and narrow viewports'),
    [{ name: 'desktop', width: 1280, height: 800 }, { name: 'narrow', ...NARROW_VIEWPORT }]);
  assert.deepEqual(signOffViewports(workflow, 'Grapher workspace at desktop viewport'), [{ name: 'desktop', width: 1280, height: 800 }], 'one size stays one screenshot');
  assert.deepEqual(signOffViewports(workflow, 'The menu on a mobile phone'), [{ name: 'narrow', ...NARROW_VIEWPORT }]);
  assert.deepEqual(signOffViewports({ resolution: { verification: { profiles: [{ id: 'desktop', label: 'Desktop', width: 1440, height: 900 },
    { id: 'phone', label: 'Phone', width: 375, height: 812 }] } } }, 'Grapher workspace'), [{ name: 'Desktop', width: 1440, height: 900 }, { name: 'Phone', width: 375, height: 812 }],
  'the Story\'s pinned profiles, when it pins more than one');
  assert.equal(sizeWords(signOffViewports(workflow, 'Grapher mode at desktop and narrow viewports')), '1280×800 and 390×844');
  const solid = (width, height, [r, g, b]) => encodePngRgba8({ width, height, data: Buffer.alloc(width * height * 4).fill(Buffer.from([r, g, b, 255])) });
  const joined = decodePngRgba8(await sideBySide([solid(8, 6, [255, 0, 0]), solid(3, 4, [0, 0, 255])], { gap: 2 }));
  assert.deepEqual([joined.width, joined.height], [13, 6]);
  const pixel = (x, y) => [...joined.data.subarray((y * joined.width + x) * 4, (y * joined.width + x) * 4 + 4)];
  assert.deepEqual([pixel(0, 0), pixel(9, 0), pixel(10, 3), pixel(12, 5)], [[255, 0, 0, 255], [0xee, 0xee, 0xee, 255], [0, 0, 255, 255], [0xee, 0xee, 0xee, 255]]);
});

/** Implementation published and submitted; its approval held by the AC-002 sign-off, whose screenshot is still to take. */
function story() {
  return { workItem: { id: W }, status: 'in_progress', currentPhase: 'implementation', phaseOrder: ['implementation'], history: [], resolution: { approvalAuthorities: AUTHORITIES },
    phases: { implementation: { id: 'implementation', label: 'Implementation', status: 'awaiting_approval', generation: 1, approvals: [], approvalPolicy: { authorities: ['engineering'], minimum: 1 } } } };
}
const NEEDED = { status: 'needed', workId: W, file: `singularity/work-items/${W}/evidence/visual-sign-offs/shot.png`, viewport: { width: 1280, height: 800 },
  viewports: [{ name: 'desktop', width: 1280, height: 800 }, { name: 'narrow', width: 390, height: 844 }], target: 'Grapher mode at desktop and narrow viewports', command: SHOT,
  build: { source: 'inferred', words: 'npm ci --no-audit --no-fund, then npm run build (inferred: package.json builds with vite build; output dist)' } };
const OWED = { kind: 'witness', clauseId: `${W}:AC-002`, slot: 'layout-structure', method: 'visual', files: [], owners: ['implementation'], available: false, groups: ['engineering'],
  contextBinding: `sha256:${'c'.repeat(64)}`, capture: NEEDED };

function packet() {
  const workflow = story();
  const hold = approvalHold(new SingularityFlowError('Phase \'implementation\' cannot be approved while 1 sign-off(s) it answers for have no witness.',
    { code: 'EVIDENCE_INSPECTION_MISSING', details: { phase: 'implementation', criteria: [{ clauseId: OWED.clauseId, slot: OWED.slot }],
      nextAction: { command: `singularity-flow decisions ${W}`, skill: '/sf-decide', label: 'An approver of implementation signs off each one after looking at its file.' } } }), workflow, workflow.phases.implementation);
  return { ...withPlainWords(workflow, decisionPacket(workflow, { phaseId: 'implementation', pending: { owed: [OWED] }, approvalCheck: { holds: [hold] } },
    { authorities: AUTHORITIES, actor: ME, at: AT })), packetSha256: `sha256:${'a'.repeat(64)}`, repositoryPath: '/repo', hold };
}

test('2. the sign-off says it captures both sizes', () => {
  const item = packet().items.find((entry) => entry.details?.clause === `${W}:AC-002`);
  assert.match(item.check.does, /Bring up the screen \(Grapher mode at desktop and narrow viewports\) and click "Capture this screen for AC-002"\. SFlow captures that screen at 1280×800 and 390×844, side by side in one screenshot\.$/u);
});

test('3. a sign-off waiting for its screenshot routes to /sf-decide on every surface, never "no verified equivalent"', () => {
  const guidance = safeCommandGuidance({ command: SHOT });
  assert.deepEqual([guidance.copilotCommand, guidance.modelFreeCommand], [`/sf-decide ${W}`, VSCODE_DECIDE_CARD]);
  const listed = packet();
  // Next steps and the approval's pending summary: the screenshot, on the Decide card.
  assert.deepEqual({ command: listed.next.command, copilot: listed.next.copilotCommand, vscode: listed.next.modelFreeCommand }, { command: SHOT, copilot: `/sf-decide ${W}`, vscode: VSCODE_DECIDE_CARD });
  assert.equal(pendingSummary(listed).next.copilotCommand, `/sf-decide ${W}`);
  assert.equal(listed.record.copilotCommand, `/sf-decide ${W}`);
  // The approval hold's own action reads the same route.
  assert.equal(safeCommandGuidance({ command: listed.hold.action.command }).copilotCommand, `/sf-decide ${W}`);
  // Inside /sf-decide itself the list ends on the Decide card, never on /sf-decide again.
  const shown = withStoryNext(listed, null);
  assert.equal(shown.next.title, 'Open the Decide card');
  assert.doesNotMatch(packetText(shown).split('\n').filter((line) => line.startsWith('Next')).join('\n'), /no verified equivalent|\/sf-decide/u);
});
