/**
 * A marketplace agent as a task's plan (docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md REQ-011, with REQ-004, A2, A7, A9): one
 * agent of a trusted marketplace whose stages cover the task is offered, with its conversion review; a yes makes that
 * agent's workflow, once imported through the review, the task's steps, the team's rules still adding to them; a no keeps
 * the composed steps. The marketplace is a local Git repository made from test/fixtures/sdlc-marketplace: no network.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

import { assertWorkTypeStartable, resolveWorkType, validateDefinition } from '../src/config.mjs';
import { parsePackageManifest } from '../src/marketplace-repository.mjs';
import { AGENT_TASK_INTENTS } from '../src/agent-task-intents.mjs';
import { agentCoverage, agentPlanCandidate, chooseTaskAgent, neededIntents, TEST_WRITING_TASKS } from '../src/task-agents.mjs';
import { composeTask, definitionForStory, storyComposition, TASK_KINDS, taskClosureWorkTypes } from '../src/task-composition.mjs';
import { taskPlan } from '../src/commands/work.mjs';
import { chooseTaskSkills } from '../src/task-skills.mjs';
import { journeyRepository, storyRecord } from './helpers/route-follower.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = YAML.parse(readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
const FIXTURE = path.join(ROOT, 'test/fixtures/sdlc-marketplace');
const ACME = Object.freeze({ id: 'acme', repository: '/srv/acme-marketplace', commit: 'a'.repeat(40) });
const QA = 'acme/qa-test-automation-agent';

/** A package of the fixture marketplace as its listing keeps it, with its agent.md text for an agent. */
function fixturePackage(kind, name) {
  const own = parsePackageManifest(readFileSync(path.join(FIXTURE, kind, name, 'apm.yml'), 'utf8'), { source: `${kind}/${name}` });
  return { ...own, name, skills: own.dependencies.map((dependency) => path.posix.basename(dependency.path ?? '')).filter(Boolean),
    ...(kind === 'agents' ? { text: readFileSync(path.join(FIXTURE, kind, name, 'agent.md'), 'utf8') } : {}) };
}
const SKILLS = ['requirements-writer', 'acceptance-criteria-writer', 'web-e2e-test-generation', 'web-xray-creation', 'android-xray-creation',
  'android-ui-test-creation', 'android-unit-test'].map((name) => fixturePackage('skills', name));
const candidate = (name, extra = {}) => agentPlanCandidate({ marketplace: ACME, entry: { ...fixturePackage('agents', name), ...(extra.entry ?? {}) },
  skills: SKILLS, imported: extra.imported ?? null, kindsOf: extra.kindsOf ?? null });

/** The base definition with a workflow imported from the QA agent: its steps as the conversion makes them, by intent. */
function withImportedQa(tasks = undefined) {
  const definition = structuredClone(BASE);
  definition.workTypes['qa-test-automation'] = { label: 'QA Test Automation', description: 'From marketplace acme: qa-test-automation-agent 1.0.0-pdlc',
    phases: ['intake', 'requirements', 'implementation', 'verification'] };
  if (tasks) definition.tasks = tasks;
  return definition;
}
const QA_AGENT = Object.freeze({ marketplace: 'acme', agent: 'qa-test-automation-agent', version: '1.0.0-pdlc', workflow: 'qa-test-automation', commit: 'a'.repeat(40) });

