import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { routeSelectors, simulateWorkflowRoutes } from '../src/workflow-route-simulation.mjs';

async function packaged(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-route-simulation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  return loadDefinition(root);
}

const phase = (id, approval = { mode: 'required', authorities: ['reviewers'], rejectTo: [id] }) => ({ id, label: id, approval });

test('every packaged workflow reaches its end on every route, and every bounded route pauses for a person', async (t) => {
  const definition = await packaged(t);
  for (const id of Object.keys(definition.workTypes)) {
    const result = simulateWorkflowRoutes(resolveWorkType(definition, id), { approvalAuthorities: definition.approvalAuthorities });
    assert.equal(result.status, 'passed', `${id}: ${JSON.stringify(result.findings)}`);
    assert.equal(result.coverage.phases.reached, result.coverage.phases.total, id);
  }
});

test('a check-repair-close workflow passes, repairs, exhausts and waits exactly as a running Story would', async (t) => {
  const definition = await packaged(t);
  const result = simulateWorkflowRoutes(resolveWorkType(definition, 'demo-check-repair-close'), { approvalAuthorities: definition.approvalAuthorities });
  const scenario = (id) => result.scenarios.find((entry) => entry.id === id);
  assert.deepEqual(scenario('pass').path, ['demo-intake', 'demo-check', 'demo-close', 'end'], 'a passing check skips its repair');
  assert.deepEqual(scenario('demo-check-result:demo-repair-defect').path,
    ['demo-intake', 'demo-check', 'demo-repair', 'demo-check', 'demo-close', 'end']);
  // A decision reached only through another decision's route is steered to, not skipped.
  assert.deepEqual(scenario('demo-repair-handoff:demo-revise-intake').path,
    ['demo-intake', 'demo-check', 'demo-repair', 'demo-intake', 'demo-check', 'demo-close', 'end']);
  const exhausted = scenario('demo-check-result:exhausted');
  assert.equal(exhausted.outcome, 'pause');
  assert.deepEqual(exhausted.pausedFor, ['quality-reviewers']);
  assert.equal(exhausted.path.filter((id) => id === 'demo-check').length, 4, 'three rounds back, then the pause');
  const waiting = scenario('demo-check-result:unavailable-evidence');
  assert.equal(waiting.outcome, 'blocked');
  assert.equal(waiting.at, 'demo-check', 'missing decision inputs never count as a pass');
});

test('a route an earlier rule always shadows, an unknown by group and a forward rejection are each reported', () => {
  const resolved = {
    id: 'shadowed',
    phases: [phase('a'), phase('b', { mode: 'required', authorities: ['reviewers'], rejectTo: ['c'] }), phase('c')],
    decisions: [{ id: 'triage', after: 'a', kind: 'branch', mode: 'auto', maxRounds: null, by: ['nobody'],
      inputs: [{ name: 'size', type: 'choice', values: ['small', 'large'] }],
      routes: [
        { id: 'any', when: { size: { in: ['small', 'large'] } }, to: 'b' },
        { id: 'large', when: { size: { in: ['large'] } }, to: 'c' },
        { id: 'else', when: null, to: 'c' }
      ] }]
  };
  const result = simulateWorkflowRoutes(resolved, { approvalAuthorities: { reviewers: {} } });
  assert.equal(result.status, 'failed');
  const codes = result.findings.map((finding) => `${finding.code}:${finding.decision ?? finding.phase}`);
  assert.ok(codes.includes('WORKFLOW_ROUTE_UNREACHABLE:triage'));
  assert.equal(codes.filter((code) => code === 'WORKFLOW_ROUTE_UNREACHABLE:triage').length, 2, 'large and else are both shadowed');
  assert.ok(codes.includes('WORKFLOW_AUTHORITY_UNKNOWN:triage'));
  assert.ok(codes.includes('WORKFLOW_REJECTION_TARGET:b'));
});

test('numeric thresholds find values for every route that can be chosen', () => {
  const decision = { id: 'score', after: 'a', kind: 'branch', mode: 'auto',
    inputs: [{ name: 'coverage', type: 'number', minimum: 0, maximum: 100 }],
    routes: [
      { id: 'high', when: { coverage: { atLeast: 80 } }, to: 'next' },
      { id: 'medium', when: { coverage: { above: 50, below: 80 } }, to: 'next' },
      { id: 'low', when: null, to: 'next' }
    ] };
  const selectors = routeSelectors(decision);
  assert.ok(selectors.get('high').values.coverage >= 80);
  assert.ok(selectors.get('medium').values.coverage > 50 && selectors.get('medium').values.coverage < 80);
  assert.ok(selectors.get('low').values.coverage <= 50);
});
