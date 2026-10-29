import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/util.mjs';
import { sourceContains, sourceFileAt, sourceRevision, sourceWorkingState } from '../src/source-inspection.mjs';
import { baseline, GIT_BOUNDARY, scanSource } from '../scripts/sda-inventory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('local Git reads may only fall, module by module (SDA-AC-001)', async () => {
  const committed = JSON.parse(await readFile(path.join(root, 'benchmarks/sda/inventory.json'), 'utf8'));
  const allowed = new Map(committed.modules.map((entry) => [entry.module, entry.localReads ?? 0]));
  const current = new Map(baseline(await scanSource()).modules.map((entry) => [entry.module, entry.localReads ?? 0]));
  const rose = [];
  const fell = [];
  for (const module of new Set([...allowed.keys(), ...current.keys()])) {
    if (GIT_BOUNDARY.test(module)) continue;
    const [was, now] = [allowed.get(module) ?? 0, current.get(module) ?? 0];
    if (now > was) rose.push(`${module}: ${was} -> ${now}`);
    else if (now < was) fell.push(`${module}: ${was} -> ${now}`);
  }
  assert.deepEqual(rose, [], 'read source through src/source-inspection.mjs rather than starting Git in the module');
  assert.deepEqual(fell, [],
    'fewer local Git reads: lock the fall in with node scripts/sda-inventory.mjs --output=benchmarks/sda/inventory.json');
});

test('the facade keeps present, absent and unavailable apart', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'sflow-source-inspection-'));
  run('git', ['init', '-q', '-b', 'main', work]);
  const commit = async (file, text) => {
    await writeFile(path.join(work, file), text);
    run('git', ['add', file], { cwd: work });
    run('git', ['-c', 'user.name=Inspect', '-c', 'user.email=inspect@example.test', 'commit', '-qm', file], { cwd: work });
    return run('git', ['rev-parse', 'HEAD'], { cwd: work }).stdout.trim();
  };
  const first = await commit('a.txt', 'alpha\n');
  const second = await commit('b.txt', 'x'.repeat(4096));

  assert.deepEqual(sourceFileAt(work, first, 'a.txt'), { status: 'present', value: 'alpha\n' });
  assert.ok(Buffer.isBuffer(sourceFileAt(work, first, 'a.txt', { encoding: 'buffer' }).value));
  assert.deepEqual(sourceFileAt(work, first, 'b.txt', { offline: true }), { status: 'absent' });
  assert.equal(sourceFileAt(work, second, 'b.txt', { maxBytes: 64 }).status, 'unavailable', 'an output bound is not absence');

  assert.deepEqual(sourceRevision(work, 'main'), { status: 'present', value: second });
  assert.deepEqual(sourceRevision(work, 'refs/heads/none'), { status: 'absent' });

  assert.deepEqual(sourceContains(work, first, second), { status: 'present', value: true });
  assert.deepEqual(sourceContains(work, second, first), { status: 'present', value: false });
  assert.equal(sourceContains(work, first, 'f'.repeat(40)).status, 'unavailable');

  assert.equal(sourceWorkingState(work).value.commit, second);
});
