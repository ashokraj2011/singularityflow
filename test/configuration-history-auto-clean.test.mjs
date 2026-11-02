import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { autoCleanConfigurationHistory, configurationHistorySettings } from '../src/configuration-history-auto-clean.mjs';
import { configurationHistoryRefs } from '../src/configuration-history-refs.mjs';
import { normalizeLedgerConfig } from '../src/ledger-config.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';
import { run } from '../src/util.mjs';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** A remote with `histories` dated history branches (the newest approved) beside refs auto-clear must never touch. */
async function fixture(t, { histories = 12 } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-history-auto-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = path.join(directory, 'remote.git'), root = path.join(directory, 'root');
  run('git', ['init', '--bare', '-q', remote]);
  run('git', ['init', '-q', root]);
  const git = (args, options = {}) => run('git', args, { cwd: root, ...options });
  git(['config', 'user.name', 'History Test']); git(['config', 'user.email', 'history@example.invalid']);
  git(['remote', 'add', 'origin', remote]);
  const commits = [];
  for (let index = 0; index < histories; index++) {
    const date = new Date(Date.UTC(2026, 8, 1, 12) + index * 3_600_000).toISOString();
    commits.push(git(['commit-tree', '--no-gpg-sign', EMPTY_TREE, '-m', `Configuration ${index}`,
      ...(commits.length ? ['-p', commits.at(-1)] : [])],
    { env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }).stdout.trim());
  }
  const approved = commits.at(-1);
  git(['push', '-q', 'origin', `${approved}:refs/heads/sflow/config`,
    ...commits.map(commit => `${commit}:${configurationHistoryRefs(commit).branch}`),
    // Never a target: the state branch, a proposal, a Story, the application, other tags, pins and a
    // look-alike outside the history namespace.
    `${commits[1]}:refs/heads/state`, `${commits[2]}:refs/heads/sflow/config-change/workflow/pending-12345678`,
    `${commits[3]}:refs/heads/SLC-1`, `${commits[4]}:refs/heads/main`, `${commits[5]}:refs/tags/v1.0.0`,
    `${commits[6]}:refs/singularity/pins/organisation/0001`, `${commits[7]}:refs/heads/sflow/config-historyx/not-ours`]);
  git(['fetch', '-q', 'origin']);
  const refsOf = (args) => new Map(run('git', [...args, 'for-each-ref', '--format=%(refname) %(objectname)'])
    .stdout.trim().split('\n').filter(Boolean).map(line => line.split(' ')));
  return { root, remote, commits, approved,
    remoteRefs: () => refsOf(['--git-dir', remote]), localRefs: () => refsOf(['-C', root]) };
}

function counting(log) {
  return async (args, options) => { log.push(args[0]); return runRemoteGitAsync(args, options); };
}

test('auto-clear archives history beyond the current and the 10 most recent as tags; every other ref stays byte-identical', async t => {
  const item = await fixture(t);
  const remoteBefore = item.remoteRefs(), localBefore = item.localRefs();
  const retired = item.commits.slice(0, 2);
  const note = await autoCleanConfigurationHistory(item.root, normalizeLedgerConfig({ remote: 'origin' }));
  assert.deepEqual(note, { status: 'cleaned', archived: 2, remaining: 0 });

  const remoteAfter = item.remoteRefs();
  for (const commit of retired) {
    const refs = configurationHistoryRefs(commit);
    assert.equal(remoteAfter.has(refs.branch), false);
    assert.equal(remoteAfter.get(refs.archive), commit);
  }
  const retiredBranches = new Set(retired.map(commit => configurationHistoryRefs(commit).branch));
  const archiveTags = new Set(retired.map(commit => configurationHistoryRefs(commit).archive));
  for (const [ref, object] of remoteBefore) {
    if (!retiredBranches.has(ref)) assert.equal(remoteAfter.get(ref), object, `${ref} must not change`);
  }
  for (const ref of remoteAfter.keys()) assert.ok(remoteBefore.has(ref) || archiveTags.has(ref), `${ref} is new`);
  const kept = [...remoteAfter.keys()].filter(ref => ref.startsWith('refs/heads/sflow/config-history/'));
  assert.equal(kept.length, 10);
  assert.ok(kept.includes(configurationHistoryRefs(item.approved).branch));

  // Only this checkout's tracking refs for the archived branches are dropped.
  const localAfter = item.localRefs();
  const retiredTracking = new Set(retired.map(commit => `refs/remotes/origin/sflow/config-history/${commit}`));
  for (const [ref, object] of localBefore) {
    if (retiredTracking.has(ref)) assert.equal(localAfter.has(ref), false, `${ref} is pruned`);
    else assert.equal(localAfter.get(ref), object, `${ref} must not change`);
  }
  assert.equal(localAfter.size, localBefore.size - retired.length);

  // Within the kept count, the next pass only lists refs: no snapshot fetch and no push.
  const log = [];
  assert.deepEqual(await autoCleanConfigurationHistory(item.root, normalizeLedgerConfig({ remote: 'origin' }),
    { runRemoteCommand: counting(log) }), { status: 'current', archived: 0, remaining: 0 });
  assert.equal(log.includes('fetch'), false);
  assert.equal(log.includes('push'), false);
});

