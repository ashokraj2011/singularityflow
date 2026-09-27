import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  preflightStoryRepositories, publishCapabilityRepositories
} from '../src/capability-start.mjs';
import { publishCapabilityRepositoriesDurably } from '../src/capability-publication-recovery.mjs';
import { parseBaseSelection, resolveCapabilityBase } from '../src/capability-branches.mjs';
import { configuredRemoteAuthority } from '../src/git-remote-diagnostics.mjs';
import { gitCommonDir, refHead } from '../src/git.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';
import { run } from '../src/util.mjs';

const entries = (count) => Array.from({ length: count }, (_, index) => ({
  schemaVersion: 1, repository: `sibling-${index}`, root: `root-${index}`,
  remote: 'origin', branch: 'STORY-WAVE', commit: String(index + 1).repeat(40),
  destinationRef: 'refs/heads/STORY-WAVE', remoteFingerprint: `authority-${index}`,
  expectedRemoteSha: null, pushOutcome: 'not-attempted'
}));
const remoteAuthority = (root) => {
  const index = Number(root.slice('root-'.length));
  return { url: `https://enterprise.invalid/sibling-${index}.git`, fingerprint: `authority-${index}` };
};
const success = { status: 0, stdout: '', stderr: '' };

test('sibling publication settles bounded waves in plan order and stops later waves on refusal', async () => {
  const plan = entries(7);
  let active = 0;
  let maximum = 0;
  const attempted = [];
  const result = await publishCapabilityRepositories(plan, {
    workers: 3, remoteAuthority,
    publishCandidate: async (root) => {
      const index = Number(root.slice('root-'.length));
      attempted.push(index);
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, (3 - index) * 5));
      active -= 1;
      return {
        result: index === 1 ? { status: 1, stdout: '', stderr: 'explicit refusal' } : success,
        candidateVerified: false, legacyUnverified: true
      };
    }
  });
  assert.equal(maximum, 3);
  assert.deepEqual(attempted, [0, 1, 2]);
  assert.deepEqual(result.published.map((entry) => entry.repository), ['sibling-0', 'sibling-2']);
  assert.deepEqual(result.pending.map((entry) => entry.repository),
    ['sibling-1', 'sibling-3', 'sibling-4', 'sibling-5', 'sibling-6']);
  assert.deepEqual(result.pending.map((entry) => entry.pushOutcome),
    ['rejected', 'not-attempted', 'not-attempted', 'not-attempted', 'not-attempted']);
  assert.equal(result.error, 'explicit refusal');
});

test('publication cannot raise the four-transport ceiling and preserves successful order', async () => {
  let active = 0;
  let maximum = 0;
  const result = await publishCapabilityRepositories(entries(9), {
    workers: 100, remoteAuthority,
    publishCandidate: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { result: success };
    }
  });
  assert.equal(maximum, 4);
  assert.deepEqual(result.published.map((entry) => entry.repository),
    entries(9).map((entry) => entry.repository));
  assert.deepEqual(result.pending, []);
});

test('lost ACK in one wave member remains exact-reconcilable without erasing concurrent success', async () => {
  const plan = entries(3);
  const publishedTips = new Map();
  const result = await publishCapabilityRepositories(plan, {
    workers: 2, remoteAuthority,
    publishCandidate: async (root, options) => {
      publishedTips.set(root, options.commit);
      return { result: root === 'root-0'
        ? { status: null, timedOut: true, stdout: '', stderr: 'lost ACK' } : success };
    }
  });
  assert.deepEqual(result.published.map((entry) => entry.repository), ['sibling-1']);
  assert.deepEqual(result.pending.map((entry) => entry.pushOutcome),
    ['transport-indeterminate', 'not-attempted']);
  let pushes = 0;
  const recovered = await publishCapabilityRepositories([result.pending[0]], {
    remoteAuthority,
    observeBranch: async (root) => ({ reachable: true, malformed: false, sha: publishedTips.get(root) }),
    publishCandidate: async () => { pushes += 1; return { result: success }; }
  });
  assert.equal(pushes, 0);
  assert.equal(recovered.published[0].reconciled, true);
});

test('poisoned zero exit cannot publish or reconcile a sibling', async () => {
  const plan = entries(1);
  const failed = await publishCapabilityRepositories(plan, {
    remoteAuthority,
    publishCandidate: async () => ({ result: { ...success, aborted: true } })
  });
  assert.deepEqual(failed.published, []);
  assert.equal(failed.pending[0].pushOutcome, 'transport-indeterminate');
  const checked = await publishCapabilityRepositories(failed.pending, {
    remoteAuthority,
    observeBranch: async () => ({
      reachable: true, malformed: false, sha: plan[0].commit,
      result: { ...success, timedOut: true }
    }),
    publishCandidate: async () => assert.fail('poisoned remote proof cannot authorize another push')
  });
  assert.deepEqual(checked.published, []);
  assert.equal(checked.pending[0].pushOutcome, 'transport-indeterminate');
});

