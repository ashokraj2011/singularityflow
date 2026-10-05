/**
 * A Story intake receipt authorizes nothing, and anything unusual about one means the full path.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  STORY_INTAKE_RECEIPT_TTL_MS, claimStoryIntakeReceipt, mintStoryIntakeReceipt, storyIntakeInputsDigest
} from '../src/story-intake-receipt.mjs';
import { admitStoryIntakeReceipt } from '../src/story-intake-verification.mjs';

const commit = 'a'.repeat(40);
const inputs = {
  workId: 'STORY-1', workType: 'feature', baseBranch: 'main', remote: 'origin',
  capabilityId: null, references: []
};

async function repository(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-intake-receipt-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'service');
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', root]).status, 0);
  return { base, root, directory: path.join(root, '.git', 'singularity-flow', 'intake-receipts') };
}

function mint(root, overrides = {}) {
  return mintStoryIntakeReceipt(root, {
    inputs,
    authority: { remote: 'https://example.test/org/config.git', branch: 'sflow/config', commit, sourceCommit: null },
    repositories: [{
      id: 'service', remote: 'origin', baseBranch: 'main', baseCommit: commit,
      destinationRef: 'refs/heads/STORY-1',
      fetch: { url: 'https://example.test/org/service.git', fingerprint: 'sha256:fetch' },
      push: { url: 'https://example.test/org/service.git', fingerprint: 'sha256:push' },
      state: { branch: 'state', commit: 'b'.repeat(40) }
    }],
    ...overrides
  });
}

test('a receipt is claimed once, for the request it answers, and consumed or given back', async (t) => {
  const { root, directory } = await repository(t);
  const minted = await mint(root);
  assert.match(minted.id, /^sir_[0-9a-f]{32}$/);
  const file = path.join(directory, `${minted.id}.json`);
  assert.equal((await lstat(file)).mode & 0o777, 0o600, 'readable only by its owner');
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  const bytes = await readFile(file, 'utf8');
  assert.doesNotMatch(bytes, new RegExp(root.replaceAll('/', '\\/')), 'no checkout path is recorded');

  const claimed = await claimStoryIntakeReceipt(root, minted.id, { inputs });
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.receipt.repositories[0].baseCommit, commit);
  assert.equal((await claimStoryIntakeReceipt(root, minted.id, { inputs })).reason, 'missing',
    'a claimed receipt cannot serve a second start');
  await claimed.release();
  const again = await claimStoryIntakeReceipt(root, minted.id, { inputs });
  assert.equal(again.status, 'claimed', 'a start that changed nothing durable gives it back');
  await again.consume();
  assert.equal((await claimStoryIntakeReceipt(root, minted.id, { inputs })).reason, 'missing');
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith(minted.id)), []);
});

test('an edited, expired, foreign or disabled receipt is refused and discarded', async (t) => {
  const { root, directory } = await repository(t);
  const edited = await mint(root);
  const file = path.join(directory, `${edited.id}.json`);
  const record = JSON.parse(await readFile(file, 'utf8'));
  record.repositories[0].baseCommit = 'c'.repeat(40);
  await writeFile(file, JSON.stringify(record));
  assert.equal((await claimStoryIntakeReceipt(root, edited.id, { inputs })).reason, 'integrity');
  assert.equal((await claimStoryIntakeReceipt(root, edited.id, { inputs })).reason, 'missing', 'discarded');

  const expired = await mint(root);
  assert.equal((await claimStoryIntakeReceipt(root, expired.id, {
    inputs, now: Date.now() + STORY_INTAKE_RECEIPT_TTL_MS + 1
  })).reason, 'expired');

  const otherRequest = await mint(root);
  assert.equal((await claimStoryIntakeReceipt(root, otherRequest.id, {
    inputs: { ...inputs, workType: 'bugfix' }
  })).reason, 'inputs', 'a start for a different request runs the full path');

  const worktree = path.join(path.dirname(root), 'story-worktree');
  assert.equal(spawnSync('git', ['-C', root, '-c', 'user.name=Receipt Test', '-c', 'user.email=receipt@example.test', 'commit', '-q', '--allow-empty', '-m', 'base']).status, 0);
  assert.equal(spawnSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'other', worktree]).status, 0);
  const elsewhere = await mint(root);
  assert.equal((await claimStoryIntakeReceipt(worktree, elsewhere.id, { inputs })).reason, 'binding',
    'the same Git directory from another checkout is not the launch checkout it was minted for');

  const disabled = await mint(root);
  assert.equal((await claimStoryIntakeReceipt(root, disabled.id, {
    inputs, env: { SINGULARITY_FLOW_STORY_INTAKE_RECEIPTS: 'off' }
  })).reason, 'disabled');
  assert.equal((await claimStoryIntakeReceipt(root, '../escape', { inputs })).reason, 'malformed');
});

test('the request digest ignores reference order and nothing else', () => {
  const references = [
    { id: 'b', url: 'https://example.test/b.git', branch: 'main' },
    { id: 'a', url: 'https://example.test/a.git', branch: 'main' }
  ];
  assert.equal(storyIntakeInputsDigest({ ...inputs, references }),
    storyIntakeInputsDigest({ ...inputs, references: [...references].reverse() }));
  assert.notEqual(storyIntakeInputsDigest({ ...inputs, references }),
    storyIntakeInputsDigest({ ...inputs, references: [{ ...references[0], branch: 'release' }, references[1]] }));
  assert.notEqual(storyIntakeInputsDigest(inputs), storyIntakeInputsDigest({ ...inputs, baseBranch: 'release' }));
});

test('a receipt cannot override an onboarding pin and a mismatch releases its claim', async (t) => {
  const { root } = await repository(t);
  const minted = await mint(root);
  const authority = {
    remote: 'https://example.test/org/config.git', branch: 'sflow/config', commit, sourceCommit: commit
  };
  for (const replacement of [
    { remote: 'https://example.test/other/config.git' },
    { branch: 'state' },
    { commit: 'c'.repeat(40) },
    { sourceCommit: 'd'.repeat(40) }
  ]) {
    const admitted = await admitStoryIntakeReceipt(root, minted.id, {
      inputs, workId: inputs.workId, remote: inputs.remote, baseBranch: inputs.baseBranch,
      configurationAuthority: { ...authority, ...replacement }
    });
    assert.deepEqual(admitted, { status: 'rejected', reason: 'configuration' });
  }
  const released = await claimStoryIntakeReceipt(root, minted.id, { inputs });
  assert.equal(released.status, 'claimed');
  await released.consume();
});
