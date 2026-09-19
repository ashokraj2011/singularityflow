import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import { FosGitObjectService } from '../src/fos-object-service.mjs';
import { readLocalGitBlobsAsync } from '../src/git-local-blob-async.mjs';
import { createGitRuntime } from '../src/git-access.mjs';

function git(root, args, input) {
  return execFileSync('git', args, { cwd: root, input, encoding: 'utf8' }).trim();
}

function objectId(format, bytes) {
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

async function fixture(t, format) {
  const root = await mkdtemp(path.join(os.tmpdir(), `sflow-gal-transports-${format}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const init = spawnSync('git', ['init', '-q', `--object-format=${format}`], { cwd: root, encoding: 'utf8' });
  if (init.status !== 0) {
    t.skip(`This Git cannot initialize a ${format} object store.`);
    return null;
  }
  const runtimeResult = await createGitRuntime();
  assert.equal(runtimeResult.ok, true, JSON.stringify(runtimeResult));
  const runtime = runtimeResult.value;
  t.after(() => runtime.dispose());
  const binary = Buffer.from([0, 13, 10, 255, 0, 128, 10, 65, 0]);
  const replacement = Buffer.from('replacement must not alter exact object reads\n');
  const binaryOid = git(root, ['hash-object', '-w', '--stdin'], binary);
  const replacementOid = git(root, ['hash-object', '-w', '--stdin'], replacement);
  const emptyOid = git(root, ['hash-object', '-w', '--stdin'], Buffer.alloc(0));
  assert.equal(binaryOid, objectId(format, binary));
  assert.equal(emptyOid, objectId(format, Buffer.alloc(0)));
  await writeFile(path.join(root, 'file.bin'), binary);
  git(root, ['add', 'file.bin']);
  const treeOid = git(root, ['write-tree']);
  git(root, ['replace', binaryOid, replacementOid]);
  return { root, format, runtime, binary, binaryOid, emptyOid, treeOid };
}

function classifyFailure(code) {
  if (code === 'GAL_OBJECT_MISSING') return 'missing';
  if (code === 'GAL_WRONG_OBJECT_TYPE') return 'wrong-type';
  if (code === 'GAL_LIMIT_EXCEEDED' || code === 'LIMIT_EXCEEDED') return 'limit';
  throw new Error(`Unexpected raw-object failure: ${code}`);
}

function reference(fixtureValue, maximumObjectBytes = 32 * 1024 * 1024) {
  return async (oid) => {
    try {
      const values = await readLocalGitBlobsAsync(fixtureValue.root, [oid], {
        executable: fixtureValue.runtime.identity.path,
        env: process.env,
        maximumObjectBytes,
        maximumBatchBytes: 32 * 1024 * 1024
      });
      return { outcome: 'ok', oid, type: 'blob', bytes: values.get(oid), complete: true, effects: 'none' };
    } catch (failure) {
      return { outcome: classifyFailure(failure.code), oid, complete: false, effects: 'none' };
    }
  };
}

function persistent(service) {
  return async (oid) => {
    try {
      const value = await service.read(oid);
      if (!value) return { outcome: 'missing', oid, complete: false, effects: 'none' };
      if (value.type !== 'blob') return { outcome: 'wrong-type', oid, complete: false, effects: 'none' };
      return { outcome: 'ok', oid, type: value.type, bytes: value.bytes, complete: true, effects: 'none' };
    } catch (failure) {
      return { outcome: classifyFailure(failure.code), oid, complete: false, effects: 'none' };
    }
  };
}

for (const format of ['sha1', 'sha256']) {
  test(`GAL:AC-009/021 raw reference and persistent transports agree in ${format}`, async (t) => {
    const value = await fixture(t, format);
    if (!value) return;
    const worker = new FosGitObjectService(value.root);
    t.after(() => worker.close());
    const readers = [reference(value), persistent(worker)];
    const absent = '0'.repeat(format === 'sha1' ? 40 : 64);
    for (const oid of [value.binaryOid, value.emptyOid, absent, value.treeOid, value.binaryOid]) {
      const [expected, observed] = await Promise.all(readers.map((read) => read(oid)));
      assert.deepEqual(observed, expected, `transport mismatch for ${oid}`);
    }
    assert.deepEqual((await readers[1](value.binaryOid)).bytes, value.binary,
      'replacement refs, CRLF, NUL, and binary bytes must not change the original object');
    assert.equal(worker.processSpawns, 1);

    const limited = new FosGitObjectService(value.root, { maxObjectBytes: 2 });
    t.after(() => limited.close());
    assert.deepEqual(await persistent(limited)(value.binaryOid),
      await reference(value, 2)(value.binaryOid));
  });
}

test('GAL:AC-021 empty and duplicate batches preserve order, isolation, and zero empty-worker spawns', async (t) => {
  const value = await fixture(t, 'sha1');
  if (!value) return;
  const worker = new FosGitObjectService(value.root);
  t.after(() => worker.close());
  const opened = await value.runtime.openRepository(value.root);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  t.after(() => opened.value.dispose());
  const invocation = opened.value.beginInvocation();
  t.after(() => invocation.dispose());
  const emptyReference = await invocation.blobs({ oids: [] });
  assert.equal(emptyReference.ok, true);
  assert.deepEqual(emptyReference.value.entries, []);
  assert.deepEqual(await Promise.all([]), []);
  assert.equal(worker.processSpawns, 0);

  const oids = [value.binaryOid, value.emptyOid, value.binaryOid];
  const expected = await invocation.blobs({ oids });
  assert.equal(expected.ok, true, JSON.stringify(expected));
  const observed = (await worker.readBatch(oids)).map((result) => {
    return { oid: result.oid, bytes: result.bytes };
  });
  assert.deepEqual(observed, expected.value.entries);
  expected.value.entries[0].bytes[0] ^= 1;
  observed[0].bytes[0] ^= 1;
  assert.deepEqual(expected.value.entries[2].bytes, value.binary);
  assert.deepEqual(observed[2].bytes, value.binary);
});

test('GAL:AC-002/021 multiple bounded chunks reuse one worker and preserve mixed outcomes', async (t) => {
  const value = await fixture(t, 'sha1');
  if (!value) return;
  const worker = new FosGitObjectService(value.root);
  t.after(() => worker.close());
  const absent = '0'.repeat(40);
  const pattern = [value.binaryOid, value.emptyOid, absent, value.treeOid];
  const requested = Array.from({ length: 260 }, (_, index) => pattern[index % pattern.length]);
  const observed = [];
  for (let offset = 0; offset < requested.length; offset += 128) {
    observed.push(...await worker.readBatch(requested.slice(offset, offset + 128)));
  }
  assert.equal(observed.length, requested.length);
  for (let index = 0; index < observed.length; index += 1) {
    const oid = requested[index];
    if (oid === absent) {
      assert.equal(observed[index], null, `missing object at ${index}`);
    } else if (oid === value.treeOid) {
      assert.equal(observed[index].type, 'tree', `wrong-type sentinel at ${index}`);
      assert.equal(observed[index].oid, oid);
    } else {
      assert.equal(observed[index].type, 'blob');
      assert.equal(observed[index].oid, oid);
      assert.deepEqual(observed[index].bytes,
        oid === value.emptyOid ? Buffer.alloc(0) : value.binary);
    }
  }
  assert.equal(worker.processSpawns, 1,
    'three bounded chunks must reuse one capability-selected persistent worker');
});

test('GAL:AC-020 promised blob stays local-only until a separate acquisition', async (t) => {
  if (process.platform === 'win32') {
    t.skip('The file-URL partial-clone fixture needs a separate Git for Windows qualification.');
    return;
  }
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-gal-promisor-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const remote = path.join(base, 'remote.git');
  const source = path.join(base, 'source');
  const local = path.join(base, 'partial');
  await Promise.all([mkdir(remote), mkdir(source)]);
  git(remote, ['init', '-q', '--bare', '-b', 'main']);
  git(remote, ['config', 'uploadpack.allowFilter', 'true']);
  git(source, ['init', '-q', '-b', 'main']);
  git(source, ['config', 'user.name', 'GAL Test']);
  git(source, ['config', 'user.email', 'gal@example.com']);
  const bytes = Buffer.from([0, 10, 255, 13, 10, 0]);
  await writeFile(path.join(source, 'promised.bin'), bytes);
  git(source, ['add', 'promised.bin']);
  git(source, ['commit', '-qm', 'promisor fixture']);
  git(source, ['remote', 'add', 'origin', remote]);
  git(source, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  const cloned = spawnSync('git', [
    'clone', '-q', '--filter=blob:none', '--no-checkout', '--no-local',
    `file://${remote}`, local
  ], { encoding: 'utf8' });
  if (cloned.status !== 0) {
    t.skip(`Git lacks the required partial-clone fixture capability: ${cloned.stderr.trim()}`);
    return;
  }
  const oid = git(local, ['rev-parse', 'HEAD:promised.bin']);
  const unavailable = spawnSync('git', ['cat-file', '-e', oid], {
    cwd: local, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }, encoding: 'utf8'
  });
  if (unavailable.status === 0) {
    t.skip('The clone materialized its blob despite the blob:none filter.');
    return;
  }
  const created = await createGitRuntime();
  assert.equal(created.ok, true);
  t.after(() => created.value.dispose());
  const value = { root: local, runtime: created.value };
  const worker = new FosGitObjectService(local);
  t.after(() => worker.close());
  assert.deepEqual(await reference(value)(oid), {
    outcome: 'missing', oid, complete: false, effects: 'none'
  });
  assert.deepEqual(await persistent(worker)(oid), {
    outcome: 'missing', oid, complete: false, effects: 'none'
  });
  assert.notEqual(spawnSync('git', ['cat-file', '-e', oid], {
    cwd: local, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }
  }).status, 0, 'neither read acquired the promised blob');

  // This separate test-harness Git invocation intentionally permits lazy acquisition.
  const acquired = spawnSync('git', ['cat-file', 'blob', oid], { cwd: local });
  assert.equal(acquired.status, 0, String(acquired.stderr));
  assert.deepEqual(acquired.stdout, bytes);
  assert.deepEqual((await persistent(worker)(oid)).bytes, bytes);
  assert.deepEqual((await reference(value)(oid)).bytes, bytes);
});

