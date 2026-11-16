/**
 * SPEC-SCF stage 5 on the other surfaces, decided by the owner on 16 November 2026:
 * - VS Code's Repair workspace previews the links and confirms that exact plan (the CLI's plan ID) before applying it.
 * - A multi-root VS Code window keeps presence for each open folder in a workspace, not only its first (WS-8).
 * - Opening a Story says when its branch on the remote had commits made lately elsewhere (WS-10), from what opening it
 *   already fetched: no new network call.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  confirmWorkspaceRepairLinks, REPAIR_LINKS_ACTION, workspaceRepairCommand, workspaceRepairConfirmCommand
} from '../apps/vscode/src/views/workspace-repair-links.ts';
import { heartbeatCommands } from '../apps/vscode/src/window-folder-heartbeats.ts';
import { ACTIVE_ELSEWHERE_HOURS, storyActiveElsewhere } from '../src/story-active-elsewhere.mjs';

function ports({ answer = true } = {}) {
  const calls = { asked: [], informed: [], ran: [] };
  return {
    calls,
    ask: async (title, detail, action) => { calls.asked.push({ title, detail, action }); return answer; },
    inform: async (title, detail) => { calls.informed.push({ title, detail }); },
    run: async (args) => { calls.ran.push(args); return { links: { status: 'repaired', lines: ['Repaired:'] } }; }
  };
}

test('VS Code repair shows the CLI\'s plan and applies exactly that plan once confirmed [SCF:REQ-022]', async () => {
  assert.deepEqual(workspaceRepairCommand('/w/ws1-moved'), ['workspace', 'repair', '/w/ws1-moved', '--json']);
  const preview = { links: { status: 'preview', plan: { planId: 'wsr-0123456789abcdef0123456789abcdef', folder: '/w/ws1-moved' },
    lines: ['Workspace ws1 (local--ws1) moved: it was saved at /w/ws1, and is now at /w/ws1-moved.', '  Re-link the checkout of ST-1 …'] } };
  const confirmed = ports();
  const outcome = await confirmWorkspaceRepairLinks('/w/ws1-moved', preview, confirmed);
  assert.equal(outcome.outcome, 'repaired');
  assert.equal(confirmed.calls.asked[0].action, REPAIR_LINKS_ACTION);
  assert.equal(confirmed.calls.asked[0].detail, preview.links.lines.join('\n'), 'the same words the terminal prints');
  assert.deepEqual(confirmed.calls.ran, [workspaceRepairConfirmCommand('/w/ws1-moved', 'wsr-0123456789abcdef0123456789abcdef')]);
  assert.deepEqual(confirmed.calls.ran[0], ['workspace', 'repair', '/w/ws1-moved', '--confirm', 'wsr-0123456789abcdef0123456789abcdef', '--json']);

  const declined = ports({ answer: false });
  assert.equal((await confirmWorkspaceRepairLinks('/w/ws1-moved', preview, declined)).outcome, 'cancelled');
  assert.deepEqual(declined.calls.ran, [], 'nothing is applied without the person\'s confirmation');

  const blocked = ports();
  const refusal = { code: 'WORKSPACE_REPAIR_WOULD_LOSE_COMMIT', message: 'The deleted checkout … was on commit abc, which no branch holds.', command: 'git -C "/w/ws1/repos/app" branch rescue-st-2 abc' };
  const waiting = await confirmWorkspaceRepairLinks('/w/ws1', { links: { status: 'blocked', plan: { refusals: [refusal] }, lines: ['Waiting on work…'] } }, blocked);
  assert.deepEqual(waiting, { outcome: 'blocked', refusals: [refusal] });
  assert.equal(blocked.calls.informed.length, 1);
  assert.deepEqual(blocked.calls.ran, []);

  for (const links of [undefined, { status: 'nothing-to-repair' }, { status: 'repaired' }]) {
    const quiet = ports();
    assert.deepEqual(await confirmWorkspaceRepairLinks('/w/ws1', { links }, quiet), { outcome: 'none' });
    assert.equal(quiet.calls.asked.length + quiet.calls.ran.length, 0);
  }
});

test('a multi-root window keeps presence for every open folder in a workspace, not only the first [WS-8]', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-window-folders-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'ws');
  const lead = path.join(workspace, 'repos', 'app');
  const story = path.join(workspace, '.singularity-flow', 'story-worktrees', '.w-0123456789abcdef01234567');
  const notes = path.join(root, 'notes');
  for (const folder of [lead, story, notes]) await mkdir(folder, { recursive: true });
  await writeFile(path.join(workspace, 'workspace.json'), '{}\n');
  await mkdir(path.join(lead, '.git'));
  await writeFile(path.join(story, '.git'), 'gitdir: elsewhere\n');
  await mkdir(path.join(notes, '.git'));

  const base = ['workspace', 'retention', '--heartbeat', '--surface', 'window', '--pid', '42', '--json'];
  assert.deepEqual(heartbeatCommands('window', 42, [lead], lead), [base], 'a one-folder window is unchanged');
  assert.deepEqual(heartbeatCommands('window', 42, [workspace], lead), [base], 'nor does a workspace folder opened alone');
  assert.deepEqual(heartbeatCommands('window', 42, [notes, lead, story], lead), [base,
    ['workspace', 'retention', '--heartbeat', '--surface', 'window-1', '--pid', '42', '--context-root', story, '--json']],
  'the Story checkout open beside the bound repository has its own presence; a folder in no workspace has none');
});

test('opening a Story says when its remote branch brought changes made lately elsewhere, with no network call [WS-10]', () => {
  const now = Date.parse('2026-11-16T12:00:00.000Z');
  const record = (at) => ({ history: [{ at: '2026-11-01T09:00:00.000Z', event: 'work_started' }, { at, event: 'phase_generated' }] });
  const recent = record('2026-11-16T11:48:00.000Z');
  const before = 'a'.repeat(40);
  const after = 'b'.repeat(40);

  const elsewhere = storyActiveElsewhere({ workId: 'ST-1', before, after, workflow: recent, now });
  assert.deepEqual({ ...elsewhere, words: undefined }, { workId: 'ST-1', commit: after, changedAt: '2026-11-16T11:48:00.000Z',
    hadCopy: true, words: undefined });
  assert.match(elsewhere.words, /^ST-1 was changed elsewhere 12 minutes ago: its branch on the remote had commits this computer did not\./u);
  assert.match(elsewhere.words, /singularity-flow sync ST-1/u);
  assert.match(storyActiveElsewhere({ workId: 'ST-1', before: null, after, workflow: recent, now }).words, /it had no copy of the Story/u,
    'a computer with no copy yet, as on a second laptop, is told too');
  assert.equal(storyActiveElsewhere({ workId: 'ST-1', before: after, after, workflow: recent, now }), null, 'nothing came from elsewhere');
  const old = record(new Date(now - (ACTIVE_ELSEWHERE_HOURS + 1) * 3_600_000).toISOString());
  assert.equal(storyActiveElsewhere({ workId: 'ST-1', before: null, after, workflow: old, now }), null, 'an old change is not work in progress');
  assert.equal(storyActiveElsewhere({ workId: 'ST-1', before: null, after, workflow: {}, now }), null, 'no record, no claim');
  assert.equal(storyActiveElsewhere({ workId: 'ST-1', before: null, after: null, workflow: recent, now }), null);
});
