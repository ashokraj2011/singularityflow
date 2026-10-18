import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSessionListingFixture } from '../scripts/session-listing-benchmark.mjs';
import { appendLedgerIntent, createLedgerIntent } from '../src/ledger.mjs';
import { approvalInbox } from '../src/inbox.mjs';
import { stateStorySubjectIndex } from '../src/session-story-discovery.mjs';
import { resolveContext } from '../src/repository-subject-index.mjs';
import { localStorySubjectIndex } from '../src/local-story-subject-index.mjs';
import { storyLifecycleProgress } from '../src/session-roster.mjs';
import { repositorySnapshot } from '../src/editor.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';
import { hasLocalGovernanceAuthority } from '../src/cli-entry.mjs';
import { run } from '../src/util.mjs';

async function fixture(t) {
  const f = await createSessionListingFixture(); t.after(f.cleanup);
  const id = 'REVIEW-1', branch = 'team/custom-review';
  const state = { schemaVersion: 11, workItem: { id, title: 'Indexed review', branch, workType: 'feature',
    createdAt: '2026-10-18T00:00:00Z' }, lineage: { canonicalBranch: branch, aliases: ['external-review'] },
    status: 'in_progress', currentPhase: 'specification', phaseOrder: ['specification'],
    phases: { specification: { id: 'specification', label: 'Specification', status: 'awaiting_approval',
      generation: 1, artifacts: [], checks: [], approvals: [], approvalPolicy: { minimum: 1, authorities: ['quality-reviewers'] },
      submittedAt: '2026-10-18T00:00:00Z', requiredArtifact: { path: 'spec.md' } } },
    resolution: { phases: [{ id: 'specification', label: 'Specification' }] }, history: [] };
  f.git(f.source, 'switch', '--quiet', '-c', branch, 'main');
  const file = path.join(f.source, f.definition.workItemRoot, id, 'workflow.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state));
  f.git(f.source, 'add', '.'); f.git(f.source, 'commit', '--quiet', '-m', 'retain review');
  f.git(f.source, 'push', '--quiet', 'origin', branch);
  const commit = f.git(f.source, 'rev-parse', 'HEAD');
  await appendLedgerIntent(f.source, { ...f.definition.ledger, pinTransport: 'none' }, createLedgerIntent({
    eventType: 'binding', capabilityId: 'fixture', actor: { name: 'Fixture', email: 'fixture@example.invalid' },
    subject: { kind: 'story', workId: id, branch, workType: 'feature', title: state.workItem.title, status: state.status,
      currentPhase: state.currentPhase, aliases: ['external-review'], progress: storyLifecycleProgress(state) }
  }), commit);
  return { ...f, id, branch, commit, state };
}

test('unpublished managed drafts resolve locally without admitting inherited or unrelated branch metadata', async t => {
  const f = await fixture(t);
  const checkout = path.join(f.original, '.singularity-flow/story-worktrees/local-draft');
  const draftBranch = 'team/local-draft';
  f.git(f.original, 'worktree', 'add', '--quiet', '-b', draftBranch, checkout, 'HEAD');
  const draft = { ...f.state, workItem: { ...f.state.workItem, id: 'LOCAL-DRAFT', branch: draftBranch },
    lineage: { canonicalBranch: draftBranch, sourceStableId: 'framework:local-draft' } };
  for (const state of [f.state, draft]) {
    const file = path.join(checkout, f.definition.workItemRoot, state.workItem.id, 'workflow.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(state));
  }
  f.git(checkout, 'add', '.');
  f.git(checkout, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'local draft');
  const index = await localStorySubjectIndex(f.original, { definition: f.definition });
  const resolved = resolveContext(index, { reference: 'framework:local-draft', kind: 'story' });
  assert.equal(resolved.id, 'LOCAL-DRAFT');
  assert.equal(resolved.source, 'managed-worktree');
  assert.equal(resolved.canonicalBranch, draftBranch);
  assert.equal(resolveContext(index, { reference: f.id, required: false }), null,
    'inherited published metadata is not a local draft owned by this checkout');
  const snapshot = await repositorySnapshot(f.original, null, null, { included: ['lifecycle'] });
  assert.equal(snapshot.lifecycle.workItems.some(item => item.id === 'LOCAL-DRAFT'), false);
});

test('approval inbox, legacy subject lookup and snapshots discover only state-indexed Stories', async t => {
  const f = await fixture(t);
  const inbox = await approvalInbox(f.original, f.definition);
  assert.equal(inbox.unavailableCount, 0, JSON.stringify(inbox));
  assert.deepEqual(inbox.items.map(row => [row.id, row.commit, row.approvalsRemaining]), [[f.id, f.commit, 1]]);
  assert.equal(inbox.source, 'state-ledger');
  assert.equal(inbox.stateRef, 'refs/remotes/origin/state', 'metadata recovery retains the state authority');
  const index = await stateStorySubjectIndex(f.original, f.definition, { fetch: true });
  const resolved = resolveContext(index, { reference: 'external-review', kind: 'story' });
  assert.equal(resolved.canonicalBranch, f.branch);
  assert.equal(resolved.location.commit, f.commit);
  assert.equal(resolved.state.currentPhase, 'specification');
  const before = await repositorySnapshot(f.original, null, null, { included: ['lifecycle'] });
  assert.deepEqual(before.lifecycle.workItems.map(row => row.id), [f.id]);
  assert.equal(before.lifecycle.workItems[0].workType, 'feature', 'state projections retain useful catalog metadata');
  assert.equal(before.lifecycle.storyDiscovery.complete, true);
  const measure = async () => {
    const timer = commandTimer('inbox', { commandClass: 'read' });
    const result = await withCommandTiming(timer, () => approvalInbox(f.original, f.definition,
      { now: new Date('2026-10-18T01:00:00Z') }));
    return { result, spawns: timer.finish().counters['git.spawns'] };
  };
  const small = await measure();
  // Hundreds of known refs must change neither the Story roster nor its Git process count.
  const oid = f.git(f.original, 'rev-parse', 'HEAD');
  for (const root of [f.original, f.remote]) run('git', ['update-ref', '--stdin'], { cwd: root,
    input: Array.from({ length: 300 }, (_, i) => `create refs/heads/unrelated-${i} ${oid}\n`).join('') });
  const large = await measure();
  assert.deepEqual(large.result.items, small.result.items);
  assert.ok(large.spawns <= small.spawns, `unrelated refs increased Git spawns: ${small.spawns} -> ${large.spawns}`);
  assert.notEqual(run('git', ['show-ref', '--verify', 'refs/remotes/origin/unrelated-299'], {
    cwd: f.original, allowFailure: true
  }).status, 0, 'inbox must not fetch wildcard heads');
  const after = await repositorySnapshot(f.original, null, null, { included: ['lifecycle'] });
  assert.deepEqual(after.lifecycle.workItems, before.lifecycle.workItems);
});

test('Goal Story lookup reads approved configuration from state-only application checkouts', async t => {
  const f = await fixture(t);
  f.git(f.original, 'fetch', '--quiet', 'origin', `refs/heads/${f.branch}:refs/remotes/origin/${f.branch}`,
    'refs/heads/state:refs/remotes/origin/state');
  f.git(f.original, 'switch', '--quiet', '--orphan', 'application-only');
  await writeFile(path.join(f.original, 'README.md'), '# Application only\n');
  f.git(f.original, 'add', '.');
  f.git(f.original, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'application only');
  const result = await f.invoke({ command: ['goal', 'propose', 'Observe indexed work',
    '--success', 'The linked Story is visible', '--work-id', f.id], selectors: false });
  assert.equal(result.child.status, 0, result.child.stdout + result.child.stderr);
  assert.equal(result.packet.data.proposal.linkedWork[0].id, f.id);
});

test('an absent state index stays an explicit error for inbox and incomplete discovery for snapshots', async t => {
  const f = await createSessionListingFixture(); t.after(f.cleanup);
  f.git(f.remote, 'update-ref', '-d', 'refs/heads/state');
  await assert.rejects(approvalInbox(f.original, f.definition), { code: 'SESSION_STATE_INDEX_UNAVAILABLE' });
  const snapshot = await repositorySnapshot(f.original, null, null, { included: ['lifecycle'] });
  assert.equal(snapshot.lifecycle.storyDiscovery.complete, false);
  assert.equal(snapshot.lifecycle.storyDiscovery.unavailable.length, 1);
  assert.deepEqual(snapshot.lifecycle.workItems, []);
});

test('CLI routing never searches sibling branches for governance', async t => {
  const f = await createSessionListingFixture(); t.after(f.cleanup);
  // A repository with no checked-out governance must not be classified by an unrelated sibling.
  f.git(f.original, 'switch', '--quiet', '--orphan', 'plain');
  await writeFile(path.join(f.original, 'README.md'), '# Plain checkout\n');
  f.git(f.original, 'add', '.');
  f.git(f.original, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'plain');
  f.git(f.original, 'update-ref', '-d', 'refs/remotes/origin/sflow/config');
  assert.equal(hasLocalGovernanceAuthority(f.original), false);
});

test('Story listing adapters do not regress to wildcard fetches, branch inventories or history walks', async () => {
  for (const relative of ['src/inbox.mjs', 'src/session-story-discovery.mjs', 'src/session-remote-url-discovery.mjs',
    'src/commands/shared/start-context.mjs', 'src/commands/start.mjs', 'src/local-story-subject-index.mjs',
    'apps/vscode/src/story-discovery.ts']) {
    const source = await readFile(new URL('../' + relative, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\b(?:localBranches|remoteBranches)\s*\(|['"](?:rev-list|log|--all)['"]/u, relative);
  }
  const editor = await readFile(new URL('../src/editor.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(editor, /\b(?:localBranches|remoteBranches|buildRepositorySubjectIndexFromRefs)\s*\(/u);
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  assert.match(extension, /workspaceStatus = storyListingWorkspaceStatus\(current, status\)/u);
  assert.match(extension, /\['--workspace', current.workspacePath, '--repository', entry.id\]/u);
});
