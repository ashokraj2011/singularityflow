/**
 * Git after-step actions: the approved artifact committed to a branch of another repository,
 * fast-forward only, once per delivery, never over a newer generation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  fetchIsolatedDeliveryHistory, isolatedRemoteBranchTip, pushIsolatedDeliveryCommit, resolveGitCommitIdentity,
  withIsolatedGitObjectRepository, writeExactGitFileCommit
} from '../src/git.mjs';
import { deliverToGit, gitDeliveryMessage, sameGitRepository } from '../src/step-action-writers.mjs';
import { normalizeIntegrations, renderGitDeliveryPath } from '../src/step-actions.mjs';

const ENV = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Delivery Tester' };

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...ENV, GIT_AUTHOR_NAME: 'Seed', GIT_AUTHOR_EMAIL: 'seed@example.com', GIT_COMMITTER_NAME: 'Seed', GIT_COMMITTER_EMAIL: 'seed@example.com' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

/** A bare "docs" repository whose docs branch already holds files, one of them executable. */
async function docsRepository(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-git-delivery-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const remote = path.join(base, 'docs.git');
  const seed = path.join(base, 'seed');
  git(base, 'init', '-q', '--bare', '-b', 'docs', remote);
  git(base, 'init', '-q', '-b', 'docs', seed);
  await writeFile(path.join(seed, 'README.md'), '# Docs\n');
  await writeFile(path.join(seed, 'publish.sh'), '#!/bin/sh\necho publish\n');
  await chmod(path.join(seed, 'publish.sh'), 0o755);
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', '-q', 'origin', 'docs');
  const identityRoot = path.join(base, 'identity');
  git(base, 'init', '-q', identityRoot);
  return { base, remote, seed, identityRoot };
}

function gitRecord(remote, { key = `sad_${'1'.repeat(40)}`, generation = 1, bytes = Buffer.from('# Intake\n\nApproved.\n'), branch = 'docs', pathTemplate = 'specs/{story}/{step}/{file}', commitRemote = null, trigger = 'approved' } = {}) {
  return {
    key, workId: 'STORY-9', phaseId: 'intake', generation, trigger,
    action: { id: 'publish', on: [trigger], target: 'docs', send: 'artifact', targetSpec: { id: 'docs', kind: 'git', repository: remote, branch, path: pathTemplate, timeoutSeconds: 10 } },
    event: { story: { id: 'STORY-9', title: 'Checkout retry', branch: 'STORY-9', baseBranch: 'main' }, step: { id: 'intake', label: 'Intake', generation }, commit: commitRemote ? { sha: 'c'.repeat(40), remote: commitRemote } : null },
    artifact: { path: 'singularity/work-items/STORY-9/artifacts/intake/intake.md', sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'text/markdown', base64: bytes.toString('base64') }
  };
}

test('a git target names a repository, an ordinary branch and a path template', () => {
  const { targets } = normalizeIntegrations({ targets: { docs: { kind: 'git', repository: 'git@git.example.com:team/docs.git', branch: 'approved/specs', path: 'specs/{story}/{step}-g{generation}/{file}' } } });
  assert.deepEqual(targets.docs, { id: 'docs', kind: 'git', timeoutSeconds: 10, repository: 'git@git.example.com:team/docs.git', branch: 'approved/specs', path: 'specs/{story}/{step}-g{generation}/{file}' });
  assert.equal(renderGitDeliveryPath(targets.docs.path, { workId: 'STORY-9', phaseId: 'intake', generation: 2, artifactPath: 'a/b/intake.md' }), 'specs/STORY-9/intake-g2/intake.md');
  assert.equal(renderGitDeliveryPath(undefined, { workId: 'STORY 9/..', phaseId: 'intake', generation: 1, artifactPath: '../../etc/passwd' }), 'sflow/STORY-9-/intake/passwd', 'placeholders never carry a separator or a leading dot');
  const code = (target) => { try { normalizeIntegrations({ targets: { one: { kind: 'git', ...target } } }); return null; } catch (error) { return error.code; } };
  for (const target of [
    { repository: 'http://git.example.com/docs', branch: 'docs' }, { repository: 'file:///srv/docs.git', branch: 'docs' },
    { repository: '/srv/docs.git', branch: 'docs' }, { repository: 'https://user:pass@git.example.com/docs', branch: 'docs' },
    { repository: 'https://git.example.com/docs', branch: 'sflow/config' }, { repository: 'https://git.example.com/docs', branch: '../x' },
    { repository: 'https://git.example.com/docs', branch: 'docs', path: '../outside' }, { repository: 'https://git.example.com/docs', branch: 'docs', path: '{secret}/x' },
    { repository: 'https://git.example.com/docs', branch: 'docs', network: 'private' }
  ]) assert.equal(code(target), 'INTEGRATION_TARGET_INVALID', JSON.stringify(target));
  assert.equal(sameGitRepository('git@git.example.com:Team/Docs.git', 'https://git.example.com/team/docs/'), true);
  assert.equal(sameGitRepository('https://git.example.com/team/docs', 'https://git.example.com/team/other'), false);
});

