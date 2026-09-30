import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { cleanupActivatedConfigurationProposal } from '../src/configuration-proposal-cleanup.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';
import { run } from '../src/util.mjs';

test('cleanup keeps squash proposals and refuses authority movement before or during deletion', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-proposal-cleanup-test-'));
  const remote = path.join(base, 'remote.git');
  const checkout = path.join(base, 'checkout');
  const branch = 'sflow/config-change/workflow/save-test-12345678';
  try {
    await mkdir(checkout);
    run('git', ['init', '--bare', '-q', remote]);
    run('git', ['init', '-q', checkout]);
    run('git', ['config', 'user.name', 'Review Test'], { cwd: checkout });
    run('git', ['config', 'user.email', 'review@example.invalid'], { cwd: checkout });
    await writeFile(path.join(checkout, 'configuration.txt'), 'original\n');
    run('git', ['add', '.'], { cwd: checkout });
    run('git', ['commit', '-qm', 'Initial configuration'], { cwd: checkout });
    run('git', ['branch', '-M', 'sflow/config'], { cwd: checkout });
    run('git', ['remote', 'add', 'origin', remote], { cwd: checkout });
    run('git', ['push', '-q', 'origin', 'sflow/config'], { cwd: checkout });
    const original = run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim();

    run('git', ['switch', '-q', '-c', branch], { cwd: checkout });
    await writeFile(path.join(checkout, 'configuration.txt'), 'reviewed\n');
    run('git', ['commit', '-qam', 'Propose configuration'], { cwd: checkout });
    const proposalCommit = run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim();
    run('git', ['push', '-q', 'origin', branch], { cwd: checkout });
    run('git', ['switch', '-q', 'sflow/config'], { cwd: checkout });
    run('git', ['merge', '--squash', branch], { cwd: checkout });
    run('git', ['commit', '-qm', 'Approve equivalent bytes by squash'], { cwd: checkout });
    const approvedCommit = run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim();
    run('git', ['push', '-q', 'origin', 'sflow/config'], { cwd: checkout });

    const stale = await cleanupActivatedConfigurationProposal(
      remote, branch, proposalCommit, original, { proofRoot: checkout }
    );
    assert.equal(stale.status, 'retained');
    assert.equal(stale.reason, 'approved-configuration-moved');
    const squash = await cleanupActivatedConfigurationProposal(
      remote, branch, proposalCommit, approvedCommit, { proofRoot: checkout }
    );
    assert.equal(squash.status, 'retained');
    assert.equal(squash.reason, 'proposal-not-in-approved-ancestry');
    assert.equal(run('git', ['--git-dir', remote, 'rev-parse', `refs/heads/${branch}`])
      .stdout.trim(), proposalCommit);

    // Once the review commit enters approved ancestry, race the deletion with a second approved
    // revision. The atomic no-op authority lease must refuse deletion based on the stale proof.
    run('git', ['merge', '--no-ff', '--no-edit', branch], { cwd: checkout });
    const mergeCommit = run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim();
    run('git', ['push', '-q', 'origin', 'sflow/config'], { cwd: checkout });
    await writeFile(path.join(checkout, 'later.txt'), 'later approved revision\n');
    run('git', ['add', 'later.txt'], { cwd: checkout });
    run('git', ['commit', '-qm', 'Advance after cleanup observation'], { cwd: checkout });
    const laterCommit = run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim();
    let movedDuringPush = false;
    const race = async (args, options) => {
      if (args[0] === 'push' && args.includes(`:refs/heads/${branch}`)) {
        movedDuringPush = true;
        run('git', ['push', '-q', 'origin', 'sflow/config'], { cwd: checkout });
      }
      return runRemoteGitAsync(args, options);
    };
    const raced = await cleanupActivatedConfigurationProposal(
      remote, branch, proposalCommit, mergeCommit,
      { proofRoot: checkout, runRemoteCommand: race }
    );
    assert.equal(movedDuringPush, true);
    assert.equal(raced.status, 'retained');
    assert.equal(raced.reason, 'deletion-refused');
    assert.equal(run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/sflow/config'])
      .stdout.trim(), laterCommit);
    assert.equal(run('git', ['--git-dir', remote, 'rev-parse', `refs/heads/${branch}`])
      .stdout.trim(), proposalCommit);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('cleanup can lease immutable approved history without updating the configuration branch', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-proposal-history-cleanup-test-'));
  const remote = path.join(base, 'remote.git');
  const checkout = path.join(base, 'checkout');
  const branch = 'sflow/config-change/workflow/save-history-12345678';
  try {
    await mkdir(checkout);
    run('git', ['init', '--bare', '-q', remote]);
    run('git', ['init', '-q', checkout]);
    run('git', ['config', 'user.name', 'Review Test'], { cwd: checkout });
    run('git', ['config', 'user.email', 'review@example.invalid'], { cwd: checkout });
    await writeFile(path.join(checkout, 'configuration.txt'), 'original\n');
    run('git', ['add', '.'], { cwd: checkout });
    run('git', ['commit', '-qm', 'Initial configuration'], { cwd: checkout });
    run('git', ['branch', '-M', 'sflow/config'], { cwd: checkout });
    run('git', ['remote', 'add', 'origin', remote], { cwd: checkout });
    run('git', ['push', '-q', 'origin', 'sflow/config'], { cwd: checkout });
    const original = run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim();
    run('git', ['switch', '-q', '-c', branch], { cwd: checkout });
    await writeFile(path.join(checkout, 'configuration.txt'), 'reviewed\n');
    run('git', ['commit', '-qam', 'Propose configuration'], { cwd: checkout });
    const proposalCommit = run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim();
    run('git', ['push', '-q', 'origin', branch], { cwd: checkout });
    run('git', ['switch', '-q', 'sflow/config'], { cwd: checkout });
    run('git', ['merge', '--ff-only', branch], { cwd: checkout });
    const approvedCommit = run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim();
    run('git', ['push', '-q', 'origin', 'sflow/config'], { cwd: checkout });
    const historyRef = `refs/heads/sflow/config-history/${approvedCommit}`;
    run('git', ['push', '-q', 'origin', `${approvedCommit}:${historyRef}`], { cwd: checkout });

    // Even the retained-history guard is leased. If it changes after the first observation,
    // deletion must not use an unproven history anchor.
    let movedHistory = false;
    const moveHistoryDuringPush = async (args, options) => {
      if (args[0] === 'push' && args.includes(`:refs/heads/${branch}`)) {
        movedHistory = true;
        run('git', ['--git-dir', remote, 'update-ref', historyRef, original]);
      }
      return runRemoteGitAsync(args, options);
    };
    const raced = await cleanupActivatedConfigurationProposal(
      remote, branch, proposalCommit, approvedCommit,
      { proofRoot: checkout, runRemoteCommand: moveHistoryDuringPush }
    );
    assert.equal(movedHistory, true);
    assert.equal(raced.status, 'retained');
    assert.equal(raced.reason, 'deletion-refused');
    assert.equal(run('git', ['--git-dir', remote, 'rev-parse', `refs/heads/${branch}`])
      .stdout.trim(), proposalCommit);
    run('git', ['--git-dir', remote, 'update-ref', historyRef, approvedCommit, original]);

    const result = await cleanupActivatedConfigurationProposal(
      remote, branch, proposalCommit, approvedCommit, { proofRoot: checkout }
    );
    assert.equal(result.status, 'deleted');
    assert.equal(result.anchor, 'approved-history');
    assert.equal(run('git', ['--git-dir', remote, 'rev-parse', historyRef]).stdout.trim(), approvedCommit);
    assert.equal(run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/sflow/config'])
      .stdout.trim(), approvedCommit);
    assert.equal(run('git', ['--git-dir', remote, 'show-ref', '--verify', '--quiet',
      `refs/heads/${branch}`], { allowFailure: true }).status, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
