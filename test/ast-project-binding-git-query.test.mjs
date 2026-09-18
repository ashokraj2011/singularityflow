import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverProjectBindings } from '../src/ast-project-binding.mjs';
import { executeGitQuery, gitQueryDescriptor } from '../src/git-query.mjs';
import { posix, run } from '../src/util.mjs';

const LISTING_LIMIT = 32 * 1024 * 1024;

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-ast-git-query-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'AST Query Test']);
  git(root, ['config', 'user.email', 'ast-query@example.com']);
  return root;
}

test('tracked-path descriptor retains one ls-files spawn, 32 MiB ceiling, and NUL parser', async (t) => {
  const root = await repository(t);
  const pathname = 'module with spaces/pyproject.toml';
  await mkdir(path.join(root, 'module with spaces'));
  await writeFile(path.join(root, pathname), '[project]\nname="sample"\n');
  await writeFile(path.join(root, 'untracked.txt'), 'not staged\n');
  git(root, ['add', pathname]);
  const expected = run('git', ['ls-files', '-z'], { cwd: root, maxBuffer: LISTING_LIMIT }).stdout
    .split('\0').filter(Boolean);
  let calls = 0;
  const actual = executeGitQuery(root, 'repository.tracked-paths', {}, {
    runner(command, args, options) {
      calls += 1;
      assert.equal(command, 'git');
      assert.deepEqual(args, ['ls-files', '-z']);
      assert.equal(options.maxBuffer, LISTING_LIMIT);
      assert.equal(options.timeoutClass, null, 'the legacy listing had no implicit deadline');
      assert.equal(options.allowFailure, false);
      return run(command, args, options);
    }
  });
  assert.deepEqual(actual, expected);
  assert.equal(calls, 1);
  assert.equal(actual.includes('untracked.txt'), false);
  assert.equal(gitQueryDescriptor('repository.tracked-paths').maxBuffer, LISTING_LIMIT);
});

test('tracked-path query preserves decoded pathname and partial-output refusal behavior', async (t) => {
  const root = await repository(t);
  const unusual = process.platform === 'win32' ? 'unicode-δ/pyproject.toml'
    : 'line\nbreak/pyproject.toml';
  await mkdir(path.dirname(path.join(root, unusual)));
  await writeFile(path.join(root, unusual), '[project]\nname="unusual"\n');
  git(root, ['add', '.']);
  const direct = run('git', ['ls-files', '-z'], { cwd: root, maxBuffer: LISTING_LIMIT }).stdout
    .split('\0').filter(Boolean).map(posix);
  assert.deepEqual(executeGitQuery(root, 'repository.tracked-paths').map(posix), direct);
  assert.ok(direct.includes(posix(unusual)));

  // The legacy string decoder replaces invalid pathname bytes; this descriptor intentionally
  // keeps that projection until a separate byte-exact listing is specified for its callers.
  const decoded = Buffer.from([0x61, 0xff, 0x00, 0x62, 0x00]).toString('utf8');
  const expectedDecoded = decoded.split('\0').filter(Boolean);
  assert.deepEqual(executeGitQuery(root, 'repository.tracked-paths', {}, {
    runner: () => ({ status: 0, stdout: decoded, stderr: '' })
  }), expectedDecoded);

  let observedLimit = null;
  const overflowRunner = (command, args, options) => {
    observedLimit = options.maxBuffer;
    return run(command, args, {
      ...options,
      spawnSyncCommand() {
        return {
          status: null, stdout: 'partial\0', stderr: '', signal: null,
          error: Object.assign(new Error('output too large'), { code: 'ENOBUFS' })
        };
      }
    });
  };
  assert.throws(
    () => executeGitQuery(root, 'repository.tracked-paths', {}, { runner: overflowRunner }),
    (error) => error.code === 'SUBPROCESS_OUTPUT_TOO_LARGE'
  );
  assert.equal(observedLimit, LISTING_LIMIT);

  const unavailable = path.join(root, 'missing-repository');
  let directError;
  try { run('git', ['ls-files', '-z'], { cwd: unavailable, maxBuffer: LISTING_LIMIT }); }
  catch (error) { directError = error; }
  assert.ok(directError);
  assert.throws(() => executeGitQuery(unavailable, 'repository.tracked-paths'),
    (error) => error.code === directError.code && error.message === directError.message);
});

test('project binding discovery uses tracked build files with the same scoped result', async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, 'app'), { recursive: true });
  await writeFile(path.join(root, 'settings.gradle.kts'), 'rootProject.name = "sample"\n');
  await writeFile(path.join(root, 'app', 'build.gradle.kts'), 'plugins { java }\n');
  await writeFile(path.join(root, 'pyproject.toml'), '[project]\nname="untracked"\n');
  git(root, ['add', 'settings.gradle.kts', 'app/build.gradle.kts']);
  const result = await discoverProjectBindings(root, { includeWarm: false });
  assert.equal(result.mode, 'existing-only');
  assert.equal(result.selectedMetadataFiles, 2);
  assert.equal(result.bindings.length, 1);
  assert.equal(result.bindings[0].projectKind, 'gradle');
  assert.deepEqual(result.bindings[0].modules, ['app']);
  assert.equal(result.bindings.some((binding) => binding.projectKind === 'python'), false);
  const scoped = await discoverProjectBindings(root, { paths: ['app'], includeWarm: false });
  assert.deepEqual(scoped.bindings, result.bindings);
});
