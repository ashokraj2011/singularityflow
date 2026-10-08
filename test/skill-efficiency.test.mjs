import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSkillPolicy, bareOperationalCommands, loadSkillPolicy, skillDelegationErrors } from '../scripts/skill-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('delegation rejects missing owners, cycles, and duplicate executable procedures', () => {
  const skills = {
    'sflow-alias': { class: 'delegation', delegatesTo: 'sflow-owner' },
    'sflow-owner': { class: 'generative' }
  };
  for (const route of ['/sf-owner', '/sflow-owner']) {
    assert.deepEqual(skillDelegationErrors('sflow-alias', `Run \`${route}\` once.`, skills), []);
  }
  assert.match(skillDelegationErrors('sflow-alias', 'Run `/sf-other`.', skills).join(), /declared canonical skill/);
  assert.match(skillDelegationErrors('sflow-alias', 'Run `/sf-owner`, then `singularity-flow phase publish code`.', skills).join(), /duplicate CLI/);
  assert.match(skillDelegationErrors('sflow-alias', 'Run `/sf-owner`.', {
    'sflow-alias': skills['sflow-alias']
  }).join(), /existing canonical skill/);
  assert.match(skillDelegationErrors('sflow-alias', 'Run `/sf-owner`.', {
    ...skills, 'sflow-owner': { class: 'delegation', delegatesTo: 'sflow-alias' }
  }).join(), /cycle/);
});

test('side-effect classes preserve authoring, repair, advisory, and alias boundaries', async () => {
  const { policy } = await loadSkillPolicy(root);
  for (const name of ['sflow-specify', 'sflow-plan', 'sflow-converge']) {
    assert.equal(policy.classes[policy.skills[name].class].outputContract, 'clarification-and-artifact');
  }
  assert.equal(policy.classes[policy.skills['sflow-code-docs'].class].outputContract, 'scoped-repair');
  assert.equal(policy.classes[policy.skills['sflow-regression-investigate'].class].outputContract, 'guided-actions');
  assert.equal(policy.classes[policy.skills['sflow-workspace-impact'].class].outputContract, 'advisory-analysis');
  for (const name of ['sflow-jira-doctor', 'sflow-jira-status']) {
    assert.equal(policy.skills[name].executionBoundary, 'machine', 'single-command diagnostics must not need another context command');
  }
  assert.equal(policy.skills['sflow-implement'].delegatesTo, 'sflow-code');
  assert.equal(policy.skills['sflow-upload'].delegatesTo, 'sflow-documents');
  assert.equal(policy.skills['sflow-epic-planning'].delegatesTo, 'sflow-epic-story-draft');
});

test('every public skill has a bounded class and output contract', async () => {
  const { policy } = await loadSkillPolicy(root);
  const result = await auditSkillPolicy(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, Object.keys(policy.skills ?? {}).length);
  assert.ok(result.rows.every((row) => row.class
    && row.bodyTokens - row.commandPresentationTokens - row.pauseGuardTokens <= (policy.skills[row.name]?.maximumTokenOverride ?? 800)));
  // Code generation, the specialised skills a step may choose (they follow that step's contract),
  // and the two skills that relay a step routed elsewhere.
  const overridden = ['sflow-code', 'sflow-design', 'sflow-phase', 'sflow-release', 'sflow-requirements', 'sflow-verify'];
  assert.deepEqual(result.rows.filter((row) => row.bodyTokens - row.commandPresentationTokens - row.pauseGuardTokens > 800).map((row) => row.name), overridden);
  for (const name of overridden) assert.ok(policy.skills[name].exception, `${name} explains its token override`);
  assert.ok(result.rows.every((row) => ['never', 'conditional'].includes(row.kernelModelPolicy)));
  // `wm ensure` reads registered-v4 views without a model; skills that only offer it stay model-free.
  assert.deepEqual(result.rows.filter((row) => row.kernelModelPolicy === 'conditional').map((row) => row.name), [
    'sflow-auto', 'sflow-explain-code', 'sflow-next', 'sflow-spec',
    'sflow-workflow-rules', 'sflow-workspace', 'sflow-workspace-impact', 'sflow-worldmodel'
  ]);
  assert.ok(result.rows.filter((row) => row.kernelModelPolicy === 'never').every((row) => row.modelOperations.length === 0));
});

test('skill policy rejects executable bare SFlow command fragments but permits concepts and full commands', () => {
  assert.deepEqual(bareOperationalCommands([
    'Run `phase show implementation --json`.',
    'Then `recover <WORK-ID> --phase implementation --json`.'
  ].join('\n')), [
    'phase show implementation --json',
    'recover <WORK-ID> --phase implementation --json'
  ]);
  assert.deepEqual(bareOperationalCommands([
    'Run `singularity-flow phase show implementation --json`.',
    'Use the `recover` intent or `/sf-recover` route.'
  ].join('\n')), []);
});

