/**
 * A marketplace that is a Git repository with an APM manifest at its root, and its agents as SFlow workflows
 * [owner, 2026-11-21]. The fixture is a copy of the simulated marketplace (test/fixtures/sdlc-marketplace), trimmed to
 * the product and QA agents and the skills they route to.
 *
 * - The catalog: the root apm.yml's marketplace.packages, each package's own apm.yml read by SFlow (`type: agent` and
 *   the pdlc keys APM 0.35 drops), at the commit `marketplace add --repo` pinned, through git.mjs.
 * - agent.md as stages: numbered headings outside fenced code, hard gates, the step-to-skill table.
 * - The QA agent: the channel question at intake, a test design step, a code step for the automation, the Test Case
 *   Review gate as a person's approval, and the evidence step; the product agent; a stage SFlow asks about.
 * - The channel is a Story value: Intake's submission records the person's answer, and each later step is given only
 *   that answer's skills (android gives the android skills, web the web ones), in the imported workflow itself.
 * - The version 4 bundle `workflow import` brings in, which `workflow check --settings` accepts.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { AGENT_TASK_INTENTS, agentInstructions, convertAgent, parseAgentDocument, workflowDefinition } from '../src/agent-workflow.mjs';
import { recordedStoryValues, skillAppliesToStory, storyValueCondition } from '../src/skill-library.mjs';
import { decisionFedBy, decisionInputsHint, normalizeDecisionInputValues, normalizeDecisions } from '../src/workflow-decisions.mjs';
import { normalizeMarketplaces } from '../src/marketplace.mjs';
import { parseMarketplaceManifest, parsePackageManifest } from '../src/marketplace-repository.mjs';
import { STEP_INTENTS } from '../src/phase-roles.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(packageRoot, 'test', 'fixtures', 'sdlc-marketplace');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Market Tester' };
const COMMIT = 'a'.repeat(40);
const MARKET = { id: 'acme', repository: '/srv/acme-marketplace', commit: COMMIT };

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const flow = (root, args) => run(process.execPath, [bin, ...args], root);
const json = (root, args) => JSON.parse(flow(root, [...args, '--json']).stdout);
const refused = (root, args) => {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', env });
  assert.notEqual(result.status, 0, `${args.join(' ')} should be refused:\n${result.stdout}`);
  return `${result.stdout}\n${result.stderr}`;
};

/** A package of the fixture as the catalog reads it, with its document's text. */
async function fixturePackage(source) {
  const own = parsePackageManifest(await readFile(path.join(FIXTURE, source, 'apm.yml'), 'utf8'), { source });
  const name = path.posix.basename(source);
  const document = own.kind === 'agent' ? 'agent.md' : 'SKILL.md';
  return { ...own, name, source, document: `${source}/${document}`, text: await readFile(path.join(FIXTURE, source, document), 'utf8'),
    skills: own.dependencies.map((dependency) => path.posix.basename(dependency.path ?? '')).filter(Boolean) };
}
async function fixtureAgent(name) {
  const agent = await fixturePackage(`agents/${name}`);
  return { agent, skills: await Promise.all(agent.skills.map((skill) => fixturePackage(`skills/${skill}`))) };
}

