import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => path.join(root, 'apps', 'vscode', 'src', name);
const { LatestSingleFlight, MicrotaskCoalescer, RetainedPanelRenderGate } =
  await import(source('single-flight.ts'));

const turn = () => new Promise((resolve) => setImmediate(resolve));

test('latest single-flight bounds a save storm to one active and one trailing validation', async () => {
  let calls = 0;
  let running = 0;
  let maximumRunning = 0;
  const releases = [];
  const flight = new LatestSingleFlight(async () => {
    const value = ++calls;
    running += 1;
    maximumRunning = Math.max(maximumRunning, running);
    return new Promise((resolve) => releases.push(() => {
      running -= 1;
      resolve(value);
    }));
  });

  const first = flight.request();
  await turn();
  assert.equal(calls, 1);

  const storm = Array.from({ length: 100 }, () => flight.request());
  assert.equal(calls, 1, 'requests arriving during validation do not start more processes');
  releases.shift()();
  await turn();
  assert.equal(calls, 2, 'the whole burst becomes one trailing validation');
  releases.shift()();

  assert.equal(await first, 2, 'the superseded validation result is never published');
  assert.deepEqual(await Promise.all(storm), Array(100).fill(2));
  assert.equal(maximumRunning, 1);
});

test('microtask rendering collapses provider bursts while explicit first paint remains immediate', async () => {
  let renders = 0;
  const coalescer = new MicrotaskCoalescer(() => { renders += 1; });

  for (let index = 0; index < 100; index += 1) coalescer.request();
  assert.equal(renders, 0);
  await Promise.resolve();
  assert.equal(renders, 1);

  coalescer.request();
  coalescer.flush();
  assert.equal(renders, 2, 'first paint does not wait for a microtask');
  await Promise.resolve();
  assert.equal(renders, 2, 'the invalidated queued paint does not run afterwards');

  coalescer.request();
  coalescer.dispose();
  await Promise.resolve();
  assert.equal(renders, 2, 'disposed views cannot be repainted by a queued callback');
});

test('retained hidden panels ignore loading and render the latest snapshot once when revealed', () => {
  let visible = true;
  let latest = 0;
  const rendered = [];
  const gate = new RetainedPanelRenderGate(() => visible, () => rendered.push(latest));

  gate.changed('loading');
  assert.deepEqual(rendered, [], 'loading carries no new read model');
  latest = 1;
  gate.changed('snapshot');
  assert.deepEqual(rendered, [1]);

  visible = false;
  for (latest = 2; latest <= 100; latest += 1) gate.changed('snapshot');
  assert.deepEqual(rendered, [1], 'a retained hidden DOM is not repeatedly replaced');
  gate.visibilityChanged(false);
  assert.deepEqual(rendered, [1]);
  latest = 101;
  visible = true;
  gate.visibilityChanged(true);
  assert.deepEqual(rendered, [1, 101], 'reveal consumes every hidden change using the latest state');
  gate.visibilityChanged(true);
  assert.deepEqual(rendered, [1, 101], 'the pending render is consumed exactly once');

  visible = false;
  latest = 102;
  gate.changed('snapshot');
  gate.rendered();
  visible = true;
  gate.visibilityChanged(true);
  assert.deepEqual(rendered, [1, 101], 'a direct render consumes the pending snapshot without a duplicate reveal render');

  visible = false;
  gate.changed('error');
  gate.dispose();
  visible = true;
  gate.visibilityChanged(true);
  assert.deepEqual(rendered, [1, 101]);
});

test('retained panels render only when their subscribed snapshot slice changed', () => {
  const rendered = [];
  const gate = new RetainedPanelRenderGate(() => true, () => rendered.push('render'), ['configuration']);

  gate.changed('snapshot', ['lifecycle']);
  gate.changed('snapshot', []);
  assert.deepEqual(rendered, [], 'an exact unrelated or unchanged slice must not replace the panel DOM');
  gate.changed('snapshot', ['repository', 'configuration']);
  assert.deepEqual(rendered, ['render']);
  gate.changed('error', []);
  assert.deepEqual(rendered, ['render', 'render'], 'errors remain visible regardless of slice filtering');
});

test('sidebar and configuration validation route their hot paths through the coalescers', async () => {
  const [sidebar, lifecycle, validation] = await Promise.all([
    readFile(source('views/sidebar.ts'), 'utf8'),
    readFile(source('views/lifecycle.ts'), 'utf8'),
    readFile(source('validation.ts'), 'utf8')
  ]);
  assert.match(sidebar, /source\.onDidChangeTreeData\(\(\) => \{[\s\S]*?this\.renders\.request\(\)/);
  assert.match(sidebar, /resolveWebviewView[\s\S]*?this\.renders\.flush\(\)/,
    'first paint must remain synchronous');
  assert.match(lifecycle, /if \(change\.kind === 'loading'\) return/,
    'loading-only state still rebuilds all tree models');
  assert.match(validation, /new LatestSingleFlight/);
  assert.match(validation, /repository !== this\.client\.repository/,
    'a validation from a previous repository can still overwrite current diagnostics');
});

test('leased heavyweight panels gate snapshot-driven rendering while hidden', async () => {
  const gated = [
    'views/approvals.ts', 'views/capabilities.ts', 'views/configuration-center.ts',
    'views/dashboard.ts', 'views/designer.ts', 'views/instruction-designer.ts'
  ];
  for (const file of gated) {
    const content = await readFile(source(file), 'utf8');
    assert.match(content, /new RetainedPanelRenderGate/,
      `${file} still rebuilds its retained hidden DOM on every store event`);
    assert.match(content, /onDidChangeViewState\?\./,
      `${file} cannot consume its deferred latest snapshot when revealed`);
    assert.match(content, /snapshotRenders\.dispose\(\)/,
      `${file} can repaint after it has been disposed`);
    assert.match(content, /snapshotRenders\.rendered\(\)/,
      `${file} can duplicate a direct render when the reveal event consumes pending state`);
    assert.match(content, /change\.changedSlices/,
      `${file} does not subscribe to the exact changed snapshot slices`);
  }

  // AST reloads additional diagnostics rather than only projecting the snapshot, but it obeys the
  // same boundary: only a changed snapshot starts work and hidden changes collapse until reveal.
  const ast = await readFile(source('views/ast-intelligence.ts'), 'utf8');
  assert.match(ast, /change\.kind !== 'snapshot' \|\| !change\.revisionChanged/);
  assert.match(ast, /panel\.visible === false[\s\S]*refreshPending = true/);
  assert.match(ast, /onDidChangeViewState\?\.[\s\S]*!this\.refreshPending/);
});
