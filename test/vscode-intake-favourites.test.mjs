import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readWorkflowFavouriteRecord as read, writeWorkflowFavouriteRecord as write
} from '../apps/vscode/src/views/catalog-search.ts';

const logical = 'v2:repository-example';
const main = 'v2:main-clone';
const next = 'v2:another-branch-clone';
function storage(values = new Map()) {
  return { values, get: key => values.get(key), update: async (key, value) => { values.set(key, structuredClone(value)); } };
}

test('legacy favourites migrate without deleting old data or admitting invalid workflow IDs', async () => {
  const state = storage(new Map([['v1:base-checkout', ['feature', '../invalid', 'feature', 'team-test']]]));
  const record = read(state, [logical, main, 'v1:story-checkout', 'v1:base-checkout']);
  assert.deepEqual(record, { at: 0, ids: ['feature', 'team-test'] });
  await write(state, [logical, main], record);
  assert.deepEqual(read(storage(state.values), [logical, next]), record, 'a different clone shares only logical identity');
  assert.deepEqual(state.get('v1:base-checkout'), ['feature', '../invalid', 'feature', 'team-test']);
});

test('an explicit removal beats stale aliases and legacy favourites, including an empty list', async () => {
  const state = storage(new Map([[logical, { at: 10, ids: ['feature'] }], [main, { at: 11, ids: [] }],
    ['v1:checkout', ['feature']]]));
  const record = read(state, [logical, main, 'v1:checkout']);
  assert.deepEqual(record, { at: 11, ids: [] });
  await write(state, [logical, main], record);
  assert.deepEqual(read(storage(state.values), [logical, next]), record, 'restarting cannot resurrect the old star');
});

test('replacement panels see pending favourites and all writes retain click order', async () => {
  const state = storage(); const updates = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  state.update = async (key, value) => { updates.push([key, value.at]); await gate; state.values.set(key, structuredClone(value)); };
  const first = write(state, [logical, main], { at: 10, ids: ['feature'] });
  const second = write(state, [logical, next], { at: 11, ids: ['feature', 'team-test'] });
  assert.deepEqual(read(state, [logical, main]), { at: 11, ids: ['feature', 'team-test'] });
  await Promise.resolve(); release(); await Promise.all([first, second]);
  assert.deepEqual(updates, [[logical, 10], [main, 10], [logical, 11], [next, 11]]);
  assert.deepEqual(read(storage(state.values), [logical, next]), { at: 11, ids: ['feature', 'team-test'] });
});

test('a failed save clears its pending value and does not poison a later retry', async () => {
  const state = storage(new Map([[logical, { at: 10, ids: ['feature'] }]]));
  const update = state.update; state.update = async () => { throw new Error('fixture storage unavailable'); };
  await assert.rejects(write(state, [logical], { at: 11, ids: [] }), /fixture storage unavailable/);
  assert.deepEqual(read(state, [logical]), { at: 10, ids: ['feature'] });
  state.update = update;
  await write(state, [logical], { at: 12, ids: [] });
  assert.deepEqual(read(state, [logical]), { at: 12, ids: [] });
});

test('a cold-checkout edit wins when its logical identity arrives later', async () => {
  const state = storage(new Map([[logical, { at: 10, ids: ['feature'] }]]));
  await write(state, [next], { at: 11, ids: [] });
  const record = read(state, [logical, next]);
  await write(state, [logical, next], record);
  assert.deepEqual(read(storage(state.values), [logical, main]), { at: 11, ids: [] });
});

test('unrelated repositories and malformed preference records never supply favourites', () => {
  const state = storage(new Map([[logical, { at: 10, ids: ['feature'] }], ['bad', { at: -1, ids: ['feature'] }],
    ['bad-shape', { at: 12, ids: 'feature' }], ['bad-clock', { at: Infinity, ids: ['feature'] }]]));
  assert.equal(read(state, ['another-repository', 'bad', 'bad-shape', 'bad-clock']), null);
});
