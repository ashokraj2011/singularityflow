/**
 * SPEC-SCF stage 5 on the other surfaces, decided by the owner on 16 November 2026:
 * - VS Code's Repair workspace previews the links and confirms that exact plan (the CLI's plan ID) before applying it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  confirmWorkspaceRepairLinks, REPAIR_LINKS_ACTION, workspaceRepairCommand, workspaceRepairConfirmCommand
} from '../apps/vscode/src/views/workspace-repair-links.ts';

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
