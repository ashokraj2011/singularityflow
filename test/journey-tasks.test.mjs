/**
 * Journey ITW (docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md A1, A10, A11, A13, REQ-011, REQ-015): a task started from its words,
 * walked by its routes to its end as Copilot CLI drives it, with the workflow's own checks deciding each step. The scripted
 * agent writes each step from its own template, by intent (test/helpers/generated-journey.mjs), so nothing here knows the
 * composed steps. A refactor's agent changes the order of two errors at its code step, and its person keeps or accepts the
 * new behaviour; a tests task follows a trusted marketplace agent's workflow, whose hard gate the person answers.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { firstClause, generatedAgent, generatedPerson } from './helpers/generated-journey.mjs';
import { decideCard } from './helpers/journey-scripts.mjs';
import { followRoutes, formatTrail, journeyRepository, storyRecord } from './helpers/route-follower.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

/**
 * What the person did on a walk, as a real chat counts it [ITW:REQ-019, A11]: their words, each /sf-task they had to type
 * again (none when SFlow carries the turn on), each answer in the chat (a question, a Yes to an approval, a Story value)
 * and each step of their own at the card or their terminal.
 */
const personActions = (trail) => {
  const typed = trail.filter((entry) => entry.typed).length;
  const answers = trail.filter((entry) => /the person answered/u.test(entry.did ?? '')).length;
  const own = trail.filter((entry) => entry.turn === 'person').length;
  return { words: 1, typed: Math.max(0, typed - 1), answers, own, total: Math.max(1, typed) + answers + own };
};

async function walkTask(t, words, kind, { files = {}, configure = null, agent = null, person = null, start = null, maxSteps = 160 } = {}) {
  const story = await journeyRepository(t, { files, configure });
  Object.assign(story, { workId: 'TASK-1', item: 'singularity/work-items/TASK-1' });
  const walk = await followRoutes(story, {
    label: `task ${kind}`,
    start: { shell: start ?? `singularity-flow work "${words}" --kind ${kind} --start` },
    agent: agent?.(story) ?? generatedAgent('TASK-1'), person: person?.(story) ?? generatedPerson(story, 'TASK-1'),
    done: ({ record }) => record?.status === 'closed',
    maxSteps
  });
  t.diagnostic(formatTrail(walk.trail));
  return { story, walk };
}

test('journey ITW: a fix task goes from its words to a closed Story by its routes, and a person approves the plan and the code', slowLane({ timeout: 1_800_000 }), async (t) => {
  const { story, walk } = await walkTask(t, 'fix the value module so it returns 2', 'fix');
  assert.equal(walk.reached, true, formatTrail(walk.trail));
  assert.deepEqual(walk.findings, [], JSON.stringify(walk.findings));
  const record = storyRecord(story);
  assert.equal(record.workItem.workType, 'task-fix');
  assert.deepEqual(record.phaseOrder, ['intake', 'implementation', 'verification']);
  const byPerson = record.phaseOrder.filter((id) => record.phases[id].approvedBy);
  assert.deepEqual(byPerson, ['intake', 'implementation'], 'a person approves the plan in the intake and the code; SFlow the test step');
  assert.equal(record.phases.verification.approvalDisposition, 'approved_automatically');
  // What the person did [ITW:REQ-019, A11]: the words, the intake's one answer and a Yes to each approval, in one chat:
  // SFlow carries the /sf-task turn on after the start, each submission and each Yes, so nothing is typed again.
  assert.equal(walk.trail[0]?.turn, '/sf-task', formatTrail(walk.trail));
  assert.ok(walk.trail.filter((entry) => /SFlow carries the \/sf-task turn on/u.test(entry.did ?? '')).length >= 5, formatTrail(walk.trail));
  assert.deepEqual(personActions(walk.trail), { words: 1, typed: 0, answers: 3, own: 0, total: 4 }, formatTrail(walk.trail));
  void firstClause;
});

