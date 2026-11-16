/**
 * SPEC-OSA v1.1 Stage 4 (plan section 6): one work command, the writing aliases as compatibility adapters, /sf-next doing
 * the current step's agent work, kernel-built steps through their generator, and the one action-to-command map
 * [OSA:REQ-021, REQ-023–REQ-027, AC-003, AC-019]. Expected results are written out here, never computed by the code under test.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { OPERATIONS, stepState } from '../src/kernel/step-state.mjs';
import { ACTION_COMMAND_MAP_VERSION, ACTION_COMMANDS, ACTION_MODEL_FREE, actionSkill, decisionRoutes, stepSnapshotOf, workCommandOf } from '../src/step-decision.mjs';
import { isWorkCommand, WORK_COMMANDS } from '../src/command-skills.mjs';
import { workCommandArguments, writingAlias } from '../src/writing-aliases.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';
import { deriveMutationContract, mutationTurnMode } from '../src/phase-mutation-contract.mjs';
import { noteTypedTurn } from '../src/asked-for.mjs';
import { skillEntries } from './helpers/route-follower.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A Story at `current`, its steps as the record pins them. */
function story(current, phases) {
  const order = Object.keys(phases);
  return { schemaVersion: 13, workItem: { id: 'S4-1', createdAt: '2026-11-17T08:00:00.000Z' }, status: 'in_progress', currentPhase: current,
    phaseOrder: order, history: [], resolution: {},
    phases: Object.fromEntries(Object.entries(phases).map(([id, phase]) => [id, { id, status: id === current ? 'in_progress' : 'pending', generation: 0, ...phase }])) };
}
const DOCUMENT = { writeScope: 'artifact-only', generationPolicy: { requirement: 'required', task: 'document' }, requiredArtifact: { path: 'artifacts/intake/intake.md' } };
const CODE = { writeScope: 'source-and-artifact', generationPolicy: { requirement: 'required', task: 'code', defaultProducer: 'governed-agent', allowedProducers: ['governed-agent'] },
  requiredArtifact: { path: 'artifacts/implement/implementation-summary.md' } };
/** The deterministic profiles the shipped workflows declare (templates/workflow.yml): the kernel builds them. */
const KERNEL_BUILT = {
  'poc-lite-plan': { task: 'reason', writeScope: 'artifact-only', artifact: 'artifacts/poc-lite-plan/plan.md' },
  'poc-lite-verify': { task: 'analyze', writeScope: 'artifact-only', artifact: 'artifacts/poc-lite-verify/verification.md' },
  'poc-lite-finalize': { task: 'summarize', writeScope: 'artifact-only', artifact: 'artifacts/poc-lite-finalize/finalize.md' },
  verify: { task: 'analyze', writeScope: 'source-and-artifact', artifact: 'artifacts/verify/verification-summary.md' }
};
const kernelStep = ({ task, writeScope, artifact }) => ({ writeScope, requiredArtifact: { path: artifact },
  generationPolicy: { requirement: 'required', task, defaultProducer: 'deterministic', allowedProducers: ['deterministic'] } });
const decide = (workflow, phase = workflow.phases[workflow.currentPhase]) => stepState(stepSnapshotOf({ workflow, phase }));

