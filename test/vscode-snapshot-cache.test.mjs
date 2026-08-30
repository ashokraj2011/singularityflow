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
import { readFileSync } from 'node:fs';
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

test('A-to-B-to-A switching restores only that repository cache and forces a full confirmation', () => {
  const source = `
    import { WorkspaceStore } from ${JSON.stringify(storeModule)};
    let repository = 'A';
    const cache = new Map([
      ['A', { workItems: [], initiatives: [], marker: 'cached-A', revision: { subjectRevision: 'cached-revision-A' } }],
      ['B', { workItems: [], initiatives: [], marker: 'cached-B', revision: { subjectRevision: 'cached-revision-B' } }]
    ]);
    const calls = [];
    const client = {
      async snapshot(_signal, _slices, ifRevision) {
        calls.push({ repository, ifRevision });
        return {
          workItems: [], initiatives: [], marker: 'live-' + repository,
          revision: { subjectRevision: 'live-revision-' + repository }
        };
      },
      async configurationSnapshot() { throw new Error('unexpected'); }
    };
    const store = new WorkspaceStore(client, {
      read: () => cache.get(repository) ?? null,
      write: (snapshot) => cache.set(repository, snapshot)
    });
    const paints = [];
    store.onDidChange((state, change) => {
      if (change.kind !== 'loading') paints.push({ repository, marker: state.snapshot?.marker ?? null, stale: state.stale });
    });
    store.primeFromCache();
    await store.refresh();
    repository = 'B';
    store.repositoryChanged();
    const immediateB = store.current.snapshot?.marker;
    await store.refresh();
    repository = 'A';
    store.repositoryChanged();
    const immediateA = store.current.snapshot?.marker;
    await store.refresh();
    process.stdout.write(JSON.stringify({ calls, paints, immediateB, immediateA, final: store.current.snapshot?.marker }));
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    encoding: 'utf8', cwd: packageRoot, timeout: 60_000
  });
  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  const outcome = JSON.parse(result.stdout);
  assert.equal(outcome.immediateB, 'cached-B');
  assert.equal(outcome.immediateA, 'live-A', 'returning to A used B cache or discarded A cache');
  assert.equal(outcome.final, 'live-A');
  assert.deepEqual(outcome.calls.map(({ repository }) => repository), ['A', 'B', 'A']);
  assert.equal(outcome.calls[1].ifRevision, null, 'B was queried using A subject revision');
  assert.equal(outcome.calls[2].ifRevision, null, 'A was queried using B subject revision');
  assert.ok(outcome.paints.some((paint) => paint.repository === 'B' && paint.marker === 'cached-B' && paint.stale));
  assert.equal(outcome.paints.some((paint) => paint.repository === 'B' && /A$/.test(paint.marker ?? '')), false,
    'repository A was painted after switching to B');
});

test('switching repositories aborts and detaches the old snapshot flight before starting the new one', () => {
  const source = `
    import { WorkspaceStore } from ${JSON.stringify(storeModule)};
    let repository = 'A';
    let releaseA;
    let releaseB;
    const aResult = new Promise((resolve) => { releaseA = resolve; });
    const bResult = new Promise((resolve) => { releaseB = resolve; });
    const calls = [];
    const writes = [];
    let aSignal;
    const client = {
      async snapshot(signal) {
        const requestedRepository = repository;
        calls.push(requestedRepository);
        if (requestedRepository === 'A') {
          aSignal = signal;
          // Deliberately ignore cancellation, as a real child process may take time to terminate.
          await aResult;
        } else {
          await bResult;
        }
        return {
          workItems: [], initiatives: [], marker: 'live-' + requestedRepository,
          revision: { subjectRevision: 'revision-' + requestedRepository }
        };
      },
      async configurationSnapshot() { throw new Error('unexpected'); }
    };
    const store = new WorkspaceStore(client, {
      read: () => null,
      write: (snapshot) => writes.push(snapshot.marker)
    });

    const aRefresh = store.refresh();
    repository = 'B';
    store.repositoryChanged();
    const bRefresh = store.refresh();
    const bStartedBeforeASettled = calls.join(',') === 'A,B';
    const aWasAborted = aSignal?.aborted === true;

    // Keep a broken implementation from making the regression test wait for its child timeout:
    // release both gates after capturing the failure if B incorrectly queued behind A.
    if (!bStartedBeforeASettled) {
      releaseA();
      releaseB();
      await Promise.allSettled([aRefresh, bRefresh]);
      process.stdout.write(JSON.stringify({
        bStartedBeforeASettled, aWasAborted, callsWhileBPending: [...calls], waitedForB: false,
        final: store.current.snapshot?.marker, writes
      }));
      process.exit(0);
    }

    releaseA();
    await aRefresh;

    // A's late finally must not clear B's flight. An already-loaded core slice should join B,
    // rather than observe no flight and start a third snapshot because the repository is empty.
    let sliceWaitSettled = false;
    const sliceWait = store.ensureSlices(['repository']).then(() => { sliceWaitSettled = true; });
    await Promise.resolve();
    await Promise.resolve();
    const callsWhileBPending = [...calls];
    const waitedForB = !sliceWaitSettled;

    releaseB();
    await Promise.all([bRefresh, sliceWait]);
    process.stdout.write(JSON.stringify({
      bStartedBeforeASettled, aWasAborted, callsWhileBPending, waitedForB,
      final: store.current.snapshot?.marker, writes
    }));
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    encoding: 'utf8', cwd: packageRoot, timeout: 60_000
  });
  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), {
    bStartedBeforeASettled: true,
    aWasAborted: true,
    callsWhileBPending: ['A', 'B'],
    waitedForB: true,
    final: 'live-B',
    writes: ['live-B']
  });
});

