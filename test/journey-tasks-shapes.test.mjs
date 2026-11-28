/**
 * Journeys ITW v1.2 (docs/SPEC-ITW-INTENT-TO-WORK-v1.2.md REQ-101–112): a task walked from its words to its end by its
 * routes, as Copilot CLI drives it, with the workflow's own checks deciding each step; each counts what the person did.
 * - a small change: the requirement, then one step that implements and tests, then SFlow's run of the tests: 3 actions;
 * - a big change, whose requirement proposes it: spec, plan, code and tests after it: 4 actions;
 * - a small change whose code turns out bigger: it grows, with a plan before the code and tests after: 4 actions.
 * The scripted agent writes each step from its own template (test/helpers/generated-journey.mjs).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { definedClauses } from '../src/workflow-walk/author.mjs';
import { generatedAgent, generatedPerson } from './helpers/generated-journey.mjs';
import { followRoutes, formatTrail, journeyRepository, storyRecord } from './helpers/route-follower.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

/** What the person did on a walk [ITW:REQ-112]: their words, each /sf-task typed again, each answer, each step of their own. */
export const personActions = (trail) => {
  const typed = trail.filter((entry) => entry.typed).length;
  const answers = trail.filter((entry) => /the person answered/u.test(entry.did ?? '')).length;
  const own = trail.filter((entry) => entry.turn === 'person').length;
  return { words: 1, typed: Math.max(0, typed - 1), answers, own, total: Math.max(1, typed) + answers + own };
};
/** The approval questions the person answered Yes to, in order. */
const answeredYes = (trail) => trail.map((entry) => /the person answered Yes to "([^"]+)"/u.exec(entry.did ?? '')?.[1]).filter(Boolean);

export async function walkTask(t, words, kind, { files = {}, configure = null, agent = null, person = null, maxSteps = 160, start = null, follow = {} } = {}) {
  const story = await journeyRepository(t, { files, configure });
  Object.assign(story, { workId: 'TASK-1', item: 'singularity/work-items/TASK-1' });
  const walk = await followRoutes(story, {
    label: `task ${kind}`,
    start: { shell: start ?? `singularity-flow work "${words}" --kind ${kind} --start` },
    agent: agent?.(story) ?? generatedAgent('TASK-1'), person: person?.(story) ?? generatedPerson(story, 'TASK-1'),
    done: ({ record }) => record?.status === 'closed', maxSteps, ...follow
  });
  t.diagnostic(formatTrail(walk.trail));
  return { story, walk };
}

/** The scripted agent, who also writes what its requirement says about the size (`size`) and, at its code step, `extra` files. */
export function sizingAgent({ size = null, extra = [] } = {}) {
  return (story) => {
    const agent = generatedAgent('TASK-1');
    return { ...agent, async author(context) {
      const wrote = await agent.author(context);
      const record = storyRecord(story);
      const step = record?.resolution?.composition?.steps?.find((entry) => entry.id === context.phase);
      const document = record?.phases?.[context.phase]?.requiredArtifact?.path;
      const file = document ? path.posix.join(story.item, document) : null;
      const clauses = [];
      for (const id of record?.phaseOrder ?? []) {
        const relative = record.phases[id]?.requiredArtifact?.path;
        const text = relative ? await context.story.read(path.posix.join(story.item, relative)).catch(() => '') : '';
        for (const clause of definedClauses(text, 'TASK-1')) if (!clauses.includes(clause)) clauses.push(clause);
      }
      if (step?.intent === 'intake' && size && file) {
        const text = await context.story.read(file);
        if (!/^Size:/mu.test(text)) await context.story.write(file, `${text.trimEnd()}\n\n## Size\n\nSize: ${size} change. The value module and its callers move together.\n`);
      }
      if (step?.intent === 'code' && extra.length) {
        // Each file the code changes carries the Story's clauses, as the value module does.
        for (const relative of extra) {
          await context.story.write(relative, `${clauses.map((clause) => `// @clause:${clause} reads the approved value\n`).join('')}`
            + `export const reads = 'v${Math.max(1, Number(context.generation) || 1)}';\n`);
        }
      }
      if (step?.intent === 'plan' && extra.length && file) {
        const text = await context.story.read(file);
        await context.story.write(file, text.split('\n').map((line) => (/^\|\s*`[^`]+`\s*\|\s*`src\/value\.mjs`\s*\|/u.test(line)
          ? line.replace('`src/value.mjs`', ['`src/value.mjs`', ...extra.map((relative) => `\`${relative}\``)].join(', ')) : line)).join('\n'));
      }
      return wrote;
    },
    // A spec written after the requirement names its own clauses: one it defined again (as the requirement's) is given the
    // next free number, as the check asks ("give the new clause its own number").
    async correct(context) {
      const findings = context.result?.findings ?? [];
      const again = findings.filter((entry) => entry?.details?.sourceCode === 'SPEC_CLAUSE_REDEFINED' && entry.path);
      if (!again.length) return agent.correct(context);
      for (const file of new Set(again.map((entry) => entry.path))) {
        const text = await context.story.read(file);
        const taken = new Set([...text.matchAll(/TASK-1:([A-Z]+)-(\d{3})/gu)].map((match) => `${match[1]}-${match[2]}`));
        for (const entry of again) for (const match of String(entry.message).matchAll(/TASK-1:([A-Z]+-\d{3})/gu)) taken.add(match[1]);
        const next = (prefix) => { let n = 1; while (taken.has(`${prefix}-${String(n).padStart(3, '0')}`)) n += 1; const id = `${prefix}-${String(n).padStart(3, '0')}`; taken.add(id); return id; };
        let changed = text;
        for (const entry of again) {
          const [, clause] = /Clause TASK-1:([A-Z]+-\d{3})/u.exec(entry.message) ?? [];
          if (clause) changed = changed.replaceAll(`[TASK-1:${clause}]`, `[TASK-1:${next(clause.split('-')[0])}]`);
        }
        await context.story.write(file, changed);
      }
      return true;
    } };
  };
}

