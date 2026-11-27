/**
 * Story lessons, walked by their routes [LRN-v1]: two Stories in one repository, each as its agent and person take
 * SFlow's own routes. The first Story's test step fails, SFlow sends the work back, and the fix passes: its code step's
 * approval keeps a lesson. The second Story's code step is given that lesson in its prompt, makes the same mistake
 * anyway, and the repeat is counted and said at its end. A third makes it again: the lesson is pinned and offered as a
 * team guidance. Slow lane: the walks run the CLI as a person and an agent do.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { check, clarifications, cooperativePerson, quickFixIntake, report, reviewer, settle, writeValueCode } from './helpers/journey-scripts.mjs';
import { followRoutes, journeyRepository, startStory, storyRecord } from './helpers/route-follower.mjs';
import { reviewStep } from './helpers/step-review.mjs';
import { slowLane } from './helpers/slow-lane.mjs';
import { givenLessons, readAllLessons } from '../src/story-lessons.mjs';
import { lessonsAfterApproval, storyLessonsLine, storyLessonsUse } from '../src/story-lessons-notice.mjs';

const VALUE_CHECK = ["import { value } from '../src/value.mjs';", '',
  "if (value !== 2) { console.error(`AssertionError: the value must be 2, got ${value}`); process.exit(1); }", "console.log('ok value 2');", ''].join('\n');
const fillTodos = (text, words) => text.replace(/TODO:[^\n]*/gu, words).replace(/\bTODO\b/gu, 'none');

function testedChange(configuration) {
  configuration.workTypes['tested-change'] = { label: 'Tested change', description: 'Scope and plan, code, and a test step that runs the value check and changes no code.',
    phases: ['intake', 'implementation', 'verification'],
    plannedClaims: { mode: 'required', clausePhases: ['intake'], owners: { implementation: 'intake' } },
    templateOverrides: { intake: 'quick-fix/intake.md' },
    phaseOverrides: {
      intake: { label: 'Scope and plan', artifact: { kind: 'requirements' }, clarification: { mode: 'off' },
        approval: { authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['intake'] } },
      implementation: { inputs: ['intake'], approval: { authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['intake', 'implementation'] } },
      verification: { inputs: ['intake', 'implementation'], clarification: { mode: 'off' },
        qualityCommands: [{ id: 'value-check', kind: 'test', argv: [process.execPath, 'checks/value-check.mjs'], modelPolicy: 'never' }],
        approval: { authorities: ['quality-reviewers'], minimum: 1, rejectTo: ['intake', 'implementation', 'verification'] } }
    } };
}

/** A Story of the tested-change kind in the same repository, its scope approved. */
async function testedChangeAtCode(story, W) {
  startStory(story, W, { workType: 'tested-change', title: 'Change the value', description: 'Return 2.' });
  story.cli('prepare', 'intake');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(W));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  reviewStep((args) => JSON.parse(story.cli(...args)), 'intake');
  story.cli('submit', 'intake');
  story.cli('approve', 'intake', '--yes');
}

/** The code step writes 1 first, as the mistake, and 2 once the failing check sent it back. */
const author = (W) => async ({ story: s, phase, generation }) => {
  if (phase === 'implementation') {
    const open = storyRecord(s)?.phases?.implementation?.generationIntent;
    const version = open?.status === 'open' ? Number(open.generation) : Number(generation ?? 0) + 1;
    const value = version >= 2 ? 2 : 1;
    await writeValueCode(s, { value, clauses: [`${W}:AC-001`], note: `returns the approved value (version ${version})` });
    await s.write(`${s.item}/artifacts/implementation/implementation-summary.md`, [`# ${W} — Implementation Summary`, '', '## Agent brief', '',
      `Version ${version} sets the exported value to ${value}.`, '', '## Implemented outcome', '', `\`src/value.mjs\` exports ${value}.`, '',
      '## Changed components and decisions', '', `- \`src/value.mjs\` carries \`@clause:${W}:AC-001\` beside the constant it sets.`, '',
      '## Tests and operational notes', '', `\`test/value.test.mjs\` (tagged \`@ac:${W}:AC-001\`) reads the value; \`npm test\` runs it.`, ''].join('\n'));
    return true;
  }
  if (phase === 'verification') {
    const file = `${s.item}/artifacts/verification/test-evidence.md`;
    const before = await s.read(file).catch(() => '');
    await s.write(file, fillTodos(before, `Ran the value check (\`node checks/value-check.mjs\`) on the code ${W}:AC-001 names; its result is the run this step records.`));
    return true;
  }
  return false;
};

