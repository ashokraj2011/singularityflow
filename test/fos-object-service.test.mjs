import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import {
  closeFosGitObjectServices, fosGitObjectService, FosGitObjectService
} from '../src/fos-object-service.mjs';

function git(args, cwd, options = {}) { return execFileSync('git', args, { cwd, encoding: options.binary ? null : 'utf8', input: options.input }).toString().trim(); }
async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fos-objects-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.name', 'FOS Test'], root); git(['config', 'user.email', 'fos@example.com'], root);
  await writeFile(path.join(root, 'source.bin'), Buffer.from([0, 10, 255, 13, 10]));
  git(['add', '.'], root); git(['commit', '-qm', 'initial'], root);
  return root;
}

function objectId(format, type, bytes) {
  return createHash(format).update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
}

function scriptedChild(parts, onWrite = () => {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        setImmediate(() => {
          onWrite(chunk);
          for (const part of parts) child.stdout.emit('data', part);
          callback();
        });
      }
    });
    child.stdin.once('finish', () => setImmediate(() => child.emit('close', 0)));
    child.kill = () => { setImmediate(() => child.emit('close', 1)); return true; };
    return child;
  };
}

async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 2_000);
      })
    ]);
  } finally { clearTimeout(timer); }
}

async function waitForQueued(service, count) {
  const deadline = Date.now() + 2_000;
  while (service.queued !== count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(service.queued, count, `expected ${count} live logical subscribers`);
}

test('FOS:AC-031 persistent object service preserves binary bytes and missing results', async () => {
  const root = await repository();
  const oid = git(['rev-parse', 'HEAD:source.bin'], root);
  const service = new FosGitObjectService(root, { idleMs: 60_000 });
  const [first, second] = await Promise.all([service.read(oid), service.read(oid)]);
  assert.deepEqual(first.bytes, Buffer.from([0, 10, 255, 13, 10]));
  assert.deepEqual(second.bytes, first.bytes);
  assert.equal(service.processSpawns, 1);
  assert.equal(await service.read('0'.repeat(40)), null);
  const [closed, disposed] = await Promise.all([service.close(), service.dispose()]);
  assert.deepEqual(closed, { closed: true, terminated: true });
  assert.deepEqual(disposed, closed);
});

test('GAL:AC-021 explicit multi-frame batch preserves order, missing values, types, and byte isolation', async () => {
  const root = await repository();
  const oid = git(['rev-parse', 'HEAD:source.bin'], root);
  const emptyOid = git(['hash-object', '-w', '--stdin'], root, { input: Buffer.alloc(0) });
  const treeOid = git(['rev-parse', 'HEAD^{tree}'], root);
  const absent = '0'.repeat(40);
  const service = new FosGitObjectService(root);
  try {
    assert.deepEqual(await service.readBatch([]), []);
    assert.equal(service.processSpawns, 0, 'an empty batch must not start a child');
    const values = await service.readBatch([oid, emptyOid, absent, oid, treeOid]);
    assert.equal(values.length, 5);
    assert.deepEqual(values.map((value) => value?.oid ?? null),
      [oid, emptyOid, null, oid, treeOid]);
    assert.deepEqual(values.map((value) => value?.type ?? null),
      ['blob', 'blob', null, 'blob', 'tree']);
    assert.deepEqual(values[0].bytes, Buffer.from([0, 10, 255, 13, 10]));
    assert.deepEqual(values[1].bytes, Buffer.alloc(0));
    assert.deepEqual(values[3].bytes, values[0].bytes);
    values[0].bytes[0] ^= 1;
    assert.deepEqual(values[3].bytes, Buffer.from([0, 10, 255, 13, 10]),
      'duplicate object results must not share mutable buffers');
    assert.deepEqual((await service.read(oid)).bytes, values[3].bytes,
      'a following single read must parse independently of the batch');
    assert.equal(service.processSpawns, 1);
  } finally { await service.close(); }
});

test('GAL:AC-022 fragmented multi-frame output is one batch write and never accepts trailing frames', async () => {
  const root = await repository();
  const firstOid = git(['rev-parse', 'HEAD:source.bin'], root);
  const firstBytes = Buffer.from([0, 10, 255, 13, 10]);
  const secondBytes = Buffer.from('second batch frame\n');
  const secondOid = git(['hash-object', '-w', '--stdin'], root, { input: secondBytes });
  const frame = (oid, bytes) => Buffer.concat([
    Buffer.from(`${oid} blob ${bytes.length}\n`), bytes, Buffer.from('\n')
  ]);
  const packet = Buffer.concat([
    frame(firstOid, firstBytes), frame(secondOid, secondBytes), frame(firstOid, firstBytes)
  ]);
  const writes = [];
  let child;
  const service = new FosGitObjectService(root, {
    spawnCommand: () => {
      child = scriptedChild([], (chunk) => {
        writes.push(chunk.toString('ascii'));
        for (const part of [packet.subarray(0, 3), packet.subarray(3, 49),
          packet.subarray(49, packet.length - 1), packet.subarray(packet.length - 1)]) {
          child.stdout.emit('data', part);
        }
      })();
      return child;
    }
  });
  try {
    const values = await service.readBatch([firstOid, secondOid, firstOid]);
    assert.deepEqual(values.map((entry) => entry.bytes), [firstBytes, secondBytes, firstBytes]);
    assert.deepEqual(writes, [`${firstOid}\n${secondOid}\n${firstOid}\n`],
      'a batch must send its full ordered OID list in one stdin write');
    // A separate service proves that a valid prefix plus an unsolicited frame is rejected atomically.
    const invalid = new FosGitObjectService(root, {
      spawnCommand: () => scriptedChild([Buffer.concat([
        frame(firstOid, firstBytes), frame(secondOid, secondBytes), frame(firstOid, firstBytes)
      ])])()
    });
    try {
      await assert.rejects(invalid.readBatch([firstOid, secondOid]),
        { code: 'OBJECT_PROTOCOL_INVALID' });
    } finally { await invalid.close(); }
  } finally { await service.close(); }
});

test('GAL:AC-023 a later oversized or corrupt batch frame fails the whole batch', async () => {
  const root = await repository();
  const oid = git(['rev-parse', 'HEAD:source.bin'], root);
  const bytes = Buffer.from([0, 10, 255, 13, 10]);
  const frame = (body) => Buffer.concat([
    Buffer.from(`${oid} blob ${body.length}\n`), body, Buffer.from('\n')
  ]);
  const limited = new FosGitObjectService(root, { maxBatchBytes: bytes.length });
  try {
    await assert.rejects(limited.readBatch([oid, oid]), { code: 'LIMIT_EXCEEDED' },
      'aggregate size must be enforced before returning any partial batch result');
    assert.deepEqual((await limited.read(oid)).bytes, bytes,
      'a failed batch must not poison a fresh worker');
  } finally { await limited.close(); }

  let generations = 0;
  const corrupt = new FosGitObjectService(root, {
    spawnCommand: () => {
      generations += 1;
      const emitted = generations === 1
        ? Buffer.concat([frame(bytes), frame(Buffer.from([1, 10, 255, 13, 10]))])
        : frame(bytes);
      return scriptedChild([emitted])();
    }
  });
  try {
    await assert.rejects(corrupt.readBatch([oid, oid]), { code: 'OBJECT_INTEGRITY_INVALID' });
    assert.deepEqual((await corrupt.read(oid)).bytes, bytes);
    assert.equal(generations, 2, 'integrity failure must retire the batch worker');
  } finally { await corrupt.close(); }
});

test('GAL:AC-025 a queued batch can cancel without writing or disturbing the active frame', async () => {
  const root = await repository();
  const activeOid = git(['rev-parse', 'HEAD:source.bin'], root);
  const activeBytes = Buffer.from([0, 10, 255, 13, 10]);
  const otherBytes = Buffer.from('queued batch only\n');
  const otherOid = git(['hash-object', '-w', '--stdin'], root, { input: otherBytes });
  let child;
  let writes = 0;
  let wroteFirst;
  const firstWrite = new Promise((resolve) => { wroteFirst = resolve; });
  const service = new FosGitObjectService(root, {
    maxQueued: 3,
    spawnCommand: () => {
      child = scriptedChild([], () => { writes += 1; wroteFirst(); })();
      return child;
    }
  });
  try {
    const active = service.read(activeOid);
    await within(firstWrite, 'the active object-worker write');
    const cancelled = new AbortController();
    const batch = service.readBatch([otherOid, activeOid], { signal: cancelled.signal });
    const failure = assert.rejects(batch, { code: 'OBJECT_REQUEST_CANCELLED' });
    await waitForQueued(service, 3);
    await assert.rejects(service.read(otherOid), { code: 'GAL_BUSY' });
    cancelled.abort();
    await failure;
    assert.equal(service.queued, 1);
    child.stdout.emit('data', Buffer.concat([
      Buffer.from(`${activeOid} blob ${activeBytes.length}\n`),
      activeBytes, Buffer.from('\n')
    ]));
    assert.deepEqual((await active).bytes, activeBytes);
    assert.equal(writes, 1, 'cancelled queued batch must never reach stdin');
  } finally { await service.close(); }
});

test('GAL:AC-025 cancelling a partially received batch retires its worker before queued work', async () => {
  const root = await repository();
  const firstOid = git(['rev-parse', 'HEAD:source.bin'], root);
  const firstBytes = Buffer.from([0, 10, 255, 13, 10]);
  const secondBytes = Buffer.from('queued after batch cancellation\n');
  const secondOid = git(['hash-object', '-w', '--stdin'], root, { input: secondBytes });
  const frame = (oid, bytes) => Buffer.concat([
    Buffer.from(`${oid} blob ${bytes.length}\n`), bytes, Buffer.from('\n')
  ]);
  let wroteFirst;
  const firstWrite = new Promise((resolve) => { wroteFirst = resolve; });
  let generations = 0;
  const service = new FosGitObjectService(root, {
    spawnCommand: () => {
      generations += 1;
      const generation = generations;
      let child;
      child = scriptedChild([], () => {
        if (generation === 1) {
          child.stdout.emit('data', frame(firstOid, firstBytes));
          wroteFirst();
        } else child.stdout.emit('data', frame(secondOid, secondBytes));
      })();
      return child;
    }
  });
  try {
    const controller = new AbortController();
    const batch = service.readBatch([firstOid, secondOid], { signal: controller.signal });
    const failure = assert.rejects(batch, { code: 'OBJECT_REQUEST_CANCELLED' });
    await within(firstWrite, 'the first batch frame');
    const queued = service.read(secondOid);
    await waitForQueued(service, 3);
    controller.abort();
    await failure;
    assert.deepEqual((await queued).bytes, secondBytes);
    assert.equal(generations, 2, 'queued work must use a verified fresh worker');
  } finally { await service.close(); }
});

test('GAL:AC-025 a partial batch obeys its operation deadline and retires the worker', async () => {
  const root = await repository();
  const oid = git(['rev-parse', 'HEAD:source.bin'], root);
  const bytes = Buffer.from([0, 10, 255, 13, 10]);
  const packet = Buffer.concat([
    Buffer.from(`${oid} blob ${bytes.length}\n`), bytes, Buffer.from('\n')
  ]);
  let writes = 0;
  let child;
  const service = new FosGitObjectService(root, {
    timeoutMs: 500,
    spawnCommand: () => {
      child = scriptedChild([], () => {
        writes += 1;
        child.stdout.emit('data', packet);
        // The second write is a two-OID batch; intentionally omit its second frame.
      })();
      return child;
    }
  });
  try {
    assert.deepEqual((await service.read(oid)).bytes, bytes, 'warm the worker before the timed batch');
    await assert.rejects(service.readBatch([oid, oid]), { code: 'OBJECT_REQUEST_TIMEOUT' });
    assert.equal(writes, 2);
    assert.equal((await service.close()).terminated, true);
  } finally { await service.close(); }
});

test('GAL:AC-025 identical in-flight readers share one write but retain independent bytes', async () => {
  const root = await repository();
  const oid = git(['rev-parse', 'HEAD:source.bin'], root);
  const bytes = Buffer.from([0, 10, 255, 13, 10]);
  const frame = Buffer.concat([Buffer.from(`${oid} blob ${bytes.length}\n`), bytes, Buffer.from('\n')]);
  let child;
  let writes = 0;
  let wroteFirst;
  const firstWrite = new Promise((resolve) => { wroteFirst = resolve; });
  const service = new FosGitObjectService(root, {
    spawnCommand: () => {
      child = scriptedChild([], () => {
        writes += 1;
        if (writes === 1) wroteFirst();
        else child.stdout.emit('data', frame);
      })();
      return child;
    }
  });
  try {
    const first = service.read(oid);
    await within(firstWrite, 'the first object-worker write');
    const second = service.read(oid);
    await waitForQueued(service, 2);
    child.stdout.emit('data', frame);
    const [one, two] = await Promise.all([first, second]);
    assert.equal(writes, 1, 'two logical subscribers must require one physical worker write');
    assert.deepEqual(one.bytes, bytes);
    assert.deepEqual(two.bytes, bytes);
    one.bytes[0] ^= 1;
    assert.deepEqual(two.bytes, bytes, 'one caller cannot mutate another caller’s bytes');
    assert.deepEqual((await service.read(oid)).bytes, bytes,
      'a completed group must not become a sticky cross-invocation answer');
    assert.equal(writes, 2);
  } finally { await service.close(); }
});

test('GAL:AC-025 cancelling one coalesced subscriber preserves its live peer and worker', async () => {
  const root = await repository();
  const oid = git(['rev-parse', 'HEAD:source.bin'], root);
  const bytes = Buffer.from([0, 10, 255, 13, 10]);
  let child;
  let writes = 0;
  let wroteFirst;
  const firstWrite = new Promise((resolve) => { wroteFirst = resolve; });
  const service = new FosGitObjectService(root, {
    spawnCommand: () => {
      child = scriptedChild([], () => { writes += 1; wroteFirst(); })();
      return child;
    }
  });
  try {
    const cancelled = new AbortController();
    const first = service.read(oid, { signal: cancelled.signal });
    const firstFailure = assert.rejects(first, { code: 'OBJECT_REQUEST_CANCELLED' });
    await within(firstWrite, 'the first object-worker write');
    const second = service.read(oid);
    await waitForQueued(service, 2);
    cancelled.abort();
    await firstFailure;
    assert.equal(service.queued, 1);
    child.stdout.emit('data', Buffer.concat([
      Buffer.from(`${oid} blob ${bytes.length}\n`), bytes, Buffer.from('\n')
    ]));
    assert.deepEqual((await second).bytes, bytes);
    assert.equal(writes, 1);
  } finally { await service.close(); }
});

test('GAL:AC-025 queued coalesced peers cancel independently and count against queue capacity', async () => {
  const root = await repository();
  const activeOid = git(['rev-parse', 'HEAD:source.bin'], root);
  const activeBytes = Buffer.from([0, 10, 255, 13, 10]);
  const queuedBytes = Buffer.from('queued coalesced object\n');
  const queuedOid = git(['hash-object', '-w', '--stdin'], root, { input: queuedBytes });
  const frame = (oid, bytes) => Buffer.concat([
    Buffer.from(`${oid} blob ${bytes.length}\n`), bytes, Buffer.from('\n')
  ]);
  let child;
  let writes = 0;
  let wroteFirst;
  const firstWrite = new Promise((resolve) => { wroteFirst = resolve; });
  const service = new FosGitObjectService(root, {
    maxQueued: 3,
    spawnCommand: () => {
      child = scriptedChild([], () => {
        writes += 1;
        if (writes === 1) wroteFirst();
        else child.stdout.emit('data', frame(queuedOid, queuedBytes));
      })();
      return child;
    }
  });
  try {
    const active = service.read(activeOid);
    await within(firstWrite, 'the first object-worker write');
    const cancelled = new AbortController();
    const queuedCancelled = service.read(queuedOid, { signal: cancelled.signal });
    const cancelledFailure = assert.rejects(queuedCancelled, { code: 'OBJECT_REQUEST_CANCELLED' });
    const queuedLive = service.read(queuedOid);
    await waitForQueued(service, 3);
    await assert.rejects(service.read(queuedOid), { code: 'GAL_BUSY' },
      'coalesced subscribers must still consume logical queue capacity');
    cancelled.abort();
    await cancelledFailure;
    assert.equal(service.queued, 2);
    const replacement = service.read(queuedOid);
    await waitForQueued(service, 3);
    assert.equal(writes, 1, 'queued peers cannot write before the active frame completes');
    child.stdout.emit('data', frame(activeOid, activeBytes));
    assert.deepEqual((await active).bytes, activeBytes);
    const [live, newPeer] = await Promise.all([queuedLive, replacement]);
    assert.deepEqual(live.bytes, queuedBytes);
    assert.deepEqual(newPeer.bytes, queuedBytes);
    assert.equal(writes, 2, 'the two remaining queued peers share one worker write');
  } finally { await service.close(); }
});

test('FOS:AC-028 a missing object result is not sticky after the exact object becomes available', async () => {
  const root = await repository();
  const bytes = Buffer.from('arrives after the negative lookup\n');
  const oid = git(['hash-object', '--stdin'], root, { input: bytes });
  const service = new FosGitObjectService(root, { idleMs: 60_000 });
  assert.equal(await service.read(oid), null);
  assert.equal(git(['hash-object', '-w', '--stdin'], root, { input: bytes }), oid);
  const available = await service.read(oid);
  assert.equal(available.oid, oid);
  assert.equal(available.type, 'blob');
  assert.deepEqual(available.bytes, bytes);
  assert.equal(service.processSpawns, 1);
  await service.close();
});

test('FOS:AC-031 linked worktrees share one immutable object-store service', async () => {
  const root = await repository();
  const target = path.join(path.dirname(root), `${path.basename(root)}-linked`);
  git(['worktree', 'add', '-q', '-b', 'WORK-OBJECTS', target, 'main'], root);
  const first = await fosGitObjectService(root, { idleMs: 60_000 });
  const second = await fosGitObjectService(target, { idleMs: 60_000 });
  assert.equal(first, second);
  const oid = git(['rev-parse', 'HEAD:source.bin'], root);
  assert.deepEqual((await second.read(oid)).bytes, Buffer.from([0, 10, 255, 13, 10]));
  git(['worktree', 'remove', '--force', target], root);
  assert.deepEqual((await first.read(oid)).bytes, Buffer.from([0, 10, 255, 13, 10]),
    'the worker must not depend on a removable linked worktree');
  await closeFosGitObjectServices();
});

test('FOS:AC-031 oversized objects fail closed and terminate the protocol session', async () => {
  const root = await repository();
  const oid = git(['rev-parse', 'HEAD:source.bin'], root);
  const service = new FosGitObjectService(root, { maxObjectBytes: 2, idleMs: 60_000 });
  await assert.rejects(() => service.read(oid), (error) => error.code === 'LIMIT_EXCEEDED');
  await service.close();
});

test('FOS:AC-011 storage-format mismatches and revision expressions never reach the worker', async () => {
  const root = await repository();
  const service = new FosGitObjectService(root);
  for (const input of ['a'.repeat(39), 'a'.repeat(41), 'a'.repeat(64), 'HEAD', 'a'.repeat(40) + '^{}']) {
    await assert.rejects(() => service.read(input), { code: 'OBJECT_ID_INVALID' });
  }
  assert.equal(service.processSpawns, 0);
  await service.close();
});

test('FOS:AC-022 raw object worker ignores replacements and untrusted Git environment overrides', async () => {
  const root = await repository();
  const officeConfig = path.join(root, 'office.gitconfig');
  await writeFile(officeConfig, '');
  const original = Buffer.from([0, 10, 13, 255, 0]);
  const replacement = Buffer.from('replacement contents\n');
  const oid = git(['hash-object', '-w', '--stdin'], root, { input: original });
  const replacementOid = git(['hash-object', '-w', '--stdin'], root, { input: replacement });
  git(['replace', oid, replacementOid], root);
  const calls = [];
  const service = new FosGitObjectService(root, {
    env: {
      ...process.env,
      GIT_DIR: path.join(root, 'not-the-repository'),
      GIT_OBJECT_DIRECTORY: path.join(root, 'not-the-objects'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.repositoryformatversion',
      GIT_CONFIG_VALUE_0: '999',
      GIT_CONFIG_GLOBAL: officeConfig,
      GIT_NO_REPLACE_OBJECTS: '0',
      GIT_NO_LAZY_FETCH: '0',
      HTTPS_PROXY: 'http://office-proxy.invalid:8080',
      SSL_CERT_FILE: '/office/ca.pem'
    },
    spawnCommand(command, args, options) {
      calls.push({ command, args, options });
      return spawn(command, args, options);
    }
  });
  try {
    assert.deepEqual((await service.read(oid)).bytes, original);
    assert.equal(calls.length, 1);
    assert.equal(path.isAbsolute(calls[0].command), true);
    const commonDir = realpathSync(path.join(root, '.git'));
    assert.equal(calls[0].options.cwd, commonDir);
    assert.deepEqual(calls[0].args, [`--git-dir=${commonDir}`, 'cat-file', '--batch']);
    assert.equal(calls[0].options.env.GIT_NO_REPLACE_OBJECTS, '1');
    assert.equal(calls[0].options.env.GIT_NO_LAZY_FETCH, '1');
    assert.equal(calls[0].options.env.GIT_DIR, undefined);
    assert.equal(calls[0].options.env.GIT_OBJECT_DIRECTORY, undefined);
    assert.equal(calls[0].options.env.GIT_CONFIG_COUNT, undefined);
    assert.equal(calls[0].options.env.GIT_CONFIG_GLOBAL, officeConfig);
    assert.equal(calls[0].options.env.HTTPS_PROXY, 'http://office-proxy.invalid:8080');
    assert.equal(calls[0].options.env.SSL_CERT_FILE, '/office/ca.pem');
  } finally {
    await service.close();
  }
});

test('FOS:AC-023 fragmented binary frames are verified and corrupt bodies retire the worker', async () => {
  const root = await repository();
  const body = Buffer.from([0, 10, 255, 13, 10, 128]);
  const oid = objectId('sha1', 'blob', body);
  const header = Buffer.from(`${oid} blob ${body.length}\n`);
  const valid = new FosGitObjectService(root, {
    spawnCommand: scriptedChild([header.subarray(0, 2), header.subarray(2), body.subarray(0, 3), body.subarray(3), Buffer.from('\n')])
  });
  assert.deepEqual((await valid.read(oid)).bytes, body);
  await valid.close();

  const corrupt = Buffer.from(body);
  corrupt[2] ^= 1;
  const invalid = new FosGitObjectService(root, {
    spawnCommand: scriptedChild([header, corrupt, Buffer.from('\n')])
  });
  await assert.rejects(() => invalid.read(oid), { code: 'OBJECT_INTEGRITY_INVALID' });
  await invalid.close();
});

test('FOS:AC-011 SHA-256 stores require SHA-256 IDs and verify their bodies', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fos-sha256-'));
  const initialized = spawnSync('git', ['init', '-q', '--object-format=sha256'], { cwd: root, encoding: 'utf8' });
  if (initialized.status !== 0) {
    t.skip('This Git does not support SHA-256 repositories.');
    return;
  }
  const bytes = Buffer.from([0, 255, 10, 128]);
  const oid = git(['hash-object', '-w', '--stdin'], root, { input: bytes });
  const service = new FosGitObjectService(root);
  try {
    await assert.rejects(() => service.read('a'.repeat(40)), { code: 'OBJECT_ID_INVALID' });
    assert.equal(service.processSpawns, 0);
    assert.equal(oid, objectId('sha256', 'blob', bytes));
    assert.deepEqual((await service.read(oid)).bytes, bytes);
  } finally {
    await service.close();
  }
});

test('FOS:AC-025 cancellation before enqueue does no worker work; queued cancellation preserves active ownership', async () => {
  const root = await repository();
  const oid = git(['rev-parse', 'HEAD:source.bin'], root);
  const queuedOid = git(['rev-parse', 'HEAD'], root);
  let written;
  const firstWrite = new Promise((resolve) => { written = resolve; });
  const service = new FosGitObjectService(root, {
    spawnCommand: scriptedChild([], written), maxQueued: 2
  });
  try {
    const before = new AbortController();
    before.abort();
    await assert.rejects(() => service.read(oid, { signal: before.signal }), { code: 'OBJECT_REQUEST_CANCELLED' });
    assert.equal(service.processSpawns, 0);

    const active = service.read(oid);
    const activeRejected = assert.rejects(active, { code: 'OBJECT_SERVICE_CLOSED' });
    await firstWrite;
    const queuedController = new AbortController();
    const queued = service.read(queuedOid, { signal: queuedController.signal });
    for (let attempt = 0; service.queued !== 2 && attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(service.queued, 2);
    await assert.rejects(() => service.read(oid), { code: 'GAL_BUSY' });
    queuedController.abort();
    await assert.rejects(queued, { code: 'OBJECT_REQUEST_CANCELLED' });
    assert.equal(service.queued, 1);
    await service.close();
    await activeRejected;
  } finally {
    await service.close();
  }
});

test('FOS:AC-028 pool and direct readers retire after repository configuration changes', async () => {
  const root = await repository();
  const oid = git(['rev-parse', 'HEAD:source.bin'], root);
  const pooled = await fosGitObjectService(root);
  const direct = new FosGitObjectService(root);
  try {
    await pooled.read(oid);
    await direct.read(oid);
    git(['config', '--local', 'sflow.objectProfileProbe', 'changed-profile-value'], root);
    await assert.rejects(() => direct.read(oid), { code: 'OBJECT_SERVICE_STALE' });
    assert.equal(direct.closed, true);
    const replacement = await fosGitObjectService(root);
    assert.notEqual(replacement, pooled);
    assert.equal(pooled.closed, true);
    assert.deepEqual((await replacement.read(oid)).bytes, Buffer.from([0, 10, 255, 13, 10]));
    const changedEnvironment = await fosGitObjectService(root, {
      env: { ...process.env, HTTPS_PROXY: 'http://different-office-proxy.invalid:8080' }
    });
    assert.notEqual(changedEnvironment, replacement);
    assert.equal(replacement.closed, true);
  } finally {
    await direct.close();
    await closeFosGitObjectServices();
  }
});

test('FOS profile acquisition obeys caller cancellation and the operation deadline', async () => {
  const root = await repository();
  const oid = git(['rev-parse', 'HEAD:source.bin'], root);
  const never = new Promise(() => {});
  const cancelled = new FosGitObjectService(root, { profile: never, timeoutMs: 500 });
  const controller = new AbortController();
  const pending = cancelled.read(oid, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'OBJECT_REQUEST_CANCELLED' });
  await cancelled.close();

  const timed = new FosGitObjectService(root, { profile: never, timeoutMs: 40 });
  const began = Date.now();
  await assert.rejects(timed.read(oid), { code: 'OBJECT_REQUEST_TIMEOUT' });
  assert.ok(Date.now() - began < 1_000, 'profile wait must not outlive its bounded deadline');
  await timed.close();
});

test('FOS pool refuses replacement when the old worker never proves cleanup', async () => {
  const root = await repository();
  const oid = git(['rev-parse', 'HEAD:source.bin'], root);
  const bytes = Buffer.from([0, 10, 255, 13, 10]);
  const transport = scriptedChild([
    Buffer.from(`${oid} blob ${bytes.length}\n`), bytes, Buffer.from('\n')
  ]);
  const stubbornTransport = () => {
    const child = transport();
    child.stdin.end = () => {};
    child.kill = () => true;
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const pooled = await fosGitObjectService(root, {
    spawnCommand: stubbornTransport, idleMs: 60_000
  });
  assert.deepEqual((await pooled.read(oid)).bytes, bytes);
  git(['config', '--local', 'sflow.objectProfileProbe', 'changed'], root);
  await assert.rejects(() => fosGitObjectService(root, {
    spawnCommand: stubbornTransport, idleMs: 60_000
  }), { code: 'GAL_CLEANUP_INCOMPLETE' });
  assert.equal(pooled.closed, true);
  const outcome = await closeFosGitObjectServices();
  assert.deepEqual(outcome, { closed: true, terminated: false });
});

test('FOS does not count a failed child start as a physical Git spawn', async () => {
  const root = await repository();
  const oid = git(['rev-parse', 'HEAD:source.bin'], root);
  const worker = new FosGitObjectService(root, {
    spawnCommand: () => {
      const child = scriptedChild([])();
      queueMicrotask(() => child.emit('error', Object.assign(new Error('not found'), {
        code: 'ENOENT'
      })));
      return child;
    }
  });
  await assert.rejects(worker.read(oid), { code: 'OBJECT_SERVICE_UNAVAILABLE' });
  assert.equal(worker.processSpawns, 0);
  await worker.close();
});
