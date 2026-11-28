/**
 * What the team already has, before the marketplace (docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md REQ-020, with REQ-010, REQ-011,
 * A2, A4, A8): a task's plan offers the team's own workflow first, then an agent the repository has (installed by APM or
 * kept in .github/agents), then a marketplace agent, one offer the same way every time; the yes runs the team's workflow
 * exactly as it is; a `tasks.use` rule still wins; a deprecated or retired item is never offered. Skills come from the
 * library, then the repository's own (.github/skills, and .agents/skills where APM installs them), then a marketplace; a
 * broken one is a note and never stops the task. The fixture repository is made here from test/fixtures/sdlc-marketplace
 * (APM's copy of the package in apm_modules): no network, no APM.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

import { validateDefinition } from '../src/config.mjs';
import { readAgentFolder } from '../src/agent-folder.mjs';
import { convertAgent } from '../src/agent-workflow.mjs';
import { parsePackageManifest } from '../src/marketplace-repository.mjs';
import { taskPlan } from '../src/commands/work.mjs';
import { agentPlanCandidate, chooseTaskAgent, taskAgentFinder } from '../src/task-agents.mjs';
import { composeTask, taskClosureWorkTypes, taskDefinition } from '../src/task-composition.mjs';
import { localAgentCandidate, localPlanCandidates, localSkills } from '../src/task-local.mjs';
import { chooseTaskSkills, librarySkillCandidate, localSkillCandidate, marketplaceSkillCandidate, taskSkillChooser } from '../src/task-skills.mjs';
import { journeyRepository, storyRecord } from './helpers/route-follower.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = YAML.parse(readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
const FIXTURE = path.join(ROOT, 'test/fixtures/sdlc-marketplace');
const MODULE = 'apm_modules/acme/sdlc-marketplace';
const QA_FOLDER = `${MODULE}/agents/qa-test-automation-agent`;
const ACME = Object.freeze({ id: 'acme', repository: '/srv/acme-marketplace', commit: 'a'.repeat(40) });
const WEB_PACKAGE = JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' }, dependencies: { react: '^18.3.1' } });
const AGENT = '.github/agents/qa-test-automation-agent.agent.md';
const E2E = '.agents/skills/web-e2e-test-generation/SKILL.md';
const XRAY = '.agents/skills/web-xray-creation/SKILL.md';

const skillText = (id, tags) => ['---', `name: ${id}`, `description: The ${id} skill, for the steps its tags name.`, 'metadata:',
  `  sflow-tags: [${tags.join(', ')}]`, '---', '', `Do what ${id} says, and name what you did.`, ''].join('\n');
const sha = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

/**
 * A team's repository: a skill library (house-style for requirements, unit-checks that its unit-tests workflow attaches to
 * its code step), its own Copilot skills (one broken, one the library also has), and APM's install of acme's QA agent:
 * the package in apm_modules, its agent and two skills put in .github and .agents (one edited since), and apm.lock.yaml.
 */
