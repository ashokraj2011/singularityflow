import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_PRESENTATION_CONTRACT, artifactPresentationContractErrors, auditSkillPolicy, bareOperationalCommands, cliPathContractErrors, loadSkillPolicy, skillDelegationErrors } from '../scripts/skill-policy.mjs';
import { CLI_PATH_CONTRACT } from '../src/safe-command-guidance.mjs';

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
    && row.bodyTokens - row.pathContractTokens - row.commandPresentationTokens - row.artifactPresentationTokens - (row.refusalHandlingTokens ?? 0) - (row.applicabilityTokens ?? 0) - (row.approvedInputsTokens ?? 0) - (row.storyCwdTokens ?? 0) - row.pauseGuardTokens - (row.gatewayToolsTokens ?? 0) <= (policy.skills[row.name]?.maximumTokenOverride ?? 800)));
  // Code generation, the specialised skills a step may choose (they follow that step's contract),
  // the two skills that relay a step routed elsewhere, and the skills whose single
  // `prepublish --publish-if-ready` or `--submit-if-ready` call must say when not to act again, and
  // the skills whose JSON reads carry `--for-agent` (a bounded result with `act` first).
  // 2026-10-19: the guard and anti-stall sentences a budget trim had removed are restored; their skills
  // carry a raised override with that reason instead of losing the guard again.
  // 2026-10-26: /sf-review joins them — its repair bound names an unchanged draft, not unchanged findings.
  // 2026-10-29: /sf-test-setup joins them — its reads carry --for-agent and its apply is the person's step.
  // 2026-10-31 (sweep batch 5): /sf-capability-map names a value conflict's discard and remap instead of a
  // rebase (C4), and /sf-configuration runs the draft read, discard and propose its refusals route to (E7).
  const overridden = ['sflow-appeal', 'sflow-approve', 'sflow-build-workflow', 'sflow-capability-map', 'sflow-code', 'sflow-configuration', 'sflow-converge', 'sflow-decide', 'sflow-design', 'sflow-document-intake', 'sflow-documents',
    'sflow-home', 'sflow-mcp', 'sflow-phase', 'sflow-plan', 'sflow-ready', 'sflow-recover', 'sflow-reinstall', 'sflow-reject',
    'sflow-release', 'sflow-requirements', 'sflow-review', 'sflow-review-source', 'sflow-run-app', 'sflow-scenario-check', 'sflow-session', 'sflow-specify', 'sflow-start',
    'sflow-story-start', 'sflow-submit', 'sflow-test-setup', 'sflow-verify', 'sflow-workflows'];
  assert.deepEqual(result.rows.filter((row) => row.bodyTokens - row.pathContractTokens - row.commandPresentationTokens - row.artifactPresentationTokens - (row.refusalHandlingTokens ?? 0) - (row.applicabilityTokens ?? 0) - (row.approvedInputsTokens ?? 0) - (row.storyCwdTokens ?? 0) - row.pauseGuardTokens - (row.gatewayToolsTokens ?? 0) > 800).map((row) => row.name), overridden);
  for (const name of overridden) assert.ok(policy.skills[name].exception, `${name} explains its token override`);
  assert.ok(result.rows.every((row) => ['never', 'conditional'].includes(row.kernelModelPolicy)));
  // `wm ensure` reads registered-v4 views without a model; skills that only offer it stay model-free.
  assert.deepEqual(result.rows.filter((row) => row.kernelModelPolicy === 'conditional').map((row) => row.name), [
    'sflow-auto', 'sflow-explain-code', 'sflow-next', 'sflow-spec',
    'sflow-workflow-rules', 'sflow-workspace', 'sflow-workspace-impact', 'sflow-worldmodel'
  ]);
  assert.ok(result.rows.filter((row) => row.kernelModelPolicy === 'never').every((row) => row.modelOperations.length === 0));
});

