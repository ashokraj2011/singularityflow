import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '../src/util.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import {
  clearHelpMetrics, helpMetricsStatus, recordHelpMetric, setHelpMetrics
} from '../src/help-metrics.mjs';
import {
  activeWorkspaceFile, workspaceMemberContextForRepository, workspaceRegistryFile
} from '../src/workspace-context.mjs';

const machine = await mkdtemp(path.join(os.tmpdir(), 'sflow-help-metrics-machine-'));
process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = path.join(machine, 'active.json');
process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = path.join(machine, 'registry.json');

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-help-metrics-'));
  run('git', ['init', '-q'], { cwd: root });
  return root;
}

/** A one-repository workspace whose member checkout matches its reviewed origin. */
async function workspaceFixture() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'sflow-help-workspace-'));
  const root = path.join(workspace, 'repos', 'application');
  await mkdir(root, { recursive: true });
  run('git', ['init', '-q'], { cwd: root });
  run('git', ['remote', 'add', 'origin', 'https://example.invalid/application.git'], {
    cwd: root
  });
  const manifest = {
    version: 1, id: 'help-workspace', name: 'Help workspace',
    anchor: { provider: 'workspace', key: 'help-workspace', title: 'Help workspace' },
    leadRepository: 'application',
    repositories: {
      application: {
        url: 'https://example.invalid/application.git', path: 'repos/application',
        defaultBranch: 'main'
      }
    }
  };
  await writeFile(path.join(workspace, 'workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { workspace, root, manifest };
}

/** Without a workspace path this writes the older selection record, which did not retain one. */
async function selectWorkspace(workspacePath, repositoryPath) {
  await writeFile(process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE, `${JSON.stringify({
    schemaVersion: currentSchemaVersion('active-workspace'),
    workspaceId: 'help-workspace', workspaceName: 'Help workspace',
    ...(workspacePath ? { workspacePath } : {}),
    repositoryId: 'application', repositoryPath, selectedAt: '2026-08-26T00:00:00.000Z'
  })}\n`);
}

const repositoryMetrics = async (root) => path.join(
  await realpath(root), '.git', 'singularity-flow', 'help-metrics'
);

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
    'latencyMs', 'answerBytes', 'actionCategory', 'command', 'commandClass',
    'modelInvocations', 'inputTokens', 'outputTokens'
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

test('participant command metrics record only bounded routing and zero-model accounting', async () => {
  const root = await repository();
  await recordHelpMetric(root, metric(7, {
    surface: 'participant', intent: 'command-discovery', topicId: 'status',
    matchedBy: 'declared-command', command: 'status', commandClass: 'deterministic',
    modelInvocations: 0, inputTokens: 0, outputTokens: 0
  }));
  const status = await helpMetricsStatus(root);
  assert.equal(status.surfaces.participant, 1);
  assert.equal(status.commands.status, 1);
  assert.equal(status.commandClasses.deterministic, 1);
  const [record] = (await readFile(status.logFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(record.modelInvocations, 0);
  assert.equal(record.inputTokens, 0);
  assert.equal(record.outputTokens, 0);
  assert.equal(Object.hasOwn(record, 'question'), false);
  assert.equal(Object.hasOwn(record, 'workId'), false);
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
  const { workspace, root } = await workspaceFixture();
  await selectWorkspace(workspace, root);
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

test('help metrics location: a repository no selected workspace claims keeps .git/singularity-flow/help-metrics', async () => {
  const root = await repository();
  const expected = await repositoryMetrics(root);
  const recorded = await recordHelpMetric(root, metric());
  assert.equal(recorded.scope, 'repository');
  assert.equal(recorded.directory, expected);
  assert.equal((await readFile(path.join(expected, 'events.jsonl'), 'utf8')).trim().split('\n').length, 1);

  // Selecting a workspace does not move help for a repository that workspace does not list.
  const { workspace, root: member } = await workspaceFixture();
  await selectWorkspace(workspace, member);
  try {
    const status = await helpMetricsStatus(root);
    assert.equal(status.scope, 'repository');
    assert.equal(status.logFile, path.join(expected, 'events.jsonl'));
    assert.equal(status.count, 1);
  } finally {
    await rm(process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE, { force: true });
  }
});

test('help metrics location: a member uses the selected workspace path, and a refused manifest falls back to .git', async () => {
  const { workspace, root, manifest } = await workspaceFixture();
  // The directory is spelled from the stored selection, not from the manifest's resolved path, so
  // a workspace selected through a symbolic link keeps that spelling.
  const alias = `${workspace}-alias`;
  await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await selectWorkspace(alias, root);
  try {
    const recorded = await recordHelpMetric(root, metric());
    assert.equal(recorded.scope, 'workspace');
    assert.equal(recorded.directory, path.join(alias, '.singularity-flow', 'help-metrics'));
    assert.equal((await helpMetricsStatus(root)).count, 1);

    // Membership still rests on readWorkspace's validation: a manifest it refuses proves nothing,
    // so best-effort metrics go back to the repository instead of the workspace.
    await writeFile(path.join(workspace, 'workspace.json'), `${JSON.stringify({
      ...manifest,
      repositories: {
        application: {
          ...manifest.repositories.application,
          url: 'https://user:secret@example.invalid/application.git'
        }
      }
    }, null, 2)}\n`);
    const fallback = await helpMetricsStatus(root);
    assert.equal(fallback.scope, 'repository');
    assert.equal(fallback.logFile, path.join(await repositoryMetrics(root), 'events.jsonl'));
    assert.equal(fallback.count, 0);
  } finally {
    await rm(process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE, { force: true });
  }
});

test('help metrics location: an older selection without a workspace path keeps help in .git', async () => {
  const { root } = await workspaceFixture();
  const unrelated = await repository();
  await selectWorkspace(null, root);
  try {
    // The best-effort lookup still resolves the selected checkout for navigation, but that context
    // names no workspace directory to aggregate under.
    const navigation = await workspaceMemberContextForRepository(
      root, activeWorkspaceFile(), workspaceRegistryFile()
    );
    assert.equal(navigation?.repositoryId, 'application', 'the older selection still resolves its checkout');
    assert.equal(navigation.workspacePath, null);

    const expected = await repositoryMetrics(root);
    const recorded = await recordHelpMetric(root, metric());
    assert.equal(recorded.scope, 'repository');
    assert.equal(recorded.directory, expected);
    const status = await helpMetricsStatus(root);
    assert.equal(status.scope, 'repository');
    assert.equal(status.logFile, path.join(expected, 'events.jsonl'));
    assert.equal(status.count, 1);
    assert.equal((await setHelpMetrics(root, false)).enabled, false);
    assert.equal((await clearHelpMetrics(root)).removed, 1);

    // A repository the older selection does not name gets no context and stays repository-local.
    assert.equal(await workspaceMemberContextForRepository(
      unrelated, activeWorkspaceFile(), workspaceRegistryFile()
    ), null);
    const other = await recordHelpMetric(unrelated, metric());
    assert.equal(other.scope, 'repository');
    assert.equal(other.directory, await repositoryMetrics(unrelated));
    assert.equal((await helpMetricsStatus(unrelated)).count, 1);
  } finally {
    await rm(process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE, { force: true });
  }
});
