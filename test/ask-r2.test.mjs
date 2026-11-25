import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { readAsk } from '../src/ask/read.mjs';
import { askTimeWindow } from '../src/ask/time-window.mjs';
import { committedHistory } from '../src/ask/git-history.mjs';
import { appendLedgerIntent, canonicalJson, createLedgerIntent, initializeLedger, ledgerPayloadDigest, sha256 } from '../src/ledger.mjs';
import { boundedToolAnswer, createHostGateway } from '../src/gateway/host.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { storyLedgerSummary } from '../src/story-publication-binding.mjs';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';

const cliPath = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const actor = { name: 'History Fixture', email: 'history@example.invalid' };
const day = '2026-11-05T12:00:00.000Z';
const ledger = { enabled: true, branch: 'retained-state', publication: 'off' };

async function repo(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-ask-history-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'source');
  await mkdir(root);
  const env = isolatedTestEnvironment(path.join(base, 'machine'));
  const previous = process.env.SINGULARITY_FLOW_REPOSITORY_CATALOG;
  process.env.SINGULARITY_FLOW_REPOSITORY_CATALOG = env.SINGULARITY_FLOW_REPOSITORY_CATALOG;
  t.after(() => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_REPOSITORY_CATALOG;
    else process.env.SINGULARITY_FLOW_REPOSITORY_CATALOG = previous;
  });
  function command(repository, args, options = {}) {
    const child = spawnSync('git', args, { cwd: repository, env, encoding: 'utf8', ...options });
    assert.equal(child.status, 0, child.stderr || child.stdout || String(child.error));
    return child.stdout.trim();
  }
  const git = (...args) => command(root, args);
  const file = async (relative, data) => {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  };
  const commit = (message, timestamp = day, author = timestamp) => {
    git('add', '-A');
    command(root, ['commit', '--allow-empty', '-qm', message], {
      env: { ...env, GIT_AUTHOR_DATE: author, GIT_COMMITTER_DATE: timestamp }
    });
    return git('rev-parse', 'HEAD');
  };
  const ask = (query, audience = 'person', cursor) => readAsk({
    root, audience, arguments: { query, ...(cursor ? { cursor } : {}) }
  });
  const cli = (...args) => {
    const child = spawnSync(process.execPath, [cliPath, 'ask', ...args, '--no-model', '--json'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return JSON.parse(child.stdout);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', actor.name);
  git('config', 'user.email', actor.email);
  await file('base.txt', 'initial source\n');
  const initial = commit('initial source', '2026-10-01T00:00:00Z');
  return { root, base, env, git, command, file, commit, ask, cli, initial };
}

test('R2 normalizes inclusive local dates and independent DST boundaries', () => {
  const kolkata = askTimeWindow({ startDate: '2026-11-01', endDate: '2026-11-07', timeZone: 'Asia/Calcutta' });
  assert.equal(kolkata.startInclusive, '2026-10-31T18:30:00.000Z');
  assert.equal(kolkata.endExclusive, '2026-11-07T18:30:00.000Z');
  assert.deepEqual([kolkata.startDate, kolkata.endDate], ['2026-11-01', '2026-11-07']);
  const dst = askTimeWindow({ startDate: '2026-11-01', endDate: '2026-11-01', timeZone: 'America/New_York' });
  assert.equal(Date.parse(dst.endExclusive) - Date.parse(dst.startInclusive), 25 * 60 * 60 * 1000);
  const anchor = new Date('2026-11-09T01:00:00Z');
  const previous = askTimeWindow({ period: 'last week', timeZone: 'America/New_York' }, anchor);
  assert.deepEqual([previous.startDate, previous.endDate, previous.anchorInstant],
    ['2026-10-26', '2026-11-01', anchor.toISOString()]);
  for (const spec of [
    { startDate: '2026-11-31', endDate: '2026-12-01' },
    { startDate: '2026-11-07', endDate: '2026-11-01' },
    { startDate: '2026-11-01', endDate: '2026-11-07', timeZone: 'Asia/Unknown' }
  ]) assert.throws(() => askTimeWindow(spec), error => error.code === 'ASK_TIME_WINDOW_INVALID');
});

test('R2 paginates committer dates across a skewed ancestry and a moved HEAD', async t => {
  const { root, git, commit, ask, cli } = await repo(t);
  const author = '2026-03-01T00:00:00Z';
  const first = commit('Exactly at local start', '2026-10-31T18:30:00Z', author);
  const qualifying = [first];
  for (let index = 0; index < 20; index++) qualifying.push(commit('Included ' + index + ' ' + 'Fixture detail. '.repeat(16), day, author));
  const last = commit('After the older clock-skewed child', day, author);
  qualifying.push(last);
  const skew = commit('Committer clock moved backward', '2026-10-30T00:00:00Z', day);
  const end = commit('Exactly at exclusive end', '2026-11-07T18:30:00Z', day);
  const query = 'commits from 2026-11-01 to 2026-11-07 in Asia/Calcutta on main';
  const refs = git('show-ref');
  const page1 = cli(query, '--for-person');
  assert.equal(page1.history.basis, 'committed');
  assert.equal(page1.history.scope.revision, end);
  assert.equal(page1.coverage.status, 'partial');
  assert.equal(page1.coverage.count.retrieved, 20);
  assert.equal(page1.coverage.count.total, null);
  assert.equal(git('show-ref'), refs);
  assert.equal(git('status', '--porcelain'), '');
  const later = commit('Arrived after page one');
  const page2 = cli('--cursor=' + page1.continuation.cursor, '--for-person');
  assert.deepEqual(page1.history.window, page2.history.window);
  assert.equal(page2.history.scope.revision, end);
  assert.deepEqual(page2.coverage.count, { unit: 'commits', retrieved: 22, total: 22 });
  const seen = [...page1.history.rows, ...page2.history.rows].map(row => row.commit);
  assert.deepEqual(seen, qualifying.reverse());
  assert.ok(!seen.includes(later) && !seen.includes(skew));
  assert.equal(page2.continuation, undefined);
  const continuationCursor = page1.continuation.cursor;
  const tampered = continuationCursor.slice(0, -1) + (continuationCursor.endsWith('a') ? 'b' : 'a');
  for (const result of [await ask('continue', 'person', tampered), await ask('continue', 'model', continuationCursor)]) {
    assert.equal(result.diagnostics[0].code, 'ASK_CONTINUATION_INVALID');
  }

  const host = createHostGateway({ root, hostSessionId: 'history-fixture', planners: gatewayPlanners() });
  const throughGateway = async args => {
    const resolved = await host.kernel.resolve({ utterance: 'ask sflow', arguments: args });
    const read = await host.kernel.read({ resolutionId: resolved.next[0]?.handle });
    assert.equal(read.operation.id, 'ask.lookup', JSON.stringify(read));
    const onWire = boundedToolAnswer('sflow_read', read);
    assert.ok(onWire.data.history, JSON.stringify(onWire.data));
    return onWire.data;
  };
  const model = await throughGateway({ query });
  const latest = await ask(query, 'model');
  assert.deepEqual(model.history, latest.history);
  assert.equal(model.coverage.count.total, null);
  let modelPage = model;
  const modelCommits = [];
  for (let index = 0; index < 8; index++) {
    modelCommits.push(...modelPage.history.rows.map(row => row.commit));
    if (!modelPage.continuation) break;
    modelPage = await throughGateway({ query: 'continue', cursor: modelPage.continuation.cursor });
  }
  assert.equal(modelPage.coverage.count.total, 23);
  assert.deepEqual(modelCommits, [later, ...seen]);

  const missing = path.join(root, '.git', 'objects', first.slice(0, 2), first.slice(2));
  const contents = await readFile(missing);
  await rm(missing);
  const failed = cli('--cursor=' + continuationCursor, '--for-person');
  assert.equal(failed.coverage.status, 'partial', JSON.stringify(failed));
  assert.deepEqual(failed.coverage.count, { unit: 'commits', retrieved: 20, total: null });
  assert.equal(failed.history.scope.revision, end);
  assert.equal(failed.continuation.behavior, 'retry');
  await writeFile(missing, contents);
  assert.deepEqual(cli('--cursor=' + failed.continuation.cursor, '--for-person').history.rows, page2.history.rows);
});

test('R2 distinguishes verified zero results, unsupported time bases and a Git scan cap', async t => {
  const { root, git, command, ask } = await repo(t);
  const empty = await ask('commits from 2020-01-01 to 2020-01-01');
  assert.equal(empty.status, 'empty');
  assert.equal(empty.coverage.count.total, 0);
  for (const query of ['what changed last week', 'deployed changes last week', 'what was known at Friday']) {
    assert.equal((await ask(query)).diagnostics[0].category, 'unsupported');
  }
  for (const query of ['commits from 2026-11-31 to 2026-12-04', 'commits from 11/1/26 to 11/5/26', 'commits from 2026-11-03 to 2026-11-01']) {
    assert.equal((await ask(query)).status, 'clarification');
  }
  const input = Array.from({ length: 16_002 }, () => [
    'commit refs/heads/cap', 'committer History Fixture <history@example.invalid> 1793880000 +0000',
    'data 6', 'Commit', ''
  ].join('\n')).join('\n');
  command(root, ['fast-import', '--quiet'], { input, maxBuffer: 4 * 1024 * 1024 });
  const window = askTimeWindow({ startDate: '2026-11-01', endDate: '2026-11-07' });
  const result = await committedHistory(root, { revision: 'cap' }, window, {
    revision: git('rev-parse', 'cap'), offset: 15_999, retrieved: 15_999, shallow: null
  });
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.coverage.count.total, null);
  assert.equal(result.coverage.inspected, 16_000);
  assert.equal(result.diagnostics[0].code, 'ASK_GIT_HISTORY_CAPPED');
});

test('R2 compares divergent endpoints, retains rename/deletion/binary metadata and reports a missing blob', async t => {
  const { root, git, commit, file, ask, cli } = await repo(t);
  await file('old path.txt', 'an exact rename\n');
  await file('removed.txt', 'to be removed\n');
  await file('broken.txt', 'historical content\n');
  const split = commit('common tree');
  await file('left-only.txt', 'not on the other side\n');
  const left = commit('left diverges');
  git('branch', 'left', left);
  git('switch', '-q', '-c', 'right', split);
  git('mv', 'old path.txt', 'new path.txt');
  git('rm', '-q', 'removed.txt');
  await file('blob.bin', Buffer.from([0, 17, 34, 51]));
  await file('broken.txt', 'new content\n');
  const right = commit('right diverges');
  const result = cli('compare left with right');
  assert.deepEqual([result.comparison.left.revision, result.comparison.right.revision], [left, right]);
  assert.equal(result.comparison.mode, 'endpoint-trees');
  const changes = result.comparison.rows;
  assert.ok(changes.some(row => row.path === 'new path.txt' && row.oldPath === 'old path.txt' && row.status === 'R'));
  assert.ok(changes.some(row => row.path === 'removed.txt' && row.status === 'D'));
  assert.ok(changes.some(row => row.path === 'left-only.txt' && row.status === 'D'));
  assert.ok(changes.some(row => row.path === 'blob.bin' && row.binary && row.added === null));
  const patchQuery = 'compare left with right patch broken.txt';
  assert.match((await ask(patchQuery)).comparison.patch.text, /-historical content/u);
  const model = await ask(patchQuery, 'model');
  assert.equal(model.comparison.patch.status, 'person-view-required');
  assert.equal(JSON.stringify(model).includes('historical content'), false);
  const old = git('rev-parse', left + ':broken.txt');
  await rm(path.join(root, '.git', 'objects', old.slice(0, 2), old.slice(2)));
  const damaged = await ask('compare left with right');
  assert.equal(damaged.comparison.paths, 'complete');
  assert.equal(damaged.comparison.lineCounts, 'partial');
  assert.equal(damaged.coverage.count.total, null);
  assert.equal(damaged.comparison.rows.find(row => row.path === 'blob.bin').binary, true);
  assert.equal(damaged.comparison.rows.find(row => row.path === 'new path.txt').oldPath, 'old path.txt');
  assert.equal(damaged.comparison.rows.find(row => row.path === 'broken.txt').binary, null);
  assert.equal((await ask(patchQuery)).comparison.patch.status, 'unavailable');
});

test('R2 retains a reverted commit pair and compares held endpoint trees even when shallow', async t => {
  const { base, root, initial, git, commit, file, command, ask } = await repo(t);
  await file('base.txt', 'feature added\n');
  const introduced = commit('introduce');
  await file('base.txt', 'initial source\n');
  const reverted = commit('revert', '2026-11-06T12:00:00Z');
  const activity = await ask('commits from 2026-11-01 to 2026-11-07');
  assert.deepEqual(activity.history.rows.map(row => row.commit), [reverted, introduced]);
  assert.equal((await ask('compare ' + initial + ' with ' + reverted)).coverage.count.total, 0);

  git('tag', 'old', initial);
  const shallow = path.join(base, 'shallow');
  command(base, ['clone', '-q', '--depth=1', pathToFileURL(root).href, shallow]);
  command(shallow, ['fetch', '-q', '--depth=1', 'origin', 'refs/tags/old:refs/tags/old']);
  const inShallow = query => readAsk({ root: shallow, audience: 'person', arguments: { query } });
  const truncated = await inShallow('commits from 2026-11-01 to 2026-11-07');
  assert.equal(truncated.history.scope.shallow, true);
  assert.equal(truncated.coverage.status, 'partial');
  assert.equal(truncated.coverage.count.total, null);
  assert.equal((await inShallow('compare old with HEAD')).coverage.status, 'complete');
});

async function recordWork(fixture, branch, { id, kind, status, eventType, date, legacy = false }) {
  const { root, env, git, file, commit } = fixture;
  git('switch', '-q', branch);
  const story = kind === 'story';
  const complete = status === 'closed' || status === 'complete' || status === 'archived';
  const createdAt = '2026-11-01T09:00:00.000Z';
  const state = {
    schemaVersion: currentSchemaVersion(story ? 'story-workflow' : 'initiative-state'),
    [story ? 'workItem' : 'initiative']: { id, branch, title: id + ' title', createdAt, createdBy: actor },
    phaseOrder: ['delivery'], currentPhase: complete ? null : 'delivery', status,
    phases: { delivery: { id: 'delivery', status: complete ? 'approved' : 'in_progress', generation: 1 } },
    history: [{ at: date, event: eventType }]
  };
  const from = story ? 'singularity/work-items/' : 'custom/initiatives/';
  await file(from + id + (story ? '/workflow.json' : '/state.json'), JSON.stringify(state));
  if (!story) await file('singularity/portfolio.yml', 'initiativeRoot: custom/initiatives\n');
  const revision = commit('Work state ' + status, date);
  const intent = createLedgerIntent({
    eventType, capabilityId: 'work-' + id.toLowerCase(), actor,
    subject: { workId: id, branch, ...(!legacy ? { kind } : {}), ...(story ? storyLedgerSummary(state) : {}) },
    payload: { lifecycleEventId: 'fixture-' + revision, configPath: story ? 'singularity/workflow.yml' : 'singularity/portfolio.yml' }
  });
  await appendLedgerIntent(root, ledger, { ...intent, createdAt: date }, revision, { env });
  return revision;
}

test('R2 reads retained Stories and Initiatives beyond deleted branches and separates historical predicates', { timeout: 45_000 }, async t => {
  const fixture = await repo(t);
  const { root, env, git, file, commit, cli, ask } = fixture;
  assert.equal((await ask('history')).diagnostics[0].code, 'ASK_WORK_HISTORY_DISABLED');
  await file('singularity/workflow.yml', 'ledger:\n  enabled: true\n  branch: retained-state\n  publication: off\n');
  commit('enable retained work history');
  assert.equal((await ask('history')).diagnostics[0].code, 'ASK_WORK_HISTORY_SNAPSHOT_UNAVAILABLE');
  await initializeLedger(root, ledger, { publish: false, refreshRemote: false, env });
  assert.equal((await ask('history')).coverage.count.total, 0);

  const binding = '2026-11-02T01:00:00.000Z';
  const close = '2026-11-04T01:00:00.000Z';
  const later = '2026-11-10T01:00:00.000Z';
  const reopened = '2026-11-05T01:00:00.000Z';
  for (const branch of ['kept-story', 'reopened-story', 'active-story', 'kept-initiative']) git('branch', branch);
  const first = await recordWork(fixture, 'kept-story', { id: 'STORY-KEPT', kind: 'story', status: 'in_progress', eventType: 'binding', date: binding, legacy: true });
  await recordWork(fixture, 'reopened-story', { id: 'STORY-REOPEN', kind: 'story', status: 'in_progress', eventType: 'binding', date: binding });
  await recordWork(fixture, 'active-story', { id: 'STORY-ACTIVE', kind: 'story', status: 'in_progress', eventType: 'binding', date: binding });
  await recordWork(fixture, 'kept-initiative', { id: 'INIT-KEPT', kind: 'initiative', status: 'in_progress', eventType: 'binding', date: binding, legacy: true });
  const finished = await recordWork(fixture, 'kept-story', { id: 'STORY-KEPT', kind: 'story', status: 'closed', eventType: 'phase-approved', date: close, legacy: true });
  await recordWork(fixture, 'reopened-story', { id: 'STORY-REOPEN', kind: 'story', status: 'closed', eventType: 'phase-approved', date: close });
  const initiative = await recordWork(fixture, 'kept-initiative', { id: 'INIT-KEPT', kind: 'initiative', status: 'complete', eventType: 'phase-approved', date: close, legacy: true });
  await recordWork(fixture, 'reopened-story', { id: 'STORY-REOPEN', kind: 'story', status: 'in_progress', eventType: 'workflow-reopened', date: reopened });
  await recordWork(fixture, 'kept-story', { id: 'STORY-KEPT', kind: 'story', status: 'closed', eventType: 'evidence-recorded', date: later, legacy: true });
  git('switch', '-q', 'main');
  git('branch', '-D', 'kept-story', 'kept-initiative');
  const refs = git('show-ref');
  const ids = value => value.history.rows.map(row => row.id).sort();
  assert.deepEqual(ids(cli('currently completed stories')), ['STORY-KEPT']);
  assert.deepEqual(ids(cli('stories completed from 2026-11-01 to 2026-11-07')), ['STORY-KEPT', 'STORY-REOPEN']);
  assert.deepEqual(ids(cli('stories with activity from 2026-11-01 to 2026-11-07')), ['STORY-ACTIVE', 'STORY-KEPT', 'STORY-REOPEN']);
  assert.equal(cli('stories completed from 2026-11-10 to 2026-11-10').coverage.count.total, 0);
  const asOf = cli('story STORY-KEPT as of 2026-11-03');
  assert.equal(asOf.history.rows[0].status, 'in_progress');
  assert.equal(asOf.history.rows[0].commit, first);
  assert.equal(cli('story STORY-KEPT as of 2026-11-04').history.rows[0].commit, finished);
  assert.equal(cli('story STORY-KEPT as of 2026-11-01').diagnostics[0].code, 'ASK_AS_OF_BASELINE_UNAVAILABLE');
  const currentInitiatives = cli('currently completed initiatives');
  assert.deepEqual(ids(currentInitiatives), ['INIT-KEPT']);
  assert.equal(currentInitiatives.history.rows[0].commit, initiative);
  assert.equal(currentInitiatives.history.rows[0].recordPath, 'custom/initiatives/INIT-KEPT/state.json');
  assert.equal(cli('initiatives completed from 2026-11-01 to 2026-11-07').history.rows[0].completedAt, close);
  assert.equal(cli('history for initiative INIT-KEPT').coverage.count.total, 2);
  assert.equal(git('show-ref'), refs);
  assert.equal(git('status', '--porcelain'), '');

  const blob = git('rev-parse', initiative + ':custom/initiatives/INIT-KEPT/state.json');
  await rm(path.join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  const unavailable = await ask('currently completed initiatives');
  assert.equal(unavailable.coverage.status, 'partial');
  assert.equal(unavailable.coverage.count.total, null);
  assert.equal(unavailable.diagnostics[0].code, 'ASK_WORK_RECORD_UNAVAILABLE');
  assert.equal((await ask('history for initiative INIT-KEPT')).coverage.count.total, 2);
});

test('R2 continues an older archived Story from a pinned retained ledger page', async t => {
  const { root, env, git, file, commit, cli, initial } = await repo(t);
  await file('singularity/workflow.yml', 'ledger:\n  enabled: true\n  branch: retained-state\n  publication: off\n');
  commit('enable retained work history');
  await initializeLedger(root, ledger, { publish: false, refreshRemote: false, env });
  git('switch', '-q', ledger.branch);
  let parentEntryHash = null;
  for (let index = 0; index < 1001; index++) {
    const id = index === 0 ? 'STORY-ARCHIVED' : 'STORY-MORE';
    const intent = createLedgerIntent({
      eventType: 'evidence-recorded', capabilityId: 'test-history', actor,
      subject: { kind: 'story', workId: id, branch: id, canonicalBranch: id, title: id,
        status: index === 0 ? 'archived' : 'in_progress', progress: {}, createdAt: day, createdBy: actor.name }
    });
    const entry = {
      ...intent, createdAt: day, idempotencyKey: 'fixture-' + index, parentEntryHash,
      transport: { publishedCommit: initial, recordedAt: day }
    };
    entry.payloadDigest = ledgerPayloadDigest(entry);
    const bytes = canonicalJson(entry);
    parentEntryHash = sha256(bytes);
    await file('ledger/entries/test-history/' + parentEntryHash + '.json', bytes);
  }
  await file('ledger/head.json', canonicalJson({ schemaVersion: currentSchemaVersion('ledger-entry'), sequence: 1001, entryHash: parentEntryHash }));
  const retained = commit('retained state checkpoint');
  git('switch', '-q', 'main');

  const first = cli('history for story STORY-ARCHIVED');
  assert.equal(first.history.scope.snapshot, retained);
  assert.equal(first.coverage.status, 'partial');
  assert.equal(first.coverage.count.total, null);
  assert.equal(first.history.rows.length, 0);
  assert.ok(first.continuation?.cursor);

  git('switch', '-q', ledger.branch);
  await file('ledger/head.json', canonicalJson({ schemaVersion: currentSchemaVersion('ledger-entry'), sequence: 1002, entryHash: parentEntryHash }));
  commit('advance ledger ref with inconsistent test data');
  git('switch', '-q', 'main');
  const next = cli('--cursor=' + first.continuation.cursor);
  assert.equal(next.history.scope.snapshot, retained);
  assert.equal(next.history.rows[0].status, 'archived');
  assert.deepEqual(next.coverage.count, { unit: 'events', retrieved: 1, total: 1 });
  const damaged = cli('history for story STORY-ARCHIVED');
  const damagedPage = cli('--cursor=' + damaged.continuation.cursor);
  assert.equal(damagedPage.coverage.count.total, null);
  assert.equal(damagedPage.diagnostics[0].code, 'LEDGER_CHAIN_INVALID');
});

test('R2 comparison keeps both exact endpoints when the selected refs move between pages', async t => {
  const { git, initial, file, commit, cli } = await repo(t);
  git('branch', 'left', initial);
  for (let index = 0; index < 63; index++) {
    await file('changes/file-' + String(index).padStart(2, '0') + '.txt', 'endpoint file ' + index + '\n');
  }
  const right = commit('right endpoint');
  git('branch', 'right', right);
  const first = cli('compare left with right', '--for-person');
  assert.equal(first.comparison.rows.length, 60);
  assert.equal(first.coverage.count.total, null);
  git('branch', '-f', 'left', right);
  git('branch', '-f', 'right', initial);
  const second = cli('--cursor', first.continuation.cursor, '--for-person');
  assert.deepEqual([second.comparison.left.revision, second.comparison.right.revision], [initial, right]);
  assert.deepEqual(second.coverage.count, { unit: 'paths', retrieved: 63, total: 63 });
  assert.deepEqual(second.comparison.rows.map(row => row.path), [
    'changes/file-60.txt', 'changes/file-61.txt', 'changes/file-62.txt'
  ]);
});
