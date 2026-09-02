import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reporter = path.join(root, 'scripts', 'release-test-reporter.mjs');

async function runFixture(source) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-release-reporter-'));
  const fixture = path.join(directory, 'fixture.test.mjs');
  try {
    await writeFile(fixture, source, 'utf8');
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
      '--test-reporter', reporter,
      '--test', fixture
    ], { cwd: root, encoding: 'utf8', env: environment });
    return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('release reporter preserves readable output and allows an ordinary passing suite', async () => {
  const result = await runFixture(`
    import test from 'node:test';
    import assert from 'node:assert/strict';
    test('ordinary release test', () => assert.equal(2 + 2, 4));
  `);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /ordinary release test/);
  assert.doesNotMatch(result.output, /Release verification forbids/);
});

test('release reporter makes skipped and todo outcomes fail the process', async () => {
  const result = await runFixture(`
    import test from 'node:test';
    test('temporarily skipped', { skip: 'not on release' }, () => {});
    test('unfinished behavior', { todo: 'known release gap' }, () => {
      throw new Error('not implemented');
    });
  `);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /Release verification forbids skipped, cancelled, or todo tests/);
  assert.match(result.output, /1 skipped/);
  assert.match(result.output, /1 todo/);
  assert.match(result.output, /skipped: temporarily skipped — not on release/);
  assert.match(result.output, /todo: unfinished behavior/);
});

test('release reporter identifies cancelled tests in the release diagnostic', async () => {
  const result = await runFixture(`
    import test from 'node:test';
    const controller = new AbortController();
    controller.abort(new Error('release fixture cancellation'));
    test('never completed', { signal: controller.signal }, () => {});
  `);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /Release verification forbids skipped, cancelled, or todo tests/);
  assert.match(result.output, /cancelled: never completed/);
});
