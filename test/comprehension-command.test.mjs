import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function command(root, args) {
  return spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' });
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-comprehension-command-'));
  t.after(() => spawnSync('rm', ['-rf', root]));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'CMP Tester']);
  git(root, ['config', 'user.email', 'cmp@example.test']);
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), '{}\n');
  await writeFile(path.join(root, 'service.txt'), 'before\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'baseline']);
  await writeFile(path.join(root, 'service.txt'), 'after\n');
  await writeFile(path.join(root, 'new.txt'), 'new\n');
  return root;
}

test('comprehension regions is a model-free, read-only exact change projection', async (t) => {
  const root = await repository(t);
  const before = git(root, ['status', '--porcelain=v1']);
  const result = command(root, ['--no-model', 'comprehension', 'regions', '--base', 'HEAD', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.operation.id, 'comprehension.regions');
  assert.deepEqual(response.effects, {
    stateChanged: false,
    filesChanged: false,
    publicationCreated: false,
    externalSystemsChanged: false
  });
  assert.equal(response.data.mode, 'observe-only');
  assert.equal(response.data.context.repository, await realpath(root));
  assert.equal(response.data.manifest.granularity, 'resource');
  assert.equal(response.data.manifest.structuralAssurance, 'unavailable');
  assert.equal(response.data.manifest.counts.regions, 2);
  assert.deepEqual(
    response.data.manifest.regions.map((region) => region.location.pathAfter),
    ['new.txt', 'service.txt']
  );
  assert.equal(await lstat(path.join(root, '.git', 'singularity-flow', 'ast')).then(
    () => true,
    (error) => error?.code === 'ENOENT' ? false : Promise.reject(error)
  ), false);
  assert.equal(git(root, ['status', '--porcelain=v1']), before);
});

test('comprehension check reports incomplete coverage without turning observation into a gate', async (t) => {
  const root = await repository(t);
  const result = command(root, ['--no-model', 'comprehension', 'check', '--base', 'HEAD', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.operation.id, 'comprehension.check');
  assert.equal(response.outcome.status, 'succeeded');
  assert.equal(response.data.mode, 'observe-only');
  assert.equal(response.data.coverage.verdict, 'incomplete');
  assert.equal(response.data.coverage.authoritative, false);
  assert.equal(response.data.coverage.lifecycleGate, false);
  assert.equal(response.data.coverage.counts.materialRegions, 2);
  assert.equal(response.data.coverage.counts.unresolved, 2);
  assert.match(JSON.stringify(response.data.coverage.unresolved), /No primary disposition is registered/);
  assert.equal(await readFile(path.join(root, 'service.txt'), 'utf8'), 'after\n');
});

test('an explicit base never bypasses a requested Story context', async (t) => {
  const root = await repository(t);
  const result = command(root, [
    '--no-model', 'comprehension', 'regions', '--base', 'HEAD', '--work-id', 'DOES-NOT-EXIST', '--json'
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DOES-NOT-EXIST/);
});

test('comprehension evidence files are bounded before JSON parsing', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'too-large.json'), Buffer.alloc((1024 * 1024) + 1, 0x20));
  const result = command(root, [
    '--no-model', 'comprehension', 'check', '--base', 'HEAD', '--bindings', 'too-large.json', '--json'
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /1048576-byte diagnostic input ceiling/);
});

test('comprehension evidence cannot escape the resolved repository', async (t) => {
  const root = await repository(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-comprehension-outside-'));
  t.after(() => spawnSync('rm', ['-rf', outside]));
  const file = path.join(outside, 'bindings.json');
  await writeFile(file, '[]\n');
  const result = command(root, [
    '--no-model', 'comprehension', 'check', '--base', 'HEAD', '--bindings', file, '--json'
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /(?:in|out)side the repository|must be repository-relative|escap/i);
});

test('comprehension evidence record collections are bounded', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'too-many.json'), `${JSON.stringify(new Array(2001).fill({}))}\n`);
  const result = command(root, [
    '--no-model', 'comprehension', 'check', '--base', 'HEAD', '--bindings', 'too-many.json', '--json'
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /2000-record diagnostic input ceiling/);
});

test('human output labels the compatibility subject and resolved repository honestly', async (t) => {
  const root = await repository(t);
  const canonicalRoot = await realpath(root);
  const result = command(root, ['--no-model', 'comprehension', 'regions', '--base', 'HEAD']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Repository: ${canonicalRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(result.stdout, /Repository change-set subject: sha256:/);
  assert.doesNotMatch(result.stdout, /^Candidate:/m);
});
