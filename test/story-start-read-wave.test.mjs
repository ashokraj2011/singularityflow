import assert from 'node:assert/strict';
import test from 'node:test';
import { settleStoryStartReadWave } from '../src/story-start-read-wave.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('Story destination and explicitly requested tracker reads overlap and both settle', async () => {
  const destination = deferred();
  const source = deferred();
  const entered = [];
  let finished = false;
  const wave = settleStoryStartReadWave(
    () => { entered.push('destination'); return destination.promise; },
    () => { entered.push('source'); return source.promise; }
  ).then((value) => { finished = true; return value; });
  await Promise.resolve();
  assert.deepEqual(entered, ['destination', 'source']);
  destination.resolve({ approved: true });
  await Promise.resolve();
  assert.equal(finished, false, 'a running source owner must not outlive command refusal/cleanup');
  source.resolve({ stableId: 'tracker:7' });
  assert.deepEqual(await wave, { approved: true });
});

test('overlapped read failures retain destination-first refusal and wait for the other owner', async () => {
  const source = deferred();
  const destinationError = new Error('destination access refused');
  const trackerError = new Error('tracker unavailable');
  let finished = false;
  const wave = settleStoryStartReadWave(
    () => { throw destinationError; }, () => source.promise
  );
  wave.catch(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  source.reject(trackerError);
  await assert.rejects(wave, (error) => error === destinationError);
});

test('a tracker failure is not relayed ahead of its original source-consumption checkpoint', async () => {
  const trackerError = new Error('tracker unavailable');
  const tracker = Promise.reject(trackerError);
  const destination = await settleStoryStartReadWave(
    () => ({ refs: 'verified' }), () => tracker
  );
  assert.deepEqual(destination, { refs: 'verified' });
  await assert.rejects(tracker, (error) => error === trackerError);
});
