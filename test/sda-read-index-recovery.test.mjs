/**
 * The read index answers from the right repository's last-known state, or from the local clone,
 * whenever it can; every successful refresh replaces its record; a refresh lease never sticks; and
 * every stale answer or refusal names its real cause and a way out that works (SDA sweep, batch 4).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  cachedSessionListing, cachedStoryIntakeCatalog, projectionSidecars, readProjectionRecord, readRefreshAttempt,
  remoteAuthority, checkoutRemoteConfiguration, repositoryCheckStatus, sessionListingDirectory, withFreshRepositoryChecks
} from '../src/repository-check-cache.mjs';
import { lastKnownStoryList } from '../src/projection-refresh.mjs';
import { acquireFileLease, inspectFileLease } from '../src/file-lease.mjs';
import { LEASE_PROCESS_STARTED_AT, localMachineId } from '../src/lease-liveness.mjs';
import { refreshFailureGuidance } from '../src/git-remote-diagnostics.mjs';
import { gitConfigRemoteUrl } from '../src/git-config-value.mjs';
import { listingRefreshRoute } from '../src/commands/session.mjs';
import { workConsistency } from '../src/gateway/work-records.mjs';
import { resolveInitiativeIdentity } from '../src/subject-identity-records.mjs';
import { retainedStoryPublication } from '../src/commands/status-read.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const BIN = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const READER = fileURLToPath(new URL('./helpers/sda-index-reader.mjs', import.meta.url));
const FILE_LEASE = pathToFileURL(path.resolve('src/file-lease.mjs')).href;

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-index-recovery-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(base, 'empty-config'),
    SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES: path.join(base, 'state', 'preferences.json'),
    SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(base, 'outbox'), SINGULARITY_FLOW_INDEX_REFRESH: 'off',
    SINGULARITY_FLOW_REPOSITORY_CHECK_MODE: 'cached', SINGULARITY_FLOW_REPOSITORY_CHECK_INTERVAL_MINUTES: '30' };
  delete env.SINGULARITY_FLOW_GIT_FACT_CACHE;
  await mkdir(path.join(base, 'state'), { mode: 0o700 });
  const repository = async (name, configure = null) => {
    const root = path.join(base, name);
    await mkdir(root);
    const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe', encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Index tester'); git('config', 'user.email', 'index@example.invalid');
    await writeFile(path.join(root, 'observed.json'), '{}\n');
    git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    if (configure) await writeFile(path.join(root, '.git', 'config'), `${await readFile(path.join(root, '.git', 'config'), 'utf8')}${configure}`);
    const directory = path.join(root, '.git/singularity-flow/cache/repository-checks');
    return { root, git, directory, observed: path.join(root, 'observed.json') };
  };
  const index = (cwd, ...args) => {
    const extra = typeof args.at(-1) === 'object' ? args.pop() : {};
    const child = spawnSync(process.execPath, [BIN, 'index', ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120_000 });
    let result = null; try { result = JSON.parse(child.stdout); } catch { /* text output */ }
    return { child, result };
  };
  return { base, env, repository, index };
}

const records = async (directory) => (await readdir(directory).catch(() => []))
  .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).map((name) => path.join(directory, name));
const age = async (file, ms) => {
  const stored = JSON.parse(await readFile(file, 'utf8')); stored.checkedAt = Date.now() - ms;
  await writeFile(file, JSON.stringify(stored), { mode: 0o600 });
};
const unreachable = () => { throw new SingularityFlowError('Could not read from the remote.', { code: 'REMOTE_REMOTE_NOT_FOUND' }); };
const catalog = (extra = {}) => async () => ({ choicesComplete: true, intake: { storyWorkflows: [] }, unreachable: [], ...extra });
const listed = (discovered = {}) => async () => ({ discovered: { items: [], count: 0, unavailableCount: 0, unavailable: [], ...discovered }, scope: {} });

