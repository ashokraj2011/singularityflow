import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { benchmarkDirectStoryWorktree } from '../scripts/direct-story-worktree-benchmark.mjs';

test('cold and repeated intake/start reuse workspace objects and only populate Story worktrees', async () => {
  const result = await benchmarkDirectStoryWorktree({ files: 25 });
  assert.equal(result.originalPreserved, true);
  for (const row of result.rows.filter(row => row.name.startsWith('preview'))) {
    assert.equal(row.workspaceBranchClones, 0, `${row.name}: no application clone`);
    assert.equal(row.preflightApplicationFetches, 0, `${row.name}: no application object transfer for preview`);
    assert.equal(row.commands.worktree, 0, `${row.name}: no background application checkout`);
    assert.equal(row.commands.checkout, 0);
    assert.equal(row.commands.status, 0, `${row.name}: no full source status scan`);
  }
  for (const row of result.rows.filter(row => row.name.startsWith('start'))) {
    assert.equal(row.workspaceBranchClones, 0, `${row.name}: no independent workspace branch clone`);
    assert.equal(row.sharesWorkspaceObjects, true, `${row.name}: Story uses the original Git common directory`);
    assert.ok(row.commands.worktree > 0, 'one direct Story worktree is created');
  }
});

test('the VS Code readiness callback never schedules speculative application worktree creation', async () => {
  const source = await readFile(new URL('../apps/vscode/src/views/intake-panel.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('private async preflightBaseBranch('), source.indexOf('private async runBaseline('));
  assert.doesNotMatch(body, /\.prep\.schedule\(/u);
  assert.match(body, /clearInterval\(elapsed\)/u);
});