test('journey ITW v1.2, B1: a small change is its requirement, one step that implements and tests, and SFlow\'s run of the tests; the person takes 3 actions', slowLane({ timeout: 2_400_000 }), async (t) => {
  const { story, walk } = await walkTask(t, 'make the value module return 2', 'change');
  assert.deepEqual(walk.findings, [], `${JSON.stringify(walk.findings)}\n${formatTrail(walk.trail)}`);
  assert.equal(walk.reached, true, formatTrail(walk.trail));
  const record = storyRecord(story);
  assert.equal(record.resolution.composition.sizing, 'requirement');
  assert.deepEqual(record.phaseOrder, ['intake', 'implementation', 'verification']);
  assert.deepEqual(record.phaseOrder.map((id) => record.phases[id].label), ['Requirement', 'Implement and test', 'Tests']);
  assert.deepEqual(record.phaseOrder.filter((id) => record.phases[id].approvedBy), ['intake', 'implementation']);
  // The tests step is SFlow's own: it ran the repository's tests and approved itself when they passed.
  assert.equal(record.phases.verification.approvalDisposition, 'approved_automatically');
  // The requirement asked nothing: the words left nothing open, so its approval came next.
  assert.ok(!walk.trail.some((entry) => /the agent asked \d+ question/u.test(entry.did ?? '')), formatTrail(walk.trail));
  assert.deepEqual(answeredYes(walk.trail), ['Approve the requirement v1 · Small change: implement and test next?', 'Approve Implement and test v1?']);
  // SFlow ran the tests itself at the code step, and kept the run as its delivery evidence.
  assert.ok(walk.trail.some((entry) => /phase prepublish implementation\b/u.test(entry.ran ?? '')), formatTrail(walk.trail));
  assert.ok(record.phases.implementation.deliveryEvidence?.changeSetPath, JSON.stringify(record.phases.implementation.deliveryEvidence));
  const status = JSON.parse(story.cli('work', 'status', 'TASK-1', '--json'));
  assert.equal(status.done, true);
  assert.equal(status.shape, 'small');
  assert.match(status.words, /^TASK-1 is done: Requirement, Implement and test, Tests, on branch TASK-1\. Checks that ran: npm test/u);
  // The change's own page, "What this change does", is written for the step that implements and tests [CSP].
  assert.match(story.git('show', `TASK-1:${story.item}/CHANGE-STORY.md`), /\S/u);
  assert.equal(status.changeStory?.path, `${story.item}/CHANGE-STORY.md`, JSON.stringify(Object.keys(status)));
  assert.deepEqual(personActions(walk.trail), { words: 1, typed: 0, answers: 2, own: 0, total: 3 }, formatTrail(walk.trail));
});

