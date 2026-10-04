import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { nextStepsSnapshot, nextStepsText, workflowNextSteps } from '../src/nextsteps.mjs';
import { storyPrerequisites } from '../src/commands/nextsteps.mjs';

function workflow({ status = 'in_progress', phaseStatus = 'in_progress', generation = 0, currentPhase = 'intake', history = [] } = {}) {
  return {
    workItem: { id: 'NEXT-1', branch: 'NEXT-1', workType: 'feature', workTypeLabel: 'Feature', source: { type: 'manual' } },
    status,
    currentPhase,
    phaseOrder: ['intake', 'requirements'],
    phases: {
      intake: {
        id: 'intake', label: 'Intake', status: phaseStatus, generation,
        requiredArtifact: { path: 'artifacts/intake/intake.md' }, defaultAgent: 'product-owner',
        approvalPolicy: { agents: ['product-owner'], minimum: 1 }
      },
      requirements: {
        id: 'requirements', label: 'Requirements', status: currentPhase ? 'not_started' : 'approved', generation: currentPhase ? 0 : 1,
        requiredArtifact: { path: 'artifacts/requirements/requirements.md' }, defaultAgent: 'product-owner',
        approvalPolicy: { agents: ['product-owner'], minimum: 1 }
      }
    },
    history
  };
}

test('nextsteps works before initialization and without an active work item', () => {
  const uninitialized = nextStepsSnapshot({ initialized: false, branch: 'main' });
  assert.equal(uninitialized.state, 'not_initialized');
  assert.deepEqual(uninitialized.actions.map((item) => item.command), ['singularity-flow init', 'singularity-flow start <WORK-ID>']);

  const idle = nextStepsSnapshot({ branch: 'main' });
  assert.equal(idle.state, 'no_active_work_item');
  assert.deepEqual(idle.actions.map((item) => item.skill), ['/sf-start', '/sf-resume']);

  const requested = nextStepsSnapshot({ branch: 'main', requestedWorkId: 'ENG-42' });
  assert.equal(requested.actions[0].command, 'singularity-flow resume ENG-42 --fetch');
  assert.equal(requested.actions[0].executable, 'singularity-flow');
  assert.deepEqual(requested.actions[0].argv, ['resume', 'ENG-42', '--fetch']);
});

test('active generation plan includes current, subsequent, alternative, and following-phase actions', () => {
  const steps = workflowNextSteps(workflow());
  assert.deepEqual(steps.map((item) => item.skill), ['/sf-phase', '/sf-phase', '/sf-submit', '/sf-approve', '/sf-reject', '/sf-cancel', '/sf-phase']);
  assert.deepEqual(steps.map((item) => item.timing), ['now', 'then', 'then', 'then', 'alternative', 'alternative', 'then']);
  assert.equal(steps[1].command, 'singularity-flow phase publish intake --authored governed-agent --channel copilot-host');
  assert.deepEqual(steps[1].argv, [
    'phase', 'publish', 'intake', '--authored', 'governed-agent', '--channel', 'copilot-host'
  ]);
  assert.deepEqual(steps.find((item) => item.command.includes('approve intake')).argv,
    ['approve', 'intake', '--work-id', 'NEXT-1', '--fetch']);
  assert.match(steps.at(-1).reason, /Requirements/);
});

test('generated and approval-pending phases return only valid next transitions', () => {
  const generated = workflowNextSteps(workflow({ generation: 1 }));
  assert.equal(generated[0].skill, '/sf-submit');
  assert.equal(generated[1].skill, '/sf-phase-documents');
  assert.equal(generated[1].timing, 'alternative');
  assert.equal(generated[1].copilotCommand, '/sf-phase-documents intake');
  assert.equal(generated.filter((item) => item.skill === '/sf-submit').length, 1);

  const awaiting = workflowNextSteps(workflow({ generation: 1, phaseStatus: 'awaiting_approval' }));
  assert.deepEqual(awaiting.slice(0, 2).map((item) => item.skill), ['/sf-approve', '/sf-reject']);
  assert.equal(awaiting[1].timing, 'alternative');
  assert.equal(awaiting[2].skill, '/sf-phase');
});