test('ITW REQ-011: an agent covers a task when its stages do each of the task\'s steps, with the task\'s kind of code', async () => {
  assert.ok(TEST_WRITING_TASKS.every((task) => AGENT_TASK_INTENTS[task]?.intent === 'code'), 'tests are a code step\'s work');
  const qa = await candidate('qa-test-automation-agent');
  assert.deepEqual([qa.id, qa.ready, qa.lifecycle, qa.state], [QA, true, 'unreviewed', 'proposed']);
  assert.deepEqual(qa.steps.map((step) => step.intent), ['intake', 'requirements', 'code', 'test']);
  // The product agent has stages SFlow cannot classify without a person's answer: it is not offered until its import has one.
  const product = await candidate('product-agent');
  assert.equal(product.ready, false);
  const offered = Object.fromEntries(TASK_KINDS.map((kind) => [kind, chooseTaskAgent(composeTask(BASE, { kind }), { candidates: [qa, product] }).offer?.id ?? null]));
  // The QA agent's code only writes tests: it covers a tests task and no other; nothing covers a task with no code.
  assert.deepEqual(offered, { fix: null, feature: null, change: null, refactor: null, tests: QA, docs: null, investigate: null, review: null, chore: null });
  assert.deepEqual(agentCoverage('tests', neededIntents(composeTask(BASE, { kind: 'tests' })), qa), { covers: true, extra: 1 });
  // A plan is covered by a requirements step before the code, which plans it; a design the agent has no stage for is not.
  const asProduct = { ...qa, steps: qa.steps.map((step) => (step.intent === 'code' ? { ...step, tasks: ['api-implementation'] } : step)) };
  assert.equal(agentCoverage('change', neededIntents(composeTask(BASE, { kind: 'change' })), asProduct).covers, true);
  assert.equal(agentCoverage('fix', neededIntents(composeTask(BASE, { kind: 'fix' })), asProduct).covers, true);
  assert.equal(agentCoverage('fix', neededIntents(composeTask(BASE, { kind: 'fix', add: ['design'] })), asProduct).covers, false);
  assert.equal(agentCoverage('investigate', neededIntents(composeTask(BASE, { kind: 'investigate' })), { ...asProduct, steps: [{ intent: 'design', tasks: [] }, ...asProduct.steps] }).covers, false,
    'an agent with a code step never covers a task that changes no code');
  // The steps a team's rule adds are not the agent's to cover: the rule adds them on top.
  const ruled = composeTask(Object.assign(structuredClone(BASE), { tasks: { always: [{ kinds: ['tests'], steps: ['review'], because: 'Reviewed.' }] } }), { kind: 'tests' });
  assert.deepEqual(neededIntents(ruled), ['code', 'test']);
});