test('code-gate skills distinguish runtime repair, draft authoring and published rollover', async () => {
  const content = async (name) => readFile(path.join(root, 'plugin', 'skills', name, 'SKILL.md'), 'utf8');
  const [code, recover, submit] = await Promise.all([
    content('sflow-code'), content('sflow-recover'), content('sflow-submit')
  ]);
  assert.match(code, /singularity-flow phase begin <phase> --json/);
  assert.match(code, /Consumed intent requires `\/sf-recover`/);
  assert.match(code, /Untracked `\.sflow\/results\/\*\*` need no cleaning/);
  assert.match(code, /proven runtime repair permits retry without source changes/i);
  assert.match(code, /Nonzero exit fails despite passing JUnit/);
  assert.match(recover, /Follow action classifications, not blanket dirty-tree stops/);
  assert.match(recover, /tracked\/staged reports and source require review/);
  assert.match(recover, /dependency repair permits retry without republishing unchanged source/);
  assert.match(recover, /Stop on unchanged conditions or three distinct repairs/);
  assert.match(submit, /changed source\/artifacts need reviewed rollover/);
  assert.match(submit, /Fingerprint refusal plus artifact\/check hashes and diagnosed runtime evidence/);
  assert.match(submit, /Stop on an unchanged condition or after three distinct repairs/);
  assert.match(submit, /Never loop quality commands/);
  assert.doesNotMatch(submit, /fix only current-phase artifacts\/checks/,
    'submission must not authorize edits over a consumed publication');
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

test('installation alone never claims native Copilot requests', async () => {
  const { policy } = await loadSkillPolicy(root);
  // Even safe read-only routing must be opt-in: a native Copilot question is not consent to
  // inject Home/Story context. Explicit SFlow agent selection still supports ordinary language.
  assert.deepEqual(policy.automaticInvocationAllowlist, []);
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
  assert.deepEqual(automatic, []);
  for (const row of result.rows) {
    const source = await readFile(path.join(root, 'plugin', 'skills', row.name, 'SKILL.md'), 'utf8');
    assert.match(source, /^disable-model-invocation: true$/mu, row.name);
  }
});

test('generative requirements retains interactive clarification and governed publication', async () => {
  const content = await readFile(path.join(root, 'plugin', 'skills', 'sflow-requirements', 'SKILL.md'), 'utf8');
  assert.match(content, /sflow-output-contract: clarification-and-artifact/);
  assert.match(content, /Human clarification checkpoint|ask_user/);
  assert.match(content, /Use returned `commands\.publish` when `ready`; absent: relay `commands\.next`, stop/);
  assert.match(content, /matching non-null `displayBinding`; else display every published text document in full/);
  assert.match(content, /reuse never carries approval consent/);
});

test('phase handoffs always show the Copilot action and terminal equivalent', async () => {
  const phaseSkills = [
    'sflow-phase', 'sflow-requirements', 'sflow-design',
    'sflow-review', 'sflow-release', 'sflow-verify', 'sflow-next',
    'sflow-specify', 'sflow-plan', 'sflow-converge',
    'sflow-document-intake', 'sflow-scenario-check'
  ];
  for (const name of phaseSkills) {
    const content = await readFile(path.join(root, 'plugin', 'skills', name, 'SKILL.md'), 'utf8');
    if (name === 'sflow-next') {
      assert.match(content, /Next action \(choose one surface\):/);
      assert.match(content, /`Copilot: \/sf-\.\.\.`/);
      assert.match(content, /`Shell: singularity-flow \.\.\.`/);
    } else {
      // Dynamic handoffs retain exact decision arguments; a literal slash command is not required.
      const boundHandoff = /`handoff`[^\n]*`copilotCommand`[^\n]*`command`/.test(content)
        || /relay the returned handoff[^\n]*Copilot\/Shell pairs/.test(content)
        || /Relay `continuation\.actions`: phase and Shell\/Copilot pair/.test(content);
      assert.ok(boundHandoff || /Next in Copilot: \/sf-|next: Copilot `\/sf-/.test(content), `${name} must relay the verified Copilot command`);
      assert.ok(boundHandoff || /Terminal equivalent: singularity-flow |Shell `singularity-flow /.test(content), `${name} must include the terminal equivalent`);
    }
  }
  const verify = await readFile(path.join(root, 'plugin', 'skills', 'sflow-verify', 'SKILL.md'), 'utf8');
  // The engine's handoff carries the decision arguments a hard-coded submit would lack.
  assert.match(verify, /End with each `handoff`/);
  assert.doesNotMatch(verify, /submit verification/);
});

test('approval remains explicit-only with one bound artifact review per conversation', async () => {
  const content = await readFile(path.join(root, 'plugin', 'skills', 'sflow-approve', 'SKILL.md'), 'utf8');
  assert.match(content, /disable-model-invocation:\s*true/);
  assert.match(content, /sflow-output-contract: governed-review/);
  assert.match(content, /Render all text\/briefs between/);
  assert.match(content, /exact phase name|exact phase ID/i);
  assert.ok(content.indexOf('choices begin approve <WORK-ID>') < content.indexOf('phase show <phase> --json'),
    'approval must resolve the requested Story and phase before reading artifacts');
  assert.ok(content.indexOf('phase show <phase> --json') < content.indexOf('Render once per exact display binding'),
    'current packet must be revalidated before prior display is reused');
  assert.match(content, /documentId`, `documentPath`, and `documentSha256`/);
  assert.match(content, /Do not perform a second `singularity-flow documents view` lookup/);
  assert.match(content, /across messages if needed/);
  assert.match(content, /Truncated content: stop/);
  assert.match(content, /do not ask again/);
  assert.match(content, /A phase supplied before a new or changed packet review is not its confirmation, even if document bodies match/);
  assert.match(content, /sflow-turn-boundary: approval-only/);
  assert.match(content, /approval CLI is the sole permitted lifecycle mutation/i);
  assert.match(content, /Never edit repository files, run tests\/builds\/raw Git, delegate, submit, or begin\/author another phase/i);
  assert.match(content, /end this turn before next-phase authoring/i);
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
