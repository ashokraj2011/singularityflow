/**
 * Settled decisions [owner, 2026-11-13]: a question with one clear, evidence-backed answer is settled by the agent or
 * SFlow and recorded with its evidence; the decisions card lists it under "Settled for you" with an undo, and the undo
 * makes it the person's question again. The record's pure parts, the card's section and its undo, the evidence rules
 * of the own-correction rollover, the covering plan row and the Node the repository names.
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { action, commandResult, effects, succeeded } from '../src/narration/command-result.mjs';
import { decisionPacket, decisionRecordPlan, effectWords, parseDecisionAnswers } from '../src/decision-list.mjs';
import { ownCorrectionHold } from '../src/own-correction-rollover.mjs';
import { settledPlanChanges, planAmendmentRecord } from '../src/plan-amendments.mjs';
import { coveringRow } from '../src/settle-before-publication.mjs';
import { activeSettled, recordSettledDecision, recordSettledUndo, reraisedRoute, settledDecisions, settlementState, SETTLED_KINDS, undoSettledDecision } from '../src/settled-decisions.mjs';
import { activeStoryTestCommands, pendingStoryTestCommands, refreshStoryTestCommands, storyTestCommandState } from '../src/story-test-commands.mjs';
import { fileReads, nodeVersionChecks } from '../src/test-plan.mjs';

const AT = '2026-11-13T09:00:00.000Z';
const LATER = '2026-11-13T10:00:00.000Z';
const authorities = { eng: { label: 'Engineers', allowAnyGitIdentity: true, members: [] } };

function story(extra = {}) {
  return { workItem: { id: 'STL-1' }, status: 'in_progress', currentPhase: 'implement', phaseOrder: ['implement'],
    phases: { implement: { id: 'implement', label: 'Implement', status: 'in_progress', generation: 1, writeScope: 'source-and-artifact',
      generationPolicy: { task: 'code', requirement: 'required' }, approvalPolicy: { authorities: ['eng'] } } },
    resolution: { approvalAuthorities: authorities }, history: [], ...extra };
}

const selection = { kind: 'story-selection', subject: 'STL-1 on stl-1', answer: 'Opened STL-1: the only Story on this branch.',
  evidence: [{ what: 'stl-1 is STL-1\'s own branch', where: 'workflow.json on stl-1' }], by: 'sflow', at: AT };

test('a settlement is recorded with its evidence, an undo makes it the person\'s question, and it is never settled again', () => {
  const workflow = story();
  const entry = recordSettledDecision(workflow, selection);
  assert.equal(entry.id, 'STL-001');
  assert.deepEqual(entry.evidence, selection.evidence);
  assert.equal(settlementState(workflow, 'story-selection', selection.subject), 'settled');
  assert.equal(activeSettled(workflow, 'story-selection').length, 1);
  // No evidence SFlow can name, an unknown kind, or a person as its settler: nothing is settled.
  assert.throws(() => recordSettledDecision(story(), { ...selection, evidence: [] }), { code: 'SETTLED_DECISION_INVALID' });
  assert.throws(() => recordSettledDecision(story(), { ...selection, kind: 'approval' }), { code: 'SETTLED_DECISION_INVALID' });
  assert.throws(() => recordSettledDecision(story(), { ...selection, by: 'person' }), { code: 'SETTLED_DECISION_INVALID' });
  assert.deepEqual([...SETTLED_KINDS].sort(), ['node-version', 'own-correction', 'plan-accounting', 'story-selection', 'test-command']);

  const { undo, settled } = recordSettledUndo(workflow, { id: 'STL-001', actor: 'person@example.invalid', at: LATER, reason: 'Not the Story I meant.' });
  assert.deepEqual([undo.id, undo.undoes, settled.id], ['STL-002', 'STL-001', 'STL-001']);
  assert.equal(settledDecisions(workflow)[0].undone.id, 'STL-002');
  assert.equal(settlementState(workflow, 'story-selection', selection.subject), 'undone');
  assert.equal(activeSettled(workflow, 'story-selection').length, 0);
  assert.throws(() => recordSettledDecision(workflow, selection), { code: 'SETTLED_DECISION_UNDONE' });
  assert.throws(() => recordSettledUndo(workflow, { id: 'STL-001', actor: 'p', at: LATER }), { code: 'SETTLED_DECISION_UNDONE' });
  assert.throws(() => recordSettledUndo(workflow, { id: 'STL-009', actor: 'p', at: LATER }), { code: 'SETTLED_DECISION_UNKNOWN' });
  // Undone, each kind goes back on its own person route.
  assert.deepEqual(reraisedRoute(workflow, settled), { words: 'The next /sf-session in this checkout lists the Stories and asks which one to open.',
    command: 'singularity-flow session open', copilotCommand: '/sf-session' });
  assert.match(reraisedRoute(workflow, { kind: 'node-version', phase: 'implement' }).copilotCommand, /^\/sf-decide STL-1$/u);
  // Each route is a registered Shell and Copilot pair, so the undo's result can name it as the next step.
  for (const kind of SETTLED_KINDS) {
    const route = reraisedRoute(workflow, { kind, phase: 'implement', effect: { request: 'TCD-001', path: 'src/a.css' } });
    assert.doesNotThrow(() => commandResult({ operation: { id: 'decisions.undo', classification: 'mutation' }, subject: { kind: 'story', id: 'STL-1' },
      outcome: succeeded('decisions.undo.succeeded', { settled: 'STL-001', undo: 'STL-002' }), effects: effects({ stateChanged: true }),
      next: [action({ id: 'settled-undo.reraised', label: route.words, command: route.command, skill: route.copilotCommand.split(' ')[0], rank: 'NOW', kind: 'workflow' })],
      data: {} }), kind);
  }
});

test('on a Story SF Guard requires, an undo nobody signed counts for nothing', () => {
  const workflow = story({ resolution: { approvalAuthorities: authorities, presence: { status: 'required' } } });
  recordSettledDecision(workflow, selection);
  recordSettledUndo(workflow, { id: 'STL-001', actor: 'agent@example.invalid', at: LATER });
  assert.equal(settledDecisions(workflow)[0].undone, null, 'an unsigned undo is not a person\'s');
  assert.equal(settlementState(workflow, 'story-selection', selection.subject), 'settled');
});

test('the card lists what was settled under its own section, counted nowhere, with an undo anyone may choose', () => {
  const workflow = story();
  recordSettledDecision(workflow, selection);
  const facts = { phaseId: 'implement', gaps: [], issues: [], pending: {}, state: {} };
  const context = { authorities, actor: { name: 'Person', email: 'person@example.invalid' }, at: AT };
  const packet = decisionPacket(workflow, facts, context);
  assert.equal(packet.open, 0, 'a settled decision is never an open decision');
  assert.equal(packet.items.length, 0);
  assert.equal(packet.status, 'nothing-to-decide');
  const [item] = packet.settled;
  assert.equal(item.kind, 'settled');
  assert.equal(item.settled, true);
  assert.equal(item.subject, selection.subject);
  assert.equal(item.answerWords, selection.answer);
  assert.equal(item.evidenceWords, 'stl-1 is STL-1\'s own branch (workflow.json on stl-1)');
  assert.deepEqual([item.by, item.at, item.holds, item.holdsApproval], ['sflow', AT, 'nothing', false]);
  assert.deepEqual(item.options.map((option) => [option.id, option.outcome, option.decidedBy.allowed]), [['undo', 'undo', true]]);
  assert.deepEqual(item.options[0].effects, [{ kind: 'settled-undo', settled: 'STL-001' }]);
  assert.equal(item.details.commands[0], 'singularity-flow decisions undo STL-1 --settled STL-001');
  assert.match(effectWords(workflow, item.options[0].effects[0]), /^undo STL-001, so it is a question for a person again/u);

  // The card records the undo like any choice, bound to the list it was read from.
  const plan = decisionRecordPlan(packet, parseDecisionAnswers({ choose: [`${item.id}=undo`] }), { at: AT });
  assert.deepEqual(plan.steps.map((step) => [step.item, step.option, step.effects[0].kind]), [[item.id, 'undo', 'settled-undo']]);
  assert.deepEqual(plan.refused, []);
  // Undone, it leaves the section, and the list's digest changes, so a card showing it is refused.
  recordSettledUndo(workflow, { id: 'STL-001', actor: 'person', at: LATER });
  const after = decisionPacket(workflow, facts, context);
  assert.equal(after.settled, undefined);
  assert.notEqual(after.packetSha256, packet.packetSha256);
  assert.throws(() => decisionRecordPlan(after, parseDecisionAnswers({ choose: [`${item.id}=undo`] }), { at: AT }), { code: 'DECISIONS_ANSWER_INVALID' });
});

test('a settled plan change counts as the plan amendment it stands for, until it is undone', () => {
  const workflow = story();
  recordSettledDecision(workflow, { kind: 'plan-accounting', subject: 'file:src/value.d.ts', answer: 'Accounted src/value.d.ts to STL-1:AC-001\'s row.',
    evidence: [{ what: 'STL-1:AC-001\'s row names src/value.mjs', where: 'the approved plan' }], by: 'sflow', at: AT,
    effect: { clauseId: 'STL-1:AC-001', path: 'src/value.d.ts' } });
  recordSettledDecision(workflow, { kind: 'node-version', subject: 'Node 22 for implement\'s tests', answer: 'Pinned Node 22 in .nvmrc.', by: 'sflow', at: AT,
    evidence: [{ what: 'the repository asks for Node >=20 <23', where: 'package.json engines.node' }], effect: { file: '.nvmrc', version: '22', class: 'build-configuration' } });
  const record = planAmendmentRecord(workflow);
  assert.deepEqual(record.accountedPaths, { 'STL-1:AC-001': ['src/value.d.ts'] });
  assert.deepEqual(record.supportingFileDetails.map((entry) => [entry.path, entry.class]), [['.nvmrc', 'build-configuration']]);
  // The plan's own reader and settledDecisions agree on what stands.
  assert.equal(settledPlanChanges(workflow).length, activeSettled(workflow, 'plan-accounting').length + activeSettled(workflow, 'node-version').length);
  recordSettledUndo(workflow, { id: 'STL-001', actor: 'person', at: LATER });
  recordSettledUndo(workflow, { id: 'STL-002', actor: 'person', at: LATER });
  assert.equal(planAmendmentRecord(workflow), null);
});

test('a settled test command request runs as accepted, and undone it waits for a person again', async () => {
  const command = { id: 'node-tests', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never',
    result: { adapter: 'junit-xml', path: '.sflow/results/junit.xml' } };
  const workflow = story({ testCommandDecisions: [{ id: 'TCD-001', phase: 'implement', command, reason: 'The repository test script.', requestedBy: 'agent', at: AT }] });
  assert.equal(pendingStoryTestCommands(workflow, 'implement').length, 1);
  recordSettledDecision(workflow, { kind: 'test-command', subject: 'TCD-001', phase: 'implement', answer: 'implement runs node-tests.', by: 'sflow', at: AT,
    evidence: [{ what: 'npm test is the only test command the repository declares', where: 'package.json' }], effect: { request: 'TCD-001', commandId: 'node-tests' } });
  refreshStoryTestCommands(workflow, 'implement');
  assert.equal(storyTestCommandState(workflow, 'TCD-001').state, 'accepted');
  assert.equal(pendingStoryTestCommands(workflow, 'implement').length, 0);
  assert.deepEqual(activeStoryTestCommands(workflow, 'implement').map((entry) => entry.id), ['node-tests']);
  assert.deepEqual(workflow.phases.implement.storyTestCommands.map((entry) => entry.id), ['node-tests']);
  // While the step awaits approval its review ran this command: the step is returned first, and nothing is written.
  const submitted = structuredClone(workflow);
  submitted.phases.implement.status = 'awaiting_approval';
  await assert.rejects(undoSettledDecision(null, {}, submitted, 'STL-001', { actor: {} }), { code: 'SETTLED_DECISION_DURING_REVIEW' });
  recordSettledUndo(workflow, { id: 'STL-001', actor: 'person', at: LATER });
  refreshStoryTestCommands(workflow, 'implement');
  assert.equal(storyTestCommandState(workflow, 'TCD-001').state, 'requested');
  assert.equal(workflow.phases.implement.storyTestCommands, undefined);
});

test('the author corrects its own published generation itself only while nobody reviewed or approved it, and never after an undo', async () => {
  const code = (extra = {}) => story({ phases: { implement: { id: 'implement', label: 'Implement', status: 'in_progress', generation: 1,
    writeScope: 'source-and-artifact', generationPolicy: { task: 'code', requirement: 'required' }, approvalPolicy: { authorities: ['eng'] },
    generationIntent: { id: 'GI-1', status: 'consumed', generation: 1 }, authorship: [{ generation: 1, producer: 'governed-agent', channel: 'copilot-host' }], ...extra } } });
  const hold = async (workflow) => (await ownCorrectionHold(null, {}, workflow, workflow.phases.implement))?.code ?? null;
  assert.equal(await hold(code()), null, 'its own, unreviewed, unapproved: settled');
  assert.equal(await hold(code({ authorship: [{ generation: 1, producer: 'human', channel: 'manual-in-place' }] })), 'GENERATION_OWN_CORRECTION_NOT_OWN');
  assert.equal(await hold(code({ approvals: [{ generation: 1, decision: 'approved', actor: 'person' }] })), 'GENERATION_OWN_CORRECTION_REVIEWED');
  assert.equal(await hold(code({ status: 'awaiting_approval' })), 'GENERATION_ROLLOVER_UNAVAILABLE', 'a submitted step is the person\'s');
  const undone = code();
  recordSettledDecision(undone, { kind: 'own-correction', subject: 'implement generation 1', phase: 'implement', answer: 'Opened generation 2.', by: 'agent', at: AT,
    evidence: [{ what: 'generation 1 of implement was published by its agent', where: 'implement generation 1' }] });
  recordSettledUndo(undone, { id: 'STL-001', actor: 'person', at: LATER });
  assert.equal(await hold(undone), 'GENERATION_OWN_CORRECTION_UNDONE');
});

test('a plan row covers a changed file it names the companion of, and only when one row does', () => {
  const plan = { 'STL-1:AC-001': { expectedPaths: ['src/Pricing.tsx'], steps: ['implement'] }, 'STL-1:AC-002': { expectedPaths: ['src/cart/Cart.tsx'] },
    'STL-1:AC-003': { expectedPaths: ['src/rates.mjs'], steps: ['verify'] }, 'STL-1:AC-004': { expectedPaths: ['src/Shared.tsx'] },
    'STL-1:AC-005': { expectedPaths: ['src/Shared.ts'] } };
  assert.deepEqual(coveringRow(plan, 'implement', 'src/Pricing.module.css'), { clauseId: 'STL-1:AC-001', path: 'src/Pricing.tsx' });
  assert.deepEqual(coveringRow(plan, 'implement', 'src/cart/Cart.stories.tsx'), { clauseId: 'STL-1:AC-002', path: 'src/cart/Cart.tsx' });
  assert.equal(coveringRow(plan, 'implement', 'src/Other.css'), null, 'no row names a file of that name');
  assert.equal(coveringRow(plan, 'implement', 'src/rates.d.ts'), null, 'another step\'s row');
  assert.equal(coveringRow(plan, 'implement', 'src/Shared.css'), null, 'two rows name one: the person says which');
  assert.equal(coveringRow(plan, 'implement', 'lib/Pricing.css'), null, 'another folder');
});

test('a Node pin is the repository\'s answer only when its engines range accepts one installed major', { skip: process.platform === 'win32' ? 'the fake Nodes are shell scripts' : false }, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-settled-node-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  for (const version of ['16.20.2', '17.9.1']) {
    const bin = path.join(home, '.nvm', 'versions', 'node', `v${version}`, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'node'), `#!/bin/sh\nif [ "$1" = --version ]; then echo v${version}; exit 0; fi\nexec '${process.execPath}' "$@"\n`);
    await chmod(path.join(bin, 'node'), 0o755);
  }
  const environment = { ...process.env, HOME: home, NVM_DIR: path.join(home, '.nvm'), PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
  const commands = [{ id: 'node-tests', kind: 'test', argv: ['node', '--test'], workingDirectory: '.', affectedRoots: ['.'] }];
  const pinFor = async (range) => {
    await writeFile(path.join(base, 'package.json'), JSON.stringify({ type: 'module', engines: { node: range } }));
    return (await nodeVersionChecks(base, commands, { environment, reads: fileReads(base) })).find((entry) => entry.pin)?.pin ?? null;
  };
  const one = await pinFor('>=16 <17');
  assert.deepEqual([one.version, one.source], ['16', { file: 'package.json', field: 'engines.node', range: '>=16 <17' }]);
  const two = await pinFor('>=16 <18');
  assert.equal(two.version, '17', 'still offered to the person');
  assert.equal(two.source, undefined, 'two installed majors fit: the person chooses');
});

test('a turn runs the author\'s own correction, and never undoes what was settled for the person', async (t) => {
  const [{ spawnSync }, { realpath }, { captureMutationTurn }, { recordRepositoryBoundaryTurn, repositoryToolGuard }] = await Promise.all([
    import('node:child_process'), import('node:fs/promises'), import('../src/copilot-mutation-guard.mjs'), import('../src/copilot-repository-boundary.mjs')]);
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-settled-guard-')));
  const root = path.join(directory, 'repository');
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE; else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(root);
  const git = (args) => assert.equal(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status, 0);
  git(['init', '-q']); git(['config', 'user.name', 'Guard Tester']); git(['config', 'user.email', 'guard@example.invalid']);
  const phase = { id: 'custom-step', status: 'in_progress', generation: 1, writeScope: 'artifact-only', generationPolicy: { task: 'document', requirement: 'required' } };
  const definition = { workItemRoot: 'singularity/work-items', governance: { protectedPaths: ['policy'] } };
  const workflow = { workItem: { id: 'PMC-1' }, currentPhase: phase.id, phaseOrder: [phase.id], phases: { [phase.id]: phase }, resolution: {} };
  await mkdir(path.join(root, 'singularity/work-items/PMC-1'), { recursive: true });
  await writeFile(path.join(root, 'singularity/work-items/PMC-1/workflow.json'), JSON.stringify(workflow));
  git(['add', '.']); git(['commit', '-qm', 'fixture']);
  const accepted = { definition, workflow };
  const guard = async (prompt, command) => {
    const payload = { cwd: root, sessionId: `settled-${prompt}`, prompt };
    await recordRepositoryBoundaryTurn(payload, { captureMutation: (value, record) => captureMutationTurn(value, record, { resolveRoot: async () => root, load: async () => accepted }) });
    return repositoryToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: root } });
  };
  const correction = 'singularity-flow phase rollover custom-step --correction "The summary says value 3, which contradicts the recorded decision." --json';
  assert.notEqual((await guard('/sf-phase', correction)).permissionDecision, 'deny', 'the author corrects its own draft in its own turn');
  for (const prompt of ['/sf-phase', '/sf-decide PMC-1', '/sf-session', 'Thanks. Undo that for me.']) {
    const refused = await guard(prompt, 'singularity-flow decisions undo PMC-1 --settled STL-001');
    assert.equal(refused.permissionDecision, 'deny', prompt);
    assert.match(refused.permissionDecisionReason, /undoing a settled decision hands its question back to the person, so only they undo it, on the decisions card \(\/sf-decide PMC-1 opens it\)/u, prompt);
    assert.equal(refused.next[0].copilotCommand, '/sf-decide PMC-1', prompt);
  }
});
