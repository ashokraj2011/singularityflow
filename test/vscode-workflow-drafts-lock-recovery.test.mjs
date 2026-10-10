import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createWorkflowDraftRecoveryStore, workflowDraftRecoveryNativeDomainRefusal } from '../apps/vscode/src/views/workflow-drafts-recovery.ts';
import { collectExecutionSites, summarizeSites } from '../scripts/git-bypass-audit.mjs';
import { modelBoundaryFailures } from '../scripts/model-boundary-policy.mjs';
import { nodeTypeScriptFlags } from '../scripts/typescript-runtime.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleUrl = new URL('../apps/vscode/src/views/workflow-drafts-recovery.ts', import.meta.url).href;
const nativeRepair = ['darwin', 'linux'].includes(process.platform);
const scope = { repository: path.resolve('/fixture-only/repository'), authority: 'https://approved.example.test/config.git', draftId: 'WFD-ABC123' };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const scopeHash = (value) => hash(JSON.stringify([value.repository, value.authority, value.draftId]));
const scopeLock = (f) => path.join(f.directory, `.${scopeHash(scope)}.lock`);
const seal = (f) => path.join(f.directory, `${scopeHash(scope)}.wdr.enc`);
function checkpoint() {
  return { schemaVersion: 1, checkpointId: randomUUID(), capturedAt: '2026-09-27T10:11:12.123Z', scope,
    base: { record: { draftId: scope.draftId, displayName: 'Saved draft', revision: 1, lifecycleEpoch: 1,
      revisionSha256: `sha256:${'b'.repeat(64)}` }, head: 'a'.repeat(40), savedName: 'Saved draft', savedText: '{"payload":{}}' },
    buffer: { name: 'Unsent draft', text: '{ invalid PRIVATE BUFFER \r\n 🚀' } };
}
async function fixture(t, seed = true) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-private-lock-recovery-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'workflow-draft-recovery'); const keyFile = path.join(base, 'fixture-secret-provider.json');
  let gets = 0; let stores = 0;
  const secrets = {
    async get(key) { gets += 1; const values = await readFile(keyFile, 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return {}; throw error; }); return values[key]; },
    async store(key, value) { stores += 1; const values = await readFile(keyFile, 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return {}; throw error; }); await writeFile(keyFile, JSON.stringify({ ...values, [key]: value })); }
  };
  const store = createWorkflowDraftRecoveryStore(directory, secrets); const first = checkpoint();
  if (seed) await store.write(first);
  return { base, directory, keyFile, secrets, store, first, counts: () => ({ gets, stores }) };
}
async function holder(t, f, mode = 'scope') {
  const cp = checkpoint(); const expected = mode === 'scope' ? f.first.checkpointId : null;
  const source = `
    import {readFile,writeFile} from 'node:fs/promises';
    import {createWorkflowDraftRecoveryStore} from ${JSON.stringify(moduleUrl)};
    const [directory,keyFile,mode,raw,expected] = process.argv.slice(1);
    const keepAlive = setInterval(()=>{},1000);
    const values = async()=>readFile(keyFile,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return {};throw e});
    const hold = async()=>{process.stdout.write('READY\\n');await new Promise(()=>{});};
    const secrets = {async get(key){if(mode==='scope')await hold();return (await values())[key];},
      async store(key,value){await writeFile(keyFile,JSON.stringify({...await values(),[key]:value}));if(mode==='key-init')await hold();}};
    await createWorkflowDraftRecoveryStore(directory,secrets).write(JSON.parse(raw),expected==='null'?null:expected);
    clearInterval(keepAlive);
  `;
  const child = spawn(process.execPath, [...nodeTypeScriptFlags(packageRoot), '--input-type=module', '-e', source, f.directory, f.keyFile, mode, JSON.stringify(cp), expected ?? 'null'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (bytes) => { stderr = (stderr + bytes).slice(-8192); });
  const closed = new Promise((resolve) => child.once('close', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Native lock fixture did not become ready.')), 5000);
    let stdout = '';
    child.stdout.on('data', (bytes) => { stdout = (stdout + bytes).slice(-8192); if (stdout.includes('READY\n')) { clearTimeout(timeout); resolve(); } });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', () => { clearTimeout(timeout); reject(new Error(`Native lock fixture exited before ready: ${stderr}`)); });
  });
  return { child, async stop() { child.kill('SIGKILL'); await closed; } };
}
async function item(f, kind = 'scope') { return (await f.store.inspectLocks(scope)).locks.find((entry) => entry.kind === kind); }
async function tree(directory) { return Promise.all((await readdir(directory)).sort().map(async (name) => [name, hash(await readFile(path.join(directory, name)))])); }

test('Windows native-domain diagnostic refuses repair qualification without using PID or elapsed-time guesses', async () => {
  assert.equal(workflowDraftRecoveryNativeDomainRefusal('win32'), 'WINDOWS_NATIVE_BOOT_PROCESS_DOMAIN_UNQUALIFIED');
  // These are available native probe sites, not evidence of another process being dead. Existing
  // real-owner fixtures below still independently observe their exact native boot/domain.
  assert.equal(workflowDraftRecoveryNativeDomainRefusal('darwin'), null);
  assert.equal(workflowDraftRecoveryNativeDomainRefusal('linux'), null);
  for (const platform of ['aix', 'freebsd', 'openbsd', 'sunos', 'android', undefined, 'WIN32']) {
    assert.equal(workflowDraftRecoveryNativeDomainRefusal(platform), 'NATIVE_PROCESS_DOMAIN_UNAVAILABLE');
  }
  const source = await readFile(new URL('../apps/vscode/src/views/workflow-drafts-recovery.ts', import.meta.url), 'utf8');
  assert.match(source, /const nativeRefusal = workflowDraftRecoveryNativeDomainRefusal\(OWNER_PLATFORM\)/u,
    'the real owner uses its captured native platform, never a caller-supplied platform override');
  assert.doesNotMatch(source, /execFile\([^;]*(?:powershell|wmic|LastBootUpTime|Get-CimInstance)/su,
    'no unqualified Windows timestamp or dynamic native ABI probe is launched');
});

test('exact-scope inspection of absent storage creates neither directories nor keys and returns no repair authority', async (t) => {
  const f = await fixture(t, false); const before = f.counts();
  const report = await f.store.inspectLocks(scope);
  assert.deepEqual(report.locks.map((lock) => lock.status), ['absent', 'absent']);
  assert.ok(report.locks.every((lock) => !lock.repairSupported && lock.reviewId === null));
  await assert.rejects(() => readdir(f.directory), { code: 'ENOENT' }); assert.deepEqual(f.counts(), before);
});

test('new live locks contain closed nonce ownership and read-only inspection does not expose buffers or raw host identity', async (t) => {
  const f = await fixture(t); const owner = await holder(t, f); const before = await tree(f.directory); const key = await readFile(f.keyFile); const counts = f.counts();
  const lock = await item(f); const record = JSON.parse(await readFile(scopeLock(f), 'utf8'));
  assert.equal(record.schemaVersion, 1); assert.equal(record.kind, 'workflow-draft-recovery-lock'); assert.equal(record.purpose, 'mutation');
  assert.equal(record.owner.pid, owner.child.pid); assert.ok(record.owner.processNonce); assert.ok(record.lockNonce);
  assert.equal(lock.status, nativeRepair ? 'live' : 'unknown'); assert.equal(lock.repairSupported, false); assert.equal(lock.reviewId, null);
  if (process.platform === 'win32') assert.equal(lock.reason, 'WINDOWS_NATIVE_BOOT_PROCESS_DOMAIN_UNQUALIFIED');
  assert.doesNotMatch(JSON.stringify(lock), /PRIVATE BUFFER|hostname|bootsessionuuid|pid:\[/);
  assert.deepEqual(await tree(f.directory), before); assert.deepEqual(await readFile(f.keyFile), key); assert.deepEqual(f.counts(), counts);
});

test('a native dead same-domain owner can be explicitly repaired without changing ciphertext or encryption keys', async (t) => {
  const f = await fixture(t); const owner = await holder(t, f); await owner.stop();
  const original = await readFile(seal(f)); const key = await readFile(f.keyFile); const counts = f.counts(); const lock = await item(f);
  assert.equal(lock.status, nativeRepair ? 'dead' : 'unknown'); assert.equal(lock.repairSupported, nativeRepair);
  if (process.platform === 'win32') assert.equal(lock.reason, 'WINDOWS_NATIVE_BOOT_PROCESS_DOMAIN_UNQUALIFIED');
  if (!nativeRepair) { assert.equal(lock.reviewId, null); assert.deepEqual(await readFile(seal(f)), original); return; }
  let confirmations = 0;
  const result = await f.store.repairLock(scope, lock.reviewId, async (exact) => { confirmations += 1; assert.deepEqual(exact, lock); assert.ok(Object.isFrozen(exact)); return true; });
  assert.deepEqual(result, { status: 'repaired', kind: 'scope', checkpointChanged: false, keyChanged: false }); assert.equal(confirmations, 1);
  await assert.rejects(() => readFile(scopeLock(f)), { code: 'ENOENT' }); assert.deepEqual(await readFile(seal(f)), original);
  assert.deepEqual(await readFile(f.keyFile), key); assert.deepEqual(f.counts(), counts);
  assert.deepEqual(await f.store.read(scope), f.first);
});

test('repair defaults to cancellation and private review tickets are one-use and bound to the exact editor scope', async (t) => {
  const f = await fixture(t); const owner = await holder(t, f); await owner.stop(); const lock = await item(f); const before = await tree(f.directory);
  if (!nativeRepair) return assert.equal(lock.reviewId, null);
  assert.equal((await f.store.repairLock(scope, lock.reviewId, async () => false)).status, 'cancelled');
  assert.deepEqual(await tree(f.directory), before);
  await assert.rejects(() => f.store.repairLock(scope, lock.reviewId, async () => true), { code: 'WORKFLOW_DRAFT_RECOVERY_LOCK_REVIEW_REQUIRED' });
  const again = await item(f); let calls = 0;
  await assert.rejects(() => f.store.repairLock({ ...scope, authority: 'https://other.example.test/config.git' }, again.reviewId, async () => { calls += 1; return true; }), { code: 'WORKFLOW_DRAFT_RECOVERY_LOCK_REVIEW_REQUIRED' });
  assert.equal(calls, 0); assert.deepEqual(await tree(f.directory), before);
  await assert.rejects(() => f.store.repairLock(scope, randomUUID(), async () => true), { code: 'WORKFLOW_DRAFT_RECOVERY_LOCK_REVIEW_REQUIRED' });
});

test('live owners cannot be declared dead by public flags, old timestamps, reused PIDs or caller monkeypatches', async (t) => {
  const f = await fixture(t); const owner = await holder(t, f); const record = JSON.parse(await readFile(scopeLock(f), 'utf8'));
  record.createdAt = '1999-01-01T00:00:00.000Z'; record.owner.processNonce = randomUUID(); record.owner.pid = process.pid;
  await writeFile(scopeLock(f), JSON.stringify(record)); const before = await tree(f.directory);
  const originalKill = process.kill;
  try {
    process.kill = () => { throw Object.assign(new Error('Caller invented process death'), { code: 'ESRCH' }); };
    const lock = await item(f); assert.equal(lock.status, nativeRepair ? 'live' : 'unknown'); assert.equal(lock.reviewId, null);
    await assert.rejects(() => f.store.repairLock(scope, randomUUID(), async () => true), { code: 'WORKFLOW_DRAFT_RECOVERY_LOCK_REVIEW_REQUIRED' });
  } finally { process.kill = originalKill; }
  assert.deepEqual(await tree(f.directory), before); assert.ok(owner.child.pid);
});

test('legacy empty, malformed, widened and other-domain owner records are retained without a repair ticket', async (t) => {
  const f = await fixture(t); const owner = await holder(t, f); await owner.stop(); const original = JSON.parse(await readFile(scopeLock(f), 'utf8'));
  const other = structuredClone(original); if (other.owner.domain) other.owner.domain.sha256 = '0'.repeat(64);
  const candidates = ['', '{', JSON.stringify({ ...original, confirmedDead: true }), JSON.stringify({ ...original, schemaVersion: 2 }),
    JSON.stringify(other), 'x'.repeat(4097)];
  for (const bytes of candidates) {
    await writeFile(scopeLock(f), bytes); const before = await tree(f.directory); const lock = await item(f);
    assert.equal(lock.status, bytes === '' ? 'legacy' : 'unknown'); assert.equal(lock.reviewId, null); assert.equal(lock.repairSupported, false);
    assert.deepEqual(await tree(f.directory), before); assert.equal(await readFile(scopeLock(f), 'utf8'), bytes);
  }
  assert.deepEqual(await f.store.read(scope), f.first);
});

test('a replacement live lock after the displayed review is fenced by exact inode and nonce without deleting the new owner', async (t) => {
  const f = await fixture(t); const old = await holder(t, f); await old.stop(); const lock = await item(f);
  if (!nativeRepair) return assert.equal(lock.reviewId, null);
  const ciphertext = await readFile(seal(f)); const key = await readFile(f.keyFile); let replacement;
  await assert.rejects(() => f.store.repairLock(scope, lock.reviewId, async () => {
    await rename(scopeLock(f), path.join(f.base, 'retained-old-lock')); replacement = await holder(t, f); return true;
  }), { code: 'WORKFLOW_DRAFT_RECOVERY_LOCK_CHANGED' });
  assert.equal((await item(f)).owner.pid, replacement.child.pid); assert.equal((await item(f)).status, 'live');
  assert.deepEqual(await readFile(seal(f)), ciphertext); assert.deepEqual(await readFile(f.keyFile), key);
  assert.equal((await readdir(f.directory)).some((name) => name.endsWith('.repair')), false);
});

test('same-inode metadata changes invalidate a displayed repair even when the numeric process owner remains absent', async (t) => {
  const f = await fixture(t); const old = await holder(t, f); await old.stop(); const lock = await item(f);
  if (!nativeRepair) return assert.equal(lock.reviewId, null);
  const record = JSON.parse(await readFile(scopeLock(f), 'utf8')); record.lockNonce = randomUUID();
  await assert.rejects(() => f.store.repairLock(scope, lock.reviewId, async () => { await writeFile(scopeLock(f), JSON.stringify(record)); return true; }), { code: 'WORKFLOW_DRAFT_RECOVERY_LOCK_CHANGED' });
  assert.equal(await readFile(scopeLock(f), 'utf8'), JSON.stringify(record)); assert.equal((await readdir(f.directory)).some((name) => name.endsWith('.repair')), false);
});

test('concurrent independent store reviews can repair only once and cannot delete a replacement lock', async (t) => {
  const f = await fixture(t); const old = await holder(t, f); await old.stop(); const other = createWorkflowDraftRecoveryStore(f.directory, f.secrets);
  const one = await item(f); const two = (await other.inspectLocks(scope)).locks.find((lock) => lock.kind === 'scope');
  if (!nativeRepair) return assert.equal(one.reviewId, null);
  const results = await Promise.allSettled([f.store.repairLock(scope, one.reviewId, async () => true), other.repairLock(scope, two.reviewId, async () => true)]);
  assert.equal(results.filter((value) => value.status === 'fulfilled').length, 1);
  assert.equal(results.find((value) => value.status === 'rejected').reason.code, 'WORKFLOW_DRAFT_RECOVERY_LOCK_CHANGED');
  assert.deepEqual(await f.store.read(scope), f.first); assert.equal((await readdir(f.directory)).some((name) => name.endsWith('.repair') || name.endsWith('.lock')), false);
});

test('independent native repair processes are fenced by the persisted barrier, not an in-process queue', async (t) => {
  const f = await fixture(t); const owner = await holder(t, f); await owner.stop(); const ciphertext = await readFile(seal(f)); const key = await readFile(f.keyFile);
  if (!nativeRepair) return assert.equal((await item(f)).reviewId, null);
  const script = `
    import {createWorkflowDraftRecoveryStore} from ${JSON.stringify(moduleUrl)};
    const [directory,raw]=process.argv.slice(1);const scope=JSON.parse(raw);
    const store=createWorkflowDraftRecoveryStore(directory,{async get(){throw Error('must not read key')},async store(){throw Error('must not write key')}});
    const inspection=(await store.inspectLocks(scope)).locks.find(v=>v.kind==='scope');
    if(!inspection.reviewId)throw Error('Expected native dead owner');
    const keepAlive=setInterval(()=>{},1000);process.stdout.write('READY\\n');
    process.stdin.once('data',async()=>{let result;try{result={ok:true,value:await store.repairLock(scope,inspection.reviewId,async()=>true)}}
      catch(error){result={ok:false,code:error.code}}process.stdout.write('RESULT:'+JSON.stringify(result)+'\\n');clearInterval(keepAlive);process.stdin.destroy();});
  `;
  async function client() {
    const child = spawn(process.execPath, [...nodeTypeScriptFlags(packageRoot), '--input-type=module', '-e', script, f.directory, JSON.stringify(scope)], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let readyResolve; let resultResolve; let resultReject;
    const ready = new Promise((resolve) => { readyResolve = resolve; });
    const result = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
    const closed = new Promise((resolve) => child.once('close', resolve));
    const timeout = setTimeout(() => resultReject(new Error('Native concurrent repair fixture timed out.')), 5000);
    child.stderr.on('data', (bytes) => { stderr = (stderr + bytes).slice(-8192); });
    child.stdout.on('data', (bytes) => {
      stdout = (stdout + bytes).slice(-8192);
      if (stdout.includes('READY\n')) readyResolve();
      const match = /RESULT:([^\n]+)\n/u.exec(stdout); if (match) { clearTimeout(timeout); resultResolve(JSON.parse(match[1])); }
    });
    child.once('close', () => { clearTimeout(timeout); if (!stdout.includes('RESULT:')) resultReject(new Error(`Concurrent native repair fixture failed: ${stderr}`)); });
    t.after(async () => { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
    await Promise.race([ready, result]); return { start() { child.stdin.write('GO\n'); }, result };
  }
  const [one, two] = await Promise.all([client(), client()]); one.start(); two.start();
  const results = await Promise.all([one.result, two.result]); assert.equal(results.filter((entry) => entry.ok).length, 1);
  assert.ok(['WORKFLOW_DRAFT_RECOVERY_BUSY', 'WORKFLOW_DRAFT_RECOVERY_LOCK_CHANGED'].includes(results.find((entry) => !entry.ok).code));
  assert.deepEqual(await readFile(seal(f)), ciphertext); assert.deepEqual(await readFile(f.keyFile), key);
  assert.equal((await readdir(f.directory)).some((name) => name.endsWith('.lock') || name.endsWith('.repair')), false);
});

test('key-initialization lock repair preserves the persisted key and does not clear the separate scope lock', async (t) => {
  const f = await fixture(t, false); const owner = await holder(t, f, 'key-init'); await owner.stop();
  const key = await readFile(f.keyFile); const counts = f.counts(); const lock = await item(f, 'key-init'); const scoped = await readFile(scopeLock(f));
  assert.equal(lock.status, nativeRepair ? 'dead' : 'unknown');
  if (!nativeRepair) return assert.equal(lock.reviewId, null);
  await f.store.repairLock(scope, lock.reviewId, async () => true);
  await assert.rejects(() => readFile(path.join(f.directory, '.key-init.lock')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(f.keyFile), key); assert.deepEqual(await readFile(scopeLock(f)), scoped); assert.deepEqual(f.counts(), counts);
  await assert.rejects(() => readFile(seal(f)), { code: 'ENOENT' });
  const scopeReview = await item(f); await f.store.repairLock(scope, scopeReview.reviewId, async () => true);
  await f.store.write(f.first); assert.deepEqual(await f.store.read(scope), f.first); assert.deepEqual(await readFile(f.keyFile), key);
});

test('active or interrupted maintenance barriers block repair and writers but not encrypted checkpoint reads', async (t) => {
  const f = await fixture(t); const owner = await holder(t, f); await owner.stop(); const barrier = `${scopeLock(f)}.repair`;
  await writeFile(barrier, ''); const before = await tree(f.directory); const lock = await item(f);
  assert.equal(lock.status, 'unknown'); assert.equal(lock.reason, 'INTERRUPTED_OR_ACTIVE_REPAIR_BARRIER'); assert.equal(lock.reviewId, null);
  assert.deepEqual(await f.store.read(scope), f.first);
  await assert.rejects(() => f.store.write(checkpoint(), f.first.checkpointId), { code: 'WORKFLOW_DRAFT_RECOVERY_BUSY' });
  assert.deepEqual(await tree(f.directory), before);
});

test('symlinked locks, maintenance paths and replaced directories refuse without following outside files', async (t) => {
  const f = await fixture(t); const outside = path.join(f.base, 'outside-lock'); await writeFile(outside, 'DO NOT CHANGE');
  await symlink(outside, scopeLock(f)); await assert.rejects(() => f.store.inspectLocks(scope), { code: 'WORKFLOW_DRAFT_RECOVERY_UNSAFE_PATH' });
  await rm(scopeLock(f)); await symlink(outside, `${scopeLock(f)}.repair`);
  await assert.rejects(() => f.store.inspectLocks(scope), { code: 'WORKFLOW_DRAFT_RECOVERY_UNSAFE_PATH' });
  assert.equal(await readFile(outside, 'utf8'), 'DO NOT CHANGE');
  await rm(`${scopeLock(f)}.repair`);
  const owner = await holder(t, f); await owner.stop(); const lock = await item(f);
  if (!nativeRepair) return assert.equal(lock.reviewId, null);
  await assert.rejects(() => f.store.repairLock(scope, lock.reviewId, async () => {
    await rename(f.directory, path.join(f.base, 'retained-original-directory')); await mkdir(f.directory); return true;
  }), { code: 'WORKFLOW_DRAFT_RECOVERY_UNSAFE_PATH' });
  assert.deepEqual(await readdir(f.directory), []);
});

test('the native process-domain probe is a single exactly-reviewed bounded read-only OS site, never a Git or model bypass', async () => {
  const file = 'apps/vscode/src/views/workflow-drafts-recovery.ts';
  const source = await readFile(new URL('../apps/vscode/src/views/workflow-drafts-recovery.ts', import.meta.url), 'utf8');
  const observed = collectExecutionSites(source, file); const summary = summarizeSites({ [file]: observed });
  assert.deepEqual(summary[file].counts, { 'process-import': 1, 'process-launch': 1 });
  const baseline = JSON.parse(await readFile(new URL('../scripts/git-bypass-baseline.json', import.meta.url), 'utf8'));
  assert.deepEqual(summary[file], baseline.sites[file]);
  assert.deepEqual(modelBoundaryFailures(file, source), []);
  assert.equal(observed.filter((site) => site.id.startsWith('process-launch:')).length, 1);
  assert.match(source.replace(/\s+/gu, ' '), /execFile\('\/usr\/sbin\/sysctl', \['-n', 'kern\.bootsessionuuid'\], \{ shell: false, encoding: 'utf8', timeout: 1000, maxBuffer: 1024, windowsHide: true \}/u);
  assert.doesNotMatch(source, /(?:spawn|execFile|execSync|run)\s*\([^\n]{0,100}['"`]copilot(?:\.cmd)?['"`]/u);
});
