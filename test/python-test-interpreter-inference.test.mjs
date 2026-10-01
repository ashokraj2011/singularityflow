import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inferModuleTestCommand } from '../src/code-delivery-tests.mjs';
import { inferRepositoryTestCommands } from '../src/repository-test-command-inference.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow python project with spaces '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
  return root;
}

async function venv(root, owner = '.', platform = 'linux', name = platform === 'win32' ? 'python.exe' : 'python3') {
  const directory = path.join(root, owner, '.venv');
  const scripts = platform === 'win32' ? 'Scripts' : 'bin';
  await mkdir(path.join(directory, scripts), { recursive: true });
  await writeFile(path.join(directory, 'pyvenv.cfg'), 'home = /system/python\nversion = 3.14.0\n');
  await writeFile(path.join(directory, scripts, name), 'fixture interpreter\n', { mode: 0o755 });
  return path.join(directory, scripts, name);
}

function pythonModule(root = '.') {
  return { root, system: 'python', manifest: 'pyproject.toml' };
}

test('repository readiness and code delivery select the project venv over PATH Python', {
  skip: process.platform === 'win32'
}, async (t) => {
  const root = await fixture(t);
  await venv(root);
  const direct = await inferModuleTestCommand(root, pythonModule(), { platform: 'linux' });
  const readiness = await inferRepositoryTestCommands(root, { platform: 'linux' });
  assert.deepEqual(direct.argv, [
    './.venv/bin/python3', '-B', '-m', 'pytest', '-p', 'no:cacheprovider',
    '--junitxml=.sflow/results/python-tests.xml'
  ]);
  assert.deepEqual(readiness[0].argv, direct.argv);
  assert.equal(direct.workingDirectory, '.');
  assert.equal(direct.result.path, '.sflow/results/python-tests.xml');
  await writeFile(path.join(root, '.venv', 'pyvenv.cfg'),
    'home = /system/python\nversion_info = 3.14.0.final.0\nvirtualenv = 20.0\n');
  assert.equal((await inferRepositoryTestCommands(root, { platform: 'linux' }))[0].argv[0],
    './.venv/bin/python3', 'virtualenv metadata is also a valid project environment');
});

test('module venv wins over repository venv and repository fallback stays relative on POSIX', {
  skip: process.platform === 'win32'
}, async (t) => {
  const root = await fixture(t);
  const moduleRoot = 'packages/a module';
  await mkdir(path.join(root, moduleRoot), { recursive: true });
  await venv(root);
  assert.equal((await inferModuleTestCommand(root, pythonModule(moduleRoot), {
    platform: 'linux'
  })).argv[0], '../../.venv/bin/python3');

  await venv(root, moduleRoot, 'linux', 'python');
  const nested = await inferModuleTestCommand(root, pythonModule(moduleRoot), {
    platform: 'linux'
  });
  assert.equal(nested.argv[0], './.venv/bin/python');
  assert.deepEqual(nested.argv.slice(1, 6), ['-B', '-m', 'pytest', '-p', 'no:cacheprovider']);
});

test('Windows inference chooses local Scripts interpreter and an absolute root fallback', async (t) => {
  const root = await fixture(t);
  const moduleRoot = 'packages/a module';
  await mkdir(path.join(root, moduleRoot), { recursive: true });
  const repositoryPython = await venv(root, '.', 'win32');
  const nestedFallback = await inferModuleTestCommand(root, pythonModule(moduleRoot), { platform: 'win32' });
  assert.equal(nestedFallback.argv[0], await realpath(repositoryPython));
  assert.equal(path.isAbsolute(nestedFallback.argv[0]), true);
  assert.ok(nestedFallback.argv[0].includes(' '), 'the executable remains one argv element despite spaces');

  await venv(root, moduleRoot, 'win32');
  const nestedLocal = await inferModuleTestCommand(root, pythonModule(moduleRoot), { platform: 'win32' });
  assert.equal(nestedLocal.argv[0], './.venv/Scripts/python.exe');
  assert.deepEqual(nestedLocal.argv.slice(1, 6), ['-B', '-m', 'pytest', '-p', 'no:cacheprovider']);
  const readiness = await inferRepositoryTestCommands(root, { platform: 'win32' });
  assert.equal(readiness[0].argv[0], './.venv/Scripts/python.exe');
});

