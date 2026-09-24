import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { terminalPublicationObservation } from '../src/governance.mjs';
import { run } from '../src/util.mjs';

test('terminal publication checks the configured push URL rather than the fetch URL', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-terminal-push-'));
  const fetchRemote = path.join(directory, 'fetch.git');
  const pushRemote = path.join(directory, 'push.git');
  const source = path.join(directory, 'source');
  run('git', ['init', '--bare', fetchRemote], { cwd: directory });
  run('git', ['init', '--bare', pushRemote], { cwd: directory });
  run('git', ['init', '-b', 'main', source], { cwd: directory });
  run('git', ['config', 'user.name', 'Test'], { cwd: source });
  run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: source });
  await writeFile(path.join(source, 'README.md'), 'test\n');
  run('git', ['add', '.'], { cwd: source });
  run('git', ['commit', '-m', 'Initial'], { cwd: source });
  run('git', ['remote', 'add', 'origin', fetchRemote], { cwd: source });
  run('git', ['remote', 'set-url', '--push', 'origin', pushRemote], { cwd: source });
  run('git', ['push', fetchRemote, 'HEAD:refs/heads/main'], { cwd: source });

  const fetchOnly = await terminalPublicationObservation(source, 'origin', 'main');
  assert.equal(fetchOnly.published, false);
  run('git', ['push', 'origin', 'HEAD:refs/heads/main'], { cwd: source });
  const pushed = await terminalPublicationObservation(source, 'origin', 'main');
  assert.equal(pushed.published, true);
});
