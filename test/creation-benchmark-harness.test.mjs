import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWarmReadFixture } from '../scripts/warm-read-fixture.mjs';
import { seedBenchmarkRepository } from '../scripts/benchmark-git-seed.mjs';

test('installed creation fixtures include managed runtime resolution inputs', async t => {
  const f = await createWarmReadFixture({ files: 0 });
  t.after(() => f.cleanup());
  assert.match(await readFile(path.join(f.engine, 'runtime', 'resolve.cjs'), 'utf8'), /module\.exports/u);
});

test('packed fixture setup preserves unique contents and never overwrites existing history', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seed-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args, options = {}) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000, ...options });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git(['init', '-q', '-b', 'main']);
  await mkdir(path.join(root, 'two files'));
  await writeFile(path.join(root, 'a.txt'), 'unique one\n');
  await writeFile(path.join(root, 'two files', 'b.txt'), 'unique two\n');
  await seedBenchmarkRepository(root, git);
  assert.equal(git(['show', 'HEAD:a.txt']), 'unique one\n');
  assert.equal(git(['show', 'HEAD:two files/b.txt']), 'unique two\n');
  assert.equal(git(['status', '--porcelain']).trim(), '');
  assert.match(git(['count-objects', '-v']), /^count: 0\r?$/mu, 'fixture blobs are packed, not thousands of loose files');
  const before = git(['rev-parse', 'HEAD']);
  await assert.rejects(() => seedBenchmarkRepository(root, git), /without existing refs/u);
  assert.equal(git(['rev-parse', 'HEAD']), before);
});

test('benchmark probe counts sync and direct async Git without retaining arguments', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-count-probe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'counts.jsonl');
  const result = spawnSync(process.execPath, ['--import', new URL('../scripts/benchmark-git-probe.mjs', import.meta.url).href,
    '--input-type=module', '--eval', `import { spawn, spawnSync } from 'node:child_process';
      import { once } from 'node:events';
      spawnSync('git', ['config', '--global', '--get', 'secret.private-benchmark-sentinel']);
      await once(spawn('git', ['--version'], { stdio: 'ignore' }), 'close');`], {
    env: { ...process.env, SFLOW_BENCHMARK_GIT_COUNTS: output }, encoding: 'utf8', timeout: 30_000
  });
  assert.equal(result.status, 0, result.stderr);
  const text = await readFile(output, 'utf8'), record = JSON.parse(text);
  assert.deepEqual(record.counts, { config: 1, other: 1 });
  assert.ok(record.elapsedMs.config >= 0);
  assert.doesNotMatch(text, /sentinel|private-benchmark|--get/u);
});
