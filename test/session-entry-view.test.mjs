/**
 * The session entry every Story skill turn runs first (owner decision, 2026-11-10): it fits whole, with the binding in
 * view, because its execution context and task resume keep only what a turn reads. The rest stays in the kept result.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { boundedAgentOutput, SESSION_ENTRY_VIEW, sessionEntryForAgent } from '../src/agent-output.mjs';

const route = { command: 'singularity-flow phase enter specification --work-id W-1 --compose --for-agent --json', executable: 'singularity-flow',
  argv: ['phase', 'enter'], copyable: true, platformCommands: { darwin: 'x', linux: 'x', win32: 'x' }, skill: '/sf-phase', copilotCommand: '/sf-phase', modelFreeCommand: null };
const entry = {
  schemaVersion: 1, resultType: 'sflow-session-entry', ready: true, workId: 'W-1', repositoryPath: '/work/app',
  executionContext: { schemaVersion: 1, resultType: 'execution-context', contextId: 'ctx-1', workspace: null,
    repository: { id: 'app', root: '/work/app' }, clone: { path: '/work/app' }, worktree: { path: '/work/app', branch: 'delivery/w-1' },
    story: { id: 'W-1', phase: 'specification', status: 'in_progress', revision: { sha: 'a'.repeat(40) },
      repositoryBindings: [{ repository: 'app', ref: 'delivery/w-1' }],
      configurationPin: { source: 'sflow/config', commit: 'b'.repeat(40), assetCount: 169 },
      binding: { storyRef: 'delivery/w-1', baseRef: 'main' } },
    observation: { at: '2026-11-10T00:00:00.000Z' } },
  taskResume: { schemaVersion: 1, operationId: 'WT-1', role: 'author', generation: 1, state: 'load-context', complete: false, resumed: true,
    inputChanged: false, authority: 'progress-only', nextAction: route, handoff: { ...route, transfers: 'progress-metadata-only' },
    checkpoints: ['prepared'], remaining: ['author'], continuationBudget: { consumed: 0, maximum: 3 }, repairConsumed: 0,
    repairConditions: { observed: 0 }, instruction: 'Resume from fresh kernel facts.' }
};

test('what a skill turn reads from the session entry is pinned', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(SESSION_ENTRY_VIEW)), {
    executionContext: ['contextId', 'story'],
    story: ['id', 'phase', 'status', 'binding', 'configurationPin'],
    taskResume: ['operationId', 'role', 'generation', 'state', 'complete', 'resumed', 'inputChanged', 'authority', 'error',
      'nextAction', 'handoff', 'checkpoints', 'remaining', 'continuationBudget', 'repairConsumed', 'repairConditions'],
    route: ['command', 'copilotCommand', 'modelFreeCommand']
  });
  const view = sessionEntryForAgent(entry);
  assert.deepEqual(view.executionContext, { contextId: 'ctx-1', story: { id: 'W-1', phase: 'specification', status: 'in_progress',
    binding: entry.executionContext.story.binding, configurationPin: entry.executionContext.story.configurationPin } });
  assert.deepEqual(view.taskResume.nextAction, { command: route.command, copilotCommand: '/sf-phase', modelFreeCommand: null });
  assert.equal(view.taskResume.operationId, 'WT-1');
  assert.deepEqual(view.taskResume.continuationBudget, { consumed: 0, maximum: 3 });
  assert.equal(view.taskResume.instruction, undefined);
  // Everything else about the entry is as it was, and the entry itself is not changed.
  assert.equal(view.repositoryPath, '/work/app');
  assert.equal(entry.executionContext.worktree.branch, 'delivery/w-1');
});

test('the agent view of the entry is whole: nothing moved out, the binding in view', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-session-entry-view-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const view = JSON.parse(await boundedAgentOutput(JSON.stringify(entry), { cwd: root }));
  assert.equal(view.agentOutput, undefined);
  assert.deepEqual(view.executionContext.story.binding, { storyRef: 'delivery/w-1', baseRef: 'main' });
  assert.equal(view.executionContext.worktree, undefined);
  // Other results are not trimmed.
  const other = JSON.parse(await boundedAgentOutput(JSON.stringify({ ...entry, resultType: 'session-open' }), { cwd: root }));
  assert.equal(other.executionContext.worktree.branch, 'delivery/w-1');
});