test('journey ITW: an investigation ends with its report approved by a person and changes no code', slowLane({ timeout: 1_800_000 }), async (t) => {
  const { story, walk } = await walkTask(t, 'why does the value module return 1', 'investigate');
  assert.equal(walk.reached, true, formatTrail(walk.trail));
  assert.deepEqual(walk.findings, [], JSON.stringify(walk.findings));
  const record = storyRecord(story);
  assert.deepEqual(record.phaseOrder, ['intake', 'design']);
  assert.equal(record.phases.design.approvedBy ? 'person' : 'sflow', 'person', 'a person approves the report');
  assert.equal(story.git('diff', '--name-only', 'main', 'TASK-1', '--', 'src', 'test'), '', 'no code changed');
});

for (const [kind, words, steps] of [
  ['docs', 'write a short note about the value module', ['intake', 'design']],
  ['change', 'make the value module return 2', ['intake', 'implementation-spec', 'implementation', 'verification']],
  ['feature', 'add a second value to the value module', ['intake', 'requirements', 'implementation-spec', 'implementation', 'verification']]
]) {
  test(`journey ITW: a ${kind} task goes from its words to a closed Story by its routes, with two approvals by a person`, slowLane({ timeout: 2_400_000 }), async (t) => {
    const { story, walk } = await walkTask(t, words, kind);
    assert.equal(walk.reached, true, formatTrail(walk.trail));
    assert.deepEqual(walk.findings, [], JSON.stringify(walk.findings));
    const record = storyRecord(story);
    assert.deepEqual(record.phaseOrder, steps);
    assert.equal(record.phaseOrder.filter((id) => record.phases[id].approvedBy).length, 2, JSON.stringify(record.phaseOrder.map((id) => [id, record.phases[id].approvedBy ?? record.phases[id].approvalDisposition])));
  });
}

// ------------------------------------------------------------------------------------ a refactor through a behaviour change

/** The value module with a validator whose two errors come in an order its test pins [ITW:REQ-015, A13]. */
const VALIDATOR = (order) => ['export const value = 1;', '',
  '// The rules a person\'s input is checked by, in the order their errors are reported.',
  `const RULES = [${order.map((field) => `['${field}', '${field} is required']`).join(', ')}];`, '',
  'export function validate(input = {}) {', '  return RULES.filter(([field]) => !input[field]).map(([, error]) => error);', '}', ''].join('\n');
const REFACTOR_FILES = Object.freeze({
  'src/value.mjs': ['export const value = 1;', '', 'export function validate(input = {}) {', '  const errors = [];',
    '  if (!input.name) errors.push(\'name is required\');', '  if (!input.email) errors.push(\'email is required\');', '  return errors;', '}', ''].join('\n'),
  'test/value.test.mjs': ["import test from 'node:test';", "import assert from 'node:assert/strict';", "import { validate, value } from '../src/value.mjs';", '',
    "test('value', () => assert.equal(value, 1));",
    "test('a missing name is reported before a missing email', () => assert.deepEqual(validate({}), ['name is required', 'email is required']));", ''].join('\n')
});

/**
 * The agent of a refactor: the generated agent, whose code step rewrites the validator as a table of rules with the clause
 * tags its check asks for, the tests kept as they were. It lists the rules email first (a behaviour change) until a person
 * kept the old behaviour; once a person accepted the new one, the task is a change and the test says the new order.
 * `editsTest`: the author also "fixes" the existing test to expect its new order, so no run fails [ITW:REQ-015].
 */
