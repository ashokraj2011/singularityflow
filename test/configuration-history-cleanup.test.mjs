import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { cleanupConfigurationHistory } from '../src/configuration-history-cleanup.mjs';
import { configurationHistoryRefs, retainedConfigurationHistoryRef } from '../src/configuration-history-refs.mjs';
import { retainStateConfigurationHistory } from '../src/configuration-branch.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { run } from '../src/util.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-history-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = path.join(directory, 'remote.git'), root = path.join(directory, 'root');
  await mkdir(root);
  run('git', ['init', '--bare', '-q', remote]);
  run('git', ['init', '-q', root]);
  const git = (args, options = {}) => run('git', args, { cwd: root, ...options });
  git(['config', 'user.name', 'History Test']); git(['config', 'user.email', 'history@example.invalid']);
  git(['remote', 'add', 'origin', remote]);
  const commits = [];
  for (let index = 0; index < 4; index++) {
    await writeFile(path.join(root, 'config.txt'), `approved-${index}\n`);
    git(['add', 'config.txt']);
    git(['commit', '-qm', `Configuration ${index}`], { env: { ...process.env,
      GIT_AUTHOR_DATE: `2026-10-0${index + 1}T12:00:00Z`, GIT_COMMITTER_DATE: `2026-10-0${index + 1}T12:00:00Z` } });
    commits.push(git(['rev-parse', 'HEAD']).stdout.trim());
  }
  git(['branch', '-M', 'sflow/config']);
  git(['push', '-q', 'origin', 'sflow/config', ...commits.map(commit => `${commit}:${configurationHistoryRefs(commit).branch}`)]);
  // Non-history application/ledger/proposal refs are never targets, even when they share commits.
  git(['push', '-q', 'origin', `${commits[0]}:refs/heads/app-story`, `${commits[1]}:refs/heads/state`,
    `${commits[2]}:refs/heads/sflow/config-change/workflow/pending-12345678`]);
  await writeFile(path.join(root, 'private.txt'), 'uncommitted work\n');
  const refs = () => run('git', ['--git-dir', remote, 'for-each-ref', '--format=%(refname)%09%(objectname)']).stdout;
  const state = () => git(['status', '--porcelain=v1']).stdout;
  return { directory, remote, root, git, commits, refs, state,
    cleanup: options => cleanupConfigurationHistory(root, { remote, keep: 1, ...options }) };
}

test('preview preserves remote refs and exact dirty worktree; confirmed cleanup archives without changing authority or Stories', async t => {
  const item = await fixture(t);
  const beforeRefs = item.refs(), beforeState = item.state();
  const preview = await item.cleanup();
  assert.equal(preview.status, 'preview');
  assert.equal(preview.candidates.length, 3);
  assert.equal(preview.retained[0].reason, 'current-approved-configuration');
  assert.equal(item.refs(), beforeRefs);
  assert.equal(item.state(), beforeState);
  assert.match(preview.commandGuidance.next.copilotCommand, /^\/sf-configuration/u);
  const result = await item.cleanup({ apply: true, confirm: preview.confirmation });
  assert.equal(result.status, 'cleaned', JSON.stringify(result));
  assert.equal(result.archived.length, 3);
  assert.equal(item.state(), beforeState);
  assert.equal(await readFile(path.join(item.root, 'private.txt'), 'utf8'), 'uncommitted work\n');
  for (const commit of item.commits.slice(0, 3)) {
    const refs = configurationHistoryRefs(commit);
    assert.equal(run('git', ['--git-dir', item.remote, 'rev-parse', refs.archive]).stdout.trim(), commit);
    assert.equal(run('git', ['--git-dir', item.remote, 'show-ref', '--verify', '--quiet', refs.branch], { allowFailure: true }).status, 1);
  }
  for (const [branch, commit] of [['app-story', item.commits[0]], ['state', item.commits[1]],
    ['sflow/config-change/workflow/pending-12345678', item.commits[2]], ['sflow/config', item.commits[3]]]) {
    assert.equal(run('git', ['--git-dir', item.remote, 'rev-parse', `refs/heads/${branch}`]).stdout.trim(), commit);
  }
  assert.equal((await item.cleanup()).candidates.length, 0);
  // Readers that clone by the retained history identity continue to work with the same tag name.
  const restored = path.join(item.directory, 'restore');
  run('git', ['clone', '-q', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
    '--branch', configurationHistoryRefs(item.commits[0]).name, item.remote, restored]);
  assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: restored }).stdout.trim(), item.commits[0]);
  const retained = await retainStateConfigurationHistory(item.root, item.remote, item.commits[0]);
  assert.equal(retained.commit, item.commits[0]);
  assert.equal(run('git', ['--git-dir', item.remote, 'show-ref', '--verify', '--quiet',
    configurationHistoryRefs(item.commits[0]).branch], { allowFailure: true }).status, 1,
  'ordinary retention must not recreate an already archived branch');
});

