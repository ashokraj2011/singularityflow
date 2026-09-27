import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, link, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createWorkflowDraftRecoveryStore, WORKFLOW_DRAFT_RECOVERY_MAX_TEXT_BYTES,
  WORKFLOW_DRAFT_RECOVERY_MAX_ENVELOPE_BYTES
} from '../apps/vscode/src/views/workflow-drafts-recovery.ts';

const moduleUrl = new URL('../apps/vscode/src/views/workflow-drafts-recovery.ts', import.meta.url).href;
const scope = { repository: path.resolve('/fixture-only/repository'), authority: 'https://approved.example.test/config.git', draftId: 'WFD-ABC123' };
const head = 'a'.repeat(40);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const scopeHash = (value) => hash(JSON.stringify([value.repository, value.authority, value.draftId]));
const fileFor = (directory, value = scope) => path.join(directory, `${scopeHash(value)}.wdr.enc`);
function checkpoint(overrides = {}) {
  return { schemaVersion: 1, checkpointId: randomUUID(), capturedAt: '2026-09-27T10:11:12.123Z', scope: structuredClone(scope),
    base: { record: { draftId: scope.draftId, displayName: 'Saved draft', revision: 3, lifecycleEpoch: 2,
      revisionSha256: `sha256:${'b'.repeat(64)}` }, head, savedName: 'Saved draft', savedText: '{"payload":{}}\r\n' },
    buffer: { name: 'Unsent draft', text: '{ invalid JSON \r\n "private-fixture-buffer": "literal | $() 🚀"\0\t' },
    pendingSave: { operationId: randomUUID(), uncertain: true,
      snapshot: { draftId: scope.draftId, authority: scope.authority, head, epoch: 2, name: 'Possibly sent draft', text: '{"payload":{"id":"sent-snapshot"}}' } },
    ...overrides };
}
async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-private-draft-recovery-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'workflow-draft-recovery');
  const values = new Map(); let stores = 0;
  const secrets = { async get(key) { return values.get(key); }, async store(key, value) { stores += 1; values.set(key, value); } };
  const store = createWorkflowDraftRecoveryStore(directory, secrets);
  return { base, directory, values, secrets, store, stores: () => stores };
}
const code = (value) => ({ code: value });

test('private recovery persists literal invalid JSON and separate uncertain-save text only in an authenticated encrypted seal', async (t) => {
  const f = await fixture(t); const cp = checkpoint();
  assert.equal(await f.store.read(scope), null);
  await f.store.write(cp);
  assert.equal(f.stores(), 1);
  assert.deepEqual(await createWorkflowDraftRecoveryStore(f.directory, f.secrets).read(scope), cp);
  const names = await readdir(f.directory);
  assert.deepEqual(names, [`${scopeHash(scope)}.wdr.enc`]);
  const bytes = await readFile(fileFor(f.directory));
  assert.ok(bytes.length < WORKFLOW_DRAFT_RECOVERY_MAX_ENVELOPE_BYTES);
  for (const text of [cp.buffer.text, cp.pendingSave.snapshot.text, cp.buffer.name, scope.authority, scope.repository]) {
    assert.equal(bytes.includes(Buffer.from(text)), false);
  }
  const envelope = JSON.parse(bytes);
  assert.deepEqual(Object.keys(envelope).sort(), ['ciphertext', 'format', 'keyId', 'nonce', 'scopeSha256', 'tag']);
  assert.equal(Buffer.from(envelope.nonce, 'base64').length, 12);
  assert.equal(Buffer.from(envelope.tag, 'base64').length, 16);
  if (process.platform !== 'win32') assert.equal((await stat(fileFor(f.directory))).mode & 0o777, 0o600);
});

