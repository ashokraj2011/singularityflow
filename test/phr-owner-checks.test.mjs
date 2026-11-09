/**
 * Phase responsibility, batch 2 [SPEC-PHR]: the step that owns an output checks it, before it can be
 * approved, so a later step no longer meets the fault. Each new check refuses only in the owning step,
 * names how to fix it there in a structured field, and applies only to a Story that pinned the
 * owner-step checks when it started: a Story already running keeps its policy.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { approvalHold, approvalHoldOwner } from '../src/approval-check.mjs';
import { evaluateEvidence } from '../src/evidence/evaluate.mjs';
import { evidenceGraph } from '../src/evidence/graph.mjs';
import { ownerStepChecks, phaseResponsibilityPin } from '../src/phase-roles.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { finalScopeStep, scopeDispositionRefusal } from '../src/scope/authoring.mjs';
import { recordScopeDecision } from '../src/scope/decisions.mjs';
import { buildScopeInventory } from '../src/scope/inventory.mjs';

const PINNED = { phaseResponsibility: phaseResponsibilityPin() };

test('[PHR:REQ-002] a Story pins the owner-step checks when it starts; one started before keeps its policy', () => {
  assert.equal(ownerStepChecks({ resolution: PINNED }), true);
  assert.equal(ownerStepChecks({ resolution: {} }), false, 'a Story started before the checks existed');
  assert.equal(ownerStepChecks(null), false);
});

/** Intake defines the scope (and the plan), specification is a later step that does not. */
function scopeStory({ pinned = true, status = 'awaiting_approval' } = {}) {
  const step = (id, stepStatus, responsibilities) => ({ id, label: id, status: stepStatus, generation: 1, approvals: [],
    approvalPolicy: { mode: 'required', authorities: ['product-approvers'], minimum: 1, rejectTo: [id] }, responsibilities });
  return { workItem: { id: 'W-1', title: 'Change the value' }, status: 'in_progress', currentPhase: 'intake', phaseOrder: ['intake', 'code'],
    phases: { intake: step('intake', status), code: { ...step('code', 'not_started'), generation: 0 } },
    resolution: { ...(pinned ? PINNED : {}), obligationGraph: { nodes: [{ id: 'intake', responsibilities: ['scope', 'plan', 'review'] },
      { id: 'code', responsibilities: ['implement', 'verify'] }], endpoints: [] } } };
}

async function storyDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-phr-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'singularity/work-items/W-1');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'documents.json'), JSON.stringify({ schemaVersion: 3, workId: 'W-1', documents: [] }));
  return { root, directory };
}

test('[PHR:REQ-002] finding 10: the step that defines the scope is approved only once each statement is dispositioned, so the ending no longer meets it', async (t) => {
  const { root, directory } = await storyDirectory(t);
  const source = { description: 'The API must stay stable.', acceptanceCriteria: ['The exported value equals 2.'] };
  const clauses = [{ id: 'W-1:AC-001', body: 'The exported value equals 2.' }];
  const workflow = scopeStory();
  assert.equal(finalScopeStep(workflow).id, 'intake');
  const inventory = await buildScopeInventory(root, directory, workflow, { source, clauses });
  const item = inventory.items.find((entry) => entry.disposition === 'unresolved');
  assert.ok(item, 'the fixture has a statement no clause carries');

  // The owning step refuses, with the decision list and the exact scope decisions as structured routes.
  const refusal = scopeDispositionRefusal(workflow, workflow.phases.intake, inventory);
  assert.equal(refusal.code, 'SCOPE_ITEMS_UNRESOLVED');
  assert.deepEqual([refusal.details.ownerPhase, refusal.details.scopePhase, refusal.details.items[0].id], ['intake', 'intake', item.id]);
  assert.equal(refusal.details.nextAction.command, 'singularity-flow decisions W-1');
  assert.match(refusal.details.recoveryCommands[0].command, new RegExp(`^singularity-flow decision scope W-1 --item ${item.id} --as <included\\|existing> --clause <CLAUSE-ID>`, 'u'));
  assert.match(refusal.details.recoveryCommands[1].command, /--as <excluded\|deferred\|informative/u);
  // Its approvers decide it, and every surface's hold says so: never a return of the step for changes.
  assert.equal(approvalHoldOwner(refusal), 'someone-decides');
  const hold = approvalHold(refusal, workflow, workflow.phases.intake);
  assert.deepEqual([hold.action.command, hold.who], ['singularity-flow decisions W-1', 'An approver of intake decides']);
  assert.doesNotMatch(JSON.stringify(hold), /reject intake/u);
  const plan = refusalRemediationPlan(refusal, ['approve', 'intake', '--work-id', 'W-1']);
  assert.ok(plan.steps.some((entry) => entry.command === 'singularity-flow decisions W-1'), JSON.stringify(plan.steps.map((entry) => entry.command)));

  // Once a person dispositions it, the step may be approved, and the ending has nothing left to refuse for it.
  recordScopeDecision(workflow, { item: item.id, disposition: 'excluded', reason: 'Stability is owned by the platform team, not this Story.',
    actor: 'po@example.test', authorityGroup: 'product-approvers', at: '2026-11-10T00:00:00.000Z', inventory, knownClauseIds: [] });
  const decided = await buildScopeInventory(root, directory, workflow, { source, clauses });
  assert.equal(scopeDispositionRefusal(workflow, workflow.phases.intake, decided), null);
  const ending = evaluateEvidence(evidenceGraph({ workflow, records: { indexes: [] }, scope: decided }));
  assert.ok(!ending.findings.some((entry) => entry.code === 'SCOPE_ITEMS_UNRESOLVED'));

  // A Story started before the check keeps working: its scope step is approved as before, and only its ending judges scope.
  const legacy = scopeStory({ pinned: false });
  assert.equal(scopeDispositionRefusal(legacy, legacy.phases.intake, inventory), null);
  assert.ok(evaluateEvidence(evidenceGraph({ workflow: legacy, records: { indexes: [] }, scope: inventory }))
    .findings.some((entry) => entry.code === 'SCOPE_ITEMS_UNRESOLVED'), 'the ending still holds an older Story');
  // A step that does not define the scope last is never held by it.
  const twoScopes = scopeStory();
  twoScopes.phaseOrder = ['intake', 'specification', 'code'];
  twoScopes.phases.specification = { ...twoScopes.phases.intake, id: 'specification', status: 'not_started', generation: 0 };
  twoScopes.resolution.obligationGraph.nodes.push({ id: 'specification', responsibilities: ['scope'] });
  assert.equal(scopeDispositionRefusal(twoScopes, twoScopes.phases.intake, inventory), null);
});