async function teamRepository(t) {
  const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'sflow-task-local-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (relative, text) => { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), text); };
  await write('package.json', WEB_PACKAGE);
  await write('singularity/skill-library/house-style/SKILL.md', skillText('house-style', ['task:requirements-analysis', 'web']));
  await write('singularity/skill-library/unit-checks/SKILL.md', skillText('unit-checks', ['task:unit-testing']));
  await write('singularity/skill-library/attachments.yml', YAML.stringify({ attachments: [{ skill: 'unit-checks', workflow: 'unit-tests', steps: ['implementation'] }] }));
  // A workflow a marketplace agent's import made: REQ-011 offers it by the agent's name, never as the team's own.
  await write('singularity/imports.lock.yml', YAML.stringify({ version: 1, imports: { 'workflow:qa-import': { kind: 'workflow',
    source: { kind: 'marketplace-agent', marketplace: 'acme', agent: 'qa-test-automation-agent' }, workflow: 'qa-import' } } }));
  await write('.github/skills/web-smoke/SKILL.md', skillText('web-smoke', ['task:e2e-testing', 'web']));
  await write('.github/skills/house-style/SKILL.md', skillText('house-style', ['task:e2e-testing', 'web']));
  await write('.github/skills/broken-skill/SKILL.md', '---\nname: broken-skill\n---\n\nNo description.\n');
  await cp(FIXTURE, path.join(root, MODULE), { recursive: true });
  const agentText = readFileSync(path.join(FIXTURE, 'agents/qa-test-automation-agent/agent.md'), 'utf8');
  const e2eText = readFileSync(path.join(FIXTURE, 'skills/web-e2e-test-generation/SKILL.md'), 'utf8');
  const xrayText = readFileSync(path.join(FIXTURE, 'skills/web-xray-creation/SKILL.md'), 'utf8');
  await write(AGENT, agentText);
  await write(E2E, e2eText);
  await write(XRAY, `${xrayText}\nEdited here.\n`);
  await write('apm.lock.yaml', YAML.stringify({ lockfile_version: '1', apm_version: '0.35.0', dependencies: [{ repo_url: 'acme/sdlc-marketplace',
    name: 'qa-test-automation-agent', version: '1.0.0-pdlc', deployed_files: [E2E, XRAY, AGENT],
    deployed_file_hashes: { [E2E]: sha(e2eText), [XRAY]: sha(xrayText), [AGENT]: sha(agentText) } }] }));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Team', '-c', 'user.email=team@example.com', ...args], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  };
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'The team\'s repository');
  return root;
}

/** The packaged workflows and the team's own: made in Workflow Studio, from an agent folder, and one a marketplace agent made. */
function teamDefinition(tasks = undefined) {
  const definition = structuredClone(BASE);
  definition.workTypes['secure-fix'] = { label: 'Secure fix', phases: ['intake', 'implementation', 'verification'] };
  definition.workTypes['reviewed-fix'] = { label: 'Reviewed fix', phases: ['intake', 'implementation', 'verification', 'conformance'] };
  definition.workTypes['unit-tests'] = { label: 'Unit tests', phases: ['intake', 'implementation', 'verification'] };
  definition.workTypes['api-builder'] = { label: 'API builder', description: 'From folder api-builder: api-builder 1.0.0', phases: ['intake', 'requirements', 'implementation', 'verification'] };
  definition.workTypes['qa-import'] = { label: 'QA imported', phases: ['intake', 'requirements', 'implementation', 'verification'] };
  // The kind's own steps, as v1.1 composed them: what a workflow covers either way (task-agents.mjs offerable).
  definition.tasks = { sizing: 'kind', ...(tasks ?? {}) };
  return validateDefinition(definition);
}

/** acme's QA agent, as a trusted marketplace lists it (task-agents.test.mjs reads it the same way). */
async function marketplaceQa(extra = {}) {
  const manifest = (kind, name) => {
    const own = parsePackageManifest(readFileSync(path.join(FIXTURE, kind, name, 'apm.yml'), 'utf8'), { source: `${kind}/${name}` });
    return { ...own, name, skills: own.dependencies.map((dependency) => path.posix.basename(dependency.path ?? '')).filter(Boolean),
      ...(kind === 'agents' ? { text: readFileSync(path.join(FIXTURE, kind, name, 'agent.md'), 'utf8') } : {}) };
  };
  const skills = ['web-e2e-test-generation', 'web-xray-creation', 'android-xray-creation', 'android-ui-test-creation', 'android-unit-test'].map((name) => manifest('skills', name));
  return agentPlanCandidate({ marketplace: ACME, entry: { ...manifest('agents', 'qa-test-automation-agent'), ...(extra.entry ?? {}) }, skills });
}

