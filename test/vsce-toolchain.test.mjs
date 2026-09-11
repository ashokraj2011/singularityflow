/**
 * The VSCE toolchain cache: installed once per (lock, registry, Node major, platform, architecture).
 *
 * The previous `resolveVsce` installed the pinned toolchain into a fresh temp directory on every
 * run and deleted it afterwards — 292 registry fetches and ~5 minutes per install, to re-create a
 * tree whose content the pin verification had already approved. These tests drive the cache with a
 * stub `npm` on PATH, so they prove the install-count behaviour without any network.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import {
  chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  resolveVsce, vsceToolchainKey, VSCE_TOOLCHAIN, VSCE_TOOLCHAIN_ROOT_ENV, VSCE_TOOLCHAIN_REFRESH_ENV
} from '../scripts/vscode-dev.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Reproduce the old permissive seal to prove an external symlink target was not covered by it. */
function permissiveTreeDigest(directory) {
  const digest = createHash('sha256');
  const visit = (absolute, relative) => {
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink()) {
      digest.update(`L\0${relative}\0${readlinkSync(absolute)}\0`);
      return;
    }
    if (metadata.isDirectory()) {
      digest.update(`D\0${relative}\0`);
      const entries = readdirSync(absolute)
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      for (const entry of entries) visit(path.join(absolute, entry), `${relative}/${entry}`);
      return;
    }
    const bytes = readFileSync(absolute);
    digest.update(`F\0${relative}\0${metadata.mode & 0o777}\0${bytes.length}\0`);
    digest.update(bytes);
    digest.update('\0');
  };
  for (const entry of ['package.json', 'package-lock.json', 'node_modules']) {
    visit(path.join(directory, entry), entry);
  }
  return `sha256:${digest.digest('hex')}`;
}

/**
 * A stand-in `npm` that materialises the pinned tree from the staging package.json.
 *
 * It counts its invocations into $STUB_NPM_COUNT and can stall via $STUB_NPM_DELAY_MS, which is
 * what makes "the second resolve performs zero installs" and the rename race provable.
 */
const STUB_NPM = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const counter = process.env.STUB_NPM_COUNT;
if (process.argv[2] !== 'ci') throw new Error('VSCE toolchain installs must use npm ci');
if (counter) {
  let n = 0;
  try { n = Number(fs.readFileSync(counter, 'utf8')) || 0; } catch {}
  fs.writeFileSync(counter, String(n + 1));
}
const until = Date.now() + Number(process.env.STUB_NPM_DELAY_MS || 0);
while (Date.now() < until) {}
const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf8'));
const pins = { '@vscode/vsce': manifest.dependencies['@vscode/vsce'], ...manifest.overrides };
const allowed = (values, current) => !Array.isArray(values) || values.length === 0
  || (!values.includes('!' + current)
    && (!values.some(value => !value.startsWith('!')) || values.includes(current)));
