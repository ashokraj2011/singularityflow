/**
 * A build is said to contain a change only through exact commit provenance. `[INT:AC-013]`
 * `[INT:IFC-041]` `[INT:CON-093]` `[INT:REQ-094]` `[INT:CON-094]` `[INT:REQ-153]`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BUILD_RECORD_FIELDS, buildBoundary, buildProviderFile, buildRelation, normalizeBuild, readBuilds
} from '../src/gateway/build-provenance.mjs';
import { githubActionsRuns } from '../src/github-evidence.mjs';
import { repositoryQuery } from '../src/gateway/planners/repository-query.mjs';
import { run } from '../src/util.mjs';

const git = (root, ...args) => run('git', args, { cwd: root }).stdout.trim();

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-int-build-'));
  const state = await mkdtemp(path.join(os.tmpdir(), 'sflow-int-build-state-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'dev@example.test');
  git(root, 'config', 'user.name', 'Dev');
  const commits = [];
  for (const step of [1, 2, 3]) {
    await writeFile(path.join(root, 'value.txt'), `${step}\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', `step ${step}`);
    commits.push(git(root, 'rev-parse', 'HEAD'));
  }
  const env = { ...process.env, SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(state, 'active-workspace.json') };
  return { root, env, commits };
}

const run8398 = (sha, conclusion = 'success', id = 8398) => ({
  databaseId: id, headSha: sha, headBranch: 'main', workflowName: 'checkout', conclusion, status: 'completed',
  createdAt: `2026-10-2${id % 10}T10:00:00Z`, updatedAt: `2026-10-2${id % 10}T10:05:00Z`, url: `https://example.test/runs/${id}`, displayTitle: 'checkout'
});

test('build-claims-require-provenance', async (t) => {
  const { root, env, commits } = await repository(t);
  const isAncestor = (older, newer) => git(root, 'merge-base', older, newer) === older;
  const retrievedAt = '2026-10-24T00:00:00.000Z';

  // Normalized into the neutral record, in order; an inexact commit is dropped, never shortened.
  const exact = normalizeBuild('github-actions', run8398(commits[1]), retrievedAt);
  assert.deepEqual(Object.keys(exact), [...BUILD_RECORD_FIELDS]);
  const inexact = normalizeBuild('github-actions', run8398(commits[1].slice(0, 12)), retrievedAt);
  assert.equal(inexact.sourceCommit, null);

  // The only content claims are the two exact provenance allows.
  assert.equal(buildRelation(exact, commits[1], { isAncestor }).relation, 'built-from');
  assert.equal(buildRelation(exact, commits[0], { isAncestor }).relation, 'contains');
  assert.equal(buildRelation(exact, commits[2], { isAncestor }).relation, 'does-not-contain');
  const near = buildRelation(inexact, commits[1], { isAncestor });
  assert.deepEqual([near.relation, near.language], ['observed-near', 'observed near']);
  assert.equal(buildRelation({ ...inexact, startedAt: null }, commits[1], { isAncestor }).language, 'mapping unavailable');
  // A pass/fail boundary across builds is a candidate range, drawn only through exact builds.
  const boundary = buildBoundary([exact, normalizeBuild('github-actions', run8398(commits[2], 'failure', 8429), retrievedAt), inexact]);
  assert.deepEqual([boundary.lastGood.buildId, boundary.firstBad.buildId, boundary.language], ['8398', '8429', 'candidate range']);

  // Unconfigured: an evidence gap, never a guess from the remote's host.
  assert.equal((await readBuilds(root, { repositoryId: 'checkout', env })).gap, 'build-provider-not-configured');
  await writeFile(buildProviderFile(env), JSON.stringify({ repositories: { other: { kind: 'jenkins' } } }));
  assert.equal((await readBuilds(root, { repositoryId: 'other', env })).gap, 'build-provider-unsupported');
  // Configured: the adapter reads, normalizes, and a provider failure is a gap that does not stop the read.
  await writeFile(buildProviderFile(env), JSON.stringify({ repositories: { checkout: { kind: 'github-actions', remote: 'https://git.example.test/acme/checkout.git' } } }));
  const runs = async () => [run8398(commits[1]), run8398('not-a-sha', 'failure', 8412)];
  const read = await readBuilds(root, { repositoryId: 'checkout', env, runs });
  assert.deepEqual(read.builds.map((build) => [build.buildId, build.sourceCommit]), [['8398', commits[1]], ['8412', null]]);
  const failing = await readBuilds(root, { repositoryId: 'checkout', env, runs: async () => { throw new Error('gh: not logged in'); } });
  assert.equal(failing.gap, 'build-provider-unavailable');

  // The repository question "which commit is build N" answers only from exact provenance.
  const context = { repositoryId: 'checkout' };
  const mapped = await repositoryQuery({ root, env, runs, context, arguments: { query: 'build-commit', buildId: '8398' } });
  assert.deepEqual([mapped.data.commit, mapped.data.facts[0].relation], [commits[1], 'built-from']);
  const unmapped = await repositoryQuery({ root, env, runs, context, arguments: { query: 'build-commit', buildId: '8412' } });
  assert.equal(unmapped.why[0].code, 'repository.query.build-unmapped');

  // The reference adapter is a read: `gh run list`, and no verb that reruns, cancels or deploys.
  const seen = [];
  githubActionsRuns(root, 'https://git.example.test/acme/checkout.git', {
    branch: 'main', runCommand: (command, args) => { seen.push([command, ...args]); return { status: 0, stdout: '[]' }; }
  });
  assert.deepEqual(seen[0].slice(0, 5), ['gh', 'run', 'list', '--repo', 'acme/checkout']);
  assert.ok(!seen.flat().some((word) => ['rerun', 'cancel', 'delete', 'approve', 'deploy'].includes(word)));
});

test('build.read is a reachable automatic read with an honest gap', async (t) => {
  const { root, env, commits } = await repository(t);
  const { buildRead } = await import('../src/gateway/planners/build-read.mjs');
  const { gatewayOperation } = await import('../src/gateway/operations.mjs');
  const { operationPermission, resolveGatewayPolicy } = await import('../src/gateway/policy.mjs');
  assert.equal(gatewayOperation('build.read').classification, 'read');
  assert.equal(operationPermission(resolveGatewayPolicy(), 'build.read').confirmation, 'none');
  const unconfigured = await buildRead({ root, env, context: { repositoryId: 'checkout' } });
  assert.deepEqual([unconfigured.data.gap, unconfigured.warnings[0].slots.field], ['build-provider-not-configured', 'build-provider-not-configured']);
  await writeFile(buildProviderFile(env), JSON.stringify({ repositories: { checkout: { kind: 'github-actions', remote: 'https://git.example.test/acme/checkout.git' } } }));
  const read = await buildRead({ root, env, context: { repositoryId: 'checkout' }, runs: async () => [run8398(commits[2]), run8398(commits[0], 'success', 8391)] });
  assert.deepEqual(read.data.builds.map((build) => build.relation), ['built-from', 'does-not-contain']);
  assert.ok(Object.values(read.effects).every((value) => value === false));
});
