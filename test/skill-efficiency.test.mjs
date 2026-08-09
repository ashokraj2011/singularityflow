import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSkillPolicy, loadSkillPolicy } from '../scripts/skill-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every public skill has a bounded class and output contract', async () => {
  const { policy } = await loadSkillPolicy(root);
  const result = await auditSkillPolicy(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, Object.keys(policy.skills ?? {}).length);
  assert.ok(result.rows.every((row) => row.class && row.bodyTokens <= 800));
});

/**
 * The bar for automatic invocation is not "useful", it is "cannot change governed state".
 *
 * The list is asserted so widening it stays a deliberate edit with a reviewer on it, and the property
 * is asserted because that is the part that actually matters: no phrasing of a question should be
 * able to cause an approval or a publication. `interactive`, `review`, `generative` and `mutation`
 * all write something; only `echo` and `conversational` are safe for the model to choose by itself.
 */
const NON_MUTATING_CLASSES = new Set(['echo', 'conversational']);

test('only low-risk read-only skills may trigger automatically', async () => {
  const { policy } = await loadSkillPolicy(root);
  assert.deepEqual(policy.automaticInvocationAllowlist, [
    'sflow-doctor', 'sflow-help', 'sflow-logs',
    'sflow-nextsteps', 'sflow-progress', 'sflow-quickstart', 'sflow-status'
  ]);
  // Listing approvals is read-only; opening one is not. sflow-inbox asks the reviewer a question and
  // attaches a session, so it stays user-invoked however tempting it is as a natural-language target.
  assert.ok(!policy.automaticInvocationAllowlist.includes('sflow-inbox'));
  const result = await auditSkillPolicy(root);
  assert.deepEqual(result.automatic, policy.automaticInvocationAllowlist);

  for (const name of policy.automaticInvocationAllowlist) {
    const declared = policy.skills[name]?.class;
    assert.ok(NON_MUTATING_CLASSES.has(declared),
      `${name} is '${declared}'; only ${[...NON_MUTATING_CLASSES].join(' and ')} skills may be chosen by the model`);
  }

  const automatic = result.rows.filter((row) => row.automatic);
  assert.equal(automatic.length, policy.automaticInvocationAllowlist.length);
  // A description is routing input. Past 15 tokens it stops being a label and becomes a spec, and
  // the model has 98 of them to choose between.
  assert.ok(automatic.every((row) => row.descriptionTokens <= 15));
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
