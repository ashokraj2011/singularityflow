/** Real SQLite/application fixtures. Synthetic transport faults are separate from native crash tests. */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteNamespaceStore } from '../../src/sda/sqlite-namespace-adapter.mjs';
import { openSqliteNamespaceJournal } from '../../src/sda/sqlite-namespace-journal.mjs';
import { createApplicationNamespaceStore } from '../../src/sda/application-namespace-adapter.mjs';
import { namespaceLimits } from '../../src/sda/namespace/contract.mjs';
import { namespaceError } from '../../src/sda/namespace/values.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export async function createNamespaceSqliteFixture(options = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-namespace-sqlite-'));
  const clock = { value: Date.now() }, handles = [];
  const cleanup = async () => {
    for (const close of handles) close();
    await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  try { return await fixture(parent, clock, handles, options, cleanup); }
  catch (error) { await cleanup(); throw error; }
}

async function fixture(parent, clock, handles, { application = false, binding = { kind: 'shared' }, limits = { maxPage: 2 } }, cleanup) {
  const filename = path.join(parent, `store-${hash(JSON.stringify(binding))}.sqlite`);
  const journal = await openSqliteNamespaceJournal({ filename, binding, limits: namespaceLimits(limits), create: true });
  handles.push(() => journal.close());
  const native = application
    ? createApplicationNamespaceStore({ id: 'application-sqlite-fixture', qualification: 'test-only', binding, limits },
      { journal, now: () => clock.value })
    : await createSqliteNamespaceStore({ filename, binding, limits }, { now: () => clock.value });
  if (native.close) handles.push(() => native.close());
  const faults = new Map(); let loseResponse = false, afterCommit = null;
  const adapter = Object.freeze({ descriptor: native.descriptor,
    ...Object.fromEntries(['read', 'list', 'transact', 'inspectOperation', 'verify'].map(method => [method, async (...args) => {
      const fault = faults.has(method) ? method : method === 'transact' && faults.has('beforeCommit') ? 'beforeCommit' : null;
      if (fault) { const error = faults.get(fault); faults.delete(fault); throw error; }
      const result = await native[method](...args);
      if (method === 'transact') {
        const callback = afterCommit; afterCommit = null; callback?.();
        if (loseResponse) {
          loseResponse = false;
          throw namespaceError('The commit may have completed; inspect this operation.', 'SDA_NAMESPACE_OUTCOME_UNKNOWN',
            { operationId: args[1].operationId, stage: 'acknowledgement', timedOut: true },
            Object.assign(new Error('The commit response timed out.'), { code: 'ETIMEDOUT' }));
        }
      }
      return result;
    }])) });
  return { adapter, filename, journal, cleanup, controls: {
    failNext(method, error) { faults.set(method, error); },
    loseNextCommitResponse() { loseResponse = true; },
    afterNextCommit(callback) { afterCommit = callback; },
    expireSnapshots() { clock.value += 1_800_001; },
    async events(scope) { return [...(await journal.read(scope)).state.events.values()]; },
    async receipts(scope) { return [...(await journal.read(scope)).state.operations.values()].map(value => value.receipt); },
    async fork(otherBinding = binding) { return fixture(parent, clock, handles, { application, binding: otherBinding, limits }, cleanup); },
    async corruptRecord(scope, namespace, key) {
      const db = new DatabaseSync(filename);
      try {
        const rows = db.prepare('SELECT seq, body FROM sflow_ns_entries WHERE scope_key = ? ORDER BY seq DESC').all(hash(JSON.stringify(scope)));
        for (const row of rows) {
          const body = JSON.parse(row.body);
          const record = body.transaction.changes.find(value => value.namespace === namespace && value.key === key);
          if (!record) continue;
          record.value = 'tampered';
          db.prepare('UPDATE sflow_ns_entries SET body = ? WHERE scope_key = ? AND seq = ?')
            .run(JSON.stringify(body), hash(JSON.stringify(scope)), row.seq);
          return;
        }
        throw new Error('Fixture record was not found.');
      } finally { db.close(); }
    }
  } };
}
