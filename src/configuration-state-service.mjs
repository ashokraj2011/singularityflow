/** Database-like configuration boundary: indexed projections plus SGOS-journalled recovery. */
import path from 'node:path';
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import initSql from 'sql.js/dist/sql-asm.js';
import { gitCommonDir } from './git.mjs';
import { remoteFingerprint } from './git-remote-diagnostics.mjs';
import { createConfigurationOperationalStore } from './sgos/operational-store.mjs';
import { configurationDigest, configurationProposalId, configurationProposalKey,
  CONFIGURATION_OID, validateConfigurationTransaction } from './configuration-state-contract.mjs';
import { writeAtomic, SingularityFlowError } from './util.mjs';
import { runningBuildIdentity } from './build-identity.mjs';

let sql;
const MAX_BYTES = 8 * 1024 * 1024;
const PROJECTION_VERSION = 1;
const fail = (message, code = 'CONFIGURATION_STATE_INVALID') => { throw new SingularityFlowError(message, { code }); };
async function directory(parent, name) {
  const target = path.join(parent, name);
  try { await mkdir(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail('Unsafe configuration service directory.');
  return target;
}
async function bytes(file) {
  try {
    const metadata = await lstat(file);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_BYTES) return null;
    return await readFile(file);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const recoveryStates = new Set(['prepared', 'outcome-unknown', 'activation-pending', 'committed', 'sync-pending', 'synced', 'superseded']);

/** Inspect retained operations without requiring a live remote or treating local rows as authority. */
export async function readConfigurationTransactionJournals(root) {
  let local = gitCommonDir(root);
  for (const name of ['singularity-flow', 'configuration-service']) {
    local = path.join(local, name);
    let metadata;
    try { metadata = await lstat(local); } catch (error) { if (error.code === 'ENOENT') return { authorityEligible: false, authorities: [], transactions: [] }; throw error; }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail('Unsafe configuration journal directory.');
  }
  const names = (await readdir(local)).filter(name => /^[a-f0-9]{64}$/u.test(name)).sort();
  if (names.length > 100) fail('Configuration journals exceed the bounded authority inventory.');
  const authorities = [], transactions = [];
  let totalBytes = 0;
  for (const fingerprint of names) {
    const scope = path.join(local, fingerprint);
    const metadata = await lstat(scope);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail('Unsafe configuration journal authority directory.');
    const store = createConfigurationOperationalStore({ root: scope, storeId: 'transactions' });
    const head = await store.read();
    totalBytes += Buffer.byteLength(JSON.stringify(head.entries));
    if (totalBytes > MAX_BYTES || transactions.length + Object.keys(head.entries).length > 2_000) fail('Configuration journals exceed the bounded local result budget.');
    authorities.push({ fingerprint, revision: head.revision });
    transactions.push(...Object.values(head.entries).map(entry => ({ ...entry, authorityFingerprint: fingerprint })));
  }
  return { authorityEligible: false, authorities, transactions };
}

export async function openConfigurationStateService(root, remote) {
  const fingerprint = remoteFingerprint(remote);
  const parent = await directory(gitCommonDir(root), 'singularity-flow');
  const serviceRoot = await directory(parent, 'configuration-service');
  const local = await directory(serviceRoot, fingerprint);
  const store = createConfigurationOperationalStore({ root: local, storeId: 'transactions' });
  const cacheFile = path.join(local, 'read-model.sqlite');
  const identity = branch => configurationProposalId(fingerprint, configurationProposalKey(branch));
  async function transact(update) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const head = await store.read();
      const change = update(head.entries);
      if (!change) return null;
      try {
        return await store.transact({ expectedRevision: head.revision, expectedStateSha256: head.stateSha256, changes: [change] });
      } catch (error) { if (error.code !== 'SGOS_OPERATIONAL_CAS_MISMATCH') throw error; }
    }
    fail('Configuration recovery state is busy. Retry against its current revision.', 'CONFIGURATION_STATE_BUSY');
  }
  return Object.freeze({
    identity,
    /** A fresh remote advertisement must match every indexed row; no mutation consumes this cache. */
    async cachedProposals(authorityCommit, branches) {
      if (!CONFIGURATION_OID.test(authorityCommit ?? '')) return null;
      let db;
      try {
        const data = await bytes(cacheFile);
        if (!data) return null;
        sql ??= initSql();
        const SQL = await sql;
        db = new SQL.Database(data);
        const metadata = db.exec('SELECT authority_commit, build_identity, projection_version FROM snapshot');
        const snapshot = metadata[0]?.values;
        if (snapshot?.length !== 1 || snapshot[0][0] !== authorityCommit
            || snapshot[0][1] !== runningBuildIdentity() || snapshot[0][2] !== PROJECTION_VERSION) return null;
        const statement = db.prepare('SELECT packet, digest FROM proposal_revisions WHERE branch = ? AND revision = ?');
        const records = [];
        try {
          for (const branch of branches) {
            statement.bind([branch.branch, branch.proposalCommit]);
            if (!statement.step()) return null;
            const [packet, digest] = statement.get();
            const record = JSON.parse(packet);
            if (configurationDigest(record) !== digest || record.branch !== branch.branch
                || record.proposalCommit !== branch.proposalCommit || record.targetCommit !== authorityCommit
                || record.proposalId !== identity(branch.branch)) return null;
            records.push(record);
            statement.reset();
          }
        } finally { statement.free(); }
        return records;
      } catch { return null; } finally { db?.close(); }
    },
    async projectProposals(authorityCommit, proposals) {
      if (!CONFIGURATION_OID.test(authorityCommit ?? '') || !Array.isArray(proposals) || proposals.length > 100) fail('Invalid configuration projection.');
      const records = proposals.map(record => ({ ...record, proposalId: identity(record.branch), proposalRevision: record.proposalCommit,
        entityStatus: record.merged ? 'activated' : record.valid ? 'awaiting-review' : 'unreadable' }));
      if (Buffer.byteLength(JSON.stringify(records)) > MAX_BYTES / 2) fail('Configuration projection exceeds its bounded budget.');
      sql ??= initSql();
      const SQL = await sql;
      const db = new SQL.Database();
      try {
        db.run('PRAGMA foreign_keys = ON; CREATE TABLE snapshot (authority_commit TEXT NOT NULL, build_identity TEXT NOT NULL, projection_version INTEGER NOT NULL); CREATE TABLE proposal_entities (entity_id TEXT PRIMARY KEY); CREATE TABLE proposal_revisions (branch TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES proposal_entities(entity_id), revision TEXT NOT NULL, status TEXT NOT NULL, packet TEXT NOT NULL, digest TEXT NOT NULL); CREATE INDEX proposals_by_entity ON proposal_revisions(entity_id, status); BEGIN TRANSACTION;');
        db.run('INSERT INTO snapshot VALUES (?, ?, ?)', [authorityCommit, runningBuildIdentity(), PROJECTION_VERSION]);
        for (const record of records) {
          db.run('INSERT OR IGNORE INTO proposal_entities VALUES (?)', [record.proposalId]);
          db.run('INSERT INTO proposal_revisions VALUES (?, ?, ?, ?, ?, ?)',
            [record.branch, record.proposalId, record.proposalCommit, record.entityStatus, JSON.stringify(record), configurationDigest(record)]);
        }
        db.run('COMMIT');
        const data = Buffer.from(db.export());
        if (data.length > MAX_BYTES) fail('Configuration projection exceeds its bounded budget.');
        await writeAtomic(cacheFile, data, { mode: 0o600 });
      } finally { db.close(); }
      return records;
    },
    /** Immutable identity + exact remote candidate. Never records approval or successful transport. */
    async prepare(transaction, targetCommit) {
      validateConfigurationTransaction(transaction);
      if (transaction.proposalId !== identity(transaction.branch) || !CONFIGURATION_OID.test(targetCommit ?? '')) fail('Invalid transaction authority scope.');
      await transact(entries => {
        const existing = entries[transaction.id];
        if (existing) {
          if (existing.transaction.digest !== transaction.digest || existing.targetCommit !== targetCommit) fail('Recovery transaction identity collision.');
          return null;
        }
        return { op: 'put', key: transaction.id, value: { transaction, targetCommit, state: 'prepared', reason: null } };
      });
      return (await store.read()).entries[transaction.id];
    },
    async mark(id, state, reason = null) {
      if (!recoveryStates.has(state) || (reason !== null && (typeof reason !== 'string' || reason.length > 256))) fail('Invalid configuration recovery outcome.');
      await transact(entries => {
        const current = entries[id];
        if (!current) fail('Configuration transaction is not retained.', 'CONFIGURATION_TRANSACTION_UNKNOWN');
        // A later local observer cannot undo a confirmed remote commit with an older failure.
        if (['synced', 'superseded'].includes(current.state) || (['committed', 'sync-pending'].includes(current.state)
            && ['prepared', 'outcome-unknown', 'activation-pending', 'superseded'].includes(state))) return null;
        if (current.state === state && current.reason === reason) return null;
        return { op: 'put', key: id, value: { ...current, state, reason } };
      });
      return (await store.read()).entries[id];
    },
    async transactions() {
      const head = await store.read();
      return { revision: head.revision, authorityEligible: false, transactions: Object.values(head.entries) };
    }
  });
}