test('journey ITW v1.2, B2: a requirement that proposes a big change gains spec, plan, code and tests; the person takes 4 actions', slowLane({ timeout: 2_400_000 }), async (t) => {
  const { story, walk } = await walkTask(t, 'make the value module return 2 for every caller', 'change', { agent: sizingAgent({ size: 'big' }) });
  assert.deepEqual(walk.findings, [], `${JSON.stringify(walk.findings)}\n${formatTrail(walk.trail)}`);
  assert.equal(walk.reached, true, formatTrail(walk.trail));
  const record = storyRecord(story);
  assert.deepEqual(record.phaseOrder, ['intake', 'requirements', 'implementation-spec', 'implementation', 'verification']);
  assert.deepEqual(record.phaseOrder.map((id) => record.phases[id].label), ['Requirement', 'Spec', 'Plan', 'Code', 'Tests']);
  const shaped = record.resolution.composition.changes.filter((entry) => entry.shape === 'big');
  assert.deepEqual(shaped.map((entry) => entry.intent), ['plan', 'requirements'], 'the plan first, so the requirement stays the person\'s and the spec SFlow\'s');
  assert.match(shaped[0].because, /^Copilot proposes a big change\.$/u);
  // A person approves the requirement, the plan and the code; SFlow the spec and the tests.
  assert.deepEqual(record.phaseOrder.filter((id) => record.phases[id].approvalDisposition !== 'approved_automatically'), ['intake', 'implementation-spec', 'implementation']);
  assert.deepEqual(answeredYes(walk.trail), ['Approve the requirement v1 · Big change: spec, plan, code and tests next (Copilot proposes a big change)?', 'Approve Plan v1?', 'Approve Code v1?']);
  assert.equal(JSON.parse(story.cli('work', 'status', 'TASK-1', '--json')).shape, 'big');
  assert.deepEqual(personActions(walk.trail), { words: 1, typed: 0, answers: 3, own: 0, total: 4 }, formatTrail(walk.trail));
});

const SIX_FILES = ['src/reads/a.mjs', 'src/reads/b.mjs', 'lib/c.mjs', 'lib/d.mjs', 'app/e.mjs', 'app/f.mjs'];

test('journey ITW v1.2, B4: a small change whose code turns out bigger grows: a plan before the code, tests after it; the person takes 4 actions', slowLane({ timeout: 2_400_000 }), async (t) => {
  const { story, walk } = await walkTask(t, 'make the value module return 2', 'change', { agent: sizingAgent({ extra: SIX_FILES }), maxSteps: 220 });
  assert.deepEqual(walk.findings, [], `${JSON.stringify(walk.findings)}\n${formatTrail(walk.trail)}`);
  assert.equal(walk.reached, true, formatTrail(walk.trail));
  const record = storyRecord(story);
  assert.deepEqual(record.phaseOrder, ['intake', 'implementation-spec', 'implementation', 'verification']);
  const composition = record.resolution.composition;
  const grow = composition.changes.find((entry) => entry.change === 'grow');
  assert.deepEqual({ from: grow.from, to: grow.to, intent: grow.intent }, { from: 'change', to: 'change', intent: 'plan' });
  assert.match(grow.because, /^The code changes 7 application files in 4 areas/u);
  assert.ok(walk.trail.some((entry) => /is a big change now/u.test(`${entry.did ?? ''} ${entry.said ?? ''} ${entry.stdout ?? ''}`)) || record.changeRequests.some((entry) => entry.automatic?.kind === 'task-grown'),
    formatTrail(walk.trail));
  assert.equal(record.phases.implementation.generation, 2, 'the code step was kept, with its next version after the plan');
  assert.deepEqual(answeredYes(walk.trail), ['Approve the requirement v1 · Small change: implement and test next?', 'Approve Plan v1?', 'Approve Code v2?']);
  assert.deepEqual(personActions(walk.trail), { words: 1, typed: 0, answers: 3, own: 0, total: 4 }, formatTrail(walk.trail));
});

const FOLLOW_UPS = ['', '## Follow-ups', '', '1. Return the approved value from the value module', '   It returns 1 where the approved value is 2.',
  '2. Pin the value in a test', '   No test reads it today.', ''].join('\n');

