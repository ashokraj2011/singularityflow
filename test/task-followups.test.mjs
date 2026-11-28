/**
 * Intent to work v1.2 (docs/SPEC-ITW-INTENT-TO-WORK-v1.2.md REQ-109, REQ-110, REQ-111): an analysis is SFlow's to approve and
 * ends with follow-ups, one Yes starting a Story from one finding; a plan names what was used for similar changes before;
 * `work status` says who carries the /sf-task turn on.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

import { resolveWorkType, validateDefinition } from '../src/config.mjs';
import { composeTask, taskDefinition } from '../src/task-composition.mjs';
import { followUpKind, reportFollowUps, taskFollowUps } from '../src/task-followups.mjs';
import { checkoutTaskStories, planSource, similarTasks, storyOutcome, suggestion, taskHistory } from '../src/task-history.mjs';
import { chooseTaskAgent } from '../src/task-agents.mjs';
import { taskTurnCarrier } from '../src/task-turn.mjs';
import { journeyRepository } from './helpers/route-follower.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = YAML.parse(readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));

const REPORT = ['# Investigation', '', 'The value module exports 1.', '', '## Follow-ups', '',
  '1. **Return the approved value** from the value module.', '   It returns 1 where the approved value is 2.', '   Its callers read it directly.',
  '2. Pin the value in a test', '   No test reads it today.', '', '## Notes', '', '- Not a follow-up.', ''].join('\n');

test('ITW REQ-109: an analysis is SFlow\'s to approve when it is clean; nobody is asked', () => {
  for (const kind of ['investigate', 'review', 'docs']) {
    const composition = composeTask(BASE, { kind });
    const phases = resolveWorkType(validateDefinition(structuredClone(taskDefinition(BASE, composition))), composition.workType).phases;
    assert.deepEqual(phases.map((phase) => [phase.id, phase.approval.automatic]), [['intake', 'when-ready'], ['design', 'when-ready']], kind);
  }
  // A team rule that gives the report to a person still does [ITW:REQ-107].
  const ruled = Object.assign(structuredClone(BASE), { tasks: { always: [{ kinds: ['investigate'], personApproves: ['design'], because: 'A person reads every investigation.' }] } });
  const composition = composeTask(ruled, { kind: 'investigate' });
  const design = resolveWorkType(validateDefinition(structuredClone(taskDefinition(ruled, composition))), composition.workType).phases.find((phase) => phase.id === 'design');
  assert.notEqual(design.approval.automatic, 'when-ready');
});

test('ITW REQ-109: the report\'s Follow-ups become follow-ups, each with the complete command that starts it', () => {
  assert.deepEqual(reportFollowUps(REPORT), [
    { n: 1, title: 'Return the approved value from the value module', details: 'It returns 1 where the approved value is 2. Its callers read it directly.' },
    { n: 2, title: 'Pin the value in a test', details: 'No test reads it today.' }]);
  assert.deepEqual(reportFollowUps('# No follow-ups here\n\n1. A list item.'), []);
  assert.equal(followUpKind('Pin the value in a test', 'investigate'), 'tests');
  assert.equal(followUpKind('Return the approved value', 'investigate'), 'fix');
  const followUps = taskFollowUps({ id: 'TASK-1', kind: 'investigate', report: REPORT });
  assert.deepEqual(followUps.map((entry) => entry.command), [
    'singularity-flow work "Return the approved value from the value module" --from TASK-1 --finding 1 --kind fix --start',
    'singularity-flow work "Pin the value in a test" --from TASK-1 --finding 2 --kind tests --start']);
  assert.ok(followUps.every((entry) => !/<[^>]+>/u.test(entry.command)), 'complete commands');
  // A docs task's follow-up implements its document, bound to the version it wrote.
  assert.deepEqual(taskFollowUps({ id: 'TASK-4', kind: 'docs', report: '# Order export', document: 'singularity/work-items/TASK-4/artifacts/design/design.md', title: 'write a spec for order export' }),
    [{ n: 1, title: 'Implement write a spec for order export', details: 'Build what singularity/work-items/TASK-4/artifacts/design/design.md says, bound to the version TASK-4 wrote.', kind: 'feature',
      command: 'singularity-flow work "Implement write a spec for order export" --kind feature --document singularity/work-items/TASK-4/artifacts/design/design.md --start' }]);
});

test('ITW REQ-109: a follow-up\'s Story carries that finding alone; a finding that is not there is refused with one that is', async (t) => {
  const story = await journeyRepository(t);
  const started = JSON.parse(story.cli('work', 'why does the value module return 1', '--kind', 'investigate', '--start', '--json'));
  assert.equal((started.data ?? started).id, 'TASK-1');
  const record = JSON.parse(await story.read('singularity/work-items/TASK-1/workflow.json'));
  assert.equal(record.resolution.composition.sizing, 'requirement');
  assert.match(story.git('show', 'TASK-1:singularity/work-items/TASK-1/USER-STORY.md'), /## How SFlow runs this task[^]*## Follow-ups/u);
  await story.write(`singularity/work-items/TASK-1/${record.phases.design.requiredArtifact.path}`, REPORT);
  const missing = story.raw(['work', 'Pin it', '--kind', 'tests', '--from', 'TASK-1', '--finding', '7', '--new', '--start', '--json']);
  assert.notEqual(missing.status, 0);
  const refused = JSON.parse(missing.stdout.slice(missing.stdout.indexOf('{')));
  const error = refused.error ?? refused;
  assert.equal(error.code, 'TASK_FROM_NO_FINDING');
  // The refusal's way on, as the CLI prints it: the complete command.
  assert.equal(error.details.nextAction.command ?? error.details.nextAction, 'singularity-flow work "Return the approved value from the value module" --kind tests --start --from TASK-1 --finding 1 --new');
  const fix = JSON.parse(story.cli('work', 'Pin the value in a test', '--kind', 'tests', '--from', 'TASK-1', '--finding', '2', '--new', '--start', '--json'));
  assert.equal((fix.data ?? fix).id, 'TASK-2');
  const intake = story.git('show', 'TASK-2:singularity/work-items/TASK-2/USER-STORY.md');
  assert.match(intake, /## Starts from TASK-1's finding 2 \(artifacts\/[^)]+\)\n\nPin the value in a test\n\nNo test reads it today\./u);
  assert.doesNotMatch(intake, /Return the approved value/u, 'the other finding stays in its report');
  // Who carries the turn on: no hook ran here, so the skill does [ITW:REQ-111].
  const status = JSON.parse(story.cli('work', 'status', 'TASK-2', '--json'));
  assert.deepEqual(status.taskTurn, { carriedBy: 'skill' });
  assert.equal(await taskTurnCarrier(story.root, { env: story.env }), 'skill');
});

/** An earlier, closed task Story, as this checkout holds it once merged. */
const earlier = (id, { kind = 'tests', agent = null, local = null, generation = 1, returns = 0, files = ['src/value.mjs'] } = {}) => ({ id, files, workflow: {
  status: 'closed', phaseOrder: ['intake', 'implementation'],
  phases: { intake: { status: 'approved', approvedBy: 'Person', generation: 1 }, implementation: { status: 'approved', approvedBy: 'Person', generation } },
  changeRequests: Array.from({ length: returns }, (_, index) => ({ id: `CR-00${index + 1}` })),
  resolution: { composition: { kind, steps: [], ...(agent ? { agent } : {}), ...(local ? { local } : {}) } } } });

