import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';

import { resolveWorkType } from '../src/config.mjs';

test('every packaged Story review target is reachable in its selected workflow', async () => {
  const definition = YAML.parse(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8'));
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