test('U1: remotes are read as Git reads them, and every checkout keeps its own authority', async (t) => {
  const f = await fixture(t);
  const upper = await f.repository('upper', '[REMOTE "origin"]\n\tURL = https://example.invalid/team/upper.git\n');
  assert.deepEqual(checkoutRemoteConfiguration(upper.root).remotes, [{ remote: 'origin', key: 'url', url: 'https://example.invalid/team/upper.git' }],
    'section and key names compare without case, as Git compares them');
  const legacy = await f.repository('legacy', '[remote.Origin]\n  url = "https://example.invalid/team/\\"quoted\\".git" ; a comment\n'
    + '[remote "second"]\n  url = https://example.invalid/\\\n  continued.git # trailing comment\n'
    + '[url "https://mirror.invalid/"]\n  insteadOf = https://example.invalid/\n');
  const configuration = checkoutRemoteConfiguration(legacy.root);
  assert.equal(configuration.confident, true);
  assert.deepEqual(configuration.remotes, [
    { remote: 'origin', key: 'url', url: 'https://example.invalid/team/"quoted".git' },
    { remote: 'second', key: 'url', url: 'https://example.invalid/  continued.git' }]);
  // The same values Git itself reads from that file.
  const gitRead = (root) => legacy.git('config', '--file', path.join(root, '.git', 'config'), '--get-regexp', '^remote\\..*\\.url$')
    .split('\n').map((line) => line.slice(line.indexOf(' ') + 1));
  assert.deepEqual(configuration.remotes.map((entry) => entry.url), gitRead(legacy.root));
  assert.deepEqual(checkoutRemoteConfiguration(upper.root).remotes.map((entry) => entry.url), gitRead(upper.root));
  assert.deepEqual(configuration.rewrites, [{ base: 'https://mirror.invalid/', key: 'insteadof', value: 'https://example.invalid/' }]);
  // Every reader of a checkout's origin reads it the same way (the Story index, an unreadable clone's listing).
  assert.equal(gitConfigRemoteUrl('[REMOTE "origin"]\n\tURL = "https://example.invalid/a.git" # note\n'), 'https://example.invalid/a.git');
  assert.equal(gitConfigRemoteUrl('[remote.origin]\n  url = https://example.invalid/b.git\n'), 'https://example.invalid/b.git');
  // A configuration this cannot follow is not known, and an unknown authority is never served.
  const included = await f.repository('included', '[include]\n  path = other-remotes.inc\n');
  assert.equal(checkoutRemoteConfiguration(included.root).confident, false);
  assert.equal(remoteAuthority([included.root]), null);
  // Two checkouts with no remotes, or remotes this used to miss, never share an authority again.
  const bare1 = await f.repository('bare-one');
  const bare2 = await f.repository('bare-two');
  const upper2 = await f.repository('upper-two', '[REMOTE "origin"]\n\tURL = https://example.invalid/team/other.git\n');
  assert.notEqual(remoteAuthority([bare1.root]), remoteAuthority([bare2.root]));
  assert.notEqual(remoteAuthority([upper.root]), remoteAuthority([upper2.root]));

  // The record of one repository is never the last-known answer of another, read from the same place.
  const launcher = await f.repository('launcher');
  const read = (settingsRoot, verify) => cachedSessionListing(launcher.root, { identity: { list: 'selected' },
    files: [launcher.observed], env: f.env, settingsRoot }, verify);
  await read(upper.root, listed({ items: [{ id: 'UPPER-1' }], count: 1 }));
  const [file] = await records(sessionListingDirectory(f.env));
  await age(file, 31 * 60_000);
  await assert.rejects(withFreshRepositoryChecks(() => read(upper2.root, unreachable)), { code: 'REMOTE_REMOTE_NOT_FOUND' },
    'a failed refresh for another repository refuses rather than answering with the previous repository\'s Stories');
  await assert.rejects(withFreshRepositoryChecks(() => cachedSessionListing(launcher.root, { identity: { list: 'selected' },
    files: [launcher.observed], env: f.env, settingsRoot: included.root }, unreachable)), { code: 'REMOTE_REMOTE_NOT_FOUND' });
});

