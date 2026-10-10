import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { releaseDependencyLockProblems, workspaceDependencyLockProblems } from '../src/release-dependency-lock.mjs';
import { resolvePlatformProcess } from '../src/platform-process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture() {
  const integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
  return {
    manifest: {
      name: 'private-release-toolchain',
      version: '1.0.0',
      private: true,
      license: 'UNLICENSED',
      dependencies: { packer: '1.2.3' },
      overrides: { nested: '4.5.6' }
    },
    lock: {
      name: 'private-release-toolchain',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'private-release-toolchain',
          version: '1.0.0',
          license: 'UNLICENSED',
          dependencies: { packer: '1.2.3' }
        },
        'node_modules/packer': {
          version: '1.2.3',
          resolved: 'https://registry.npmjs.org/packer/-/packer-1.2.3.tgz',
          integrity
        },
        'node_modules/packer/node_modules/nested': {
          version: '4.5.6',
          resolved: 'https://registry.npmjs.org/nested/-/nested-4.5.6.tgz',
          integrity
        }
      }
    }
  };
}

function problems(input) {
  return releaseDependencyLockProblems(input.manifest, input.lock, {
    label: 'fixture toolchain', requirePrivate: true, registryEntries: 'all', validateOverrides: true
  });
}

test('release dependency lock accepts exact manifest, direct pin, override, and archive integrity', () => {
  assert.deepEqual(problems(fixture()), []);
});

test('release dependency lock rejects manifest-to-lock range drift and installed-version drift', () => {
  const rootDrift = fixture();
  rootDrift.lock.packages[''].dependencies.packer = '^1.2.3';
  assert.match(problems(rootDrift).join('\n'), /dependencies does not exactly match/);

  const installedDrift = fixture();
  installedDrift.lock.packages['node_modules/packer'].version = '1.2.4';
  assert.match(problems(installedDrift).join('\n'), /locked packer version '1\.2\.4'/);

  const rangedManifest = fixture();
  rangedManifest.manifest.dependencies.packer = '^1.2.3';
  rangedManifest.lock.packages[''].dependencies.packer = '^1.2.3';
  assert.match(problems(rangedManifest).join('\n'), /must use an exact version/);
});

test('release dependency lock rejects lock identity, override, and integrity drift', () => {
  const identity = fixture();
  identity.lock.name = 'different-toolchain';
  assert.match(problems(identity).join('\n'), /top-level name does not match/);

  const override = fixture();
  override.lock.packages['node_modules/packer/node_modules/nested'].version = '4.5.7';
  assert.match(problems(override).join('\n'), /override nested resolved to '4\.5\.7'/);

  const integrity = fixture();
  delete integrity.lock.packages['node_modules/packer'].integrity;
  assert.match(problems(integrity).join('\n'), /must bind an HTTPS archive and SHA-512 integrity/);
});

test('release dependency lock requires the complete root bundle declaration and lock markers', () => {
  const bundled = fixture();
  bundled.manifest.bundleDependencies = ['packer'];
  bundled.lock.packages[''].bundleDependencies = ['packer'];
  bundled.lock.packages['node_modules/packer'].inBundle = true;
  bundled.lock.packages['node_modules/packer/node_modules/nested'].inBundle = true;
  assert.deepEqual(releaseDependencyLockProblems(bundled.manifest, bundled.lock, {
    label: 'fixture package', requireBundled: true, registryEntries: 'production'
  }), []);

  delete bundled.lock.packages['node_modules/packer'].inBundle;
  assert.match(releaseDependencyLockProblems(bundled.manifest, bundled.lock, {
    label: 'fixture package', requireBundled: true, registryEntries: 'production'
  }).join('\n'), /must be marked inBundle/);
});

test('release dependency lock does not let an arbitrary inBundle marker erase archive authority', () => {
  const bundled = fixture();
  bundled.lock.packages['node_modules/packer'].inBundle = true;
  delete bundled.lock.packages['node_modules/packer'].resolved;
  delete bundled.lock.packages['node_modules/packer'].integrity;
  assert.match(problems(bundled).join('\n'), /must bind an HTTPS archive and SHA-512 integrity/);

  const npm = fixture();
  npm.manifest.dependencies = { npm: '11.8.0' };
  npm.lock.packages[''].dependencies = { npm: '11.8.0' };
  npm.lock.packages = {
    '': npm.lock.packages[''],
    'node_modules/npm': {
      version: '11.8.0',
      resolved: 'https://registry.npmjs.org/npm/-/npm-11.8.0.tgz',
      integrity: `sha512-${Buffer.alloc(64).toString('base64')}`
    },
    'node_modules/npm/node_modules/nested': {
      version: '4.5.6', inBundle: true
    }
  };
  delete npm.manifest.overrides;
  assert.deepEqual(releaseDependencyLockProblems(npm.manifest, npm.lock, {
    label: 'npm toolchain', requirePrivate: true, registryEntries: 'all', allowNpmBundledClosure: true
  }), []);
});

test('release dependency lock validates complete SRI, dev archives, links, and transitive bundles', () => {
  const malformed = fixture();
  malformed.lock.packages['node_modules/packer'].integrity = 'sha512-';
  malformed.lock.packages['node_modules/dev-only'] = {
    version: '1.0.0', dev: true, resolved: 'https://', integrity: 'sha512-'
  };
  malformed.lock.packages['node_modules/workspace'] = { link: true, resolved: 'workspace' };
  const result = problems(malformed).join('\n');
  assert.match(result, /node_modules\/packer must bind/);
  assert.match(result, /node_modules\/dev-only must bind/);
  assert.match(result, /node_modules\/workspace must not be a mutable link/);

  const transitive = fixture();
  transitive.manifest.bundleDependencies = ['packer'];
  transitive.lock.packages[''].bundleDependencies = ['packer'];
  transitive.lock.packages['node_modules/packer'].inBundle = true;
  assert.match(releaseDependencyLockProblems(transitive.manifest, transitive.lock, {
    label: 'fixture package', requireBundled: true, registryEntries: 'production'
  }).join('\n'), /production lock entry node_modules\/packer\/node_modules\/nested must be marked inBundle/);
});

