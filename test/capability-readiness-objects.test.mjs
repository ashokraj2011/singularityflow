import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { capabilityReadiness } from '../src/organisation.mjs';
import { GitRemoteSession, runRemoteGitAsync, sealTemporaryGitReadTransport } from '../src/git-execution.mjs';
import { enterpriseGitEnvironment } from '../src/git-enterprise-environment.mjs';
import { run } from '../src/util.mjs';

async function fixture(t, { model = true, objectFormat = 'sha1' } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-readiness-objects-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source');
  const remote = path.join(base, 'repository.git');
  run('git', ['init', '-q', `--object-format=${objectFormat}`, '-b', 'main', source]);
  run('git', ['config', 'user.name', 'Readiness Fixture'], { cwd: source });
  run('git', ['config', 'user.email', 'readiness@example.test'], { cwd: source });
  await writeFile(path.join(source, 'README.md'), 'Fixture\n');
  if (model) {
    await mkdir(path.join(source, 'singularity', 'world-model'), { recursive: true });
    // Readiness asks presence, not semantic validation. This also proves even a large model
    // manifest is not fetched to answer a one-entry tree question.
    await writeFile(path.join(source, 'singularity', 'world-model', 'manifest.json'), 'x'.repeat(2 * 1024 * 1024));
  }
  run('git', ['add', '-A'], { cwd: source });
  run('git', ['commit', '-qm', 'Initial'], { cwd: source });
  run('git', ['clone', '-q', '--bare', '--no-hardlinks', source, remote]);
  run('git', ['config', 'uploadpack.allowFilter', 'true'], { cwd: remote });
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

test('already-read readiness fetches trees only and never hydrates the manifest blob', async (t) => {
  const f = await fixture(t);
  const { advertisements, session } = sessionWithCalls();
  const blob = run('git', ['rev-parse', 'main:singularity/world-model/manifest.json'], { cwd: f.remote }).stdout.trim();
  let fetches = 0;
  let privateGitDir;
  const before = run('git', ['show-ref'], { cwd: f.remote }).stdout;
  const result = await capabilityReadiness('https://not-contacted.example.test/lead.git', {
    organisation: f.organisation, remoteSession: session,
    async runRemoteCommand(args, options) {
      fetches += 1;
      assert.ok(args.includes('--filter=blob:none'));
      assert.ok(args.includes('--no-tags'));
      assert.equal(args.includes('clone'), false);
      privateGitDir = args[args.indexOf('--git-dir') + 1];
      const fetched = await runRemoteGitAsync(args, options);
      assert.equal(fetched.status, 0);
      assert.equal(run('git', ['--git-dir', privateGitDir, 'cat-file', '-e', blob], {
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }, allowFailure: true
      }).status !== 0, true, 'the manifest blob is omitted before the owner reads trees');
      assert.notEqual(run('git', ['--git-dir', privateGitDir, 'remote']).stdout, '',
        'the fixture exercises Git’s implicit promisor creation before the owner seals it');
      return fetched;
    }
  });
  assert.deepEqual(result.application, {
    url: f.remote, stateBranch: null, hasStateBranch: false, worldModel: 'main',
    status: 'current', worldModelStatus: 'present'
  });
  assert.equal(fetches, 1);
  assert.equal(advertisements.length, 1, 'no second organisation authority read');
  assert.deepEqual(advertisements[0].slice(-2), ['refs/heads/state', 'refs/heads/main']);
  assert.equal(advertisements[0].includes('refs/heads/*'), false);
  assert.equal(run('git', ['show-ref'], { cwd: f.remote }).stdout, before);
  await assert.rejects(readFile(path.join(privateGitDir, 'HEAD')), { code: 'ENOENT' });
});

test('readiness prefers the state branch, reports genuine absence, and supports SHA-256 trees', async (t) => {
  const f = await fixture(t, { objectFormat: 'sha256' });
  run('git', ['update-ref', 'refs/heads/state', 'refs/heads/main'], { cwd: f.remote });
  const present = await capabilityReadiness(f.remote, { organisation: f.organisation });
  assert.equal(present.application.hasStateBranch, true);
  assert.equal(present.application.worldModel, 'state-branch');
  assert.equal(present.application.worldModelStatus, 'present');
  const missing = await fixture(t, { model: false });
  const absent = await capabilityReadiness(missing.remote, { organisation: missing.organisation });
  assert.equal(absent.application.status, 'current');
  assert.equal(absent.application.hasStateBranch, false);
  assert.equal(absent.application.worldModel, null);
  assert.equal(absent.application.worldModelStatus, 'missing');
});

test('unavailable advertisements and failed fetches are not missing-model evidence', async (t) => {
  const f = await fixture(t);
  let fetches = 0;
  const offline = new GitRemoteSession({ async runAsyncCommand() {
    return { status: 128, stdout: '', stderr: 'Fixture unavailable' };
  } });
  const unavailable = await capabilityReadiness(f.remote, {
    organisation: f.organisation, remoteSession: offline,
    async runRemoteCommand() { fetches += 1; throw new Error('Must not fetch after failed observation'); }
  });
  assert.equal(fetches, 0);
  assert.equal(unavailable.application.hasStateBranch, null);
  assert.equal(unavailable.application.status, 'unavailable');
  assert.equal(unavailable.application.worldModelStatus, 'unavailable');
  const failed = await capabilityReadiness(f.remote, {
    organisation: f.organisation,
    async runRemoteCommand() { return { status: 128, stdout: '', stderr: 'Fixture fetch refused' }; }
  });
  assert.equal(failed.application.hasStateBranch, false, 'successful observation still proves state absence');
  assert.equal(failed.application.status, 'unavailable');
  assert.equal(failed.application.worldModelStatus, 'unavailable');
});

