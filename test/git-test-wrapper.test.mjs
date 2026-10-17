import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitTestWrapperEnvironment, realGitForTest, writeGitTestWrapper } from './helpers/git-test-wrapper.mjs';

test('Git fault-injection wrapper preserves exact argv without shell interpretation', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-git-wrapper-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  assert.ok(path.isAbsolute(realGitForTest()));
  const environment = gitTestWrapperEnvironment(directory, { Path: 'original', OTHER: 'kept' });
  assert.equal(environment.Path, undefined);
  assert.equal(environment.PATH, directory + path.delimiter + 'original');
  assert.equal(environment.OTHER, 'kept');
  const wrapper = await writeGitTestWrapper(directory,
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(7);\n');
  const args = ['clone', 'a b', '--git-dir', 'a"b', 'C:\\ends\\', '', 'é', '--upload-pack=x & not-a-command'];
  const result = spawnSync(wrapper, args, { encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});
