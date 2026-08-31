import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '../src/util.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import {
  clearHelpMetrics, helpMetricsStatus, recordHelpMetric, setHelpMetrics
} from '../src/help-metrics.mjs';

const machine = await mkdtemp(path.join(os.tmpdir(), 'sflow-help-metrics-machine-'));
process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = path.join(machine, 'active.json');
process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = path.join(machine, 'registry.json');

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-help-metrics-'));
  run('git', ['init', '-q'], { cwd: root });
  return root;
}

const metric = (index = 0, overrides = {}) => ({
  surface: 'chat', intent: 'concept', outcome: 'resolved', topicId: 'project-binding',
  matchedBy: 'authored-question', latencyMs: index, answerBytes: 512,
  actionCategory: null, ...overrides
});

test('concurrent help metrics are append-locked, schema-stamped, and content-free', async () => {
  const root = await repository();
  await Promise.all(Array.from({ length: 24 }, (_, index) => recordHelpMetric(root, metric(index))));
  const status = await helpMetricsStatus(root);
  assert.equal(status.enabled, true);
  assert.equal(status.count, 24);
  assert.equal(status.outcomes.resolved, 24);
  assert.equal(status.topics['project-binding'], 24);
  const lines = (await readFile(status.logFile, 'utf8')).trim().split('\n').map(JSON.parse);
  const allowed = [
    'schemaVersion', 'timestamp', 'surface', 'intent', 'outcome', 'topicId', 'matchedBy',
    'latencyMs', 'answerBytes', 'actionCategory'
  ].sort();
  for (const record of lines) {
    assert.equal(record.schemaVersion, currentSchemaVersion('help-metrics-event'));
    assert.equal(record.surface, 'chat');
    assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(Object.keys(record).sort(), allowed);
    for (const forbidden of ['question', 'answer', 'path', 'workId', 'identity', 'prompt', 'content']) {
      assert.equal(Object.hasOwn(record, forbidden), false, forbidden);
    }
  }
});

test('raw questions and unreviewed fields are rejected before append', async () => {
  const root = await repository();
  await assert.rejects(recordHelpMetric(root, { ...metric(), question: 'raw text must not persist' }),
    /refuses unrecognized field 'question'/);
  assert.equal((await helpMetricsStatus(root)).count, 0);
});

test('metrics can be disabled, re-enabled, retained, and atomically cleared', async () => {
  const root = await repository();
  await setHelpMetrics(root, false);
  const skipped = await recordHelpMetric(root, metric());
  assert.equal(skipped.recorded, false);
  await setHelpMetrics(root, true);
  await recordHelpMetric(root, metric(1, { outcome: 'ambiguous', intent: 'compare', topicId: null }), {
    now: new Date('2025-01-01T00:00:00.000Z')
  });
  await recordHelpMetric(root, metric(2, { outcome: 'no-match', intent: 'compare', topicId: null }), {
    now: new Date('2026-08-26T00:00:00.000Z')
  });
  const retained = await helpMetricsStatus(root);
  assert.equal(retained.count, 1, 'expired records are pruned');
  assert.equal(retained.unresolvedIntents.compare, 1);
  assert.equal(retained.noMatchIntents.compare, 1);
  assert.equal(retained.ambiguousIntents.compare, undefined);
  const cleared = await clearHelpMetrics(root);
  assert.equal(cleared.removed, 1);
  assert.equal(cleared.count, 0);
});

test('a selected workspace aggregates repository help under the workspace directory', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'sflow-help-workspace-'));
  const root = path.join(workspace, 'repos', 'application');
  await mkdir(root, { recursive: true });
  run('git', ['init', '-q'], { cwd: root });
  run('git', ['remote', 'add', 'origin', 'https://example.invalid/application.git'], {
    cwd: root
  });
  await writeFile(path.join(workspace, 'workspace.json'), `${JSON.stringify({
    version: 1, id: 'help-workspace', name: 'Help workspace',
    anchor: { provider: 'workspace', key: 'help-workspace', title: 'Help workspace' },
    leadRepository: 'application',
    repositories: {
      application: {
        url: 'https://example.invalid/application.git', path: 'repos/application',
        defaultBranch: 'main'
      }
    }
  }, null, 2)}\n`);
  await writeFile(process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE, `${JSON.stringify({
    schemaVersion: currentSchemaVersion('active-workspace'),
    workspaceId: 'help-workspace', workspaceName: 'Help workspace', workspacePath: workspace,
    repositoryId: 'application', repositoryPath: root, selectedAt: '2026-08-26T00:00:00.000Z'
  })}\n`);
  try {
    await recordHelpMetric(root, metric());
    const status = await helpMetricsStatus(root);
    assert.equal(status.scope, 'workspace');
    assert.equal(status.logFile, path.join(workspace, '.singularity-flow', 'help-metrics', 'events.jsonl'));
    assert.equal(status.count, 1);
  } finally {
    await rm(process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE, { force: true });
  }
});