/** APM's copy of acme's QA agent, read and converted as `workflow from-agent <FOLDER>` does. */
async function localQa(extra = {}) {
  const read = await readAgentFolder(path.join(FIXTURE, 'agents/qa-test-automation-agent'));
  read.agent = { ...read.agent, ...extra };
  const conversion = convertAgent({ marketplace: null, folder: read.folder, agent: read.agent, skills: read.skills });
  return localAgentCandidate({ read, conversion, path: QA_FOLDER, installed: true, apm: 'acme/sdlc-marketplace' });
}

test('ITW REQ-020: the team\'s own workflows and agents are read with what each step is for; packaged and marketplace-made ones are not', async (t) => {
  const root = await teamRepository(t);
  const { candidates, notes } = await localPlanCandidates(root, teamDefinition());
  assert.deepEqual(candidates.map((entry) => [entry.id, entry.source, entry.ready]), [
    ['api-builder', 'workflow', true], ['reviewed-fix', 'workflow', true], ['secure-fix', 'workflow', true], ['unit-tests', 'workflow', true],
    ['product', 'local-agent', false], ['qa-test-automation', 'local-agent', true]
  ], 'SFlow\'s own workflows (feature, bugfix …) and qa-import, which acme\'s agent made, are not the team\'s own here');
  assert.deepEqual(notes, []);
  // Its code step's attached library skill writes unit tests, so it is a tests workflow.
  const unitTests = candidates.find((entry) => entry.id === 'unit-tests');
  assert.deepEqual(unitTests.steps.map((step) => [step.id, step.intent, step.tasks]), [['intake', 'intake', []], ['implementation', 'code', ['unit-testing']], ['verification', 'test', []]]);
  // Who approves each step, as the workflow says: a rule that gives a person a step SFlow approves here is not kept by it.
  assert.deepEqual(candidates.find((entry) => entry.id === 'reviewed-fix').steps.map((step) => step.approvedBy), ['person', 'person', 'sflow', 'sflow']);
  // APM's copy of the package (with its apm.yml) is read, not the bare agent file APM put in .github/agents.
  const qa = candidates.find((entry) => entry.id === 'qa-test-automation');
  assert.deepEqual([qa.agent, qa.path, qa.installed, qa.apm], ['qa-test-automation-agent', QA_FOLDER, true, 'acme/sdlc-marketplace']);
  assert.deepEqual(qa.steps.map((step) => step.intent), ['intake', 'requirements', 'code', 'test']);
  // The agent file alone in .github/agents reads as its name says, as `workflow from-agent` reads it.
  assert.equal((await readAgentFolder(path.join(root, AGENT))).agent.name, 'qa-test-automation-agent');
  assert.deepEqual(await localPlanCandidates(root, teamDefinition()), { candidates, notes }, 'read twice, the same');
});