function frame(oid, body) {
  return Buffer.concat([Buffer.from(`${oid} blob ${body.length}\n`), body, Buffer.from('\n')]);
}

function scriptedWorker(onWrite) {
  const child = new EventEmitter();
  let closed = false;
  const close = (code) => {
    if (closed) return;
    closed = true;
    setImmediate(() => child.emit('close', code));
  };
  child.stdout = new EventEmitter();
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      setImmediate(() => { onWrite(child, chunk); callback(); });
    }
  });
  child.stdin.once('finish', () => close(0));
  child.kill = () => { close(1); return true; };
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

test('GAL:AC-022 every header/body/terminator split preserves exact bytes', async (t) => {
  const value = await fixture(t, 'sha1');
  if (!value) return;
  const packet = frame(value.binaryOid, value.binary);
  const cases = [...Array(packet.length + 1).keys()].map((split) => ({
    oid: value.binaryOid, bytes: value.binary, parts: [packet.subarray(0, split), packet.subarray(split)]
  }));
  cases.push({ oid: value.emptyOid, bytes: Buffer.alloc(0), parts: [frame(value.emptyOid, Buffer.alloc(0))] });
  let sent = 0;
  const worker = new FosGitObjectService(value.root, {
    spawnCommand: () => scriptedWorker((child) => {
      const entry = cases[sent++];
      assert.ok(entry, 'worker received an unexpected command');
      for (const part of entry.parts) if (part.length) child.stdout.emit('data', part);
    })
  });
  t.after(() => worker.close());
  for (const entry of cases) {
    assert.deepEqual((await worker.read(entry.oid)).bytes, entry.bytes);
  }
  assert.equal(sent, cases.length);
  assert.equal(worker.processSpawns, 1);
});

