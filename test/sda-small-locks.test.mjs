// The small local locks (the bootstrap lease, the choices selection receipt, the prompt audit, help
// metrics and the repositories store) were taken over once they were old, whoever held them, and the
// holder's release then removed its successor's lock. They now follow the lease rule (SDA M3): only a
// proven-dead owner is taken over, another machine's names its reviewed release, and only an older
// build's lock, which records no owner, is still judged by its age.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '../src/util.mjs';
import { localMachineId } from '../src/lease-liveness.mjs';
import { acquireFileLease, acquireFileLeaseWithin, heldFileLeaseRoute } from '../src/file-lease.mjs';
import { recordHelpMetric } from '../src/help-metrics.mjs';
import { setPromptAudit } from '../src/prompt-audit.mjs';
import { readProviderCache } from '../src/repositories/store.mjs';
import { consumeSelectionReceipt } from '../src/choices.mjs';
import { activePublicationRefusal, livePreparedPublicationOwner } from '../src/publication-pending.mjs';
import { subjectLockPath } from '../src/subject-lock.mjs';

const machine = await mkdtemp(path.join(os.tmpdir(), 'sflow-small-locks-machine-'));
process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = path.join(machine, 'active.json');
process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = path.join(machine, 'registry.json');

const TOKEN = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const HOUR_AGO = new Date(Date.now() - 60 * 60_000);
const exists = (file) => lstat(file).then(() => true, () => false);

async function exitedPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  return pid;
}

const owner = (fields) => ({ version: 3, nonce: randomUUID(), createdAt: HOUR_AGO.toISOString(),
  heartbeatAt: HOUR_AGO.toISOString(), ...fields });
const foreignOwner = () => owner({ pid: 4242, host: 'other-laptop.example', machineId: '0a1b2c3d-0000-4000-8000-000000000000' });
const deadOwner = async () => owner({ pid: await exitedPid(), host: os.hostname(), ...(localMachineId() ? { machineId: localMachineId() } : {}) });

async function placeLock(file, content) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, typeof content === 'string' ? content : `${JSON.stringify(content)}\n`, { mode: 0o600 });
  await utimes(file, HOUR_AGO, HOUR_AGO);
}

async function repository(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-small-locks-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q'], { cwd: root });
  return root;
}

const metric = { surface: 'chat', intent: 'concept', outcome: 'resolved', topicId: 'project-binding',
  matchedBy: 'authored-question', latencyMs: 1, answerBytes: 512, actionCategory: null };
const catalog = (root) => ({ env: { SINGULARITY_FLOW_REPOSITORY_CATALOG: path.join(root, 'catalog') } });
// `act` takes the lock; `took` checks what it returns once it has the lock.
const SITES = [
  { name: 'help metrics', code: 'HELP_METRICS_LOCK_BUSY', legacy: `4242:${randomUUID()}`,
    lock: (root) => path.join(root, '.git', 'singularity-flow', 'help-metrics', 'write.lock'),
    act: (root) => recordHelpMetric(root, metric), took: async (done) => assert.equal((await done).recorded, true) },
  { name: 'prompt audit', code: 'PROMPT_AUDIT_LOCK_BUSY', legacy: `4242:${randomUUID()}`,
    lock: (root) => path.join(root, '.git', 'singularity-flow', 'prompt-audit', 'write.lock'),
    act: (root) => setPromptAudit(root, true), took: (done) => done },
  { name: 'repositories store', code: 'REPOSITORY_CATALOG_STORAGE_UNAVAILABLE', legacy: '4242\n',
    lock: (root) => path.join(root, 'catalog', '.lock'),
    act: (root) => readProviderCache('k', catalog(root)), took: async (done) => assert.equal(await done, null) },
  // The receipt does not exist: holding its lock is what reaches "not found".
  { name: 'selection receipt', code: undefined, legacy: null,
    lock: (root) => path.join(root, '.git', 'singularity-flow', 'choices', `${TOKEN}.json.lock`),
    act: (root) => consumeSelectionReceipt(root, TOKEN),
    took: (done) => assert.rejects(done, /not found or was already consumed/u) }
];

test('a lease released here without removing its file is taken over here; one still held never is', async (t) => {
  const root = await repository(t);
  const file = path.join(root, 'held.lock');
  const lease = await acquireFileLease(file);
  assert.equal(await acquireFileLease(file), null, 'held by this process: never taken over');
  const alias = `${root}-alias`;
  await symlink(root, alias);
  t.after(() => rm(alias, { force: true }));
  assert.equal(await acquireFileLease(path.join(alias, 'held.lock')), null, 'nor through another spelling of its path');
  await lease.release({ remove: false });
  assert.equal(await exists(file), true, 'the caller removes it itself');
  const next = await acquireFileLease(file);
  assert.equal(next?.reclaimed, true, 'nothing here holds it any more');
  await next.release();
  assert.equal(await exists(file), false);
});