for (const [relative, metadata] of Object.entries(lock.packages)) {
  if (!relative || metadata.link || metadata.dev
    || !allowed(metadata.os, process.platform) || !allowed(metadata.cpu, process.arch)) continue;
  const dir = path.join(process.cwd(), ...relative.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const pkg = { name: metadata.name || relative.split('/').pop(), version: metadata.version };
  if (relative === 'node_modules/@vscode/vsce') {
    pkg.bin = { vsce: 'vsce' };
    fs.writeFileSync(path.join(dir, 'vsce'), '// stub vsce\\n');
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
}
for (const [name, version] of Object.entries(pins)) {
  const suffix = 'node_modules/' + name;
  const resolved = Object.entries(lock.packages).some(([relative, metadata]) =>
    (relative === suffix || relative.endsWith('/' + suffix)) && metadata.version === version);
  if (!resolved) {
    throw new Error('package lock does not resolve ' + name + '@' + version);
  }
}
`;

async function harness() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-vsce-cache-'));
  const bin = path.join(base, 'bin');
  await mkdir(bin, { recursive: true });
  const stub = path.join(bin, 'npm');
  await writeFile(stub, STUB_NPM);
  await chmod(stub, 0o755);
  const counter = path.join(base, 'installs');
  const cacheRoot = path.join(base, 'cache');
  return {
    base, cacheRoot, counter,
    async installs() {
      return Number(await readFile(counter, 'utf8').catch(() => '0')) || 0;
    },
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      [VSCE_TOOLCHAIN_ROOT_ENV]: cacheRoot,
      STUB_NPM_COUNT: counter
    }
  };
}

/** Run the body with process.env temporarily overlaid, restoring exactly what was there. */
async function withEnv(overlay, body) {
  const saved = new Map(Object.keys(overlay).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overlay);
  try {
    return await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('the second resolve performs zero installs and returns the verified cache', async () => {
  const h = await harness();
  await withEnv(h.env, async () => {
    const first = await resolveVsce();
    assert.equal(first.cached, false, 'the first resolve must install');
    assert.equal(await h.installs(), 1);
    if (process.platform !== 'win32') {
      assert.equal((await stat(h.cacheRoot)).mode & 0o777, 0o700,
        'per-user toolchain cache must not be writable by another account');
    }

    const second = await resolveVsce();
    assert.equal(second.cached, true, 'the second resolve must reuse the cache');
    assert.equal(await h.installs(), 1, 'a cache hit ran npm again');
    assert.equal(second.entry, first.entry);
    assert.match(second.entry, /@vscode[\\/]vsce[\\/]vsce$/);
  });
});

test('a forged seal cannot authorize a mutable external package symlink', async () => {
  const h = await harness();
  await withEnv(h.env, async () => {
    const first = await resolveVsce();
    const packageDirectory = path.join(first.directory, 'node_modules', '@vscode', 'vsce');
    const external = path.join(h.base, 'external-vsce');
    await rename(packageDirectory, external);
    await symlink(external, packageDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    const sealPath = path.join(first.directory, '.singularity-flow-vsce-seal.json');
    const seal = JSON.parse(await readFile(sealPath, 'utf8'));
    seal.treeSha256 = permissiveTreeDigest(first.directory);
    await writeFile(sealPath, `${JSON.stringify(seal, null, 2)}\n`);
    const oldSeal = permissiveTreeDigest(first.directory);
    await writeFile(path.join(external, 'vsce'), '// attacker-controlled replacement\n');
    assert.equal(permissiveTreeDigest(first.directory), oldSeal,
      'fixture did not demonstrate the old link-only seal bypass');

    const repaired = await resolveVsce();
    assert.equal(repaired.cached, false, 'external package symlink was accepted as cached closure');
    assert.notEqual(repaired.directory, first.directory);
    assert.equal(await readFile(repaired.entry, 'utf8'), '// stub vsce\n');
    assert.equal(await h.installs(), 2);
  });
});

test('a cache hit still sweeps staging left by a crashed installer', async () => {
  const h = await harness();
  await withEnv(h.env, async () => {
    await resolveVsce();
    const deadPid = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('close', () => resolve(child.pid));
    });
    const abandoned = path.join(h.cacheRoot, `${vsceToolchainKey()}.staging-${deadPid}-abandoned`);
    await mkdir(abandoned);

    const cached = await resolveVsce();
    assert.equal(cached.cached, true);
    assert.equal(existsSync(abandoned), false, 'cache-hit fast path left dead staging behind');
    assert.equal(await h.installs(), 1);
  });
});

test('version drift or byte tampering anywhere in the cached closure forces reinstall', async () => {
  const h = await harness();
  await withEnv(h.env, async () => {
    const first = await resolveVsce();
    // Tamper with a pinned version — the exact drift the verification loop exists to catch.
    const manifest = path.join(first.directory, 'node_modules', '@azure', 'identity', 'package.json');
    await writeFile(manifest, JSON.stringify({ name: '@azure/identity', version: '0.0.0' }));

    const repaired = await resolveVsce();
    assert.equal(repaired.cached, false, 'a corrupt tree must be rebuilt, not trusted');
    assert.equal(await h.installs(), 2);
    assert.notEqual(repaired.directory, first.directory,
      'a corrupt immutable generation must not be replaced in place');
    const repairedManifest = path.join(
      repaired.directory, 'node_modules', '@azure', 'identity', 'package.json');
    assert.equal(JSON.parse(await readFile(repairedManifest, 'utf8')).version, VSCE_TOOLCHAIN.identity);

    const unpinned = path.join(repaired.directory, 'node_modules', 'semver', 'package.json');
    await writeFile(unpinned, `${await readFile(unpinned, 'utf8')} `);
    const resealed = await resolveVsce();
    assert.equal(resealed.cached, false, 'tampering in an unpinned transitive package was trusted');
    assert.equal(await h.installs(), 3);
    assert.notEqual(resealed.directory, repaired.directory,
      'tampering in a prior generation caused an in-place replacement');
  });
});

test('an occupied empty content path is preserved instead of being replaced by POSIX rename', async () => {
  const h = await harness();
  await withEnv(h.env, async () => {
    const first = await resolveVsce();
    await rm(first.directory, { recursive: true });
    await mkdir(first.directory);

    const repaired = await resolveVsce();
    assert.notEqual(repaired.directory, first.directory);
    assert.match(repaired.directory, /-recovery-/);
    assert.deepEqual(await readdir(first.directory), [], 'occupied generation was replaced in place');
    assert.equal(existsSync(repaired.entry), true);
    assert.equal(await h.installs(), 2);
  });
});

test('legacy truncated generation names are retained but never selected as publication authority', async () => {
  const h = await harness();
  await withEnv(h.env, async () => {
    const first = await resolveVsce();
    const digest = path.basename(first.directory).split('-')[1];
    const legacy = path.join(h.cacheRoot, `${vsceToolchainKey()}-${digest.slice(0, 12)}`);
    await rename(first.directory, legacy);

    const migrated = await resolveVsce();
    assert.notEqual(migrated.directory, legacy);
    assert.match(path.basename(migrated.directory), /^[0-9a-f]{12}-[0-9a-f]{64}$/);
    assert.equal(existsSync(legacy), true, 'legacy generation was deleted during migration');
    assert.equal(await h.installs(), 2);
  });
});

test('the committed lock digest and install boundaries define the cache identity', async () => {
  const lockBytes = await readFile(path.join(repoRoot, 'toolchains', 'vsce', 'package-lock.json'));
  const lockDigest = createHash('sha256').update(lockBytes).digest('hex');
  const expectedKey = (registry) => createHash('sha256').update(JSON.stringify({
    lockDigest,
    registry,
    nodeMajor: process.versions.node.split('.')[0],
    platform: process.platform,
    architecture: process.arch
  })).digest('hex').slice(0, 12);

  const lock = JSON.parse(lockBytes);
  assert.deepEqual(lock.packages[''].dependencies, { '@vscode/vsce': VSCE_TOOLCHAIN.vsce });
  for (const [name, version] of [
    ['@vscode/vsce', VSCE_TOOLCHAIN.vsce],
    ['@azure/identity', VSCE_TOOLCHAIN.identity],
    ['@azure/msal-node', VSCE_TOOLCHAIN.msalNode],
    ['@azure/msal-browser', VSCE_TOOLCHAIN.msalBrowser],
    ['@azure/msal-common', VSCE_TOOLCHAIN.msalCommon]
  ]) {
    const resolved = lock.packages[`node_modules/${name}`];
    assert.equal(resolved?.version, version, `${name} is not locked to the declared version`);
    assert.match(resolved?.integrity ?? '', /^sha512-/, `${name} has no locked tarball integrity`);
  }
  for (const [name, [version, engine]] of Object.entries({
    '@azure/abort-controller': ['2.1.2', '>=18.0.0'],
    '@azure/core-auth': ['1.10.1', '>=20.0.0'],
    '@azure/core-client': ['1.10.1', '>=20.0.0'],
    '@azure/core-rest-pipeline': ['1.24.0', '>=20.0.0'],
    '@azure/core-tracing': ['1.3.0', '>=20.0.0'],
    '@azure/core-util': ['1.13.1', '>=20.0.0'],
    '@azure/logger': ['1.3.0', '>=20.0.0'],
    '@typespec/ts-http-runtime': ['0.3.1', '>=20.0.0']
  })) {
    const suffix = `node_modules/${name}`;
    const [, resolved] = Object.entries(lock.packages).find(([relative, metadata]) =>
      (relative === suffix || relative.endsWith(`/${suffix}`)) && metadata.version === version) ?? [];
    assert.equal(resolved?.version, version, `${name} is not locked to its Node 20-compatible release`);
    assert.equal(resolved?.engines?.node, engine, `${name}@${version} changed its Node support range`);
  }

  const h = await harness();
  const mirrorKey = expectedKey('https://artifactory.example.test/npm/');
  await withEnv({ ...h.env, NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/' }, async () => {
    const publicKey = expectedKey('https://registry.npmjs.org/');
    assert.equal(vsceToolchainKey(), publicKey);
    const first = await resolveVsce();
    assert.deepEqual(await readFile(path.join(first.directory, 'package-lock.json')), lockBytes,
      'the cache did not retain the exact committed install authority');
    await withEnv({ NPM_CONFIG_REGISTRY: 'https://artifactory.example.test/npm/' }, async () => {
      assert.equal(vsceToolchainKey(), mirrorKey);
      assert.notEqual(mirrorKey, publicKey, 'a registry change crossed the cache trust boundary');
      const mirrored = await resolveVsce();
      assert.equal(mirrored.cached, false);
      assert.notEqual(mirrored.directory, first.directory);
    });
    assert.equal(await h.installs(), 2);
    const generations = (await readdir(h.cacheRoot)).filter((name) =>
      name.startsWith(`${publicKey}-`) || name.startsWith(`${mirrorKey}-`));
    assert.equal(generations.length, 2);
  });
});

test('the refresh escape hatch reinstalls even over a healthy cache', async () => {
  const h = await harness();
  await withEnv(h.env, async () => {
    await resolveVsce();
    await withEnv({ [VSCE_TOOLCHAIN_REFRESH_ENV]: '1' }, async () => {
      const refreshed = await resolveVsce();
      assert.equal(refreshed.cached, false);
    });
    assert.equal(await h.installs(), 2);
  });
});

test('a crashed publication claim is recovered without replacing its completed generation', async () => {
  const h = await harness();
  await withEnv(h.env, async () => {
    const first = await resolveVsce();
    const deadPid = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('close', () => resolve(child.pid));
    });
    const generationName = path.basename(first.directory);
    const ownerName = `${generationName}.publish-owner-${deadPid}-crashed`;
    const lock = path.join(h.cacheRoot, `${generationName}.publish-lock`);
    await writeFile(lock, JSON.stringify({
      pid: deadPid, token: 'crashed', ownerName, createdAt: Date.now()
    }));

    const refreshed = await resolveVsce({ refresh: true });
    assert.equal(refreshed.directory, first.directory);
    assert.equal(existsSync(first.entry), true);
    assert.equal(existsSync(lock), false);
    assert.equal(await h.installs(), 2);
  });
});

test('a staggered refresh never removes the generation an earlier caller is about to use', async () => {
  const h = await harness();
  await withEnv(h.env, async () => {
    const first = await resolveVsce();
    const initialEntry = await readFile(first.entry);
    const initialMetadata = await stat(first.entry);
    const driver = path.join(h.base, 'refresh-driver.mjs');
    await writeFile(driver, `
      import { resolveVsce } from ${JSON.stringify(path.join(repoRoot, 'scripts', 'vscode-dev.mjs'))};
      const result = await resolveVsce();
      console.log(JSON.stringify(result));
    `);
    const done = new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [driver], {
        env: {
          ...process.env,
          ...h.env,
          [VSCE_TOOLCHAIN_REFRESH_ENV]: '1',
          STUB_NPM_DELAY_MS: '600'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('close', (code) => code === 0
        ? resolve(JSON.parse(out.trim().split('\n').pop()))
        : reject(new Error(`refresh driver exited ${code}: ${err}`)));
    });
    const deadline = Date.now() + 5_000;
    while (await h.installs() < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(await h.installs(), 2, 'refresh never entered its install window');
    assert.equal(existsSync(first.entry), true,
      'refresh removed the entry path after an earlier resolver returned it');
    const refreshed = await done;
    assert.equal(refreshed.directory, first.directory,
      'a deterministic refresh should reuse the identical immutable generation');
    assert.equal(existsSync(first.entry), true, 'refresh removed the earlier immutable generation');
    assert.deepEqual(await readFile(first.entry), initialEntry, 'refresh changed the live entry bytes');
    const finalMetadata = await stat(first.entry);
    assert.equal(finalMetadata.dev, initialMetadata.dev);
    assert.equal(finalMetadata.ino, initialMetadata.ino, 'refresh replaced the live entry inode');
  });
});

test('two concurrent resolves race safely: both succeed, one tree, no staging debris', async () => {
  /**
   * The rename is the arbiter. The loser must find the winner's verified tree and use it — the
   * subject-lock module documents what happens when this is done with delete-then-create instead.
   */
  const h = await harness();
  const driver = path.join(h.base, 'driver.mjs');
  await writeFile(driver, `
    import { resolveVsce } from ${JSON.stringify(path.join(repoRoot, 'scripts', 'vscode-dev.mjs'))};
    const result = await resolveVsce();
    console.log(JSON.stringify({ cached: result.cached, entry: result.entry }));
  `);
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [driver], {
      env: { ...process.env, ...h.env, STUB_NPM_DELAY_MS: '400' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => code === 0
      ? resolve(JSON.parse(out.trim().split('\n').pop()))
      : reject(new Error(`driver exited ${code}: ${err}`)));
  });

  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(a.entry, b.entry, 'both processes must agree on one tree');
  const names = await readdir(h.cacheRoot);
  assert.equal(names.filter((name) => /^[0-9a-f]{12}-[0-9a-f]{12}/.test(name)).length, 1,
    'exactly one sealed generation');
  assert.equal(names.filter((name) => name.includes('.staging-')).length, 0, 'staging debris survived the race');
  assert.equal(names.filter((name) => name.includes('.publish-')).length, 0,
    'publication lock debris survived the race');
});

test('immutable final generations are retained because another process may still use them', async () => {
  const h = await harness();
  await withEnv(h.env, async () => {
    // Simulate prior keys, then install the current one. Only abandoned staging is swept.
    await mkdir(path.join(h.cacheRoot, 'aaaaaaaaaaaa'), { recursive: true });
    await mkdir(path.join(h.cacheRoot, 'bbbbbbbbbbbb'), { recursive: true });
    await resolveVsce();
    const names = await readdir(h.cacheRoot);
    assert.ok(names.includes('aaaaaaaaaaaa'));
    assert.ok(names.includes('bbbbbbbbbbbb'));
    assert.ok(names.some((name) => name.startsWith(`${vsceToolchainKey()}-`)),
      'the current immutable generation was not published');
  });
});
