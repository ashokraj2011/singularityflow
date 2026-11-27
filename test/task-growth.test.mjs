/**
 * Intent to work, a task that grows (docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md REQ-004, REQ-009, REQ-014, A15): a fix whose code
 * changes the data or a public interface becomes a change, with its plan approved by a person before its code; a step a
 * team's rule gives a person stays theirs when it is added to a started task; a Story whose test agreement was confirmed
 * for its steps is started again with the step, by a complete command.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertTaskChangeScope, taskChangeDigest, taskChangePolicyDigest } from '../src/task-change-contracts.mjs';
import { assertTaskStepAddable, grownVersionDue, taskGrowth } from '../src/task-amendment.mjs';
import { rulePersonApproves } from '../src/task-composition.mjs';
import { MIGRATION_PATH } from '../src/application-paths.mjs';
import { isAllowedTestAutomationPath } from '../src/code-delivery-tests.mjs';
import { definedClauses } from '../src/workflow-walk/author.mjs';
import { generatedAgent, generatedPerson } from './helpers/generated-journey.mjs';
import { followRoutes, formatTrail, journeyRepository, storyRecord } from './helpers/route-follower.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const ITEM = 'singularity/work-items/TASK-1';
const json = (text) => JSON.parse(text);

/** A Story composed from its kind, as one started before v1.2 is (docs/SPEC-ITW-INTENT-TO-WORK-v1.2.md §4): `tasks.sizing: kind`. */
const v11 = (configuration) => { configuration.tasks = { ...(configuration.tasks ?? {}), sizing: 'kind' }; };
const grows = (files) => taskGrowth(files, { isTest: isAllowedTestAutomationPath, migration: MIGRATION_PATH });

test('ITW REQ-014: a fix grows into a change by the files its code changed, never by a test\'s own files', () => {
  assert.equal(grows(['src/value.mjs', 'test/value.test.mjs', 'README.md']), null);
  const data = grows(['src/value.mjs', 'db/migrations/0002_amount.sql']);
  assert.deepEqual(data.reasons, ['data']);
  assert.deepEqual(data.files, ['db/migrations/0002_amount.sql']);
  assert.equal(data.because, 'The code changes the data (db/migrations/0002_amount.sql), so a person approves a plan for it before the code');
  assert.deepEqual(grows(['db/migrate/20261125_add_amount.rb']).reasons, ['data']);
  assert.deepEqual(grows(['prisma/schema.prisma']).reasons, ['data']);
  assert.deepEqual(grows(['db/structure.sql']).reasons, ['data']);
  for (const contract of ['api/openapi.yaml', 'docs/swagger.json', 'events/asyncapi.yml', 'proto/value.proto', 'schema/value.graphql', 'src/value.gql']) {
    assert.deepEqual(grows([contract])?.reasons, ['interface'], contract);
  }
  const both = grows(['db/migrations/1.sql', 'api/openapi.yaml']);
  assert.deepEqual(both.reasons, ['data', 'interface']);
  assert.match(both.what, /^the data \(db\/migrations\/1\.sql\) and a public interface \(api\/openapi\.yaml\)$/u);
  // A test's own fixture is not the product's data, and a file merely named like a contract is not one.
  assert.equal(grows(['test/fixtures/migrations/0001.sql', 'src/openapi-client.mjs', 'src/schema.mjs']), null);
  // The same files always give the same answer, whatever their order.
  assert.deepEqual(grows(['b.proto', 'a.proto']), grows(['a.proto', 'b.proto']));
});

test('ITW REQ-004: the approvals the team\'s rules give a person, by kind and by the files the task touched', () => {
  const definition = { workTypes: {}, tasks: {
    always: [{ kinds: ['change'], personApproves: ['review'], because: 'A person reads every change\'s review.' }],
    paths: [{ paths: ['src/auth/**'], personApproves: ['design'], steps: ['design'], because: 'Auth changes get a design a person approves.' }] } };
  assert.deepEqual(rulePersonApproves(definition, 'fix', []), []);
  assert.deepEqual(rulePersonApproves(definition, 'change', []), ['review']);
  assert.deepEqual(rulePersonApproves(definition, 'fix', ['src/auth/login.mjs']), ['design']);
  assert.deepEqual(rulePersonApproves(definition, 'change', ['src/auth/login.mjs', 'src/value.mjs']), ['design', 'review']);
});