test('A1: a record this process cannot use counts as missing, and VS Code and a terminal keep their own records', async (t) => {
  const f = await fixture(t);
  const repo = await f.repository('app', '[remote "origin"]\n\turl = https://example.invalid/team/app.git\n');
  const calls = [];
  const read = (env = f.env) => cachedSessionListing(repo.root, { identity: { list: 'app' }, files: [repo.observed], env },
    async ({ allowLocal } = {}) => { calls.push(allowLocal); return (await listed())(); });
  await read();
  assert.deepEqual(calls, [true], 'never synchronized: the first read may answer from the local clone');
  const [file] = await records(sessionListingDirectory(f.env));
  // Another build, a moved checkout, another environment or a clock that went back: the key differs.
  const stored = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...stored, key: `${stored.key.slice(0, -4)}beef` }), { mode: 0o600 });
  await read();
  assert.deepEqual(calls, [true, true], 'an unusable record is no record: the local first read answers again');
  await read();
  assert.equal(calls.length, 2, 'and its answer replaced the record');
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), checkedAt: Date.now() + 3_600_000 }), { mode: 0o600 });
  await read();
  assert.deepEqual(calls, [true, true, true], 'a record checked in the future (the clock went back) is no record either');

  // The VS Code surface's environment names its own file: a terminal read never replaces it.
  const vscode = { ...f.env, SINGULARITY_FLOW_SURFACE_CONTEXT: JSON.stringify({ schemaVersion: 1, repositoryPath: repo.root }) };
  await read(vscode);
  assert.equal((await records(sessionListingDirectory(f.env))).length, 2);
  const before = calls.length;
  await read(); await read(vscode);
  assert.equal(calls.length, before, 'each surface reuses its own record');
  // The repository-check settings say how long a record is reused, never what it answers.
  await read({ ...f.env, SINGULARITY_FLOW_REPOSITORY_CHECK_INTERVAL_MINUTES: '5' });
  assert.equal(calls.length, before);
});

test('A1, A4, A10: index status names a record it cannot use, verify names the rebuild that reaches it, rebuild discards it', async (t) => {
  const f = await fixture(t);
  const repo = await f.repository('app');
  const scratch = await f.repository('scratch');
  await cachedStoryIntakeCatalog(repo.root, { identity: { catalog: 'status' }, files: [repo.observed], env: f.env,
    refreshRecipe: { argv: ['workspace', 'branches', '--intake', '--json'], cwd: repo.root } }, catalog());
  const [record] = await records(repo.directory);
  const stored = JSON.parse(await readFile(record, 'utf8'));
  await writeFile(record, JSON.stringify({ ...stored, binding: { ...stored.binding, build: '0'.repeat(16) } }), { mode: 0o600 });
  // A listing whose read ran in a folder that is gone (a moved checkout), and one that cannot be verified.
  await cachedSessionListing(scratch.root, { identity: { list: 'gone' }, files: [scratch.observed], env: f.env,
    refreshRecipe: { argv: ['session', 'candidates', '--json'], cwd: scratch.root } }, listed());
  await rm(scratch.root, { recursive: true, force: true });
  const corrupt = path.join(sessionListingDirectory(f.env), `${'a'.repeat(64)}.json`);
  await writeFile(corrupt, '{"format":1,"key":"x","checkedAt":1,', { mode: 0o600 });

  const status = f.index(repo.root, 'status', '--json').result;
  const catalogEntry = status.projections.find((item) => item.kind === 'story-intake-catalog');
  assert.equal(catalogEntry.usable, false);
  assert.equal(catalogEntry.notUsable, 'another-build');
  assert.match(f.index(repo.root, 'status').child.stdout, /Not usable here: another build of singularity-flow wrote it\. The next read replaces it; index rebuild discards it\./u);
  // An unverifiable listing cannot say whose it is, so the repository scope shows it too (A4).
  assert.ok(status.projections.some((item) => item.record === path.basename(corrupt) && item.integrity === 'unverifiable'));
  const verify = f.index(repo.root, 'verify', '--json');
  assert.equal(verify.child.status, 1);
  assert.equal(verify.result.repair, 'singularity-flow index rebuild');
  assert.equal(f.index(repo.root, 'verify', '--all', '--json').result.repair, 'singularity-flow index rebuild --all',
    'a machine-wide verify names the machine-wide rebuild');

  const rebuilt = f.index(repo.root, 'rebuild', '--json').result.rebuilt;
  assert.ok(rebuilt.some((item) => item.record === path.basename(record) && item.outcome === 'discarded'
    && /another build/u.test(item.reason)), JSON.stringify(rebuilt));
  assert.ok(rebuilt.some((item) => item.record === path.basename(corrupt) && item.outcome === 'discarded'));
  assert.equal(f.index(repo.root, 'verify', '--json').result.ok, true);
  // The listing of a folder that is gone is another repository's: rebuild --all discards it (A10).
  const all = f.index(repo.root, 'rebuild', '--all', '--json').result.rebuilt;
  assert.ok(all.some((item) => item.kind === 'session-listing' && item.outcome === 'discarded'
    && /folder its read ran in is gone/u.test(item.reason)), JSON.stringify(all));
  assert.deepEqual(await records(sessionListingDirectory(f.env)), []);
});