test('the action-to-command map is versioned and names a command, or none, for every operation the kernel returns [§10, OSA:REQ-021]', () => {
  assert.equal(ACTION_COMMAND_MAP_VERSION, 'sflow-action-command-map/v1');
  assert.deepEqual(Object.keys(ACTION_COMMANDS).sort(), [...OPERATIONS].sort(), 'one entry per kernel operation, no more and no fewer');
  for (const [operation, entry] of Object.entries(ACTION_COMMANDS)) {
    assert.ok(['work', 'by-command'].includes(entry.copilot) || /^\/sf-[a-z-]+$/u.test(entry.copilot), `${operation}: ${entry.copilot}`);
    assert.ok(Array.isArray(entry.shell) && entry.shell.length, `${operation} names its Shell command`);
  }
  assert.equal(ACTION_MODEL_FREE, 'by-command', 'VS Code\'s model-free command is read from the exact command, never assumed');
  // Written out: the step's own work is the work command's, the others their own skill's.
  const code = story('implement', { implement: CODE });
  const document = story('intake', { intake: DOCUMENT });
  assert.equal(actionSkill('author-version', { phase: code.phases.implement, workflow: code }), '/sf-code');
  assert.equal(actionSkill('author-version', { phase: document.phases.intake, workflow: document }), '/sf-phase');
  assert.equal(actionSkill('build-version', { phase: document.phases.intake, workflow: document }), '/sf-phase');
  assert.equal(actionSkill('start-review'), '/sf-review-source');
  assert.equal(actionSkill('approve-step'), '/sf-approve');
  assert.equal(actionSkill('recover-operation', { phase: code.phases.implement, workflow: code }), '/sf-code', 'an uncertain opening is the work command\'s');
  assert.equal(actionSkill('recover-operation', { variant: 'recover' }), '/sf-recover', 'positive damage alone is /sf-recover\'s');
  assert.equal(actionSkill('inspect'), null, 'by the command\'s own crosswalk');
});

test('every rendered route carries the map\'s skill and its three surfaces, with VS Code\'s said truthfully when it has none [AC-003]', () => {
  const cases = [story('implement', { implement: CODE }), story('intake', { intake: DOCUMENT }),
    story('poc-lite-plan', { 'poc-lite-plan': kernelStep(KERNEL_BUILT['poc-lite-plan']) })];
  for (const workflow of cases) {
    const phase = workflow.phases[workflow.currentPhase];
    const decision = decide(workflow);
    const [route] = decisionRoutes(decision, workflow, phase);
    assert.ok(route?.command, JSON.stringify(decision.next));
    const mapped = actionSkill(decision.next.operation, { phase, workflow });
    if (mapped) assert.equal(route.skill, mapped, `${phase.id}: ${decision.next.operation}`);
    assert.equal(route.copilotCommand?.split(' ')[0] ?? null, route.skill, 'the Copilot line names the route\'s skill');
    assert.equal(route.modelFreeStatus, route.modelFreeCommand ? 'available' : 'unavailable', 'an unavailable model-free command is said, never invented');
  }
});

test('D1: /sf-code and /sf-phase are one work command, accepted for every step command of every kind, with one Shell form [OSA:REQ-024]', () => {
  assert.deepEqual([...WORK_COMMANDS], ['/sf-code', '/sf-phase']);
  for (const value of ['/sf-code', '/sf-phase', '/sflow-code implement', '/sf-phase intake']) assert.equal(isWorkCommand(value), true, value);
  for (const value of ['/sf-next', '/sf-converge', '/sf-publish', null]) assert.equal(isWorkCommand(value), false, String(value));
  for (const argv of [['prepare', 'intake'], ['phase', 'begin', 'implement', '--json'], ['phase', 'rollover', 'intake', '--json'],
    ['phase', 'prepublish', 'implement', '--for-agent', '--json'], ['phase', 'opening', 'intake', '--reconcile', '--json'], ['phase', 'enter', 'intake', '--json']]) {
    const [code, phase] = WORK_COMMANDS.map((skill) => safeCommandGuidance({ argv, skill }));
    assert.ok(code && phase, `${argv.join(' ')}: both names are accepted`);
    assert.equal(code.command, phase.command, 'the same Shell command');
    assert.equal(code.modelFreeCommand, phase.modelFreeCommand, 'the same VS Code command');
    assert.equal(code.skill, '/sf-code');
    assert.equal(phase.skill, '/sf-phase');
  }
  // A step's routes still show the name its kind always had; the other name works the same.
  assert.equal(workCommandOf(story('implement', { implement: CODE }).phases.implement), '/sf-code');
  assert.equal(workCommandOf(story('intake', { intake: DOCUMENT }).phases.intake), '/sf-phase');
});

