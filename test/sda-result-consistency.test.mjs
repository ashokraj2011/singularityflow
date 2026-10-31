/**
 * The consistency block's producers (SDA §14, decision D1): the read index's records carry the
 * revision they were computed from, and the gateway's work list and home read where the
 * repository's Story list stands against its authority from those records alone, with no Git process.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cachedSessionListing, cachedStoryIntakeCatalog, projectionSidecars, readProjectionRecord, repositoryCheckStatus,
  sessionListingDirectory
} from '../src/repository-check-cache.mjs';
import { workConsistency } from '../src/gateway/work-records.mjs';
import { workList } from '../src/gateway/planners/work-list.mjs';
import { homeOverviewResult } from '../src/gateway/planners/home-overview.mjs';
import { validateSflowResult } from '../src/gateway/result.mjs';
import { createTransportIntent } from '../src/transport-intents.mjs';
import { branch } from '../src/git.mjs';

const LEDGER = 'c'.repeat(40);
const AUTHORITY = 'd'.repeat(40);

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-sda-consistency-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(base, 'empty-config'),
    SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES: path.join(base, 'state', 'preferences.json'),
    SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(base, 'outbox'), SINGULARITY_FLOW_INDEX_REFRESH: 'off',
    SINGULARITY_FLOW_REPOSITORY_CHECK_MODE: 'cached', SINGULARITY_FLOW_REPOSITORY_CHECK_INTERVAL_MINUTES: '30' };
  delete env.SINGULARITY_FLOW_GIT_FACT_CACHE;
  await mkdir(path.join(base, 'state'), { mode: 0o700 });
  const remote = path.join(base, 'origin.git');
  const repository = async (name) => {
    const root = path.join(base, name);
    await mkdir(root);
    const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe', encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Packager'); git('config', 'user.email', 'packager@example.com');
    git('remote', 'add', 'origin', remote);
    await writeFile(path.join(root, 'observed.json'), '{}\n');
    git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    return { root, git };
  };
  execFileSync('git', ['init', '--bare', '-q', remote], { env, stdio: 'pipe' });
  return { base, env, remote, repository };
}

/** One Story list read in `root`, as `session candidates` stores it, answered by `discovered`. */
const listing = (f, root, discovered, identity = { list: root }) => cachedSessionListing(root, {
  identity, files: [path.join(root, 'observed.json')], env: f.env,
  refreshRecipe: { argv: ['session', 'candidates', '--json'], cwd: root }
}, async () => ({ discovered: { items: [], count: 0, unavailableCount: 0, unavailable: [], ...discovered }, scope: {} }));

async function listingRecord(f) {
  const directory = sessionListingDirectory(f.env);
  const names = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
  return names.map((name) => path.join(directory, name));
}

test('a last-known record keeps the revision it was computed from, and every read of it says so', async (t) => {
  const f = await fixture(t);
  const { root } = await f.repository('app');
  await listing(f, root, { ledgerCommit: LEDGER });
  assert.deepEqual(repositoryCheckStatus(root).acceptedRevision, { ledgerCommit: LEDGER, authorityCommit: null });
  const [file] = await listingRecord(f);
  assert.deepEqual(readProjectionRecord(file, null).acceptedRevision, { ledgerCommit: LEDGER, authorityCommit: null });
  // Verified without decoding its payload, for a reader that needs only the record.
  const header = readProjectionRecord(file, null, Date.now(), { decode: false });
  assert.equal(header.value, undefined);
  assert.equal(header.kind, 'session-listing');
  await listing(f, root, { ledgerCommit: 'e'.repeat(40) });
  assert.equal(repositoryCheckStatus(root).source, 'cache');
  assert.deepEqual(repositoryCheckStatus(root).acceptedRevision, { ledgerCommit: LEDGER, authorityCommit: null },
    'a hit serves the stored record and its revision, not the one a new read would compute');

  // The intake catalog names the approved configuration commit its choices came from.
  await cachedStoryIntakeCatalog(root, { identity: { catalog: 'revision' }, files: [path.join(root, 'observed.json')], env: f.env },
    async () => ({ choicesComplete: true, intake: { storyWorkflows: [], authorityCommit: AUTHORITY }, unreachable: [] }));
  assert.deepEqual(repositoryCheckStatus(root).acceptedRevision, { ledgerCommit: null, authorityCommit: AUTHORITY });

  // A record an older build wrote has no revision, and says so with null rather than a guess.
  const stored = JSON.parse(await readFile(file, 'utf8'));
  delete stored.acceptedRevision;
  await writeFile(file, JSON.stringify(stored), { mode: 0o600 });
  assert.equal(readProjectionRecord(file, null).acceptedRevision, null);
});

