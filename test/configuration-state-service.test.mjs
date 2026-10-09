import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { run } from '../src/util.mjs';
import { remoteFingerprint } from '../src/git-remote-diagnostics.mjs';
import { openConfigurationStateService, readConfigurationTransactionJournals } from '../src/configuration-state-service.mjs';
import { configurationProposalId, configurationProposalKey, createConfigurationTransaction,
  appendConfigurationTransaction, readConfigurationState, emptyConfigurationState } from '../src/configuration-state-contract.mjs';
import { replayConfigurationIntent } from '../src/configuration-intent-replay.mjs';
import initSql from 'sql.js/dist/sql-asm.js';
import { assertConfigurationAssetPathIdentities } from '../src/configuration-state-git.mjs';

const remote = 'https://example.test/team/config.git';
const branch = 'sflow/config-change/workflow/edit-workflow-feature-aaaaaaaa-bbbbbbbbbbbb';
const actor = { name: 'Reviewer', email: 'reviewer@example.test' };
const binding = (id = 'a') => createConfigurationTransaction({
  proposalId: configurationProposalId(remoteFingerprint(remote), configurationProposalKey(branch)),
  proposalRevision: id.repeat(40), branch, baseCommit: 'b'.repeat(40), expectedAuthorityCommit: 'c'.repeat(40), actor,
  changes: [{ path: 'singularity/workflow.yml', beforeSha256: 'd'.repeat(64), afterSha256: 'e'.repeat(64), beforeMode: '100644', afterMode: '100644' }]
});
async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-state-service-test-'));
  run('git', ['init', '-q', '-b', 'main', base]);
  const service = await openConfigurationStateService(base, remote);
  return { base, service, cache: path.join(base, '.git/singularity-flow/configuration-service', remoteFingerprint(remote), 'read-model.sqlite') };
}

test('proposal entity identity is stable across immutable base/content revisions and scoped to authority', () => {
  assert.equal(configurationProposalKey(branch), 'edit-workflow-feature');
  assert.equal(configurationProposalKey('sflow/config-change/workflow/edit-workflow-feature-cccccccc'), 'edit-workflow-feature');
  const id = configurationProposalId(remoteFingerprint(remote), configurationProposalKey(branch));
  assert.equal(id, binding().proposalId);
  assert.notEqual(id, configurationProposalId(remoteFingerprint('https://elsewhere.test/config.git'), configurationProposalKey(branch)));
  assert.throws(() => configurationProposalKey('sflow/config-change/workflow/../outside'), /Invalid/u);
});

test('shared receipts enforce exact bindings, unique revisions and kernel-owned paths', () => {
  const first = binding();
  const state = appendConfigurationTransaction(emptyConfigurationState(), first);
  assert.equal(state.revision, 1);
  assert.deepEqual(appendConfigurationTransaction(state, first), state);
  assert.deepEqual(readConfigurationState(JSON.stringify(state)), state);
  assert.throws(() => readConfigurationState(JSON.stringify({ ...state, revision: 0 })), /lineage/u);
  assert.throws(() => readConfigurationState(JSON.stringify({ ...state, extra: true })), /fields/u);
  assert.throws(() => readConfigurationState(JSON.stringify({ ...state, transactions: [{ ...first, actor: { ...actor, name: 'Forged' } }] })), /digest/u);
  assert.throws(() => createConfigurationTransaction({ ...first, changes: [{ ...first.changes[0], path: 'singularity/configuration-transactions.json' }] }), /transaction asset/u);
  assert.throws(() => createConfigurationTransaction({ ...first, changes: [{ ...first.changes[0], path: 'Singularity/Configuration-Transactions.json' }] }), /transaction asset/u);
  assert.throws(() => createConfigurationTransaction({ ...first, changes: [{ ...first.changes[0], path: null }] }), /transaction asset/u);
  const anotherReviewer = createConfigurationTransaction({ ...first, actor: { name: 'Other reviewer', email: 'other@example.test' } });
  assert.notEqual(anotherReviewer.id, first.id, 'different reviewer commits must not collide in the local journal');
  assert.throws(() => createConfigurationTransaction({ ...first, changes: [first.changes[0], { ...first.changes[0], path: 'singularity/Workflow.yml' }] }), /transaction asset/u);
  assert.throws(() => assertConfigurationAssetPathIdentities(['singularity/workflow.yml', 'singularity/Workflow.yml']), /colliding/u);
  assert.throws(() => assertConfigurationAssetPathIdentities(['../outside']), /unsafe/u);
  assert.doesNotThrow(() => assertConfigurationAssetPathIdentities(['singularity/workflow.yml', 'singularity/portfolio.yml']));
});

