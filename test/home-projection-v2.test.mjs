import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createHostGateway } from '../src/gateway/host.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { run } from '../src/util.mjs';
import { buildResultCard } from '../apps/vscode/src/views/result-card-model.ts';
import { resultCardHtml } from '../apps/vscode/src/views/result-card-page.ts';

test('the kernel emits one bounded HomeProjectionV2 with sealed nested actions', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-home-projection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q'], { cwd: root });
  run('git', ['config', 'user.name', 'Ada Lovelace'], { cwd: root });
  run('git', ['config', 'user.email', 'ada@example.test'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), 'projection fixture\n');
  run('git', ['add', 'README.md'], { cwd: root });
  run('git', ['commit', '-qm', 'fixture'], { cwd: root });
  const { kernel } = createHostGateway({
    root,
    hostSessionId: 'projection-test',
    workspaceId: 'workspace-one',
    planners: gatewayPlanners(),
    now: () => Date.parse('2026-08-19T10:00:00.000Z'),
    plannerContext: {
      workspace: { id: 'workspace-one', name: 'Payments' },
      repositoryId: 'payments', lens: 'qa', otherWorkspaces: 0,
      today: {
        schemaVersion: 1, resultType: 'local-work-journal-day', generatedAt: '2026-08-19T09:59:00.000Z',
        date: '2026-08-19', timeZone: 'Asia/Kolkata', privacy: { localOnly: true, remoteSync: 'never' },
        summaries: [], attention: [], totalEvents: 0, malformedLines: []
      },
      yesterday: {
        schemaVersion: 1, resultType: 'local-work-journal-day', generatedAt: '2026-08-19T09:59:00.000Z',
        date: '2026-08-18', timeZone: 'Asia/Kolkata', privacy: { localOnly: true, remoteSync: 'never' },
        summaries: [{ id: 'jrn_previous', at: '2026-08-18T10:00:00.000Z', kind: 'checkpoint',
          workId: 'WRK-19', text: 'Local checkpoint recorded' }], attention: [], totalEvents: 1, malformedLines: []
      }
    }
  });
  const resolution = kernel.resolve({ utterance: 'home' });
  const result = await kernel.read({ resolutionId: resolution.next[0].handle });
  const projection = result.data.homeProjection;
  assert.equal(projection.schemaVersion, 2);
  assert.equal(projection.resultType, 'my-work-home');
  assert.equal(projection.lens.id, 'qa');
  assert.equal(projection.context.workspaceLabel, 'Payments');
  assert.equal(projection.asOf, '2026-08-19T10:00:00.000Z');
  assert.match(projection.subjectRevision, /^[a-f0-9]{64}$/);
  assert.equal(projection.prompt.goals.length, result.next.length);
  for (const action of projection.prompt.goals) {
    assert.match(action.handle, /^sel_/);
    assert.ok(!action.handle.startsWith('home:'), 'planner prefixes never cross the kernel boundary');
  }
  assert.equal(projection.prompt.goals.filter((action) => action.emphasis === 'primary').length, 1);
  assert.equal(JSON.stringify(projection).includes(root), false, 'the projection carries no unrestricted local path');

  const html = resultCardHtml(buildResultCard(result));
  assert.match(html, /My Work/);
  assert.match(html, /What is on your mind today\?/);
  assert.match(html, /Local first/);
  assert.match(html, /Today/);
  assert.match(html, /Yesterday — where you stopped/);
  assert.match(html, /WRK-19 · Local checkpoint recorded/);
  assert.match(html, /Stored locally · Never pushed/);
  assert.match(html, /aria-labelledby="sf-home-title"/);
  assert.match(html, /aria-label="Current work"/);
  assert.equal((html.match(/class="primary"/g) ?? []).length, 1, 'Home renders exactly one primary action');
  for (const action of projection.prompt.goals) {
    assert.equal(html.includes(action.handle), false, 'opaque handles stay out of webview markup');
  }
  assert.equal(html.includes(root), false, 'the rendered Home carries no unrestricted local path');
  assert.match((await import('../apps/vscode/src/views/result-card-page.ts')).RESULT_CARD_STYLE,
    /prefers-reduced-motion/);
  assert.match((await import('../apps/vscode/src/views/result-card-page.ts')).RESULT_CARD_STYLE,
    /forced-colors/);
});
