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
function drive({ failures, recovers = true }) {
  const source = `
    import { WorkspaceStore } from ${JSON.stringify(storeModule)};
    const failures = ${JSON.stringify(failures)};
    let attempts = 0;
    let configurationCalls = 0;
    const client = {
      async snapshot() {
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

test('the backoff is real time, and the whole budget stays under five seconds', () => {
  const outcome = drive({ failures: Array.from({ length: 12 }, () => DISTURBED) });
  // 400 + 1000 + 2500. Long enough for a write burst to finish, short enough that a person who
  // clicked refresh does not conclude the extension has hung.
  assert.ok(outcome.elapsed >= 3_900, `backoff did not happen: ${outcome.elapsed}ms`);
  assert.ok(outcome.elapsed < 5_000, `backoff overran: ${outcome.elapsed}ms`);
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