test('private checkpoint writes and deletes use exact CAS across store instances and idempotent retries', async (t) => {
  const f = await fixture(t); const second = createWorkflowDraftRecoveryStore(f.directory, f.secrets);
  const first = checkpoint(); const newer = checkpoint({ buffer: { name: 'Newer', text: 'newest literal buffer' } });
  await f.store.write(first);
  await assert.rejects(() => second.write(newer), code('WORKFLOW_DRAFT_RECOVERY_CONFLICT'));
  await second.write(newer, first.checkpointId);
  await second.write(Object.fromEntries(Object.entries(newer).reverse()), first.checkpointId);
  await assert.rejects(() => second.write({ ...newer, buffer: { ...newer.buffer, text: 'changed under same ID' } }, newer.checkpointId),
    code('WORKFLOW_DRAFT_RECOVERY_CHECKPOINT_CHANGED'));
  await assert.rejects(() => f.store.write(checkpoint(), first.checkpointId), code('WORKFLOW_DRAFT_RECOVERY_CONFLICT'));
  assert.equal(await f.store.remove(scope, first.checkpointId), false);
  assert.deepEqual(await f.store.read(scope), newer);
  assert.equal(await f.store.remove(scope, newer.checkpointId), true);
  assert.equal(await f.store.remove(scope, newer.checkpointId), false);
  assert.equal(await f.store.read(scope), null);
});

test('private capture snapshots all mutable inputs and CAS operands before awaiting storage', async (t) => {
  const f = await fixture(t); const original = checkpoint(); const mutable = structuredClone(original);
  const pending = f.store.write(mutable);
  mutable.scope.authority = 'https://other.example.test/config.git';
  mutable.buffer.text = 'late mutation'; mutable.pendingSave.operationId = randomUUID(); mutable.base.head = 'c'.repeat(40);
  await pending;
  assert.deepEqual(await f.store.read(original.scope), original);
});

test('closed private schema rejects unknown or mismatched fields and bounds without replacing prior text', async (t) => {
  const f = await fixture(t); const first = checkpoint(); await f.store.write(first);
  const changes = [
    (cp) => { cp.schemaVersion = 2; }, (cp) => { cp.confirmed = true; },
    (cp) => { cp.scope.actor = 'invented'; }, (cp) => { cp.base.record.extra = true; },
    (cp) => { cp.base.record.draftId = 'WFD-OTHER1'; }, (cp) => { cp.base.record.revision = 0; },
    (cp) => { cp.base.head = null; }, (cp) => { cp.capturedAt = '2026-02-31T10:11:12.123Z'; },
    (cp) => { cp.checkpointId = '../unsafe'; }, (cp) => { cp.pendingSave.uncertain = false; },
    (cp) => { cp.pendingSave.snapshot.epoch += 1; }, (cp) => { cp.pendingSave.snapshot.head = 'c'.repeat(40); },
    (cp) => { cp.pendingSave.snapshot.authority += '/other'; }, (cp) => { cp.buffer.name = 'x'.repeat(513); },
    (cp) => { cp.buffer.text = 'x'.repeat(WORKFLOW_DRAFT_RECOVERY_MAX_TEXT_BYTES + 1); },
    (cp) => { cp.buffer.text = '\ud800'; },
    (cp) => { cp.buffer.text = '\0'.repeat(WORKFLOW_DRAFT_RECOVERY_MAX_TEXT_BYTES); }
  ];
  for (const change of changes) {
    const cp = checkpoint(); change(cp);
    await assert.rejects(() => f.store.write(cp, first.checkpointId), code('WORKFLOW_DRAFT_RECOVERY_INVALID'));
  }
  assert.deepEqual(await f.store.read(scope), first);
  assert.equal(f.stores(), 1);
});

test('the 20 MiB encrypted envelope bound is independent of each valid 5 MiB text bound', async (t) => {
  const f = await fixture(t); const cp = checkpoint();
  cp.base.savedText = cp.buffer.text = cp.pendingSave.snapshot.text = 'x'.repeat(WORKFLOW_DRAFT_RECOVERY_MAX_TEXT_BYTES);
  await assert.rejects(() => f.store.write(cp), code('WORKFLOW_DRAFT_RECOVERY_INVALID'));
  await assert.rejects(() => stat(f.directory), { code: 'ENOENT' });
  assert.equal(f.stores(), 0);
  assert.equal(await f.store.read(scope), null);
});

