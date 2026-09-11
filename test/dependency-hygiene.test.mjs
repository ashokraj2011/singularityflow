import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('install graph excludes retired Electron dependencies and pins the reviewed CALM validator exception', async () => {
  const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
  const npmrc = await readFile(new URL('.npmrc', root), 'utf8');
  const packages = Object.entries(lock.packages ?? {});

  assert.equal(packageJson.overrides, undefined, 'retired Electron overrides must not remain');
  assert.deepEqual(packageJson.workspaces, ['apps/vscode']);
  assert.match(npmrc, /^omit=peer$/m);

  const installed = (dependency) => packages.filter(([packagePath, value]) => {
    if (value.peer === true) return false;
    return packagePath === `node_modules/${dependency}` || packagePath.endsWith(`/node_modules/${dependency}`);
  });

  for (const dependency of ['electron', 'electron-builder', 'rimraf', 'boolean']) {
    assert.deepEqual(installed(dependency), [], `${dependency} must not return to the npm install graph`);
  }

  // The exact FINOS CALM CLI used for offline architecture validation still packages
  // copyfiles -> glob@7 -> inflight. Admit only that reviewed, pinned upstream chain.
  assert.deepEqual(installed('glob').map(([packagePath, value]) => [packagePath, value.version]),
    [['node_modules/glob', '7.2.3']]);
  assert.deepEqual(installed('inflight').map(([packagePath, value]) => [packagePath, value.version]),
    [['node_modules/inflight', '1.0.6']]);
  assert.equal(lock.packages['node_modules/@finos/calm-cli']?.version, '1.57.0');
  assert.equal(lock.packages['node_modules/@finos/calm-cli']?.dependencies?.copyfiles, '^2.4.1');
  assert.equal(lock.packages['node_modules/copyfiles']?.version, '2.4.1');
  assert.equal(lock.packages['node_modules/copyfiles']?.dependencies?.glob, '^7.0.5');
  assert.equal(lock.packages['node_modules/glob']?.dependencies?.inflight, '^1.0.4');
  assert.equal(lock.packages['node_modules/inflight']?.integrity,
    'sha512-k92I/b08q4wvFscXCLvqfsHCrjrF7yiXsQuIVvVE7N82W3+aqpzuUdBbfhWcy/FZR3/4IgflMgKLOsvPDrGCJA==');
});
