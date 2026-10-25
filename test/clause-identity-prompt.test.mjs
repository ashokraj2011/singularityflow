import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';
import { resolveWorkType } from '../src/config.mjs';
import { phasePromptExecutionContract } from '../src/worldmodel.mjs';

async function seededDefinition() {
  return YAML.parse(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8'));
}

function storyOf(definition, workType, workId, spec = undefined) {
  const resolved = resolveWorkType(definition, workType);
  return {
    workItem: { id: workId },
    resolution: spec ? { ...resolved, spec } : resolved,
    phaseOrder: resolved.phases.map((phase) => phase.id),
    phases: Object.fromEntries(resolved.phases.map((phase) => [phase.id, phase]))
  };
}

function clauseLines(definition, workflow, id) {
  return phasePromptExecutionContract(definition, workflow, workflow.phases[id]).lines
    .filter((line) => line.startsWith('- Clause IDs:'));
}

const owns = (workflow, id) => workflow.resolution.obligationGraph.nodes
  .find((node) => node.id === id).responsibilities.includes('scope');

test('a feature intake is told it numbers no clauses, and which later steps define them with the Work ID', async () => {
  const definition = await seededDefinition();
  const workflow = storyOf(definition, 'feature', 'hex-201806');
  const [intake] = clauseLines(definition, workflow, 'intake');
  assert.match(intake, /this step defines no requirement clauses/u);
  assert.match(intake, /Requirements \(`requirements`\) and Implementation specification \(`implementation-spec`\) define them later/u);
  assert.ok(intake.includes('`[HEX-201806:REQ-001]`'), 'the anchor carries the Work ID in capitals');
  assert.match(intake, /no `REQ-`\/`AC-` numbers; this overrides agent or skill guidance/u);
  assert.deepEqual(clauseLines(definition, workflow, 'requirements'), [], 'a clause step keeps its anchored template');
  assert.deepEqual(clauseLines(definition, workflow, 'implementation-spec'), []);
  const [design] = clauseLines(definition, workflow, 'design');
  assert.match(design, /defines no new clauses\. Cite an approved clause by its full ID, such as `HEX-201806:REQ-001`, never a bare `REQ-001`/u);
});

test('a configured clause namespace is the one the line names', async () => {
  const definition = await seededDefinition();
  const workflow = storyOf(definition, 'feature', 'hex-7', { namespace: 'ORDER' });
  assert.ok(clauseLines(definition, workflow, 'intake')[0].includes('`[ORDER:REQ-001]`'));
  assert.ok(clauseLines(definition, workflow, 'verification')[0].includes('`ORDER:REQ-001`'));
});

test('across seeded workflows only authored steps outside the clause steps get the line, once', async (t) => {
  const definition = await seededDefinition();
  let told = 0;
  for (const name of Object.keys(definition.workTypes)) {
    const workflow = storyOf(definition, name, 'cover-1');
    const before = structuredClone(workflow);
    const anyScope = workflow.phaseOrder.some((id) => owns(workflow, id));
    for (const id of workflow.phaseOrder) {
      const contract = phasePromptExecutionContract(definition, workflow, workflow.phases[id]);
      const lines = contract.lines.filter((line) => line.startsWith('- Clause IDs:'));
      const expected = anyScope && !owns(workflow, id) && !contract.deterministicOnly ? 1 : 0;
      assert.equal(lines.length, expected, `${name}/${id}`);
      told += lines.length;
    }
    assert.deepEqual(workflow, before, 'composing the line never changes the Story');
  }
  assert.ok(told > 20);
  t.diagnostic(`${told} steps across ${Object.keys(definition.workTypes).length} seeded workflows carry the line.`);
});

test('a quick fix whose intake defines the clauses gets no line there', async () => {
  const definition = await seededDefinition();
  const workflow = storyOf(definition, 'quick-fix', 'fix-1');
  const first = workflow.phaseOrder[0];
  assert.equal(owns(workflow, first), true);
  assert.deepEqual(clauseLines(definition, workflow, first), []);
});
