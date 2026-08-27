/**
 * A failed refresh has to heal itself.
 *
 * The engine refuses a snapshot whose repository moved while it was being assembled. `WorkspaceStore`
 * caught that, published it as state, and stopped — and the only automatic thing that would ever call
 * `refresh()` again is a watcher scoped to `singularity/**`. So a disturbance from anywhere else — an
 * autosave, a build, a file dropped in the tree — left Lifecycle and Inbox showing "Repository state
 * changed" until somebody clicked, because the thing that broke it could not un-break it.
 *
 * The store is plain TypeScript over an injected client — it imports `vscode` only as a type — so it
 * can be driven for real rather than read as text. The suite's runner cannot load `.ts`, so this
 * spawns a child with type stripping instead of changing the runner for one file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storeModule = pathToFileURL(path.join(packageRoot, 'apps/vscode/src/state.ts')).href;

const DISTURBED = 'Repository state changed while the snapshot was being assembled. Refresh and retry.';

/**
 * Run one scenario in a child and return what the store did.
 *
 * `failures` is the list of messages `snapshot()` rejects with, in order, before it starts
 * succeeding. `recovers` decides whether the configuration fallback answers.
 */
function drive({ failures, recovers = true, attemptWorkMs = 0 }) {
  const source = `
    import { WorkspaceStore } from ${JSON.stringify(storeModule)};
    const failures = ${JSON.stringify(failures)};
    let attempts = 0;
    let configurationCalls = 0;
    const client = {
      async snapshot() {
        const workUntil = Date.now() + ${JSON.stringify(attemptWorkMs)};
        while (Date.now() < workUntil) { /* deterministic snapshot work */ }
        const message = failures[attempts];
        attempts += 1;
        if (message) throw new Error(message);
        return { workItems: [], initiatives: [], marker: 'live' };
      },
      async configurationSnapshot() {
        configurationCalls += 1;
        if (!${JSON.stringify(recovers)}) throw new Error('no configuration either');
        return { workItems: [], initiatives: [], marker: 'configuration' };
      }
    };
    const store = new WorkspaceStore(client);
    const retryWaits = [];
    const nativeSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...args) => {
      retryWaits.push(delay);
      return nativeSetTimeout(callback, delay, ...args);
    };
    const published = [];
    store.onDidChange((state) => published.push({
      marker: state.snapshot?.marker ?? null,
      error: state.error?.message ?? null,
      loading: state.loading
    }));
    const startedAt = Date.now();
    await store.refresh();
    process.stdout.write(JSON.stringify({
      attempts,
      configurationCalls,
      elapsed: Date.now() - startedAt,
      retryWaits,
      final: store.current.snapshot?.marker ?? null,
      error: store.current.error?.message ?? null,
      loading: store.current.loading,
      published
    }));
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    encoding: 'utf8', cwd: packageRoot, timeout: 60_000
  });
  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('a disturbed snapshot is retried until it lands, with nobody clicking anything', () => {
  const outcome = drive({ failures: [DISTURBED] });
  assert.equal(outcome.attempts, 2, 'the store gave up instead of trying again');
  assert.equal(outcome.final, 'live');
  assert.equal(outcome.error, null, 'a transient failure must not be left on screen');
  assert.equal(outcome.loading, false);
  // Never publishes the failure: the person sees a brief load, then the data.
  assert.deepEqual(outcome.published.map((state) => state.error), [null, null]);
  assert.equal(outcome.configurationCalls, 0, 'the recovery path is not for transient failures');
});

test('a repository under sustained write recovers as soon as it settles', () => {
  const outcome = drive({ failures: [DISTURBED, DISTURBED, DISTURBED] });
  // A running phase writes throughout. Three disturbed reads then a good one is an ordinary phase.
  assert.equal(outcome.attempts, 4);
  assert.equal(outcome.final, 'live');
  assert.equal(outcome.error, null);
});

test('the retries are bounded — permanent churn ends at a visible error, not a spinner', () => {
  const outcome = drive({ failures: Array.from({ length: 12 }, () => DISTURBED) });
  // One attempt plus one per backoff step, and then it stops and says so.
  assert.equal(outcome.attempts, 4, 'the retry loop is not bounded');
  assert.match(outcome.error, /Repository state changed/);
  assert.equal(outcome.loading, false, 'a store that stops trying must stop claiming to load');
  // The configuration inventory still renders, so the person can reach the files to repair.
  assert.equal(outcome.configurationCalls, 1);
  assert.equal(outcome.final, 'configuration');
});

test('a real fault is reported at once, not four seconds later', () => {
  const outcome = drive({ failures: ['workflow.yml declares an unknown phase "deploy"'] });
  // Retrying a broken lifecycle definition only delays the error someone needs to repair it.
  assert.equal(outcome.attempts, 1, 'a non-transient failure must not consume the retry budget');
  assert.match(outcome.error, /unknown phase/);
  assert.ok(outcome.elapsed < 400, `took ${outcome.elapsed}ms — it backed off on a real fault`);
});

test('when nothing answers, the failure is still the one worth showing', () => {
  const outcome = drive({ failures: ['no repository here'], recovers: false });
  assert.equal(outcome.final, null);
  assert.match(outcome.error, /no repository here/);
  assert.equal(outcome.loading, false);
});

test('the backoff uses real timers and its configured wait budget stays under five seconds', () => {
  const outcome = drive({
    failures: Array.from({ length: 12 }, () => DISTURBED),
    attemptWorkMs: 100
  });
  // 400 + 1000 + 2500. Long enough for a write burst to finish, short enough that a person who
  // clicked refresh does not conclude the extension has hung. A saturated test host may deschedule
  // the child for much longer than that; verify the delays the product requested rather than
  // blaming Singularity Flow for time during which its process did not run.
  assert.ok(outcome.elapsed >= 3_900, `backoff did not happen: ${outcome.elapsed}ms`);
  assert.equal(outcome.retryWaits.length, 3);
  for (const [index, delay] of outcome.retryWaits.entries()) {
    assert.ok(delay >= 0 && delay <= [400, 1_000, 2_500][index], `invalid retry delay ${index}: ${delay}ms`);
  }
  const requestedWaitMs = outcome.retryWaits.reduce((total, delay) => total + delay, 0);
  assert.ok(requestedWaitMs <= 3_650, `snapshot work was compounded into the backoff: ${requestedWaitMs}ms`);
});

test('the store owns the retry policy, so no view has to know about it', async () => {
  // Guards the shape rather than the numbers: a second view growing its own retry loop is how two
  // sections end up disagreeing about whether the repository is readable.
  const views = path.join(packageRoot, 'apps/vscode/src/views');
  const offenders = [];
  for (const name of (await readdir(views)).filter((file) => file.endsWith('.ts'))) {
    const source = await readFile(path.join(views, name), 'utf8');
    if (/Repository state changed/.test(source)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], 'a view is handling the disturbance itself');
});

test('overlapping refreshes coalesce without aborting paid work or fanning out stale results', () => {
  const source = `
    import { WorkspaceStore } from ${JSON.stringify(storeModule)};
    let calls = 0;
    let aborted = 0;
    const client = {
      async snapshot(signal) {
        calls += 1;
        const marker = calls;
        await new Promise((resolve) => setTimeout(resolve, 80));
        if (signal?.aborted) aborted += 1;
        return {
          workItems: [], initiatives: [], marker,
          revision: { subjectRevision: String(marker) },
          included: ['repository', 'lifecycle', 'capabilities']
        };
      },
      async configurationSnapshot() { throw new Error('not expected'); }
    };
    const store = new WorkspaceStore(client);
    const events = [];
    store.onDidChange((state, change) => events.push({ kind: change.kind, marker: state.snapshot?.marker ?? null }));
    const first = store.refresh();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = store.refresh();
    await Promise.all([first, second]);
    process.stdout.write(JSON.stringify({ calls, aborted, events, marker: store.current.snapshot?.marker }));
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    encoding: 'utf8', cwd: packageRoot, timeout: 10_000
  });
  assert.equal(result.status, 0, result.stderr);
  const outcome = JSON.parse(result.stdout);
  assert.equal(outcome.calls, 2, 'the newer request did not receive one coherent follow-up');
  assert.equal(outcome.aborted, 0, 'a refresh request aborted work that was already in progress');
  assert.equal(outcome.marker, 2);
  assert.deepEqual(outcome.events, [
    { kind: 'loading', marker: null },
    { kind: 'snapshot', marker: 2 }
  ]);
});