test('tampered ciphertext, closed headers, invalid JSON and oversized seals fail visibly and are never discarded', async (t) => {
  const f = await fixture(t); const cp = checkpoint(); await f.store.write(cp);
  const original = await readFile(fileFor(f.directory)); const envelope = JSON.parse(original);
  const modified = { ...envelope }; const bytes = Buffer.from(modified.ciphertext, 'base64'); bytes[0] ^= 1; modified.ciphertext = bytes.toString('base64');
  for (const candidate of [JSON.stringify(modified), JSON.stringify({ ...envelope, confirmed: true }), '{', JSON.stringify({ ...envelope, tag: 'bad' })]) {
    await writeFile(fileFor(f.directory), candidate);
    await assert.rejects(() => f.store.read(scope), code('WORKFLOW_DRAFT_RECOVERY_CORRUPT'));
    await assert.rejects(() => f.store.remove(scope, cp.checkpointId), code('WORKFLOW_DRAFT_RECOVERY_CORRUPT'));
    assert.equal(await readFile(fileFor(f.directory), 'utf8'), candidate);
  }
  await writeFile(fileFor(f.directory), Buffer.alloc(WORKFLOW_DRAFT_RECOVERY_MAX_ENVELOPE_BYTES + 1));
  await assert.rejects(() => f.store.read(scope), code('WORKFLOW_DRAFT_RECOVERY_INVALID'));
  await writeFile(fileFor(f.directory), original);
  assert.deepEqual(await f.store.read(scope), cp);
});

test('scope AAD and decrypted scope are both exact, including repository authority and draft ID', async (t) => {
  const f = await fixture(t); const cp = checkpoint(); await f.store.write(cp);
  const original = await readFile(fileFor(f.directory));
  for (const alternate of [ { ...scope, repository: path.resolve('/fixture-only/other') },
    { ...scope, authority: 'https://other.example.test/config.git' }, { ...scope, draftId: 'WFD-OTHER1' } ]) {
    assert.equal(await f.store.read(alternate), null);
    await writeFile(fileFor(f.directory, alternate), original);
    await assert.rejects(() => f.store.read(alternate), code('WORKFLOW_DRAFT_RECOVERY_CORRUPT'));
    const key = Buffer.from([...f.values.values()][0], 'base64'); const nonce = randomBytes(12); const keyId = hash(key);
    const source = JSON.parse(original); const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([source.format, scopeHash(alternate), keyId])));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(cp))), cipher.final()]);
    await writeFile(fileFor(f.directory, alternate), JSON.stringify({ format: source.format,
      scopeSha256: scopeHash(alternate), keyId, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') }));
    await assert.rejects(() => f.store.read(alternate), code('WORKFLOW_DRAFT_RECOVERY_CORRUPT'));
    await unlink(fileFor(f.directory, alternate));
  }
  assert.deepEqual(await f.store.read(scope), cp);
});

test('an authenticated but unknown future or widened plaintext record still fails the closed recovery reader', async (t) => {
  const f = await fixture(t); const cp = checkpoint(); await f.store.write(cp);
  const original = await readFile(fileFor(f.directory)); const source = JSON.parse(original);
  const key = Buffer.from([...f.values.values()][0], 'base64');
  for (const value of [{ ...cp, schemaVersion: 2 }, { ...cp, approval: true },
    { ...cp, pendingSave: { ...cp.pendingSave, uncertain: false } }]) {
    const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([source.format, source.scopeSha256, source.keyId])));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value))), cipher.final()]);
    const sealed = JSON.stringify({ ...source, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') });
    await writeFile(fileFor(f.directory), sealed);
    await assert.rejects(() => f.store.read(scope), code('WORKFLOW_DRAFT_RECOVERY_CORRUPT'));
    await assert.rejects(() => f.store.remove(scope, cp.checkpointId), code('WORKFLOW_DRAFT_RECOVERY_CORRUPT'));
    assert.equal(await readFile(fileFor(f.directory), 'utf8'), sealed);
  }
  await writeFile(fileFor(f.directory), original);
});

