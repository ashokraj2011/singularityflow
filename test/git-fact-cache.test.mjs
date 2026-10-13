import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  cachedGitFact, clearGitFactCache, gitFactCacheHits, gitFactKind, gitFactRequest,
  gitFactSnapshot, rememberGitFact
} from '../src/git-fact-cache.mjs';
import { run } from '../src/util.mjs';

/** Git outside `run()`: another program, a child process or a test changing the repository. */
function outside(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-git-facts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  outside(root, ['init', '-q', '-b', 'main']);
  outside(root, ['config', 'user.name', 'Fact Tester']);
  outside(root, ['config', 'user.email', 'facts@example.test']);
  await writeFile(path.join(root, 'a.txt'), 'one\n');
  outside(root, ['add', 'a.txt']);
  outside(root, ['commit', '-q', '-m', 'one']);
  clearGitFactCache();
  return root;
}

function asked(root, args, options = {}) {
  return run('git', args, { cwd: root, allowFailure: true, ...options });
}

test('only repository location, HEAD, configuration and ref-name checks are cacheable', () => {
  const sha = 'a'.repeat(40);
  const cases = [
    [['branch', '--show-current'], 'head'],
    [['rev-parse', 'HEAD'], 'head'],
    [['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'], 'head'],
    [['symbolic-ref', '-q', 'HEAD'], 'head'],
    [['rev-parse', '--show-toplevel'], 'location'],
    [['rev-parse', '--path-format=absolute', '--git-common-dir'], 'location'],
    [['config', '--local', '--get-all', 'remote.origin.url'], 'config'],
    [['config', '--get', 'user.name'], 'config'],
    [['remote', 'get-url', '--push', 'origin'], 'config'],
    [['remote'], 'config'],
    // A name checked as a string, with no repository or file behind the answer.
    [['check-ref-format', '--branch', 'feature/x'], 'ref-format'],
    [['check-ref-format', 'refs/remotes/origin/feature'], 'ref-format'],
    [['check-ref-format', '--branch', '@{-1}'], null],
    [['check-ref-format', '--normalize', 'refs/heads/x'], null],
    // An object read is also a proof the object is present now; destructive checks rely on it.
    [['show', `${sha}:singularity/workflow.yml`], null],
    [['ls-tree', '-r', '-z', sha, '--', 'docs'], null],
    [['rev-parse', '--verify', `${sha}^{tree}`], null],
    [['cat-file', '-t', sha], null],
    // Refs move under a running command when another program fetches: never cached.
    [['rev-parse', '--verify', 'refs/remotes/origin/main'], null],
    [['show-ref', '--verify', '--quiet', 'refs/heads/main'], null],
    [['for-each-ref', '--format=%(refname)', 'refs/heads'], null],
    [['show', 'HEAD:a.txt'], null],
    [['show', sha], null],
    // Writes, global options and anything this module cannot vouch for go to Git.
    [['config', 'user.name', 'Someone'], null],
    [['config', '--system', '--get', 'user.name'], null],
    [['config', '--file', 'x', '--get', 'a.b'], null],
    [['-C', '/tmp', 'rev-parse', 'HEAD'], null],
    [['remote', 'set-url', 'origin', 'x'], null],
    [['commit', '-m', 'x'], null],
    [['log', '--format=%H', sha], null]
  ];
  for (const [args, kind] of cases) assert.equal(gitFactKind(args), kind, args.join(' '));
});

test('a repeated HEAD, branch, location or configuration question is answered without Git', async (t) => {
  const root = await repository(t);
  for (const args of [['rev-parse', 'HEAD'], ['branch', '--show-current'], ['rev-parse', '--show-toplevel'],
    ['config', '--get', 'user.name']]) {
    const first = asked(root, args);
    const before = gitFactCacheHits();
    const second = asked(root, args);
    assert.equal(gitFactCacheHits(), before + 1, `${args.join(' ')} was asked of Git again`);
    assert.deepEqual({ status: second.status, stdout: second.stdout }, { status: first.status, stdout: first.stdout });
  }
});

