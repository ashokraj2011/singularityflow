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

// Two sentences share the prefix: a clause step is told how its brackets define clauses (the
// authoring contract); any other authored step is told it numbers none (the composer).
const DEFINES = /^- Clause IDs: brackets define a clause once, as `\[[A-Z0-9._-]+:REQ-001\]` \(this Story's namespace;/u;
const NUMBERS_NONE = /no new clauses|defines no requirement clauses/u;

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
  assert.doesNotMatch(intake, DEFINES);
  for (const id of ['requirements', 'implementation-spec']) {
    const lines = clauseLines(definition, workflow, id);
    assert.equal(lines.length, 1, `${id}: a clause step is told once how its brackets define clauses`);
    assert.match(lines[0], DEFINES);
    // The step that defines the clauses is shown the Story's own namespace: shown `[NS:REQ-001]`, an office
    // agent wrote NS:AC-001 for every Story [office, 2026-11-12].
    assert.ok(lines[0].includes('`[HEX-201806:REQ-001]`'), `${id}: ${lines[0]}`);
    assert.doesNotMatch(lines[0], /\bNS:/u);
    assert.doesNotMatch(lines[0], NUMBERS_NONE, `${id}: a clause step is never told it numbers none`);
  }
  const [design] = clauseLines(definition, workflow, 'design');
  assert.match(design, /defines no new clauses\. Cite an approved clause by its full ID, such as `HEX-201806:REQ-001`, never a bare `REQ-001`/u);
});

test('a configured clause namespace is the one the line names', async () => {
  const definition = await seededDefinition();
  const workflow = storyOf(definition, 'feature', 'hex-7', { namespace: 'ORDER' });
  assert.ok(clauseLines(definition, workflow, 'intake')[0].includes('`[ORDER:REQ-001]`'));
  assert.ok(clauseLines(definition, workflow, 'verification')[0].includes('`ORDER:REQ-001`'));
  assert.ok(clauseLines(definition, workflow, 'requirements')[0].includes('`[ORDER:REQ-001]`'), 'the step that defines them names it too');
});

test('across seeded workflows only authored steps outside the clause steps get the line, once', async (t) => {
  const definition = await seededDefinition();
  let told = 0;
  for (const name of Object.keys(definition.workTypes)) {
    const workflow = storyOf(definition, name, 'cover-1');
    const before = structuredClone(workflow);
    for (const id of workflow.phaseOrder) {
      const contract = phasePromptExecutionContract(definition, workflow, workflow.phases[id]);
      const lines = contract.lines.filter((line) => line.startsWith('- Clause IDs:'));
      if (owns(workflow, id)) {
        assert.equal(lines.length, 1, `${name}/${id}`);
        assert.match(lines[0], DEFINES, `${name}/${id}: a clause step defines its clauses with brackets`);
        continue;
      }
      // Every authored step that defines no clauses is told so, in a workflow with no clause step as well.
      const expected = contract.deterministicOnly ? 0 : 1;
      assert.equal(lines.length, expected, `${name}/${id}`);
      for (const line of lines) assert.match(line, NUMBERS_NONE, `${name}/${id}`);
      told += lines.length;
    }
    assert.deepEqual(workflow, before, 'composing the line never changes the Story');
  }
  assert.ok(told > 20);
  t.diagnostic(`${told} steps across ${Object.keys(definition.workTypes).length} seeded workflows carry the line.`);
});

test('a workflow with no step that defines clauses tells each step there are none to cite', async () => {
  // Office, 2026-11-13: an intake, testing and test-report workflow that writes no code numbered bare
  // REQ-001 and AC-001 in its intake (agent text) and asked testing to map clauses nobody defined.
  const definition = await seededDefinition();
  const workflow = storyOf(definition, 'test-run', 'tr-1');
  assert.equal(workflow.phaseOrder.some((id) => owns(workflow, id)), false);
  const [line, ...more] = clauseLines(definition, workflow, 'test-run');
  assert.equal(more.length, 0);
  assert.match(line, /^- Clause IDs: this workflow defines no requirement clauses, so there are none to cite\. Write needs, success criteria and findings as plain statements, with no `REQ-`\/`AC-` numbers/u);
  assert.match(line, /this overrides agent or skill guidance that numbers or maps them\.$/u);
  assert.doesNotMatch(line, DEFINES);
  assert.doesNotMatch(line, /TR-1:/u, 'no namespace is shown where no clause exists');
});

test('a quick fix whose intake defines the clauses gets only the bracket definition there', async () => {
  const definition = await seededDefinition();
  const workflow = storyOf(definition, 'quick-fix', 'fix-1');
  const first = workflow.phaseOrder[0];
  assert.equal(owns(workflow, first), true);
  const lines = clauseLines(definition, workflow, first);
  assert.equal(lines.length, 1, 'only the bracket definition, never the numbering line');
  assert.match(lines[0], DEFINES);
});
