import assert from 'node:assert/strict';
import test from 'node:test';
import { isCliReadSuperseded } from '../apps/vscode/src/cli/client.ts';
import { WorkspaceStore } from '../apps/vscode/src/state.ts';
import { discoverWorkspaceStoryRows } from '../apps/vscode/src/story-discovery.ts';

const superseded = () => Object.assign(new Error('The Singularity Flow read was superseded.'), {
  code: 'CLI_READ_SUPERSEDED'
});

test('read cancellation requires its stable code, not an error message resemblance', () => {
  assert.equal(isCliReadSuperseded(superseded()), true);
  assert.equal(isCliReadSuperseded(new Error('The Singularity Flow read was superseded.')), false);
  assert.equal(isCliReadSuperseded(null), false);
});

test('a superseded Store snapshot never publishes an error, recovery snapshot or cache write', async () => {
  let recoveryReads = 0;
  let cacheWrites = 0;
  const cached = { workItems: [], initiatives: [], marker: 'previous-context' };
  const store = new WorkspaceStore({
    async snapshot() { throw superseded(); },
    async configurationSnapshot() { recoveryReads += 1; return { workItems: [], marker: 'recovery' }; }
  }, { read: () => cached, write: () => { cacheWrites += 1; } });
  store.primeFromCache();
  const changes = [];
  store.onDidChange((state, change) => changes.push({ state, change }));
  await store.refresh();
  assert.equal(recoveryReads, 0);
  assert.equal(cacheWrites, 0);
  assert.equal(store.current.snapshot.marker, 'previous-context');
  assert.equal(store.current.error, null);
  assert.equal(store.current.loading, false);
  assert.ok(changes.every(({ state, change }) => state.error === null && change.kind !== 'error'));
  store.dispose();
});

test('superseded recovery is cancellation too, not a publish of the original context failure', async () => {
  const store = new WorkspaceStore({
    async snapshot() { throw new Error('a real failure in the old repository'); },
    async configurationSnapshot() { throw superseded(); }
  });
  const events = [];
  store.onDidChange((_state, change) => events.push(change.kind));
  await store.refresh();
  assert.equal(store.current.error, null);
  assert.equal(store.current.loading, false);
  assert.equal(events.includes('error'), false);
  store.dispose();
});

test('Story discovery propagates a superseded read without rendering a needs-attention issue', async () => {
  const cancellation = superseded();
  await assert.rejects(discoverWorkspaceStoryRows([
    { id: 'alpha', absolutePath: '/fixture/repos/alpha', state: 'ready' },
    { id: 'beta', absolutePath: '/fixture/repos/beta', state: 'ready' }
  ], async (repository) => {
    if (repository.id === 'beta') throw cancellation;
    return { items: [{ id: 'STORY-1' }] };
  }), (error) => error === cancellation);
});