test('lost or invalid SecretStorage keys never create a fallback key over retained ciphertext', async (t) => {
  const f = await fixture(t); const cp = checkpoint(); await f.store.write(cp);
  const original = await readFile(fileFor(f.directory)); const [secretName, secretValue] = [...f.values.entries()][0];
  f.values.clear();
  await assert.rejects(() => f.store.read(scope), code('WORKFLOW_DRAFT_RECOVERY_KEY_UNAVAILABLE'));
  await assert.rejects(() => f.store.write(checkpoint(), cp.checkpointId), code('WORKFLOW_DRAFT_RECOVERY_KEY_UNAVAILABLE'));
  const other = checkpoint(); other.scope.draftId = other.base.record.draftId = other.pendingSave.snapshot.draftId = 'WFD-OTHER1';
  await assert.rejects(() => f.store.write(other), code('WORKFLOW_DRAFT_RECOVERY_KEY_UNAVAILABLE'));
  assert.equal(f.stores(), 1);
  assert.deepEqual(await readFile(fileFor(f.directory)), original);
  f.values.set(secretName, 'invalid');
  await assert.rejects(() => f.store.read(scope), code('WORKFLOW_DRAFT_RECOVERY_KEY_UNAVAILABLE'));
  f.values.set(secretName, secretValue);
  assert.deepEqual(await f.store.read(scope), cp);
});

test('key persistence failure and storage exceptions never publish plaintext or disclose buffer/backend error contents', async (t) => {
  const f = await fixture(t); const sentinel = 'fixture-only-secret-and-buffer';
  for (const secrets of [
    { async get() { return undefined; }, async store() { throw new Error(sentinel); } },
    { async get() { return undefined; }, async store() {} },
    { async get() { throw new Error(sentinel); }, async store() {} }
  ]) {
    const store = createWorkflowDraftRecoveryStore(f.directory, secrets);
    await assert.rejects(() => store.write(checkpoint()), (error) => {
      assert.equal(error.code, 'WORKFLOW_DRAFT_RECOVERY_KEY_UNAVAILABLE'); assert.equal(error.message.includes(sentinel), false); return true;
    });
    assert.deepEqual(await readdir(f.directory), []);
  }
});

test('symlink ancestors and sealed-file symlinks or hardlinks refuse without following or changing outside files', async (t) => {
  const f = await fixture(t); const outside = path.join(f.base, 'outside'); await mkdir(outside);
  const ancestor = path.join(f.base, 'linked'); await symlink(outside, ancestor, process.platform === 'win32' ? 'junction' : 'dir');
  const unsafe = createWorkflowDraftRecoveryStore(path.join(ancestor, 'workflow-draft-recovery'), f.secrets);
  await assert.rejects(() => unsafe.write(checkpoint()), code('WORKFLOW_DRAFT_RECOVERY_UNSAFE_PATH'));
  await assert.rejects(() => unsafe.read(scope), code('WORKFLOW_DRAFT_RECOVERY_UNSAFE_PATH'));
  assert.deepEqual(await readdir(outside), []);
  const cp = checkpoint(); await f.store.write(cp); const sealed = await readFile(fileFor(f.directory));
  const outsideFile = path.join(outside, 'do-not-change'); await writeFile(outsideFile, sealed);
  await unlink(fileFor(f.directory)); await symlink(outsideFile, fileFor(f.directory));
  for (const action of [() => f.store.read(scope), () => f.store.write(checkpoint(), cp.checkpointId), () => f.store.remove(scope, cp.checkpointId)]) {
    await assert.rejects(action, code('WORKFLOW_DRAFT_RECOVERY_UNSAFE_PATH'));
  }
  assert.deepEqual(await readFile(outsideFile), sealed);
  await unlink(fileFor(f.directory)); await link(outsideFile, fileFor(f.directory));
  await assert.rejects(() => f.store.read(scope), code('WORKFLOW_DRAFT_RECOVERY_UNSAFE_PATH'));
  assert.deepEqual(await readFile(outsideFile), sealed);
});