test('loading a new snapshot slice cannot reuse a revision from a smaller projection', () => {
  const source = `
    import { WorkspaceStore } from ${JSON.stringify(storeModule)};
    const calls = [];
    const client = {
      async snapshot(_signal, slices, ifRevision) {
        calls.push({ slices, ifRevision });
        return {
          workItems: [], initiatives: [],
          definitionText: slices.includes('configuration') ? 'version: 2' : undefined,
          revision: { subjectRevision: slices.includes('configuration') ? 'expanded' : 'core' },
          included: slices
        };
      },
      async configurationSnapshot() { throw new Error('not expected'); }
    };
    const store = new WorkspaceStore(client);
    await store.refresh();
    await store.ensureSlices(['configuration']);
    process.stdout.write(JSON.stringify({ calls, definitionText: store.current.snapshot?.definitionText }));
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    encoding: 'utf8', cwd: packageRoot, timeout: 10_000
  });
  assert.equal(result.status, 0, result.stderr);
  const outcome = JSON.parse(result.stdout);
  assert.equal(outcome.calls.length, 2);
  assert.equal(outcome.calls[0].ifRevision, null);
  assert.equal(outcome.calls[1].ifRevision, null,
    'a core-slice revision incorrectly suppressed the newly requested configuration slice');
  assert.ok(outcome.calls[1].slices.includes('configuration'));
  assert.equal(outcome.definitionText, 'version: 2');
});

test('loading a missing slice reports that it already refreshed, so Start Work does not read twice', () => {
  const source = `
    import { WorkspaceStore } from ${JSON.stringify(storeModule)};
    let calls = 0;
    const client = {
      async snapshot(_signal, slices) {
        calls += 1;
        return { workItems: [], initiatives: [], included: slices, revision: { subjectRevision: String(calls) } };
      },
      async configurationSnapshot() { throw new Error('not expected'); }
    };
    const store = new WorkspaceStore(client);
    const firstRefreshed = await store.ensureSlices(['configuration']);
    const secondRefreshed = await store.ensureSlices(['configuration']);
    process.stdout.write(JSON.stringify({ calls, firstRefreshed, secondRefreshed }));
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    encoding: 'utf8', cwd: packageRoot, timeout: 10_000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    calls: 1,
    firstRefreshed: true,
    secondRefreshed: false
  });
});

