import test from 'node:test';
import assert from 'node:assert/strict';

import { gitCommitObjectExists, gitIsAncestor } from '../src/git-ancestry.mjs';

const base = Object.freeze({
  status: 0, stdout: '', stderr: '', error: undefined, signal: null,
  timedOut: false, aborted: false, outputOverflow: false, blocked: false
});

test('Git ancestry distinguishes its one clean negative from execution failures', () => {
  const observe = (result) => gitIsAncestor('/repository', 'ancestor', 'descendant', {
    runCommand(command, args, options) {
      assert.equal(command, 'git');
      assert.deepEqual(args, ['merge-base', '--is-ancestor', 'ancestor', 'descendant']);
      assert.equal(options.allowFailure, true);
      return result;
    }
  });

  assert.equal(observe({ ...base }), true);
  assert.equal(observe({ ...base, status: 1 }), false);

  for (const result of [
    { ...base, status: 128 },
    { ...base, status: 1, stderr: 'fatal: missing object' },
    { ...base, error: Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' }) },
    { ...base, signal: 'SIGTERM' },
    { ...base, timedOut: true },
    { ...base, aborted: true },
    { ...base, outputOverflow: true },
    { ...base, blocked: true }
  ]) {
    assert.throws(() => observe(result), (error) => error.code === 'GIT_ANCESTRY_UNAVAILABLE');
  }
});

test('Git commit availability uses the explicit batch missing record and rejects protocol failure', () => {
  const commit = 'a'.repeat(40);
  const expression = `${commit}^{commit}`;
  const observe = (result) => gitCommitObjectExists('/repository', commit, {
    runCommand(command, args, options) {
      assert.equal(command, 'git');
      assert.deepEqual(args, ['cat-file', '--batch-check=%(objectname) %(objecttype)']);
      assert.equal(options.input, `${expression}\n`);
      assert.equal(options.allowFailure, true);
      return result;
    }
  });

  assert.equal(observe({ ...base, stdout: `${expression} missing\n` }), false);
  assert.equal(observe({ ...base, stdout: `${commit} commit\n` }), true);
  assert.throws(() => observe({ ...base, stdout: 'unexpected\n' }),
    (error) => error.code === 'GIT_OBJECT_PROTOCOL_INVALID');
  assert.throws(() => observe({ ...base, status: 1, timedOut: true }),
    (error) => error.code === 'GIT_OBJECT_OBSERVATION_UNAVAILABLE');
});