test('A2: a read keeps its answer when its own fetch moved a remote-tracking ref, and not when anything else changed', async (t) => {
  const f = await fixture(t);
  const repo = await f.repository('app');
  const fetched = path.join(repo.root, '.git', 'refs', 'remotes', 'origin', 'state');
  const read = (verify) => cachedSessionListing(repo.root, { identity: { list: 'fetch' }, files: [repo.observed, fetched],
    selfUpdated: [fetched], env: f.env, refreshRecipe: { argv: ['session', 'candidates', '--json'], cwd: repo.root } }, verify);
  let reads = 0;
  const fetching = async () => {
    reads += 1;
    await mkdir(path.dirname(fetched), { recursive: true });
    await writeFile(fetched, `${String(reads).padStart(40, '0')}\n`);
    return (await listed({ ledgerCommit: String(reads).padStart(40, '0') }))();
  };
  await withFreshRepositoryChecks(() => read(fetching));
  assert.equal((await records(sessionListingDirectory(f.env))).length, 1, 'the first read stores its answer');
  await read(fetching);
  assert.equal(reads, 1, 'and the next routine read is served from it, waiting on no network');
  await withFreshRepositoryChecks(() => read(fetching));
  const [file] = await records(sessionListingDirectory(f.env));
  assert.equal(readProjectionRecord(file, null).acceptedRevision.ledgerCommit, '2'.padStart(40, '0'), 'every refresh replaces it');
  // Anything else changing during the read is not kept, and the attempt says why.
  await withFreshRepositoryChecks(() => read(async () => {
    await writeFile(repo.observed, '{"changed":true}\n');
    return fetching();
  }));
  assert.equal(readProjectionRecord(file, null).acceptedRevision.ledgerCommit, '2'.padStart(40, '0'));
  assert.equal(readRefreshAttempt(file).notKeptReason, 'Something it depends on changed while it was read.');
});

test('A3: a refresh that failed for a cause a retry does not end names its fix, never --refresh again', () => {
  const kept = { code: 'SESSION_STATE_REFRESH_UNAVAILABLE', remoteFailure: { stage: 'observation', classification: 'remote-not-found',
    code: 'REMOTE_REMOTE_NOT_FOUND', retryable: false, advice: 'Verify the repository URL and your access to it, then retry.' } };
  const guidance = refreshFailureGuidance(kept, { retry: '--refresh' });
  assert.equal(guidance.cause, 'SESSION_STATE_REFRESH_UNAVAILABLE: REMOTE_REMOTE_NOT_FOUND');
  assert.equal(guidance.text, 'Verify the repository URL and your access to it, then retry. '
    + 'Diagnose the connection with: singularity-flow workspace doctor --network.');
  const route = listingRefreshRoute({ freshness: 'refresh-failed', refreshError: kept });
  assert.doesNotMatch(route, /--refresh/u);
  assert.match(route, /workspace doctor --network/u);
  // A bare remote code carries its classification; a cause a retry may end still names the retry.
  assert.equal(refreshFailureGuidance({ code: 'REMOTE_REMOTE_NOT_FOUND' }).retryable, false);
  assert.match(listingRefreshRoute({ freshness: 'refresh-failed', refreshError: { code: 'REMOTE_NETWORK_TRANSIENT' } }),
    /Check DNS and network reachability.*Retry with: --refresh\./u);
  assert.equal(listingRefreshRoute({ freshness: 'stale' }), 'Use --refresh for a fresh listing.');
});