test('post-completion guidance skips only phases preserved by an approved skill amendment', () => {
  const story = workflow({ generation: 2, phaseStatus: 'awaiting_approval' });
  story.phaseOrder.push('release');
  story.phases.requirements.status = 'approved';
  story.phases.requirements.generation = 1;
  story.phases.release = {
    ...story.phases.requirements, id: 'release', label: 'Release', status: 'not_started', generation: 0
  };
  story.skillVersionAmendments = [{
    status: 'approved', affectedPhaseIds: ['intake', 'release'], preservedPhaseIds: ['requirements']
  }];
  const next = workflowNextSteps(story).filter((entry) => entry.timing === 'then');
  assert.equal(next[0].command, 'singularity-flow prepare release');
  assert.equal(next.some((entry) => entry.command === 'singularity-flow prepare requirements'), false);

  story.skillVersionAmendments[0].status = 'proposed';
  assert.equal(workflowNextSteps(story).find((entry) => entry.timing === 'then').command,
    'singularity-flow prepare requirements', 'unapproved independence claims never skip a phase');
});

test('input preparation follows the next unused generation after abandoned rework', () => {
  const story = workflow({ generation: 1 });
  story.phases.intake.rejectedAt = '2026-10-02T00:00:00.000Z';
  story.phases.intake.generationHighWatermark = 2;
  story.resolution = { inputsMode: 'enforce', phases: [{ id: 'intake', inputs: [{ phase: 'prior' }] }] };
  story.phases.intake.inputContext = { generation: 2 };
  assert.equal(workflowNextSteps(story)[0].command, 'singularity-flow inputs intake');
  story.phases.intake.inputContext.generation = 3;
  assert.equal(workflowNextSteps(story).some((entry) => entry.command === 'singularity-flow inputs intake'), false);
});

test('rejection, pending publication, and completion produce safe action plans', () => {
  const rejectedWorkflow = workflow({ generation: 2, history: [{ phase: 'requirements', event: 'phase_rejected', at: '2026-01-02T00:00:00.000Z' }] });
  rejectedWorkflow.phases.intake.rejectedAt = '2026-01-02T00:00:00.000Z';
  const rejected = workflowNextSteps(rejectedWorkflow);
  assert.equal(rejected[0].skill, '/sf-phase');
  assert.match(rejected[0].reason, /Regenerate/);

  rejectedWorkflow.history.push({ phase: 'intake', event: 'phase_generated', at: '2026-01-03T00:00:00.000Z' });
  assert.equal(workflowNextSteps(rejectedWorkflow)[0].skill, '/sf-submit');

  const pending = workflowNextSteps(workflow(), { publicationPending: true });
  assert.equal(pending[0].command, 'singularity-flow sync');
  assert.equal(pending[1].skill, '/sf-nextsteps');

  const complete = workflow({ status: 'closed', currentPhase: null, phaseStatus: 'approved', generation: 1 });
  const completed = workflowNextSteps(complete);
  assert.deepEqual(completed.map((item) => item.skill), ['/sf-gate', '/sf-stack', '/sf-stack', '/sf-progress', '/sf-report']);
  assert.match(completed[0].command, /gate --terminal/);
  assert.equal(completed[1].command, 'singularity-flow pr NEXT-1');
  assert.equal(completed[2].command, 'singularity-flow pr NEXT-1 --create');

  const cancelled = workflow({ status: 'cancelled', currentPhase: null, phaseStatus: 'cancelled', generation: 1 });
  cancelled.cancellation = {
    phase: 'intake', reason: 'Priority changed', cancelledAt: '2026-01-04T00:00:00.000Z',
    cancelledBy: { name: 'Reviewer', email: 'reviewer@example.com' }
  };
  assert.deepEqual(workflowNextSteps(cancelled).map((item) => item.skill), ['/sf-documents', '/sf-report']);
});

