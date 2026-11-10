/**
 * The owner's test on main a08ed273c (2026-11-11): attaching a Story at Specification listed an optional
 * assignment, then composing the prompt, then preparing, publishing and reviewing, all as "now". "The most
 * appropriate next step here is sf-phase." The step's own route leads; an optional prerequisite follows it,
 * labelled; the step's later stages are 'then'; and composing is never a step before prepare, which composes.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { approvedSpecificationStory, implementationPlan, startedSpecificationStory, CLI } from './helpers/submitted-planning-story.mjs';

const json = (result) => JSON.parse(result.stdout);
const nextsteps = (story) => json(story.run(process.execPath, [CLI, '--no-model', 'nextsteps', '--json']));

function assertPrimaryFirst(actions, { phase, skill, command = `singularity-flow prepare ${phase}` }) {
  const [primary] = actions;
  assert.equal(primary.command, command, JSON.stringify(actions.slice(0, 4)));
  assert.equal(primary.skill, skill);
  assert.equal(primary.timing, 'now');
  assert.deepEqual(actions.filter((action) => action.timing === 'now').map((action) => action.command), [primary.command], 'one primary action');
  const compose = actions.findIndex((action) => / wm compose /u.test(`${action.command} `));
  if (command.startsWith('singularity-flow prepare ')) assert.equal(compose, -1, 'prepare composes the prompt itself');
  else if (compose >= 0) assert.ok(compose > 0 && actions[compose].timing !== 'now', 'composing never comes before the step\'s own route');
  const assign = actions.findIndex((action) => action.command.startsWith(`singularity-flow assign ${phase} `));
  assert.ok(assign > 0, 'the optional assignment follows the primary');
  assert.equal(actions[assign].timing, 'optional');
  for (const later of actions.filter((action) => /^singularity-flow (?:phase publish|submit|review-source) /u.test(action.command))) {
    assert.notEqual(later.timing, 'now', later.command);
  }
}

test('a new Story at Specification leads with /sf-phase; the optional assignment follows, and later stages are then', async (t) => {
  const story = await startedSpecificationStory(t, 'NEXT-1');
  assertPrimaryFirst(nextsteps(story).actions, { phase: 'specification', skill: '/sf-phase' });
  // The words say which is next and which is optional, three routes each.
  const text = story.run(process.execPath, [CLI, '--no-model', 'nextsteps']).stdout;
  assert.match(text, /\nNext:\n1\. NOW — [^\n]*\n {3}- Copilot: \/sf-phase\n {3}- Shell: singularity-flow prepare specification\n {3}- VS Code/u);
  assert.match(text, /\nOptional:\n2\. OPTIONAL — Record who is coordinating 'specification'/u);
  // What a session's agent reads first: the primary, then the optional one, labelled; nothing that comes after.
  const opened = json(story.run(process.execPath, [CLI, '--no-model', 'session', 'open', 'NEXT-1', '--for-agent', '--json']));
  assert.deepEqual(opened.act.next.map((entry) => [entry.timing, entry.copilot]), [['now', '/sf-phase'], ['optional', '/sf-assign']]);
});

test('a required assignment still comes before the step\'s own route', async (t) => {
  const story = await startedSpecificationStory(t, 'NEXT-2', { configure: (configuration) => {
    configuration.collaboration = { ...(configuration.collaboration ?? {}), assignmentMode: 'required' };
  } });
  const actions = nextsteps(story).actions;
  assert.deepEqual(actions.slice(0, 2).map((action) => [action.timing, action.command]), [
    ['now', 'singularity-flow assign specification <assignee>'], ['now', 'singularity-flow prepare specification']]);
});

test('a code step needing its generation leads with /sf-code', async (t) => {
  const WORK = 'NEXT-3';
  const story = await approvedSpecificationStory(t, WORK);
  story.cli('prepare', 'planning');
  await writeFile(path.join(story.item, 'artifacts/planning/plan.md'), implementationPlan(WORK));
  story.cli('artifact', 'scan', '--phase', 'planning');
  story.cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  story.cli('submit', 'planning', '--skip-checks'); story.cli('approve', 'planning', '--yes');
  // Approving the plan prepared the code step, so its own route opens the code generation.
  const actions = nextsteps(story).actions;
  assertPrimaryFirst(actions, { phase: 'implementation', skill: '/sf-code', command: 'singularity-flow phase begin implementation --json' });
  // Its inputs are composed by /sf-code's entry; for the Shell they are the next stage, not a step before it.
  assert.equal(actions.find((action) => action.command === 'singularity-flow inputs implementation')?.timing ?? 'then', 'then');
});