test('a leased SGOS slice loads lazily and is released when Command Center closes', () => {
  const source = `
    import { WorkspaceStore } from ${JSON.stringify(storeModule)};
    const calls = [];
    const client = {
      async snapshot(_signal, slices) {
        calls.push([...slices]);
        const hasSgos = slices.includes('sgos');
        return {
          workItems: [], initiatives: [], included: [...slices],
          ...(hasSgos ? { sgos: { projectionVersion:1, kind:'sgos-command-center', processes:[], needsYou:[], unavailable:[], counts:{}, contentSha256:'sha256:${'a'.repeat(64)}', runtimeProfile:{ id:'bounded-static-parallel-lineage', capabilities:{} } } } : {}),
          revision: { subjectRevision: 'revision-' + calls.length, slices: hasSgos ? { sgos:'sgos-1' } : {} }
        };
      },
      async configurationSnapshot() { throw new Error('unexpected'); }
    };
    const store = new WorkspaceStore(client);
    await store.refresh();
    const beforeLease = calls.at(-1);
    const lease = await store.acquireSlices(['sgos']);
    const loaded = Boolean(store.current.snapshot?.sgos);
    const duringLease = calls.at(-1);
    lease.dispose();
    const released = !store.current.snapshot?.sgos;
    await store.refresh();
    process.stdout.write(JSON.stringify({ beforeLease, duringLease, afterRelease:calls.at(-1), loaded, released }));
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    encoding: 'utf8', cwd: packageRoot, timeout: 60_000
  });
  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(value.beforeLease.sort(), ['capabilities', 'lifecycle', 'repository']);
  assert.ok(value.duringLease.includes('sgos'));
  assert.equal(value.loaded, true);
  assert.equal(value.released, true);
  assert.equal(value.afterRelease.includes('sgos'), false);
});

test('shared panel slice leases stop heavyweight polling only after the final panel closes', () => {
  const source = `
    import { WorkspaceStore } from ${JSON.stringify(storeModule)};
    const calls = [];
    const client = {
      async snapshot(_signal, slices) {
        calls.push([...slices]);
        return {
          workItems: [], initiatives: [], included: [...slices],
          revision: { subjectRevision: 'revision-' + calls.length }
        };
      },
      async configurationSnapshot() { throw new Error('unexpected'); }
    };
    const store = new WorkspaceStore(client);
    await store.refresh();
    const configurationPanel = await store.acquireSlices(['configuration']);
    const dashboardPanel = await store.acquireSlices(['configuration', 'diagnostics']);
    await store.refresh();
    const whileBothOpen = calls.at(-1);
    configurationPanel.dispose();
    await store.refresh();
    const afterFirstClose = calls.at(-1);
    dashboardPanel.dispose();
    await store.refresh();
    const afterFinalClose = calls.at(-1);
    process.stdout.write(JSON.stringify({ whileBothOpen, afterFirstClose, afterFinalClose }));
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    encoding: 'utf8', cwd: packageRoot, timeout: 60_000
  });
  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  const value = JSON.parse(result.stdout);
  assert.ok(value.whileBothOpen.includes('configuration'));
  assert.ok(value.whileBothOpen.includes('diagnostics'));
  assert.ok(value.afterFirstClose.includes('configuration'), 'a shared slice was released while another panel still held it');
  assert.ok(value.afterFirstClose.includes('diagnostics'));
  assert.equal(value.afterFinalClose.includes('configuration'), false);
  assert.equal(value.afterFinalClose.includes('diagnostics'), false);
});

