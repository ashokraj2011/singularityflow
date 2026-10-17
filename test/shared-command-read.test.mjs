import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createWarmReadFixture } from '../scripts/warm-read-fixture.mjs';
import { withCommandReadScope, withReadScope, withFreshReadScope, withoutReadScope } from '../src/read-scope.mjs';
import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { loadDefinition } from '../src/config.mjs';
import { withCommandTiming } from '../src/dx-timing-context.mjs';
import { withConfigurationReadRoot } from '../src/configuration-read-scope.mjs';

function accounting(counters) {
  return { increment(key, amount = 1) { counters[key] = (counters[key] ?? 0) + amount; },
    measure(key, fn) { return fn(); } };
}

test('one read context shares source parsing and accepted resolution, not mutable Story objects', async t => {
  const f = await createWarmReadFixture(); t.after(f.cleanup);
  const counters = {};
  await withCommandTiming(accounting(counters), () => withCommandReadScope(async () => {
    const [one, two] = await Promise.all([loadAcceptedStoryExecution(f.repository, 'PERF-001'),
      loadAcceptedStoryExecution(f.repository, 'PERF-001')]);
    assert.notEqual(one.workflow, two.workflow);
    one.workflow.workItem.title = 'caller-local';
    assert.equal(two.workflow.workItem.title, 'Read fixture');
    const bootstrap = await loadDefinition(f.repository, { storyBootstrap: true });
    const current = await loadDefinition(f.repository);
    assert.notEqual(bootstrap, current);
    assert.equal(bootstrap.agentCatalog.length, 0);
    assert.ok(current.agentCatalog.length > 0, 'current validation still discovers governed agents');
  }));
  assert.equal(counters['story.context-load'], 1);
  assert.equal(counters['story.context-requests'], 2);
  assert.equal(counters['configuration.source-read'], 1);
  assert.equal(counters['configuration.yaml-parse'], 1);
  assert.equal(counters['configuration.definition-load'], 2, 'bootstrap and strict policy remain distinct');
  const normal = {};
  await withCommandTiming(accounting(normal), () => withReadScope(async () => {
    await loadAcceptedStoryExecution(f.repository); await loadAcceptedStoryExecution(f.repository);
  }));
  assert.equal(normal['story.context-load'], 2, 'ordinary scopes, including writer internals, cannot reuse the accepted context');
});

test('fresh/bypassed reads see edits; configuration overlays cannot share source bytes', async t => {
  const f = await createWarmReadFixture(), other = await createWarmReadFixture();
  t.after(f.cleanup); t.after(other.cleanup);
  const file = path.join(f.repository, 'singularity/workflow.yml');
  const original = await readFile(file, 'utf8');
  await withCommandReadScope(async () => {
    assert.equal((await loadAcceptedStoryExecution(f.repository)).workflow.workItem.title, 'Read fixture');
    await writeFile(f.statePath, JSON.stringify({ ...f.state, workItem: { ...f.state.workItem, title: 'Fresh title' } }));
    assert.equal((await withFreshReadScope(() => loadAcceptedStoryExecution(f.repository))).workflow.workItem.title, 'Fresh title');
    assert.equal((await loadDefinition(f.repository)).workTypes.chore.label, 'Chore');
    await writeFile(file, original.replace('label: Chore', 'label: Edited'));
    assert.equal((await withFreshReadScope(() => loadDefinition(f.repository))).workTypes.chore.label, 'Edited');
    assert.equal((await withoutReadScope(() => loadDefinition(f.repository))).workTypes.chore.label, 'Edited');
    const overlayFile = path.join(other.repository, 'singularity/workflow.yml');
    await writeFile(overlayFile, original.replace('label: Chore', 'label: Overlay'));
    const overlay = await withConfigurationReadRoot(f.repository, other.repository, null, () => loadDefinition(f.repository));
    assert.equal(overlay.workTypes.chore.label, 'Overlay');
  });
  assert.equal((await loadDefinition(f.repository)).workTypes.chore.label, 'Edited');
});

test('shared parse never upgrades bootstrap validation or hides malformed sources', async t => {
  const f = await createWarmReadFixture(); t.after(f.cleanup);
  await mkdir(path.join(f.repository, '.github/agents'), { recursive: true });
  await writeFile(path.join(f.repository, '.github/agents/broken.agent.md'), 'not valid agent frontmatter');
  await withCommandReadScope(async () => {
    await loadDefinition(f.repository, { storyBootstrap: true });
    await assert.rejects(loadDefinition(f.repository), /frontmatter|description|name|agent/i);
  });
  const file = path.join(f.repository, 'singularity/workflow.yml');
  await writeFile(file, 'version: [invalid\n');
  await withCommandReadScope(async () => {
    await assert.rejects(loadDefinition(f.repository, { storyBootstrap: true }));
    await assert.rejects(loadDefinition(f.repository));
  });
});