const refactorAgentWith = ({ editsTest = false } = {}) => (story) => {
  const agent = generatedAgent('TASK-1');
  return { ...agent,
    // A failed test the gate returns to the author: the code is written again as the Story now stands.
    async repair({ story: guarded, phase }) {
      return this.author({ story: guarded, phase, generation: Number(storyRecord(story)?.phases?.[phase]?.generation ?? 0) + 1, repair: true });
    },
    async author(context) {
    const record = storyRecord(story);
    const intent = record?.resolution?.composition?.steps?.find((step) => step.id === context.phase)?.intent;
    const wrote = context.repair ? true : await agent.author(context);
    // The refactor's plan says what must not change and which checks show it: the order of the errors, by the value test;
    // the log line's format, which no test reads. Revised once the person accepted the new order, it says what changes.
    if (intent === 'plan') {
      const changes = record.resolution.composition.kind === 'change';
      const relative = path.posix.join(story.item, record.phases[context.phase].requiredArtifact.path);
      const anchor = (line, kind) => (line.startsWith('|') ? null : new RegExp(`\\[TASK-1:${kind}-\\d{3}\\]`, 'u').exec(line)?.[0]);
      const text = (await story.read(relative)).split('\n').map((line) => {
        if (/^\| `TASK-1:CON-\d{3}` \|/u.test(line)) return line.replace(/^(\| `TASK-1:CON-\d{3}` \|[^|]*\|)[^|]*\|/u, '$1 not-applicable: no test reads the log line; a person reads it |');
        if (anchor(line, 'IFC')) return changes ? `A missing email is now reported before a missing name: the order of the errors changes, as the person accepted. ${anchor(line, 'IFC')}`
          : `A missing name is still reported before a missing email: the order of the errors does not change. ${anchor(line, 'IFC')}`;
        if (anchor(line, 'CON')) return `The log line the validator writes keeps its format. ${anchor(line, 'CON')}`;
        return line;
      }).join('\n');
      await context.story.write(relative, text);
    }
    if (intent !== 'code') return wrote;
    const tags = async (relative, pattern) => (await story.read(relative)).split('\n').filter((line) => pattern.test(line));
    const clauses = await tags('src/value.mjs', /^\/\/ @clause:/u);
    const criteria = await tags('test/value.test.mjs', /^\/\/ @ac:/u);
    const kept = (record.behaviourDecisions ?? []).some((entry) => entry.choice === 'keep');
    const accepted = record.resolution.composition.kind === 'change';
    await context.story.write('src/value.mjs', `${clauses.join('\n')}\n${VALIDATOR(kept ? ['name', 'email'] : ['email', 'name'])}`);
    const [head, ...rest] = REFACTOR_FILES['test/value.test.mjs'].split('\n\n');
    const newOrder = accepted || (editsTest && !kept);
    const tests = rest.join('\n\n').replace(newOrder ? "['name is required', 'email is required']" : '\u0000', "['email is required', 'name is required']")
      .replace(accepted ? 'a missing name is reported before a missing email' : '\u0000', 'a missing email is reported before a missing name');
    await context.story.write('test/value.test.mjs', `${head}\n\n${criteria.join('\n')}\n${tests}`);
    return true;
  } };
};
const refactorAgent = refactorAgentWith();

/**
 * The person of a refactor: the generated person, who at a behaviour change makes `choice` on the decisions card the stop
 * names (`card`), or by the terminal command it offers.
 */
function behaviourPerson(choice, { card = false } = {}) {
  return (story) => {
    const person = generatedPerson(story, 'TASK-1');
    return (context) => {
      if (!/^singularity-flow work behaviour /u.test(context.route.shell ?? '')) return person(context);
      if (card) {
        const answer = decideCard(story, { choose: (item) => (item.kind === 'refactor-behaviour' ? item.options.find((entry) => entry.id === `${choice}-behaviour`) : null) });
        return answer ? { command: answer.command, agent: false, onCard: true } : null;
      }
      const offered = (context.result?.remediationPlan?.steps ?? []).map((step) => step.command).find((command) => new RegExp(`^singularity-flow work behaviour ${choice}\\b`, 'u').test(command ?? ''));
      return offered ? { command: offered, agent: false } : null;
    };
  };
}

const stopAtCode = (trail) => trail.findIndex((entry) => entry.code === 'REFACTOR_BEHAVIOUR_CHANGED' && /phase prepublish implementation\b/u.test(entry.ran ?? ''));