test('ITW REQ-009: a Story whose test agreement was confirmed for its steps is started again with the step, by a complete command', async () => {
  const steps = [{ id: 'intake', intent: 'intake', label: 'Intake' }, { id: 'implementation', intent: 'code', label: 'Code' },
    { id: 'verification', intent: 'test', label: 'Tests' }];
  const workflow = {
    workItem: { id: 'TASK-9', title: 'fix the "value" module' }, status: 'in_progress', currentPhase: 'intake', phaseOrder: steps.map((step) => step.id),
    phases: Object.fromEntries(steps.map((step) => [step.id, { status: step.id === 'intake' ? 'in_progress' : 'not_started' }])),
    testRecovery: { id: 'agreement-1', revision: 1 },
    resolution: { composition: { schemaVersion: 1, kind: 'fix', workType: 'task-fix', steps, added: [], personApproves: [], rules: [] } }
  };
  await assert.rejects(assertTaskStepAddable(workflow, 'design'), (error) => {
    assert.equal(error.code, 'TASK_CHANGE_REFUSED');
    assert.match(error.message, /test agreement was confirmed for the steps it started with/u);
    const { command } = error.details.nextAction;
    assert.equal(command, 'singularity-flow work "fix the \\"value\\" module" --kind fix --add design --new --start');
    assert.doesNotMatch(command, /<[^>]+>/u, 'a complete command, with nothing to fill in');
    assert.equal(error.details.cancel.command, 'singularity-flow cancel TASK-9 --reason "Started again with the step" --confirm TASK-9');
    return true;
  });
});

test('ITW REQ-014, REQ-015: a step a growth\'s return set back gets its next version once the plan is approved, and only once', () => {
  const returnedAt = '2026-11-25T10:00:00.000Z';
  const workflow = (overrides = {}) => ({
    currentPhase: 'implementation', phaseOrder: ['intake', 'implementation-spec', 'implementation', 'verification'],
    phases: { 'implementation-spec': { id: 'implementation-spec', status: 'approved', generation: 1 },
      implementation: { id: 'implementation', status: 'in_progress', generation: 1, reworkRevalidation: { generation: 1, invalidatedAt: returnedAt } } },
    changeRequests: [{ id: 'CR-001', sourcePhase: 'implementation', sourceGeneration: 1, targetPhase: 'implementation-spec', requestedAt: returnedAt,
      automatic: { kind: 'task-grown', files: ['db/migrations/1.sql'] } }],
    resolution: { composition: { kind: 'change', changes: [{ change: 'grow', from: 'fix', to: 'change' }] } },
    settledDecisions: [], ...overrides });
  const ready = workflow();
  assert.equal(grownVersionDue(ready, ready.phases.implementation)?.request.id, 'CR-001');
  const planOpen = workflow({ phases: { 'implementation-spec': { id: 'implementation-spec', status: 'awaiting_approval', generation: 1 },
    implementation: { id: 'implementation', status: 'not_started', generation: 1 } }, currentPhase: 'implementation-spec' });
  assert.equal(grownVersionDue(planOpen, planOpen.phases.implementation), null, 'not before the plan is approved');
  const started = workflow({ settledDecisions: [{ id: 'STL-001', kind: 'task-grown', phase: 'implementation', effect: { generation: 1, toGeneration: 2 } }] });
  assert.equal(grownVersionDue(started, started.phases.implementation), null, 'started once');
  const byPerson = workflow({ changeRequests: [{ ...ready.changeRequests[0], automatic: undefined }] });
  assert.equal(grownVersionDue(byPerson, byPerson.phases.implementation), null, 'a person\'s own return keeps its own yes');
  // A refactor whose new behaviour a person accepted: their return to the plan, named by the task's kind change, sets the
  // code and its tests back, and each gets its next version as the Story reaches it.
  const accepted = workflow({ currentPhase: 'verification',
    phases: { 'implementation-spec': { id: 'implementation-spec', status: 'approved', generation: 2 },
      implementation: { id: 'implementation', status: 'approved', generation: 2 },
      verification: { id: 'verification', status: 'in_progress', generation: 1, reworkRevalidation: { generation: 1, invalidatedAt: returnedAt } } },
    changeRequests: [{ id: 'CR-002', sourcePhase: 'verification', sourceGeneration: 1, targetPhase: 'implementation-spec', requestedAt: returnedAt }],
    resolution: { composition: { kind: 'change', changes: [{ change: 'grow', from: 'refactor', to: 'change', changeRequest: 'CR-002' }] } } });
  assert.equal(grownVersionDue(accepted, accepted.phases.verification)?.request.id, 'CR-002');
});