test('the work list and home carry where the repository Story list stands, from the index alone', async (t) => {
  const f = await fixture(t);
  const app = await f.repository('app');
  const elsewhere = await f.repository('elsewhere');
  const consistency = () => workConsistency(app.root, { env: f.env });

  // Never synchronized: a local read with nothing verified, which is not an empty verified list.
  assert.deepEqual(await consistency(), { policy: 'local', scope: 'shared', freshness: null, checkedAt: null,
    acceptedRevision: null, completeness: null, pendingOperations: [] });
  // A list read in another repository is not this one's.
  await listing(f, elsewhere.root, { ledgerCommit: 'f'.repeat(40) });
  assert.equal((await consistency()).freshness, null);

  await listing(f, app.root, { ledgerCommit: LEDGER });
  const fresh = await consistency();
  assert.equal(fresh.freshness, 'fresh');
  assert.equal(fresh.completeness, 'complete');
  assert.deepEqual(fresh.acceptedRevision, { ledgerCommit: LEDGER, authorityCommit: null });
  assert.ok(Math.abs(Date.parse(fresh.checkedAt) - Date.now()) < 60_000);

  const [file] = (await listingRecord(f)).filter((candidate) => readProjectionRecord(candidate, null)?.refresh?.cwd === app.root);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  stored.checkedAt = Date.now() - 31 * 60_000;
  await writeFile(file, JSON.stringify(stored), { mode: 0o600 });
  assert.equal((await consistency()).freshness, 'stale', 'past the repository-check interval');

  // A failed refresh keeps its real error beside the last-known list, structured, never its message.
  await writeFile(projectionSidecars(file).attempt, JSON.stringify({ format: 1, failedAt: new Date().toISOString(),
    error: { code: 'SESSION_STATE_REFRESH_UNAVAILABLE', message: 'Could not refresh the Story state index.',
      remoteFailure: { stage: 'fetch', classification: 'authorization-denied', code: 'REMOTE_AUTHORIZATION_DENIED', retryable: false, timedOut: false } } }),
  { mode: 0o600 });
  const failed = await consistency();
  assert.equal(failed.freshness, 'refresh-failed');
  // The cause under the wrapper code, and a way out a refresh cannot loop on (A3).
  assert.deepEqual(failed.refreshError, { code: 'SESSION_STATE_REFRESH_UNAVAILABLE', stage: 'fetch',
    classification: 'authorization-denied', retryable: false, timedOut: false, cause: 'REMOTE_AUTHORIZATION_DENIED',
    command: 'singularity-flow workspace doctor --network' });
  assert.deepEqual(failed.acceptedRevision, { ledgerCommit: LEDGER, authorityCommit: null }, 'the last-known revision stays');

  // Pushes that have not reached the authority, from this checkout or another one of the repository.
  const head = app.git('rev-parse', 'HEAD');
  const saved = await createTransportIntent({ repositoryRoot: app.root, sourceCommit: head, targetRef: 'refs/heads/WRK-1' }, { env: f.env });
  const other = await f.repository('other-checkout');
  const savedElsewhere = await createTransportIntent({ repositoryRoot: other.root, sourceCommit: other.git('rev-parse', 'HEAD'),
    targetRef: 'refs/heads/WRK-2' }, { env: f.env });
  assert.deepEqual((await consistency()).pendingOperations.map((entry) => [entry.id, entry.kind, entry.status]).sort(),
    [[saved.intentId, 'push', 'pending'], [savedElsewhere.intentId, 'push', 'pending']].sort());

  // Reading it starts no Git process: a Git on PATH that records every call sees none.
  const shims = path.join(f.base, 'shims');
  await mkdir(shims);
  const calls = path.join(f.base, 'git-calls.log');
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  await writeFile(path.join(shims, 'git'), `#!/bin/sh\necho "$@" >> '${calls}'\nexec '${real}' "$@"\n`);
  await chmod(path.join(shims, 'git'), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${shims}${path.delimiter}${previous}`;
  try {
    const block = await workConsistency(app.root, { env: { ...f.env, PATH: process.env.PATH } });
    assert.equal(block.pendingOperations.length, 2);
    assert.equal(await readFile(calls, 'utf8').catch(() => ''), '', 'the consistency read started Git');
    branch(app.root);
    assert.match(await readFile(calls, 'utf8'), /\S/u, 'the recording Git is the one product reads would start');
  } finally { process.env.PATH = previous; }

  // The planners attach it, and the result stays a valid v2 result.
  const listed = await workList({ root: app.root, context: { env: f.env } });
  validateSflowResult(listed);
  assert.equal(listed.consistency.policy, 'local');
  assert.equal(listed.consistency.freshness, 'refresh-failed');
  assert.equal(listed.consistency.pendingOperations.length, 2);
  // A caller that declares none gets none: the block is optional.
  assert.equal(Object.hasOwn(await workList({ root: app.root, context: { consistency: null } }), 'consistency'), false);
  const home = homeOverviewResult({ workspace: { id: 'app', name: 'app' }, records: { items: [], groups: {} },
    consistency: await consistency() });
  validateSflowResult(home);
  assert.equal(home.consistency.freshness, 'refresh-failed');
  assert.equal(Object.hasOwn(homeOverviewResult({ workspace: { id: 'app', name: 'app' }, records: { items: [], groups: {} } }),
    'consistency'), false);

  // A changed remote is another authority: its record no longer speaks for this repository.
  app.git('remote', 'set-url', 'origin', path.join(f.base, 'moved.git'));
  assert.equal((await consistency()).freshness, null);
});
