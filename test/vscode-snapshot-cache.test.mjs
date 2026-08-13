/**
 * The sidebar opens on what it knew last, and says so until it is confirmed.
 *
 * `snapshot --json` takes most of a second even after the subprocess work, and until it landed the
 * sidebar could only show "Connecting to the Singularity Flow CLI…". Nothing survived a window
 * reload, so every open paid that wait again — one of the three things reported as slow.
 *
 * The repository rarely changes while VS Code is closed, so the previous answer is shown at once and
 * marked `stale`. What makes this safe rather than merely fast is the marking: governance state that
 * is quietly out of date is worse than a panel that admits it is checking.
 *
 * Driven for real, in a child with type stripping, the same way `vscode-refresh-retry` does it — the
 * store imports `vscode` only as a type, so it can be run rather than read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storeModule = pathToFileURL(path.join(packageRoot, 'apps/vscode/src/state.ts')).href;

/** Run one scenario and report every state the store published, in order. */
function drive({ cached = null, snapshotFails = false }) {
  const source = `
    import { WorkspaceStore } from ${JSON.stringify(storeModule)};
    const writes = [];
    const cache = {
      read: () => (${JSON.stringify(cached)}),
      write: (snapshot) => writes.push(snapshot.marker)
    };
    const client = {
      async snapshot() {
        if (${JSON.stringify(snapshotFails)}) throw new Error('the lifecycle definition is broken');
        return { workItems: [], initiatives: [], marker: 'live' };
      },
      async configurationSnapshot() { return { workItems: [], initiatives: [], marker: 'configuration' }; }
    };
    const store = new WorkspaceStore(client, cache);
    const published = [];
    store.onDidChange((state) => published.push({
      marker: state.snapshot?.marker ?? null, stale: state.stale, loading: state.loading
    }));
    const primed = store.primeFromCache();
    await store.refresh();
    process.stdout.write(JSON.stringify({ primed, writes, published, final: store.current.snapshot?.marker ?? null, finalStale: store.current.stale }));
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    encoding: 'utf8', cwd: packageRoot, timeout: 60_000
  });
  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('a cached snapshot paints before the CLI is asked, and is replaced when it answers', () => {
  const result = drive({ cached: { workItems: [], initiatives: [], marker: 'remembered' } });
  assert.equal(result.primed, true);

  // The very first thing a view is told is real content, not a spinner and not nothing.
  assert.deepEqual(result.published[0], { marker: 'remembered', stale: true, loading: false });

  // ...and it is honest about being unconfirmed until the live answer lands.
  assert.ok(result.published.some((state) => state.marker === 'remembered' && state.stale),
    'the restored snapshot was never marked stale');
  assert.equal(result.final, 'live');
  assert.equal(result.finalStale, false, 'the confirmed snapshot is still flagged as stale');
});

test('with nothing cached the behaviour is exactly what it was', () => {
  const result = drive({ cached: null });
  assert.equal(result.primed, false);
  assert.equal(result.published[0].marker, null, 'a first-ever open invented content it did not have');
  assert.equal(result.final, 'live');
  assert.equal(result.finalStale, false);
});

test('only a confirmed snapshot is remembered for next time', () => {
  // A live read writes through.
  assert.deepEqual(drive({ cached: null }).writes, ['live']);

  /**
   * The recovery path must not. `configurationSnapshot` is a validation-independent inventory
   * produced *because* the lifecycle failed to load; priming a later session with it would open the
   * sidebar on a repair view of a repository that may be perfectly healthy by then.
   */
  assert.deepEqual(drive({ cached: null, snapshotFails: true }).writes, [],
    'the failure-recovery inventory was cached as if it were the repository');
});
