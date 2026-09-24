import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import {
  GitNameStatusParseError, parseGitNameStatus, readGitNameStatusDiff
} from '../src/git-diff-name-status.mjs';
import { run } from '../src/util.mjs';

test('NUL-framed name-status preserves whitespace, Unicode, and both copy/rename endpoints', () => {
  const output = Buffer.from([
    'M', 'folder/line\nwith\ttabs and spaces.txt',
    'R087', 'before/naïve.txt', 'after/目录/naïve renamed.txt',
    'C100', 'source/emoji-😀.txt', 'copies/emoji 😀.txt',
    'D', 'removed/old file.txt', ''
  ].join('\0'), 'utf8');

  const statuses = parseGitNameStatus(output);
  assert.deepEqual(statuses, [
    { status: 'M', paths: ['folder/line\nwith\ttabs and spaces.txt'] },
    { status: 'R087', paths: ['before/naïve.txt', 'after/目录/naïve renamed.txt'] },
    { status: 'C100', paths: ['source/emoji-😀.txt', 'copies/emoji 😀.txt'] },
    { status: 'D', paths: ['removed/old file.txt'] }
  ]);
});

test('name-status reader runs one byte-mode diff and derives every changed path', () => {
  const calls = [];
  const output = Buffer.from('R100\0old name.txt\0new 名.txt\0D\0gone.txt\0', 'utf8');
  const changed = readGitNameStatusDiff('/repository', 'base', 'proposal', {
    env: { TEST: 'value' },
    runCommand(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: output, stderr: Buffer.alloc(0) };
    }
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    'diff', '--no-ext-diff', '--name-status', '-z', '--find-renames', '--find-copies',
    'base..proposal', '--'
  ]);
  assert.equal(calls[0].options.encoding, 'buffer');
  assert.deepEqual(changed.statuses, [
    { status: 'R100', paths: ['old name.txt', 'new 名.txt'] },
    { status: 'D', paths: ['gone.txt'] }
  ]);
  assert.deepEqual(changed.names, ['old name.txt', 'new 名.txt', 'gone.txt']);
});

test('name-status reader refuses every poisoned zero-exit result before parsing', () => {
  const poisoned = [
    { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) },
    { signal: 'SIGTERM' },
    { timedOut: true },
    { aborted: true },
    { outputOverflow: true },
    { blocked: true }
  ];
  for (const poison of poisoned) {
    assert.throws(() => readGitNameStatusDiff('/repository', 'base', 'proposal', {
      runCommand() {
        return {
          status: 0, stdout: Buffer.from('M\0must-not-be-parsed\0'),
          stderr: Buffer.alloc(0), ...poison
        };
      }
    }), (error) => error.code === 'GIT_DIFF_NAME_STATUS_UNAVAILABLE');
  }
});

test('name-status parser rejects malformed framing, records, metadata, and UTF-8', () => {
  const malformed = [
    Buffer.from('M\0path-without-final-nul'),
    Buffer.from('M\0'),
    Buffer.from('R100\0only-source\0'),
    Buffer.from('C101\0source\0target\0'),
    Buffer.from('Q\0path\0'),
    Buffer.from([0x4d, 0, 0xff, 0])
  ];
  for (const input of malformed) {
    assert.throws(() => parseGitNameStatus(input), GitNameStatusParseError);
  }
  assert.throws(() => parseGitNameStatus('M\0path\0'), /requires raw bytes/u);
});

test('one real Git diff reports rename endpoints, deletion, and Unicode paths losslessly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-name-status-'));
  try {
    run('git', ['init', '-q', '-b', 'main', root]);
    run('git', ['config', 'user.name', 'Diff Test'], { cwd: root });
    run('git', ['config', 'user.email', 'diff@example.test'], { cwd: root });
    await mkdir(path.join(root, 'before'), { recursive: true });
    await writeFile(path.join(root, 'before', 'old name.txt'), 'rename me\n');
    await writeFile(path.join(root, 'delete me.txt'), 'delete me\n');
    await writeFile(path.join(root, 'keep.txt'), 'keep\n');
    run('git', ['add', '-A'], { cwd: root });
    run('git', ['commit', '-qm', 'base'], { cwd: root });
    const base = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();

    await mkdir(path.join(root, 'after', '目录'), { recursive: true });
    run('git', ['mv', '--', 'before/old name.txt', 'after/目录/new name.txt'], { cwd: root });
    run('git', ['rm', '-q', '--', 'delete me.txt'], { cwd: root });
    await writeFile(path.join(root, 'added 😀.txt'), 'added\n');
    run('git', ['add', '-A'], { cwd: root });
    run('git', ['commit', '-qm', 'proposal'], { cwd: root });
    const proposal = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();

    const changed = readGitNameStatusDiff(root, base, proposal);
    assert.ok(changed.statuses.some(({ status, paths }) =>
      status === 'R100'
      && paths[0] === 'before/old name.txt'
      && paths[1] === 'after/目录/new name.txt'));
    assert.ok(changed.statuses.some(({ status, paths }) =>
      status === 'D' && paths[0] === 'delete me.txt'));
    assert.ok(changed.statuses.some(({ status, paths }) =>
      status === 'A' && paths[0] === 'added 😀.txt'));
    assert.ok(changed.names.includes('before/old name.txt'));
    assert.ok(changed.names.includes('after/目录/new name.txt'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
