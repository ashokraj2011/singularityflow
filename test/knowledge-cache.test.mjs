/**
 * The knowledge cache [WMR:REQ-017–019]: keyed by what was read, never the commit, so a Story's bookkeeping commit
 * reuses the analysis (A8); only analysis entries are pruned, and what a model wrote and a person's unconfirmed rule
 * draft survive any number of commits (A9).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readCachedBrief, writeCachedBrief } from '../src/knowledge/brief.mjs';
import { readPolish, writePolish } from '../src/knowledge/brief-polish.mjs';
import { readExplanations, writeExplanations } from '../src/knowledge/explain.mjs';
import { readProposals, writeProposals } from '../src/knowledge/rule-meaning.mjs';
import { rulesCommand } from '../src/knowledge/rules-command.mjs';
import { buildKnowledge } from '../src/knowledge/store.mjs';
import { newestCommitTouching } from '../src/git-access.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function shop(t) {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-knowledge-cache-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await cp(path.join(root, 'test', 'fixtures', 'knowledge', 'shop'), repository, { recursive: true });
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'Shop');
  return repository;
}

const cacheDirectory = (repository) => path.join(repository, '.git', 'singularity-flow', 'knowledge');
const analysisEntries = async (repository) => (await readdir(cacheDirectory(repository)).catch(() => [])).filter((name) => /^[0-9a-f]{64}\.json$/u.test(name));

/** A Story's bookkeeping: its own records change, no file the knowledge reads does. */
async function bookkeepingCommit(repository, n) {
  const folder = path.join(repository, 'singularity', 'work-items', 'STORY-7', 'context');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, `step-${n}.json`), `${JSON.stringify({ generation: n })}\n`);
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', `STORY-7 bookkeeping ${n}`);
}

test('A8: a commit that changes only Story records reuses the analysis; a change to a read file analyses again [WMR:REQ-017]', async (t) => {
  const repository = await shop(t);
  const first = await buildKnowledge(repository);
  assert.equal(first.status, 'ok');
  assert.equal(first.cache, 'miss');
  const analysedAt = first.knowledge.repository.commit;
  for (const n of [1, 2, 3]) await bookkeepingCommit(repository, n);
  assert.notEqual(git(repository, 'rev-parse', 'HEAD'), analysedAt, 'HEAD moved');
  const reused = await buildKnowledge(repository);
  assert.equal(reused.cache, 'hit', 'nothing is analysed again');
  assert.equal(reused.key, first.key);
  assert.equal(reused.commit, git(repository, 'rev-parse', 'HEAD'), 'the build reports the commit it read');
  assert.equal(reused.knowledge.repository.commit, analysedAt, 'the analysis names the commit it was first built at; its read files are the same');
  assert.equal((await analysisEntries(repository)).length, 1);
  // History is keyed by the newest commit that touched a read path: the bookkeeping commits touched none.
  const read = [...first.knowledge.graph.functions.map((fn) => fn.file)];
  assert.equal(newestCommitTouching(repository, [...new Set(read)]), analysedAt);

  await appendFile(path.join(repository, 'src', 'api', 'client.ts'), '\n// a code change\n');
  git(repository, 'commit', '-qam', 'A code change');
  const changed = await buildKnowledge(repository);
  assert.equal(changed.cache, 'miss');
  assert.notEqual(changed.key, first.key);
  assert.equal(changed.knowledge.repository.commit, git(repository, 'rev-parse', 'HEAD'));
});