test('a no-approval phase never offers review actions and post-submit state targets the new phase', () => {
  const beforeSubmit = workflow({ generation: 1 });
  beforeSubmit.phases.intake.approvalPolicy.mode = 'none';
  const beforeActions = workflowNextSteps(beforeSubmit);
  assert.equal(beforeActions[0].command, 'singularity-flow submit intake');
  assert.equal(beforeActions.some((item) => /singularity-flow (?:approve|reject) intake/.test(item.command)), false);
  assert.match(beforeActions.at(-1).reason, /submission completes its no-approval phase/);

  const afterSubmit = workflow({ generation: 1, currentPhase: 'requirements' });
  afterSubmit.phases.intake.status = 'approved';
  afterSubmit.phases.intake.approvalPolicy.mode = 'none';
  afterSubmit.phases.requirements.status = 'in_progress';
  afterSubmit.phases.requirements.approvalPolicy.mode = 'none';
  const afterActions = workflowNextSteps(afterSubmit);
  assert.ok(afterActions.some((item) => item.command === 'singularity-flow prepare requirements'));
  assert.equal(afterActions.some((item) => /singularity-flow (?:approve|reject)/.test(item.command)), false);
  assert.equal(afterActions.some((item) => /(?:prepare|submit|phase publish) intake/.test(item.command)), false);
});

test('nextsteps text preserves timing and reason and shows both Shell and Copilot routes', () => {
  const snapshot = nextStepsSnapshot({ workflow: workflow() });
  const text = nextStepsText(snapshot);
  assert.match(text, /NEXT-1 — next actions/);
  assert.match(text, /Guided router: Copilot \/sf-next · Shell singularity-flow next/);
  assert.match(text, /NOW — .*\n   Shell: singularity-flow prepare intake/);
  assert.match(text, /THEN — .*\n   Shell: singularity-flow phase publish intake --authored governed-agent --channel copilot-host/);
  assert.match(text, /THEN — .*\n   Shell: singularity-flow submit intake/);
  assert.match(text, /ALTERNATIVE — .*\n   Shell: singularity-flow reject/);
  assert.match(text, /Copilot: \/sf-phase/);
});

test('agent trust and synchronization prerequisites precede generation', () => {
  const prerequisites = [
    { timing: 'now', skill: null, command: 'singularity-flow agents lock architecture', reason: 'Trust hashes.' },
    { timing: 'then', skill: null, command: 'singularity-flow agents sync architecture', reason: 'Materialize cache.' }
  ];
  const snapshot = nextStepsSnapshot({ workflow: workflow(), prerequisites });
  assert.deepEqual(snapshot.actions.slice(0, 2).map((item) => item.command), prerequisites.map((item) => item.command));
  assert.deepEqual(snapshot.actions.slice(0, 2).map((item) => item.skill), ['/sf-agents', '/sf-agents']);
  assert.equal(snapshot.actions[2].skill, '/sf-phase');
});

test('a consumed generation with changed bytes suppresses ordinary lifecycle retries', () => {
  const recovery = {
    requiresRecovery: true, phaseId: 'intake', planId: 'sha256:recovery',
    blockers: [{ code: 'generation.intent.consumed-changed' }]
  };
  const snapshot = nextStepsSnapshot({ workflow: workflow({ generation: 1 }), recovery });
  assert.equal(snapshot.state, 'recovery_required');
  assert.equal(snapshot.actions.length, 1);
  assert.equal(snapshot.actions[0].skill, '/sf-recover');
  assert.equal(snapshot.actions[0].command, 'singularity-flow recover NEXT-1 --phase intake');
  assert.equal(snapshot.actions.some((entry) => /submit|publish/.test(entry.command)), false);
});

