import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, realpath, rename } from 'node:fs/promises';
import { createSessionListingFixture } from '../scripts/session-listing-benchmark.mjs';
import { appendLedgerIntent, createLedgerIntent, ledgerStoryPointers } from '../src/ledger.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';
import { readSessionStateIndex } from '../src/session-state-index.mjs';
import { prepareWorkspaceBranch } from '../src/workspace-branch-checkout.mjs';
import { readWorkspace } from '../src/workspace-manifest.mjs';
import { readActiveWorkspaceContext } from '../src/workspace-context.mjs';

async function partialFixture(t) {
  const f = await createSessionListingFixture(); t.after(f.cleanup);
  await appendLedgerIntent(f.source, { ...f.definition.ledger, pinTransport: 'none' }, createLedgerIntent({
    eventType: 'binding', capabilityId: 'fixture', actor: { name: 'Fixture', email: 'fixture@example.invalid' },
    subject: { kind: 'story', workId: 'INDEX-1', branch: 'INDEX-1', title: 'Indexed Story',
      status: 'in_progress', currentPhase: 'specification', progress: { total: 6, approved: 0 } }
  }), f.git(f.source, 'rev-parse', 'HEAD'));
  const partial = path.join(f.directory, 'partial');
  f.git(f.directory, 'clone', '--quiet', '--filter=blob:none', '--no-checkout', '--single-branch',
    '--branch', 'main', pathToFileURL(f.remote).href, partial);
  f.git(partial, 'fetch', '--quiet', '--filter=blob:none', '--no-tags', 'origin',
    'refs/heads/state:refs/remotes/origin/state');
  const commit = f.git(partial, 'rev-parse', 'refs/remotes/origin/state');
  const headBlob = f.git(partial, 'ls-tree', commit, 'ledger/head.json').split(/\s+/u)[2];
  const appBlob = f.git(f.source, 'rev-parse', 'HEAD:src/file-0.txt');
  const present = oid => spawnSync('git', ['cat-file', '-e', oid], {
    cwd: partial, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }, timeout: 5000
  }).status === 0;
  assert.equal(present(headBlob), false, 'fixture must reproduce a present ref with absent blobs');
  return { ...f, partial, commit, headBlob, appBlob, present };
}

test('blobless state listing hydrates only ledger objects once, without history or checkout changes', async t => {
  const f = await partialFixture(t);
  await writeFile(path.join(f.partial, 'private.txt'), 'unpublished bytes');
  const before = { refs: f.git(f.partial, 'show-ref'), head: f.git(f.partial, 'rev-parse', 'HEAD'),
    fetchHead: await readFile(path.join(f.partial, '.git/FETCH_HEAD'), 'utf8') };
  await assert.rejects(ledgerStoryPointers(f.partial, f.definition.ledger, { offline: true }), {
    code: 'SESSION_STATE_INDEX_OBJECTS_UNAVAILABLE'
  });
  const calls = [];
  const read = () => ledgerStoryPointers(f.partial, f.definition.ledger, { runGit: async (args, options) => {
    calls.push(args);
    assert.ok(['ls-remote', 'fetch'].includes(args[0]));
    if (args[0] === 'fetch') {
      assert.ok(args.includes('--no-write-fetch-head'));
      assert.ok(args.slice(args.indexOf('--refmap=') + 2).every(oid => /^[0-9a-f]{40}$/u.test(oid)));
      assert.equal(options.env.GIT_NO_LAZY_FETCH, '1');
    } else assert.deepEqual(args.slice(-1), ['refs/heads/state']);
    const result = await runRemoteGitAsync(args, options);
    assert.equal(result.status, 0, String(result.stderr));
    return result;
  } });
  const first = await read();
  assert.equal(first.commitOid, f.commit);
  assert.deepEqual(first.items.map(item => item.id), ['INDEX-1']);
  assert.equal(f.present(f.headBlob), true);
  assert.equal(f.present(f.appBlob), false, 'no application blobs should be fetched');
  await read();
  assert.deepEqual(calls.map(args => args[0]), ['ls-remote', 'fetch', 'ls-remote']);
  assert.deepEqual(await ledgerStoryPointers(f.partial, f.definition.ledger, { offline: true }), first);
  assert.equal(f.git(f.partial, 'show-ref'), before.refs);
  assert.equal(f.git(f.partial, 'rev-parse', 'HEAD'), before.head);
  assert.equal(await readFile(path.join(f.partial, '.git/FETCH_HEAD'), 'utf8'), before.fetchHead);
  assert.equal(await readFile(path.join(f.partial, 'private.txt'), 'utf8'), 'unpublished bytes');
});

test('missing state blobs retain metadata fetch timeout details without blind retries', async t => {
  const f = await partialFixture(t), calls = [];
  await assert.rejects(ledgerStoryPointers(f.partial, f.definition.ledger, { runGit: async args => {
    calls.push(args[0]);
    if (args[0] === 'ls-remote') return { status: 0, stdout: `${f.commit}\trefs/heads/state\n`, stderr: '' };
    return { status: null, signal: 'SIGTERM', timedOut: true, timeoutMs: 300000, stdout: '', stderr: '' };
  } }), error => {
    assert.equal(error.code, 'SESSION_STATE_REFRESH_UNAVAILABLE');
    assert.equal(error.details.remoteFailure.stage, 'metadata');
    assert.equal(error.details.remoteFailure.timeoutMs, 300000);
    assert.equal(error.details.remoteFailure.evidence.timedOut, true);
    return true;
  });
  assert.deepEqual(calls, ['ls-remote', 'fetch']);
});

