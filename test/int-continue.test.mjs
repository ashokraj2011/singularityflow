/**
 * Continuation is reconstructed, never remembered. `[INT:AC-008]` `[INT:AC-009]` `[INT:CON-062]` `[INT:CON-063]`
 *
 * Part of the P1 release gate `[INT:CON-160]`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createGatewayKernel } from '../src/gateway/kernel.mjs';
import { createHostGateway } from '../src/gateway/host.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { run } from '../src/util.mjs';

const ACTOR = { login: 'dev-1', email: 'dev@example.test', name: 'Dev' };

async function governedRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-continue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.email', ACTOR.email], { cwd: root });
  run('git', ['config', 'user.name', ACTOR.name], { cwd: root });
  const directory = path.join(root, 'singularity', 'work-items', 'WRK-123');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'workflow.json'), JSON.stringify({
    workItem: { id: 'WRK-123', title: 'Address validation', workType: 'feature', branch: 'main' },
    phaseOrder: ['design', 'implementation'], currentPhase: 'implementation',
    phases: { implementation: { status: 'in_progress', generation: 2, label: 'Implementation' } },
    history: [{ event: 'work_started', phase: 'implementation', actor: ACTOR, at: '2026-10-20T10:00:00.000Z' }]
  }));
  await writeFile(path.join(root, 'checkout.mjs'), 'export const postal = true;\n');
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-q', '-m', 'governed work'], { cwd: root });
  return root;
}

const continueIn = async (kernel) => {
  const resolved = await kernel.resolve({ utterance: 'pick up where I left off', arguments: { workId: 'WRK-123' } });
  return kernel.read({ resolutionId: resolved.next[0].handle });
};

test('conversation-is-not-state', async (t) => {
  const root = await governedRepository(t);
  const session = (hostSessionId) => createHostGateway({ root, hostSessionId, planners: gatewayPlanners(), plannerContext: { actor: ACTOR } });
  const before = await continueIn(session('vscode-before-reload').kernel);
  // The first session is gone — its handles, its memory, its conversation. A new one starts cold.
  const after = await continueIn(session('vscode-after-reload').kernel);
  const shape = (result) => ({
    work: result.data.work.id, phase: result.data.work.phase, generation: result.data.work.generation,
    legalActions: result.data.legalActions, next: result.next.map((action) => [action.id, action.reasonCode, action.kind]),
    why: result.why.map((reason) => reason.code)
  });
  assert.deepEqual(shape(after), shape(before));
  // Handles are what did not survive: the old session's handle is meaningless to the new one.
  const stale = await session('vscode-third').kernel.read({ resolutionId: before.next[0]?.handle ?? 'rea_none' });
  assert.equal(stale.kind, 'refusal');
});

test('developer-can-leave-and-return', async (t) => {
  const root = await governedRepository(t);
  const host = createHostGateway({ root, hostSessionId: 'developer-session', planners: gatewayPlanners(), plannerContext: { actor: ACTOR } });
  const issued = await host.kernel.resolve({ utterance: 'pick up where I left off', arguments: { workId: 'WRK-123' } });

  // The developer leaves SFlow and changes code with another tool.
  await writeFile(path.join(root, 'checkout.mjs'), 'export const postal = false; // edited outside SFlow\n');
  await writeFile(path.join(root, 'notes.txt'), 'scratch\n');

  // What was resolved against the old bytes no longer holds: the handle bound the whole worktree.
  const drifted = await host.kernel.read({ resolutionId: issued.next[0].handle });
  assert.deepEqual([drifted.kind, drifted.why[0].code], ['refusal', 'gateway.handle-drifted']);

  // Returning reconstructs from governed state, discloses the local work, and leaves it alone.
  const returned = await continueIn(host.kernel);
  const disclosure = returned.warnings.find((warning) => warning.code === 'work.local-changes-present');
  assert.ok(disclosure, 'local development was not disclosed');
  assert.equal(disclosure.reference, host.binding().worktreeHash, 'the disclosure is not bound to the returned bytes');
  assert.equal(returned.data.localChanges.dirty, true);
  assert.deepEqual([...returned.data.localChanges.paths].sort(), ['checkout.mjs', 'notes.txt']);
  assert.equal(await readFile(path.join(root, 'checkout.mjs'), 'utf8'), 'export const postal = false; // edited outside SFlow\n');

  // Anything planned now is bound to exactly these bytes, and one more edit invalidates it.
  const kernel = createGatewayKernel({ binding: host.binding, planners: gatewayPlanners(), root, plannerContext: { actor: ACTOR } });
  const planned = await kernel.resolve({ utterance: 'watch this', arguments: { subjectId: 'WRK-123', predicate: 'phase-changed' } });
  assert.equal(planned.kind, 'plan');
  await writeFile(path.join(root, 'notes.txt'), 'scratch, edited again\n');
  assert.throws(() => kernel.handles.verify({ id: planned.data.plan.handle }, { kind: 'plan', binding: host.binding() }),
    { code: 'HANDLE_DRIFTED' });
});