test('crash-left writer and key-init locks never block reading an already sealed checkpoint or get auto-reaped', async (t) => {
  const f = await fixture(t); const cp = checkpoint(); await f.store.write(cp);
  const writer = path.join(f.directory, `.${scopeHash(scope)}.lock`); const keyLock = path.join(f.directory, '.key-init.lock');
  await writeFile(writer, ''); await writeFile(keyLock, '');
  const fresh = createWorkflowDraftRecoveryStore(f.directory, f.secrets);
  assert.deepEqual(await fresh.read(scope), cp);
  await assert.rejects(() => fresh.write(checkpoint(), cp.checkpointId), code('WORKFLOW_DRAFT_RECOVERY_BUSY'));
  assert.equal(await readFile(writer, 'utf8'), ''); assert.equal(await readFile(keyLock, 'utf8'), '');
  assert.deepEqual(await fresh.read(scope), cp);
});

test('symlinked scope and key-init locks never follow or overwrite an outside file', async (t) => {
  const f = await fixture(t); await mkdir(f.directory, { mode: 0o700 });
  const outside = path.join(f.base, 'outside-lock-do-not-change'); await writeFile(outside, 'fixture-only');
  const writer = path.join(f.directory, `.${scopeHash(scope)}.lock`);
  await symlink(outside, writer);
  await assert.rejects(() => f.store.write(checkpoint()), code('WORKFLOW_DRAFT_RECOVERY_UNSAFE_PATH'));
  await unlink(writer);
  const keyLock = path.join(f.directory, '.key-init.lock'); await symlink(outside, keyLock);
  await assert.rejects(() => f.store.write(checkpoint()), code('WORKFLOW_DRAFT_RECOVERY_UNSAFE_PATH'));
  assert.equal(await readFile(outside, 'utf8'), 'fixture-only');
  assert.equal(f.stores(), 0);
  assert.equal(await f.store.read(scope), null);
});