test('the catalog is what each apm.yml says: type agent and the pdlc keys APM 0.35 drops, read by SFlow', async () => {
  const manifest = parseMarketplaceManifest(await readFile(path.join(FIXTURE, 'apm.yml'), 'utf8'));
  assert.equal(manifest.name, 'sdlc-marketplace');
  assert.equal(manifest.owner, 'Acme Retail Engineering Enablement');
  assert.deepEqual(manifest.packages.slice(0, 2).map(({ name, source, includePrerelease }) => [name, source, includePrerelease]),
    [['product-agent', 'agents/product-agent', true], ['qa-test-automation-agent', 'agents/qa-test-automation-agent', true]]);
  assert.equal(manifest.packages.length, 9);
  const qa = parsePackageManifest(await readFile(path.join(FIXTURE, 'agents/qa-test-automation-agent/apm.yml'), 'utf8'), { source: 'agents/qa-test-automation-agent' });
  assert.deepEqual([qa.type, qa.kind, qa.version, qa.lifecycleState], ['agent', 'agent', '1.0.0-pdlc', 'proposed']);
  assert.deepEqual(qa.pdlcPhases, ['elaboration', 'delivery']);
  assert.deepEqual(qa.pdlcTasks, ['test-case-creation', 'e2e-testing', 'ui-test-automation', 'unit-testing']);
  assert.ok(qa.tags.includes('multi-channel'));
  assert.deepEqual(qa.dependencies.map((dependency) => dependency.path), ['skills/web-xray-creation', 'skills/android-xray-creation',
    'skills/web-e2e-test-generation', 'skills/android-ui-test-creation', 'skills/android-unit-test']);
  // A dependency that leaves the repository is refused, never followed.
  assert.throws(() => parsePackageManifest('name: x\ntype: agent\ndependencies:\n  apm: [../../../outside]\n', { source: 'agents/x' }), /outside the repository/u);
  assert.throws(() => parseMarketplaceManifest('name: plain\n'), { code: 'MARKETPLACE_REPOSITORY_NOT_MARKETPLACE' });
  // Every task of the marketplace's taxonomy says what a step doing it is for.
  const taxonomy = YAML.parse(await readFile(path.join(FIXTURE, 'registry/pdlc-taxonomy.yml'), 'utf8'));
  for (const task of taxonomy['pdlc-tasks']) assert.ok(STEP_INTENTS.includes(AGENT_TASK_INTENTS[task.name]?.intent), task.name);
});

test('a repository marketplace pins its commit, has no allowed origins, and is a repository or an index, never both', () => {
  const pinned = normalizeMarketplaces({ acme: { label: 'Acme', repository: 'https://git.example.com/acme/sdlc-marketplace.git', ref: 'main', commit: COMMIT } }).acme;
  assert.deepEqual({ ...pinned }, { id: 'acme', label: 'Acme', repository: 'https://git.example.com/acme/sdlc-marketplace.git', ref: 'main', commit: COMMIT, allowedOrigins: [] });
  assert.equal(normalizeMarketplaces({ acme: { repository: '/srv/marketplace', commit: COMMIT } }).acme.ref, null);
  assert.equal(normalizeMarketplaces({ acme: { repository: 'git@git.example.com:acme/market.git', commit: COMMIT } }).acme.repository, 'git@git.example.com:acme/market.git');
  assert.throws(() => normalizeMarketplaces({ acme: { repository: '/srv/marketplace' } }), /must pin the commit/u);
  assert.throws(() => normalizeMarketplaces({ acme: { repository: '/srv/marketplace', commit: COMMIT, index: 'https://catalog.example.org/i.json' } }), /not both/u);
  assert.throws(() => normalizeMarketplaces({ acme: { repository: 'relative/folder', commit: COMMIT } }), /absolute folder path/u);
  const userInfoRemote = `https://user:${['pass', 'word'].join('')}@git.example.com/acme/market.git`;
  assert.throws(() => normalizeMarketplaces({ acme: { repository: userInfoRemote, commit: COMMIT } }), /no password/u);
  assert.throws(() => normalizeMarketplaces({ acme: { repository: 'file:///srv/marketplace', commit: COMMIT } }), /https or ssh/u);
});

test('agent.md as stages: numbered headings outside fenced code, its hard gates and its step-to-skill table', async () => {
  const parsed = parseAgentDocument(await readFile(path.join(FIXTURE, 'agents/qa-test-automation-agent/agent.md'), 'utf8'));
  assert.equal(parsed.title, 'QA Test Automation Agent');
  assert.deepEqual(parsed.stages.map((stage) => [stage.number, stage.title]), [[0, 'Channel Selection'], [1, 'Intake'], [2, 'Test Case Creation'],
    [3, 'Test Case Review'], [4, 'Test Automation'], [5, 'Unit Test Gap Fill'], [6, 'Execution and Evidence']]);
  // The Output Format's `## QA Automation Summary` and its `###` headings are inside a code fence: not sections.
  assert.deepEqual(Object.keys(parsed.sections), ['Role', 'Channel Skill Path Resolution', 'Rules', 'Output Format']);
  const [gate, , , review, , optional] = parsed.stages;
  assert.equal(gate.hardGate, true);
  assert.deepEqual(gate.questions, [{ question: 'Which channel is this test automation for?', choices: ['web', 'android'], name: 'channel' }]);
  assert.deepEqual([review.hardGate, review.approvalGate], [true, true]);
  assert.deepEqual([optional.optional, optional.conditions], [true, ['android']]);
  assert.deepEqual(parsed.skillTable.options, ['web', 'android']);
  assert.deepEqual(parsed.skillTable.rows, [
    { step: 'Test Case Creation', skills: { web: ['web-xray-creation'], android: ['android-xray-creation'] } },
    { step: 'Test Automation', skills: { web: ['web-e2e-test-generation'], android: ['android-ui-test-creation'] } }]);
  // Fences of either kind, of any length, hide headings until they close with the same mark.
  const fenced = parseAgentDocument([
    '# Fenced', '', '## 1. Intake', 'Collect the request.', '', '````markdown', '## 2. Not a stage', '```', '## 3. Still not', '````', '',
    '~~~', '## 4. Nor this', '~~~', '', '## 2. Write It Down', 'Write the document.', ''].join('\n'));
  assert.deepEqual(fenced.stages.map((stage) => `${stage.number}. ${stage.title}`), ['1. Intake', '2. Write It Down']);
});