test('readiness fences a branch move between advertisement and fetch', async (t) => {
  const f = await fixture(t);
  run('git', ['commit', '--allow-empty', '-qm', 'New exact revision'], { cwd: f.source });
  const result = await capabilityReadiness(f.remote, {
    organisation: f.organisation,
    async runRemoteCommand(args, options) {
      run('git', ['push', '-q', f.remote, 'main'], { cwd: f.source });
      return runRemoteGitAsync(args, options);
    }
  });
  assert.equal(result.application.status, 'authority-moved');
  assert.equal(result.application.worldModel, null);
  assert.equal(result.application.worldModelStatus, 'unavailable');
});

test('readiness captures catalog scalars before awaits and rejects unsafe query selectors', async (t) => {
  const f = await fixture(t);
  const reading = capabilityReadiness(f.remote, { organisation: f.organisation });
  f.organisation.repositories.application.url = 'https://must-not-contact.example.test/repository.git';
  f.organisation.repositories.application.defaultBranch = 'missing';
  assert.equal((await reading).application.worldModel, 'main');
  for (const options of [{ stateBranch: 'bad:branch' }, { outputDir: '../outside' },
    { outputDir: '/absolute' }, { outputDir: ':(glob)*' }]) {
    await assert.rejects(capabilityReadiness(f.remote, { ...options, organisation: {} }),
      (error) => error.code === 'CAPABILITY_READINESS_INPUT_INVALID');
  }
});

test('readiness reuses only exact-tip presence, observes each call, and retries unavailable reads', async (t) => {
  const f = await fixture(t);
  let advertisements = 0;
  let fetches = 0;
  const options = () => ({ organisation: f.organisation,
    remoteSession: new GitRemoteSession({ env: enterpriseGitEnvironment(), async runAsyncCommand(args, processOptions) {
      advertisements += 1;
      return runRemoteGitAsync(args, processOptions);
    } }),
    async runRemoteCommand(args, processOptions) {
      fetches += 1;
      return runRemoteGitAsync(args, processOptions);
    }
  });
  const first = await capabilityReadiness(f.remote, options());
  const second = await capabilityReadiness(f.remote, options());
  assert.deepEqual(second, first);
  assert.equal(advertisements, 2, 'a presence cache never substitutes for current ref observation');
  assert.equal(fetches, 1);
  await capabilityReadiness(f.remote, { ...options(), refresh: true });
  assert.equal(fetches, 2, 'explicit refresh rechecks exact trees');
  run('git', ['commit', '--allow-empty', '-qm', 'Byte-identical changed tip'], { cwd: f.source });
  run('git', ['push', '-q', f.remote, 'main'], { cwd: f.source });
  const failed = await capabilityReadiness(f.remote, { ...options(), async runRemoteCommand() {
    fetches += 1;
    return { status: 128, stdout: '', stderr: 'Fixture unavailable' };
  } });
  assert.equal(failed.application.status, 'unavailable');
  const retried = await capabilityReadiness(f.remote, options());
  assert.equal(retried.application.worldModel, 'main');
  assert.equal(fetches, 4, 'a changed commit and an unavailable result both require fresh tree reads');
  assert.equal(advertisements, 5);
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

test('exact-tip presence cache evicts old entries at its bounded capacity', async (t) => {
  const f = await fixture(t);
  let fetches = 0;
  const options = { organisation: f.organisation, async runRemoteCommand(args, processOptions) {
    fetches += 1;
    return runRemoteGitAsync(args, processOptions);
  } };
  await capabilityReadiness(f.remote, options);
  for (let index = 0; index < 136; index += 1) {
    const url = `https://no-network-fixture.example.test/${index}.git`;
    const absence = new GitRemoteSession({ async runAsyncCommand() {
      return { status: 0, stdout: '', stderr: '' };
    } });
    const result = await capabilityReadiness(url, {
      organisation: { repositories: { application: { url } } }, remoteSession: absence,
      async runRemoteCommand() { throw new Error('An exact absent tip must not be fetched'); }
    });
    assert.equal(result.application.worldModelStatus, 'missing');
  }
  await capabilityReadiness(f.remote, options);
  assert.equal(fetches, 2, 'the oldest exact pair is re-read rather than retained without bound');
});

test('SHA-1 presence initialization remains compatible with the supported Git 2.25 argument profile', {
  skip: process.platform === 'win32'
}, async (t) => {
  const f = await fixture(t);
  const realGit = run('which', ['git']).stdout.trim();
  const bin = path.join(f.base, 'qualification-bin');
  const wrapper = path.join(bin, 'git');
  const script = path.join(f.base, 'git-argument-profile.mjs');
  const log = path.join(f.base, 'git-arguments.jsonl');
  await mkdir(bin);
  await writeFile(script, `import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args.includes('--object-format=sha1')) process.exit(42);
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`);
  await chmod(wrapper, 0o755);
  const env = enterpriseGitEnvironment({ ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  const result = await capabilityReadiness(f.remote, {
    organisation: f.organisation, remoteSession: new GitRemoteSession({ env })
  });
  assert.equal(result.application.worldModel, 'main');
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map((row) => JSON.parse(row));
  assert.ok(calls.some((args) => args.includes('init')));
  assert.equal(calls.some((args) => args.includes('--object-format=sha1')), false);
});
