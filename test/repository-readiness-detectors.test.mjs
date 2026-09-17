import assert from 'node:assert/strict';
import test from 'node:test';

import { runSmartInitDetectors } from '../src/initialization/detectors.mjs';

function snapshot(files) {
  return {
    entries: Object.entries(files).map(([file, content], index) => ({
      path: file,
      kind: file.endsWith('.lockb') ? 'binary-manifest' : 'manifest',
      sha256: `sha256:${String(index + 1).padStart(64, '0')}`,
      content: file.endsWith('.lockb') ? null : content
    }))
  };
}

function nodeDetection({ manager, lockName, scripts = {} }) {
  const manifest = {
    name: 'readiness-fixture',
    ...(manager ? { packageManager: `${manager}@1.0.0` } : {}),
    scripts
  };
  return runSmartInitDetectors(snapshot({
    'package.json': `${JSON.stringify(manifest)}\n`,
    [lockName]: lockName.endsWith('.lockb') ? Buffer.from([0]) : 'lock data\n'
  }));
}

test('lockfile-backed Node package managers produce deterministic dependency restores', () => {
  const cases = [
    ['npm', 'package-lock.json', ['ci']],
    ['npm', 'npm-shrinkwrap.json', ['ci']],
    ['pnpm', 'pnpm-lock.yaml', ['install', '--frozen-lockfile']],
    ['yarn', 'yarn.lock', ['install', '--frozen-lockfile']],
    ['bun', 'bun.lockb', ['install', '--frozen-lockfile']]
  ];

  for (const [manager, lockName, args] of cases) {
    const detected = nodeDetection({ manager, lockName });
    assert.equal(detected.commands.dependency.length, 1, `${manager} dependency command`);
    assert.equal(detected.commands.dependency[0].launcher, manager);
    assert.deepEqual(detected.commands.dependency[0].args, args);
    assert.equal(detected.commands.dependency[0].required, true);
    assert.equal(detected.commands.dependency[0].timeoutMs, 600_000);
  }
});

test('dependency restore is absent without the selected manager lockfile', () => {
  const detected = runSmartInitDetectors(snapshot({
    'package.json': `${JSON.stringify({
      name: 'no-lock', packageManager: 'npm@10.0.0', scripts: { test: 'node --test' }
    })}\n`
  }));

  assert.deepEqual(detected.commands.dependency, []);
  assert.equal(detected.commands.verification.length, 1);
});

test('competing Node lockfiles are a dependency ambiguity, not a test ambiguity', () => {
  const detected = runSmartInitDetectors(snapshot({
    'package.json': `${JSON.stringify({ name: 'ambiguous', scripts: { test: 'node --test' } })}\n`,
    'package-lock.json': '{}\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n'
  }));
  const ambiguity = detected.ambiguities.find((entry) => entry.id === 'node-package-manager:.');
  assert.ok(ambiguity);
  assert.equal(ambiguity.purpose, 'dependency');
});

test('canonical start is preferred and command metadata never contains the script body', () => {
  const secretBody = 'node server.mjs --token do-not-copy-this';
  const detected = nodeDetection({
    manager: 'npm', lockName: 'package-lock.json',
    scripts: { start: secretBody, dev: 'vite --host 0.0.0.0' }
  });

  assert.equal(detected.commands.start.length, 1);
  assert.deepEqual(detected.commands.start[0].args, ['start']);
  assert.equal(detected.commands.start[0].required, false);
  assert.equal(detected.commands.start[0].timeoutMs, 15_000);
  assert.equal(detected.commands.start[0].observationMs, 5_000);
  assert.equal(detected.commands.start[0].shutdownGraceMs, 2_000);
  assert.doesNotMatch(JSON.stringify(detected.commands), /do-not-copy-this|server\.mjs|0\.0\.0\.0/);
  assert.equal(detected.ambiguities.some((entry) => entry.id === 'node-start-script:.'), false);
});

test('one declared start alias is selected and no start script produces no candidate', () => {
  const alias = nodeDetection({
    manager: 'pnpm', lockName: 'pnpm-lock.yaml', scripts: { dev: 'vite' }
  });
  assert.equal(alias.commands.start.length, 1);
  assert.deepEqual(alias.commands.start[0].args, ['run', 'dev']);

  const absent = nodeDetection({
    manager: 'yarn', lockName: 'yarn.lock', scripts: { test: 'node --test' }
  });
  assert.deepEqual(absent.commands.start, []);
  assert.equal(absent.ambiguities.some((entry) => entry.purpose === 'start'), false);
});

test('multiple noncanonical start aliases remain explicit ambiguity', () => {
  const detected = nodeDetection({
    manager: 'bun', lockName: 'bun.lock',
    scripts: { dev: 'bun app.ts', serve: 'bun server.ts', preview: 'bun preview.ts' }
  });

  assert.deepEqual(detected.commands.start, []);
  const ambiguity = detected.ambiguities.find((entry) => entry.id === 'node-start-script:.');
  assert.ok(ambiguity);
  assert.equal(ambiguity.purpose, 'start');
  assert.deepEqual(ambiguity.candidates, ['dev', 'preview', 'serve']);
  assert.doesNotMatch(JSON.stringify(ambiguity), /app\.ts|server\.ts|preview\.ts/);
});
