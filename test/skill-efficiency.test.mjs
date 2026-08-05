import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSkillPolicy, loadSkillPolicy } from '../scripts/skill-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every public skill has a bounded class and output contract', async () => {
  const result = await auditSkillPolicy(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 93);
  assert.ok(result.rows.every((row) => row.class && row.bodyTokens <= 800));
});

test('only low-risk conversational skills may trigger automatically', async () => {
  const { policy } = await loadSkillPolicy(root);
  assert.deepEqual(policy.automaticInvocationAllowlist, ['sflow-help', 'sflow-nextsteps', 'sflow-status']);
  const result = await auditSkillPolicy(root);
  assert.deepEqual(result.automatic, ['sflow-help', 'sflow-nextsteps', 'sflow-status']);
  assert.equal(result.rows.filter((row) => row.automatic).length, 3);
  assert.ok(result.rows.filter((row) => row.automatic).every((row) => row.descriptionTokens <= 15));
});

test('generative requirements retains interactive clarification and governed publication', async () => {
  const content = await readFile(path.join(root, 'plugin', 'skills', 'sflow-requirements', 'SKILL.md'), 'utf8');
  assert.match(content, /sflow-output-contract: clarification-and-artifact/);
  assert.match(content, /Human clarification checkpoint|ask_user/);
  assert.match(content, /phase publish requirements/);
  assert.match(content, /reproduce every published text document in full/);
});

test('approval remains explicit-only and displays the full governed artifact', async () => {
  const content = await readFile(path.join(root, 'plugin', 'skills', 'sflow-approve', 'SKILL.md'), 'utf8');
  assert.match(content, /disable-model-invocation:\s*true/);
  assert.match(content, /sflow-output-contract: governed-review/);
  assert.match(content, /reproduce every returned generated current-phase text document in full/);
  assert.match(content, /exact phase name|exact phase ID/i);
});

test('plugin startup does not inject a model prompt', async () => {
  const hooks = JSON.parse(await readFile(path.join(root, 'plugin', 'hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.sessionStart, undefined);
  assert.equal(hooks.hooks.subagentStart?.[0]?.type, 'command');
});

test('utility agent is read-only and delegates mutations to the governed workflow', async () => {
  const content = await readFile(path.join(root, 'plugin', 'agents', 'sflow-utility.agent.md'), 'utf8');
  assert.match(content, /tools: \["bash", "read_bash", "view"\]/);
  assert.doesNotMatch(content, /"edit"|"write_bash"/);
  assert.match(content, /Run the narrowest named `singularity-flow` command and return its output verbatim/);
  assert.match(content, /request would change repository or lifecycle\s+state, stop/);
});
