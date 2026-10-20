import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

/**
 * `session open <ID>` on a Story that already has its own managed checkout brings that checkout up
 * to date from the remote first: fetch and fast-forward only. Local commits the remote lacks are
 * kept (ahead opens; diverged stops), uncommitted changes stop a needed fast-forward, and a remote
 * that cannot be reached opens the checkout as it is and says so.
 */
const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

test('session open fast-forwards an existing local Story checkout, and never merges or discards local work',
  { timeout: 300_000 }, async (t) => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-open-local-sync-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const root = path.join(base, 'repo');
    const remote = path.join(base, 'remote.git');
    const other = path.join(base, 'other');
    const worktree = path.join(base, 'story-worktrees', 'SYNC-1');
    const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_BUNDLE: 'off', SINGULARITY_FLOW_NO_MODEL: '1',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Sync Opener',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Sync Opener',
      GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'sync.opener@example.invalid' };
    const must = (command, args, cwd = root) => {
      const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
      assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };
    const open = () => {
      const result = spawnSync(process.execPath, [cli, 'session', 'open', 'SYNC-1', '--for-agent', '--json'],
        { cwd: root, env, encoding: 'utf8', timeout: 180_000 });
      let packet = null;
      try {
        packet = JSON.parse(result.stdout);
        if (packet.agentOutput?.path) packet = JSON.parse(readFileSync(packet.agentOutput.path, 'utf8'));
      } catch { /* asserted below */ }
      return { ...result, packet };
    };
    const remoteHead = () => must('git', ['rev-parse', 'refs/heads/SYNC-1'], remote).trim();
    const localHead = () => must('git', ['rev-parse', 'HEAD'], worktree).trim();
    const publishFromOther = async (file, text) => {
      must('git', ['pull', '-q', '--ff-only'], other);
      await writeFile(path.join(other, file), text);
      must('git', ['add', file], other);
      must('git', ['commit', '-q', '-m', `Remote ${file}`], other);
      must('git', ['push', '-q', 'origin', 'SYNC-1'], other);
    };

    must('git', ['init', '-q', '-b', 'main', root], base);
    // Assert exact checkout bytes regardless of the host's global core.autocrlf setting.
    await writeFile(path.join(root, '.gitattributes'), '* text eol=lf\n');
    await writeFile(path.join(root, 'README.md'), '# Local sync\n');
    must(process.execPath, [cli, '--no-model', 'init']);
    const definitionPath = path.join(root, 'singularity/workflow.yml');
    const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
    definition.ledger.enabled = true;
    await writeFile(definitionPath, YAML.stringify(definition));
    must('git', ['add', '.']);
    must('git', ['commit', '-q', '-m', 'Local sync fixture']);
    must('git', ['init', '-q', '--bare', '-b', 'main', remote], base);
    must('git', ['remote', 'add', 'origin', remote]);
    must('git', ['push', '-q', '-u', 'origin', 'main']);
    must(process.execPath, [cli, '--no-model', 'start', 'SYNC-1', '--from-branch', 'main', '--work-type', 'classic-delivery',
      '--title', 'Sync before open', '--description', 'An existing checkout is fast-forwarded first.']);
    must('git', ['checkout', '-q', 'main']);
    must('git', ['worktree', 'add', '-q', worktree, 'SYNC-1']);
    must('git', ['clone', '-q', '--branch', 'SYNC-1', remote, other], base);

    // Already current: opened locally, and it says it matches the remote.
    const current = open();
    assert.equal(current.status, 0, current.stdout);
    assert.equal(current.packet.status, 'ready');
    assert.equal(current.packet.localOnly, true);
    assert.equal(current.packet.open.remoteSync.status, 'current');
    assert.equal(current.packet.act.story.remoteSync, 'current');

    // Behind and clean: fast-forwarded to the remote head before the session binds.
    await publishFromOther('remote-1.txt', 'first remote change\n');
    const forwarded = open();
    assert.equal(forwarded.status, 0, forwarded.stdout);
    assert.equal(forwarded.packet.open.remoteSync.status, 'fast-forwarded');
    assert.equal(localHead(), remoteHead());
    assert.equal(forwarded.packet.open.head, remoteHead());
    assert.equal(await readFile(path.join(worktree, 'remote-1.txt'), 'utf8'), 'first remote change\n');

    // Ahead only: local commits are kept and the checkout opens.
    await writeFile(path.join(worktree, 'local.txt'), 'local work\n');
    must('git', ['add', 'local.txt'], worktree);
    must('git', ['commit', '-q', '-m', 'Local work'], worktree);
    const aheadHead = localHead();
    const ahead = open();
    assert.equal(ahead.status, 0, ahead.stdout);
    assert.equal(ahead.packet.open.remoteSync.status, 'ahead');
    assert.equal(localHead(), aheadHead);

    // Diverged: nothing is merged or rebased, and the refusal names the next step.
    await publishFromOther('remote-2.txt', 'second remote change\n');
    const diverged = open();
    assert.notEqual(diverged.status, 0);
    assert.equal(diverged.packet.error.code, 'SESSION_LOCAL_SYNC_DIVERGED');
    assert.match(diverged.packet.error.message, /have diverged \(1 local, 1 remote commits\)\. Nothing was merged, rebased, reset, stashed or discarded\./);
    assert.match(diverged.packet.error.message, /log --oneline --left-right HEAD\.\.\.origin\/SYNC-1.*then run \/sf-session SYNC-1 again/);
    assert.equal(localHead(), aheadHead);
    must('git', ['reset', '-q', '--hard', 'origin/SYNC-1'], worktree);

    // Behind with uncommitted changes: the changes stay and nothing moves.
    await publishFromOther('remote-3.txt', 'third remote change\n');
    await writeFile(path.join(worktree, 'remote-1.txt'), 'edited locally\n');
    const before = localHead();
    const dirty = open();
    assert.notEqual(dirty.status, 0);
    assert.equal(dirty.packet.error.code, 'SESSION_LOCAL_SYNC_DIRTY');
    assert.match(dirty.packet.error.message, /is 1 commit\(s\) behind origin\/SYNC-1 and has uncommitted changes\. Nothing was merged/);
    assert.equal(localHead(), before);
    assert.equal(await readFile(path.join(worktree, 'remote-1.txt'), 'utf8'), 'edited locally\n');
    must('git', ['checkout', '-q', '--', 'remote-1.txt'], worktree);

    // An unreachable remote does not hide a readable checkout: it opens as it is, and says so.
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    must('git', ['remote', 'set-url', 'origin', `http://127.0.0.1:${port}/closed.git`]);
    const offline = open();
    assert.equal(offline.status, 0, offline.stdout);
    assert.equal(offline.packet.status, 'ready');
    assert.equal(offline.packet.open.remoteSync.status, 'unavailable');
    assert.match(offline.packet.open.remoteSync.reason, /The remote could not be reached, so SYNC-1 was opened as it is and may be behind origin\/SYNC-1/);
    assert.match(offline.packet.act.said, /the remote could not be reached, so the local checkout was opened as it is and may be behind/);
    assert.equal(localHead(), before, 'nothing moved while the remote was unreachable');
  });
