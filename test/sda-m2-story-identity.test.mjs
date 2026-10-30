/**
 * SDA M2, stable identities (docs/SPEC-SDA-STORAGE-INDEPENDENT-WORKFLOW-v1.md §5): a Story is its
 * Work ID, its branch a recorded binding; a repository is its remote or its own local ID, never a
 * path; a saved push names its repository and resolves its checkout on this computer.
 *
 * - Discovery lists a Story whose recorded branch differs from its ledger location, with a binding
 *   finding, instead of calling it unavailable; any other ownership failure still refuses.
 * - The Story index finds a Story by a branch only through an alias its entry records.
 * - A repository without a remote gets one random ID at registration; `gitdir:` entries still match.
 * - A push whose checkout moved runs in another indexed checkout of the same repository.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { appendLedgerIntent, createLedgerIntent, initializeLedger } from '../src/ledger.mjs';
import { localRepositoryId, localRepositoryIdFile } from '../src/repository-local-id.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { discoverRemoteStoryCandidates } from '../src/session-story-discovery.mjs';
import { discoverRemoteStoryCandidatesByUrl } from '../src/session-remote-url-discovery.mjs';
import { lookupStoryCheckouts, readStoryIndex, repositoryKey } from '../src/story-index.mjs';
import {
  createTransportIntent, resolveTransportCheckout, retryTransportIntent, transportCheckoutMissing,
  transportOperationDigest, transportRetryAction
} from '../src/transport-intents.mjs';
import { removeTemporaryTree } from '../src/util.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const canonical = (file) => realpathSync.native(file);

function git(root, args) {
  const child = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: childTimeout(15_000) });
  assert.equal(child.status, 0, `${args.join(' ')}\n${child.stderr || child.error}`);
  return child.stdout.trim();
}

async function scratch(t, prefix) {
  const base = canonical(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => removeTemporaryTree(base));
  return base;
}

function storyState(id, branch, phases = null) {
  const order = phases ?? [{ id: 'intake', label: 'Intake' }];
  return {
    schemaVersion: 11, workItem: { id, title: `Identity ${id}`, branch, createdAt: '2026-10-01T08:30:00Z' },
    lineage: { canonicalBranch: branch }, status: 'in_progress',
    currentPhase: order[0].id, phaseOrder: order.map((phase) => phase.id),
    phases: Object.fromEntries(order.map((phase) => [phase.id, {
      id: phase.id, label: phase.label, status: 'in_progress', generation: 0, artifacts: [], checks: []
    }])), resolution: { phases: order }, history: []
  };
}

async function writeIndex(env, entries) {
  await writeFile(env.SINGULARITY_FLOW_STORY_INDEX, `${JSON.stringify({
    schemaVersion: currentSchemaVersion('story-index'), kind: 'story-index', updatedAt: null, backfill: null, entries
  }, null, 2)}\n`);
}

function indexEntry({ workId, checkoutPath, commonDir, branch, key, aliases }) {
  return {
    workId, checkoutPath, commonDir, branch, workflowPath: `singularity/work-items/${workId}/workflow.json`,
    repository: { key, url: null, id: 'app' }, workspace: { id: 'ws', name: 'ws', path: path.dirname(checkoutPath) },
    ...(aliases ? { aliases } : {})
  };
}

test('discovery lists a Story by its Work ID where the ledger found it, with a branch binding finding', async (t) => {
  const base = await scratch(t, 'sflow-binding-');
  const remote = path.join(base, 'remote.git');
  const seed = path.join(base, 'seed');
  const client = path.join(base, 'client');
  git(base, ['init', '--bare', remote]);
  git(base, ['init', '-b', 'main', seed]);
  git(seed, ['config', 'user.name', 'Binding Fixture']);
  git(seed, ['config', 'user.email', 'binding@example.invalid']);
  await initializeDefinition(seed);
  const definition = await loadDefinition(seed);
  definition.ledger.enabled = true;
  await writeFile(path.join(seed, 'singularity/workflow.yml'), YAML.stringify(definition));
  git(seed, ['add', '.']);
  git(seed, ['commit', '-m', 'retain configured workflow']);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-u', 'origin', 'main']);
  git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(remote, ['config', 'uploadpack.allowFilter', 'true']);
  const ledger = { ...definition.ledger, enabled: true, pinTransport: 'none' };
  await initializeLedger(seed, ledger);
  const phases = resolveWorkType(definition, 'feature').phases;
  // BIND-1 records branch BIND-1, but its state was published on team/bind-1. BIND-2's ledger
  // entry claims a directory whose record names another Work ID: that is not this Story.
  const publish = async (ledgerId, branch, state) => {
    git(seed, ['switch', '-c', branch, 'main']);
    const file = path.join(seed, definition.workItemRoot, ledgerId, 'workflow.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(state)}\n`);
    git(seed, ['add', definition.workItemRoot]);
    git(seed, ['commit', '-m', `retain ${ledgerId}`]);
    git(seed, ['push', 'origin', branch]);
    await appendLedgerIntent(seed, ledger, createLedgerIntent({ eventType: 'binding', capabilityId: 'identity',
      subject: { kind: 'story', workId: ledgerId, branch },
      actor: { name: 'Binding Fixture', email: 'binding@example.invalid' }
    }), git(seed, ['rev-parse', 'HEAD']));
  };
  await publish('BIND-1', 'team/bind-1', storyState('BIND-1', 'BIND-1', phases));
  await publish('BIND-2', 'BIND-2', storyState('OTHER-9', 'BIND-2', phases));
  await publish('BIND-3', 'BIND-3', storyState('BIND-3', 'BIND-3', phases));
  git(base, ['clone', '--no-hardlinks', remote, client]);

  const check = (discovered, label) => {
    const byId = new Map(discovered.items.map((item) => [item.id, item]));
    assert.deepEqual(byId.get('BIND-1')?.bindingFinding,
      { code: 'STORY_BRANCH_BINDING_MISMATCH', recordedBranch: 'BIND-1', ledgerBranch: 'team/bind-1' }, label);
    assert.equal(byId.get('BIND-1').branch, 'team/bind-1', `${label}: listed where its state is`);
    assert.equal(byId.get('BIND-3')?.bindingFinding, undefined, `${label}: a matching binding has no finding`);
    assert.equal(byId.has('BIND-2'), false, label);
    assert.ok(discovered.unavailable.some((entry) => entry.claimedId === 'BIND-2' && entry.code === 'SESSION_STORY_INVALID'),
      `${label}: a Work ID mismatch is still refused`);
    assert.ok(!discovered.unavailable.some((entry) => entry.claimedId === 'BIND-1'), label);
  };
  check(await discoverRemoteStoryCandidates(client, definition, { fetch: false }), 'materialized');
  // The proven-summary cache keeps no row that would list BIND-1 without its finding.
  const cache = JSON.parse(await readFile(path.join(client, '.git', 'singularity-flow', 'story-summaries.json'), 'utf8'));
  assert.ok(cache.items.some((row) => row.id === 'BIND-3'));
  assert.ok(!cache.items.some((row) => row.id === 'BIND-1'));
  check(await discoverRemoteStoryCandidates(client, definition, { fetch: false }), 'second listing');
  check(await discoverRemoteStoryCandidatesByUrl(remote, { approvedDefinition: definition }), 'by URL');
});

test('the Story index finds a branch only through an alias its entry records, and keys a remote-less repository by its own ID', async (t) => {
  const base = await scratch(t, 'sflow-index-identity-');
  const env = { ...process.env, SINGULARITY_FLOW_STORY_INDEX: path.join(base, 'story-index.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json') };
  const checkout = path.join(base, 'app');
  git(base, ['init', '-b', 'feature/s5', checkout]);
  const file = path.join(checkout, 'singularity', 'work-items', 'S-5', 'workflow.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(storyState('S-5', 'feature/s5'))}\n`);
  const commonDir = canonical(path.join(checkout, '.git'));

  // Leak 5: no ID until registration; then one, created once and kept.
  assert.equal(localRepositoryId(commonDir), null);
  assert.equal(await repositoryKey(null, commonDir), `gitdir:${commonDir}`, 'before registration the legacy key stands');
  const key = await repositoryKey(null, commonDir, { create: true });
  assert.match(key, /^repo:[a-f0-9]{32}$/u);
  assert.equal(await repositoryKey(null, commonDir, { create: true }), key);
  assert.equal(await repositoryKey(null, commonDir), key);
  if (process.platform !== 'win32') {
    assert.equal(statSync(localRepositoryIdFile(commonDir)).mode & 0o777, 0o600);
  }

  // Leak 2 with a legacy `gitdir:` entry: the recorded aliases do not yet name the branch.
  await writeIndex(env, [indexEntry({ workId: 'S-5', checkoutPath: canonical(checkout), commonDir, branch: 'feature/s5',
    key: `gitdir:${commonDir}`, aliases: ['S-5'] })]);
  assert.deepEqual((await lookupStoryCheckouts('feature/s5', { env, backfill: false })).valid, [],
    'a branch the entry does not record as an alias is not inferred from its branch field');
  const byId = await lookupStoryCheckouts('S-5', { env, backfill: false, repositoryKey: key });
  assert.equal(byId.valid.length, 1, 'the legacy gitdir: entry still matches the same repository under its ID');
  assert.equal(byId.valid[0].repository.key, key, 'a verified legacy entry carries the repository ID');
  const stored = (await readStoryIndex({ env })).entries[0];
  assert.equal(stored.repository.key, key, 'and the index is rewritten with it');
  assert.ok(stored.aliases.includes('feature/s5'), 'verification records the Story\'s own branches as aliases');
  assert.equal((await lookupStoryCheckouts('feature/s5', { env, backfill: false })).valid.length, 1,
    'a recorded branch alias finds the Story');

  // An entry from before aliases were recorded keeps its branch as its only alias.
  await writeIndex(env, [indexEntry({ workId: 'S-5', checkoutPath: canonical(checkout), commonDir, branch: 'feature/s5', key })]);
  assert.equal((await lookupStoryCheckouts('feature/s5', { env, backfill: false })).valid.length, 1);
  assert.equal((await lookupStoryCheckouts('S-5', { env, backfill: false, repositoryKey: 'repo:0123' })).valid.length, 0,
    'another repository\'s key does not match');
});

test('concurrent creators of a repository ID converge on the first one written', async (t) => {
  const base = await scratch(t, 'sflow-repository-id-');
  const commonDir = path.join(base, 'repo.git');
  git(base, ['init', '--bare', commonDir]);
  const module = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'repository-local-id.mjs');
  const script = `const { localRepositoryId } = await import(${JSON.stringify(pathToFileURL(module).href)});`
    + `process.stdout.write(String(localRepositoryId(${JSON.stringify(commonDir)}, { create: true })));`;
  const ids = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(out));
  })));
  assert.match(ids[0], /^[a-f0-9]{32}$/u);
  assert.deepEqual(new Set(ids), new Set([ids[0]]));
  assert.equal(localRepositoryId(commonDir), ids[0]);
});

async function transportFixture(t) {
  const base = await scratch(t, 'sflow-transport-identity-');
  const bare = path.join(base, 'remote.git');
  const work = path.join(base, 'work');
  git(base, ['init', '-q', '--bare', bare]);
  git(base, ['init', '-q', '-b', 'main', work]);
  git(work, ['config', 'user.name', 'Transport Identity']);
  git(work, ['config', 'user.email', 'transport@example.invalid']);
  await writeFile(path.join(work, 'README.md'), 'first\n');
  git(work, ['add', 'README.md']);
  git(work, ['commit', '-qm', 'first']);
  git(work, ['remote', 'add', 'origin', bare]);
  const env = { ...process.env, SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(base, 'outbox'),
    SINGULARITY_FLOW_STORY_INDEX: path.join(base, 'story-index.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json') };
  return { base, bare, work, env, options: { env, home: base } };
}

test('a saved push names its repository, and runs in another indexed checkout of it once its own is gone', async (t) => {
  const item = await transportFixture(t);
  const story = path.join(item.base, 'story-worktree');
  git(item.work, ['worktree', 'add', '-q', '-b', 'S-7', story, 'main']);
  await writeFile(path.join(story, 'value.txt'), 'story\n');
  git(story, ['add', 'value.txt']);
  git(story, ['commit', '-qm', 'story change']);
  const commit = git(story, ['rev-parse', 'HEAD']);
  const intent = await createTransportIntent({ repositoryRoot: story, sourceCommit: commit,
    targetRef: 'refs/heads/S-7', expectedRemote: null, scope: { requiredLocalRef: 'refs/heads/S-7' } }, item.options);
  assert.equal(intent.repositoryRoot, canonical(story));
  assert.match(intent.repository.key, /^local:/u);
  assert.equal(intent.repository.id, intent.repository.key);
  assert.equal(intent.operation.payloadDigest, transportOperationDigest(intent), 'the operation digest is unchanged');
  assert.equal(await resolveTransportCheckout(intent, item.options), intent.repositoryRoot);

  // The Story's worktree is removed; the clone it came from is in the index under the same repository.
  const commonDir = canonical(path.join(item.work, '.git'));
  await writeIndex(item.env, [
    indexEntry({ workId: 'S-6', checkoutPath: path.join(item.base, 'gone'), commonDir, branch: 'S-6', key: intent.repository.key }),
    indexEntry({ workId: 'S-8', checkoutPath: canonical(item.work), commonDir, branch: 'main', key: intent.repository.key })
  ]);
  git(item.work, ['worktree', 'remove', '--force', story]);
  assert.equal(existsSync(story), false);
  assert.equal(transportCheckoutMissing(intent, item.options), false);
  // Reports call it with the process environment.
  const before = process.env.SINGULARITY_FLOW_STORY_INDEX;
  process.env.SINGULARITY_FLOW_STORY_INDEX = item.env.SINGULARITY_FLOW_STORY_INDEX;
  try { assert.ok(transportRetryAction(intent), 'the retry is still offered'); }
  finally { if (before == null) delete process.env.SINGULARITY_FLOW_STORY_INDEX; else process.env.SINGULARITY_FLOW_STORY_INDEX = before; }
  assert.equal(await resolveTransportCheckout(intent, item.options), canonical(item.work));
  // A push saved before repository identities resolves only to its recorded path, as before.
  const legacy = { ...intent };
  delete legacy.repository;
  assert.equal(await resolveTransportCheckout(legacy, item.options), null);
  assert.equal(transportCheckoutMissing(legacy, item.options), true);

  const result = await retryTransportIntent(intent.intentId, item.options);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.repositoryRoot, canonical(item.work), 'the local binding follows where the repository resolved');
  assert.equal(result.repositoryRootFingerprint, intent.repositoryRootFingerprint);
  assert.equal(result.operation.payloadDigest, transportOperationDigest(result), 'the operation digest still verifies');
  assert.equal(git(item.bare, ['rev-parse', 'refs/heads/S-7']), commit);
});

test('a saved push whose repository has no checkout left still refuses as missing', async (t) => {
  const item = await transportFixture(t);
  const other = await transportFixture(t);
  const story = path.join(item.base, 'story-worktree');
  git(item.work, ['worktree', 'add', '-q', '-b', 'S-9', story, 'main']);
  const commit = git(story, ['rev-parse', 'HEAD']);
  const intent = await createTransportIntent({ repositoryRoot: story, sourceCommit: commit,
    targetRef: 'refs/heads/S-9', expectedRemote: null }, item.options);
  // A clone of the same remote that lacks the commit, and a checkout of another repository.
  const stranger = path.join(item.base, 'stranger');
  git(item.base, ['init', '-q', '-b', 'main', stranger]);
  git(stranger, ['remote', 'add', 'origin', item.bare]);
  await writeIndex(item.env, [
    indexEntry({ workId: 'S-10', checkoutPath: canonical(stranger), commonDir: canonical(path.join(stranger, '.git')),
      branch: 'main', key: intent.repository.key }),
    indexEntry({ workId: 'S-11', checkoutPath: canonical(other.work), commonDir: canonical(path.join(other.work, '.git')),
      branch: 'main', key: `local:${other.bare}` })
  ]);
  git(item.work, ['worktree', 'remove', '--force', story]);
  assert.equal(await resolveTransportCheckout(intent, item.options), null);
  await assert.rejects(retryTransportIntent(intent.intentId, item.options), { code: 'TRANSPORT_REPOSITORY_MISSING' });
});

test('a push to a remote with no comparable identity names its repository by the local repository ID', async (t) => {
  const item = await transportFixture(t);
  git(item.work, ['remote', 'set-url', 'origin', '../remote.git']);
  const commit = git(item.work, ['rev-parse', 'HEAD']);
  const intent = await createTransportIntent({ repositoryRoot: item.work, sourceCommit: commit,
    targetRef: 'refs/heads/relative', expectedRemote: null }, item.options);
  const id = localRepositoryId(canonical(path.join(item.work, '.git')));
  assert.match(id, /^[a-f0-9]{32}$/u);
  assert.deepEqual(intent.repository, { id, key: `repo:${id}` });
  assert.equal(await resolveTransportCheckout(intent, item.options), intent.repositoryRoot);
});
