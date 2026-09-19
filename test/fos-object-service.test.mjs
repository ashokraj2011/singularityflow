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
  closeFosGitObjectServices, fosGitObjectService, FosGitObjectService,
  probeFosGitObjectServiceCapabilities
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

function probeChild({ code = 0, stdout = [], stderr = [], hang = false,
  onInput = () => {} } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let closed = false;
  const close = (exitCode) => {
    if (closed) return;
    closed = true;
    setImmediate(() => child.emit('close', exitCode));
  };
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      onInput(chunk.toString('ascii'));
      callback();
    }
  });
  child.stdin.once('finish', () => {
    if (hang) return;
    for (const part of stdout) child.stdout.emit('data', Buffer.from(part));
    for (const part of stderr) child.stderr.emit('data', Buffer.from(part));
    close(code);
  });
  child.kill = () => { close(137); return true; };
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

function verifiedBatchCommandCapabilities() {
  return {
    capabilityEvidenceVersion: 1,
    mode: 'persistent-opt-in',
    selection: 'capability-probe',
    selectedProtocol: 'batch-command-buffered',
    batchCommand: {
      protocol: 'batch-command-buffered', status: 'supported', supported: true,
      exitCode: 0, timedOut: false, outputOverflow: false, cleanupVerified: true
    },
    legacyBatch: null,
    replacementSuppression: 'GIT_NO_REPLACE_OBJECTS=1',
    lazyFetchSuppression: 'GIT_NO_LAZY_FETCH=1'
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

test('GAL:AC-009 capability probe selects buffered batch-command with portable Windows process options', async () => {
  const root = await repository();
  const commonDir = realpathSync(path.join(root, '.git'));
  const executable = path.join(root, 'Git', 'cmd', 'git.exe');
  const calls = [];
  const inputs = [];
  const capabilities = await probeFosGitObjectServiceCapabilities(root, {
    executable,
    profile: { commonDir, gitDir: commonDir, objectFormat: 'sha1' },
    platform: 'win32',
    spawnCommand(command, args, options) {
      calls.push({ command, args, options });
      return probeChild({ onInput: (input) => inputs.push(input) });
    }
  });
  assert.deepEqual(capabilities, verifiedBatchCommandCapabilities());
  assert.equal(Object.isFrozen(capabilities), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, executable);
  assert.deepEqual(calls[0].args,
    [`--git-dir=${commonDir}`, 'cat-file', '--batch-command', '--buffer']);
  assert.equal(calls[0].options.cwd, commonDir);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.detached, false);
  assert.equal(calls[0].options.env.GIT_NO_REPLACE_OBJECTS, '1');
  assert.equal(calls[0].options.env.GIT_NO_LAZY_FETCH, '1');
  assert.deepEqual(inputs, ['flush\n']);
});

for (const scenario of [
  { name: 'unsupported', child: () => probeChild({ code: 129 }) },
  { name: 'malformed', child: () => probeChild({ stdout: ['unexpected\n'] }) },
  { name: 'timeout', child: () => probeChild({ hang: true }), timeoutMs: 20 },
  { name: 'unavailable', spawnFailure: true }
]) {
  test(`GAL:AC-009 capability probe deterministically falls back after ${scenario.name} batch-command`, async () => {
    const root = await repository();
    const commonDir = realpathSync(path.join(root, '.git'));
    const calls = [];
    const capabilities = await probeFosGitObjectServiceCapabilities(root, {
      executable: path.join(root, 'git'),
      profile: { commonDir, gitDir: commonDir, objectFormat: 'sha1' },
      timeoutMs: scenario.timeoutMs ?? 1_000,
      spawnCommand(_command, args, options) {
        calls.push({ args, options });
        if (calls.length === 1 && scenario.spawnFailure) throw new Error('spawn failed');
        return calls.length === 1 ? scenario.child() : probeChild();
      }
    });
    assert.equal(capabilities.selectedProtocol, 'legacy-batch');
    assert.equal(capabilities.batchCommand.status, scenario.name);
    assert.equal(capabilities.batchCommand.supported, false);
    assert.equal(capabilities.batchCommand.cleanupVerified, true);
    assert.equal(capabilities.legacyBatch.status, 'supported');
    assert.equal(capabilities.legacyBatch.supported, true);
    assert.equal(capabilities.legacyBatch.cleanupVerified, true);
    assert.deepEqual(calls.map(({ args }) => args.slice(1)), [
      ['cat-file', '--batch-command', '--buffer'],
      ['cat-file', '--batch']
    ]);
  });
}

test('GAL:AC-009 legacy fallback evidence drives the legacy worker grammar exactly', async () => {
  const root = await repository();
  const oid = git(['rev-parse', 'HEAD:source.bin'], root);
  const bytes = Buffer.from([0, 10, 255, 13, 10]);
  const probeCalls = [];
  const workerCalls = [];
  const writes = [];
  const service = new FosGitObjectService(root, {
    probeSpawnCommand(_command, args) {
      probeCalls.push(args);
      return probeCalls.length === 1 ? probeChild({ code: 129 }) : probeChild();
    },
    spawnCommand(command, args, options) {
      workerCalls.push({ command, args, options });
      return scriptedChild([
        Buffer.from(`${oid} blob ${bytes.length}\n`), bytes, Buffer.from('\n')
      ], (chunk) => writes.push(chunk.toString('ascii')))();
    }
  });
  try {
    assert.deepEqual((await service.read(oid)).bytes, bytes);
    assert.equal(service.capabilities.selectedProtocol, 'legacy-batch');
    assert.equal(service.capabilities.batchCommand.status, 'unsupported');
    assert.equal(workerCalls.length, 1);
    assert.deepEqual(workerCalls[0].args.slice(1), ['cat-file', '--batch']);
    assert.deepEqual(writes, [`${oid}\n`]);
  } finally {
    await service.close();
  }
});

test('GAL:AC-009 unavailable persistent protocols fail closed with structured evidence', async () => {
  const root = await repository();
  const commonDir = realpathSync(path.join(root, '.git'));
  let calls = 0;
  await assert.rejects(probeFosGitObjectServiceCapabilities(root, {
    executable: path.join(root, 'git'),
    profile: { commonDir, gitDir: commonDir, objectFormat: 'sha1' },
    spawnCommand() { calls += 1; throw new Error('not installed'); }
  }), (failure) => {
    assert.equal(failure.code, 'OBJECT_SERVICE_UNAVAILABLE');
    assert.equal(failure.details.batchCommand.status, 'unavailable');
    assert.equal(failure.details.legacyBatch.status, 'unavailable');
    return true;
  });
  assert.equal(calls, 2);
});

test('GAL:AC-025 cancellation retires a capability probe without starting its fallback', async () => {
  const root = await repository();
  const commonDir = realpathSync(path.join(root, '.git'));
  const controller = new AbortController();
  let received;
  const inputReceived = new Promise((resolve) => { received = resolve; });
  let calls = 0;
  const pending = probeFosGitObjectServiceCapabilities(root, {
    executable: path.join(root, 'git'),
    profile: { commonDir, gitDir: commonDir, objectFormat: 'sha1' },
    signal: controller.signal,
    spawnCommand() {
      calls += 1;
      return probeChild({ hang: true, onInput: received });
    }
  });
  await inputReceived;
  controller.abort();
  await assert.rejects(pending, { code: 'OBJECT_REQUEST_CANCELLED' });
  assert.equal(calls, 1);
});

test('GAL:AC-025 immediate capability-probe cancellation never writes after closing stdin', async () => {
  const root = await repository();
  const commonDir = realpathSync(path.join(root, '.git'));
  const controller = new AbortController();
  let inputs = 0;
  const pending = probeFosGitObjectServiceCapabilities(root, {
    executable: path.join(root, 'git'),
    profile: { commonDir, gitDir: commonDir, objectFormat: 'sha1' },
    signal: controller.signal,
    spawnCommand() {
      return probeChild({ hang: true, onInput: () => { inputs += 1; } });
    }
  });
  controller.abort();
  await assert.rejects(pending, { code: 'OBJECT_REQUEST_CANCELLED' });
  assert.equal(inputs, 0);
});

test('GAL:AC-026 capability fallback is blocked when probe cleanup cannot be verified', async () => {
  const root = await repository();
  const commonDir = realpathSync(path.join(root, '.git'));
  let calls = 0;
  const began = Date.now();
  await assert.rejects(probeFosGitObjectServiceCapabilities(root, {
    executable: path.join(root, 'git'),
    profile: { commonDir, gitDir: commonDir, objectFormat: 'sha1' },
    timeoutMs: 20,
    spawnCommand() {
      calls += 1;
      const child = probeChild({ hang: true });
      child.kill = () => true;
      return child;
    }
  }), (failure) => {
    assert.equal(failure.code, 'GAL_CLEANUP_INCOMPLETE');
    assert.equal(failure.details.probe.cleanupVerified, false);
    assert.equal(failure.details.probe.timedOut, true);
    return true;
  });
  assert.equal(calls, 1, 'an unretired preferred probe forbids legacy fallback overlap');
  assert.ok(Date.now() - began < 3_500, 'failed cleanup remains bounded');
});

test('GAL:AC-026 capability fallback waits for delayed process-tree cleanup after child close', async () => {
  const root = await repository();
  const commonDir = realpathSync(path.join(root, '.git'));
  let calls = 0;
  let releaseCleanup;
  const cleanupStarted = new Promise((resolve) => {
    releaseCleanup = (complete) => resolve(complete);
  });
  let resolveTree;
  const pending = probeFosGitObjectServiceCapabilities(root, {
    executable: path.join(root, 'git'),
    profile: { commonDir, gitDir: commonDir, objectFormat: 'sha1' },
    timeoutMs: 20,
    spawnCommand() {
      calls += 1;
      const child = calls === 1 ? probeChild({ hang: true }) : probeChild();
      child.pid = 4_321 + calls;
      return child;
    },
    terminateTree(child, _signal, options) {
      assert.equal(options.requireTree, true);
      child.kill();
      releaseCleanup(true);
      return new Promise((resolve) => { resolveTree = resolve; });
    }
  });
  await cleanupStarted;
  assert.equal(calls, 1,
    'the legacy worker must not start merely because the direct child emitted close');
  resolveTree(true);
  const capabilities = await pending;
  assert.equal(calls, 2);
  assert.equal(capabilities.selectedProtocol, 'legacy-batch');
  assert.equal(capabilities.batchCommand.cleanupVerified, true);
});

test('GAL:AC-026 a failed tree cleanup stays unverified after the direct child closes', async () => {
  const root = await repository();
  const commonDir = realpathSync(path.join(root, '.git'));
  let calls = 0;
  let strictTreeRequested = false;
  await assert.rejects(probeFosGitObjectServiceCapabilities(root, {
    executable: path.join(root, 'git'),
    profile: { commonDir, gitDir: commonDir, objectFormat: 'sha1' },
    timeoutMs: 20,
    spawnCommand() {
      calls += 1;
      const child = probeChild({ hang: true });
      child.pid = 4_444;
      return child;
    },
    async terminateTree(child, _signal, options) {
      strictTreeRequested = options.requireTree === true;
      child.kill();
      return false;
    }
  }), (failure) => failure.code === 'GAL_CLEANUP_INCOMPLETE'
    && failure.details?.probe?.cleanupVerified === false);
  assert.equal(calls, 1, 'an unverified tree cleanup forbids fallback overlap');
  assert.equal(strictTreeRequested, true,
    'a real spawned worker requires descendant-tree proof, not only direct-child close');
});

test('GAL:AC-026 asynchronous probe pipe failure is handled without crashing the process', async () => {
  const root = await repository();
  const commonDir = realpathSync(path.join(root, '.git'));
  let calls = 0;
  const capabilities = await probeFosGitObjectServiceCapabilities(root, {
    executable: path.join(root, 'git'),
    profile: { commonDir, gitDir: commonDir, objectFormat: 'sha1' },
    spawnCommand() {
      calls += 1;
      if (calls !== 1) return probeChild();
      const child = probeChild({ hang: true });
      child.stdin = new Writable({
        write(_chunk, _encoding, callback) {
          setImmediate(() => callback(Object.assign(new Error('broken pipe'), {
            code: 'EPIPE'
          })));
        }
      });
      return child;
    }
  });
  assert.equal(capabilities.batchCommand.status, 'unavailable');
  assert.equal(capabilities.legacyBatch.supported, true);
  assert.equal(calls, 2);
});

test('GAL:AC-026 asynchronous probe spawn failure is unavailable, not protocol incompatibility', async () => {
  const root = await repository();
  const commonDir = realpathSync(path.join(root, '.git'));
  let calls = 0;
  const capabilities = await probeFosGitObjectServiceCapabilities(root, {
    executable: path.join(root, 'missing-git'),
    profile: { commonDir, gitDir: commonDir, objectFormat: 'sha1' },
    spawnCommand() {
      calls += 1;
      if (calls !== 1) return probeChild();
      const child = probeChild({ hang: true });
      queueMicrotask(() => {
        child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
      });
      return child;
    }
  });
  assert.equal(capabilities.batchCommand.status, 'unavailable');
  assert.equal(capabilities.legacyBatch.supported, true);
  assert.equal(calls, 2);
});

test('GAL:AC-026 service close waits for in-flight probe cleanup and reports an unverifiable child', async () => {
  const root = await repository();
  const oid = git(['rev-parse', 'HEAD:source.bin'], root);
  let received;
  const inputReceived = new Promise((resolve) => { received = resolve; });
  const service = new FosGitObjectService(root, {
    probeSpawnCommand() {
      const child = probeChild({ hang: true, onInput: received });
      child.kill = () => true;
      return child;
    }
  });
  const pending = service.read(oid);
  const failed = assert.rejects(pending, { code: 'GAL_CLEANUP_INCOMPLETE' });
  await within(inputReceived, 'the capability-probe request');
  const outcome = await service.close();
  assert.deepEqual(outcome, { closed: true, terminated: false });
  await failed;
});

test('GAL:AC-025 caller cancellation cannot detach a shared capability probe from close', async () => {
  const root = await repository();
  const oid = git(['rev-parse', 'HEAD:source.bin'], root);
  const controller = new AbortController();
  let received;
  const inputReceived = new Promise((resolve) => { received = resolve; });
  let probes = 0;
  const service = new FosGitObjectService(root, {
    probeSpawnCommand() {
      probes += 1;
      const child = probeChild({ hang: true, onInput: received });
      child.kill = () => true;
      return child;
    }
  });
  const pending = service.read(oid, { signal: controller.signal });
  await within(inputReceived, 'the shared capability-probe request');
  controller.abort();
  await assert.rejects(pending, { code: 'OBJECT_REQUEST_CANCELLED' });

  const began = Date.now();
  const outcome = await service.close();
  assert.deepEqual(outcome, { closed: true, terminated: false });
  assert.equal(probes, 1, 'cancellation and close must retain one shared probe generation');
  assert.ok(Date.now() - began >= 1_500,
    'close must wait for the probe cleanup boundary instead of reporting early success');
});

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

test('GAL:AC-009 a transient verified probe failure is retryable and does not poison pool reuse', async () => {
  const root = await repository();
  const oid = git(['rev-parse', 'HEAD:source.bin'], root);
  let probes = 0;
  const capabilityProbe = async () => {
    probes += 1;
    if (probes === 1) throw Object.assign(new Error('temporarily unavailable'), {
      code: 'OBJECT_SERVICE_UNAVAILABLE'
    });
    return verifiedBatchCommandCapabilities();
  };
  try {
    const first = await fosGitObjectService(root, { capabilityProbe });
    await assert.rejects(first.read(oid), { code: 'OBJECT_SERVICE_UNAVAILABLE' });
    const reused = await fosGitObjectService(root, { capabilityProbe });
    assert.equal(reused, first);
    assert.deepEqual((await reused.read(oid)).bytes, Buffer.from([0, 10, 255, 13, 10]));
    assert.equal(probes, 2);
  } finally { await closeFosGitObjectServices(); }
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
    const expectedWrite = service.capabilities.selectedProtocol === 'batch-command-buffered'
      ? `contents ${firstOid}\ncontents ${secondOid}\ncontents ${firstOid}\nflush\n`
      : `${firstOid}\n${secondOid}\n${firstOid}\n`;
    assert.deepEqual(writes, [expectedWrite],
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
    platform: 'win32',
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
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.windowsHide, true);
    assert.equal(calls[0].options.detached, false);
    assert.deepEqual(calls[0].args, service.capabilities.selectedProtocol === 'batch-command-buffered'
      ? [`--git-dir=${commonDir}`, 'cat-file', '--batch-command', '--buffer']
      : [`--git-dir=${commonDir}`, 'cat-file', '--batch']);
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
