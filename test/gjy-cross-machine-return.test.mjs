import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initializeDefinition } from '../src/config.mjs';
import { readReturnLocator, readReturnLocatorAtRef, writeReturnLocator } from '../src/return-locator.mjs';
import { manualStorySource, startStory } from '../src/story-start.mjs';
import { run } from '../src/util.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

function git(root, args) { return run('git', args, { cwd: root }); }

test('a second clone verifies the same durable return locator without local workspace state', async () => {
  const area = await mkdtemp(path.join(os.tmpdir(), 'sflow-gjy-return-'));
  const remote = path.join(area, 'remote.git');
  const first = path.join(area, 'machine-a');
  const second = path.join(area, 'machine-b');
  run('git', ['init', '--bare', '-q', '--initial-branch=main', remote]);
  run('git', ['clone', '-q', remote, first]);
  git(first, ['config', 'user.name', 'Machine A']);
  git(first, ['config', 'user.email', 'machine-a@example.com']);
  git(first, ['checkout', '-q', '-b', 'WRK-RETURN-1']);

  const config = { git: { remote: 'origin' } };
  const workflow = {
    workItem: { id: 'WRK-RETURN-1', branch: 'WRK-RETURN-1' },
    lineage: { canonicalBranch: 'WRK-RETURN-1' },
    resolution: {
      configSha256: 'c'.repeat(64),
      configurationSource: { branch: 'sflow/config', commit: 'd'.repeat(40) },
      capability: { id: 'payments', repositoryId: 'payments-api' }
    }
  };
  const written = await writeReturnLocator(first, config, workflow);
  git(first, ['add', written.path]);
  git(first, ['commit', '-q', '-m', 'Add durable return locator']);
  git(first, ['push', '-q', '-u', 'origin', 'HEAD:refs/heads/WRK-RETURN-1']);

  run('git', ['clone', '-q', '--branch', 'WRK-RETURN-1', remote, second]);
  const replay = await readReturnLocator(second, config, 'WRK-RETURN-1');
  assert.deepEqual(replay.locator, written.locator);
  assert.equal(replay.locator.repositories[0].url, null,
    'a filesystem remote is classified but its machine path is never governed');
  assert.equal(replay.locator.repositories[0].portability, 'machine-local');
  assert.doesNotMatch(JSON.stringify(replay.locator), new RegExp(area.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(replay.locator.workBranchRef, 'refs/heads/WRK-RETURN-1');
  const beforeCheckout = readReturnLocatorAtRef(second, config, 'WRK-RETURN-1', 'origin/WRK-RETURN-1');
  assert.equal(beforeCheckout.locator.integritySha256, written.locator.integritySha256);
});

test('return previews and reconstructs a published Story in a fresh clone without stashing or resetting', async (t) => {
  const area = await mkdtemp(path.join(os.tmpdir(), 'sflow-gjy-return-command-'));
  t.after(() => rm(area, { recursive: true, force: true }));
  const remote = path.join(area, 'remote.git');
  const first = path.join(area, 'machine-a');
  const second = path.join(area, 'machine-b');
  run('git', ['init', '--bare', '-q', '--initial-branch=main', remote]);
  run('git', ['clone', '-q', remote, first]);
  git(first, ['config', 'user.name', 'Machine A']);
  git(first, ['config', 'user.email', 'machine-a@example.com']);
  await writeFile(path.join(first, 'README.md'), '# Return command fixture\n');
  await initializeDefinition(first);
  git(first, ['add', '.']);
  git(first, ['commit', '-q', '-m', 'initialize']);
  git(first, ['push', '-q', '-u', 'origin', 'main']);
  const started = await startStory(first, {
    id: 'WRK-RETURN-2',
    source: manualStorySource('WRK-RETURN-2', { title: 'Resume on another machine' }),
    workType: 'quick-fix',
    baseBranch: 'main'
  });
  assert.equal(started.publication.pushed, true);

  run('git', ['clone', '-q', '--branch', 'main', remote, second]);
  git(second, ['config', 'user.name', 'Machine B']);
  git(second, ['config', 'user.email', 'machine-b@example.com']);
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Machine B' };
  const preview = run(process.execPath, [cli, 'return', 'WRK-RETURN-2', '--json'], {
    cwd: second, env
  });
  const plan = JSON.parse(preview.stdout);
  assert.equal(plan.workId, 'WRK-RETURN-2');
  assert.equal(plan.sourceRef, 'origin/WRK-RETURN-2');
  assert.equal(plan.currentBranch, 'main');
  assert.equal(plan.worktree.clean, true);
  assert.equal(git(second, ['branch', '--show-current']).stdout.trim(), 'main', 'preview does not switch branches');

  const refused = run(process.execPath, [cli, 'return', 'WRK-RETURN-2', '--apply', '--confirm', 'WRONG'], {
    cwd: second, env, allowFailure: true
  });
  assert.notEqual(refused.status, 0);
  assert.equal(git(second, ['branch', '--show-current']).stdout.trim(), 'main');

  run(process.execPath, [cli, 'return', 'WRK-RETURN-2', '--apply', '--confirm', 'WRK-RETURN-2'], {
    cwd: second, env
  });
  assert.equal(git(second, ['branch', '--show-current']).stdout.trim(), 'WRK-RETURN-2');
  assert.equal(git(second, ['rev-parse', 'HEAD']).stdout.trim(), plan.sourceCommit);

  await writeFile(path.join(second, 'machine-b-only.txt'), 'preserve this local continuation\n');
  git(second, ['add', 'machine-b-only.txt']);
  git(second, ['commit', '-q', '-m', 'local continuation']);
  const localHead = git(second, ['rev-parse', 'HEAD']).stdout.trim();
  const conflictPlan = JSON.parse(run(process.execPath, [cli, 'return', 'WRK-RETURN-2', '--json'], {
    cwd: second, env
  }).stdout);
  assert.equal(conflictPlan.localBranch.disposition, 'local-ahead');
  assert.equal(conflictPlan.localBranch.blocksApply, true);
  const conflictApply = run(process.execPath, [cli, 'return', 'WRK-RETURN-2', '--apply', '--confirm', 'WRK-RETURN-2'], {
    cwd: second, env, allowFailure: true
  });
  assert.notEqual(conflictApply.status, 0);
  assert.match(conflictApply.stderr, /preserved both histories and changed nothing/);
  assert.equal(git(second, ['rev-parse', 'HEAD']).stdout.trim(), localHead,
    'a local-ahead branch is refused before checkout or fast-forward');
});
