import assert from 'node:assert/strict';
import test from 'node:test';

import { RetainedPanelRenderGate } from '../apps/vscode/src/single-flight.ts';
import { WorkspaceStore, changedSnapshotSlices } from '../apps/vscode/src/state.ts';
import {
  RevisionSliceWatcherFence, governedPathCandidateSlices
} from '../apps/vscode/src/watcher-refresh-fence.ts';

const root = '/workspace/repository';
const snapshot = (subject, slices) => ({
  workItems: [], initiatives: [], included: Object.keys(slices),
  revision: {
    branch: 'main', head: `head-${subject}`, worktreeHash: `worktree-${subject}`,
    subjectRevision: subject, slices
  }
});

test('slice diffing is exact when coordinator slice hashes are available', () => {
  const before = snapshot('before', { repository: 'r1', lifecycle: 'l1', configuration: 'c1' });
  const after = snapshot('after', { repository: 'r2', lifecycle: 'l2', configuration: 'c1' });
  assert.deepEqual(changedSnapshotSlices(before, after), ['repository', 'lifecycle']);
  assert.deepEqual(governedPathCandidateSlices(root,
    `${root}/singularity/work-items/WRK-1/state.json`), ['lifecycle', 'repository']);
  assert.deepEqual(governedPathCandidateSlices(root,
    `${root}/singularity/workflow.yml`), ['configuration', 'repository']);
});

test('one explicit mutation plus its exact watcher echo produces one snapshot and one relevant render', async () => {
  const before = snapshot('before', { repository: 'r1', lifecycle: 'l1', capabilities: 'p1' });
  const after = snapshot('after', { repository: 'r2', lifecycle: 'l2', capabilities: 'p1' });
  const answers = [before, after];
  let snapshots = 0;
  const store = new WorkspaceStore({
    async snapshot() { snapshots += 1; return answers.shift() ?? after; },
    async configurationSnapshot() { throw new Error('not expected'); }
  });
  await store.refresh();

  let renders = 0;
  const renderGate = new RetainedPanelRenderGate(() => true, () => { renders += 1; }, ['lifecycle']);
  store.onDidChange((_state, change) => renderGate.changed(change.kind, change.changedSlices));
  const fence = new RevisionSliceWatcherFence(() => root);
  fence.observe(`${root}/singularity/work-items/WRK-1/state.json`);
  const result = await fence.reconcileExplicitRefresh(
    () => store.current.snapshot,
    () => store.refresh()
  );

  assert.equal(result.suppressedWatcherEcho, true);
  assert.deepEqual(result.changedSlices, ['repository', 'lifecycle']);
  assert.equal(fence.hasPending, false, 'the exact already-incorporated echo is consumed');
  assert.equal(snapshots, 2, 'initial read plus exactly one mutation refresh; no watcher duplicate');
  assert.equal(renders, 1, 'loading is ignored and the relevant snapshot renders once');
});

test('a delayed exact watcher echo uses one lightweight revision probe and no second full refresh', async () => {
  const before = snapshot('before', { repository: 'r1', lifecycle: 'l1' });
  const after = snapshot('after', { repository: 'r2', lifecycle: 'l2' });
  const answers = [before, after];
  let snapshots = 0;
  const store = new WorkspaceStore({
    async snapshot() { snapshots += 1; return answers.shift() ?? after; },
    async configurationSnapshot() { throw new Error('not expected'); }
  });
  await store.refresh();
  let renders = 0;
  const gate = new RetainedPanelRenderGate(() => true, () => { renders += 1; }, ['lifecycle']);
  store.onDidChange((_state, change) => gate.changed(change.kind, change.changedSlices));
  const fence = new RevisionSliceWatcherFence(() => root);

  await fence.reconcileExplicitRefresh(() => store.current.snapshot, () => store.refresh());
  fence.observe(`${root}/singularity/work-items/WRK-LATE/state.json`);
  const delayed = fence.capture();
  let probes = 0;
  const suppressed = await fence.matchesDelayedEcho(delayed, async () => {
    probes += 1;
    return structuredClone(after.revision);
  });

  assert.equal(suppressed, true);
  assert.equal(probes, 1);
  assert.equal(snapshots, 2, 'the late echo did not purchase a second complete snapshot');
  assert.equal(renders, 1, 'a revision probe never publishes a second panel render');
});