test('a git delivery commits the artifact over the branch as it was, once, and never over a newer generation', async (t) => {
  const { remote, identityRoot, base } = await docsRepository(t);
  const before = git(base, '--git-dir', remote, 'rev-parse', 'docs');
  const record = gitRecord(remote);
  const first = await deliverToGit(record, { root: identityRoot, env: ENV });
  assert.equal(first.outcome, 'delivered', first.detail);
  assert.match(first.detail, /^Committed specs\/STORY-9\/intake\/intake\.md to docs as [0-9a-f]{12}\.$/);
  const after = git(base, '--git-dir', remote, 'rev-parse', 'docs');
  assert.equal(git(base, '--git-dir', remote, 'rev-parse', `${after}^`), before, 'a fast-forward of the tip it read');
  assert.equal(git(base, '--git-dir', remote, 'show', `${after}:specs/STORY-9/intake/intake.md`), '# Intake\n\nApproved.');
  assert.equal(git(base, '--git-dir', remote, 'show', `${after}:README.md`), '# Docs', 'everything else on the branch stays');
  assert.match(git(base, '--git-dir', remote, 'ls-tree', after, 'publish.sh'), /^100755 /, 'and keeps its mode');
  const message = git(base, '--git-dir', remote, 'log', '-1', '--format=%B', after);
  assert.match(message, new RegExp(`Sflow-Delivery: ${record.key}`));
  assert.match(message, /Sflow-Story: STORY-9\nSflow-Step: intake\nSflow-Generation: 1\nSflow-Artifact-Sha256: [0-9a-f]{64}/);
  assert.equal(git(base, '--git-dir', remote, 'log', '-1', '--format=%an <%ae>', after), 'Delivery Tester <delivery.tester@example.com>');

  const again = await deliverToGit(record, { root: identityRoot, env: ENV });
  assert.match(again.detail, /^Already on docs as [0-9a-f]{12}\.$/);
  assert.equal(git(base, '--git-dir', remote, 'rev-parse', 'docs'), after, 'a retry writes nothing');

  const sameBytes = await deliverToGit(gitRecord(remote, { key: `sad_${'2'.repeat(40)}`, trigger: 'submitted' }), { root: identityRoot, env: ENV });
  assert.match(sameBytes.detail, /already holds these bytes/);

  const newer = await deliverToGit(gitRecord(remote, { key: `sad_${'3'.repeat(40)}`, generation: 2, bytes: Buffer.from('# Intake\n\nRevised.\n') }), { root: identityRoot, env: ENV });
  assert.equal(newer.outcome, 'delivered', newer.detail);
  const late = await deliverToGit(gitRecord(remote, { key: `sad_${'4'.repeat(40)}`, generation: 1, bytes: Buffer.from('# Intake\n\nOld retry.\n') }), { root: identityRoot, env: ENV });
  assert.equal(late.detail, 'Superseded on docs by generation 2.');
  assert.equal(git(base, '--git-dir', remote, 'show', 'docs:specs/STORY-9/intake/intake.md'), '# Intake\n\nRevised.', 'an older generation never overwrites a newer one');
});

test('a git delivery starts a branch that does not exist, and refuses this repository\'s reviewed branches', async (t) => {
  const { remote, identityRoot, base } = await docsRepository(t);
  const created = await deliverToGit(gitRecord(remote, { branch: 'approved/specs', pathTemplate: '{file}' }), { root: identityRoot, env: ENV });
  assert.equal(created.outcome, 'delivered', created.detail);
  assert.equal(git(base, '--git-dir', remote, 'ls-tree', '--name-only', 'approved/specs'), 'intake.md', 'a new branch holds just the artifact');

  const ownMain = await deliverToGit(gitRecord(remote, { branch: 'main', commitRemote: `${remote}/` }), { root: identityRoot, env: ENV });
  assert.deepEqual([ownMain.outcome, ownMain.code], ['failed', 'STEP_ACTION_GIT_BRANCH_REFUSED']);
  const ownStory = await deliverToGit(gitRecord(remote, { branch: 'STORY-9', commitRemote: remote }), { root: identityRoot, env: ENV });
  assert.equal(ownStory.code, 'STEP_ACTION_GIT_BRANCH_REFUSED');

  const missing = await deliverToGit({ ...gitRecord(remote), artifact: { path: 'a.md', sha256: null, problem: 'a.md could not be read on this machine.' } }, { root: identityRoot, env: ENV });
  assert.deepEqual([missing.outcome, missing.code, missing.detail], ['failed', 'STEP_ACTION_ARTIFACT_UNAVAILABLE', 'a.md could not be read on this machine.']);

  const nowhere = await deliverToGit(gitRecord(path.join(base, 'missing.git')), { root: identityRoot, env: ENV });
  assert.equal(nowhere.outcome, 'failed', 'a repository that is not there waits for a person');
  assert.match(nowhere.code, /^REMOTE_/);
});

test('a push is fast-forward only: when the branch moved meanwhile, the delivery is retried on the new tip', async (t) => {
  const { remote, identityRoot, seed } = await docsRepository(t);
  const identity = resolveGitCommitIdentity(identityRoot, { env: ENV });
  const outcome = await withIsolatedGitObjectRepository({ remote }, async (scratch) => {
    const tip = await isolatedRemoteBranchTip(scratch, { remote, branch: 'docs' });
    await fetchIsolatedDeliveryHistory(scratch, { remote, commit: tip, depth: 10 });
    const commit = await writeExactGitFileCommit(scratch, { parentCommit: tip, relative: 'specs/x.md', bytes: Buffer.from('x\n'), commitIdentity: identity, message: gitDeliveryMessage(gitRecord(remote), 'specs/x.md') });
    // Someone else pushes first.
    await writeFile(path.join(seed, 'other.md'), 'other\n');
    git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'concurrent'); git(seed, 'push', '-q', 'origin', 'docs');
    return pushIsolatedDeliveryCommit(scratch, { remote, commit, branch: 'docs' });
  });
  assert.equal(outcome, 'moved');
  const retried = await deliverToGit(gitRecord(remote), { root: identityRoot, env: ENV });
  assert.equal(retried.outcome, 'delivered', 'the next attempt builds on the branch as it is now');
  assert.equal(git(path.dirname(remote), '--git-dir', remote, 'show', 'docs:other.md'), 'other');
});