async function startedFix(t, tasks) {
  const story = await journeyRepository(t, { configure: (configuration) => { configuration.tasks = { sizing: 'kind', ...(tasks ?? {}) }; } });
  Object.assign(story, { workId: 'TASK-1', item: ITEM });
  json(story.cli('work', 'fix the value module so it returns 2', '--kind', 'fix', '--start', '--json'));
  return story;
}

test('ITW REQ-004, REQ-009: a step a person adds to a started task is a person\'s to approve when a team rule says so', async (t) => {
  const because = 'A person reads every review.';
  const story = await startedFix(t, { always: [{ personApproves: ['review'], because }] });
  // A new task's plan with the step gives it to a person too (without the rule, a review is SFlow's when it is clean).
  const plain = json(story.cli('work', 'fix the value module so it returns 2', '--kind', 'fix', '--add', 'review', '--new', '--json'));
  assert.equal(plain.steps.find((step) => step.id === 'conformance').approvedBy, 'person');
  const changed = json(story.cli('work', 'add', 'review', '--json'));
  assert.equal(changed.added.approvedBy, 'person');
  assert.equal(changed.words, 'Added a review step after the tests. You approve it.');
  const record = storyRecord(story);
  assert.deepEqual(record.resolution.composition.personApproves, ['review']);
  const pinned = record.resolution.phases.find((phase) => phase.id === 'conformance');
  assert.notEqual(pinned.approval.automatic, 'when-ready', JSON.stringify(pinned.approval));
  assert.notEqual(record.phases.conformance.approvalPolicy.automatic, 'when-ready');
});