test('D1: either name opens the same turn, with the same permission, on a code step and on a document step [OSA:REQ-024, AC-001]', () => {
  assert.equal(mutationTurnMode('sf-code'), 'authoring');
  assert.equal(mutationTurnMode('sf-phase'), 'authoring');
  for (const workflow of [story('implement', { implement: CODE }), story('intake', { intake: DOCUMENT }),
    story('poc-lite-plan', { 'poc-lite-plan': kernelStep(KERNEL_BUILT['poc-lite-plan']) })]) {
    const [code, phase] = ['sf-code', 'sf-phase'].map((skill) => deriveMutationContract({ definition: { workItemRoot: 'singularity/work-items' }, workflow,
      turnMode: mutationTurnMode(skill) }));
    assert.deepEqual(code, phase, `${workflow.currentPhase}: one permission, one next action, whichever name was typed`);
  }
});

test('D1: the two names carry one body, with no relay between them [OSA:REQ-024, AC-008]', async () => {
  const body = async (name) => (await readFile(path.join(root, 'plugin/skills', name, 'SKILL.md'), 'utf8'))
    .replace(/^---\n[\s\S]*?\n---\n/u, '').replace(/^# .*\n/u, '');
  const [code, phase] = await Promise.all([body('sflow-code'), body('sflow-phase')]);
  assert.equal(code, phase, 'one body for both names');
  assert.match(code, /`\/sf-code` and `\/sf-phase` are one work command: this turn writes the current step, code or document, and never sends one to the other/u);
  assert.doesNotMatch(code, /`generatesCode: true`, `authoring\.policyVerified`; else relay routes/u, 'the code name no longer relays a document step');
  assert.doesNotMatch(code, /If `effectiveAuthoringSkill` is not `\/sf-phase`, relay it/u, 'the document name no longer relays a code step');
  assert.doesNotMatch(code, /kernel-only `\/sf-next` cannot author/u);
  // What the follower enters each name by, and finishes with: the same.
  const entries = skillEntries();
  assert.equal(entries.get('/sf-code').entry, entries.get('/sf-phase').entry);
  assert.equal(entries.get('/sf-code').finish, entries.get('/sf-phase').finish);
});

test('the writing aliases keep their arguments, targets and standalone meanings, and an ambiguous one is clarified [OSA:REQ-027, AC-019]', () => {
  const steps = ['intake', 'implement', 'verify'];
  // The work command's step argument is its target, never what the person asked for (alias-matrix.md finding 7, 8).
  assert.deepEqual(writingAlias('/sf-code', 'implement make it return 2', { steps }), { coordinator: 'work', via: '/sf-code', target: 'implement', focus: 'make it return 2' });
  assert.deepEqual(writingAlias('/sf-phase', 'intake', { steps }), { coordinator: 'work', via: '/sf-phase', target: 'intake', focus: null });
  assert.deepEqual(writingAlias('/sflow-code', 'tighten the error message', { steps }), { coordinator: 'work', via: '/sf-code', target: null, focus: 'tighten the error message' });
  assert.deepEqual(writingAlias('/sf-code', 'publish', { steps }), { coordinator: 'work', via: '/sf-code', target: null, focus: null }, 'a form word is no instruction');
  // The delegating aliases do the same work, with their focus.
  assert.deepEqual(writingAlias('/sf-implement', 'the parser', { steps }), { coordinator: 'work', via: '/sf-code', target: null, focus: 'the parser' });
  assert.deepEqual(writingAlias('/sf-scenario-repair', 'S-3 rounds down', { steps }), { coordinator: 'work', via: '/sf-code', target: null, focus: 'S-3 rounds down' });
  assert.equal(writingAlias('/sf-scenario-repair', '', { steps }).clarification, 'scenario-defect-required');
  // /sf-call: the agent the Story runs, its mismatch message, and a precise question when no agent is named.
  assert.deepEqual(writingAlias('/sf-call', 'reviewer-bot add tests', { steps, stepAgent: 'reviewer-bot' }),
    { coordinator: 'work', via: '/sf-code', agent: 'reviewer-bot', target: null, focus: 'add tests' });
  const mismatch = writingAlias('/sf-call', 'other-bot', { steps, stepAgent: 'reviewer-bot' });
  assert.equal(mismatch.clarification, 'agent-mismatch');
  assert.match(mismatch.words, /This Story runs agent reviewer-bot, not other-bot\. A Story for other-bot starts with \/sf-start <WORK-ID> --agent other-bot\./u);
  assert.equal(writingAlias('/sf-call', '', { steps }).clarification, 'agent-required');
  // Standalone contracts stay their own.
  assert.deepEqual(writingAlias('/sf-run', 'focus on errors'), { standalone: 'guided-run', focus: 'focus on errors' });
  assert.deepEqual(writingAlias('/sf-converge'), { standalone: 'convergence' });
  assert.deepEqual(writingAlias('/sf-code-docs', 'src/a.js'), { standalone: 'doc-comments', focus: 'src/a.js' });
  assert.deepEqual(writingAlias('/sf-next'), { coordinator: 'next' });
  assert.equal(writingAlias('/sf-approve'), null, 'not a writing alias');
  assert.deepEqual(workCommandArguments('  ', steps), { target: null, focus: null });
});

test('the aliases that delegate are entered as the work command; /sf-call no longer resolves to /sf-start (alias-matrix finding 4)', () => {
  const entries = skillEntries();
  for (const alias of ['/sf-implement', '/sf-call', '/sf-scenario-repair']) {
    assert.equal(entries.get(alias).delegate, '/sf-code', alias);
    assert.equal(entries.get(alias).entry, entries.get('/sf-code').entry, alias);
  }
  assert.equal(entries.get('/sf-next').worksInTurn, true, '/sf-next takes the step\'s work in its own turn (D2)');
  assert.equal(entries.get('/sf-code').worksInTurn, false);
});

test('a step named after the work command is its target and never recorded as what the person asked for [OSA:REQ-027]', async (t) => {
  const gitDir = await mkdtemp(path.join(os.tmpdir(), 'sflow-s4-asked-'));
  t.after(() => rm(gitDir, { recursive: true, force: true }));
  const workflow = story('implement', { intake: { ...DOCUMENT, status: 'approved', generation: 1 }, implement: CODE });
  workflow.phases.intake.status = 'approved';
  const note = (text) => noteTypedTurn({ typed: { text }, skill: 'sf-code', turnId: `T-${text.length}` }, { gitDir, workflow, at: Date.parse('2026-11-17T09:00:00Z') });
  assert.equal(await note('implement'), null, 'the step alone: nothing to account for');
  await note('implement return 2 to every caller');
  await note('tighten the message');
  const { localAskedFor } = await import('../src/asked-for.mjs');
  const kept = await localAskedFor(gitDir, { workId: 'S4-1', phase: 'implement', generation: 1 });
  const texts = (kept?.turns ?? kept ?? []).map((entry) => entry.text);
  assert.deepEqual(texts, ['return 2 to every caller', 'tighten the message'], JSON.stringify(kept));
});

test('D2: /sf-next is an authoring turn, so its writes are the kernel\'s decision\'s, as for the work command [OSA:REQ-025]', () => {
  assert.equal(mutationTurnMode('sf-next'), 'authoring');
  for (const workflow of [story('implement', { implement: CODE }), story('intake', { intake: DOCUMENT })]) {
    const [work, next] = ['sf-code', 'sf-next'].map((skill) => deriveMutationContract({ definition: { workItemRoot: 'singularity/work-items' }, workflow,
      turnMode: mutationTurnMode(skill) }));
    assert.deepEqual(next, work, `${workflow.currentPhase}: /sf-next may write exactly what the work command may`);
  }
  // A step whose next action is a person's grants /sf-next no write.
  const submitted = story('intake', { intake: { ...DOCUMENT, status: 'awaiting_approval', generation: 1 } });
  submitted.phases.intake.status = 'awaiting_approval';
  const contract = deriveMutationContract({ definition: { workItemRoot: 'singularity/work-items' }, workflow: submitted, turnMode: mutationTurnMode('sf-next') });
  assert.deepEqual(contract.allow.artifacts, []);
  assert.equal(contract.allow.application, false);
  assert.equal(contract.policy.step.next, 'approve-step:intake@1', 'the approval of submitted version 1, a person\'s');
});

test('D5: every declared deterministic profile is built by its generator through the work command, never an AI task [OSA:REQ-026]', () => {
  for (const [id, profile] of Object.entries(KERNEL_BUILT)) {
    const workflow = story(id, { [id]: kernelStep(profile) });
    const decision = decide(workflow);
    assert.equal(decision.kind.executionOwner, 'kernel', id);
    assert.equal(decision.state, 'kernel-build', id);
    assert.equal(decision.next.operation, 'build-version', id);
    assert.equal(decision.next.inputs.producer, 'deterministic', id);
    assert.deepEqual(decision.next.then, ['publish-version'], `${id}: built, then published; no authoring`);
    const [route] = decisionRoutes(decision, workflow, workflow.phases[id]);
    assert.equal(route.command, `singularity-flow prepare ${id}`, id);
    assert.equal(route.skill, '/sf-phase', `${id}: the work command, whose turn runs the generator`);
    assert.equal(safeCommandGuidance({ argv: ['prepare', id], skill: '/sf-code' })?.command, route.command, `${id}: the other name runs it the same`);
  }
  // Deterministic convergence is kernel-built too; its declared writer is /sf-converge, which builds it the same way.
  const convergence = story('convergence', { convergence: { ...kernelStep({ task: 'analyze', writeScope: 'artifact-only', artifact: 'artifacts/convergence/convergence.md' }),
    requiredArtifact: { path: 'artifacts/convergence/convergence.md', kind: 'convergence-report' } } });
  const converged = decide(convergence);
  assert.deepEqual([converged.kind.executionOwner, converged.state, converged.next.operation], ['kernel', 'kernel-build', 'build-version']);
  const [built] = decisionRoutes(converged, convergence, convergence.phases.convergence);
  assert.deepEqual([built.command, built.skill], ['singularity-flow prepare convergence', '/sf-converge']);
  // A deterministic code step keeps its agent for the code, the kernel only for its summary (quick-fix implement).
  const implement = story('implement', { implement: { ...CODE, generationPolicy: { requirement: 'required', task: 'code', defaultProducer: 'deterministic', allowedProducers: ['deterministic'] } } });
  const coded = decide(implement);
  assert.equal(coded.kind.executionOwner, 'agent');
  assert.equal(coded.next.operation, 'open-version');
});

test('the kernel-built successor\'s rendering, from the kernel\'s own decision shape [D5]', () => {
  const workflow = story('poc-lite-plan', { 'poc-lite-plan': { ...kernelStep(KERNEL_BUILT['poc-lite-plan']), generation: 1 } });
  const decision = { next: { operation: 'build-version', inputs: { producer: 'deterministic', version: 2, consent: 'required', from: 1 }, target: { phase: 'poc-lite-plan' }, reasonCodes: ['REWORK', 'KERNEL_BUILT'] } };
  const [successor] = decisionRoutes(decision, workflow, workflow.phases['poc-lite-plan']);
  assert.equal(successor.command, 'singularity-flow phase rollover poc-lite-plan --json');
  assert.equal(successor.skill, '/sf-phase');
  assert.match(successor.detail, /^Preview building version 2 of poc-lite-plan and ask the person to confirm it; version 1 stays as published\. Its generator builds it once it opens\.$/u);
  const [opened] = decisionRoutes({ next: { ...decision.next, inputs: { ...decision.next.inputs, consent: 'given' } } }, workflow, workflow.phases['poc-lite-plan']);
  assert.equal(opened.command, 'singularity-flow prepare poc-lite-plan', 'once open, its generator builds it');
});
