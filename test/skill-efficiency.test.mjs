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
  assert.ok(result.rows.every((row) => ['never', 'conditional'].includes(row.kernelModelPolicy)));
  assert.deepEqual(result.rows.filter((row) => row.kernelModelPolicy === 'conditional').map((row) => row.name), [
    'sflow-initiative-phase', 'sflow-next', 'sflow-run', 'sflow-spec', 'sflow-story-start',
    'sflow-workflow-rules', 'sflow-workspace', 'sflow-workspace-impact', 'sflow-worldmodel'
  ]);
  assert.ok(result.rows.filter((row) => row.kernelModelPolicy === 'never').every((row) => row.modelOperations.length === 0));
});

/**
 * The bar for automatic invocation is not "useful", it is "cannot change governed state".
 *
 * The list is asserted so widening it stays a deliberate edit with a reviewer on it, and the property
 * is asserted because that is the part that actually matters: no phrasing of a question should be
 * able to cause an approval or a publication. A `guided` skill may automatically compute its
 * initial read-only plan, but must collect an explicit choice before following any mutation flow.
 */
const NON_MUTATING_CLASSES = new Set(['echo', 'conversational', 'guided']);

test('only low-risk read-only skills may trigger automatically', async () => {
  const { policy } = await loadSkillPolicy(root);
  // sflow-docs earns a place here for the same reason the rest do: `explain` is an L0 read that
  // cannot touch governed state, and "how do approvals work?" is precisely the phrasing a newcomer
  // uses. It is also the only entry whose contract forbids answering from the model's own memory.
  assert.deepEqual(policy.automaticInvocationAllowlist, [
    'sflow-advise', 'sflow-docs', 'sflow-doctor', 'sflow-help', 'sflow-home', 'sflow-logs',
    'sflow-nextsteps', 'sflow-progress', 'sflow-quickstart', 'sflow-receipt', 'sflow-recommend',
    'sflow-status'
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
  assert.deepEqual(automatic.filter((row) => row.class === 'guided').map((row) => row.name), ['sflow-home']);
});

test('generative requirements retains interactive clarification and governed publication', async () => {
  const content = await readFile(path.join(root, 'plugin', 'skills', 'sflow-requirements', 'SKILL.md'), 'utf8');
  assert.match(content, /sflow-output-contract: clarification-and-artifact/);
  assert.match(content, /Human clarification checkpoint|ask_user/);
  assert.match(content, /phase publish requirements/);
  assert.match(content, /reproduce every published text document in full/);
});

test('phase handoffs always show the Copilot action and terminal equivalent', async () => {
  const phaseSkills = [
    'sflow-phase', 'sflow-requirements', 'sflow-design', 'sflow-implement',
    'sflow-review', 'sflow-release', 'sflow-verify', 'sflow-next',
    'sflow-specify', 'sflow-plan', 'sflow-converge'
  ];
  for (const name of phaseSkills) {
    const content = await readFile(path.join(root, 'plugin', 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(content, /Next in Copilot: \/sf-/, `${name} must lead its handoff with a Copilot command`);
    assert.match(content, /Terminal equivalent: singularity-flow /, `${name} must include the terminal equivalent`);
  }
  const verify = await readFile(path.join(root, 'plugin', 'skills', 'sflow-verify', 'SKILL.md'), 'utf8');
  assert.match(verify, /Next in Copilot: \/sf-submit verification/);
  assert.match(verify, /Terminal equivalent: singularity-flow submit verification/);
});

test('approval remains explicit-only and displays the full governed artifact', async () => {
  const content = await readFile(path.join(root, 'plugin', 'skills', 'sflow-approve', 'SKILL.md'), 'utf8');
  assert.match(content, /disable-model-invocation:\s*true/);
  assert.match(content, /sflow-output-contract: governed-review/);
  assert.match(content, /reproduce every returned generated current-phase text document in full/);
  assert.match(content, /exact phase name|exact phase ID/i);
  assert.ok(content.indexOf('choices begin approve <WORK-ID>') < content.indexOf('phase show <phase> --json'),
    'approval must resolve the requested Story and phase before reading artifacts');
  assert.ok(content.indexOf('phase show <phase> --json') < content.indexOf('Only now: Ask the reviewer'),
    'every artifact must be visibly rendered before confirmation is requested');
  assert.match(content, /paths, and SHA-256 values to match `approvalContext`/);
  assert.match(content, /If response bounds require several messages, continue until every document is visible/);
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
