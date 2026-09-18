import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { executeGitQuery, gitQueryDescriptor } from '../src/git-query.mjs';
import {
  assertTrustedSgosConfigurationAuthority, withTrustedSgosConfigurationRead
} from '../src/sgos/authority-trust.mjs';
import { run } from '../src/util.mjs';

async function repository(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-sgos-trust-query-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'repo');
  run('git', ['init', '-b', 'main', root]);
  run('git', ['config', 'user.name', 'SGOS Trust Test'], { cwd: root });
  run('git', ['config', 'user.email', 'sgos-trust@example.test'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), 'local authority fixture\n');
  run('git', ['add', 'README.md'], { cwd: root });
  run('git', ['commit', '-m', 'initial'], { cwd: root });
  return { directory, root };
}

const LOCAL_AUTHORITY = Object.freeze({
  kind: 'approved-configuration-ref', ref: 'refs/heads/sflow/config'
});

test('SGOS remote query keeps one exact Git command and the offline no-remote trust profile', async (t) => {
  const { root } = await repository(t);
  const calls = [];
  const result = executeGitQuery(root, 'sgos.configured-remotes', {}, {
    runner(command, argv, options) {
      calls.push({ command, argv, allowFailure: options.allowFailure });
      return run(command, argv, options);
    }
  });
  assert.deepEqual(result, { ok: true, remotes: [] });
  assert.deepEqual(calls, [{ command: 'git', argv: ['remote'], allowFailure: true }]);
  assert.deepEqual(assertTrustedSgosConfigurationAuthority(root, LOCAL_AUTHORITY), {
    mode: 'offline-local-head-authority', remote: null
  });
});

test('SGOS sorts ambiguous configured remotes before refusing authority selection', async (t) => {
  const { root } = await repository(t);
  for (const name of ['reviewed', 'attacker']) {
    run('git', ['remote', 'add', name, `https://example.invalid/${name}.git`], { cwd: root });
  }
  assert.deepEqual(executeGitQuery(root, 'sgos.configured-remotes'), {
    ok: true, remotes: ['attacker', 'reviewed']
  });
  assert.throws(() => assertTrustedSgosConfigurationAuthority(root, LOCAL_AUTHORITY), (error) => {
    assert.equal(error.code, 'SGOS_CONFIGURATION_AUTHORITY_UNTRUSTED');
    assert.deepEqual(error.details?.configuredRemotes, ['attacker', 'reviewed']);
    return true;
  });
});

test('SGOS local-head query selects only its two canonical refs and treats Git failure as empty', async (t) => {
  const { root } = await repository(t);
  for (const ref of ['refs/heads/state', 'refs/heads/sflow/config', 'refs/heads/unrelated']) {
    run('git', ['update-ref', ref, 'HEAD'], { cwd: root });
  }
  const calls = [];
  assert.deepEqual(executeGitQuery(root, 'sgos.local-authority-heads', {}, {
    runner(command, argv, options) {
      calls.push({ command, argv, allowFailure: options.allowFailure });
      return run(command, argv, options);
    }
  }), ['refs/heads/sflow/config', 'refs/heads/state']);
  assert.deepEqual(calls, [{
    command: 'git',
    argv: ['for-each-ref', '--format=%(refname)', 'refs/heads/sflow/config', 'refs/heads/state'],
    allowFailure: true
  }]);
  assert.deepEqual(executeGitQuery(root, 'sgos.local-authority-heads', {}, {
    runner: () => ({ status: 1, stdout: 'refs/heads/sflow/config\n', stderr: 'failed' })
  }), []);
  assert.equal(gitQueryDescriptor('sgos.local-authority-heads').dependency, 'mutable');
});

test('SGOS remote-query failure retains the exact trust refusal code and trimmed Git stderr', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-sgos-nonrepo-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const observed = run('git', ['remote'], { cwd: directory, allowFailure: true });
  assert.notEqual(observed.status, 0);
  assert.deepEqual(executeGitQuery(directory, 'sgos.configured-remotes'), {
    ok: false, stderr: observed.stderr.trim()
  });
  assert.throws(() => assertTrustedSgosConfigurationAuthority(directory, LOCAL_AUTHORITY), (error) => {
    assert.equal(error.code, 'SGOS_CONFIGURATION_AUTHORITY_UNTRUSTED');
    assert.equal(error.details?.stderr, observed.stderr.trim());
    assert.match(error.message, /remote boundary/i);
    return true;
  });
});

test('a configured remote never falls back to a locally manufactured SGOS head', async (t) => {
  const { directory, root } = await repository(t);
  const remote = path.join(directory, 'remote.git');
  run('git', ['init', '--bare', remote]);
  run('git', ['remote', 'add', 'origin', remote], { cwd: root });
  run('git', ['update-ref', 'refs/heads/sflow/config', 'HEAD'], { cwd: root });
  let called = false;
  await assert.rejects(withTrustedSgosConfigurationRead(root, () => {
    called = true;
  }, { refreshAuthority: false }), (error) => {
    assert.equal(error.code, 'SGOS_CONFIGURATION_AUTHORITY_UNTRUSTED');
    assert.deepEqual(error.details?.localAuthorityRefs, ['refs/heads/sflow/config']);
    assert.deepEqual(error.details?.configuredRemotes, ['origin']);
    return true;
  });
  assert.equal(called, false);
});