test('a cached heavy panel does not make the next activation reload every heavy slice', () => {
  const source = `
    import { WorkspaceStore } from ${JSON.stringify(storeModule)};
    let requested = null;
    const client = {
      async snapshot(_signal, slices) {
        requested = slices;
        return { workItems: [], initiatives: [], included: slices, revision: { subjectRevision: 'live-core' } };
      },
      async configurationSnapshot() { throw new Error('not expected'); }
    };
    const cache = {
      read() {
        return {
          workItems: [], initiatives: [], definitionText: 'cached heavy data',
          included: ['repository', 'lifecycle', 'capabilities', 'configuration', 'integrations', 'diagnostics'],
          revision: { subjectRevision: 'cached-all' }
        };
      },
      write() {}
    };
    const store = new WorkspaceStore(client, cache);
    store.primeFromCache();
    await store.refresh();
    process.stdout.write(JSON.stringify({ requested }));
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    encoding: 'utf8', cwd: packageRoot, timeout: 10_000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).requested, ['repository', 'lifecycle', 'capabilities']);
});

test('panels that launch CLI reads ignore loading-only store events', async () => {
  const names = ['impact.ts', 'flow-impact.ts', 'reconciliation.ts', 'ast-intelligence.ts'];
  for (const name of names) {
    const source = await readFile(path.join(packageRoot, 'apps/vscode/src/views', name), 'utf8');
    assert.match(source, /change\.kind (?:===|!==) 'snapshot'/, `${name} reloads on loading-only events`);
    assert.match(source, /revisionChanged/, `${name} ignores the slice revision`);
  }
});
