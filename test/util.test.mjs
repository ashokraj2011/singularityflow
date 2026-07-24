import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeJson, writeText } from '../src/util.mjs';

test('shared atomic writers tolerate concurrent writes without temporary-file collisions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-util-concurrent-'));
  const jsonFile = path.join(root, 'state.json');
  const textFile = path.join(root, 'state.txt');
  const jsonValues = Array.from({ length: 12 }, (_, index) => ({ index, payload: `value-${index}` }));
  const textValues = Array.from({ length: 12 }, (_, index) => `value-${index}`);

  await Promise.all(jsonValues.map((value) => writeJson(jsonFile, value)));
  await Promise.all(textValues.map((value) => writeText(textFile, value)));

  const finalJson = JSON.parse(await readFile(jsonFile, 'utf8'));
  const finalText = await readFile(textFile, 'utf8');
  assert.ok(jsonValues.some((value) => JSON.stringify(value) === JSON.stringify(finalJson)));
  assert.ok(textValues.some((value) => `${value}\n` === finalText));
  assert.deepEqual((await readdir(root)).sort(), ['state.json', 'state.txt']);
});

test('shared atomic writers remove temporary files after replacement failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-util-cleanup-'));
  const target = path.join(root, 'existing-directory');
  await mkdir(target);

  await assert.rejects(() => writeText(target, 'cannot replace a directory'));

  assert.deepEqual(await readdir(root), ['existing-directory']);
});
