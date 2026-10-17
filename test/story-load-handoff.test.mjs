import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createWarmReadFixture } from '../scripts/warm-read-fixture.mjs';
import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { verifyStoryCatalogAmendments } from '../src/story-execution-context.mjs';
import { withCommandTiming } from '../src/dx-timing-context.mjs';

for (const storyMode of ['legacy', 'pinned', 'amended']) {
  test(`${storyMode} strict execution loads validate once and never share a later load`, async t => {
    const f = await createWarmReadFixture({ storyMode }); t.after(f.cleanup);
    const before = await readFile(f.statePath);
    const counters = {};
    const timer = { increment(key, amount = 1) { counters[key] = (counters[key] ?? 0) + amount; },
      measure(_key, action) { return action(); } };
    await withCommandTiming(timer, async () => {
      const first = await loadAcceptedStoryExecution(f.repository, f.workId);
      const expected = storyMode === 'legacy' ? 0 : 1;
      assert.equal(counters['story.snapshot-verifications'] ?? 0, expected);
      if (storyMode === 'amended') assert.equal(counters['story.context-catalog-handoffs'], 1);
      first.workflow.workItem.title = 'caller-local';
      const second = await loadAcceptedStoryExecution(f.repository, f.workId);
      assert.notEqual(first.workflow, second.workflow);
      assert.notEqual(second.workflow.workItem.title, 'caller-local');
      assert.equal(counters['story.snapshot-verifications'] ?? 0, expected * 2);
      if (storyMode !== 'legacy') {
        assert.notEqual(first.executionCatalog, second.executionCatalog);
        assert.equal(second.definition, second.executionCatalog.effectiveDefinition);
      }
    });
    assert.deepEqual(await readFile(f.statePath), before, 'a context handoff never writes Story state');
  });
}

test('catalog handoff rejects forged/cross-repository capabilities and still checks phase baselines', async t => {
  const f = await createWarmReadFixture({ storyMode: 'amended' }); t.after(f.cleanup);
  const context = await loadAcceptedStoryExecution(f.repository, f.workId);
  const check = (root, workflow, catalog) => verifyStoryCatalogAmendments(root, context.definition, workflow, catalog);
  await assert.rejects(check(f.repository, context.workflow, { ...context.executionCatalog }),
    { code: 'WFA_SNAPSHOT_INVALID' });
  await assert.rejects(check(`${f.repository}-other`, context.workflow, context.executionCatalog),
    { code: 'WFA_SNAPSHOT_INVALID' });
  const changed = structuredClone(context.workflow);
  delete changed.phases[f.phaseId].skillAmendmentRevalidation;
  await assert.rejects(check(f.repository, changed, context.executionCatalog),
    { code: 'SKP_AMENDMENT_REVALIDATION_INVALID' });
});

test('a new strict execution load cannot conceal changed resolution or committed revalidation markers', async t => {
  const f = await createWarmReadFixture({ storyMode: 'amended' }); t.after(f.cleanup);
  await loadAcceptedStoryExecution(f.repository, f.workId);
  const original = await readFile(f.statePath);
  const changed = JSON.parse(original);
  changed.resolution.sequenceGates = { forged: true };
  await writeFile(f.statePath, JSON.stringify(changed));
  await assert.rejects(loadAcceptedStoryExecution(f.repository, f.workId));
  const markerChanged = JSON.parse(original);
  delete markerChanged.phases[f.phaseId].skillAmendmentRevalidation;
  await writeFile(f.statePath, JSON.stringify(markerChanged));
  f.git(['add', '.']); f.git(['commit', '-qm', 'Attempt to erase an accepted baseline']);
  await assert.rejects(loadAcceptedStoryExecution(f.repository, f.workId),
    { code: 'SKP_AMENDMENT_REVALIDATION_INVALID' });
});

test('stress fixture Git cannot launch detached maintenance or change its measured environment', async t => {
  const f = await createWarmReadFixture({ historyCommits: 120, artifacts: 8 }); t.after(f.cleanup);
  assert.equal(f.totalCommits, 122);
  assert.equal(f.env.GIT_CONFIG_COUNT, process.env.GIT_CONFIG_COUNT);
  f.git(['config', 'maintenance.auto', 'true']);
  f.git(['config', 'gc.auto', '1']);
  assert.equal(f.git(['config', 'maintenance.auto']), 'false');
  assert.equal(f.git(['config', 'gc.auto']), '0');
  assert.equal(f.git(['config', '--local', 'maintenance.auto']), 'true', 'repository configuration stays unchanged');
  assert.equal(f.git(['config', '--local', 'gc.auto']), '1');
  assert.equal(f.git(['fsck', '--no-dangling']), '');
});