test('GAL:AC-023 invalid frames and EOF retire their worker without contaminating later reads', async (t) => {
  const value = await fixture(t, 'sha1');
  if (!value) return;
  const good = frame(value.binaryOid, value.binary);
  const invalid = [
    { name: 'malformed length', bytes: Buffer.from(`${value.binaryOid} blob nope\n`), code: 'OBJECT_PROTOCOL_INVALID' },
    { name: 'integer overflow', bytes: Buffer.from(`${value.binaryOid} blob 9007199254740992\n`), code: 'OBJECT_PROTOCOL_INVALID' },
    { name: 'oversized length', bytes: Buffer.from(`${value.binaryOid} blob 999999999\n`), code: 'LIMIT_EXCEEDED' },
    { name: 'unknown record', bytes: Buffer.from(`${value.binaryOid} symlink 1\nx\n`), code: 'OBJECT_PROTOCOL_INVALID' },
    { name: 'ambiguous record', bytes: Buffer.from(`${value.binaryOid} ambiguous\n`), code: 'OBJECT_PROTOCOL_INVALID' },
    { name: 'wrong identity', bytes: Buffer.from(`${'f'.repeat(40)} blob 0\n\n`), code: 'OBJECT_PROTOCOL_INVALID' },
    { name: 'trailing bytes', bytes: Buffer.concat([good, Buffer.from('x')]), code: 'OBJECT_PROTOCOL_INVALID' },
    { name: 'coalesced unrequested frame', bytes: Buffer.concat([good, good]), code: 'OBJECT_PROTOCOL_INVALID' },
    { name: 'truncated EOF', bytes: good.subarray(0, good.length - 1), close: true, code: 'OBJECT_SERVICE_UNAVAILABLE' }
  ];
  for (const entry of invalid) {
    let spawns = 0;
    const worker = new FosGitObjectService(value.root, {
      spawnCommand: () => {
        const generation = ++spawns;
        return scriptedWorker((child) => {
          child.stdout.emit('data', generation === 1 ? entry.bytes : good);
          if (generation === 1 && entry.close) child.emit('close', 1);
        });
      }
    });
    try {
      await assert.rejects(worker.read(value.binaryOid), { code: entry.code }, entry.name);
      assert.deepEqual((await worker.read(value.binaryOid)).bytes, value.binary, entry.name);
      assert.equal(worker.processSpawns, 2, entry.name);
    } finally {
      await worker.close();
    }
  }
});