test('ITW REQ-110: the agent used most for similar changes before, with how those Stories went', async (t) => {
  const qa = { marketplace: 'acme', agent: 'qa-test-automation-agent', version: '1.0.0', workflow: 'qa' };
  const stories = [earlier('TASK-3', { agent: qa }), earlier('TASK-4', { agent: qa, generation: 2, returns: 1 }), earlier('TASK-5'),
    earlier('TASK-6', { kind: 'investigate', agent: qa }), earlier('TASK-7', { agent: qa, files: ['docs/x.md'] })];
  assert.deepEqual(planSource(stories[0].workflow.resolution.composition), { key: 'agent:acme/qa-test-automation-agent', kind: 'agent',
    id: 'acme/qa-test-automation-agent', words: 'acme\'s qa-test-automation agent', use: '--use-agent acme/qa-test-automation-agent' });
  assert.deepEqual(storyOutcome(stories[1].workflow), { firstTime: false, returns: 1, versions: 3 });
  // Similar: the same group and a shared area, or a file whose name the words say.
  const similar = similarTasks(stories, { kind: 'tests', said: 'add tests for the value module', files: [] });
  assert.deepEqual(similar.map((entry) => entry.id), ['TASK-3', 'TASK-4', 'TASK-5']);
  const suggested = suggestion(similar, { said: 'add tests for the value module' });
  assert.equal(suggested.line, 'For similar changes to src you used acme\'s qa-test-automation agent 2 times, 1 approved first time.');
  assert.deepEqual(suggested.stories, ['TASK-3', 'TASK-4']);
  // SFlow's own steps used most: nothing to suggest.
  assert.equal(suggestion([earlier('TASK-8'), earlier('TASK-9'), earlier('TASK-3', { agent: qa })]), null);
  assert.equal(suggestion([]), null);
  // The offer of the agent used before says so, and SFlow deciding is its no.
  const candidate = { id: 'acme/qa-test-automation-agent', marketplace: 'acme', agent: 'qa-test-automation-agent', version: '1.0.0', ready: true, kinds: [],
    lifecycle: 'ready', state: null, imported: { workflow: 'qa', version: '1.0.0' },
    steps: [{ id: 'a', intent: 'intake', label: 'Intake', tasks: [] }, { id: 'b', intent: 'code', label: 'Tests', tasks: ['unit-testing'] }, { id: 'c', intent: 'test', label: 'Run', tasks: [] }] };
  const offered = chooseTaskAgent(composeTask(BASE, { kind: 'tests' }), { candidates: [candidate], history: { suggestion: suggested } }).offer;
  assert.equal(offered.ask, 'For similar changes to src you used acme\'s qa-test-automation agent 2 times, 1 approved first time. Use it, or let SFlow decide?');
  assert.deepEqual([offered.yes, offered.no, offered.noWords], ['--use-agent acme/qa-test-automation-agent', '--without-agent acme/qa-test-automation-agent', 'let SFlow decide']);
  assert.equal(chooseTaskAgent(composeTask(BASE, { kind: 'tests' }), { candidates: [candidate] }).offer.history, undefined, 'no history, the plain offer');
  // Read from the checkout's Stories folder.
  const story = await journeyRepository(t);
  for (const entry of stories.slice(0, 2)) {
    await mkdir(path.join(story.root, 'singularity/work-items', entry.id), { recursive: true });
    await writeFile(path.join(story.root, 'singularity/work-items', entry.id, 'workflow.json'), JSON.stringify({ ...entry.workflow,
      resolution: { composition: { ...entry.workflow.resolution.composition, touchedPaths: entry.files } } }));
  }
  assert.deepEqual(checkoutTaskStories(story.root, ['singularity/work-items']).map((entry) => [entry.id, entry.files]), [['TASK-4', ['src/value.mjs']], ['TASK-3', ['src/value.mjs']]]);
  const history = await taskHistory(story.root, { kind: 'tests', said: 'add tests for the value module', folders: ['singularity/work-items'] });
  assert.equal(history.suggestion.line, 'For similar changes to src you used acme\'s qa-test-automation agent 2 times, 1 approved first time.');
  assert.equal(history.similar, 2);
});