test('all skill classes and bundled agents preserve CLI-issued paths without conflicting confinement', async () => {
  const { policy } = await loadSkillPolicy(root);
  for (const name of Object.keys(policy.skills)) {
    const text = await readFile(path.join(root, 'plugin/skills', name, 'SKILL.md'), 'utf8');
    assert.equal(text.split(CLI_PATH_CONTRACT).length, 2, name);
    assert.doesNotMatch(text, /cwd for every shell and file tool/, name);
  }
  for (const agent of ['sflow-workflow', 'sflow-utility', 'sflow-source-reviewer']) {
    const text = await readFile(path.join(root, 'plugin/agents', `${agent}.agent.md`), 'utf8');
    assert.ok(text.includes(CLI_PATH_CONTRACT), agent);
    assert.doesNotMatch(text, /cwd for every shell and file tool|Never search.*outside that repository/, agent);
  }
});

test('the install-time path audit refuses missing, duplicate and contradictory future guidance', () => {
  assert.deepEqual(cliPathContractErrors(CLI_PATH_CONTRACT), []);
  assert.match(cliPathContractErrors('').join(), /exactly one/);
  assert.match(cliPathContractErrors(`${CLI_PATH_CONTRACT}\n${CLI_PATH_CONTRACT}`).join(), /exactly one/);
  assert.match(cliPathContractErrors(`${CLI_PATH_CONTRACT}\nUse repositoryPath as cwd for every shell and file tool.`).join(), /file-path prefix/);
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
  assert.match(submit, /Fingerprint refusal plus artifact\/check hashes and diagnosed runtime evidence/i);
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
  assert.match(content, /Use returned `commands\.publish` when `ready` unless `publishIfReady\.published`; absent: relay `commands\.next`, stop/);
  assert.match(content, /Preparation is not authoring/);
  assert.match(content, /native file-edit tool/);
  assert.match(content, /verified Markdown-preview links/);
  assert.match(content, /current `reviewBinding`[\s\S]*document reuse never (?:reuses|carries) approval consent/);
});