test('known pre-dispatch and Candidate failures do not acquire equal-tip recovery authority', async () => {
  for (const stage of ['configuration', 'candidate']) {
    const plan = entries(1);
    const failed = await publishCapabilityRepositories(plan, {
      remoteAuthority: stage === 'configuration'
        ? () => { throw new Error('configuration unavailable'); } : remoteAuthority,
      publishCandidate: async () => { throw new Error('Candidate refused before transport'); }
    });
    assert.equal(failed.pending[0].pushOutcome, 'not-attempted', stage);
    let observations = 0;
    let attempts = 0;
    const retried = await publishCapabilityRepositories(failed.pending, {
      remoteAuthority,
      observeBranch: async () => {
        observations += 1;
        return { reachable: true, malformed: false, sha: plan[0].commit };
      },
      publishCandidate: async () => {
        attempts += 1;
        return { result: { status: 1, stdout: '', stderr: 'identical ref belongs to another actor' } };
      }
    });
    assert.equal(observations, 0, stage);
    assert.equal(attempts, 1, stage);
    assert.equal(retried.pending[0].pushOutcome, 'rejected', stage);
  }
});

test('publication captures entry identity before async dispatch', async () => {
  const plan = entries(1);
  const originalCommit = plan[0].commit;
  const result = await publishCapabilityRepositories(plan, {
    remoteAuthority,
    publishCandidate: async (_root, options) => {
      plan[0].commit = 'f'.repeat(40);
      plan[0].branch = 'OTHER-STORY';
      await Promise.resolve();
      assert.equal(options.commit, originalCommit);
      assert.equal(options.branch, 'STORY-WAVE');
      return { result: success };
    }
  });
  assert.equal(result.published[0].commit, originalCommit);
  assert.equal(result.published[0].branch, 'STORY-WAVE');
});

test('durable publication marks only its current wave before dispatch and serializes marker writes', async () => {
  const plan = entries(6);
  const receipts = [];
  let cleared = false;
  let activeWrites = 0;
  let maximumWrites = 0;
  const result = await publishCapabilityRepositoriesDurably('root', 'STORY-WAVE', {}, plan, {
    workers: 2,
    retainRecovery: async (_root, _id, _publication, pending) => {
      activeWrites += 1;
      maximumWrites = Math.max(maximumWrites, activeWrites);
      await Promise.resolve();
      receipts.push(structuredClone(pending));
      activeWrites -= 1;
    },
    clearRecovery: async () => { cleared = true; },
    publishRepositories: async (wave, options) => {
      assert.equal(options.workers, 2);
      const durable = receipts.at(-1);
      assert.deepEqual(durable.slice(0, 2).map((entry) => entry.repository),
        wave.map((entry) => entry.repository));
      assert.ok(durable.slice(0, 2).every((entry) => entry.pushOutcome === 'transport-indeterminate'));
      assert.ok(durable.slice(2).every((entry) => entry.pushOutcome === 'not-attempted'));
      assert.ok(wave.every((entry) => entry.pushOutcome === 'not-attempted'),
        'in-flight marker must not authorize equality for a returned create-only rejection');
      return { published: wave.map((entry) => ({ repository: entry.repository })), pending: [], error: null };
    }
  });
  assert.equal(maximumWrites, 1);
  assert.equal(cleared, true);
  assert.deepEqual(result.published.map((entry) => entry.repository), plan.map((entry) => entry.repository));
});

