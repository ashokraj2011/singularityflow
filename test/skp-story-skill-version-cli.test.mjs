import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

function invoke(executable, argv, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(executable, argv, {
    cwd, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Skill CLI Tester' }
  });
  if (!allowFailure) assert.equal(result.status, 0,
    `${executable} ${argv.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

test('Story skill-version status reads the accepted pin and invalid decisions never mutate', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-story-cli-'));
  const remote = `${root}.git`;
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  });
  const git = (...argv) => invoke('git', argv, root).stdout.trim();
  const cli = (...argv) => invoke(process.execPath, [CLI, '--no-model', ...argv], root);
  const refused = (...argv) => invoke(process.execPath, [CLI, '--no-model', ...argv], root,
    { allowFailure: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Skill CLI Tester');
  git('config', 'user.email', 'skill-cli@example.invalid');
  cli('init');
  git('add', '-A');
  git('commit', '-qm', 'Initialize Story skill CLI fixture');
  invoke('git', ['init', '--bare', '-b', 'main', remote], root);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', '-u', 'origin', 'main');
  cli('start', 'SKP-CLI-1', '--from-branch', 'main', '--work-type', 'feature',
    '--title', 'Review a package', '--description', 'Review a pinned approved package before adoption.');

  const recordPath = path.join(root, 'singularity/work-items/SKP-CLI-1/workflow.json');
  const before = await readFile(recordPath);
  const head = git('rev-parse', 'HEAD');
  const status = JSON.parse(cli('story', 'skill-version', 'status', '--json').stdout);
  assert.equal(status.workId, 'SKP-CLI-1');
  assert.equal(status.snapshotRevision, 1);
  assert.deepEqual(status.selectedPackages, []);
  assert.deepEqual(status.proposals, []);

  const missingReason = refused('story', 'skill-version', 'preview', 'threat-model', '--json');
  assert.notEqual(missingReason.status, 0);
  assert.match(missingReason.stderr, /reviewed skill-version proposal needs --reason/);
  const oversizedReason = refused('story', 'skill-version', 'preview', 'threat-model',
    '--reason', 'x'.repeat(4097), '--json');
  assert.notEqual(oversizedReason.status, 0);
  assert.match(oversizedReason.stderr, /at most 4096 characters/);
  const invalidDecision = refused('story', 'skill-version', 'decide', 'SAM-001',
    '--decision', 'maybe', '--reason', 'Invalid decision.', '--json');
  assert.notEqual(invalidDecision.status, 0);
  assert.match(invalidDecision.stderr, /--decision approve\|reject/);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.deepEqual(await readFile(recordPath), before);
});