test('GAL:AC-025 cancelling an active frame retires only that frame; queued work uses a new worker', async (t) => {
  const value = await fixture(t, 'sha1');
  if (!value) return;
  let firstWritten;
  const wroteFirst = new Promise((resolve) => { firstWritten = resolve; });
  let spawns = 0;
  const worker = new FosGitObjectService(value.root, {
    spawnCommand: () => {
      const generation = ++spawns;
      return scriptedWorker((child) => {
        if (generation === 1) firstWritten();
        else child.stdout.emit('data', frame(value.emptyOid, Buffer.alloc(0)));
      });
    }
  });
  t.after(() => worker.close());
  const controller = new AbortController();
  const active = worker.read(value.binaryOid, { signal: controller.signal });
  const activeFailure = assert.rejects(active, { code: 'OBJECT_REQUEST_CANCELLED' });
  await wroteFirst;
  const queued = worker.read(value.emptyOid);
  for (let i = 0; worker.queued !== 2 && i < 50; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(worker.queued, 2);
  controller.abort();
  await activeFailure;
  assert.deepEqual((await queued).bytes, Buffer.alloc(0));
  assert.equal(worker.processSpawns, 2);
});

test('GAL:AC-009/040 reference fallback still verifies bytes after a persistent integrity failure', async (t) => {
  const value = await fixture(t, 'sha1');
  if (!value) return;
  const corrupt = Buffer.from(value.binary);
  corrupt[2] ^= 1;
  const worker = new FosGitObjectService(value.root, {
    spawnCommand: () => scriptedWorker((child) => {
      child.stdout.emit('data', frame(value.binaryOid, corrupt));
    })
  });
  t.after(() => worker.close());
  await assert.rejects(worker.read(value.binaryOid), { code: 'OBJECT_INTEGRITY_INVALID' });
  assert.deepEqual(await reference(value)(value.binaryOid), {
    outcome: 'ok', oid: value.binaryOid, type: 'blob', bytes: value.binary,
    complete: true, effects: 'none'
  });
});

test('GAL:AC-026 unverifiable worker cleanup blocks queued work and is reported by disposal', async (t) => {
  const value = await fixture(t, 'sha1');
  if (!value) return;
  let firstWritten;
  const wroteFirst = new Promise((resolve) => { firstWritten = resolve; });
  const worker = new FosGitObjectService(value.root, {
    spawnCommand: () => {
      const child = scriptedWorker(() => firstWritten());
      child.stdin.end = () => {}; // A stuck child neither consumes EOF nor closes its pipe.
      child.kill = () => true; // Deliberately no close evidence, despite accepting the signal.
      return child;
    }
  });
  t.after(() => worker.close());
  const controller = new AbortController();
  const active = worker.read(value.binaryOid, { signal: controller.signal });
  const activeFailure = assert.rejects(active, { code: 'OBJECT_REQUEST_CANCELLED' });
  await wroteFirst;
  const queued = worker.read(value.emptyOid);
  const queuedFailure = assert.rejects(queued, { code: 'GAL_CLEANUP_INCOMPLETE' });
  for (let i = 0; worker.queued !== 2 && i < 50; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(worker.queued, 2);
  controller.abort();
  await activeFailure;
  await queuedFailure;
  assert.equal(worker.processSpawns, 1);
  assert.deepEqual(await worker.dispose(), { closed: true, terminated: false });
});

test('GAL:AC-026 idle worker eviction is a verified close; a later service starts fresh', async (t) => {
  const value = await fixture(t, 'sha1');
  if (!value) return;
  const first = new FosGitObjectService(value.root, { idleMs: 20 });
  t.after(() => first.close());
  assert.deepEqual((await first.read(value.binaryOid)).bytes, value.binary);
  for (let i = 0; !first.closed && i < 50; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(first.closed, true);
  assert.deepEqual(await first.dispose(), { closed: true, terminated: true });
  const second = new FosGitObjectService(value.root);
  t.after(() => second.close());
  assert.deepEqual((await second.read(value.binaryOid)).bytes, value.binary);
  assert.equal(second.processSpawns, 1);
});