const workerCode = `
import { readFile, writeFile, appendFile } from 'node:fs/promises';
const {createWorkflowDraftRecoveryStore}=await import(${JSON.stringify(moduleUrl)});
let input=''; for await(const part of process.stdin) input+=part;
const request=JSON.parse(input);
const secrets={async get(){try{return await readFile(request.keyFile,'utf8')}catch(e){if(e.code==='ENOENT')return undefined;throw e}},
async store(_key,value){await new Promise(r=>setTimeout(r,100));await writeFile(request.keyFile,value);await appendFile(request.countFile,'.')}};
const store=createWorkflowDraftRecoveryStore(request.directory,secrets);
try { let expected=request.expected??null;
 for(const cp of request.checkpoints){await store.write(cp,expected);expected=cp.checkpointId;await new Promise(r=>setTimeout(r,5))}
 process.stdout.write(JSON.stringify({status:'stored',checkpointId:expected}));
}catch(e){process.stdout.write(JSON.stringify({status:'refused',code:e.code}));}
`;
function worker(request) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', workerCode], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { errors += chunk; });
  const result = new Promise((resolve, reject) => {
    child.on('error', reject); child.on('exit', (status) => {
      try { assert.equal(status, 0, errors); assert.equal(errors, ''); resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
  });
  child.stdin.end(JSON.stringify(request)); return result;
}
function fileSecrets(keyFile) { return { async get() { return readFile(keyFile, 'utf8').catch((error) => error.code === 'ENOENT' ? undefined : Promise.reject(error)); },
  async store(_key, value) { await writeFile(keyFile, value); } }; }

test('two independent extension-host processes cannot both create or replace the same private checkpoint', async (t) => {
  const f = await fixture(t); const first = checkpoint(); const second = checkpoint();
  const request = { directory: f.directory, keyFile: path.join(f.base, 'mock-secret-storage'), countFile: path.join(f.base, 'mock-key-write-count') };
  const outcomes = await Promise.all([worker({ ...request, checkpoints: [first] }), worker({ ...request, checkpoints: [second] })]);
  assert.deepEqual(outcomes.map((value) => value.status).sort(), ['refused', 'stored']);
  assert.equal(outcomes.find((value) => value.status === 'refused').code, 'WORKFLOW_DRAFT_RECOVERY_CONFLICT');
  const store = createWorkflowDraftRecoveryStore(f.directory, fileSecrets(request.keyFile));
  const winner = outcomes.find((value) => value.status === 'stored').checkpointId;
  assert.equal((await store.read(scope)).checkpointId, winner);
  const replacing = [checkpoint(), checkpoint()];
  const replacements = await Promise.all(replacing.map((cp) => worker({ ...request, checkpoints: [cp], expected: winner })));
  assert.deepEqual(replacements.map((value) => value.status).sort(), ['refused', 'stored']);
  assert.equal(replacements.find((value) => value.status === 'refused').code, 'WORKFLOW_DRAFT_RECOVERY_CONFLICT');
  assert.equal((await store.read(scope)).checkpointId, replacements.find((value) => value.status === 'stored').checkpointId);
  assert.equal(await store.remove(scope, winner), false);
  assert.equal(await readFile(request.countFile, 'utf8'), '.');
});

test('independent hosts concurrently creating distinct scopes persist one SecretStorage key without orphaning either seal', async (t) => {
  const f = await fixture(t); const first = checkpoint(); const second = checkpoint();
  second.scope.draftId = second.base.record.draftId = second.pendingSave.snapshot.draftId = 'WFD-OTHER1';
  const request = { directory: f.directory, keyFile: path.join(f.base, 'mock-secret-storage'), countFile: path.join(f.base, 'mock-key-write-count') };
  const outcomes = await Promise.all([worker({ ...request, checkpoints: [first] }), worker({ ...request, checkpoints: [second] })]);
  assert.deepEqual(outcomes.map((value) => value.status), ['stored', 'stored']);
  const store = createWorkflowDraftRecoveryStore(f.directory, fileSecrets(request.keyFile));
  assert.deepEqual(await store.read(first.scope), first); assert.deepEqual(await store.read(second.scope), second);
  assert.equal(await readFile(request.countFile, 'utf8'), '.');
});

test('lock-free reads observe complete authenticated old or new seals during independent atomic publications', async (t) => {
  const f = await fixture(t); const keyFile = path.join(f.base, 'mock-secret-storage');
  const store = createWorkflowDraftRecoveryStore(f.directory, fileSecrets(keyFile)); const first = checkpoint(); await store.write(first);
  const versions = Array.from({ length: 12 }, (_, index) => checkpoint({ buffer: { name: `Revision ${index}`, text: `literal-${index}:` + 'x'.repeat(128 * 1024) } }));
  const expected = new Map([first, ...versions].map((cp) => [cp.checkpointId, cp]));
  let completed = false;
  const pending = worker({ directory: f.directory, keyFile, countFile: path.join(f.base, 'mock-key-write-count'),
    expected: first.checkpointId, checkpoints: versions }).finally(() => { completed = true; });
  let observations = 0;
  while (!completed) { const cp = await store.read(scope); assert.deepEqual(cp, expected.get(cp.checkpointId)); observations += 1; }
  assert.equal((await pending).status, 'stored'); assert.ok(observations > 1);
  assert.deepEqual(await store.read(scope), versions.at(-1));
});
