import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('install graph excludes retired Electron dependencies and the removed CALM validator chain', async () => {
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

  // The FINOS CALM CLI left with the CALM architecture projection, and with it the deprecated
  // copyfiles -> glob@7 -> inflight chain it packaged.
  for (const dependency of ['electron', 'electron-builder', 'rimraf', 'boolean', '@finos/calm-cli', 'copyfiles', 'glob', 'inflight']) {
    assert.deepEqual(installed(dependency), [], `${dependency} must not return to the npm install graph`);
  }

  assert.equal(Object.hasOwn(packageJson.dependencies, '@finos/calm-cli'), false);
  assert.equal(packageJson.bundleDependencies.includes('@finos/calm-cli'), false);
});
