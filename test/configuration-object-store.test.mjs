import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { prepareConfigurationObjectCheckout } from '../src/configuration-object-store.mjs';
import { frozenRemoteTransport } from '../src/git-remote-diagnostics.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';
import { materializeConfigurationSnapshot } from '../src/configuration-state-git.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';
import { run } from '../src/util.mjs';

test('private object pool reuses exact commits and blobs but never changes the application checkout', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-object-pool-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'), remote = path.join(base, 'authority.git');
  run('git', ['init', '--quiet', '--template=', '-b', 'main', source]);
  run('git', ['config', 'user.name', 'Fixture'], { cwd: source });
  run('git', ['config', 'user.email', 'fixture@example.test'], { cwd: source });
  await import('node:fs/promises').then(fs => fs.mkdir(path.join(source, 'singularity')));
  await writeFile(path.join(source, 'singularity/workflow.yml'), 'version: 2\n');
  await writeFile(path.join(source, 'README.md'), '# Application stays unchanged\n');
  run('git', ['add', '.'], { cwd: source }); run('git', ['commit', '-qm', 'baseline'], { cwd: source });
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: source }).stdout.trim();
  run('git', ['branch', 'sflow/config'], { cwd: source });
  run('git', ['clone', '--quiet', '--bare', '--', source, remote]);
  const before = await readFile(path.join(source, '.git/index'));
  let unsupported = false;
  const read = async () => {
    const scratch = await mkdtemp(path.join(base, 'read-'));
    const timer = commandTimer('object-pool', { commandClass: 'read' });
    await withCommandTiming(timer, async () => {
      const transport = frozenRemoteTransport(remote);
      const pool = await prepareConfigurationObjectCheckout(source, scratch, { remote, transport,
        authorityCommit: commit, runRemoteCommand: runRemoteGitAsync });
      if (!pool && process.platform === 'win32') {
        unsupported = true; t.skip('Private object-store ACL profile is unavailable; original reads remain supported.'); return;
      }
      assert.ok(pool, 'qualified hosts must admit a pool');
      try {
        const reader = await materializeConfigurationSnapshot(scratch, transport.remote, commit, transport.env, pool.download);
        assert.equal(reader.file(commit, 'singularity/workflow.yml').bytes.toString(), 'version: 2\n');
      } finally { await rm(scratch, { recursive: true, force: true }); await pool.release(); }
    });
    return timer.finish().counters;
  };
  const cold = await read();
  if (unsupported) return;
  const warm = await read();
  assert.equal(cold['configuration.object-store-fetch'], 1);
  assert.equal(warm['configuration.object-store-hit'], 1);
  assert.equal(warm['git.remote.commands'] ?? 0, 0, 'exact object reuse requires no object transport');
  assert.deepEqual(await readFile(path.join(source, '.git/index')), before);
  assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: source }).stdout.trim(), commit);
});
