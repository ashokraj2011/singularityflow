/**
 * One refused domain must not blank the panels reading another.
 *
 * The store reads every leased slice in one snapshot. When the engine refuses the lifecycle (a
 * Story whose review evidence it cannot bind, a broken workflow definition), the whole read fails
 * and the store falls back to the configuration inventory. That fallback used to be all it
 * published, so the Code Explainer leasing the captured change showed "no captured change" on a
 * Story that had changed ten files. The read-only slices that do not depend on the lifecycle are now
 * read on their own and kept, while the refusal stays the state's error for Lifecycle to show.
 *
 * The store is plain TypeScript over an injected client, driven in a child with type stripping as
 * the refresh-retry test does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nodeTypeScriptFlags } from '../scripts/typescript-runtime.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storeModule = pathToFileURL(path.join(packageRoot, 'apps/vscode/src/state.ts')).href;
const REFUSAL = 'Story review packet has no immutable Git commit containing its bound submission evidence.';

function drive({ independentFails = false, lease = ['comprehension'] } = {}) {
  const source = `
    import { WorkspaceStore } from ${JSON.stringify(storeModule)};
    const reads = [];
    const client = {
      async snapshot(signal, slices = ['repository', 'lifecycle', 'capabilities']) {
        reads.push(slices.join(','));
        if (slices.includes('lifecycle')) throw new Error(${JSON.stringify(REFUSAL)});
        if (${JSON.stringify(independentFails)}) throw new Error('refused as well');
        return {
          workItems: [], initiatives: [], included: slices,
          comprehension: slices.includes('comprehension') ? { marker: 'captured change' } : undefined,
          sgos: slices.includes('sgos') ? { marker: 'sgos' } : undefined,
          revision: { head: 'abc', slices: { repository: 'r1', comprehension: 'c1' } }
        };
      },
      async configurationSnapshot() {
        reads.push('configuration');
        return { workItems: [], initiatives: [], marker: 'configuration', included: ['configuration'], revision: { head: 'abc', slices: { configuration: 'k1' } } };
      }
    };
    const store = new WorkspaceStore(client);
    await store.acquireSlices('code-explainer', ${JSON.stringify(lease)});
    const snapshot = store.current.snapshot;
    process.stdout.write(JSON.stringify({
      reads,
      marker: snapshot?.marker ?? null,
      comprehension: snapshot?.comprehension?.marker ?? null,
      sgos: snapshot?.sgos?.marker ?? null,
      included: snapshot?.included ?? [],
      revisionSlices: snapshot?.revision?.slices ?? null,
      error: store.current.error?.message ?? null
    }));
  `;
  const result = spawnSync(process.execPath, [...nodeTypeScriptFlags(packageRoot), '--input-type=module', '-e', source], {
    encoding: 'utf8', cwd: packageRoot, timeout: 60_000
  });
  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('a refused lifecycle keeps the error, and the captured change a panel leases is still published', () => {
  const outcome = drive();
  assert.equal(outcome.error, REFUSAL, 'Lifecycle still shows why it is refused');
  assert.equal(outcome.marker, 'configuration', 'the configuration inventory is still there to repair it');
  assert.equal(outcome.comprehension, 'captured change', 'the Code Explainer keeps its captured change');
  assert.ok(outcome.included.includes('comprehension') && outcome.included.includes('configuration'));
  assert.equal(outcome.revisionSlices.comprehension, 'c1', 'the kept slice carries its own revision, so staleness still works');
  assert.equal(outcome.revisionSlices.configuration, 'k1');
  assert.ok(outcome.reads.includes('repository,comprehension'), `the independent read names only what was leased: ${outcome.reads.join(' | ')}`);
});

test('the independent read is bounded to leased slices, and its own failure leaves the plain recovery', () => {
  const both = drive({ lease: ['comprehension', 'sgos'] });
  assert.equal(both.sgos, 'sgos');
  assert.ok(both.reads.includes('repository,comprehension,sgos'));
  const refused = drive({ independentFails: true });
  assert.equal(refused.comprehension, null);
  assert.equal(refused.marker, 'configuration');
  assert.equal(refused.error, REFUSAL);
});
