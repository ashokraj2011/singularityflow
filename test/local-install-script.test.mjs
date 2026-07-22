import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRegistry, registryArgument } from '../scripts/update-local-install.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('local installer performs a safe ordered pull, pack, global install, and plugin replacement', async () => {
  const script = await readFile(path.join(root, 'scripts/update-local-install.mjs'), 'utf8');
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['install:local'], 'node scripts/update-local-install.mjs');
  assert.match(script, /git', \['status', '--porcelain'/);
  assert.match(script, /git', \['pull', '--ff-only'/);
  assert.match(script, /npm, \['pack', '--json'/);
  assert.match(script, /npm, \['install', '--global', tarball/);
  assert.match(script, /npm, \['install', `--registry=\$\{registry\}`\]/);
  assert.match(script, /npm, \['install', '--global', tarball, `--registry=\$\{registry\}`\]/);
  assert.match(script, /singularity-flow', \['plugin', 'install'/);
  const main = script.slice(script.indexOf('function main()'));
  assert.ok(main.indexOf("['pull', '--ff-only']") < main.indexOf('const tarball = pack()'));
  assert.ok(main.indexOf('const tarball = pack()') < main.indexOf("['install', '--global', tarball"));
  assert.ok(main.indexOf("['install', '--global', tarball") < main.indexOf("['plugin', 'install']"));
});

test('local installer accepts CLI and Artifactory registry URLs without embedding credentials', () => {
  assert.equal(registryArgument(['--registry', 'https://artifacts.example.com/api/npm/npm-virtual']), 'https://artifacts.example.com/api/npm/npm-virtual');
  assert.equal(registryArgument(['--registry=https://registry.npmjs.org/']), 'https://registry.npmjs.org/');
  assert.equal(normalizeRegistry('https://artifacts.example.com/api/npm/npm-virtual'), 'https://artifacts.example.com/api/npm/npm-virtual/');
  assert.throws(() => normalizeRegistry('file:///tmp/registry'), /http:\/\/ or https:\/\//);
  assert.throws(() => normalizeRegistry('https://user:token@artifacts.example.com/npm/'), /credentials in the URL/);
  assert.throws(() => normalizeRegistry('https://artifacts.example.com/npm/?token=secret'), /query string or fragment/);
});
