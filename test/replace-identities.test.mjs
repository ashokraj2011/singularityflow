import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyIdentityReplacement,
  parseArguments,
  planIdentityReplacement
} from '../scripts/replace-identities.mjs';

async function fixture() {
  return mkdtemp(path.join(os.tmpdir(), 'sflow-identities-'));
}

test('identity replacement previews and applies repeatable mappings', async () => {
  const root = await fixture();
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'one.md'), 'owner: old-login\nname: Old Name\n');
  await writeFile(path.join(root, 'nested', 'two.yml'), 'reviewer: old-login\ndisplay: Old Name\n');
  const mappings = [
    { oldValue: 'old-login', newValue: 'new-login' },
    { oldValue: 'Old Name', newValue: 'New Name' }
  ];

  const plan = await planIdentityReplacement({ root, mappings });
  assert.deepEqual(plan.totals, { files: 2, replacements: 4 });
  assert.match(plan.confirmation, /^REPLACE IDENTITIES [a-f0-9]{12}$/);
  await applyIdentityReplacement(plan, plan.confirmation);
  assert.equal(await readFile(path.join(root, 'one.md'), 'utf8'), 'owner: new-login\nname: New Name\n');
  assert.equal(await readFile(path.join(root, 'nested', 'two.yml'), 'utf8'), 'reviewer: new-login\ndisplay: New Name\n');
});

test('identity replacement requires exact confirmation', async () => {
  const root = await fixture();
  await writeFile(path.join(root, 'record.txt'), 'old-login');
  const plan = await planIdentityReplacement({ root, mappings: [{ oldValue: 'old-login', newValue: 'new-login' }] });
  await assert.rejects(() => applyIdentityReplacement(plan, 'REPLACE IDENTITIES wrong'), /Exact confirmation required/);
});

test('identity replacement skips Git internals, dependencies, binaries, and symlinks', async () => {
  const root = await fixture();
  await mkdir(path.join(root, '.git'));
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, '.git', 'config'), 'old-login');
  await writeFile(path.join(root, 'node_modules', 'package.txt'), 'old-login');
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(root, 'target.txt'), 'old-login');
  await symlink(path.join(root, 'target.txt'), path.join(root, 'link.txt'));
  const plan = await planIdentityReplacement({ root, mappings: [{ oldValue: 'old-login', newValue: 'new-login' }] });
  assert.deepEqual(plan.files.map((entry) => entry.relative), ['target.txt']);
});

test('identity replacement refuses broad roots and stale previews', async () => {
  await assert.rejects(
    () => planIdentityReplacement({ root: path.parse(process.cwd()).root, mappings: [{ oldValue: 'old', newValue: 'new' }] }),
    /filesystem root/
  );
  const root = await fixture();
  const file = path.join(root, 'record.txt');
  await writeFile(file, 'old-login');
  const plan = await planIdentityReplacement({ root, mappings: [{ oldValue: 'old-login', newValue: 'new-login' }] });
  await writeFile(file, 'old-login changed');
  await assert.rejects(() => applyIdentityReplacement(plan, plan.confirmation), /changed after preview/);
});

test('argument parser accepts repeatable mappings and safe defaults', () => {
  const options = parseArguments(['--root', '/tmp/example', '--replace', 'old=new', '--replace', 'Old Name=New Name', '--ignore-case']);
  assert.equal(options.root, '/tmp/example');
  assert.equal(options.apply, false);
  assert.equal(options.ignoreCase, true);
  assert.deepEqual(options.mappings, [
    { oldValue: 'old', newValue: 'new' },
    { oldValue: 'Old Name', newValue: 'New Name' }
  ]);
});