test('a step reopened by rework or a skill amendment gets the grounding prerequisites of a new generation', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-nextsteps-grounding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'repo');
  const machine = path.join(directory, 'machine');
  await mkdir(root); await mkdir(machine);
  const env = { ...process.env, HOME: machine, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Next Steps Tester' };
  const execute = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  };
  const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
  execute('git', ['init', '-q', '-b', 'main']);
  execute('git', ['config', 'user.name', 'Next Steps Tester']);
  execute('git', ['config', 'user.email', 'next-steps@example.test']);
  await writeFile(path.join(root, 'README.md'), '# Grounding fixture\n');
  execute(process.execPath, [cli, '--no-model', 'init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off'; config.worldModel.grounding = 'warn';
  config.repositoryReadiness.requiredBeforeStory = false;
  await writeFile(configPath, YAML.stringify(config));
  execute('git', ['add', '.']); execute('git', ['commit', '-q', '-m', 'Grounding fixture']);
  execute('git', ['init', '-q', '--bare', '-b', 'main', path.join(directory, 'remote.git')]);
  execute('git', ['remote', 'add', 'origin', path.join(directory, 'remote.git')]);
  execute('git', ['push', '-q', '-u', 'origin', 'main']);
  execute(process.execPath, [cli, '--no-model', 'start', 'GROUND-1', '--from-branch', 'main', '--work-type', 'feature',
    '--title', 'Ground reopened work', '--description', 'A reopened step regenerates with grounding.']);
  const story = JSON.parse(await readFile(path.join(root, 'singularity/work-items/GROUND-1/workflow.json'), 'utf8'));
  const [first, second] = story.phaseOrder;
  Object.assign(story.phases[first], { status: 'approved', generation: 2 });
  Object.assign(story.phases[second], { status: 'in_progress', generation: 1 });
  story.currentPhase = second;
  const grounding = async (state) => (await storyPrerequisites(root, state,
    { location: { path: 'singularity/work-items/GROUND-1/workflow.json' } }, { enabled: false }))
    .some((entry) => entry.skill === '/sf-worldmodel' || /wm compose/.test(entry.command));
  assert.equal(await grounding(story), false, 'a published, unreopened generation needs no new grounding');
  // A downstream step reopened by a return to an earlier step has no rejectedAt of its own.
  const reopened = structuredClone(story);
  reopened.phases[second].reworkRevalidation = { generation: 1, invalidatedAt: '2026-10-02T00:00:00.000Z' };
  assert.equal(await grounding(reopened), true);
  const amended = structuredClone(story);
  amended.phases[second].skillAmendmentRevalidation = { state: 'affected', generationAtAdoption: 1 };
  assert.equal(await grounding(amended), true);
});

test('a required after-step delivery comes before the held step\'s own work', () => {
  const key = `sad_${'2'.repeat(40)}`;
  const hold = {
    missing: [{ key, phaseId: 'intake', generation: 1, action: 'audit', target: 'audit-log', here: 'failed' }],
    nextAction: `singularity-flow integrations retry ${key}`,
    reason: 'The next step waits: the required after-step action audit → audit-log has no receipt in the Story.'
  };
  const plain = workflowNextSteps(workflow());
  assert.equal(plain.find((entry) => entry.command === 'singularity-flow prepare intake')?.timing, 'now');
  const held = workflowNextSteps(workflow(), { stepActionHold: hold });
  assert.deepEqual([held[0].timing, held[0].command, held[0].skill, held[0].reason], ['now', hold.nextAction, '/sf-integrations', hold.reason]);
  assert.equal(held.find((entry) => entry.command === 'singularity-flow prepare intake')?.timing, 'then', 'the step\'s own work follows the delivery');
  assert.equal(held.filter((entry) => entry.timing === 'now').length, 1);
  const snapshot = nextStepsSnapshot({ workflow: workflow(), stepActionHold: hold });
  assert.equal(snapshot.stepActionHold, hold);
  assert.equal(snapshot.actions[0].command, hold.nextAction);
  assert.match(nextStepsText(snapshot), /integrations retry sad_2{40}/);
  assert.equal(workflowNextSteps(workflow({ phaseStatus: 'awaiting_approval', generation: 1 }), { stepActionHold: hold })[0].command.includes('integrations'), false, 'a step in review is not held');
});
