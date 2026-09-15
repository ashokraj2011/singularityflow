import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { remoteFingerprint } from '../src/git-remote-diagnostics.mjs';
import { run } from '../src/util.mjs';
import {
  configuredWorldModelHistoryAuthorityCut
} from '../src/world-model/history/authority-cut.mjs';

function git(root, ...args) {
  return run('git', args, { cwd: root }).stdout.trim();
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmp-authority-cut-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'WMP Authority Cut');
  git(root, 'config', 'user.email', 'wmp-authority@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# application\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'application');
  const applicationCommit = git(root, 'rev-parse', 'HEAD');
  git(root, 'branch', 'state', applicationCommit);
  return { root, applicationCommit };
}

test('remote-backed history authority admits only the configured tracking ref tip', async (t) => {
  const { root, applicationCommit } = await repository(t);
  const remote = 'https://example.invalid/application.git';
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'update-ref', 'refs/remotes/origin/state', applicationCommit);

  const cut = configuredWorldModelHistoryAuthorityCut(root, {
    worldModel: { stateBranch: 'state' },
    ledger: { remote: 'origin' }
  }, {
    expectedRepositoryIdentitySha256: `sha256:${remoteFingerprint(remote)}`
  });
  assert.deepEqual(cut, {
    ref: 'refs/remotes/origin/state', commit: applicationCommit,
    repositoryIdentitySha256: `sha256:${remoteFingerprint(remote)}`
  });
});

test('remote-backed history authority refuses a configured endpoint outside the Repository Domain', async (t) => {
  const { root, applicationCommit } = await repository(t);
  git(root, 'remote', 'add', 'origin', 'https://example.invalid/substituted.git');
  git(root, 'update-ref', 'refs/remotes/origin/state', applicationCommit);

  assert.throws(
    () => configuredWorldModelHistoryAuthorityCut(root, {
      worldModel: { stateBranch: 'state' }, ledger: { remote: 'origin' }
    }, {
      expectedRepositoryIdentitySha256:
        `sha256:${remoteFingerprint('https://example.invalid/application.git')}`
    }),
    (error) => error?.code === 'WMP_STATE_AUTHORITY_IDENTITY_MISMATCH'
      && !JSON.stringify(error).includes('substituted.git')
  );
});

test('remote-backed history authority requires the approved Repository Domain identity', async (t) => {
  const { root, applicationCommit } = await repository(t);
  git(root, 'remote', 'add', 'origin', 'https://example.invalid/application.git');
  git(root, 'update-ref', 'refs/remotes/origin/state', applicationCommit);

  assert.throws(
    () => configuredWorldModelHistoryAuthorityCut(root, {
      worldModel: { stateBranch: 'state' }, ledger: { remote: 'origin' }
    }),
    (error) => error?.code === 'WMP_STATE_AUTHORITY_IDENTITY_REQUIRED'
  );
});

test('a configured remote never falls back to an unpublished local state branch', async (t) => {
  const { root } = await repository(t);
  const remote = 'https://example.invalid/application.git';
  git(root, 'remote', 'add', 'origin', remote);

  assert.throws(
    () => configuredWorldModelHistoryAuthorityCut(root, {
      worldModel: { stateBranch: 'state' },
      ledger: { remote: 'origin' }
    }, {
      expectedRepositoryIdentitySha256: `sha256:${remoteFingerprint(remote)}`
    }),
    (error) => error?.code === 'WMP_AUTHORITY_REFRESH_REQUIRED'
      && error?.details?.authorityRef === 'refs/remotes/origin/state'
  );
});

test('local-mode history authority requires an explicit approved full ref', async (t) => {
  const { root, applicationCommit } = await repository(t);
  const cut = configuredWorldModelHistoryAuthorityCut(root, {
    worldModel: { stateBranch: 'refs/heads/state' }
  });
  assert.deepEqual(cut, {
    ref: 'refs/heads/state', commit: applicationCommit,
    repositoryIdentitySha256: null
  });
});

test('explicit local mode cannot name a remote-tracking or arbitrary full ref', async (t) => {
  const { root } = await repository(t);
  assert.throws(
    () => configuredWorldModelHistoryAuthorityCut(root, {
      worldModel: { stateBranch: 'refs/remotes/origin/state' }
    }),
    (error) => error?.code === 'WMP_AUTHORITY_CUT_REQUIRED'
  );
});

test('a shorthand state branch without its configured remote fails closed', async (t) => {
  const { root } = await repository(t);
  assert.throws(
    () => configuredWorldModelHistoryAuthorityCut(root, {
      worldModel: { stateBranch: 'state' }, ledger: { remote: 'origin' }
    }),
    (error) => error?.code === 'WMP_AUTHORITY_CUT_REQUIRED'
  );
});

test('ambiguous configured state remotes fail closed before selecting a ref', async (t) => {
  const { root } = await repository(t);
  git(root, 'remote', 'add', 'origin', 'https://example.invalid/one.git');
  git(root, 'config', '--add', 'remote.origin.url', 'https://example.invalid/two.git');

  assert.throws(
    () => configuredWorldModelHistoryAuthorityCut(root, {
      worldModel: { stateBranch: 'state' }, ledger: { remote: 'origin' }
    }),
    (error) => error?.code === 'WMP_AUTHORITY_CUT_REQUIRED'
  );
});

test('history authority reads fail with one typed timeout and never permit lazy fetch', () => {
  const calls = [];
  const runCommand = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      status: 1, stdout: '', stderr: '', timedOut: true,
      error: Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' })
    };
  };
  assert.throws(
    () => configuredWorldModelHistoryAuthorityCut('/fixture', {
      worldModel: { stateBranch: 'refs/heads/state' }
    }, { runCommand }),
    (error) => error?.code === 'WMP_HISTORY_READ_TIMEOUT'
      && error?.details?.operation === 'authority-ref-format'
      && error?.details?.cause === 'SUBPROCESS_TIMEOUT'
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'git');
  assert.equal(calls[0].options.timeoutClass, 'local-read');
  assert.equal(calls[0].options.allowFailure, true);
  assert.equal(calls[0].options.env.GIT_NO_LAZY_FETCH, '1');
  assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(calls[0].options.env.GCM_INTERACTIVE, 'Never');
});

test('remote identity lookup crosses the same bounded offline Git boundary', () => {
  const calls = [];
  assert.throws(
    () => configuredWorldModelHistoryAuthorityCut('/fixture', {
      worldModel: { stateBranch: 'state' }, ledger: { remote: 'origin' }
    }, {
      expectedRepositoryIdentitySha256: `sha256:${'a'.repeat(64)}`,
      runCommand(command, args, options) {
        calls.push({ command, args, options });
        return { status: 1, stdout: '', stderr: '', timedOut: true };
      }
    }),
    (error) => error?.code === 'WMP_HISTORY_READ_TIMEOUT'
      && error?.details?.operation === 'remote-identity'
  );
  assert.deepEqual(calls.map(({ args }) => args.slice(0, 3)), [
    ['config', '--local', '--get-all']
  ]);
  assert.equal(calls[0].options.timeoutClass, 'local-read');
  assert.equal(calls[0].options.env.GIT_NO_LAZY_FETCH, '1');
});