test('ITW REQ-004, REQ-014: a step a team\'s path rule adds after the start is a person\'s to approve when the rule says so', async (t) => {
  const because = 'Changes to the value module get a review a person approves.';
  const story = await startedFix(t, { paths: [{ paths: ['src/**'], steps: ['review'], personApproves: ['review'], because }] });
  // The rule's own path at code submission (addRuleStepsAfterCode), run here on the started Story for the files it names.
  const script = `
    const { loadAcceptedStoryExecution } = await import(${JSON.stringify(path.join(SOURCE, 'accepted-story-execution.mjs'))});
    const { addTaskStep } = await import(${JSON.stringify(path.join(SOURCE, 'task-amendment.mjs'))});
    const { loadConfig } = await import(${JSON.stringify(path.join(SOURCE, 'state-stores.mjs'))});
    const root = process.cwd();
    const loaded = await loadAcceptedStoryExecution(root, 'TASK-1');
    const result = await addTaskStep(root, loaded.config ?? loaded.definition, loaded.workflow, { intent: 'review', definition: await loadConfig(root),
      rule: { rule: 'paths[0]', because: ${JSON.stringify(because)} }, touchedPaths: ['src/value.mjs'], changedPaths: ['src/value.mjs'] });
    console.log(JSON.stringify(result));`;
  const ran = story.spawn(process.execPath, ['--input-type=module', '-e', script]);
  assert.equal(ran.status, 0, ran.stderr);
  const result = json(ran.stdout.slice(ran.stdout.indexOf('{')));
  assert.equal(result.added.approvedBy, 'person');
  assert.equal(result.words, `Added a review step after the tests: ${because.replace(/\.$/u, '')}. You approve it.`);
  const record = storyRecord(story);
  assert.deepEqual(record.resolution.composition.personApproves, ['review']);
  assert.equal(record.resolution.composition.changes.at(-1).rule, 'paths[0]');
  assert.notEqual(record.resolution.phases.find((phase) => phase.id === 'conformance').approval.automatic, 'when-ready');
  json(story.cli('status', '--json'));
  // The contract: an approval rises only for the step the change adds.
  const before = json(story.git('show', `HEAD~1:${ITEM}/workflow.json`));
  const decision = json(readFileSync(path.join(story.root, record.taskChanges[0].decisionPath), 'utf8'));
  assertTaskChangeScope(before.resolution, record.resolution, decision);
  const widened = structuredClone(record.resolution);
  widened.composition.personApproves = ['review', 'test'];
  widened.policySha256 = taskChangePolicyDigest(widened);
  const forged = { ...structuredClone(decision), to: { ...decision.to, policySha256: widened.policySha256, compositionSha256: taskChangeDigest(widened.composition) } };
  assert.throws(() => assertTaskChangeScope(before.resolution, widened, forged), /gave a person the approval of a step it did not add/u);
  // And a step goes after the current one unless a fix grows: the same change one place earlier is refused.
  const early = { ...structuredClone(decision), position: 0 };
  assert.throws(() => assertTaskChangeScope(before.resolution, record.resolution, early), /malformed|after the current step, and only there|steps are not the task's steps/u);
});

test('ITW REQ-009: a plan added to a started fix leaves the requirement IDs with the intake that wrote them, beside the plan\'s', async (t) => {
  const story = await startedFix(t, undefined);
  const before = storyRecord(story);
  const intake = before.resolution.phases.find((phase) => phase.id === 'intake');
  assert.equal(intake.artifact.kind, 'requirements', 'a fix\'s intake writes the requirement IDs');
  const changed = json(story.cli('work', 'add', 'plan', '--json'));
  assert.equal(changed.words, 'Added a plan step before the code.');
  const record = storyRecord(story);
  assert.deepEqual(record.phaseOrder, ['intake', 'implementation-spec', 'implementation', 'verification']);
  assert.deepEqual(record.resolution.composition.clauseKeeps, ['intake']);
  assert.deepEqual(record.resolution.phases[0], before.resolution.phases[0], 'the intake keeps every setting it started with');
  assert.deepEqual(record.resolution.plannedClaims?.clausePhases, ['intake', 'implementation-spec']);
  assert.deepEqual(record.resolution.plannedClaims?.owners, { implementation: 'implementation-spec' });
  json(story.cli('status', '--json'));
});

const MIGRATION = 'db/migrations/0002_value_amount.sql';
/**
 * The journey's agent, whose code step adds a migration with the fix; the plan it writes once the fix is a change names
 * the migration among the paths it expects, as a plan written from the code on the branch does.
 */
function migratingAgent(workId) {
  const agent = generatedAgent(workId);
  return { ...agent, async author(context) {
    const wrote = await agent.author(context);
    const record = storyRecord(context.story);
    const resolved = (record?.resolution?.phases ?? []).find((phase) => phase.id === context.phase);
    if (resolved?.generation?.task === 'code') {
      // Tagged with the Story's clauses, as the code is: the plan names it among the paths each one changes.
      const clauses = [];
      for (const id of record.phaseOrder) {
        const relative = record.phases[id]?.requiredArtifact?.path;
        const text = relative ? await context.story.read(path.posix.join(context.story.item, relative)).catch(() => '') : '';
        for (const clause of definedClauses(text, workId)) if (!clauses.includes(clause)) clauses.push(clause);
      }
      await context.story.write(MIGRATION, `${clauses.map((clause) => `-- @clause:${clause} keeps the approved value in the amount column\n`).join('')}`
        + `-- version ${Math.max(1, Number(context.generation) || 1)}\nALTER TABLE value ADD COLUMN amount INTEGER NOT NULL DEFAULT 2;\n`);
    }
    const document = record?.phases?.[context.phase]?.requiredArtifact?.path;
    if (resolved?.intent === 'plan' && document) {
      const file = path.posix.join(context.story.item, document);
      const text = await context.story.read(file);
      await context.story.write(file, text.split('\n').map((line) => (/^\|\s*`[^`]+`\s*\|\s*`src\/value\.mjs`\s*\|/u.test(line)
        ? line.replace('`src/value.mjs`', `\`src/value.mjs\`, \`${MIGRATION}\``) : line)).join('\n'));
    }
    return wrote;
  } };
}