function workspaceFixture() {
  const input = fixture();
  input.manifest.workspaces = ['apps/editor'];
  input.lock.packages[''].workspaces = ['apps/editor'];
  input.workspaces = {
    'apps/editor': {
      name: 'editor-workspace', version: '1.0.0',
      devDependencies: { compiler: '^2.0.0', packer: '1.2.3' }
    }
  };
  input.lock.packages['apps/editor'] = structuredClone(input.workspaces['apps/editor']);
  input.lock.packages['node_modules/editor-workspace'] = { link: true, resolved: 'apps/editor' };
  input.lock.packages['node_modules/compiler'] = {
    version: '2.0.1', dev: true, dependencies: { types: '~3.0.0' },
    optionalDependencies: { 'compiler-platform': '2.0.1' }
  };
  input.lock.packages['node_modules/types'] = { version: '3.0.2', dev: true };
  input.lock.packages['node_modules/compiler-platform'] = { version: '2.0.1', dev: true, optional: true };
  return input;
}

function workspaceProblems(input) {
  return workspaceDependencyLockProblems(input.manifest, input.lock, input.workspaces);
}

test('source lock accepts workspace tools hoisted alongside bundled runtime dependencies', () => {
  assert.deepEqual(workspaceProblems(workspaceFixture()), []);
});

test('source lock rejects a production-only lock even when workspace metadata remains', () => {
  const input = workspaceFixture();
  for (const location of [
    'node_modules/editor-workspace', 'node_modules/compiler', 'node_modules/types',
    'node_modules/compiler-platform'
  ]) delete input.lock.packages[location];
  const result = workspaceProblems(input).join('\n');
  assert.match(result, /missing the exact workspace link/);
  assert.match(result, /apps\/editor devDependencies compiler is missing/);
});

test('source lock validates workspace metadata and the exact local link target', () => {
  const missing = workspaceFixture();
  delete missing.lock.packages['apps/editor'];
  assert.match(workspaceProblems(missing).join('\n'), /missing workspace apps\/editor/);
  const drift = workspaceFixture();
  drift.lock.packages['apps/editor'].devDependencies.compiler = '^4.0.0';
  assert.match(workspaceProblems(drift).join('\n'), /devDependencies does not exactly match/);
  const link = workspaceFixture();
  link.lock.packages['node_modules/editor-workspace'].resolved = 'apps/other';
  assert.match(workspaceProblems(link).join('\n'), /exact workspace link/);
  link.lock.packages['node_modules/editor-workspace'] = { version: '1.0.0' };
  assert.match(workspaceProblems(link).join('\n'), /exact workspace link/);
});

test('source lock rejects missing manifests and undeclared workspace manifests', () => {
  const input = workspaceFixture();
  assert.match(workspaceDependencyLockProblems(input.manifest, input.lock, {}).join('\n'), /no manifest supplied/);
  input.manifest.workspaces = [];
  assert.match(workspaceProblems(input).join('\n'), /is not declared/);
});

test('source lock rejects missing transitive and optional platform dependencies', () => {
  const input = workspaceFixture();
  delete input.lock.packages['node_modules/types'];
  delete input.lock.packages['node_modules/compiler-platform'];
  const result = workspaceProblems(input).join('\n');
  assert.match(result, /node_modules\/compiler dependencies types is missing/);
  assert.match(result, /optionalDependencies compiler-platform is missing/);
});

test('source lock resolves workspace-local and nested dependencies and checks exact pins', () => {
  const input = workspaceFixture();
  input.lock.packages['apps/editor/node_modules/compiler'] = input.lock.packages['node_modules/compiler'];
  delete input.lock.packages['node_modules/compiler'];
  input.lock.packages['apps/editor/node_modules/compiler/node_modules/types'] = input.lock.packages['node_modules/types'];
  delete input.lock.packages['node_modules/types'];
  assert.deepEqual(workspaceProblems(input), []);
  input.lock.packages['node_modules/compiler-platform'].version = '2.0.2';
  assert.match(workspaceProblems(input).join('\n'), /locked compiler-platform version does not equal '2\.0\.1'/);
});

test('committed source lock passes npm clean-install validation offline in a fresh directory', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-source-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'apps', 'vscode'), { recursive: true });
  for (const relative of ['package.json', 'package-lock.json', '.npmrc', 'apps/vscode/package.json']) {
    await copyFile(path.join(root, relative), path.join(directory, relative));
  }
  const before = await readFile(path.join(directory, 'package-lock.json'), 'utf8');
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const workspace = JSON.parse(await readFile(path.join(directory, 'apps/vscode/package.json'), 'utf8'));
  assert.deepEqual(workspaceDependencyLockProblems(manifest, JSON.parse(before), { 'apps/vscode': workspace }), []);
  const launch = resolvePlatformProcess('npm', [
    'ci', '--dry-run', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'
  ]);
  const result = spawnSync(launch.executable, launch.arguments, {
    cwd: directory, encoding: 'utf8', timeout: 30_000, ...launch.spawnOptions
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  assert.equal(await readFile(path.join(directory, 'package-lock.json'), 'utf8'), before,
    'clean installs must consume the committed lock, never repair it implicitly');
});