test('session candidates recover a blobless workspace index, then composed open reuses the roster', async t => {
  const f = await partialFixture(t);
  await rename(f.original, path.join(f.directory, 'original-preserved'));
  await rename(f.partial, f.original);
  const first = await f.invoke();
  assert.equal(first.child.status, 0, first.child.stdout + first.child.stderr);
  assert.deepEqual(first.packet.items.map(item => item.id), ['INDEX-1']);
  await f.invoke();
  const hit = await f.invoke();
  assert.equal(hit.packet.listingSnapshot.source, 'cache');
  assert.equal(hit.metrics.remoteOperations, 0);
  const opened = await f.invoke({ command: ['session', 'open'] });
  assert.equal(opened.child.status, 0, opened.child.stdout + opened.child.stderr);
  assert.equal(opened.packet.status, 'choose');
  assert.match(opened.packet.table, /INDEX-1/u);
});

test('corrupt and absent ledger metadata is not accepted as an empty roster or repaired by fetching', async t => {
  const f = await createSessionListingFixture(); t.after(f.cleanup);
  const applicationCommit = f.git(f.original, 'rev-parse', 'HEAD');
  let fetched = 0;
  await assert.rejects(readSessionStateIndex(f.original, applicationCommit, { hydrate: async () => fetched++ }), {
    code: 'SESSION_STATE_INDEX_INVALID'
  });
  assert.equal(fetched, 0);
  f.git(f.original, 'fetch', '--quiet', 'origin', 'refs/heads/state:refs/remotes/origin/state');
  f.git(f.original, 'switch', '--quiet', '--detach', 'refs/remotes/origin/state');
  f.git(f.original, 'config', 'user.name', 'Fixture');
  f.git(f.original, 'config', 'user.email', 'fixture@example.invalid');
  const head = JSON.parse(await readFile(path.join(f.original, 'ledger/head.json'), 'utf8'));
  await writeFile(path.join(f.original, 'ledger/head.json'), JSON.stringify({ ...head, sequence: 1, entryHash: 'a'.repeat(64) }));
  f.git(f.original, 'add', 'ledger/head.json');
  f.git(f.original, 'commit', '--quiet', '-m', 'invalid reachable ledger');
  f.git(f.original, 'update-ref', 'refs/remotes/origin/state', 'HEAD');
  await assert.rejects(ledgerStoryPointers(f.original, f.definition.ledger, { offline: true }), {
    code: 'SESSION_STATE_INDEX_INVALID'
  });
});

test('explicit workspace listing uses its verified active branch clone, not the original clone', async t => {
  const f = await createSessionListingFixture(); t.after(f.cleanup);
  const workspace = await readWorkspace(path.join(f.directory, 'workspace'));
  const branch = await prepareWorkspaceBranch(workspace, 'app', 'main', { env: f.env });
  const selectionFile = f.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
  const selected = JSON.parse(await readFile(selectionFile, 'utf8'));
  await writeFile(selectionFile, JSON.stringify({ ...selected, repositoryPath: branch.repositoryPath,
    canonicalRepositoryPath: branch.repositoryPath, checkoutPath: branch.repositoryPath,
    branchCheckout: { branch: 'main' } }));
  const verified = await readActiveWorkspaceContext(selectionFile, f.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY);
  assert.equal(verified.selectionStatus, 'ready');
  assert.equal(verified.canonicalRepositoryPath, await realpath(branch.repositoryPath));
  const first = await f.invoke();
  assert.equal(first.child.status, 0, first.child.stdout + first.child.stderr);
  assert.equal(first.packet.repositoryPath, await realpath(branch.repositoryPath));
  const inbox = await f.invoke({ command: ['inbox'] });
  assert.equal(inbox.child.status, 0, inbox.child.stdout + inbox.child.stderr);
  assert.equal(inbox.packet.repositoryPath, await realpath(branch.repositoryPath), 'approval listing shares the same clone resolver');
  await f.invoke();
  const cached = await f.invoke();
  assert.equal(cached.packet.listingSnapshot.source, 'cache');
  assert.equal(cached.metrics.remoteOperations, 0);
  // A change to the actual reader's Git configuration must invalidate the cached roster.
  f.git(branch.repositoryPath, 'config', 'sflow.session-test', 'changed');
  assert.notEqual((await f.invoke()).packet.listingSnapshot.source, 'cache');
  // Navigation in a different repository must not override an explicit workspace member.
  const active = JSON.parse(await readFile(selectionFile, 'utf8'));
  await writeFile(selectionFile, JSON.stringify({ ...active, repositoryId: 'different-member' }));
  const otherSelection = await f.invoke();
  assert.equal(otherSelection.child.status, 0, otherSelection.child.stdout + otherSelection.child.stderr);
  assert.equal(otherSelection.packet.repositoryPath, await realpath(f.original));
});