test('journey ITW, A13: a refactor that changes the order of two errors stops at its code step; the person keeps the old behaviour on the decisions card, and the last message names what no check covered', slowLane({ timeout: 2_400_000 }), async (t) => {
  const { story, walk } = await walkTask(t, 'tidy the validator in the value module', 'refactor', { files: REFACTOR_FILES,
    agent: refactorAgent, person: behaviourPerson('keep', { card: true }) });
  assert.equal(walk.reached, true, formatTrail(walk.trail));
  assert.deepEqual(walk.findings, [], JSON.stringify(walk.findings));
  // The run before any edit, then the stop at the code step's own gate, before the code was published or approved.
  assert.match(walk.trail[0].did ?? '', /checks on the base before any edit \(exit 0\)/u, formatTrail(walk.trail));
  const stop = stopAtCode(walk.trail);
  assert.ok(stop > 0, formatTrail(walk.trail));
  // On the decisions card, with SFlow's recommendation to keep it; the person's own step, never the agent's.
  assert.match(walk.trail[stop + 1].ran ?? '', /^singularity-flow decisions record TASK-1 --choose d1=keep-behaviour /u, formatTrail(walk.trail));
  assert.equal(walk.trail[stop + 1].turn, 'person');
  const record = storyRecord(story);
  assert.equal(record.resolution.composition.kind, 'refactor');
  assert.deepEqual(record.behaviourDecisions.map(({ phase, generation, choice, checks }) => ({ phase, generation, choice, checks })),
    [{ phase: 'implementation', generation: 1, choice: 'keep', checks: ['\'a missing name is reported before a missing email\''] }]);
  assert.match(story.git('show', 'TASK-1:src/value.mjs'), /\[\['name', 'name is required'\], \['email', 'email is required'\]\]/u, 'the code restored the old order');
  assert.equal(story.git('show', 'TASK-1:test/value.test.mjs').includes("['name is required', 'email is required']"), true, 'the test still expects it');
  assert.deepEqual(record.phaseOrder.map((id) => [id, record.phases[id].status]), [['intake', 'approved'], ['implementation-spec', 'approved'],
    ['implementation', 'approved'], ['verification', 'approved']]);
  // The last message: the checks that ran, and what the plan says must not change that none of them covered.
  const status = JSON.parse(story.cli('work', 'status', 'TASK-1', '--json'));
  assert.equal(status.words, 'TASK-1 is done: Intake, Plan: what must not change, Code, Tests, on branch TASK-1. Checks that ran: npm test (2 tests, all passed). '
    + 'Not covered by any check: The log line the validator writes keeps its format.');
  // The person: the words, the intake's answer, a Yes to the plan, keeping the old behaviour on the card and a Yes to the
  // code. Nothing typed again: after the card's decision VS Code sends /sf-task to the chat, as after a page approval.
  assert.ok(walk.trail.some((entry) => /VS Code sends \/sf-task to the chat the person used last/u.test(entry.did ?? '')), formatTrail(walk.trail));
  assert.deepEqual(personActions(walk.trail), { words: 1, typed: 0, answers: 3, own: 1, total: 5 }, formatTrail(walk.trail));
});