test('missing or invalid venv falls back to the platform launcher', async (t) => {
  const root = await fixture(t);
  if (process.platform !== 'win32') {
    assert.deepEqual((await inferModuleTestCommand(root, pythonModule(), { platform: 'linux' })).argv.slice(0, 6), [
      'python3', '-B', '-m', 'pytest', '-p', 'no:cacheprovider'
    ]);
  }
  assert.deepEqual((await inferModuleTestCommand(root, pythonModule(), { platform: 'win32' })).argv.slice(0, 7), [
    'py', '-3', '-B', '-m', 'pytest', '-p', 'no:cacheprovider'
  ]);

  const scripts = process.platform === 'win32' ? 'Scripts' : 'bin';
  const executable = process.platform === 'win32' ? 'python.exe' : 'python3';
  await mkdir(path.join(root, '.venv', scripts), { recursive: true });
  await writeFile(path.join(root, '.venv', scripts, executable), 'not a venv\n', { mode: 0o755 });
  if (process.platform !== 'win32') {
    assert.equal((await inferModuleTestCommand(root, pythonModule(), { platform: 'linux' })).argv[0], 'python3');
  }
  assert.equal((await inferModuleTestCommand(root, pythonModule(), { platform: 'win32' })).argv[0], 'py');
  await writeFile(path.join(root, '.venv', 'pyvenv.cfg'), 'invalid metadata\n');
  if (process.platform !== 'win32') {
    assert.equal((await inferModuleTestCommand(root, pythonModule(), { platform: 'linux' })).argv[0], 'python3');
  }
  assert.equal((await inferModuleTestCommand(root, pythonModule(), { platform: 'win32' })).argv[0], 'py');
});

test('POSIX inference rejects a venv interpreter symlink to a non-Python executable', {
  skip: process.platform === 'win32'
}, async (t) => {
  const root = await fixture(t);
  const scripts = path.join(root, '.venv', 'bin');
  await mkdir(scripts, { recursive: true });
  await writeFile(path.join(root, '.venv', 'pyvenv.cfg'), 'home = /system/python\nversion = 3.14.0\n');
  const outside = path.join(root, 'other-tool');
  await writeFile(outside, 'fixture\n', { mode: 0o755 });
  await symlink(outside, path.join(scripts, 'python3'));
  assert.equal((await inferModuleTestCommand(root, pythonModule(), { platform: 'linux' })).argv[0], 'python3');
});

test('POSIX inference accepts a normal venv interpreter symlink', {
  skip: process.platform === 'win32'
}, async (t) => {
  const root = await fixture(t);
  const scripts = path.join(root, '.venv', 'bin');
  await mkdir(scripts, { recursive: true });
  await writeFile(path.join(root, '.venv', 'pyvenv.cfg'), 'home = /system/python\nversion = 3.14.0\n');
  const target = path.join(root, 'python3.14');
  await writeFile(target, 'fixture\n', { mode: 0o755 });
  await symlink(target, path.join(scripts, 'python3'));
  assert.equal((await inferModuleTestCommand(root, pythonModule(), { platform: 'linux' })).argv[0],
    './.venv/bin/python3');
});

test('a symlinked module outside the repository cannot supply a Python interpreter', {
  skip: process.platform === 'win32'
}, async (t) => {
  const root = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow external python module '));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await venv(outside);
  await mkdir(path.join(root, 'packages'), { recursive: true });
  await symlink(outside, path.join(root, 'packages', 'external'));
  await assert.rejects(
    () => inferModuleTestCommand(root, pythonModule('packages/external'), { platform: 'linux' }),
    (error) => error.code === 'REPOSITORY_PATH_UNSAFE'
  );
});