test('an answer is not reused after anything changes the files it came from', async (t) => {
  const root = await repository(t);
  const firstHead = asked(root, ['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(asked(root, ['branch', '--show-current']).stdout.trim(), 'main');
  assert.equal(asked(root, ['config', '--get', 'user.name']).stdout.trim(), 'Fact Tester');
  assert.equal(asked(root, ['remote']).stdout.trim(), '');

  // Every change below is made outside run(), so nothing could have told the cache about it.
  await writeFile(path.join(root, 'a.txt'), 'two\n');
  outside(root, ['commit', '-q', '-am', 'two']);
  const secondHead = asked(root, ['rev-parse', 'HEAD']).stdout.trim();
  assert.notEqual(secondHead, firstHead, 'a commit by another program moved HEAD');
  assert.equal(secondHead, outside(root, ['rev-parse', 'HEAD']));

  outside(root, ['checkout', '-q', '-b', 'feature']);
  assert.equal(asked(root, ['branch', '--show-current']).stdout.trim(), 'feature');
  assert.equal(asked(root, ['symbolic-ref', '-q', 'HEAD']).stdout.trim(), 'refs/heads/feature');

  outside(root, ['config', 'user.name', 'Renamed Tester']);
  assert.equal(asked(root, ['config', '--get', 'user.name']).stdout.trim(), 'Renamed Tester');
  outside(root, ['remote', 'add', 'origin', 'https://example.test/one.git']);
  assert.equal(asked(root, ['remote']).stdout.trim(), 'origin');
  assert.equal(asked(root, ['remote', 'get-url', 'origin']).stdout.trim(), 'https://example.test/one.git');
  outside(root, ['remote', 'set-url', 'origin', 'https://example.test/two.git']);
  assert.equal(asked(root, ['remote', 'get-url', 'origin']).stdout.trim(), 'https://example.test/two.git');

  // A packed branch moved by a loose update, and a detached HEAD.
  outside(root, ['pack-refs', '--all']);
  const packed = asked(root, ['rev-parse', 'HEAD']).stdout.trim();
  await writeFile(path.join(root, 'a.txt'), 'three\n');
  outside(root, ['commit', '-q', '-am', 'three']);
  assert.notEqual(asked(root, ['rev-parse', 'HEAD']).stdout.trim(), packed);
  outside(root, ['checkout', '-q', '--detach', firstHead]);
  assert.equal(asked(root, ['rev-parse', 'HEAD']).stdout.trim(), firstHead);
  assert.equal(asked(root, ['branch', '--show-current']).stdout.trim(), '');
});

test('a missing configuration value is an answer; a failure and any object read are not kept', async (t) => {
  const root = await repository(t);
  const missing = asked(root, ['config', '--get', 'example.absent']);
  assert.equal(missing.status, 1);
  const before = gitFactCacheHits();
  assert.equal(asked(root, ['config', '--get', 'example.absent']).status, 1);
  assert.equal(gitFactCacheHits(), before + 1, 'config --get exit 1 is Git\'s answer and is kept');
  outside(root, ['config', 'example.absent', 'now-present']);
  assert.equal(asked(root, ['config', '--get', 'example.absent']).stdout.trim(), 'now-present');

  const head = outside(root, ['rev-parse', 'HEAD']);
  const absentPath = asked(root, ['show', `${head}:not-there.txt`]);
  assert.notEqual(absentPath.status, 0);
  const afterFailure = gitFactCacheHits();
  asked(root, ['show', `${head}:not-there.txt`]);
  assert.equal(gitFactCacheHits(), afterFailure, 'a failed object read is asked again');

  assert.equal(asked(root, ['show', `${head}:a.txt`]).stdout, 'one\n');
  const afterSuccess = gitFactCacheHits();
  assert.equal(asked(root, ['show', `${head}:a.txt`]).stdout, 'one\n');
  assert.equal(gitFactCacheHits(), afterSuccess, 'an object read always asks Git, so it proves presence now');
});

test('a relocating environment, includes, stdin, an injected runner and the switch all bypass the cache', async (t) => {
  const root = await repository(t);
  const bypassed = (args, options) => {
    asked(root, args, options);
    const before = gitFactCacheHits();
    asked(root, args, options);
    return gitFactCacheHits() === before;
  };
  assert.ok(bypassed(['rev-parse', 'HEAD'], { env: { ...process.env, GIT_DIR: path.join(root, '.git') } }));
  assert.ok(bypassed(['rev-parse', 'HEAD'], { env: { ...process.env, SINGULARITY_FLOW_GIT_FACT_CACHE: 'off' } }));
  assert.ok(bypassed(['rev-parse', 'HEAD'], { input: '' }));
  assert.ok(bypassed(['rev-parse', 'HEAD'], { spawnSyncCommand: (...args) => spawnSync(...args) }));

  await writeFile(path.join(root, 'included.gitconfig'), '[example]\n\tvalue = included\n');
  outside(root, ['config', 'include.path', path.join(root, 'included.gitconfig')]);
  assert.ok(bypassed(['config', '--get', 'example.value']), 'an included file is not tracked, so nothing is kept');
  assert.equal(asked(root, ['config', '--get', 'example.value']).stdout.trim(), 'included');
});

test('the same question in two checkouts of one repository has two answers', async (t) => {
  const root = await repository(t);
  const linked = path.join(root, '..', `${path.basename(root)}-linked`);
  t.after(() => rm(linked, { recursive: true, force: true }));
  outside(root, ['worktree', 'add', '-q', '-b', 'linked', linked]);
  assert.equal(asked(root, ['branch', '--show-current']).stdout.trim(), 'main');
  assert.equal(asked(linked, ['branch', '--show-current']).stdout.trim(), 'linked');
  assert.equal(asked(linked, ['rev-parse', '--show-toplevel']).stdout.trim(), outside(linked, ['rev-parse', '--show-toplevel']));
  await writeFile(path.join(linked, 'a.txt'), 'linked\n');
  outside(linked, ['commit', '-q', '-am', 'linked']);
  assert.equal(asked(linked, ['rev-parse', 'HEAD']).stdout.trim(), outside(linked, ['rev-parse', 'HEAD']));
  assert.notEqual(asked(linked, ['rev-parse', 'HEAD']).stdout.trim(), asked(root, ['rev-parse', 'HEAD']).stdout.trim());
});

test('Windows reuses location, HEAD and configuration facts and invalidates an external ref update', async (t) => {
  const root = await repository(t);
  const env = { GIT_NO_REPLACE_OBJECTS: '1' };
  for (const args of [['branch', '--show-current'], ['rev-parse', 'HEAD'], ['rev-parse', '--git-common-dir']]) {
    const request = gitFactRequest(args, { cwd: root, env, platform: 'win32' });
    assert.ok(request);
    const before = gitFactSnapshot(request);
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    rememberGitFact(request, result, { before });
    assert.equal(cachedGitFact(request)?.stdout, result.stdout);
  }
  const head = gitFactRequest(['rev-parse', 'HEAD'], { cwd: root, env, platform: 'win32' });
  await writeFile(path.join(root, 'a.txt'), 'external update\n');
  outside(root, ['commit', '-q', '-am', 'external update']);
  assert.equal(cachedGitFact(head), null, 'a different program moving the ref invalidates reuse');
  // Every Git process is dearer on Windows; configuration reads are reused there too.
  for (const args of [['config', '--get', 'user.name'], ['remote', 'get-url', 'origin']]) {
    assert.equal(gitFactRequest(args, { cwd: root, env, platform: 'win32' })?.kind, 'config', args.join(' '));
  }
  for (const args of [['show-ref', '--verify', 'refs/heads/main'], ['cat-file', '-t', 'HEAD']]) {
    assert.equal(gitFactRequest(args, { cwd: root, env, platform: 'win32' }), null);
  }
  for (const env of [{ Git_Dir: root }, { Home: root }, { GIT_DIR: root },
    { SINGULARITY_FLOW_GIT_FACT_CACHE: 'off' }]) {
    assert.equal(gitFactRequest(['rev-parse', 'HEAD'], { cwd: root, env, platform: 'win32' }), null);
  }
});

test('Windows facts are not reused when dependencies changed during Git execution', async (t) => {
  const root = await repository(t);
  const request = gitFactRequest(['rev-parse', 'HEAD'], { cwd: root, env: {}, platform: 'win32' });
  const before = gitFactSnapshot(request);
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  outside(root, ['checkout', '-q', '-b', 'different']);
  rememberGitFact(request, result, { before });
  assert.equal(cachedGitFact(request), null);
});

test('a Windows configuration answer is tied to every file Git for Windows may read it from', async (t) => {
  const root = await repository(t);
  const machine = await mkdtemp(path.join(os.tmpdir(), 'sflow-git-facts-machine-'));
  t.after(() => rm(machine, { recursive: true, force: true }));
  const share = path.join(machine, 'share');
  const profile = path.join(machine, 'profile');
  const programData = path.join(machine, 'ProgramData');
  for (const directory of [share, profile, path.join(programData, 'Git')]) await mkdir(directory, { recursive: true });
  // HOME unset: Git for Windows takes HOMEDRIVE+HOMEPATH when it exists, else USERPROFILE.
  const env = { GIT_NO_REPLACE_OBJECTS: '1', HOMEDRIVE: machine, HOMEPATH: 'share', USERPROFILE: profile, ProgramData: programData };
  const args = ['config', '--get', 'user.name'];
  const answer = () => {
    const request = gitFactRequest(args, { cwd: root, env, platform: 'win32' });
    rememberGitFact(request, spawnSync('git', args, { cwd: root, encoding: 'utf8' }), { before: gitFactSnapshot(request) });
    assert.ok(cachedGitFact(request), 'kept');
    return request;
  };
  for (const changed of [path.join(share, '.gitconfig'), path.join(profile, '.gitconfig'),
    path.join(share, '.config', 'git', 'config'), path.join(programData, 'Git', 'config')]) {
    const request = answer();
    await mkdir(path.dirname(changed), { recursive: true });
    await writeFile(changed, '[core]\n\tautocrlf = true\n');
    assert.equal(cachedGitFact(request), null, `a change to ${path.relative(machine, changed)} invalidates the answer`);
  }
  // An include in the machine-wide file cannot be followed: nothing is kept.
  await writeFile(path.join(programData, 'Git', 'config'), '[include]\n\tpath = elsewhere\n');
  const included = gitFactRequest(args, { cwd: root, env, platform: 'win32' });
  rememberGitFact(included, spawnSync('git', args, { cwd: root, encoding: 'utf8' }), { before: gitFactSnapshot(included) });
  assert.equal(cachedGitFact(included), null);
  // Two spellings of ProgramData that disagree are ambiguous: Git is asked.
  assert.equal(gitFactRequest(args, { cwd: root, env: { ...env, PROGRAMDATA: share }, platform: 'win32' }), null);
  assert.ok(gitFactRequest(args, { cwd: root, env: { ...env, PROGRAMDATA: programData }, platform: 'win32' }), 'agreeing spellings are one variable');
});

test('a ref-name check is answered once, valid or not, without a repository behind it', async (t) => {
  const root = await repository(t);
  // A valid branch name, and an invalid ref (exit 1): both are answers, kept outright.
  for (const args of [['check-ref-format', '--branch', 'feature/ok'], ['check-ref-format', 'refs/heads/bad..name']]) {
    const first = asked(root, args);
    const hitsBefore = gitFactCacheHits();
    const second = asked(root, args);
    assert.equal(gitFactCacheHits(), hitsBefore + 1, `${args.join(' ')} came from the cache`);
    assert.equal(second.status, first.status, args.join(' '));
  }
  // An invalid --branch name is a fatal exit, which is never kept: Git refuses it every time.
  const hitsBefore = gitFactCacheHits();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.notEqual(asked(root, ['check-ref-format', '--branch', 'bad..name']).status, 0);
  }
  assert.equal(gitFactCacheHits(), hitsBefore);
});