test('strict semantic transactions retain unrelated fields and reject genuine concurrent edits', () => {
  assert.deepEqual(replayConfigurationIntent({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 2 }, { conflictPolicy: 'reject' }).value, { a: 2, b: 2 });
  assert.throws(() => replayConfigurationIntent({ a: 1 }, { a: 2 }, { a: 3 }, { conflictPolicy: 'reject' }),
    error => error.code === 'CONFIGURATION_ENTITY_CONFLICT' && error.details.pointers[0] === '/a');
  assert.deepEqual(replayConfigurationIntent({ a: 1 }, {}, { a: 1, keep: false }, { conflictPolicy: 'reject' }).value, { keep: false });
  assert.throws(() => replayConfigurationIntent({ a: 1 }, {}, { a: null }, { conflictPolicy: 'reject' }), /same configuration/u);
  assert.throws(() => replayConfigurationIntent({ workflow: { label: 'Before', phases: ['a'] } },
    { workflow: { label: 'After', phases: ['a'] } }, {}, { conflictPolicy: 'reject' }), /same configuration/u,
  'a removed entity must not be partially resurrected');
});

test('SQLite projection is exact-snapshot bound, disposable and never an authority', async () => {
  const f = await fixture();
  try {
    const row = { branch, proposalCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), valid: true, merged: false, changedFiles: [] };
    const projected = await f.service.projectProposals(row.targetCommit, [row]);
    assert.match((await readFile(f.cache)).subarray(0, 16).toString(), /^SQLite format 3/u);
    assert.deepEqual(await f.service.cachedProposals(row.targetCommit, [row]), projected);
    assert.equal(await f.service.cachedProposals('c'.repeat(40), [row]), null);
    assert.equal(await f.service.cachedProposals(row.targetCommit, [{ ...row, proposalCommit: 'd'.repeat(40) }]), null);
    const SQL = await initSql();
    const previousBuild = new SQL.Database(await readFile(f.cache));
    try {
      previousBuild.run("UPDATE snapshot SET build_identity = 'previous-build'");
      await writeFile(f.cache, previousBuild.export());
    } finally { previousBuild.close(); }
    assert.equal(await f.service.cachedProposals(row.targetCommit, [row]), null, 'another build must re-evaluate its projection');
    await writeFile(f.cache, 'corrupt cache');
    assert.equal(await f.service.cachedProposals(row.targetCommit, [row]), null);
    await f.service.projectProposals(row.targetCommit, [row]);
    assert.deepEqual(await f.service.cachedProposals(row.targetCommit, [row]), projected);
    assert.equal((await f.service.transactions()).authorityEligible, false);
    assert.equal((await f.service.transactions()).transactions.length, 0, 'projecting a proposal never activates it');
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('idempotent journal is CAS-serialized, durable and does not downgrade confirmed effects', async () => {
  const f = await fixture();
  try {
    const a = binding('a'), b = binding('b');
    await Promise.all([f.service.prepare(a, 'd'.repeat(40)), f.service.prepare(a, 'd'.repeat(40)), f.service.prepare(b, 'e'.repeat(40))]);
    const reopened = await openConfigurationStateService(f.base, remote);
    assert.equal((await reopened.transactions()).transactions.length, 2);
    const offline = await readConfigurationTransactionJournals(f.base);
    assert.equal(offline.authorityEligible, false);
    assert.equal(offline.transactions.length, 2, 'no Git remote is even configured in this fixture');
    assert.equal(offline.authorities[0].fingerprint, remoteFingerprint(remote));
    await reopened.mark(a.id, 'committed');
    await f.service.mark(a.id, 'outcome-unknown');
    assert.equal((await f.service.transactions()).transactions.find(row => row.transaction.id === a.id).state, 'committed');
    await f.service.mark(a.id, 'sync-pending');
    await reopened.mark(a.id, 'synced');
    await f.service.mark(a.id, 'activation-pending');
    assert.equal((await f.service.transactions()).transactions.find(row => row.transaction.id === a.id).state, 'synced');
    await assert.rejects(() => reopened.prepare(a, 'f'.repeat(40)), /collision/u);
    await assert.rejects(() => reopened.mark('unknown', 'synced'), error => error.code === 'CONFIGURATION_TRANSACTION_UNKNOWN');
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('a symlinked service directory cannot write outside the Git-common boundary', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-state-link-test-'));
  try {
    const repo = path.join(base, 'repo'), outside = path.join(base, 'outside');
    run('git', ['init', '-q', repo]);
    await mkdir(outside);
    await symlink(outside, path.join(repo, '.git/singularity-flow'), 'dir');
    await assert.rejects(() => openConfigurationStateService(repo, remote), /Unsafe/u);
  } finally { await rm(base, { recursive: true, force: true }); }
});
