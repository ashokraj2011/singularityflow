import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, link, lstat, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const source = (name) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', name)).href;
// One process of a session: install the store, ask Git, report what came from where.
const DRIVER = `
import { installGitFactStore } from ${JSON.stringify(source('git-fact-store.mjs'))};
import { run } from ${JSON.stringify(source('util.mjs'))};
import { gitFactStoreHits } from ${JSON.stringify(source('git-fact-cache.mjs'))};
installGitFactStore();
const [questions, cwd] = [JSON.parse(process.argv[2]), process.argv[3]];
const answers = questions.map((args) => { const result = run('git', args, { cwd, allowFailure: true }); return { status: result.status, stdout: result.stdout }; });
console.log(JSON.stringify({ answers, storeHits: gitFactStoreHits() }));
`;
const settle = () => new Promise((resolve) => { setTimeout(resolve, 2_100); });

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

async function session(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-git-fact-store-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  git(base, ['init', '-q', '-b', 'main', root]);
  git(root, ['config', 'user.name', 'Store Tester']);
  git(root, ['config', 'user.email', 'store@example.invalid']);
  git(root, ['config', 'example.secret', 'configured-secret-value']);
  await writeFile(path.join(root, 'a.txt'), 'one\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-q', '-m', 'one']);
  const driver = path.join(base, 'driver.mjs');
  await writeFile(driver, DRIVER);
  const store = path.join(base, 'store');
  const head = git(root, ['rev-parse', 'HEAD']);
  const questions = [['rev-parse', '--show-toplevel'], ['branch', '--show-current'], ['rev-parse', 'HEAD'],
    ['show', `${head}:a.txt`], ['rev-parse', '--verify', `${head}^{tree}`]];
  const ask = (asked = questions, env = {}) => {
    const result = spawnSync(process.execPath, [driver, JSON.stringify(asked), root], {
      encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_GIT_FACT_STORE: store, SINGULARITY_FLOW_GIT_FACT_CACHE: '', GIT_TEST_TOKEN: 'secret-token-value', ...env }
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const storeFiles = async () => (await readdir(path.join(store, 'git-facts', 'v1'))).filter((name) => name.endsWith('.json'));
  return { base, root, store, head, questions, ask, storeFiles };
}

test('the next process of a session reuses every answer the previous one proved, from a private store', async (t) => {
  const { root, store, questions, ask, storeFiles } = await session(t);
  await settle();
  const first = ask([...questions, ['config', '--get', 'example.secret']]);
  assert.equal(first.storeHits, 0);
  const second = ask();
  assert.equal(second.storeHits, questions.length, 'every question was answered from the session store');
  assert.deepEqual(second.answers, first.answers.slice(0, questions.length));
  assert.equal(path.resolve(second.answers[0].stdout.trim()), await import('node:fs').then((fs) => fs.realpathSync(root)));

  const [file] = await storeFiles();
  const text = await readFile(path.join(store, 'git-facts', 'v1', file), 'utf8');
  assert.doesNotMatch(text, /secret-token-value|GIT_TEST_TOKEN/u, 'questions are stored by digest, never as text');
  assert.doesNotMatch(text, /configured-secret-value/u, 'configuration answers are never stored');
  if (process.platform !== 'win32') {
    assert.equal((await lstat(path.join(store, 'git-facts', 'v1'))).mode & 0o777, 0o700);
    assert.equal((await lstat(path.join(store, 'git-facts', 'v1', file))).mode & 0o777, 0o600);
  }
});

test('an answer whose files could still change in the same timestamp tick stays in memory, and off stores nothing', async (t) => {
  const { root, store, ask } = await session(t);
  await settle();
  // A whole-second timestamp is what a coarse filesystem (HFS+, FAT) records: within two seconds a
  // later change could keep the same value, so the HEAD answer must not outlive this process.
  const wholeSecond = Math.floor(Date.now() / 1000);
  await utimes(path.join(root, '.git', 'HEAD'), wholeSecond, wholeSecond);
  const head = [['rev-parse', 'HEAD']];
  ask(head);
  assert.equal(ask(head).storeHits, 0, 'a racy HEAD answer was not persisted');
  await settle();
  ask(head);
  assert.equal(ask(head).storeHits, 1, 'once its files settled, the same answer is persisted');

  const offStore = `${store}-off`;
  ask(undefined, { SINGULARITY_FLOW_GIT_FACT_STORE: offStore, SINGULARITY_FLOW_GIT_FACT_CACHE: 'off' });
  await assert.rejects(lstat(offStore), { code: 'ENOENT' });
});

test('a stored object read is refused once another program deleted the object', async (t) => {
  const { root, head, ask } = await session(t);
  await settle();
  const read = [['show', `${head}:a.txt`]];
  assert.equal(ask(read).answers[0].stdout, 'one\n');
  const blob = git(root, ['rev-parse', 'HEAD:a.txt']);
  await rm(path.join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  const after = ask(read);
  assert.equal(after.storeHits, 0);
  assert.notEqual(after.answers[0].status, 0, 'the read that proved the blob present fails, as without a store');
});

test('a store file that is damaged, foreign, shared, linked or expired is ignored', async (t) => {
  const { store, ask, storeFiles } = await session(t);
  await settle();
  ask();
  const directory = path.join(store, 'git-facts', 'v1');
  const [name] = await storeFiles();
  const file = path.join(directory, name);
  const good = path.join(directory, 'good.copy');
  await copyFile(file, good);
  const valid = JSON.parse(await readFile(good, 'utf8'));
  assert.equal(ask().storeHits, 5, 'the untouched store is used');
  const variants = [
    ['damaged', async () => writeFile(file, '{"format":1,')],
    ['another platform', async () => writeFile(file, JSON.stringify({ ...valid, platform: 'plan9' }))],
    ['another repository', async () => writeFile(file, JSON.stringify({ ...valid, commonDir: '/elsewhere/.git' }))],
    ['expired', async () => writeFile(file, JSON.stringify({ ...valid, entries: valid.entries.map((entry) => ({ ...entry, recordedAt: Date.now() - 16 * 60 * 1000 })) }))],
    ['tampered', async () => writeFile(file, JSON.stringify({ ...valid, entries: valid.entries.map((entry) => ({ ...entry, id: 'not-a-digest' })) }))]
  ];
  if (process.platform !== 'win32') {
    variants.push(['readable by others', async () => { await copyFile(good, file); await chmod(file, 0o644); }]);
    variants.push(['a symbolic link', async () => { await rm(file); await symlink(good, file); }]);
    variants.push(['hard-linked', async () => { await rm(file); await link(good, file); }]);
  }
  for (const [label, damage] of variants) {
    await rm(file, { force: true });
    await copyFile(good, file);
    await chmod(file, 0o600);
    await damage();
    assert.equal(ask().storeHits, 0, label);
  }
});

test('stores nobody wrote for twenty minutes are removed', async (t) => {
  const { store, ask } = await session(t);
  await settle();
  ask();
  const directory = path.join(store, 'git-facts', 'v1');
  const stale = path.join(directory, `${'0'.repeat(64)}.json`);
  await writeFile(stale, '{}', { mode: 0o600 });
  const old = new Date(Date.now() - 30 * 60 * 1000);
  await utimes(stale, old, old);
  await rm(path.join(directory, '.pruned'), { force: true });
  ask([['rev-parse', '--show-prefix']]);
  await assert.rejects(lstat(stale), { code: 'ENOENT' });
});

test('the CLI installs the session store: a repeated command answers from it with identical output', async (t) => {
  const { base, root, store } = await session(t);
  await settle();
  const cli = path.join(import.meta.dirname, '..', 'bin', 'singularity-flow.mjs');
  const env = { ...process.env, SINGULARITY_FLOW_GIT_FACT_STORE: store, SINGULARITY_FLOW_GIT_FACT_CACHE: '',
    SINGULARITY_FLOW_NO_MODEL: '1', HOME: path.join(base, 'home'), SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'mode.json') };
  const counter = (stderr, name) => Number(new RegExp(`\\b${name.replaceAll('.', '\\.')}=(\\d+)`, 'u').exec(stderr)?.[1] ?? 0);
  const once = () => {
    const result = spawnSync(process.execPath, [cli, 'nextsteps', '--json', '--timings'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return { stdout: result.stdout, spawns: counter(result.stderr, 'git.spawns'), stored: counter(result.stderr, 'git.fact-store-hits') };
  };
  const first = once();
  const second = once();
  assert.equal(first.stored, 0);
  assert.ok(second.stored > 0, 'the second command reused answers the first one proved');
  assert.ok(second.spawns < first.spawns, `${second.spawns} Git processes after ${first.spawns}`);
  assert.equal(second.stdout, first.stdout);
});
