/**
 * The execution identity a composed prompt carries is accepted wherever it is checked.
 *
 * Reusable instructions referenced by retained skills joined the identity, but the shared check kept
 * its older closed key set. Every Story-scoped model request that forwarded the identity (Auto
 * authoring, assisted specification quality, PR description polish) and the VS Code handoff audit
 * were refused with "unknown field 'instructions'".
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePromptExecutionContext } from '../src/prompt-execution-context.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const identity = () => ({
  mode: 'workflow-snapshot', snapshotHash: digest('a'), agentId: 'developer', agentBlobSha256: digest('b'),
  dependencies: [{ logicalId: 'skill:zeta', sha256: digest('c') }, { logicalId: 'skill:alpha', sha256: digest('d') }],
  parserProfile: 'agent-markdown-v1', composerProfile: 'story-snapshot-agent-v3', overrideSha256: null
});

test('the instructions a snapshot identity names are accepted and kept in order', () => {
  const normalized = normalizePromptExecutionContext({
    ...identity(),
    instructions: [{ logicalId: 'instruction:tone', sha256: digest('e') }, { logicalId: 'instruction:api', sha256: digest('f') }]
  }, { code: 'MODEL_REQUEST_INVALID', label: 'Model request executionContext' });
  assert.deepEqual(normalized.instructions.map((entry) => entry.logicalId), ['instruction:api', 'instruction:tone']);
  assert.deepEqual(normalized.dependencies.map((entry) => entry.logicalId), ['skill:alpha', 'skill:zeta']);
  assert.deepEqual(normalizePromptExecutionContext({ ...identity(), instructions: [] }).instructions, []);
});

test('an identity stored before instructions existed normalizes to the same fields', () => {
  assert.equal(Object.hasOwn(normalizePromptExecutionContext(identity()), 'instructions'), false);
});

test('instructions are checked as strictly as dependencies', () => {
  const refused = (instructions, pattern) => assert.throws(
    () => normalizePromptExecutionContext({ ...identity(), instructions }), pattern);
  refused({}, /instructions must be an array/);
  refused([{ logicalId: 'instruction:a', sha256: 'abc' }], /instructions\[0\]\.sha256 must be a canonical/);
  refused([{ logicalId: 'instruction:a', sha256: digest('1'), extra: true }], /unknown field 'extra'/);
  refused([{ logicalId: 'instruction:a', sha256: digest('1') }, { logicalId: 'instruction:a', sha256: digest('2') }],
    /repeats instruction 'instruction:a'/);
  assert.throws(() => normalizePromptExecutionContext({ ...identity(), surprise: 1 }), /unknown field 'surprise'/);
});