test('ITW REQ-020, REQ-108, A2: the team\'s covering workflow is the plan with no question; then a local agent, then a marketplace agent, is offered; the same input gives the same answer', async (t) => {
  const root = await teamRepository(t);
  const definition = teamDefinition();
  const own = (await localPlanCandidates(root, definition)).candidates;
  const workflows = own.filter((entry) => entry.source === 'workflow');
  const local = await localQa();
  const market = await marketplaceQa();
  const answer = (kind, candidates, options = {}) => chooseTaskAgent(composeTask(definition, { kind }), { candidates, ...options });
  const offer = (kind, candidates) => answer(kind, candidates).offer ?? null;
  const used = (kind, candidates) => answer(kind, candidates).chosenWorkflow?.workflow ?? null;
  // A tests task: the team's unit-tests workflow is the plan, with no question; it says why, and its no.
  const tests = answer('tests', [market, local, ...workflows]);
  assert.deepEqual(tests, { chosenWorkflow: { workflow: 'unit-tests', label: 'Unit tests' }, used: {
    id: 'unit-tests', source: 'workflow', workflow: 'unit-tests', label: 'Unit tests', imported: true, state: null, steps: ['Intake', 'Implementation', 'Verification'],
    ask: 'Your team\'s workflow Unit tests covers this task: use it as the plan, exactly as it is, write the tests → tests?',
    why: 'its steps cover every step this task needs (write the tests and tests)',
    yes: '--use-workflow unit-tests', no: '--without-workflow unit-tests', asked: false
  } });
  assert.deepEqual(answer('tests', [...workflows].reverse().concat([local, market])), tests, 'in any order, the same answer');
  // A sized task (v1.2) is covered by the kind's own steps, the same answer.
  const sized = Object.assign(structuredClone(definition), { tasks: {} });
  assert.deepEqual(chooseTaskAgent(composeTask(sized, { kind: 'tests' }), { candidates: [market, local, ...workflows] }), tests);
  const installed = offer('tests', [market, local]);
  assert.deepEqual(installed, {
    id: 'qa-test-automation', source: 'local-agent', workflow: 'qa-test-automation', label: 'QA Test Automation', imported: false,
    agent: 'qa-test-automation-agent', path: QA_FOLDER, version: '1.0.0-pdlc', package: 'acme/sdlc-marketplace', state: 'proposed',
    steps: ['Intake', 'Test Case Creation', 'Test Automation', 'Execution and Evidence'],
    ask: 'Installed agent qa-test-automation-agent covers this task: add its workflow to this repository and use it as the plan, requirements → write the tests → tests (it is marked proposed)?',
    why: 'its stages cover every step this task needs (write the tests and tests)',
    review: `singularity-flow workflow from-agent ${QA_FOLDER} --review`, show: `singularity-flow workflow from-agent ${QA_FOLDER} --propose --json`,
    yes: '--use-workflow qa-test-automation', no: '--without-workflow qa-test-automation'
  });
  assert.equal(offer('tests', [market]).id, 'acme/qa-test-automation-agent', 'with nothing of the team\'s own, the marketplace\'s');
  // Within a group, the fewest steps the task does not need, then by name; a workflow's code is the task's kind of code.
  assert.equal(used('fix', [...workflows, local, market]), 'secure-fix');
  assert.equal(used('feature', [...workflows, local, market]), 'api-builder', 'its requirements step plans the code');
  assert.deepEqual(answer('docs', [...workflows, local, market]), {}, 'a workflow with code never covers a task that changes none');
  // A deprecated or retired item is never offered, the team's agent or the marketplace's.
  const retired = await localQa({ lifecycleState: 'deprecated' });
  assert.equal(retired.lifecycle, 'retired');
  assert.equal(offer('tests', [retired, { ...market, lifecycle: 'retired', state: 'deprecated' }]), null);
  assert.equal(offer('tests', [retired, market]).id, 'acme/qa-test-automation-agent');
  // The no asks nothing more.
  assert.deepEqual(chooseTaskAgent(composeTask(definition, { kind: 'tests' }), { candidates: [...workflows, local, market], withoutWorkflow: ['unit-tests'] }), {});
  // Read from the repository by the finder: the same answer.
  const found = await taskAgentFinder(root, definition)(composeTask(definition, { kind: 'tests' }));
  assert.deepEqual(found, { ...tests, notes: [] });
});

