import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('desktop install graph excludes deprecated Electron packaging dependencies', async () => {
  const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
  const npmrc = await readFile(new URL('.npmrc', root), 'utf8');
  const packages = Object.entries(lock.packages ?? {});

  assert.equal(packageJson.overrides?.['@electron/asar'], '4.2.1');
  assert.equal(packageJson.overrides?.['@electron/get'], '5.0.0');
  assert.match(npmrc, /^omit=peer$/m);

  for (const dependency of ['inflight', 'rimraf', 'boolean']) {
    const matches = packages.filter(([path, value]) => {
      if (value.peer === true) return false;
      return path === `node_modules/${dependency}` || path.endsWith(`/node_modules/${dependency}`);
    });
    assert.deepEqual(matches, [], `${dependency} must not return to the npm install graph`);
  }

  const legacyGlob = packages.filter(([path, value]) => {
    if (value.peer === true) return false;
    if (!(path === 'node_modules/glob' || path.endsWith('/node_modules/glob'))) return false;
    return Number.parseInt(value.version, 10) < 10;
  });
  assert.deepEqual(legacyGlob, [], 'glob versions older than 10 must not return to the npm install graph');
});