test('phase handoffs show Copilot, Shell and exact available model-free alternatives', async () => {
  const phaseSkills = [
    'sflow-phase', 'sflow-requirements', 'sflow-design',
    'sflow-review', 'sflow-release', 'sflow-verify', 'sflow-next',
    'sflow-specify', 'sflow-plan', 'sflow-converge',
    'sflow-document-intake', 'sflow-scenario-check'
  ];
  for (const name of phaseSkills) {
    const content = await readFile(path.join(root, 'plugin', 'skills', name, 'SKILL.md'), 'utf8');
    // The shared presentation contract (8f25dc4b): three bullets in route order, and the words for a missing route.
    assert.match(content, /three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code \(model-free\): `<modelFreeCommand>`"/);
    assert.match(content, /Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action"/);
    if (name === 'sflow-next') {
      assert.match(content, /first `NOW` action's `copilotCommand` and `command` from that same action object/);
      assert.match(content, /render all three surfaces per the Output contract/);
    } else {
      // Dynamic handoffs retain exact decision arguments; a literal slash command is not required.
      const boundHandoff = /`handoff`[^\n]*`copilotCommand`[^\n]*`command`/.test(content)
        || /relay the returned handoff[^\n]*Copilot\/Shell pairs/.test(content)
        || /Relay `continuation\.actions`: phase and all three surfaces/.test(content);
      assert.ok(boundHandoff || /Next in Copilot: \/sf-|next: Copilot `\/sf-/.test(content), `${name} must relay the verified Copilot command`);
      assert.ok(boundHandoff || /Terminal equivalent: singularity-flow |Shell `singularity-flow /.test(content), `${name} must include the terminal equivalent`);
    }
  }
  const verify = await readFile(path.join(root, 'plugin', 'skills', 'sflow-verify', 'SKILL.md'), 'utf8');
  // The engine's handoff carries the decision arguments a hard-coded submit would lack.
  assert.match(verify, /End with each `handoff`/);
  assert.doesNotMatch(verify, /submit verification/);
});

test('approval remains explicit-only with complete bound human review outside chat', async () => {
  const content = await readFile(path.join(root, 'plugin', 'skills', 'sflow-approve', 'SKILL.md'), 'utf8');
  assert.match(content, /disable-model-invocation:\s*true/);
  assert.match(content, /sflow-output-contract: governed-review/);
  assert.match(content, /Require human review of complete bound documents; never infer it from opened previews/);
  assert.match(content, /exact phase name|exact phase ID/i);
  assert.ok(content.indexOf('choices begin approve <WORK-ID>') < content.indexOf('phase show <phase> --for-agent --json'),
    'approval must resolve the requested Story and phase before reading artifacts');
  assert.ok(content.indexOf('phase show <phase> --for-agent --json') < content.indexOf('Review outside chat against the exact binding'),
    'current packet must be revalidated before prior human acknowledgement is reused');
  assert.match(content, /Match receipt, `reviewBinding`, artifacts and briefs to `approvalContext`; mismatch or missing binding stops/);
  assert.match(content, /Do not repeat document lookup/);
  assert.match(content, /omissions or truncation require fresh human review/);
  assert.match(content, /do not ask again/);
  assert.match(content, /A phase supplied before a new or changed packet review is not its confirmation, even if document bodies match/);
  assert.match(content, /sflow-turn-boundary: approval-only/);
  assert.match(content, /approval CLI is the sole permitted lifecycle mutation/i);
  assert.match(content, /Never edit repository files, run tests\/builds\/raw Git, delegate, submit, or begin\/author another phase/i);
  assert.match(content, /end this turn before next-phase authoring/i);
});

test('artifact presentation rejects conflicting dump instructions without equating summaries to review', () => {
  assert.deepEqual(artifactPresentationContractErrors(ARTIFACT_PRESENTATION_CONTRACT), []);
  assert.match(ARTIFACT_PRESENTATION_CONTRACT, /observed added\/deleted\/created line counts; unavailable stays unavailable/);
  assert.match(ARTIFACT_PRESENTATION_CONTRACT, /Use existing evidence, not extra calls solely for display/);
  assert.match(ARTIFACT_PRESENTATION_CONTRACT, /Summaries, links and opened previews are not human review or approval/);
  assert.match(artifactPresentationContractErrors('Summarize the artifact.').join(), /missing concise/);
  for (const stale of [
    'Display every published text document in full.',
    'Reproduce every generated text document in full.',
    'Render every text/brief with --- BEGIN <path> --- delimiters.',
    'New chats require full display.',
    'Reproduce the complete Markdown summary.',
    'Show all three documents and hashes in full.',
    'Reproduce the complete command output in the visible assistant response.'
  ]) assert.match(artifactPresentationContractErrors(`${ARTIFACT_PRESENTATION_CONTRACT}\n${stale}`).join(), /conflicts/, stale);
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
  assert.match(content, /Run the narrowest named `singularity-flow` command and relay its exact status, warnings and actions/);
  assert.match(content, /not bodies, snippets or diffs/);
  assert.match(content, /request would change repository or lifecycle\s+state, stop/);
});

// /sf-test-setup and /sf-confirm relay refusals whose fix is in `act` (a test command's wrong field, a
// stale digest), but as repository skills they lacked the act-first and cut-off-result contract that
// every Story skill carries (2026-10-29).
test('repository skills that relay act-borne refusals carry the complete-output contract', async () => {
  const { COMPLETE_OUTPUT_CONTRACT } = await import('../scripts/skill-policy.mjs');
  for (const name of ['sflow-test-setup', 'sflow-confirm']) {
    const text = await readFile(path.join(root, 'plugin/skills', name, 'SKILL.md'), 'utf8');
    assert.ok(text.includes(COMPLETE_OUTPUT_CONTRACT), name);
  }
});