test('A5: a refresh lease is judged by machine identity and process start, and one no process here holds names its release', async (t) => {
  const f = await fixture(t);
  const repo = await f.repository('app');
  let n = 0;
  const read = (verify) => cachedStoryIntakeCatalog(repo.root, { identity: { catalog: 'lease' }, files: [repo.observed], env: f.env,
    refreshRecipe: { argv: ['no-such-read'], cwd: repo.root } }, verify);
  const next = catalog({ n: 0 });
  await read(async () => ({ ...await next(), n: ++n }));
  const [file] = await records(repo.directory);
  const leaseFile = projectionSidecars(file).lease;
  const now = new Date().toISOString();
  const writeLease = (owner) => writeFile(leaseFile, JSON.stringify({ version: 3, nonce: randomUUID(), createdAt: now, heartbeatAt: now, ...owner }), { mode: 0o600 });

  // A PID the OS gave to another running process (it started after the recorded owner did): dead.
  await writeLease({ pid: 1, host: os.hostname(), machineId: localMachineId(), processStartedAt: Date.parse('2000-01-01T00:00:00Z'),
    processToken: randomUUID() });
  assert.equal((await inspectFileLease(leaseFile)).state, 'reclaimable');
  // A hostname that changed with the network keeps the machine: a dead owner is still taken over.
  await writeLease({ pid: 2 ** 22 + 17, host: 'renamed-by-the-network.local', machineId: localMachineId(),
    processStartedAt: LEASE_PROCESS_STARTED_AT, processToken: randomUUID() });
  assert.equal((await inspectFileLease(leaseFile)).state, 'reclaimable');
  const started = Date.now();
  await withFreshRepositoryChecks(() => read(async () => ({ ...await next(), n: ++n })));
  assert.equal(n, 2, 'the refresh took the dead owner\'s lease over and read at once');
  assert.ok(Date.now() - started < 10_000);

  // An owner this machine cannot judge (an older record whose running PID proves nothing): never
  // taken over, never waited for, and named with its review and reviewed release.
  await age(file, 31 * 60_000);
  const nonce = randomUUID();
  await writeFile(leaseFile, JSON.stringify({ version: 2, pid: 1, host: os.hostname(), nonce, createdAt: now, heartbeatAt: now }), { mode: 0o600 });
  const held = await inspectFileLease(leaseFile);
  assert.deepEqual([held.state, held.active], ['busy', false]);
  assert.equal(held.releaseCommand, `singularity-flow lock release-file ${JSON.stringify(leaseFile)} --confirm ${nonce}`);
  assert.equal((await read(unreachable)).n, 2);
  assert.notEqual(repositoryCheckStatus(repo.root).backgroundRefresh, 'in-flight', 'not reported as a refresh in flight forever');
  const explicit = Date.now();
  await withFreshRepositoryChecks(() => read(async () => ({ ...await next(), n: ++n })));
  assert.equal(n, 3, 'an explicit refresh reads at once');
  assert.ok(Date.now() - explicit < 10_000, 'without waiting on a lease no running process holds');
  const status = f.index(repo.root, 'status', '--json').result.projections.find((item) => item.kind === 'story-intake-catalog');
  assert.deepEqual([status.refreshing, status.refreshLease.state, status.refreshLease.token], [false, 'held', nonce]);
  // The repository's own path, as Git resolves it (a temporary folder may be reached through a link).
  assert.equal(status.refreshLease.release,
    `singularity-flow lock release-file ${JSON.stringify(path.join(await realpath(path.dirname(leaseFile)), path.basename(leaseFile)))} --confirm ${nonce}`);
  assert.match(f.index(repo.root, 'status').child.stdout, /never taken over by age\. Review it with: singularity-flow lock show-file/u);
  // Rebuild leaves it for the reviewed release; the release, run from the repository or not, ends it.
  f.index(repo.root, 'rebuild', '--json');
  assert.ok((await readdir(repo.directory)).some((name) => name.endsWith('.lease')));
  const lock = (...args) => spawnSync(process.execPath, [BIN, 'lock', ...args, '--json'], { cwd: f.base, env: f.env, encoding: 'utf8' });
  const shown = JSON.parse(lock('show-file', leaseFile).stdout);
  assert.deepEqual([shown.form, shown.held, shown.releaseCommand], ['cache', true, held.releaseCommand]);
  const released = lock('release-file', leaseFile, '--confirm', nonce);
  assert.equal(released.status, 0, released.stderr);
  assert.equal(JSON.parse(released.stdout).released, true);
  assert.equal((await inspectFileLease(leaseFile)).state, 'missing');
});