test('the QA agent: the channel at intake, a test design step, a code step for the automation, a person\'s review gate, the evidence', async () => {
  const { agent, skills } = await fixtureAgent('qa-test-automation-agent');
  const conversion = convertAgent({ marketplace: MARKET, agent, skills });
  assert.equal(conversion.ready, true);
  assert.deepEqual([conversion.workflow.id, conversion.workflow.label, conversion.agent.id], ['qa-test-automation', 'QA Test Automation', 'qa-test-automation-agent']);
  assert.deepEqual(conversion.steps.map((step) => [step.id, step.intent]), [
    ['qa-test-automation-intake', 'intake'], ['qa-test-automation-test-case-creation', 'requirements'],
    ['qa-test-automation-test-automation', 'code'], ['qa-test-automation-execution-and-evidence', 'test']]);
  // The hard gate before the first stage is the person's question at intake, with its two answers.
  assert.deepEqual(conversion.questions.map(({ id, choices, from }) => [id, choices, from]), [['channel', ['web', 'android'], '0. Channel Selection']]);
  const [intake, design, automation, evidence] = conversion.steps;
  assert.match(intake.why, /"intake", and it is the first step/u);
  // Test Case Creation is a test design document, from its skills' task; the Test Case Review gate is its person approval.
  assert.equal(design.confidence, 'certain');
  assert.match(design.why, /test-case-creation is requirements: a test design document/u);
  assert.deepEqual(design.skills, [{ skill: 'web-xray-creation', use: 'when channel is web' }, { skill: 'android-xray-creation', use: 'when channel is android' }]);
  assert.deepEqual(design.personApproval, { gate: '3. Test Case Review', derived: 'it is the plan' });
  assert.equal(design.because, undefined, 'the plan is a person\'s already: no setting is kept against the profile');
  // Test automation is code (tests are its code); the optional android unit tests run inside it.
  assert.match(automation.why, /e2e-testing is code: it writes tests into the repository/u);
  assert.deepEqual(automation.folded, [{ number: 5, title: 'Unit Test Gap Fill' }]);
  assert.deepEqual(automation.skills.map((entry) => entry.skill), ['web-e2e-test-generation', 'android-ui-test-creation', 'android-unit-test']);
  assert.match(automation.skills[2].use, /^when channel is android, only when step 5, Unit Test Gap Fill, is needed$/u);
  assert.match(evidence.why, /comes after the last code step/u);
  const { phases, workType } = workflowDefinition(conversion);
  assert.deepEqual(Object.values(phases).map((phase) => phase.intent), ['intake', 'requirements', 'code', 'test']);
  assert.deepEqual(phases['qa-test-automation-intake'].clarification, { topics: ['Which channel is this test automation for? Choose one: web, android (recorded as channel).'] });
  for (const phase of Object.values(phases)) assert.deepEqual(Object.keys(phase).filter((key) => ['writeScope', 'generation', 'approval', 'repositoryTests'].includes(key)), [], 'the intent gives every setting');
  assert.deepEqual(workType.phases, conversion.steps.map((step) => step.id));

  // The channel is a Story value: a decision after Intake records the person's answer at its submission, and every
  // route goes on to the next step, so the answer chooses skills and never skips a step.
  assert.deepEqual(conversion.storyValue, { name: 'channel', question: 'Which channel is this test automation for?', values: ['web', 'android'],
    step: 'qa-test-automation-intake', decision: 'channel', tableSection: 'Channel Skill Path Resolution' });
  assert.deepEqual(workType.decisions, [{ id: 'channel', after: 'qa-test-automation-intake', kind: 'branch', label: 'Which channel is this test automation for?',
    inputs: [{ name: 'channel', label: 'Which channel is this test automation for?', values: ['web', 'android'] }],
    routes: [{ id: 'web', label: 'web', when: { channel: 'web' }, to: 'next' }, { id: 'android', label: 'android', to: 'next' }] }]);
  const [decision] = normalizeDecisions(workType.decisions, { workTypeId: 'qa-test-automation',
    phases: conversion.steps.map((step) => ({ id: step.id, label: step.label, approval: { mode: 'required', authorities: [] } })) });
  assert.deepEqual(decision.routes.map((route) => route.to), ['next', 'next']);
  assert.equal(decisionInputsHint(decision), '--decision channel=<web|android>');
  // Every skill the table ties to an answer reads it in the form a Story value is read in.
  assert.deepEqual([...design.skills, ...automation.skills].map((entry) => [entry.skill, storyValueCondition(entry.use)?.values ?? null]),
    [['web-xray-creation', ['web']], ['android-xray-creation', ['android']], ['web-e2e-test-generation', ['web']], ['android-ui-test-creation', ['android']], ['android-unit-test', ['android']]]);
  // The agent's instructions name the Story value, and its table of both channels' skill paths is SFlow's line instead.
  const instructions = agentInstructions(conversion, agent.text);
  assert.match(instructions, /SFlow records the answer to "Which channel is this test automation for\?" as the Story value channel when Intake is submitted/u);
  assert.match(instructions, /## Channel Skill Path Resolution\n\nSFlow resolves each step's skill from the Story value channel: the step is given only the skill for the recorded answer\./u);
  assert.doesNotMatch(instructions, /\| Test Case Creation \| `skills\/web-xray-creation\/` \|/u, 'no table of both channels\' paths');
  assert.match(instructions, /## 1\. Intake/u, 'the stages stay as written');
});

test('a skill tied to one answer applies once the Story records another answer only if it is that answer', () => {
  assert.deepEqual(storyValueCondition('when channel is web or when channel is android'), { name: 'channel', values: ['web', 'android'] });
  assert.deepEqual(storyValueCondition('When channel is android, only when step 5, Unit Test Gap Fill, is needed'), { name: 'channel', values: ['android'] });
  for (const free of ['', 'After you write the code, before you publish it', 'only when step 5, Unit Test Gap Fill, is needed', 'when channel is web or when size is big']) {
    assert.equal(storyValueCondition(free), null, free);
  }
  assert.equal(skillAppliesToStory('when channel is web', { channel: 'android' }), false);
  assert.equal(skillAppliesToStory('when channel is web', { channel: 'Web' }), true);
  assert.equal(skillAppliesToStory('when channel is web', {}), true, 'not recorded yet: the skill stays, with its condition in words');
  assert.equal(skillAppliesToStory('Before you publish', { channel: 'android' }), true, 'a skill that names no value is unchanged');
  const decision = { id: 'channel', after: 'intake', inputs: [{ name: 'channel', type: 'choice', values: ['web', 'android'] }] };
  const workflow = { resolution: { decisions: [decision] }, phases: { intake: { decisionInputs: { decision: 'channel', values: normalizeDecisionInputValues(decision, { channel: 'ANDROID' }) } } } };
  assert.deepEqual(recordedStoryValues(workflow), { channel: 'android' });
  assert.deepEqual(recordedStoryValues({ ...workflow, phases: { intake: { decisionInputs: { decision: 'another', values: { channel: 'web' } } } } }), {}, 'only this round\'s own decision counts');
});

test('the product agent, and a stage SFlow cannot classify gets the one plain question, never a guess', async () => {
  const { agent, skills } = await fixtureAgent('product-agent');
  const asked = convertAgent({ marketplace: MARKET, agent, skills });
  assert.equal(asked.ready, false);
  assert.equal(asked.questions.length, 5, 'the five clarifying questions of its first stage');
  assert.equal(asked.storyValue, undefined, 'open questions with no choices stay questions, not Story values');
  assert.deepEqual(asked.steps.slice(0, 4).map((step) => step.intent), ['intake', 'requirements', 'requirements', 'requirements']);
  assert.deepEqual(asked.open.map((entry) => entry.step), ['product-traceability-check', 'product-hand-off']);
  const [traceability, handoff] = asked.open;
  assert.equal(traceability.question, 'What does "Traceability Check" do?');
  assert.deepEqual(traceability.choices.map((choice) => choice.intent), ['test', 'review', 'requirements', 'document']);
  assert.ok(handoff.choices.some((choice) => choice.intent === 'report'), 'the last step of a workflow that changes no code leans to report');
  assert.equal(handoff.choices.at(-1).label, 'Something else: any other document (document)');
  assert.throws(() => workflowDefinition(asked), { code: 'AGENT_WORKFLOW_OPEN' });
  assert.throws(() => convertAgent({ marketplace: MARKET, agent, skills, answers: { 'product-hand-off': 'shipping' } }), { code: 'AGENT_WORKFLOW_ANSWER_INVALID' });
  assert.throws(() => convertAgent({ marketplace: MARKET, agent, skills, answers: { 'product-nothing': 'report' } }), { code: 'AGENT_WORKFLOW_ANSWER_INVALID' });
  const answered = convertAgent({ marketplace: MARKET, agent, skills, answers: { 'product-traceability-check': 'review', 'product-hand-off': 'report' } });
  assert.equal(answered.ready, true);
  assert.deepEqual(answered.steps.slice(4).map((step) => [step.intent, step.source]), [['review', 'person'], ['report', 'person']]);
  // The Requirements Review gate is the person's approval of the requirements: the scope of a workflow that changes no code.
  assert.deepEqual(answered.steps[1].personApproval, { gate: '3. Requirements Review', derived: 'it sets the scope of a workflow that changes no code' });
  // A stage whose name and words say nothing is asked about too.
  const text = (await readFile(path.join(FIXTURE, 'agents/product-agent/agent.md'), 'utf8'))
    .replace(/## 4\. User Stories[\s\S]*?(?=## 5\.)/u, '## 4. Sync With The Team\n\nMeet the team and agree who does what next.\n\n');
  const sync = convertAgent({ marketplace: MARKET, agent: { ...agent, text }, skills });
  const entry = sync.open.find((item) => item.step === 'product-sync-with-the-team');
  assert.ok(entry, JSON.stringify(sync.open));
  assert.ok(entry.choices.length >= 2 && entry.choices.at(-1).intent === 'document');
});

test('marketplace add --repo, browse at the pinned commit, and workflow from-agent to a version 4 workflow that workflow check --settings accepts', async () => {
  // The marketplace: a Git repository holding the fixture.
  const market = await mkdtemp(path.join(os.tmpdir(), 'sflow-mkt-'));
  await cp(FIXTURE, market, { recursive: true });
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Market Tester'], ['config', 'user.email', 'market@example.com'], ['add', '-A'], ['commit', '-m', 'catalog']]) run('git', args, market);
  const pinned = run('git', ['rev-parse', 'HEAD'], market).stdout.trim();
  // The repository that trusts it.
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-mkt-repo-'));
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Market Tester'], ['config', 'user.email', 'market@example.com']]) run('git', args, root);
  await writeFile(path.join(root, 'README.md'), '# Shop\n');
  flow(root, ['init']);
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'initialize'], root);
  try {
    const preview = json(root, ['marketplace', 'add', 'acme', '--repo', market, '--dry-run']);
    assert.equal(preview.valid, true, JSON.stringify(preview.problems));
    assert.equal(YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8')).marketplaces, undefined, 'a dry run writes nothing');
    flow(root, ['marketplace', 'add', 'acme', '--repo', market]);
    const workflow = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
    assert.deepEqual(workflow.marketplaces.acme, { label: 'sdlc-marketplace', repository: market, commit: pinned });
    run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'trust the marketplace'], root);
    assert.match(flow(root, ['marketplace', 'list']).stdout, new RegExp(`^acme: sdlc-marketplace — ${market.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} at ${pinned.slice(0, 12)}$`, 'mu'));

    // The marketplace moves on; the repository still reads the commit it trusts.
    await rm(path.join(market, 'agents', 'product-agent'), { recursive: true });
    run('git', ['add', '-A'], market); run('git', ['commit', '-m', 'retire the product agent'], market);
    const browsed = json(root, ['marketplace', 'browse', 'acme']);
    assert.equal(browsed.marketplace.commit, pinned);
    assert.deepEqual(browsed.entries.filter((entry) => entry.kind === 'agent').map((entry) => entry.name), ['product-agent', 'qa-test-automation-agent']);
    const qa = browsed.entries.find((entry) => entry.name === 'qa-test-automation-agent');
    assert.deepEqual({ type: qa.type, version: qa.version, lifecycleState: qa.lifecycleState, pdlcPhases: qa.pdlcPhases, skills: qa.skills },
      { type: 'agent', version: '1.0.0-pdlc', lifecycleState: 'proposed', pdlcPhases: ['elaboration', 'delivery'],
        skills: ['web-xray-creation', 'android-xray-creation', 'web-e2e-test-generation', 'android-ui-test-creation', 'android-unit-test'] });
    assert.deepEqual(json(root, ['marketplace', 'browse', 'acme', '--kind', 'skill', '--search', 'xray']).entries.map((entry) => entry.name), ['web-xray-creation', 'android-xray-creation']);
    assert.match(flow(root, ['marketplace', 'browse', 'acme', '--kind', 'agent']).stdout, /As a workflow: singularity-flow workflow from-agent acme\/qa-test-automation-agent$/mu);
    // Trusting the newer commit is the same command again: it moves the pin, as a reviewed change.
    const moved = json(root, ['marketplace', 'add', 'acme', '--repo', market, '--dry-run']);
    assert.equal(moved.valid, true, JSON.stringify(moved.problems));
    assert.ok(moved.summary.some((line) => line.startsWith(`Marketplace sdlc-marketplace is now read at ${run('git', ['rev-parse', 'HEAD'], market).stdout.trim().slice(0, 12)}`)), moved.summary.join('\n'));
    // A repository marketplace has no index of files to import one by one, and says where to go instead.
    assert.match(refused(root, ['import', 'preview', 'market:acme/web-xray-creation']), /MARKETPLACE_REPOSITORY_NOT_INDEX|singularity-flow marketplace browse acme/u);

    // A stage SFlow asks about: nothing is written, and each answer is a whole command.
    const open = refused(root, ['workflow', 'from-agent', 'acme/product-agent', '--out', 'product.json']);
    assert.match(open, /What does "Traceability Check" do\?/u);
    assert.match(open, /singularity-flow workflow from-agent acme\/product-agent --answer product-traceability-check=review --out product\.json/u);

    // The QA agent as a bundle, imported into a version 4 workflow.yml, where workflow check --settings accepts it.
    const shown = json(root, ['workflow', 'from-agent', 'acme/qa-test-automation-agent']);
    assert.equal(shown.ready, true);
    assert.match(shown.workflowYaml, /^version: 4$/mu);
    // The channel decision follows Intake, so a person approves Intake: the workflow rule for a step a decision reads.
    assert.deepEqual(shown.derived.map((step) => [step.intent, step.changesSource, step.approval]), [
      ['intake', false, 'person'], ['requirements', false, 'person'], ['code', true, 'person'], ['test', false, 'sflow-when-clean']]);
    const out = path.join(root, 'qa.workflow.json');
    flow(root, ['workflow', 'from-agent', 'acme/qa-test-automation-agent', '--out', out]);
    const file = path.join(root, 'singularity', 'workflow.yml');
    const document = YAML.parseDocument(await readFile(file, 'utf8'));
    document.set('version', 4);
    await writeFile(file, document.toString());
    run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'version 4'], root);
    const plan = json(root, ['workflow', 'import', out, '--dry-run']);
    assert.equal(plan.status, 'ready', JSON.stringify(plan.unresolved ?? plan));
    // The plan's template already has its planned-claims table: the import has nothing to repair.
    assert.deepEqual(plan.repairs ?? [], []);
    flow(root, ['workflow', 'import', out, '--confirm', plan.planSha256]);
    run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'import the QA workflow'], root);
    const check = json(root, ['workflow', 'check', 'qa-test-automation', '--settings']);
    assert.equal(check.configuration.valid, true);
    const [checked] = check.workflows;
    assert.deepEqual(checked.findings.filter((finding) => finding.severity === 'problem'), []);
    assert.equal(checked.settings.derives, true);
    assert.deepEqual(checked.settings.steps.map((step) => step.intent?.value), ['intake', 'requirements', 'code', 'test']);
    const setting = (step, key) => checked.settings.steps.find((entry) => entry.id === step).settings.find((entry) => entry.key === key);
    assert.deepEqual([setting('qa-test-automation-execution-and-evidence', 'repositoryTests').value, setting('qa-test-automation-execution-and-evidence', 'testEvidenceFrom').value],
      ['run', 'qa-test-automation-test-automation']);
    // The agent drafts every step, with each skill attached where its stage uses it.
    const agentText = await readFile(path.join(root, 'singularity/agents/qa-test-automation-agent.agent.md'), 'utf8');
    assert.match(agentText, /SFlow runs the numbered stages below as the steps of the QA Test Automation workflow/u);
    assert.match(agentText, /\| web-xray-creation \|[^\n]*qa-test-automation-test-case-creation[^\n]*when channel is web/u);
    assert.match(flow(root, ['workflow', 'from-agent', 'acme/qa-test-automation-agent']).stdout,
      /The answer is the Story value channel, recorded when Intake is submitted \(--decision channel=<web\|android>\); each later step is given only the skills for that answer\./u);

    // In the imported workflow: Intake's submission records the person's channel, and each later step is given that
    // channel's skills only. Choosing android gives the android skills; choosing web gives the web skills.
    const [{ loadDefinition, resolveWorkType }, { renderAgentSkills }] = await Promise.all([import('../src/config.mjs'), import('../src/agents.mjs')]);
    const imported = resolveWorkType(await loadDefinition(root), 'qa-test-automation');
    const recording = decisionFedBy({ resolution: { decisions: imported.decisions } }, 'qa-test-automation-intake');
    assert.ok(recording, 'Intake records the channel when it is submitted');
    const storyOn = (channel) => ({ workItem: { id: 'QA-1', workType: 'qa-test-automation' }, resolution: { decisions: imported.decisions },
      phases: { 'qa-test-automation-intake': channel ? { decisionInputs: { schemaVersion: 1, decision: recording.id, values: normalizeDecisionInputValues(recording, { channel }) } } : {} } });
    const skillsAt = async (channel, step) => (await renderAgentSkills(root, storyOn(channel), { id: `qa-test-automation-${step}` }, { agent: 'qa-test-automation-agent' })).skills.map((entry) => entry.id).sort();
    assert.deepEqual(await skillsAt('android', 'test-case-creation'), ['android-xray-creation']);
    assert.deepEqual(await skillsAt('android', 'test-automation'), ['android-ui-test-creation', 'android-unit-test']);
    assert.deepEqual(await skillsAt('web', 'test-case-creation'), ['web-xray-creation']);
    assert.deepEqual(await skillsAt('web', 'test-automation'), ['web-e2e-test-generation']);
    const androidPrompt = (await renderAgentSkills(root, storyOn('android'), { id: 'qa-test-automation-test-case-creation' }, { agent: 'qa-test-automation-agent' })).text;
    assert.match(androidPrompt, /`android-xray-creation`/u);
    assert.doesNotMatch(androidPrompt, /web-xray-creation/u, 'the step sees the chosen skill, not both');
    // Before Intake records it, both stay, each with its condition in words.
    assert.deepEqual(await skillsAt(null, 'test-case-creation'), ['android-xray-creation', 'web-xray-creation']);

    // --propose: the bundle in SFlow's private folder, and its import as a configuration proposal, ready to confirm.
    const proposed = json(root, ['workflow', 'from-agent', 'acme/product-agent', '--answer', 'product-traceability-check=review', '--answer', 'product-hand-off=report', '--propose']);
    assert.equal(proposed.importPlan.status, 'ready');
    assert.ok(path.isAbsolute(proposed.bundlePath) && !proposed.bundlePath.startsWith(root));
  } finally {
    await rm(market, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
