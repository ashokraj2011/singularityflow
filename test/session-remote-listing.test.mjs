import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, realpathSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { bootstrapRepository } from '../src/bootstrap.mjs';

/**
 * When the local clone's own Git files cannot be read (macOS had evicted them to iCloud
 * placeholders), /sf-session still lists the Stories, read from the remote state branch, and says
 * that opening one waits for the clone. Named pipes stand in for the placeholders: both block a
 * reader until data arrives, and both look unreadable to the storage check.
 */
const bin = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const posix = process.platform !== 'win32';

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, timeout: 180_000 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

/**
 * Evict the clone's objects: each pack becomes a same-size sparse file (a placeholder's signature:
 * a size and no allocated blocks) and each loose object a named pipe (a read that never completes).
 * Returns how to put them back.
 */
function evict(gitDirectory) {
  const objects = path.join(gitDirectory, 'objects');
  const saved = path.join(path.dirname(gitDirectory), '..', `saved-objects-${path.basename(path.dirname(gitDirectory))}`);
  const moved = [];
  for (const directory of readdirSync(objects)) {
    const loose = /^[0-9a-f]{2}$/.test(directory);
    if (!loose && directory !== 'pack') continue;
    for (const name of readdirSync(path.join(objects, directory))) {
      if (!loose && !name.endsWith('.pack')) continue;
      const file = path.join(objects, directory, name);
      const copy = path.join(saved, directory, name);
      execFileSync('mkdir', ['-p', path.dirname(copy)]);
      renameSync(file, copy);
      if (loose) execFileSync('mkfifo', [file]);
      else { writeFileSync(file, ''); truncateSync(file, statSync(copy).size); }
      moved.push([file, copy]);
    }
  }
  assert.ok(moved.length > 0, 'the clone has Git objects to evict');
  return () => { for (const [file, copy] of moved) { rmSync(file); renameSync(copy, file); } };
}

test('a clone whose Git files cannot be read still lists its Stories from the remote, and says what is blocked',
  { skip: !posix, timeout: 300_000 }, async (t) => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-remote-listing-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const remote = path.join(base, 'remote.git');
    const seed = path.join(base, 'seed');
    run('git', ['init', '--bare', remote], base);
    run('git', ['init', '-b', 'main', seed], base);
    run('git', ['config', 'user.name', 'Listing Seed'], seed);
    run('git', ['config', 'user.email', 'listing.seed@example.invalid'], seed);
    await writeFile(path.join(seed, 'README.md'), '# Remote listing\n');
    run('git', ['add', '.'], seed);
    run('git', ['commit', '-m', 'initial'], seed);
    run('git', ['push', remote, 'main:main'], seed);
    run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
    run('git', ['config', 'uploadpack.allowFilter', 'true'], remote);

    const boot = await bootstrapRepository(remote, { capabilityId: 'listing', capabilityName: 'Listing', base: path.join(base, 'work') });
    const env = {
      ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_BUNDLE: 'off', SINGULARITY_FLOW_NO_MODEL: '1',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Listing Tester', SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }),
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Listing Tester',
      GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'listing.tester@example.invalid'
    };
    run(process.execPath, [bin, 'start', 'LIST-101', '--from-branch', 'main', '--title', 'Remote listing', '--work-type', 'feature'], boot.root, env);
    const storyBranch = run('git', ['branch', '--show-current'], boot.root).stdout.trim();
    run('git', ['switch', '-q', 'main'], boot.root);

    const unreadable = { ...env, SINGULARITY_FLOW_GIT_STORAGE_CHECK: 'always', SINGULARITY_FLOW_GIT_STORAGE_DOWNLOAD_TIMEOUT_MS: '500' };
    const sflow = (args, extra = unreadable) => {
      const started = performance.now();
      const result = spawnSync(process.execPath, [bin, ...args], { cwd: boot.root, env: extra, encoding: 'utf8', timeout: 120_000 });
      return { ...result, elapsedMs: performance.now() - started };
    };
    const restore = evict(path.join(boot.root, '.git'));
    let restored = false;
    t.after(() => { if (!restored) restore(); });

    const listed = sflow(['session', 'open', '--for-agent', '--json']);
    assert.equal(listed.status, 0, `${listed.stdout}\n${listed.stderr}`);
    assert.ok(listed.elapsedMs < 60_000, `listed in ${Math.round(listed.elapsedMs)} ms`);
    const choose = JSON.parse(listed.stdout);
    assert.equal(choose.status, 'choose');
    assert.match(choose.table, /\| LIST-101 \|/);
    assert.match(choose.table, /Local clone: unavailable\. Git cannot read this repository's own files/);
    assert.match(choose.table, /read from the remote state branch; nothing in the local clone was used/);
    assert.match(choose.table, /Blocked: Opening, attaching or resuming a Story needs this clone/);
    assert.match(choose.table, /To unblock: Download .*Download Now.*then run \/sf-session again/);
    assert.equal(choose.localClone.available, false);
    assert.equal(realpathSync(choose.localClone.gitDirectory), realpathSync(path.join(boot.root, '.git')));
    assert.ok(choose.localClone.unreadableFiles > 0);
    assert.equal(choose.act.state, 'ask-person');
    assert.match(choose.act.said, /read from the remote because the local clone cannot be read/);
    assert.match(choose.act.said, /do not open one/);

    const candidates = sflow(['session', 'candidates', '--json', '--diagnostics']);
    assert.equal(candidates.status, 0, candidates.stderr);
    const discovered = JSON.parse(candidates.stdout);
    assert.equal(discovered.source, 'remote-url');
    assert.equal(realpathSync(discovered.repositoryPath), realpathSync(boot.root));
    assert.equal(discovered.localClone.available, false);
    assert.ok(discovered.items.some((item) => item.id === 'LIST-101' && item.branch === storyBranch));
    assert.match(candidates.stderr, /Listed from the remote: the local clone .* cannot be read/);

    // Opening needs the clone, so it refuses with the cause and the way to fix it.
    const open = sflow(['session', 'open', 'LIST-101', '--for-agent', '--json']);
    assert.notEqual(open.status, 0);
    const refused = JSON.parse(open.stdout);
    assert.equal(refused.error.code, 'GIT_STORAGE_UNAVAILABLE');
    assert.match(refused.error.message, /Download Now/);

    // Once the clone is readable again, the listing is the ordinary local one: nothing stale was kept.
    restore();
    restored = true;
    const again = sflow(['session', 'open', '--for-agent', '--json']);
    assert.equal(again.status, 0, again.stderr);
    const fresh = JSON.parse(again.stdout);
    assert.equal(fresh.localClone, undefined);
    assert.doesNotMatch(fresh.table, /Local clone: unavailable/);
    assert.match(fresh.table, /\| LIST-101 \|/);
  });

