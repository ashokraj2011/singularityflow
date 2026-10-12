import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';

import { resolveWorkType } from '../src/config.mjs';

const packaged = async () => YAML.parse(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8'));

test('every packaged Story review target is reachable in its selected workflow', async () => {
  const definition = await packaged();
  for (const id of Object.keys(definition.workTypes)) {
    const workflow = resolveWorkType(definition, id);
    const order = workflow.phases.map((phase) => phase.id);
    for (const [index, phase] of workflow.phases.entries()) {
      for (const target of phase.approval.rejectTo) {
        assert.ok(order.indexOf(target) >= 0 && order.indexOf(target) <= index,
          `${id}/${phase.id} offers unreachable rejection target ${target}`);
      }
    }
  }
});

test('every reviewed step of every packaged workflow may return the Story to each earlier step or to itself', async () => {
  // A later step finds defects in what earlier steps produced: the plan a Code step implements, or
  // the specification a review checks. Its reviewers can send the Story back to whichever step owns
  // the defect, so a Story is never stuck because that step "is not an allowed rejection target".
  const definition = await packaged();
  for (const id of Object.keys(definition.workTypes)) {
    const workflow = resolveWorkType(definition, id);
    const order = workflow.phases.map((phase) => phase.id);
    for (const [index, phase] of workflow.phases.entries()) {
      if (phase.approval.mode === 'none') {
        // Nobody reviews this step, so nobody can reject it; its policy names only itself.
        assert.deepEqual(phase.approval.rejectTo, [phase.id], `${id}/${phase.id}`);
        continue;
      }
      assert.deepEqual(phase.approval.rejectTo, order.slice(0, index + 1),
        `${id}/${phase.id} must offer every earlier step and itself, in workflow order`);
    }
  }
});