/** The scripted agent of an analysis: its report ends with its follow-ups, as SFlow's intake asks. */
const reportingAgent = (story) => {
  const agent = generatedAgent('TASK-1');
  return { ...agent, async author(context) {
    const wrote = await agent.author(context);
    const record = storyRecord(story);
    const step = record?.resolution?.composition?.steps?.find((entry) => entry.id === context.phase);
    const document = record?.phases?.[context.phase]?.requiredArtifact?.path;
    if (step?.intent === 'design' && document) {
      const file = path.posix.join(story.item, document);
      const text = await context.story.read(file);
      if (!/^## Follow-ups/mu.test(text)) await context.story.write(file, `${text.trimEnd()}\n${FOLLOW_UPS}`);
    }
    return wrote;
  } };
};

test('journey ITW v1.2, B7: an investigation is done with no approval and offers its follow-ups; one Yes starts a fix from that finding: 2 actions', slowLane({ timeout: 2_400_000 }), async (t) => {
  const { story, walk } = await walkTask(t, 'why does the value module return 1', 'investigate', { agent: reportingAgent });
  assert.deepEqual(walk.findings, [], `${JSON.stringify(walk.findings)}\n${formatTrail(walk.trail)}`);
  assert.equal(walk.reached, true, formatTrail(walk.trail));
  const record = storyRecord(story);
  assert.deepEqual(record.phaseOrder, ['intake', 'design']);
  assert.deepEqual(record.phaseOrder.map((id) => record.phases[id].approvalDisposition), ['approved_automatically', 'approved_automatically']);
  assert.equal(story.git('diff', '--name-only', 'main', 'TASK-1', '--', 'src', 'test'), '', 'no code changed');
  // Nothing asked of the person until the end: their words only.
  assert.deepEqual(personActions(walk.trail), { words: 1, typed: 0, answers: 0, own: 0, total: 1 }, formatTrail(walk.trail));
  const status = JSON.parse(story.cli('work', 'status', 'TASK-1', '--json'));
  assert.equal(status.shape, 'analysis');
  assert.equal(status.ask, 'Start a story from one of these findings? Each starts a new task that carries only that finding; No starts nothing, and the report stays.');
  assert.deepEqual(status.followUps.map((entry) => [entry.n, entry.title, entry.kind]), [[1, 'Return the approved value from the value module', 'fix'], [2, 'Pin the value in a test', 'tests']]);
  // The person's one Yes, to the first: its command, as the skill runs it.
  const [first] = status.followUps;
  assert.equal(first.command, 'singularity-flow work "Return the approved value from the value module" --from TASK-1 --finding 1 --kind fix --start');
  const started = JSON.parse(story.cli('work', first.title, '--from', 'TASK-1', '--finding', '1', '--kind', 'fix', '--start', '--json'));
  assert.equal((started.data ?? started).id, 'TASK-2');
  const intake = story.git('show', 'TASK-2:singularity/work-items/TASK-2/USER-STORY.md');
  assert.match(intake, /## Starts from TASK-1's finding 1 \([^)]+\)\n\nReturn the approved value from the value module\n\nIt returns 1 where the approved value is 2\./u);
  assert.doesNotMatch(intake, /Pin the value in a test/u);
  assert.equal(personActions(walk.trail).total + 1, 2, 'the words and one follow-up');
});

test('journey ITW v1.2, B9: with no hooks the /sf-task skill carries its own turn on; a small change still takes 3 actions', slowLane({ timeout: 2_400_000 }), async (t) => {
  const { story, walk } = await walkTask(t, 'make the value module return 2', 'change', { follow: { hooks: false } });
  assert.deepEqual(walk.findings, [], `${JSON.stringify(walk.findings)}\n${formatTrail(walk.trail)}`);
  assert.equal(walk.reached, true, formatTrail(walk.trail));
  const record = storyRecord(story);
  assert.deepEqual(record.phaseOrder, ['intake', 'implementation', 'verification']);
  assert.ok(walk.trail.some((entry) => /the \/sf-task skill carries its own turn on, no hook ran/u.test(entry.did ?? '')), formatTrail(walk.trail));
  assert.ok(!walk.trail.some((entry) => /SFlow carries the \/sf-task turn on/u.test(entry.did ?? '')), 'no hook carried anything');
  assert.deepEqual(personActions(walk.trail), { words: 1, typed: 0, answers: 2, own: 0, total: 3 }, formatTrail(walk.trail));
});
