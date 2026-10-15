import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { head, withVerifiedReadHead } from '../src/git-execution.mjs';
import { withFreshReadScope } from '../src/read-scope.mjs';
import { withStableRead } from '../src/stable-read.mjs';

test('snapshot HEAD reuse is private, bounded by the read, and discarded on an external commit', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-verified-head-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env,
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Snapshot Tester',
      GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'snapshot@example.invalid' } });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'value'), 'initial'); git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'initial');
  const initial = head(root);
  assert.throws(() => withVerifiedReadHead(root, initial, () => null), /private read scope/);
  let observed, reads = 0;
  const result = await withStableRead({ files: [], freshScope: withFreshReadScope, identity() { observed = head(root); return observed; } },
    () => withVerifiedReadHead(root, observed, async () => {
      const pinned = head(root);
      if (++reads === 1) {
        await writeFile(path.join(root, 'value'), 'new'); git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'external commit');
        assert.equal(head(root), pinned, 'a projection keeps one HEAD until its final independent observation detects the change');
      }
      return head(root);
    }));
  assert.equal(reads, 2);
  assert.notEqual(result, initial);
  assert.equal(head(root), result, 'the ordinary head owner is fresh again outside the private projection');
});
