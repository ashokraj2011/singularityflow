import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '../src/util.mjs';
import { refreshWorldModelV4Authority } from '../src/world-model/authority-refresh.mjs';

const TRACKING_REF = 'refs/remotes/origin/state';
const CONFIG = Object.freeze({ stateBranch: 'state', remote: 'origin', outputDir: 'singularity/world-model' });

function git(root, ...args) {
  return run('git', args, { cwd: root }).stdout.trim();
}

async function fixture(t, { symbolic = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-ref-cas-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = path.join(directory, 'remote.git');
  const root = path.join(directory, 'work');
  git(directory, 'init', '--bare', remote);
  git(directory, 'init', '-b', 'main', root);
  git(root, 'config', 'user.name', 'Authority CAS Test');
  git(root, 'config', 'user.email', 'authority-cas@example.test');
  await writeFile(path.join(root, 'README.md'), 'initial\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'initial');
  const original = git(root, 'rev-parse', 'HEAD');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', 'origin', 'main');
  if (symbolic) git(root, 'symbolic-ref', TRACKING_REF, 'refs/heads/main');
  else git(root, 'update-ref', TRACKING_REF, original);
  return { root, remote, original };
}

function assertRefreshFailure(classification) {
  return (error) => {
    assert.equal(error.code, 'WMB_STATE_AUTHORITY_REFRESH_FAILED');
    assert.equal(error.details?.classification, classification);
    assert.equal(error.details?.stateBranch, 'state');
    assert.equal(error.details?.remote, 'origin');
    return true;
  };
}

test('absent authority removes only its exact non-symbolic tracking ref with no-deref CAS', async (t) => {
  const { root, original } = await fixture(t);
  const mutations = [];
  const result = await refreshWorldModelV4Authority(root, CONFIG, {
    runLocalGit(command, args, options) {
      if (args[0] === 'update-ref') mutations.push(args);
      return run(command, args, options);
    }
  });
  assert.equal(result.status, 'remote-absent');
  assert.equal(result.removedCachedRef, true);
  assert.deepEqual(mutations, [['update-ref', '--no-deref', '-d', TRACKING_REF, original]]);
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', TRACKING_REF], {
    cwd: root, allowFailure: true
  }).status, 1);
  assert.equal(git(root, 'rev-parse', 'refs/heads/main'), original);
});

test('a competing tracking-ref update defeats the exact old-OID CAS', async (t) => {
  const { root, original } = await fixture(t);
  await writeFile(path.join(root, 'README.md'), 'competing\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'competing local commit');
  const competing = git(root, 'rev-parse', 'HEAD');
  let attempted = false;
  await assert.rejects(refreshWorldModelV4Authority(root, CONFIG, {
    runLocalGit(command, args, options) {
      if (args[0] === 'update-ref') {
        attempted = true;
        git(root, 'update-ref', TRACKING_REF, competing, original);
      }
      return run(command, args, options);
    }
  }), assertRefreshFailure('tracking-ref-raced'));
  assert.equal(attempted, true);
  assert.equal(git(root, 'rev-parse', TRACKING_REF), competing);
});

test('lost CAS acknowledgement stays unknown even if the exact ref is now absent', async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(refreshWorldModelV4Authority(root, CONFIG, {
    runLocalGit(command, args, options) {
      const result = run(command, args, options);
      return args[0] === 'update-ref' ? { ...result, status: 1, timedOut: true } : result;
    }
  }), assertRefreshFailure('tracking-ref-outcome-unknown'));
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', TRACKING_REF], {
    cwd: root, allowFailure: true
  }).status, 1);
  const reconciled = await refreshWorldModelV4Authority(root, CONFIG);
  assert.equal(reconciled.status, 'remote-absent');
  assert.equal(reconciled.removedCachedRef, false);
});

test('symbolic tracking ref is refused before CAS and its target is untouched', async (t) => {
  const { root, original } = await fixture(t, { symbolic: true });
  let mutated = false;
  await assert.rejects(refreshWorldModelV4Authority(root, CONFIG, {
    runLocalGit(command, args, options) {
      if (args[0] === 'update-ref') mutated = true;
      return run(command, args, options);
    }
  }), assertRefreshFailure('tracking-ref-symbolic'));
  assert.equal(mutated, false);
  assert.equal(git(root, 'symbolic-ref', TRACKING_REF), 'refs/heads/main');
  assert.equal(git(root, 'rev-parse', 'refs/heads/main'), original);
});

test('a successful CAS followed by ref recreation cannot report remote-absent', async (t) => {
  const { root, original } = await fixture(t);
  let attempted = false;
  await assert.rejects(refreshWorldModelV4Authority(root, CONFIG, {
    runLocalGit(command, args, options) {
      const result = run(command, args, options);
      if (args[0] === 'update-ref') {
        attempted = true;
        git(root, 'update-ref', TRACKING_REF, original);
      }
      return result;
    }
  }), assertRefreshFailure('tracking-ref-raced'));
  assert.equal(attempted, true);
  assert.equal(git(root, 'rev-parse', TRACKING_REF), original);
});