test('ITW REQ-011, A2, A7: one agent is offered with its review and each answer\'s option; the same input gives the same offer', async () => {
  const qa = await candidate('qa-test-automation-agent');
  const composition = composeTask(BASE, { kind: 'tests' });
  const { offer } = chooseTaskAgent(composition, { candidates: [qa] });
  assert.deepEqual(offer, {
    id: QA, marketplace: 'acme', agent: 'qa-test-automation-agent', version: '1.0.0-pdlc', imported: false, state: 'proposed',
    steps: ['Intake', 'Test Case Creation', 'Test Automation', 'Execution and Evidence'],
    ask: 'acme\'s qa-test-automation agent covers this task: add its workflow to this repository and use it as the plan, requirements → write the tests → tests (the marketplace marks it proposed)?',
    why: 'its stages cover every step this task needs (write the tests and tests)',
    review: `singularity-flow workflow from-agent ${QA} --review`,
    show: `singularity-flow workflow from-agent ${QA} --propose --json`,
    yes: `--use-agent ${QA}`, no: `--without-agent ${QA}`
  });
  assert.deepEqual(chooseTaskAgent(composition, { candidates: [await candidate('qa-test-automation-agent')] }), { offer }, 'the same words and repository, the same offer');
  // Imported here: no import to show, and it comes before another that covers the task.
  const imported = await candidate('qa-test-automation-agent', { imported: { workflow: 'qa-test-automation', commit: ACME.commit, version: '1.0.0-pdlc' } });
  const other = { ...qa, id: 'aaa/qa-other-agent', marketplace: 'aaa', agent: 'qa-other-agent' };
  const first = chooseTaskAgent(composition, { candidates: [other, imported] }).offer;
  assert.deepEqual([first.id, first.imported, first.show], [QA, true, undefined]);
  assert.match(first.ask, /^acme's qa-test-automation agent covers this task: use its workflow as the plan, requirements → write the tests → tests \(the marketplace marks it proposed\)\?$/u);
  assert.equal(chooseTaskAgent(composition, { candidates: [qa, other] }).offer.id, 'aaa/qa-other-agent', 'neither imported: by marketplace, then name');
  // A deprecated agent is never offered; one whose tags name only another kind of software is not either.
  assert.deepEqual(chooseTaskAgent(composition, { candidates: [{ ...qa, lifecycle: 'retired', state: 'deprecated' }] }), {});
  const android = { ...qa, kinds: ['mobile'] };
  assert.deepEqual(chooseTaskAgent(composition, { candidates: [android], kinds: ['web'] }), {});
  assert.equal(chooseTaskAgent(composition, { candidates: [android], kinds: ['mobile'] }).offer.id, QA);
  // The no: nothing more is asked. A team's `use` rule keeps its workflow, and the person's yes to an agent is refused.
  assert.deepEqual(chooseTaskAgent(composition, { candidates: [qa], without: [QA] }), {});
  const used = Object.assign(structuredClone(BASE), { tasks: { use: { tests: 'chore' } } });
  assert.deepEqual(chooseTaskAgent(composeTask(used, { kind: 'tests' }), { candidates: [qa] }), {});
  assert.throws(() => chooseTaskAgent(composeTask(used, { kind: 'tests' }), { candidates: [qa], use: [QA] }),
    (error) => error.code === 'TASK_AGENT_NOT_COVERING' && Boolean(error.details.nextAction.command));
});

test('ITW REQ-011: a yes is the agent\'s workflow once it is in the repository; until then the start names its import', async () => {
  const qa = await candidate('qa-test-automation-agent');
  const composition = composeTask(BASE, { kind: 'tests' });
  assert.throws(() => chooseTaskAgent(composition, { candidates: [qa], use: [QA] }), (error) => error.code === 'TASK_AGENT_IMPORT_NEEDED'
    && error.details.nextAction.command === `singularity-flow workflow from-agent ${QA} --propose` && /conversion review/u.test(error.message));
  assert.throws(() => chooseTaskAgent(composition, { candidates: [qa], use: ['acme/nobody'] }),
    (error) => error.code === 'TASK_AGENT_UNKNOWN' && error.details.nextAction.command === 'singularity-flow marketplace browse acme --kind agent');
  assert.throws(() => chooseTaskAgent(composeTask(BASE, { kind: 'fix' }), { candidates: [qa], use: [QA] }),
    (error) => error.code === 'TASK_AGENT_NOT_COVERING' && /do not cover this fix task/u.test(error.message) && Boolean(error.details.nextAction.command));
  const imported = await candidate('qa-test-automation-agent', { imported: { workflow: 'qa-test-automation', commit: ACME.commit, version: '1.0.0-pdlc' } });
  assert.deepEqual(chooseTaskAgent(composition, { candidates: [imported], use: [QA] }), { chosen: QA_AGENT });
});

test('ITW REQ-011, REQ-004, A9: the agent\'s steps replace the composed ones, the team\'s rules still add, and the Story rebuilds the same steps', async () => {
  const chooseAgent = async () => ({ chosen: QA_AGENT });
  const plain = await taskPlan(withImportedQa(), { kind: 'tests', chooseAgent });
  assert.equal(plain.plan, 'Plan, from acme\'s qa-test-automation agent: requirements → write the tests → tests. You approve the requirements and the tests. Say "add a design step" to change it.');
  assert.deepEqual(plain.steps.map((step) => step.id), ['intake', 'requirements', 'implementation', 'verification']);
  assert.equal(plain.walk, 'completed');
  assert.deepEqual(plain.composition.agent, QA_AGENT, 'the composition records where its steps came from');
  assert.deepEqual(await taskPlan(withImportedQa(), { kind: 'tests', chooseAgent }), plain, 'the same words and repository, the same plan');
  // A team rule adds its step and its person's approval to the agent's steps, where its intent goes.
  const rules = { always: [{ kinds: ['tests'], steps: ['review'], personApproves: ['test'], because: 'A person reads every test change\'s results, and it is reviewed.' }] };
  const ruled = await taskPlan(withImportedQa(rules), { kind: 'tests', chooseAgent });
  assert.deepEqual(ruled.steps.map((step) => [step.id, step.approvedBy]),
    [['intake', 'sflow'], ['requirements', 'person'], ['implementation', 'person'], ['verification', 'person'], ['conformance', 'sflow']]);
  assert.deepEqual(ruled.composition.added, [{ intent: 'review', rule: 'always[0]', because: rules.always[0].because }]);
  assert.equal(ruled.walk, 'completed');
  // The person adds a step where its intent goes; a step of the agent's workflow stays.
  const designed = composeTask(withImportedQa(), { kind: 'tests', agent: QA_AGENT, add: ['design'] });
  assert.deepEqual(designed.steps.map((step) => step.id), ['intake', 'requirements', 'design', 'implementation', 'verification']);
  assert.throws(() => composeTask(withImportedQa(), { kind: 'tests', agent: QA_AGENT, skip: ['requirements'] }),
    (error) => error.code === 'TASK_CHANGE_REFUSED' && /workflow is followed as it is/u.test(error.message) && /--without-agent acme\/qa-test-automation-agent/u.test(error.details.nextAction.command));
  // Its skills come with its workflow: a task chooses none for it.
  assert.deepEqual(chooseTaskSkills(ruled.composition, { candidates: [], kinds: ['web'] }), { skills: [], offers: [], byStep: {} });
  // The Story's record rebuilds the same work type from the configuration it carries; its closure carries the agent's workflow.
  const definition = withImportedQa(rules);
  const workflow = { resolution: { composition: structuredClone(ruled.composition) } };
  assert.deepEqual(storyComposition(workflow), ruled.composition);
  const resolved = assertWorkTypeStartable(resolveWorkType(validateDefinition(structuredClone(definitionForStory(definition, workflow))), 'task-tests'));
  assert.deepEqual(resolved.phases.map((phase) => phase.id), ruled.steps.map((step) => step.id));
  assert.deepEqual(taskClosureWorkTypes(definition, ruled.composition), ['qa-test-automation', 'feature']);
  // Not in the configuration the task reads: refused with the import through the conversion review.
  assert.throws(() => composeTask(BASE, { kind: 'tests', agent: QA_AGENT }),
    (error) => error.code === 'TASK_AGENT_IMPORT_NEEDED' && error.details.nextAction.command === `singularity-flow workflow from-agent ${QA} --propose`);
});

/** The fixture marketplace as a Git repository of its own, read at the commit it is trusted at. */
async function marketplaceRepository(t) {
  const directory = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'sflow-task-agent-market-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, 'acme');
  await cp(FIXTURE, repository, { recursive: true });
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Market Maintainer', '-c', 'user.email=maintainers@example.com', ...args], { cwd: repository, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'The marketplace');
  return { repository, commit: git('rev-parse', 'HEAD') };
}

const json = (text) => { const value = JSON.parse(text); return value.data ?? value; };
function refused(story, args) {
  const result = story.raw([...args, '--json']);
  assert.notEqual(result.status, 0, `${args.join(' ')} should be refused:\n${result.stdout}`);
  const text = `${result.stdout}`;
  const body = JSON.parse(text.slice(text.search(/^\s*\{/mu)));
  return body.error ?? body;
}

const WORDS = 'add end-to-end tests for the checkout page';
const RULE = { kinds: ['tests'], steps: ['review'], because: 'Every test change gets a conformance review.' };

test('ITW REQ-011, A7, A9: a trusted marketplace\'s agent is offered; its yes imports it through the conversion review, and the task follows its workflow with the team\'s rule', slowLane({ timeout: 900_000 }), async (t) => {
  const acme = await marketplaceRepository(t);
  const story = await journeyRepository(t, {
    configure: (configuration) => {
      configuration.marketplaces = { acme: { label: 'Acme', repository: acme.repository, commit: acme.commit } };
      configuration.tasks = { always: [RULE] };
    }
  });
  const shown = json(story.cli('work', WORDS, '--kind', 'tests', '--json'));
  assert.equal(shown.plan, 'Plan: write the tests → tests → review. You approve the plan in the intake and the tests. Say "add a design step" to change it.');
  assert.equal(shown.agentOffer.id, QA);
  assert.equal(shown.agentOffer.show, `singularity-flow workflow from-agent ${QA} --propose --json`);
  assert.equal(shown.next.label, 'Start the task after a yes or no to the agent offered.');
  assert.deepEqual(json(story.cli('work', WORDS, '--kind', 'tests', '--json')), shown, 'the same words and repository, the same plan');
  assert.equal(story.git('status', '--porcelain'), '', 'showing the plan writes nothing');
  const printed = story.cli('work', WORDS, '--kind', 'tests');
  assert.match(printed, /^acme's qa-test-automation agent covers this task: add its workflow to this repository and use it as the plan, requirements → write the tests → tests \(the marketplace marks it proposed\)\? Its stages cover/mu);
  assert.match(printed, new RegExp(`^  See its conversion review: singularity-flow workflow from-agent ${QA} --review$`, 'mu'));
  // Starting asks first, with the conversion review to show and the start each answer completes.
  const asked = refused(story, ['work', WORDS, '--kind', 'tests', '--start']);
  assert.equal(asked.code, 'TASK_AGENT_YES_NEEDED');
  assert.equal(asked.details.nextAction, shown.agentOffer.show);
  assert.equal(asked.details.start, `singularity-flow work "${WORDS}" --kind tests --start`);
  assert.equal(asked.details.agentOffer.yes, `--use-agent ${QA}`);
  // A yes before its workflow is here: the start names the import through the conversion review, and a start without it.
  const importFirst = refused(story, ['work', WORDS, '--kind', 'tests', '--start', '--use-agent', QA]);
  assert.equal(importFirst.code, 'TASK_AGENT_IMPORT_NEEDED');
  assert.equal(importFirst.details.nextAction, `singularity-flow workflow from-agent ${QA} --propose`);
  assert.equal(importFirst.details.withoutAgent, `singularity-flow work "${WORDS}" --kind tests --start --without-agent ${QA}`);
  assert.equal(story.git('branch', '--list', 'TASK-1'), '', 'nothing started');
  // The conversion review's import, as /sf-import and Workflow Studio make it.
  const review = json(story.cli('workflow', 'from-agent', QA, '--propose', '--json'));
  assert.equal(review.ready, true);
  assert.match(review.review.markdown, /^# Conversion review: QA Test Automation$/mu);
  const out = path.join(story.base, 'qa.workflow.json');
  story.cli('workflow', 'from-agent', QA, '--out', out);
  const importPlan = json(story.cli('workflow', 'import', out, '--dry-run', '--json'));
  assert.equal(importPlan.status, 'ready', JSON.stringify(importPlan.unresolved ?? importPlan));
  story.cli('workflow', 'import', out, '--confirm', importPlan.planSha256);
  story.git('add', '-A');
  story.git('commit', '-qm', 'Import the QA workflow');
  story.git('push', '-q', 'origin', 'main');
  // Now here: the offer asks nothing more than its yes, and the plan with it is the agent's steps and the team's review.
  const again = json(story.cli('work', WORDS, '--kind', 'tests', '--json'));
  assert.deepEqual([again.agentOffer.imported, again.agentOffer.show], [true, undefined]);
  const withAgent = json(story.cli('work', WORDS, '--kind', 'tests', '--use-agent', QA, '--json'));
  assert.equal(withAgent.plan, 'Plan, from acme\'s qa-test-automation agent: requirements → write the tests → tests → review. You approve the requirements and the tests. Say "add a design step" to change it.');
  assert.deepEqual(withAgent.steps.map((step) => step.id), ['qa-test-automation-intake', 'qa-test-automation-test-case-creation',
    'qa-test-automation-test-automation', 'qa-test-automation-execution-and-evidence', 'conformance']);
  assert.deepEqual(withAgent.agent, { id: QA, marketplace: 'acme', agent: 'qa-test-automation-agent', version: '1.0.0-pdlc', workflow: 'qa-test-automation' });
  assert.equal(withAgent.agentOffer, undefined);
  const started = json(story.cli('work', WORDS, '--kind', 'tests', '--start', '--use-agent', QA, '--json'));
  assert.equal(started.id, 'TASK-1');
  assert.deepEqual(started.task.steps.map((step) => step.id), withAgent.steps.map((step) => step.id));
  story.item = 'singularity/work-items/TASK-1';
  const record = storyRecord(story);
  assert.equal(record.workItem.workType, 'task-tests');
  assert.deepEqual(record.phaseOrder, withAgent.steps.map((step) => step.id));
  // The Story's own record says where its steps came from, so a second laptop resumes the same steps.
  const { commit: recorded, ...source } = record.resolution.composition.agent;
  assert.deepEqual(source, { marketplace: 'acme', agent: 'qa-test-automation-agent', version: '1.0.0-pdlc', workflow: 'qa-test-automation' });
  assert.equal(recorded, acme.commit);
  assert.deepEqual(record.resolution.composition.added, [{ intent: 'review', rule: 'always[0]', because: RULE.because }]);
  const committed = JSON.parse(story.git('show', `origin/TASK-1:${story.item}/workflow.json`));
  assert.deepEqual(committed.resolution.composition.agent, record.resolution.composition.agent);
  assert.equal(json(story.cli('work', 'status', 'TASK-1', '--json')).steps.length, 5);
  // The no, on another task: its own steps, and nothing more asked.
  story.git('checkout', '-q', 'main');
  const declined = json(story.cli('work', WORDS, '--kind', 'tests', '--start', '--new', '--without-agent', QA, '--json'));
  assert.equal(declined.id, 'TASK-2');
  assert.deepEqual(declined.task.steps.map((step) => step.id), ['intake', 'implementation', 'verification', 'conformance']);
});

test('ITW REQ-011, A7: with no trusted marketplace nothing is read and nothing is offered; an agent named anyway is refused with its way on', slowLane({ timeout: 600_000 }), async (t) => {
  const story = await journeyRepository(t);
  const shown = json(story.cli('work', WORDS, '--kind', 'tests', '--json'));
  assert.equal(shown.agentOffer, undefined);
  assert.equal(shown.plan, 'Plan: write the tests → tests. You approve the plan in the intake and the tests. Say "add a design step" to change it.');
  assert.equal(existsSync(path.join(story.root, '.git/singularity-flow/task-marketplace-agents')), false, 'no marketplace was read');
  const unknown = refused(story, ['work', WORDS, '--kind', 'tests', '--use-agent', QA]);
  assert.equal(unknown.code, 'TASK_AGENT_UNKNOWN');
  assert.equal(unknown.details.nextAction, 'singularity-flow marketplace list');
  assert.equal(unknown.details.withoutAgent, `singularity-flow work "${WORDS}" --kind tests --start --without-agent ${QA}`);
  const named = refused(story, ['work', WORDS, '--kind', 'tests', '--use-agent', 'not an agent']);
  assert.equal(named.code, 'TASK_AGENT_UNKNOWN');
  assert.equal(named.details.nextAction, 'singularity-flow marketplace list');
});

test('ITW REQ-011: an agent\'s hard gate is asked once, in its own words and choices, and the submission reads the answer', async () => {
  const { answeredChoice, clarifiedValueQuestions, storyValueOfTopic, storyValueTopic } = await import('../src/phase-roles.mjs');
  const { decisionSubmitArguments } = await import('../src/workflow-decisions.mjs');
  const asked = { question: 'Which channel is this test automation for?', choices: ['web', 'android'], name: 'channel' };
  const topic = storyValueTopic(asked);
  assert.equal(topic, 'Which channel is this test automation for? Choose one: web, android (recorded as channel).');
  assert.deepEqual(storyValueOfTopic(topic), asked);
  assert.equal(storyValueOfTopic('Prioritize the checkout page.'), null);
  assert.equal(answeredChoice(asked, [{ question: 'Which channel is this test automation for? (web / android)', answer: 'Web, please.' }]), 'web');
  assert.equal(answeredChoice(asked, [{ question: 'Which channel is this test automation for?', answer: 'web and android' }]), null, 'both named: asked again');
  assert.equal(answeredChoice(asked, [{ question: 'Anything else?', answer: 'web' }]), null, 'an answer to another question');
  // The route to submit the step carries no `<channel>`: the value is the step's clarification's, read at its submission.
  const workflow = { workItem: { id: 'TASK-1' }, phases: { intake: { id: 'intake' } }, phaseOrder: ['intake', 'cases'],
    resolution: { phases: [{ id: 'intake', clarification: { mode: 'required', topics: [topic] } }, { id: 'cases' }],
      decisions: [{ id: 'channel', after: 'intake', kind: 'branch', mode: 'auto', label: asked.question,
        inputs: [{ name: 'channel', label: asked.question, values: ['web', 'android'] }], routes: [{ id: 'web', when: { channel: 'web' }, to: 'next' }, { id: 'android', to: 'next' }] }] } };
  assert.deepEqual([...clarifiedValueQuestions(workflow, 'intake').keys()], ['channel']);
  assert.equal(decisionSubmitArguments(workflow, 'intake'), '');
  const unasked = structuredClone(workflow);
  unasked.resolution.phases[0].clarification.topics = ['Anything left open?'];
  assert.equal(decisionSubmitArguments(unasked, 'intake'), ' --decision channel=<channel>', 'a value no clarification asks keeps its place to fill in');
});
