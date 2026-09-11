import assert from 'node:assert/strict';
import test from 'node:test';

import { releaseDependencyLockProblems } from '../src/release-dependency-lock.mjs';

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
