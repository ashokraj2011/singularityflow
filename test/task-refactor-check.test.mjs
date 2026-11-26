/**
 * Intent to work, refactoring (docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md REQ-015, A13): a refactor's test step compares its run
 * with the run before the change that `task.before` kept. A check that passed before and fails after is a behaviour change:
 * the step stops and names it, and the person keeps the old behaviour (back to the code) or accepts the new one (back to
 * the plan, and the task becomes a change); a check that already failed before stays a finding.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { afterCheckOf, checkNames, refactorCodeStep, refactorHold } from '../src/failing-tests-return.mjs';
import { behaviourCommands, behaviourDecisionsOf } from '../src/refactor-behaviour.mjs';
import { checksWords, planItems, taskChecks } from '../src/task-checks.mjs';
import { assertTaskChangeScope, stableTaskStepState, taskChangeDigest, taskChangePolicyDigest } from '../src/task-change-contracts.mjs';
import { journeyRepository, storyRecord } from './helpers/route-follower.mjs';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const ITEM = 'singularity/work-items/TASK-1';
const json = (text) => JSON.parse(text);

test('ITW REQ-015: a test that passed before and fails after is a behaviour change; one that failed before too stays a finding', () => {
  const facts = new Map([
    ['unit', { status: 'checked', verdict: 'partly-on-base', onlyHere: ['orders errors by code'], alsoOnBase: ['flaky clock'] }],
    ['api', { status: 'checked', verdict: 'passes-on-base', onlyHere: [], alsoOnBase: [] }],
    ['e2e', { status: 'checked', verdict: 'fails-on-base', onlyHere: [], alsoOnBase: [] }],
    ['lint-tests', { status: 'unknown', stale: true }],
    ['other-node', { status: 'checked', verdict: 'other-node', onlyHere: ['x'], alsoOnBase: [] }]
  ]);
  const check = afterCheckOf(['unit', 'api', 'e2e', 'lint-tests', 'other-node', 'missing'], facts);
  assert.deepEqual(check.changed, [{ command: 'unit', tests: ['orders errors by code'] }, { command: 'api', tests: [] }]);
  assert.deepEqual(check.before, [{ command: 'unit', tests: ['flaky clock'] }, { command: 'e2e', tests: [] }]);
  assert.deepEqual(check.unknown, ['lint-tests', 'other-node', 'missing'], 'no run before the change kept, or one on another Node, cannot be told');
  assert.deepEqual(checkNames(check.changed), ['\'orders errors by code\'', 'the test command api']);
});

function refactorStory() {
  const steps = [{ id: 'intake', intent: 'intake', label: 'Intake' }, { id: 'implementation-spec', intent: 'plan', label: 'Plan: what must not change' },
    { id: 'implementation', intent: 'code', label: 'Code' }, { id: 'verification', intent: 'test', label: 'Tests' }];
  const workflow = { workItem: { id: 'TASK-7' }, currentPhase: 'verification', phaseOrder: steps.map((step) => step.id),
    phases: Object.fromEntries(steps.map((step) => [step.id, { id: step.id, label: step.label, status: step.id === 'verification' ? 'awaiting_approval' : 'approved', generation: 1 }])),
    resolution: { composition: { kind: 'refactor', steps } } };
  workflow.phases.verification.approvalPolicy = { rejectTo: steps.map((step) => step.id) };
  const dispute = { id: 'dispute', label: 'Dispute it: run Tests\'s tests again', command: 'singularity-flow reject verification --to verification', skill: '/sf-approve' };
  return { workflow, test: workflow.phases.verification, code: workflow.phases.implementation, choices: [{ id: 'another-version', label: 'x', command: 'y' }, dispute] };
}

test('ITW REQ-015, A13: a behaviour change stops the test step, names it, and gives the person two filled choices', () => {
  const { workflow, test: step, code, choices } = refactorStory();
  const held = refactorHold(workflow, step, code, { changed: [{ command: 'unit', tests: ['errors come in code order'] }], before: [], unknown: [] }, choices);
  assert.equal(held.reason, 'behaviour-change');
  assert.match(held.words, /^The refactor changed behaviour: 'errors come in code order' passed before the change and fails after it\. Keep the old behaviour \(.+\), or accept the new one \(.+\)\.$/u);
  assert.deepEqual(held.choices.map((choice) => choice.id), ['keep-behaviour', 'accept-behaviour', 'dispute']);
  const [keep, accept] = held.choices;
  assert.match(keep.command, /--to implementation\b/u, 'keeping the old behaviour goes back to the code step');
  assert.match(accept.command, /--to implementation-spec\b/u, 'accepting the new behaviour goes back to the plan, which is revised');
  assert.match(accept.label, /the task becomes a change/u);
  for (const choice of held.choices) assert.doesNotMatch(choice.command, /<[^>]+>/u, `${choice.id} is a complete command`);
  // A check that already failed before stays a finding; with no run before kept, the checks run on the base first.
  const old = refactorHold(workflow, step, code, { changed: [], before: [{ command: 'unit', tests: ['flaky clock'] }], unknown: [] }, choices);
  assert.equal(old.reason, 'failed-before');
  assert.match(old.words, /^'flaky clock' already failed before the change: a finding the refactor does not approve\./u);
  assert.deepEqual(old.choices, choices);
  const blind = refactorHold(workflow, step, code, { changed: [], before: [], unknown: ['unit'] }, choices);
  assert.equal(blind.reason, 'no-before');
  assert.equal(blind.choices[0].command, 'singularity-flow tests base --work-id TASK-7 --phase implementation --within 600 --json', 'the code step\'s commands run on the base');
  assert.equal(refactorHold(workflow, step, code, null, choices), null, 'not a refactor: the test step\'s own brake');
});

test('ITW REQ-015: a refactor whose new behaviour is accepted becomes a change in one revision that keeps every step', async (t) => {
  const story = await journeyRepository(t);
  Object.assign(story, { workId: 'TASK-1', item: ITEM });
  const started = json(story.cli('work', 'tidy the value module', '--kind', 'refactor', '--start', '--json'));
  assert.match(started.data?.task?.before ?? started.task?.before ?? JSON.stringify(started), /tests base --work-id TASK-1 --phase implementation/u);
  const before = storyRecord(story);
  const because = 'A person accepted the new behaviour: \'errors come in code order\' behave differently after the change.';
  const script = `
    const { loadAcceptedStoryExecution } = await import(${JSON.stringify(path.join(SOURCE, 'accepted-story-execution.mjs'))});
    const { changeTaskKind } = await import(${JSON.stringify(path.join(SOURCE, 'task-amendment.mjs'))});
    const loaded = await loadAcceptedStoryExecution(process.cwd(), 'TASK-1');
    console.log(JSON.stringify(await changeTaskKind(process.cwd(), loaded.config, loaded.workflow,
      { from: 'refactor', to: 'change', because: ${JSON.stringify(because)}, checks: ['errors come in code order'], changeRequest: 'CR-001' })));`;
  const ran = story.spawn(process.execPath, ['--input-type=module', '-e', script]);
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(json(ran.stdout.slice(ran.stdout.indexOf('{'))).changeId, 'TSC-001');
  const record = storyRecord(story);
  assert.equal(record.resolution.composition.kind, 'change');
  // The steps stay, and the plan takes the change's own label, in the composition, its pinned step and its state alike.
  const relabel = (entry) => (entry.id === 'implementation-spec' ? { ...entry, label: 'Plan' } : entry);
  assert.equal(before.resolution.composition.steps[1].label, 'Plan: what must not change');
  assert.deepEqual(record.resolution.composition.steps, before.resolution.composition.steps.map(relabel), 'the steps stay');
  assert.deepEqual(record.resolution.phases, before.resolution.phases.map(relabel), 'every pinned step stays');
  for (const id of record.phaseOrder) assert.deepEqual(stableTaskStepState(record.phases[id]), stableTaskStepState(relabel(before.phases[id])), `${id}'s state stays`);
  // Every reader resolves the same steps: the definition the Story's own record rebuilds names the plan the same way.
  const { definitionForStory } = await import('../src/task-composition.mjs');
  const { resolveWorkType, validateDefinition } = await import('../src/config.mjs');
  const definition = YAML.parse(readFileSync(path.join(story.root, 'singularity/workflow.yml'), 'utf8'));
  const rebuilt = resolveWorkType(validateDefinition(structuredClone(definitionForStory(definition, record))), record.workItem.workType);
  assert.deepEqual(rebuilt.phases.map((phase) => [phase.id, phase.label]), record.resolution.phases.map((phase) => [phase.id, phase.label]));
  const change = record.resolution.composition.changes.at(-1);
  assert.deepEqual({ change: change.change, from: change.from, to: change.to, checks: change.checks, changeRequest: change.changeRequest },
    { change: 'grow', from: 'refactor', to: 'change', checks: ['errors come in code order'], changeRequest: 'CR-001' });
  assert.equal(record.taskChanges.at(-1).change, 'kind');
  assert.equal(record.workflowSnapshot.revision, 2);
  assert.equal(record.history.at(-1).event, 'task_kind_changed');
  assert.equal(story.git('status', '--porcelain'), '', 'the change is committed whole');
  json(story.cli('status', '--json'));
  const work = json(story.cli('work', 'status', '--json'));
  assert.equal(work.kind, 'change');
  assert.deepEqual(work.steps.map((step) => step.label), ['Intake', 'Plan', 'Code', 'Tests']);
  // The contract: a kind change keeps the steps; one that also moved a step is refused.
  const decision = json(readFileSync(path.join(story.root, record.taskChanges[0].decisionPath), 'utf8'));
  assertTaskChangeScope(before.resolution, record.resolution, decision);
  const moved = structuredClone(record.resolution);
  moved.phases = [...moved.phases].reverse();
  moved.policySha256 = taskChangePolicyDigest(moved);
  const forged = { ...structuredClone(decision), to: { ...decision.to, policySha256: moved.policySha256, compositionSha256: taskChangeDigest(moved.composition) } };
  assert.throws(() => assertTaskChangeScope(before.resolution, moved, forged), /A kind change changed the Story's steps/u);
  const otherKind = structuredClone(decision);
  otherKind.change = { ...otherKind.change, from: 'fix' };
  assert.throws(() => assertTaskChangeScope(before.resolution, record.resolution, otherKind), /malformed|kind/u);
});

test('ITW REQ-015, A13: the last message lists the checks that ran and each thing the plan says must not change that no check covered', () => {
  const plan = ['<!-- singularity-flow:metadata {} -->', '# TASK-7 — Plan', '', '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
    '| `TASK-7:IFC-001` | `src/value.mjs` | `test/value.test.mjs` | modified |',
    '| `TASK-7:CON-002` | `src/value.mjs` | not-applicable: no test reads the log line; a person reads it | modified |',
    '| `TASK-7:BEH-003` | `src/value.mjs` | `test/other.test.mjs` | existing |', '',
    'A missing name is still reported before a missing email. [TASK-7:IFC-001]', 'The log line keeps its format. [TASK-7:CON-002]',
    'The errors stay plain text. [TASK-7:BEH-003]', '<!-- singularity-flow:inputs:start -->', '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    '| `TASK-7:REQ-009` | - | - |', '<!-- singularity-flow:inputs:end -->'].join('\n');
  assert.deepEqual(planItems(plan).map((item) => [item.clause, item.words, item.tests, item.notApplicable]), [
    ['TASK-7:IFC-001', 'A missing name is still reported before a missing email', ['test/value.test.mjs'], false],
    ['TASK-7:CON-002', 'The log line keeps its format', [], true],
    ['TASK-7:BEH-003', 'The errors stay plain text', ['test/other.test.mjs'], false]], 'an earlier step\'s document the plan carries as an input is not its own');
  const receipt = { tests: { discovered: 2, passed: 2, failed: 0 }, occurrences: [{ name: 'order', file: 'test/value.test.mjs', outcome: 'passed' }] };
  const files = { 'singularity/work-items/TASK-7/artifacts/plan.md': plan, 'runs/TA-1.json': JSON.stringify(receipt) };
  const steps = [{ id: 'implementation-spec', intent: 'plan' }, { id: 'implementation', intent: 'code' }, { id: 'verification', intent: 'test' }];
  const workflow = { phaseOrder: steps.map((step) => step.id), resolution: { composition: { kind: 'refactor', steps } }, phases: {
    'implementation-spec': { status: 'approved', requiredArtifact: { path: 'artifacts/plan.md' } },
    implementation: { status: 'approved', checks: [{ id: '.-node-tests', command: 'npm test' }],
      deliveryEvidence: { testExecutions: [{ commandId: '.-node-tests', receiptPath: 'runs/TA-1.json', status: 'passed' }] } },
    verification: { status: 'approved', checks: [{ id: 'node-tests', command: 'npm test' }],
      stepTestRuns: { testExecutions: [{ commandId: 'node-tests', receiptPath: 'runs/TA-1.json', status: 'passed', counts: receipt.tests }] } } } };
  const read = (relative) => files[relative] ?? null;
  const checks = taskChecks(workflow, read, { item: 'singularity/work-items/TASK-7' });
  assert.deepEqual(checks, { ran: ['npm test (2 tests, all passed)'], items: 3, notCovered: ['The log line keeps its format', 'The errors stay plain text'] },
    'the same command run by the code step and reused by the test step is one check; a row whose tests never passed in a run is not covered');
  assert.equal(checksWords(checks), ' Checks that ran: npm test (2 tests, all passed). Not covered by any check: The log line keeps its format; The errors stay plain text.');
  // A change has no list of what must not change: only the checks that ran.
  const change = structuredClone(workflow);
  change.resolution.composition.kind = 'change';
  assert.deepEqual(taskChecks(change, read, { item: 'singularity/work-items/TASK-7' }), { ran: ['npm test (2 tests, all passed)'] });
  // The checks are the code step's tests: the test step's own are read as the code step's commands.
  const code = { id: 'implementation', generation: { task: 'code' } };
  assert.equal(refactorCodeStep({ phaseOrder: workflow.phaseOrder, phases: { implementation: code } }, { id: 'verification' }), code);
  assert.equal(refactorCodeStep({ phaseOrder: workflow.phaseOrder, phases: { implementation: code } }, code), code);
  assert.equal(refactorCodeStep({ phaseOrder: ['intake', 'design'], phases: {} }, { id: 'design' }), null);
});

test('ITW REQ-015: keeping or accepting a refactor\'s behaviour is the person\'s own step, by complete commands, recorded per version', async () => {
  const { keep, accept } = behaviourCommands('TASK-7');
  assert.equal(keep, 'singularity-flow work behaviour keep --work-id TASK-7');
  assert.equal(accept, 'singularity-flow work behaviour accept --work-id TASK-7');
  const { ownTerminalStep, skillForCommandLine } = await import('../src/command-skills.mjs');
  for (const command of [keep, accept]) {
    assert.equal(ownTerminalStep(command), 'refactor-behaviour', 'the Copilot guard refuses it to an agent');
    assert.equal(skillForCommandLine(command), null, 'no skill runs it');
  }
  const workflow = { behaviourDecisions: [{ id: 'BHV-001', phase: 'implementation', generation: 1, choice: 'keep', checks: ['\'order\''] },
    { id: 'BHV-002', phase: 'implementation', generation: 2, choice: 'keep', checks: ['\'format\''] }] };
  assert.deepEqual(behaviourDecisionsOf(workflow, { id: 'implementation' }, 2).map((entry) => entry.id), ['BHV-002'], 'a choice is for the version it was made on');
});

test('ITW REQ-015: a refactor\'s behaviour change is an item on the decisions card, SFlow recommends keeping it, and each choice stays the person\'s own step', async () => {
  const [{ decisionPacket }, { withPlainWords }, { agentAct }, { refusalEnvelope }, { codeStepBehaviourHold }] = await Promise.all([import('../src/decision-list.mjs'),
    import('../src/decision-plain.mjs'), import('../src/agent-output.mjs'), import('../src/refusal-remediation.mjs'), import('../src/refactor-behaviour.mjs')]);
  const authorities = { engineering: { label: 'Engineering', members: [{ email: 'reviewer@example.test' }], allowAnyGitIdentity: true } };
  const steps = [{ id: 'implementation-spec', intent: 'plan', label: 'Plan: what must not change' }, { id: 'implementation', intent: 'code', label: 'Code' }];
  const workflow = { workItem: { id: 'TASK-7' }, currentPhase: 'implementation', phaseOrder: steps.map((step) => step.id), status: 'in_progress',
    phases: { 'implementation-spec': { id: 'implementation-spec', label: steps[0].label, status: 'approved', generation: 1, approvals: [], approvalPolicy: { authorities: ['engineering'], minimum: 1 } },
      implementation: { id: 'implementation', label: 'Code', status: 'in_progress', generation: 0, approvals: [], approvalPolicy: { authorities: ['engineering'], minimum: 1 } } },
    resolution: { approvalAuthorities: authorities, composition: { kind: 'refactor', steps } } };
  const behaviourChange = { phase: 'implementation', generation: 1, failing: ['\'errors come in code order\''], tests: [{ path: 'test/errors.test.mjs', removed: false }],
    names: ['\'errors come in code order\'', 'the expectations of test/errors.test.mjs'], undecided: ['\'errors come in code order\'', 'the expectations of test/errors.test.mjs'], kept: false, changed: [] };
  const packet = withPlainWords(workflow, decisionPacket(workflow, { phaseId: 'implementation', pending: {}, behaviourChange },
    { authorities, actor: { name: 'Reviewer', email: 'reviewer@example.test' }, at: '2026-11-26T00:00:00.000Z' }));
  const item = packet.items.find((entry) => entry.kind === 'refactor-behaviour');
  assert.ok(item, JSON.stringify(packet.items.map((entry) => entry.kind)));
  assert.equal(item.title, 'The refactor changes behaviour in Code version 1');
  assert.match(item.why, /^'errors come in code order' passed before the change and fails now; the code changes the expectations of test\/errors\.test\.mjs\./u);
  assert.deepEqual(item.options.map((entry) => [entry.id, entry.recommended, entry.terminal]), [
    ['keep-behaviour', true, 'singularity-flow work behaviour keep --work-id TASK-7'], ['accept-behaviour', false, 'singularity-flow work behaviour accept --work-id TASK-7']]);
  assert.equal(item.recommended?.option, 'keep-behaviour');
  assert.match(item.recommended.words, /^Recommended: Keep the old behaviour\. A refactor keeps behaviour/u);
  assert.equal(item.options[0].decidedBy.allowed, true, 'the code step\'s approvers decide it');
  assert.equal(item.holds, 'this-step', 'the code step is not published until it is decided');
  assert.equal(item.plain.question, 'Keep the old behaviour that Code changed?');
  assert.equal(item.chatYesNo, false, 'never a yes a chat records for the person');
  // The stop's route is the card, its terminal command the shell route; the agent runs neither.
  const stop = await codeStepBehaviourHold('/nowhere', null, workflow, workflow.phases.implementation).catch(() => null);
  assert.equal(stop, null, 'no Story here: nothing to stop on');
  const { SingularityFlowError } = await import('../src/util.mjs');
  const refusal = new SingularityFlowError('The refactor changed behaviour.', { code: 'REFACTOR_BEHAVIOUR_CHANGED',
    details: { nextAction: { command: behaviourCommands('TASK-7').keep, label: 'Keep' }, recoveryCommands: [{ command: behaviourCommands('TASK-7').accept, label: 'Accept' }] } });
  const act = agentAct(refusalEnvelope(refusal, ['phase', 'prepublish', 'implementation']));
  assert.deepEqual([act.state, act.do.copilot, act.do.shell], ['confirm-in-terminal', '/sf-decide TASK-7', 'singularity-flow work behaviour keep --work-id TASK-7']);

  // Decided on Copilot CLI's card: the person's own answers, and the record's word that the task goes on reaches the
  // chat's agent, which names /sf-task, or does /sf-task's step 1 when SFlow's note says the turn goes on [ITW:REQ-008].
  const { RECORD, runCard } = await import('../plugin/extensions/decisions/card.mjs');
  const list = { ...packet, packetSha256: `sha256:${'a'.repeat(64)}`, repositoryPath: '/repo' };
  const continueTask = { copilotCommand: '/sf-task', words: 'Code goes on: /sf-task in the chat carries it on.', instruction: 'Name /sf-task, typed in this chat.' };
  const answers = [];
  const answer = (form) => Object.fromEntries(Object.entries(form.requestedSchema.properties).map(([name, field]) => [name,
    name === 'confirm' ? RECORD : field.enum ? field.enum.find((word) => /^Keep the old behaviour/u.test(word)) ?? field.enum[0] : 'Keep it as it was.']));
  const card = await runCard({ read: async () => list, show: async () => {}, ask: async (form) => ({ action: 'accept', content: answer(form) }),
    record: async (_packet, document) => { answers.push(document); return { recorded: [{ item: item.id, kind: 'refactor-behaviour', record: 'the old behaviour kept' }],
      decided: [{ item: item.id, words: 'Keep the old behaviour' }], continueTask }; },
    witness: async () => assert.fail('nothing to sign'), inspect: async () => {} });
  assert.equal(answers.length, 1, JSON.stringify(card));
  assert.deepEqual(answers[0].choose, { [item.id]: 'keep-behaviour' });
  assert.deepEqual([card.status, card.continueTask, card.instruction], ['recorded', continueTask, continueTask.instruction]);
});

test('ITW REQ-015: an existing test whose expectations a refactor changes is found from the diff against the base; a comment or an added test is not', async (t) => {
  const { changedExistingTests } = await import('../src/refactor-behaviour.mjs');
  const { mkdtemp, rm, writeFile, mkdir } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refactor-tests-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => { const ran = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args], { cwd: root, encoding: 'utf8' }); assert.equal(ran.status, 0, ran.stderr); return ran.stdout.trim(); };
  await mkdir(path.join(root, 'test'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  const expects = (order) => `import test from 'node:test';\ntest('order', () => assert.deepEqual(errors(), ${JSON.stringify(order)}));\n`;
  await writeFile(path.join(root, 'test/order.test.mjs'), expects(['name', 'email']));
  await writeFile(path.join(root, 'test/gone.test.mjs'), expects(['a']));
  await writeFile(path.join(root, 'src/order.mjs'), 'export const errors = () => [];\n');
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const workflow = { workItem: { id: 'TASK-7', baseCommit: base } };
  // A tag comment and blank lines say nothing a test expects; source changes and added tests are no test's expectations.
  await writeFile(path.join(root, 'test/order.test.mjs'), `// @ac:TASK-7:BEH-001\n\n${expects(['name', 'email'])}`);
  await writeFile(path.join(root, 'test/new.test.mjs'), expects(['x']));
  await writeFile(path.join(root, 'src/order.mjs'), 'export const errors = () => [\'name\'];\n');
  assert.deepEqual(await changedExistingTests(root, workflow, {}), []);
  await writeFile(path.join(root, 'test/order.test.mjs'), expects(['email', 'name']));
  await rm(path.join(root, 'test/gone.test.mjs'));
  assert.deepEqual(await changedExistingTests(root, workflow, {}), [{ path: 'test/gone.test.mjs', removed: true }, { path: 'test/order.test.mjs', removed: false }]);
  // Kept: what the test expected comes back from the base, hunk by hunk; a tag its author added stays.
  const { expectationsRestored } = await import('../src/refactor-behaviour-decide.mjs');
  const tagged = `// @ac:TASK-7:BEH-001\n${expects(['email', 'name'])}`;
  await writeFile(path.join(root, 'test/order.test.mjs'), tagged);
  const diff = spawnSync('git', ['diff', '-U0', '--no-color', base, '--', 'test/order.test.mjs'], { cwd: root, encoding: 'utf8' }).stdout;
  assert.equal(expectationsRestored(tagged, diff), `// @ac:TASK-7:BEH-001\n${expects(['name', 'email'])}`);
  assert.equal(expectationsRestored(tagged, ''), null, 'no diff to read: the base file is written whole');
});