test('journey ITW: a refactor whose new behaviour the person accepts at its code step becomes a change with a revised plan, and ends', slowLane({ timeout: 2_400_000 }), async (t) => {
  const { story, walk } = await walkTask(t, 'tidy the validator in the value module', 'refactor', { files: REFACTOR_FILES,
    agent: refactorAgent, person: behaviourPerson('accept') });
  assert.equal(walk.reached, true, formatTrail(walk.trail));
  assert.deepEqual(walk.findings, [], JSON.stringify(walk.findings));
  const stop = stopAtCode(walk.trail);
  assert.ok(stop > 0, formatTrail(walk.trail));
  assert.match(walk.trail[stop + 1].ran ?? '', /^singularity-flow work behaviour accept --work-id TASK-1/u, formatTrail(walk.trail));
  const record = storyRecord(story);
  assert.equal(record.resolution.composition.kind, 'change');
  const grown = record.resolution.composition.changes.at(-1);
  assert.deepEqual({ change: grown.change, from: grown.from, to: grown.to, checks: grown.checks },
    { change: 'grow', from: 'refactor', to: 'change', checks: ['\'a missing name is reported before a missing email\''] });
  const request = record.changeRequests.find((entry) => entry.id === grown.changeRequest);
  assert.deepEqual([request.sourcePhase, request.targetPhase, request.behaviourChange?.checks], ['implementation', 'implementation-spec', grown.checks],
    'the code step went back to the plan by the person\'s acceptance');
  assert.equal(record.phases['implementation-spec'].generation, 2, 'the plan was revised');
  assert.match(story.git('show', `TASK-1:${story.item}/${record.phases['implementation-spec'].requiredArtifact.path}`), /the order of the errors changes, as the person accepted/u);
  assert.equal(story.git('show', 'TASK-1:test/value.test.mjs').includes("['email is required', 'name is required']"), true, 'the test says the new order');
  assert.deepEqual(record.phaseOrder.map((id) => record.phases[id].status), ['approved', 'approved', 'approved', 'approved']);
  const status = JSON.parse(story.cli('work', 'status', 'TASK-1', '--json'));
  assert.equal(status.kind, 'change');
  assert.match(status.words, /^TASK-1 is done: .* Checks that ran: npm test \(2 tests, all passed\)\.$/u, 'a change has no list of what must not change');
  assert.deepEqual(status.steps.map((step) => step.label), ['Intake', 'Plan', 'Code', 'Tests'], 'the plan is the change\'s own plan now');
  // The person: the words, the intake's answer, a Yes to the plan, accepting the new behaviour at their terminal, /sf-task
  // again, and a Yes to the revised plan and one to the code.
  assert.deepEqual(personActions(walk.trail), { words: 1, typed: 1, answers: 4, own: 1, total: 7 }, formatTrail(walk.trail));
});

test('journey ITW: a refactor whose author edits an existing test to expect the new order stops though no run fails; kept, SFlow puts back what the test expected', slowLane({ timeout: 2_400_000 }), async (t) => {
  const { story, walk } = await walkTask(t, 'tidy the validator in the value module', 'refactor', { files: REFACTOR_FILES,
    agent: refactorAgentWith({ editsTest: true }), person: behaviourPerson('keep', { card: true }) });
  assert.equal(walk.reached, true, formatTrail(walk.trail));
  assert.deepEqual(walk.findings, [], JSON.stringify(walk.findings));
  // The code step's tests passed with the edited test: the stop is the edit itself, from the version's diff against the base.
  const stop = stopAtCode(walk.trail);
  assert.ok(stop > 0, formatTrail(walk.trail));
  const record = storyRecord(story);
  assert.deepEqual(record.behaviourDecisions.map(({ choice, checks }) => ({ choice, checks })),
    [{ choice: 'keep', checks: ['the expectations of test/value.test.mjs'] }]);
  assert.equal(story.git('show', 'TASK-1:test/value.test.mjs').includes("['name is required', 'email is required']"), true, 'the test says what it said before');
  assert.match(story.git('show', 'TASK-1:src/value.mjs'), /\[\['name', 'name is required'\], \['email', 'email is required'\]\]/u, 'the code keeps the old order');
  assert.equal(record.status, 'closed');
  // The same five as a kept failing test: SFlow, not the person, put back what the test expected.
  assert.deepEqual(personActions(walk.trail), { words: 1, typed: 0, answers: 3, own: 1, total: 5 }, formatTrail(walk.trail));
});

// ------------------------------------------------------------------------------------ a marketplace agent as the plan

const MARKETPLACE_FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/sdlc-marketplace');
const QA_AGENT = 'acme/qa-test-automation-agent';