test('ITW REQ-020, A4: the yes runs the team\'s workflow exactly as it is, and no rule of the team\'s is lost', async (t) => {
  const root = await teamRepository(t);
  const definition = teamDefinition();
  const candidates = (await localPlanCandidates(root, definition)).candidates;
  const choose = (useWorkflow, options = {}) => async (composition) => chooseTaskAgent(composition, { candidates, useWorkflow, ...options });
  const chooseSkills = async (composition) => chooseTaskSkills(composition, { candidates: [librarySkillCandidate({ id: 'web-checks', tags: ['task:e2e-testing', 'web'], sha256: 'x' })], kinds: ['web'] });
  const plan = await taskPlan(definition, { kind: 'fix', chooseAgent: choose(['reviewed-fix']), chooseSkills });
  assert.deepEqual(plan.steps.map((step) => step.id), definition.workTypes['reviewed-fix'].phases, 'its steps, in its order, nothing added and none dropped');
  assert.equal(plan.plan, 'Plan, from your team\'s workflow Reviewed fix: code → tests → review. You approve the plan in the intake and the code. Say "add a design step" to change it.');
  assert.deepEqual([plan.composition.workType, plan.composition.uses, plan.composition.local], ['reviewed-fix', 'reviewed-fix', { workflow: 'reviewed-fix', label: 'Reviewed fix' }]);
  assert.deepEqual([plan.composition.added, plan.composition.personApproves, plan.skills], [[], [], []], 'nothing composed into it, no skill chosen for it');
  assert.equal(plan.walk, 'completed');
  assert.equal(taskDefinition(definition, plan.composition), definition, 'the configuration as it is: no composed work type');
  assert.deepEqual(taskClosureWorkTypes(definition, plan.composition), ['reviewed-fix']);
  assert.deepEqual(await taskPlan(definition, { kind: 'fix', chooseAgent: choose(['reviewed-fix']), chooseSkills }), plan, 'the same input, the same plan');
  // A step the person asks to skip that it has stays: the workflow is followed as it is.
  assert.throws(() => composeTask(definition, { kind: 'fix', workflow: { workflow: 'reviewed-fix' }, skip: ['review'] }),
    (error) => error.code === 'TASK_CHANGE_REFUSED' && /followed as it is/u.test(error.message) && /--without-workflow reviewed-fix/u.test(error.details.nextAction.command));
  // A workflow that does not cover the task (it has no design step the person added) is refused with its way on.
  await assert.rejects(taskPlan(definition, { kind: 'fix', add: ['design'], chooseAgent: choose(['reviewed-fix']) }),
    (error) => error.code === 'TASK_AGENT_NOT_COVERING' && Boolean(error.details.nextAction.command));
  // A local agent's yes before its workflow is here names its import through the conversion review.
  assert.throws(() => chooseTaskAgent(composeTask(definition, { kind: 'tests' }), { candidates, useWorkflow: ['qa-test-automation'] }),
    (error) => error.code === 'TASK_AGENT_IMPORT_NEEDED' && error.details.nextAction.command === `singularity-flow workflow from-agent ${QA_FOLDER} --propose`);
  // A workflow a marketplace agent made is said yes to by the agent's name; one that is nowhere is refused.
  const market = await marketplaceQa();
  market.imported = { workflow: 'qa-import', commit: ACME.commit, version: '1.0.0-pdlc' };
  assert.throws(() => chooseTaskAgent(composeTask(definition, { kind: 'tests' }), { candidates: [...candidates, market], useWorkflow: ['qa-import'] }),
    (error) => error.code === 'TASK_WORKFLOW_UNKNOWN' && /--use-agent acme\/qa-test-automation-agent/u.test(error.message));
  assert.throws(() => chooseTaskAgent(composeTask(definition, { kind: 'fix' }), { candidates, useWorkflow: ['feature'] }),
    (error) => error.code === 'TASK_WORKFLOW_UNKNOWN' && error.details.nextAction.command === 'singularity-flow workflow list', 'SFlow\'s own workflows are not offered');
  // The team's rules add to the team's workflow [ITW:REQ-107]: the one with the fewest steps the task does not need is the
  // plan, and the rule's step goes where its intent goes; a step the workflow has is not added twice.
  const reviewed = teamDefinition({ always: [{ kinds: ['fix'], steps: ['review'], because: 'Every fix is reviewed.' }] });
  const ruled = (await localPlanCandidates(root, reviewed)).candidates;
  const chosen = chooseTaskAgent(composeTask(reviewed, { kind: 'fix' }), { candidates: ruled }).chosenWorkflow;
  assert.equal(chosen.workflow, 'secure-fix', 'the rule adds the review secure-fix lacks');
  const secure = composeTask(reviewed, { kind: 'fix', workflow: chosen });
  assert.deepEqual(secure.steps.map((step) => step.id), ['intake', 'implementation', 'verification', 'conformance']);
  assert.deepEqual([secure.workType, secure.uses, secure.local], ['task-fix', undefined, { workflow: 'secure-fix', label: 'Secure fix' }]);
  assert.deepEqual(secure.added, [{ intent: 'review', rule: 'always[0]', because: 'Every fix is reviewed.' }]);
  assert.equal(taskClosureWorkTypes(reviewed, secure)[0], 'secure-fix', 'the Story\'s branch carries the team\'s workflow and the step the rule brings');
  assert.equal((await taskPlan(reviewed, { kind: 'fix', chooseAgent: choose(['secure-fix']) })).walk, 'completed');
  const twice = composeTask(reviewed, { kind: 'fix', workflow: { workflow: 'reviewed-fix' } });
  assert.deepEqual([twice.steps.map((step) => step.id), twice.workType, twice.uses], [['intake', 'implementation', 'verification', 'conformance'], 'reviewed-fix', 'reviewed-fix'],
    'a workflow that has the rule\'s step runs exactly as it is');
  const personal = teamDefinition({ always: [{ kinds: ['fix'], steps: ['review'], personApproves: ['review'], because: 'A person reads every fix\'s review.' }] });
  const theirs = composeTask(personal, { kind: 'fix', workflow: { workflow: 'reviewed-fix' } });
  assert.deepEqual([theirs.workType, theirs.personApproves], ['task-fix', ['review']], 'the rule gives the workflow\'s own review to a person');
  const resolved = (await taskPlan(personal, { kind: 'fix', chooseAgent: choose(['reviewed-fix']) })).steps;
  assert.equal(resolved.find((step) => step.id === 'conformance').approvedBy, 'person');
});

