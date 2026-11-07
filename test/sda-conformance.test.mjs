/**
 * SDA-AC-017: the Git ledger and the deterministic test adapter pass one conformance suite, and the
 * test adapter can never be selected as shared-state authority.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitLedgerAdapter } from '../src/sda/git-ledger-adapter.mjs';
import { selectSharedStateAuthority, SHARED_STATE_CONTRACT } from '../src/sda/shared-state-contract.mjs';
import { createMemoryAdapter } from './helpers/sda-memory-adapter.mjs';
import { sharedStateConformance } from './helpers/sda-conformance.mjs';
import { gitLedgerFixture as gitFixture, LEDGER } from './helpers/sda-git-ledger-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function memoryFixture() {
  const adapter = createMemoryAdapter();
  return {
    adapter,
    sourceRevision: 'a'.repeat(40),
    concurrentAppend: (event) => adapter.concurrentAppend(event),
    forgeDigest: (id) => adapter.forgeDigest(id),
    otherNamespace: () => adapter.otherNamespace(),
    cleanup: async () => {}
  };
}

sharedStateConformance('git ledger', gitFixture);
sharedStateConformance('deterministic memory', memoryFixture);

test('the deterministic adapter can never be selected as shared-state authority; the Git ledger can', async () => {
  const memory = createMemoryAdapter();
  assert.equal(memory.descriptor.qualification, 'test-only');
  assert.throws(() => selectSharedStateAuthority(memory), (error) => error.code === 'SDA_ADAPTER_NOT_PRODUCTION');
  assert.throws(() => selectSharedStateAuthority({ descriptor: { ...memory.descriptor, qualification: 'production', contract: 'other' } }),
    (error) => error.code === 'SDA_ADAPTER_CONTRACT_MISMATCH');
  const ledger = createGitLedgerAdapter(root, LEDGER);
  assert.equal(ledger.descriptor.contract, SHARED_STATE_CONTRACT);
  assert.equal(selectSharedStateAuthority(ledger, { require: ['conditional-append', 'idempotent-append'] }), ledger);
  assert.throws(() => selectSharedStateAuthority(ledger, { require: ['time-travel'] }),
    (error) => error.code === 'SDA_ADAPTER_CAPABILITY_UNSUPPORTED');
  // Nothing an installed build carries can reach it: the package ships src/, never test/.
  const files = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).files;
  assert.ok(files.includes('src/') && !files.some((entry) => entry.startsWith('test')));
  const shipped = await readFile(path.join(root, 'src/sda/git-ledger-adapter.mjs'), 'utf8');
  assert.doesNotMatch(shipped, /test\//u);
});