test('invalid, unconfirmed and stale cleanup never changes refs', async t => {
  const item = await fixture(t);
  for (const keep of [0, 101, NaN, 1.5]) await assert.rejects(item.cleanup({ keep }), /integer/u);
  const preview = await item.cleanup(), before = item.refs();
  await assert.rejects(item.cleanup({ apply: true }), error => error.code === 'CONFIGURATION_HISTORY_CLEANUP_STALE');
  assert.equal(item.refs(), before);
  item.git(['push', '-q', 'origin', `${item.commits[1]}:refs/tags/${configurationHistoryRefs(item.commits[1]).name}`]);
  const changed = item.refs();
  await assert.rejects(item.cleanup({ apply: true, confirm: preview.confirmation }), error => error.code === 'CONFIGURATION_HISTORY_CLEANUP_STALE');
  assert.equal(item.refs(), changed);
});

test('CLI preview respects the numeric retention option and keeps an old current authority separately from recent history', async t => {
  const item = await fixture(t);
  run('git', ['--git-dir', item.remote, 'update-ref', 'refs/heads/sflow/config', item.commits[0]]);
  const before = item.refs();
  const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
  const output = run(process.execPath, [cli, 'configuration', 'cleanup-history', '--keep-recent', '1', '--json'],
    { cwd: item.root, timeoutMs: 30_000 });
  const preview = JSON.parse(output.stdout);
  assert.equal(preview.status, 'preview');
  assert.equal(preview.keep, 1);
  assert.equal(preview.candidates.length, 2);
  assert.ok(preview.retained.some(row => row.commit === item.commits[0] && row.reason === 'current-approved-configuration'));
  assert.ok(preview.retained.some(row => row.commit === item.commits[3] && row.reason === 'recent-history'));
  assert.equal(item.refs(), before);
});

test('colliding archive tags and malformed history refs are retained with explicit reasons', async t => {
  const item = await fixture(t);
  item.git(['push', '-q', 'origin', `${item.commits[3]}:${configurationHistoryRefs(item.commits[0]).archive}`,
    `${item.commits[1]}:refs/heads/sflow/config-history/not-an-object-id`]);
  const before = item.refs(), preview = await item.cleanup();
  assert.ok(preview.retained.some(row => row.reason === 'archive-collision'));
  assert.ok(preview.retained.some(row => row.reason === 'noncanonical-history-ref'));
  assert.ok(!preview.candidates.some(row => row.commit === item.commits[0]));
  assert.equal(item.refs(), before);
  assert.throws(() => retainedConfigurationHistoryRef(new Map([
    [configurationHistoryRefs(item.commits[0]).archive, item.commits[3]]]), item.commits[0]),
  error => error.code === 'STATE_CONFIGURATION_HISTORY_COLLISION');
});

test('leased atomic cleanup refuses a concurrently changed branch; lost acknowledgement is reconciled', async t => {
  const item = await fixture(t), preview = await item.cleanup();
  let changed = false;
  const raced = await item.cleanup({ apply: true, confirm: preview.confirmation,
    runRemoteCommand: async (args, options) => {
      if (args[0] === 'push') {
        changed = true;
        run('git', ['--git-dir', item.remote, 'update-ref', configurationHistoryRefs(item.commits[0]).branch, item.commits[3]]);
      }
      return runRemoteGitAsync(args, options);
    } });
  assert.equal(changed, true);
  assert.equal(raced.status, 'not-cleaned');
  assert.equal(raced.archived.length, 0);
  assert.equal(run('git', ['--git-dir', item.remote, 'show-ref', '--tags'], { allowFailure: true }).stdout, '');
  run('git', ['--git-dir', item.remote, 'update-ref', configurationHistoryRefs(item.commits[0]).branch, item.commits[0]]);
  const refreshed = await item.cleanup();
  const recovered = await item.cleanup({ apply: true, confirm: refreshed.confirmation,
    runRemoteCommand: async (args, options) => {
      const result = await runRemoteGitAsync(args, options);
      return args[0] === 'push' ? { ...result, status: 1, stderr: 'lost acknowledgement' } : result;
    } });
  assert.equal(recovered.status, 'cleaned'); assert.equal(recovered.reconciled, true);
});

test('atomic rejection keeps every ref; a post-push observation failure reports unknown rather than false success', async t => {
  const item = await fixture(t), preview = await item.cleanup(), original = item.refs();
  const refused = await item.cleanup({ apply: true, confirm: preview.confirmation,
    runRemoteCommand: async (args, options) => args[0] === 'push'
      ? { status: 128, stdout: '', stderr: 'server does not support --atomic push' }
      : runRemoteGitAsync(args, options) });
  assert.equal(refused.status, 'not-cleaned'); assert.equal(item.refs(), original);
  let pushed = false;
  const unknown = await item.cleanup({ apply: true, confirm: preview.confirmation,
    runRemoteCommand: async (args, options) => {
      if (pushed) return { status: 128, stdout: '', stderr: 'network unavailable' };
      const result = await runRemoteGitAsync(args, options);
      if (args[0] === 'push') pushed = true;
      return result;
    } });
  assert.equal(unknown.status, 'outcome-unknown'); assert.deepEqual(unknown.archived, []);
  assert.equal((await item.cleanup()).candidates.length, 0, 'fresh preview reconciles a landed transaction without another push');
});

test('preview and apply are separately registered model-free operations', () => {
  for (const apply of [false, true]) {
    const operation = resolveOperation({ requestedCommand: 'configuration',
      positionals: ['configuration', 'cleanup-history'], options: { apply } });
    assert.equal(operation.classification, apply ? 'mutation' : 'read');
    assert.equal(operation.modelPolicy, 'never');
  }
});
