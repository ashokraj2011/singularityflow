import test from 'node:test';
import assert from 'node:assert/strict';

import { COMMAND_REGISTRY } from '../src/command-registry.mjs';
import { BROAD_GOALS } from '../src/gateway/goals.mjs';
import { gatewayRegistry } from '../src/gateway/operations.mjs';
import {
  NEXT_SCOPES, SFLOW_TOOLS, SFLOW_TOOL_NAMES, TOOL_SCHEMA_TOKEN_BUDGET,
  serializeToolSchemas, toolSchemaMeasurement
} from '../src/gateway/tools.mjs';

test('five-tools-stay-small', () => {
  // `[INT:AC-020]` `[INT:REQ-031]`. The measurement is reported whether it passes or not, because
  // the number is what belongs in the release report — the assertion is only the tripwire.
  const measured = toolSchemaMeasurement();
  assert.equal(measured.tools, 5);
  assert.equal(measured.serialization, 'json-compact');
  assert.equal(measured.tokenizer, 'bytes-per-token-4.0');
  assert.ok(measured.bytes > 0);
  assert.ok(
    measured.tokens <= TOOL_SCHEMA_TOKEN_BUDGET,
    `the five host schemas measure ${measured.tokens} tokens (${measured.bytes} bytes)`
    + ` against a budget of ${TOOL_SCHEMA_TOKEN_BUDGET}`
  );
});

test('there are exactly five tools, and no command is one of them', () => {
  // `[INT:CON-034]`. Registering commands as tools is how a five-tool surface becomes a hundred.
  assert.deepEqual([...SFLOW_TOOL_NAMES], ['sflow_resolve', 'sflow_read', 'sflow_next', 'sflow_run', 'sflow_explain']);
  const commands = new Set(COMMAND_REGISTRY.map((entry) => entry.name));
  for (const name of SFLOW_TOOL_NAMES) {
    assert.equal(commands.has(name), false);
    assert.equal(commands.has(name.replace('sflow_', '')), name === 'sflow_next' || name === 'sflow_run' || name === 'sflow_explain');
  }
  // Those three share a word with a CLI command and are still not that command: a tool named for a
  // verb is fine, a tool that *is* a command is not.
  const operations = new Set(gatewayRegistry().operations.map((entry) => entry.id));
  for (const name of SFLOW_TOOL_NAMES) assert.equal(operations.has(name), false);
});

test('the handle-only tools accept a handle and nothing else', () => {
  // `[INT:IFC-013]` `[INT:IFC-015]`: no operation name, command line, Git argv, path, provider
  // query or free-form arguments — expressed as a closed object with exactly one property.
  for (const [name, property] of [['sflow_read', 'resolutionId'], ['sflow_run', 'planId']]) {
    const schema = SFLOW_TOOLS.find((tool) => tool.name === name).inputSchema;
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties), [property]);
    assert.deepEqual([...schema.required], [property]);
  }
});

test('the confirmation receipt is not a field the model can see', () => {
  // `[INT:CON-039]`. A property the model can name is a property the model can invent.
  const serialized = serializeToolSchemas();
  for (const word of ['receipt', 'confirmation', 'token', 'secret']) {
    assert.equal(serialized.toLowerCase().includes(word), false, `'${word}' appears in the tool surface`);
  }
});

test('a goal hint is a closed vocabulary, and only resolution accepts one', () => {
  /**
   * `[INT:CON-035]`, in the form that actually holds.
   *
   * Ten operations are spelled exactly like the goal they serve — `impact.quick` is both, and the
   * specification's own §7 example is written that way. The name is not what makes a hint advisory;
   * *where it is accepted* is. A hint can only be offered to `sflow_resolve`, which validates it and
   * intersects it with the legal-action set. Neither tool that carries something out will take one,
   * so there is no path from naming a goal to performing it.
   */
  const resolve = SFLOW_TOOLS.find((tool) => tool.name === 'sflow_resolve').inputSchema;
  assert.deepEqual([...resolve.properties.goalHint.enum], [...BROAD_GOALS]);
  assert.equal(resolve.additionalProperties, false);

  for (const tool of SFLOW_TOOLS) {
    if (tool.name === 'sflow_resolve') continue;
    assert.equal(tool.inputSchema.properties.goalHint, undefined, `${tool.name} accepts a goal hint`);
  }

  // And a hint always has somewhere safe to land, which the registry enforces at compile time.
  const byGoal = new Map();
  for (const operation of gatewayRegistry().operations) {
    for (const goal of operation.gateway.goals) byGoal.set(goal, [...(byGoal.get(goal) ?? []), operation]);
  }
  for (const goal of BROAD_GOALS) {
    assert.ok(byGoal.get(goal).some((entry) => entry.classification === 'read'), `goal '${goal}' reaches only writes`);
  }
});

test('every tool input is a closed object', () => {
  for (const tool of SFLOW_TOOLS) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} accepts unknown properties`);
    assert.ok(tool.description.length > 0);
  }
  assert.deepEqual([...NEXT_SCOPES], ['home', 'subject', 'investigation']);
});