test('U2: index rebuild removes a refresh lease only when its owner is proven stopped', async (t) => {
  const f = await fixture(t);
  const repo = await f.repository('app');
  await mkdir(repo.directory, { recursive: true, mode: 0o700 });
  // A first refresh holds its lease before its record exists.
  const live = path.join(repo.directory, `${'b'.repeat(64)}.lease`);
  const holder = spawn(process.execPath, ['--input-type=module', '-e',
    `import { acquireFileLease } from ${JSON.stringify(FILE_LEASE)}; await acquireFileLease(${JSON.stringify(live)});
     process.stdout.write('READY\\n'); setInterval(() => {}, 1000);`], { env: f.env, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill('SIGKILL'));
  await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('exit', () => reject(new Error('holder exited'))); });
  // And one left by a process that stopped.
  const stopped = path.join(repo.directory, `${'c'.repeat(64)}.lease`);
  const exited = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { acquireFileLease } from ${JSON.stringify(FILE_LEASE)}; await acquireFileLease(${JSON.stringify(stopped)}); process.exit(0);`],
  { env: f.env, encoding: 'utf8' });
  assert.equal(exited.status, 0, exited.stderr);
  assert.equal((await inspectFileLease(stopped)).state, 'reclaimable');

  const verify = f.index(repo.root, 'verify', '--json').result;
  assert.equal(verify.orphanSidecars, 1, 'a held lease is held, not an orphan');
  const rebuilt = f.index(repo.root, 'rebuild', '--json').result;
  assert.equal(rebuilt.orphanSidecarsRemoved, 1);
  assert.equal((await inspectFileLease(live)).state, 'busy', 'the live first refresh keeps its lease');
  assert.equal((await inspectFileLease(stopped)).state, 'missing');
});

test('U3: while a refresh runs here, a read with a last-known record serves it and never reads the network again', async (t) => {
  const f = await fixture(t);
  const repo = await f.repository('app');
  let n = 0;
  const read = (verify) => cachedStoryIntakeCatalog(repo.root, { identity: { catalog: 'waiter' }, files: [repo.observed], env: f.env }, verify);
  await read(async () => ({ ...await catalog()(), n: ++n }));
  const [file] = await records(repo.directory);
  const lease = await acquireFileLease(projectionSidecars(file).lease);
  t.after(() => lease.release());
  await writeFile(repo.observed, '{"moved":true}\n');
  const started = Date.now();
  const served = await read(async () => ({ ...await catalog()(), n: ++n }));
  assert.equal(served.n, 1);
  assert.equal(n, 1, 'no second network read');
  assert.ok(Date.now() - started < 5_000, 'and no wait in the foreground');
  const status = repositoryCheckStatus(repo.root);
  assert.deepEqual([status.source, status.freshness, status.backgroundRefresh], ['last-known', 'stale', 'in-flight']);
});

test('U3: three concurrent slow readers with no record read the network once', slowLane({ timeout: 300_000 }), async (t) => {
  const f = await fixture(t);
  const repo = await f.repository('app');
  const counter = path.join(f.base, 'observations.log');
  // Slower than the 30 s a waiter used to give up after, when each waiter read the network again.
  const reader = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [READER, repo.root, repo.observed, counter, '33000'], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stderr, result: status === 0 ? JSON.parse(stdout) : null }));
  });
  const results = await Promise.all([reader(), reader(), reader()]);
  for (const run of results) assert.equal(run.status, 0, run.stderr);
  const observations = (await readFile(counter, 'utf8')).trim().split('\n');
  t.diagnostic(`fetches with three concurrent 33 s readers: ${observations.length}`);
  assert.equal(observations.length, 1, `one fetch, not ${observations.length}`);
  assert.deepEqual(results.map((run) => run.result.status.source).sort(), ['fresh', 'shared', 'shared']);
});

test('A6: a listing of another repository named by URL is never this repository\'s', async (t) => {
  const f = await fixture(t);
  const repo = await f.repository('a', '[remote "origin"]\n\turl = https://example.invalid/team/a.git\n');
  const previous = process.cwd();
  process.chdir(repo.root);
  t.after(() => process.chdir(previous));
  const saved = { ...process.env };
  Object.assign(process.env, f.env);
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  const { sessionListingSnapshot } = await import('../src/session-listing-cache.mjs');
  const other = { discovered: { source: 'remote-url', ledgerCommit: 'b'.repeat(40), items: [{ id: 'B-1' }], count: 1, unavailableCount: 0, unavailable: [] } };
  await sessionListingSnapshot(['session', 'candidates'], { 'repository-url': 'https://example.invalid/team/b.git' }, async () => other);
  const [file] = await records(sessionListingDirectory(f.env));
  assert.deepEqual(readProjectionRecord(file, null).binding.authority, { repositoryUrl: 'https://example.invalid/team/b.git', configurationUrl: null });
  assert.equal(await lastKnownStoryList(repo.root, { env: f.env }), null);
  assert.equal((await workConsistency(repo.root, { env: f.env })).freshness, null, 'A never reports B\'s ledger as its own');
});

test('A7, A12: a partial refresh is recorded as partial, and manual refresh is never called fresh', async (t) => {
  const f = await fixture(t);
  const repo = await f.repository('app');
  const read = (verify, env = f.env) => cachedSessionListing(repo.root, { identity: { list: 'partial' }, files: [repo.observed], env,
    refreshRecipe: { argv: ['session', 'candidates', '--json'], cwd: repo.root } }, verify);
  await read(listed({ items: [{ id: 'S-1' }], count: 1, ledgerCommit: 'c'.repeat(40) }));
  const [file] = await records(sessionListingDirectory(f.env));
  await withFreshRepositoryChecks(() => read(async () => {
    throw new SingularityFlowError('Could not reach the remote.', { code: 'SESSION_STATE_REFRESH_UNAVAILABLE',
      details: { remoteFailure: { stage: 'fetch', failure: { classification: 'network-transient', code: 'REMOTE_NETWORK_TRANSIENT', retryable: true } } } });
  }));
  const partial = await withFreshRepositoryChecks(() => read(listed({ items: [], count: 1, unavailableCount: 1, unavailable: [{ id: 'S-1' }] })));
  assert.equal(partial.discovered.unavailableCount, 1);
  assert.equal(repositoryCheckStatus(repo.root).completeness, 'partial');
  const attempt = readRefreshAttempt(file);
  assert.equal(attempt.error.code, 'SESSION_STATE_REFRESH_UNAVAILABLE', 'a partial refresh clears no earlier error');
  assert.equal(attempt.succeededAt, undefined, 'and is never written as a success');
  assert.equal(attempt.partialReason, '1 Story rows could not be read.');
  const list = await lastKnownStoryList(repo.root, { env: f.env });
  assert.deepEqual([list.freshness, list.completeness], ['refresh-failed', 'partial']);
  assert.equal(readProjectionRecord(file, null).acceptedRevision.ledgerCommit, 'c'.repeat(40), 'the complete record stands');

  // Manual refresh: a record of any age is reported with its age and as stale, never as verified now.
  await withFreshRepositoryChecks(() => read(listed({ items: [{ id: 'S-1' }], count: 1, ledgerCommit: 'd'.repeat(40) })));
  const manual = { ...f.env, SINGULARITY_FLOW_REPOSITORY_CHECK_MODE: 'manual' };
  await read(listed(), manual);
  const status = repositoryCheckStatus(repo.root);
  assert.deepEqual([status.source, status.freshness, status.backgroundRefresh], ['cache', 'stale', 'manual']);
  assert.equal((await lastKnownStoryList(repo.root, { env: manual })).freshness, 'stale');
});

test('A9: an unrecorded Initiative names the fetch first; ambiguous identities name a way out', () => {
  const identities = { offline: true, records: [{ id: 'EPIC-1', branch: 'feature/one', aliases: ['shared'] },
    { id: 'EPIC-2', branch: 'feature/two', aliases: ['shared'] }] };
  assert.throws(() => resolveInitiativeIdentity(identities, 'EPIC-9'), (error) => {
    assert.equal(error.code, 'INITIATIVE_IDENTITY_UNRECORDED');
    assert.match(error.message, /started on another computer, fetch its record first: singularity-flow initiative resume EPIC-9 --fetch\./u);
    assert.equal(error.details.nextAction, 'singularity-flow initiative resume EPIC-9 --fetch');
    return true;
  });
  assert.throws(() => resolveInitiativeIdentity({ ...identities, offline: false }, 'EPIC-9'),
    (error) => !/--fetch/u.test(error.message) && /ledger reconcile/u.test(error.message));
  assert.throws(() => resolveInitiativeIdentity(identities, 'shared'),
    (error) => error.code === 'INITIATIVE_IDENTITY_AMBIGUOUS' && /singularity-flow initiative resume EPIC-1/u.test(error.message));
});

test('A11: status says a retained publication record it cannot read is unknown, not nothing pending', async (t) => {
  const f = await fixture(t);
  const repo = await f.repository('app');
  const marker = path.join(repo.root, '.git', 'singularity-flow', 'pending-publication', 'story--S-1.json');
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, '{"broken":', { mode: 0o600 });
  const selected = { id: 'S-1', location: { path: path.join(repo.root, 'singularity', 'work-items', 'S-1', 'workflow.json') } };
  const retained = await retainedStoryPublication(repo.root, selected);
  assert.equal(retained.state, 'unreadable');
  assert.equal(retained.nextAction.command, 'singularity-flow doctor --json');
  assert.match(retained.message, /cannot be read, so whether its last transition reached the remote is unknown/u);
});

test('A4, A12: after a failed first read, index status names its cause and fix; manual refresh is never fresh', async (t) => {
  const f = await fixture(t);
  const repo = await f.repository('app');
  const read = (verify) => cachedStoryIntakeCatalog(repo.root, { identity: { catalog: 'first' }, files: [repo.observed], env: f.env,
    refreshRecipe: { argv: ['workspace', 'branches', '--intake', '--json'], cwd: repo.root } }, verify);
  await assert.rejects(read(() => {
    throw new SingularityFlowError('Could not read the repository.', { code: 'SESSION_STATE_REFRESH_UNAVAILABLE',
      details: { remoteFailure: { stage: 'observation', failure: { classification: 'remote-not-found', code: 'REMOTE_REMOTE_NOT_FOUND',
        retryable: false, advice: 'Verify the repository URL and your access to it, then retry.' } } } });
  }), { code: 'SESSION_STATE_REFRESH_UNAVAILABLE' });
  const status = f.index(repo.root, 'status', '--json').result;
  assert.equal(status.firstSynchronization, undefined, 'not the same refresh again');
  assert.deepEqual(status.firstReads.map((item) => [item.read, item.cause]),
    [['workspace branches', 'SESSION_STATE_REFRESH_UNAVAILABLE: REMOTE_REMOTE_NOT_FOUND']]);
  const text = f.index(repo.root, 'status').child.stdout;
  assert.match(text, /workspace branches: never synchronized; the first read failed at .* \(SESSION_STATE_REFRESH_UNAVAILABLE: REMOTE_REMOTE_NOT_FOUND\)\. Verify the repository URL/u);
  assert.match(text, /workspace doctor --network/u);
  assert.doesNotMatch(text, /First synchronization/u);

  // Once a read succeeds the record stands, and with manual refresh its age is never called fresh.
  await read(catalog());
  const manual = f.index(repo.root, 'status', '--json', { SINGULARITY_FLOW_REPOSITORY_CHECK_MODE: 'manual' }).result;
  assert.equal(manual.firstReads, undefined);
  const entry = manual.projections.find((item) => item.kind === 'story-intake-catalog');
  assert.deepEqual([entry.freshness, entry.refresh], ['stale', 'manual']);
  assert.match(f.index(repo.root, 'status', { SINGULARITY_FLOW_REPOSITORY_CHECK_MODE: 'manual' }).child.stdout,
    /repository checks manual \(refreshed only by hand\).*\n.*stale \(refresh is manual\), checked .* \(0 minutes ago\)/u);
});
