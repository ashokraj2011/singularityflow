import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { capabilityReadiness } from '../src/organisation.mjs';
import { GitRemoteSession, runRemoteGitAsync, sealTemporaryGitReadTransport } from '../src/git-execution.mjs';
import { enterpriseGitEnvironment } from '../src/git-enterprise-environment.mjs';
import { run } from '../src/util.mjs';

async function fixture(t, { objectFormat = 'sha1' } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-readiness-objects-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source');
  const remote = path.join(base, 'repository.git');
  run('git', ['init', '-q', `--object-format=${objectFormat}`, '-b', 'main', source]);
  run('git', ['config', 'user.name', 'Readiness Fixture'], { cwd: source });
  run('git', ['config', 'user.email', 'readiness@example.test'], { cwd: source });
  await writeFile(path.join(source, 'README.md'), 'Fixture\n');
  run('git', ['add', '-A'], { cwd: source });
  run('git', ['commit', '-qm', 'Initial'], { cwd: source });
  run('git', ['clone', '-q', '--bare', '--no-hardlinks', source, remote]);
  const organisation = { repositories: { application: { url: remote, defaultBranch: 'main' } } };
  return { base, source, remote, organisation };
}

function sessionWithCalls() {
  const advertisements = [];
  const session = new GitRemoteSession({ env: enterpriseGitEnvironment(), async runAsyncCommand(args, options) {
    advertisements.push(args);
    return runRemoteGitAsync(args, options);
  } });
  return { advertisements, session };
}

test('readiness answers whether the state branch exists from one exact advertisement', async (t) => {
  for (const objectFormat of ['sha1', 'sha256']) {
    const f = await fixture(t, { objectFormat });
    const main = run('git', ['rev-parse', 'refs/heads/main'], { cwd: f.remote }).stdout;
    const absentCalls = sessionWithCalls();
    const absent = await capabilityReadiness('https://not-contacted.example.test/lead.git', {
      organisation: f.organisation, remoteSession: absentCalls.session
    });
    assert.deepEqual(absent.application, { url: f.remote, stateBranch: null, hasStateBranch: false, status: 'current' });
    assert.equal(absentCalls.advertisements.length, 1, 'no organisation read and no fetch');
    assert.deepEqual(absentCalls.advertisements[0].slice(-1), ['refs/heads/state']);
    run('git', ['update-ref', 'refs/heads/state', 'refs/heads/main'], { cwd: f.remote });
    const present = await capabilityReadiness(f.remote, { organisation: f.organisation });
    assert.deepEqual(present.application, { url: f.remote, stateBranch: 'state', hasStateBranch: true, status: 'current' });
    assert.equal(run('git', ['rev-parse', 'refs/heads/main'], { cwd: f.remote }).stdout, main, 'nothing on the remote changes');
  }
});

test('an unavailable advertisement is not evidence of a missing state branch', async (t) => {
  const f = await fixture(t);
  const offline = new GitRemoteSession({ async runAsyncCommand() {
    return { status: 128, stdout: '', stderr: 'Fixture unavailable' };
  } });
  const unavailable = await capabilityReadiness(f.remote, { organisation: f.organisation, remoteSession: offline });
  assert.equal(unavailable.application.hasStateBranch, null);
  assert.equal(unavailable.application.stateBranch, null);
  assert.equal(unavailable.application.status, 'unavailable');
});

test('readiness captures catalog scalars before awaits and rejects unsafe selectors', async (t) => {
  const f = await fixture(t);
  run('git', ['update-ref', 'refs/heads/state', 'refs/heads/main'], { cwd: f.remote });
  const reading = capabilityReadiness(f.remote, { organisation: f.organisation });
  f.organisation.repositories.application.url = 'https://must-not-contact.example.test/repository.git';
  assert.equal((await reading).application.hasStateBranch, true);
  for (const options of [{ stateBranch: 'bad:branch', organisation: f.organisation }, { organisation: {} }]) {
    await assert.rejects(capabilityReadiness(f.remote, options),
      (error) => error.code === 'CAPABILITY_READINESS_INPUT_INVALID');
  }
});

test('private bare transport sealing removes modern/legacy promisors and refuses ordinary remotes before mutation', async (t) => {
  const f = await fixture(t);
  const scratch = path.join(f.base, 'private.git');
  run('git', ['init', '-q', '--bare', scratch]);
  const alias = 'sflow-frozen-00000000-0000-0000-0000-000000000000:';
  // Git’s filtered URL fetch creates this unusual remote name directly in config; `remote add`
  // rejects the colon even though `remote remove` supports the resulting Git-owned entry.
  run('git', ['config', `remote.${alias}.url`, f.remote], { cwd: scratch });
  run('git', ['config', `remote.${alias}.promisor`, 'true'], { cwd: scratch });
  run('git', ['config', `remote.${alias}.partialclonefilter`, 'blob:none'], { cwd: scratch });
  run('git', ['config', 'extensions.partialClone', alias], { cwd: scratch });
  assert.deepEqual(sealTemporaryGitReadTransport(scratch), { ok: true, cleanupUnproven: false });
  assert.equal(run('git', ['remote'], { cwd: scratch }).stdout, '');
  assert.equal(run('git', ['config', '--local', '--get-regexp', 'promisor|partialclone'], {
    cwd: scratch, allowFailure: true
  }).status, 1);
  run('git', ['remote', 'add', 'origin', f.remote], { cwd: scratch });
  const before = await readFile(path.join(scratch, 'config'));
  assert.deepEqual(sealTemporaryGitReadTransport(scratch), { ok: false, cleanupUnproven: false });
  assert.deepEqual(await readFile(path.join(scratch, 'config')), before);
  assert.deepEqual(sealTemporaryGitReadTransport(f.source), { ok: false, cleanupUnproven: false },
    'a normal application checkout is never a transport cleanup target');
});