test('ITW REQ-020, A8: a `tasks.use` rule still wins over the team\'s other workflows and its agents', async (t) => {
  const root = await teamRepository(t);
  const used = teamDefinition({ use: { fix: 'bugfix', tests: 'chore' } });
  const { candidates } = await localPlanCandidates(root, used);
  const composition = composeTask(used, { kind: 'fix' });
  assert.equal(composition.uses, 'bugfix');
  assert.deepEqual(chooseTaskAgent(composition, { candidates }), {});
  assert.deepEqual(await taskAgentFinder(root, used)(composition), { notes: [] }, 'nothing of the team\'s own is read');
  assert.throws(() => chooseTaskAgent(composition, { candidates, useWorkflow: ['secure-fix'] }),
    (error) => error.code === 'TASK_AGENT_NOT_COVERING' && /runs every fix task as its bugfix workflow/u.test(error.message));
  assert.throws(() => composeTask(used, { kind: 'fix', workflow: { workflow: 'secure-fix' } }), (error) => error.code === 'TASK_AGENT_NOT_COVERING');
  assert.deepEqual((await localPlanCandidates(root, teamDefinition({ use: { tests: 'unit-tests' } }))).candidates.some((entry) => entry.id === 'unit-tests'), true,
    'the workflow a rule names stays the team\'s own');
});

