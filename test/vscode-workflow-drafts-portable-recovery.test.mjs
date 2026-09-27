/** Real local encrypted-owner fixtures. This file does not attest another OS or inject native death. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorkflowDraftRecoveryStore } from '../apps/vscode/src/views/workflow-drafts-recovery.ts';
import { removeTemporaryTree } from '../src/util.mjs';

const moduleUrl = new URL('../apps/vscode/src/views/workflow-drafts-recovery.ts', import.meta.url).href;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const scopeHash = (scope) => hash(JSON.stringify([scope.repository, scope.authority, scope.draftId]));
const fileFor = (f, scope) => path.join(f.directory, `${scopeHash(scope)}.wdr.enc`);
const fileSecrets = (keyFile) => ({ async get() { return readFile(keyFile, 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return undefined; throw error;
}); }, async store(_name, value) { await writeFile(keyFile, value); } });
function checkpoint(scope, text = 'Unsent private fixture\r\n雪 🚀') {
  return { schemaVersion: 1, checkpointId: randomUUID(), capturedAt: '2026-09-27T10:11:12.123Z', scope,
    base: { record: { draftId: scope.draftId, displayName: 'Saved café', revision: 2, lifecycleEpoch: 1,
      revisionSha256: `sha256:${'b'.repeat(64)}` }, head: 'a'.repeat(40), savedName: 'Saved café', savedText: '{ retained CRLF\r\n' },
    buffer: { name: 'Private 雪', text }, pendingSave: { operationId: randomUUID(), uncertain: true,
      snapshot: { draftId: scope.draftId, authority: scope.authority, head: 'a'.repeat(40), epoch: 1,
        name: 'Possibly sent', text: 'Exact historical unknown-operation snapshot\r\n' } } };
}
async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-portable-recovery-')));
  t.after(() => removeTemporaryTree(base));
  // Components stay below native per-component limits; the complete path exceeds old MAX_PATH.
  const directory = path.join(base, ...Array.from({ length: 4 }, (_, index) => `space ${index} 雪 ${'x'.repeat(54)}`), 'workflow-draft-recovery');
  const keyFile = path.join(base, 'fixture-secret-storage'); const secrets = fileSecrets(keyFile);
  const scope = { repository: path.join(base, 'repository Café 雪'), authority: 'https://approved.example.test/config.git', draftId: 'WFD-ABC123' };
  return { base, directory, keyFile, secrets, scope, store: createWorkflowDraftRecoveryStore(directory, secrets) };
}
const workerSource = `
  import {readFile,writeFile} from 'node:fs/promises';
  import {createWorkflowDraftRecoveryStore} from ${JSON.stringify(moduleUrl)};
  let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>262144)throw Error('fixture input bound');}
  const request=JSON.parse(input);
  const secrets={async get(){try{return await readFile(request.keyFile,'utf8')}catch(error){if(error.code==='ENOENT')return undefined;throw error}},
    async store(_name,value){await writeFile(request.keyFile,value)}};
  const store=createWorkflowDraftRecoveryStore(request.directory,secrets);
  try{const value=request.operation==='read'?await store.read(request.scope):request.operation==='remove'
    ?await store.remove(request.scope,request.expected):await store.write(request.checkpoint,request.expected);
    process.stdout.write(JSON.stringify({status:'ok',value:value??null}));}
  catch(error){process.stdout.write(JSON.stringify({status:'refused',code:error.code}));}
`;
async function worker(t, request) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', workerSource], { shell: false, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let errors = ''; let closed = false;
  const closure = new Promise((resolve) => child.once('close', () => { closed = true; resolve(); }));
  t.after(async () => {
    if (!closed) child.kill('SIGKILL');
    let deadline; await Promise.race([closure, new Promise((resolve) => { deadline = setTimeout(resolve, 2000); })]);
    clearTimeout(deadline);
    if (!closed) { for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy(); child.unref(); }
    assert.equal(closed, true, 'Private recovery fixture child exit was not observed before cleanup deadline');
  });
  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Private recovery fixture deadline')); }, 10000);
    child.stdout.on('data', (chunk) => { output += chunk; if (Buffer.byteLength(output) > 262144) { child.kill('SIGKILL'); reject(Error('Fixture output bound')); } });
    child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-8192); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (status) => { clearTimeout(timeout); try { assert.equal(status, 0, errors); assert.equal(errors, ''); resolve(JSON.parse(output)); }
      catch (error) { reject(error); } });
  });
  child.stdin.end(JSON.stringify(request)); return result;
}

test('actual local owner retains literal CRLF and Unicode through long-path encrypted publication and process restart', async (t) => {
  const f = await fixture(t); const cp = checkpoint(f.scope); await f.store.write(cp);
  assert.ok(f.directory.length > 260); const bytes = await readFile(fileFor(f, f.scope));
  for (const privateText of [cp.buffer.text, cp.pendingSave.snapshot.text, cp.scope.repository, cp.scope.authority]) {
    assert.equal(bytes.includes(Buffer.from(privateText)), false);
  }
  const result = await worker(t, { directory: f.directory, keyFile: f.keyFile, operation: 'read', scope: f.scope });
  assert.equal(result.status, 'ok'); assert.deepEqual(result.value, cp);
  assert.deepEqual(await readdir(f.directory), [`${scopeHash(f.scope)}.wdr.enc`]);
});

test('repository case/Unicode and authority aliases remain exact distinct private scopes, never inferred adoption', async (t) => {
  const f = await fixture(t); const scopes = [f.scope, { ...f.scope, repository: f.scope.repository.toUpperCase() },
    { ...f.scope, repository: f.scope.repository.normalize('NFD') }, { ...f.scope, authority: `${f.scope.authority}/` }];
  assert.equal(new Set(scopes.map(scopeHash)).size, 4);
  const checkpoints = scopes.map((scope, index) => checkpoint(scope, `Exact alias buffer ${index}`));
  for (const cp of checkpoints) await f.store.write(cp);
  for (const cp of checkpoints) assert.deepEqual(await f.store.read(cp.scope), cp);
  assert.equal((await readdir(f.directory)).length, 4);
  const original = await readFile(fileFor(f, scopes[0])); const foreign = await readFile(fileFor(f, scopes[1]));
  await writeFile(fileFor(f, scopes[1]), original);
  await assert.rejects(f.store.read(scopes[1]), { code: 'WORKFLOW_DRAFT_RECOVERY_CORRUPT' });
  assert.deepEqual(await readFile(fileFor(f, scopes[1])), original, 'a scope mismatch is not repaired or discarded');
  await writeFile(fileFor(f, scopes[1]), foreign); assert.deepEqual(await f.store.read(scopes[1]), checkpoints[1]);
});

test('actual independent replace/delete clients cannot discard a newer unknown operation or resurrect a deleted parent', async (t) => {
  const f = await fixture(t); const first = checkpoint(f.scope); const next = checkpoint(f.scope, 'Newer unsent operation');
  await f.store.write(first); const request = { directory: f.directory, keyFile: f.keyFile, scope: f.scope, expected: first.checkpointId };
  const [replace, remove] = await Promise.all([worker(t, { ...request, operation: 'write', checkpoint: next }),
    worker(t, { ...request, operation: 'remove' })]);
  assert.equal(remove.status, 'ok');
  if (replace.status === 'ok') {
    assert.equal(remove.value, false); assert.deepEqual(await f.store.read(f.scope), next);
    assert.equal(await f.store.remove(f.scope, first.checkpointId), false);
  } else {
    assert.equal(replace.code, 'WORKFLOW_DRAFT_RECOVERY_CONFLICT'); assert.equal(remove.value, true);
    assert.equal(await f.store.read(f.scope), null);
  }
});

test('unqualified Windows-domain and mismatched Linux-namespace lock records stay unknown without native repair authority', async (t) => {
  const f = await fixture(t); const cp = checkpoint(f.scope); await f.store.write(cp);
  const original = await readFile(fileFor(f, f.scope)); const key = await readFile(f.keyFile);
  const name = `.${scopeHash(f.scope)}.lock`; const location = path.join(f.directory, name);
  // Persisted record fixtures only: no OS probe, native platform, PID or death result is replaced.
  for (const domain of [null, { profile: 'linux-boot-pid-namespace/v1', sha256: '0'.repeat(64) }]) {
    const bytes = JSON.stringify({ schemaVersion: 1, kind: 'workflow-draft-recovery-lock', purpose: 'mutation', target: 'scope',
      directorySha256: hash(f.directory), scopeSha256: scopeHash(f.scope),
      owner: { pid: process.pid, processNonce: randomUUID(), domain }, lockNonce: randomUUID(), createdAt: '1999-01-01T00:00:00.000Z' });
    await writeFile(location, bytes); const report = await f.store.inspectLocks(f.scope); const lock = report.locks.find((entry) => entry.kind === 'scope');
    assert.equal(lock.status, 'unknown'); assert.equal(lock.repairSupported, false); assert.equal(lock.reviewId, null);
    let confirmations = 0;
    await assert.rejects(f.store.repairLock(f.scope, randomUUID(), async () => { confirmations += 1; return true; }),
      { code: 'WORKFLOW_DRAFT_RECOVERY_LOCK_REVIEW_REQUIRED' });
    assert.equal(confirmations, 0); assert.equal(await readFile(location, 'utf8'), bytes);
    assert.deepEqual(await f.store.read(f.scope), cp); assert.deepEqual(await readFile(fileFor(f, f.scope)), original);
    assert.deepEqual(await readFile(f.keyFile), key);
  }
});

test('private storage refuses relative/root/traversal identities before creating directories or keys', async (t) => {
  const f = await fixture(t); let calls = 0; const secrets = { get() { calls += 1; }, store() { calls += 1; } };
  for (const directory of ['relative-store', path.parse(f.base).root, `${f.directory}${path.sep}..${path.sep}escape`, `${f.directory}\r\n`]) {
    assert.throws(() => createWorkflowDraftRecoveryStore(directory, secrets), { code: 'WORKFLOW_DRAFT_RECOVERY_INVALID' });
  }
  await assert.rejects(readdir(f.directory), { code: 'ENOENT' }); assert.equal(calls, 0);
});