test('autoClear false does nothing; keepRecent sets the count kept as branches', async t => {
  const off = await fixture(t);
  const before = off.remoteRefs();
  assert.equal(await autoCleanConfigurationHistory(off.root,
    normalizeLedgerConfig({ remote: 'origin', configurationHistory: { autoClear: false } })), null);
  assert.deepEqual(off.remoteRefs(), before);

  const three = await fixture(t);
  const note = await autoCleanConfigurationHistory(three.root,
    normalizeLedgerConfig({ remote: 'origin', configurationHistory: { keepRecent: 3 } }));
  assert.deepEqual(note, { status: 'cleaned', archived: 9, remaining: 0 });
  assert.equal([...three.remoteRefs().keys()].filter(ref => ref.startsWith('refs/heads/sflow/config-history/')).length, 3);
});

test('a refused push, an unreachable remote or a missing authority returns a note with the manual command and never throws', async t => {
  const item = await fixture(t);
  const before = item.remoteRefs(), localBefore = item.localRefs();
  const refused = await autoCleanConfigurationHistory(item.root, normalizeLedgerConfig({ remote: 'origin' }), {
    runRemoteCommand: async (args, options) => args[0] === 'push'
      ? { status: 1, stdout: '', stderr: 'remote: refusing branch deletion' }
      : runRemoteGitAsync(args, options)
  });
  assert.equal(refused.status, 'not-cleaned');
  assert.equal(refused.archived, 0);
  assert.equal(refused.command, 'singularity-flow configuration cleanup-history --keep-recent 10 --json');
  assert.match(refused.message, /not reported cleaned/u);
  assert.deepEqual(item.remoteRefs(), before);
  assert.deepEqual(item.localRefs(), localBefore);

  run('git', ['--git-dir', item.remote, 'update-ref', '-d', 'refs/heads/sflow/config']);
  const missing = await autoCleanConfigurationHistory(item.root, normalizeLedgerConfig({ remote: 'origin' }));
  assert.equal(missing.status, 'failed');
  assert.match(missing.message, /approved sflow\/config authority/u);
  assert.equal(missing.command, refused.command);

  run('git', ['remote', 'set-url', 'origin', path.join(path.dirname(item.remote), 'absent.git')], { cwd: item.root });
  const unreachable = await autoCleanConfigurationHistory(item.root, normalizeLedgerConfig({ remote: 'origin' }));
  assert.equal(unreachable.status, 'failed');
  assert.equal(unreachable.command, refused.command);
});

test('a backlog beyond one batch clears 100 per run and the next run continues', async t => {
  const item = await fixture(t, { histories: 111 });
  const ledger = normalizeLedgerConfig({ remote: 'origin' });
  assert.deepEqual(await autoCleanConfigurationHistory(item.root, ledger), { status: 'cleaned', archived: 100, remaining: 1 });
  assert.deepEqual(await autoCleanConfigurationHistory(item.root, ledger), { status: 'cleaned', archived: 1, remaining: 0 });
  assert.deepEqual(await autoCleanConfigurationHistory(item.root, ledger), { status: 'current', archived: 0, remaining: 0 });
  const refs = item.remoteRefs();
  assert.equal([...refs.keys()].filter(ref => ref.startsWith('refs/heads/sflow/config-history/')).length, 10);
  assert.equal([...refs.keys()].filter(ref => ref.startsWith('refs/tags/sflow/config-history/')).length, 101);
});

test('ledger.configurationHistory is optional, validated, and absent from a resolution that never set it', () => {
  assert.equal(Object.hasOwn(normalizeLedgerConfig({}), 'configurationHistory'), false);
  assert.deepEqual(normalizeLedgerConfig({ configurationHistory: { autoClear: false } }).configurationHistory,
    { autoClear: false, keepRecent: 10 });
  assert.deepEqual(normalizeLedgerConfig({ configurationHistory: {} }).configurationHistory, { autoClear: true, keepRecent: 10 });
  for (const value of [{ keepRecent: 0 }, { keepRecent: 101 }, { keepRecent: 1.5 }, { autoClear: 'no' }, { other: 1 }, []]) {
    assert.throws(() => normalizeLedgerConfig({ configurationHistory: value }), /configurationHistory/u);
  }
  assert.deepEqual(configurationHistorySettings(undefined), { autoClear: true, keepRecent: 10 });
  assert.deepEqual(configurationHistorySettings({ configurationHistory: { keepRecent: 500 } }), { autoClear: true, keepRecent: 10 });
});