test('ITW REQ-020, REQ-010: skills come from the library, then the repository\'s own and APM\'s, then a marketplace; a broken one never stops the task', async (t) => {
  const root = await teamRepository(t);
  const definition = teamDefinition();
  const read = await localSkills(root, { libraryIds: new Set(['house-style', 'unit-checks']) });
  assert.deepEqual(read.skills.map(({ skill, path: where, apm, own }) => [skill.id, where, apm, own?.pdlcTasks ?? null]), [
    ['web-smoke', '.github/skills/web-smoke/SKILL.md', null, null],
    ['web-e2e-test-generation', E2E, 'acme/sdlc-marketplace', ['e2e-testing', 'ui-test-automation']]
  ], 'the library\'s house-style is the library\'s; APM\'s copy of the package says what its skill is for');
  assert.deepEqual(read.notes, [
    'Skill broken-skill (.github/skills/broken-skill/SKILL.md) is not used: Skill \'broken-skill\' needs a description of what it does and when to use it. To use it, correct .github/skills/broken-skill/SKILL.md.',
    `Skill web-xray-creation (${XRAY}) is not used: it changed since APM installed it. To use it, run apm install, which puts it back as APM installed it.`
  ]);
  // The chooser: a fix's code step gets the repository's own skills; a feature's requirements step the library's.
  const fix = await taskSkillChooser(root, definition, { words: 'fix the login button' })(composeTask(definition, { kind: 'fix' }));
  assert.deepEqual(fix.skills.map(({ id, steps, path: where, from, package: owner }) => [id, steps, where, from, owner ?? null]), [
    ['web-e2e-test-generation', ['implementation'], E2E, 'apm', 'acme/sdlc-marketplace'],
    ['web-smoke', ['implementation'], '.github/skills/web-smoke/SKILL.md', 'repository', null]
  ]);
  assert.match(fix.skills[1].why, /it is this repository's own \(\.github\/skills\/web-smoke\/SKILL\.md\)$/u);
  assert.deepEqual(fix.notes, read.notes, 'the broken skills are named, and the plan goes on');
  const feature = await taskSkillChooser(root, definition)(composeTask(definition, { kind: 'feature' }));
  assert.deepEqual(feature.skills.map(({ id, steps, path: where }) => [id, steps, where ?? null]),
    [['house-style', ['requirements'], null], ['web-e2e-test-generation', ['implementation'], E2E], ['web-smoke', ['implementation'], '.github/skills/web-smoke/SKILL.md']]);
  // Pure: a step the library has a skill for takes it; a marketplace skill is offered only where neither has one; an ID
  // the repository has is never a marketplace's.
  const composition = composeTask(definition, { kind: 'fix' });
  const library = librarySkillCandidate({ id: 'web-checks', tags: ['task:e2e-testing', 'web'], sha256: 'l' });
  const own = localSkillCandidate({ id: 'web-smoke', tags: ['task:e2e-testing', 'web'], sha256: 'o' }, { path: '.github/skills/web-smoke/SKILL.md' });
  const market = marketplaceSkillCandidate({ name: 'web-smoke', tags: ['web'], pdlcTasks: ['e2e-testing'], lifecycleState: 'ga' }, 'acme');
  const other = marketplaceSkillCandidate({ name: 'web-lint', tags: ['web'], pdlcTasks: ['static-analysis'], lifecycleState: 'ga' }, 'acme');
  assert.deepEqual(chooseTaskSkills(composition, { candidates: [market, own, library, other], kinds: ['web'] }).skills.map((skill) => skill.id), ['web-checks']);
  const chosen = chooseTaskSkills(composition, { candidates: [market, own, other], kinds: ['web'] });
  assert.deepEqual(chosen.skills.map((skill) => [skill.id, skill.from]), [['web-smoke', 'repository']]);
  assert.deepEqual(chosen.offers.map((entry) => [entry.id, entry.marketplace, entry.steps]), [['web-lint', 'acme', ['verification']]]);
  assert.deepEqual(chooseTaskSkills(composition, { candidates: [market, own, other], kinds: ['web'] }), chosen, 'the same skills twice');
  // A team's own workflow as the plan brings its own skills: none is chosen, nothing is read.
  assert.deepEqual(await taskSkillChooser(root, definition)(composeTask(definition, { kind: 'fix', workflow: { workflow: 'secure-fix' } })),
    { skills: [], offers: [], byStep: {}, notes: [] });
});

const json = (text) => { const value = JSON.parse(text); return value.data ?? value; };
function refused(story, args) {
  const result = story.raw([...args, '--json']);
  assert.notEqual(result.status, 0, `${args.join(' ')} should be refused:\n${result.stdout}`);
  const text = `${result.stdout}`;
  const body = JSON.parse(text.slice(text.search(/^\s*\{/mu)));
  return body.error ?? body;
}

test('ITW REQ-020, REQ-108: in a real repository, the team\'s workflow is the plan with no question and runs as it is; a no keeps the task\'s steps, with its own skill frozen', slowLane({ timeout: 900_000 }), async (t) => {
  const SMOKE = skillText('web-smoke', ['task:e2e-testing', 'web']);
  const story = await journeyRepository(t, {
    files: { 'package.json': WEB_PACKAGE, '.github/skills/web-smoke/SKILL.md': SMOKE, '.github/skills/broken-skill/SKILL.md': '---\nname: broken-skill\n---\n\nNo description.\n' },
    configure: (configuration) => {
      configuration.workTypes['reviewed-fix'] = { label: 'Reviewed fix', phases: ['intake', 'implementation', 'verification', 'conformance'] };
    }
  });
  const WORDS = 'fix the login button';
  const shown = json(story.cli('work', WORDS, '--kind', 'fix', '--json'));
  assert.equal(shown.agentOffer, undefined, 'the team\'s own workflow is not asked about');
  assert.deepEqual([shown.usedWorkflow.id, shown.usedWorkflow.without], ['reviewed-fix', `singularity-flow work "${WORDS}" --kind fix --start --without-workflow reviewed-fix`]);
  assert.equal(shown.next.label, 'Start the task.');
  assert.match(shown.plan, /^Plan, from your team's workflow Reviewed fix: code → tests → review\./u);
  assert.deepEqual(json(story.cli('work', WORDS, '--kind', 'fix', '--json')), shown, 'the same words and repository, the same plan');
  const printed = story.cli('work', WORDS, '--kind', 'fix');
  assert.match(printed, /^Your team's workflow Reviewed fix covers this task \(its steps cover every step this task needs \(code and tests\)\), so it is the plan\. Its own steps instead: /mu);
  // The start asks nothing: the Story runs the team's workflow exactly as it is.
  const started = json(story.cli('work', WORDS, '--kind', 'fix', '--start', '--json'));
  assert.equal(started.id, 'TASK-1');
  assert.match(started.task.plan, /^Plan, from your team's workflow Reviewed fix: code → tests → review\./u);
  story.item = 'singularity/work-items/TASK-1';
  const record = storyRecord(story);
  assert.equal(record.workItem.workType, 'reviewed-fix');
  assert.deepEqual(record.phaseOrder, ['intake', 'implementation', 'verification', 'conformance']);
  assert.deepEqual(record.resolution.composition.local, { workflow: 'reviewed-fix', label: 'Reviewed fix' });
  const status = json(story.cli('work', 'status', 'TASK-1', '--json'));
  assert.equal(status.planFrom, 'your team\'s workflow Reviewed fix');
  // The no, on another task: its own steps, and the repository's own skill frozen with its exact text.
  story.git('checkout', '-q', 'main');
  const declined = json(story.cli('work', WORDS, '--kind', 'fix', '--start', '--new', '--without-workflow', 'reviewed-fix', '--json'));
  assert.equal(declined.id, 'TASK-2');
  assert.ok(shown.notes === undefined || shown.notes.some((note) => /^Skill broken-skill /u.test(note)), 'the broken skill is named');
  assert.deepEqual(declined.task.skills, [{ id: 'web-smoke', steps: ['implementation'] }]);
  story.item = 'singularity/work-items/TASK-2';
  const second = storyRecord(story);
  assert.deepEqual(second.resolution.composition.skills.map(({ id, path: where, from }) => [id, where, from]), [['web-smoke', '.github/skills/web-smoke/SKILL.md', 'repository']]);
  const manifest = JSON.parse(await readFile(path.join(story.root, second.workflowSnapshot.manifestPath), 'utf8'));
  const asset = manifest.assets.find((entry) => entry.logicalId === 'workflow:task-fix:skill:web-smoke');
  assert.equal(asset?.purpose, 'workflow-skill');
  assert.equal(await readFile(path.join(story.root, asset.blob.path), 'utf8'), SMOKE, 'the exact text the Story uses');
});
