import test from 'node:test';
import assert from 'node:assert/strict';

import { inReadScope, scopedRead, scopedReadSync, withReadScope } from '../src/read-scope.mjs';

test('overlapping read requests never share or clear each other memo state', async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let firstCalls = 0;
  let secondCalls = 0;

  const first = withReadScope(async () => {
    const pending = scopedRead('same-key', async () => {
      firstCalls += 1;
      await firstGate;
      return 'first';
    });
    await Promise.resolve();
    assert.equal(inReadScope(), true);
    assert.equal(await pending, 'first');
    assert.equal(await scopedRead('same-key', () => 'wrong'), 'first');
  });

  const second = withReadScope(async () => {
    assert.equal(await scopedRead('same-key', async () => {
      secondCalls += 1;
      return 'second';
    }), 'second');
    assert.equal(scopedReadSync('falsy', () => false), false);
    assert.equal(scopedReadSync('falsy', () => true), false);
  });

  await second;
  assert.equal(inReadScope(), false, 'a completed sibling scope is not visible to its caller');
  releaseFirst();
  await first;
  assert.deepEqual({ firstCalls, secondCalls }, { firstCalls: 1, secondCalls: 1 });
});

test('nested scopes share only their request-local outer memo', async () => {
  let calls = 0;
  await withReadScope(async () => {
    assert.equal(await scopedRead('nested', () => ++calls), 1);
    await withReadScope(async () => {
      assert.equal(await scopedRead('nested', () => ++calls), 1);
    });
  });
  assert.equal(calls, 1);
  assert.equal(inReadScope(), false);
});

test('a rejected scope is disposed without disturbing another live request', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const live = withReadScope(async () => {
    await scopedRead('live', async () => { await gate; return 'retained'; });
    return scopedRead('live', () => 'wrong');
  });
  await assert.rejects(
    withReadScope(async () => {
      await scopedRead('failed', () => 'cached');
      throw new Error('stop this request');
    }),
    /stop this request/
  );
  release();
  assert.equal(await live, 'retained');
  assert.equal(inReadScope(), false);
});

test('unscoped writes are visible to the next read scope', async () => {
  let value = 'before';
  assert.equal(await withReadScope(() => scopedRead('value', () => value)), 'before');
  value = 'after';
  assert.equal(await withReadScope(() => scopedRead('value', () => value)), 'after');
});