test('a concurrent external write in the same slice fails the exact probe and performs a full refresh', async () => {
  const before = snapshot('before', { repository: 'r1', lifecycle: 'l1' });
  const afterMutation = snapshot('mutation', { repository: 'r2', lifecycle: 'l2' });
  const afterExternal = snapshot('external', { repository: 'r3', lifecycle: 'l3' });
  const answers = [before, afterMutation, afterExternal];
  let snapshots = 0;
  const store = new WorkspaceStore({
    async snapshot() { snapshots += 1; return answers.shift() ?? afterExternal; },
    async configurationSnapshot() { throw new Error('not expected'); }
  });
  await store.refresh();
  let renders = 0;
  const gate = new RetainedPanelRenderGate(() => true, () => { renders += 1; }, ['lifecycle']);
  store.onDidChange((_state, change) => gate.changed(change.kind, change.changedSlices));
  const fence = new RevisionSliceWatcherFence(() => root);
  await fence.reconcileExplicitRefresh(() => store.current.snapshot, () => store.refresh());

  fence.observe(`${root}/singularity/work-items/WRK-LATE/state.json`);
  const delayed = fence.capture();
  const suppressed = await fence.matchesDelayedEcho(delayed, async () => afterExternal.revision);
  assert.equal(suppressed, false, 'same path and slice are insufficient when repository bytes moved');
  await store.refresh();
  assert.equal(snapshots, 3, 'the external change receives the complete coherent snapshot');
  assert.equal(renders, 2, 'the external lifecycle revision renders once after the mutation render');
});

test('a mismatched slice or later event remains pending and performs a watcher refresh', async () => {
  const before = snapshot('before', { repository: 'r1', lifecycle: 'l1', configuration: 'c1' });
  const lifecycleOnly = snapshot('phase', { repository: 'r2', lifecycle: 'l2', configuration: 'c1' });
  const configurationLater = snapshot('config', { repository: 'r3', lifecycle: 'l2', configuration: 'c2' });
  const answers = [before, lifecycleOnly, configurationLater];
  let snapshots = 0;
  const store = new WorkspaceStore({
    async snapshot() { snapshots += 1; return answers.shift() ?? configurationLater; },
    async configurationSnapshot() { throw new Error('not expected'); }
  });
  await store.refresh();
  let configurationRenders = 0;
  const renderGate = new RetainedPanelRenderGate(
    () => true, () => { configurationRenders += 1; }, ['configuration']
  );
  store.onDidChange((_state, change) => renderGate.changed(change.kind, change.changedSlices));

  const fence = new RevisionSliceWatcherFence(() => root);
  fence.observe(`${root}/singularity/workflow.yml`);
  const result = await fence.reconcileExplicitRefresh(
    () => store.current.snapshot,
    () => store.refresh()
  );
  assert.equal(result.suppressedWatcherEcho, false, 'a configuration event is not hidden by lifecycle movement');
  assert.equal(fence.hasPending, true);
  fence.capture();
  await store.refresh();

  assert.equal(snapshots, 3, 'the mismatched event receives its own coherent snapshot');
  assert.equal(configurationRenders, 1, 'only the later relevant slice refresh renders Configuration');

  fence.observe(`${root}/singularity/work-items/WRK-2/state.json`);
  const late = fence.capture();
  assert.equal(fence.matchesExplicitRefresh(late, configurationLater, configurationLater), false,
    'an unchanged revision can never suppress a later event');
});
