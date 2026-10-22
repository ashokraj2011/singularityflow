import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createStoryReadinessFixture } from '../scripts/story-readiness-benchmark.mjs';
import { withCreationContext } from '../src/creation-context.mjs';
import { loadStoryConfigurationSnapshot, takeStoryConfigurationCheckout } from '../src/configuration-branch.mjs';
import { configuredRemoteIdentity } from '../src/git-remote-diagnostics.mjs';
import { GitRemoteSession } from '../src/git-execution.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';

async function capture(f, action) {
  const timer = commandTimer('start-context-test');
  const value = await withCommandTiming(timer, () => withCreationContext(action));
  return { value, counters: timer.finish().counters };
}
function options(f) { return { env: f.env, useObjectCache: true,
  session: new GitRemoteSession({ cwd: f.original, env: f.env }), reuseAuthorityObservation: true }; }
function authority(f) { return { remote: f.remote, branch: 'sflow/config',
  commit: f.git(f.source, 'rev-parse', 'HEAD'), source: 'configuration-branch' }; }

test('large application trees reuse only their exact configuration closure on every host', async t => {
  const f = await createStoryReadinessFixture({ files: 4200 }); t.after(f.cleanup);
  const before = f.git(f.original, 'rev-parse', 'HEAD');
  const selected = authority(f);
  const { value: snapshot, counters } = await capture(f, () => loadStoryConfigurationSnapshot(selected, options(f)));
  assert.equal(counters['configuration.workspace-object-hit'], 1);
  assert.equal(counters['git.remote.command.clone'] ?? 0, 0);
  assert.equal(counters['git.remote.command.fetch'] ?? 0, 0);
  assert.ok(snapshot.assets.length < 4200);
  assert.ok(snapshot.assets.every(entry => !entry.relative.startsWith('src/')));
  assert.equal(f.git(f.original, 'rev-parse', 'HEAD'), before);
  assert.equal(f.git(f.original, 'status', '--porcelain'), '');
});

test('enrollment borrows a configuration-only checkout, preserves application bytes and retains normal hooks', async t => {
  const f = await createStoryReadinessFixture({ files: 100 }); t.after(f.cleanup);
  const selected = authority(f);
  const { counters } = await capture(f, async () => {
    const snapshot = await loadStoryConfigurationSnapshot(selected, options(f));
    const checkout = await takeStoryConfigurationCheckout(snapshot, selected.remote, selected.commit);
    assert.ok(checkout);
    assert.equal(f.git(checkout, 'rev-parse', 'HEAD'), selected.commit);
    assert.equal(await readFile(path.join(checkout, 'singularity/workflow.yml'), 'utf8'),
      snapshot.assets.find(entry => entry.relative === 'singularity/workflow.yml').contents.toString());
    await assert.rejects(readFile(path.join(checkout, 'src/file-0.txt')), { code: 'ENOENT' });
    assert.equal(f.git(checkout, 'ls-tree', 'HEAD', 'src/file-0.txt').includes('blob'), true,
      'unmaterialized application objects remain in the parent tree');
    assert.doesNotMatch(f.git(checkout, 'config', '--local', '--list'), /core\.hookspath=/iu,
      'normal template/commit hooks are not disabled by the cache');
    const hook = path.join(checkout, '.git/hooks/pre-commit');
    await writeFile(hook, '#!/bin/sh\necho ran > hook-ran.txt\n'); await chmod(hook, 0o755);
    await writeFile(path.join(checkout, 'singularity/portfolio.yml'),
      (await readFile(path.join(checkout, 'singularity/portfolio.yml'), 'utf8')) + '\n');
    f.git(checkout, 'add', 'singularity/portfolio.yml');
    f.git(checkout, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'hook verification');
    assert.equal((await readFile(path.join(checkout, 'hook-ran.txt'), 'utf8')).trim(), 'ran');
    assert.equal(await takeStoryConfigurationCheckout(snapshot, selected.remote, selected.commit), null);
  });
  assert.equal(counters['configuration.enrollment-object-checkout'], 1);
  assert.equal(counters['git.remote.command.clone'] ?? 0, 0);
});

