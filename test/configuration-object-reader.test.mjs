import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile, rename, rm, symlink, stat, utimes } from 'node:fs/promises';
import { ConfigurationObjectReader, parseConfigurationObjectChecks } from '../src/configuration-object-reader.mjs';
import { run } from '../src/util.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';

test('object metadata accepts LF/CRLF without relaxing identity, type, count or byte ceilings', () => {
  const first = 'a'.repeat(40), second = 'b'.repeat(40);
  for (const ending of ['\n', '\r\n']) {
    assert.deepEqual(parseConfigurationObjectChecks(`${first} blob 3${ending}${second} missing${ending}`, [first, second]), [second]);
  }
  for (const output of [`${first} tree 3\n`, `${first} blob 33554433\n`,
    `${second} blob 3\n`, `${first} blob 3\n${first} blob 3\n`, `${first}\r blob 3\n`,
    `${first} blob invalid\n`]) {
    assert.throws(() => parseConfigurationObjectChecks(output, [first]), { code: 'CONFIGURATION_RECREATE_UNSAFE' });
  }
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-object-reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, SINGULARITY_FLOW_GIT_FACT_CACHE: 'off' };
  const git = (...args) => run('git', args, { cwd: root, env });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(root, 'one.txt'), 'first\n');
  git('add', '.'); git('commit', '-qm', 'first');
  const commit = git('rev-parse', 'HEAD').stdout.trim();
  const reader = new ConfigurationObjectReader(root, 'fixture', env, () => { throw new Error('Unexpected network operation'); });
  return { root, git, env, commit, reader };
}

test('one reader reuses exact inventories and verified bytes, but re-evaluates each admission rule', async t => {
  const f = await fixture(t);
  const timer = commandTimer(['test']);
  await withCommandTiming(timer, async () => {
    const entries = f.reader.inventory(f.commit, ['one.txt']);
    assert.equal(f.reader.inventory(f.commit, ['one.txt'], () => false).length, 0);
    await f.reader.hydrate(entries);
    const repeat = commandTimer(['test']);
    await withCommandTiming(repeat, () => f.reader.hydrate(entries));
    assert.equal(repeat.finish().counters['git.spawns'] ?? 0, 0, 'already verified bytes need no Git or remote read');
    assert.equal(f.reader.file(f.commit, 'one.txt').bytes.toString(), 'first\n');
  });
  const counters = timer.finish().counters;
  assert.equal(counters['configuration.inventory-reuse'], 1);
  assert.ok(counters['configuration.seal-reuse'] >= 2);
  await writeFile(path.join(f.root, 'one.txt'), 'second\n');
  f.git('add', '.'); f.git('commit', '-qm', 'second');
  const newer = f.git('rev-parse', 'HEAD').stdout.trim();
  await f.reader.hydrate(f.reader.inventory(newer, ['one.txt']));
  assert.equal(f.reader.file(newer, 'one.txt').bytes.toString(), 'second\n');
  assert.equal(f.reader.file(f.commit, 'one.txt').bytes.toString(), 'first\n');
});

test('an in-place local configuration change invalidates the seal despite restored timestamps', async t => {
  const f = await fixture(t);
  f.reader.inventory(f.commit, ['one.txt']);
  const file = path.join(f.root, '.git/config');
  const original = await readFile(file, 'utf8'), before = await stat(file);
  await writeFile(file, `${original}\n[remote "untrusted"]\n\tpromisor = true\n`);
  await utimes(file, before.atime, before.mtime);
  assert.throws(() => f.reader.inventory(f.commit, ['one.txt']), error => error.code === 'CONFIGURATION_RECREATE_UNSAFE');
});

test('an explicit object fetch invalidates the seal and newly installed promisor registrations', async t => {
  const f = await fixture(t);
  const [entry] = f.reader.inventory(f.commit, ['one.txt']);
  const object = path.join(f.root, '.git/objects', entry.oid.slice(0, 2), entry.oid.slice(2));
  const backup = path.join(f.root, 'saved-object');
  await rename(object, backup);
  let fetches = 0;
  f.reader.runRemoteCommand = async (args, options) => {
    assert.equal(args[0], 'fetch');
    assert.ok(args.includes('--refetch'));
    assert.equal(args.at(-1), entry.oid);
    assert.equal(options.env.GIT_NO_LAZY_FETCH, '1');
    fetches++;
    await rename(backup, object);
    f.git('config', 'remote.origin.promisor', 'true');
    return { status: 0 };
  };
  await f.reader.hydrate([entry]);
  assert.equal(fetches, 1);
  assert.equal(f.reader.file(f.commit, 'one.txt').bytes.toString(), 'first\n');
  assert.equal(run('git', ['config', '--local', '--get', 'remote.origin.promisor'],
    { cwd: f.root, env: f.env, allowFailure: true }).status, 1);
});

test('a cached tree cannot turn a newly admitted symlink into a regular configuration asset',
  { skip: process.platform === 'win32' }, async t => {
    const f = await fixture(t);
    await symlink('one.txt', path.join(f.root, 'link.txt'));
    f.git('add', '.'); f.git('commit', '-qm', 'link');
    const commit = f.git('rev-parse', 'HEAD').stdout.trim();
    assert.equal(f.reader.inventory(commit, ['.'], relative => relative === 'one.txt').length, 1);
    assert.throws(() => f.reader.inventory(commit, ['.']), /not a regular file/u);
  });

test('inventory reuse remains bounded independently of the number of inspected proposals', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 140; index++) f.reader.inventory(f.commit, [`absent-${index}`]);
  assert.equal(f.reader.inventories.size, 128);
  assert.ok(f.reader.inventoryBytes <= 4 * 1024 * 1024);
});