test('journey ITW REQ-014, A15: a fix whose code adds a migration becomes a change; a person approves its plan before its code, and its code step is kept', slowLane({ timeout: 2_400_000 }), async (t) => {
  const story = await journeyRepository(t, { configure: v11 });
  Object.assign(story, { workId: 'TASK-1', item: ITEM });
  const walk = await followRoutes(story, { label: 'task fix that grows', agent: migratingAgent('TASK-1'), person: generatedPerson(story, 'TASK-1'),
    start: { shell: 'singularity-flow work "fix the value module so it returns 2" --kind fix --start' },
    done: ({ record }) => record?.status === 'closed', maxSteps: 200 });
  t.diagnostic(formatTrail(walk.trail));
  const record = storyRecord(story);
  assert.deepEqual(record.phaseOrder, ['intake', 'implementation-spec', 'implementation', 'verification'], formatTrail(walk.trail));
  const composition = record.resolution.composition;
  assert.equal(composition.kind, 'change');
  assert.equal(record.workItem.workType, 'task-fix', 'the Story keeps the workflow it started with, grown');
  const grow = composition.changes.find((entry) => entry.change === 'grow');
  assert.deepEqual({ from: grow.from, to: grow.to, intent: grow.intent, paths: grow.paths },
    { from: 'fix', to: 'change', intent: 'plan', paths: ['db/migrations/0002_value_amount.sql'] });
  assert.match(grow.because, /^The code changes the data \(db\/migrations\/0002_value_amount\.sql\), so a person approves a plan for it before the code\.$/u);
  assert.equal(record.taskChanges.length, 1);
  const decision = json(readFileSync(path.join(story.root, record.taskChanges[0].decisionPath), 'utf8'));
  assert.equal(decision.id, 'TSC-001');
  assert.equal(decision.change.change, 'grow');
  assert.equal(decision.afterPhase, 'implementation');
  // SFlow returned the code to the plan, and started its next version once the plan was approved.
  const returned = record.changeRequests.find((entry) => entry.automatic?.kind === 'task-grown');
  assert.equal(returned?.sourcePhase, 'implementation');
  assert.equal(returned?.targetPhase, 'implementation-spec');
  assert.ok((record.settledDecisions ?? []).some((entry) => entry.kind === 'task-grown' && entry.phase === 'implementation'), JSON.stringify(record.settledDecisions));
  // The code is approved by a person after the plan, and never before it.
  assert.ok(record.phases['implementation-spec'].approvedBy, 'a person approved the plan');
  assert.ok(record.phases.implementation.approvedBy, 'a person approved the code');
  assert.ok(Date.parse(record.phases.implementation.approvedAt) > Date.parse(record.phases['implementation-spec'].approvedAt));
  assert.equal(record.status, 'closed', formatTrail(walk.trail));
  assert.equal(record.phases.implementation.generation, 2, 'the code step was kept, with its next version after the plan');
  // What the person did: the words, the intake's one question, and three approvals (the plan in the intake, the plan, the
  // code), each a Yes in the chat while SFlow carries the /sf-task turn on [owner 2026-11-26]. Nothing else: no yes for the
  // change itself, none for the code's next version, and no step at the card or the terminal.
  const yes = walk.trail.filter((entry) => /the person answered Yes to "Approve /u.test(entry.did ?? ''));
  assert.deepEqual(yes.map((entry) => entry.did.match(/"Approve ([^"]+)\?"/u)[1]), ['Intake v1', 'Plan v1', 'Code v2'], formatTrail(walk.trail));
  assert.equal(walk.trail.filter((entry) => /the person answered/u.test(entry.did ?? '')).length, 4, formatTrail(walk.trail));
  assert.equal(walk.trail.filter((entry) => entry.turn === 'person').length, 0, formatTrail(walk.trail));
  assert.equal(walk.reached, true, formatTrail(walk.trail));
  assert.deepEqual(walk.findings, [], JSON.stringify(walk.findings));
});