test('A9: after 20 commits a model-written brief, phrasing, explanation and an unconfirmed rule draft are all still there [WMR:REQ-018, REQ-019]', async (t) => {
  const repository = await shop(t);
  const built = await buildKnowledge(repository);
  // What a model wrote, each keyed by the analysis (no commit in its key) and what was sent.
  await writeCachedBrief(repository, 'a'.repeat(32), { mode: 'model', model: 'recorded', views: {} });
  await writePolish(repository, 'b'.repeat(32), { key: 'b'.repeat(32), model: 'recorded', accepted: [], rejected: [] });
  await writeExplanations(repository, built.key, { model: 'recorded', accepted: [{ text: 'Shipping is free from 50.00.' }], rejected: [] });
  // A person's unconfirmed rule draft, written by a model.
  const listed = await captured(() => rulesCommand(repository, ['list'], { json: true }));
  const rule = listed.rules.find((record) => (record.anchors ?? []).length && /shipping/u.test(record.text));
  assert.ok(rule, 'the shipping rule has anchors to bind a draft to');
  await writeProposals(repository, { [rule.id]: { condition: 'the subtotal reaches the free shipping threshold', outcome: 'shipping is free',
    intent: null, by: 'model', model: 'recorded', anchors: rule.anchors, createdAt: '2026-11-26T00:00:00.000Z' } });

  // Twenty commits that each change a read file (one the rule does not live in): twenty analyses, more than the 12 kept.
  for (let n = 1; n <= 20; n += 1) {
    await appendFile(path.join(repository, 'src', 'api', 'client.ts'), `// change ${n}\n`);
    git(repository, 'commit', '-qam', `Change ${n}`);
    assert.equal((await buildKnowledge(repository)).cache, 'miss');
  }
  assert.equal((await analysisEntries(repository)).length, 12, 'analysis entries are pruned to the newest 12');
  assert.ok(await readCachedBrief(repository, 'a'.repeat(32)), 'the model-written brief is still there');
  assert.ok(await readPolish(repository, 'b'.repeat(32)), 'the phrasing is still there');
  assert.ok(await readExplanations(repository, built.key), 'the explanation is still there');
  assert.equal((await readProposals(repository))[rule.id]?.by, 'model', 'the unconfirmed rule draft is still there');
  for (const name of [`brief-${'a'.repeat(32)}.json`, `brief-polish-${'b'.repeat(32)}.json`, `explanations-${built.key}.json`]) {
    assert.ok(await stat(path.join(cacheDirectory(repository), 'paid', name)), `${name} is kept under knowledge/paid/`);
  }
  assert.ok(await stat(path.join(cacheDirectory(repository), 'rule-proposals.json')));

  // `wm rules confirm` credits the drafted meaning to the model that drafted it, not to "template".
  const confirmed = await captured(() => rulesCommand(repository, ['confirm', rule.id], { json: true }));
  assert.equal(confirmed.entry.proposedBy, 'model');
  assert.equal(confirmed.entry.model, 'recorded');
  assert.equal(confirmed.entry.outcome, 'shipping is free');
});

test('paid output an earlier version kept beside the analysis entries is moved to knowledge/paid/, and kept by its own count [WMR:REQ-018]', async (t) => {
  const repository = await shop(t);
  await buildKnowledge(repository);
  const legacy = path.join(cacheDirectory(repository), `brief-${'c'.repeat(32)}.json`);
  await writeFile(legacy, JSON.stringify({ mode: 'model', views: {} }));
  assert.ok(await readCachedBrief(repository, 'c'.repeat(32)), 'read from its new place on first use');
  await assert.rejects(stat(legacy), /ENOENT/u, 'moved, not copied');
  for (let n = 0; n < 33; n += 1) await writeCachedBrief(repository, n.toString(16).padStart(32, '0'), { n });
  const paid = (await readdir(path.join(cacheDirectory(repository), 'paid'))).filter((name) => name.endsWith('.json'));
  assert.equal(paid.length, 30, 'paid output keeps the newest 30');
  assert.ok((await analysisEntries(repository)).length >= 1, 'the paid prune never touches an analysis entry');
});

/** Run a command that prints JSON, and return what it returned (its printed JSON is not needed). */
async function captured(run) {
  const log = console.log;
  console.log = () => {};
  try { return await run(); } finally { console.log = log; }
}
