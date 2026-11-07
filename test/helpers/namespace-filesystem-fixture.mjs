/** Test controls wrap the real protocol; durable faults/crashes have a separate native suite. */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFilesystemNamespaceStore } from '../../src/sda/filesystem-namespace-adapter.mjs';
import { openFilesystemNamespaceJournal } from '../../src/sda/filesystem-namespace-journal.mjs';
import { namespaceError } from '../../src/sda/namespace/index.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const TTL = 1_800_000;

export async function createNamespaceFilesystemFixture(options = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-namespace-filesystem-'));
  const clock = { value: Date.now() };
  const cleanup = () => rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  try { return await fixture(parent, clock, options, cleanup); }
  catch (error) { await cleanup(); throw error; }
}

async function fixture(parent, clock, { binding = { kind: 'shared' }, limits = { maxPage: 2 } }, cleanup) {
  const root = path.join(parent, `store-${hash(JSON.stringify(binding))}`);
  const adapter = await createFilesystemNamespaceStore({ root, binding, limits, create: true }, { now: () => clock.value });
  const journal = await openFilesystemNamespaceJournal({ root, binding, limits: adapter.descriptor.limits });
  const faults = new Map();
  let loseResponse = false, afterCommit = null;
  const wrapped = Object.freeze({ descriptor: adapter.descriptor,
    ...Object.fromEntries(['read', 'list', 'transact', 'inspectOperation', 'verify'].map(method => [method, async (...args) => {
      const faultKey = faults.has(method) ? method : method === 'transact' && faults.has('beforeCommit') ? 'beforeCommit' : null;
      if (faultKey) { const error = faults.get(faultKey); faults.delete(faultKey); throw error; }
      const pending = adapter[method](...args);
      const result = await pending;
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
  return { adapter: wrapped, root, cleanup, controls: {
    failNext(method, error) { faults.set(method, error); },
    loseNextCommitResponse() { loseResponse = true; },
    afterNextCommit(callback) { afterCommit = callback; },
    expireSnapshots() { clock.value += TTL + 1; },
    async events(scope) { return [...(await journal.read(scope)).state.events.values()]; },
    async receipts(scope) { return [...(await journal.read(scope)).state.operations.values()].map(value => value.receipt); },
    async fork(otherBinding = binding) { return fixture(parent, clock, { binding: otherBinding, limits }, cleanup); },
    async corruptRecord(scope, namespace, key) {
      const directory = path.join(root, `project-${hash(JSON.stringify(scope))}`, 'commits');
      for (const name of (await readdir(directory)).sort().reverse()) {
        const file = path.join(directory, name), envelope = JSON.parse(await readFile(file, 'utf8'));
        const record = envelope.body.transaction.changes.find(value => value.namespace === namespace && value.key === key);
        if (!record) continue;
        record.value = 'tampered';
        await writeFile(file, JSON.stringify(envelope) + '\n');
        return;
      }
      throw new Error('Fixture record was not found.');
    }
  } };
}