test('an older build\'s owner text is judged by its age; other text without an owner never is', async (t) => {
  const root = await repository(t);
  const file = path.join(root, 'legacy.lock');
  const legacyOwner = /^\d+:[a-f0-9-]{36}$/u;
  await placeLock(file, `4242:${randomUUID()}`);
  assert.equal(await acquireFileLease(file, { staleMs: 60_000 }), null, 'not this lock\'s dialect: unverifiable');
  const lease = await acquireFileLease(file, { staleMs: 60_000, legacyOwner });
  assert.equal(lease?.reclaimed, true);
  await lease.release();
  await placeLock(file, `4242:${randomUUID()}`);
  await utimes(file, new Date(), new Date());
  assert.equal(await acquireFileLease(file, { staleMs: 60_000, legacyOwner }), null, 'a young one is still busy');
  await assert.rejects(acquireFileLease(file, { legacyOwner: 'x' }), { code: 'FILE_LEASE_INVALID' });
});

test('a bounded wait never ends another machine\'s lease, and its refusal route names the reviewed release', async (t) => {
  const root = await repository(t);
  const file = path.join(root, 'foreign.lock');
  const foreign = foreignOwner();
  await placeLock(file, foreign);
  const started = Date.now();
  assert.equal(await acquireFileLeaseWithin(file, 300, { staleMs: 1_000 }), null);
  assert.ok(Date.now() - started >= 250, 'it waited to its deadline');
  const route = await heldFileLeaseRoute(file);
  assert.equal(route.details.releaseCommand, `singularity-flow lock release-file ${JSON.stringify(file)} --confirm ${foreign.nonce}`);
  assert.match(route.message, /other-laptop\.example .*waiting does not end it\. Review it with: singularity-flow lock show-file /u);
  assert.equal(route.details.liveness.state, 'unknown');
});

test('every small local lock: another machine\'s is never taken over by age, and its refusal names the release', async (t) => {
  const root = await repository(t);
  await Promise.all(SITES.map(async (site) => {
    const lock = site.lock(root);
    const foreign = foreignOwner();
    await placeLock(lock, foreign);
    const refused = await site.act(root).then(() => null, (error) => error);
    assert.ok(refused, `${site.name}: refused`);
    assert.equal(refused.code, site.code, `${site.name}: ${refused.message}`);
    assert.match(refused.message, /busy.*It is held by PID 4242 on other-laptop\.example .*waiting does not end it/su, site.name);
    assert.equal(refused.details?.releaseCommand,
      `singularity-flow lock release-file ${JSON.stringify(lock)} --confirm ${foreign.nonce}`, site.name);
    assert.equal(await exists(lock), true, `${site.name}: the lock is still there`);
  }));
});

test('every small local lock: a dead owner\'s, and an older build\'s past its age, is taken over', async (t) => {
  const root = await repository(t);
  for (const site of SITES) {
    const lock = site.lock(root);
    await placeLock(lock, await deadOwner());
    await site.took(site.act(root));
    assert.equal(await exists(lock), false, `${site.name}: taken over, then released`);
    if (site.legacy) await placeLock(lock, site.legacy);
    else {
      // An older build's receipt lock is a directory.
      await mkdir(lock, { recursive: true, mode: 0o700 });
      await utimes(lock, HOUR_AGO, HOUR_AGO);
    }
    await site.took(site.act(root));
    assert.equal(await exists(lock), false, `${site.name}: the older build's lock is gone`);
  }
});

// A publication journal from before lock tokens names no lease generation. Judged by its own owner
// alone, another machine's owner kept it live forever, and there was no lock to release.
test('a journal without a lock token is judged by the subject lease held now', async (t) => {
  const root = await repository(t);
  const subject = { kind: 'story', id: 'JRN-1' };
  const pending = { journal: true, record: { recoveryStage: 'interrupted-before-branch-ref-advanced' },
    journalRecord: { subject, stage: 'prepared', refAdvanced: false, createdAt: HOUR_AGO.toISOString(),
      owner: { pid: 4242, host: 'other-laptop.example', machineId: '0a1b2c3d-0000-4000-8000-000000000000' } } };
  assert.equal(livePreparedPublicationOwner(pending, root), null, 'no lease is held: nothing still writes it');

  const lock = subjectLockPath(root, subject);
  await mkdir(lock, { recursive: true });
  const token = randomUUID();
  await writeFile(path.join(lock, 'owner.json'), `${JSON.stringify({ schemaVersion: 1, subject, pid: 4242,
    host: 'other-laptop.example', machineId: '0a1b2c3d-0000-4000-8000-000000000000', processToken: 'p',
    lockToken: token, acquiredAt: HOUR_AGO.toISOString(), expiresAt: HOUR_AGO.toISOString() })}\n`);
  const active = livePreparedPublicationOwner(pending, root);
  assert.equal(active?.pid, 4242, 'another machine holds the subject lease');
  const refusal = await activePublicationRefusal(root, pending, active, {
    what: "Story 'JRN-1'", retry: 'singularity-flow sync JRN-1', code: 'STORY_PUBLICATION_IN_PROGRESS' });
  assert.equal(refusal.details.releaseCommand, `singularity-flow lock release story JRN-1 --confirm ${token}`);
  assert.match(refusal.message, /Waiting does not end it/u);
});
