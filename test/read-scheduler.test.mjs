import test from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import assert from 'node:assert/strict';
import { createReadScheduler } from '../src/read-scheduler.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
test('a shared drain restores each requester context instead of inheriting the prior author or reviewer', async () => {
  const scheduler = createReadScheduler({ concurrency: 1 });
  const contexts = new AsyncLocalStorage(); let release;
  const first = contexts.run('author', () => scheduler.run('first', () => new Promise(resolve => { release = resolve; })));
  await tick();
  const second = contexts.run('independent-reviewer', () => scheduler.run('second', async () => {
    assert.equal(contexts.getStore(), 'independent-reviewer');
    await tick(); assert.equal(contexts.getStore(), 'independent-reviewer');
  }));
  release(); await Promise.all([first, second]); await tick();
  assert.equal(contexts.getStore(), undefined);
  assert.deepEqual(scheduler.counts(), { running: 0, queued: 0, repositories: 0 });
});

test('read scheduling bounds global/per-repository concurrency and releases all request keys', async () => {
  const scheduler = createReadScheduler({ concurrency: 3, perRepository: 1 });
  const pending = [], releases = [];
  for (const key of ['a', 'a', 'b', 'c']) pending.push(scheduler.run(key, () => new Promise(resolve => releases.push(resolve))));
  await tick(); assert.deepEqual(scheduler.counts(), { running: 3, queued: 1, repositories: 3 });
  releases.shift()(); await tick(); assert.equal(releases.length, 3);
  releases.forEach(release => release()); await Promise.all(pending); await tick();
  assert.deepEqual(scheduler.counts(), { running: 0, queued: 0, repositories: 0 });
});

test('queued cancellation is content-free and running cancellation holds its cleanup slot', async () => {
  const scheduler = createReadScheduler({ concurrency: 1, perRepository: 1, maximumQueued: 1 });
  const active = new AbortController(), queued = new AbortController(); let release;
  const first = scheduler.run('a', () => new Promise(resolve => { release = resolve; }), { signal: active.signal });
  await tick();
  const second = scheduler.run('b', () => { throw new Error('must not run'); }, { signal: queued.signal });
  await assert.rejects(scheduler.run('c', async () => null), { code: 'READ_QUEUE_FULL' });
  queued.abort('private reason'); await assert.rejects(second, error => error.code === 'READ_CANCELLED' && !error.message.includes('private'));
  active.abort(); assert.equal(scheduler.counts().running, 1);
  release(); await first; await tick(); assert.equal(scheduler.counts().running, 0);
});

test('an interactive read gets the next available slot without executing any queued mutation', async () => {
  const scheduler = createReadScheduler({ concurrency: 1 }); let release; const order = [];
  const first = scheduler.run('a', () => new Promise(resolve => { release = resolve; })); await tick();
  const background = scheduler.run('b', async () => order.push('background'), { priority: 'background' });
  const interactive = scheduler.run('c', async () => order.push('interactive'));
  release(); await Promise.all([first, background, interactive]); assert.deepEqual(order, ['interactive', 'background']);
});
