import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  cachedGitFact, clearGitFactCache, gitFactCacheHits, gitFactKind, gitFactRequest,
  gitFactSnapshot, rememberGitFact, withFreshGitFacts
} from '../src/git-fact-cache.mjs';
import {
  governedCommitIdentity, head, localBranches, refExists, refHead, remoteBranches,
  remoteDefaultBranchName, shallowBoundaryCommit, stagedEntriesForPaths
} from '../src/git.mjs';
import { withReadScope } from '../src/read-scope.mjs';
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

test('only repository location, HEAD, the index, history and single object reads, configuration and ref-name checks are cacheable', () => {
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
    // A single object read by its full ID is tied to the object store, so it still proves presence.
    [['show', `${sha}:singularity/workflow.yml`], 'object'],
    [['ls-tree', '-r', '-z', sha, '--', 'docs'], 'object'],
    [['ls-tree', '-rz', '--format=%(objectmode)%x09%(objecttype)%x09%(objectname)%x09%(path)', sha, '--'], 'object'],
    [['rev-parse', '--verify', `${sha}^{tree}`], 'object'],
    [['cat-file', '-t', sha], 'object'],
    [['merge-base', '--is-ancestor', sha, sha], 'ancestry'],
    // A path relative to the directory, an abbreviation, a commit's own output or stdin go to Git.
    [['show', `${sha}:./a.txt`], null],
    [['ls-tree', '--abbrev', sha], null],
    [['cat-file', '--batch'], null],
    [['merge-base', sha, sha], null],
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
    [['log', '--format=%H', sha], null],
    // History from HEAD limited to paths, with output the commits alone decide.
    [['log', '--format=%H', '--diff-filter=A', '--reverse', '--', 'singularity/work-items/A-1/workflow.json'], 'history'],
    [['log', '--full-history', '--format=%H', '--', 'a.txt'], 'history'],
    [['log', '--format=%H', 'HEAD', '--', 'a.txt'], 'history'],
    [['log', '--first-parent', '--max-count=3', '--format=%x1f%s', '--', 'a.txt'], 'history'],
    // Another starting point, a time window, an abbreviation, a relative date, renames, or no path.
    [['log', '--format=%H', 'main', '--', 'a.txt'], null],
    [['log', '--format=%H', `${sha}..HEAD`, '--', 'a.txt'], null],
    [['log', '--since=12 months ago', '--format=%H', '--', 'a.txt'], null],
    [['log', '--format=%h', '--', 'a.txt'], null],
    [['log', '--format=%cr', '--', 'a.txt'], null],
    [['log', '--follow', '--format=%H', '--', 'a.txt'], null],
    [['log', '--format=%H', '--'], null],
    [['log', '--format=%H'], null],
    // The index alone answers a cached-mode listing; one that reads the working tree goes to Git.
    [['ls-files', '--stage', '-z'], 'index'],
    [['ls-files', '-v', '-z'], 'index'],
    [['ls-files', '--unmerged', '-z'], 'index'],
    [['ls-files', '-z', '--', '*workflow.json'], 'index'],
    [['ls-files', '--others', '--exclude-standard', '-z'], null],
    [['ls-files', '--modified', '-z'], null],
    [['ls-files', '--deleted'], null],
    [['--no-optional-locks', 'ls-files', '--stage'], null]
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

test('a fresh scope asks Git every question, including after it awaits, and leaves its answers for later readers', async (t) => {
  const root = await repository(t);
  const args = ['rev-parse', 'HEAD'];
  asked(root, args);
  const before = gitFactCacheHits();
  withFreshGitFacts(() => asked(root, args));
  await withFreshGitFacts(async () => { await null; asked(root, args); });
  assert.equal(gitFactCacheHits(), before, 'a fresh proof was answered from the cache');
  assert.throws(() => withFreshGitFacts(() => { throw new Error('read failed'); }), /read failed/u);
  asked(root, args);
  assert.equal(gitFactCacheHits(), before + 1, 'the scope ended, even after a failure');
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

test('history from HEAD is reused until HEAD, a replacement or the shallow boundary changes what Git sees', async (t) => {
  const root = await repository(t);
  const history = ['log', '--format=%H', '--', 'a.txt'];
  const added = ['log', '--format=%H', '--diff-filter=A', '--reverse', '--', 'a.txt'];
  const first = outside(root, ['rev-parse', 'HEAD']);
  assert.equal(asked(root, added).stdout.trim(), first);
  let before = gitFactCacheHits();
  assert.equal(asked(root, added).stdout.trim(), first);
  assert.equal(gitFactCacheHits(), before + 1, 'the same history question from the same HEAD is not walked again');

  // Every change below is made outside run().
  await writeFile(path.join(root, 'a.txt'), 'two\n');
  outside(root, ['commit', '-q', '-am', 'two']);
  const second = outside(root, ['rev-parse', 'HEAD']);
  assert.equal(asked(root, history).stdout.trim(), [second, first].join('\n'), 'a commit by another program moved HEAD');
  before = gitFactCacheHits();
  assert.equal(asked(root, history).stdout.trim(), [second, first].join('\n'));
  assert.equal(gitFactCacheHits(), before + 1);

  // A replacement commit with no parent hides the first commit.
  const tree = outside(root, ['rev-parse', 'HEAD^{tree}']);
  const orphan = outside(root, ['commit-tree', tree, '-m', 'replacement']);
  outside(root, ['replace', second, orphan]);
  assert.equal(asked(root, history).stdout.trim(), second, 'Git shows the replacement in place of the original');
  outside(root, ['replace', '-d', second]);
  assert.equal(asked(root, history).stdout.trim(), [second, first].join('\n'));

  // A shallow boundary at HEAD hides everything older.
  await writeFile(path.join(root, '.git', 'shallow'), `${second}\n`);
  assert.equal(asked(root, history).stdout.trim(), second, 'the shallow boundary changed which commits Git can see');
});

test('an index listing is reused until the index changes; another index file and working-tree listings always ask Git', async (t) => {
  const root = await repository(t);
  const listing = ['ls-files', '--stage', '-z'];
  const first = asked(root, listing).stdout;
  assert.match(first, /\ta\.txt\0$/u);
  let before = gitFactCacheHits();
  assert.equal(asked(root, listing).stdout, first);
  assert.equal(gitFactCacheHits(), before + 1, 'an unchanged index is not listed again');

  // Staged by another program, outside run().
  await writeFile(path.join(root, 'b.txt'), 'b\n');
  outside(root, ['add', 'b.txt']);
  assert.match(asked(root, listing).stdout, /\tb\.txt\0$/u, 'a staged file is listed');
  outside(root, ['update-index', '--skip-worktree', 'a.txt']);
  assert.match(asked(root, ['ls-files', '-v', '-z']).stdout, /^S a\.txt\0/mu);
  before = gitFactCacheHits();
  asked(root, ['ls-files', '-v', '-z']);
  assert.equal(gitFactCacheHits(), before + 1);

  // A scratch index and a working-tree listing are always read from Git.
  const scratch = path.join(root, '.git', 'scratch-index');
  outside(root, ['read-tree', `--index-output=${scratch}`, 'HEAD']);
  before = gitFactCacheHits();
  for (let index = 0; index < 2; index += 1) {
    asked(root, listing, { env: { ...process.env, GIT_INDEX_FILE: scratch } });
    asked(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  }
  assert.equal(gitFactCacheHits(), before, 'neither was answered from the cache');
  await writeFile(path.join(root, 'c.txt'), 'c\n');
  assert.match(asked(root, ['ls-files', '--others', '--exclude-standard', '-z']).stdout, /c\.txt/u);
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
  assert.equal(gitFactCacheHits(), afterSuccess + 1, 'a successful object read is kept while every object is still there');
});

test('an object read is refused again once its object is gone, and asked again after a repack', async (t) => {
  const root = await repository(t);
  const head = outside(root, ['rev-parse', 'HEAD']);
  const blob = outside(root, ['rev-parse', 'HEAD:a.txt']);
  const reads = [['show', `${head}:a.txt`], ['cat-file', '-p', blob], ['rev-parse', '--verify', `${head}^{tree}`],
    ['ls-tree', '-z', head, '--', 'a.txt']];
  const answers = reads.map((args) => asked(root, args).stdout);
  let before = gitFactCacheHits();
  reads.forEach((args, index) => assert.equal(asked(root, args).stdout, answers[index]));
  assert.equal(gitFactCacheHits(), before + reads.length, 'every object read came from the cache');

  // Another program deletes the blob: the reads that proved it present now fail, as without a cache.
  await rm(path.join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  assert.notEqual(asked(root, reads[0]).status, 0);
  assert.notEqual(asked(root, reads[1]).status, 0);
  assert.equal(asked(root, reads[2]).stdout, answers[2], 'the tree is still there');

  const packed = await repository(t);
  const packedHead = outside(packed, ['rev-parse', 'HEAD']);
  const read = ['show', `${packedHead}:a.txt`];
  asked(packed, read);
  outside(packed, ['repack', '-adq']);
  before = gitFactCacheHits();
  assert.equal(asked(packed, read).stdout, 'one\n');
  assert.equal(gitFactCacheHits(), before, 'a repack moved every object, so Git is asked again');
});

test('a replacement object changes what an object read answers, unless replacements are switched off', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'a.txt'), 'two\n');
  outside(root, ['commit', '-q', '-am', 'two']);
  const second = outside(root, ['rev-parse', 'HEAD']);
  const read = ['cat-file', '-p', second];
  const original = asked(root, read).stdout;
  assert.match(original, /^parent /mu);
  const orphan = outside(root, ['commit-tree', outside(root, ['rev-parse', 'HEAD^{tree}']), '-m', 'replacement']);
  outside(root, ['replace', second, orphan]);
  assert.doesNotMatch(asked(root, read).stdout, /^parent /mu, 'Git shows the replacement');
  assert.equal(asked(root, read, { env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } }).stdout, original);
});

test('"not an ancestor" is an answer, kept until the shallow boundary changes which commits Git sees', async (t) => {
  const root = await repository(t);
  const first = outside(root, ['rev-parse', 'HEAD']);
  await writeFile(path.join(root, 'a.txt'), 'two\n');
  outside(root, ['commit', '-q', '-am', 'two']);
  const second = outside(root, ['rev-parse', 'HEAD']);
  const notAncestor = ['merge-base', '--is-ancestor', second, first];
  const ancestor = ['merge-base', '--is-ancestor', first, second];
  assert.equal(asked(root, notAncestor).status, 1);
  assert.equal(asked(root, ancestor).status, 0);
  const before = gitFactCacheHits();
  assert.equal(asked(root, notAncestor).status, 1);
  assert.equal(asked(root, ancestor).status, 0);
  assert.equal(gitFactCacheHits(), before + 2);
  await writeFile(path.join(root, '.git', 'shallow'), `${second}\n`);
  const afterShallow = gitFactCacheHits();
  asked(root, ancestor);
  assert.equal(gitFactCacheHits(), afterShallow, 'the shallow boundary changed which commits Git sees');
});

test('a borrowed or relocated object store is never answered from the cache', async (t) => {
  const root = await repository(t);
  const head = outside(root, ['rev-parse', 'HEAD']);
  const read = ['show', `${head}:a.txt`];
  let before = gitFactCacheHits();
  for (const name of ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH']) {
    const env = { ...process.env, [name]: path.join(root, '.git', 'objects') };
    asked(root, read, { env });
    asked(root, read, { env });
  }
  assert.equal(gitFactCacheHits(), before, 'a relocated object directory is not the one fingerprinted');
  const lender = await repository(t);
  await writeFile(path.join(root, '.git', 'objects', 'info', 'alternates'), `${path.join(lender, '.git', 'objects')}\n`);
  before = gitFactCacheHits();
  asked(root, read);
  asked(root, read);
  assert.equal(gitFactCacheHits(), before, 'objects borrowed through alternates are not fingerprinted');
});

test('no answer outlives fifteen minutes, and another Git on PATH is asked afresh', async (t) => {
  const root = await repository(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-14T00:00:00.000Z') });
  t.after(() => t.mock.timers.reset());
  asked(root, ['rev-parse', 'HEAD']);
  let before = gitFactCacheHits();
  asked(root, ['rev-parse', 'HEAD']);
  assert.equal(gitFactCacheHits(), before + 1);
  t.mock.timers.tick(16 * 60 * 1000);
  before = gitFactCacheHits();
  asked(root, ['rev-parse', 'HEAD']);
  assert.equal(gitFactCacheHits(), before, 'a sixteen-minute-old answer is asked again');
  if (process.platform === 'win32') return;
  const execPath = outside(root, ['--exec-path']);
  const wrapper = await mkdtemp(path.join(os.tmpdir(), 'sflow-git-wrapper-'));
  t.after(() => rm(wrapper, { recursive: true, force: true }));
  await writeFile(path.join(wrapper, 'git'), `#!/bin/sh\nexec "${path.join(execPath, 'git')}" "$@"\n`);
  await chmod(path.join(wrapper, 'git'), 0o755);
  before = gitFactCacheHits();
  const answer = asked(root, ['rev-parse', 'HEAD'], { env: { ...process.env, PATH: `${wrapper}:${process.env.PATH}` } });
  assert.equal(answer.stdout.trim(), outside(root, ['rev-parse', 'HEAD']));
  assert.equal(gitFactCacheHits(), before, 'the wrapper is another Git, so it answered itself');
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
  // An include in the machine-wide file cannot be followed for config reads, while HEAD/object
  // reads remain cacheable on Windows machines whose global/system gitconfig uses [include].
  await writeFile(path.join(programData, 'Git', 'config'), '[include]\n\tpath = elsewhere\n');
  const included = gitFactRequest(args, { cwd: root, env, platform: 'win32' });
  rememberGitFact(included, spawnSync('git', args, { cwd: root, encoding: 'utf8' }), { before: gitFactSnapshot(included) });
  assert.equal(cachedGitFact(included), null);
  const headUnderHostInclude = gitFactRequest(['rev-parse', 'HEAD'], { cwd: root, env, platform: 'win32' });
  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  rememberGitFact(headUnderHostInclude, headResult, { before: gitFactSnapshot(headUnderHostInclude) });
  assert.equal(cachedGitFact(headUnderHostInclude)?.stdout, headResult.stdout);
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

test('Stage 1: read-scope memoization coalesces repeated ref/branch reads and expires outside the scope', async (t) => {
  const root = await repository(t);
  outside(root, ['branch', 'feature-one']);
  outside(root, ['update-ref', 'refs/remotes/origin/main', outside(root, ['rev-parse', 'HEAD'])]);
  outside(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  outside(root, ['config', 'remote.origin.url', root]);

  await withReadScope(async () => {
    const firstHead = head(root);
    const firstRefHead = refHead(root, 'refs/heads/feature-one');
    const firstExists = refExists(root, 'refs/heads/feature-one');
    const firstLocal = localBranches(root);
    const firstRemote = remoteBranches(root, 'origin');
    const firstDefault = remoteDefaultBranchName(root, {}, 'origin');

    // Mutate outside run() while still inside the read-only scope: the scoped read memo returns
    // the consistent in-scope snapshot without spawning additional Git processes.
    outside(root, ['branch', 'feature-two']);
    assert.equal(head(root), firstHead);
    assert.equal(refHead(root, 'refs/heads/feature-one'), firstRefHead);
    assert.equal(refExists(root, 'refs/heads/feature-one'), firstExists);
    assert.deepEqual(localBranches(root), firstLocal);
    assert.deepEqual(remoteBranches(root, 'origin'), firstRemote);
    assert.equal(remoteDefaultBranchName(root, {}, 'origin'), firstDefault);
  });

  // Outside the read scope, the new branch is immediately observed.
  assert.ok(localBranches(root).includes('feature-two'));
  assert.equal(refExists(root, 'refs/heads/feature-two'), true);
});

test('Stage 1: governedCommitIdentity, shallowBoundaryCommit, and stagedEntriesForPaths batch and coalesce object reads', async (t) => {
  const root = await repository(t);
  const baseCommit = outside(root, ['rev-parse', 'HEAD']);
  outside(root, ['checkout', '-q', '-b', 'side']);
  await writeFile(path.join(root, 'side.txt'), 'side\n');
  outside(root, ['add', 'side.txt']);
  outside(root, ['commit', '-q', '-m', 'side commit']);
  const sideCommit = outside(root, ['rev-parse', 'HEAD']);
  outside(root, ['checkout', '-q', 'main']);

  const tree = outside(root, ['rev-parse', `${sideCommit}^{tree}`]);
  const msg = [
    'Governed merge commit',
    '',
    'Singularity-Flow-Transaction: tx-123',
    `Singularity-Flow-Event-SHA256: ${'a'.repeat(64)}`,
    `Singularity-Flow-State-SHA256: ${'b'.repeat(64)}`,
    'Singularity-Flow-Publication-Mode: required'
  ].join('\n');
  const mergeCommit = outside(root, ['commit-tree', tree, '-p', baseCommit, '-p', sideCommit, '-m', msg]);

  clearGitFactCache();
  const identity1 = governedCommitIdentity(root, mergeCommit);
  assert.equal(identity1.commit, mergeCommit);
  assert.equal(identity1.tree, tree);
  assert.deepEqual(identity1.parents, [baseCommit, sideCommit]);
  assert.equal(identity1.transactionId, 'tx-123');
  assert.equal(identity1.eventSha256, 'a'.repeat(64));
  assert.equal(identity1.stateSha256, 'b'.repeat(64));

  // Second call hits git-fact-cache for both `rev-parse --verify` and `cat-file -p`.
  const hitsBefore = gitFactCacheHits();
  const identity2 = governedCommitIdentity(root, mergeCommit);
  assert.deepEqual(identity2, identity1);
  assert.equal(gitFactCacheHits(), hitsBefore + 2, 'both rev-parse and cat-file -p hit the object fact cache');

  // shallowBoundaryCommit with multiple parents uses batched cat-file --batch-check.
  await writeFile(path.join(root, '.git', 'shallow'), `${baseCommit}\n`);
  assert.equal(shallowBoundaryCommit(root, mergeCommit), false, 'both parents exist locally');
  const rawMerge = outside(root, ['cat-file', '-p', mergeCommit]);
  const missingParentCommit = spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    cwd: root,
    encoding: 'utf8',
    input: `${rawMerge.replace(`parent ${sideCommit}`, `parent ${'f'.repeat(40)}`)}\n`
  }).stdout.trim();
  assert.equal(shallowBoundaryCommit(root, missingParentCommit), true, 'missing parent in multi-parent commit is detected as shallow boundary');
  await rm(path.join(root, '.git', 'shallow'), { force: true });

  // stagedEntriesForPaths batches multi-file index reads via ls-files --stage + readLocalGitBlobs.
  await writeFile(path.join(root, 'one.txt'), 'alpha\n');
  await writeFile(path.join(root, 'two.txt'), 'beta\n');
  await writeFile(path.join(root, 'three.txt'), 'gamma\n');
  outside(root, ['add', 'one.txt', 'two.txt', 'three.txt']);
  const staged = stagedEntriesForPaths(root, ['one.txt', 'two.txt', 'three.txt']);
  assert.deepEqual(staged, [
    { path: 'one.txt', content: 'alpha\n' },
    { path: 'two.txt', content: 'beta\n' },
    { path: 'three.txt', content: 'gamma\n' }
  ]);
});

