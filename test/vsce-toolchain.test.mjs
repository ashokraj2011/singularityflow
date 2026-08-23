/**
 * The VSCE toolchain cache: installed at most once per (pins, registry, Node major).
 *
 * The previous `resolveVsce` installed the pinned toolchain into a fresh temp directory on every
 * run and deleted it afterwards — 292 registry fetches and ~5 minutes per install, to re-create a
 * tree whose content the pin verification had already approved. These tests drive the cache with a
 * stub `npm` on PATH, so they prove the install-count behaviour without any network.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  resolveVsce, vsceToolchainKey, VSCE_TOOLCHAIN, VSCE_TOOLCHAIN_ROOT_ENV, VSCE_TOOLCHAIN_REFRESH_ENV
} from '../scripts/vscode-dev.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
if (counter) {
  let n = 0;
  try { n = Number(fs.readFileSync(counter, 'utf8')) || 0; } catch {}
  fs.writeFileSync(counter, String(n + 1));
}
const until = Date.now() + Number(process.env.STUB_NPM_DELAY_MS || 0);
while (Date.now() < until) {}
const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
const pins = { '@vscode/vsce': manifest.dependencies['@vscode/vsce'], ...manifest.overrides };
for (const [name, version] of Object.entries(pins)) {
  const dir = path.join(process.cwd(), 'node_modules', ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const pkg = { name, version };
  if (name === '@vscode/vsce') { pkg.bin = { vsce: 'vsce' }; fs.writeFileSync(path.join(dir, 'vsce'), '// stub vsce\\n'); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
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

    const second = await resolveVsce();
    assert.equal(second.cached, true, 'the second resolve must reuse the cache');
    assert.equal(await h.installs(), 1, 'a cache hit ran npm again');
    assert.equal(second.entry, first.entry);
    assert.match(second.entry, /@vscode[\\/]vsce[\\/]vsce$/);
  });
});

test('a corrupted cached tree fails verification and is reinstalled', async () => {
  const h = await harness();
  await withEnv(h.env, async () => {
    const first = await resolveVsce();
    // Tamper with a pinned version — the exact drift the verification loop exists to catch.
    const manifest = path.join(first.directory, 'node_modules', '@azure', 'identity', 'package.json');
    await writeFile(manifest, JSON.stringify({ name: '@azure/identity', version: '0.0.0' }));

    const repaired = await resolveVsce();
    assert.equal(repaired.cached, false, 'a corrupt tree must be rebuilt, not trusted');
    assert.equal(await h.installs(), 2);
    assert.equal(JSON.parse(await readFile(manifest, 'utf8')).version, VSCE_TOOLCHAIN.identity);
  });
});

test('the registry is part of the identity, so a different registry is a different tree', async () => {
  const h = await harness();
  await withEnv({ ...h.env, NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/' }, async () => {
    const publicKey = vsceToolchainKey();
    await resolveVsce();
    await withEnv({ NPM_CONFIG_REGISTRY: 'https://artifactory.example.test/npm/' }, async () => {
      assert.notEqual(vsceToolchainKey(), publicKey,
        'the same pins from a different registry are a different trust decision');
      const mirrored = await resolveVsce();
      assert.equal(mirrored.cached, false);
    });
    assert.equal(await h.installs(), 2);
    const keys = (await readdir(h.cacheRoot)).filter((name) => /^[0-9a-f]{12}$/.test(name));
    assert.equal(keys.length, 2, 'both registries keep their own verified tree');
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
  assert.equal(names.filter((name) => /^[0-9a-f]{12}$/.test(name)).length, 1, 'exactly one key directory');
  assert.equal(names.filter((name) => name.includes('.staging-')).length, 0, 'staging debris survived the race');
});

test('older toolchains are pruned to one predecessor, so pin bumps cannot hoard disk', async () => {
  const h = await harness();
  await withEnv(h.env, async () => {
    // Simulate two prior keys, then install the current one.
    await mkdir(path.join(h.cacheRoot, 'aaaaaaaaaaaa'), { recursive: true });
    await mkdir(path.join(h.cacheRoot, 'bbbbbbbbbbbb'), { recursive: true });
    await resolveVsce();
    const keys = (await readdir(h.cacheRoot)).filter((name) => /^[0-9a-f]{12}$/.test(name));
    assert.equal(keys.length, 2, `expected current + one predecessor, found: ${keys.join(', ')}`);
    assert.ok(keys.includes(vsceToolchainKey()), 'the current key must survive its own prune');
  });
});