/** The fixture marketplace as a Git repository of its own, read at the commit it is trusted at. */
async function marketplaceRepository(t) {
  const directory = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'sflow-journey-market-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, 'acme');
  await cp(MARKETPLACE_FIXTURE, repository, { recursive: true });
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

test('journey ITW: a marketplace agent\'s workflow is a tests task\'s plan, walked to its end with the person\'s answer for its channel', slowLane({ timeout: 2_400_000 }), async (t) => {
  const acme = await marketplaceRepository(t);
  const story = await journeyRepository(t, { configure: (configuration) => {
    configuration.marketplaces = { acme: { label: 'Acme', repository: acme.repository, commit: acme.commit } };
  } });
  Object.assign(story, { workId: 'TASK-1', item: 'singularity/work-items/TASK-1' });
  // The agent's workflow, imported through the conversion review, as /sf-import does before the task uses it.
  const out = path.join(story.base, 'qa.workflow.json');
  story.cli('workflow', 'from-agent', QA_AGENT, '--out', out);
  const importPlan = JSON.parse(story.cli('workflow', 'import', out, '--dry-run', '--json'));
  story.cli('workflow', 'import', out, '--confirm', (importPlan.data ?? importPlan).planSha256);
  story.git('add', '-A');
  story.git('commit', '-qm', 'Import the QA workflow');
  story.git('push', '-q', 'origin', 'main');
  const walk = await followRoutes(story, {
    label: 'task tests from the QA agent',
    start: { shell: `singularity-flow work "add end-to-end tests for the checkout page" --kind tests --start --use-agent ${QA_AGENT}` },
    agent: generatedAgent('TASK-1'), person: generatedPerson(story, 'TASK-1'), values: { channel: 'web' },
    done: ({ record }) => record?.status === 'closed', maxSteps: 160
  });
  t.diagnostic(formatTrail(walk.trail));
  assert.equal(walk.reached, true, formatTrail(walk.trail));
  assert.deepEqual(walk.findings, [], JSON.stringify(walk.findings));
  const record = storyRecord(story);
  // The task's steps are the agent's workflow's, recorded with where they came from.
  assert.equal(record.workItem.workType, 'task-tests');
  assert.deepEqual(record.phaseOrder, ['qa-test-automation-intake', 'qa-test-automation-test-case-creation', 'qa-test-automation-test-automation',
    'qa-test-automation-execution-and-evidence']);
  const { commit: _read, ...agent } = record.resolution.composition.agent;
  assert.deepEqual(agent, { marketplace: 'acme', agent: 'qa-test-automation-agent', version: '1.0.0-pdlc', workflow: 'qa-test-automation' });
  // The agent's hard gate: the person's answer, recorded as the Story value its intake's submission records.
  assert.deepEqual(record.phases['qa-test-automation-intake'].decisionInputs?.values, { channel: 'web' });
  assert.deepEqual(record.phaseOrder.map((id) => record.phases[id].status), ['approved', 'approved', 'approved', 'approved']);
  assert.deepEqual(record.phaseOrder.filter((id) => record.phases[id].approvedBy && record.phases[id].approvalDisposition !== 'approved_automatically'),
    ['qa-test-automation-test-case-creation', 'qa-test-automation-test-automation'], 'a person approves the requirements and the tests, as the plan line said');
  // The agent's own question, with its choices, is asked once in the intake's clarification; the submission reads it, so
  // no route ever carried a `<channel>` to fill in.
  assert.ok(!walk.trail.some((entry) => /<channel>/u.test(`${entry.taking ?? ''} ${entry.ran ?? ''}`)), formatTrail(walk.trail));
  // The person: the words, the intake's answers (the channel among them), and a Yes to the requirements and to the tests.
  assert.deepEqual(personActions(walk.trail), { words: 1, typed: 0, answers: 3, own: 0, total: 4 }, formatTrail(walk.trail));
  const status = JSON.parse(story.cli('work', 'status', 'TASK-1', '--json'));
  assert.equal(status.done, true);
  assert.match(status.words, /^TASK-1 is done: .* Checks that ran: /u);
});