test('Start fetches a missing exact configuration once and keeps it available to later requests', async t => {
  const f = await createStoryReadinessFixture({ files: 1 }); t.after(f.cleanup);
  await writeFile(path.join(f.source, 'singularity/templates/new.txt'), 'new configuration\n');
  f.git(f.source, 'add', '.'); f.git(f.source, 'commit', '-qm', 'configuration only advance');
  f.git(f.source, 'push', '-q', 'origin', 'HEAD:refs/heads/sflow/config');
  const selected = authority(f), head = f.git(f.original, 'rev-parse', 'HEAD');
  const timer = commandTimer('configuration-transfer');
  await withCommandTiming(timer, () => withCreationContext(
    () => loadStoryConfigurationSnapshot(selected, options(f)), { configurationTransfers: true }));
  assert.equal(timer.finish().counters['configuration.workspace-object-fetch'], 1);
  const warm = await capture(f, () => loadStoryConfigurationSnapshot(selected, options(f)));
  assert.equal(warm.counters['configuration.workspace-object-hit'], 1);
  assert.equal(warm.counters['git.remote.command.clone'] ?? 0, 0);
  assert.equal(warm.counters['git.remote.command.fetch'] ?? 0, 0);
  assert.equal(f.git(f.original, 'rev-parse', 'HEAD'), head);
});

test('configuration attributes preserve checkout semantics without a remote clone or application checkout', async t => {
  const f = await createStoryReadinessFixture({ files: 10 }); t.after(f.cleanup);
  await writeFile(path.join(f.source, '.gitattributes'), 'singularity/templates/** text eol=crlf\n');
  await writeFile(path.join(f.source, 'singularity/templates/new.txt'), 'approved\n');
  f.git(f.source, 'add', '.'); f.git(f.source, 'commit', '-qm', 'configuration checkout attributes');
  f.git(f.source, 'push', '-q', 'origin', 'HEAD:refs/heads/sflow/config');
  f.git(f.original, 'fetch', '-q', 'origin', 'sflow/config');
  const { value: snapshot, counters } = await capture(f, () => loadStoryConfigurationSnapshot(authority(f), options(f)));
  assert.equal(counters['configuration.workspace-object-hit'], 1);
  assert.equal(counters['git.remote.command.clone'] ?? 0, 0);
  assert.equal(snapshot.assets.find(entry => entry.relative === 'singularity/templates/new.txt').contents.toString(), 'approved\r\n');
});

test('moved authority is refused before local configuration can be reused', async t => {
  const f = await createStoryReadinessFixture({ files: 1 }); t.after(f.cleanup);
  const selected = authority(f);
  await writeFile(path.join(f.source, 'singularity/templates/new.txt'), 'new configuration\n');
  f.git(f.source, 'add', '.'); f.git(f.source, 'commit', '-qm', 'advance authority');
  f.git(f.source, 'push', '-q', 'origin', 'HEAD:refs/heads/sflow/config');
  await assert.rejects(capture(f, () => loadStoryConfigurationSnapshot(selected, options(f))),
    { code: 'STORY_CONFIGURATION_AUTHORITY_STALE' });
});

test('shared remote configuration batches both directions and invalidates changed files', async t => {
  const f = await createStoryReadinessFixture({ files: 0 }); t.after(f.cleanup);
  await capture(f, () => {
    assert.equal(configuredRemoteIdentity(f.original).url, f.remote);
    assert.equal(configuredRemoteIdentity(f.original, 'origin', { direction: 'push' }).inherited, true);
    f.git(f.original, 'config', 'remote.origin.pushurl', 'https://example.invalid/changed.git');
    assert.equal(configuredRemoteIdentity(f.original, 'origin', { direction: 'push' }).url,
      'https://example.invalid/changed.git');
    f.git(f.original, 'config', '--add', 'remote.origin.pushurl', 'https://example.invalid/other.git');
    assert.equal(configuredRemoteIdentity(f.original, 'origin', { direction: 'push' }).ambiguous, true);
  });
});
