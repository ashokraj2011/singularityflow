/**
 * The startup menu and the direct path past it. `[INT:AC-001]` `[INT:REQ-021]` `[INT:REQ-025]`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createGatewayKernel } from '../src/gateway/kernel.mjs';
import { HOME_CHOICES, MAX_HOME_CHOICES } from '../src/gateway/planners/home-overview.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';

const ACTOR = { login: 'dev-1', email: 'dev-1@example.com', name: 'Dev One' };
const binding = {
  workspaceId: 'payments', repository: 'checkout-service', branch: 'main', subjectKind: null, subjectId: null,
  sourceCommit: null, worktreeHash: null, worktreeAlgorithm: 'sflow-worktree-v2', lifecycleRevision: null,
  policyHash: 'sha256:policy', registryHash: 'sha256:registry', actorId: ACTOR.email, hostSessionId: 'sess-home'
};

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-guide-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'singularity', 'work-items', 'WRK-123');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'workflow.json'), JSON.stringify({
    workItem: { id: 'WRK-123', title: 'Address validation', workType: 'feature', branch: 'WRK-123' },
    phaseOrder: ['design', 'implementation'], currentPhase: 'implementation',
    phases: { implementation: { status: 'in_progress', generation: 1, label: 'Implementation' } },
    history: [{ event: 'work_started', phase: 'implementation', actor: ACTOR, at: '2026-10-20T10:00:00.000Z' }]
  }));
  return createGatewayKernel({
    binding, planners: gatewayPlanners(), root,
    plannerContext: { actor: ACTOR, storyId: 'WRK-123', workId: 'WRK-123', workKind: 'story', repositoryId: 'checkout-service' }
  });
}

test('home-is-contextual-and-direct-intent-bypasses', async (t) => {
  const kernel = await fixture(t);
  const stable = new Set(HOME_CHOICES.map((choice) => `home:${choice.id}`));

  // An empty entry and a greeting both reach the kernel-owned home planner.
  for (const utterance of ['home', 'hello', 'Good morning!']) {
    const resolved = await kernel.resolve({ utterance });
    assert.equal(resolved.kind, 'read', utterance);
    const home = await kernel.read({ resolutionId: resolved.next[0].handle });
    assert.equal(home.operation.id, 'home.overview', utterance);
    // At most six kernel-ranked choices from the stable goal set, none of them executable.
    assert.ok(home.next.length <= MAX_HOME_CHOICES && MAX_HOME_CHOICES === 6);
    for (const choice of home.next) {
      assert.ok(stable.has(choice.id), `${choice.id} is not a stable home choice`);
      assert.equal(choice.executable, false);
      assert.ok(choice.handle && choice.label && choice.reasonCode && choice.fallback?.command, `${choice.id} lacks IFC-001 fields`);
    }
    // The active Story leads, and names itself, its repository and its phase `[INT:REQ-023]`.
    assert.deepEqual([home.next[0].id, home.next[0].slots.work, home.next[0].slots.phase],
      ['home:work.continue', 'WRK-123', 'implementation']);
  }

  // A substantive first request is resolved directly; the menu never stands in front of it.
  const direct = await kernel.resolve({ utterance: 'what caused this checkout bug' });
  assert.deepEqual([direct.kind, direct.operation.id], ['read', 'problem.investigate']);
  const continued = await kernel.resolve({ utterance: 'continue', arguments: { workId: 'WRK-123' } });
  assert.deepEqual([continued.kind, continued.operation.id], ['read', 'work.continue']);
  // A greeting followed by a request is a request.
  const greeted = await kernel.resolve({ utterance: 'hi, continue WRK-123', arguments: { workId: 'WRK-123' } });
  assert.notEqual(greeted.operation.id, 'home.overview');
});
