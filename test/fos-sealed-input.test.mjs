import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readFosSealedInputs, sealFosInputs, verifyFosSealedInputs
} from '../src/fos-sealed-input.mjs';
import { readRecord } from '../src/schema-migrations.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fos-sealed-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.name', 'FOS Test'], root);
  git(['config', 'user.email', 'fos@example.com'], root);
  await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await writeFile(path.join(root, 'source.txt'), 'index bytes\n');
  git(['add', '.'], root);
  git(['commit', '-qm', 'initial'], root);
  return root;
}

test('FOS:AC-023 sealed bytes distinguish same-size edits, ignored inputs and index/worktree divergence', async () => {
  const root = await repository();
  await writeFile(path.join(root, 'source.txt'), 'other bytes\n');
  await writeFile(path.join(root, 'ignored.txt'), 'required despite ignore\n');
  const sealed = await sealFosInputs(root, [
    { path: 'source.txt', source: 'index' },
    { path: 'source.txt', source: 'worktree' },
    { path: 'ignored.txt', source: 'worktree' }
  ]);
  assert.equal(sealed.schemaVersion, 2);
  assert.equal(sealed.observation.classification, 'observational');
  const indexed = sealed.inputs.find((entry) => entry.source === 'index');
  const worktree = sealed.inputs.find((entry) => entry.path === 'source.txt' && entry.source === 'worktree');
  assert.notEqual(indexed.sha256, worktree.sha256);
  assert.ok(sealed.inputs.some((entry) => entry.path === 'ignored.txt'));
  assert.equal((await verifyFosSealedInputs(root, sealed)).valid, true);

  const original = await readFile(path.join(root, 'source.txt'));
  await writeFile(path.join(root, 'source.txt'), Buffer.from('third bytes\n'));
  await assert.rejects(() => verifyFosSealedInputs(root, sealed),
    (error) => error.code === 'FOS_INPUT_CHANGED');
  await writeFile(path.join(root, 'source.txt'), original);

  await assert.rejects(() => sealFosInputs(root, ['source.txt'], {
    readBoundaryHook: async () => writeFile(path.join(root, 'source.txt'), 'raced bytes\n')
  }), (error) => error.code === 'FOS_INPUT_CHANGED');
});

test('FOS:AC-030 sealed-input migration reads the previous version and refuses a newer writer', async () => {
  const root = await repository();
  const current = await sealFosInputs(root, ['source.txt']);
  const previous = structuredClone(current);
  previous.schemaVersion = 1;
  delete previous.observation.classification;
  assert.equal(readFosSealedInputs(previous).schemaVersion, 2);
  assert.equal(readRecord('fos-sealed-input', previous).storedVersion, 1);
  await assert.rejects(async () => readFosSealedInputs({ ...current, schemaVersion: 3 }),
    (error) => error.code === 'SCHEMA_VERSION_FUTURE');
});