async function walkStory(t, story, W) {
  await testedChangeAtCode(story, W);
  const walk = await followRoutes(story, {
    label: `lessons ${W}`, start: { copilot: '/sf-code' },
    agent: { author: author(W), review: reviewer(), clarify: clarifications() },
    person: cooperativePerson(() => null),
    done: ({ record }) => ['approved', 'completed'].includes(record?.phases?.verification?.status) && Number(record.phases.verification.generation) >= 2, maxSteps: 120
  });
  t.diagnostic(`${W}: ${walk.reached ? 'reached' : 'not reached'}`);
  return walk;
}

test('journey LRN: a Story\'s failing test becomes a lesson, the next Story is given it, repeats the mistake anyway, and the third is offered as team guidance', slowLane({ timeout: 3_600_000 }), async (t) => {
  const story = await journeyRepository(t, { files: { 'checks/value-check.mjs': VALUE_CHECK }, configure: testedChange });

  const first = await walkStory(t, story, 'LRN-J1');
  await check(t, 'the first Story goes from the failing check to the passing one by its routes', {}, () => {
    assert.equal(first.reached, true, report(first));
    assert.deepEqual(first.findings, [], report(first));
  });
  const kept = (await readAllLessons(story.root, { base: false })).entries.filter((entry) => entry.record.lesson?.kind === 'failing-test');
  await check(t, 'the code step\'s approval kept the failing test as a lesson, with the files the fix changed', {}, () => {
    assert.equal(kept.length, 1, JSON.stringify(kept.map((entry) => entry.record.text)));
    assert.deepEqual(kept[0].record.lesson.origin, { workId: 'LRN-J1', phase: 'implementation' });
    assert.ok(kept[0].record.scope.paths.includes('src/value.mjs'), JSON.stringify(kept[0].record.scope));
  });

  const second = await walkStory(t, story, 'LRN-J2');
  await check(t, 'the second Story goes the same way by its routes', {}, () => {
    assert.equal(second.reached, true, report(second));
    assert.deepEqual(second.findings, [], report(second));
  });
  await check(t, 'its code step was given the first Story\'s lesson, and the same mistake counted a repeat', {}, async () => {
    assert.ok((await givenLessons(story.root, 'LRN-J2', 'implementation')).includes(kept[0].sha256), 'the lesson was in the code step\'s prompt');
    const use = await storyLessonsUse(story.root, 'LRN-J2');
    assert.equal(use.repeated, 1, JSON.stringify(use));
    assert.match(storyLessonsLine(use), /1 earlier mistake happened again although its lesson was in the step's prompt\.$/u);
  });

  const third = await walkStory(t, story, 'LRN-J3');
  await check(t, 'the third repeat pins the lesson and the approval offers it as team guidance', {}, async () => {
    assert.equal(third.reached, true, report(third));
    const after = await lessonsAfterApproval(story.root, 'LRN-J3', 'implementation');
    assert.equal(after?.ruleOffers?.length, 1, JSON.stringify(after));
    assert.match(after.line, /Make it team guidance, first for every step on these files: singularity-flow lessons guidance K-[0-9a-f]{12}/u);
    const current = (await readAllLessons(story.root, { base: false })).entries.find((entry) => entry.record.id === after.ruleOffers[0].id);
    assert.equal(current.record.lesson.pinned, true);
    assert.equal(current.record.lesson.repeats, 2);
  });
  settle(t);
});