test('a concurrent panel waits for the first shared slice expansion without triggering another read', () => {
  const source = `
    import { WorkspaceStore } from ${JSON.stringify(storeModule)};
    let calls = 0;
    let releaseExpansion;
    let expansionStarted;
    const started = new Promise((resolve) => { expansionStarted = resolve; });
    const expansion = new Promise((resolve) => { releaseExpansion = resolve; });
    const client = {
      async snapshot(_signal, slices) {
        calls += 1;
        if (slices.includes('configuration')) {
          expansionStarted();
          await expansion;
        }
        return { workItems: [], initiatives: [], included: [...slices], revision: { subjectRevision: String(calls) } };
      },
      async configurationSnapshot() { throw new Error('unexpected'); }
    };
    const store = new WorkspaceStore(client);
    await store.refresh();
    const first = store.acquireSlices(['configuration']);
    await started;
    let secondSettled = false;
    const second = store.acquireSlices(['configuration']).then((lease) => { secondSettled = true; return lease; });
    await Promise.resolve();
    const settledBeforeExpansion = secondSettled;
    releaseExpansion();
    const leases = await Promise.all([first, second]);
    process.stdout.write(JSON.stringify({ calls, settledBeforeExpansion }));
    leases.forEach((lease) => lease.dispose());
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    encoding: 'utf8', cwd: packageRoot, timeout: 60_000
  });
  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), { calls: 2, settledBeforeExpansion: false });
});

test('heavy VS Code panels own and release their snapshot slice leases', () => {
  const panels = new Map([
    ['configuration-center.ts', ['configuration', 'integrations']],
    ['capabilities.ts', ['configuration', 'diagnostics']],
    ['approvals.ts', ['configuration']],
    ['dashboard.ts', ['configuration', 'integrations', 'diagnostics']],
    ['designer.ts', ['configuration']],
    ['instruction-designer.ts', ['configuration']],
    ['ast-intelligence.ts', ['configuration']]
  ]);
  for (const [name, slices] of panels) {
    const source = readFileSync(path.join(packageRoot, 'apps/vscode/src/views', name), 'utf8');
    const argumentsPattern = slices.map((slice) => `'${slice}'`).join(', ');
    assert.match(source, new RegExp(`acquireSlices\\(\\[${argumentsPattern}\\]\\)`), `${name} does not acquire its heavy slices`);
    assert.match(source, /this\.lease\.dispose\(\)/, `${name} does not release its slice lease on disposal`);
  }
  const extension = readFileSync(path.join(packageRoot, 'apps/vscode/src/extension.ts'), 'utf8');
  assert.equal((extension.match(/ensureSlices\(/g) ?? []).length, 1,
    'panel commands still pin heavy slices outside panel lifecycle; only Start Work may ensure configuration transiently');
});