test('a refused durable wave retains successful peers and an ordered unattempted tail', async () => {
  const plan = entries(5);
  const receipts = [];
  let calls = 0;
  const result = await publishCapabilityRepositoriesDurably('root', 'STORY-WAVE', {}, plan, {
    workers: 3,
    retainRecovery: async (_root, _id, _publication, pending) => receipts.push(structuredClone(pending)),
    clearRecovery: async () => assert.fail('partial publication must retain its journal'),
    publishRepositories: async (wave) => {
      calls += 1;
      return {
        published: [{ repository: wave[0].repository }, { repository: wave[2].repository }],
        pending: [{ ...wave[1], pushOutcome: 'rejected' }], error: 'known refusal'
      };
    }
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.pending.map((entry) => entry.repository), ['sibling-1', 'sibling-3', 'sibling-4']);
  assert.deepEqual(receipts.at(-1), result.pending);
  assert.deepEqual(result.pending.map((entry) => entry.pushOutcome),
    ['rejected', 'not-attempted', 'not-attempted']);
});

test('a failed wave-journal write starts no pushes', async () => {
  let pushes = 0;
  await assert.rejects(() => publishCapabilityRepositoriesDurably('root', 'STORY-WAVE', {}, entries(4), {
    retainRecovery: async () => { throw new Error('journal unavailable'); },
    publishRepositories: async () => { pushes += 1; }
  }), /journal unavailable/u);
  assert.equal(pushes, 0);
});

test('an unexpected wave failure retains every in-flight peer as indeterminate, not the tail', async () => {
  const receipts = [];
  const result = await publishCapabilityRepositoriesDurably('root', 'STORY-WAVE', {}, entries(5), {
    workers: 2,
    retainRecovery: async (_root, _id, _publication, pending) => receipts.push(structuredClone(pending)),
    publishRepositories: async () => { throw new Error('runner lost during wave'); }
  });
  assert.deepEqual(result.pending.map((entry) => entry.pushOutcome),
    ['transport-indeterminate', 'transport-indeterminate', 'not-attempted', 'not-attempted', 'not-attempted']);
  assert.deepEqual(receipts.at(-1), result.pending);
});

const git = (cwd, ...args) => run('git', args, { cwd, allowFailure: false }).stdout.trim();
async function launchFixture(t, { registered = false } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'sflow-start-fetch-performance-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'work', 'lifecycle');
  const remote = path.join(base, 'origin.git');
  await mkdir(path.dirname(root), { recursive: true });
  git(base, 'init', '--bare', '--initial-branch=main', remote);
  git(base, 'clone', '--quiet', remote, root);
  git(root, 'config', 'user.name', 'Story Fixture');
  git(root, 'config', 'user.email', 'story@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# lifecycle\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'initial');
  git(root, 'push', '--quiet', 'origin', 'main');
  if (registered) git(root, 'push', '--quiet', 'origin', 'HEAD:refs/heads/state');
  git(root, 'fetch', '--quiet', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*');
  const authority = configuredRemoteAuthority(root, 'origin', { direction: 'fetch' });
  const proof = Object.freeze({
    sourceCommonDir: gitCommonDir(root), remote: 'origin',
    transportRemote: authority.url, remoteFingerprint: authority.fingerprint,
    baseBranch: 'main', baseCommit: refHead(root, 'refs/remotes/origin/main'),
    stateBranch: registered ? 'state' : null,
    stateCommit: registered ? refHead(root, 'refs/remotes/origin/state') : null
  });
  const repository = { id: 'lifecycle', url: remote, path: 'work/lifecycle', defaultBranch: 'main' };
  const resolution = resolveCapabilityBase({
    repositories: { lifecycle: ['main'] }, selection: parseBaseSelection(['main'])
  });
  const options = {
    lifecycleRoot: root, publishRequired: false, launchFetchProof: proof,
    ...(registered ? { configurationSnapshot: { definition: {
      worldModel: { format: 'registered-v4' }, ledger: { branch: 'state', remote: 'origin' }
    } } } : {})
  };
  const calls = [];
  options.runGit = async (args, runOptions) => {
    calls.push([...args]);
    return runRemoteGitAsync(args, runOptions);
  };
  const preflight = () => preflightStoryRepositories(base, { repositories: [repository], resolution },
    'STORY-FRESH', options);
  return { base, root, remote, options, calls, preflight };
}

test('capability preflight reuses a same-command launch fetch after one fresh exact-ref probe', async (t) => {
  const fixture = await launchFixture(t, { registered: true });
  assert.equal(refHead(fixture.root, 'refs/remotes/origin/main'), fixture.options.launchFetchProof.baseCommit);
  assert.equal(refHead(fixture.root, 'refs/remotes/origin/state'), fixture.options.launchFetchProof.stateCommit);
  assert.equal(refHead(fixture.root, 'refs/remotes/origin/STORY-FRESH'), null);
  assert.equal(configuredRemoteAuthority(fixture.root, 'origin', { direction: 'fetch' }).fingerprint,
    fixture.options.launchFetchProof.remoteFingerprint);
  const checked = await fixture.preflight();
  assert.equal(checked[0].fetchReused, true, JSON.stringify(fixture.calls));
  assert.equal(fixture.calls.filter((args) => args[0] === 'fetch').length, 0);
  const probes = fixture.calls.filter((args) => args[0] === 'ls-remote');
  assert.equal(probes.length, 1);
  assert.deepEqual(probes[0].slice(-3).sort(), ['refs/heads/main', 'refs/heads/STORY-FRESH', 'refs/heads/state'].sort());
  assert.equal(checked[0].worldModelAuthorityRefresh.commit, fixture.options.launchFetchProof.stateCommit);
});

test('moved launch base is fetched and bound rather than reused', async (t) => {
  const fixture = await launchFixture(t);
  await writeFile(path.join(fixture.root, 'README.md'), '# moved base\n');
  git(fixture.root, 'commit', '--quiet', '-am', 'moved base');
  const moved = git(fixture.root, 'rev-parse', 'HEAD');
  // Publish through the bare authority so this checkout's tracking tip stays at the launch receipt.
  git(fixture.root, 'push', '--quiet', fixture.remote, 'HEAD:refs/heads/main');
  const checked = await fixture.preflight();
  assert.equal(checked[0].fetchReused, false);
  assert.equal(checked[0].baseCommit, moved);
  assert.equal(fixture.calls.filter((args) => args[0] === 'fetch').length, 1);
});

test('absent remote Story and state tips take the normal prune path for stale tracking refs', async (t) => {
  const fixture = await launchFixture(t, { registered: true });
  git(fixture.root, 'update-ref', 'refs/remotes/origin/STORY-FRESH', fixture.options.launchFetchProof.baseCommit);
  git(fixture.remote, '--git-dir', fixture.remote, 'update-ref', '-d', 'refs/heads/state');
  const checked = await fixture.preflight();
  assert.equal(checked[0].fetchReused, false);
  assert.equal(fixture.calls.filter((args) => args[0] === 'fetch').length, 1);
  assert.equal(refHead(fixture.root, 'refs/remotes/origin/STORY-FRESH'), null);
  assert.equal(checked[0].worldModelAuthorityRefresh.status, 'remote-absent');
  assert.equal(checked[0].worldModelAuthorityRefresh.commit, null);
});

test('a state tip removed after launch is freshly detected and pruned even when the base did not move', async (t) => {
  const fixture = await launchFixture(t, { registered: true });
  git(fixture.remote, '--git-dir', fixture.remote, 'update-ref', '-d', 'refs/heads/state');
  const checked = await fixture.preflight();
  assert.equal(checked[0].fetchReused, false);
  assert.equal(fixture.calls.filter((args) => args[0] === 'ls-remote').length, 1);
  assert.equal(fixture.calls.filter((args) => args[0] === 'fetch').length, 1);
  assert.equal(refHead(fixture.root, 'refs/remotes/origin/state'), null);
  assert.equal(checked[0].worldModelAuthorityRefresh.status, 'remote-absent');
});

test('freshly absent state remains reusable only when the launch fetch also proved absence', async (t) => {
  const fixture = await launchFixture(t, { registered: true });
  git(fixture.remote, '--git-dir', fixture.remote, 'update-ref', '-d', 'refs/heads/state');
  git(fixture.root, 'fetch', '--quiet', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*');
  fixture.options.launchFetchProof = { ...fixture.options.launchFetchProof, stateCommit: null };
  const checked = await fixture.preflight();
  assert.equal(checked[0].fetchReused, true);
  assert.equal(fixture.calls.filter((args) => args[0] === 'fetch').length, 0);
  assert.equal(checked[0].worldModelAuthorityRefresh.status, 'remote-absent');
});

test('poisoned fetch success is refused before any publication probe', async (t) => {
  const fixture = await launchFixture(t);
  fixture.options.launchFetchProof = null;
  let probes = 0;
  fixture.options.publishRequired = true;
  fixture.options.runGit = async (args) => {
    if (args[0] === 'push') probes += 1;
    return { ...success, aborted: true };
  };
  await assert.rejects(fixture.preflight, (error) => error.code === 'STORY_REMOTE_UNREACHABLE');
  assert.equal(probes, 0);
});

test('newly published Story destination is still refused after launch fetch', async (t) => {
  const fixture = await launchFixture(t);
  git(fixture.root, 'push', '--quiet', fixture.remote, 'HEAD:refs/heads/STORY-FRESH');
  await assert.rejects(fixture.preflight, (error) => error.code === 'STORY_BRANCH_EXISTS');
  assert.equal(fixture.calls.filter((args) => args[0] === 'fetch').length, 1);
});

test('a receipt for another common directory cannot bypass the ordinary fetch', async (t) => {
  const fixture = await launchFixture(t);
  fixture.options.launchFetchProof = { ...fixture.options.launchFetchProof, sourceCommonDir: fixture.base };
  const checked = await fixture.preflight();
  assert.equal(checked[0].fetchReused, false);
  assert.equal(fixture.calls.filter((args) => args[0] === 'fetch').length, 1);
  assert.equal(fixture.calls.filter((args) => args[0] === 'ls-remote').length, 0);
});
